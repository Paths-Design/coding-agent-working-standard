#!/bin/bash
# CAWS Worktree Write Guard for Claude Code
# Blocks Write/Edit on the base branch while worktrees are active.
# This prevents agents from modifying files on main and then trying to
# create worktrees retroactively to commit them.
# @author @darianrosebrook

set -euo pipefail

# Read JSON input from Claude Code
INPUT=$(cat)

# Extract tool info
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // ""')
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // ""')

# Only check Write and Edit tools
case "$TOOL_NAME" in
  Write|Edit) ;;
  *) exit 0 ;;
esac

# --- Resolve main repo root ---
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"

if command -v git >/dev/null 2>&1; then
  GIT_COMMON_DIR=$(cd "$PROJECT_DIR" && git rev-parse --git-common-dir 2>/dev/null || echo "")
  if [[ -n "$GIT_COMMON_DIR" ]] && [[ "$GIT_COMMON_DIR" != ".git" ]]; then
    CANDIDATE=$(cd "$PROJECT_DIR" && cd "$GIT_COMMON_DIR/.." 2>/dev/null && pwd || echo "")
    if [[ -n "$CANDIDATE" ]] && [[ -d "$CANDIDATE/.caws" ]]; then
      PROJECT_DIR="$CANDIDATE"
    fi
  fi
fi

# --- Check for active worktrees ---
if [[ ! -f "$PROJECT_DIR/.caws/worktrees.json" ]]; then
  exit 0
fi

if ! command -v node >/dev/null 2>&1; then
  exit 0
fi

CURRENT_BRANCH=$(cd "$PROJECT_DIR" && git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")

WT_INFO=$(node -e "
  try {
    var reg = JSON.parse(require('fs').readFileSync('$PROJECT_DIR/.caws/worktrees.json', 'utf8'));
    var active = Object.values(reg.worktrees || {}).filter(function(w) {
      return w.status === 'active' && w.baseBranch === '$CURRENT_BRANCH';
    });
    console.log(active.length + ':' + active.map(function(w) { return w.name; }).join(', '));
  } catch(e) { console.log('0:'); }
" 2>/dev/null || echo "0:")

WT_COUNT=$(echo "$WT_INFO" | cut -d: -f1)
WT_NAMES=$(echo "$WT_INFO" | cut -d: -f2)

if [[ "$WT_COUNT" -le 0 ]] 2>/dev/null; then
  exit 0
fi

# Allow edits to .claude/ configuration (hooks, settings, rules)
if [[ -n "$FILE_PATH" ]]; then
  case "$FILE_PATH" in
    */.claude/*|*/.caws/*) exit 0 ;;
  esac
fi

# Block: we're on the base branch with active worktrees
echo "BLOCKED: Cannot write/edit files on '$CURRENT_BRANCH' while $WT_COUNT worktree(s) are active: $WT_NAMES" >&2
echo "" >&2
echo "You MUST work in a worktree, not on the base branch." >&2
echo "  To use an existing worktree: cd $PROJECT_DIR/.caws/worktrees/<name>/" >&2
echo "  To create a new worktree:    caws worktree create <name>" >&2
echo "" >&2
echo "Do NOT make changes on main and create a worktree retroactively." >&2
echo "The worktree must exist BEFORE you start making changes." >&2
exit 2
