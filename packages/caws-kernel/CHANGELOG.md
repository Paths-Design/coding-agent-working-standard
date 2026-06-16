# Changelog — @paths.design/caws-kernel

All notable changes to the CAWS kernel are documented here. The kernel is a
pure-TypeScript governance primitive layer (spec/policy/scope/evidence/worktree
types, parsers, validators, lifecycle transitions; no I/O) consumed by
`caws-cli@^11` and external integrators.

## [1.4.0] (2026-06-16)

Additive governance-primitive surface for the caws-cli 11.4.0 hook-de-duplication
release ("caws governs caws artifacts"). No breaking changes — one new pure
scope evaluator. The caws-cli 11.4.0 runtime imports it (`caws scope contention`
consumes it; the worktree-write-guard hook delegates to that command), so **this
kernel 1.4.0 must be published before the caws-cli 11.4.0 tag** (coupled-release
ordering; see `docs/release-procedure.md`).

### Added

- **`evaluateContention(path, worktrees, specs, currentBranch)`** — a pure,
  I/O-free cross-worktree scope-claim evaluator (`scope/contention.ts`). Returns
  a typed `ContentionResult` (`claimed` with `{worktreeName, specId,
  matchedPattern}` / `clear` / `undetermined` with a `missing-specId |
  missing-spec | missing-scope` reason). Uses the kernel's own `matchGlob` — the
  single scope matcher — so a consumer cannot disagree with the kernel on a
  `(path, spec)` contention decision. Exported types: `ContentionResult`,
  `ContentionClaimant`, `ContentionUndeterminedReason`, `EvaluateContentionInput`.
  This is the substrate that lets `worktree-write-guard.sh` delete its last
  inline `js-yaml` spec re-parser and delegate to `caws scope contention`.

## [1.3.0] (2026-06-16)

Additive governance-primitive surface for the caws-cli 11.3.0 worktree-repair
release. No breaking changes — new event-vocabulary entries and new doctor
diagnostic rules. The caws-cli 11.3.0 runtime imports these symbols
(`caws worktree repair` consumes the doctor diagnostics and appends the repair
events), so **this kernel 1.3.0 must be published before the caws-cli 11.3.0 tag**
(coupled-release ordering; see `docs/release-procedure.md`). The published kernel
1.2.0 did not carry these symbols, so the caws-cli 11.3.0 dependency floor is
raised to `^1.3.0` to prevent a fresh install from resolving a stale kernel.

### Added

* **Half-state repair event vocabulary** (`evidence/types.ts`, `evidence/validate.ts`,
  `schemas/events.v1.json`, `schemas/events/worktree_pruned.v1.json`,
  `schemas/events/spec_binding_cleared.v1.json`): two honest audit event types for
  the worktree/spec half-state repair executor —
  * `worktree_pruned` (`h_class`, `worktree_name`, `reason`, optional `spec_id`) —
    a ghost registry entry was removed; the backing git worktree was already gone,
    so the event does NOT claim a git removal.
  * `spec_binding_cleared` (`h_class`, `spec_id`, `cleared_worktree_name`, `reason`)
    — a dead `spec.worktree` binding was cleared. Requires a top-level `spec_id`.
  Both registered across `EventType`, the spec-id-class Sets, the `events.v1.json`
  envelope enum, the `validate.ts` schema map, and `KNOWN_EVENT_TYPES`
  (`additionalProperties: false`, `h_class` closed enum).
* **Typed worktree/spec half-state diagnostics** (`doctor/inspect.ts`, `doctor/rules.ts`):
  the H1–H6 taxonomy plus the event-backed orphan rule
  `WORKTREE_EVENT_WITHOUT_CONTROL_PLANE_BINDING` (a `worktree_created` event with no
  live control-plane binding), with lifecycle/canonical-dir enrichment on
  `BINDING_SPEC_MISSING_REGISTRY` so a consumer can distinguish a ghost binding from
  an active recreate-vs-clear ambiguity.

### Changed

* **Event-orphan diagnostic copy** is present-tense: automatic repair is
  *intentionally refused* for the orphan class (the `worktree_created` event is
  immutable audit history; no control-plane mutation is safe), not "deferred." The
  3-way contradiction (H5) `narrowRepair` points at
  `WORKTREE-SPEC-AUTHORITY-CONTROL-PLANE-002`. Both remain command-free (the
  authority-policy lock holds).

## [1.2.0] (2026-06-01)

