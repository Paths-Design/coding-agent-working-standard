#!/bin/bash
# CAWS-MANAGED-HOOK
# hook_pack: claude-code
# hook_pack_version: 11
# caws_min_major: 11
# lineage_refs: 1,17
# do_not_edit_directly: update via `caws init --agent-surface claude-code`
# CAWS Command Safety Gate for Claude Code
# Delegates to classify_command.py for robust command parsing and classification.
# Falls back to bash pattern matching if Python is unavailable.
#
# The Python classifier handles:
#   - Heredoc-aware parsing (won't false-positive on quoted dangerous commands)
#   - Quoted-region stripping (echo "git reset --hard" is safe)
#   - Pipeline-aware dangers (curl | sh)
#   - Context-aware rm classification (safe prefixes vs dangerous targets)
#   - Proper shell segmentation (&&, ||, ;, |)
#
# @author @darianrosebrook

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=lib/emit.sh
# Canonical Claude Code envelope emitters (HOOK-LIB-CONSOLIDATION-001 T3a).
source "$SCRIPT_DIR/lib/emit.sh" 2>/dev/null || true
# shellcheck source=lib/caws-state.sh
# sanitize_session — the canonical session-id->filename transform shared with
# reset-danger-latch.sh so the latch WRITER and CLEARER agree on the sentinel
# filename (DANGER-LATCH-UX-001).
source "$SCRIPT_DIR/lib/caws-state.sh" 2>/dev/null || true

danger_state_dir() {
  local project_dir="${CLAUDE_PROJECT_DIR:-.}"
  local state_dir="$project_dir/.claude/hooks/state"
  mkdir -p "$state_dir"
  printf '%s\n' "$state_dir"
}

danger_latch_file() {
  local session_id="$1"
  local safe_session
  # Prefer the shared lib transform (DANGER-LATCH-UX-001); fall back to the
  # identical inline transform if the lib was not sourced.
  if command -v sanitize_session >/dev/null 2>&1; then
    safe_session=$(sanitize_session "$session_id")
  else
    safe_session=$(printf '%s' "$session_id" | tr -c 'A-Za-z0-9._-' '_')
  fi
  printf '%s/danger-latch-%s.json\n' "$(danger_state_dir)" "$safe_session"
}

# Thin adapters over the canonical lib/emit.sh primitives. Kept as named
# wrappers so the 8 call-sites below stay unchanged; the envelope JSON
# lives only in lib/emit.sh (HOOK-LIB-CONSOLIDATION-001 T3a).
emit_block_json() { emit_block "$1"; }
emit_ask_json() { emit_ask "$1"; }

record_danger_latch() {
  local file="$1"
  local decision="$2"
  local reason="$3"
  local command="$4"

  mkdir -p "$(dirname "$file")"
  jq -n \
    --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg hook "block-dangerous.sh" \
    --arg decision "$decision" \
    --arg reason "$reason" \
    --arg command "$command" \
    '{
      ts: $ts,
      hook: $hook,
      decision: $decision,
      reason: $reason,
      command: $command,
      message: "Dangerous command boundary engaged. User reset required before more Bash commands may run in this session."
    }' > "$file"
}

# Classify a command via classify_command.py, echoing the decision
# ("allow" | "ask" | "deny") on stdout. Echoes "unavailable" when the
# classifier or python3 is missing so callers can fail closed. Used both
# by the sticky-latch read-only carve-out and the main classification path.
classify_decision() {
  local cmd="$1"
  local classifier="$SCRIPT_DIR/classify_command.py"
  if [[ ! -f "$classifier" ]] || ! command -v python3 >/dev/null 2>&1; then
    printf 'unavailable'
    return 0
  fi
  local result
  result=$(printf '%s' "$cmd" | python3 "$classifier" \
    --repo-root "${CLAUDE_PROJECT_DIR:-.}" \
    --home "$HOME" \
    --cwd "$(pwd)" 2>/dev/null) || {
    printf 'unavailable'
    return 0
  }
  printf '%s' "$result" | jq -r '.decision // "ask"' 2>/dev/null || printf 'ask'
}

# Does this command INVOKE the pack's own reset-danger-latch.sh escape hatch?
# Narrow match: the script must appear in invocation position — either as the
# command's first token (an optionally-pathed `reset-danger-latch.sh ...`) or
# immediately after a `bash`/`sh`/`.` launcher. It must NOT match the script
# named as an operand of another command (`rm -rf .../reset-danger-latch.sh`)
# or mentioned in a trailing comment (`git push --force # reset-danger-latch.sh`)
# — those are mutating commands smuggling the string, not the escape hatch.
# The leading-anchor is the whole command start (after optional whitespace),
# not any `;|&` separator, so a compound like `rm x; reset-danger-latch.sh`
# is judged by its FIRST (mutating) clause, not exempted by the trailing one.
# The reset is the documented way out of a sticky latch; gating it behind the
# very latch it clears is self-defeating.
is_reset_latch_invocation() {
  local cmd="$1"
  # Strip a leading run of whitespace, then require either:
  #   <optional dir/>reset-danger-latch.sh   at the very start, or
  #   bash|sh|. <optional dir/>reset-danger-latch.sh   at the very start.
  printf '%s' "$cmd" | grep -qE '^[[:space:]]*((bash|sh|\.)[[:space:]]+)?([^[:space:];|&]*/)?reset-danger-latch\.sh([[:space:]]|$)'
}

