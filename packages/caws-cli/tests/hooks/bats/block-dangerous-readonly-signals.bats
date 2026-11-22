#!/usr/bin/env bats
# Read-only commands neither warn nor arm the danger latch through the real
# guard; a request that sends a body still does (CAWS-GUARD-FALSE-SIGNALS-001).
#
# The classifier tests pin decisions. These pin what the agent experiences:
# block-dangerous.sh's exit, its stderr, and the per-session warning and latch
# files it writes. The curl command is the one that armed a live rc session's
# latch on Nov 21 2026.

load helpers

setup_file() {
  caws_install_pack_once
}

teardown_file() {
  caws_teardown_pack
}

setup() {
  SID="readonly-$$-$BATS_TEST_NUMBER"
}

call() {
  run_guard block-dangerous.sh "$(jq -nc --arg c "$1" --arg s "$SID" \
    '{tool_name:"Bash",tool_input:{command:$c},session_id:$s}')"
}

state_dir() { printf '%s' "$CAWS_TEST_REPO/.claude/hooks/state"; }
latch_file() { printf '%s/danger-latch-%s.json' "$(state_dir)" "$SID"; }
warn_file() { printf '%s/danger-warn-%s.json' "$(state_dir)" "$SID"; }

FIELD_CURL='curl -s -G "https://commons.wikimedia.org/w/api.php" --data-urlencode "action=query" --data-urlencode "format=json" | jq .'

@test "curl -G with request data twice: no warning, no latch" {
  call "$FIELD_CURL"
  assert_success
  refute_output --partial 'WARN'
  refute_output --partial 'decision'
  [ ! -f "$(warn_file)" ]
  call 'curl -sG https://example.test/api --data-urlencode q=x'
  assert_success
  refute_output --partial 'WARN'
  refute_output --partial 'decision'
  refute_output --partial 'capability'
  [ ! -f "$(warn_file)" ]
  [ ! -f "$(latch_file)" ]
}

@test "curl sending a body twice still warns, then arms the latch" {
  call 'curl -sd q=x https://example.test/api'
  assert_success
  assert_output --partial 'WARN, first capability ask'
  [ -f "$(warn_file)" ]
  call 'curl -d q=y https://example.test/api'
  assert_output --partial 'SECOND capability-risk command this session'
  [ -f "$(latch_file)" ]
}

@test "read-only git inspection draws no advisory" {
  for cmd in 'git grep -n foo' 'git merge-base main HEAD' 'git ls-tree -r HEAD' \
    'git for-each-ref refs/heads' 'git show-ref --heads' 'git check-attr -a README.md' \
    'git diff-tree --name-only -r HEAD'; do
    call "$cmd"
    assert_success
    refute_output --partial 'advisory'
    refute_output --partial 'unknown git subcommand'
  done
  [ ! -f "$(warn_file)" ]
  [ ! -f "$(latch_file)" ]
}

@test "git grep that opens a program keeps its advisory" {
  call 'git grep -O vim foo'
  assert_success
  assert_output --partial 'caws advisory (non-blocking): git grep --open-files-in-pager (-O) launches an external program'
}
