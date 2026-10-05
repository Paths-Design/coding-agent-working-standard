#!/usr/bin/env bats
# agent-surface.sh caws_source_lib USER tier + registry-derived vendor dir
# (CAWS-DESIGN-GLOBAL-IDENTITY-HOME-001 A3/A5).

load helpers

setup_file() {
  caws_install_pack_once
}
teardown_file() {
  caws_teardown_pack
}

SID="$CAWS_TEST_HOOKS_DIR/lib/agent-surface.sh"

@test "user tier: ~/.caws/surfaces/<surface>/lib/<name> overrides the shared fallback (A3)" {
  local fake_home
  fake_home="$(mktemp -d "${TMPDIR:-/tmp}/caws-user-tier-XXXXXX")"
  mkdir -p "$fake_home/.caws/surfaces/dsh/lib"
  printf 'user_tier_loaded=1\n' > "$fake_home/.caws/surfaces/dsh/lib/emit.sh"

  run env -i PATH="$PATH" HOME="$fake_home" CAWS_AGENT_SURFACE=dsh \
    CAWS_SHARED_LIB_DIR="$CAWS_TEST_HOOKS_DIR/lib" \
    bash -c "source '$SID' >/dev/null 2>&1; caws_source_lib emit.sh; printf '%s' \"\${user_tier_loaded:-0}\""
  assert_success
  assert_output "1"
  rm -rf "$fake_home"
}

@test "user tier: absent override -> the shared fallback loads (inert by default) (A3)" {
  local fake_home
  fake_home="$(mktemp -d "${TMPDIR:-/tmp}/caws-user-tier-XXXXXX")"

  run env -i PATH="$PATH" HOME="$fake_home" CAWS_AGENT_SURFACE=dsh \
    CAWS_SHARED_LIB_DIR="$CAWS_TEST_HOOKS_DIR/lib" \
    bash -c "source '$SID' >/dev/null 2>&1; caws_source_lib emit.sh; printf '%s' \"\${user_tier_loaded:-0}\""
  assert_success
  assert_output "0"
  rm -rf "$fake_home"
}

@test "user tier: repo vendor override beats the user tier (A3)" {
  local fake_home
  fake_home="$(mktemp -d "${TMPDIR:-/tmp}/caws-user-tier-XXXXXX")"
  mkdir -p "$fake_home/.caws/surfaces/dsh/lib"
  printf 'user_tier_loaded=1\n' > "$fake_home/.caws/surfaces/dsh/lib/emit.sh"
  mkdir -p "$CAWS_TEST_REPO/.dsh/hooks/lib"
  printf 'vendor_override_loaded=1\n' > "$CAWS_TEST_REPO/.dsh/hooks/lib/emit.sh"

  run env -i PATH="$PATH" HOME="$fake_home" CAWS_AGENT_SURFACE=dsh \
    CAWS_PROJECT_DIR="$CAWS_TEST_REPO" CAWS_VENDOR_DIR=".dsh" \
    CAWS_SHARED_LIB_DIR="$CAWS_TEST_HOOKS_DIR/lib" \
    bash -c "source '$SID' >/dev/null 2>&1; caws_source_lib emit.sh; printf '%s,%s' \"\${vendor_override_loaded:-0}\" \"\${user_tier_loaded:-0}\""
  assert_success
  assert_output "1,0"
  rm -rf "$fake_home" "$CAWS_TEST_REPO/.dsh"
}

@test "vendor dir: registry-derived for dsh (A5)" {
  run env -i PATH="$PATH" HOME="$HOME" CAWS_AGENT_SURFACE=dsh \
    CAWS_SHARED_LIB_DIR="$CAWS_TEST_HOOKS_DIR/lib" \
    bash -c "source '$SID' >/dev/null 2>&1; printf '%s' \"\$CAWS_VENDOR_DIR\""
  assert_success
  assert_output ".dsh"
}
