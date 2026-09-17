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
# .lintstagedrc.json is staged. On a clean tree there is none, the hook skips
# lint-staged entirely, and T3b would pass without reaching the code under test.
# So the test stages its own fixture rather than depending on the caller's index.
# The path is written literally on purpose: the agent bash-write-guard refuses a
# parameter-resolved write target, since ownership cannot be decided from text.
printf '# lint-staged fixture\n\ntransient;   removed   by   run.sh\n' > .husky/tests/.lintfixture.md
git add .husky/tests/.lintfixture.md >/dev/null 2>&1
t3_fixture_cleanup() {
  git rm --cached --quiet --force .husky/tests/.lintfixture.md >/dev/null 2>&1
  rm -f .husky/tests/.lintfixture.md
}
trap 't3_fixture_cleanup; cleanup' EXIT

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

t3_fixture_cleanup
trap cleanup EXIT
t3_residue=$(git status --porcelain -- .husky/tests/.lintfixture.md | wc -l | tr -d ' ')
if [ "$t3_residue" = "0" ]; then
  ok "T3e lint fixture removed from index and disk (no residue)"
else
  bad "T3e lint fixture removed from index and disk" "still present in git status"
fi

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
if [ -L "$T4LOCK" ]; then
  bad "T4c release removes a lock this process owns" "lock still present"
else
  ok "T4c release removes a lock this process owns"
fi

# Stale lock (holder dead) must be reclaimed, or one crashed push wedges the
# repo until a human deletes it.
ln -s 999999 "$T4LOCK"
if caws_prepush_lock_acquire "$T4LOCK" 0 1; then
  ok "T4d stale lock (dead pid) is reclaimed rather than wedging pushes"
else
  bad "T4d stale lock (dead pid) is reclaimed" "acquire refused a dead holder's lock"
fi
caws_prepush_lock_release "$T4LOCK"

# A release by a NON-owner must be a no-op, or a slow process could delete the
# lock a successor legitimately holds.
ln -s 999999 "$T4LOCK"
caws_prepush_lock_release "$T4LOCK"
if [ -L "$T4LOCK" ]; then
  ok "T4e release by a non-owner is a no-op"
else
  bad "T4e release by a non-owner is a no-op" "it deleted a lock it did not own"
fi
rm -f "$T4LOCK"

# A failure that is NOT contention must be reported as such (exit 2), or a
# filesystem that cannot take the symlink looks like an eternally-held lock and
# wedges every push in the repository.
if caws_prepush_lock_acquire "$SCRATCH/no-such-dir/lock" 0 1; then
  bad "T4f a lock that cannot be created returns 2, not contention" "it reported success"
else
  t4f=$?
  if [ "$t4f" = "2" ]; then
    ok "T4f a lock that cannot be created returns 2, distinguishable from contention"
  else
    bad "T4f a lock that cannot be created returns 2, not contention" "returned $t4f (1 would spin as if contended)"
  fi
fi

# The lock must carry its owner atomically: there is no instant at which it
# exists without a readable pid. This is the invariant the mkdir version broke.
caws_prepush_lock_acquire "$T4LOCK" 0 1
t4_owner=$(caws_prepush_lock_owner "$T4LOCK")
if [ "$t4_owner" = "$$" ]; then
  ok "T4g the lock records its owner's pid ($t4_owner) in the same atomic act that creates it"
else
  bad "T4g the lock records its owner's pid in the same atomic act that creates it" "owner reads '${t4_owner:-<none>}', expected $$"
fi
caws_prepush_lock_release "$T4LOCK"

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

# --workspaces=false is load-bearing, not tidiness. Root .npmrc sets
# workspaces=true, so a bare `npm run prepare` resolves the name against the
# workspaces and runs THEIR prepare, never the root one. That is how the
# original version of this test passed vacuously: it asserted core.hooksPath
# was ".husky" after running a script that had not touched it.
T6OUT="$SCRATCH/prepare.out"
npm run prepare --workspaces=false > "$T6OUT" 2>&1
t6_exit=$?
t6_value=$(git config --get core.hooksPath 2>/dev/null)
if [ "$t6_exit" = "0" ] && [ "$t6_value" = ".husky" ]; then
  ok "T6b npm run prepare --workspaces=false exits 0 and core.hooksPath reads '.husky'"
else
  bad "T6b npm run prepare --workspaces=false exits 0 and core.hooksPath reads '.husky'" "exit=$t6_exit value=${t6_value:-<unset>}"
fi

