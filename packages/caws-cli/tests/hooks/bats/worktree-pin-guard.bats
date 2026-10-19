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
    CAWS_BIN="${CAWS_PIN_TEST_BIN:-$CLI_DIST_ENTRY}" \
    bash -c 'printf "%s" "$1" | bash "$2"' _ "$envelope" "$CAWS_TEST_HOOKS_DIR/worktree-pin-guard.sh"
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
  assert_output --partial 'typed command analysis denied'
}

@test "pin-guard A5b: git -C redirect to another worktree — blocked" {
  mkdir -p "$CAWS_TEST_REPO/.caws/worktrees/wt-other"
  run_pin_guard "$PIN_DIR" "$PIN_DIR" "git -C $CAWS_TEST_REPO/.caws/worktrees/wt-other status"
  assert_failure 2
  assert_output --partial 'typed command analysis denied'
}

@test "pin-guard A5c: leading cd into the canonical checkout with a git token — blocked" {
  run_pin_guard "$PIN_DIR" "$PIN_DIR" "cd $CAWS_TEST_REPO && git log --oneline -3"
  assert_failure 2
  assert_output --partial 'typed command analysis denied'
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


@test "pin-guard: quoted canonical Git target is denied" {
  run_pin_guard "$PIN_DIR" "$PIN_DIR" "git -C '$CAWS_TEST_REPO' status"
  assert_failure 2
  assert_output --partial 'typed command analysis denied'
}

@test "pin-guard: assigned canonical Git target is denied" {
  run_pin_guard "$PIN_DIR" "$PIN_DIR" "p='$CAWS_TEST_REPO'; git -C \"\$p\" status"
  assert_failure 2
  assert_output --partial 'typed command analysis denied'
}

@test "pin-guard: lifecycle text cannot exempt a compound command outside the pin" {
  run_pin_guard "$PIN_DIR" "$CAWS_TEST_REPO" "caws worktree ensure wt-next --spec SPEC-1; git status"
  assert_failure 2
  assert_output --partial 'typed command analysis denied'
}

@test "pin-guard: helper keeps quotes and substitutions as payload data" {
  local sentinel="$CAWS_TEST_HOME/payload-was-executed"
  run_pin_guard "$PIN_DIR" "$PIN_DIR" "printf '%s' '\$(touch $sentinel)'"
  assert_success
  [[ ! -e "$sentinel" ]]
}

@test "pin-guard: missing analyzer under a live pin refuses as unresolved" {
  export CAWS_PIN_TEST_BIN="$CAWS_TEST_HOME/missing-caws"
  run_pin_guard "$PIN_DIR" "$PIN_DIR" "git status"
  assert_failure 2
  assert_output --partial 'UNRESOLVED'
}

run_raw_pin_payload() {
  run env CAWS_PROJECT_DIR="$PIN_DIR" CAWS_AGENT_SURFACE="claude-code" HOOK_CWD="$PIN_DIR" \
    CAWS_BIN="${CAWS_PIN_TEST_BIN:-$CLI_DIST_ENTRY}" \
    bash -c 'printf "%s" "$1" | bash "$2"' _ "$1" "$CAWS_TEST_HOOKS_DIR/worktree-pin-guard.sh"
}

@test "pin-guard: finite assigned sed filename is admitted" {
  run_pin_guard "$PIN_DIR" "$PIN_DIR" "P='src/a b.ts'; sed -n '1,40p' \"\$P\""
  assert_success
}

@test "pin-guard: malformed tool type cannot become a non-shell exemption" {
  run_raw_pin_payload '{"tool_name":17,"tool_input":{"command":"git status"}}'
  assert_failure 2
  assert_output --partial 'UNRESOLVED'
}

@test "pin-guard: native exec command requires explicit Bash and checks foreign targets" {
  local envelope
  envelope="$(jq -nc --arg p "$CAWS_TEST_REPO" --arg own "$PIN_DIR" '{cwd:$own,tool_name:"functions.exec_command",tool_input:{cmd:("git -C " + $p + " status"),shell:"/bin/bash",login:false}}')"
  run_raw_pin_payload "$envelope"
  assert_failure 2
  assert_output --partial 'foreign-git-target'
  envelope="$(jq -nc --arg own "$PIN_DIR" '{cwd:$own,tool_name:"exec_command",tool_input:{cmd:"printf x"}}')"
  run_raw_pin_payload "$envelope"
  assert_failure 2
  assert_output --partial 'shell-dialect'
}

@test "pin-guard: invalid analyzer response refuses even with Python optimization" {
  local fake="$CAWS_TEST_HOME/invalid-analyzer"
  printf '%s\n' '#!/bin/sh' "printf '%s' '{\"schema\":\"wrong\",\"decision\":\"allow\",\"reasons\":[],\"trace\":[]}'" > "$fake"
  chmod +x "$fake"
  export CAWS_PIN_TEST_BIN="$fake" PYTHONOPTIMIZE=1
  run_pin_guard "$PIN_DIR" "$PIN_DIR" 'printf x'
  assert_failure 2
  assert_output --partial 'did not return a valid decision'
}

@test "pin-guard: missing pin releases even with malformed tool metadata" {
  rm -rf "$PIN_DIR"
  run_raw_pin_payload '{"tool_name":17}'
  assert_success
  assert_output --partial 'RELEASING'
}

@test "pin-guard: native cwd must come from the original typed payload" {
  run_raw_pin_payload '{"tool_name":"Bash","tool_input":{"command":"printf x"}}'
  assert_failure 2
  assert_output --partial 'invalid-cwd'
  run_raw_pin_payload '{"cwd":17,"tool_name":"Bash","tool_input":{"command":"printf x"}}'
  assert_failure 2
  assert_output --partial 'invalid-cwd'
}

@test "pin-guard: parsed dispatcher markers cannot replace stdin or cwd" {
  local envelope
  envelope="$(jq -nc --arg p "$CAWS_TEST_REPO" '{cwd:$p,tool_name:"Bash",tool_input:{command:"git status"}}')"
  export HOOK_TOOL_NAME="Bash" HOOK_CWD="$PIN_DIR"
  run_raw_pin_payload "$envelope"
  assert_failure 2
  assert_output --partial 'foreign-git-target'
}

@test "pin-guard: dispatcher file transport preserves inert command bytes" {
  local payload="$CAWS_TEST_HOME/original-payload.json" sentinel="$CAWS_TEST_HOME/file-payload-executed"
  local command="printf '%s' 'λ \$(touch $sentinel)'"
  jq -nc --arg p "$PIN_DIR" --arg cmd "$command" '{cwd:$p,tool_name:"Bash",tool_input:{command:$cmd}}' > "$payload"
  export HOOK_PAYLOAD_FILE="$payload" HOOK_TOOL_NAME="Bash"
  run_raw_pin_payload ''
  assert_success
  [[ ! -e "$sentinel" ]]
  rm "$payload"
  run_raw_pin_payload '{"cwd":"/tmp","tool_name":"Bash","tool_input":{"command":"printf x"}}'
  assert_failure 2
  assert_output --partial 'transport file is unavailable'
}
