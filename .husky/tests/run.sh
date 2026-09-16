#!/bin/bash
# Tests for the repo-local git hooks. Run: npm run test:hooks
#
# These run against the CURRENT repository on purpose. They never call `git
# init` and never create a commit; every mutation is index-only or confined to
# a mktemp scratch dir, and each is restored before the test returns.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT" || exit 1

PASS=0; FAIL=0
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/caws-hook-tests.XXXXXX")"
cleanup() { rm -rf "$SCRATCH"; }
trap cleanup EXIT

ok()   { PASS=$((PASS+1)); printf '  PASS  %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  FAIL  %s\n     -> %s\n' "$1" "$2"; }

echo "hook tests (repo: $REPO_ROOT)"
echo

# ─────────────────────────────────────────────────────────────────────────
# T1  pre-commit amend guard fails CLOSED when the lane count is unknowable.
#     A stub `node` that prints nothing stands in for a crashed/OOM node.
#     Regression target: `${LANE_COUNT:-0}` coerced empty to 0 and allowed it.
# ─────────────────────────────────────────────────────────────────────────
mkdir -p "$SCRATCH/bin-silent" "$SCRATCH/bin-zero" "$SCRATCH/bin-three"
printf '#!/bin/sh\nexit 0\n'            > "$SCRATCH/bin-silent/node"
printf '#!/bin/sh\necho 0\n'            > "$SCRATCH/bin-zero/node"
printf '#!/bin/sh\necho 3\n'            > "$SCRATCH/bin-three/node"
chmod +x "$SCRATCH"/bin-*/node

run_amend_with_node_stub() {  # $1 = stub dir; echoes exit code
  PATH="$1:$PATH" bash -c 'bash .husky/pre-commit >/dev/null 2>&1; echo $?' --amend
}

t1_silent=$(run_amend_with_node_stub "$SCRATCH/bin-silent")
if [ "$t1_silent" = "1" ]; then
  ok "T1a amend + node emitting nothing -> refuses (exit 1)"
else
  bad "T1a amend + node emitting nothing -> refuses (exit 1)" "got exit $t1_silent"
fi

t1_three=$(run_amend_with_node_stub "$SCRATCH/bin-three")
if [ "$t1_three" = "1" ]; then
  ok "T1b amend + 3 lanes registered -> refuses (exit 1)"
else
  bad "T1b amend + 3 lanes registered -> refuses (exit 1)" "got exit $t1_three"
fi

# Control: with zero lanes the amend guard must NOT be what blocks. This is the
# test that makes T1a/T1b non-vacuous — it proves the stub harness can produce a
# non-refusing outcome, so a hook that refused unconditionally would fail here.
t1_zero_out=$(PATH="$SCRATCH/bin-zero:$PATH" bash -c 'bash .husky/pre-commit 2>&1' --amend)
if printf '%s' "$t1_zero_out" | grep -q 'amend'; then
  bad "T1c amend + 0 lanes -> amend guard stays silent" "guard fired: $t1_zero_out"
else
  ok "T1c amend + 0 lanes -> amend guard stays silent (non-vacuity control)"
fi

# ─────────────────────────────────────────────────────────────────────────
# T2  Staged DELETIONS reach the guards.
#     Regression target: --diff-filter=ACM hid them, so `git rm .caws/policy.yaml`
#     alongside code deletions produced an empty set and exited 0 before Guard 2.
#     Index-only: `git rm --cached` never touches the working tree, and both
#     paths are restored with `git add` (not reset/restore, which the worktree
#     guards refuse).
# ─────────────────────────────────────────────────────────────────────────
t2_policy=".caws/policy.yaml"
t2_code="turbo.json"
if [ -f "$t2_policy" ] && [ -f "$t2_code" ] && git ls-files --error-unmatch "$t2_policy" >/dev/null 2>&1; then
  t2_dirty=$(git status --porcelain -- "$t2_policy" "$t2_code" | wc -l | tr -d ' ')
  if [ "$t2_dirty" != "0" ]; then
    bad "T2 deletion-only policy+code commit is refused" "skipped: $t2_policy/$t2_code already dirty"
  else
    git rm --cached --quiet "$t2_policy" "$t2_code" >/dev/null 2>&1
    t2_out=$(bash .husky/pre-commit 2>&1); t2_exit=$?
    git add "$t2_policy" "$t2_code" >/dev/null 2>&1
    t2_restored=$(git status --porcelain -- "$t2_policy" "$t2_code" | wc -l | tr -d ' ')
    if [ "$t2_exit" = "1" ] && printf '%s' "$t2_out" | grep -q 'policy.yaml is staged together with code changes'; then
      ok "T2a deletion-only policy+code commit is refused (exit 1, Guard 2 message)"
    else
      bad "T2a deletion-only policy+code commit is refused" "exit=$t2_exit out=$t2_out"
    fi
    if [ "$t2_restored" = "0" ]; then
      ok "T2b index restored after the test (no residue)"
    else
      bad "T2b index restored after the test" "$t2_restored path(s) still staged"
    fi
  fi
