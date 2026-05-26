# #!/usr/bin/env python3
# # CAWS-MANAGED-HOOK
# # hook_pack: claude-code
# # hook_pack_version: 2
# # caws_min_major: 11
# # lineage_refs: 1,17
# # do_not_edit_directly: update via `caws init --agent-surface claude-code`
# """
# Command safety classifier for Claude Code PreToolUse hooks.

# Segments shell commands, parses them individually, and classifies each
# as allow / confirm / deny based on tiered policy.

# Output: JSON object with keys:
#   decision: "allow" | "ask" | "deny"
#   reason:   human-readable explanation (empty string for allow)

# Usage:
#   echo "$COMMAND" | python3 classify_command.py [--repo-root DIR] [--home DIR]
# """

# from __future__ import annotations

# import json
# import os
# import re
# import shlex
# import sys
# from pathlib import Path
# from typing import Sequence


# # ---------------------------------------------------------------------------
# # Configuration
# # ---------------------------------------------------------------------------

# # Paths that are safe targets for recursive deletion (relative to repo root).
# # After normalization, if the resolved path starts with one of these, allow.
# SAFE_DELETE_PREFIXES: list[str] = [
#     "target/",
#     "tmp/",
#     ".pytest_cache/",
#     "node_modules/",
#     "__pycache__/",
# ]

# # Pipeline-aware deny patterns: matched against the FULL raw command string
# # BEFORE segmentation.  These detect cross-pipeline dangers like curl|sh and
# # fork bombs whose syntax spans segment boundaries.
# DENY_PIPELINE_PATTERNS: list[tuple[str, str]] = [
#     # Pipe-to-shell (network exfiltration) — must match across | boundary
#     (r"\b(curl|wget)\b.*\|\s*(ba)?sh\b", "pipe-to-shell execution"),
#     (r"\|\s*(ba|da|z)?sh\b", "pipeline into shell execution"),
#     # Fork bombs — special syntax that segmentation mangles
#     (r":\(\)\s*\{.*:\|:.*\}\s*;\s*:", "fork bomb"),
#     (r"\bwhile\s+true\b.*\bfork\b", "fork loop"),
# ]

# # Segment-level regex patterns that are always hard-blocked.
# # These are matched against individual parsed command segments, NOT the raw
# # command string.  Quoted literals in other segments will not trigger them.
# DENY_SEGMENT_PATTERNS: list[tuple[str, str]] = [
#     # System destruction
#     (r"\bdd\b.*\bif=/dev/(zero|random)\b", "dd with destructive input"),
#     (r"\bmkfs\.", "filesystem format"),
#     (r"\bfdisk\b", "disk partitioning"),
#     (r">\s*/dev/sd", "raw device write"),
#     # Permission escalation
#     (r"\bchmod\b.*\+s\b", "setuid/setgid bit"),
#     # System control
#     (r"\b(shutdown|reboot)\b", "system shutdown/reboot"),
#     (r"\binit\s+[06]\b", "system runlevel change"),
#     # CAWS spec/policy/waiver protection (RC defect #8).
#     # Naked rm/mv on .caws/specs/, .caws/policy.yaml, or .caws/waivers/ bypasses
#     # the audit trail. Use `caws specs close|archive`, `caws waiver revoke`,
#     # or edit policy.yaml in place via Edit (not Bash) instead.
#     (r"\b(rm|mv)\b[^\n]*\.caws/specs/[^\s'\"]*\.ya?ml\b",
#      "naked rm/mv on .caws/specs/*.yaml — use `caws specs close|archive <id>`"),
#     (r"\b(rm|mv)\b[^\n]*\.caws/policy\.ya?ml\b",
#      "naked rm/mv on .caws/policy.yaml — policy is governed; use Edit and a CAWS waiver"),
#     (r"\b(rm|mv)\b[^\n]*\.caws/waivers/[^\s'\"]*\.ya?ml\b",
#      "naked rm/mv on .caws/waivers/*.yaml — use `caws waiver revoke <id>`"),
# ]

# READ_ONLY_COMMANDS: set[str] = {
#     "tail",
#     "head",
#     "cat",
#     "less",
#     "more",
#     "wc",
#     "stat",
#     "file",
#     "du",
#     "df",
#     "ls",
#     "tree",
#     "grep",
#     "rg",
# }

# FIND_MUTATING_FLAGS: set[str] = {
#     "-delete",
#     "-exec",
#     "-execdir",
#     "-fprint",
#     "-fprint0",
#     "-ok",
#     "-okdir",
# }

# GH_GLOBAL_OPTIONS_WITH_VALUE: set[str] = {
#     "-R",
#     "--repo",
#     "--hostname",
#     "--config-dir",
# }

# GH_GLOBAL_OPTIONS_NO_VALUE: set[str] = {
#     "--help",
# }

# # Segment-level regex patterns that require user confirmation.
# CONFIRM_SEGMENT_PATTERNS: list[tuple[str, str]] = [
#     # Git destructive operations
#     (r"\bgit\s+reset\s+--hard\b", "git reset --hard"),
#     (r"\bgit\s+push\s+(-f\b|--force\b|--force-with-lease\b)", "git force push"),
#     (r"\bgit\s+clean\s+-[a-zA-Z]*f", "git clean with force"),
#     (r"\bgit\s+checkout\s+\.\s*$", "git checkout . (discard all changes)"),
#     (r"\bgit\s+restore\s+\.\s*$", "git restore . (discard all changes)"),
#     (r"\bgit\s+rebase\b", "git rebase (rewrites branch history)"),
#     (r"\bgit\s+cherry-pick\b", "git cherry-pick (replays commits across branches)"),
#     # chmod 777
#     (r"\bchmod\b.*\b777\b", "chmod 777"),
#     # History manipulation
#     (r"\bhistory\s+-c\b", "history clear"),
#     # sudo (not in allowed list)
#     (r"^sudo\s+(?!npm|yarn|pnpm|brew|apt-get|apt|dnf|yum)", "sudo command"),
#     # venv creation (sprawl prevention)
#     (r"\bpython3?\s+-m\s+venv\b", "virtual environment creation"),
#     (r"\bvirtualenv\s", "virtual environment creation"),
#     (r"\bconda\s+create\b", "conda environment creation"),
#     # Credential file reads
#     (r"\bcat\b.*\.(env|ssh/|aws/)", "credential file read"),
#     (r"\bcat\b.*/etc/(passwd|shadow)\b", "system credential read"),
#     (r"\bcat\b.*(id_rsa|credentials)\b", "credential file read"),
# ]

