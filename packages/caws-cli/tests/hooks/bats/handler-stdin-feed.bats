#!/usr/bin/env bats
# CAWS-DEFECT-RUNHANDLERS-STDIN-EPIPE-NOISE-001 — handler stdin must not be
# streamed through a pipe whose reader may exit before draining.
#
# Root cause this file pins: run-handlers.sh fed every handler via
# `printf '%s' "$HOOK_INPUT_JSON" | handler`. Handlers run in dispatcher
# fast-path (HOOK_* pre-parsed) and legitimately never read stdin, so any
# payload larger than the kernel pipe buffer left the writer blocked and
# then broken: one `printf: write error: Broken pipe` per handler per
# dispatch, surfaced on the dispatcher's stderr. A large tool payload turned
# every dispatch into a wall of pipe noise.

load helpers

setup_file() {
  caws_install_pack_once
}
teardown_file() {
  caws_teardown_pack
}

setup() {
  caws_session_isolation_begin
  caws_enter_fixture
}

# Byte-exact stdin delivery through run_handlers itself, with a probe handler
# in a minimal HOOKS_DIR (no lib/: run_handlers sources parse-input only when
# HOOK_INPUT_JSON is unset, and the session-id/reprieve/guard-config sources
# are all `[[ -f ]]`-guarded, so a bare handler dir is a hermetic harness).
# HOOK_INPUT_JSON is pre-set so the parser stage is skipped and the test
# observes exactly the run_handlers stdin-feeding decision.
_run_chain_with_payload() { # $1 = payload string, $2 = count file
  local fake_dir="$BATS_TEST_TMPDIR/fake-pack-$$"
  mkdir -p "$fake_dir"
  printf '#!/bin/bash\nwc -c < /dev/stdin > "$COUNT_FILE" 2>/dev/null\nexit 0\n' \
    > "$fake_dir/echo-size.sh"
  chmod +x "$fake_dir/echo-size.sh"
  # A TMPDIR inside the test directory keeps any stage this chain writes out of
  # the machine's real TMPDIR.
  mkdir -p "$BATS_TEST_TMPDIR/chain-tmp"
  # Enter the child with a filename, not an oversized argv/environment value.
  # The shell-local inline string intentionally exercises the dispatcher stage.
  local input_file="$BATS_TEST_TMPDIR/chain-input.json"
  printf '%s' "$1" > "$input_file"
  run env COUNT_FILE="$2" HOOKS_DIR="$fake_dir" PAYLOAD_INPUT_FILE="$input_file" \
    TMPDIR="$BATS_TEST_TMPDIR/chain-tmp" \
    bash -c 'unset HOOK_INPUT_JSON; HOOK_INPUT_JSON=$(cat "$PAYLOAD_INPUT_FILE"); source "'"$CAWS_TEST_HOOKS_DIR"'/lib/run-handlers.sh"; run_handlers echo-size.sh'
}

@test "handler stdin: a >64KiB inline payload reaches the handler intact, no broken-pipe stderr" {
  # 100000 bytes is above every kernel pipe buffer (so the old `printf |
  # handler` form is guaranteed to EPIPE) but below the 131072-byte inline
  # ceiling (so parse-input keeps the payload inline and run-handlers must
  # stage it itself). Pre-fix this prints one "write error: Broken pipe"
  # and strands a short read in the handler.
  local big count_file
  big=$(jq -nc '{tool_name:"Bash",tool_input:{command:"big"},tool_response:{data:("A" * 100000)}}')
  count_file="$BATS_TEST_TMPDIR/count-inline-$$"
  _run_chain_with_payload "$big" "$count_file"
  assert_success
  refute_output --partial 'write error: Broken pipe'
  [ -f "$count_file" ]
  [ "$(tr -d ' ' < "$count_file")" = "${#big}" ]
}

@test "handler stdin: a >131072-byte shell-local payload reaches the handler intact, no broken-pipe stderr" {
  # This direct-chain fixture deliberately bypasses parse-input. The installed
  # dispatch cases below exercise real HOOK_PAYLOAD_FILE transport.
  local big count_file
  big=$(jq -nc '{tool_name:"Bash",tool_input:{command:"bigger"},tool_response:{data:("B" * 200000)}}')
  count_file="$BATS_TEST_TMPDIR/count-file-$$"
  _run_chain_with_payload "$big" "$count_file"
  assert_success
  refute_output --partial 'write error: Broken pipe'
  [ -f "$count_file" ]
  [ "$(tr -d ' ' < "$count_file")" = "${#big}" ]
}

@test "handler stdin: the installed pre_tool dispatch stays quiet and succeeds on a 100KiB payload" {
  # Dispatch-level pin over the real handler chain: no per-handler pipe
  # noise reaches the dispatcher's stderr (this is the user-visible
  # signature from the defect) and the chain still completes successfully.
  local payload_file="$BATS_TEST_TMPDIR/envelope-dispatch-$$"
  jq -nc '{tool_name:"Bash",session_id:"stdin-dispatch-1",
           tool_input:{command:"git status"},
           tool_response:{data:("C" * 100000)},
           cwd:"'"$CAWS_TEST_REPO"'"}' > "$payload_file"
  run env \
    CAWS_PROJECT_DIR="$CAWS_TEST_REPO" \
    CAWS_AGENT_SURFACE="claude-code" \
    HOOK_CWD="$CAWS_TEST_REPO" \
    TMPDIR="$BATS_TEST_TMPDIR" \
    bash -c "cat '$payload_file' | bash '$CAWS_TEST_HOOKS_DIR/dispatch/pre_tool_use.sh'"
  assert_success
  refute_output --partial 'write error: Broken pipe'
}

@test "handler stdin: the installed pre_tool dispatch stays quiet on a 200KiB payload" {
  # File-transport band over the real chain: the E2BIG survival contract is
  # pinned by parse-input-payload-transport.bats; this adds the noise
  # contract for the same band.
  local payload_file="$BATS_TEST_TMPDIR/envelope-dispatch-big-$$"
  jq -nc '{tool_name:"Bash",session_id:"stdin-dispatch-2",
           tool_input:{command:"git status"},
           tool_response:{data:("D" * 200000)},
           cwd:"'"$CAWS_TEST_REPO"'"}' > "$payload_file"
  run env \
    CAWS_PROJECT_DIR="$CAWS_TEST_REPO" \
    CAWS_AGENT_SURFACE="claude-code" \
    HOOK_CWD="$CAWS_TEST_REPO" \
    TMPDIR="$BATS_TEST_TMPDIR" \
    bash -c "cat '$payload_file' | bash '$CAWS_TEST_HOOKS_DIR/dispatch/pre_tool_use.sh'"
  assert_success
  refute_output --partial 'write error: Broken pipe'
}
