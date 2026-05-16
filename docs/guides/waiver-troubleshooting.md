---
doc_id: waiver-troubleshooting
authority: reference
status: active
title: Waiver troubleshooting (v11.0.0)
owner: vNext rewrite team
updated: 2026-05-15
---

# Waiver troubleshooting (v11.0.0)

**For AI agents and developers working with CAWS v11 waivers.**

> **v11 surface only.** Waivers in v11 use the singular `caws waiver create | list | show | revoke` surface. The legacy `caws waivers` (plural) command and the `waiver_ids: [...]` field on the spec are removed. Doctrine source: [`docs/architecture/caws-vnext-command-surface.md`](../architecture/caws-vnext-command-surface.md).

## How waivers work in v11

Waivers in v11 are records under `.caws/waivers/<id>.yaml`, written through the store via `caws waiver create`. Each waiver targets one gate name. When `caws gates run --spec <id>` evaluates that gate and a violation matches an active, non-expired waiver, the violation is filtered out of the disposition.

**Waivers do not change gate `mode`.** `mode` is owned by `policy.yaml` (block / warn / skip). Waivers filter individual violations.

**Waivers do not need to be referenced from the spec.** v11 has no `waiver_ids:` field. The store discovers waivers by scanning `.caws/waivers/`, matching them against gate-evaluation events at run time.

## Quick fixes

### Issue 1: a gate keeps failing despite my waiver

**Likely causes**, in order of frequency:

1. The waiver's `gate` field doesn't match the gate the policy is failing.
2. The waiver has expired (check `expires_at`).
3. The waiver was revoked.
4. The waiver file is malformed (`caws waiver list` will skip it; `caws doctor` will surface it).

**Diagnose**:

```bash
caws waiver list                    # see all active waivers
caws waiver show <id>               # full record for one waiver
caws gates run --spec <id>          # see which gate is blocking
caws doctor                          # surfaces malformed waiver files as findings
```

**Fix**: open a new waiver with the correct gate name, or revoke + recreate:

```bash
caws waiver revoke <old-id>
caws waiver create <new-id> \
  --gate <correct-gate-name> \
  --reason "..." \
  --approved-by "..." \
  --expires-at "2026-12-31T23:59:59Z"
```

### Issue 2: `caws waiver create` failed with "already exists"

**Cause**: a waiver with that id already exists at `.caws/waivers/<id>.yaml`.

**Fix**: pick a different id (waiver ids are arbitrary strings; convention is `<spec-id>-<short>`, e.g. `FEAT-1-w1`). Or revoke the existing waiver first if it's stale.

The exit code for this case is `1` (domain failure), and the diagnostic mentions the duplicate id explicitly. The CLI uses the `STORE_RULES.WAIVERS_ALREADY_EXISTS` rule constant (8a1).

### Issue 3: waiver expired and now the gate blocks

**Cause**: `expires_at` is in the past. Expired waivers no longer filter violations.

**Fix**: either fix the underlying gate violation (the right answer) or open a new waiver with a forward-dated `expires_at` and a fresh approval. Do not edit the expired waiver's YAML by hand — the audit trail expects waivers to be created and revoked through the CLI.

### Issue 4: I tried to set `change_budget` in my spec to "fix" the budget gate

**Cause**: hand-editing `change_budget` is a governed-paths violation. CI rejects it. The right escape is a waiver against the budget gate.

**Fix**: revert the spec edit and open a waiver:

```bash
caws waiver create FEAT-1-budget \
  --gate budget_limit \
  --reason "Refactor required emergency budget breach; cleanup tracked in FEAT-2" \
  --approved-by "tech-lead@example.com" \
  --expires-at "2026-09-01T00:00:00Z"
```

In v11, budget enforcement is driven by `policy.yaml` (which owns the gate's `mode`) and per-spec `risk_tier` thresholds. The spec's `change_budget` is informational; gates enforce against policy-derived limits.

### Issue 5: `caws gates run --spec <id>` exits 2

**Cause**: composition failure. Not a quality issue — usually means CAWS can't read your `.caws/` state.

**Diagnose**:

```bash
ls -la .caws/                       # is the directory present?
cat .caws/policy.yaml | head        # is policy.yaml readable / well-formed?
caws doctor                          # surfaces composition findings as "load errors"
```

**Fix**: address the underlying setup problem. Re-run `caws init` if `.caws/` is missing (it's idempotent).

## v11 waiver lifecycle

```bash
# Create
caws waiver create FEAT-1-w \
  --gate budget_limit \
  --reason "Emergency budget extension for FEAT-1 integration" \
  --approved-by "tech-lead@example.com" \
  --expires-at "2026-12-31T23:59:59Z"

# Inspect
caws waiver list                     # all waivers
caws waiver show FEAT-1-w            # one waiver

# Revoke (idempotent)
caws waiver revoke FEAT-1-w
```

Each operation appends an event to `.caws/events.jsonl` via the store's hash-chained `appendEvent`. The audit trail is durable and verifiable.

## Waiver record shape (v11)

`.caws/waivers/<id>.yaml`:

```yaml
id: FEAT-1-w
gate: budget_limit
reason: |
  Emergency budget extension for FEAT-1 integration.
  Cleanup tracked in FEAT-2.
approved_by: tech-lead@example.com
created_at: 2026-05-15T10:00:00Z
expires_at: 2026-12-31T23:59:59Z
status: active
```

Authored by `caws waiver create`. Do not hand-edit. The store enforces atomic writes via `writeFileAtomic`.

Fields v11 does NOT use (legacy v3/v10 leftovers — ignore them):

- `delta:` (max_files / max_loc) — budget is policy-driven in v11.
- `gates:` plural — v11 waivers target one gate per waiver.
- `risk_assessment:` (impact_level / mitigation_plan) — capture in `reason` instead.
- `approvers:` plural — v11 records a single `approved_by`.
- `description:` — capture in `reason`.

## When a waiver is the wrong answer

Waivers are for **legitimate, time-bound bypass with audit**. They are not:

- A way to silence a gate that exposes a real bug.
- A substitute for fixing scope.
- A way to make T1-tier failures go away without human review.

If a gate failure is reproducible and the underlying issue is fixable, fix it. Use waivers for genuinely exceptional cases.

## Validation checklist

Before opening a waiver:

- [ ] The gate name matches what `caws gates run --spec <id>` reports.
- [ ] The reason explains *why the violation is acceptable*, not just *that you want past it*.
- [ ] The approver is real and authorized.
- [ ] `expires_at` is short and matches the planned remediation horizon.
- [ ] No hand-edits to `policy.yaml` or the spec's `change_budget`.

After opening:

- [ ] `caws waiver show <id>` shows the record correctly.
- [ ] `caws gates run --spec <id>` exits 0 (the violation is filtered).
- [ ] `caws doctor` exits 0 (no malformed-waiver findings).

## See also

- [`docs/architecture/caws-vnext-command-surface.md`](../architecture/caws-vnext-command-surface.md) — doctrine source
- [`docs/api/cli.md`](../api/cli.md) — full CLI reference (§8 `caws waiver`)
- [`docs/agent-workflow-tools.md`](../agent-workflow-tools.md) — agent block-recovery patterns
- [`AGENTS.md`](../../AGENTS.md) — agent quickstart