# GIT_GLOBAL_OPTIONS_WITH_VALUE: set[str] = {
#     "-C",
#     "-c",
#     "--git-dir",
#     "--work-tree",
#     "--namespace",
#     "--exec-path",
# }

# GIT_GLOBAL_OPTIONS_NO_VALUE: set[str] = {
#     "--bare",
#     "--no-pager",
#     "--paginate",
#     "--no-replace-objects",
#     "--literal-pathspecs",
#     "--glob-pathspecs",
#     "--noglob-pathspecs",
#     "--icase-pathspecs",
# }

# COMMAND_WRAPPERS: set[str] = {
#     "builtin",
#     "command",
#     "nohup",
# }

# SHELL_C_WRAPPERS: set[str] = {
#     "bash",
#     "dash",
#     "sh",
#     "zsh",
# }


# # ---------------------------------------------------------------------------
# # Command segmentation
# # ---------------------------------------------------------------------------

# def segment_command(raw: str) -> list[str]:
#     """Split a shell command string on &&, ||, ;, | operators.

#     Respects quoted strings so that e.g. git commit -m "rm -rf /" does not
#     split inside the quotes.  Returns individual command segments with
#     leading/trailing whitespace stripped.

#     This is intentionally conservative: if we cannot parse, we return
#     the entire string as one segment so it still gets classified.
#     """
#     segments: list[str] = []
#     current: list[str] = []
#     i = 0
#     in_single = False
#     in_double = False
#     in_heredoc: str | None = None
#     heredoc_marker: str = ""

#     while i < len(raw):
#         ch = raw[i]

#         # ---- heredoc detection ----
#         # Look for <<EOF or <<'EOF' or <<"EOF" at segment level
#         if not in_single and not in_double and in_heredoc is None:
#             if raw[i:i+2] == "<<":
#                 # Extract the delimiter
#                 j = i + 2
#                 while j < len(raw) and raw[j] in (' ', '\t'):
#                     j += 1
#                 # Strip optional quotes around delimiter
#                 quote_char = None
#                 if j < len(raw) and raw[j] in ("'", '"'):
#                     quote_char = raw[j]
#                     j += 1
#                 k = j
#                 while k < len(raw) and raw[k] not in (' ', '\t', '\n', "'", '"', ')'):
#                     k += 1
#                 if k > j:
#                     heredoc_marker = raw[j:k]
#                     in_heredoc = heredoc_marker
#                     # Skip to end of this line
#                     nl = raw.find('\n', i)
#                     if nl >= 0:
#                         current.append(raw[i:nl+1])
#                         i = nl + 1
#                     else:
#                         current.append(raw[i:])
#                         i = len(raw)
#                     continue

#         # ---- inside heredoc: scan for closing marker ----
#         if in_heredoc is not None:
#             nl = raw.find('\n', i)
#             if nl < 0:
#                 # No newline found, rest is heredoc content
#                 current.append(raw[i:])
#                 i = len(raw)
#                 continue
#             line = raw[i:nl]
#             current.append(raw[i:nl+1])
#             i = nl + 1
#             if line.strip() == in_heredoc:
#                 in_heredoc = None
#             continue

#         # ---- quoting ----
#         if ch == '\\' and not in_single:
#             current.append(raw[i:i+2])
#             i += 2
#             continue
#         if ch == "'" and not in_double:
#             in_single = not in_single
#             current.append(ch)
#             i += 1
#             continue
#         if ch == '"' and not in_single:
#             in_double = not in_double
#             current.append(ch)
#             i += 1
#             continue

#         # ---- segment separators (only outside quotes) ----
#         if not in_single and not in_double:
#             # && or ||
#             if raw[i:i+2] in ('&&', '||'):
#                 seg = ''.join(current).strip()
#                 if seg:
#                     segments.append(seg)
#                 current = []
#                 i += 2
#                 continue
#             # ; (but not ;;)
#             if ch == ';' and (i + 1 >= len(raw) or raw[i+1] != ';'):
#                 seg = ''.join(current).strip()
#                 if seg:
#                     segments.append(seg)
#                 current = []
#                 i += 1
#                 continue
#             # | (but not ||, already handled above)
#             if ch == '|':
#                 seg = ''.join(current).strip()
#                 if seg:
#                     segments.append(seg)
#                 current = []
#                 i += 1
#                 continue

#         current.append(ch)
#         i += 1

#     seg = ''.join(current).strip()
#     if seg:
#         segments.append(seg)

#     return segments if segments else [raw.strip()]


# def strip_quotes(s: str) -> str:
#     """Remove surrounding quotes from a shell token."""
#     if len(s) >= 2:
#         if (s[0] == '"' and s[-1] == '"') or (s[0] == "'" and s[-1] == "'"):
#             return s[1:-1]
#     return s


# def command_basename(token: str) -> str:
#     """Return the executable basename for a command token."""
#     return Path(token).name


# def is_assignment_token(token: str) -> bool:
#     """Return true for shell-style NAME=value assignment tokens."""
#     return re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", token) is not None


