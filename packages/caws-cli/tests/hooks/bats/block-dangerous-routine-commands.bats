#!/usr/bin/env bats
# block-dangerous.sh — routine commands do not lock a session.
#
# CAWS-LATCH-ROUTINE-COMMANDS-001. A kill by explicit process ID is refused
# once the session has drawn its one warning, and the refusal leaves the session
# usable: no latch, no strike, and the next command runs. Every other kill, and
# a kill beside another risky operation, locks as before. A command that names
# reboot without running it is allowed; one that runs it locks.

load helpers

setup_file() {
  caws_install_pack_once
}
teardown_file() {
  caws_teardown_pack
}

setup() {
  SID="routine-$$-$BATS_TEST_NUMBER"
}

call() {
  run_guard block-dangerous.sh "$(jq -nc --arg c "$1" --arg s "$SID" \
    '{tool_name:"Bash",tool_input:{command:$c},session_id:$s}')"
}

sentinel() { printf '%s' "$CAWS_TEST_REPO/.claude/hooks/state/danger-latch-$SID.json"; }

# A later call, outside the window in which unidentified calls count as one batch.
later() { sleep 1.1; }

use_the_warning() {
  call 'docker run alpine'
  assert_success
  assert_output --partial 'WARN, first capability ask'
  later
}

assert_usable() {
  [ ! -e "$(sentinel)" ]
  call 'git status'
  assert_success
  refute_output --partial '"decision": "block"'
}

@test "kill by process ID: the first in a session draws the warning and runs" {
  call 'kill -TERM 64436'
  assert_success
  assert_output --partial 'WARN, first capability ask'
  assert_output --partial 'another kill by process ID is refused without it'
  refute_output --partial '"decision": "block"'
  assert_usable
}

@test "kill by process ID: after the warning it is refused and the session stays usable" {
  use_the_warning
  call 'kill -INT 25828'
  assert_output --partial '"decision": "block"'
  assert_output --partial 'PROC_KILL'
  assert_output --partial 'the session danger latch was NOT armed'
  assert_output --partial "your harness's own stop control"
  refute_output --partial 'NOW ARMED'
  assert_usable
}

@test "kill by process ID: repeating it never locks" {
  use_the_warning
  local n
  for n in 1 2 3 4; do
    call "kill 303$n"
    assert_output --partial '"decision": "block"'
    assert_output --partial 'NOT armed'
    later
  done
  assert_usable
}

@test "kill by process ID: a second one after a first warned kill is refused" {
  call 'kill 30339'
  assert_output --partial 'WARN, first capability ask'
  later
  call 'kill 30340'
  assert_output --partial '"decision": "block"'
  assert_output --partial 'NOT armed'
  assert_usable
}

@test "kill by process ID: a refused kill does not spend anything for the next risky command" {
  use_the_warning
  call 'kill 30339'
  later
  call 'pkill -f worker'
  assert_output --partial 'SECOND capability-risk command this session'
  [ -f "$(sentinel)" ]
}

@test "other kills: each still locks after the warning" {
  local command
  for command in 'kill -9 -1' 'kill 0' 'kill -- -1234' 'kill %1' 'kill $(pgrep node)' \
    'pkill -f worker' 'killall node' 'kill 1234; pkill -f worker' 'pkill -f worker; kill 1234' \
    'kill 1234 && docker run alpine'; do
    SID="routine-$$-$BATS_TEST_NUMBER-${command//[^a-z0-9]/_}"
    use_the_warning
    call "$command"
    assert_output --partial '"decision": "block"'
    assert_output --partial 'this one ARMS the session danger latch'
    [ -f "$(sentinel)" ]
  done
}

@test "reboot: naming it is allowed" {
  local command
  for command in 'last -n 8 reboot shutdown' 'ls /art/marker-after-reboot-2026.json' 'grep -rn shutdown src'; do
    call "$command"
    assert_success
    refute_output --partial '"decision": "block"'
    [ ! -e "$(sentinel)" ]
  done
}

@test "reboot: running it locks the session" {
  local command
  for command in 'reboot' 'true; shutdown now' 'if true; then reboot; fi' 'x=reboot; $x' 'ssh host reboot'; do
    SID="routine-$$-$BATS_TEST_NUMBER-${command//[^a-z0-9]/_}"
    call "$command"
    assert_output --partial '"decision": "block"'
    assert_output --partial 'system shutdown/reboot'
    assert_output --partial 'NOW ARMED'
    [ -f "$(sentinel)" ]
  done
}
