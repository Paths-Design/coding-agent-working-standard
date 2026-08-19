#!/usr/bin/env bats
# lib/agent-surface.sh — CAWS_PROJECT_DIR root resolution
# (HOOK-PROJECT-DIR-ROOT-NOT-CWD-01).
#
# Some harnesses (zcode) inject the session CWD as CLAUDE_PROJECT_DIR rather
# than the repo root; when that CWD is a package-bearing subdirectory, the old
# verbatim adoption made CAWS_PROJECT_DIR the subdir and fragmented every
# derived path (CAWS_LOG_DIR, heartbeat lease cache, audit log) into a stray
# <subdir>/.caws or <subdir>/.zcode. The resolver now normalizes each vendor
# *_PROJECT_DIR candidate to its git repo root via `git rev-parse
# --show-toplevel` before adopting it — the same invariant the codex dispatcher
# already binds (hook-install.ts codexCommand: CAWS_PROJECT_DIR=$REPO_ROOT).
#
# These tests source the INSTALLED lib (the copy `caws init` stamps from the
# built dist) so they exercise the pack the consumer actually runs, and assert
# CAWS_PROJECT_DIR after resolution. The temp repo (CAWS_TEST_REPO) is itself a
# git repo, so show-toplevel resolves to it.

load helpers

setup_file() {
  caws_install_pack_once
}
teardown_file() {
  caws_teardown_pack
}

AS_LIB="$CAWS_TEST_HOOKS_DIR/lib/agent-surface.sh"

# git rev-parse --show-toplevel returns the realpath-resolved root (on macOS
# this resolves /tmp -> /private/tmp). Normalize the expected repo root the
# same way so assertions compare canonical-to-canonical, not symlink-text.
CAWS_TEST_REPO_REAL="$(cd "$CAWS_TEST_REPO" && git rev-parse --show-toplevel)"

# The inline node-ish script run under bash -c. Sourcing the lib prints
# CAWS_PROJECT_DIR on stdout. Kept as a single literal so it survives the
# env/bash word-splitting boundary intact (the run_guard pattern).
RESOLVE_CMD="source '$AS_LIB' >/dev/null 2>&1; printf '%s\n' \"\${CAWS_PROJECT_DIR:-}\""

@test "agent-surface: CLAUDE_PROJECT_DIR at a subdir resolves to the repo root (A1, zcode scenario)" {
  local subdir="$CAWS_TEST_REPO/packages/caws-cli/templates"
  mkdir -p "$subdir"
  run env -i \
    PATH="$PATH" \
    CAWS_AGENT_SURFACE="claude-code" \
    CLAUDE_PROJECT_DIR="$subdir" \
    bash -c "$RESOLVE_CMD"
  assert_success
  assert_output "$CAWS_TEST_REPO_REAL"
  refute_output --partial '/templates'
}

@test "agent-surface: CODEX_PROJECT_DIR at a subdir resolves to the repo root (A2)" {
  local subdir="$CAWS_TEST_REPO/packages/caws-cli/src"
  mkdir -p "$subdir"
  run env -i \
    PATH="$PATH" \
    CAWS_AGENT_SURFACE="claude-code" \
    CODEX_PROJECT_DIR="$subdir" \
    bash -c "$RESOLVE_CMD"
  assert_success
  assert_output "$CAWS_TEST_REPO_REAL"
  refute_output --partial '/src'
}

@test "agent-surface: vendor dir already at the root is unchanged — idempotent, no regression (A3)" {
  # Claude Code / Codex inject the root itself; show-toplevel of the root is
  # the root, so resolution must be a no-op.
  run env -i \
    PATH="$PATH" \
    CAWS_AGENT_SURFACE="claude-code" \
    CLAUDE_PROJECT_DIR="$CAWS_TEST_REPO" \
    bash -c "$RESOLVE_CMD"
  assert_success
  assert_output "$CAWS_TEST_REPO_REAL"
}

@test "agent-surface: a pre-set CAWS_PROJECT_DIR is respected, not overridden (A4)" {
  # The codex dispatcher already binds CAWS_PROJECT_DIR=$REPO_ROOT; that must
  # win and the vendor chain must never be consulted. Even though the vendor
  # dir here points at a subdir, the pre-set value is what we expect back.
  run env -i \
    PATH="$PATH" \
    CAWS_AGENT_SURFACE="claude-code" \
    CAWS_PROJECT_DIR="$CAWS_TEST_REPO" \
    CLAUDE_PROJECT_DIR="$CAWS_TEST_REPO/packages/caws-cli/templates" \
    bash -c "$RESOLVE_CMD"
  assert_success
  assert_output "$CAWS_TEST_REPO"
}

@test "agent-surface: no vendor dir set falls back to '.' (last resort, unchanged)" {
  run env -i \
    PATH="$PATH" \
    CAWS_AGENT_SURFACE="claude-code" \
    bash -c "$RESOLVE_CMD"
  assert_success
  assert_output "."
}

