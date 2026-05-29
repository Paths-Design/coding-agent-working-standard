#!/bin/bash
# CAWS-MANAGED-HOOK
# hook_pack: claude-code
# hook_pack_version: 11
# caws_min_major: 11
# lineage_refs: 17
# do_not_edit_directly: update via `caws init --agent-surface claude-code`
# Human-authorized reset for the dangerous-command latch written by
# block-dangerous.sh. Clears latch sentinel(s) under
# .claude/hooks/state/ and records each reset (with a mandatory reason)
# to .claude/logs/danger-latch-resets.log. See failure-lineage Entry 17.

set -euo pipefail

# --- Resolve project + state locations -------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
STATE_DIR="$PROJECT_DIR/.claude/hooks/state"
LOG_FILE="$PROJECT_DIR/.claude/logs/danger-latch-resets.log"

usage() {
  cat >&2 <<USAGE
Usage: reset-danger-latch.sh (--current | --all | --session <id>) --reason "<why this is safe>"

Clears the dangerous-command latch(es) written by block-dangerous.sh so that
Bash tool calls may resume. A reason is mandatory and is recorded to the
audit log at:
  $LOG_FILE

Modes (exactly one required):
  --current            Clear the latch for the current Claude session
                       (resolved from CLAUDE_SESSION_ID / HOOK_SESSION_ID).
  --all                Clear every latch in this project.
  --session <id>       Clear the latch for a specific session id.

Required:
  --reason "<text>"    Human-supplied justification, recorded to the log.
USAGE
}

# --- Parse arguments --------------------------------------------------------
MODE=""
SESSION_ARG=""
REASON=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --current)  MODE="current"; shift ;;
    --all)      MODE="all"; shift ;;
    --session)  MODE="session"; SESSION_ARG="${2:-}"; shift 2 ;;
    --reason)   REASON="${2:-}"; shift 2 ;;
    -h|--help)  usage; exit 0 ;;
    *)          echo "reset-danger-latch.sh: unknown argument: $1" >&2; usage; exit 2 ;;
  esac
done

if [[ -z "$MODE" ]]; then
  echo "reset-danger-latch.sh: one of --current, --all, or --session <id> is required." >&2
  usage
  exit 2
fi

if [[ -z "$REASON" ]]; then
  echo "reset-danger-latch.sh: --reason \"<why this is safe>\" is required." >&2
  echo "The latch is a human-review boundary; clearing it must be justified and is logged." >&2
  exit 2
fi

if [[ "$MODE" == "session" && -z "$SESSION_ARG" ]]; then
  echo "reset-danger-latch.sh: --session requires a session id." >&2
  exit 2
fi

# Mirror block-dangerous.sh's danger_latch_file() session-id sanitization.
sanitize_session() {
  printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '_'
}

# --- Resolve the set of latch files to clear --------------------------------
declare -a LATCH_FILES=()

case "$MODE" in
  current)
    SESSION_ID="${CLAUDE_SESSION_ID:-${HOOK_SESSION_ID:-unknown}}"
    LATCH_FILES+=("$STATE_DIR/danger-latch-$(sanitize_session "$SESSION_ID").json")
    ;;
  session)
    LATCH_FILES+=("$STATE_DIR/danger-latch-$(sanitize_session "$SESSION_ARG").json")
    ;;
  all)
    if [[ -d "$STATE_DIR" ]]; then
      while IFS= read -r f; do
        [[ -n "$f" ]] && LATCH_FILES+=("$f")
      done < <(find "$STATE_DIR" -maxdepth 1 -type f -name 'danger-latch-*.json' 2>/dev/null)
    fi
    ;;
esac

if [[ "${#LATCH_FILES[@]}" -eq 0 ]]; then
  echo "No danger latches found to clear (state dir: $STATE_DIR)."
  exit 0
fi

# --- Clear latches + append audit records -----------------------------------
mkdir -p "$(dirname "$LOG_FILE")"
RESET_TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
CLEARED=0
MISSING=0

for LATCH in "${LATCH_FILES[@]}"; do
  if [[ ! -f "$LATCH" ]]; then
    MISSING=$((MISSING + 1))
    continue
  fi

  ORIGINAL="$(cat "$LATCH" 2>/dev/null || printf '{}')"

  if command -v jq >/dev/null 2>&1; then
    jq -c -n \
      --arg ts "$RESET_TS" \
      --arg latch "$LATCH" \
      --arg mode "$MODE" \
      --arg reason "$REASON" \
      --argjson original "$ORIGINAL" \
      '{ts: $ts, action: "reset", mode: $mode, latch_file: $latch, reason: $reason, cleared_latch: $original}' \
      >> "$LOG_FILE"
  else
    printf '{"ts":"%s","action":"reset","mode":"%s","latch_file":"%s","reason":%s}\n' \
      "$RESET_TS" "$MODE" "$LATCH" "$(printf '%s' "$REASON" | sed 's/\\/\\\\/g; s/"/\\"/g; s/^/"/; s/$/"/')" \
      >> "$LOG_FILE"
  fi

  rm -f "$LATCH"
  CLEARED=$((CLEARED + 1))
  echo "Cleared danger latch: $LATCH"
done

if [[ "$MODE" != "all" && "$CLEARED" -eq 0 && "$MISSING" -gt 0 ]]; then
  echo "No active latch for the requested session (nothing to clear)."
  exit 0
fi

echo "Reset $CLEARED danger latch(es). Reason recorded to $LOG_FILE"
echo "Bash tool calls may now resume in this session."