# Anti-vacuity for T6b: npm echoes the script body it is about to run. Seeing
# the body proves the ROOT script executed, rather than the assertion passing
# because core.hooksPath already held the right value.
if grep -q 'git config core.hooksPath .husky' "$T6OUT"; then
  ok "T6f npm echoed the root script body — T6b observed an execution, not a pre-existing value"
else
  bad "T6f npm echoed the root script body" "not in output; T6b cannot distinguish 'prepare ran' from 'value was already right'. Output: $(tr '\n' '|' < "$T6OUT")"
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

# The regression guard for the outage itself. husky's CLI repoints
# core.hooksPath at .husky/_ ; packages/caws-cli carried
# `"prepare": "husky >/dev/null 2>&1 || true"`, so any npm install silently
# killed every hook in the repo, and the redirect hid it. No package here may
# invoke husky from a script again, under any lifecycle name.
T6HUSKY=$(git ls-files '*package.json' ':!:**/node_modules/**' | while IFS= read -r f; do
  node -e '
    var fs = require("fs");
    try {
      var s = (JSON.parse(fs.readFileSync(process.argv[1], "utf8")).scripts) || {};
      Object.keys(s).forEach(function (k) {
        // Match husky as a COMMAND token. A looser word boundary matches the
        // "husky" inside the path .husky/tests/run.sh, which is this repo\x27s
        // own hook tree and the opposite of the thing being banned.
        if (/(^|[\s;&|(])husky([\s;&|)]|$)/.test(String(s[k]))) {
          console.log(process.argv[1] + " -> " + k + ": " + s[k]);
        }
      });
    } catch (e) { console.log(process.argv[1] + " -> UNREADABLE: " + e.message); }
  ' "$f"
done)
if [ -z "$T6HUSKY" ]; then
  ok "T6d no package.json script invokes husky (it repoints core.hooksPath at .husky/_)"
else
  bad "T6d no package.json script invokes husky" "$(printf '%s' "$T6HUSKY" | tr '\n' ';')"
fi

