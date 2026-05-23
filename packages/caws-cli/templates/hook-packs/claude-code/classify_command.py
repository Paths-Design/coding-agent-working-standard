#!/usr/bin/env python3
# CAWS-MANAGED-HOOK
# hook_pack: claude-code
# hook_pack_version: 3
# caws_min_major: 11
# lineage_refs: 1,17
# do_not_edit_directly: update via `caws init --agent-surface claude-code`
"""
Command safety classifier for Claude Code PreToolUse hooks.

Segments shell commands, parses them individually, and classifies each
as allow / confirm / deny based on tiered policy.

Output: JSON object with keys:
  decision: "allow" | "ask" | "deny"
  reason:   human-readable explanation (empty string for allow)

Usage:
  echo "$COMMAND" | python3 classify_command.py [--repo-root DIR] [--home DIR]
"""

from __future__ import annotations

import json
import os
import re
import shlex
import sys
from pathlib import Path
from typing import Sequence


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

# Paths that are safe targets for recursive deletion (relative to repo root).
# After normalization, if the resolved path starts with one of these, allow.
SAFE_DELETE_PREFIXES: list[str] = [
    "target/",
    "tmp/",
    ".pytest_cache/",
    "node_modules/",
    "__pycache__/",
]

# Pipeline-aware deny patterns: matched against the FULL raw command string
# BEFORE segmentation.  These detect cross-pipeline dangers like curl|sh and
# fork bombs whose syntax spans segment boundaries.
#
# IMPORTANT: these patterns are matched against `executable_surface`, which
# has had quoted regions (single + double quotes) replaced with spaces by
# strip_quoted_regions. That is what gives us quote-safety — a literal
# `tail x | sh` inside a quoted string is replaced with whitespace before
# the regex runs, so it does not trigger.
DENY_PIPELINE_PATTERNS: list[tuple[str, str]] = [
    # Pipe-to-shell (network exfiltration) — historical curl/wget pattern,
    # kept for diagnostic-reason specificity. The generic rule below also
    # catches these; this pattern fires first to give a clearer reason.
    (r"\b(curl|wget)\b[^|]*\|\s*(ba)?sh\b", "pipe-to-shell execution"),
    # Generic pipe-to-shell — any command piped into bash/sh execution.
    # Catches `tail x | sh`, `cat script | bash`, `head install.sh | sh`,
    # etc. The leading `[^|]` (non-pipe, non-empty char before the pipe)
    # ensures we do not false-match `||` (logical OR). The trailing `\b`
    # ensures we do not match `bash-completion` or similar word-extended
    # forms. Quote-safety is provided by strip_quoted_regions upstream.
    (r"[^|]\|\s*(ba)?sh\b", "generic pipe-to-shell execution — pipe target is a shell interpreter"),
    # Fork bombs — special syntax that segmentation mangles
    (r":\(\)\s*\{.*:\|:.*\}\s*;\s*:", "fork bomb"),
    (r"\bwhile\s+true\b.*\bfork\b", "fork loop"),
]

# Segment-level regex patterns that are always hard-blocked.
# These are matched against individual parsed command segments, NOT the raw
# command string.  Quoted literals in other segments will not trigger them.
DENY_SEGMENT_PATTERNS: list[tuple[str, str]] = [
    # System destruction
    (r"\bdd\b.*\bif=/dev/(zero|random)\b", "dd with destructive input"),
    (r"\bmkfs\.", "filesystem format"),
    (r"\bfdisk\b", "disk partitioning"),
    (r">\s*/dev/sd", "raw device write"),
    # Permission escalation
    (r"\bchmod\b.*\+s\b", "setuid/setgid bit"),
    # System control
    (r"\b(shutdown|reboot)\b", "system shutdown/reboot"),
    (r"\binit\s+[06]\b", "system runlevel change"),
    # CAWS spec/policy/waiver protection (RC defect #8).
    # Naked rm/mv on .caws/specs/, .caws/policy.yaml, or .caws/waivers/ bypasses
    # the audit trail. Use `caws specs close|archive`, `caws waiver revoke`,
    # or edit policy.yaml in place via Edit (not Bash) instead.
    (r"\b(rm|mv)\b[^\n]*\.caws/specs/[^\s'\"]*\.ya?ml\b",
     "naked rm/mv on .caws/specs/*.yaml — use `caws specs close|archive <id>`"),
    (r"\b(rm|mv)\b[^\n]*\.caws/policy\.ya?ml\b",
     "naked rm/mv on .caws/policy.yaml — policy is governed; use Edit and a CAWS waiver"),
    (r"\b(rm|mv)\b[^\n]*\.caws/waivers/[^\s'\"]*\.ya?ml\b",
     "naked rm/mv on .caws/waivers/*.yaml — use `caws waiver revoke <id>`"),
]

# Segment-level regex patterns that require user confirmation.
CONFIRM_SEGMENT_PATTERNS: list[tuple[str, str]] = [
    # Git destructive operations
    (r"\bgit\s+reset\s+--hard\b", "git reset --hard"),
    (r"\bgit\s+push\s+(-f\b|--force\b|--force-with-lease\b)", "git force push"),
    (r"\bgit\s+clean\s+-[a-zA-Z]*f", "git clean with force"),
    (r"\bgit\s+checkout\s+\.\s*$", "git checkout . (discard all changes)"),
    (r"\bgit\s+restore\s+\.\s*$", "git restore . (discard all changes)"),
    (r"\bgit\s+rebase\b", "git rebase (rewrites branch history)"),
    (r"\bgit\s+cherry-pick\b", "git cherry-pick (replays commits across branches)"),
    # chmod 777
    (r"\bchmod\b.*\b777\b", "chmod 777"),
    # History manipulation
    (r"\bhistory\s+-c\b", "history clear"),
    # sudo (not in allowed list)
    (r"^sudo\s+(?!npm|yarn|pnpm|brew|apt-get|apt|dnf|yum)", "sudo command"),
    # venv creation (sprawl prevention)
    (r"\bpython3?\s+-m\s+venv\b", "virtual environment creation"),
    (r"\bvirtualenv\s", "virtual environment creation"),
    (r"\bconda\s+create\b", "conda environment creation"),
    # Credential file reads
    (r"\bcat\b.*\.(env|ssh/|aws/)", "credential file read"),
    (r"\bcat\b.*/etc/(passwd|shadow)\b", "system credential read"),
    (r"\bcat\b.*(id_rsa|credentials)\b", "credential file read"),
]

