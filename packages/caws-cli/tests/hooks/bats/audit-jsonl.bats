#!/usr/bin/env bats
# audit.sh — the audit log must be true JSONL and must carry the tool payload.
# AUDIT-JSONL-EMISSION-001. Pre-fix the hook emitted pretty-printed JSON (jq -n),
# so one audit record spanned many lines and every line-wise consumer saw a
# truncated record; the tool payload (tool_use_id / tool_input / tool_response)
# was also dropped entirely.

load helpers

setup_file() {
  caws_install_pack_once
}
teardown_file() {
  caws_teardown_pack
}

_log_file() { printf '%s' "$CAWS_TEST_REPO/.claude/logs/audit.log"; }

_run_audit() { # $1 = event type, $2 = JSON envelope (no single quotes inside)
  run env CAWS_PROJECT_DIR="$CAWS_TEST_REPO" CAWS_AGENT_SURFACE="claude-code" \
    HOOK_CWD="$CAWS_TEST_REPO" \
    bash -c "printf '%s' '$2' | bash '$CAWS_TEST_HOOKS_DIR/audit.sh' '$1'"
}

@test "audit: a tool-use record is exactly one JSON line (A1)" {
  local envelope
  envelope=$(jq -nc '{tool_name:"Bash",session_id:"audit-a1",tool_use_id:"tu-1",
                      tool_input:{command:"ls"},tool_response:{exit_code:0},cwd:"/tmp"}')
  rm -f "$(_log_file)"
  _run_audit tool-use "$envelope"
  assert_success
  [ "$(wc -l < "$(_log_file)" | tr -d ' ')" = "1" ]
  jq -e . "$(_log_file)" >/dev/null
}

@test "audit: the tool_use record carries the tool payload (A2)" {
  local envelope
  envelope=$(jq -nc '{tool_name:"Bash",session_id:"audit-a2",tool_use_id:"tu-2",
                      tool_input:{command:"echo hi"},tool_response:{exit_code:0,stdout:"hi"},cwd:"/tmp"}')
  rm -f "$(_log_file)"
  _run_audit tool-use "$envelope"
  [ "$(jq -r '.tool_use_id' "$(_log_file)")" = "tu-2" ]
  [ "$(jq -c '.tool_input' "$(_log_file)")" = '{"command":"echo hi"}' ]
  [ "$(jq -r '.tool_response.stdout' "$(_log_file)")" = "hi" ]
}

@test "audit: is_error tracks the response exit code in both directions (A3)" {
  local failing ok
  failing=$(jq -nc '{tool_name:"Bash",session_id:"audit-a3",tool_use_id:"tu-3",
                     tool_input:{command:"false"},tool_response:{exit_code:1},cwd:"/tmp"}')
  rm -f "$(_log_file)"
  _run_audit tool-use "$failing"
  [ "$(jq -r '.is_error' "$(_log_file)")" = "true" ]
  ok=$(jq -nc '{tool_name:"Bash",session_id:"audit-a3",tool_use_id:"tu-4",
                tool_input:{command:"true"},tool_response:{exit_code:0},cwd:"/tmp"}')
  _run_audit tool-use "$ok"
  [ "$(jq -r '.is_error' "$(_log_file)" | tail -1)" = "false" ]
}

@test "audit: every event branch emits one line (A4)" {
  rm -f "$(_log_file)"
  _run_audit session-start "$(jq -nc '{session_id:"audit-a4"}')"
  _run_audit stop "$(jq -nc '{session_id:"audit-a4",stop_hook_active:true}')"
  _run_audit mystery "$(jq -nc '{session_id:"audit-a4"}')"
  [ "$(wc -l < "$(_log_file)" | tr -d ' ')" = "3" ]
  while IFS= read -r line; do
    printf '%s' "$line" | jq -e . >/dev/null
  done < "$(_log_file)"
}
