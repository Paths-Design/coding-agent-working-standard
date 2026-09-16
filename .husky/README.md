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

Verify the wiring without executing anything:

```bash
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

All four stages write to the shared turbo cache and to `dist/`. Two pushes from
sibling worktrees running at once interleave those writes and produce failures
that reproduce nowhere. `lib/prepush-lock.sh` serialises them with an atomic
`mkdir` on the common git dir, records the holder's pid, reclaims the lock if
that pid is gone, and refuses to release a lock this process does not own. It
waits up to 30 minutes, then refuses rather than proceeding unlocked. If the
lock library is missing, `pre-push` **refuses** — a guard that proceeds without
its concurrency control is the `source <missing> || true` pattern this repo
bans.

## Tests

`npm run test:hooks` (`.husky/tests/run.sh`). They run against this repository —
there is no `git init` of a fixture repo, because that pattern arms the agent
danger latch. Every mutation is index-only (`git rm --cached`, restored with
`git add`) or confined to a `mktemp` scratch directory.

### What these tests do not cover

Stated explicitly so the pass count is not mistaken for a proof:

- **`prepare` repairing a wrong `core.hooksPath`.** The test asserts the
  script's exact text and its post-state. Proving repair means setting
  `core.hooksPath` to a bogus value first, and for that window every concurrent
  session in this repo would commit with no hooks at all. Reviewed as a
  one-command script instead.
- **`pre-push` end to end.** The lock primitive is tested directly; the four
  stages are not run, because doing so is a 15-minute build per test run.
- **Real contention between two OS processes racing `mkdir`.** The lock tests
  are sequential; they prove the protocol, not the kernel's `mkdir` atomicity
  (which is POSIX-guaranteed and not this repo's to test).
- **The `--amend` detection itself.** `ps -o args= -p $PPID` is best-effort by
  construction — git gives a hook no amend signal. The tests drive the guard's
  logic through a stubbed `node`; they do not prove a real `git commit --amend`
  is detected under every wrapper.

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
