#!/bin/bash
# CAWS Dangerous Command Blocker for Claude Code
# Blocks potentially destructive shell commands
# @author @darianrosebrook

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/parse-input.sh
source "$SCRIPT_DIR/lib/parse-input.sh"
parse_hook_input

# Back-compat aliases keep the downstream pattern-match logic unchanged.
TOOL_NAME="$HOOK_TOOL_NAME"
COMMAND="$HOOK_COMMAND"

# Only check Bash tool
if [[ "$TOOL_NAME" != "Bash" ]] || [[ -z "$COMMAND" ]]; then
  exit 0
fi

# Protect the write guard itself from shell-based self-modification.
# Keep this narrow: only block obvious mutating commands that target the
# specific guard path, either relatively or absolutely.
PROTECTED_HOOK_REL=".claude/hooks/worktree-write-guard.sh"
PROTECTED_HOOK_ABS="${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/worktree-write-guard.sh"
if echo "$COMMAND" | grep -qF "$PROTECTED_HOOK_REL" || echo "$COMMAND" | grep -qF "$PROTECTED_HOOK_ABS"; then
  # Allow checkpoint-oriented git flows that only stage/commit the protected file.
  if echo "$COMMAND" | grep -qE '(^|[;&|[:space:]])git[[:space:]]+(add|commit|status|diff|log|show)\b'; then
    exit 0
  fi

  # Check for mutating utilities (cp, mv, rm, etc.) targeting the protected path.
  if echo "$COMMAND" | grep -qE '(^|[;&|[:space:]])(cp|mv|rm|sed|perl|python|python3|ruby|node|tee|touch|truncate|install|chmod)[[:space:]]'; then
    echo "BLOCKED: $PROTECTED_HOOK_REL is protected from Bash-based edits." >&2
    echo "Ask the user for permission before modifying this hook." >&2
    echo "Command was: $COMMAND" >&2
    exit 2
  fi

  # Check for output-redirect operators that write to a file.
  # Match `>` or `>>` only when NOT followed by `&` (which would be fd-redirect
  # like 2>&1, >&2 — those are harmless read-only plumbing). `<<` is heredoc
  # INPUT and never writes to a file, so it is intentionally excluded here.
  if echo "$COMMAND" | grep -qE '(>>|>)[^&]'; then
    echo "BLOCKED: $PROTECTED_HOOK_REL is protected from Bash-based edits." >&2
    echo "Ask the user for permission before modifying this hook." >&2
    echo "Command was: $COMMAND" >&2
    exit 2
  fi
fi

# Dangerous command patterns
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
  if echo "$COMMAND" | grep -qiE "$pattern"; then
    # Allow git init in worktree context
    if [[ "$pattern" == "git init" ]] && [[ "${CAWS_WORKTREE_CONTEXT:-0}" == "1" ]]; then
      continue
    fi

    # Allow git rebase only when no worktrees are active
    if [[ "$pattern" == *"git rebase"* ]] || [[ "$pattern" == *"git cherry-pick"* ]]; then
      PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"
      # Resolve to main repo root if we're in a worktree
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
            var c = Object.values(r.worktrees||{}).filter(function(w){return w.status==='active';}).length;
            console.log(c);
          } catch(e) { console.log(0); }
        " 2>/dev/null || echo "0")
        if [[ "$ACTIVE_COUNT" -gt 0 ]]; then
          GIT_SUBCMD="git operation"
          [[ "$pattern" == *"git rebase"* ]] && GIT_SUBCMD="git rebase"
          [[ "$pattern" == *"git cherry-pick"* ]] && GIT_SUBCMD="git cherry-pick"
          echo "BLOCKED: $GIT_SUBCMD is forbidden while $ACTIVE_COUNT worktree(s) are active." >&2
          echo "This can replay or rewrite commits across worktree boundaries." >&2
          echo "Command was: $COMMAND" >&2
          exit 2
        fi
      fi
      # No active worktrees — allow
      continue
    fi

    # Allow venv commands if target matches designated venv path from scope.json
    if echo "$pattern" | grep -qE '(python.*venv|virtualenv|conda create)'; then
      PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"
      SCOPE_FILE="$PROJECT_DIR/.caws/scope.json"
      if [[ -f "$SCOPE_FILE" ]] && command -v node >/dev/null 2>&1; then
        DESIGNATED_VENV=$(node -e "try { const s = JSON.parse(require('fs').readFileSync('$SCOPE_FILE','utf8')); console.log(s.designatedVenvPath || ''); } catch(e) { console.log(''); }" 2>/dev/null || echo "")
        if [[ -n "$DESIGNATED_VENV" ]] && echo "$COMMAND" | grep -qF "$DESIGNATED_VENV"; then
          continue
        fi
      fi
    fi

    # Output to stderr for Claude to see
    echo "BLOCKED: Command matches dangerous pattern: $pattern" >&2
    echo "Command was: $COMMAND" >&2

    # Exit code 2 blocks the tool and shows stderr to Claude
    exit 2
  fi