@test "agent-surface: a vendor dir outside any repo is kept verbatim (fail-open, not downgraded to '.')" {
  # git-absent / not-a-repo must keep the raw candidate rather than collapse to
  # ".", so a real vendor signal is never silently lost.
  local outside
  outside="$(mktemp -d "${TMPDIR:-/tmp}/caws-norepo-XXXXXX")"
  run env -i \
    PATH="$PATH" \
    CAWS_AGENT_SURFACE="claude-code" \
    CLAUDE_PROJECT_DIR="$outside" \
    bash -c "$RESOLVE_CMD"
  assert_success
  assert_output "$outside"
  rm -rf "$outside"
}

# ─── caws_run_cli (CAWS-HOOKS-CLI-CWD-LEAK-001) ────────────────────────────
#
# A hook that shells out to `"$CAWS_BIN" <cmd>` directly inherits whatever cwd
# the calling process happens to have — invisible in ordinary harness use
# (PWD naturally sits inside the repo the harness drives), but wrong the
# moment CAWS_PROJECT_DIR names a DIFFERENT directory than the inherited cwd,
# which is exactly what happened here: agent-heartbeat.sh/-register.sh/-stop.sh
# registered real leases/session records against whatever repo the bats
# process's true cwd sat in, not the isolated fixture. caws_run_cli fixes this
# by `cd`-ing into CAWS_PROJECT_DIR before invoking the binary.
#
# A fake CAWS_BIN that just records its cwd — proves the mechanism directly,
# independent of the real CLI's own behavior.
FAKE_CAWS_BIN_SRC='#!/bin/bash
pwd > "$CAPTURE_FILE"'

@test "agent-surface: caws_run_cli invokes the binary from CAWS_PROJECT_DIR, not the inherited cwd" {
  local fake_bin="$BATS_TEST_TMPDIR/fake-caws"
  printf '%s\n' "$FAKE_CAWS_BIN_SRC" >"$fake_bin"
  chmod +x "$fake_bin"

  local capture="$BATS_TEST_TMPDIR/captured-pwd"
  local inherited_cwd="$BATS_TEST_TMPDIR/inherited"
  mkdir -p "$inherited_cwd"

  # CAWS_TEST_REPO stands in for CAWS_PROJECT_DIR, deliberately DIFFERENT
  # from the process's real cwd (inherited_cwd) — the exact leak scenario.
  run env -i \
    PATH="$PATH" \
    CAWS_BIN="$fake_bin" \
    CAWS_PROJECT_DIR="$CAWS_TEST_REPO" \
    CAPTURE_FILE="$capture" \
    bash -c 'cd "$1" && source "$2/lib/agent-surface.sh" >/dev/null 2>&1 && caws_run_cli whatever-args' \
    _ "$inherited_cwd" "$CAWS_TEST_HOOKS_DIR"
  assert_success
  # Normalize CAWS_TEST_REPO the SAME way the fake binary computes its own
  # answer (plain `cd && pwd`, no -P): CAWS_TEST_REPO itself carries a
  # double slash (mktemp concatenates a trailing-slash $TMPDIR verbatim) and
  # is not realpath-resolved, so comparing against it — or against the
  # realpath-resolved CAWS_TEST_REPO_REAL — both spuriously mismatch a
  # correct cd on pure string spelling, not on actual directory identity.
  local expected
  expected="$(cd "$CAWS_TEST_REPO" && pwd)"
  [ "$(cat "$capture")" = "$expected" ]
}

@test "agent-surface: caws_run_cli falls open to the plain invocation when CAWS_PROJECT_DIR is unset" {
  local fake_bin="$BATS_TEST_TMPDIR/fake-caws"
  printf '%s\n' "$FAKE_CAWS_BIN_SRC" >"$fake_bin"
  chmod +x "$fake_bin"

  local capture="$BATS_TEST_TMPDIR/captured-pwd"
  local inherited_cwd="$BATS_TEST_TMPDIR/inherited"
  mkdir -p "$inherited_cwd"
  local inherited_real
  inherited_real="$(cd "$inherited_cwd" && pwd)"

  run env -i \
    PATH="$PATH" \
    CAWS_BIN="$fake_bin" \
    CAPTURE_FILE="$capture" \
    bash -c 'cd "$1" && source "$2/lib/agent-surface.sh" >/dev/null 2>&1 && caws_run_cli whatever-args' \
    _ "$inherited_cwd" "$CAWS_TEST_HOOKS_DIR"
  assert_success
  # agent-surface.sh's own resolution falls CAWS_PROJECT_DIR back to "." when
  # unset (§1 above), so caws_run_cli's "." branch is what fires here.
  [ "$(cat "$capture")" = "$inherited_real" ]
}
