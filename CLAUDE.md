# CLAUDE.md

The rules most tasks in the CAWS repository need. Each section names the doc
that holds its full procedure and reasoning; `AGENTS.md` and
`docs/agents/full-guide.md` cover the whole agent workflow.

## This repo self-hosts

CAWS (Coding Agent Working Standard) is both the framework and a live user of
it: `.caws/` drives real quality gates here, so you are governed by the system
you are changing. Command-surface doctrine (§1 cutover posture, §6 architectural
invariants) is `docs/architecture/caws-vnext-command-surface.md`; for the live
surface run `caws <group> --help`. v10.2 migration:
`docs/migration-v10-to-v11.md`.

## Coding rigor

Scale verification to risk ([full procedure](docs/guides/coding-rigor.md)).

- **Establish context and authority**: revision, actual diff/base, owned
  worktree/spec and consumer contract. A review authorizes findings; fixes,
  evidence recording and publication need their own authorization.
- **Define acceptance before completion**: each criterion gets an observable
  result, a specific check and a counterexample that must fail.
- **Trace behavior and challenge the tests**: follow the entry point to the
  consumer-visible result, including rejection, partial failure and cleanup.
  Never lower declared floors to manufacture success.
- **Retain and bound evidence**: cite command, cwd/revision, exit status and
  relevant output. Distinguish source review, tests, installed-package behavior,
  recorded acceptance, CI, merge and deployment, and name what was not verified.

## Runtime bugs block release

CAWS governs agents by blocking them, so a bug in a governed path is a
governance hole: it pushes the blocked agent to route around the guard.
Rationale and worked example: `docs/release-procedure.md`, "Runtime correctness
blocks release".

- **A known correctness bug in the CLI or kernel blocks release.** Fix it before
  tagging; only if the fix genuinely cannot ship in time, gate the affected
  command so it fails loudly.
- **"Reports success while doing nothing" is the most dangerous class.**
  Prioritize it.
- **Restore the sanctioned path; don't document a workaround.** The audited path
  must also be the easy path.
- **File a spec and fix it under governance**; never patch one off-spec.
- **Releases are tag-driven:** only a `caws-cli-v*` tag push publishes; branch
  pushes never do. Procedure: `docs/release-procedure.md`.

## Before you start

1. Run `caws status` and `caws doctor`: the claim panel shows worktree
   ownership, doctor shows drift.
2. Create your worktree with `caws worktree create <name> --spec <id>`. It binds
   the spec, registers ownership and confers write authority. Loop it per spec;
   there is no `caws parallel setup`.
3. `caws claim` shows ownership; `--takeover`, only with explicit user
   authorization, acquires it and writes a `prior_owners` audit.
4. Commit your spec after any change, before creating the worktree. Uncommitted
   specs aren't snapshotted into it.

## Governed paths (require special handling)

- `.caws/policy.yaml` — owns gate `mode` (block/warn/skip). Waivers filter
  violations; they do not change gate mode.
- `CODEOWNERS` — reviewer routing.
- Pre-commit hooks — do not bypass with `--no-verify`.

What lifts a block depends on the block; a waiver lifts none of the three below
(it only filters `caws gates run` violations):

- A hook handler's refusal (`protected-paths.sh`, `scope-guard.sh` and the other
  PreToolUse guards): `caws reprieve grant`, run by a human, session- and
  repo-scoped and expiring. An agent cannot grant its own.
- A `.caws/policy.yaml` change: an Edit under an active spec whose `scope.in`
  admits the path (widen it with `caws specs amend-scope`). Never a naked
  `rm`/`mv`.
- `--no-verify` on a pre-commit hook: nothing. It is not an available escape.

Risk-tier budgets (`budget_limit`) are advisory: overages are reported, never
block (even under `mode: block`) and need no waiver. Don't trim, defer or stub
work to fit one; note an outgrown plan in the spec.

## Spec authoring — the recurring traps

Get these right at activation time; each one otherwise costs a strike or a
mid-implementation rewrite.

1. **`scope.in` paths must match real extensions.** Tests are `*.test.js` even
   when the source is TypeScript; `ls` the test directory first.
2. **`scope.out` rejects globs** (`spec.schema.scope.out_glob_forbidden`). Use
   directory paths: `packages/foo`, never `packages/foo/**`.
