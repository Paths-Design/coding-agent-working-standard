#!/usr/bin/env bats
# worktree-pin-guard.sh — per-session worktree isolation pin with
# release/re-point affordances (failure-lineage Entry 41,
# CAWS-DEFECT-WORKTREE-ISOLATION-PIN-RELEASE-01).
#
# The guard derives the pin from CAWS_PROJECT_DIR: a session whose project
# root is inside .caws/worktrees/<name> is pinned to that worktree. It
# refuses (exit 2) Bash whose effective working directory resolves outside
# the pin — except caws worktree merge/destroy/create/ensure — and RELEASES
# the pin with an advisory when the pinned directory no longer exists, so a
# session that merges its own worktree is never bricked.
#
# CAWS-TEST-HOOKS-BASH-001. Tests run the INSTALLED guard (from the temp
# pack install) with a controlled envelope: the `cwd` payload field sets
# HOOK_CWD, and CAWS_PROJECT_DIR is set per test to simulate the session
# project root (inside or outside a worktree).

load helpers

setup_file() {
  caws_install_pack_once
}
teardown_file() {
  caws_teardown_pack
}

setup() {
  export PIN_DIR="$CAWS_TEST_REPO/.caws/worktrees/wt-pinned"
  mkdir -p "$PIN_DIR"
}
teardown() {
  rm -rf "$CAWS_TEST_REPO/.caws/worktrees"
}

# Run the installed guard with a controlled session root (CAWS_PROJECT_DIR),
# payload cwd, and command. Usage:
#   run_pin_guard <session_root> <cwd> <command> [tool]
run_pin_guard() {
  local session_root="$1" cwd_value="$2" command="$3" tool="${4:-Bash}"
  local envelope
  envelope="$(jq -nc --arg c "$cwd_value" --arg cmd "$command" --arg t "$tool" \
    '{cwd:$c, tool_name:$t, tool_input:{command:$cmd}}')"
  run env \
    CAWS_PROJECT_DIR="$session_root" \
    CAWS_AGENT_SURFACE="claude-code" \
    HOOK_CWD="$cwd_value" \
    bash -c "printf '%s' '$envelope' | bash '$CAWS_TEST_HOOKS_DIR/worktree-pin-guard.sh'"
}

@test "pin-guard A1: pinned session, command inside the worktree — admitted, silent" {
  run_pin_guard "$PIN_DIR" "$PIN_DIR" "git status --short"
  assert_success
  refute_output --partial 'worktree-pin-guard'
}

@test "pin-guard A2: pinned session, working directory outside the worktree — blocked with remediation" {
  run_pin_guard "$PIN_DIR" "$CAWS_TEST_REPO" "pwd"
  assert_failure 2
  assert_output --partial 'isolated in the worktree'
  assert_output --partial "Re-run the command from $PIN_DIR"
  assert_output --partial 'caws worktree merge|destroy'
}

@test "pin-guard A3: sanctioned lifecycle verbs admitted from an outside working directory" {
  for cmd in \
    "caws worktree merge wt-pinned" \
    "caws worktree destroy wt-pinned" \
    "caws worktree create wt-next --spec SPEC-1" \
    "caws worktree ensure wt-next --spec SPEC-1"; do
    run_pin_guard "$PIN_DIR" "$CAWS_TEST_REPO" "$cmd"
    assert_success
  done
}

@test "pin-guard A4: pinned directory destroyed — RELEASES for every command (bricked-session regression)" {
  rm -rf "$PIN_DIR"
  for cmd in "pwd" "cd /tmp" "git status" "caws worktree create wt-next --spec SPEC-1"; do
    run_pin_guard "$PIN_DIR" "$CAWS_TEST_REPO" "$cmd"
    assert_success
    assert_output --partial "RELEASING this session's isolation pin"
    assert_output --partial 'caws worktree create'
  done
}

@test "pin-guard A4b: release advisory also fires when the payload cwd still names the dead worktree" {
  rm -rf "$PIN_DIR"
  run_pin_guard "$PIN_DIR" "$PIN_DIR" "pwd"
  assert_success
  assert_output --partial 'RELEASING'
}

@test "pin-guard A5: git -C redirect to the canonical checkout — blocked" {
  run_pin_guard "$PIN_DIR" "$PIN_DIR" "git -C $CAWS_TEST_REPO status"
  assert_failure 2
  assert_output --partial 'git -C redirects'
}

@test "pin-guard A5b: git -C redirect to another worktree — blocked" {
  mkdir -p "$CAWS_TEST_REPO/.caws/worktrees/wt-other"
  run_pin_guard "$PIN_DIR" "$PIN_DIR" "git -C $CAWS_TEST_REPO/.caws/worktrees/wt-other status"
  assert_failure 2
  assert_output --partial 'git -C redirects'
}

@test "pin-guard A5c: leading cd into the canonical checkout with a git token — blocked" {
  run_pin_guard "$PIN_DIR" "$PIN_DIR" "cd $CAWS_TEST_REPO && git log --oneline -3"
  assert_failure 2
  assert_output --partial "cd '$CAWS_TEST_REPO' moves the git operation"
}

@test "pin-guard A5d: git ops redirected outside the repository (scratch) — permitted" {
  run_pin_guard "$PIN_DIR" "$PIN_DIR" "git -C /tmp status"
  assert_success
  run_pin_guard "$PIN_DIR" "$PIN_DIR" "cd /tmp && git log"
  assert_success
}

@test "pin-guard A5e: git ops inside the pinned worktree — permitted" {
  run_pin_guard "$PIN_DIR" "$PIN_DIR" "git -C . status"
  assert_success
  run_pin_guard "$PIN_DIR" "$PIN_DIR" "cd $PIN_DIR && git status"
  assert_success
}

@test "pin-guard A6: unpinned session (canonical project root) — silent pass for any command" {
  run_pin_guard "$CAWS_TEST_REPO" "$CAWS_TEST_REPO" "cd /tmp && git log"
  assert_success
  refute_output --partial 'worktree-pin-guard'
}

@test "pin-guard A7: non-Bash tool — silent pass even from an outside cwd" {
  run_pin_guard "$PIN_DIR" "$CAWS_TEST_REPO" "" "Write"
  assert_success
  refute_output --partial 'worktree-pin-guard'
}

@test "pin-guard A8: missing project dir env — fails open, silent" {
  run env \
    CAWS_AGENT_SURFACE="claude-code" \
    HOOK_CWD="$CAWS_TEST_REPO" \
    bash -c "printf '%s' '{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"pwd\"}}' | bash '$CAWS_TEST_HOOKS_DIR/worktree-pin-guard.sh'"
  assert_success
  refute_output --partial 'worktree-pin-guard'
}

@test "pin-guard: relative cwd outside the pin resolves against the payload cwd and blocks" {
  run_pin_guard "$PIN_DIR" "$CAWS_TEST_REPO" "caws status"
  assert_failure 2
  assert_output --partial 'isolated in the worktree'
}
