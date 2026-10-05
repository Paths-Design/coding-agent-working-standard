#!/usr/bin/env bats
# worktree-guard.sh — CAWS-WORKTREE-GUARD-CHECKOUT-PATHSPEC-MISCLASSIFY-001.
#
# From the canonical checkout while a CAWS worktree is active, every
# `git checkout <non-flag arg>` is refused. The guard used to call all of them
# "git checkout (branch switch)", so restoring a churned lockfile
# (`git checkout package-lock.json`) was reported as a branch switch, naming a
# hazard that was not in play. The refusal stays (a path restore overwrites
# uncommitted work, the same hazard class as `checkout -- <path>`); only the
# label is corrected. The refused tracked file here is a source file: a
# package-manager lockfile is admitted (worktree-guard-lockfile-restore.bats), and a real ref is still labeled a branch switch.
#
# Both directions are load-bearing: the path cases assert the path-restore label
# AND the absence of the branch-switch label; the ref cases assert the inverse;
# the branch-creation and no-worktree cases are positive controls proving the
# guard still admits what it should.

load helpers

setup_file() {
  caws_install_pack_once
  # Mutation runs apply one literal replacement to the installed guard. A FROM
  # absent from the guard fails setup, so a mutant that changes nothing cannot
  # "survive". The splice is prefix + TO + suffix: bash 3.2 keeps the quotes of
  # a quoted replacement inside ${body/from/to}.
  if [[ -n "${WORKTREE_GUARD_MUTATE_FROM:-}" ]]; then
    local guard="$CAWS_TEST_HOOKS_DIR/worktree-guard.sh" body from
    from="$WORKTREE_GUARD_MUTATE_FROM"
    body="$(cat "$guard")"
    [[ "$body" == *"$from"* ]] || {
      echo "mutation FROM not found in $guard" >&2
      return 1
    }
    printf '%s%s%s\n' "${body%%"$from"*}" "${WORKTREE_GUARD_MUTATE_TO:-}" "${body#*"$from"}" >"$guard"
  fi
  git -C "$CAWS_TEST_REPO" config commit.gpgsign false
  printf '{}\n' >"$CAWS_TEST_REPO/package-lock.json"
  printf 'source\n' >"$CAWS_TEST_REPO/tracked.txt"
  git -C "$CAWS_TEST_REPO" add package-lock.json tracked.txt
  git -C "$CAWS_TEST_REPO" commit -q -m 'add lockfile and tracked file'
  git -C "$CAWS_TEST_REPO" branch feature-x
  git -C "$CAWS_TEST_REPO" update-ref refs/remotes/origin/remote-only HEAD
  printf 'scratch\n' >"$CAWS_TEST_REPO/scratch.txt"
  printf 'x\n' >"$CAWS_TEST_REPO/gone.txt"
  git -C "$CAWS_TEST_REPO" add gone.txt
  git -C "$CAWS_TEST_REPO" commit -q -m 'add gone'
  rm -f "$CAWS_TEST_REPO/gone.txt"
  printf 'y\n' >"$CAWS_TEST_REPO/collide.txt"
  git -C "$CAWS_TEST_REPO" branch collide.txt
}
teardown_file() {
  caws_teardown_pack
}

PATH_LABEL="BLOCKED: git checkout <path> (working-tree path restore, not a branch switch) from the canonical checkout while CAWS worktrees are active."
REF_LABEL="BLOCKED: git checkout (branch switch) from the canonical checkout while CAWS worktrees are active."
DISCARD_LABEL="BLOCKED: git checkout -- <path> (working-tree discard) is not allowed while worktrees are active."

_active_worktree() {
  printf '{"peer-wt":{"status":"active"}}\n' >"$CAWS_TEST_REPO/.caws/worktrees.json"
}

teardown() {
  rm -f "$CAWS_TEST_REPO/.caws/worktrees.json"
}

