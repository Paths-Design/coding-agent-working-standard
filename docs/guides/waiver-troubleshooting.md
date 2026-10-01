---
doc_id: waiver-troubleshooting
authority: reference
status: active
title: Waiver troubleshooting (v11.9.0)
owner: vNext rewrite team
updated: 2026-08-19
audience: consumer
---

# Waiver troubleshooting (v11.9.0)

**For AI agents and developers working with CAWS v11 waivers.**

> **v11 surface only.** Waivers in v11 use the singular
> `caws waiver create | list | show | revoke` surface. The legacy `caws waivers`
> (plural) command and the `waiver_ids: [...]` field on the spec are removed.
> Doctrine source:
> [`docs/architecture/caws-vnext-command-surface.md`](../architecture/caws-vnext-command-surface.md).

## How waivers work in v11

Waivers in v11 are records under `.caws/waivers/<id>.yaml`, written through the
store via `caws waiver create`. A waiver targets one or more gate names
(`gates:`, an array — repeat `--gate` on the CLI for more than one). When
`caws gates run --spec <id>` evaluates a targeted gate and a violation matches
an active, non-expired waiver, the violation is filtered out of the disposition.

**Waivers do not change gate `mode`.** `mode` is owned by `policy.yaml` (block /
warn / skip). Waivers filter individual violations.

**Waivers do not need to be referenced from the spec.** v11 has no `waiver_ids:`
field. The store discovers waivers by scanning `.caws/waivers/`, matching them
against gate-evaluation events at run time.

## Quick fixes

### Issue 1: a gate keeps failing despite my waiver

**Likely causes**, in order of frequency:

1. The waiver's `gate` field doesn't match the gate the policy is failing.
2. The waiver has expired (check `expires_at`).
3. The waiver was revoked.
4. The waiver file is malformed (`caws waiver list` will skip it; `caws doctor`
   will surface it).

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
  --title "<short title>" \
  --gate <correct-gate-name> \
  --reason "..." \
  --approved-by "..." \
  --expires-at "2026-12-31T23:59:59Z"
```

### Issue 2: `caws waiver create` failed with "already exists"

**Cause**: a waiver with that id already exists at `.caws/waivers/<id>.yaml`.

**Fix**: pick a different id. Waiver ids must match
`^[A-Z][A-Z0-9]*(-[A-Z0-9]+)*-\d+[a-z]?$` (ends in digits, optionally one
trailing lowercase letter — `FEAT-1-w` and `FEAT-1-w1` both fail this since they
end in a letter-only segment). Convention: `<spec-id>-<n>`, e.g. `FEAT-1a` or
`FEAT-1-2`. Or revoke the existing waiver first if it's stale.

The exit code for this case is `1` (domain failure), and the diagnostic mentions
the duplicate id explicitly. The CLI uses the
`STORE_RULES.WAIVERS_ALREADY_EXISTS` rule constant (8a1).

### Issue 3: waiver expired and now the gate blocks

**Cause**: `expires_at` is in the past. Expired waivers no longer filter
violations.

**Fix**: either fix the underlying gate violation (the right answer) or open a
new waiver with a forward-dated `expires_at` and a fresh approval. Do not edit
the expired waiver's YAML by hand — the audit trail expects waivers to be
created and revoked through the CLI.

### Issue 4: The budget gate reports an overage

**Cause**: the staged change is larger than the sizing goal for the spec's risk
tier (`max_files` / `max_loc` under `risk_tiers` in `.caws/policy.yaml`).
`budget_limit` is advisory: it prints
`OVER budget_limit ... [advisory — never blocks]`, records its `gate_evaluated`
event in mode `warn`, and never fails `caws gates run`.

**Fix**: nothing to fix, and no waiver to open. Do not trim, defer or stub work
to come in under the goal — it is there to prompt a check against the plan, not
to cap the work. If the change is larger than the spec planned, say so in the
spec. A policy that still declares `budget_limit` with `mode: block` is not
honored; `caws doctor` reports it with the repair `mode: warn`. `change_budget`
is not a v11 spec field, and the spec schema rejects it.

### Issue 5: `caws gates run --spec <id>` exits 2

**Cause**: composition failure. Not a quality issue — usually means CAWS can't
read your `.caws/` state.

**Diagnose**:

```bash
ls -la .caws/                       # is the directory present?
cat .caws/policy.yaml | head        # is policy.yaml readable / well-formed?
caws doctor                          # surfaces composition findings as "load errors"
```

**Fix**: address the underlying setup problem. Re-run `caws init` if `.caws/` is
missing (it's idempotent).

## v11 waiver lifecycle

```bash
# Create
caws waiver create FEAT-1a \
  --title "Experimental mode past expiry during rollout" \
  --gate spec_completeness \
  --reason "FEAT-1 rollout finishes after experimental_mode.expires_at; renewal tracked in FEAT-2" \
  --approved-by "tech-lead@example.com" \
  --expires-at "2026-12-31T23:59:59Z"

