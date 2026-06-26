# CLAUDE.md

Project-specific doctrine for Claude Code agents working on the CAWS repository.
This file carries the durable *why/what* that shapes how you work here; the live
command surface and step-by-step procedure live in the docs it points to (they
track the current version — this file does not enumerate it, so it can't drift).

## This repo self-hosts

CAWS (Coding Agent Working Standard) is both the framework and a live user of
it. The `.caws/` directory drives real quality gates on this codebase — when you
work here you are governed by the system you are changing.

**The command surface, its lifecycle, and what's removed/deferred are doctrine
in `docs/architecture/caws-vnext-command-surface.md` (read §1 cutover posture,
§6 architectural invariants) and the `caws` skill — which track the live
version.** Do not enumerate the command list here; if you need the current
surface, run `caws <group> --help` or read the doctrine doc. Teams migrating
from v10.2 start at `docs/migration-v10-to-v11.md` (it buckets every v10.2
command and gives the rollback one-liner).

## We do not ship buggy runtime code (release stance)

CAWS governs agents by *blocking* them: scope guards, danger latches, lifecycle
refusals, the `amend-scope` control plane. That enforcement only works if the
governed paths are correct. **Every bug left in the runtime CLI or kernel
actively incentivizes agents to look for an exploit to get unblocked.** When a
governed command misbehaves — reports success while doing nothing, refuses a
legitimate operation, or strands state in a contradictory shape — the agent's
local pressure is to route *around* the guard (dodge `git checkout`, hand-edit
the YAML the CLI won't fix, find a different command that achieves the blocked
effect). That is the exact failure mode CAWS exists to prevent, and a runtime
bug is what manufactures it.

Worked example (`CAWS-CLI-AMEND-SCOPE-REMOVE-OUT-QUOTED-NOOP-001`):
`amend-scope --remove-out` silently no-op'd on a quoted `scope.out` entry while
printing "amended scope". An agent, unable to un-fence a path through the
sanctioned command, was pushed toward hand-editing the spec YAML — bypassing the
audit trail. The bug *created* the incentive to circumvent governance.

Therefore the release stance is non-negotiable:

- **A known correctness bug in the CLI or kernel blocks release.** It is not
  backlog; it is a governance hole. Fix it (or, if it genuinely cannot ship in
  time, gate the affected command so it *fails loudly* rather than lying about
  success) before tagging.
- **"Reports success while doing nothing" is the most dangerous class.** A
  command that errors honestly is recoverable; a command that falsely confirms
  leaves the agent trusting a state that never changed, and trains it to stop
  trusting the guard. Prioritize these.
- **The fix must restore the sanctioned path, not just document a workaround.**
  Telling agents "amend-scope can't do X, hand-edit instead" institutionalizes
  the bypass. Make the governed command correct so the audited path is also the
  easy path.
- **When you find one, file a spec and fix it under governance** — the same
  discipline this section protects. Do not patch a control-plane bug off-spec.

The integrity of every guard depends on the integrity of the runtime that
enforces it. Shipping buggy governance code is shipping the incentive to defeat
governance.

## Before you start

1. Run `caws status` and `caws doctor`. The `claim` panel surfaces worktree
   ownership; doctor surfaces drift.
2. For multi-agent work, create your worktree with `caws worktree create <name>
   --spec <id>` — it writes the bidirectional worktree↔spec binding, registers
   ownership, and emits the `worktree_created` + `worktree_bound` events. Loop it
   per spec; there is no `caws parallel setup`.
3. `caws claim` surfaces or takes worktree ownership. `caws claim --takeover`
   acquires from a foreign session and writes a `prior_owners` audit entry.
4. Commit your spec after any change, before creating the worktree — uncommitted
   specs aren't snapshotted into the worktree, and stale spec state causes
   multi-agent confusion.

## Governed paths (require special handling)

- `.caws/policy.yaml` — owns gate `mode` (block/warn/skip). Waivers filter
  violations; they do not change gate mode.
- `CODEOWNERS` — reviewer routing.
- `change_budget` keys in any spec YAML — use waivers, not edits.
- Pre-commit hooks — do not bypass with `--no-verify`.

Legitimate escape: `caws waiver create <id> --gate <gate> --reason "..."
--approved-by "..." --expires-at <iso8601>` (singular `waiver`, not plural).

## Spec authoring — the recurring traps

These patterns waste scope-strike budget and force mid-implementation rewrites.
Get them right at spec-activation time:

1. **`scope.in` paths must match real file extensions.** Test files are
   `*.test.js`, not `*.test.ts`, even when the production code is TypeScript.
   `ls` the test directory before authoring `scope.in` lines for tests.
2. **`scope.out` cannot contain glob patterns.** `.github/workflows/**` is
   rejected (`spec.schema.scope.out_glob_forbidden`). Use directory paths only:
   `.github/workflows`, `packages/foo` — never `packages/foo/**`.
3. **Tier 1/2 require `contracts`.** A genuinely cross-package tier-2 slice
   declares a contract; a structural chore sets `mode: chore` (no contracts
   required). Mode and commit type are separate concerns — the release guard
   reads the commit-message scope (`fix(cli):` publishes), not the spec mode.
4. **`scope.out` is enforcement, not documentation.** Listing a sibling spec's
   `scope.in` paths in your `scope.out` refuses YOUR edits to those paths in
   union mode. Omit the entry, or accept you cannot edit those paths.
5. **Kernel-change escape must be explicit.** The scope guard treats
   `packages/caws-kernel/src` as a literal prefix. If a kernel change proves
   necessary, amend the *specific* file into `scope.in` (e.g.
   `.../schemas/events/spec_closed.v1.json`) — that admits it while leaving the
   rest of the kernel out.
6. **`non_functional` admits exactly four subkeys:** `accessibility`,
   `performance`, `reliability`, `security` (`additionalProperties: false` in
   `packages/caws-kernel/src/schemas/spec.v1.json`). Observability belongs under
   `reliability`; anything else is `spec.schema.violation`.
7. **Releases are tag-driven; branch pushes never publish.** The Release
   workflow triggers only on `caws-cli-v*` tag pushes. The maintainer bumps
   `package.json`, authors the `CHANGELOG.md` section, commits, then pushes the
   canonical tag; CI publishes that content verbatim and never modifies a branch.
   Bare `v*` and `caws-kernel-v*` tags are refused. Full procedure (including the
   asymmetric pre/post-publish failure invariant): `docs/release-procedure.md`.

## Scope is an agreement (and the sparse checkout hides nothing)

A spec's `scope.in` is the explicit surface you agree to touch for this slice;
everything else (READMEs, sibling source, meta/process files) is out-of-scope
**on purpose**, not by accident — that bounded blast radius is the isolation CAWS
exists to provide. When a legitimate edit falls outside the surface, the answer
is never "bypass the guard" — it is to widen the agreement with `caws specs
amend-scope <id> --add <path>` (auditable, attributed to a commit), or to do
non-slice work from the canonical checkout under no binding.

Two things a first-timer conflates — kept separate:

- **The linked-worktree sparse checkout (`/*` + `!/.caws/specs/`) materializes
  everything except `.caws/specs/`.** `CLAUDE.md`, `package.json`, and every
  source file at the repo root and below are present in your worktree the moment
  it is created. There is no "the file wasn't checked out, so I can't bring it
  into scope" problem. Bringing any in-tree path into scope after checkout is
  purely a control-plane op — `amend-scope` — and the worktree's `caws scope
  check` ADMITs it immediately, no re-checkout and no `git cherry-pick`.
- **`.caws/specs/` is the one thing sparse-checkout withholds**, because the
  canonical `.caws/specs/` at the main checkout is the *only* authority for spec
  content. Never read/edit `<worktree>/.caws/specs/*` and never `git
  sparse-checkout disable` — both re-open the v10.2 split-brain class and are
  refused by the worktree guards. Read specs from any cwd via `caws specs show
  <id>` / `caws specs list` (they resolve through canonical). Scope is enforced
  by `scope-guard.sh` reading `scope.in`/`scope.out` from canonical; sparse
  checkout is a *materialization/recovery* invariant, not the authority or
  scope-enforcement model. (`caws worktree repair-sparse <name>` non-destructively
  restores the invariant if a tree ends up with materialized `.caws/specs/*`.)

## Pre-edit admission (prove scope before you edit)

`caws scope show <path>` is a **pre-edit admission check, not a post-failure
diagnostic.** Every commit inside a bound worktree begins with a preflight proof
block before any file write — including probe scripts, scratch files, and
redirected diagnostic output, which are write targets too (there is no "it's
just a scratch file" exception; do not write under `/tmp/`, use `node -e`/stdout
capture or a temporary `console.log` in an already-admitted test file).

Output this block as text in your response before any write tool call:

```text
Commit <N> preflight:

Branch:
- <branch name>

Planned write targets:
- <path> (CREATE | MODIFY)
- ...

Scope proof:
- caws scope show <path> => <ADMIT | REFUSE>
- ...

No edits before this proof is complete.
```

Then run the `caws scope show` calls; edit only if every target returns ADMIT.
On a REFUSE: stop, run **one** `caws specs amend-scope <SPEC-ID> --add <path>...`
(all missing paths in a single call — canonical write, no cherry-pick), rerun
the proof, then edit.

**Demote intuition; trust proof.** If your mental model says "this file is
obviously in scope" but you haven't run `caws scope show`, your mental model has
no authority — the kernel's scope decision is the only authority. The cost of
four `caws scope show` calls is ~six seconds; the cost of one strike +
amendment + reset + explanation is several minutes of your turn and the user's.
The asymmetry is severe.

**Why this is doctrine and not just a hook:** the hook fires *after* the edit
attempt — by then the strike is on the counter, the file is hot, and recovery
needs user intervention. The preflight is the only thing that prevents the
strike, because it runs before the edit, in your reasoning, not after, in the
kernel's enforcement. An edit-before-proof creates the same "guard exists but
the invariant was bypassed" drift class (half-state worktrees, stale bindings,
unfiled defects) that failure-lineage Entry 21 names as a load-bearing v11
lesson.

**The full procedure — post-edit verification, the diagnostic-files rule, the
strike-state mechanics, and the recovery checklist — is in
[`docs/agents/scope-discipline.md`](docs/agents/scope-discipline.md).** Scope
amendments are welcome (they're auditable); what burns time is discovering the
gap one strike at a time. Plan scope before editing, not after the strike.

## Worktree discipline

When git worktrees are active for parallel work:

- Work only in your assigned worktree; use the main repo's venv (`source
  <main-repo>/.venv/bin/activate`), not a per-worktree one.
- `caws claim` shows ownership; `caws claim --takeover` acquires from a foreign
  session and writes a durable `prior_owners` audit.
- Use the lifecycle commands (`caws worktree create | list | bind | destroy |
  merge | migrate-registry | repair-sparse | repair`) — do not fall back to raw
  `git worktree`/`git merge` by default.
- **`caws worktree merge <name>` is the governed merge path** — one transaction:
  `git checkout <base>` + `git merge --no-ff` + auto-close the bound spec
  (`spec_closed`) + append `worktree_merged`, over the flat-map `worktrees.json`.
  Prefer it over a manual `git checkout main && git merge`: a bare `git checkout
  <existing-branch>` is flagged by the danger-latch classifier as potentially
  discarding work (only `checkout -b` is auto-admitted), so the manual path can
  trip the latch and need a human reset. The governed command does the base
  checkout *inside* the transaction and avoids that trap.

Full list: `.claude/rules/worktree-isolation.md`.

## Spec lifecycle

- Specs live at `.caws/specs/<id>.yaml` (no project-level working spec).
  Acceptance criteria use Given/When/Then (see existing specs for the shape).
- **Lifecycle exits by current state:** active → `caws specs close`; closed →
  `caws specs archive`; never-activated draft → `caws specs retire-draft <id>`.
  retire-draft is the governed draft exit — it tombstones the YAML and appends a
  recoverable `spec_retired` event (recover via `caws specs show <id>
  --archived`). **Never `git rm` a spec** to retire it — raw deletion bypasses
  the YAML-state audit, the hash-chained event, and the recovery path. `caws
  specs create` always makes *active* specs, so a `draft` on disk is
  hand-authored or residue, and retire-draft is its sanctioned removal.

## Implementation hygiene (lessons from prior sessions)

- **Inspect the Outcome, not just the Result.** The store layer wraps both
  `{ kind: 'success' }` and `{ kind: 'partial_failure_recovered' }` in `ok()`.
  Checking only `isOk(result)` treats a rolled-back transaction as success.
  Always inspect `result.value.kind !== 'success'` for store-layer outcomes,
  especially in composed lifecycle commands (`mergeWorktree → closeSpec`).
- **Event-data fields must match the kernel schema.** Event payloads under
  `packages/caws-kernel/src/schemas/events/*.v1.json` use
  `additionalProperties: false`. A new field added at the call site without
  amending the schema is rejected by the lifecycle validator → rollback →
  surfaces as `partial_failure_recovered`. Update the kernel schema *first* (and
  put it in `scope.in`).
- **Don't `git stash` while turbo dist is built.** Stash reverts the working
  tree but turbo's `dist/` reflects pre-stash source, so tests load stale
  `../../dist/...`. If you must stash, force-rebuild
  (`turbo run build --filter=@paths.design/caws-cli... --force`) both after the
  stash and after the pop — turbo caches by source hash, not working-tree state.
- **Babel parse errors point at the wrong line.** A redeclared `const` in a Jest
  test produces a multi-page `parseExpression` trace, not "duplicate
  declaration". First step: `grep -n "const <var> =" path/to/test.js` for two
  declarations in the same `it()` block.
- **`npm whoami` vs token auth are different identities.** With 2FA, interactive
  `npm publish` needs `--otp=<code>` even after `npm login`. A granular token
  with "bypass 2FA for write actions" works for `NPM_TOKEN` CI publishes but not
  `npm whoami` sessions — `EOTP` with a valid `npm whoami` means use the token
  via env, not the interactive session.

## Bash hook latches

The hook pack includes a "danger latch" that fires on certain Bash patterns
(force-push, `reset --hard`, `rebase`, `cherry-pick`, `clean -f`, bare
`checkout <path>`, deleted-tag pushes, pipe-to-shell, the `git init` family). If
it fires once, **every subsequent Bash call in the session blocks** until a
human runs `bash .claude/hooks/reset-danger-latch.sh`. There is no agent-side
dismissal by design. If you trip it, stop and ask the user to reset — do NOT
re-run the command in a different shape (`command git ...`, `env ... git ...`,
`bash -lc '...'`); the latch recognizes those variants, and shell trickery to
bypass it is exactly the pattern it's there to catch.

## Decision cadence (act from local authority)

Default to the narrowest reversible decision supported by local repo authority;
do not stop merely because there is ambiguity. Before asking the maintainer, do
one cheap grounding pass against (1) the active spec — scope, invariants,
acceptance, closure notes; (2) repo doctrine — this file, the command-surface
and release docs, architecture notes; (3) existing code, tests, scripts, CLI
help; (4) recent commits governing the slice. If one path is locally supported,
reversible, and within scope, take it — state the decision briefly and continue.

**Ask for direction only on true blockers:** external/irreversible mutation
(`npm publish`/`dist-tag`, tag push, force-push, unpublish, destructive
deletion); a scope conflict not resolvable via the correct bound worktree or an
existing CAWS command; a direct contradiction between active specs or between a
spec and governed implementation; missing credentials/files/evidence; any action
that would edit guard state, spoof ownership/session state, bypass safety
checks, or rewrite another active spec's contract; a broad refactor or policy
change outside the current spec.

**Do not ask merely because:** multiple shapes exist but one is narrowest and
evidence-supported; a test/CI failure has a clear local root cause; a small
follow-up/hotfix spec is the obvious governance shape; a command failed once and
the next diagnostic step is obvious; existing specs/docs already answer it.

**Failure cadence:** classify the failure → identify the narrowest admissible
fix → if reversible and in scope, do it → if out of scope but small and local,
open a focused hotfix spec and proceed under it → if external/irreversible/
credential-bound/safety-bound, stop with a precise handoff. The anti-pattern to
avoid: turning a stale local assertion into a three-option menu when the spec,
source, and CI log support a narrow hotfix.

Tool-call discipline: every command advances the slice; don't re-inspect the
same help/registry/ownership/logs after the blocker is classified; prefer one
decisive grounding pass over many probes; report meaningful work output, not a
play-by-play of hesitation.

## Test suite

- CLI tests (vNext shell + store): `cd packages/caws-cli && npx jest`
- Kernel tests: `cd packages/caws-kernel && npm test`
- Per `~/.claude/CLAUDE.md` and `~/Desktop/Projects/CLAUDE.md`: interpret pass
  counts critically, print the concrete runtime artifacts the scenario produced,
  cite specific evidence, name the false-confidence risks, and state what
  artifact/instrumentation/check is still missing if the proof is insufficient.

## References

- `docs/architecture/caws-vnext-command-surface.md` — **doctrine source**: cutover
  posture, kept/removed commands, architectural invariants.
- `docs/agents/scope-discipline.md` — pre-edit admission procedure, strike-state
  mechanics, scope-authoring habits, recovery checklist.
- `docs/migration-v10-to-v11.md` — v10.2→v11 command buckets + rollback.
- `docs/release-procedure.md` — tag-driven release procedure + failure invariant.
- `AGENTS.md` / `docs/agents/full-guide.md` — agent quickstart and full workflow.
- `.claude/rules/` — git-safety + worktree-isolation rules (auto-loaded).