# def skip_env_prefix(tokens: Sequence[str], index: int) -> tuple[int, list[str] | None]:
#     """Skip env options and assignments after an env wrapper."""
#     i = index
#     while i < len(tokens):
#         tok = tokens[i]
#         if tok == "--":
#             return i + 1, None
#         if is_assignment_token(tok):
#             i += 1
#             continue
#         if tok in ("-i", "-0", "--ignore-environment", "--null"):
#             i += 1
#             continue
#         if tok in ("-u", "--unset", "-C", "--chdir", "-S", "--split-string"):
#             if tok in ("-S", "--split-string") and i + 1 < len(tokens):
#                 return i, [" ".join(tokens[i + 1:])]
#             i += 2
#             continue
#         if tok.startswith("--split-string="):
#             nested = tok.split("=", 1)[1]
#             if i + 1 < len(tokens):
#                 nested = " ".join([nested, *tokens[i + 1:]])
#             return i, [nested]
#         if tok.startswith("--unset=") or tok.startswith("--chdir=") or tok.startswith("--split-string="):
#             i += 1
#             continue
#         return i, None
#     return i, None


# def normalize_command_tokens(tokens: Sequence[str]) -> tuple[int, list[str] | None]:
#     """Strip variable assignments and simple command wrappers.

#     Returns the index of the real command. If the command is a shell -c wrapper,
#     returns a nested command string list so the caller can classify it
#     recursively.
#     """
#     i = 0
#     while i < len(tokens):
#         tok = tokens[i]
#         base = command_basename(tok)

#         if is_assignment_token(tok):
#             i += 1
#             continue

#         if base == "env":
#             i, nested = skip_env_prefix(tokens, i + 1)
#             if nested is not None:
#                 return i, nested
#             continue

#         if base == "time":
#             i += 1
#             while i < len(tokens) and tokens[i].startswith("-"):
#                 if tokens[i] in ("-f", "-o"):
#                     i += 2
#                 else:
#                     i += 1
#             continue

#         if base in COMMAND_WRAPPERS:
#             i += 1
#             continue

#         if base in SHELL_C_WRAPPERS:
#             j = i + 1
#             while j < len(tokens):
#                 arg = tokens[j]
#                 if arg == "--":
#                     j += 1
#                     continue
#                 if arg.startswith("-") and "c" in arg[1:]:
#                     if j + 1 < len(tokens):
#                         return i, [tokens[j + 1]]
#                     return i, [""]
#                 if not arg.startswith("-"):
#                     break
#                 j += 1

#         return i, None

#     return i, None


# def detect_git_subcommand(segment: str) -> str | None:
#     """Detect the semantic Git subcommand for one executable segment.

#     This recognizes wrappers such as env/command/nohup/time, absolute Git
#     executable paths, and Git global options before the real subcommand.
#     """
#     try:
#         tokens = shlex.split(segment)
#     except ValueError:
#         return None

#     if not tokens:
#         return None

#     start, nested = normalize_command_tokens(tokens)
#     if nested is not None:
#         return None
#     if start >= len(tokens) or command_basename(tokens[start]) != "git":
#         return None

#     i = start + 1
#     while i < len(tokens):
#         tok = tokens[i]
#         if tok == "--":
#             i += 1
#             break
#         if tok in GIT_GLOBAL_OPTIONS_WITH_VALUE:
#             i += 2
#             continue
#         if any(tok.startswith(f"{opt}=") for opt in GIT_GLOBAL_OPTIONS_WITH_VALUE if opt.startswith("--")):
#             i += 1
#             continue
#         if tok in GIT_GLOBAL_OPTIONS_NO_VALUE:
#             i += 1
#             continue
#         if tok.startswith("-"):
#             # Unknown global option. If it has an inline value, skip it;
#             # otherwise stop so we do not accidentally skip a subcommand.
#             if "=" in tok:
#                 i += 1
#                 continue
#             break
#         return tok

#     if i < len(tokens) and not tokens[i].startswith("-"):
#         return tokens[i]
#     return None


# def git_alias_value_invokes_init(value: str) -> bool:
#     """Return true when a `git -c alias.*=...` value routes to init."""
#     stripped = value.strip()
#     if not stripped:
#         return False
#     if stripped == "init" or stripped.startswith("init "):
#         return True
#     if stripped.startswith("!"):
#         nested = stripped[1:].strip()
#         return detect_git_subcommand(nested) == "init" or nested == "init" or nested.startswith("init ")
#     return False


# def has_git_init_alias_config(segment: str) -> bool:
#     """Detect inline Git alias definitions that route an alias to init."""
#     try:
#         tokens = shlex.split(segment)
#     except ValueError:
#         return False

#     if not tokens:
#         return False

#     start, nested = normalize_command_tokens(tokens)
#     if nested is not None or start >= len(tokens) or command_basename(tokens[start]) != "git":
#         return False

#     i = start + 1
#     while i < len(tokens):
#         tok = tokens[i]
#         config_value = None
#         if tok == "-c" and i + 1 < len(tokens):
#             config_value = tokens[i + 1]
#             i += 2
#         elif tok.startswith("-c") and len(tok) > 2:
#             config_value = tok[2:]
#             i += 1
#         else:
#             i += 1

#         if not config_value or "=" not in config_value:
#             continue
#         key, value = config_value.split("=", 1)
#         if key.startswith("alias.") and git_alias_value_invokes_init(value):
#             return True

#     return False


# def classify_nested_shell(segment: str, repo_root: Path, home: Path, cwd: Path, caws_worktree: bool) -> tuple[str, str] | None:
#     """Recursively classify sh/bash/zsh -c strings."""
#     try:
#         tokens = shlex.split(segment)
#     except ValueError:
#         return None