# Inspect
caws waiver list                     # all waivers
caws waiver show FEAT-1a            # one waiver

# Revoke (idempotent)
caws waiver revoke FEAT-1a
```

Each operation appends an event to `.caws/events.jsonl` via the store's
hash-chained `appendEvent`. The audit trail is durable and verifiable.

## Waiver record shape (v11)

`.caws/waivers/<id>.yaml`:

```yaml
id: FEAT-1a
title: Experimental mode past expiry during rollout
status: active
effectiveness: active
gates:
  - spec_completeness
reason: |
  FEAT-1 rollout finishes after experimental_mode.expires_at.
  Renewal tracked in FEAT-2.
approved_by: tech-lead@example.com
created_at: 2026-05-15T10:00:00Z
expires_at: 2026-12-31T23:59:59Z
scope: {}
```

`title` is required (≥5 non-whitespace characters). `gates` is an array — a
waiver can target more than one gate; repeat `--gate` on the CLI to add more.
`status` is the stored lifecycle value (active/revoked); `effectiveness`
reflects whether the waiver is currently in force (accounts for expiry,
independent of `status`).

Authored by `caws waiver create`. Do not hand-edit. The store enforces atomic
writes via `writeFileAtomic`.

Fields v11 does NOT use (legacy v3/v10 leftovers — ignore them):

- `delta:` (max_files / max_loc) — budgets are an advisory sizing goal and are
  never waived.
- `gate:` singular — the current field is `gates:`, an array.
- `risk_assessment:` (impact_level / mitigation_plan) — capture in `reason`
  instead.
- `approvers:` plural — v11 records a single `approved_by`.
- `description:` — capture in `reason`.

## When a waiver is the wrong answer

Waivers are for **legitimate, time-bound bypass with audit**. They are not:

- A way to silence a gate that exposes a real bug.
- A substitute for fixing scope.
- A way to make T1-tier failures go away without human review.

If a gate failure is reproducible and the underlying issue is fixable, fix it.
Use waivers for genuinely exceptional cases.

## Validation checklist

Before opening a waiver:

- [ ] The gate name matches what `caws gates run --spec <id>` reports.
- [ ] The reason explains _why the violation is acceptable_, not just _that you
      want past it_.
- [ ] The approver is real and authorized.
- [ ] `expires_at` is short and matches the planned remediation horizon.
- [ ] The gate actually blocks — a `budget_limit` overage never does and needs
      no waiver.
- [ ] No hand-edits to `policy.yaml` to change the gate's mode.

After opening:

- [ ] `caws waiver show <id>` shows the record correctly.
- [ ] `caws gates run --spec <id>` exits 0 (the violation is filtered).
- [ ] `caws doctor` exits 0 (no malformed-waiver findings).

## See also

- [`docs/architecture/caws-vnext-command-surface.md`](../architecture/caws-vnext-command-surface.md)
  — doctrine source
- [`docs/api/cli.md`](../api/cli.md) — full CLI reference (§8 `caws waiver`)
- [`docs/agent-workflow-tools.md`](../agent-workflow-tools.md) — agent
  block-recovery patterns
- [`AGENTS.md`](../../AGENTS.md) — agent quickstart
