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

setup() {
  caws_session_isolation_begin
  # Some payloads here carry no `cwd`, so the hook would fall back to the
  # runner's cwd; run from inside the fixture repo instead.
  caws_enter_fixture
}

teardown() {
  caws_assert_session_state_isolated audit-a1 audit-a2 audit-a3 audit-a4 \
    "${CAWS_TEST_SESSION_ID:-}"
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

@test "audit: a >=131072-byte tool payload still records one tool_use line (A5)" {
  # CAWS-DEFECT-AUDIT-TOOLJSON-EMPTY-ARGJSON-001. At or above the inline
  # payload ceiling, parse_hook_input switches to file transport and exports
  # HOOK_TOOL_INPUT_JSON/RESPONSE empty by design. Pre-fix, the tool-use
  # branch passed those empty strings straight to `jq --argjson`, jq exited
  # 2 with "invalid JSON text passed to --argjson", and `set -e` turned the
  # logging hook's crash into a post_tool_use block — with NO audit record
  # for exactly the largest tool calls. The envelope is read from a file so
  # the payload never becomes part of a shell command line.
  local payload_file="$BATS_TEST_TMPDIR/big-envelope-a5.json"
  local real_jq jq_bin="$BATS_TEST_TMPDIR/linux-argv-limit"
  real_jq=$(command -v jq)
  mkdir -p "$jq_bin"
  # Exercise Linux's per-argument boundary even on the macOS test host.
  printf '#!/bin/bash\nfor arg; do if [ "${#arg}" -ge 131072 ]; then echo "oversized jq argument" >&2; exit 126; fi; done\nexec %q "$@"\n' \
    "$real_jq" > "$jq_bin/jq"
  chmod +x "$jq_bin/jq"
  jq -nc '{tool_name:"Write",session_id:"audit-a5",tool_use_id:"tu-5",
           tool_input:{file_path:"/tmp/big.bin",content:("x" * 140000)},
           tool_response:{bytes:140000,marker:"big-payload-marker"},cwd:"/tmp"}' \
    > "$payload_file"
  rm -f "$(_log_file)"
  run env CAWS_PROJECT_DIR="$CAWS_TEST_REPO" CAWS_AGENT_SURFACE="claude-code" \
    HOOK_CWD="$CAWS_TEST_REPO" TMPDIR="$BATS_TEST_TMPDIR" PATH="$jq_bin:$PATH" \
    bash -c "cat '$payload_file' | bash '$CAWS_TEST_HOOKS_DIR/audit.sh' 'tool-use'"
  assert_success
  local log
  log="$(_log_file)"
  [ "$(wc -l < "$log" | tr -d ' ')" = "1" ]
  [ "$(jq -r '.tool_use_id' "$log")" = "tu-5" ]
  [ "$(jq -r '.tool_input.file_path' "$log")" = "/tmp/big.bin" ]
  [ "$(jq -r '.tool_response.marker' "$log")" = "big-payload-marker" ]
  [ "$(jq -r '.is_error' "$log")" = "false" ]
  jq -c '.tool_input, .tool_response' "$payload_file" > "$BATS_TEST_TMPDIR/expected-payload.jsonl"
  jq -c '.tool_input, .tool_response' "$log" > "$BATS_TEST_TMPDIR/observed-payload.jsonl"
  cmp "$BATS_TEST_TMPDIR/expected-payload.jsonl" "$BATS_TEST_TMPDIR/observed-payload.jsonl"
}

@test "audit: file-transport record coerces non-dict tool objects to {} (A6)" {
  # The parser dict-coerces tool_input/tool_response before exporting the
  # inline JSON; the payload-file read must apply the same coercion, so a
  # harness envelope carrying a scalar/array object still yields a valid
  # record (and the is_error filter still evaluates). Forcing the ceiling
  # down to 10 bytes exercises file transport without a large fixture.
  local payload_file="$BATS_TEST_TMPDIR/odd-envelope-a6.json"
  jq -nc '{tool_name:"Bash",session_id:"audit-a6",tool_use_id:"tu-6",
           tool_input:"flat-string-not-object",
           tool_response:[1,2,3],cwd:"/tmp"}' > "$payload_file"
  rm -f "$(_log_file)"
  run env CAWS_HOOK_INLINE_PAYLOAD_MAX_BYTES=10 \
    CAWS_PROJECT_DIR="$CAWS_TEST_REPO" CAWS_AGENT_SURFACE="claude-code" \
    HOOK_CWD="$CAWS_TEST_REPO" TMPDIR="$BATS_TEST_TMPDIR" \
    bash -c "cat '$payload_file' | bash '$CAWS_TEST_HOOKS_DIR/audit.sh' 'tool-use'"
  assert_success
  local log
  log="$(_log_file)"
  [ "$(wc -l < "$log" | tr -d ' ')" = "1" ]
  [ "$(jq -c '.tool_input' "$log")" = '{}' ]
  [ "$(jq -c '.tool_response' "$log")" = '{}' ]
  [ "$(jq -r '.is_error' "$log")" = "false" ]
}