#     _, nested = normalize_command_tokens(tokens)
#     if not nested:
#         return None

#     return classify_command(nested[0], repo_root, home, cwd, caws_worktree)


# def classify_git_semantics(
#     segment: str,
#     caws_worktree: bool,
#     repo_root: Path | None = None,
# ) -> tuple[str, str] | None:
#     """Classify Git operations by executable/subcommand semantics.

#     When `caws_worktree` is true (a trusted git-init context exists) and
#     the segment is a git-init variant, the trusted token is consumed
#     here. If consumption fails (the token was removed by a concurrent
#     classifier run, or another git-init segment in the same command
#     already consumed it), the segment falls back to `ask` so the human
#     review boundary still engages.
#     """
#     is_init_alias = has_git_init_alias_config(segment)
#     subcommand = detect_git_subcommand(segment) if not is_init_alias else None

#     if is_init_alias:
#         if caws_worktree and repo_root is not None and consume_trusted_git_init_context(repo_root):
#             return "allow", ""
#         return "ask", "git alias routes to init and requires human approval"

#     if subcommand is None:
#         return None

#     if subcommand == "init":
#         if caws_worktree and repo_root is not None and consume_trusted_git_init_context(repo_root):
#             return "allow", ""
#         return "ask", "git init requires human approval; do not retry by wrapping, reordering, aliasing, or indirect invocation"

#     if subcommand == "pull":
#         return "ask", "git pull mutates the worktree and requires human approval"

#     if subcommand == "fetch" and "--prune" in _git_args_after_subcommand(segment):
#         return "ask", "git fetch --prune mutates remote-tracking refs"

#     if subcommand == "reset":
#         return "ask", "git reset requires human approval"

#     if subcommand == "rebase":
#         return "ask", "git rebase rewrites branch history"

#     if subcommand == "cherry-pick":
#         return "ask", "git cherry-pick replays commits across branches"

#     if subcommand == "stash":
#         return "ask", "git stash mutates worktree state"

#     if subcommand == "checkout":
#         return "ask", "git checkout mutates worktree or branch state"

#     return None


# def normalized_segment_tokens(segment: str) -> tuple[list[str], int] | None:
#     """Return parsed tokens and the normalized executable index."""
#     try:
#         tokens = shlex.split(segment)
#     except ValueError:
#         return None
#     if not tokens:
#         return None
#     start, nested = normalize_command_tokens(tokens)
#     if nested is not None or start >= len(tokens):
#         return None
#     return tokens, start


# def _git_args_after_subcommand(segment: str) -> list[str]:
#     parsed = normalized_segment_tokens(segment)
#     if parsed is None:
#         return []
#     tokens, start = parsed
#     if command_basename(tokens[start]) != "git":
#         return []

#     i = start + 1
#     while i < len(tokens):
#         tok = tokens[i]
#         if tok == "--":
#             i += 1
#             break
#         if tok in GIT_GLOBAL_OPTIONS_WITH_VALUE:
#             i += 2
#             continue
#         if any(tok.startswith(f"{opt}=") for opt in GIT_GLOBAL_OPTIONS_WITH_VALUE if opt.startswith("--")):
#             i += 1
#             continue
#         if tok in GIT_GLOBAL_OPTIONS_NO_VALUE:
#             i += 1
#             continue
#         if tok.startswith("-"):
#             if "=" in tok:
#                 i += 1
#                 continue
#             break
#         return tokens[i + 1:]
#     return []


# def _find_has_mutating_action(segment: str) -> bool:
#     parsed = normalized_segment_tokens(segment)
#     if parsed is None:
#         return False
#     tokens, start = parsed
#     if command_basename(tokens[start]) != "find":
#         return False
#     return any(tok in FIND_MUTATING_FLAGS for tok in tokens[start + 1:])


# def _has_option(tokens: Sequence[str], options: set[str]) -> bool:
#     return any(tok in options or any(tok.startswith(f"{opt}=") for opt in options if opt.startswith("--")) for tok in tokens)


# def _skip_gh_globals(tokens: Sequence[str], start: int) -> int:
#     i = start + 1
#     while i < len(tokens):
#         tok = tokens[i]
#         if tok == "--":
#             return i + 1
#         if tok in GH_GLOBAL_OPTIONS_WITH_VALUE:
#             i += 2
#             continue
#         if any(tok.startswith(f"{opt}=") for opt in GH_GLOBAL_OPTIONS_WITH_VALUE if opt.startswith("--")):
#             i += 1
#             continue
#         if tok in GH_GLOBAL_OPTIONS_NO_VALUE:
#             i += 1
#             continue
#         return i
#     return i


# def _gh_api_method(args: Sequence[str]) -> str:
#     i = 0
#     while i < len(args):
#         tok = args[i]
#         if tok in ("-X", "--method"):
#             return args[i + 1].upper() if i + 1 < len(args) else ""
#         if tok.startswith("-X") and len(tok) > 2:
#             return tok[2:].upper()
#         if tok.startswith("--method="):
#             return tok.split("=", 1)[1].upper()
#         i += 1
#     return "GET"


# def classify_gh_semantics(segment: str) -> tuple[str, str] | None:
#     parsed = normalized_segment_tokens(segment)
#     if parsed is None:
#         return None
#     tokens, start = parsed
#     if command_basename(tokens[start]) != "gh":
#         return None

#     i = _skip_gh_globals(tokens, start)
#     if i >= len(tokens):
#         return None
#     group = tokens[i]
#     sub = tokens[i + 1] if i + 1 < len(tokens) else ""
#     args = tokens[i + 2:]

