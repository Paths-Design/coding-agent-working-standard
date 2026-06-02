---
doc_id: multi-agent-workflow-guide
authority: reference
status: active
title: Multi-agent workflow (v11.1)
owner: vNext rewrite team
updated: 2026-05-28
audience: consumer
---

# Multi-agent workflow (v11.1)

**Each agent works on its own per-feature spec, in its own git worktree, with non-overlapping scope.**

This guide describes the v11.1 multi-agent pattern. For worktree mechanics, see [`worktree-isolation.md`](worktree-isolation.md). For the full CLI surface, see [`docs/api/cli.md`](../api/cli.md).

> **v11.1 surface.** v11.1 ships twelve command groups: `init`, `doctor`, `status`, `scope`, `claim`, `gates`, `evidence`, `events`, `waiver`, `specs`, `worktree`, `agents` (plus the auto-generated `help`). Use `caws specs create` to author specs, `caws worktree create <name> --spec <id>` to bind worktrees, and `caws worktree merge <name>` to close out. Removed and not returning: `validate`, `iterate`, `evaluate`, `diagnose`, `parallel setup`.

## The pattern

| Concern | Mechanism |
|---|---|
| One feature = one spec | `caws specs create <id>` → `.caws/specs/<id>.yaml` |
| Scope boundaries | Spec's `scope.in` / `scope.out`; enforced by `caws scope check <path>` |
| Worktree isolation | `caws worktree create <name> --spec <id>` writes binding + emits events |
| Ownership audit | `.caws/worktrees.json:owner` (session id), `prior_owners` audit on `--takeover` |
| Agent visibility | `caws agents list` / `caws agents show <id>` (liveness cache — not authority) |
| Per-spec gates | `caws gates run --spec <id>` |
| Per-spec evidence | `caws evidence record --type <kind> --spec <id> --data '{...}'` |
| Per-spec waivers | `caws waiver create <id>-w --gate <gate> --reason "..." --approved-by "..." --expires-at <iso>` |

## Anti-pattern (do not do this)

Multiple agents editing the same spec file (e.g. a project-level `working-spec.yaml`, or two agents both editing `.caws/specs/shared.yaml`). They will overwrite each other and produce non-deterministic gate evaluations.

v11 has no project-level working spec. `caws init` refuses legacy `.caws/working-spec.yaml`.

## End-to-end multi-agent workflow

### Step 1 — create one spec per agent

The host (or first agent) creates per-feature specs via the CLI:

```bash
caws specs create user-auth --title "User Authentication System" --risk-tier T1
caws specs create payment-system --title "Payment System" --risk-tier T1
caws specs create dashboard-ui --title "Dashboard UI" --risk-tier T1
```

Each generated spec lives at `.caws/specs/<id>.yaml`. Edit it to define non-overlapping `scope.in` and explicitly exclude the other features in `scope.out` (defensive — prevents accidental cross-feature edits even if `scope.in` is too broad).

Example (`user-auth.yaml`):

```yaml
id: FEAT-001
title: User Authentication System
risk_tier: T1
mode: feature
scope:
  in:
    - src/auth/**
    - tests/auth/**
  out:
    - src/payments/**
    - src/dashboard/**
acceptance:
  - id: A1
    given: User submits valid credentials
    when: Authentication is requested
    then: JWT token is issued
  - id: A2
    given: Invalid credentials
    when: Authentication is requested
    then: 401 Unauthorized error returned
```

### Step 2 — host creates worktrees

Use `caws worktree create` — it creates the git worktree, writes the bidirectional binding to `.caws/worktrees.json`, and emits `worktree_created` + `worktree_bound` events in a single transaction. Loop once per spec; there is no `caws parallel setup`.

```bash
caws worktree create proj-auth --spec user-auth
caws worktree create proj-payments --spec payment-system
caws worktree create proj-dashboard --spec dashboard-ui
```

Worktrees are created under `.caws/worktrees/<name>/` by default. List them with `caws worktree list`.

### Step 3 — each agent claims its worktree

Inside its assigned worktree, each agent surfaces ownership:

```bash
cd .caws/worktrees/proj-auth
caws claim
# Prints current owner. If unclaimed, records this session as owner in .caws/worktrees.json.
```

