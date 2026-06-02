---
doc_id: caws-developer-guide
authority: guide
status: active
title: CAWS Developer Guide
owner: vNext rewrite team
updated: 2026-06-02
audience: consumer
---

# CAWS Developer Guide

> Purpose: make every change predictable. Pick a **mode**, generate scaffolds, run gates, deliver a PR bundle.

## 0) Pick a Mode
- **feature**: adds behavior, may change contracts & migrations.
- **refactor**: behavior-preserving, API stable. In-place codemods only.
- **fix**: reproduce with a failing test, then make it green. Scope minimal.

> Set `mode` in `.caws/specs/<spec-id>.yaml`. CI enforces mode rules.

## 1) Quick Start

```bash
# create a spec for the change
caws specs create FEAT-1234 --title "Apply coupon at checkout" --risk-tier T1

# edit spec & plan
code .caws/specs/FEAT-1234.yaml docs/FEAT-1234/feature.plan.md docs/FEAT-1234/test-plan.md

# validate spec + project health
caws doctor

# run the full local gate battery against the spec
caws gates run --spec FEAT-1234
```

> Note: `npm run caws:start`, `npm run caws:validate`, and `npm run caws:verify` are project-local wrapper scripts. If your project defines them, they may wrap the commands above. The canonical v11.1 commands are `caws specs create`, `caws doctor`, and `caws gates run --spec <id>`.

## 2) Spec Layout Convention

```
.caws/
  specs/
    FEAT-1234.yaml                  # one file per feature; no root-level spec
    FEAT-1235.yaml
docs/FEAT-1234/
  feature.plan.md
  test-plan.md
  codemod/                          # refactor mode only
```

> v11 has no project-level root spec. `caws init` refuses legacy `.caws/<spec-id>.yaml` layouts. All specs live under `.caws/specs/`.

**When to split a feature spec?**
Single domain → one `specs/FEAT-…yaml`. Cross-cutting or architectural → multiple specs with non-overlapping `scope.in`.

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
