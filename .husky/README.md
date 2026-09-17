# Git hooks for this repository

These are the git hooks for the caws monorepo itself. They are **repo-local dev
tooling**, not part of the CAWS product: `caws init` ships no git hooks, and
nothing here is copied into a consumer project. The hooks CAWS _does_ ship are
the agent-harness hook packs under `packages/caws-cli/templates/hook-packs/`,
which are a different mechanism entirely (they gate agent tool calls, not git
operations).

## Layout

```
.husky/
  commit-msg          hook, executed by git
  pre-commit          hook, executed by git
  pre-push            hook, executed by git
  lib/prepush-lock.sh sourced by pre-push; not a hook (no hook is named "lib")
  tests/run.sh        `npm run test:hooks`
  README.md           this file
```

Only files whose name matches a git hook are ever executed by git, so `lib/`,
`tests/` and this README sit in the hooks directory harmlessly.

## How git finds these

`core.hooksPath` is set to `.husky`, so git executes `.husky/<hook-name>`
directly and **ignores `.git/hooks/` completely**. These files are plain shell
scripts; they do not source a husky runtime.

The `prepare` script in the root `package.json` is
`git config core.hooksPath .husky` — a one-line re-assertion that runs on every
`npm install`, so a fresh clone or a `node_modules` rebuild lands wired. It is
deliberately **not** husky's own CLI, which would repoint `core.hooksPath` at
`.husky/_`.

Two failure modes worth knowing, because the repo has hit both:

- **`core.hooksPath` pointing at a directory with no hook-named files is a
  silent, total kill switch.** Between 2025-11-13 and 2026-09-15 it pointed at
  `.husky/_`, which contained only a helper script. Git found no hook by any
  name, so every hook here and every hook in `.git/hooks/` was dead, with no
  warning.
- **Running husky's own CLI repoints `core.hooksPath` at `.husky/_`** and
  recreates exactly that state. If hooks stop firing, read
  `git config --local core.hooksPath` first.

That second mode is not hypothetical, and it was not a one-off human mistake:
`packages/caws-cli/package.json` carried
`"prepare": "husky >/dev/null 2>&1 || true"`, so **any `npm install` in this
repo silently disabled every git hook** — the redirect hid the output and
`|| true` hid the failure. That is the entire mechanism of the ten-month outage.
It is removed, and `.husky/tests/run.sh` (T6d/T6g) fails if any `package.json`
script invokes `husky` again.

Verify the wiring without executing anything:

```bash
git config --get core.hooksPath             # expect: .husky
git rev-parse --git-path hooks/commit-msg   # expect: .husky/commit-msg
```

`git rev-parse --git-path` honours `core.hooksPath` and answers "which file
would git run", which is the question. Prefer it to `git hook run <name>`, which
answers the same question by _running the hook_ — on `pre-push` that is a
15-minute build. And never add `--ignore-missing` to a discovery probe: it
suppresses the `cannot find a hook named <name>` error that is the entire
signal.

## The hooks

| Hook         | What it enforces                                                                                                                                                                                     |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `commit-msg` | While worktree lanes target the current branch, only `merge(worktree):`, `wip(checkpoint):`, `chore(caws):` and true git merge commits may land on it.                                               |
| `pre-commit` | Refuses `--amend` while lanes are registered; keeps `.caws/policy.yaml` edits out of code commits; refuses `change_budget` in spec YAML; validates staged specs; runs lint-staged with `--no-stash`. |
| `pre-push`   | Mirrors CI — lint, `npm audit --audit-level=critical`, build, full test suite — serialised repo-wide by a lock so sibling worktrees cannot build concurrently.                                       |

### Reading the worktree registry

`commit-msg` and `pre-commit` both read `.caws/worktrees.json`. Two shape rules
are load-bearing, and getting either wrong makes the guard silently inert:

1. **v11 is a flat map** — worktree names are top-level keys. v10 nested them
   under a `worktrees` property. Read both shapes.
2. **v11 persists no per-record `status` field.** Being registered _is_ the
   active state. `status: 'active'` exists only on the projection
   `listWorktreesPretty` returns and never reaches disk, so filtering on it
   matches nothing.

Both hooks **fail closed**: an unreadable or malformed registry refuses the
commit rather than allowing it. That includes the case where `node` produces no
output at all — an empty reading is "unknown", never "zero".

### Two views of the staged set

`pre-commit` computes the staged paths twice, and the difference matters:

- `--diff-filter=ACMRD` — what the **guards** see. Deletions and renames are
  changes a guard must judge: `git rm .caws/policy.yaml` alongside deleted
  source is exactly the governance change the policy guard exists to catch.
- `--diff-filter=ACM` — what **lint-staged** sees. A deleted file has no content
  to lint, and handing one to prettier is an error, not a lint failure.

The hook exits early only when _both_ are empty.

### Why `--no-stash`

`refs/stash` lives in the **common git dir** and is therefore shared by every
linked worktree. lint-staged's default backup pushes a stash, resolves it back
**by index**, then drops that index — so a sibling worktree stashing during the
window shifts the index and lint-staged drops or restores the wrong entry. This
repo runs several worktrees concurrently; the backup is the larger hazard, so it
is off. The cost is that a task crashing mid-write leaves partially formatted
files in the working tree, recoverable with `git diff`.

### Why `pre-push` takes a lock

