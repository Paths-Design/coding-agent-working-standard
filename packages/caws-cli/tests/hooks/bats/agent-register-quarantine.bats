#!/usr/bin/env bats
# agent-register.sh — SessionStart quarantine read
# (DANGER-LATCH-QUARANTINE-TRAP-001, A9).
#
# A session id whose danger-latch sentinel still exists is QUARANTINED. The
# SessionStart hook READS that state and reports it as additionalContext so a
# restarted trapped session learns its status before burning a command. It
# never blocks and never kills (a kill at start would loop with any
# auto-restarting harness); the trap re-engages in block-dangerous.sh on the
# first non-read-only Bash attempt.

load helpers

setup_file() {
  caws_install_pack_once
  # Pristine copy of the installed project pack. The drift tests edit a stock
  # handler to prove drift is detected, and the fixture is installed ONCE for the
  # whole file — without this, a later test would inherit the earlier test's edit
  # and see drift it never created.
  # Exported on purpose: bats runs setup_file in a separate process, so an
  # unexported variable never reaches the tests or the teardown hook.
  export CAWS_PRISTINE_HOOKS="$CAWS_TEST_HOME/pristine-hooks"
  cp -R "$CAWS_TEST_HOOKS_DIR" "$CAWS_PRISTINE_HOOKS"
}
teardown_file() {
  caws_teardown_pack
}

_register_envelope() {
  jq -nc --arg s "$1" '{session_id:$s}'
}

_run_register() {
  local sid="$1"
  # The envelope JSON carries double quotes, so it must ride inside SINGLE
  # quotes in the bash -c string (double quotes mangle it into invalid JSON —
  # the same class _cmd_envelope_sid documents in block-dangerous.bats).
  # CAWS_HOME is pinned to the isolated fixture home: caws_install_pack_once
  # exports it only inside a command substitution, so without this the pack-drift
  # check would read the real machine runtime pointer.
  run env \
    CAWS_PROJECT_DIR="$CAWS_TEST_REPO" \
    CAWS_AGENT_SURFACE="claude-code" \
    CAWS_HOME="$CAWS_TEST_HOME/.caws" \
    HOOK_CWD="$CAWS_TEST_REPO" \
    bash -c "printf '%s' '$(_register_envelope "$sid")' | bash '$CAWS_TEST_HOOKS_DIR/agent-register.sh'"
}

# ── Pack-drift advisory (HOOKPACK-STALENESS-VISIBILITY-001) ─────────────────
# Build a REAL machine runtime for the fixture home with the same installer a
# user runs, from the same templates the project pack was installed from.
#
# This is load-bearing, not convenience. A hand-built fixture that hashes the
# installed files to synthesize the "expected" manifest makes the comparison
# tautological: the installer stamps `hook_pack_version: <cli-version>` into the
# project copy while the runtime snapshot keeps the template literal, so EVERY
# stock file differs by that one line, and only a fixture that goes through the
# real installer can observe it. An earlier hand-built version of this fixture
# hid exactly that defect and the shipped comparison reported the whole pack as
# drift on a clean install.
_install_runtime_fixture() {
  run env \
    HOME="$CAWS_TEST_HOME" \
    CAWS_HOME="$CAWS_TEST_HOME/.caws" \
    node "$CLI_DIST_ENTRY" init adapters install
  assert_success
}

_clear_runtime_fixture() {
  rm -rf "$CAWS_TEST_HOME/.caws/state/adapter-runtime.json" "$CAWS_TEST_HOME/.caws/lib/runtimes"
}

# Every drift test installs machine-home state; clear it so the "no pointer" case
# cannot inherit a previous test's fixture (all tests share one CAWS_TEST_HOME),
# and restore the project pack so an edited stock handler cannot leak forward.
teardown() {
  _clear_runtime_fixture
  if [[ -n "${CAWS_PRISTINE_HOOKS:-}" && -d "$CAWS_PRISTINE_HOOKS" ]]; then
    cp -R "$CAWS_PRISTINE_HOOKS/." "$CAWS_TEST_HOOKS_DIR/"
  fi
}

@test "quarantine read: a trapped session id is told it is TRAPPED at session start (A9)" {
  local sid="quar-a9-$$"
  local state_dir="$CAWS_TEST_REPO/.claude/hooks/state"
  mkdir -p "$state_dir"
  printf '{"reason":"probe"}' > "$state_dir/danger-latch-${sid}.json"
  _run_register "$sid"
  assert_success
  assert_output --partial 'QUARANTINE'
  assert_output --partial "$sid"
  assert_output --partial 'read-only'
  rm -f "$state_dir/danger-latch-${sid}.json"
}

@test "quarantine read: a session with no sentinel gets NO quarantine notice (A9 negative)" {
  local sid="quar-none-$$"
  _run_register "$sid"
  assert_success
  refute_output --partial 'QUARANTINE'
}

@test "quarantine read: never blocks even when the sentinel is malformed (fail-open advisory)" {
  local sid="quar-bad-$$"
  local state_dir="$CAWS_TEST_REPO/.claude/hooks/state"
  mkdir -p "$state_dir"
  printf 'not-json' > "$state_dir/danger-latch-${sid}.json"
  _run_register "$sid"
  assert_success
  rm -f "$state_dir/danger-latch-${sid}.json"
}

@test "pack drift: a repo-local edit to a stock handler is named, and the count is exact (A1)" {
  local sid="drift-a1-$$"
  _install_runtime_fixture
  printf '\n# repo-local edit\n' >> "$CAWS_TEST_HOOKS_DIR/block-dangerous.sh"
  _run_register "$sid"
  assert_success
  assert_output --partial 'pack drift: 1 installed stock hook file(s)'
  assert_output --partial 'block-dangerous.sh'
}

@test "pack drift: a clean install of the pinned runtime reports NO drift (A2)" {
  local sid="drift-a2-$$"
  _install_runtime_fixture
  _run_register "$sid"
  assert_success
  refute_output --partial 'pack drift'
}

@test "pack drift: no advisory and exit 0 with no readable runtime pointer (A3)" {
  local sid="drift-a3-$$"
  _clear_runtime_fixture
  _run_register "$sid"
  assert_success
  refute_output --partial 'pack drift'
}

@test "pack drift: CAWS_PACK_STALENESS_CHECK=0 silences a real drift (A4)" {
  local sid="drift-a4-$$"
  _install_runtime_fixture
  printf '\n# repo-local edit\n' >> "$CAWS_TEST_HOOKS_DIR/block-dangerous.sh"
  run env \
    CAWS_PROJECT_DIR="$CAWS_TEST_REPO" \
    CAWS_AGENT_SURFACE="claude-code" \
    CAWS_HOME="$CAWS_TEST_HOME/.caws" \
    CAWS_PACK_STALENESS_CHECK="0" \
    HOOK_CWD="$CAWS_TEST_REPO" \
    bash -c "printf '%s' '$(_register_envelope "$sid")' | bash '$CAWS_TEST_HOOKS_DIR/agent-register.sh'"
  assert_success
  refute_output --partial 'pack drift'
}
