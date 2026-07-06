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

# Drive the PreToolUse dispatcher with a payload that carries session_id,
# under a given CAWS_AGENT_SURFACE. CAWS-RESOLVER-PLATFORM-FROM-ENVELOPE-001
# (A5): the durable session envelope written by _write_durable_session_envelope
# must carry a `platform` field sourced from CAWS_PLATFORM_FLAG.
#
# NOTE: the payload MUST include `cwd` (set to the temp repo). parse_hook_input
# extracts HOOK_CWD from data.cwd, and the envelope writer resolves the
# canonical repo_root via `cd "$HOOK_CWD" && git rev-parse --git-common-dir`;
# without cwd it returns early (no envelope written).
run_envelope_write() {
  local surface="$1" sid="$2"
  local payload
  payload="$(jq -nc --arg sid "$sid" --arg cwd "$CAWS_TEST_REPO" \
    '{tool_name:"Bash", tool_input:{file_path:"", command:"git status"}, session_id:$sid, cwd:$cwd}')"
  run env \
    CAWS_PROJECT_DIR="$CAWS_TEST_REPO" \
    CAWS_AGENT_SURFACE="$surface" \
    HOOK_EVENT_NAME="PreToolUse" \
    bash -c "printf '%s' '$payload' | bash '$CAWS_TEST_HOOKS_DIR/dispatch/pre_tool_use.sh'"
}

envelope_platform() {
  local sid="$1" envfile
  envfile="$CAWS_TEST_REPO/.caws/sessions/$sid/.session-envelope.json"
  python3 -c '
import json, sys
with open(sys.argv[1]) as f:
    print(json.load(f).get("platform", "<MISSING>"))
' "$envfile" 2>/dev/null
}

@test "parse-input: durable envelope records platform per surface (A5)" {
  local sid="bats_a5_zcode"
  run_envelope_write "zcode" "$sid"
  assert_success
  [[ -f "$CAWS_TEST_REPO/.caws/sessions/$sid/.session-envelope.json" ]]
  [ "$(envelope_platform "$sid")" = "zcode" ]

  sid="bats_a5_codex"
  run_envelope_write "codex" "$sid"
  assert_success
  [ "$(envelope_platform "$sid")" = "codex" ]

  sid="bats_a5_claude"
  run_envelope_write "claude-code" "$sid"
  assert_success
  [ "$(envelope_platform "$sid")" = "claude-code" ]

  sid="bats_a5_opencode"
  run_envelope_write "opencode" "$sid"
  assert_success
  [ "$(envelope_platform "$sid")" = "opencode" ]
}

@test "parse-input: durable envelope platform defaults to claude-code when CAWS_PLATFORM_FLAG unset (A5 back-compat)" {
  # Simulate a wiring that has not sourced agent-surface.sh: surface is
  # unknown, so CAWS_PLATFORM_FLAG is unset and the default fires.
  local sid="bats_a5_default" payload
  payload="$(jq -nc --arg sid "$sid" --arg cwd "$CAWS_TEST_REPO" \
    '{tool_name:"Bash", tool_input:{file_path:"", command:"git status"}, session_id:$sid, cwd:$cwd}')"
  run env \
    CAWS_PROJECT_DIR="$CAWS_TEST_REPO" \
    HOOK_EVENT_NAME="PreToolUse" \
    bash -c "printf '%s' '$payload' | bash '$CAWS_TEST_HOOKS_DIR/dispatch/pre_tool_use.sh'"
  assert_success
  [[ -f "$CAWS_TEST_REPO/.caws/sessions/$sid/.session-envelope.json" ]]
  [ "$(envelope_platform "$sid")" = "claude-code" ]
}

