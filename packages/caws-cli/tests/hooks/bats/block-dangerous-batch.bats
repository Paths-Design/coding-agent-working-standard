#!/usr/bin/env bats
# block-dangerous.sh — a batch of queued tool calls counts once.
#
# A harness can issue several tool calls from one model reply, queued before
# the model reads any result. A call queued with a refused one is not a retry
# of it, so it must not escalate: no strike, no latch, no process kill. A call
# from a later reply is a retry and escalates. The refused command never runs
# in either case.
#
# The batch is the assistant message carrying the tool call, read from the
# transcript named in the payload. Each test writes a transcript in the
# harness's shape and sends envelopes that name it.

load helpers

setup_file() {
  caws_install_pack_once
}
teardown_file() {
  caws_teardown_pack
}

setup() {
  TRANSCRIPT="$BATS_TEST_TMPDIR/transcript.jsonl"
  : > "$TRANSCRIPT"
  SID="batch-$$-$BATS_TEST_NUMBER"
}

# say <message-id> <tool-use-id>... — append one assistant message that issues
# the given tool calls, one transcript line per call, as the harness writes it.
say() {
  local message="$1" use
  shift
  for use in "$@"; do
    jq -nc --arg m "$message" --arg u "$use" \
      '{type:"assistant",message:{id:$m,content:[{type:"tool_use",id:$u,name:"Bash"}]}}' >> "$TRANSCRIPT"
  done
}

# call <tool-use-id> <command> — a Bash call naming the transcript.
call() {
  run_guard block-dangerous.sh "$(jq -nc --arg c "$2" --arg s "$SID" --arg t "$TRANSCRIPT" --arg u "$1" \
    '{tool_name:"Bash",tool_input:{command:$c},session_id:$s,transcript_path:$t,tool_use_id:$u}')"
}

# call_bare <command> — a Bash call with no transcript and no tool-use id.
call_bare() {
  run_guard block-dangerous.sh "$(jq -nc --arg c "$1" --arg s "$SID" \
    '{tool_name:"Bash",tool_input:{command:$c},session_id:$s}')"
}

# write_call <tool-use-id> <path> — a Write call naming the transcript.
write_call() {
  run_guard block-dangerous.sh "$(jq -nc --arg p "$2" --arg s "$SID" --arg t "$TRANSCRIPT" --arg u "$1" \
    '{tool_name:"Write",tool_input:{file_path:$p,content:"x"},session_id:$s,transcript_path:$t,tool_use_id:$u}')"
}

sentinel() { printf '%s' "$CAWS_TEST_REPO/.claude/hooks/state/danger-latch-$SID.json"; }
strikes() { jq -r '.trap_strikes // 0' "$(sentinel)"; }
escalation_events() {
  local log="$CAWS_TEST_REPO/.claude/logs/danger-latch-escalations.log"
  [ -f "$log" ] || { printf '0'; return; }
  grep -c "\"$SID\"" "$log" || true
}

ARM='sudo rm -rf /private/tmp/batch-arm-probe'
OPAQUE_ONE='python3 -c "print($X)"'
OPAQUE_TWO='node -e "console.log($Y)"'

@test "batch: calls queued with the arming command are refused without a strike" {
  say msg_1 use_a use_b use_c
  call use_a "$ARM"
  assert_output --partial 'the session danger latch is NOW ARMED'
  [ "$(jq -r '.batch_key' "$(sentinel)")" = "msg_1" ]

  call use_b 'git commit -m chore'
  assert_output --partial '"decision": "block"'
  assert_output --partial 'was queued together with the command that engaged the danger trap'
  assert_output --partial 'it is NOT counted as a strike and it triggers no escalation'
  write_call use_c "$CAWS_TEST_REPO/notes.txt"
  assert_output --partial '"decision": "block"'
  assert_output --partial 'was queued together with the command that engaged the danger trap'

  [ "$(strikes)" = "0" ]
  [ ! -e "$CAWS_TEST_REPO/notes.txt" ]
}

