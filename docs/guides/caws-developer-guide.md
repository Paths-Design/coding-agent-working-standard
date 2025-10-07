# CAWS Developer Guide

> Purpose: make every change predictable. Pick a **mode**, generate scaffolds, run gates, deliver a PR bundle.

## 0) Pick a Mode
- **feature**: adds behavior, may change contracts & migrations.
- **refactor**: behavior-preserving, API stable. In-place codemods only.
- **fix**: reproduce with a failing test, then make it green. Scope minimal.

> Set `mode` in `.caws/working-spec.yaml`. CI enforces mode rules.

## 1) Quick Start

```bash
# scaffold a change by mode and id
npm run caws:start FEAT-1234 feature "Apply coupon at checkout"

# edit spec & plan
code .caws/working-spec.yaml docs/FEAT-1234/feature.plan.md docs/FEAT-1234/test-plan.md

# validate spec + policies locally
npm run caws:validate

# run the full local gate battery
npm run caws:verify
```

## 2) Spec Layout Convention

```
.caws/
  working-spec.yaml
  specs/FEAT-1234.yaml              # optional feature-specific spec
docs/FEAT-1234/
  feature.plan.md
  test-plan.md
  codemod/                          # refactor mode only
```

**When to split a feature spec?**
Single domain → `specs/FEAT-…yaml`. Cross-cutting or architectural → update `working-spec.yaml`.

## 3) Checklists (copy into PR)

### Feature

* [ ] Contracts updated first (OpenAPI/GraphQL/Proto) and verified
* [ ] Unit + contract + integration + E2E smoke written before impl
* [ ] Feature flag + reversible migration + rollback plan
* [ ] Observability: logs/metrics/traces named & asserted
* [ ] A11y/perf budgets met

### Refactor

* [ ] Codemod added in `docs/<ID>/codemod/` with dry-run & apply
* [ ] No public API change; golden frames unchanged
* [ ] Mutation score ≥ baseline; coverage not reduced
* [ ] No duplicate/"enhanced-*.ts" files

### Fix

* [ ] Minimal failing test reproduces bug
* [ ] Root cause noted; guard test added
* [ ] Risk tier confirmed; scope confined to `scope.in`

---

## Mode Contract

refactor:
  - Public API: MUST NOT change
  - New files: discouraged; if splitting, provide codemod and 1:1 export mapping
  - Required artifacts: codemod script + semantic diff report
  - Golden frames: unchanged within tolerance
feature:
  - Contracts: MUST be updated first & verified
  - Migrations: forwards-compatible + dry-run; feature flag required
fix:
  - Repro: failing test first; minimal diff; root cause note

---

## Blast Radius (copy into feature.plan.md)

- Modules: checkout, pricing
- Data migration: yes (backfill coupons_usages)
- Cross-service contracts: payments@v1.4 (consumer), cart@v2 (provider)

## Operational Rollback SLO (copy into feature.plan.md)

- 15m to revert via FEATURE_COUPONS_APPLY=false and revert migration step DDL

---

## Mode Matrix (copy into test-plan.md)

| Test Class | feature | refactor | fix |
|------------|---------|----------|-----|
| Unit | mandatory | mandatory | mandatory |
| Contract | mandatory | mandatory | optional* |
| Integration | mandatory | optional | optional* |
| E2E smoke | mandatory | optional | optional* |
| Mutation | mandatory | mandatory | mandatory |
| A11y/Perf | mandatory | optional | optional* |

*Only if scope impacts these areas