Additive governance-primitive surface for the caws-cli 11.1.9 batch
(worktree-isolation hardening, agent-liveness doctor, scope amendment, and
`scope.support`). No breaking changes — new event schemas, a new optional spec
field, new scope/doctor rule ids, and additive event-vocabulary entries. The CLI
11.1.9 runtime imports these symbols, so this kernel must be published before the
caws-cli 11.1.9 tag (coupled-release ordering; see `docs/release-procedure.md`).

### Added

* **`scope.support` spec field** (`spec/types.ts` `support?: string[]`,
  `schemas/spec.v1.json`, `scope/evaluate.ts`, `scope/rules.ts`)
  (`WORKTREE-SUPPORT-SCOPE-001`). Paths admitted for editing **like `scope.in`
  but never treated as a worktree claim** — for repo-root deliverables a slice
  must write but should not contend for. New distinct scope rule
  `ADMIT_SCOPE_SUPPORT` (`scope.admit.scope_support`) so diagnostics
  distinguish "admitted because owned (`scope.in`)" from "admitted as support".
* **`spec_scope_amended.v1` event schema** (`schemas/events/spec_scope_amended.v1.json`)
  for `caws specs amend-scope` (`CAWS-SCOPE-AMEND-COMMAND-001`). Registered in the
  event vocabulary at all sites (`events.v1.json` enum, `EventType` union +
  `REQUIRES_SPEC_ID` in `evidence/types.ts` and `evidence/validate.ts`).
* **`worktree_ownership_seized.v1` event schema**
  (`schemas/events/worktree_ownership_seized.v1.json`) for the forced
  `caws worktree bind --steal --reason` audit (`WORKTREE-ISOLATION-HARDENING-001`
  Fix 4). A seizure binds to a spec, so the event carries `spec_id` like
  `worktree_bound`. Registered in the event vocabulary at all sites.
* **Lease/worktree liveness-drift doctor rules** (`doctor/rules.ts`,
  `doctor/inspect.ts`, `doctor/types.ts`) (`AGENT-LIVENESS-DOCTOR-001` D10):
  `WORKTREE_OWNER_LEASE_MISSING` (`doctor.worktree.owner_lease_missing` —
  diagnostic only; the registry owner remains authoritative) and a
  `pid_oracle_unreliable` signal for the Claude Code per-call-PID case where
  recency, not PID, is the liveness authority.
* **Hook-pack-without-`.caws` doctor rule** (`CAWS-DOCTOR-HOOKS-NO-CAWS-DRIFT-001`):
  the inverse of the `INIT_*_MISSING` family — the hook pack is installed but the
  whole `.caws/` is absent.

## [1.1.4] (2026-05-29)

### Added

* **`spec_retired` event schema** (`schemas/events/spec_retired.v1.json`):
  the tombstone event emitted by `caws specs retire-draft`. `REQUIRES_SPEC_ID`,
  `additionalProperties: false`, required `from_path` + `blob_sha`
  (`^[0-9a-f]{40}$`), optional `source_commit_sha` + `reason`. Registered in
  the event vocabulary at all four sites so `appendEvent` accepts and validates
  it: the `events.v1.json` enum, the `EventType` union and `REQUIRES_SPEC_ID`
  set in `evidence/types.ts`, and the `PAYLOAD_SCHEMAS` map + `REQUIRES_SPEC_ID`
  array in `evidence/validate.ts`. The retired-spec recovery predicate scans
  `spec_retired` events in addition to `spec_archived`.
* **Spec enum value exports** (`spec/types.ts`): the closed spec enums are now
  exported as `const` value arrays — `SPEC_MODES`, `SPEC_RESOLUTIONS`,
  `RISK_TIERS`, `SPEC_LIFECYCLE_STATES`, `CONTRACT_TYPES` — with the existing
  `Mode` / `Resolution` / `RiskTier` / `LifecycleState` / `ContractType` types
  derived from them. The type surface is unchanged (same union members); the
  arrays give consumers a single importable runtime source for the enum values
  (e.g. CLI `--mode` / `--resolution` validation + help text), replacing
  per-consumer re-declarations. The arrays mirror `schemas/spec.v1.json`, which
  remains the validation authority.

Additive and backward-compatible: no existing schema, type, or validator
behavior changes. A kernel before 1.1.4 rejects `spec_retired` as an unknown
event type, so consumers calling `caws specs retire-draft` (or importing the
new enum-value arrays) must depend on `^1.1.4`.

## [1.1.3]

Prior releases (1.0.0 → 1.1.3) were published without a maintained changelog;
their history is in git and in the consuming `caws-cli` CHANGELOG. 1.1.3 is the
last version before the `spec_retired` schema.