All five stages write to the shared turbo cache and to `dist/`. Two pushes from
sibling worktrees running at once interleave those writes and produce failures
that reproduce nowhere. `lib/prepush-lock.sh` serialises them on the common git
dir: it reclaims the lock if the holder's pid is gone, refuses to release a lock
this process does not own, waits up to 30 minutes, and then refuses rather than
proceeding unlocked. If the lock library is missing, `pre-push` **refuses** — a
guard that proceeds without its concurrency control is the
`source <missing> || true` pattern this repo bans.

**The primitive is `ln -s <pid> <lock>`, not `mkdir`, and the difference is a
bug that shipped.** Both syscalls are atomic, but `mkdir` only makes _existence_
atomic — the owner's pid has to be written in a second step. A contender
arriving between those two steps finds a lock with no pid, concludes the holder
is dead, and deletes a lock that is very much alive. Sequential tests cannot see
this; 16 processes racing the `mkdir` version produced **9 simultaneous
winners**. A symlink carries its payload inside the atomic operation, so the
lock never exists without its owner (T7b, T4g).

`caws_prepush_lock_acquire` therefore has three outcomes, not two: `0` acquired,
`1` contended, `2` the lock could not be created at all. The third exists
because `ln -s` reports "someone holds it" and "this filesystem will not take a
symlink" identically, and treating the second as contention would spin until the
30-minute deadline and wedge every push in the repo (T4f).

## Running the root scripts at all

The root `.npmrc` sets `workspaces=true`. That makes `npm run <name>` resolve
`<name>` **against the workspaces**, so it never reaches a root script:

```bash
npm run test:hooks                    # npm error Missing script: "test:hooks"
                                      #   workspace @paths.design/caws-cli
npm run test:hooks --workspaces=false # runs the root script
```

`npm install` is unaffected — it runs the root `prepare` lifecycle script
normally. Only explicit `npm run` is shadowed. This bit the hook suite itself:
its `prepare` assertion originally ran the _caws-cli_ `prepare` (which was
`husky`) and then read `core.hooksPath`, passing because the value was already
correct rather than because anything set it. T6f now asserts npm echoed the root
script body, so the test cannot pass without an execution.

## Tests

`npm run test:hooks --workspaces=false`, or just `bash .husky/tests/run.sh`.
They run against this repository — there is no `git init` of a fixture repo,
because that pattern arms the agent danger latch. Every mutation is index-only
(`git rm --cached`, restored with `git add`) or confined to a `mktemp` scratch
directory.

### What these tests do not cover

Stated explicitly so the pass count is not mistaken for a proof:

- **The real `timeout` path in `pre-push`.** T8 runs the real hook with the four
  stage commands replaced by exported shell functions. Functions are used rather
  than a stub directory because `pre-push` prepends `/usr/local/bin` to `PATH`
  itself, so no stub directory can ever win; and `timeout` has to be replaced
  too, because the real one is a separate process that would `exec` past the
  functions. So the `124` timeout branch and the real `run_with_timeout` are not
  exercised. T8a fails loudly if the functions do not reach the child shell,
  rather than silently starting a 15-minute build.
- **A real `npm install`.** T9 proves `prepare` repairs a wrong
  `core.hooksPath`, but it runs the script directly against a scratch `GIT_DIR`.
  The install-time lifecycle hook itself is not exercised; that cannot be run
  from a linked worktree without destroying the `node_modules` symlinks.
- **The `--amend` detection itself.** `ps -o args= -p $PPID` is best-effort by
  construction — git gives a hook no amend signal. The tests drive the guard's
  logic through a stubbed `node`; they do not prove a real `git commit --amend`
  is detected under every wrapper. This one cannot be closed by a test here:
  `git commit --amend` is refused by the CAWS agent guards before it reaches
  git, so the scenario is unreachable from an agent session. This hook is
  defence in depth behind that refusal, not the primary control.

A gap in this list is an obligation, not a disclaimer. Three of the five entries
that were here after the hardening slice have since been closed by tests (T7b
real contention, T8 pre-push end to end, T9 prepare repair) — and the first of
those found a live bug in the lock. If a check is mechanically cheap, write it
rather than documenting around it.

## Deliberate non-goals

- **No general conventional-commit format check.** `commit-msg` enforces only
  the base-branch policy above. Adding a format gate would introduce a new
  refusal class that no spec legislates.
- **No secret scanning.** The previous `pre-commit` grepped staged files for
  `(password|secret|key|token).*=.*`, which matched ordinary identifiers far
  more often than secrets and had accumulated six path exclusions to stay
  usable. Secret scanning belongs in CI and in the agent-side hook pack
  (`shared/scan-secrets.sh`), both of which are pattern-maintained.
- **No `post-commit` provenance hook.** The previous one called
  `caws provenance update`, a command v11 removed, gated on
  `.caws/working-spec.yaml`, a file v11 removed. Provenance is written by the
  lifecycle commands themselves.

## Bypassing

`git commit --no-verify` skips `commit-msg` and `pre-commit`;
`git push --no-verify` skips `pre-push`. A hook cannot police its own bypass —
git does not run it at all in that case. Repo doctrine (`CLAUDE.md`, "Governed
paths") is that you do not bypass these; use `caws worktree merge <name>` for
the case the base-branch guard is most often hit on.