# T6d passes trivially once the offending script is gone, so the detector needs
# its own oracle. This pins it against the exact string the repo carried
# ("husky >/dev/null 2>&1 || true") and against the paths it must NOT flag.
T6DETECT=$(node -e '
  var re = /(^|[\s;&|(])husky([\s;&|)]|$)/;
  var cases = [
    ["husky >/dev/null 2>&1 || true", true],
    ["husky install", true],
    ["npm run build && husky", true],
    ["git config core.hooksPath .husky", false],
    ["bash .husky/tests/run.sh", false],
    ["node ./huskyish.js", false]
  ];
  var bad = cases.filter(function (c) { return re.test(c[0]) !== c[1]; });
  console.log(bad.length ? bad.map(function (c) { return c[0]; }).join(" | ") : "");
')
if [ -z "$T6DETECT" ]; then
  ok "T6g the husky detector flags the historical offending script and not .husky paths"
else
  bad "T6g the husky detector flags the historical offending script and not .husky paths" "misclassified: $T6DETECT"
fi

# T6d only means something if the scanner actually read package.json files.
T6SCANNED=$(git ls-files '*package.json' ':!:**/node_modules/**' | wc -l | tr -d ' ')
if [ "$T6SCANNED" -ge 2 ]; then
  ok "T6e husky scan covered $T6SCANNED package.json file(s) (scanner is live)"
else
  bad "T6e husky scan covers the repo's package.json files" "only $T6SCANNED found — T6d would pass vacuously"
fi

# ─────────────────────────────────────────────────────────────────────────
# T7  Real contention: N processes race one free lock, exactly one wins.
#     T4b proved the protocol sequentially — acquire, then try again from a
#     second process. That cannot observe a torn window between "is it free?"
#     and "take it". These processes all block on a start gate and go at once.
# ─────────────────────────────────────────────────────────────────────────
T7LOCK="$SCRATCH/racelock"
T7DIR="$SCRATCH/race"
mkdir -p "$T7DIR"
T7N=16
i=1
while [ "$i" -le "$T7N" ]; do
  (
    # Block until the gate opens so the attempts overlap instead of queueing.
    while [ ! -f "$T7DIR/go" ]; do sleep 0.01; done
    . .husky/lib/prepush-lock.sh
    if caws_prepush_lock_acquire "$T7LOCK" 0 1; then
      printf 'win %s\n' "$$" > "$T7DIR/r$i"
    else
      printf 'lose\n' > "$T7DIR/r$i"
    fi
  ) &
  i=$((i + 1))
done
sleep 0.3
: > "$T7DIR/go"
wait

T7REPORTED=$(find "$T7DIR" -name 'r*' -type f | wc -l | tr -d ' ')
T7WINS=$(grep -l '^win' "$T7DIR"/r* 2>/dev/null | wc -l | tr -d ' ')

# Non-vacuity: a run where half the processes died would also show one winner.
if [ "$T7REPORTED" = "$T7N" ]; then
  ok "T7a all $T7N racing processes reported a verdict (none died silently)"
else
  bad "T7a all $T7N racing processes reported a verdict" "only $T7REPORTED of $T7N wrote a result"
fi
if [ "$T7WINS" = "1" ]; then
  ok "T7b exactly 1 of $T7N concurrent processes acquired the lock (mutual exclusion holds)"
else
  bad "T7b exactly 1 of $T7N concurrent processes acquired the lock" "$T7WINS winners — the lock did not serialise them"
fi
rm -f "$T7LOCK"

# ─────────────────────────────────────────────────────────────────────────
# T8  pre-push end to end, with the five heavy stage commands stubbed.
#     Running the real stages is a 15-minute build, so the stages are stubbed
#     while the hook itself stays the real file. GIT_DIR points at a scratch git
#     dir so the lock lands there rather than on the real common dir, which a
#     peer's genuine push may be holding.
# ─────────────────────────────────────────────────────────────────────────
T8GIT="$SCRATCH/gitdir"
mkdir -p "$T8GIT/objects" "$T8GIT/refs"
printf 'ref: refs/heads/main\n' > "$T8GIT/HEAD"

# The stages are stubbed as EXPORTED SHELL FUNCTIONS, not as executables on
# PATH, and that is forced by the hook rather than chosen. pre-push begins with
#   export PATH="/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin:$PATH"
# so a stub directory can never be reached first — /usr/local/bin/npm exists on
# this machine. A bash function outranks PATH lookup entirely, and child bash
# processes inherit exported functions, so `bash .husky/pre-push` sees them.
#
# `timeout` has to be stubbed too, for a non-obvious reason: run_with_timeout
# prefers the real /usr/local/bin/timeout, which is a separate process and would
# exec the real npm past the functions. The replacement drops the seconds and
# runs the command in-shell, where the function is visible. The cost is stated
# plainly: T8 does not exercise the real timeout path or the 124 branch.
_caws_stage_stub() {
  local name="$1"; shift
  local lock="free"
  if [ -n "${CAWS_STAGE_LOCK:-}" ] && [ -L "$CAWS_STAGE_LOCK" ]; then lock="held"; fi
  printf '%s %s lock=%s\n' "$name" "$*" "$lock" >> "$CAWS_STAGE_LOG"
  # Prefix match on the full argument string, not equality on $1. Typecheck and
  # build are both `npm run`, so matching $1 alone cannot single out either —
  # CAWS_STAGE_FAIL="run" would fail both and prove neither.
  if [ -n "${CAWS_STAGE_FAIL:-}" ]; then
    case "$*" in
      "$CAWS_STAGE_FAIL"*) return 1 ;;
    esac
  fi
  return 0
}
npm() { _caws_stage_stub npm "$@"; }
npx() { _caws_stage_stub npx "$@"; }
timeout() { shift; "$@"; }
export -f _caws_stage_stub npm npx timeout

