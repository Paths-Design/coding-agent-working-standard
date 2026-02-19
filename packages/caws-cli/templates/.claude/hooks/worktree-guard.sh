#!/bin/bash
# CAWS Worktree Safety Guard for Claude Code
# Blocks dangerous git operations when parallel worktrees are active
# @author @darianrosebrook

set -euo pipefail

# Read JSON input from Claude Code
INPUT=$(cat)

# Extract tool info
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // ""')
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // ""')

# Only check Bash tool with git commands
if [[ "$TOOL_NAME" != "Bash" ]] || [[ -z "$COMMAND" ]]; then
  exit 0
fi

# Only check git commands
if ! echo "$COMMAND" | grep -qE '^\s*git\s'; then
  exit 0
fi

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"

# Determine if worktrees are active
WORKTREES_ACTIVE=false
PARALLEL_BASE=""

# Check .caws/parallel.json
if [[ -f "$PROJECT_DIR/.caws/parallel.json" ]] && command -v node >/dev/null 2>&1; then
  PARALLEL_INFO=$(node -e "
    try {
      var reg = JSON.parse(require('fs').readFileSync('$PROJECT_DIR/.caws/parallel.json', 'utf8'));
      var agents = (reg.agents || []).length;
      console.log(agents + ':' + (reg.baseBranch || ''));
    } catch(e) { console.log('0:'); }
  " 2>/dev/null || echo "0:")

  AGENT_COUNT=$(echo "$PARALLEL_INFO" | cut -d: -f1)
  PARALLEL_BASE=$(echo "$PARALLEL_INFO" | cut -d: -f2)

  if [[ "$AGENT_COUNT" -gt 0 ]] 2>/dev/null; then
    WORKTREES_ACTIVE=true
  fi
fi

# Check .caws/worktrees.json
if [[ "$WORKTREES_ACTIVE" != "true" ]] && [[ -f "$PROJECT_DIR/.caws/worktrees.json" ]] && command -v node >/dev/null 2>&1; then
  ACTIVE_COUNT=$(node -e "
    try {
      var reg = JSON.parse(require('fs').readFileSync('$PROJECT_DIR/.caws/worktrees.json', 'utf8'));
      var active = Object.values(reg.worktrees || {}).filter(function(w) { return w.status === 'active'; });
      console.log(active.length);
    } catch(e) { console.log('0'); }
  " 2>/dev/null || echo "0")

  if [[ "$ACTIVE_COUNT" -gt 0 ]] 2>/dev/null; then
    WORKTREES_ACTIVE=true
  fi
fi

# If no worktrees are active, allow everything
if [[ "$WORKTREES_ACTIVE" != "true" ]]; then
  exit 0
fi

# Block git commit --amend when worktrees are active
if echo "$COMMAND" | grep -qE 'git\s+commit\s+.*--amend'; then
  echo "BLOCKED: git commit --amend is not allowed while worktrees are active." >&2
  echo "Amending commits risks rewriting another agent's work." >&2
  echo "Create a new commit instead." >&2
  exit 2
fi

# Block git stash when worktrees are active (stash is shared across worktrees)
if echo "$COMMAND" | grep -qE 'git\s+stash'; then
  echo "BLOCKED: git stash is not allowed while worktrees are active." >&2
  echo "Stash is shared across all worktrees and can capture or destroy another agent's work." >&2
  echo "Commit your changes to your branch instead." >&2
  exit 2
fi

# Block git reset --hard when worktrees are active
if echo "$COMMAND" | grep -qE 'git\s+reset\s+--hard'; then
  echo "BLOCKED: git reset --hard is not allowed while worktrees are active." >&2
  echo "This could discard work that other agents depend on." >&2
  exit 2
fi

# Block git push --force when worktrees are active
if echo "$COMMAND" | grep -qE 'git\s+push\s+.*(--force|-f\s)'; then
  echo "BLOCKED: Force push is not allowed while worktrees are active." >&2
  echo "This could rewrite history that other agents have based work on." >&2
  exit 2
fi

# Get current branch to check base-branch operations
CURRENT_BRANCH=$(cd "$PROJECT_DIR" && git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")

# Determine the base branch to protect
BASE_BRANCH="$PARALLEL_BASE"
if [[ -z "$BASE_BRANCH" ]] && [[ -f "$PROJECT_DIR/.caws/worktrees.json" ]] && command -v node >/dev/null 2>&1; then
  BASE_BRANCH=$(node -e "
    try {
      var reg = JSON.parse(require('fs').readFileSync('$PROJECT_DIR/.caws/worktrees.json', 'utf8'));
      var active = Object.values(reg.worktrees || {}).filter(function(w) { return w.status === 'active'; });
      if (active.length > 0) console.log(active[0].baseBranch || '');
      else console.log('');
    } catch(e) { console.log(''); }
  " 2>/dev/null || echo "")
fi

# If we're on the base branch, block push (should be working in a worktree instead)
if [[ -n "$BASE_BRANCH" ]] && [[ "$CURRENT_BRANCH" == "$BASE_BRANCH" ]]; then
  if echo "$COMMAND" | grep -qE 'git\s+push'; then
    echo "BLOCKED: Pushing from the base branch ($BASE_BRANCH) while worktrees are active." >&2
    echo "You should be working in a worktree, not on the base branch." >&2
    echo "Use: cd .caws/worktrees/<name>/" >&2
    exit 2
  fi

  # Warn (but don't block) commits on base branch — the pre-commit hook handles blocking
  if echo "$COMMAND" | grep -qE 'git\s+commit\b' && ! echo "$COMMAND" | grep -qE '--amend'; then
    echo '{
      "hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "additionalContext": "WARNING: You are committing to the base branch ('"$BASE_BRANCH"') while worktrees are active. The pre-commit hook should block this. If you need to commit, work in your worktree instead: cd .caws/worktrees/<name>/"
      }
    }'
    exit 0
  fi
fi

# Allow the command
exit 0
