#!/bin/bash
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

# --- Try Python classifier first (preferred) ---
CLASSIFIER="$SCRIPT_DIR/classify_command.py"
if [[ ! -f "$CLASSIFIER" ]] || ! command -v python3 >/dev/null 2>&1; then
  REASON="command classifier unavailable; dangerous-command safety cannot verify Bash semantics. This is a human-review boundary. Command was: $COMMAND"
  record_danger_latch "$LATCH_FILE" "ask" "classifier unavailable" "$COMMAND"
  emit_ask_json "$REASON"
  exit 0
fi

if [[ -f "$CLASSIFIER" ]] && command -v python3 >/dev/null 2>&1; then
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
  esac
fi

# --- Fallback: bash pattern matching (less precise, no heredoc/quote awareness) ---

DANGEROUS_PATTERNS=(
  # Destructive file operations
  'rm -rf /'
  'rm -rf ~'
  'rm -rf \*'
  'rm -rf \.'
  'rm -rf /\*'
  'dd if=/dev/zero'
  'dd if=/dev/random'
  'mkfs\.'
  'fdisk'
  '> /dev/sd'

  # Fork bombs and resource exhaustion
  ':\(\)\{:\|:\&\};:'
  'while true.*fork'

  # Credential/secret exposure
  'cat.*\.env'
  'cat.*/etc/passwd'
  'cat.*/etc/shadow'
  'cat.*id_rsa'
  'cat.*\.ssh/'
  'cat.*credentials'
  'cat.*\.aws/'

  # Network exfiltration
  'curl.*\|.*sh'
  'wget.*\|.*sh'
  'curl.*\|.*bash'
  'wget.*\|.*bash'

  # Permission escalation
  'chmod 777'
  'chmod -R 777'
  'chmod.*\+s'

  # History manipulation
  'history -c'
  'rm.*\.bash_history'
  'rm.*\.zsh_history'

  # System modification
  'shutdown'
  'reboot'
  'init 0'
  'init 6'

  # Git destructive operations
  'git init'
  'git reset --hard'
  'git push --force'
  'git push -f '
  'git push --force-with-lease'
  'git clean -f'
  'git checkout \.'
  'git restore \.'
  '(^|&&|\|\||;|\|)\s*git rebase'
  '(^|&&|\|\||;|\|)\s*git cherry-pick'

  # Virtual environment creation (prevents venv sprawl)
  'python -m venv'
  'python3 -m venv'
  'virtualenv '
  'conda create'
)

# Check command against dangerous patterns
for pattern in "${DANGEROUS_PATTERNS[@]}"; do
  if printf '%s\n' "$COMMAND" | grep -qiE "$pattern"; then
    # Allow git rebase/cherry-pick only when no worktrees are active
    if [[ "$pattern" == *"git rebase"* ]] || [[ "$pattern" == *"git cherry-pick"* ]]; then
      PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"
      if command -v git >/dev/null 2>&1; then
        GIT_COMMON=$(cd "$PROJECT_DIR" && git rev-parse --git-common-dir 2>/dev/null || echo "")
        if [[ -n "$GIT_COMMON" ]] && [[ "$GIT_COMMON" != ".git" ]]; then
          CANDIDATE=$(cd "$PROJECT_DIR" && cd "$GIT_COMMON/.." 2>/dev/null && pwd || echo "")
          if [[ -n "$CANDIDATE" ]] && [[ -d "$CANDIDATE/.caws" ]]; then
            PROJECT_DIR="$CANDIDATE"
          fi
        fi
      fi
      WT_FILE="$PROJECT_DIR/.caws/worktrees.json"
      if [[ -f "$WT_FILE" ]] && command -v node >/dev/null 2>&1; then
        ACTIVE_COUNT=$(node -e "
          try {
            var r = JSON.parse(require('fs').readFileSync('$WT_FILE','utf8'));
            var registry = r.worktrees && typeof r.worktrees === 'object' ? r.worktrees : r;
            var c = Object.values(registry).filter(function(w){
              return w && typeof w === 'object' && (w.status === 'active' || w.specId || w.spec_id);
            }).length;
            console.log(c);
          } catch(e) { console.log(0); }
        " 2>/dev/null || echo "0")
        if [[ "$ACTIVE_COUNT" -gt 0 ]]; then
          GIT_SUBCMD="git operation"
          [[ "$pattern" == *"git rebase"* ]] && GIT_SUBCMD="git rebase"
          [[ "$pattern" == *"git cherry-pick"* ]] && GIT_SUBCMD="git cherry-pick"
          REASON="$GIT_SUBCMD is forbidden while $ACTIVE_COUNT worktree(s) are active. This can replay or rewrite commits across worktree boundaries. This is a human-review boundary, not a retryable syntax error. Command was: $COMMAND"
          record_danger_latch "$LATCH_FILE" "deny" "$GIT_SUBCMD active-worktrees" "$COMMAND"
          emit_block_json "$REASON"
          exit 0
        fi
      fi
      continue
    fi

    # Allow venv commands if target matches designated venv path from scope.json
    if printf '%s\n' "$pattern" | grep -qE '(python.*venv|virtualenv|conda create)'; then
      PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"
      SCOPE_FILE="$PROJECT_DIR/.caws/scope.json"
      if [[ -f "$SCOPE_FILE" ]] && command -v node >/dev/null 2>&1; then
        DESIGNATED_VENV=$(node -e "try { const s = JSON.parse(require('fs').readFileSync('$SCOPE_FILE','utf8')); console.log(s.designatedVenvPath || ''); } catch(e) { console.log(''); }" 2>/dev/null || echo "")
        if [[ -n "$DESIGNATED_VENV" ]] && printf '%s\n' "$COMMAND" | grep -qF "$DESIGNATED_VENV"; then
          continue
        fi
      fi
    fi

    REASON="Command matches dangerous pattern: $pattern. This is a human-review boundary, not a retryable syntax error. Do not rephrase, wrap, reorder, alias, or indirectly invoke this command. Stop and ask the user for the next step. Command was: $COMMAND"
    record_danger_latch "$LATCH_FILE" "deny" "$pattern" "$COMMAND"
    emit_block_json "$REASON"
    exit 0
  fi
done

# Check for sudo without specific allowed commands
if printf '%s\n' "$COMMAND" | grep -qE '^sudo\s' && ! printf '%s\n' "$COMMAND" | grep -qE 'sudo (npm|yarn|pnpm|brew|apt-get|apt|dnf|yum)'; then
  REASON="sudo commands require explicit approval. If this command is safe, run it manually in your terminal. Command was: $COMMAND"
  record_danger_latch "$LATCH_FILE" "deny" "sudo" "$COMMAND"
  emit_block_json "$REASON"
  exit 0
fi

# Allow the command
exit 0