# Safety gate. If the function export does not survive into the child shell,
# pre-push would run the REAL lint, build and test suite — 15+ minutes. Replay
# the hook's preamble and require that npm and timeout are both functions there
# before running anything.
T8KINDS=$(bash -c '
  export PATH="/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin:$PATH"
  if [ -s "$HOME/.nvm/nvm.sh" ]; then . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1; fi
  printf "%s,%s,%s" "$(type -t npm)" "$(type -t npx)" "$(type -t timeout)"' 2>/dev/null)
T8SKIP=""
if [ "$T8KINDS" = "function,function,function" ]; then
  ok "T8a npm/npx/timeout resolve as exported functions inside pre-push's preamble"
else
  T8SKIP=1
  bad "T8a npm/npx/timeout resolve as exported functions inside pre-push's preamble" \
      "got '$T8KINDS' (want function,function,function). Refusing to run pre-push: it would start a real build and a real test suite."
fi

if [ -z "$T8SKIP" ]; then
  T8LOG="$SCRATCH/stages.log"
  : > "$T8LOG"
  GIT_DIR="$T8GIT" \
    CAWS_STAGE_LOG="$T8LOG" CAWS_STAGE_LOCK="$T8GIT/caws-prepush.lock" \
    bash .husky/pre-push origin https://example.invalid/repo.git > "$SCRATCH/prepush.out" 2>&1
  t8_exit=$?
  cp "$T8LOG" "${TMPDIR:-/tmp}/caws-hooktest-stages.log" 2>/dev/null
  cp "$SCRATCH/prepush.out" "${TMPDIR:-/tmp}/caws-hooktest-prepush.out" 2>/dev/null

  if [ "$t8_exit" = "0" ]; then
    ok "T8b pre-push exits 0 when all five stages pass"
  else
    bad "T8b pre-push exits 0 when all five stages pass" "exit=$t8_exit; output: $(tr '\n' '|' < "$SCRATCH/prepush.out")"
  fi

  t8_order=$(cut -d' ' -f1-2 "$T8LOG" | tr '\n' ',')
  if [ "$t8_order" = "npm run,npx turbo,npm audit,npm run,npm test," ]; then
    ok "T8c all five stages ran in order: $t8_order"
  else
    bad "T8c all five stages ran in order" "got: ${t8_order:-<nothing logged>} (expected 'npm run,npx turbo,npm audit,npm run,npm test,')"
  fi

  # T8c cuts to two fields, so typecheck and build are both "npm run" there and
  # the order assertion alone cannot tell them apart. Pin the first invocation
  # in full. The -w flag is the load-bearing part: root .npmrc sets
  # workspaces=true, so a bare `npm run typecheck` resolves against the
  # workspaces and never reaches the intended script — it would log identically
  # here while checking nothing.
  t8_first=$(head -1 "$T8LOG")
  case "$t8_first" in
    "npm run typecheck -w @paths.design/caws-cli lock="*)
      ok "T8c2 stage 1 is the workspace-targeted typecheck: $t8_first" ;;
    *)
      bad "T8c2 stage 1 is the workspace-targeted typecheck" \
          "got: ${t8_first:-<nothing logged>} (expected 'npm run typecheck -w @paths.design/caws-cli lock=...')" ;;
  esac

  # The point of the lock is that it is HELD while the stages run, not merely
  # created and removed around them.
  t8_held=$(grep -c 'lock=held' "$T8LOG" 2>/dev/null)
  t8_held=$(printf '%s' "${t8_held:-0}" | head -1)
  t8_free=$(grep -c 'lock=free' "$T8LOG" 2>/dev/null)
  t8_free=$(printf '%s' "${t8_free:-0}" | head -1)
  if [ "$t8_held" = "5" ] && [ "$t8_free" = "0" ]; then
    ok "T8d the lock was held during all 5 stages (held=$t8_held free=$t8_free)"
  else
    bad "T8d the lock was held during all 5 stages" "held=$t8_held free=$t8_free"
  fi

  if [ ! -L "$T8GIT/caws-prepush.lock" ]; then
    ok "T8e the lock is released when pre-push exits"
  else
    bad "T8e the lock is released when pre-push exits" "lock dir still present after exit"
  fi

  # A stage that fails must refuse the push. Without this, T8b only pins the
  # happy path, and a hook that ignored every exit code would still pass.
  : > "$T8LOG"
  GIT_DIR="$T8GIT" \
    CAWS_STAGE_LOG="$T8LOG" CAWS_STAGE_LOCK="$T8GIT/caws-prepush.lock" CAWS_STAGE_FAIL="audit" \
    bash .husky/pre-push origin https://example.invalid/repo.git > "$SCRATCH/prepush-fail.out" 2>&1
  t8_fail_exit=$?
  if [ "$t8_fail_exit" = "1" ] && grep -q 'refusing the push' "$SCRATCH/prepush-fail.out"; then
    ok "T8f a failing stage makes pre-push refuse the push (exit 1)"
  else
    bad "T8f a failing stage makes pre-push refuse the push" "exit=$t8_fail_exit; output: $(tr '\n' '|' < "$SCRATCH/prepush-fail.out")"
  fi

  # The typecheck stage specifically. T8f only proves the audit stage's exit
  # code is inspected; a stage added but run-and-ignored would still pass it.
  # This is the whole point of the stage, so it gets its own falsification.
  : > "$T8LOG"
  GIT_DIR="$T8GIT" \
    CAWS_STAGE_LOG="$T8LOG" CAWS_STAGE_LOCK="$T8GIT/caws-prepush.lock" CAWS_STAGE_FAIL="run typecheck" \
    bash .husky/pre-push origin https://example.invalid/repo.git > "$SCRATCH/prepush-tc-fail.out" 2>&1
  t8_tc_exit=$?
  if [ "$t8_tc_exit" = "1" ] \
     && grep -q 'refusing the push' "$SCRATCH/prepush-tc-fail.out" \
     && grep -q 'typecheck failed' "$SCRATCH/prepush-tc-fail.out"; then
    ok "T8f2 a failing typecheck refuses the push and names itself"
  else
    bad "T8f2 a failing typecheck refuses the push and names itself" \
        "exit=$t8_tc_exit; output: $(tr '\n' '|' < "$SCRATCH/prepush-tc-fail.out")"
  fi

  # ...and the build stage must NOT be collateral damage of that match: both are
  # `npm run`, so a sloppy matcher would fail build too and T8f2 would pass for
  # the wrong reason.
  if grep -q '^npm run build' "$T8LOG"; then
    ok "T8f3 the build stage still ran — the typecheck failure did not match it"
  else
    bad "T8f3 the build stage still ran" "build absent from: $(tr '\n' '|' < "$T8LOG")"
  fi

  # The real lock path is deliberately not exercised above (GIT_DIR was
  # redirected), so assert it separately rather than leaving it unstated.
  t8_real_lock=$(caws_prepush_lock_dir)
  case "$t8_real_lock" in
    */caws-prepush.lock)
      ok "T8g the real lock resolves onto the common git dir: $t8_real_lock" ;;
    *)
      bad "T8g the real lock resolves onto the common git dir" "got '${t8_real_lock:-<empty>}'" ;;
  esac
