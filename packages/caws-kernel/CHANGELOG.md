# Changelog — @paths.design/caws-kernel

All notable changes to the CAWS kernel are documented here. The kernel is a
pure-TypeScript governance primitive layer (spec/policy/scope/evidence/worktree
types, parsers, validators, lifecycle transitions; no I/O) consumed by
`caws-cli@^11` and external integrators.

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
