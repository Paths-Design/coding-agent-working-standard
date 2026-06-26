# Scope discipline — procedure

Operational procedure for staying in scope and avoiding strike lockouts in this
CAWS-governed repo. The *doctrine* (why this matters, the load-bearing
invariants) lives in the root `CLAUDE.md` under **Scope is an agreement** and
**Pre-edit admission**. This file is the *how* those sections point to: the
checklists, the strike-state mechanics, and the recovery steps. Read the
doctrine first; reach here for the recipe.

## Pre-edit admission protocol (mandatory)

`caws scope show <path>` is a **pre-edit admission check**, not a post-failure
diagnostic. Every commit you author inside a bound worktree begins with an
explicit proof block before any file write. This protocol is non-optional.
Strike reset is **not** part of normal workflow — a strike means the procedure
failed, and the procedure must be explained and corrected before another reset
is requested.

### The preflight proof block

The first thing you produce when starting a new commit is this block (literally
— output it as text in your response before any tool call that writes a file):

```text
Commit <N> preflight:

Branch:
- <branch name>

Planned write targets:
- <path> (CREATE | MODIFY)
- <path> (CREATE | MODIFY)
- ...

Scope proof:
- caws scope show <path> => <ADMIT | REFUSE>
- caws scope show <path> => <ADMIT | REFUSE>
- ...

No edits before this proof is complete.
```

Then run the `caws scope show` calls. Then — only if every target returns ADMIT
— start editing.

If any target returns REFUSE:

1. Stop. Do not edit anything.
2. Run **one** `caws specs amend-scope <SPEC-ID> --add <path>...` adding all
   missing paths in a single call (the sanctioned path — CAWS-SCOPE-AMEND-COMMAND-001).
   It writes canonical, bumps `updated_at`, and appends `spec_scope_amended`.
   **No `git cherry-pick`** — scope resolves through canonical, so the worktree
   sees the change immediately.
3. Rerun the scope-proof block. Every target must now return ADMIT.
4. Begin editing.

(Legacy fallback, only if `amend-scope` cannot express the change: hand-edit +
commit the canonical spec, then `git cherry-pick` to the worktree — but that
cherry-pick engages the danger latch and needs a human reset. Avoid it.)

### Post-edit verification (every commit)

After the edit phase and before `git commit`:

- Run the targeted tests for the surface you touched (`jest <path>`, kernel `npm test`, etc.).
- Run the relevant typecheck/build (`tsc`, turbo build for the package).
- Run `caws scope check <path>` on each written file (admission proof, not just show).
- Run `git status --short` to verify only the planned write targets are dirty.

Commit only when all checks pass or you can explain in the commit message why a
check was deliberately skipped or expected to fail.

### Diagnostic files are write targets too

Probe scripts, scratch files, redirected diagnostic outputs, and any other
"temporary" file the agent creates ARE subject to the preflight protocol.
`/tmp/probe.js`, `scratch.txt`, `debug-output.log`, and anything similar count
as writes.

**Concretely:**

- Do NOT write to `/tmp/` from the agent. The scope guard doesn't admit paths
  under `/tmp/` because they're not in any spec's `scope.in`. Use `node -e '...'`
  for inline JS, stdout/stderr redirection inside Bash for capture, or in-scope
  test instrumentation (a temporary `console.log` inside an already-admitted
  `*.test.js` file, removed before commit).
- Do NOT redirect diagnostic output to a new file unless that file's path is
  predeclared in the preflight write-target list AND passes `caws scope show`.
- Do NOT use Write tool for ANY purpose without preflight. There is no "but it's
  just a scratch file" exception. The hook fires on every Write call.

The valid escape hatches for diagnostic work:

- Inline Bash with `node -e`, `python -c`, `jq`, etc. — no file is written, only stdout returned.
- Temporary `console.log` inside an existing in-scope test file. Add, run, capture, remove before commit. The file itself stays scope-admitted.
- Reading existing artifacts (`fs.readFileSync`, `cat`, `jq` against a real on-disk file) — read is never gated, only writes are.

