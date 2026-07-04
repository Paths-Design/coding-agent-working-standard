---
doc_id: caws-vnext-command-surface
authority: architecture
status: active
title: CAWS vNext command surface (v11.0.0 → v11.2) [updated for v11.6.0]
owner: vNext rewrite team
updated: 2026-07-03
governs:
  modules:
    - packages/caws-cli/src/index.js
    - packages/caws-cli/src/shell/
    - packages/caws-cli/src/store/
    - packages/caws-cli/src/commands/
    - packages/caws-kernel/src/
  schemas:
    - packages/caws-kernel/src/schemas/events/
---

# CAWS vNext command surface (v11.0.0 → v11.2)

**Status:** active. v11.0.0 → v11.6.0 shipped (governed core, worktree lifecycle, events, agents, message, prepush). Multi-agent authority remains in planning (see §1).
**Branch:** `main` post-cutover.
**Authors:** vNext rewrite team
**Last updated:** 2026-07-03

This document is the doctrine source for the v11 cutover and its follow-on
releases. It captures the cutover posture, the command surface that ships,
the legacy commands that are removed, and the architectural invariants the
rewrite established.

If a future change conflicts with anything below, fix the change or revise
this doc — do not silently regress an invariant.

---

## 1. Cutover posture

**Current state: v11.x is the canonical line.** The v11 cutover is complete; v11.1 restored the spec and worktree lifecycle on top of the v11.0 governed core. The original A1 doctrine and the v11.0 → v11.1 plan are preserved below as historical context.

### Historical: A1 chosen

The cutover posture chosen at v11.0.0 was:

> v11.0.0 is the governed core.
> v11.0.0 deliberately excludes spec/worktree lifecycle.
> Projects needing legacy lifecycle pin to `caws-cli@^10.2.x`.
> vNext lifecycle returns in v11.1.

The v11.1 plan shipped in v11.1.x. Today's recommended install path is `@paths.design/caws-cli@^11.6.0` (or unpinned). Projects migrating from v10.2 should read [`docs/migration-v10-to-v11.md`](../migration-v10-to-v11.md).

### Why A1 was chosen

The vNext rewrite established a coherent kernel/store/shell substrate
across slices 1–7c, including:

- pure kernel (no fs/path/env/clock) for spec/policy/doctor/waiver logic
- store layer that owns all I/O, atomic writes, hash-chained event log
- shell commands that compose store snapshots into observability and
  governance surfaces (`init`, `doctor`, `status`, `scope`, `claim`,
  `gates`, `waiver`, `evidence`)

It did **not** rewrite the legacy spec or worktree lifecycle commands
(`specs create/close/archive/migrate`, `worktree create/destroy/merge`).
Those remain on the legacy code path.

The two viable cutover postures were:

- **A1** — ship the governed core as v11.0.0; defer lifecycle to v11.1.
- **A2** — block cutover until vNext spec/worktree lifecycle exists.
- **C** — keep legacy lifecycle alongside vNext (mixed-regime).

A1 is chosen because:

- A2 indefinitely delays cutover and lets `caws-next` rot
- C re-introduces the exact mixed-regime hazard the rewrite was meant to
  eliminate (two authority paths writing to overlapping state files)
- A1 is honest about the scope of v11.0.0: it is a strong governance
  core, not yet a complete lifecycle replacement

### v11.1 plan (out of scope for v11.0.0) — **shipped in v11.1.x**

vNext spec lifecycle (`spec create/close/archive`) and worktree lifecycle
(`worktree create/destroy/merge`) were reintroduced as vNext shell
commands in v11.1. Projects that need only the v11.0 governed core may
still pin to `caws-cli@^11.0.x`.

### v11.2 plan — multi-agent authority and observability

v11.0 → v11.1 delivered the governed core and worktree lifecycle. v11.2
delivers the surface CAWS needs to be **usable for multi-agent work**:
agent visibility, takeover audit, non-worktree (bridge) claims, and
recovery ergonomics. The deliverables are:

- **Leases** (ephemeral operational cache) under `.caws/leases/` — a
  per-session liveness file written by the store layer on write-class
  command dispatch. **Not authority. Not in `events.jsonl`.**
  - The operational verbs (`caws agents register/heartbeat/stop/prune`)
    that write and read this substrate shipped ahead of the full v11.2
    release as `MULTI-AGENT-ACTIVITY-REGISTRY-001` (mid-v11.1.x).
    Trigger: the canonical-checkout hijack documented in failure-lineage
    Entry 19 was a live multi-agent incident with no visibility
    substrate to make the conflict legible at the decision point.
    Visibility could not wait for the full v11.2 authority slice
    package. The `list/show` read surface remains a v11.2 deliverable;
    `register/heartbeat/stop/prune` are the write/lifecycle/cleanup
    verbs and are live from v11.1.x onward via the Claude Code hook
    pack (SessionStart / PreToolUse / Stop). See §2.
- **`claim_taken_over.v1` event emission** wired into `caws claim
  --takeover` inside the same lifecycle transaction as the worktrees.json
  mutation. Closes the existing audit gap.
- **Bridge bindings** under `.caws/claims/bridge.json` — `caws claim
  --spec <id>` outside a worktree creates a session ↔ spec authority
  binding. Bridge has the full lifecycle (acquire, observe, refuse,
  takeover, release via `--release`, retire via spec close/archive,
  prune).
- **`caws agents list/show`** — **SHIPPED in v11.1.x** (ahead of the
  full v11.2 release). Pure read-only composition over leases/worktrees
  stores. Restores agent visibility removed in v11.0.0. See §2 "Added in
  v11.1" and "Shipped ahead of v11.2" for subcommand detail.
- **`caws worktree prune/reconcile`** — recovery ergonomics for ghost
  worktree entries and ghost bridge bindings. (`repair-sparse` shipped in
  v11.1 — see §2 "Added in v11.1". The planned `repair` and `reconcile`
  subcommands remain v11.2.)
- **Adversarial fault-injection harness** on `lifecycle-transaction` to
  prove every step boundary is rollback-safe.

**Explicitly deferred to v11.3+:** `caws session start/checkpoint/end`
and `caws parallel setup/status/merge/teardown`. The `caws worktree
create` loop pattern replaces `parallel` for the multi-agent setup case.
Session lifecycle re-introduction waits on evidence of need from real
v11.2 usage.

### v11.2 acceptance bar: binding lifecycle spine

Every authority binding introduced by v11.2 (and any future binding)
must satisfy all seven lifecycle slots, each with at least one test:

```
acquire    — creation path, with audit event
observe    — read paths (status, agents); side-effect-free
refuse     — typed diagnostics for every conflicting acquire scenario
takeover   — explicit authority transition, with audited event
release    — explicit relinquishment by the owning session
retire     — automatic ending tied to a natural lifecycle event
prune      — operator-driven cleanup of ghost/stale entries
```

| Binding | acquire | observe | refuse | takeover | release | retire | prune |
|---|---|---|---|---|---|---|---|
| Worktree binding | `worktree create` | `worktree list`, `status`, `agents` | `worktree create` collision | `claim --takeover` (shipped v11.1) | `worktree destroy` | `worktree merge` auto-close | `worktree prune` (v11.2) |
| Bridge binding | `claim --spec <id>` (v11.2) | `agents`, `status` | `claim --spec` collision (v11.2) | `claim --spec --takeover` (v11.2) | `claim --release` (v11.2) | spec close/archive auto-retire (v11.2) | `worktree prune` extension (v11.2) |
| Lease (presence, not authority) | first write-class command with stable identity | `agents list/show` | n/a (presence is not exclusive) | n/a | n/a — natural refresh-or-decay | stale_after_seconds decay | `worktree prune` extension (v11.2) |

A v11.2+ binding that does not define all applicable slots is a doctrine
violation, not just a missing feature.

### v11.2 reconciliation matrix (added by V11-2-STABILIZATION-RECON-001)

The v11.2 plan list above remains authoritative. The matrix below
records the disposition of every overlapping draft and proposed slice
as of 2026-05-21, so the next 4–6 implementation slices execute
against a single resolved frame rather than re-deriving it.

| Draft / artifact | Disposition | Rationale |
|---|---|---|
| `WORKTREE-CAWS-SHARED-STATE-001` (draft, refactor, tier 3) | **Sequence after recon — likely absorbed** | "Shared state" is mechanism framing; the newer authority-control-plane spec carries the better invariant (§6.9 liveness ≠ authority). Useful implementation detail may be lifted into the control-plane spec before closure as `superseded`. Do not close in this slice. |
| `WORKTREE-SPEC-AUTHORITY-CONTROL-PLANE-001` (draft, feature, tier 3) | **Activate after recon, but reframe** | A1/A2 are largely already true on read (see §1.3 finding 1). Actual gap is worktree-checkout spec bytes + doctor drift + reconcile migration. On activation, amend to add a concrete contract (proposed: `control-plane-state-authority`) and re-evaluate to tier 2. |
| `PRUNE-REPAIR-WORKTREE-001` (draft, feature, tier 2) | **Prerequisite for control-plane reconcile** | `caws worktree reconcile` belongs in this spec, not as a standalone command in the authority spec. Sequence before A7 of the control-plane spec. |
| `LIFECYCLE-ROLLBACK-FAILURE-HARNESS-001` (draft, chore, tier 3) | **Parallel-safe** | Fault-injection seam shipped (`CAWS_TEST_INJECT_LIFECYCLE_FAULT`, `packages/caws-cli/src/store/lifecycle-transaction.ts:225–273`). Test-only expansion across 7 callers (`createSpec`, `closeSpec`, `archiveSpec`, `createWorktree`, `bindWorktreeRepair`, `destroyWorktree`, `mergeWorktree`). Strengthens substrate before authority work increases transition count. Safe in its own worktree without blocking the authority lane. |
| `SPECS-PROMOTE-DRAFT` (resolved as `CAWS-SPECS-ACTIVATE-DRAFT-001`) | **Shipped as `caws specs activate`** | Release-blocking gap found during quality-gates deprecation: activating a pre-authored draft required hand-editing governed YAML. The shipped surface is named `activate`, not `promote`, and appends `spec_activated`. |
| v11.2 plan above (existing list) | **Authoritative** | The list (leases, claim_taken_over emission, bridge bindings, prune/repair/reconcile, rollback harness) stands as the v11.2 acceptance bar. Recon supplements, does not replace. (`agents list/show` was on this list but shipped ahead in v11.1.x — see "Shipped ahead of v11.2" in §2.) |

### v11.2 slice ordering