# Read JSON input from Claude Code
INPUT=$(cat)

# Extract tool info
TOOL_NAME=$(printf '%s' "$INPUT" | jq -r '.tool_name // ""')
COMMAND=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // ""')
# Fallback to "unknown" when no session id is available so the latch still
# engages. Multiple concurrent sessions without an id will share the "unknown"
# latch -- safer than not latching at all.
SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // env.CLAUDE_SESSION_ID // env.HOOK_SESSION_ID // "unknown"')

# Only check Bash tool
if [[ "$TOOL_NAME" != "Bash" ]] || [[ -z "$COMMAND" ]]; then
  exit 0
fi

LATCH_FILE="$(danger_latch_file "$SESSION_ID")"
if [[ -f "$LATCH_FILE" ]]; then
  # The latch exists to stop further MUTATION pending a human reset — not to
  # wedge the entire session. Two carve-outs let a latched agent stay useful
  # and reach its own escape hatch:
  #
  #   1. The reset escape hatch itself. A reset-danger-latch.sh invocation is
  #      the documented way out; blocking it behind the very latch it clears
  #      is self-defeating. Let it reach the shell (its --reason audit + the
  #      human running it remain the gate).
  #   2. Read-only commands. If classify_command.py rates the CURRENT command
  #      `allow` (read-only — git log, ls, cat, caws status), let it through.
  #      A read-only command was never the danger; collateral-blocking it
  #      gives a latched agent no way to diagnose. The latch stays sticky for
  #      mutating commands (not cleared here).
  #
  # Fail-closed: if the classifier is unavailable, we do NOT bypass — the
  # command stays blocked by the latch (conservative pre-existing behavior).
  if is_reset_latch_invocation "$COMMAND"; then
    exit 0
  fi
  if [[ "$(classify_decision "$COMMAND")" == "allow" ]]; then
    exit 0
  fi

  # Surface which command FIRST engaged the latch so the agent stops
  # misattributing the block to the command it happens to be running now
  # (the latch is sticky per-session; every later MUTATING Bash call hits
  # this branch). Read the original command + reason from the latch file
  # when jq is available.
  ORIG_CMD=""
  ORIG_WHY=""
  if command -v jq >/dev/null 2>&1; then
    ORIG_CMD=$(jq -r '.command // ""' "$LATCH_FILE" 2>/dev/null)
    ORIG_WHY=$(jq -r '.reason // ""' "$LATCH_FILE" 2>/dev/null)
  fi
  TRIGGER_NOTE="The latch was engaged earlier in this session"
  if [[ -n "$ORIG_CMD" ]]; then
    TRIGGER_NOTE="$TRIGGER_NOTE by this command: \`${ORIG_CMD%%$'\n'*}\`"
    [[ -n "$ORIG_WHY" ]] && TRIGGER_NOTE="$TRIGGER_NOTE (reason: $ORIG_WHY)"
    TRIGGER_NOTE="$TRIGGER_NOTE — NOT by the command you just ran. The latch is sticky for mutating commands, so they block until it is cleared (read-only commands and the reset itself are exempt)."
  fi
  REASON="A dangerous command was previously blocked or sent for approval in this Claude session. $TRIGGER_NOTE This is a human-review boundary, not a retryable syntax error. Do not rephrase, wrap, reorder, alias, or indirectly invoke the command. You, the agent, CANNOT clear this in-band: the reset is human-only by design AND a reset run from a latched session resolves no human shell session-id. Ask the USER to run, from their own shell (use --session with THIS session id, not --current): bash .claude/hooks/reset-danger-latch.sh --session $SESSION_ID --reason \"<why this is safe>\"  (or --all to clear every latch). Sentinel: $LATCH_FILE"
  emit_block_json "$REASON"
  exit 0
fi

