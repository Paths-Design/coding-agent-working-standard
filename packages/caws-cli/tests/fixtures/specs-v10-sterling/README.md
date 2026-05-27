# v10 spec fixture corpus (Sterling-shape representative sample)

Read-only fixture inputs for `tests/store/specs-migration.test.js` corpus
suite. Each YAML file is a curated v10-shape spec representing one class
the migrator must handle. The corpus is small (bounded fixture set per
invariant 8 of `.caws/specs/CAWS-MIGRATE-V10-SPECS-001.yaml`) but covers
both refusal and safe-migration classes at least once.

This README.md is itself a fixture — it tests that the scanner emits a
`non_yaml_observations` entry with `kind: 'markdown_sidecar'`. Do not
remove it; the test depends on its presence.

## Refusal class coverage

| File | Refusal rule | Acceptance |
|------|--------------|------------|
| `refuse-empty-modules.yaml` | `spec.migrate.blast_radius_modules_empty` | A5 |
| `refuse-lifecycle-unmapped.yaml` | `spec.migrate.lifecycle_unmapped` | A6 (no mapping) |
| `refuse-mode-unresolvable.yaml` | `spec.migrate.mode_unresolvable` | invariant 5 |
| `refuse-risk-tier-unresolvable.yaml` | `spec.migrate.risk_tier_unresolvable` | invariant 4 |
| `refuse-scope-in-missing.yaml` | `spec.migrate.scope_in_missing` | input gate |

## Migration class coverage

| File | What it exercises | Acceptance |
|------|-------------------|------------|
| `migrate-happy-renames.yaml` | every safe rename + risk_tier coercion | A2 |
| `migrate-mode-from-type.yaml` | mode='development' footgun + type fallback | A3 |
| `migrate-mode-type-disagree.yaml` | mode/type disagreement preserves mode | A4 |
| `migrate-bare-date-created.yaml` | YYYY-MM-DD → ISO date-time coercion | commit 3.1 |
| `migrate-lifecycle-mapped.yaml` | operator mapping unblocks lifecycle | A6 (with mapping) |

## Operator-supplied artifact (also exercises non_yaml observation)

`mapping.json` — lifecycle mapping for `migrate-lifecycle-mapped.yaml`.
Includes `resolution: superseded` because v11 schema requires resolution
for terminal lifecycles (closed/archived). The test loads this file as
the `--lifecycle-mapping` input. Note: the migrator's scanner will
surface it as `kind: 'unknown_non_yaml'` in the non_yaml observations —
this matches real operator reality where a `mapping.json` co-located
with specs is visible to the scan.

## Expected distribution under `runSpecsMigrateScan` (no mapping)

- migrated: 0
- migrated_with_warnings: 4 (happy, mode-from-type, mode-type-disagree, bare-date)
- refused: 6 (5 refuse-* + lifecycle-mapped which refuses without mapping)
- total: 10 (the 10 .yaml files; README.md and mapping.json are non_yaml)

## Expected distribution under `runSpecsMigrateScan` (with mapping)

- migrated_with_warnings: 5 (lifecycle-mapped now migrates)
- refused: 5
- total: 10

## Expected non_yaml observations (both runs)

- `README.md` (kind: markdown_sidecar)
- `mapping.json` (kind: unknown_non_yaml)