| Bucket | Slice | Notes |
|---|---|---|
| Implementation-ready | `LIFECYCLE-ROLLBACK-FAILURE-HARNESS-001` | Seam shipped. Pure test additions. Recommended as first post-recon slice. |
| Needs recon | `WORKTREE-SPEC-AUTHORITY-CONTROL-PLANE-001` | Reframe per §1.3 finding 1. Amend scope, add contract, decide tier on activation. |
| Needs recon | `WORKTREE-CAWS-SHARED-STATE-001` | Likely absorbed into control-plane spec; do not close yet — extract any useful detail first. |
| Needs recon | `PRUNE-REPAIR-WORKTREE-001` | Decide whether `reconcile` lives here or as A7 of control-plane spec. Recon recommends here. |
| Shipped | `CAWS-SPECS-ACTIVATE-DRAFT-001` | Governed draft → active transition via `caws specs activate <id>`; replaces hand-editing lifecycle_state for pre-authored drafts. |
| Defer past v11.2 | `WORKTREE-NODE-MODULES-*` (not drafted) | Execution ergonomics. Comfort, not correctness. Do not solve before authority. |
| Defer past v11.2 | `TEMPLATES-V11-COMMAND-REFRESH-*` (not drafted) | Doc/template hygiene. Pre-public-release concern, not substrate. |
| Defer past v11.2 | `SPEC-CONTRACTS-SCHEMA-RECONCILE-*` (not drafted) | Schema-vs-practice gap (tier 2 with empty contracts). Investigate across all specs separately. |

### Recon findings (preserve so future agents do not re-derive)

1. **Read-path authority is already control-plane.** `resolveRepoRoot`
   (`packages/caws-cli/src/store/repo-root.ts:87`) uses
   `git rev-parse --path-format=absolute --git-common-dir`. All four
   read commands — `scope show`, `scope check`, `gates run --spec`,
   `specs show` — invoked from a linked worktree resolve to the main
   repo's `.caws/specs/`. The v11.2 control-plane authority work is
   therefore not about read-path correction; it is about (a) the
   worktree's git checkout still containing tracked `.caws/specs/*.yaml`
   that look authoritative to humans/agents but are ignored by the
   resolver, (b) absence of doctor drift diagnostics between
   checked-out and resolver-loaded bytes, and (c) migration of
   pre-v11.2 worktrees.

2. **Draft activation now has doctrine.** The original `specs promote`
   idea had zero doctrine footprint. `CAWS-SPECS-ACTIVATE-DRAFT-001`
   resolved the gap with a narrower surface: `caws specs activate <id>`
   transitions `lifecycle_state: draft` to `active` and appends
   `spec_activated`. The command is draft-only and exists to prevent
   hand-editing governed spec lifecycle state before worktree binding.

3. **`WORKTREE-CAWS-SHARED-STATE-001` and
   `WORKTREE-SPEC-AUTHORITY-CONTROL-PLANE-001` overlap.** The older
   spec uses mechanism framing ("shared state"); the newer spec
   uses authority framing (matches §6.9 — liveness ≠ authority). Do
   not implement either until the §1.1 disposition is acted on by a
   subsequent slice.

### v11.2 worktree half-state doctrine (added by PRUNE-REPAIR-WORKTREE-RECON-001)

Prune/repair was filed as one capability. It is three. Conflating
them encodes doctrine decisions accidentally — a "helpful" repair
command that wins today's workflow can permanently fix the wrong
source of truth before the authority rule is written.

#### Diagnose / Decide / Repair stratification

| Level | Capability | Authority required | Status |
|---|---|---|---|
| **Diagnose** | Name contradictions; classify; surface evidence | None beyond read-only fs/git access | Implementable now under existing doctor invariants (§6.3 purity, §6.7 status/observability) |
| **Decide** | Pick which state surface wins for a given contradiction class: registry, spec YAML, git worktree list, filesystem, event log, control-plane binding | Control-plane authority doctrine | Delivered by `WORKTREE-SPEC-AUTHORITY-CONTROL-PLANE-002` (§1.4 decision matrix + §6 invariant 16) |
| **Repair** | Mutate state to resolve a contradiction | Decide must have produced a policy first | Gated on Decide; `PRUNE-REPAIR-WORKTREE-001` blocked until then |

Each level requires the prior one. Detection is the only authority-free level and the only one safe to ship in the next slice.

#### Half-state taxonomy (H1–H6)

| # | Class | Observable state | Witnessed by |
|---|---|---|---|
| H1 | Ghost registry entry | `worktrees.json[name]` exists; backing git worktree dir absent | Previously known (PRUNE-REPAIR-WORKTREE-001 A1) |
| H2 | One-sided registry → spec | `worktrees.json[name].specId === id` but `spec_<id>.yaml` lacks `worktree:` field | Previously known; likely covered by existing kernel `BINDING_SPEC_MISSING_REGISTRY` |
| H3 | One-sided spec → registry | `spec_<id>.yaml` has `worktree: <name>` but `worktrees.json[name]` absent | Previously known; likely covered by existing kernel `BINDING_REGISTRY_MISSING_SPEC` |
| H4 | Ghost spec binding (destroyWorktree post-fault) | Registry entry absent; git worktree absent; `spec_<id>.yaml` still has `worktree: <name>` | `packages/caws-cli/tests/store/lifecycle-rollback-failure-harness.test.js:533-583` |
| H5 | 3-way registry/spec contradiction (bindWorktreeRepair post-fault) | `worktrees.json[name].specId === idB`; `spec_<idA>.yaml` has `worktree: <name>`; `spec_<idB>.yaml` lacks `worktree:` | `packages/caws-cli/tests/store/lifecycle-rollback-failure-harness.test.js:438-506` |
| H6 | Foreign physical worktree | `git worktree list --porcelain` shows a worktree at some path; no `.caws/worktrees.json` entry references it | Identified during recon; cheap to detect alongside H1 |

#### H5 doctor-UX rule