# --- Protect the write guard itself from shell-based self-modification ---
# (harvested from Sterling/caws-local per HOOK-PACK-DIVERGENCE-RECONCILE-001).
# Keep this narrow: only block obvious mutating commands that target the
# specific guard path, either relatively or absolutely. The classifier does
# not cover "agent rewrites the guard that is about to judge its commands,"
# so this is a dedicated pre-check before classifier delegation.
PROTECTED_HOOK_REL=".claude/hooks/worktree-write-guard.sh"
PROTECTED_HOOK_ABS="${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/worktree-write-guard.sh"
if printf '%s' "$COMMAND" | grep -qF "$PROTECTED_HOOK_REL" || printf '%s' "$COMMAND" | grep -qF "$PROTECTED_HOOK_ABS"; then
  # Allow checkpoint-oriented git flows that only stage/commit the protected file.
  if printf '%s' "$COMMAND" | grep -qE '(^|[;&|[:space:]])git[[:space:]]+(add|commit|status|diff|log|show)\b'; then
    :
  # Mutating utilities (cp, mv, rm, sed, etc.) targeting the protected path.
  elif printf '%s' "$COMMAND" | grep -qE '(^|[;&|[:space:]])(cp|mv|rm|sed|perl|python|python3|ruby|node|tee|touch|truncate|install|chmod)[[:space:]]'; then
    record_danger_latch "$LATCH_FILE" "block" "shell edit of protected guard" "$COMMAND"
    emit_block_json "$PROTECTED_HOOK_REL is protected from Bash-based edits — it is the guard that enforces worktree write boundaries. Do not modify it via the shell. Ask the user for permission before modifying this hook. Command was: $COMMAND"
    exit 0
  # Output-redirect operators that write to a file. Match `>` or `>>` only
  # when NOT followed by `&` (fd-redirects like 2>&1, >&2 are read-only
  # plumbing). `<<` heredoc is INPUT and never writes a file, so excluded.
  elif printf '%s' "$COMMAND" | grep -qE '(>>|>)[^&]'; then
    record_danger_latch "$LATCH_FILE" "block" "shell redirect into protected guard" "$COMMAND"
    emit_block_json "$PROTECTED_HOOK_REL is protected from Bash-based edits — it is the guard that enforces worktree write boundaries. Do not redirect output into it. Ask the user for permission before modifying this hook. Command was: $COMMAND"
    exit 0
  fi
fi

# --- Python classifier (preferred path) ---
CLASSIFIER="$SCRIPT_DIR/classify_command.py"
if [[ ! -f "$CLASSIFIER" ]] || ! command -v python3 >/dev/null 2>&1; then
  REASON="command classifier unavailable; dangerous-command safety cannot verify Bash semantics. This is a human-review boundary. Command was: $COMMAND"
  record_danger_latch "$LATCH_FILE" "ask" "classifier unavailable" "$COMMAND"
  emit_ask_json "$REASON"
  exit 0
fi

REPO_ROOT="${CLAUDE_PROJECT_DIR:-.}"
CLASSIFIER_STDERR=$(mktemp)
RESULT=$(printf '%s' "$COMMAND" | python3 "$CLASSIFIER" \
  --repo-root "$REPO_ROOT" \
  --home "$HOME" \
  --cwd "$(pwd)" 2>"$CLASSIFIER_STDERR") || {
  DIAG=$(head -c 200 "$CLASSIFIER_STDERR" 2>/dev/null || true)
  rm -f "$CLASSIFIER_STDERR"
  RESULT="{\"decision\":\"ask\",\"reason\":\"command classifier failed: ${DIAG:-unknown error}\"}"
}
rm -f "$CLASSIFIER_STDERR"

DECISION=$(printf '%s' "$RESULT" | jq -r '.decision // "ask"')
REASON=$(printf '%s' "$RESULT" | jq -r '.reason // "unknown"')

case "$DECISION" in
  allow)
    exit 0
    ;;
  deny)
    FULL_REASON="$REASON. This is a HARD BLOCK — Claude Code will refuse the command. This is a human-review boundary, not a retryable syntax error. Do not rephrase, wrap, reorder, alias, or indirectly invoke this command (e.g. via 'command git ...', 'env ... git ...', 'bash -lc \"...\"', or 'git --bare init'). Stop and ask the user for the next step. Command was: $COMMAND"
    record_danger_latch "$LATCH_FILE" "$DECISION" "$REASON" "$COMMAND"
    emit_block_json "$FULL_REASON"
    exit 0
    ;;
  ask)
    FULL_REASON="$REASON. Claude Code will PAUSE and ask the user to approve before running. This may alter destructive or authority-bearing state. Do not attempt to bypass this by rephrasing the command, switching syntax, or wrapping the invocation. If permission is not granted, stop and ask the user for the next step. Command was: $COMMAND"
    record_danger_latch "$LATCH_FILE" "$DECISION" "$REASON" "$COMMAND"
    emit_ask_json "$FULL_REASON"
    exit 0
    ;;
  *)
    # Unknown decision value -- malformed classifier output. Do NOT fall
    # through to the weaker regex fallback; ask+latch instead so a
    # corrupted classifier cannot silently downgrade safety.
    FULL_REASON="command classifier returned an unrecognized decision '$DECISION'. Claude Code will PAUSE and ask the user. This is a human-review boundary. Command was: $COMMAND"
    record_danger_latch "$LATCH_FILE" "ask" "classifier unknown decision: $DECISION" "$COMMAND"
    emit_ask_json "$FULL_REASON"
    exit 0
    ;;
esac

# Every classifier outcome (allow/deny/ask/unknown) exits inside the case
# above. There is no flat-regex fallback; if classify_command.py cannot run,
# the early-exit at the top of this script ask-latches the command. That
# keeps the dangerous-command decision in a single semantic layer.

# shellcheck disable=SC2317  # Defense-in-depth tail; unreachable on a healthy classifier.
exit 0
