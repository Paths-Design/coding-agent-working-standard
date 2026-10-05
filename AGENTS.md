# CAWS — Agent Quick Reference

**Project governance with a shared machine runtime.**

## Read this first

CAWS keeps project authority in canonical `.caws/` and executable distribution
under `~/.caws` (or absolute `CAWS_HOME`). The CLI includes its kernel. Run
`caws --version` and `caws --help` for the installed package and command tree;
the historical v11 architecture names do not pin the current package version.
The doctrine source is
[the command-surface contract](docs/architecture/caws-vnext-command-surface.md).

Machine setup is an **ordered** three-step sequence, and the order is
load-bearing — each step is performed by the CLI installed in the step before
it:

1. **CLI package** —
   `node scripts/install-cli-snapshot.mjs --package packages/caws-cli --bin "$(command -v caws)"`
   (only when running a development build; a released install gets this from
   npm).
2. **Shared runtime** — `caws init adapters install`.
3. **Native harness** —
   `caws init adapters configure --agent-surface <surface>`.

Steps 2 and 3 apply by default; preview with `--plan`. Running them against a
stale CLI is the trap: `configure` writes the event set _that CLI_ knows and
reports `OK`, so a newer build then reports
`System surface settings and native registration disagree` and re-running
`configure` cannot fix it. Upgrade the CLI first. An agent in that harness must
verify native trust, lifecycle execution, a guarded-write refusal, and session
rendering. Retire existing project registration once with
`caws init adapters migrate` after reviewing custom hooks. New projects inherit
the configured runtime through `caws init --agent-surface <surface>`. Future
stock updates require one machine installation, not per-project pack refreshes.
See each operation's `--help`.

Legacy governance conversion is separate:
`caws init migrate --from <reviewed-json>` previews;
`caws init migrate apply --from <reviewed-json>` archives original bytes and
installs validated draft governance. No completed work is inferred.

Bridge claims (`caws claim --spec`) ship and bind active specs. Agent leases,
messages and manual handoff records provide visibility and provenance, not
additional authority. Only session lifecycle start/checkpoint/end and the
`parallel` orchestrator remain deferred. Removed v10 commands such as top-level
`validate`, `evaluate` and `iterate` are not restored by global adoption. The
current `caws hooks` group manages repository hook policy; the historical
`caws hooks install` command remains retired.

## Coding rigor: acceptance, review and evidence

Apply this standard to reviews and implementation; scale verification to the
change's risk. Full procedure: [Coding rigor](docs/guides/coding-rigor.md).

- **Establish context and authority.** Identify the revision, actual diff/base,
  owned worktree/spec and relevant consumer contract. A review authorizes
  inspection and findings; fixes, evidence recording and publication require the
  corresponding authorization. Preserve unrelated work.
- **Define acceptance before completion.** Give each criterion an observable
  result, a specific test/check and a counterexample that must fail. Rank
  failure modes by severity, with trigger, cost and resolve-now/defer decision;
  flag irreversible choices and dependencies that grow expensive to change.
- **Trace behavior and challenge the tests.** Follow the actual entry point to
  the consumer-visible result, including rejection, partial failure and cleanup.
  Assert semantic values and state, and use meaningful negative controls or
  mutation checks for consequential logic. Ask what could remain wrong while the
  tests pass. Never lower declared floors to manufacture success.
- **Retain concrete evidence.** Cite command, cwd/revision, exit status,
  selected tests, relevant output and runtime artifacts. Inspect before/after
  state where side effects matter. Preserve failed/skipped/interrupted attempts
  and artifact identity; generated receipts stay outside the source ledger.
- **Bound every conclusion.** Distinguish source review, tests,
  installed-package behavior, native execution, recorded acceptance, CI, merge
  and deployment. Passing gates or exit zero alone do not establish
  completeness. Name what was not verified and the exact observation needed to
  close each material gap.