#     readonly = {
#         ("pr", "view"),
#         ("pr", "status"),
#         ("pr", "list"),
#         ("pr", "checks"),
#         ("pr", "diff"),
#         ("run", "view"),
#         ("run", "list"),
#         ("issue", "view"),
#         ("issue", "list"),
#         ("repo", "view"),
#         ("release", "view"),
#         ("release", "list"),
#     }
#     mutating = {
#         ("pr", "merge"),
#         ("pr", "edit"),
#         ("pr", "close"),
#         ("pr", "reopen"),
#         ("pr", "ready"),
#         ("pr", "comment"),
#         ("run", "rerun"),
#         ("run", "cancel"),
#         ("run", "delete"),
#         ("workflow", "run"),
#         ("workflow", "enable"),
#         ("workflow", "disable"),
#         ("release", "create"),
#         ("release", "edit"),
#         ("release", "delete"),
#         ("issue", "create"),
#         ("issue", "edit"),
#         ("issue", "close"),
#     }

#     if (group, sub) in mutating:
#         return "ask", f"gh {group} {sub} mutates GitHub state"
#     if group == "pr" and sub == "review" and _has_option(args, {"--approve", "--request-changes", "--comment"}):
#         return "ask", "gh pr review mutates pull request review state"
#     if group == "api":
#         method = _gh_api_method(tokens[i + 1:])
#         if method == "GET":
#             return "allow", ""
#         return "ask", f"gh api -X {method} mutates or may mutate GitHub state"
#     if (group, sub) in readonly:
#         return "allow", ""
#     return None


# def classify_npm_semantics(segment: str) -> tuple[str, str] | None:
#     parsed = normalized_segment_tokens(segment)
#     if parsed is None:
#         return None
#     tokens, start = parsed
#     if command_basename(tokens[start]) not in ("npm", "npm-cli.js"):
#         return None
#     if start + 1 >= len(tokens):
#         return None

#     cmd = tokens[start + 1]
#     args = tokens[start + 2:]

#     if cmd in ("view", "whoami", "ls", "outdated", "explain"):
#         return "allow", ""
#     if cmd == "config" and args[:1] == ["get"]:
#         return "allow", ""
#     if cmd == "pack":
#         if "--dry-run" in args:
#             return "allow", ""
#         return "ask", "npm pack without --dry-run creates an artifact"

#     mutating = {"publish", "deprecate", "unpublish", "owner", "access", "install", "uninstall", "version"}
#     if cmd in mutating:
#         return "ask", f"npm {cmd} mutates package or dependency state"
#     if cmd == "dist-tag" and args[:1] == ["add"]:
#         return "ask", "npm dist-tag add mutates registry state"
#     return None


# def classify_sed_perl_semantics(segment: str) -> tuple[str, str] | None:
#     parsed = normalized_segment_tokens(segment)
#     if parsed is None:
#         return None
#     tokens, start = parsed
#     cmd = command_basename(tokens[start])
#     args = tokens[start + 1:]
#     if cmd == "sed":
#         if any(tok == "-i" or tok.startswith("-i") for tok in args):
#             return "ask", "sed -i edits files in place"
#         if "-n" in args:
#             return "allow", ""
#     if cmd == "perl" and any(tok == "-pi" or tok.startswith("-pi") or tok == "-i" or tok.startswith("-i") for tok in args):
#         return "ask", "perl -pi edits files in place"
#     return None


# def classify_allow_list(segment: str) -> tuple[str, str] | None:
#     parsed = normalized_segment_tokens(segment)
#     if parsed is None:
#         return None
#     tokens, start = parsed
#     cmd = command_basename(tokens[start])

#     if cmd in READ_ONLY_COMMANDS:
#         return "allow", ""
#     if cmd == "find" and not _find_has_mutating_action(segment):
#         return "allow", ""

#     subcommand = detect_git_subcommand(segment)
#     if subcommand is not None:
#         args = _git_args_after_subcommand(segment)
#         if subcommand in {"status", "log", "diff", "show", "rev-parse", "ls-files", "blame"}:
#             return "allow", ""
#         if subcommand == "branch" and not any(arg in {"-d", "-D", "-m", "-M", "--delete", "--move"} for arg in args):
#             return "allow", ""
#         if subcommand == "tag" and args and all(arg in {"--list", "-l"} or not arg.startswith("-") for arg in args):
#             return "allow", ""
#         if subcommand == "remote" and args == ["-v"]:
#             return "allow", ""
#         if subcommand == "config" and args[:1] == ["--get"]:
#             return "allow", ""

#     return classify_gh_semantics(segment) or classify_npm_semantics(segment) or classify_sed_perl_semantics(segment)


# def _trusted_git_init_token_path(repo_root: Path) -> Path | None:
#     """Return the trusted git-init allow-token path if the env signals it.

#     Validation only — does not check disk presence and does not consume.
#     """
#     if os.environ.get("CAWS_TRUSTED_WORKTREE_CREATE_CONTEXT", "0") != "1":
#         return None
#     nonce = os.environ.get("CAWS_TRUSTED_HOOK_NONCE", "")
#     if not re.match(r"^[A-Za-z0-9._-]{8,128}$", nonce):
#         return None
#     return repo_root / ".claude" / "hooks" / "state" / f"allow-git-init-{nonce}"


# def has_trusted_git_init_context(repo_root: Path) -> bool:
#     """Return true when dispatch created a one-shot git-init allow token."""
#     token = _trusted_git_init_token_path(repo_root)
#     return token is not None and token.is_file()


# def consume_trusted_git_init_context(repo_root: Path) -> bool:
#     """Atomically consume the trusted git-init allow token.

#     Returns true if a valid token existed and was removed. The token is
#     one-shot: a subsequent git-init in the same dispatch will be subject
#     to normal classification (which means `ask`). Dispatch must mint a
#     fresh nonce + token for each authorized lifecycle operation.
#     """
#     token = _trusted_git_init_token_path(repo_root)
#     if token is None or not token.is_file():
#         return False
#     try:
#         token.unlink()
#     except OSError:
#         return False
#     return True