If `caws claim` reports a foreign owner, do not take over without explicit user authorization (see [`worktree-isolation.md`](worktree-isolation.md#ownership-and-the-foreign-claim-soft-block)).

### Step 4 — work within scope

Before editing each file, verify it's in your spec's scope:

```bash
caws scope show src/auth/login.ts        # explain
caws scope check src/auth/login.ts       # exit 0 admit / 1 refuse
```

Implement, run your project's test suite as usual.

### Step 5 — record evidence as ACs close

```bash
caws evidence record --type test --spec user-auth \
  --data '{"name":"login_happy_path","status":"pass"}'

caws evidence record --type ac --spec user-auth \
  --data '{"id":"A1","status":"satisfied"}'
```

Both append hash-chained events to `.caws/events.jsonl` via the store.

### Step 6 — run gates per spec

```bash
caws gates run --spec user-auth
```

Each spec evaluates its own gates against the current diff. If a blocking gate fails:

- Fix the issue, re-run, OR
- Open a waiver: `caws waiver create user-auth-w --gate <gate> --reason "..." --approved-by "..." --expires-at <iso>`. Subsequent runs filter that violation out of the disposition.

### Step 7 — verify and merge

```bash
caws doctor                              # surface drift
caws status                              # observability snapshot
```

When the spec is complete, use `caws worktree merge` — it merges the branch into base and auto-closes the bound spec in a single transaction. Then destroy the worktree:

```bash
# From the main worktree (canonical checkout)
caws worktree merge proj-auth
caws worktree destroy proj-auth
```

`caws worktree merge` emits a `worktree_merged` event and calls `caws specs close` on the bound spec automatically. `caws worktree destroy` removes the filesystem tree and the registry entry.

## Detecting scope conflicts

`caws specs conflicts` does not exist in v11.1. To check whether two specs have overlapping `scope.in` patterns, compare them manually. A defensive `scope.out` per spec — listing the other features' directories — catches accidents at `caws scope check` time.

## Listing specs

```bash
caws specs list
```

Shows each spec's `id`, `title`, `status`, and `risk_tier`. Pass `--archived` to include archived specs.

## Common pitfalls

**Pitfall: agents edit the same spec file.**
Each feature gets its own `.caws/specs/<id>.yaml`. Don't share.

**Pitfall: overlapping `scope.in`.**
Use narrow `scope.in` and explicit `scope.out` listing other agents' directories. Verify with `caws scope show <path>` before starting work.

**Pitfall: `caws claim` refuses with a foreign-owner message.**
Read the prior session's log under `tmp/<sessionId>/` first. `--takeover` only with explicit user authorization; it writes a durable `prior_owners` audit.

**Pitfall: agents commit to the base branch.**
Each agent must `cd` into its worktree before working. The pre-commit hook in this repo blocks direct base-branch commits while worktrees are active; only `merge(worktree):` and `wip(checkpoint):` formats are allowed.

**Pitfall: trying `caws validate` / `caws iterate`.**
These are removed in v11. Use `caws specs create` to author specs; validate via `caws doctor` and `caws gates run --spec <id>`.

## Cross-feature coordination

When two features need to interact (e.g., the dashboard consumes the auth API):

1. Define the contract first — write the OpenAPI / TypeScript interface in a file owned by exactly one of the specs.
2. The contract owner publishes; the consumer's spec lists the contract under `contracts:` and treats it as read-only.
3. Don't modify files across `scope.in` boundaries. If you must, the right answer is usually a third spec that owns the shared layer.

## Summary

1. **One feature = one spec** — create with `caws specs create <id>`; edit `scope.in`/`scope.out` before activating agents.
2. **One agent = one worktree** — create with `caws worktree create <name> --spec <id>`. Surface ownership with `caws claim`.
3. **Non-overlapping `scope.in`**, defensive `scope.out`. Verify with `caws scope check`.
4. **Per-spec gates and evidence:** `caws gates run --spec <id>`, `caws evidence record --spec <id>`.
5. **Waivers, not policy edits**, when a gate legitimately needs to pass.
6. **Merge and close with `caws worktree merge <name>`**; then `caws worktree destroy <name>` to remove the tree.

## See also

- [`docs/architecture/caws-vnext-command-surface.md`](../architecture/caws-vnext-command-surface.md) — doctrine source
- [`docs/guides/worktree-isolation.md`](worktree-isolation.md) — worktree mechanics
- [`docs/api/cli.md`](../api/cli.md) — full v11 CLI reference
- [`AGENTS.md`](../../AGENTS.md) — agent quickstart
- [`docs/guides/waiver-troubleshooting.md`](waiver-troubleshooting.md) — waiver patterns
