#!/usr/bin/env bats
# reset-danger-latch.sh — multi-vendor state-dir search
# (CAWS-RESET-LATCH-MULTIVENDOR-001).
#
# The danger latch is written by block-dangerous.sh under the WRITER's vendor
# dir (the active harness bridge sets CAWS_AGENT_SURFACE, e.g. zcode ->
# .zcode/hooks/state/). The reset is run by a human from a plain shell where
# CAWS_AGENT_SURFACE is unset, so agent-surface.sh defaults to claude-code ->
# .claude/. Before this fix the reset searched ONLY its own (defaulted) vendor
# dir, so in a multi-surface repo it reported "nothing to clear" while the latch
# stayed armed under .zcode/ — wedging the agent with no working recovery. The
# reset now enumerates every present vendor state dir and searches the union.
#
# These tests run the INSTALLED reset script from inside the temp test repo
# (so SCRIPT_DIR/../.. resolves to the repo root) with CAWS_AGENT_SURFACE unset
# (the human-shell default), planting latches under .zcode/ (the non-default
# writer surface) and asserting the reset reaches across the vendor boundary.

load helpers

setup_file() {
  caws_install_pack_once
}
teardown_file() {
  caws_teardown_pack
}

RESET="$CAWS_TEST_HOOKS_DIR/reset-danger-latch.sh"

# Plant a latch under a given vendor dir.
plant_latch() {
  local vendor="$1" sid="$2"
  local dir="$CAWS_TEST_REPO/$vendor/hooks/state"
  mkdir -p "$dir"
  printf '{"ts":"2026-07-30T00:00:00Z","hook":"block-dangerous.sh","decision":"deny","reason":"fixture"}\n' \
    > "$dir/danger-latch-${sid}.json"
}

# Count remaining latch files across all vendor dirs.
latch_count() {
  find "$CAWS_TEST_REPO" -path '*/hooks/state/danger-latch-*.json' 2>/dev/null | wc -l | tr -d ' '
}

# Run the reset from inside the test repo, as a human would (no surface env).
run_reset() {
  run env -i \
    PATH="$PATH" \
    HOME="$HOME" \
    bash -c "cd '$CAWS_TEST_REPO' && bash '$RESET' $*"
}

@test "reset: --session clears a latch under a non-default vendor dir (.zcode) from a claude-code-defaulting shell (A1)" {
  plant_latch ".zcode" "sess-A1"
  [ "$(latch_count)" = "1" ]

  run_reset --session sess-A1 --reason "test"
  assert_success
  # The latch is gone.
  [ "$(latch_count)" = "0" ]
}

@test "reset: --current one-latch fallback finds a latch under .zcode across the vendor boundary (A2)" {
  # --current with no session id in env resolves to "unknown"; the one-latch
  # fallback must now span every vendor dir, not just the resolved default.
  plant_latch ".zcode" "sess-A2"
  [ "$(latch_count)" = "1" ]

  run_reset --current --reason "test"
  assert_success
  assert_output --partial "exactly one latch exists — clearing it"
  [ "$(latch_count)" = "0" ]
}

@test "reset: --all sweeps BOTH .claude and .zcode vendor dirs (A3)" {
  plant_latch ".claude" "sess-A3c"
  plant_latch ".zcode" "sess-A3z"
  [ "$(latch_count)" = "2" ]

  run_reset --all --reason "test"
  assert_success
  [ "$(latch_count)" = "0" ]
}

@test "reset: --current with 2 latches across vendors REFUSES to guess and lists them (A4)" {
  plant_latch ".claude" "sess-A4c"
  plant_latch ".zcode" "sess-A4z"
  [ "$(latch_count)" = "2" ]

  run_reset --current --reason "test"
  # Non-zero exit (refused — does not clear).
  [ "$status" -ne 0 ]
  assert_output --partial "cannot"
  assert_output --partial "disambiguate"
  # Neither latch was cleared.
  [ "$(latch_count)" = "2" ]
}

@test "reset: --session with no matching latch reports the searched vendor dirs (not just the default)" {
  run_reset --session sess-NOSUCH --reason "test"
  assert_success
  # The no-match message now lists EVERY searched vendor dir (multi-vendor),
  # proving the search spanned beyond the claude-code default — including the
  # writer's surface (.zcode), so an operator can see the right tree was tried.
  assert_output --partial "No active latch or warn marker"
  assert_output --partial "searched vendor state dirs"
  assert_output --partial ".zcode/hooks/state"
}