GIT_GLOBAL_OPTIONS_WITH_VALUE: set[str] = {
    "-C",
    "-c",
    "--git-dir",
    "--work-tree",
    "--namespace",
    "--exec-path",
}

GIT_GLOBAL_OPTIONS_NO_VALUE: set[str] = {
    "--bare",
    "--no-pager",
    "--paginate",
    "--no-replace-objects",
    "--literal-pathspecs",
    "--glob-pathspecs",
    "--noglob-pathspecs",
    "--icase-pathspecs",
}

COMMAND_WRAPPERS: set[str] = {
    "builtin",
    "command",
    "nohup",
}

SHELL_C_WRAPPERS: set[str] = {
    "bash",
    "dash",
    "sh",
    "zsh",
}


# ---------------------------------------------------------------------------
# DANGER-LATCH-CALIBRATION-001 — explicit allow-list of read-only surface
# ---------------------------------------------------------------------------
# Hybrid fail-closed semantics: for `git`, `gh`, and `npm` (the three
# governed command families), a subcommand NOT on the allow-list and NOT
# matched by any deny/confirm pattern resolves to "ask". Other commands
# keep the existing classifier default. The allow-list itself is
# command+subcommand specific — `gh pr view` is admitted, `gh pr merge`
# is not (it falls through to ask). See spec invariant for the full
# canonical surface.
#
# IMPORTANT: editing this allow-list weakens or expands the agent-
# boundary guard. Add a name only after confirming it is observational
# (no filesystem mutation, no network write, no privileged operation,
# no irreversible state change to GitHub / npm / git).

# Top-level simple commands that are read-only file inspection or search.
# Matched by exact basename of the segment's first executable token.
# These do NOT have subcommands worth tracking; presence of the name is
# enough.
ALLOWED_SIMPLE_COMMANDS: set[str] = {
    # File inspection
    "tail", "head", "cat", "less", "more", "wc", "stat", "file",
    "du", "df", "ls", "tree",
    # Search
    "grep", "rg",
    # `find` is NOT in this set because of -delete/-exec/-execdir/-fprint/-ok;
    # classify_allow_list handles find specifically.
}

# Allowed git subcommands (read-only).
ALLOWED_GIT_SUBCOMMANDS: set[str] = {
    "status", "log", "diff", "show", "branch", "tag",
    "remote", "config", "rev-parse", "ls-files", "blame",
}

# Allowed gh top-level groups + subcommands. Format: "group action".
# Example: "pr view" means `gh pr view ...` is admitted.
# `gh api` is handled specifically by gh_api_method() because its
# admit decision depends on -X verb, not subcommand structure.
ALLOWED_GH_ACTIONS: set[str] = {
    "pr view", "pr status", "pr list", "pr checks", "pr diff",
    "run view", "run list",
    "issue view", "issue list",
    "repo view",
    "release view", "release list",
    # `gh api` admitted only when -X is absent or -X is GET (separate logic)
}

# Mutating gh actions that the allow-list explicitly REJECTS (returns ask).
# These exist because `gh` as a top-level command is not whitelisted; only
# named read-only subcommands are. But for clarity (and to surface a
# specific reason in diagnostics), we name the mutating ones explicitly.
# Note: appearance here does NOT make the command a hard deny — only ask.
GH_MUTATING_ACTIONS: set[str] = {
    "pr merge", "pr edit", "pr close", "pr reopen", "pr ready",
    "pr comment", "pr review",
    "run rerun", "run cancel",
    "workflow run", "workflow enable", "workflow disable",
    "release create", "release edit", "release delete",
    "issue create", "issue edit", "issue close",
}

# Allowed npm subcommands (read-only).
ALLOWED_NPM_SUBCOMMANDS: set[str] = {
    "view", "whoami", "config", "ls", "outdated", "explain",
    # `npm pack --dry-run` is admitted; bare `npm pack` is not (handled separately)
}

# Top-level command names that participate in HYBRID FAIL-CLOSED semantics.
# For commands in this set, an unknown subcommand (one not on the
# allow-list and not matched by any deny/confirm pattern) resolves to
# "ask", not the default "allow". Outside this set, the classifier's
# global default applies.
GOVERNED_FAMILIES: set[str] = {"git", "gh", "npm"}


# ---------------------------------------------------------------------------
# Command segmentation
# ---------------------------------------------------------------------------

