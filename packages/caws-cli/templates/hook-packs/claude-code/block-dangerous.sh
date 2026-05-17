#!/bin/bash
# CAWS-MANAGED-HOOK
# hook_pack: claude-code
# hook_pack_version: 1
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

danger_state_dir() {
  local project_dir="${CLAUDE_PROJECT_DIR:-.}"
  local state_dir="$project_dir/.claude/hooks/state"
  mkdir -p "$state_dir"
  printf '%s\n' "$state_dir"
}

danger_latch_file() {
  local session_id="$1"
  local safe_session
  safe_session=$(printf '%s' "$session_id" | tr -c 'A-Za-z0-9._-' '_')
  printf '%s/danger-latch-%s.json\n' "$(danger_state_dir)" "$safe_session"
}

emit_block_json() {
  local reason="$1"
  jq -n --arg msg "$reason" '{ decision: "block", reason: $msg }'
}

emit_ask_json() {
  local reason="$1"
  jq -n --arg msg "$reason" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "ask",
      permissionDecisionReason: $msg
    }
  }'
}

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
  REASON="A dangerous command was previously blocked or sent for approval in this Claude session. This is a human-review boundary, not a retryable syntax error. Do not rephrase, wrap, reorder, alias, or indirectly invoke the command. Ask the user to clear the latch with .claude/hooks/reset-danger-latch.sh before more Bash commands may run. Sentinel: $LATCH_FILE"
  emit_block_json "$REASON"
  exit 0
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
    FULL_REASON="$REASON. This is a human-review boundary, not a retryable syntax error. Do not rephrase, wrap, reorder, alias, or indirectly invoke this command. Stop and ask the user for the next step. Command was: $COMMAND"
    record_danger_latch "$LATCH_FILE" "$DECISION" "$REASON" "$COMMAND"
    emit_block_json "$FULL_REASON"
    exit 0
    ;;
  ask)
    FULL_REASON="$REASON. This may alter destructive or authority-bearing state. Do not retry by alternate syntax if permission is not granted. Command was: $COMMAND"
    record_danger_latch "$LATCH_FILE" "$DECISION" "$REASON" "$COMMAND"
    emit_ask_json "$FULL_REASON"
    exit 0
    ;;
  *)
    # Unknown decision value -- malformed classifier output. Do NOT fall
    # through to the weaker regex fallback; ask+latch instead so a
    # corrupted classifier cannot silently downgrade safety.
    FULL_REASON="command classifier returned an unrecognized decision '$DECISION'. This is a human-review boundary. Command was: $COMMAND"
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