@test "reset: --session clears a latch at the CANONICAL root when run from a linked worktree (A2, CAWS-LATCH-CANONICAL-STATE-DIR-001)" {
  # The latch writer (block-dangerous.sh) lands files at <git-root>/<surface>/
  # hooks/state (CAWS_PROJECT_DIR is git-root-normalized). The clearer used to
  # anchor at its INSTALL root (SCRIPT_DIR/../..), which is a worktree path when
  # the reset runs from a linked worktree — diverging from the writer's root and
  # missing the latch. The clearer now anchors at the canonical root.
  #
  # Here: the temp repo IS the canonical root. Plant a latch under it, then run
  # the reset from a subdir, and assert the latch is still found via the
  # canonical root. Asserts ONLY our latch (prior tests may leave residue).
  plant_latch ".zcode" "sess-A2canon"
  local before
  before=$(find "$CAWS_TEST_REPO" -path '*/hooks/state/danger-latch-sess-A2canon.json' 2>/dev/null | wc -l | tr -d ' ')
  [ "$before" = "1" ]

  mkdir -p "$CAWS_TEST_REPO/.caws/worktrees/fake-wt"
  run env -i PATH="$PATH" HOME="$HOME" bash -c "cd '$CAWS_TEST_REPO/.caws/worktrees/fake-wt' && bash '$RESET' --session sess-A2canon --reason test"
  assert_success
  local after
  after=$(find "$CAWS_TEST_REPO" -path '*/hooks/state/danger-latch-sess-A2canon.json' 2>/dev/null | wc -l | tr -d ' ')
  [ "$after" = "0" ]
}

# --- DANGER-LATCH-QUARANTINE-TRAP-001: the reset fails closed ----------------
#
# The reset is the ONLY human release from the trap (and from the kill path
# behind it), so "reports success while doing nothing" is unacceptable here:
# a snapshot invoked without its env prefix, or any invocation that locates
# ZERO vendor state dirs, must exit non-zero with the corrected command.

@test "reset fail-closed: a machine snapshot invoked WITHOUT the env prefix exits 2 with the corrected command (A10)" {
  local tmp snap
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/caws-reset-snap-XXXXXX")"
  # The snapshot discriminator is the install PATH SHAPE
  # (<home>/lib/runtimes/<digest>) plus the manifest.json belt.
  snap="$tmp/lib/runtimes/db759a4ccb13108d81082cc8a64aa0172f32af5ebb9d90e21a7ae29ed321fc00"
  mkdir -p "$snap"
  cp "$CAWS_TEST_HOOKS_DIR/reset-danger-latch.sh" "$snap/"
  # lib/ must ride along: a standalone copy dies at `source lib/agent-surface.sh`
  # under set -e before reaching any logic (CAWS-HOOK-SOURCE-GUARD-FAIL-SOFT-001).
  cp -R "$CAWS_TEST_HOOKS_DIR/lib" "$snap/lib"
  # manifest.json sibling is the structural snapshot belt.
  touch "$snap/manifest.json"
  # Neutral non-repo cwd keeps agent-surface's git-walk from resolving the
  # bats checkout as the project.
  run bash -c "cd '$snap' && bash '$snap/reset-danger-latch.sh' --session probe-snap --reason test"
  [ "$status" -eq 2 ]
  assert_output --partial 'machine-runtime snapshot'
  assert_output --partial 'CAWS_MACHINE_RUNTIME=1'
  assert_output --partial 'CAWS_PROJECT_DIR'
  rm -rf "$tmp"
}

@test "reset fail-closed: zero vendor state dirs searched exits 2, never success-by-absence (A10)" {
  local lone
  lone="$(mktemp -d "${TMPDIR:-/tmp}/caws-reset-lone-XXXXXX")"
  cp "$CAWS_TEST_HOOKS_DIR/reset-danger-latch.sh" "$lone/"
  cp -R "$CAWS_TEST_HOOKS_DIR/lib" "$lone/lib"
  # No manifest marker; the install root derives to a tree with no vendor
  # state dirs — the reset located NOTHING it could search.
  run bash -c "cd '$lone' && bash '$lone/reset-danger-latch.sh' --session probe-zero --reason test"
  [ "$status" -eq 2 ]
  assert_output --partial 'ZERO vendor state dirs'
  assert_output --partial 'success-by-absence'
}