This rule exists because the agent earned a strike on `/tmp/migrator-probe.js`
during CAWS-MIGRATE-V10-SPECS-001 commit 3 by treating "it's just a probe" as a
license to skip the preflight. The strike system caught it. The protocol must
catch it earlier — the agent's reasoning, not the kernel's enforcement.

## Scope authoring — anticipate, don't react

Scope amendments are normal and welcome — they're git-tracked, attributed to a
specific commit, and `caws specs show` displays the updated scope. The
maintainer is comfortable with you amending scope when you discover a path you
legitimately need to edit. What burns time is NOT amendments — it's discovering
the gap one strike at a time during implementation. Avoid that by planning scope
BEFORE you start editing.

### 1. Run scope.in through the file-list lens, not the file-pattern lens

When you draft scope.in, mentally walk every file you'll create or modify:

- For every new `.ts` file you intend to create: is its exact path in scope.in?
- For every `*.test.js` / `*.test.ts` you'll write: does the test path with the
  correct extension match scope.in? (`.test.js` vs `.test.ts` mismatches are a
  common foot-gun — see the spec-authoring traps in `CLAUDE.md`.)
- For every comment-only edit you intend (deprecation markers, doctrine
  annotations): is the file in scope.in? The invariant body saying "add comment
  to X" is NOT scope admission.
