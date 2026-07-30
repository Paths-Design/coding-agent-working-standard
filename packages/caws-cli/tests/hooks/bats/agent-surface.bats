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