_checkout() {
  run_guard worktree-guard.sh "$(hook_envelope Bash '' "$1")"
}

# --- a path restore is not a branch switch -----------------------------------

@test "worktree-guard: checkout of a tracked file is refused as a path restore, not a branch switch" {
  _active_worktree
  _checkout 'git checkout tracked.txt'
  assert_equal "$status" 2
  assert_output --partial "$PATH_LABEL"
  assert_output --partial "overwrites uncommitted changes to the named path(s)"
  refute_output --partial "git checkout (branch switch)"
}

@test "worktree-guard: checkout of an untracked existing file is refused as a path restore" {
  _active_worktree
  _checkout 'git checkout scratch.txt'
  assert_equal "$status" 2
  assert_output --partial "$PATH_LABEL"
  refute_output --partial "git checkout (branch switch)"
}

@test "worktree-guard: checkout of a tracked file deleted from the working tree is a path restore" {
  _active_worktree
  _checkout 'git checkout gone.txt'
  assert_equal "$status" 2
  assert_output --partial "$PATH_LABEL"
  refute_output --partial "git checkout (branch switch)"
}

@test "worktree-guard: checkout of a tree-ish plus a path is refused as a path restore" {
  _active_worktree
  _checkout 'git checkout main tracked.txt'
  assert_equal "$status" 2
  assert_output --partial "$PATH_LABEL"
  refute_output --partial "git checkout (branch switch)"
}

@test "worktree-guard: the explicit double-dash form keeps its working-tree discard label" {
  _active_worktree
  _checkout 'git checkout -- tracked.txt'
  assert_equal "$status" 2
  assert_output --partial "$DISCARD_LABEL"
  refute_output --partial "git checkout (branch switch)"
  refute_output --partial "path restore"
}

# --- a real ref is still a branch switch -------------------------------------

@test "worktree-guard: checkout of the base branch is refused as a branch switch" {
  _active_worktree
  _checkout 'git checkout main'
  assert_equal "$status" 2
  assert_output --partial "$REF_LABEL"
  refute_output --partial "path restore"
}

@test "worktree-guard: checkout of another local branch is refused as a branch switch" {
  _active_worktree
  _checkout 'git checkout feature-x'
  assert_equal "$status" 2
  assert_output --partial "$REF_LABEL"
  refute_output --partial "path restore"
}

@test "worktree-guard: a name that is both a branch and an existing file resolves as the branch, as git does" {
  _active_worktree
  _checkout 'git checkout collide.txt'
  assert_equal "$status" 2
  assert_output --partial "$REF_LABEL"
  refute_output --partial "path restore"
}

@test "worktree-guard: checkout of a name only a remote-tracking branch has is a branch switch" {
  _active_worktree
  _checkout 'git checkout remote-only'
  assert_equal "$status" 2
  assert_output --partial "$REF_LABEL"
  refute_output --partial "path restore"
}

@test "worktree-guard: checkout of a name that is neither a ref nor a path stays labeled a branch switch" {
  _active_worktree
  _checkout 'git checkout no-such-thing'
  assert_equal "$status" 2
  assert_output --partial "$REF_LABEL"
  refute_output --partial "path restore"
}

# --- admitted forms (positive controls) --------------------------------------

@test "worktree-guard: branch creation with -b is admitted with no output" {
  _active_worktree
  _checkout 'git checkout -b new-branch'
  assert_success
  assert_output ''
}

@test "worktree-guard: branch creation with -B is admitted with no output" {
  _active_worktree
  _checkout 'git checkout -B new-branch'
  assert_success
  assert_output ''
}

@test "worktree-guard: without an active worktree a checkout of a ref is admitted by this guard" {
  _checkout 'git checkout main'
  assert_success
  assert_output ''
}

@test "worktree-guard: without an active worktree a path checkout is admitted by this guard" {
  _checkout 'git checkout package-lock.json'
  assert_success
  assert_output ''
}
