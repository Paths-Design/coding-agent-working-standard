#!/usr/bin/env bats
# parse-input/runtime-paths — shared hook input parser failure visibility.
#
# Malformed vendor hook JSON must remain fail-open (hooks should not wedge the
# user's tool call because the harness payload was bad), but it must be visible
# and honest so agents do not confuse "no guard output" with a permitted command.

load helpers

setup_file() {
  caws_install_pack_once
}
teardown_file() {
  caws_teardown_pack
}

run_pre_tool_dispatcher_raw() {
  local payload="$1"
  run env \
    CAWS_PROJECT_DIR="$CAWS_TEST_REPO" \
    CAWS_AGENT_SURFACE="claude-code" \
    bash -c "printf '%s' '$payload' | bash '$CAWS_TEST_HOOKS_DIR/dispatch/pre_tool_use.sh'"
}

@test "parse-input: malformed dispatcher payload fails open but emits CAWS parse diagnostic" {
  run_pre_tool_dispatcher_raw '{not json'

  assert_success
  assert_output --partial '[CAWS hook parse] malformed hook input JSON'
  assert_output --partial 'failing open with an empty payload'
  assert_output --partial 'Expected vendor hook payload JSON on stdin'
  assert_output --partial 'Parser:'
  refute_output --partial '{not json'
  refute_output --partial 'Traceback'
  refute_output --partial '"decision": "block"'
}

@test "parse-input: valid dispatcher payload emits no parser diagnostic" {
  run_pre_tool_dispatcher_raw "$(hook_envelope Bash '' 'git status')"

  assert_success
  refute_output --partial '[CAWS hook parse]'
  refute_output --partial '"decision": "block"'
}