def segment_command(raw: str) -> list[str]:
    """Split a shell command string on &&, ||, ;, | operators.

    Respects quoted strings so that e.g. git commit -m "rm -rf /" does not
    split inside the quotes.  Returns individual command segments with
    leading/trailing whitespace stripped.

    This is intentionally conservative: if we cannot parse, we return
    the entire string as one segment so it still gets classified.
    """
    segments: list[str] = []
    current: list[str] = []
    i = 0
    in_single = False
    in_double = False
    in_heredoc: str | None = None
    heredoc_marker: str = ""

    while i < len(raw):
        ch = raw[i]

        # ---- heredoc detection ----
        # Look for <<EOF or <<'EOF' or <<"EOF" at segment level
        if not in_single and not in_double and in_heredoc is None:
            if raw[i:i+2] == "<<":
                # Extract the delimiter
                j = i + 2
                while j < len(raw) and raw[j] in (' ', '\t'):
                    j += 1
                # Strip optional quotes around delimiter
                quote_char = None
                if j < len(raw) and raw[j] in ("'", '"'):
                    quote_char = raw[j]
                    j += 1
                k = j
                while k < len(raw) and raw[k] not in (' ', '\t', '\n', "'", '"', ')'):
                    k += 1
                if k > j:
                    heredoc_marker = raw[j:k]
                    in_heredoc = heredoc_marker
                    # Skip to end of this line
                    nl = raw.find('\n', i)
                    if nl >= 0:
                        current.append(raw[i:nl+1])
                        i = nl + 1
                    else:
                        current.append(raw[i:])
                        i = len(raw)
                    continue

        # ---- inside heredoc: scan for closing marker ----
        if in_heredoc is not None:
            nl = raw.find('\n', i)
            if nl < 0:
                # No newline found, rest is heredoc content
                current.append(raw[i:])
                i = len(raw)
                continue
            line = raw[i:nl]
            current.append(raw[i:nl+1])
            i = nl + 1
            if line.strip() == in_heredoc:
                in_heredoc = None
            continue

        # ---- quoting ----
        if ch == '\\' and not in_single:
            current.append(raw[i:i+2])
            i += 2
            continue
        if ch == "'" and not in_double:
            in_single = not in_single
            current.append(ch)
            i += 1
            continue
        if ch == '"' and not in_single:
            in_double = not in_double
            current.append(ch)
            i += 1
            continue

        # ---- segment separators (only outside quotes) ----
        if not in_single and not in_double:
            # && or ||
            if raw[i:i+2] in ('&&', '||'):
                seg = ''.join(current).strip()
                if seg:
                    segments.append(seg)
                current = []
                i += 2
                continue
            # ; (but not ;;)
            if ch == ';' and (i + 1 >= len(raw) or raw[i+1] != ';'):
                seg = ''.join(current).strip()
                if seg:
                    segments.append(seg)
                current = []
                i += 1
                continue
            # | (but not ||, already handled above)
            if ch == '|':
                seg = ''.join(current).strip()
                if seg:
                    segments.append(seg)
                current = []
                i += 1
                continue

        current.append(ch)
        i += 1

    seg = ''.join(current).strip()
    if seg:
        segments.append(seg)

    return segments if segments else [raw.strip()]


def strip_quotes(s: str) -> str:
    """Remove surrounding quotes from a shell token."""
    if len(s) >= 2:
        if (s[0] == '"' and s[-1] == '"') or (s[0] == "'" and s[-1] == "'"):
            return s[1:-1]
    return s


def command_basename(token: str) -> str:
    """Return the executable basename for a command token."""
    return Path(token).name


def is_assignment_token(token: str) -> bool:
    """Return true for shell-style NAME=value assignment tokens."""
    return re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", token) is not None


def skip_env_prefix(tokens: Sequence[str], index: int) -> tuple[int, list[str] | None]:
    """Skip env options and assignments after an env wrapper."""
    i = index
    while i < len(tokens):
        tok = tokens[i]
        if tok == "--":
            return i + 1, None
        if is_assignment_token(tok):
            i += 1
            continue
        if tok in ("-i", "-0", "--ignore-environment", "--null"):
            i += 1
            continue
        if tok in ("-u", "--unset", "-C", "--chdir", "-S", "--split-string"):
            if tok in ("-S", "--split-string") and i + 1 < len(tokens):
                return i, [" ".join(tokens[i + 1:])]
            i += 2
            continue
        if tok.startswith("--split-string="):
            nested = tok.split("=", 1)[1]
            if i + 1 < len(tokens):
                nested = " ".join([nested, *tokens[i + 1:]])
            return i, [nested]
        if tok.startswith("--unset=") or tok.startswith("--chdir=") or tok.startswith("--split-string="):
            i += 1
            continue
        return i, None
    return i, None


def normalize_command_tokens(tokens: Sequence[str]) -> tuple[int, list[str] | None]:
    """Strip variable assignments and simple command wrappers.

    Returns the index of the real command. If the command is a shell -c wrapper,
    returns a nested command string list so the caller can classify it
    recursively.
    """
    i = 0
    while i < len(tokens):
        tok = tokens[i]
        base = command_basename(tok)

        if is_assignment_token(tok):
            i += 1
            continue

        if base == "env":
            i, nested = skip_env_prefix(tokens, i + 1)
            if nested is not None:
                return i, nested
            continue

        if base == "time":
            i += 1
            while i < len(tokens) and tokens[i].startswith("-"):
                if tokens[i] in ("-f", "-o"):
                    i += 2
                else:
                    i += 1
            continue

        if base in COMMAND_WRAPPERS:
            i += 1
            continue

        if base in SHELL_C_WRAPPERS:
            j = i + 1
            while j < len(tokens):
                arg = tokens[j]
                if arg == "--":
                    j += 1
                    continue
                if arg.startswith("-") and "c" in arg[1:]:
                    if j + 1 < len(tokens):
                        return i, [tokens[j + 1]]
                    return i, [""]
                if not arg.startswith("-"):
                    break
                j += 1

        return i, None

    return i, None


def detect_git_subcommand(segment: str) -> str | None:
    """Detect the semantic Git subcommand for one executable segment.

    This recognizes wrappers such as env/command/nohup/time, absolute Git
    executable paths, and Git global options before the real subcommand.
    """
    try:
        tokens = shlex.split(segment)
    except ValueError:
        return None

    if not tokens:
        return None

    start, nested = normalize_command_tokens(tokens)
    if nested is not None:
        return None
    if start >= len(tokens) or command_basename(tokens[start]) != "git":
        return None

    i = start + 1
    while i < len(tokens):
        tok = tokens[i]
        if tok == "--":
            i += 1
            break
        if tok in GIT_GLOBAL_OPTIONS_WITH_VALUE:
            i += 2
            continue
        if any(tok.startswith(f"{opt}=") for opt in GIT_GLOBAL_OPTIONS_WITH_VALUE if opt.startswith("--")):
            i += 1
            continue
        if tok in GIT_GLOBAL_OPTIONS_NO_VALUE:
            i += 1
            continue
        if tok.startswith("-"):
            # Unknown global option. If it has an inline value, skip it;
            # otherwise stop so we do not accidentally skip a subcommand.
            if "=" in tok:
                i += 1
                continue
            break
        return tok

    if i < len(tokens) and not tokens[i].startswith("-"):
        return tokens[i]
    return None


