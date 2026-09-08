#!/usr/bin/env bats

load helpers

setup() {
  HOSTILE_HOME="$BATS_TEST_TMPDIR/user"
  HOSTILE_MACHINE="$BATS_TEST_TMPDIR/machine"
  mkdir -p "$HOSTILE_HOME"
  local surface
  for surface in claude-code kimi-code qwen-code; do
    mkdir -p "$HOSTILE_MACHINE/surfaces/$surface"
    printf '{"version":0,"enabled":true}\n' > "$HOSTILE_MACHINE/surfaces/$surface/settings.json"
  done
}

teardown() {
  [ -z "${CAWS_TEST_REPO:-}" ] || caws_teardown_pack
}

@test "home isolation control: the CLI rejects the inherited hostile machine settings" {
  mkdir -p "$BATS_TEST_TMPDIR/control"
  cd "$BATS_TEST_TMPDIR/control"
  git init -q -b main
  run env HOME="$HOSTILE_HOME" CAWS_HOME="$HOSTILE_MACHINE" \
    node "$CLI_DIST_ENTRY" init --agent-surface claude-code
  assert_failure 1
  assert_output --partial 'Malformed system surface settings'
}

check_fixture() {
  local surface="$1" vendor="$2" fixture_repo fixture_home
  HOME="$HOSTILE_HOME" CAWS_HOME="$HOSTILE_MACHINE" caws_install_pack_once "$surface"
  [ -x "$CAWS_TEST_HOOKS_DIR/dispatch/pre_tool_use.sh" ]
  [ -d "$CAWS_TEST_REPO/$vendor" ]
  [ -d "$CAWS_TEST_HOME" ]
  [ "$CAWS_TEST_HOME" != "$HOSTILE_HOME" ]
  fixture_repo="$CAWS_TEST_REPO"
  fixture_home="$CAWS_TEST_HOME"
  caws_teardown_pack
  [ ! -e "$fixture_repo" ]
  [ ! -e "$fixture_home" ]
  # Teardown must be idempotent and leave the caller's homes intact.
  caws_teardown_pack
  [ -d "$HOSTILE_HOME" ]
  run cat "$HOSTILE_MACHINE/surfaces/$surface/settings.json"
  assert_output '{"version":0,"enabled":true}'
}

@test "shared fixture installs and cleans up despite hostile inherited homes" {
  check_fixture claude-code .claude
}

@test "Kimi fixture installs and cleans up despite hostile inherited homes" {
  check_fixture kimi-code .kimi-code
}

@test "Qwen fixture installs and cleans up despite hostile inherited homes" {
  check_fixture qwen-code .qwen
}

@test "a failed fixture install reports failure and reclaims its temporary roots" {
  local scratch="$BATS_TEST_TMPDIR/failed-install"
  mkdir -p "$scratch"
  TMPDIR="$scratch" run caws_install_pack_once not-a-surface
  assert_failure 2
  assert_output --partial 'unknown --agent-surface "not-a-surface"'
  run find "$scratch" -mindepth 1 -print
  assert_success
  assert_output ''
}