- For every doctrine doc you'll touch (CLAUDE.md, AGENTS.md, COMMIT_CONVENTIONS.md,
  docs/architecture/*, docs/failure-lineage.md): is it in scope.in or admitted
  via `policy.root_passthrough`?
- For every integration test that creates real fixtures (linked worktrees, git
  repos): is the new test file path in scope.in?

If you're listing one or two paths and the rest are "in this directory,"
consider whether the directory itself is the right scope.in entry. The scope
kernel treats scope.in entries as literal prefix matches (or globs where
supported), not as documentation.

### 2. Amend scope BEFORE the speculative edit, not after the strike

When mid-implementation you realize a file isn't in scope:

- **Stop editing that file immediately.** A single edit on an out-of-scope path
  is strike 1. Three strikes hard-block until reset.
- **Run `caws scope show <path>`** to confirm the refusal and capture the spec
  id + exact missing entry.
- **Amend the scope with `caws specs amend-scope`** — the sanctioned path
  (CAWS-SCOPE-AMEND-COMMAND-001). It mutates `scope.in` on the canonical control
  plane, bumps `updated_at`, and appends a `spec_scope_amended` audit event — all
  in one governed transaction:
  ```
  caws specs amend-scope <SPEC-ID> --add path/one --add path/two
  ```
  Because scope resolves through canonical regardless of cwd, `caws scope check
  <path>` from your worktree ADMITs the added path **immediately** — there is
  **no `git cherry-pick` to run** (and therefore no danger latch to trip). Use
  `--remove`, `--add-out`, `--remove-out` as needed. Run it from anywhere.
- **Do not chain amendments.** If you need 3 files, `--add` all 3 in one
  `amend-scope` call, not three.
- **Fallback (rare):** if `amend-scope` cannot cover the change (e.g. a non-scope
  spec field), hand-edit the canonical spec, commit it as `chore(caws): amend
  <SPEC-ID> scope for <what>` (bump `updated_at`), then `git cherry-pick` into
  your worktree branch. ⚠️ **Raw `git cherry-pick` engages the danger latch and
  requires a human reset** — prefer `amend-scope`, which avoids it entirely. (The
  classifier admits a cherry-pick that touches ONLY `.caws/specs/*.yaml` without
  latching, but `amend-scope` is still the first choice.)

### 3. Blast-radius and scope-collision review at draft time

When authoring a new spec, before flipping to `active`:

- **List every package, every directory tree, every test file, every doc, every
  hook template, every CI surface you might touch.** Put them in scope.in. Easier
  to over-include and trim than to scramble mid-implementation.
- **Cross-check `scope.out` against sibling specs' `scope.in`.** Listing a
  sibling's `scope.in` paths in your `scope.out` will refuse YOUR edits to those
  paths even when admitted (it's enforcement, not documentation). Either omit or
  accept the collision.
- **Cross-check governed paths** (`.caws/policy.yaml`, `CODEOWNERS`,
  `change_budget` keys) and explicitly list them in `scope.out` so future agents
  know you intentionally excluded them.
- **Cross-check active sibling worktrees.** If another agent is actively editing
  files in `packages/foo/`, putting `packages/foo` broadly in your scope.in
  creates a union-mode collision when both specs are active. Either narrow your
  scope or coordinate.

## Scope-guard strike state (avoid stale lockouts)

The scope-guard strike counter is **accumulative across all guards within a
single (session, checkout-location) pair**, not per-file or per-spec. The keying
is deliberately scoped to the checkout you are working in:

- From the **canonical checkout**, strikes accumulate in
  `.claude/logs/guard-strikes-<session>.json` — one file per session.
- From inside a **linked worktree**, strikes accumulate in that worktree's own
  gitdir-relative file (`<gitdir>/caws-guard-strikes/guard-strikes-<session>.json`,
  where `<gitdir>` is `<canonical>/.git/worktrees/<name>` — outside every working
  tree so `git add -A` can never commit it; see
  `CAWS-GUARD-STRIKE-FILE-OUT-OF-TREE-001`).

**Strikes do NOT bleed across worktrees.** A strike earned in worktree A does not
corner an edit in worktree B, and a strike earned in a worktree is *not* visible
in the canonical `.claude/logs` file (and vice-versa). This per-checkout
isolation is **intentional**, not a defect: cross-worktree strike accumulation
was a high-severity multi-agent control-plane collapse in the failure lineage (an
agent flagged a bogus authority violation because another worktree's strikes
leaked in). If a block message says "strike 3" but the canonical `.claude/logs`
file shows a lower count, you are reading the wrong file — the live count is in
*your current checkout's* strike file (the worktree gitdir when you're inside a
worktree).

Two important behaviors within a given checkout:

1. **A file that earned strikes earlier stays "hot."** Even after you correct the
   underlying scope (e.g., add the file to a spec's `scope.in`), the guard does
   NOT re-evaluate prior strikes — it adds the next strike on top of the
   cumulative count for that checkout. If you've already burned strikes 1 and 2
   on `path/X`, the next edit will hard-block at strike 3 regardless of whether
   the scope is now correct.

2. **The recovery path is the strike-reset script, not the scope edit alone.**
   When the guard says "ask the user to run: `bash .claude/hooks/reset-strikes.sh
   --current`" — that's not optional. After correcting the scope cause, you still
   need to clear the accumulated strike state. `reset-strikes.sh` collects strike
   files from the canonical `.claude/logs`, every worktree gitdir, and the legacy
   `.caws/worktrees/**/tmp` location, so `--current` clears the right one.

The right discipline: don't speculatively edit a file before verifying it's in
scope. Use `caws scope show <path>` first if uncertain. The check costs nothing
and avoids burning a strike on a file you'll have to revisit.

## Recovery checklist (when you hit a strike anyway)

1. **Stop editing the hot file.** Don't retry on the same path — each retry is
   another strike.
2. **Diagnose** with `caws scope show <path>` from inside the worktree. Capture
   the exact refusal message.
3. **Decide:** is the path legitimately in scope (amend needed) or genuinely out
   (revert your edit, route through a different file)?
4. **For "amend needed":** run `caws specs amend-scope <SPEC-ID> --add <path>`
   (writes canonical, no cherry-pick), then ask the user to run `bash
   .claude/hooks/reset-strikes.sh --current`. The reset is required because fixing
   scope alone does NOT re-evaluate prior strikes — the file stays "hot" at its
   accumulated count.
5. **For "genuinely out":** revert your edit, route the change through an
   in-scope file, and document the decision in the next commit message.
