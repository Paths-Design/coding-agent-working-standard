# Changelog — @paths.design/caws-kernel

All notable changes to the CAWS kernel are documented here. The kernel is a
pure-TypeScript governance primitive layer (spec/policy/scope/evidence/worktree
types, parsers, validators, lifecycle transitions; no I/O) consumed by
`caws-cli@^11` and external integrators.

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