def git_alias_value_invokes_init(value: str) -> bool:
    """Return true when a `git -c alias.*=...` value routes to init."""
    stripped = value.strip()
    if not stripped:
        return False
    if stripped == "init" or stripped.startswith("init "):
        return True
    if stripped.startswith("!"):
        nested = stripped[1:].strip()
        return detect_git_subcommand(nested) == "init" or nested == "init" or nested.startswith("init ")
    return False


def has_git_init_alias_config(segment: str) -> bool:
    """Detect inline Git alias definitions that route an alias to init."""
    try:
        tokens = shlex.split(segment)
    except ValueError:
        return False

    if not tokens:
        return False

    start, nested = normalize_command_tokens(tokens)
    if nested is not None or start >= len(tokens) or command_basename(tokens[start]) != "git":
        return False

    i = start + 1
    while i < len(tokens):
        tok = tokens[i]
        config_value = None
        if tok == "-c" and i + 1 < len(tokens):
            config_value = tokens[i + 1]
            i += 2
        elif tok.startswith("-c") and len(tok) > 2:
            config_value = tok[2:]
            i += 1
        else:
            i += 1

        if not config_value or "=" not in config_value:
            continue
        key, value = config_value.split("=", 1)
        if key.startswith("alias.") and git_alias_value_invokes_init(value):
            return True

    return False


def classify_nested_shell(segment: str, repo_root: Path, home: Path, cwd: Path, caws_worktree: bool) -> tuple[str, str] | None:
    """Recursively classify sh/bash/zsh -c strings."""
    try:
        tokens = shlex.split(segment)
    except ValueError:
        return None

    _, nested = normalize_command_tokens(tokens)
    if not nested:
        return None

    return classify_command(nested[0], repo_root, home, cwd, caws_worktree)


def classify_git_semantics(
    segment: str,
    caws_worktree: bool,
    repo_root: Path | None = None,
) -> tuple[str, str] | None:
    """Classify Git operations by executable/subcommand semantics.

    When `caws_worktree` is true (a trusted git-init context exists) and
    the segment is a git-init variant, the trusted token is consumed
    here. If consumption fails (the token was removed by a concurrent
    classifier run, or another git-init segment in the same command
    already consumed it), the segment falls back to `ask` so the human
    review boundary still engages.
    """
    is_init_alias = has_git_init_alias_config(segment)
    subcommand = detect_git_subcommand(segment) if not is_init_alias else None

    if is_init_alias:
        if caws_worktree and repo_root is not None and consume_trusted_git_init_context(repo_root):
            return "allow", ""
        return "ask", "git alias routes to init and requires human approval"

    if subcommand is None:
        return None

    if subcommand == "init":
        if caws_worktree and repo_root is not None and consume_trusted_git_init_context(repo_root):
            return "allow", ""
        return "ask", "git init requires human approval; do not retry by wrapping, reordering, aliasing, or indirect invocation"

    if subcommand == "rebase":
        return "ask", "git rebase rewrites branch history"

    if subcommand == "cherry-pick":
        return "ask", "git cherry-pick replays commits across branches"

    return None


# ---------------------------------------------------------------------------
# DANGER-LATCH-CALIBRATION-001 — gh / npm subcommand detection
# ---------------------------------------------------------------------------

def detect_gh_subcommand(segment: str) -> tuple[str, str] | None:
    """Detect the (group, action) for a `gh` segment.

    Returns a tuple like ("pr", "view") for `gh pr view 5`, or
    ("api", "") for `gh api /repos/foo/bar`. Returns None if the
    segment is not a gh invocation. Handles env/time/nohup wrappers
    via normalize_command_tokens.

    Subcommand-with-no-action (e.g., bare `gh pr`) returns
    (group, "") so the caller can distinguish "no allow-list match"
    from "not a gh command at all."
    """
    try:
        tokens = shlex.split(segment)
    except ValueError:
        return None

    if not tokens:
        return None

    start, nested = normalize_command_tokens(tokens)
    if nested is not None:
        return None
    if start >= len(tokens) or command_basename(tokens[start]) != "gh":
        return None

    # First non-flag token after `gh` is the group (pr, run, issue, repo, api, ...)
    i = start + 1
    group = ""
    while i < len(tokens):
        tok = tokens[i]
        if tok.startswith("-"):
            i += 1
            continue
        group = tok
        i += 1
        break

    if not group:
        return None

    # Second non-flag token is the action (view, list, merge, ...)
    # For `gh api` there is no action — the next token is the path.
    if group == "api":
        return ("api", "")

    action = ""
    while i < len(tokens):
        tok = tokens[i]
        if tok.startswith("-"):
            i += 1
            continue
        action = tok
        break

    return (group, action)


def gh_api_method(segment: str) -> str:
    """Return the HTTP method for a `gh api` segment.

    Defaults to "GET" when no -X flag is present. Recognizes both
    `-X POST` and `--method POST` / `-XPOST` forms.
    """
    try:
        tokens = shlex.split(segment)
    except ValueError:
        return "GET"

    for i, tok in enumerate(tokens):
        if tok in ("-X", "--method") and i + 1 < len(tokens):
            return tokens[i + 1].upper()
        if tok.startswith("-X") and len(tok) > 2:
            # Concatenated form like -XPOST
            return tok[2:].upper()
        if tok.startswith("--method="):
            return tok.split("=", 1)[1].upper()
    return "GET"


def detect_npm_subcommand(segment: str) -> str | None:
    """Return the subcommand for an `npm` segment, or None if not npm.

    Handles env/time/nohup wrappers via normalize_command_tokens.
    """
    try:
        tokens = shlex.split(segment)
    except ValueError:
        return None

    if not tokens:
        return None

    start, nested = normalize_command_tokens(tokens)
    if nested is not None:
        return None
    if start >= len(tokens) or command_basename(tokens[start]) != "npm":
        return None

    i = start + 1
    while i < len(tokens):
        tok = tokens[i]
        if tok.startswith("-"):
            i += 1
            continue
        return tok
    return None


