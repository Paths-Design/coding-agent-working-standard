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
  --current       Reset the current latch. If CLAUDE_SESSION_ID or
                  HOOK_SESSION_ID is set, that session's latch is
                  targeted. Otherwise, if exactly one latch exists
                  under .claude/hooks/state/, it is targeted; if
                  zero or multiple exist, the script exits non-zero.
  --session <id>  Reset a specific session latch. Use this from a
                  plain terminal where CLAUDE_SESSION_ID is not set.
                  The id is the suffix of the latch filename, e.g.
                  for danger-latch-abc-123.json the id is abc-123.
  --reason <text> Required audit reason.

The script targets latches under $CLAUDE_PROJECT_DIR/.claude/hooks/state/
(falling back to the current working directory if CLAUDE_PROJECT_DIR is
unset). From a terminal outside Claude Code, set CLAUDE_PROJECT_DIR to the
repo root or `cd` there before running.

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

list_existing_latches() {
  find "$STATE_DIR" -maxdepth 1 -type f -name 'danger-latch-*.json' 2>/dev/null | sort
}

targets=()
case "$MODE" in
  current)
    SESSION_ID="${CLAUDE_SESSION_ID:-${HOOK_SESSION_ID:-}}"
    if [[ -n "$SESSION_ID" ]]; then
      targets+=("$STATE_DIR/danger-latch-$(safe_session "$SESSION_ID").json")
    else
      # No session id from environment -- fall back to inferring from
      # whatever single latch is present under STATE_DIR. This makes
      # --current usable from a plain terminal in the common case
      # where there is exactly one latch to clear.
      # `mapfile` is Bash 4+; macOS ships /bin/bash 3.2 by default, so
      # read the list with a plain loop for portability.
      found_latches=()
      while IFS= read -r line; do
        [[ -n "$line" ]] && found_latches+=("$line")
      done < <(list_existing_latches)
      case "${#found_latches[@]}" in
        0)
          echo "No danger latch files found under $STATE_DIR." >&2
          echo "If you expected a latch here, check CLAUDE_PROJECT_DIR ('${CLAUDE_PROJECT_DIR:-unset}')." >&2
          exit 2
          ;;
        1)
          targets+=("${found_latches[0]}")
          echo "Inferred single latch: ${found_latches[0]}" >&2
          ;;
        *)
          echo "Multiple latches found under $STATE_DIR. Specify one with --session <id>:" >&2
          for latch in "${found_latches[@]}"; do
            base=$(basename "$latch" .json)
            id=${base#danger-latch-}
            echo "  --session $id   ($latch)" >&2
          done
          exit 2
          ;;
      esac
    fi
    ;;
  session)
    if [[ -z "$SESSION_ID" ]]; then
      echo "--session requires an id." >&2
      exit 2
    fi
    targets+=("$STATE_DIR/danger-latch-$(safe_session "$SESSION_ID").json")
    ;;
esac

# Sanity: at this point targets[] must be non-empty (each case branch
# either appends or exits). Defend against future changes that forget
# this invariant.
if [[ "${#targets[@]}" -eq 0 ]]; then
  echo "Internal error: no targets resolved." >&2
  exit 2
fi

TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
RESET_COUNT=0
MISSING=()
for file in "${targets[@]}"; do
  if [[ ! -f "$file" ]]; then
    MISSING+=("$file")
    continue
  fi
  jq -n \
    --arg ts "$TS" \
    --arg file "$file" \
    --arg reason "$REASON" \
    --arg by "${USER:-unknown}" \
    '{ ts: $ts, latch: $file, reset_by: $by, reason: $reason }' >> "$LOG_DIR/danger-latch-resets.log"
  rm -f "$file"
  RESET_COUNT=$((RESET_COUNT + 1))
done

if [[ "$RESET_COUNT" -eq 0 ]]; then
  echo "No danger latch matched (looked for: ${targets[*]})." >&2
  echo "If you expected this latch to exist, check CLAUDE_PROJECT_DIR ('${CLAUDE_PROJECT_DIR:-unset}') and the session id." >&2
  exit 2
fi

if [[ "${#MISSING[@]}" -gt 0 ]]; then
  echo "Note: ${#MISSING[@]} target(s) did not exist on disk and were skipped." >&2
fi

echo "Reset $RESET_COUNT danger latch(es)."