done

# Check for sudo without specific allowed commands
if echo "$COMMAND" | grep -qE '^sudo\s' && ! echo "$COMMAND" | grep -qE 'sudo (npm|yarn|pnpm|brew|apt-get|apt|dnf|yum)'; then
  echo "BLOCKED: sudo commands require explicit approval" >&2
  echo "If this command is safe, please run it manually in your terminal" >&2
  exit 2
fi

# Allow the command
exit 0


# #!/bin/bash
# # CAWS-MANAGED-HOOK
# # hook_pack: claude-code
# # hook_pack_version: 2
# # caws_min_major: 11
# # lineage_refs: 1,17
# # do_not_edit_directly: update via `caws init --agent-surface claude-code`
# # CAWS Command Safety Gate for Claude Code
# # Delegates to classify_command.py for robust command parsing and classification.
# # Fails closed with an ask+latch if the classifier is unavailable.
# #
# # The Python classifier handles:
# #   - Heredoc-aware parsing (won't false-positive on quoted dangerous commands)
# #   - Quoted-region stripping (echo "git reset --hard" is safe)
# #   - Pipeline-aware dangers (curl | sh)
# #   - Context-aware rm classification (safe prefixes vs dangerous targets)
# #   - Proper shell segmentation (&&, ||, ;, |)
# #   - Explicit read-only allow-list with mutating sibling commands gated
# #
# # @author @darianrosebrook

# set -euo pipefail

# SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# danger_state_dir() {
#   local project_dir="${CLAUDE_PROJECT_DIR:-.}"
#   local state_dir="$project_dir/.claude/hooks/state"
#   mkdir -p "$state_dir"
#   printf '%s\n' "$state_dir"
# }

# danger_latch_file() {
#   local session_id="$1"
#   local safe_session
#   safe_session=$(printf '%s' "$session_id" | tr -c 'A-Za-z0-9._-' '_')
#   printf '%s/danger-latch-%s.json\n' "$(danger_state_dir)" "$safe_session"
# }

# danger_log_dir() {
#   local project_dir="${CLAUDE_PROJECT_DIR:-.}"
#   local log_dir="$project_dir/.claude/logs"
#   mkdir -p "$log_dir"
#   printf '%s\n' "$log_dir"
# }

# emit_block_json() {
#   local reason="$1"
#   jq -n --arg msg "$reason" '{ decision: "block", reason: $msg }'
# }

# emit_ask_json() {
#   local reason="$1"
#   jq -n --arg msg "$reason" '{
#     hookSpecificOutput: {
#       hookEventName: "PreToolUse",
#       permissionDecision: "ask",
#       permissionDecisionReason: $msg
#     }
#   }'
# }

# record_danger_latch() {
#   local file="$1"
#   local decision="$2"
#   local reason="$3"
#   local command="$4"

#   mkdir -p "$(dirname "$file")"
#   jq -n \
#     --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
#     --arg hook "block-dangerous.sh" \
#     --arg decision "$decision" \
#     --arg reason "$reason" \
#     --arg command "$command" \
#     '{
#       ts: $ts,
#       hook: $hook,
#       decision: $decision,
#       reason: $reason,
#       command: $command,
#       message: "Dangerous command boundary engaged. User reset required before more Bash commands may run in this session."
#     }' > "$file"
# }

# reset_guard_strikes_for_session() {
#   local session_id="$1"
#   local reason="$2"
#   local project_dir="${CLAUDE_PROJECT_DIR:-.}"
#   local safe_session
#   local log_dir
#   local strike_log
#   local targets=()
#   local file

#   safe_session=$(printf '%s' "$session_id" | tr -c 'A-Za-z0-9._-' '_')
#   log_dir="$(danger_log_dir)"
#   strike_log="$log_dir/strike-resets.log"

#   if [[ -f "$log_dir/guard-strikes-$safe_session.json" ]]; then
#     targets+=("$log_dir/guard-strikes-$safe_session.json")
#   fi

#   while IFS= read -r file; do
#     [[ -n "$file" ]] && targets+=("$file")
#   done < <(find "$project_dir/.caws/worktrees" -maxdepth 3 -type f -name "guard-strikes-$safe_session.json" 2>/dev/null || true)