def npm_pack_is_dry_run(segment: str) -> bool:
    """Return true if `npm pack` invocation has --dry-run."""
    try:
        tokens = shlex.split(segment)
    except ValueError:
        return False
    return "--dry-run" in tokens


# ---------------------------------------------------------------------------
# DANGER-LATCH-CALIBRATION-001 — allow-list classifier
# ---------------------------------------------------------------------------

def classify_allow_list(segment: str) -> tuple[str, str] | None:
    """Return ("allow", "") if the segment is on the documented allow-list.

    The allow-list is consulted AFTER deny/confirm patterns. A segment
    that matches a deny or confirm pattern WILL escalate the overall
    decision; this function is only what the segment contributes when
    no other rule fires.

    Returns None when the segment does not match the allow-list. The
    caller (classify_command) then falls through to either:
      (a) the existing classifier default (allow) for non-governed
          commands, or
      (b) hybrid fail-closed "ask" via
          classify_governed_family_default for git/gh/npm.
    """
    # First, the simple-command allow-list — match by extracted command word.
    cmd = extract_command_word(segment)
    if not cmd:
        return None

    # Strip path components so /usr/bin/tail matches `tail`.
    cmd_base = command_basename(cmd)

    # `find` is allowed ONLY without mutating action flags. The
    # classify_find_delete function returns ("ask", ...) when find has
    # any of -delete/-exec/-execdir/-fprint/-ok. The allow-list admits
    # find here only when classify_find_delete would return None (i.e.,
    # the find is observational).
    if cmd_base == "find":
        if classify_find_delete(segment) is None:
            return ("allow", "")
        return None

    if cmd_base in ALLOWED_SIMPLE_COMMANDS:
        return ("allow", "")

    # Read-only git subcommands.
    if cmd_base == "git":
        sub = detect_git_subcommand(segment)
        if sub is None:
            # Bare `git` with no subcommand — not allow-list eligible.
            return None
        # Special-case `git tag --list` / `git tag -l` — list only,
        # not mutating (`git tag -d` is a delete).
        if sub == "tag":
            try:
                tokens = shlex.split(segment)
            except ValueError:
                return None
            # Admit only when --list or -l is present and no -d/-D/-m.
            mutating = any(t in ("-d", "-D", "-m", "-a", "-s", "-f") for t in tokens)
            listing = any(t in ("--list", "-l") for t in tokens)
            if listing and not mutating:
                return ("allow", "")
            return None
        # Special-case `git branch` — read-only when no -d/-D/-m flags.
        if sub == "branch":
            try:
                tokens = shlex.split(segment)
            except ValueError:
                return None
            mutating = any(
                t in ("-d", "-D", "-m", "-M", "--delete", "--move") for t in tokens
            )
            if not mutating:
                return ("allow", "")
            return None
        # Special-case `git config --get` — read-only get; bare `git config`
        # or `git config key value` is mutating.
        if sub == "config":
            try:
                tokens = shlex.split(segment)
            except ValueError:
                return None
            if any(t in ("--get", "--get-all", "--get-regexp", "--list", "-l") for t in tokens):
                return ("allow", "")
            return None
        if sub in ALLOWED_GIT_SUBCOMMANDS:
            return ("allow", "")
        return None

    # Read-only gh subcommands.
    if cmd_base == "gh":
        result = detect_gh_subcommand(segment)
        if result is None:
            return None
        group, action = result
        # `gh api` is admit-only when method is GET.
        if group == "api":
            if gh_api_method(segment) == "GET":
                return ("allow", "")
            return None
        key = f"{group} {action}".strip()
        if key in ALLOWED_GH_ACTIONS:
            return ("allow", "")
        return None

    # Read-only npm subcommands.
    if cmd_base == "npm":
        sub = detect_npm_subcommand(segment)
        if sub is None:
            return None
        if sub == "pack":
            if npm_pack_is_dry_run(segment):
                return ("allow", "")
            return None
        if sub in ALLOWED_NPM_SUBCOMMANDS:
            return ("allow", "")
        return None

    return None


def classify_governed_family_default(segment: str) -> tuple[str, str] | None:
    """Hybrid fail-closed for git/gh/npm — unknown subcommand → ask.

    Only fires when:
      - the segment's command is in GOVERNED_FAMILIES, OR is a
        hyphenated PATH-spoof variant (e.g. `gh-pr-view-fake-script`,
        `git-foo`, `npm-something`) that could be mistaken for a
        governed-family command,
      - no deny/confirm pattern matched,
      - no allow-list match.
    Returns ("ask", reason) in that case, None otherwise.

    Callers should invoke this AFTER deny/confirm/allow-list checks
    have all returned no opinion. The function's job is the third
    tier of decision-making for governed families.

    The hyphenated-variant check enforces the spec's anchoring
    invariant: `gh-pr-view-fake-script` does not match the `gh pr view`
    allow-list, and because it shadows a governed family name, it
    deserves the same ask-by-default treatment a real `gh` invocation
    would get for an unknown subcommand.
    """
    cmd = extract_command_word(segment)
    if not cmd:
        return None
    cmd_base = command_basename(cmd)

    # PATH-spoof variants — gh-foo, git-foo, npm-foo. Treated as a
    # suspicious hyphenated impersonation of a governed family, not
    # as an unknown command. The reason names the spoof explicitly.
    for family in GOVERNED_FAMILIES:
        if cmd_base.startswith(f"{family}-"):
            return (
                "ask",
                f"hyphenated command `{cmd_base}` shadows governed family "
                f"`{family}` — not on the allow-list; ask before invoking "
                "to confirm this is not a PATH-spoof of `{family}`",
            )

    if cmd_base not in GOVERNED_FAMILIES:
        return None

    # Surface a useful reason naming the family and subcommand if we
    # can identify one.
    if cmd_base == "gh":
        result = detect_gh_subcommand(segment)
        if result is not None:
            group, action = result
            return (
                "ask",
                f"unknown gh subcommand: {group} {action}".rstrip()
                + " — not on the documented read-only allow-list; "
                "ask before invoking",
            )
        return ("ask", "unknown gh invocation — ask before invoking")

    if cmd_base == "git":
        sub = detect_git_subcommand(segment)
        if sub is not None:
            return (
                "ask",
                f"unknown git subcommand: {sub} — not on the documented "
                "read-only allow-list; ask before invoking",
            )
        return ("ask", "unknown git invocation — ask before invoking")

    if cmd_base == "npm":
        sub = detect_npm_subcommand(segment)
        if sub is not None:
            return (
                "ask",
                f"unknown npm subcommand: {sub} — not on the documented "
                "read-only allow-list; ask before invoking",
            )
        return ("ask", "unknown npm invocation — ask before invoking")

    return None