fi

# The stubs shadow the real npm for the rest of this script; T9 runs the real
# one. Retire them explicitly rather than relying on ordering.
unset -f npm npx timeout _caws_stage_stub
if [ "$(type -t npm)" = "function" ]; then
  bad "T8h the stage stubs are retired before the next test" "npm is still a function; T9 would measure the stub"
else
  ok "T8h the stage stubs are retired before the next test (npm is $(type -t npm 2>/dev/null || echo external) again)"
fi

# ─────────────────────────────────────────────────────────────────────────
# T9  prepare REPAIRS a wrong core.hooksPath, not merely re-asserts a right one.
#     The wrong value is produced in a scratch GIT_DIR, so the shared repository
#     config — which every concurrent session's hooks depend on — is never
#     touched. That constraint is why an earlier slice waived this criterion.
# ─────────────────────────────────────────────────────────────────────────
T9GIT="$SCRATCH/gitdir-prepare"
mkdir -p "$T9GIT/objects" "$T9GIT/refs"
printf 'ref: refs/heads/main\n' > "$T9GIT/HEAD"

T9REAL_BEFORE=$(git config --get core.hooksPath 2>/dev/null)

GIT_DIR="$T9GIT" git config core.hooksPath .husky-WRONG 2>/dev/null
t9_wrong=$(GIT_DIR="$T9GIT" git config --get core.hooksPath 2>/dev/null)
if [ "$t9_wrong" = ".husky-WRONG" ]; then
  ok "T9a scratch config holds a wrong core.hooksPath ('.husky-WRONG') to repair from"
else
  bad "T9a scratch config holds a wrong core.hooksPath to repair from" "reads '${t9_wrong:-<unset>}' — the rest of T9 would prove nothing"
fi

GIT_DIR="$T9GIT" npm run prepare --workspaces=false >/dev/null 2>&1
t9_exit=$?
t9_after=$(GIT_DIR="$T9GIT" git config --get core.hooksPath 2>/dev/null)
if [ "$t9_exit" = "0" ] && [ "$t9_after" = ".husky" ]; then
  ok "T9b prepare repaired '.husky-WRONG' -> '.husky' (repair, not idempotence)"
else
  bad "T9b prepare repaired '.husky-WRONG' -> '.husky'" "exit=$t9_exit value='${t9_after:-<unset>}'"
fi

T9REAL_AFTER=$(git config --get core.hooksPath 2>/dev/null)
if [ "$T9REAL_AFTER" = "$T9REAL_BEFORE" ] && [ "$T9REAL_AFTER" = ".husky" ]; then
  ok "T9c the real repository config was never touched (still '$T9REAL_AFTER')"
else
  bad "T9c the real repository config was never touched" "before='$T9REAL_BEFORE' after='$T9REAL_AFTER' — this test leaked into shared state"
fi

echo
echo "hook tests: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