**Doctor MUST NOT suggest a mutating command for H5.** The repair
field of an H5 diagnostic must be a non-actionable doctrine pointer
(e.g., "Ambiguous authority split; no automatic repair available
under current doctrine. See WORKTREE-SPEC-AUTHORITY-CONTROL-PLANE-001"),
not a shell command an operator could copy-paste. H5 cannot be
resolved without an authority policy; any UX that implies it can will
permanently encode the wrong source of truth at first use.

#### Doctrinal phrase: lifecycle result honesty

`LIFECYCLE-ROLLBACK-FAILURE-HARNESS-001` proved that the
lifecycle-transaction outcome `ok({kind: 'partial_failure_recovered'})`
can be returned while governance state (registry vs. spec YAML
coherence) and external state (git worktrees, filesystem) are NOT
actually recovered. The closure phrase

> **transaction-layer recovery observed; governance/external-state recovery not guaranteed**

is hereby promoted to a doctrinal phrase. Future specs that describe
operations composing writes outside `runLifecycleTransaction` MUST
refuse to equate transaction-layer recovery with governance recovery.
Stricter result kinds (`transaction_recovered`, `governance_recovered`,
`external_state_recovered`) are deferred doctrinal debt; not required
for v11.2 unless half-state detection surfaces a concrete UX failure.

#### Half-state authority decision matrix (Decide)

`WORKTREE-SPEC-AUTHORITY-CONTROL-PLANE-002` (the Decide slice; the `-001`
id is closed `superseded`, deferred from v11.1.x) resolves, per half-state
class, **which state surface is authoritative** and **whether repair is
eligible**. This is doctrine that the future Repair slice
(`PRUNE-REPAIR-WORKTREE-001`) MUST conform to — it does not itself execute.

Authority surfaces, ranked by what each is the source of truth *for*:

- **`worktrees.json` + `claims/bridge.json`** — authority for *which worktrees
  are bound and to whom* (the binding control plane).
- **git worktree list + canonical filesystem** — ground truth for *whether a
  worktree physically exists*.
- **canonical `.caws/specs/*`** — authority for *spec existence and the spec's
  declared `worktree:` binding*. Worktree-local `.caws/specs/*` bytes are
  **never** authoritative (see invariant 10).
- **`events.jsonl`** — immutable audit history; authority for *what happened*,
  never a target to mutate into agreement.

| Class | Observable contradiction | Authoritative surface(s) | Repair | Auto-repair later? | Operator UX |
|---|---|---|---|---|---|
| **H1** Ghost registry entry | `worktrees.json[name]` exists; git + canonical fs show no worktree dir | git/fs (existence) win → the registry entry is stale | **Unambiguous** — drop the stale registry entry | **Yes** | Command |
| **H2** Registry → missing spec | `worktrees.json[name].specId === id`; spec `id` not loaded | spec store (existence) is authority, **but** "not loaded" ≠ "deleted" (parse error / transient) | **Ambiguous** — could be a recoverable spec | No (until disambiguated: confirmed-absent vs unloadable) | Doctrine pointer |
| **H3** Spec → registry one-sided | spec has `worktree: <name>`; no `worktrees.json[name]` | registry (live worktrees) is authority → the spec field is stale **iff** the spec is closed/archived | **Unambiguous for closed/archived** (clear the field); **ambiguous for active** (recreate-vs-clear) | Yes for closed/archived; no for active | Command (closed/archived) / pointer (active) |
| **H4** Ghost spec binding (`destroyWorktree` post-fault) | registry absent; git worktree absent; spec still has `worktree: <name>` | registry + git agree the worktree is gone → spec field is stale | **Unambiguous** — clear the spec `worktree:` field | **Yes** | Command |
| **H5** 3-way contradiction (`bindWorktreeRepair` post-fault) | `worktrees.json[name].specId === idB`; spec `idA` has `worktree: <name>`; spec `idB` lacks `worktree:` | **No surface wins** — registry, specA, and specB make three mutually-incompatible claims | **Forbidden** — no winner under current doctrine | **No** — requires a separate, explicitly-justified resolution slice | Doctrine pointer (never a command) |
| **H6** Foreign physical worktree | git lists a worktree path; no `worktrees.json` entry references it | git (it physically exists) — but **CAWS does not own it** | **Forbidden** — not CAWS's state to mutate | No — advisory only | Doctrine pointer / informational (INFO) |
| **Event orphan** `worktree_created` w/ no live binding | `events.jsonl` has `worktree_created` for `name`; no live registry entry, no spec binding, no later `worktree_destroyed` | control plane (registry + spec) says it does not exist; the event is honest immutable history | **Forbidden as deletion** — the event cannot be un-appended; "repair" here is reconciliation/acknowledgement, not mutation | No — the audit record is correct; residue is informational | Doctrine pointer |

Reading the matrix:

- **Unambiguous (H1, H4, H3-closed/archived)** — exactly one surface is the
  source of truth and the contradiction is a stale *copy* of a decided fact.
  These are the *only* classes `PRUNE-REPAIR-WORKTREE-001` may mutate, and only
  in the direction the matrix names. They are the Repair slice's precise,
  non-creative target list.
- **Ambiguous (H2, H3-active)** — the winning surface is knowable but requires a
  disambiguating observation the current snapshot does not carry (e.g. "spec
  unloadable vs. genuinely deleted"). Repair waits on that observation; the
  diagnostic points to doctrine, not a command.
- **Forbidden (H5, H6, event orphan)** — repair is doctrinally refused. H5 has no
  winner; H6 is not CAWS's state; the event orphan's authority record is already
  correct and immutable. A UX that implies any of these is auto-repairable would
  encode a wrong source of truth at first use.

The **`destroyWorktree` external-half-state** boundary from
`CAWS-LIFECYCLE-ROLLBACK-HARNESS-COMPLETE-001` holds: when the event lifecycle is
coherent (`created`+`bound`+`destroyed` all chained) but the external git dir was
already irreversibly removed, this is **not** generically inferable from current
state — it is **out of scope for this Decide slice** and would need new result
metadata (the deferred `external_state_recovered` result kind) before doctor or
repair could distinguish it. The matrix does not pretend to decide it.

#### Functional-complete bar for the v11.2 worktree/authority line

| # | Criterion | Current state |
|---|---|---|
| 1 | Authority doctrine is explicit: CAWS state is control-plane; worktrees are execution sandboxes; bindings may be present locally but control-plane state is not duplicated as mutable truth | **Done** — promoted to §6 invariant 16 by `WORKTREE-SPEC-AUTHORITY-CONTROL-PLANE-002` |
| 2 | Overlapping specs reconciled: `WORKTREE-CAWS-SHARED-STATE-001` superseded, absorbed, or sequenced behind the authority spec | **Done** — `WORKTREE-CAWS-SHARED-STATE-001` was never created on disk (recon candidate only); its supersession was recorded in the `-001` closure. No further action. |
| 3 | Doctor detects all known half-states: H1–H6 have typed diagnostics and regression fixtures | **Done** — `WORKTREE-DOCTOR-HALF-STATE-001` shipped H1–H6 diagnostics + the event-backed orphan rule, with a regression suite |
| 4 | Detection is mutation-free: doctor/reconcile never writes specs, registry, event log, git worktrees, or repairs | Doctrinally true (§6.3); to be locked as a regression in slice #2 |
| 5 | Repair is explicit and scoped: `prune`/`repair` operate only on unambiguous classes; H5 refuses until control-plane policy resolves it | **Policy decided** (§1.4 decision matrix): unambiguous = H1, H4, H3-closed/archived; forbidden = H5, H6, event orphan; ambiguous = H2, H3-active. `PRUNE-REPAIR-WORKTREE-001` is now unblocked **for the unambiguous set only** |
| 6 | Lifecycle results stop overclaiming: either result naming changes, or every caller that mutates outside the transaction maps transaction-layer partial recovery into an honest diagnostic | Doctrinal phrase recorded (above); production-code change deferred |
| 7 | Worktree-local spec copies are neutralized: editing `.caws/specs/*.yaml` inside a worktree cannot silently create false truth | **Policy decided** — invariant 16 + §1.4 materialization row: worktree-local spec bytes are ignored-as-authority; sparse-checkout exclusion (invariant 15) is the mechanical guard. (Edit/Write tool-surface enforcement is `worktree-write-guard.sh`, already shipped; Bash-surface gap is tracked separately.) |
| 8 | Migration covered: pre-v11.2 and 10.2-created worktrees with materialized `.caws` state produce explicit diagnostics and a safe migration path | Pending — control-plane spec A7; H1/H6 diagnostics are partial coverage |
| 9 | CI locks behavior: store/doctor tests cover all known states; a future refactor cannot reintroduce hidden split-brain without failing tests | Pending — slice #2 down payment |
| 10 | Release discipline stays intact: branch pushes remain non-release | Holds — tag-driven release contract from `CAWS-RELEASE-TAG-DRIVEN-001` |

#### Slice ordering for the v11.2 worktree/authority line

1. `PRUNE-REPAIR-WORKTREE-RECON-001` — recon/amendment; no implementation. **Done.**
2. `WORKTREE-DOCTOR-HALF-STATE-001` — mutation-free diagnostics for H1–H6 + event-backed orphan. Diagnose only. **Done.**
3. `WORKTREE-SPEC-AUTHORITY-CONTROL-PLANE-002` — authority rule per H-class (especially H5) and worktree-local spec materialization policy. Decide only. **Done** (the `-001` id is closed `superseded`; `-002` carries the deliverable: §6 invariant 16 + §1.4 decision matrix).
4. `PRUNE-REPAIR-WORKTREE-001` — repair only for the classes the matrix marks **unambiguous** (H1, H4, H3-closed/archived). Now unblocked for that set; H2/H3-active (ambiguous) and H5/H6/event-orphan (forbidden) stay out of scope. **Optional pre-repair contract slice** first if a class needs new event/result metadata (e.g. the deferred `external_state_recovered` result kind for the `destroyWorktree` external-half-state) — otherwise proceed directly.
5. `WORKTREE-NODE-MODULES-001` (or equivalent) — execution ergonomics so agents stop falling back to main for builds/tests. Promoted from deferred only if friction blocks every worktree slice.

Other v11.2 deliverables from the §1 plan list — leases,
`claim_taken_over` event emission, bridge bindings (`agents list/show`
shipped in v11.1 — not a v11.2 deliverable) — are tracked separately
and **not displaced** by this ordering. The worktree/authority line is
a parallel lane.

#### Drift note (recorded, not fixed)

§1.3's framing implies `non_functional` permits only `reliability` and
`performance`. The kernel schema at
`packages/caws-kernel/src/schemas/spec.v1.json` actually permits
`performance`, `security`, `accessibility`, and `reliability`. Several
existing specs use `security` legitimately (e.g.,
`WORKTREE-CAWS-SHARED-STATE-001`, `PRUNE-REPAIR-WORKTREE-001`).
Recorded as doctrine-doc hygiene to track; not fixed in this slice
to preserve recon's no-side-edit discipline.

---

## 2. Command surface

The v11.0.0 governed core shipped eight command groups. The current v11 line has
**fourteen** top-level commands/groups (plus the auto-generated `help`): it
restored `worktree` (ninth) and `specs` (tenth) as lifecycle commands,
added `events` (eleventh) for hash-chained audit-log maintenance
(`migrate/rotate/verify-archive`), `agents` (twelfth) for multi-agent
observability, `message` for directed inter-agent messages, and `prepush` — the governed pre-push range
check (MULTI-AGENT-PUSH-RANGE-GUARD-001) that classifies the outgoing
commit range and refuses commits not attributable to the current slice
without running `git push` itself. `agents` shipped ahead of the broader
v11.2 multi-agent plan: its `register/heartbeat/stop/list/show/prune`
subcommands are all live. `message send/poll` is deliberately not authority:
message bodies are unverified claims until checked against repo/runtime state.
The remaining multi-agent authority line (bridge claims and lease-backed
ownership) is still forthcoming. Every command group is
implemented in `packages/caws-cli/src/shell/`, composed atop
`packages/caws-cli/src/store/` and `packages/caws-kernel/`.

### v11.0.0 (governed core)

| Command | Purpose |
|---|---|
| `caws init` | Bootstrap canonical vNext `.caws/` state. Idempotent. Refuses legacy residue. No `--force`. |
| `caws doctor` | Drift detection over `.caws/` state; exits 0 (clean) / 1 (findings or load errors) / 2 (composition failure). |
| `caws status` | Read-only dashboard: project, current context, claim, doctor findings. Always observability — never mutates. |
| `caws scope show <path>` | Explain the scope decision for `<path>`; always exits 0. |
| `caws scope check <path>` | Enforce the scope decision for `<path>`; exits 0 on admit, 1 otherwise. |
| `caws claim [--takeover]` | Surface or take ownership of the current worktree; writes `prior_owners` audit on takeover. |
| `caws gates run --spec <id>` | Run CAWS-local policy evaluators against current changes; policy decides block/warn/skip; appends one `gate_evaluated` event per policy-declared gate. |
| `caws evidence record` | Append a typed evidence event (`test`/`gate`/`ac`) to `.caws/events.jsonl`. |
| `caws waiver create/list/show/revoke` | Manage waiver records that filter matching gate violations. Singular surface — no plural alias. |

**Quality-gates package removal (2026-06-12).**
`@paths.design/quality-gates` is removed as a standalone batch-scanner
package. The current safety posture is hooks-first for edit-time advisory
signals, with `caws gates run` remaining the governed policy-gate runner.
The hook-pack checks implement the load-bearing edit-time quality checks;
they do not import, execute, or publish an external quality package. The
removal rationale and the v11.1.2 release-governance incident are
recorded in `docs/architecture/quality-gates-deprecation.md`.

**`caws gates run` post-quality-gates decision (2026-05-29).**
`GATES-RUN-POST-QG-DOCTRINE-001` chooses Option B as the transition
contract: keep `caws gates run` in the v11 canonical command surface, but
stop spawning `caws-quality-gates` from the production command path. The
command now evaluates CAWS-local policy checks (`budget_limit`,
`scope_boundary`, `spec_completeness`) and still appends one
`gate_evaluated` event per policy-declared gate. The former package-backed
code-quality checks move to hook-pack advisory surfaces until a later
doctrine slice decides whether hook-emitted events become the target
Option A.

### Added in v11.1 (lifecycle restoration)

| Command | Purpose |
|---|---|
| `caws worktree create/list/bind/destroy/merge` | Worktree lifecycle on the vNext substrate. Canonical path for parallel agent work. |
| `caws worktree migrate-registry` | Convert v10.2 legacy-envelope `.caws/worktrees.json` into the v11 flat-map shape. Idempotent on already-flat files. |
| `caws worktree repair-sparse <name>` | Restore the `/*` + `!/.caws/specs/` sparse-checkout invariant on a linked worktree. Idempotent and non-destructive: refuses dirty/untracked content under `<wt>/.caws/specs/` rather than stashing, cleaning, resetting, or deleting. Added by `WORKTREE-SPEC-CANONICAL-ACCESS-GUARD-001`. |
| `caws worktree repair` | Repair unambiguous worktree/spec half-states surfaced by `caws doctor`: prune ghost registry entries and clear dead spec→worktree bindings. Never creates or deletes a git worktree directory. |
| `caws specs create/list/show/recover/retire-draft/activate/amend-scope/close/archive/prune-archive/migrate/validate` | vNext spec lifecycle. Exits by state: draft → activate or retire-draft, active → close, closed → archive. |
| `caws specs activate <id>` | Governed activation of a pre-authored draft spec. Draft-only: patches `lifecycle_state: active`, refreshes `updated_at`, and appends `spec_activated`. This is the sanctioned alternative to hand-editing lifecycle state before `caws worktree create --spec <id>`. |
| `caws specs recover <id>` | Recover an archived OR retired spec body via the event log + git history. Topology-independent; does NOT mutate `.caws/specs/`. |
| `caws specs retire-draft <id>` | Governed retirement of a never-activated DRAFT spec (CAWS-SPECS-RETIRE-DRAFT-001). Draft-only: refuses active (use close), closed (use archive), archived. Tombstone — deletes the draft YAML and appends a recoverable `spec_retired` event (recover via `specs show --archived` / `specs recover`). The sanctioned alternative to raw `git rm .caws/specs/<id>.yaml`, which bypasses the audit + recovery path. |
| `caws specs amend-scope <id>` | Governed scope amendments for active specs. Use one invocation for a logical set of `--add`/`--remove` entries. |
| `caws specs prune-archive` | Compatibility no-op. Archived spec bodies under `.caws/specs/.archive/` are canonical again and are not pruned by CAWS; `--apply` is accepted for compatibility and removes nothing. |
| `caws specs migrate` | v10→v11 spec YAML migrator. Dry-run by default; `--apply --partial` for partial migration. |
| `caws specs validate` | Validate spec YAML records and optionally apply safe date normalization repairs with `--fix-dates --apply`. |
| `caws events migrate/rotate/verify-archive` | Hash-chained audit-log maintenance over `.caws/events.jsonl`. |
| `caws agents register/heartbeat/stop/list/show/prune` | Agent-liveness substrate + read-only inspector. Shipped ahead of the broader v11.2 multi-agent plan: `list/show` restore agent visibility removed in v11.0.0; `register/heartbeat/stop` back the hook pack; `prune` is operator cleanup. |
| `caws message send/poll` | Directed inter-agent messages over `.caws/messages.jsonl`. Separate from the audit chain and not authority. |
| `caws claim --takeover` | Acquire ownership from a foreign session; writes `prior_owners` audit entry. |
| `caws claim --paths <path>` | Declare working-tree path ownership metadata on the current session's lease (SESSION-OWNERSHIP-METADATA-001). |
| `caws prepush [--base <ref>] [--ack <sha>]` | Governed pre-push range check (MULTI-AGENT-PUSH-RANGE-GUARD-001). Enumerates the outgoing commit range (`<base>..HEAD`, default `origin/main`), classifies each commit's spec provenance (file-touch + commit-subject), escalates foreign-worktree presence, and refuses commits not attributable to the current slice unless `--ack <sha>`'d. Diagnose/decide only — never rewrites, drops, or pushes. v1 is opt-in (`prepush`-first; no raw `git push` interception). |

### Planned in v11.2 (multi-agent authority and observability)

| Command | Purpose |
|---|---|
| `caws claim --spec <id>` | Bridge claim — session ↔ spec binding outside a worktree. |
| `caws claim --release [--spec <id>]` | Explicit relinquishment of a bridge binding. |
| `caws worktree prune` | Remove ghost worktree registry entries and ghost bridge bindings. Never removes live git worktrees. |
| `caws worktree reconcile` | Read-only drift diagnostic across git worktrees, registry, spec fields, and bridge bindings. |

### Shipped ahead of v11.2 (MULTI-AGENT-ACTIVITY-REGISTRY-001)

These operational verbs ship the `.caws/leases/<session_id>` substrate
that `caws agents list/show` reads. Both the write verbs (`register`,
`heartbeat`, `stop`, `prune`) and the read surface (`list`, `show`)
went live in v11.1.x ahead of the full v11.2 release because the
canonical-checkout hijack incident (failure-lineage Entry 19) needed
visibility immediately. The write verbs are invoked exclusively by the
Claude Code hook pack v3 at SessionStart / PreToolUse / Stop; humans
rarely type them directly. `list` and `show` are typed directly by
operators and agents inspecting session state.

| Command | Purpose |
|---|---|
| `caws agents register --session-id <id> --platform <name> --reason <reason>` | Upsert the calling session's lease at `.caws/leases/<id>.json` with status=active. Hook-invoked at SessionStart. |
| `caws agents heartbeat --session-id <id> --throttle <ms> --json --include-active-summary` | Refresh `last_active` (respects throttle), and emit CAWS-native JSON describing all currently-active leases. Hook-invoked at PreToolUse; the hook script (not the CLI) composes Claude Code's `hookSpecificOutput.additionalContext` envelope from this JSON. |
| `caws agents stop --session-id <id>` | Mark the session's lease as `status=stopped` with `stopped_at`. Hook-invoked at Stop; best-effort (SIGKILL/crash bypasses it — heartbeat staleness is the primary liveness signal). |
| `caws agents prune --dead [--apply]` | Operator-driven cleanup of active/stopping leases on this host whose owning process is gone. Default is dry-run. Never auto-runs. |
| `caws agents prune --status <stopped\|stale> --older-than-ms <ms> [--apply]` | Operator-driven retention cleanup of stopped or stale lease records. Default is dry-run. Never auto-runs. |

**Hook IO boundary:** the CLI is hook-protocol-agnostic. `caws agents
heartbeat --json` emits CAWS-native JSON only. The Claude Code envelope
(`hookSpecificOutput.additionalContext`) is composed by
`templates/hook-packs/claude-code/agent-heartbeat.sh` via inline
`node -e`, not via `jq` (the hook pack has no `jq` dependency). A future
Cursor or terminal integration consumes the same CAWS-native JSON and
emits its own protocol-specific envelope. Changing Claude Code's hook
envelope format does not require changing kernel lease logic or store
lease writes.

### Help banner (v11.0.0 historical snapshot)

> **Historical — captured at v11.0.0.** The current surface has
> fourteen top-level commands/groups: `init doctor status scope claim gates
> evidence events waiver specs worktree agents message prepush` plus the auto-generated `help`. Run
> `caws --help` against the installed CLI to see the live banner.

```
$ caws --help   # v11.0.0 snapshot — 8 groups only
Commands:
  init      Bootstrap the canonical vNext .caws/ project state...
  doctor    Run drift detection against the current .caws/ state
  scope     Evaluate file paths against the bound spec scope
  status    Read-only dashboard...
  claim     Surface ownership of the current worktree...
  gates     Run quality gates against the current changes (policy-driven)
  evidence  Record typed evidence events into .caws/events.jsonl
  waiver    Manage CAWS waivers...
```

Exactly these eight groups (plus auto-generated `help`) at v11.0.0. See
§2 tables above for the full v11.1.x surface.

### Count reconciliation (against `caws-next` @ `52d6165`, v11.0.0 historical)

> **Historical — captured at v11.0.0 (8 vNext groups).** The `VALID_COMMANDS`
> rewrite happened in slice 8a3; audit 8a4 confirmed equality. Current
> later v11.x releases have a larger surface — these counts reflect the pre-removal state.

| Source | Count | Notes |
|---|---|---|
| `node dist/index.js --help` rows (excluding Commander's auto-generated `help`) | 32 | 8 vNext + 24 legacy |
| `node dist/index.js --help` rows (including `help`) | 33 | adds Commander's built-in row |
| `VALID_COMMANDS` entries in `src/index.js` | 28 | suggester list for unknown-command fallback |
| `VALID_COMMANDS` entries with no current registration | 1 | `quality-gates` (alias removed in slice 6c, never cleaned from suggester) — **stale** |
| Currently-registered commands missing from `VALID_COMMANDS` | 5 | `agents`, `claim`, `doctor`, `evidence`, `test-analysis` (drift; suggester does not learn them) |

The `VALID_COMMANDS` discrepancy is an existing drift, not a v11 regression.
8a3 will rewrite `VALID_COMMANDS` to match exactly the post-removal v11 surface;
8a4 audit 1 will assert the equality.

---

## 3. Removed in v11

The legacy command surface registered in `packages/caws-cli/src/index.js`
ships in v10.2.x but is **removed in v11.0.0**. This section catalogs
every removed group, the reason category, and what (if anything) replaces
it.

Reason categories:

- **AC** — *authority conflict.* The legacy command writes to overlapping
  state, calls `appendEvent` on a parallel chain, or interprets specs
  through the legacy `spec-resolver` (which falls back to
  `working-spec.yaml`). Mixed-regime hazard.
- **LG** — *unsupported lifecycle gap under A1.* The command is part of
  the spec or worktree lifecycle; v11.0.0 explicitly does not ship a
  vNext replacement. Returns in v11.1.
- **PNC** — *peripheral / non-core.* The command is not part of the v11
  authority surface and is not depended on by the governed core.
- **PE** — *legacy provenance/evidence conflict.* The command writes to
  `.caws/provenance/`, which is superseded by `.caws/events.jsonl`.
- **SH** — *old scaffold/hook risk.* The command installs or generates
  legacy regime artifacts (git hooks that call removed commands, scaffold
  templates that write `working-spec.yaml`, etc.).

| Command | Handler | Mutates? | State touched | Reason | Replacement |
|---|---|---|---|---|---|
| `scaffold` | `src/scaffold/index.js` (793 LOC) | yes | `.caws/`, `.git/hooks/`, IDE configs, gitignore | **SH** | `caws init` (governed core only) |
| `validate \| verify` | `src/commands/validate.js` (357 LOC) | yes (`appendEvent` on legacy log) | `working-spec.yaml` fallback via `spec-resolver`; legacy `events.jsonl` writer | **AC** | `caws doctor` covers spec health; v11.1 will re-add explicit validation |
| `archive <change-id>` | `src/commands/archive.js` (500 LOC) | yes | `.caws/provenance/chain.json`, `working-spec.yaml` | **PE + LG** | (none in v11.0; provenance superseded by events.jsonl) |
| `specs list/create/show/update/delete/close/archive/conflicts/migrate/types` | `src/commands/specs.js` (1656 LOC) | yes (`appendEvent` on legacy log) | `.caws/specs/<id>.yaml`, `.caws/specs/registry.json`, legacy `working-spec.yaml` (migrate) | **LG + AC** | **Removed in v11.0; RESTORED in v11.1** as vNext `caws specs create/list/show/close/archive/recover/prune-archive/migrate`. Note: `update`, `delete`, `conflicts`, `types` are NOT restored — they have no v11.1 replacement. |
| `sidecar drift/gaps/waiver-draft/provenance` | `src/commands/sidecar.js` (74 LOC) | no (read + advisory) | reads via `sidecars/` subsystem | **PNC** | (none; advisory only) |
| `mode current/set/compare/recommend/details` | `src/commands/mode.js` (269 LOC) | yes | `.caws/mode.yaml` (separate state file) | **PNC + AC** | (none; complexity tier metadata not in v11) |
| `tutorial [type]` | `src/commands/tutorial.js` (480 LOC) | no | none | **PNC** | (none) |
| `plan <action>` | `src/commands/plan.js` (438 LOC) | yes (writes plan markdown to `--output`) | user-specified path | **PNC** | (none) |
| `worktree create/list/destroy/merge/prune/repair/bind/claim` | `src/commands/worktree.js` (502 LOC) | yes | `.caws/worktrees.json`, git worktrees | **LG** | **Removed in v11.0; RESTORED in v11.1** as vNext `caws worktree create/list/bind/destroy/merge/migrate-registry/repair-sparse`, plus **`caws worktree repair`** (the governed unambiguous-half-state executor — ghost-registry prune + dead spec→worktree binding clear). `caws claim` handles ownership. Broad `prune`/`reconcile` over ambiguous classes remain deferred. |
| `agents list/show <id>` | `src/commands/agents.js` (124 LOC) | no (read-only) | reads `.caws/agents.json` | **PNC** (overlaps with vNext `status`/claim panel) | **Removed in v11.0; RESTORED in v11.1** as `caws agents list/show` (plus `register/heartbeat/stop/prune`). Reads `.caws/leases/` (not legacy `.caws/agents.json`). |
| `session start/checkpoint/end/list/show/briefing` | `src/commands/session.js` (312 LOC) | yes | `.caws/sessions/`, `.caws/sessions.json` (separate state) | **PNC + AC** | v11 doctor does not observe sessions; re-add later if needed |
| `parallel setup/status/merge/teardown` | `src/commands/parallel.js` (242 LOC) | yes | `.caws/parallel/...` (separate state); creates worktrees | **LG** | v11.1 lifecycle work |
| `templates [subcommand]` | `src/commands/templates.js` (237 LOC) | no | reads `templates/` | **PNC** | (none) |
| `diagnose [--fix]` | `src/commands/diagnose.js` (525 LOC) | yes (`--fix`) | various; advertises legacy commands as "core" | **AC** | `caws doctor` is the v11 diagnostic surface |
| `verify-acs` | `src/commands/verify-acs.js` (443 LOC) | yes (`appendEvent` on legacy log) | spec-resolver legacy fallback; legacy `events.jsonl` writer | **AC** | (none in v11.0; planned for v11.1 alongside spec lifecycle) |
| `evaluate [spec-file]` | `src/commands/evaluate.js` (314 LOC) | yes (`appendEvent` on legacy log) | spec-resolver legacy fallback; legacy `events.jsonl` writer | **AC** | (none in v11.0) |
| `iterate [spec-file]` | `src/commands/iterate.js` (417 LOC) | no (read + advisory) | spec-resolver legacy fallback | **AC** | (none in v11.0) |
| `burnup [spec-file]` | `src/commands/burnup.js` (198 LOC) | yes (writes report) | spec-resolver legacy fallback | **AC** | (none in v11.0) |
| `workflow <type>` | `src/commands/workflow.js` (243 LOC) | no (advisory; advertises `caws provenance update`) | spec-resolver | **AC + PNC** | (none) |
| `quality-monitor <action>` | `src/commands/quality-monitor.js` (284 LOC) | varies | spec-resolver | **PNC** | `caws gates run` is the v11 gate surface |
| `tool <tool-id>` | `src/commands/tool.js` (136 LOC) | varies (executes registered tools) | none directly | **PNC** | (none) |
| `test-analysis <subcommand>` | `src/test-analysis.js` (~?) | reads | `working-spec.yaml` ref | **AC + PNC** | (none) |
| `provenance update/show/verify/analyze-ai/init` | `src/commands/provenance.js` (1143 LOC) | yes | `.caws/provenance/chain.json` (separate hash chain), legacy `working-spec.yaml` fallback | **PE + AC** | `.caws/events.jsonl` is the v11 audit chain |
| `hooks install/remove/status` | `src/scaffold/git-hooks.js` (965 LOC) + index.js inline | yes | `.git/hooks/{pre-commit,post-commit,pre-push,commit-msg}` — generated hooks call `caws validate` and `caws provenance update` | **SH** | (none in v11.0; users wire their own hooks against `caws gates run` if desired) |

### 3.5 Non-command shipped code that touches legacy state

These are not command groups but ship in v11 and reach legacy artifacts.
They are tracked here so 8a2 can decide reachability rather than guessing.

| File | Concern | 8a2 audit question |
|---|---|---|
| `src/gates/spec-completeness.js` | Reads `.caws/working-spec.yaml` as the spec source for the `spec_completeness` gate | Is this gate reachable from the v11 surface (`caws gates run`) or only from removed commands like `caws validate` / `caws quality-gates`? |
| `src/cicd-optimizer.js` | Defaults `specPath` to `.caws/working-spec.yaml` | Is this code reachable from any v11-registered command? |
| `src/budget-derivation.js` | Mentions `.caws/working-spec.yaml` in error guidance | Same reachability question. |
| `src/spec/SpecFileManager.js` | Manages `working-spec.yaml` lifecycle | Reachability — likely only used by removed `validate`/`evaluate`/`iterate`/`burnup`. |
| `src/utils/spec-resolver.js` | Defines `LEGACY_SPEC = '.caws/working-spec.yaml'` and falls back to it | Reachable from any v11 surface? Vendored types/utils that the removal pass should orphan. |
| `src/worktree/worktree-manager.js` | Writes/reads `.caws/worktrees.json`; references `working-spec.yaml` | `caws claim` uses parts of this; precise reachability boundary required. |
| `src/utils/event-log.js` | Parallel `appendEvent` writer to `.caws/events.jsonl` (NOT the store) | Reachable only from removed commands? **Invariant 1 violator** if any v11 path reaches it. |
| `src/sidecars/listeners.js` | Registered at startup (`index.js:786-789`) | Side-effect surface; should be removed alongside `sidecar` command. |
| `src/scaffold/git-hooks.js` | Generates hooks calling `caws validate` and `caws provenance update` | Removed in 8a3 alongside `hooks` command. |

8a2 audit 3 (kernel purity) is unaffected by these — the kernel is clean
already. These are CLI-side concerns. The audit will tell us which files
are dead code in v11 (safe to leave dormant; cleaned in 8e) vs which are
still reachable from the v11 surface (must be addressed in 8a3 or
escalated).

### Removal counts

- 24 legacy command groups removed (matches the table above; matches `--help` minus the 8 vNext groups)
- 8 vNext command groups remain
- ~10,650 LOC of legacy handler code (kept on disk for archaeology in v11.0; deleted in v11.1 per Slice 8e)
- `VALID_COMMANDS` rewritten to match the v11 surface exactly (drops 24 legacy entries plus the stale `quality-gates` alias; adds the 5 currently-missing vNext entries `agents`, `claim`, `doctor`, `evidence`, `test-analysis` — minus any of those that are themselves removed; `agents` and `test-analysis` are removed under A1, so the final `VALID_COMMANDS` is exactly the 8 vNext groups)

---

## 4. State files

### Owned by v11

| File | Owner | Notes |
|---|---|---|
| `.caws/specs/<id>.yaml` | store + doctor + scope | Multi-spec authority. No project-level `working-spec.yaml`. |
| `.caws/specs/registry.json` | store | Index over `specs/`. Optional; doctor handles missing/malformed. |
| `.caws/policy.yaml` | store | Single source of truth for gate `mode` (block/warn/skip). |
| `.caws/waivers/<id>.yaml` | store + waiver command | Waivers filter violations; never mutate gate mode. |
| `.caws/worktrees.json` | store + claim + worktree commands | **Authority binding** for worktree ↔ spec ↔ owner. |
| `.caws/agents.json` | store | **Compatibility/identity registry** — durable identity metadata (platform first-seen, capsule references, prior_owners pointers). **Not the presence source.** See `.caws/leases/` for presence. |
| `.caws/events.jsonl` | **store ONLY** (`appendEvent` in `events-store.ts`) | Hash-chained, append-only durable governance/audit facts. First `appendEvent` creates the file under lock. Never required at rest. |
| `.caws/leases/<session_id>` (v11.2) | store (`leases-store.ts`) | **Ephemeral operational cache.** Per-session liveness file. Content-authoritative (`last_command_at` is the primary timestamp). Writes are non-blocking and outside `lifecycle-transaction`. Never participates in governance authority decisions. |
| `.caws/claims/bridge.json` (v11.2) | store (`claim-store.ts`) | **Authority binding** for non-worktree session ↔ spec. Mutated only through `lifecycle-transaction`. |

**State-file role split:** liveness (leases) and authority (worktrees,
bridge claims) are deliberately separated. `agents.json` is compatibility/
identity metadata only — it is **not** the canonical presence source from
v11.2 onward. This split prevents the dual-write drift that would
re-introduce the mixed-regime hazard the rewrite eliminated.

### Refused by v11 (legacy residue)

| File | Detection | Action |
|---|---|---|
| `.caws/working-spec.yaml` | `init-store.findLegacyResidue` and `doctor-snapshot.observeInitResidue` (both via `fs.statSync().isFile()`) | `caws init` refuses with `INIT_LEGACY_RESIDUE`; `caws doctor` emits `doctor.init.legacy_working_spec_present` (error). |
| `.caws/working-spec.schema.json` | same | `caws doctor` emits `doctor.init.legacy_working_spec_schema_present` (error). |
| `.caws/provenance/` | (not yet a doctor rule) | Superseded by `events.jsonl`. Future: doctor rule to flag presence. |
| `.caws/sessions/`, `.caws/sessions.json` | (no v11 awareness) | Created only by removed `session` command. Inert in v11. |
| `.caws/parallel/...` | (no v11 awareness) | Created only by removed `parallel` command. Inert in v11. |
| `.caws/mode.yaml` | (no v11 awareness) | Created only by removed `mode` command. Inert in v11. |
| `.caws/quality-gates-report.json` | (no v11 awareness) | Cache file; can be deleted manually. |

---

## 5. Exit-code conventions

| Code | Meaning |
|---|---|
| `0` | Success / observation. The command did what was asked, or surfaced state without mutating. |
| `1` | Domain failure. A gate failed, doctor found drift, validation rejected input, scope refused admit. The command worked correctly and reported the failure. |
| `2` | Composition failure. Could not establish preconditions: not in a git repo, cannot read `.caws/`, missing required tooling. |

Doctor specifically: exit 0 when clean, 1 when findings or load errors are
present, 2 on hard composition failure (e.g., not a git repo).

Status specifically: always exits 0. Status is observability — it does
not gate other operations.

Scope: `show` always 0; `check` 0 on admit, 1 on refuse, 2 on composition
failure.

---

## 6. Architectural invariants

These are non-negotiable for v11. A change that violates one of these is
either a regression to fix, or a deliberate doctrine shift requiring an
update to this document.

1. **`events.jsonl` is written ONLY through `appendEvent` in
   `packages/caws-cli/src/store/events-store.ts`.** That function
   acquires `events.jsonl.lock`, computes the hash chain, validates the
   event against its JSON Schema, and writes atomically. No other code
   in v11 writes to that file.

2. **`policy.yaml` owns gate `mode` (`block` / `warn` / `skip`).**
   Waivers filter violations *out of* the disposition calculation; they
   do not change the gate's policy mode. Removing all waiver matches
   does not magically downgrade a `block` gate to `warn`.

3. **Doctor is pure.** `packages/caws-kernel/src/doctor/` has no
   `fs`/`path`/`process.env`/`Date.now()`/`new Date()` access in
   executable code. Time enters via the injected `now: Date` field on
   `DoctorInput`; everything else is constructed by the store.

4. **Missing != malformed.** Registry diagnostics distinguish a missing
   file (no diagnostic, treated as empty) from a malformed file (warning
   or error diagnostic carrying the cause). The same distinction applies
   to specs and waivers.

5. **`events.jsonl` is never required at rest.** The first call to
   `appendEvent` creates it. Doctor and status do not require its
   existence; they only require its hash chain to verify when present.

6. **Init is non-destructive.** `caws init` is idempotent; it never
   overwrites existing files except to add missing canonical layout
   pieces. It never creates `events.jsonl`. It refuses if legacy residue
   is detected.

7. **Status is observability.** `caws status` never mutates governance
   state. Running it any number of times produces no `.caws/` byte
   changes *in the governance dimension* — specs, policy, waivers,
   worktrees.json, bridge claims, events.jsonl. (Mutation-negative test
   in `tests/shell/doctor-status-7c3.test.js`.) **From v11.2 onward, the
   carve-out is explicit:** repeated read-only commands may update
   `.caws/leases/<session_id>` mtime/content. Leases are ephemeral
   operational cache (invariant 9) and are exempt from the governance-
   mutation invariant. Status MUST NOT mutate anything other than the
   current session's lease entry.

### v11.2 invariants

The following are added in v11.2 to support the multi-agent surface.
Same authority as invariants 1–7: a violation is either a regression to
fix or an explicit doctrine shift requiring an update to this document.

8. **Stale lease is evidence, never authority.** A stale lease may
   justify a louder warning, a richer `agents list` display, or context
   inside a takeover diagnostic. It MUST NOT silently authorize a
   takeover or relax any refusal. The only authority transition is:
   prior owner exists → new session supplies `--takeover` →
   `worktrees.json` (or `claims/bridge.json`) updates and
   `claim_taken_over` appends in one lifecycle transaction. Paused
   sessions are not ended sessions.

9. **Liveness is operational cache; authority is governance state.**
   The two are split into separate stores with different invariants:
   `.caws/leases/*` is ephemeral operational cache; `.caws/events.jsonl`
   is durable governance/audit facts; `.caws/policy.yaml` is
   configuration; `.caws/worktrees.json` and `.caws/claims/bridge.json`
   are authority bindings; `.caws/agents.json` is compatibility/identity
   metadata. No store may write to another's domain.

10. **No heartbeat events.** `events.jsonl` is reserved for durable
    governance facts. Lease writes (creation, refresh, expiry) MUST NOT
    append events. There is no `lease_created`, no `lease_refreshed`, no
    `lease_expired`. Operator queries see lease state via `caws agents
    list`; the audit trail lives in claim/takeover/release events, not
    lease events.

11. **Lease writes never block work, never corrupt governance state.**
    Lease write failure logs a warning and continues. Lease touches are
    NOT inside `lifecycle-transaction`. A failed lease write MUST NOT
    prevent a `caws claim` (or any other command) from succeeding.
    Lease writes flow through `caws agents register/heartbeat/stop`
    (composed by the agent hook pack, invoked from
    SessionStart/PreToolUse/Stop). Hooks MUST NOT write `.caws/leases/`
    directly; they invoke the CLI which routes through `leases-store.ts`
    so the atomic-write + safe-filename invariants hold.

12. **Bridge bindings do not bypass scope.** A bridge claim is an
    *authority binding* (session ↔ spec), not a *scope expansion*.
    Scope checks still consult `spec.scope.in` for the bound spec. A
    governed write outside `scope.in` still fails normally.

13. **Every authority binding satisfies the seven-slot lifecycle.**
    Worktree bindings and bridge bindings (and any future authority
    binding type) MUST define: acquire (with audit event), observe
    (side-effect-free read path), refuse (typed diagnostics for every
    conflicting acquire scenario), takeover (explicit transition with
    audit), release (explicit relinquishment by owner), retire
    (automatic ending tied to natural lifecycle), prune (operator-driven
    cleanup of ghost/stale entries). Each slot has at least one test.
    A binding type that omits an applicable slot is a doctrine
    violation, not just a missing feature.

14. **`events.jsonl` writers are closed and enumerated; chain
    maintenance is a sanctioned second writer.** The writer surface
    has exactly two functions, both in
    `packages/caws-cli/src/store/events-store.ts`, both holding
    `.caws/events.jsonl.lock`:
    - `appendEvent(cawsDir, body)` — evidence appends. Validates the
      new event body, reads the prior chain via `loadEvents` to compute
      the next `seq` + `prev_hash`, calls `prepareAppend`, writes the
      new line atomically.
    - `rotateEvents(cawsDir, opts)` — chain maintenance (v11.2+).
      Performs a tolerant tail scan (NOT `validateChainedEvent`) to
      capture `prior_tail_hash` + `seq`, computes `prior_file_digest`
      + `actor_shape_stats`, renames the existing file to
      `events.jsonl.archive-<ISO timestamp>`, builds a `chain_rotated`
      genesis body, calls `prepareAppend(null, body)`, writes the new
      file.

    No third writer is permitted. Shell commands and migration tooling
    NEVER write `events.jsonl` directly; they invoke these two functions
    through the exported store surface. The lock primitives stay
    private to `events-store.ts` (per invariant 1's "ONLY through the
    two sanctioned writers" clause). Adding a third writer is a
    doctrine-level decision requiring an update to this document and a
    new invariant, not an implementation choice.

    The `chain_rotated` event payload carries enough evidence to
    cryptographically tie the archive to the new chain externally:
    `prior_tail_hash`, `prior_file_path`, `prior_file_digest` (sha256
    of archive bytes), `prior_line_count`, `prior_chain_status` (enum
    `["parseable_unverified", "unparseable", "empty"]` — `"verified"`
    is deliberately excluded for v10→v11 rotations because the v11
    hash algorithm hashes a structurally different envelope than v10),
    `actor_shape_stats`, `migration_reason`. `caws events
    verify-archive` recomputes the archive's digest + line count and
    asserts match. Tamper detection survives the rotation boundary.

15. **Canonical `.caws/specs/` is the only spec authority surface.**
    Added by `WORKTREE-SPEC-CANONICAL-ACCESS-GUARD-001` (contract
    `canonical-spec-authority-materialization-guard-v1`). Linked
    worktrees MUST NOT use worktree-local `.caws/specs/*` files as
    authority. The sparse-checkout exclusion of `.caws/specs/` on
    `caws worktree create` is the mechanical guard; the canonical
    control-plane resolver (`resolveRepoRoot` walking
    `git rev-parse --git-common-dir`) is the read-path guarantee.
    Worktree-write-guard.sh refuses `Read`/`Write`/`Edit` of
    `<linked-worktree>/.caws/specs/*` before the broad `.caws/*`
    allowlist can exit 0. Worktree-guard.sh refuses every agent-Bash
    `git sparse-checkout` invocation (any subcommand) with a
    diagnostic pointing to `caws worktree repair-sparse <name>`.
    Repair-sparse is non-destructive: refuses dirty/untracked content
    under `<wt>/.caws/specs/` rather than stashing, cleaning,
    resetting, or deleting work. Sparse-checkout is a
    **materialization/recovery invariant**, NOT the authority model
    and NOT the scope-enforcement model — scope authority is
    `scope-guard.sh` reading the canonical spec's `scope.in`/`scope.out`.

16. **Control-plane state is authority; linked worktrees are execution
    sandboxes.** Promoted by `WORKTREE-SPEC-AUTHORITY-CONTROL-PLANE-002`
    (the Decide slice; the `-001` id is closed `superseded`). The CAWS
    control plane — `.caws/worktrees.json` + `.caws/claims/bridge.json`
    (authority bindings), `.caws/events.jsonl` (durable audit),
    `.caws/policy.yaml` (config), and the **canonical** `.caws/specs/*`
    (spec authority, per invariant 15) — is the single source of truth.
    A linked worktree is an execution sandbox: it carries a *reference*
    to its binding, never a mutable *copy* of control-plane truth. No
    control-plane state is duplicated as authoritative bytes inside a
    worktree; where a worktree-local copy exists (e.g. a materialized
    `.caws/specs/*` from a hostile or manual write), it is
    **ignored-as-authority** and may be diagnosed, never consulted (the
    mechanical guard is invariant 15's sparse-checkout exclusion). This
    generalizes invariant 9 (liveness ≠ authority) and invariant 15
    (spec materialization) to the whole control plane, and it is the
    precondition for the half-state authority decision matrix in §1.4:
    "which surface wins" is answerable *because* authority is
    single-sourced. Repair (`PRUNE-REPAIR-WORKTREE-001`) may mutate only
    the classes that matrix marks **unambiguous**, and only in the
    direction it names; ambiguous/forbidden classes (H2, H3-active, H5,
    H6, the event orphan) carry a doctrine pointer, not a command.

---

## 7. Migration guidance for legacy users

Projects upgrading from `caws-cli@10.2.x` to `caws-cli@11.0.0` should:

### Mandatory

1. **Migrate from `working-spec.yaml` to per-feature specs.** Move the
   contents of `.caws/working-spec.yaml` into `.caws/specs/<id>.yaml`
   files. v11's `caws init` and `caws doctor` refuse to run alongside
   `working-spec.yaml`. (The legacy `caws specs migrate` command is
   removed in v11; perform the migration on v10.2.x first, or do it
   manually.)
2. **Delete `.caws/working-spec.schema.json`** if present. Schemas are
   now bundled in the kernel.
3. **Remove `.caws/provenance/`.** The hash-chained audit trail moves to
   `.caws/events.jsonl`. Old provenance data is not migrated; archive it
   if you need historical access.

### Recommended

4. **Replace generated git hooks.** v10.2.x `caws hooks install` wrote
   `.git/hooks/{pre-commit,post-commit,pre-push,commit-msg}` that call
   removed commands (`caws validate`, `caws provenance update`). Either
   remove those hooks or rewrite them to call v11 surfaces (`caws
   doctor`, `caws gates run`, etc.).
5. **Audit `caws scaffold` artifacts.** Templates and IDE integrations
   installed by `caws scaffold` may reference removed commands. Check
   `.cursorrules`, `.claude/`, etc.

### If you need spec or worktree lifecycle commands in v11.0

Pin to `caws-cli@^10.2.x` until v11.1 ships vNext lifecycle commands.
The two CLIs cannot coexist in the same project — they write to
overlapping state.

---

## 9. Slice 8a2 — pre-removal invariant audit (results)

Run as part of Slice 8a2. Stance: a finding is any active shipped path
that can read or write old authority state, or invoke a command marked
for removal. Dormant code (not imported, not registered, not invoked
by hooks/templates, not advertised) is acceptable in v11.0.0 and gets
cleaned in 8e. **Replacement, not continuity.**

### Audit 1 — `events.jsonl` writers outside the event store

The store's `appendEvent` (`packages/caws-cli/src/store/events-store.ts:178`)
is the canonical writer. A second implementation lives in
`packages/caws-cli/src/utils/event-log.js` (`appendEvent` async +
`appendEventSync`). Call sites of the legacy writer:

| Call site | Reachable via v11? | Disposition |
|---|---|---|
| `commands/specs.js:576,866,958,1086` | only via removed `specs` group | orphaned by 8a3 |
| `commands/validate.js:176` | only via removed `validate` | orphaned by 8a3 |
| `commands/verify-acs.js:373` | only via removed `verify-acs` | orphaned by 8a3 |
| `commands/evaluate.js:227` | only via removed `evaluate` | orphaned by 8a3 |
| `commands/gates.js:95` | already dormant (legacy `gates` group unregistered slice 6c) | orphaned by 8a3 file delete |
| `commands/waivers.js:504` | already dormant (legacy plural unregistered slice 7a.4) | orphaned by 8a3 file delete |
| `session/session-manager.js:315,482` | only via removed `session` group | orphaned by 8a3 |

**Result: zero blockers. `utils/event-log.js` is fully orphaned by 8a3.**
Invariant 1 ("events.jsonl ONLY through store appendEvent") will hold
after 8a3 import removal.

### Audit 2 — `working-spec.yaml` active authority paths

Two categories:

**Acceptable refs** (residue detection, refusal, user-facing rule text):
`store/init-store.ts:84` (refused-paths list), `store/specs-store.ts:69`
(loader guard), `store/doctor-snapshot.ts:113` (residue observation),
`kernel/doctor/inspect.ts:636-640` (rule message), `shell/register.ts:76`
(comment), kernel rule constants, generated diagnostic messages.

**Active legacy authority** — every site is reachable only via removed
commands or already-dormant subsystems:

| File | Caller | Disposition |
|---|---|---|
| `gates/spec-completeness.js:25` | only `gates/pipeline.js` → only `commands/gates.js` (already dormant) | orphaned by 8a3 |
| `cicd-optimizer.js:29` | no callers found | already dormant |
| `test-analysis.js:96` | only via removed `test-analysis` group | orphaned by 8a3 |
| `worktree/worktree-manager.js:289` | only via removed `worktree`/`specs`/`scope`(legacy)/`parallel` | orphaned by 8a3 |
| `spec/SpecFileManager.js` | only via removed `validate`/`evaluate`/`iterate`/`burnup` | orphaned by 8a3 |
| `utils/spec-resolver.js:51` (`LEGACY_SPEC` fallback) | reachable from many removed commands | orphaned by 8a3 |
| `utils/quality-gates-utils.js:57` | only via removed `gates`/`quality-monitor` | orphaned by 8a3 |
| `validation/spec-validation.js:584` | only via removed `validate` | orphaned by 8a3 |
| `commands/status.js:26,507` | already dormant (legacy status not imported) | orphaned (file delete in 8e) |
| `commands/init.js:605,746` | already dormant (legacy init not imported) | orphaned (file delete in 8e) |
| `generators/working-spec.js` | imported by `index.js:80` AND **exported via `module.exports` (line 870-871)** as part of caws-cli public API | **8a3 must remove the module.exports block too** (public-surface breaking change consistent with A1) |
| `utils/finalization.js`, `error-handler.js`, `utils/detection.js`, `budget-derivation.js` | text/observation only (no writes) | acceptable |
| `session/session-manager.js:123` | only via removed `session` group | orphaned by 8a3 |

`detectCAWSSetup()` runs at startup (`config/index.js:29` ← `index.js:86`)
and reads `working-spec.yaml` existence as one of many capabilities. It
**does not write**. Acceptable for v11; cleaned by 8a3 import orphaning.

**Result: zero blockers. All active legacy authority paths are reachable
only via 8a3-removed commands.** One 8a3 note: `index.js:80` import +
`module.exports` block at lines 870-871 must be removed (public-API
breaking change for `generateWorkingSpec`/`validateGeneratedSpec`).

### Audit 3 — kernel purity drift

Grep for `fs`/`path`/`process.env`/`Date.now()`/`new Date(` across
`packages/caws-kernel/src/**/*.ts`. Hits classified:

- `evidence/validate.ts:274` — string content of an error message. Not
  executable. Acceptable.
- `doctor/types.ts:10`, `worktree/types.ts:18`, `worktree/index.ts:4` —
  comments. Not executable. Acceptable.
- `policy/derive-budget.ts:152, 160` — `new Date(string)` for ISO
  parsing. Deterministic input conversion, not clock access. Acceptable.
- **`policy/derive-budget.ts:150` — `if (now === undefined) return new Date()`.**
  Wall-clock fallback. **Blocker for invariant 3 ("kernel is pure").**

**Fix landed inline (8a2):**
- Made `DeriveBudgetOptions.now` required (`Date | string`, no `?`).
- Removed the wall-clock fallback in `resolveNow`; throws
  `deriveBudget: \`now\` is required` when called without `now`.
- Tightened the function signature: `options: DeriveBudgetOptions` (no
  default `{}`). Tests and callers already supply `now`; verified no
  call site relied on the implicit fallback.
- Kernel typecheck + 456/456 kernel tests still pass after the change.

### Audit 4 — hook/scaffold templates and other v11-shipped strings invoking removed commands

Two distinct surfaces:

**A. Kernel/shell user-facing repair strings** — these ship in v11 and
are emitted to users by v11 commands. Five strings pointed at removed
commands:

| File | Pre-fix | Post-fix |
|---|---|---|
| `shell/commands/claim.ts:121` | "Run \`caws worktree create <name>\` first." | "v11.0.0 does not ship worktree lifecycle commands; create externally and register, or pin to caws-cli@^10.2.x." |
| `kernel/doctor/inspect.ts:158` | repair points to `caws worktree create` | repair states v11 limitation, points to manual fix or v10 pin |
| `kernel/doctor/inspect.ts:193` | `caws worktree destroy` | edits .caws/worktrees.json directly, or v10 pin |
| `kernel/doctor/inspect.ts:231` | `caws worktree destroy/bind` | manual edit or v10 pin |
| `kernel/worktree/transitions.ts:82` | `caws worktree merge/destroy` | manual edit or v10 pin |
| `kernel/worktree/ownership.ts:76` | `caws worktree bind` | replaced with `caws claim` (which IS in v11) |
| `kernel/scope/evaluate.ts:82,96` | `caws worktree bind` | manual edit or v10 pin |

**Fix landed inline (8a2).** All v11-shipped user-facing strings now
either point to v11 commands or are explicit about v11.0.0 not shipping
the lifecycle command (and direct users to either the manual procedure
or the v10 pin).

**B. Templates shipped via `package.json:files` — `templates/` directory.**
116 invocations of removed commands across 30+ template files
(`.cursor/hooks/*.sh`, `.claude/hooks/*.sh`, `.cursor/rules/*.mdc`,
`.github/copilot-instructions.md`, `templates/CLAUDE.md`,
`templates/agents.md`, etc.). Templates are installed only by `caws
scaffold` (which is removed in 8a3); without a v11 installer, they are
unreachable from the v11 CLI surface. **However**, they still ship in
the npm tarball because `package.json:files` lists `"templates"`.

**Disposition:** flagged for **8b packaging slice** — remove `"templates"`
from `package.json:files` so v11 doesn't ship templates that reference
non-existent commands. Not a v11.0.0 cutover blocker but cosmetic
correctness.

### Audit 5 — docs/help advertising deprecated commands

Top-level docs (`README.md`, `CLAUDE.md`, `AGENTS.md`) and `docs/`
extensively reference the legacy command surface. None gate runtime
behavior; they are doc-rot.

| File | Status | Disposition |
|---|---|---|
| `README.md` | ships in npm tarball; advertises ~15 removed commands | **8b finding** (rewrite for v11 before publish) |
| `CLAUDE.md` | repo-only, agent-facing; references removed commands extensively | **8c finding** (rewrite as part of cutover) |
| `AGENTS.md` | repo-only | 8c finding |
| `docs/agents/full-guide.md`, `docs/agents/TUTORIAL.md`, `docs/agents/EXAMPLES.md` | extensive legacy refs | 8c / 8e |
| `docs/guides/hooks-and-agent-workflows.md`, `docs/guides/quality-gates-staged-files.md` | legacy refs | 8c / 8e |
| `docs/MIGRATION_GUIDE_V3.5.md`, `docs/DEPLOYMENT.md`, `docs/ROLLBACK.md`, `docs/agent-workflow-tools.md` | legacy refs | 8c / 8e |
| `docs/architecture/caws-vnext-command-surface.md` (this doc) | legitimately mentions removed commands in §3 "removed in v11" | acceptable (doctrine ownership) |

**Result: zero blockers; significant doc-rot deferred to 8b (`README.md`)
and 8c (`CLAUDE.md`, `AGENTS.md`, `docs/`).**

### Slice 8a2 summary

| Audit | Findings | Blockers fixed in 8a2 | Orphaned by 8a3 | Deferred to 8b/8c/8e |
|---|---|---|---|---|
| 1 — events.jsonl writers | 7 call sites + 1 dormant impl | 0 | 7 | 1 file (8e delete) |
| 2 — working-spec.yaml authority | 16 active sites | 0 | 16 (incl. public exports) | 0 |
| 3 — kernel purity | 1 wall-clock fallback | **1 (derive-budget.ts)** | 0 | 0 |
| 4 — v11-shipped strings + templates | 8 string sites + ~30 template files | **8 (claim.ts, doctor/inspect.ts ×3, worktree/transitions.ts, worktree/ownership.ts, scope/evaluate.ts ×2)** | 0 | templates → 8b |
| 5 — docs/help | extensive doc-rot | 0 | 0 | README → 8b; CLAUDE/docs → 8c/8e |
| **Total** | | **9 blockers, all fixed** | **23 orphans** | |

Verification after fixes (run from `caws-next` HEAD + 8a2 changes):
- `cd packages/caws-kernel && npx tsc --noEmit` clean
- `cd packages/caws-kernel && npx jest` → 456/456 pass
- `cd packages/caws-cli && npx tsc -p tsconfig.vnext.test.json --noEmit` clean
- `cd packages/caws-cli && npx jest tests/shell tests/store` → 232/232 pass
- `npx eslint 'src/**/*.{js,ts}' 'tests/**/*.{js,ts}'` clean
- `find packages/*/dist -name '*.ts' -not -name '*.d.ts'` empty (no source leak)

8a2 closes with:
- One kernel signature change (deriveBudget purity tightening — public
  API breaking but no internal caller relied on the omission).
- Eight user-facing string updates in v11-shipped repair guidance.
- Doc-only audit report (this section).
- No command registrations changed.
- No command removals.
- No compatibility aliases introduced.

---

## 10. Slice 8a4 — post-removal invariant audit (results)

Run after the 8a3 staged removals to prove that what was removed from
the registered surface is also severed from startup imports, package
reachability, generated-hook reachability, and user-facing advertising.
Stance unchanged: replacement, not continuity.

### Audit 1 — `VALID_COMMANDS` matches registered commands

```
Registered (from `node dist/index.js --help`, excluding `help`):
  claim, doctor, evidence, gates, init, scope, status, waiver

VALID_COMMANDS (from src/index.js):
  claim, doctor, evidence, gates, init, scope, status, waiver

diff: SAME
```

**Pass.**

### Audit 2 — no dangling startup imports in `src/index.js`

`grep -E '^const .* = require|^import' src/index.js` produces exactly
five imports, all core entrypoint:

```
require('commander')          // CLI framework
require('chalk')               // color output
require('./config')            // CLI_VERSION
require('./error-handler')     // handleCliError, findSimilarCommand
require('./shell')             // registerShellCommands
```

No imports of `./commands/*`, `./scaffold`, `./scaffold/git-hooks`,
`./generators/working-spec`, `./sidecars/listeners`, `./test-analysis`,
`./worktree/*`, `./parallel/*`. **Pass.**

### Audit 3 — built `--help` shows only v11 surface

Top-level `node dist/index.js --help` shows exactly the 8 vNext groups
plus Commander's built-in `help` row. No legacy aliases.

Per-group `--help` (init, doctor, scope, status, claim, gates, evidence,
waiver) was scanned for any text invoking removed commands; **zero hits**.
The v11-shipped repair-string fixes from 8a2 hold under audit 3 — no
help text directs users to a removed command. **Pass.**

### Audit 4 — template/scaffold/legacy-source reachability + tarball

`npm pack --dry-run` against `packages/caws-cli` shows **427 files /
550 kB** in the v11 candidate tarball. The package boundary contradicts
the v11 doctrine in three ways:

| Artifact in tarball | Reachable from v11 surface | Disposition |
|---|---|---|
| `dist/templates/` (~150 files: `.cursor/hooks/*.sh`, `.claude/hooks/*.sh`, `.cursor/rules/*.mdc`, `.github/copilot-instructions.md`, `templates/CLAUDE.md`, `templates/agents.md`, schemas, etc. — 116 invocations of removed commands) | **NO** (no v11 command installs them; `caws scaffold` and `caws hooks` are unregistered) | **8b BLOCKER** |
| `dist/commands/*.js` (26 legacy command source files: agents, archive, burnup, diagnose, evaluate, gates, init, iterate, mode, parallel, plan, provenance, quality-monitor, scope, session, sidecar, specs, status, templates, tool, tutorial, validate, verify-acs, waivers, workflow, worktree) | **NO via CLI surface**; YES via programmatic `require('@paths.design/caws-cli/dist/commands/<name>')` | **8b BLOCKER** |
| `dist/scaffold/`, `dist/sidecars/`, `dist/session/`, `dist/parallel/`, `dist/worktree/`, `dist/spec/`, `dist/validation/`, `dist/policy/`, `dist/utils/event-log.js`, `dist/utils/spec-resolver.js`, etc. | **NO via CLI surface**; YES via programmatic require | **8b BLOCKER** |

**Root cause** — two independent contributors:

1. `package.json:files = ["dist", "README.md", "templates"]` ships the
   entire `dist/` tree (and explicitly the templates root) without
   any whitelist of which `dist/` subtrees are part of the v11 API.
2. `scripts/build-cli.js` does `copyJsTree(src, dist)` (recursive copy
   of every `.js` file from `src/` to `dist/`) and `copyDir(templates,
   dist/templates)`. Under v11, the build should only emit:
   - `dist/index.js`, `dist/config/`, `dist/error-handler.js`
   - `dist/shell/` (vNext shell, TS-compiled)
   - `dist/store/` (vNext store, TS-compiled)
   - whatever `dist/policy/` files are still consumed by `dist/store/`
     or `dist/shell/` at runtime
   - no `dist/templates/`, no `dist/commands/`, no `dist/scaffold/`, no
     `dist/sidecars/`, no `dist/session/`, no `dist/parallel/`, no
     `dist/worktree/`, no `dist/spec/`, no `dist/validation/`, no
     `dist/utils/event-log.js`, no `dist/utils/spec-resolver.js`, etc.

**Recorded classification** (per audit-4 protocol):

```
templates/:
  reachable from v11 command surface: NO
  included in npm tarball today: YES (via files=["dist","templates"]
                                       and scripts/build-cli.js copyDir)
  disposition: REMOVE FROM PACKAGE FILES IN 8B
               (drop "templates" from files; remove copyDir step from
                build-cli.js; ensure dist/templates/ is not produced)

dist/commands/*.js (26 legacy handlers):
  reachable from v11 command surface: NO (no import from index.js)
  reachable from package programmatic API: YES (path is stable)
  included in npm tarball today: YES
  disposition: REMOVE FROM TARBALL IN 8B
               (build-cli.js copyJsTree must exclude src/commands/*.js
                or, preferably, switch to an opt-in whitelist of which
                src/ subtrees ship)

dist/{scaffold,sidecars,session,parallel,worktree,spec,validation,
      policy,utils/event-log.js,utils/spec-resolver.js, ...}:
  reachable from v11 command surface: NO
  reachable from package programmatic API: YES
  included in npm tarball today: YES
  disposition: REMOVE FROM TARBALL IN 8B (same build-cli.js change)
```

**8a4 verdict on Audit 4:** no v11 command-surface blocker (commands are
not registered, not imported, not advertised). **Three independent 8b
packaging blockers identified.** Cutover (8d) cannot proceed until 8b
closes the package-boundary contradiction.

### Audit 5 — docs/help advertising removed commands

| File | In npm tarball | Removed-command refs | Disposition |
|---|---|---|---|
| `packages/caws-cli/README.md` | **YES** (via `files=["dist","README.md","templates"]`) | 22 | **8b BLOCKER** — rewrite for v11 before npm publish |
| `README.md` (repo root) | NO | 21 | 8c — repo-facing |
| `AGENTS.md` | NO | 88 | 8c — agent-facing |
| `CLAUDE.md` | NO | 17 | 8c — agent-facing |

The package README ships and advertises `caws specs create`,
`caws validate`, `caws scaffold`, `caws provenance`, `caws hooks`,
`caws waivers`, plus `working-spec.yaml` workflow — none of which exist
in v11. **8b blocker.**

The repo-facing docs (`README.md`, `AGENTS.md`, `CLAUDE.md`) are
agent/developer guidance and are not shipped in the tarball; classified
as 8c work alongside the docs/agents/ and docs/guides/ rewrites
identified in 8a2.

`package.json:description` is generic ("Coding Agent Workflow System
command-line tools for spec management, quality gates, and AI-assisted
development") and does not advertise specific removed commands.
Acceptable as-is, though "spec management" is misleading under A1
(v11.0.0 has no spec lifecycle command); minor 8b polish.

### Audit 6 — no v11 path reaches old authority modules

```
grep -rEn "utils/event-log|working-spec\.yaml|spec-resolver|\
provenance/chain\.json" packages/caws-cli/src/index.js \
packages/caws-cli/src/shell packages/caws-cli/src/store \
packages/caws-kernel/src
```

Every hit is one of:
- residue detection (`init-store.ts:84` refused-paths list,
  `doctor-snapshot.ts:113` isFile probe, `specs-store.ts:69-70` loader
  guard)
- doctor rule message (`kernel/doctor/inspect.ts:636-640`)
- doctrine comments (`init-store.ts:14,17`, `specs-store.ts:8`,
  `register.ts:76`, `rules.ts:68`, `kernel/doctor/rules.ts:93`)

**Pass.** No v11 shell/store/kernel path reads or writes legacy
event-log, falls back to spec-resolver, or touches provenance/chain.json.

### Audit 7 — full verification

```
npx eslint 'src/**/*.{js,ts}' 'tests/**/*.{js,ts}'        clean
npx tsc -p tsconfig.vnext.test.json --noEmit               clean
npx jest tests/shell tests/store                           232/232 pass
cd packages/caws-kernel && npx jest                        456/456 pass
find packages/*/dist -name '*.ts' -not -name '*.d.ts'      empty
```

**Pass.**

### Slice 8a4 summary

| Audit | Result | Blockers fixed in 8a4 | Carried into 8b | Carried into 8c |
|---|---|---|---|---|
| 1 — VALID_COMMANDS == registered | pass | 0 | 0 | 0 |
| 2 — no dangling imports | pass | 0 | 0 | 0 |
| 3 — `--help` shows only v11 | pass | 0 | 0 | 0 |
| 4 — template/scaffold/legacy-source tarball | classified | 0 | **3** (`templates/`, `dist/commands/*`, other dormant `dist/` subtrees) | 0 |
| 5 — docs advertising removed commands | classified | 0 | **1** (`packages/caws-cli/README.md` rewrite) | 3 (root README, AGENTS.md, CLAUDE.md, plus `docs/`) |
| 6 — no v11 → legacy authority reach | pass | 0 | 0 | 0 |
| 7 — verification gates | pass | 0 | 0 | 0 |
| **Total** | | **0** | **4** | **3+** |

**Audit-only slice closes with zero new code changes.** Two doc-only
sideband commits during this slice updated
`docs/failure-lineage.md` (worked-around
session-attribution incidents — documented part of why CAWS exists,
not part of the command-surface removal); they were committed as
`wip(docs)` and pushed alongside this audit.

**Cutover gating** — 8b cannot publish v11.0.0 until the four 8b
blockers identified above are resolved:

1. Drop `templates` from `package.json:files`.
2. Rewrite `scripts/build-cli.js` to opt-in whitelist what `dist/`
   ships (no `dist/commands/`, no `dist/scaffold/`, etc.).
3. Rewrite `packages/caws-cli/README.md` for the v11 surface.
4. (Soft) Refresh `package.json:description` away from "spec
   management" wording.

8c work (root `README.md`, `AGENTS.md`, `CLAUDE.md`, `docs/agents/`,
`docs/guides/`) is repo-internal and does not gate the npm publish,
but should land alongside cutover for coherence.

---

## 8. References

- `packages/caws-kernel/` — pure logic
- `packages/caws-cli/src/store/` — I/O and snapshot composition
- `packages/caws-cli/src/shell/` — vNext command surface
- `packages/caws-cli/src/commands/` — legacy handlers (kept on disk for
  v11.0; deleted in v11.1 per Slice 8e)
- `packages/caws-cli/src/index.js` — registration; subject to Slice 8a3
  removals
- `.caws/events.jsonl` schema: `packages/caws-kernel/src/schemas/events/`
- Slice closure notes: see commits `52d6165`, `2ed4a6f`, `4286c20`,
  `157df5a`, `7dfd865`, `8f8ac56`, `2ed7435`, `8f33580`