@test "batch: a transcript line written after the arming call still identifies its batch" {
  # The harness writes the line after the hook has started: the arming call
  # finds nothing on disk and records only its tool-use id.
  call use_a "$ARM"
  [ "$(jq -r '.batch_key' "$(sentinel)")" = "" ]
  [ "$(jq -r '.tool_use_id' "$(sentinel)")" = "use_a" ]
  say msg_1 use_a use_b
  # Long past any time window: only the transcript can say these were queued together.
  CAWS_BATCH_WINDOW_SECONDS=0 call use_b 'git commit -m chore'
  assert_output --partial 'was queued together with the command that engaged the danger trap'
  [ "$(strikes)" = "0" ]
}

@test "batch: a late transcript line does not hide a call from a later reply" {
  call use_a "$ARM"
  say msg_1 use_a
  say msg_2 use_b
  # Inside the time window, yet the transcript shows a different reply.
  CAWS_BATCH_WINDOW_SECONDS=60 call use_b 'git commit -m chore'
  refute_output --partial 'was queued together'
  [ "$(strikes)" = "1" ]
}

@test "batch: a call from a later reply is a strike and escalates" {
  say msg_1 use_a
  call use_a "$ARM"
  say msg_2 use_b
  call use_b 'git commit -m chore'
  assert_output --partial '"decision": "block"'
  assert_output --partial 'QUARANTINED'
  refute_output --partial 'was queued together'
  [ "$(strikes)" = "1" ]
}

@test "batch: a tool-use id the transcript does not contain falls back to the time window" {
  say msg_1 use_a
  call use_a "$ARM"
  # use_missing is in no message: with the window open it is taken as queued
  # with the arming call; with the window closed it is a later call.
  CAWS_BATCH_WINDOW_SECONDS=60 call use_missing 'git commit -m chore'
  assert_output --partial 'was queued together with the command that engaged the danger trap'
  [ "$(strikes)" = "0" ]
  CAWS_BATCH_WINDOW_SECONDS=0 call use_missing 'git commit -m chore'
  refute_output --partial 'was queued together'
  [ "$(strikes)" = "1" ]
}

@test "batch: with no transcript the time window decides" {
  call_bare "$ARM"
  [ "$(jq -r '.batch_key' "$(sentinel)")" = "" ]
  CAWS_BATCH_WINDOW_SECONDS=60 call_bare 'git commit -m chore'
  assert_output --partial 'was queued together with the command that engaged the danger trap'
  [ "$(strikes)" = "0" ]
  CAWS_BATCH_WINDOW_SECONDS=0 call_bare 'git commit -m chore'
  assert_output --partial 'QUARANTINED'
  refute_output --partial 'was queued together'
  [ "$(strikes)" = "1" ]
}

@test "batch: a transcript message id is not taken from the tool input" {
  say msg_1 use_a
  call use_a "$ARM"
  say msg_2 use_b
  # The agent controls tool_input; a batch id placed there changes nothing.
  run_guard block-dangerous.sh "$(jq -nc --arg s "$SID" --arg t "$TRANSCRIPT" \
    '{tool_name:"Bash",tool_input:{command:"git commit -m chore",batch_key:"msg_1",tool_use_id:"use_a",transcript_path:$t},session_id:$s,transcript_path:$t,tool_use_id:"use_b"}')"
  refute_output --partial 'was queued together'
  [ "$(strikes)" = "1" ]
}

@test "repeat: the same no-latch classification in a later reply arms the latch" {
  say msg_1 use_a
  call use_a "$OPAQUE_ONE"
  assert_output --partial 'NOT armed'
  assert_output --partial 'A second opaque inline payload in this session, sent after this refusal, WILL arm the danger latch.'
  [ ! -e "$(sentinel)" ]
  say msg_2 use_b
  call use_b "$OPAQUE_TWO"
  assert_output --partial '"decision": "block"'
  assert_output --partial 'this is a repeat of that same classification (opaque_exec), so the session danger latch is NOW ARMED'
  [ -f "$(sentinel)" ]
}

@test "repeat: the same classification queued in one reply does not arm the latch" {
  say msg_1 use_a use_b use_c
  call use_a "$OPAQUE_ONE"
  call use_b "$OPAQUE_TWO"
  assert_output --partial '"decision": "block"'
  assert_output --partial 'NOT armed'
  call use_c "$OPAQUE_ONE"
  assert_output --partial 'NOT armed'
  [ ! -e "$(sentinel)" ]
}