else
  bad "T2 deletion-only policy+code commit is refused" "fixtures missing: $t2_policy / $t2_code"
fi

# ─────────────────────────────────────────────────────────────────────────
# T3  pre-commit must not touch the shared stash stack.
#     Oracle: a PATH shim records every `git` invocation the hook makes, then
#     execs the real git. Asserting "no stash subcommand was invoked" is exact,
#     where before/after `git stash list` counts are not — lint-staged's default
#     backup creates AND drops an entry, so the counts match either way.
# ─────────────────────────────────────────────────────────────────────────
GITLOG="$SCRATCH/git-calls.log"
mkdir -p "$SCRATCH/bin-gitshim"
REAL_GIT="$(command -v git)"
cat > "$SCRATCH/bin-gitshim/git" <<SHIM
#!/bin/sh
printf '%s\n' "\$*" >> "$GITLOG"
exec "$REAL_GIT" "\$@"
SHIM
chmod +x "$SCRATCH/bin-gitshim/git"

# Vacuity precondition: lint-staged only runs when a file matching
# .lintstagedrc.json is staged. Without one the hook skips it and T3b would pass
# by never reaching the code under test.
T3STAGED=$(git diff --cached --name-only --diff-filter=ACM 2>/dev/null | grep -E '\.(js|jsx|ts|tsx|json|md|ya?ml)$' || true)

: > "$GITLOG"
T3OUT="$SCRATCH/precommit.out"
PATH="$SCRATCH/bin-gitshim:$PATH" bash .husky/pre-commit > "$T3OUT" 2>&1
t3_hook_exit=$?
t3_calls=$(wc -l < "$GITLOG" | tr -d ' ')
# grep -c prints "0" AND exits 1 on no-match, so `|| echo 0` would append a
# second line and make every numeric comparison below fail. Take grep's stdout
# and normalise, never OR a fallback onto it.
t3_stash=$(grep -c '^stash' "$GITLOG" 2>/dev/null)
t3_stash=$(printf '%s' "${t3_stash:-0}" | head -1)

if [ -n "$T3STAGED" ]; then
  ok "T3a precondition: lintable file(s) staged -> lint-staged is reached ($(printf '%s' "$T3STAGED" | tr '\n' ' '))"
else
  bad "T3a precondition: a lintable file must be staged" \
      "nothing matching .lintstagedrc.json is staged, so lint-staged never ran and T3b would pass vacuously. Stage a .ts/.json/.md file and re-run."
fi
if [ "$t3_calls" -gt 0 ]; then
  ok "T3d git shim observed $t3_calls git call(s) (oracle is live, not vacuously empty)"
else
  bad "T3d git shim observed git calls" "log empty — the shim never ran, so T3b proves nothing"
fi
if [ "$t3_stash" = "0" ]; then
  ok "T3b pre-commit made 0 git-stash calls (shared refs/stash untouched)"
else
  bad "T3b pre-commit made 0 git-stash calls" "$t3_stash stash call(s): $(grep '^stash' "$GITLOG" | tr '\n' ';')"
fi
printf '        pre-commit exit=%s, output at %s\n' "$t3_hook_exit" "$T3OUT"
cp "$T3OUT" "${TMPDIR:-/tmp}/caws-hooktest-precommit.out" 2>/dev/null
cp "$GITLOG" "${TMPDIR:-/tmp}/caws-hooktest-git-calls.log" 2>/dev/null

if grep -q -- '--no-stash' .husky/pre-commit; then
  ok "T3c pre-commit invokes lint-staged with --no-stash"
else
  bad "T3c pre-commit invokes lint-staged with --no-stash" "flag absent from the hook"
fi

# ─────────────────────────────────────────────────────────────────────────
# T4  pre-push lock serialises across worktrees.
#     Exercises the primitive directly against a scratch lock dir; running the
#     real pre-push would run a 15-minute build.
# ─────────────────────────────────────────────────────────────────────────
# shellcheck source=../lib/prepush-lock.sh
. .husky/lib/prepush-lock.sh
T4LOCK="$SCRATCH/lock"

