# CLAUDE.md

Project-specific doctrine for Claude Code agents working on the CAWS repository.
This file carries the durable _why/what_ that shapes how you work here; the live
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

CAWS governs agents by _blocking_ them: scope guards, danger latches, lifecycle
refusals, the `amend-scope` control plane. That enforcement only works if the
governed paths are correct. **Every bug left in the runtime CLI or kernel
actively incentivizes agents to look for an exploit to get unblocked.** When a
governed command misbehaves — reports success while doing nothing, refuses a
legitimate operation, or strands state in a contradictory shape — the agent's
local pressure is to route _around_ the guard (dodge `git checkout`, hand-edit
the YAML the CLI won't fix, find a different command that achieves the blocked
effect). That is the exact failure mode CAWS exists to prevent, and a runtime
bug is what manufactures it.

Worked example (`CAWS-CLI-AMEND-SCOPE-REMOVE-OUT-QUOTED-NOOP-001`):
`amend-scope --remove-out` silently no-op'd on a quoted `scope.out` entry while
printing "amended scope". An agent, unable to un-fence a path through the
sanctioned command, was pushed toward hand-editing the spec YAML — bypassing the
audit trail. The bug _created_ the incentive to circumvent governance.

Therefore the release stance is non-negotiable:

- **A known correctness bug in the CLI or kernel blocks release.** It is not
  backlog; it is a governance hole. Fix it (or, if it genuinely cannot ship in
  time, gate the affected command so it _fails loudly_ rather than lying about
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
2. For multi-agent work, create your worktree with
   `caws worktree create <name> --spec <id>` — it writes the bidirectional
   worktree↔spec binding, registers ownership, and emits the
   `worktree_created` + `worktree_bound` events. Loop it per spec; there is no
   `caws parallel setup`.
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

Legitimate escape:
`caws waiver create <id> --title "<title>" --gate <gate> --reason "..." --approved-by "..." --expires-at <iso8601>`
(singular `waiver`, not plural; `--title` is required).

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
   `packages/caws-cli/src/kernel` as a literal prefix. If a kernel change proves
   necessary, amend the _specific_ file into `scope.in` (e.g.
   `.../schemas/events/spec_closed.v1.json`) — that admits it while leaving the
   rest of the kernel out.
6. **`non_functional` admits exactly four subkeys:** `accessibility`,
   `performance`, `reliability`, `security` (`additionalProperties: false` in
   `packages/caws-cli/src/kernel/schemas/spec.v1.json`). Observability belongs
   under `reliability`; anything else is `spec.schema.violation`.
7. **Releases are tag-driven; branch pushes never publish.** The Release
   workflow triggers only on `caws-cli-v*` tag pushes. The maintainer bumps
   `package.json`, authors the `CHANGELOG.md` section, commits, then pushes the
   canonical tag; CI publishes that content verbatim and never modifies a
   branch. Bare `v*` and `caws-kernel-v*` tags are refused. Full procedure
   (including the asymmetric pre/post-publish failure invariant):
   `docs/release-procedure.md`.

## Scope is an agreement (and the sparse checkout hides nothing)

A spec's `scope.in` is the explicit surface you agree to touch for this slice;
everything else (READMEs, sibling source, meta/process files) is out-of-scope
**on purpose**, not by accident — that bounded blast radius is the isolation
CAWS exists to provide. When a legitimate edit falls outside the surface, the
answer is never "bypass the guard" — it is to widen the agreement with
`caws specs amend-scope <id> --add <path>` (auditable, attributed to a commit),
or to do non-slice work from the canonical checkout under no binding.

Two things a first-timer conflates — kept separate:

- **The linked-worktree sparse checkout (`/*` + `!/.caws/specs/`) materializes
  everything except `.caws/specs/`.** `CLAUDE.md`, `package.json`, and every
  source file at the repo root and below are present in your worktree the moment
  it is created. There is no "the file wasn't checked out, so I can't bring it
  into scope" problem. Bringing any in-tree path into scope after checkout is
  purely a control-plane op — `amend-scope` — and the worktree's
  `caws scope check` ADMITs it immediately, no re-checkout and no
  `git cherry-pick`.
- **`.caws/specs/` is the one thing sparse-checkout withholds**, because the
  canonical `.caws/specs/` at the main checkout is the _only_ authority for spec
  content. Never read/edit `<worktree>/.caws/specs/*` and never
  `git sparse-checkout disable` — both re-open the v10.2 split-brain class and
  are refused by the worktree guards. Read specs from any cwd via
  `caws specs show <id>` / `caws specs list` (they resolve through canonical).
  Scope is enforced by `scope-guard.sh` reading `scope.in`/`scope.out` from
  canonical; sparse checkout is a _materialization/recovery_ invariant, not the
  authority or scope-enforcement model. (`caws worktree repair-sparse <name>`
  non-destructively restores the invariant if a tree ends up with materialized
  `.caws/specs/*`.)

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
- caws scope show <path> => <ADMIT | REFUSE | NO AUTHORITY>
- ...

No edits before this proof is complete.
```

Then run the `caws scope show` calls; edit only if every target returns ADMIT.
The kernel has **three** outcomes, not two — dispatch on which one you got:

- **ADMIT** — proceed.
- **REFUSE** — stop, run **one**
  `caws specs amend-scope <SPEC-ID> --add <path>...` (all missing paths in a
  single call — canonical write, no cherry-pick), rerun the proof, then edit.
- **NO AUTHORITY** (`scope.no_authority.unbound`) — _no spec is bound to this
  checkout_, so the kernel cannot decide scope at all. This is not an edge case:
  it is the outcome for every new spec before its worktree exists. `amend-scope`
  does **not** fix it — the path may already be in `scope.in` and the edit will
  still refuse. Create or enter the worktree (below), then rerun the proof.

**The worktree-before-code ordering invariant.** For a new spec, the worktree
must exist _before_ any file is written under that spec's authority:

```
author spec → caws specs validate .caws/specs/<id>.yaml → commit spec → caws worktree create <name> --spec <id> → cd into it → then write
```

This is not a multi-agent nicety — the worktree is what _confers write
authority_. Working solo does not exempt you; skipping it produces NO AUTHORITY
on every path and a strike on every edit.

**`--spec` answers a different question than the bare form.**
`caws scope show <path>` asks _may I write here now?_;
`caws scope show <path> --spec <id>` asks _would this path fit that spec?_ — a
hypothetical. The `--spec` form prints `binding: bound` referring to the **named
spec**, not your checkout, so from an unbound checkout it can read as authority
it does not grant. Only the bare form proves write authority. Use `--spec` to
choose an authority before creating a worktree, never as your pre-edit proof.

**Demote intuition; trust proof.** If your mental model says "this file is
obviously in scope" but you haven't run `caws scope show`, your mental model has
no authority — the kernel's scope decision is the only authority. The cost of
four `caws scope show` calls is ~six seconds; the cost of one strike +
amendment + reset + explanation is several minutes of your turn and the user's.
The asymmetry is severe.

**Why this is doctrine and not just a hook:** the hook fires _after_ the edit
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

- **Never `git checkout -b` in the canonical checkout.** Canonical's HEAD is
  shared state: every session's CAWS lifecycle auto-commit (`specs evidence`,
  `specs close`, `worktree bind`/`destroy`) lands on whatever branch canonical
  has checked out, whoever created it. Because `.caws/specs/` is canonical-only,
  a peer's evidence recorded while canonical was parked on your branch is
  invisible to the base branch — and their next governed `worktree merge`
  computes against the base's evidence-free copy and auto-closes the spec over
  it, dropping the proof while reporting success. "Branch first" is right; in
  this repo the mechanism is `caws worktree create <name> --spec <id>`, which
  gives you a branch and write authority without moving canonical's HEAD.
- Work only in your assigned worktree; use the main repo's venv
  (`source <main-repo>/.venv/bin/activate`), not a per-worktree one.
- `caws claim` shows ownership; `caws claim --takeover` acquires from a foreign
  session and writes a durable `prior_owners` audit.
- **DSH self-claim divergence**: a refusal on a worktree you just created, where
  the owner id is your own session id in another form (bare `<uuid>` vs
  `session-<uuid>` — CAWS-SESSION-RESOLVER-GUARD-DIVERGENCE-001), is a
  legacy-stamped lane, not a foreign session. Verify the uuid matches your
  `DSH_SESSION_ID` minus the `session-` prefix, then reclaim with
  `caws claim --takeover` from inside the worktree — it restamps the owner
  through the current resolver and writes the `prior_owners` audit. A genuinely
  foreign owner still requires explicit user authorization.
- Use the lifecycle commands
  (`caws worktree create | list | bind | destroy | merge | migrate-registry | repair-sparse | repair`)
  — do not fall back to raw `git worktree`/`git merge` by default.
- **`caws worktree merge <name>` is the governed merge path, and it is safe
  under concurrent agents.** It never checks out the base branch. The merge is
  computed in the object database (`git merge-tree --write-tree` +
  `git commit-tree`) and the base ref advances by an atomic compare-and-swap
  (`git update-ref <ref> <new> <expected-old>`). One transaction: merge +
  auto-close the bound spec (`spec_closed`) + append `worktree_merged` + delete
  the merged branch (`git branch -d`, never `-D`), over the flat-map
  `worktrees.json`.
- **A lost race is a retry, not a failure.** If another agent advances the base
  between the merge computation and the CAS, git refuses the ref update ("is at
  X but expected Y") and the merge recomputes against the new base, up to 5
  attempts. Nothing partial is written: the objects created before the CAS are
  unreferenced and therefore invisible, so an interrupted merge leaves no
  half-applied state. Only a real conflict, or exhausting the retry budget,
  surfaces as an error — and the diagnostic distinguishes the two.
- **Prefer the governed command over hand-running git.** A manual
  `git checkout main && git merge` reintroduces exactly the hazard the CAS
  removes: the base checkout mutates the shared working tree, and a bare
  checkout of an existing branch is flagged by the danger-latch classifier as
  potentially discarding work (only `checkout -b` is auto-admitted). The
  governed path touches no working tree at all.

Full list: `.claude/rules/worktree-isolation.md`.

## Spec lifecycle

- Specs live at `.caws/specs/<id>.yaml` (no project-level working spec).
  Acceptance criteria use Given/When/Then (see existing specs for the shape).
- **Lifecycle exits by current state:** active → `caws specs close`; closed →
  `caws specs archive`; never-activated draft → `caws specs retire-draft <id>`.
  retire-draft is the governed draft exit — it tombstones the YAML and appends a
  recoverable `spec_retired` event (recover via
  `caws specs show <id> --archived`). **Never `git rm` a spec** to retire it —
  raw deletion bypasses the YAML-state audit, the hash-chained event, and the
  recovery path.
- **`active` means bound and being worked; `draft` is the normal resting
  state.** `caws specs create` writes a _draft_;
  `caws worktree create <name> --spec <id>` activates it inside the transaction
  that binds it, and `caws worktree destroy` returns it to draft when the branch
  never moved off its fork point. So a draft on disk is the ordinary case — an
  unstarted or paused slice — NOT residue, and retire-draft is for the ones you
  have decided against, not for every draft you find. `caws specs activate` /
  `caws specs deactivate` still move a spec between the two states directly when
  there is no worktree in play. An active spec with no bound worktree is the
  drift signal; `caws doctor` reports the count and escalates it to an error
  past ten.

## Implementation hygiene (lessons from prior sessions)

- **Inspect the Outcome, not just the Result.** The store layer wraps both
  `{ kind: 'success' }` and `{ kind: 'partial_failure_recovered' }` in `ok()`.
  Checking only `isOk(result)` treats a rolled-back transaction as success.
  Always inspect `result.value.kind !== 'success'` for store-layer outcomes,
  especially in composed lifecycle commands (`mergeWorktree → closeSpec`).
- **Event-data fields must match the kernel schema.** Event payloads under
  `packages/caws-cli/src/kernel/schemas/events/*.v1.json` use
  `additionalProperties: false`. A new field added at the call site without
  amending the schema is rejected by the lifecycle validator → rollback →
  surfaces as `partial_failure_recovered`. Update the kernel schema _first_ (and
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

## Shared runtime and native configuration

Project `.caws/` owns governance; `~/.caws` owns shared executable snapshots,
dispatch, renderers and harness adapters.

**These have separate lifecycles and the upgrade order is load-bearing: CLI
package → shared runtime → native registration.** Each step is carried out by
the CLI installed in the step before it, so a stale CLI silently poisons the
steps after it.

1. **CLI package.** The `caws` on your PATH is a _pinned snapshot_ under
   `~/.caws/lib/cli/<release>/`, not a link into this checkout's `dist/` (a link
   would break every project each time you rebuild). A local build therefore
   does NOT change the `caws` command. After `npm run build`, activate it with
   `node scripts/install-cli-snapshot.mjs --package packages/caws-cli --bin "$(command -v caws)"`
   — it packs, installs, smoke-checks in an isolated project, and only then
   swaps the symlink atomically, keeping prior snapshots for rollback.
2. **Shared runtime.** `caws init adapters install` (once per machine).
3. **Native registration.**
   `caws init adapters configure --agent-surface claude-code` for native user
   wiring.

Preview each with `--plan`. Migrate existing project registrations once with
`adapters migrate --agent-surface claude-code`, preserving custom behavior.

**The failure this ordering prevents:** `configure` wires the lifecycle events
_the CLI running it_ knows about. Run it from a stale CLI and it reports `OK`
while writing the old event set; a newer build then refuses with
`System surface settings and native registration disagree; run caws init adapters configure`,
and following that instruction cannot fix it — the remediation names the step
_after_ the one that is actually stale. Verify with content, not version
strings: two builds can both say `12.2.0-rc.2` and differ
(`grep -c session_end "$(dirname "$(readlink -f "$(which caws)")")/init/native-hook-identification.js"`).
Adding an event to `MACHINE_EVENTS` invalidates every configured surface on the
machine, so plan that re-configure as part of the change. Verify native
SessionStart, protected-write refusal, Stop and session rendering inside Claude
before claiming activation. Template availability is not proof. New projects
inherit configured machine behavior; legacy packs use diff/port.

### Which hook copy governs you (two live copies, not one)

Guard scripts exist in two places at once, and **which one executes depends on
the surface, not on the file**:

| Copy                                                               | Executed by             | In this repo                                         |
| ------------------------------------------------------------------ | ----------------------- | ---------------------------------------------------- |
| `~/.caws` (machine runtime, via `~/.caws/bin/caws-hook`)           | machine-routed surfaces | `claude-code`, `codex`                               |
| `.caws/hooks/dispatch/<event>.sh` (project-local, exec'd directly) | project-wired surfaces  | `qwen-code`, `kimi-code`, `opencode`, `zcode`, `dsh` |

The asymmetry is the trap, and it points the opposite way from the obvious
guess. From a Claude Code session, `.claude/settings.json` carries no hook
commands and your guards come from `~/.caws` — so editing `.caws/hooks/` does
nothing you can observe. **It is still not a no-op.** That same edit is live
governance for every project-wired surface: the qwen and kimi shims and the
opencode plugin exec `$ROOT/.caws/hooks/dispatch/<event>.sh` directly, and the
opencode plugin **fails OPEN** when that tree is absent or incomplete. So an
"inert" experiment there can silently disarm another harness's guard plane.

Three consequences:

- **Never delete or prune `.caws/hooks/` as dead weight.** It is live runtime
  code for five surfaces here, and it hosts the human-only escape hatches
  (`reset-danger-latch.sh`, `reset-strikes.sh`) that live block messages
  instruct the user to run by that exact path.
- **A stale project pack is invisible from Claude.**
  `doctor.hooks.installed_pack_version_lag` can sit at an old version while
  every Claude session looks healthy, because Claude never reads that copy.
  Treat that warning as real; refresh with
  `caws init --agent-surface <an-already-wired-surface>` so the shared core
  updates without re-registering a machine-routed surface.
- **The install set is per surface, and retirement reads the whole repo.**
  `ADAPTER_COVERED_SURFACES` (today: `dsh`) omits the four telemetry rows —
  `agent-heartbeat.sh`, `agent-stop.sh`, `session-log.sh`,
  `session_log_renderer.py` — because that harness's own adapter owns
  `.caws/sessions/` and `.caws/leases/`. Init for a covered surface also retires
  managed copies, but **only rows no co-installed surface still claims**: a row
  stays if any installed pack's install set contains it (`sharedPackForSurface`
  decides, so the rule needs no update when the covered set changes). The
  general invariant is that init never removes a file another installed surface
  still installs — without it, initializing one surface silently strips the
  telemetry plane from every project-wired surface sharing
  `.caws/hooks/dispatch`, and `run_handlers` treats the missing handlers as
  `missing` + `continue`, so nothing reports the loss. An absent telemetry row
  is therefore **not** evidence of version lag — check `git log --diff-filter=D`
  on the path before restoring it. `--plan` shows both halves under "Telemetry
  rows (adapter-covered surface owns this plane)" — what it would unlink, and
  what it keeps and for whom — and as `telemetry_retirement` (`retire` /
  `retained` / `retainedFor`) in `--plan --json`.

Reprieves are human-granted session-global exceptions in
`~/.caws/state/sessions/<session>/`. `--surface` records harness identity and
selects legacy lookup; it does not partition new grants. `caws reprieve grant`
requires an explicit target, handlers, reason, approver and one expiry choice.

### Extend the guards; do not fork them

A repo that needs a guard to behave differently declares that in
`.caws/hooks/hook-policy.json` — committed, reviewable, scoped to this git root,
honored by **both** routing planes. Copying a guard into `.caws/hooks/` to edit
it is the thing this replaces: a fork owns a file whose upstream keeps moving,
and because `installed_pack_version_lag` treats local growth as _explaining_ the
drift, forking a guard suppresses the warning that says it has gone stale.

Two tiers, both additive:

- **`surfaces`** — which guards run (`disabled`, `extensions`, `handlers`,
  `libraries`, `forks`). The repo tier is applied before machine state, and
  `protected-paths.sh` / `block-dangerous.sh` / `agent-register.sh` cannot be
  disabled or replaced from it: a policy that can authorize its own amendment is
  not a policy.
- **`guards`** — what data a running guard uses. Only `additional_*` keys and
  clamped thresholds exist, so no shipped entry can be removed or reordered, and
  a malformed document applies **zero** entries rather than a subset. Prefixes
  must be repo-relative; an absolute one would bypass cross-repo containment and
  is refused at authoring time.

Threshold precedence is **env > config > shipped default**, so an existing
`.claude/settings.json` env block keeps working unchanged.

Before adding an entry, apply the test: _would this be correct in a repo with a
different directory layout?_ Specific to this repo's names (`native/`,
`workbench/`) → configuration. Correct in every repo → that is an **upstream
defect**, and a config entry is a workaround that will rot.

The location is the authority argument: `protected-paths.sh` admits only `*.md`
under `.caws/hooks/`, so the `.json` there is agent-write-blocked — the entity
with the incentive to paper over a block cannot author the paper. Doctrine:
[`docs/architecture/repo-local-hook-policy.md`](docs/architecture/repo-local-hook-policy.md).

## Bash hook latches

The hook pack includes a "danger latch" that fires on certain Bash patterns
(force-push, `reset --hard`, `rebase`, `cherry-pick`, `clean -f`, bare
`checkout <path>`, deleted-tag pushes, pipe-to-shell, the `git init` family). If
it fires once, the session is **quarantined in a trap**: only fixed read-only
commands and the reset itself run, every other Bash attempt and every Write/Edit
blocks and is recorded as a strike, and on kill-enabled surfaces the first such
attempt ends the session's process (identity-verified SIGTERM) — until a human
runs the verified runtime reset helper with
`--session <id> --reason "<why this is safe>"` and the canonical project root.
See the recovery command in
[the runtime guide](docs/guides/hook-packs.md#human-latch-recovery). Legacy
reset scripts live under `.caws/hooks/`, not under the harness vendor dir
(`.claude/`) — that directory holds logs and settings, not the hook scripts. The
block message prints the exact command with your session id already filled in;
hand that to the user verbatim. There is no agent-side dismissal by design. If
you trip it, stop and ask the user to reset — do NOT re-run the command in a
different shape (`command git ...`, `env ... git ...`, `bash -lc '...'`); the
latch recognizes those variants, and shell trickery to bypass it is exactly the
pattern it's there to catch.

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

- CLI tests (vNext shell + store, includes the absorbed kernel under
  `src/kernel`): `cd packages/caws-cli && npx jest`
- Per `~/.claude/CLAUDE.md` and `~/Desktop/Projects/CLAUDE.md`: interpret pass
  counts critically, print the concrete runtime artifacts the scenario produced,
  cite specific evidence, name the false-confidence risks, and state what
  artifact/instrumentation/check is still missing if the proof is insufficient.

## References

- `docs/architecture/caws-vnext-command-surface.md` — **doctrine source**:
  cutover posture, kept/removed commands, architectural invariants.
- `docs/agents/scope-discipline.md` — pre-edit admission procedure, strike-state
  mechanics, scope-authoring habits, recovery checklist.
- `docs/migration-v10-to-v11.md` — v10.2→v11 command buckets + rollback.
- `docs/release-procedure.md` — tag-driven release procedure + failure
  invariant.
- `AGENTS.md` / `docs/agents/full-guide.md` — agent quickstart and full
  workflow.
- `.claude/rules/` — git-safety + worktree-isolation rules (auto-loaded).