@test "repeat: a human reset clears the repeat record" {
  say msg_1 use_a
  call use_a "$OPAQUE_ONE"
  local record="$CAWS_TEST_REPO/.claude/hooks/state/danger-repeat-$SID.json"
  [ "$(jq -r '.opaque_exec.batch_key' "$record")" = "msg_1" ]
  say msg_2 use_b
  call use_b "$OPAQUE_TWO"
  [ -f "$(sentinel)" ]
  run env CAWS_PROJECT_DIR="$CAWS_TEST_REPO" CAWS_AGENT_SURFACE=claude-code \
    bash "$CAWS_TEST_HOOKS_DIR/reset-danger-latch.sh" --session "$SID" --reason "bats reset" </dev/null
  [ "$status" -eq 0 ]
  [ ! -e "$(sentinel)" ]
  [ ! -e "$record" ]
  # After the reset the count starts over: one refusal, no latch.
  say msg_3 use_c
  call use_c "$OPAQUE_ONE"
  assert_output --partial 'NOT armed'
  [ ! -e "$(sentinel)" ]
}

@test "repeat: a different no-latch classification later does not arm the latch" {
  say msg_1 use_a
  call use_a "$OPAQUE_ONE"
  # A first capability-risk command is its own classification: it draws the
  # session's one warning and is allowed, with no latch.
  say msg_2 use_b
  call use_b 'docker run alpine'
  assert_success
  assert_output --partial 'WARN, first capability ask'
  [ ! -e "$(sentinel)" ]
}

@test "capability: a second risk command queued with the warned one is refused without a latch" {
  say msg_1 use_a use_b
  call use_a 'docker run alpine'
  assert_output --partial 'WARN, first capability ask'
  refute_output --partial '"decision": "block"'
  call use_b 'kill -9 1234'
  assert_output --partial '"decision": "block"'
  assert_output --partial 'was queued together with another one (`docker run alpine`) that drew this session'
  assert_output --partial 'the session danger latch was NOT armed'
  [ ! -e "$(sentinel)" ]
}

@test "capability: two risk commands whose hooks run at the same time draw one warning between them" {
  say msg_1 use_a use_b
  local out_a="$BATS_TEST_TMPDIR/a.out" out_b="$BATS_TEST_TMPDIR/b.out" cmd
  for cmd in a b; do
    local use="use_$cmd" text='docker run alpine' out="$BATS_TEST_TMPDIR/$cmd.out"
    [ "$cmd" = a ] || text='kill -9 1234'
    env CLAUDE_CODE_SESSION_ID="$CAWS_TEST_SESSION_ID" CAWS_BATCH_WINDOW_SECONDS=0 \
      CAWS_PROJECT_DIR="$CAWS_TEST_REPO" CAWS_AGENT_SURFACE="claude-code" HOOK_CWD="$CAWS_TEST_REPO" \
      bash -c 'cd "$1" && printf "%s" "$2" | bash "$3"' _ "$CAWS_TEST_REPO" \
      "$(jq -nc --arg c "$text" --arg s "$SID" --arg t "$TRANSCRIPT" --arg u "$use" \
        '{tool_name:"Bash",tool_input:{command:$c},session_id:$s,transcript_path:$t,tool_use_id:$u}')" \
      "$CAWS_TEST_HOOKS_DIR/block-dangerous.sh" >"$out" 2>&1 </dev/null &
  done
  wait
  local warned refused
  warned="$(cat "$out_a" "$out_b" | grep -c 'WARN, first capability ask')"
  refused="$(cat "$out_a" "$out_b" | grep -c 'was queued together with another one')"
  [ "$warned" -eq 1 ]
  [ "$refused" -eq 1 ]
  [ ! -e "$(sentinel)" ]
}

@test "capability: a second risk command in a later reply arms the latch" {
  say msg_1 use_a
  call use_a 'docker run alpine'
  say msg_2 use_b
  call use_b 'kill -9 1234'
  assert_output --partial '"decision": "block"'
  assert_output --partial 'SECOND capability-risk command this session'
  [ -f "$(sentinel)" ]
  [ "$(jq -r '.batch_key' "$(sentinel)")" = "msg_2" ]
}
