---
doc_id: agent-workflow-tools
authority: reference
status: active
title: Agent workflow tools (v11.0.0)
owner: vNext rewrite team
updated: 2026-05-15
---

# Agent workflow tools (v11.0.0)

This guide shows agents how to use the v11.0.0 CAWS surface to navigate quality gates and recover from common blocks. The full CLI reference is at [`docs/api/cli.md`](api/cli.md); the doctrine source is [`docs/architecture/caws-vnext-command-surface.md`](architecture/caws-vnext-command-surface.md).

> **v11 surface only.** This doc references exactly the eight v11 command groups: `init`, `doctor`, `status`, `scope`, `claim`, `gates`, `evidence`, `waiver`. v10 commands (`burnup`, `validate`, `evaluate`, `iterate`, `diagnose`, `waivers` plural, etc.) are removed. Pin to `caws-cli@^10.2.x` if you need them today.

## When you get blocked

### Block: a gate is failing on `caws gates run --spec <id>`

**Why blocked:** policy declares the gate as `block`, and your changes don't satisfy it.

**Approved workflow:**

```bash
# 1. Inspect what's failing
caws gates run --spec <id>          # exit 1 + diagnostic output

# 2. Either fix the underlying issue, or open a waiver
caws waiver create <id>-w \
  --gate <gate-name> \
  --reason "Why the violation is acceptable + mitigation plan" \
  --approved-by "approver@example.com" \
  --expires-at "2026-12-31T23:59:59Z"

# 3. Re-run gates — the violation is now filtered out of the disposition
caws gates run --spec <id>
```

Waivers do not change gate `mode` (block/warn/skip). They filter matching violations out of the run's disposition. Gate mode lives in `.caws/policy.yaml` and is governed (CI requires dual control to edit).

---

### Block: `caws scope check <path>` returned 1

**Why blocked:** the file is not in your spec's `scope.in`.

**Approved workflow:**

```bash
# 1. Confirm the decision and see why
caws scope show <path>

# 2. If the file genuinely belongs in scope, edit your spec's scope.in
$EDITOR .caws/specs/<id>.yaml          # add the path / glob

# 3. Re-check
caws scope check <path>
```

If the path is genuinely out of scope but you must touch it (rare — usually means the spec was scoped wrong), open a waiver against the scope gate as configured in `policy.yaml`.

---

### Block: a foreign session owns the worktree

**Why blocked:** another agent's session id is recorded as the owner of this worktree in `.caws/worktrees.json`. v11 enforces session-id equality before allowing mutations.

**Approved workflow:**

```bash
# 1. Inspect — read-only
caws claim
# prints: <sessionId>:<platform>, last heartbeat age, tmp/<sessionId>/ session-log path

# 2. Read the prior session's log first (it may be paused, not dead)
ls tmp/<sessionId>/

# 3. ONLY with explicit user authorization, take over
caws claim --takeover
# Writes a durable prior_owners audit on the worktree entry.
```

A stale heartbeat is not authorization. Paused sessions are not ended sessions.

---

### Block: `caws init` refuses to run

**Why blocked:** legacy `.caws/working-spec.yaml` is present. v11 refuses single-spec residue (invariant 6).

**Approved workflow:**

```bash
# 1. Migrate the legacy spec into per-feature shape
$EDITOR .caws/specs/<id>.yaml          # extract content from working-spec.yaml
rm .caws/working-spec.yaml

# 2. Re-run
caws init                              # idempotent; will succeed
```

Alternatively, do the migration on `caws-cli@10.2.x` and then upgrade.

---

### Block: editing `.caws/policy.yaml` is rejected

**Why blocked:** `policy.yaml` is a governed path. CI requires dual control + path discipline (no code changes in the same PR).

**Approved workflow:**

1. Open a separate PR for the policy change.
2. If the underlying motivation is a budget breach, prefer a waiver over a policy edit. Waivers are time-bound and auditable.

---

## v11 command cheat sheet

| Situation | Command |
|---|---|
| Health check | `caws doctor` |
| Dashboard | `caws status` |
| Explain scope decision | `caws scope show <path>` |
| Enforce scope decision | `caws scope check <path>` |
| Inspect worktree claim | `caws claim` |
| Take over worktree (with authorization) | `caws claim --takeover` |
| Run quality gates | `caws gates run --spec <id>` |
| Record test evidence | `caws evidence record --type test --spec <id> --data '{...}'` |
| Record AC closure | `caws evidence record --type ac --spec <id> --data '{...}'` |
| Open a waiver | `caws waiver create <id> --gate <g> --reason "..." --approved-by "..." --expires-at <iso8601>` |
| List waivers | `caws waiver list` |
| Show waiver | `caws waiver show <id>` |
| Revoke waiver | `caws waiver revoke <id>` |

---

## Daily agent loop

1. **Author the spec** in `.caws/specs/<id>.yaml`. v11 does not ship a spec generator — author the YAML directly.
2. **Verify scope** with `caws scope check <path>` for each file you intend to touch.
3. **Implement and test.** Run your project's test suite as usual.
4. **Record typed evidence** as ACs close: `caws evidence record --type ac --spec <id> --data '{"id":"A1","status":"satisfied"}'`.
5. **Run gates** with `caws gates run --spec <id>`. If anything blocks, fix or waive.
6. **Re-check** with `caws doctor` and `caws status` before declaring done.

---

## Operating principles

1. **Use observability proactively.** `caws doctor` and `caws status` are free; run them often.
2. **Waivers are normal.** Time-bound exceptions with an approver are the legitimate escape; hand-editing `change_budget` is not.
3. **Dual control on governed paths is real.** `policy.yaml`, `CODEOWNERS`, and pre-commit hooks are not yours to silently bypass.
4. **Transparency by construction.** Every gate evaluation appends a `gate_evaluated` event to `.caws/events.jsonl` (hash-chained). Every takeover writes a `prior_owners` audit.
5. **Replacement, not migration.** v11 commands are the canonical surface. Don't reach for v10 names; they're gone.

---

## See also

- [`docs/architecture/caws-vnext-command-surface.md`](architecture/caws-vnext-command-surface.md) — doctrine source (posture, kept commands, removed commands, invariants)
- [`docs/api/cli.md`](api/cli.md) — full CLI reference for v11
- [`AGENTS.md`](../AGENTS.md) — agent quickstart
- [`docs/guides/waiver-troubleshooting.md`](guides/waiver-troubleshooting.md) — waiver patterns
- [`docs/guides/worktree-isolation.md`](guides/worktree-isolation.md) — worktree discipline
