---
doc_id: multi-agent-workflow-guide
authority: reference
status: active
title: Multi-agent workflow (v11.0.0)
owner: vNext rewrite team
updated: 2026-05-15
---

# Multi-agent workflow (v11.0.0)

**Each agent works on its own per-feature spec, in its own git worktree, with non-overlapping scope.**

This guide describes the v11.0.0 multi-agent pattern. For worktree mechanics, see [`worktree-isolation.md`](worktree-isolation.md). For the full CLI surface, see [`docs/api/cli.md`](../api/cli.md).

> **v11 posture (A1).** v11.0.0 ships eight command groups (`init`, `doctor`, `status`, `scope`, `claim`, `gates`, `evidence`, `waiver`). It does not ship `caws specs create | list | conflicts`, `caws worktree create | merge`, `caws parallel setup | merge | teardown`, or `caws validate | iterate | evaluate | diagnose`. Author specs by editing YAML directly; create worktrees with `git worktree`; surface ownership with `caws claim`. Lifecycle automation returns in v11.1.

## The pattern

| Concern | Mechanism |
|---|---|
| One feature = one spec | `.caws/specs/<id>.yaml` (one file per feature, edited by hand) |
| Scope boundaries | Spec's `scope.in` / `scope.out`; enforced by `caws scope check <path>` |
| Worktree isolation | `git worktree add` (host-side) + `caws claim` (inside worktree) |
| Ownership audit | `.caws/worktrees.json:owner` (session id), `prior_owners` audit on `--takeover` |
| Per-spec gates | `caws gates run --spec <id>` |
| Per-spec evidence | `caws evidence record --type <kind> --spec <id> --data '{...}'` |
| Per-spec waivers | `caws waiver create <id>-w --gate <gate> --reason "..." --approved-by "..." --expires-at <iso>` |

## Anti-pattern (do not do this)

Multiple agents editing the same spec file (e.g. a project-level `working-spec.yaml`, or two agents both editing `.caws/specs/shared.yaml`). They will overwrite each other and produce non-deterministic gate evaluations.

v11 has no project-level working spec. `caws init` refuses legacy `.caws/working-spec.yaml`.

## End-to-end multi-agent workflow

### Step 1 — author one spec per agent

The host (or first agent) authors per-feature YAML files. v11 has no spec generator; create the files directly.

```bash
$EDITOR .caws/specs/user-auth.yaml
$EDITOR .caws/specs/payment-system.yaml
$EDITOR .caws/specs/dashboard-ui.yaml
```

Each spec must define non-overlapping `scope.in` and explicitly exclude the other features in `scope.out` (defensive — prevents accidental cross-feature edits even if `scope.in` is too broad).

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

```bash
git worktree add ../proj-auth -b agent-auth
git worktree add ../proj-payments -b agent-payments
git worktree add ../proj-dashboard -b agent-dashboard
```

### Step 3 — each agent claims its worktree

Inside its assigned worktree, each agent surfaces ownership:

```bash
cd ../proj-auth
caws claim
# Records this session as the worktree owner in .caws/worktrees.json
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

When the spec is complete, the host merges the agent branch back to base:

```bash
# From the main worktree
git checkout main
git merge --no-ff agent-auth
git worktree remove ../proj-auth
git branch -d agent-auth
```

## Detecting scope conflicts (manual in v11)

v11 does not ship `caws specs conflicts`. To check whether two specs have overlapping `scope.in` patterns, read the YAML directly. A defensive `scope.out` per spec — listing the other features' directories — catches accidents at `caws scope check` time.

In v11.1 a vNext `caws specs conflicts` returns.

## Listing specs (manual in v11)

v11 does not ship `caws specs list`. List by directory:

```bash
ls .caws/specs/
```

Each YAML's `id`, `title`, `status`, and `risk_tier` fields describe it.

## Common pitfalls

**Pitfall: agents edit the same spec file.**
Each feature gets its own `.caws/specs/<id>.yaml`. Don't share.

**Pitfall: overlapping `scope.in`.**
Use narrow `scope.in` and explicit `scope.out` listing other agents' directories. Verify with `caws scope show <path>` before starting work.

**Pitfall: `caws claim` refuses with a foreign-owner message.**
Read the prior session's log under `tmp/<sessionId>/` first. `--takeover` only with explicit user authorization; it writes a durable `prior_owners` audit.

**Pitfall: agents commit to the base branch.**
Each agent must `cd` into its worktree before working. The pre-commit hook in this repo blocks direct base-branch commits while worktrees are active; only `merge(worktree):` and `wip(checkpoint):` formats are allowed.

**Pitfall: trying `caws specs create` / `caws validate` / `caws iterate`.**
These are removed in v11. Author the YAML directly; validate via `caws doctor` and `caws gates run`.

## Cross-feature coordination

When two features need to interact (e.g., the dashboard consumes the auth API):

1. Define the contract first — write the OpenAPI / TypeScript interface in a file owned by exactly one of the specs.
2. The contract owner publishes; the consumer's spec lists the contract under `contracts:` and treats it as read-only.
3. Don't modify files across `scope.in` boundaries. If you must, the right answer is usually a third spec that owns the shared layer.

## Summary

1. **One feature = one spec** under `.caws/specs/<id>.yaml`. Author by hand.
2. **One agent = one worktree** via `git worktree add`. Surface ownership with `caws claim`.
3. **Non-overlapping `scope.in`**, defensive `scope.out`. Verify with `caws scope check`.
4. **Per-spec gates and evidence:** `caws gates run --spec <id>`, `caws evidence record --spec <id>`.
5. **Waivers, not policy edits**, when a gate legitimately needs to pass.
6. **Manual `git worktree` merge** for now; lifecycle automation returns in v11.1.

## See also

- [`docs/architecture/caws-vnext-command-surface.md`](../architecture/caws-vnext-command-surface.md) — doctrine source
- [`docs/guides/worktree-isolation.md`](worktree-isolation.md) — worktree mechanics
- [`docs/api/cli.md`](../api/cli.md) — full v11 CLI reference
- [`AGENTS.md`](../../AGENTS.md) — agent quickstart
- [`docs/guides/waiver-troubleshooting.md`](waiver-troubleshooting.md) — waiver patterns
