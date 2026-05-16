#!/bin/bash
# Reset the Claude dangerous-command latch for a session.
#
# This script is intentionally separate from block-dangerous.sh. A latch marks a
# human-review boundary after dangerous Bash was blocked or sent for approval.
# Run this only from a human terminal after deciding the session may continue.

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: reset-danger-latch.sh (--current | --session <id>) --reason <text>

Options:
  --current       Reset the current CLAUDE_SESSION_ID/HOOK_SESSION_ID latch.
  --session <id>  Reset a specific session latch.
  --reason <text> Required audit reason.

Note: there is intentionally no `--all` flag. Multi-session global reset is
a human maintenance operation, not part of the installed hook surface. To
clear every latch in a project, remove the files under
`.claude/hooks/state/` from a human terminal and record the reason in
`.claude/logs/danger-latch-resets.log`.
EOF
}

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
STATE_DIR="$PROJECT_DIR/.claude/hooks/state"
LOG_DIR="$PROJECT_DIR/.claude/logs"
MODE=""
SESSION_ID=""
REASON=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --current)
      MODE="current"
      shift
      ;;
    --session)
      MODE="session"
      SESSION_ID="${2:-}"
      shift 2
      ;;
    --all)
      echo "--all is no longer supported. Reset latches one at a time with --current or --session <id>." >&2
      echo "If you need to clear every latch, remove .claude/hooks/state/danger-latch-*.json" >&2
      echo "manually from a human terminal and log the reason in .claude/logs/danger-latch-resets.log." >&2
      exit 2
      ;;
    --reason)
      REASON="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "$MODE" ]]; then
  echo "Missing reset target." >&2
  usage >&2
  exit 2
fi

if [[ -z "$REASON" ]]; then
  echo "--reason is required." >&2
  usage >&2
  exit 2
fi

mkdir -p "$STATE_DIR" "$LOG_DIR"

safe_session() {
  printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '_'
}

targets=()
case "$MODE" in
  current)
    SESSION_ID="${CLAUDE_SESSION_ID:-${HOOK_SESSION_ID:-}}"
    if [[ -z "$SESSION_ID" ]]; then
      echo "No current session id found in CLAUDE_SESSION_ID or HOOK_SESSION_ID." >&2
      exit 2
    fi
    targets+=("$STATE_DIR/danger-latch-$(safe_session "$SESSION_ID").json")
    ;;
  session)
    if [[ -z "$SESSION_ID" ]]; then
      echo "--session requires an id." >&2
      exit 2
    fi
    targets+=("$STATE_DIR/danger-latch-$(safe_session "$SESSION_ID").json")
    ;;
esac

if [[ "${#targets[@]}" -eq 0 ]]; then
  echo "No danger latch files matched." >&2
  exit 0
fi

TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
RESET_COUNT=0
for file in "${targets[@]}"; do
  [[ -f "$file" ]] || continue
  jq -n \
    --arg ts "$TS" \
    --arg file "$file" \
    --arg reason "$REASON" \
    --arg by "${USER:-unknown}" \
    '{ ts: $ts, latch: $file, reset_by: $by, reason: $reason }' >> "$LOG_DIR/danger-latch-resets.log"
  rm -f "$file"
  RESET_COUNT=$((RESET_COUNT + 1))
done

echo "Reset $RESET_COUNT danger latch(es)."
