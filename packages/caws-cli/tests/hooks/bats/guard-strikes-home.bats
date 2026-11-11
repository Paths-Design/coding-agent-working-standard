#!/usr/bin/env bats
# Strike state belongs to the machine home: CAWS_HOME, else HOME/.caws. It has
# no fallback to a shared temporary directory, and a finding whose strike
# cannot be recorded is refused with the reason stated. Each case runs the
# shipped guard-strikes.sh in a child shell with an explicit environment and
# records what it wrote and what it emitted.

setup() {
  SHARED="$BATS_TEST_DIRNAME/../../../templates/hook-packs/shared"
  WORK="$(mktemp -d "$BATS_TEST_TMPDIR/strike-home.XXXXXX")"
  mkdir -p "$WORK/machine" "$WORK/user" "$WORK/project"
  SID="strike-home-$$-$BATS_TEST_NUMBER"
  # Emitters are replaced after sourcing so the test reads the decision and
  # its text directly, without a surface envelope in between.
  cat > "$WORK/drive.sh" <<'DRIVE'
source "$1/guard-strikes.sh"
guard_emit_warning_allow() { printf 'WARN:%s\n' "$1"; }
guard_emit_permission_ask() { printf 'ASK:%s\n' "$1"; }
guard_emit_block() { printf 'BLOCK:%s\n' "$1"; }
shift
session="$1"; times="$2"
while [ "$times" -gt 0 ]; do
  guard_enforce_progressive_strikes "$session" scope_guard "" first second third
  times=$((times - 1))
done
DRIVE
}

# drive <session> <times> [NAME=value ...] — run the driver with only the given
# environment plus PATH and the project directory.
drive() {
  local session="$1" times="$2"
  shift 2
  run env -i PATH="$PATH" CAWS_PROJECT_DIR="$WORK/project" "$@" \
    bash "$WORK/drive.sh" "$SHARED" "$session" "$times" </dev/null
}

@test "strike state is written under CAWS_HOME, not under HOME" {
  drive "$SID" 1 CAWS_HOME="$WORK/machine" HOME="$WORK/user"
  [ "$status" -eq 0 ]
  [ "$output" = "WARN:first" ]
  [ "$(cat "$WORK/machine/state/sessions/$SID/strikes.json" | tr -d ' \n')" = '{"scope_guard":1}' ]
  [ ! -e "$WORK/user/.caws" ]
}

@test "without CAWS_HOME, strike state is written under HOME/.caws" {
  drive "$SID" 1 HOME="$WORK/user"
  [ "$status" -eq 0 ]
  [ "$output" = "WARN:first" ]
  [ "$(cat "$WORK/user/.caws/state/sessions/$SID/strikes.json" | tr -d ' \n')" = '{"scope_guard":1}' ]
}

@test "repeated findings in one session progress from warning to ask to block" {
  drive "$SID" 4 CAWS_HOME="$WORK/machine"
  [ "$status" -eq 0 ]
  [ "$output" = "WARN:first
ASK:second
BLOCK:third
BLOCK:third" ]
  [ "$(cat "$WORK/machine/state/sessions/$SID/strikes.json" | tr -d ' \n')" = '{"scope_guard":4}' ]
}

@test "with neither CAWS_HOME nor HOME the finding is refused with that reason and nothing lands in /tmp" {
  drive "$SID" 2
  [ "$status" -eq 0 ]
  [ "$output" = "BLOCK:Strike state is unavailable: neither CAWS_HOME nor HOME is set. This finding is refused outright because it cannot be counted; it is not a strike. Finding: third
BLOCK:Strike state is unavailable: neither CAWS_HOME nor HOME is set. This finding is refused outright because it cannot be counted; it is not a strike. Finding: third" ]
  [ ! -e "/tmp/.caws/state/sessions/$SID" ]
  [ ! -e "$WORK/project/.caws" ]
}

@test "an unresolved session is refused with that reason, not reported as a third strike" {
  drive unknown 1 CAWS_HOME="$WORK/machine"
  [ "$status" -eq 0 ]
  [ "$output" = "BLOCK:Strike state is unavailable: the session id is unresolved. This finding is refused outright because it cannot be counted; it is not a strike. Finding: third" ]
  [ ! -e "$WORK/machine/state" ]
}

@test "an empty session id is refused the same way" {
  drive "" 1 CAWS_HOME="$WORK/machine"
  [ "$status" -eq 0 ]
  [ "$output" = "BLOCK:Strike state is unavailable: the session id is unresolved. This finding is refused outright because it cannot be counted; it is not a strike. Finding: third" ]
}
