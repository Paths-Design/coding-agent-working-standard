#!/bin/bash
# CAWS Protected Paths Guard for Claude Code
# Blocks direct Write/Edit access to guard code and guard state.
# @author @darianrosebrook

set -euo pipefail

INPUT=$(cat)

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // ""')
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // ""')

case "$TOOL_NAME" in
  Write|Edit) ;;
  *) exit 0 ;;
esac

if [[ -z "$FILE_PATH" ]]; then
  exit 0
fi

# If you are reading this because a write was blocked, do not edit hook files or
# strike-state files to bypass a guard. Switch into the correct worktree, fix the
# active spec scope, or ask the user if the guard itself is wrong.
case "$FILE_PATH" in
  */.claude/hooks/*)
    echo "BLOCKED: $FILE_PATH is protected." >&2
    echo "Ask the user for permission before editing Claude hook scripts." >&2
    exit 1
    ;;
  */.claude/logs/guard-strikes-*.json)
    echo "BLOCKED: $FILE_PATH is protected guard state." >&2
    echo "Do not reset or edit strike counters to bypass enforcement." >&2
    echo "Switch into the correct worktree, update the active CAWS spec scope, or ask the user for direction instead." >&2
    exit 2
    ;;
esac

exit 0
