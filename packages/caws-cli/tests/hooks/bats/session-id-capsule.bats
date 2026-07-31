#!/usr/bin/env bats
# lib/session-id.sh — resolve_caws_session_id capsule tier
# (CAWS-SESSION-SHELL-RESOLVER-CAPSULE-001).
#
# The shell resolver was env-only and returned "unknown" in any subshell with no
# identity env var, so the write-guards treated the owner's own edits as foreign.
# It now reads the durable capsule (the TS resolver's tier-3 mirror, and the file
# caws worktree create records as owner) when the env chain misses.

load helpers

setup_file() {
  caws_install_pack_once
}
teardown_file() {
  caws_teardown_pack
}

SID="$CAWS_TEST_HOOKS_DIR/lib/session-id.sh"

# resolve with a controlled env + optional capsule.
resolve_under() {
  local caws_project_dir="$1"; shift
  run env -i PATH="$PATH" HOME="$HOME" CAWS_PROJECT_DIR="$caws_project_dir" \
    bash -c "source '$SID' >/dev/null 2>&1; printf '%s\n' \"\$(resolve_caws_session_id)\""
}

@test "session-id: no env vars + a capsule -> reads the capsule session_id (A1)" {
  # Plant a capsule (the file caws worktree create records as owner).
  local sess_dir="$CAWS_TEST_REPO/.caws/sessions"
  mkdir -p "$sess_dir"
  printf '{"session_id":"caws-cap-aaa","platform":"zcode","minted_at":"2026-07-31T00:00:00Z","worktree_root":"%s"}\n' "$CAWS_TEST_REPO" \
    > "$sess_dir/caws-cap-aaa.json"

  resolve_under "$CAWS_TEST_REPO"
  assert_success
  assert_output "caws-cap-aaa"
}

@test "session-id: an env identity var wins over the capsule (A2, precedence)" {
  local sess_dir="$CAWS_TEST_REPO/.caws/sessions"
  mkdir -p "$sess_dir"
  printf '{"session_id":"caws-cap-bbb","platform":"zcode","minted_at":"2026-07-31T00:00:00Z","worktree_root":"%s"}\n' "$CAWS_TEST_REPO" \
    > "$sess_dir/caws-cap-bbb.json"

  run env -i PATH="$PATH" HOME="$HOME" CAWS_PROJECT_DIR="$CAWS_TEST_REPO" CLAUDE_SESSION_ID=env-wins \
    bash -c "source '$SID' >/dev/null 2>&1; printf '%s\n' \"\$(resolve_caws_session_id)\""
  assert_success
  assert_output "env-wins"
}

@test "session-id: no env vars + no capsule -> unknown (A3, fail-open)" {
  # Use a repo with an empty sessions dir (no capsule).
  local empty_repo
  empty_repo="$(mktemp -d "${TMPDIR:-/tmp}/caws-nocap-XXXXXX")"
  mkdir -p "$empty_repo/.caws/sessions"

  resolve_under "$empty_repo"
  assert_success
  assert_output "unknown"
  rm -rf "$empty_repo"
}

@test "session-id: a malformed capsule is skipped, not fatal (fail-open)" {
  # Isolated repo: ONLY a malformed capsule, no valid one (other tests plant
  # valid capsules in the shared CAWS_TEST_REPO, which would be picked first).
  local mal_repo
  mal_repo="$(mktemp -d "${TMPDIR:-/tmp}/caws-malcap-XXXXXX")"
  mkdir -p "$mal_repo/.caws/sessions"
  printf 'not json at all\n' > "$mal_repo/.caws/sessions/caws-malformed.json"

  resolve_under "$mal_repo"
  assert_success
  # No valid capsule -> unknown (malformed skipped, not crashed).
  assert_output "unknown"
  rm -rf "$mal_repo"
}