def _trusted_git_init_token_path(repo_root: Path) -> Path | None:
    """Return the trusted git-init allow-token path if the env signals it.

    Validation only — does not check disk presence and does not consume.
    """
    if os.environ.get("CAWS_TRUSTED_WORKTREE_CREATE_CONTEXT", "0") != "1":
        return None
    nonce = os.environ.get("CAWS_TRUSTED_HOOK_NONCE", "")
    if not re.match(r"^[A-Za-z0-9._-]{8,128}$", nonce):
        return None
    return repo_root / ".claude" / "hooks" / "state" / f"allow-git-init-{nonce}"


def has_trusted_git_init_context(repo_root: Path) -> bool:
    """Return true when dispatch created a one-shot git-init allow token."""
    token = _trusted_git_init_token_path(repo_root)
    return token is not None and token.is_file()


def consume_trusted_git_init_context(repo_root: Path) -> bool:
    """Atomically consume the trusted git-init allow token.

    Returns true if a valid token existed and was removed. The token is
    one-shot: a subsequent git-init in the same dispatch will be subject
    to normal classification (which means `ask`). Dispatch must mint a
    fresh nonce + token for each authorized lifecycle operation.
    """
    token = _trusted_git_init_token_path(repo_root)
    if token is None or not token.is_file():
        return False
    try:
        token.unlink()
    except OSError:
        return False
    return True


def extract_command_word(segment: str) -> str:
    """Extract the first command word from a segment.

    Strips leading variable assignments (FOO=bar), env prefixes,
    and common wrappers like 'time'.
    """
    try:
        tokens = shlex.split(segment)
    except ValueError:
        # Malformed quoting — return raw first word
        return segment.split()[0] if segment.split() else ""

    for tok in tokens:
        # Skip variable assignments
        if '=' in tok and not tok.startswith('-'):
            continue
        # Skip common prefixes
        if tok in ('env', 'time', 'nice', 'nohup', 'command', 'builtin'):
            continue
        return tok
    return ""


# ---------------------------------------------------------------------------
# rm classifier
# ---------------------------------------------------------------------------

def is_recursive_rm(segment: str) -> tuple[bool, list[str]]:
    """Check if a segment is an rm command with recursive flags.

    Returns (is_recursive, [target_paths]).
    """
    try:
        tokens = shlex.split(segment)
    except ValueError:
        # Cannot parse — be conservative
        if re.search(r'\brm\b', segment) and re.search(r'-[a-zA-Z]*r', segment):
            return True, []
        return False, []

    if not tokens:
        return False, []

    # Find the rm command (skip env/time prefixes)
    rm_idx = -1
    for idx, tok in enumerate(tokens):
        if tok in ('env', 'time', 'nice', 'nohup', 'command', 'builtin'):
            continue
        if '=' in tok and not tok.startswith('-'):
            continue
        if tok == 'rm':
            rm_idx = idx
        break

    if rm_idx < 0:
        return False, []

    # Check for recursive flag
    is_recursive = False
    targets: list[str] = []
    i = rm_idx + 1
    while i < len(tokens):
        tok = tokens[i]
        if tok == '--':
            # Everything after -- is targets
            targets.extend(tokens[i+1:])
            break
        if tok.startswith('-') and not tok.startswith('--'):
            if 'r' in tok or 'R' in tok:
                is_recursive = True
        elif tok.startswith('--'):
            if tok == '--recursive':
                is_recursive = True
            # Other long options: skip
        else:
            targets.append(tok)
        i += 1

    return is_recursive, targets


def classify_rm_target(
    target: str,
    repo_root: Path,
    home: Path,
    cwd: Path,
) -> tuple[str, str]:
    """Classify a single rm target path.

    Returns ("deny"|"ask"|"allow", reason).
    """
    # Resolve the target to an absolute path
    raw = target.strip()
    if not raw:
        return "deny", "empty target on recursive delete"

    # Handle glob-like patterns conservatively
    if any(c in raw for c in ('*', '?', '[', ']')):
        # Check if it is /* or ~/* which are catastrophic
        stripped = raw.rstrip('/')
        if stripped in ('/*', '~/*', './*'):
            return "deny", f"glob expansion at dangerous root: {raw}"
        # Other globs: confirm
        return "ask", f"recursive delete with glob pattern: {raw}"

    # Resolve path
    try:
        if raw.startswith('~'):
            resolved = (home / raw[2:]).resolve(strict=False) if len(raw) > 1 else home
        elif raw.startswith('/'):
            resolved = Path(raw).resolve(strict=False)
        else:
            resolved = (cwd / raw).resolve(strict=False)
    except (ValueError, OSError):
        return "ask", f"cannot resolve path: {raw}"

    resolved_str = str(resolved)
    repo_str = str(repo_root)
    home_str = str(home)

    # Hard-block: root, home, repo root
    if resolved_str == '/':
        return "deny", f"recursive delete targets filesystem root"
    if resolved_str == home_str:
        return "deny", f"recursive delete targets home directory"
    if resolved_str == repo_str:
        return "deny", f"recursive delete targets repository root"

    # Check if resolved path is a parent of repo or home (even worse)
    if repo_str.startswith(resolved_str + '/'):
        return "deny", f"recursive delete targets ancestor of repository: {raw}"
    if home_str.startswith(resolved_str + '/'):
        return "deny", f"recursive delete targets ancestor of home directory: {raw}"

    # Allow: known safe prefixes (relative to repo root)
    try:
        rel = resolved.relative_to(repo_root)
        rel_str = str(rel) + '/'
        for prefix in SAFE_DELETE_PREFIXES:
            if rel_str.startswith(prefix):
                return "allow", ""
    except ValueError:
        pass  # Not inside repo root

    # Default: confirm
    return "ask", f"recursive delete: {raw}"