3. **New specs have no risk tier** (existing tiered specs stay readable; new
   authoring neither chooses nor infers one). Declare contracts and operational
   requirements when they describe the work. Mode and commit type are separate.
4. **`scope.out` is enforcement, not documentation.** Listing a sibling spec's
   `scope.in` paths there refuses _your_ edits to them.
5. **Kernel changes need an explicit file.** The scope guard treats
   `packages/caws-cli/src/kernel` as a literal prefix; amend the specific file
   (e.g. `.../schemas/events/spec_closed.v1.json`) into `scope.in`.
6. **`non_functional` admits exactly** `accessibility`, `performance`,
   `reliability` and `security` (`additionalProperties: false` in
   `packages/caws-cli/src/kernel/schemas/spec.v1.json`). Observability belongs
   under `reliability`; anything else is `spec.schema.violation`.

## Scope and pre-edit admission

A spec's `scope.in` is the surface you agreed to touch; everything else is out
of scope on purpose. When a legitimate edit falls outside it, widen the
agreement with `caws specs amend-scope <id> --add <path>`, or do non-slice work
from the canonical checkout under no binding. Never bypass the guard.

**Inside a bound worktree, prove scope before every write**, including probe
scripts, scratch files and redirected output (do not write under `/tmp/`).
Output a preflight block as text (branch, planned write targets marked
CREATE/MODIFY, the `caws scope show <path>` result for each, and "No edits
before this proof is complete."), then run the bare `caws scope show` calls and
dispatch on the result:

- **ADMIT**: proceed.
- **REFUSE**: run **one** `caws specs amend-scope <SPEC-ID> --add <path>...`
  naming every missing path, rerun the proof, then edit.
- **NO AUTHORITY** (`scope.no_authority.unbound`): no spec is bound to this
  checkout, and `amend-scope` cannot fix it. Create or enter the worktree, then
  rerun the proof.

For a new spec the worktree must exist before any file is written under that
spec's authority: author → `caws specs validate .caws/specs/<id>.yaml` → commit
spec → `caws worktree create <name> --spec <id>` → `cd` into it → write. Working
solo does not exempt you. `caws scope show <path> --spec <id>` asks a
hypothetical ("would this fit that spec?") and is never write authority.

Linked worktrees materialize everything except `.caws/specs/`; canonical is the
only spec authority. Never read or edit `<worktree>/.caws/specs/*` and never run
`git sparse-checkout disable`. Read specs with `caws specs show <id>` or
`caws specs list`.

Preflight template, post-edit verification, strike mechanics, recovery and the
reasoning behind all of this:
[`docs/agents/scope-discipline.md`](docs/agents/scope-discipline.md).

## Worktree discipline

`.claude/rules/worktree-isolation.md` (auto-loaded) holds the full rules: never
`git checkout -b` in canonical, merge only with `caws worktree merge`, use the
main repo's venv. In addition:

- Use the `caws worktree` lifecycle commands (`caws worktree --help` lists
  them), not raw `git worktree`/`git merge`.
- **DSH self-claim divergence**: a refusal on a worktree you just created whose
  owner is your own session id in another form (bare `<uuid>` vs
  `session-<uuid>`) is a legacy-stamped lane, not a foreign session. If the uuid
  matches `DSH_SESSION_ID` minus `session-`, run `caws claim --takeover` from
  inside the worktree; a genuinely foreign owner still needs user authorization.

## Spec lifecycle

Specs live at `.caws/specs/<id>.yaml`; acceptance criteria use Given/When/Then.

- `draft` is the normal resting state and `active` means bound and being worked.
  `caws worktree create` activates a spec; `caws worktree destroy` returns it to
  draft when the branch never moved; with no worktree in play,
  `caws specs activate` / `deactivate` move it. An active spec with no bound
  worktree is the drift signal; `caws doctor` counts them and escalates past
  ten.
- Exit by current state: active → `caws specs close`; closed →
  `caws specs archive`; a never-activated draft you have decided against →
  `caws specs retire-draft <id>` (recover with
  `caws specs show <id> --archived`). **Never `git rm` a spec.**

## Implementation hygiene

- **Inspect the Outcome, not just the Result.** The store layer wraps both
  `{ kind: 'success' }` and `{ kind: 'partial_failure_recovered' }` in `ok()`.
  Check `result.value.kind !== 'success'`, especially in composed lifecycle
  commands (`mergeWorktree → closeSpec`).
- **Update the event schema first.** Payloads under
  `packages/caws-cli/src/kernel/schemas/events/*.v1.json` use
  `additionalProperties: false`; a new call-site field is rejected, rolls back
  and surfaces as `partial_failure_recovered`. Put the schema in `scope.in`.
- Build and test pitfalls (stale turbo `dist/` after `git stash`, misplaced
  Babel parse errors): `CONTRIBUTING.md`. `npm whoami` vs token auth:
  `docs/NPM_PUBLISHING_TEST.md`.

## Shared runtime and hooks

Project `.caws/` owns governance; `~/.caws` owns shared executable snapshots,
dispatch, renderers and harness adapters.

- **A local build does not change the `caws` command.** It is a pinned snapshot
  under `~/.caws/lib/cli/<release>/`. Activation, the load-bearing upgrade order
  (CLI package → shared runtime → native registration) and how to verify it:
  `CONTRIBUTING.md`, "Activating your build as the `caws` command".
- **Two hook copies are live.** Claude Code and Codex run guards from `~/.caws`;
  qwen-code, kimi-code, opencode, zcode and dsh exec
  `.caws/hooks/dispatch/<event>.sh` directly. An edit under `.caws/hooks/` is
  invisible from Claude but live for those five. **Never delete or prune
  `.caws/hooks/`.** **Extend guards; do not fork them:** declare repo-specific
  behavior in `.caws/hooks/hook-policy.json` (agent-write-blocked by design).
  Both are detailed in `docs/architecture/repo-local-hook-policy.md`.
- Reprieves are human-granted, cover one session in one repo (`--all-repos`
  widens that), and refuse a grant covering only part of a handler set that
  jointly enforces one boundary. See `caws reprieve grant --help`.

## Bash hook latches

The danger latch fires on catastrophic Bash patterns (force-push,
`reset --hard`, `rebase`, `cherry-pick`, `clean -f`, bare `checkout <path>`,
deleted-tag pushes, pipe-to-shell, the `git init` family). Once it fires the
session is quarantined: only fixed read-only commands and the reset run, every
other Bash, Write or Edit is a strike, and on kill-enabled surfaces the first
such attempt ends the session's process (identity-verified SIGTERM). There is no
agent-side dismissal. **Stop and hand the user the reset command the block
message prints** (human recovery:
[`docs/guides/hook-packs.md`](docs/guides/hook-packs.md#human-latch-recovery);
legacy reset scripts live under `.caws/hooks/`). Never re-run the command in
another shape (`command git ...`, `env ... git ...`, `bash -lc '...'`): the
latch recognizes those variants.

## Decision cadence

Take the narrowest reversible decision local authority supports; ambiguity alone
is no reason to stop. First do one grounding pass (the active spec, this file
and the doctrine docs it names, existing code/tests/help, recent commits on the
slice); if one path is supported, reversible and in scope, state it and
continue.

**Ask only on true blockers:** external or irreversible mutation
(`npm publish`/`dist-tag`, tag push, force-push, unpublish, destructive
deletion); a scope conflict no bound worktree or CAWS command resolves; a
contradiction between active specs, or between a spec and governed code; missing
credentials, files or evidence; anything that edits guard state, spoofs
ownership or session state, bypasses safety checks or rewrites another active
spec's contract; a broad refactor or policy change outside the current spec.
These are not blockers: several shapes where one is narrowest, a failure with a
clear local root cause, an obvious hotfix spec, a command that failed once with
an obvious next diagnostic, a question the docs already answer.

**On failure:** classify it → find the narrowest admissible fix → if reversible
and in scope, do it → if small, local and out of scope, open a focused hotfix
spec and proceed under it → if external, irreversible, credential-bound or
safety-bound, stop with a precise handoff. Once a blocker is classified, stop
re-inspecting the same help, registry or logs, and report work output rather
than a play-by-play of hesitation.

## Test suite

`cd packages/caws-cli && npx jest` runs the shell, store and absorbed kernel
(`src/kernel`) tests. Report what ran, its runtime artifacts and its
false-confidence risks, not just the pass count.