# def extract_command_word(segment: str) -> str:
#     """Extract the first command word from a segment.

#     Strips leading variable assignments (FOO=bar), env prefixes,
#     and common wrappers like 'time'.
#     """
#     try:
#         tokens = shlex.split(segment)
#     except ValueError:
#         # Malformed quoting — return raw first word
#         return segment.split()[0] if segment.split() else ""

#     for tok in tokens:
#         # Skip variable assignments
#         if '=' in tok and not tok.startswith('-'):
#             continue
#         # Skip common prefixes
#         if tok in ('env', 'time', 'nice', 'nohup', 'command', 'builtin'):
#             continue
#         return tok
#     return ""


# # ---------------------------------------------------------------------------
# # rm classifier
# # ---------------------------------------------------------------------------

# def is_recursive_rm(segment: str) -> tuple[bool, list[str]]:
#     """Check if a segment is an rm command with recursive flags.

#     Returns (is_recursive, [target_paths]).
#     """
#     try:
#         tokens = shlex.split(segment)
#     except ValueError:
#         # Cannot parse — be conservative
#         if re.search(r'\brm\b', segment) and re.search(r'-[a-zA-Z]*r', segment):
#             return True, []
#         return False, []

#     if not tokens:
#         return False, []

#     # Find the rm command (skip env/time prefixes)
#     rm_idx = -1
#     for idx, tok in enumerate(tokens):
#         if tok in ('env', 'time', 'nice', 'nohup', 'command', 'builtin'):
#             continue
#         if '=' in tok and not tok.startswith('-'):
#             continue
#         if tok == 'rm':
#             rm_idx = idx
#         break

#     if rm_idx < 0:
#         return False, []

#     # Check for recursive flag
#     is_recursive = False
#     targets: list[str] = []
#     i = rm_idx + 1
#     while i < len(tokens):
#         tok = tokens[i]
#         if tok == '--':
#             # Everything after -- is targets
#             targets.extend(tokens[i+1:])
#             break
#         if tok.startswith('-') and not tok.startswith('--'):
#             if 'r' in tok or 'R' in tok:
#                 is_recursive = True
#         elif tok.startswith('--'):
#             if tok == '--recursive':
#                 is_recursive = True
#             # Other long options: skip
#         else:
#             targets.append(tok)
#         i += 1

#     return is_recursive, targets


# def classify_rm_target(
#     target: str,
#     repo_root: Path,
#     home: Path,
#     cwd: Path,
# ) -> tuple[str, str]:
#     """Classify a single rm target path.

#     Returns ("deny"|"ask"|"allow", reason).
#     """
#     # Resolve the target to an absolute path
#     raw = target.strip()
#     if not raw:
#         return "deny", "empty target on recursive delete"

#     # Handle glob-like patterns conservatively
#     if any(c in raw for c in ('*', '?', '[', ']')):
#         # Check if it is /* or ~/* which are catastrophic
#         stripped = raw.rstrip('/')
#         if stripped in ('/*', '~/*', './*'):
#             return "deny", f"glob expansion at dangerous root: {raw}"
#         # Other globs: confirm
#         return "ask", f"recursive delete with glob pattern: {raw}"

#     # Resolve path
#     try:
#         if raw.startswith('~'):
#             resolved = (home / raw[2:]).resolve(strict=False) if len(raw) > 1 else home
#         elif raw.startswith('/'):
#             resolved = Path(raw).resolve(strict=False)
#         else:
#             resolved = (cwd / raw).resolve(strict=False)
#     except (ValueError, OSError):
#         return "ask", f"cannot resolve path: {raw}"

#     resolved_str = str(resolved)
#     repo_str = str(repo_root)
#     home_str = str(home)

#     # Hard-block: root, home, repo root
#     if resolved_str == '/':
#         return "deny", f"recursive delete targets filesystem root"
#     if resolved_str == home_str:
#         return "deny", f"recursive delete targets home directory"
#     if resolved_str == repo_str:
#         return "deny", f"recursive delete targets repository root"

#     # Check if resolved path is a parent of repo or home (even worse)
#     if repo_str.startswith(resolved_str + '/'):
#         return "deny", f"recursive delete targets ancestor of repository: {raw}"
#     if home_str.startswith(resolved_str + '/'):
#         return "deny", f"recursive delete targets ancestor of home directory: {raw}"

#     # Allow: known safe prefixes (relative to repo root)
#     try:
#         rel = resolved.relative_to(repo_root)
#         rel_str = str(rel) + '/'
#         for prefix in SAFE_DELETE_PREFIXES:
#             if rel_str.startswith(prefix):
#                 return "allow", ""
#     except ValueError:
#         pass  # Not inside repo root

#     # Default: confirm
#     return "ask", f"recursive delete: {raw}"


# def classify_find_delete(segment: str) -> tuple[str, str] | None:
#     """Check if segment is a find command with -delete or -exec rm.

#     Returns classification tuple or None if not a find-delete.
#     """
#     try:
#         tokens = shlex.split(segment)
#     except ValueError:
#         return None

#     cmd = extract_command_word(segment)
#     if cmd != 'find':
#         return None

#     has_delete = '-delete' in tokens
#     has_exec_rm = False
#     for i, tok in enumerate(tokens):
#         if tok == '-exec' and i + 1 < len(tokens) and 'rm' in tokens[i + 1]:
#             has_exec_rm = True
#             break

#     if not has_delete and not has_exec_rm:
#         return None

#     return "ask", f"find with delete action"


# def extract_command_substitutions(raw: str) -> list[str]:
#     """Return the bodies of every $(...) and `...` substitution in raw.