- **Report actionable results.** Lead with the highest-impact finding and cite
  its trigger, incorrect result, impact and correction. Give next actions as
  investigate / implement / change, each with where and why. Name the strongest
  objection when changing course; say plainly when the plan is sound.

## Command surface

| Command                                                                                                                                                                                                                 | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `caws init`                                                                                                                                                                                                             | Initialize project governance. `init adapters install/configure/migrate/rollback` manage machine distribution and native adoption. `init migrate` previews reviewed legacy governance conversion; `migrate apply` executes. `diff`/`port` and overwrite/adopt flags are legacy pack maintenance.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `caws doctor`                                                                                                                                                                                                           | Drift detection over `.caws/` state. Exits 0 (no error-severity findings/load diagnostics; warnings may remain) / 1 (error-severity findings or load diagnostics) / 2 (composition failure).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `caws status`                                                                                                                                                                                                           | Read-only dashboard: project, current context, claim, doctor findings. Never mutates `.caws/`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `caws scope show / check / contention`                                                                                                                                                                                  | Explain scope, enforce scope, or report cross-worktree path contention.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `caws claim [--takeover] [--spec <id>] [--release]`                                                                                                                                                                     | Surface or take ownership of the current worktree. Writes `prior_owners` audit on takeover. `--spec`/`--release` manage BRIDGE bindings (AUTH-BINDING-BRIDGE-001): session↔spec authority for non-worktree contexts — `caws claim --spec <id>` bridges to an ACTIVE spec (same `scope.in` admission as a worktree binding; refuses worktree-held or foreign-held specs), `--takeover` transitions explicitly with audit, `--release` relinquishes. Retired (closed/archived) specs confer nothing; `worktree prune` cleans ghost bindings.                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `caws gates run --spec <id>`                                                                                                                                                                                            | Run policy-driven quality gates. Appends one `gate_evaluated` event per declared gate.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `caws evidence record --type <kind> --spec <id> --data <json>`                                                                                                                                                          | Append a typed evidence event (`test` / `gate` / `ac` / `human_decision`). `human_decision` (HUMAN-DECISION-EVIDENCE-001) is the schema-first record of a human judgment — always REQUIRES_SPEC_ID, provenance-only (never authority).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `caws waiver create / list / show / revoke`                                                                                                                                                                             | Manage waiver records. Singular surface — no plural alias.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `caws reprieve grant / show / revoke / list`                                                                                                                                                                            | Session-scoped guard reprieve: skip a PreToolUse guard for ONE session until expiry. Replaces commenting a guard out of the dispatcher HANDLERS array. See [Reprieves](#reprieves).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `caws events migrate / rotate / verify-archive`                                                                                                                                                                         | Maintenance for the hash-chained `.caws/events.jsonl`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `caws specs create / list / show / recover / restore / retire-draft / prune-drafts / activate / deactivate / amend / amend-scope / evidence / close / reopen / archive / prune-archive / migrate / validate / relocate` | Manage spec lifecycle. Specs live at `.caws/specs/<id>.yaml`. `create` writes `lifecycle_state: draft` by default (pass `--activate` to create active directly); the normal path is `caws worktree create --spec <id>`, which activates on bind. `close` (auto-fired by `worktree merge`) → `reopen` reverses it when the work was premature (closed→active, removes resolution/closure_notes). Batch archive supports `--status closed`, `--include`, `--exclude`, and `--apply`. CANONICAL-DRIFT-GUARDS-001: lifecycle auto-commits (create/activate/amend-scope/close) refuse pre-write when the canonical HEAD is parked off-base while worktrees are active (`--allow-foreign-branch` overrides deliberately); doctor warns `doctor.canonical.mis_parked_head`; `caws specs relocate <id> [--apply]` recovers a mis-landed spec onto base without touching any working tree.                                                                                      |
| `caws worktree create / list / ensure / bind / destroy / untrack / merge / review / migrate-registry / repair-sparse / repair / prune / cleanup-plan`                                                                   | Manage CAWS worktrees bound to active specs (`repair` prunes ghost registry entries + clears dead spec→worktree bindings; `repair-sparse` restores the `.caws/specs` sparse-checkout invariant; `untrack` releases the registry binding while keeping the directory; `prune` and `cleanup-plan` are dry-run-by-default cleanup planners). `ensure <name> --spec <id>` (WORKTREE-ENSURE-AFFORDANCE-001) is the idempotent create-or-admit form: absent lanes create via the full path; existing same-spec untouched lanes admit with no new events — the verb the unbound SessionStart advisory and scope no-authority remediation name. `review <name>` (WORKTREE-REVIEW-SURFACE-001) is the read-only human gate merge lacks: the exact commit list, per-commit scope-provenance table (the dry-run of merge's provenance gate), the lane diffstat, the bound spec's AC evidence status, and the owner's lease work_state — never mutates `.caws/` or appends events. |
| `caws agents register / heartbeat / stop / list / show / work-state / prune`                                                                                                                                            | Agent-liveness substrate (`.caws/leases/`). Operational cache only — never authority. `work-state` (LEASE-WORK-STATE-001): set a visibility-only annotation (`--set working                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | blocked_awaiting_human | review_ready | done [--note <t>]`, `--clear`) so peers can see who is blocked on a human or ready for review; read in `agents list`, the status Agents panel, and message sender-context. Never authority; never rescued from staleness. `prune`modes:`--dead`(PID-liveness),`--status stopped | stale --older-than-ms`(retention),`--status legacy --older-than-ms` (age-based, reaches v10/early-v11 leases with no status field). |
| `caws message send / reply / poll / inbox / history / status / prune`                                                                                                                                                   | Directed inter-agent message channel over `.caws/messages.jsonl`. Not authority; verify claims before acting. `--to` accepts `wt:<worktree>` / `spec:<spec-id>` aliases; liveness is heartbeat-age-based (idle peer = stopped lease + fresh heartbeat = deliverable); refused sends print a not-sent verdict to stdout; `reply <message_id>` answers on the same channel; `status <message_id>` reports queued-vs-delivered.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `caws session prune / pickup`                                                                                                                                                                                           | `prune`: dry-run-default retention for `.caws/sessions/` (SESSION-LOG-RETENTION-SCOPE-001). Session logs are operational cache (gitignored; never events.jsonl, never read by the kernel for authority). Only per-session turn history (`turn-<NNN>.json`) is retention-eligible; the identity capsule (`.session-envelope.json`), `.meta.json`, and top-level dotfiles are preserved (per-path exclusion). The current session and any session with a live lease are protected. `--apply` performs the prune; without it nothing is deleted; never appends an event. `pickup` (MULTI-AGENT-HANDOFF-EVENT-001): records a `manual_pickup` event when one session continues another's paused work. The session LIFECYCLE (`start`/`checkpoint`/`end`) remains deferred; this group ships `prune` and `pickup` only.                                                                                                                                                     |
| `caws working-tree check / ack`                                                                                                                                                                                         | WORKING-TREE-PROVENANCE-GUARD-001: `check` reports uncommitted working-tree overlap with another session's declared ownership metadata; `ack` acknowledges the advisory. Never mutates authority.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `caws handoff export / import`                                                                                                                                                                                          | HANDOFF-EXPORT-IMPORT-001: portable handoff briefs for session-to-session continuity — `export` writes a brief describing current state; `import` reads one into a fresh session. Provenance only, never authority.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

Run `caws <group> --help` for full options and flag details.

## Specs in v11

- Specs live at `.caws/specs/<id>.yaml`. There is no project-level
  `working-spec.yaml`.
- The v11 line ships
  `caws specs create/list/show/recover/retire-draft/activate/amend-scope/close/reopen/archive/prune-archive/migrate/validate`.
  `caws specs reopen <id>` reverses a close (closed→active) when the auto-close
  from `worktree merge` was premature. Create with
  `caws specs create <id> --title "..." --mode <feature|refactor|fix|doc|chore>`,
  then edit the generated YAML. See existing specs in `.caws/specs/` for the
  shape.
- v11 does **not** ship `caws validate` (removed in v11.0, not returning).
  Validation happens via `caws doctor` (drift / structure) and
  `caws gates run --spec <id>` (policy / quality).
- Acceptance criteria use Given/When/Then format.
- A spec's `scope.in` / `scope.out` defines what files an agent may touch.
  `caws scope check <path>` enforces it.

## Your contract with v11 CAWS

**You MUST:**

- Author a spec in `.caws/specs/<id>.yaml` for every unit of work.
- Stay within the spec's `scope.in` boundaries — verify with
  `caws scope check <path>`.
- Run `caws doctor` and `caws gates run --spec <id>` before declaring work
  complete.
- Use `caws waiver create` (singular) to legitimately bypass a gate, with an
  expiry, an approver, and a reason.
- Surface ownership with `caws claim` before mutating shared state in a
  worktree.
- Treat `caws status` as observability — never write to `.caws/` directly except
  through CLI commands.

**You MUST NOT:**

- Invoke removed commands (see list above) — they are gone.
- Edit `.caws/working-spec.yaml`, `.caws/events.jsonl`, `.caws/policy.yaml`, or
  other governed state by hand. Use the CLI.
- Trim, defer or stub work to come in under a risk-tier budget. Budgets are an
  advisory sizing goal: `budget_limit` reports an overage and never blocks. If
  the change is larger than planned, say so in the spec.
- Take over a worktree owned by another session (`caws claim --takeover`)
  without explicit user authorization.
- Create shadow files (`*-enhanced.*`, `*-final.*`, `*-v2.*`, `*-copy.*`) — edit
  canonical files in place.

## Quick start (project setup)

```bash
git init my-project && cd my-project
caws init                                  # idempotent; refuses legacy residue
```

`caws init` creates:

```
.caws/
  specs/                  # per-feature specs (.caws/specs/<id>.yaml)
  waivers/                # waiver records (.caws/waivers/<id>.yaml)
  policy.yaml             # gate block/warn/skip policy
  worktrees.json          # worktree registry
  agents.json             # agent session registry
  # events.jsonl is created on first append; never required at rest.
```

If `.caws/working-spec.yaml` exists, plain init refuses. Use a reviewed
`caws init migrate --from <plan>` preview and
`caws init migrate apply --from <plan>`; see docs/migration-v10-to-v11.md.

## Daily agent workflow

```bash
# 1. Author a spec for your work
caws specs create FEAT-1 --title "Short title" --mode feature --scope-in src/foo.ts
caws specs amend FEAT-1 --add-invariant "State the invariant"
caws specs amend FEAT-1 --set-ac A1 --given "Initial state" --when "Action" --then "Observable result"
# Use specs amend-scope for later scope changes; governance edits stay audited.

# 2. Verify scope/structure
caws doctor
caws scope show src/foo.ts                 # explain the scope decision
caws scope check src/foo.ts                # enforce; exits 1 if refused

# 3. Implement, run tests, then evaluate gates
git add <changed-paths>                   # unstaged/untracked files are not evaluated
caws gates run --spec FEAT-1               # policy decides block/warn/skip
# Bound lanes include committed changes against their recorded base branch.
# Elsewhere, pass --base <ref> to include committed work; empty staged input
# without a branch basis is unavailable, not a passing scope check.

# 4. Record typed evidence (test results, AC closures)
caws evidence record --type test --spec FEAT-1 \
  --data '{"command":"npm test","exit_code":0}'
# AC evidence goes through specs evidence, NOT evidence record: only this
# command writes the spec's evidence: block, which is the closure authority
# the close gate reads. It dual-writes the ac_recorded event too.
# (`caws evidence record --type ac` is refused and redirects here.)
caws specs evidence FEAT-1 --ac A1 --status pass --evidence-ref "npm test"
# Cite a machine-checkable field and add --verify wherever you can. --verify
# re-derives the citation BEFORE writing and refuses to record status pass when
# it is refuted — nothing is written, the failing detail is printed. Without it,
# status is a self-assertion no later stage can disagree with.
caws specs evidence FEAT-1 --ac A1 --status pass \
  --test-nodeid "tests/foo.test.js::renders the empty state" --verify
# The nodeid is pytest-style `<file>::<test name>` for jest as well as pytest.
# Inspect the whole spec's evidence without writing anything:
caws specs verify-acs FEAT-1 --run   # --run executes cited tests; existence
                                     # alone is not_rederived, never pass
# Payload shapes are closed (additionalProperties: false) and status is a closed
# enum. Print the authoritative shape + a runnable example for any kind with:
#   caws evidence schema --type <test|gate|ac|human_decision>

# 5. Re-check
caws doctor
caws status
```

## Worktree-based parallel agent work

When multiple agents work on the same project, each agent **must** work in its
own git worktree. CAWS's model is to **partition authority, not add channels
between agents**: one spec + one bound worktree per agent, scope enforced from
`scope.in`/`scope.out`, ownership in `.caws/worktrees.json`. There is no
`caws parallel setup` (deferred to v11.3+) — loop `caws worktree create` per
spec.

```bash
# Create an isolated worktree bound to your spec (writes the binding atomically,
# emits worktree_created + worktree_bound)
caws worktree create wt-auth --spec FEAT-AUTH
cd .caws/worktrees/wt-auth

# Surface the claim and see who else is live
caws claim                                 # prints owner; exits 0 if you own it
caws status                                # Agents panel: other live sessions
caws agents list                           # active / stale / stopped sessions
# The authority-mutating commands (specs activate, worktree create/bind/merge,
# mutating claim) also print an advisory peer-presence block themselves when
# live peers exist — visibility only, never a refusal or an authority input.

# When done: merge (auto-closes the bound spec, deletes the merged branch)
caws worktree merge wt-auth
caws worktree destroy wt-auth              # "not found in registry" = already
                                           # de-registered by the merge = success
```

### Merging is safe while other agents are working

`caws worktree merge` **never checks out the base branch**. It computes the
merge in the object database (`git merge-tree --write-tree` + `git commit-tree`)
and advances the base with an atomic compare-and-swap
(`git update-ref <ref> <new> <expected-old>`). Nothing touches the shared
working tree.

If another agent lands a merge first, git refuses the ref update ("is at X but
expected Y") and yours recomputes against the new base and retries — bounded at
5 attempts. **Losing that race is normal, not an error.** Nothing partial is
written either way: the objects created before the compare-and-swap are
unreferenced, so an interrupted or crashed merge leaves no half-applied state.

Only a genuine conflict or an exhausted retry budget is reported as a failure,
and the diagnostic distinguishes them — contention names the base branch and the
retry command; a conflict names the paths and leaves your working tree clean (no
`MERGE_HEAD`, no conflict markers to clean up).

Merge is also where **lane provenance** is enforced: every commit in the lane
range must touch only paths inside the bound spec's `scope.in`. A lane carrying
out-of-scope commits is refused before the merge is computed, and the refusal
names candidate lanes for the foreign paths — scope-keyed, never author- or
session-keyed, so a `--takeover`-handed worktree merges cleanly. A successful
merge records `lane_tip`/`base_before` on the `worktree_merged` event; that
record is the durable, auditable proof of which commits landed under governance
and which lane they came from.

Hand-running `git checkout main && git merge` reintroduces the hazard this
removes, and the bare checkout can trip the danger latch. Use the governed
command.

### Foreign-claim soft-block

`caws claim`, `caws worktree bind`, and `caws worktree merge` refuse to mutate a
worktree owned by a different session id without `--takeover`. The refusal looks
like:

```
Worktree 'wt-foreign' is claimed by 8be65780-...:claude-code
   Last heartbeat: 2026-04-27T17:04:00Z (23 min ago)
   Session log:    .caws/sessions/8be65780-72e0-4fc7-a989-4ebac148c18d
                   15 turns, last turn 2026-04-27T17:26:49Z
   To proceed:     caws claim --takeover
```

**Read the session log first.** A stale heartbeat does not mean the prior
session is dead — it may be paused. Take over only with explicit user
authorization. `--takeover` writes a durable `prior_owners` audit (sessionId,
platform, lastSeen-at-takeover, takenOver_at) so postmortems can see what
happened.

## Architectural invariants (v11)

These are enforced by code, not docs. Don't try to work around them.

1. `events.jsonl` is written ONLY through the store's `appendEvent`. Never
   hand-edit.
2. `policy.yaml` owns gate `mode` (block / warn / skip). Waivers filter
   violations out of the disposition; they do not change gate mode.
3. Doctor is pure (kernel-side). The store composes the snapshot; doctor
   inspects it.
4. Missing != malformed. Diagnostics distinguish absence from corruption.
5. `events.jsonl` is never required at rest. The first `appendEvent` creates it.
6. `caws init` is idempotent and non-destructive. Plain initialization refuses
   legacy residue; only explicit reviewed migration converts it. `--force`
   belongs solely to legacy pack `--overwrite`.
7. `caws status` is observability. Running it any number of times produces no
   `.caws/` byte changes.

## Spec requirements

New specs have no risk tier. Declare the scope, invariants and acceptance for
actual work; add contracts, observability, rollback and security requirements
when they help describe that work. No tier determines which authoring flags must
be supplied, and creation does not silently choose a default tier.

Existing tiered specs retain their recorded fields and legacy validation.
`budget_limit` reports legacy policy sizing goals only for those specs; a new
spec has no inferred tier budget. Scope and policy gates continue to apply.
Coverage and mutation thresholds belong in project checks and CI.

## Waivers

Waivers legitimately bypass a gate violation. They do not change gate mode —
they filter violations out of the disposition.

```bash
caws waiver create FEAT-1a \
  --title "Experimental mode past expiry during rollout" \
  --gate spec_completeness \
  --reason "FEAT-1 rollout finishes after experimental_mode.expires_at; renewal tracked in FEAT-2" \
  --approved-by "team-lead@example.com" \
  --expires-at "2026-12-01T00:00:00Z"

caws waiver list
caws waiver show FEAT-1a
caws waiver revoke FEAT-1a
```

## Reprieves

A **reprieve** skips a PreToolUse guard for exactly one agent session until a
stated expiry. It replaces the anti-pattern of commenting a guard out of the
dispatcher's HANDLERS array (which disables it for _every_ agent, forever, with
no reason or expiry). Reprieves are operational cache (gitignored, under
`~/.caws/state/sessions/<session>/`), not governance state — they do not flow
through `events.jsonl` or the kernel.

A reprieve is a legitimate way to ask a human to adjudicate a necessary action
that CAWS cannot adequately express or admit. Before handing the user a grant
command, the agent **must write a descriptive `--reason`** that stands on its
own for the operator and later agents. State:

1. The requested action, target paths/repository, owning spec and observed
   refusal; identify the CAWS limitation that makes this exception necessary.
2. The ordinary routes considered (such as an owned binding, scope amendment, or
   a session in the target repository), and concrete evidence of why none can
   accomplish this action. If one can, use it. Convenience or a deadline alone
   does not establish necessity.
3. The exact session, handlers, operations, extent and number of uses requested,
   exclusions, and shortest practical expiry. Disclose any earlier refusal;
   seeking a different approver does not erase it.
4. How the result will be checked, how unintended changes will be recovered, and
   when the reprieve will be revoked.

The reason is an accountable justification, not a self-issued permission. Later
agents may learn the standard of explanation from it; they may not reuse its
approval. A grant belongs to its named actor, action and prospective bounds: one
bowl of ice cream does not authorize the tub, another bowl, or yesterday's bowl.
Ambiguity calls for a narrower action or clarification from the grantor. The
human must actually grant the exception before the action. Never invent an
approver, copy a peer's grant, or grant your own; see
[failure-lineage Entry 40](docs/failure-lineage.md#entry-40-the-agent-signs-the-owners-name-on-a-waiver-it-grants-itself-the-approver-field-is-self-authenticating-and-the-only-detector-is-a-human-reading-the-ledger-august-2026).

**Explain the enforcement gap to the user:** the mechanism matches session,
repository, handlers and expiry. It skips the entire named handler on matching
calls until expiry. It does not enforce paths, operations or use counts written
in `--reason`, nor assess the quality of that explanation. Those narrower bounds
remain obligations of the agent and operator; a successful grant is not proof of
necessity or permission for adjacent work.

```bash
# Run this in a human terminal; agents cannot grant reprieves.
caws reprieve grant --session <session-id> --surface codex \
  --handlers protected-paths.sh \
  --reason "Under CASR-HOOK-LIVE-WIRING-OWNER-STEP-01, repair only casr-context.sh in this repository: protected-paths.sh refuses the required hook edit even in the owned bound worktree; scope amendment and another session cannot lift this path protection. Request one repair and its validation for this session within 20m, excluding all other hooks. The handler skip is broader than this path restriction. Check the focused hook regression and diff, revert this repair if it fails, and revoke immediately after validation." \
  --approved-by "<human-grantor>" \
  --for 20m

caws reprieve show --current
caws reprieve revoke --current --reason "done editing hooks"
caws reprieve list
```

**Reprieve vs waiver** — different enforcement layers, do not confuse them:

- A **waiver** bypasses a **GATE** at policy-run time (`caws gates run`). It is
  governance state (`.caws/waivers/`), kernel-adjudicated, optionally scoped to
  a spec. Use it when a gate's threshold is wrong for a legitimate change.
- A **reprieve** skips a **HOOK guard** at dispatch time (the PreToolUse chain).
  It is operational cache (machine session store), session-scoped, expiring. Use
  it when one session legitimately needs to do what a guard blocks (e.g. editing
  a hook script) without disabling the guard for every other session.

A reprieve requires `--reason`, `--approved-by`, and exactly one of `--for` or
`--expires-at`. A grant covers one session in one repo: the record carries the
repo it was granted from, and a guard in any other repo ignores it unless the
grant was made with `--all-repos`. A grant that names some but not all handlers
of a set that jointly enforces one boundary (e.g. `scope-guard.sh` and
`bash-write-guard.sh` both adjudicate the cross-repo write boundary, on
different tool channels) is refused — lifting one does not narrow the exception,
it redirects the write to the channel still guarded. `--surface` supplies
harness provenance and legacy lookup context. The skip is logged to stderr
(`[reprieve] <handler> skipped for session <id> (expires <ts>)`) so the audit
trail shows when and why a guard was skipped. A foreign session is never covered
— the state file is keyed to the resolved session id.

## Exit codes (uniform across v11)

- `0` — success / observation
- `1` — domain failure (gate failed, doctor finding, scope refused, waiver
  duplicate)
- `2` — composition failure (not a git repo, can't read `.caws/`, missing
  required tooling)

## When to ask a human

- **Security-sensitive or irreversible changes** — request appropriate review.
- **Architecture decisions** — when the design affects multiple components or
  governed paths.
- **Waivers on T1 gates** — emergency only; document mitigation plan.
- **`caws claim --takeover`** — never without explicit authorization.
- **A dangerous-command hook fires** — `block-dangerous.sh` returning `block` or
  `ask` is a human-review boundary, not a syntax problem to solve. Do not
  rephrase, wrap, reorder, or alias the command. Stop and ask. The hook also
  engages a per-session quarantine trap: only fixed read-only commands run until
  the user runs `reset-danger-latch.sh`; every other attempt — including every
  Write/Edit, so a file write cannot route around the shell boundary — is
  recorded as a strike, `caws message send`/`reply` are refused, and on
  kill-enabled surfaces the first such attempt terminates the session's process.
  Read [`docs/failure-lineage.md`](docs/failure-lineage.md) Entry 17 for why
  this rule exists.

## Resources

- [`docs/architecture/caws-vnext-command-surface.md`](docs/architecture/caws-vnext-command-surface.md)
  — **doctrine source**: posture, kept commands, removed commands, invariants
- [`docs/agents/full-guide.md`](docs/agents/full-guide.md) — comprehensive
  workflow guide (post-8c.1; cross-reference doctrine doc for any conflicts)
- [`docs/guides/multi-agent-workflow.md`](docs/guides/multi-agent-workflow.md) —
  multi-agent patterns
- [`docs/guides/worktree-isolation.md`](docs/guides/worktree-isolation.md) —
  worktree discipline
- [`docs/guides/waiver-troubleshooting.md`](docs/guides/waiver-troubleshooting.md)
  — waiver patterns
- [`packages/caws-cli/README.md`](packages/caws-cli/README.md) — v11 CLI package
  reference
- [`CLAUDE.md`](CLAUDE.md) — Claude Code project guidance for this repo

## Common pitfalls

**Problem**: Tried to run `caws validate` / `caws iterate` / `caws diagnose` /
`caws verify-acs` / `caws evaluate` / `caws burnup`. **Cause**: Reading a stale
doc that pre-dates v11.0 cutover. **Fix**: Those commands were removed in v11.0.
Use `caws doctor` (drift / structure) and `caws gates run --spec <id>` (policy /
quality) as the validation surface. `caws specs create` was restored in v11.1;
`caws verify-acs` returned as `caws specs verify-acs <id>` in 12.2 (re-derives
recorded evidence; `--run` executes cited tests; a collected-but-unexecuted test
reports `not_rederived`, never pass). The rest are not planned to return.

**Problem**: `caws init` refuses to run. **Cause**: Legacy
`.caws/working-spec.yaml` residue from v10.x. **Fix**: Migrate that file's
contents into `.caws/specs/<id>.yaml`, then re-run.

**Problem**: `caws claim` refused with a foreign-owner message. **Cause**:
Another agent session owns the worktree. **Fix**: Read their session log under
`.caws/sessions/<sessionId>/`; only `--takeover` with user authorization.

**Problem**: Under DSH, `caws claim` or a write guard refuses a worktree you
just created — the owner id is your own session id in another form (bare
`<uuid>` vs your `session-<uuid>`). **Cause**: The lane was stamped by a runtime
whose resolver emitted a different session-id form than the guards resolve from
`DSH_SESSION_ID` (CAWS-SESSION-RESOLVER-GUARD-DIVERGENCE-001) — the rightful
owner treated as foreign. **Fix**: Verify the owner uuid equals your
`DSH_SESSION_ID` minus the `session-` prefix, then reclaim your own lane with
`caws claim --takeover` from inside the worktree — it restamps the owner through
the current resolver and writes the `prior_owners` audit. A genuinely foreign
owner still requires explicit user authorization.

**Problem**: A gate keeps blocking and you want to bypass it. **Cause**: The
gate is in `block` mode and the violation is real; editing `.caws/policy.yaml`
to change its mode is a governed-path edit, not an escape. **Fix**:
`caws waiver create` with reason, approver, and expiry. A `budget_limit` overage
is not this problem — it never blocks, needs no waiver, and is not a reason to
cut work.

---

**Mission**: Deliver reliable, scoped, auditable changes through the v11
governance surface. When the docs and the doctrine doc disagree, trust the
doctrine doc.
