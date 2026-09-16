# Git hooks for this repository

These are the git hooks for the caws monorepo itself. They are **repo-local dev
tooling**, not part of the CAWS product: `caws init` ships no git hooks, and
nothing here is copied into a consumer project. The hooks CAWS _does_ ship are
the agent-harness hook packs under `packages/caws-cli/templates/hook-packs/`,
which are a different mechanism entirely (they gate agent tool calls, not git
operations).

## How git finds these

`core.hooksPath` is set to `.husky`, so git executes `.husky/<hook-name>`
directly and **ignores `.git/hooks/` completely**. These files are plain shell
scripts; they do not source a husky runtime.

Two failure modes worth knowing, because the repo has hit both:

- **`core.hooksPath` pointing at a directory with no hook-named files is a
  silent, total kill switch.** Between 2025-11-13 and 2026-09-15 it pointed at
  `.husky/_`, which contained only a helper script. Git found no hook by any
  name, so every hook here and every hook in `.git/hooks/` was dead, with no
  warning. Diagnose with `git hook run <name>`;
  `error: cannot find a hook named <name>` means git is not running it, whatever
  the file says.
- **Running husky's own CLI will repoint `core.hooksPath` at `.husky/_`** and
  break this layout again. This repo has no `prepare` script, so that only
  happens if someone runs it by hand. If hooks stop firing, check
  `git config --local core.hooksPath` first.

Verify the wiring at any time:

```bash
git rev-parse --git-path hooks        # expect: .husky
git hook run commit-msg 2>&1 | head   # expect: a hook error, not "cannot find a hook"
```

## The hooks

| Hook         | What it enforces                                                                                                                                                                   |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `commit-msg` | While worktree lanes target the current branch, only `merge(worktree):`, `wip(checkpoint):`, `chore(caws):` and true git merge commits may land on it.                             |
| `pre-commit` | Refuses `--amend` while lanes are registered; keeps `.caws/policy.yaml` edits out of code commits; refuses `change_budget` in spec YAML; validates staged specs; runs lint-staged. |
| `pre-push`   | Mirrors CI: lint, `npm audit --audit-level=critical`, build, full test suite.                                                                                                      |

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
commit rather than allowing it. The previous version returned `0` from its catch
block, so a corrupt registry silently permitted everything.

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
