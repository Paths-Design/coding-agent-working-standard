#!/usr/bin/env bats
# block-dangerous.sh — a failure of the command classifier itself.
#
# When the classifier is missing, crashes, or answers with a decision the guard
# does not know, the command was never judged. It is refused, and the refusal
# names the fault. It does not arm the danger latch: the agent did nothing
# wrong and has no way to discharge a latch for it.

load helpers

setup_file() {
  caws_install_pack_once
  export CAWS_BATCH_WINDOW_SECONDS=0
}
teardown_file() {
  caws_teardown_pack
}

setup() {
  SID="classifier-fault-$$-$BATS_TEST_NUMBER"
  SHIM="$BATS_TEST_TMPDIR/shim"
  mkdir -p "$SHIM"
  REAL_PYTHON="$(command -v python3)"
}

sentinel() { printf '%s' "$CAWS_TEST_REPO/.claude/hooks/state/danger-latch-$SID.json"; }

envelope() {
  jq -nc --arg c "$1" --arg s "$SID" '{tool_name:"Bash",tool_input:{command:$c},session_id:$s}'
}

# with_path <PATH> <command> — run the guard with a chosen PATH.
with_path() {
  run env PATH="$1" CLAUDE_CODE_SESSION_ID="$CAWS_TEST_SESSION_ID" \
    CAWS_PROJECT_DIR="$CAWS_TEST_REPO" CAWS_AGENT_SURFACE="claude-code" HOOK_CWD="$CAWS_TEST_REPO" \
    bash -c 'cd "$1" && printf "%s" "$2" | bash "$3"' _ \
    "$CAWS_TEST_REPO" "$(envelope "$2")" "$CAWS_TEST_HOOKS_DIR/block-dangerous.sh" </dev/null
}

# classifier_shim <body> — a python3 that behaves normally except when asked
# to run classify_command.py, where it runs <body>.
classifier_shim() {
  cat > "$SHIM/python3" <<SHIM
#!/bin/bash
for arg in "\$@"; do
  case "\$arg" in
    */classify_command.py) $1 ;;
  esac
done
exec "$REAL_PYTHON" "\$@"
SHIM
  chmod +x "$SHIM/python3"
}

@test "classifier failure: a classifier that exits with an error refuses without arming the latch" {
  classifier_shim 'echo "boom: classifier exploded" >&2; exit 3'
  with_path "$SHIM:$PATH" 'ls -la'
  assert_success
  assert_output --partial '"decision": "block"'
  assert_output --partial 'command classifier failed: boom: classifier exploded'
  assert_output --partial 'the refusal adds no strike and does NOT arm the danger latch'
  [ ! -e "$(sentinel)" ]
  # A second command is refused the same way; nothing accumulates.
  with_path "$SHIM:$PATH" 'git status'
  assert_output --partial 'does NOT arm the danger latch'
  [ ! -e "$(sentinel)" ]
}

@test "classifier failure: an unrecognized decision refuses, names it, and does not arm the latch" {
  classifier_shim 'printf "%s" "{\"decision\":\"maybe\",\"reason\":\"x\",\"source\":\"regex\"}"; exit 0'
  with_path "$SHIM:$PATH" 'ls -la'
  assert_success
  assert_output --partial "the command classifier returned an unrecognized decision 'maybe'"
  assert_output --partial 'does NOT arm the danger latch'
  [ ! -e "$(sentinel)" ]
}

@test "classifier failure: a missing classifier file refuses, names the file, and does not arm the latch" {
  local copy="$BATS_TEST_TMPDIR/hooks"
  cp -R "$CAWS_TEST_HOOKS_DIR" "$copy"
  mv "$copy/classify_command.py" "$copy/classify_command.py.absent"
  run env CLAUDE_CODE_SESSION_ID="$CAWS_TEST_SESSION_ID" \
    CAWS_PROJECT_DIR="$CAWS_TEST_REPO" CAWS_AGENT_SURFACE="claude-code" HOOK_CWD="$CAWS_TEST_REPO" \
    bash -c 'cd "$1" && printf "%s" "$2" | bash "$3"' _ \
    "$CAWS_TEST_REPO" "$(envelope 'ls -la')" "$copy/block-dangerous.sh" </dev/null
  assert_success
  assert_output --partial "the command classifier cannot run (classify_command.py is missing from $copy)"
  assert_output --partial 'does NOT arm the danger latch'
  [ ! -e "$(sentinel)" ]
}

@test "classifier failure: a traceback with quotes in it is still reported as the classifier's failure" {
  classifier_shim 'echo "Traceback: File \"classify_command.py\", line 1, in <module>" >&2; exit 1'
  with_path "$SHIM:$PATH" 'ls -la'
  assert_success
  assert_output --partial '"decision": "block"'
  assert_output --partial 'command classifier failed: Traceback: File'
  assert_output --partial 'does NOT arm the danger latch'
  [ ! -e "$(sentinel)" ]
}

@test "classifier failure: a real catastrophic deny still arms the latch after a classifier fault" {
  classifier_shim 'echo "boom" >&2; exit 3'
  with_path "$SHIM:$PATH" 'ls -la'
  [ ! -e "$(sentinel)" ]
  with_path "$PATH" 'rm -rf /'
  assert_output --partial '"decision": "block"'
  assert_output --partial 'the session danger latch is NOW ARMED'
  [ -f "$(sentinel)" ]
}

# A command nested past the classifier's budget is a verdict about the command,
# not a fault: the classifier ran and said it could not finish.
NESTED='bash -c "bash -c \"bash -c \\\"bash -c \\\\\\\"bash -c ls\\\\\\\"\\\"\""'

@test "unanalyzable command: the first is refused with the way to restate it and no latch" {
  with_path "$PATH" "$NESTED"
  assert_success
  assert_output --partial '"decision": "block"'
  assert_output --partial 'recursion budget exceeded'
  assert_output --partial 'the session danger latch was NOT armed'
  assert_output --partial 'A second unanalyzable command in this session, sent after this refusal, WILL arm the danger latch.'
  [ ! -e "$(sentinel)" ]
}

@test "unanalyzable command: a second one sent after the refusal arms the latch" {
  with_path "$PATH" "$NESTED"
  [ ! -e "$(sentinel)" ]
  with_path "$PATH" "$NESTED"
  assert_output --partial 'this is a repeat of that same classification (classifier_error), so the session danger latch is NOW ARMED'
  [ -f "$(sentinel)" ]
}

@test "unanalyzable command: a classifier crash between two of them does not count as the repeat" {
  with_path "$PATH" "$NESTED"
  classifier_shim 'echo "boom" >&2; exit 3'
  with_path "$SHIM:$PATH" 'ls -la'
  assert_output --partial 'does NOT arm the danger latch'
  [ ! -e "$(sentinel)" ]
}