#     Bash executes command substitutions even when they appear inside double
#     quotes; only single-quoted regions suppress them. Callers should pass
#     each body back through the classifier so a nested `$(rm -rf /)` or
#     `$(git reset --hard)` is not treated as inert text.

#     Single-quoted regions, escaped `\\$` and `\\``, and heredoc bodies are
#     skipped. Nested `$(...)` is supported by balancing parentheses.
#     """
#     bodies: list[str] = []
#     i = 0
#     in_single = False
#     in_heredoc: str | None = None

#     while i < len(raw):
#         ch = raw[i]

#         # Heredoc tracking: bodies are inert as far as substitutions go
#         # (heredoc expansion is its own surface; classify_command will see
#         # the raw text and apply the same rules).
#         if in_heredoc is not None:
#             nl = raw.find('\n', i)
#             if nl < 0:
#                 break
#             line = raw[i:nl]
#             i = nl + 1
#             if line.strip() == in_heredoc:
#                 in_heredoc = None
#             continue

#         if not in_single and raw[i:i+2] == "<<":
#             j = i + 2
#             while j < len(raw) and raw[j] in (' ', '\t'):
#                 j += 1
#             if j < len(raw) and raw[j] in ("'", '"'):
#                 j += 1
#             k = j
#             while k < len(raw) and raw[k] not in (' ', '\t', '\n', "'", '"', ')'):
#                 k += 1
#             if k > j:
#                 in_heredoc = raw[j:k]
#                 nl = raw.find('\n', i)
#                 i = nl + 1 if nl >= 0 else len(raw)
#                 continue

#         # Escape: `\$`, `\``, and `\\` suppress substitution recognition.
#         if ch == '\\' and i + 1 < len(raw):
#             i += 2
#             continue

#         # Single quotes suppress everything inside; toggle and skip.
#         if ch == "'":
#             in_single = not in_single
#             i += 1
#             continue

#         if in_single:
#             i += 1
#             continue

#         # $(...) substitution — find the matching close paren, respecting
#         # nesting and quoted regions inside the body.
#         if ch == '$' and i + 1 < len(raw) and raw[i+1] == '(':
#             depth = 1
#             j = i + 2
#             inner_single = False
#             inner_double = False
#             while j < len(raw) and depth > 0:
#                 c = raw[j]
#                 if c == '\\' and j + 1 < len(raw):
#                     j += 2
#                     continue
#                 if not inner_double and c == "'":
#                     inner_single = not inner_single
#                 elif not inner_single and c == '"':
#                     inner_double = not inner_double
#                 elif not inner_single and not inner_double:
#                     if c == '(':
#                         depth += 1
#                     elif c == ')':
#                         depth -= 1
#                         if depth == 0:
#                             bodies.append(raw[i+2:j])
#                             j += 1
#                             break
#                 j += 1
#             i = j
#             continue

#         # Backtick substitution. Bash does not support nesting inside the
#         # same backtick pair (you need `\``), so a simple scan to the next
#         # unescaped backtick is sufficient.
#         if ch == '`':
#             j = i + 1
#             while j < len(raw):
#                 c = raw[j]
#                 if c == '\\' and j + 1 < len(raw):
#                     j += 2
#                     continue
#                 if c == '`':
#                     bodies.append(raw[i+1:j])
#                     j += 1
#                     break
#                 j += 1
#             i = j
#             continue

#         i += 1

#     return bodies


# def strip_quoted_regions(raw: str) -> str:
#     """Remove content inside single/double quotes and heredocs.

#     Returns only the executable shell surface — quoted literals, heredoc
#     bodies, and $(...) subshell content embedded in quotes are replaced
#     with whitespace so that regex patterns only match actual commands.

#     Note: command substitutions inside double quotes execute in Bash. This
#     helper still blanks them so the surrounding command's literal pattern
#     matching is not confused; callers handle substitutions separately via
#     extract_command_substitutions().
#     """
#     result: list[str] = []
#     i = 0
#     in_single = False
#     in_double = False
#     in_heredoc: str | None = None

#     while i < len(raw):
#         ch = raw[i]

#         # Heredoc detection (outside quotes)
#         if not in_single and not in_double and in_heredoc is None:
#             if raw[i:i+2] == "<<":
#                 j = i + 2
#                 while j < len(raw) and raw[j] in (' ', '\t'):
#                     j += 1
#                 if j < len(raw) and raw[j] in ("'", '"'):
#                     j += 1
#                 k = j
#                 while k < len(raw) and raw[k] not in (' ', '\t', '\n', "'", '"', ')'):
#                     k += 1
#                 if k > j:
#                     in_heredoc = raw[j:k]
#                     # Keep the << marker but skip to end of line
#                     result.append(raw[i:i+2])
#                     nl = raw.find('\n', i)
#                     if nl >= 0:
#                         i = nl + 1
#                     else:
#                         i = len(raw)
#                     continue

#         # Inside heredoc: skip until closing marker
#         if in_heredoc is not None:
#             nl = raw.find('\n', i)
#             if nl < 0:
#                 i = len(raw)
#                 continue
#             line = raw[i:nl]
#             i = nl + 1
#             if line.strip() == in_heredoc:
#                 in_heredoc = None
#             else:
#                 result.append(' ')  # placeholder
#             continue

#         # Escape handling
#         if ch == '\\' and not in_single:
#             result.append(' ')
#             i += 2
#             continue

#         # Quote tracking
#         if ch == "'" and not in_double:
#             if in_single:
#                 in_single = False
#             else:
#                 in_single = True
#             i += 1
#             continue
#         if ch == '"' and not in_single:
#             if in_double:
#                 in_double = False
#             else:
#                 in_double = True
#             i += 1
#             continue

#         # Inside quotes: replace with space
#         if in_single or in_double:
#             result.append(' ')
#             i += 1
#             continue