if caws_prepush_lock_acquire "$T4LOCK" 0 1; then
  ok "T4a first acquire succeeds on a free lock"
else
  bad "T4a first acquire succeeds on a free lock" "acquire returned non-zero"
fi

if bash -c ". .husky/lib/prepush-lock.sh; caws_prepush_lock_acquire '$T4LOCK' 0 1"; then
  bad "T4b second concurrent acquire is refused" "it acquired a held lock"
else
  ok "T4b second concurrent acquire is refused while the holder is alive"
fi

caws_prepush_lock_release "$T4LOCK"
if [ -d "$T4LOCK" ]; then
  bad "T4c release removes a lock this process owns" "lock dir still present"
else
  ok "T4c release removes a lock this process owns"
fi

# Stale lock (holder dead) must be reclaimed, or one crashed push wedges the
# repo until a human deletes the directory.
mkdir -p "$T4LOCK"; printf '%s\n' "999999" > "$T4LOCK/pid"
if caws_prepush_lock_acquire "$T4LOCK" 0 1; then
  ok "T4d stale lock (dead pid) is reclaimed rather than wedging pushes"
else
  bad "T4d stale lock (dead pid) is reclaimed" "acquire refused a dead holder's lock"
fi
caws_prepush_lock_release "$T4LOCK"

# A release by a NON-owner must be a no-op, or a slow process could delete the
# lock a successor legitimately holds.
mkdir -p "$T4LOCK"; printf '%s\n' "999999" > "$T4LOCK/pid"
caws_prepush_lock_release "$T4LOCK"
if [ -d "$T4LOCK" ]; then
  ok "T4e release by a non-owner is a no-op"
else
  bad "T4e release by a non-owner is a no-op" "it deleted a lock it did not own"
fi
rm -rf "$T4LOCK"

# ─────────────────────────────────────────────────────────────────────────
# T5  pre-push fails CLOSED when its lock library is missing.
# ─────────────────────────────────────────────────────────────────────────
mkdir -p "$SCRATCH/hookcopy/lib"
cp .husky/pre-push "$SCRATCH/hookcopy/pre-push"
cp package.json turbo.json "$SCRATCH/hookcopy/" 2>/dev/null
( cd "$SCRATCH/hookcopy" && bash ./pre-push >/dev/null 2>&1 )
t5_exit=$?
if [ "$t5_exit" = "1" ]; then
  ok "T5 pre-push refuses when lib/prepush-lock.sh is absent (fail closed)"
else
  bad "T5 pre-push refuses when lib/prepush-lock.sh is absent" "got exit $t5_exit"
fi

# ─────────────────────────────────────────────────────────────────────────
# T6  `npm run prepare` points git at the tracked hook tree.
#     Deliberately NOT a sentinel flip: proving prepare *repairs* a wrong value
#     would mean setting core.hooksPath to a bogus path, and for that window
#     every concurrent session in this repo would commit with no hooks at all.
#     What is asserted here is the script's identity plus its post-state; the
#     repair case is covered by review of a one-command script, not execution.
#     See .husky/README.md "What these tests do not cover".
# ─────────────────────────────────────────────────────────────────────────
t6_script=$(node -p 'require("./package.json").scripts.prepare' 2>/dev/null)
if [ "$t6_script" = "git config core.hooksPath .husky" ]; then
  ok "T6a prepare script is exactly: git config core.hooksPath .husky"
else
  bad "T6a prepare script is exactly: git config core.hooksPath .husky" "got: ${t6_script:-<missing>}"
fi

npm run prepare >/dev/null 2>&1
t6_exit=$?
t6_value=$(git config --get core.hooksPath 2>/dev/null)
if [ "$t6_exit" = "0" ] && [ "$t6_value" = ".husky" ]; then
  ok "T6b npm run prepare exits 0 and core.hooksPath reads '.husky'"
else
  bad "T6b npm run prepare exits 0 and core.hooksPath reads '.husky'" "exit=$t6_exit value=${t6_value:-<unset>}"
fi

# The value is worthless if git does not actually find the hooks there. This is
# the assertion that would have caught the .husky/_ regression: that directory
# was configured and readable, and held nothing but an `exit 0` shim.
t6_missing=""
for h in pre-commit commit-msg pre-push; do
  [ -x ".husky/$h" ] || t6_missing="$t6_missing $h"
done
if [ -z "$t6_missing" ]; then
  ok "T6c all three hook-named files exist and are executable under .husky/"
else
  bad "T6c all three hook-named files exist and are executable under .husky/" "missing or non-executable:$t6_missing"
fi

echo
echo "hook tests: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
