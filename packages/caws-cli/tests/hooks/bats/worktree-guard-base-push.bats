#!/usr/bin/env bats
# worktree-guard.sh — CAWS-WORKTREE-GUARD-BASE-PUSH-RETIRE-001.
#
# An ordinary `git push` from the base branch while worktrees are active used
# to be refused unconditionally, inherited unreviewed from a 2026-06-13 bulk
# hook migration with no incident or rationale attached. Publishing
# already-merged commits rewrites no history and races no sibling's index, so
# it carries none of the isolation risk that justifies the OTHER guards in
# this file (force-push, reset --hard, stash, etc). This pins two behaviors
# together so a future edit cannot regress one while "fixing" the other:
#   1. a plain `git push` from the base branch is now ADMITTED even while a
#      worktree is active.
#   2. `git push --force` / `-f` from the base branch is STILL refused — that
#      guard is a separate, unconditional check earlier in the file and this
#      slice must not touch it.

load helpers

setup_file() {
  caws_install_pack_once
}
teardown_file() {
  caws_teardown_pack
}

GUARD() { echo "$CAWS_TEST_HOOKS_DIR/worktree-guard.sh"; }

# Marks WORKTREES_ACTIVE=true and BASE_BRANCH=main via the parallel.json path
# (the guard consults this before ever looking at worktrees.json), so the
# "Base branch protections" section is reached without standing up a full
# worktree registry. The freshly-installed test repo's default branch is
# "main" (helpers.bash: `git init -q -b main`), matching CURRENT_BRANCH.
_mark_worktrees_active_on_main() {
  printf '{"agents":["fake-peer"],"baseBranch":"main"}\n' > "$CAWS_TEST_REPO/.caws/parallel.json"
}

teardown() {
  rm -f "$CAWS_TEST_REPO/.caws/parallel.json"
}

@test "wt-guard: plain 'git push' from the base branch is ADMITTED while a worktree is active" {
  _mark_worktrees_active_on_main
  run_guard worktree-guard.sh "$(hook_envelope Bash '' 'git push origin main')"
  assert_success
  refute_output --partial "BLOCKED: Pushing from the base branch"
}

@test "wt-guard: 'git push' with no remote/branch args from the base branch is ADMITTED" {
  _mark_worktrees_active_on_main
  run_guard worktree-guard.sh "$(hook_envelope Bash '' 'git push')"
  assert_success
  refute_output --partial "BLOCKED: Pushing from the base branch"
}

@test "wt-guard: 'git push --force' from the base branch is STILL BLOCKED" {
  _mark_worktrees_active_on_main
  run_guard worktree-guard.sh "$(hook_envelope Bash '' 'git push --force origin main')"
  assert_equal "$status" 2
  assert_output --partial "BLOCKED: Force push is not allowed"
}

@test "wt-guard: 'git push -f' from the base branch is STILL BLOCKED" {
  _mark_worktrees_active_on_main
  run_guard worktree-guard.sh "$(hook_envelope Bash '' 'git push -f origin main')"
  assert_equal "$status" 2
  assert_output --partial "BLOCKED: Force push is not allowed"
}