def classify_find_delete(segment: str) -> tuple[str, str] | None:
    """Check if segment is a find command with a mutating action flag.

    Mutating action flags: -delete, -exec, -execdir, -fprint*, -ok.
    Returns classification tuple or None if find has no mutating action.

    The allow-list (see classify_allow_list) admits `find` ONLY when none
    of these flags are present. This classifier returns "ask" for find
    invocations that DO carry a mutating action — the allow-list will
    not match them, and they fall through to this check.
    """
    try:
        tokens = shlex.split(segment)
    except ValueError:
        return None

    cmd = extract_command_word(segment)
    if cmd != 'find':
        return None

    has_delete = '-delete' in tokens
    has_exec = False
    has_execdir = False
    has_fprint = False
    has_ok = False
    for i, tok in enumerate(tokens):
        if tok == '-exec':
            has_exec = True
        elif tok == '-execdir':
            has_execdir = True
        elif tok in ('-ok', '-okdir'):
            has_ok = True
        elif tok in ('-fprint', '-fprint0', '-fprintf'):
            has_fprint = True

    if not (has_delete or has_exec or has_execdir or has_fprint or has_ok):
        return None

    return "ask", f"find with mutating action flag (-delete/-exec/-execdir/-fprint/-ok)"


def extract_command_substitutions(raw: str) -> list[str]:
    """Return the bodies of every $(...) and `...` substitution in raw.

    Bash executes command substitutions even when they appear inside double
    quotes; only single-quoted regions suppress them. Callers should pass
    each body back through the classifier so a nested `$(rm -rf /)` or
    `$(git reset --hard)` is not treated as inert text.

    Single-quoted regions, escaped `\\$` and `\\``, and heredoc bodies are
    skipped. Nested `$(...)` is supported by balancing parentheses.
    """
    bodies: list[str] = []
    i = 0
    in_single = False
    in_heredoc: str | None = None

    while i < len(raw):
        ch = raw[i]

        # Heredoc tracking: bodies are inert as far as substitutions go
        # (heredoc expansion is its own surface; classify_command will see
        # the raw text and apply the same rules).
        if in_heredoc is not None:
            nl = raw.find('\n', i)
            if nl < 0:
                break
            line = raw[i:nl]
            i = nl + 1
            if line.strip() == in_heredoc:
                in_heredoc = None
            continue

        if not in_single and raw[i:i+2] == "<<":
            j = i + 2
            while j < len(raw) and raw[j] in (' ', '\t'):
                j += 1
            if j < len(raw) and raw[j] in ("'", '"'):
                j += 1
            k = j
            while k < len(raw) and raw[k] not in (' ', '\t', '\n', "'", '"', ')'):
                k += 1
            if k > j:
                in_heredoc = raw[j:k]
                nl = raw.find('\n', i)
                i = nl + 1 if nl >= 0 else len(raw)
                continue

        # Escape: `\$`, `\``, and `\\` suppress substitution recognition.
        if ch == '\\' and i + 1 < len(raw):
            i += 2
            continue

        # Single quotes suppress everything inside; toggle and skip.
        if ch == "'":
            in_single = not in_single
            i += 1
            continue

        if in_single:
            i += 1
            continue

        # $(...) substitution — find the matching close paren, respecting
        # nesting and quoted regions inside the body.
        if ch == '$' and i + 1 < len(raw) and raw[i+1] == '(':
            depth = 1
            j = i + 2
            inner_single = False
            inner_double = False
            while j < len(raw) and depth > 0:
                c = raw[j]
                if c == '\\' and j + 1 < len(raw):
                    j += 2
                    continue
                if not inner_double and c == "'":
                    inner_single = not inner_single
                elif not inner_single and c == '"':
                    inner_double = not inner_double
                elif not inner_single and not inner_double:
                    if c == '(':
                        depth += 1
                    elif c == ')':
                        depth -= 1
                        if depth == 0:
                            bodies.append(raw[i+2:j])
                            j += 1
                            break
                j += 1
            i = j
            continue

        # Backtick substitution. Bash does not support nesting inside the
        # same backtick pair (you need `\``), so a simple scan to the next
        # unescaped backtick is sufficient.
        if ch == '`':
            j = i + 1
            while j < len(raw):
                c = raw[j]
                if c == '\\' and j + 1 < len(raw):
                    j += 2
                    continue
                if c == '`':
                    bodies.append(raw[i+1:j])
                    j += 1
                    break
                j += 1
            i = j
            continue

        i += 1

    return bodies


def strip_quoted_regions(raw: str) -> str:
    """Remove content inside single/double quotes and heredocs.

    Returns only the executable shell surface — quoted literals, heredoc
    bodies, and $(...) subshell content embedded in quotes are replaced
    with whitespace so that regex patterns only match actual commands.

    Note: command substitutions inside double quotes execute in Bash. This
    helper still blanks them so the surrounding command's literal pattern
    matching is not confused; callers handle substitutions separately via
    extract_command_substitutions().
    """
    result: list[str] = []
    i = 0
    in_single = False
    in_double = False
    in_heredoc: str | None = None

    while i < len(raw):
        ch = raw[i]

        # Heredoc detection (outside quotes)
        if not in_single and not in_double and in_heredoc is None:
            if raw[i:i+2] == "<<":
                j = i + 2
                while j < len(raw) and raw[j] in (' ', '\t'):
                    j += 1
                if j < len(raw) and raw[j] in ("'", '"'):
                    j += 1
                k = j
                while k < len(raw) and raw[k] not in (' ', '\t', '\n', "'", '"', ')'):
                    k += 1
                if k > j:
                    in_heredoc = raw[j:k]
                    # Keep the << marker but skip to end of line
                    result.append(raw[i:i+2])
                    nl = raw.find('\n', i)
                    if nl >= 0:
                        i = nl + 1
                    else:
                        i = len(raw)
                    continue

        # Inside heredoc: skip until closing marker
        if in_heredoc is not None:
            nl = raw.find('\n', i)
            if nl < 0:
                i = len(raw)
                continue
            line = raw[i:nl]
            i = nl + 1
            if line.strip() == in_heredoc:
                in_heredoc = None
            else:
                result.append(' ')  # placeholder
            continue

        # Escape handling
        if ch == '\\' and not in_single:
            result.append(' ')
            i += 2
            continue

        # Quote tracking
        if ch == "'" and not in_double:
            if in_single:
                in_single = False
            else:
                in_single = True
            i += 1
            continue
        if ch == '"' and not in_single:
            if in_double:
                in_double = False
            else:
                in_double = True
            i += 1
            continue

        # Inside quotes: replace with space
        if in_single or in_double:
            result.append(' ')
            i += 1
            continue

        result.append(ch)
        i += 1

    return ''.join(result)