#         result.append(ch)
#         i += 1

#     return ''.join(result)


# # ---------------------------------------------------------------------------
# # Main classifier
# # ---------------------------------------------------------------------------

# def classify_command(
#     raw_command: str,
#     repo_root: Path,
#     home: Path,
#     cwd: Path,
#     caws_worktree: bool = False,
# ) -> tuple[str, str]:
#     """Classify a full command string.

#     Returns the most restrictive (decision, reason) across all segments.
#     Priority: deny > ask > allow.
#     """
#     worst_decision = "allow"
#     worst_reason = ""

#     def escalate(decision: str, reason: str) -> None:
#         nonlocal worst_decision, worst_reason
#         priority = {"allow": 0, "ask": 1, "deny": 2}
#         if priority.get(decision, 0) > priority.get(worst_decision, 0):
#             worst_decision = decision
#             worst_reason = reason

#     # --- Pipeline-aware deny patterns ---
#     # Strip quoted regions so patterns only match executable shell surface.
#     # This prevents commit messages, echo arguments, etc. from triggering.
#     executable_surface = strip_quoted_regions(raw_command)
#     for pattern, desc in DENY_PIPELINE_PATTERNS:
#         if re.search(pattern, executable_surface, re.IGNORECASE):
#             escalate("deny", desc)

#     # --- Recursively classify command substitutions ---
#     # Bash executes `$(...)` and backtick substitutions even inside double
#     # quotes; single-quoted bodies are skipped by extract_command_substitutions.
#     # Each extracted body is classified as if it were an independent command.
#     for body in extract_command_substitutions(raw_command):
#         if not body.strip():
#             continue
#         sub_decision, sub_reason = classify_command(
#             body, repo_root, home, cwd, caws_worktree,
#         )
#         if sub_decision != "allow":
#             escalate(sub_decision, f"command substitution: {sub_reason}")

#     segments = segment_command(raw_command)

#     for segment in segments:
#         segment_decision = "allow"
#         segment_reason = ""

#         def classify_segment(decision: str, reason: str) -> None:
#             nonlocal segment_decision, segment_reason
#             priority = {"allow": 0, "ask": 1, "deny": 2}
#             if (
#                 priority.get(decision, 0) > priority.get(segment_decision, 0)
#             ):
#                 segment_decision = decision
#                 segment_reason = reason

#         nested_result = classify_nested_shell(segment, repo_root, home, cwd, caws_worktree)
#         if nested_result:
#             classify_segment(*nested_result)
#             escalate(segment_decision, segment_reason)
#             continue

#         git_result = classify_git_semantics(segment, caws_worktree, repo_root)
#         if git_result:
#             classify_segment(*git_result)

#         gh_result = classify_gh_semantics(segment)
#         if gh_result:
#             classify_segment(*gh_result)

#         npm_result = classify_npm_semantics(segment)
#         if npm_result:
#             classify_segment(*npm_result)

#         sed_perl_result = classify_sed_perl_semantics(segment)
#         if sed_perl_result:
#             classify_segment(*sed_perl_result)

#         # Strip quoted regions for pattern matching so that e.g.
#         # echo "git reset --hard" does not trigger the git pattern.
#         # The original segment is still used for rm/find parsing
#         # (shlex.split handles quotes correctly for argument extraction).
#         segment_surface = strip_quoted_regions(segment)

#         # --- Hard-block patterns (segment-level) ---
#         for pattern, desc in DENY_SEGMENT_PATTERNS:
#             if re.search(pattern, segment_surface, re.IGNORECASE):
#                 classify_segment("deny", desc)

#         # --- Confirm patterns (segment-level) ---
#         for pattern, desc in CONFIRM_SEGMENT_PATTERNS:
#             if re.search(pattern, segment_surface, re.IGNORECASE):
#                 # Special case: git init in worktree context is allowed
#                 if "git init" in desc and caws_worktree:
#                     continue
#                 classify_segment("ask", desc)

#         # --- rm classifier ---
#         is_recursive, targets = is_recursive_rm(segment)
#         if is_recursive:
#             if not targets:
#                 # Cannot determine targets — be conservative
#                 classify_segment("ask", "recursive delete with unparseable targets")
#             else:
#                 for target in targets:
#                     decision, reason = classify_rm_target(
#                         target, repo_root, home, cwd,
#                     )
#                     classify_segment(decision, reason)

#         # --- find -delete classifier ---
#         find_result = classify_find_delete(segment)
#         if find_result:
#             classify_segment(*find_result)

#         allow_result = classify_allow_list(segment)
#         if allow_result and segment_decision == "allow":
#             segment_decision, segment_reason = allow_result

#         escalate(segment_decision, segment_reason)

#     return worst_decision, worst_reason


# # ---------------------------------------------------------------------------
# # Entry point
# # ---------------------------------------------------------------------------

# def main() -> None:
#     import argparse

#     parser = argparse.ArgumentParser(description="Classify shell command safety")
#     parser.add_argument("--repo-root", default=os.environ.get("CLAUDE_PROJECT_DIR", "."))
#     parser.add_argument("--home", default=str(Path.home()))
#     parser.add_argument("--cwd", default=os.getcwd())
#     args = parser.parse_args()

#     raw_command = sys.stdin.read()

#     repo_root = Path(args.repo_root).resolve(strict=False)
#     home = Path(args.home).resolve(strict=False)
#     cwd = Path(args.cwd).resolve(strict=False)
#     caws_worktree = has_trusted_git_init_context(repo_root)

#     decision, reason = classify_command(
#         raw_command, repo_root, home, cwd, caws_worktree,
#     )

#     json.dump({"decision": decision, "reason": reason}, sys.stdout)


# if __name__ == "__main__":
#     main()
