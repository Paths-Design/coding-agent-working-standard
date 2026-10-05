#!/usr/bin/env bats
# worktree-guard.sh — CAWS-DEFECT-CANONICAL-GUARD-NO-SANCTIONED-LOCKFILE-RESTORE-01.
#
# From the canonical checkout while a CAWS worktree is active, a path restore
# whose EVERY target is a package-manager lockfile is admitted (the package
# manager regenerates it, and no lane owns lockfile churn in canonical), and
# `git restore --staged <path>` is admitted (it only changes the index). Every
# other path restore stays refused, and its message names an alternative that
# applies (asking the user to run it), never an owning worktree.
#
# Both directions are load-bearing: admitted cases assert exit 0 AND empty
# output; refused cases assert exit 2 AND the exact label, so the lockfile
# exemption cannot widen to source, a tree-ish, a flag, or a shell sequence.

load helpers

setup_file() {
  caws_install_pack_once
  # Mutation runs apply one literal replacement to the installed guard; a FROM
  # absent from the guard fails setup so a no-op mutant cannot "survive".
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
  mkdir -p "$CAWS_TEST_REPO/web"
  printf '{}\n' >"$CAWS_TEST_REPO/package-lock.json"
  printf '{}\n' >"$CAWS_TEST_REPO/web/yarn.lock"
  printf 'source\n' >"$CAWS_TEST_REPO/tracked.txt"
  printf '{}\n' >"$CAWS_TEST_REPO/package-lock.json.bak"
  git -C "$CAWS_TEST_REPO" add package-lock.json web/yarn.lock tracked.txt package-lock.json.bak
  git -C "$CAWS_TEST_REPO" commit -q -m 'add lockfiles and a source file'
  git -C "$CAWS_TEST_REPO" branch feature-x
}
teardown_file() {
  caws_teardown_pack
}

PATH_LABEL="BLOCKED: git checkout <path> (working-tree path restore, not a branch switch) from the canonical checkout while CAWS worktrees are active."
RESTORE_LABEL="BLOCKED: git restore (working-tree/path restore) is not allowed while worktrees are active."
DISCARD_LABEL="BLOCKED: git checkout -- <path> (working-tree discard) is not allowed while worktrees are active."
APPLICABLE_ALTERNATIVE="ask the user to run"

_active_worktree() {
  printf '{"peer-wt":{"status":"active"}}\n' >"$CAWS_TEST_REPO/.caws/worktrees.json"
}

teardown() {
  rm -f "$CAWS_TEST_REPO/.caws/worktrees.json"
}

_guard() {
  run_guard worktree-guard.sh "$(hook_envelope Bash '' "$1")"
}

_assert_admitted() {
  _guard "$1"
  assert_equal "$status" 0
  assert_output ''
}

# --- A1: a lockfile-only restore is admitted ----------------------------------

@test "worktree-guard: checkout of a lockfile is admitted from canonical with lanes active" {
  _active_worktree
  _assert_admitted 'git checkout package-lock.json'
}

@test "worktree-guard: checkout -- of a lockfile is admitted from canonical with lanes active" {
  _active_worktree
  _assert_admitted 'git checkout -- package-lock.json'
}

@test "worktree-guard: git restore of a lockfile is admitted from canonical with lanes active" {
  _active_worktree
  _assert_admitted 'git restore package-lock.json'
}

@test "worktree-guard: a lockfile is matched by basename at any depth" {
  _active_worktree
  _assert_admitted 'git checkout web/yarn.lock'
  _assert_admitted 'git restore -- web/yarn.lock'
}

@test "worktree-guard: every listed lockfile name is admitted by git restore" {
  _active_worktree
  local name
  for name in package-lock.json npm-shrinkwrap.json yarn.lock pnpm-lock.yaml bun.lockb \
    Cargo.lock poetry.lock uv.lock Gemfile.lock composer.lock go.sum; do
    _assert_admitted "git restore $name"
    _assert_admitted "git restore sub/dir/$name"
  done
}

@test "worktree-guard: several lockfiles in one restore are admitted" {
  _active_worktree
  _assert_admitted 'git restore package-lock.json web/yarn.lock'
}

# --- A2: the exemption never widens beyond lockfiles --------------------------