# ---------------------------------------------------------------------------
# Main classifier
# ---------------------------------------------------------------------------

def classify_command(
    raw_command: str,
    repo_root: Path,
    home: Path,
    cwd: Path,
    caws_worktree: bool = False,
) -> tuple[str, str]:
    """Classify a full command string.

    Returns the most restrictive (decision, reason) across all segments.
    Priority: deny > ask > allow.
    """
    worst_decision = "allow"
    worst_reason = ""

    def escalate(decision: str, reason: str) -> None:
        nonlocal worst_decision, worst_reason
        priority = {"allow": 0, "ask": 1, "deny": 2}
        if priority.get(decision, 0) > priority.get(worst_decision, 0):
            worst_decision = decision
            worst_reason = reason

    # --- Pipeline-aware deny patterns ---
    # Strip quoted regions so patterns only match executable shell surface.
    # This prevents commit messages, echo arguments, etc. from triggering.
    executable_surface = strip_quoted_regions(raw_command)
    for pattern, desc in DENY_PIPELINE_PATTERNS:
        if re.search(pattern, executable_surface, re.IGNORECASE):
            escalate("deny", desc)

    # --- Recursively classify command substitutions ---
    # Bash executes `$(...)` and backtick substitutions even inside double
    # quotes; single-quoted bodies are skipped by extract_command_substitutions.
    # Each extracted body is classified as if it were an independent command.
    for body in extract_command_substitutions(raw_command):
        if not body.strip():
            continue
        sub_decision, sub_reason = classify_command(
            body, repo_root, home, cwd, caws_worktree,
        )
        if sub_decision != "allow":
            escalate(sub_decision, f"command substitution: {sub_reason}")

    segments = segment_command(raw_command)

    for segment in segments:
        nested_result = classify_nested_shell(segment, repo_root, home, cwd, caws_worktree)
        if nested_result:
            escalate(*nested_result)
            continue

        git_result = classify_git_semantics(segment, caws_worktree, repo_root)
        if git_result:
            escalate(*git_result)

        # Strip quoted regions for pattern matching so that e.g.
        # echo "git reset --hard" does not trigger the git pattern.
        # The original segment is still used for rm/find parsing
        # (shlex.split handles quotes correctly for argument extraction).
        segment_surface = strip_quoted_regions(segment)

        # --- Hard-block patterns (segment-level) ---
        for pattern, desc in DENY_SEGMENT_PATTERNS:
            if re.search(pattern, segment_surface, re.IGNORECASE):
                escalate("deny", desc)

        # --- Confirm patterns (segment-level) ---
        for pattern, desc in CONFIRM_SEGMENT_PATTERNS:
            if re.search(pattern, segment_surface, re.IGNORECASE):
                # Special case: git init in worktree context is allowed
                if "git init" in desc and caws_worktree:
                    continue
                escalate("ask", desc)

        # --- rm classifier ---
        is_recursive, targets = is_recursive_rm(segment)
        if is_recursive:
            if not targets:
                # Cannot determine targets — be conservative
                escalate("ask", "recursive delete with unparseable targets")
            else:
                for target in targets:
                    decision, reason = classify_rm_target(
                        target, repo_root, home, cwd,
                    )
                    escalate(decision, reason)

        # --- find -delete classifier ---
        find_result = classify_find_delete(segment)
        if find_result:
            escalate(*find_result)

        # --- DANGER-LATCH-CALIBRATION-001 ---
        # Hybrid fail-closed for governed families (git/gh/npm).
        # Run the allow-list AFTER all deny/confirm/rm/find checks have
        # had a chance to escalate. The allow-list itself never escalates
        # (allow is the lowest tier). It exists to:
        #   (a) tell the governed-family default below to leave this
        #       segment alone (do not escalate to ask),
        #   (b) be auditable as an explicit admit decision in future
        #       diagnostics.
        # If the segment is on the allow-list, skip the hybrid default
        # check. If it is NOT on the allow-list AND the segment is a
        # governed-family command, escalate to "ask".
        allow_result = classify_allow_list(segment)
        if allow_result is None:
            family_result = classify_governed_family_default(segment)
            if family_result is not None:
                escalate(*family_result)

    return worst_decision, worst_reason


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="Classify shell command safety")
    parser.add_argument("--repo-root", default=os.environ.get("CLAUDE_PROJECT_DIR", "."))
    parser.add_argument("--home", default=str(Path.home()))
    parser.add_argument("--cwd", default=os.getcwd())
    args = parser.parse_args()

    raw_command = sys.stdin.read()

    repo_root = Path(args.repo_root).resolve(strict=False)
    home = Path(args.home).resolve(strict=False)
    cwd = Path(args.cwd).resolve(strict=False)
    caws_worktree = has_trusted_git_init_context(repo_root)

    decision, reason = classify_command(
        raw_command, repo_root, home, cwd, caws_worktree,
    )

    json.dump({"decision": decision, "reason": reason}, sys.stdout)


if __name__ == "__main__":
    main()