#   for file in "${targets[@]+"${targets[@]}"}"; do
#     [[ -f "$file" ]] || continue
#     if ! jq -e 'any(.[]; (type == "number") and . >= 2)' "$file" >/dev/null 2>&1; then
#       continue
#     fi
#     local before
#     before=$(cat "$file" 2>/dev/null || echo '{}')
#     rm -f "$file"
#     printf '%s  action=auto-delete-after-approved-danger-command  guard=*  dry_run=0  before=%s  target=%s  reason=%s\n' \
#       "$(date '+%Y-%m-%dT%H:%M:%S%z')" \
#       "$(printf '%s' "$before" | jq -c . 2>/dev/null || printf '%s' "$before" | tr -d '\n')" \
#       "$file" \
#       "$reason" \
#       >> "$strike_log"
#   done
# }

# reset_danger_latch_after_execution() {
#   local file="$1"
#   local session_id="$2"
#   local command="$3"

#   [[ -f "$file" ]] || return 0

#   local latched_decision
#   local latched_command
#   latched_decision=$(jq -r '.decision // ""' "$file" 2>/dev/null || true)
#   latched_command=$(jq -r '.command // ""' "$file" 2>/dev/null || true)

#   # Only auto-clear ask latches after the exact command reaches PostToolUse.
#   # A deny latch remains a manual human-review boundary.
#   if [[ "$latched_decision" != "ask" ]] || [[ "$latched_command" != "$command" ]]; then
#     return 0
#   fi

#   local log_dir
#   log_dir="$(danger_log_dir)"
#   jq -n \
#     --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
#     --arg file "$file" \
#     --arg by "${USER:-unknown}" \
#     --arg command "$command" \
#     '{
#       ts: $ts,
#       latch: $file,
#       reset_by: $by,
#       reason: "auto-reset after approved Bash command reached PostToolUse",
#       command: $command
#     }' >> "$log_dir/danger-latch-resets.log"
#   rm -f "$file"
#   reset_guard_strikes_for_session "$session_id" "approved-danger-command"
# }

# reset_stale_ask_latch_for_allowed_command() {
#   local file="$1"
#   local session_id="$2"
#   local command="$3"

#   [[ -f "$file" ]] || return 1

#   local latched_decision
#   local latched_command
#   latched_decision=$(jq -r '.decision // ""' "$file" 2>/dev/null || true)
#   latched_command=$(jq -r '.command // ""' "$file" 2>/dev/null || true)

#   if [[ "$latched_decision" != "ask" ]] || [[ "$latched_command" != "$command" ]]; then
#     return 1
#   fi

#   local log_dir
#   log_dir="$(danger_log_dir)"
#   jq -n \
#     --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
#     --arg file "$file" \
#     --arg by "${USER:-unknown}" \
#     --arg command "$command" \
#     '{
#       ts: $ts,
#       latch: $file,
#       reset_by: $by,
#       reason: "auto-reset stale ask latch after command reclassified as allow",
#       command: $command
#     }' >> "$log_dir/danger-latch-resets.log"
#   rm -f "$file"
#   reset_guard_strikes_for_session "$session_id" "stale-ask-latch-now-allowed"
#   return 0
# }

# # Read JSON input from Claude Code
# INPUT=$(cat)

# # Extract tool info
# TOOL_NAME=$(printf '%s' "$INPUT" | jq -r '.tool_name // ""')
# COMMAND=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // ""')
# HOOK_EVENT_NAME=$(printf '%s' "$INPUT" | jq -r '.hook_event_name // env.HOOK_EVENT_NAME // ""')
# # Fallback to "unknown" when no session id is available so the latch still
# # engages. Multiple concurrent sessions without an id will share the "unknown"
# # latch -- safer than not latching at all.
# SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // env.CLAUDE_SESSION_ID // env.HOOK_SESSION_ID // "unknown"')

# LATCH_FILE="$(danger_latch_file "$SESSION_ID")"

# if [[ "$HOOK_EVENT_NAME" == "PostToolUse" ]]; then
#   if [[ "$TOOL_NAME" == "Bash" && -n "$COMMAND" ]]; then
#     reset_danger_latch_after_execution "$LATCH_FILE" "$SESSION_ID" "$COMMAND"
#   fi
#   reset_guard_strikes_for_session "$SESSION_ID" "approved-tool-use"
#   exit 0
# fi

# # Only check Bash tool on PreToolUse.
# if [[ "$TOOL_NAME" != "Bash" ]] || [[ -z "$COMMAND" ]]; then
#   exit 0
# fi