@test "worktree-guard: checkout of a lockfile plus source is refused with the path-restore label" {
  _active_worktree
  _guard 'git checkout package-lock.json tracked.txt'
  assert_equal "$status" 2
  assert_output --partial "$PATH_LABEL"
  refute_output --partial "BLOCKED: git checkout (branch switch)"
}

@test "worktree-guard: git restore of a lockfile plus source is refused with the restore label" {
  _active_worktree
  _guard 'git restore package-lock.json tracked.txt'
  assert_equal "$status" 2
  assert_output --partial "$RESTORE_LABEL"
}

@test "worktree-guard: checkout -- of a lockfile plus source keeps the working-tree discard label" {
  _active_worktree
  _guard 'git checkout -- package-lock.json tracked.txt'
  assert_equal "$status" 2
  assert_output --partial "$DISCARD_LABEL"
}

@test "worktree-guard: a lookalike name that is not a lockfile is refused" {
  _active_worktree
  _guard 'git checkout package-lock.json.bak'
  assert_equal "$status" 2
  assert_output --partial "$PATH_LABEL"
}

@test "worktree-guard: a tree-ish plus a lockfile is refused" {
  _active_worktree
  _guard 'git checkout main package-lock.json'
  assert_equal "$status" 2
  assert_output --partial "$PATH_LABEL"
}

@test "worktree-guard: a lockfile restore from another source revision is refused" {
  _active_worktree
  _guard 'git restore --source=HEAD~1 package-lock.json'
  assert_equal "$status" 2
  assert_output --partial "$RESTORE_LABEL"
}

@test "worktree-guard: a lockfile restore chained to a refused restore is refused" {
  _active_worktree
  _guard 'git restore package-lock.json && git restore tracked.txt'
  assert_equal "$status" 2
  assert_output --partial "$RESTORE_LABEL"
}

@test "worktree-guard: a lockfile checkout chained to a branch switch is refused" {
  _active_worktree
  _guard 'git checkout package-lock.json; git checkout feature-x'
  assert_equal "$status" 2
  refute_output ''
}

@test "worktree-guard: a wildcard that could match source is refused" {
  _active_worktree
  _guard 'git restore web/*'
  assert_equal "$status" 2
  assert_output --partial "$RESTORE_LABEL"
}

# --- A3: git restore --staged is index-only and admitted ----------------------

@test "worktree-guard: git restore --staged of a source file is admitted with no discard label" {
  _active_worktree
  _assert_admitted 'git restore --staged tracked.txt'
}

@test "worktree-guard: git restore -S and --staged -- forms are admitted" {
  _active_worktree
  _assert_admitted 'git restore -S tracked.txt'
  _assert_admitted 'git restore --staged -- tracked.txt'
}

@test "worktree-guard: git restore --staged with --worktree also discards content and is refused" {
  _active_worktree
  _guard 'git restore --staged --worktree tracked.txt'
  assert_equal "$status" 2
  assert_output --partial "$RESTORE_LABEL"
}

@test "worktree-guard: git restore --staged --source from another revision is refused" {
  _active_worktree
  _guard 'git restore --staged --source=HEAD~1 tracked.txt'
  assert_equal "$status" 2
  assert_output --partial "$RESTORE_LABEL"
}

# --- A4: a remaining refusal names an alternative that applies ----------------

@test "worktree-guard: a refused source checkout asks the user rather than naming an owning worktree" {
  _active_worktree
  _guard 'git checkout tracked.txt'
  assert_equal "$status" 2
  assert_output --partial "$PATH_LABEL"
  assert_output --partial "$APPLICABLE_ALTERNATIVE"
  refute_output --partial "owning worktree"
  refute_output --partial "cd .caws/worktrees/"
}

@test "worktree-guard: a refused source restore asks the user rather than naming an owning worktree" {
  _active_worktree
  _guard 'git restore tracked.txt'
  assert_equal "$status" 2
  assert_output --partial "$RESTORE_LABEL"
  assert_output --partial "$APPLICABLE_ALTERNATIVE"
  refute_output --partial "owning worktree"
}

@test "worktree-guard: a refused source checkout -- asks the user rather than naming an owning worktree" {
  _active_worktree
  _guard 'git checkout -- tracked.txt'
  assert_equal "$status" 2
  assert_output --partial "$DISCARD_LABEL"
  assert_output --partial "$APPLICABLE_ALTERNATIVE"
  refute_output --partial "owning worktree"
}
