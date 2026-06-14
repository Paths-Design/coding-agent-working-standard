#!/usr/bin/env bats
# cwd-guard.sh — deleted/inaccessible working-directory detection
# (failure-lineage E22: session crash when the working directory is deleted
# mid-session).
#
# CAWS-TEST-HOOKS-BASH-001. The guard inspects HOOK_CWD: if it is missing or
# inaccessible, it warns (to stderr) but does NOT hard-fail (exit 0 — it's a
# diagnostic, not a blocker), so a transient cwd issue does not wedge the
# session. Tests assert: a valid cwd is silent; a nonexistent cwd warns; both
# exit 0.

load helpers

setup_file() {
  caws_install_pack_once
}
teardown_file() {
  caws_teardown_pack
}

# cwd-guard reads HOOK_CWD from the ENVELOPE's `cwd` field (parse_hook_input
# overrides env from the parsed payload), so the controlled cwd goes in the JSON.
run_cwd_guard() {
  local cwd_value="$1"
  local envelope
  envelope="$(jq -nc --arg c "$cwd_value" '{cwd:$c, tool_name:"Bash", tool_input:{}}')"
  run env \
    CAWS_PROJECT_DIR="$CAWS_TEST_REPO" \
    CAWS_AGENT_SURFACE="claude-code" \
    bash -c "printf '%s' '$envelope' | bash '$CAWS_TEST_HOOKS_DIR/cwd-guard.sh'"
}

@test "cwd-guard: a valid existing cwd is silent and exits 0" {
  run_cwd_guard "$CAWS_TEST_REPO"
  assert_success
  refute_output --partial 'working directory is missing'
}

@test "cwd-guard: a nonexistent cwd WARNS but still exits 0 (diagnostic, not a wedge — E22)" {
  run_cwd_guard "/no/such/dir/deleted-mid-session"
  assert_success
  assert_output --partial 'working directory is missing'
}

@test "cwd-guard: an empty HOOK_CWD exits 0 (no false warning)" {
  run_cwd_guard ""
  assert_success
  refute_output --partial 'working directory is missing'
}