# # --- Python classifier (preferred path) ---
# CLASSIFIER="$SCRIPT_DIR/classify_command.py"
# if [[ ! -f "$CLASSIFIER" ]] || ! command -v python3 >/dev/null 2>&1; then
#   if [[ -f "$LATCH_FILE" ]]; then
#     REASON="A dangerous command was previously blocked or sent for approval in this Claude session, and the command classifier is unavailable. This is a human-review boundary. Ask the user to clear the latch with .claude/hooks/reset-danger-latch.sh before more Bash commands may run. Sentinel: $LATCH_FILE"
#     emit_block_json "$REASON"
#     exit 0
#   fi
#   REASON="command classifier unavailable; dangerous-command safety cannot verify Bash semantics. This is a human-review boundary. Command was: $COMMAND"
#   record_danger_latch "$LATCH_FILE" "ask" "classifier unavailable" "$COMMAND"
#   emit_ask_json "$REASON"
#   exit 0
# fi

# REPO_ROOT="${CLAUDE_PROJECT_DIR:-.}"
# CLASSIFIER_STDERR=$(mktemp)
# RESULT=$(printf '%s' "$COMMAND" | python3 "$CLASSIFIER" \
#   --repo-root "$REPO_ROOT" \
#   --home "$HOME" \
#   --cwd "$(pwd)" 2>"$CLASSIFIER_STDERR") || {
#   DIAG=$(head -c 200 "$CLASSIFIER_STDERR" 2>/dev/null || true)
#   rm -f "$CLASSIFIER_STDERR"
#   RESULT="{\"decision\":\"ask\",\"reason\":\"command classifier failed: ${DIAG:-unknown error}\"}"
# }
# rm -f "$CLASSIFIER_STDERR"

# DECISION=$(printf '%s' "$RESULT" | jq -r '.decision // "ask"')
# REASON=$(printf '%s' "$RESULT" | jq -r '.reason // "unknown"')

# if [[ -f "$LATCH_FILE" ]]; then
#   if [[ "$DECISION" == "allow" ]] && reset_stale_ask_latch_for_allowed_command "$LATCH_FILE" "$SESSION_ID" "$COMMAND"; then
#     exit 0
#   fi
#   REASON="A dangerous command was previously blocked or sent for approval in this Claude session. This is a human-review boundary, not a retryable syntax error. Do not rephrase, wrap, reorder, alias, or indirectly invoke the command. Ask the user to clear the latch with .claude/hooks/reset-danger-latch.sh before more Bash commands may run. Sentinel: $LATCH_FILE"
#   emit_block_json "$REASON"
#   exit 0
# fi

# case "$DECISION" in
#   allow)
#     exit 0
#     ;;
#   deny)
#     FULL_REASON="$REASON. This is a HARD BLOCK — Claude Code will refuse the command. This is a human-review boundary, not a retryable syntax error. Do not rephrase, wrap, reorder, alias, or indirectly invoke this command (e.g. via 'command git ...', 'env ... git ...', 'bash -lc \"...\"', or 'git --bare init'). Stop and ask the user for the next step. Command was: $COMMAND"
#     record_danger_latch "$LATCH_FILE" "$DECISION" "$REASON" "$COMMAND"
#     emit_block_json "$FULL_REASON"
#     exit 0
#     ;;
#   ask)
#     FULL_REASON="$REASON. Claude Code will PAUSE and ask the user to approve before running. This may alter destructive or authority-bearing state. Do not attempt to bypass this by rephrasing the command, switching syntax, or wrapping the invocation. If permission is not granted, stop and ask the user for the next step. Command was: $COMMAND"
#     record_danger_latch "$LATCH_FILE" "$DECISION" "$REASON" "$COMMAND"
#     emit_ask_json "$FULL_REASON"
#     exit 0
#     ;;
#   *)
#     # Unknown decision value -- malformed classifier output. Do NOT fall
#     # through to the weaker regex fallback; ask+latch instead so a
#     # corrupted classifier cannot silently downgrade safety.
#     FULL_REASON="command classifier returned an unrecognized decision '$DECISION'. Claude Code will PAUSE and ask the user. This is a human-review boundary. Command was: $COMMAND"
#     record_danger_latch "$LATCH_FILE" "ask" "classifier unknown decision: $DECISION" "$COMMAND"
#     emit_ask_json "$FULL_REASON"
#     exit 0
#     ;;
# esac

# # Every classifier outcome (allow/deny/ask/unknown) exits inside the case
# # above. There is no flat-regex fallback; if classify_command.py cannot run,
# # the early-exit at the top of this script ask-latches the command. That
# # keeps the dangerous-command decision in a single semantic layer.

# # shellcheck disable=SC2317  # Defense-in-depth tail; unreachable on a healthy classifier.
# exit 0
