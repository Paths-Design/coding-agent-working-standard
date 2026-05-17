---
doc_id: worktree-isolation-guide
authority: reference
status: active
title: Git worktree isolation for parallel agents (v11.0.0)
owner: vNext rewrite team
updated: 2026-05-15
---

# Git worktree isolation for parallel agents (v11.0.0)

## Overview

Multiple AI agents working on the same repo in parallel must work in **isolated git worktrees**. This guide covers the v11.0.0 workflow: create worktrees with `git worktree` directly, surface and govern ownership with `caws claim`.

> **v11 posture (A1).** v11.0.0 does not ship `caws worktree create | destroy | merge | bind | prune | repair` or `caws parallel setup | status | merge | teardown`. Worktree lifecycle returns in v11.1. Today, use plain `git worktree` for create/destroy/merge and `caws claim` for ownership.
>
> If your project relies on the legacy lifecycle automation, pin `caws-cli@^10.2.x`.

## Why worktrees?

When 2+ agents run on the same project, the common failures are:

- **Scope drift** — agent A modifies files agent B is working on
- **Git destruction** — an agent runs `git init` or `git reset --hard`, losing work
- **File sprawl** — agents create duplicate files (`*-enhanced.*`, `*-final.*`)
- **Merge conflicts** — agents commit to the same branch simultaneously

Worktrees give each agent its own working directory and branch, so concurrent edits don't fight.

## Quick start (v11)

```bash
# 1. Create the worktree externally (host-side, before the agent starts)
git worktree add ../my-proj-agent-auth -b agent-auth

# 2. Inside the worktree, surface ownership via CAWS
cd ../my-proj-agent-auth
caws claim
# Prints: <sessionId>:<platform>, last heartbeat, any tmp/<sessionId>/ session-log path
# If the worktree has no prior owner, the current session takes it.
```

That's it. The agent now works in `../my-proj-agent-auth/` on branch `agent-auth`. `caws claim` records ownership in `.caws/worktrees.json`.

## Ownership and the foreign-claim soft-block

`caws claim` (and, in v11.1, the lifecycle commands) refuse to mutate a worktree owned by a different session id without `--takeover`. The refusal looks like:

```
Worktree '<name>' is claimed by 8be65780-...:claude-code
   Last heartbeat: 2026-04-27T17:04:00Z (23 min ago)
   Session log:    tmp/8be65780-72e0-4fc7-a989-4ebac148c18d
                   15 turns, last turn 2026-04-27T17:26:49Z
   To proceed:     caws claim --takeover
```

**Read the session log first.** A stale heartbeat does not mean the prior session is dead — it may be paused. Take over only with explicit user authorization. `--takeover` writes a durable `prior_owners` audit (sessionId, platform, lastSeen-at-takeover, takenOver_at) to the worktree entry in `.caws/worktrees.json`.

Decision-gating uses session-id equality only. Do not interpret the heartbeat age as authorization.

## Patterns

### Pattern 1: feature-per-agent

Each agent owns a feature directory. Define `scope.in` in each spec to enforce file-level boundaries:

```bash
# Host-side
git worktree add ../proj-auth -b feat/auth
git worktree add ../proj-payments -b feat/payments

# Each agent edits its spec
# .caws/specs/auth.yaml:    scope.in: [src/auth/**, tests/auth/**]
# .caws/specs/payments.yaml: scope.in: [src/payments/**, tests/payments/**]

# Inside each worktree, the agent runs
caws claim
caws scope check src/auth/login.ts        # 0 admit / 1 refuse
```

`caws scope check` enforces the per-spec boundary. Out-of-scope edits exit 1.

### Pattern 2: layer-per-agent

Each agent owns a layer (frontend, backend, infra). Same shape — different `scope.in`.

### Pattern 3: safe experimentation

A worktree is a cheap way to try a risky change without polluting `main`:

```bash
git worktree add ../proj-experiment -b experiment/new-orm
# ... try it ...
# If it works:
git checkout main && git merge --no-ff experiment/new-orm
# If it fails:
git worktree remove ../proj-experiment --force
git branch -D experiment/new-orm
```

## Merging work back

v11 does not ship `caws worktree merge` or `caws parallel merge`. Use `git` directly:

```bash
# From the main working directory
git checkout main

# Merge each agent's branch
git merge --no-ff agent-auth
git merge --no-ff agent-payments

# Clean up worktrees
git worktree remove ../proj-auth
git worktree remove ../proj-payments
git branch -d agent-auth agent-payments
```

The `merge(worktree): <description>` commit-message convention is recommended (and enforced by this repo's commit-msg hook) for non-fast-forward merges from agent branches into base.

## Filesystem layout

```
project/                   # main working directory (e.g. branch: main)
├── .caws/
│   ├── policy.yaml
│   ├── specs/
│   ├── waivers/
│   ├── worktrees.json     # ownership registry (per-worktree session id, prior_owners audit)
│   └── agents.json        # agent session registry (written by external session-log hook)
├── src/
└── tests/

../proj-auth/              # agent 1's worktree (branch: agent-auth)
├── .caws/                 # shared with the main repo via git worktree
└── src/

../proj-payments/          # agent 2's worktree (branch: agent-payments)
├── .caws/
└── src/
```

The `.caws/` directory is shared across worktrees because git worktree shares the working tree's tracked files. Per-worktree session ownership is keyed inside `.caws/worktrees.json` by worktree path.

## Troubleshooting

**`caws claim` refuses with a foreign-owner message.**
Another session id owns the worktree. Read their `tmp/<sessionId>/` log. Take over only with explicit authorization (`caws claim --takeover`).

**`caws status` shows worktree findings under doctor.**
Doctor surfaces drift: orphaned worktree entries, missing directories, ownership conflicts. The repair string in each finding is v11-honest — it points to manual `git worktree` operations or `caws claim`.

**Agents are still committing to base.**
Check that each agent is `cd`'d into its worktree, not the main repo. The pre-commit hook in this repo blocks direct base-branch commits during active worktree sessions; only `merge(worktree):` and `wip(checkpoint):` commits are allowed.

**Want lifecycle automation back?**
Pin `caws-cli@^10.2.x` until v11.1 ships vNext spec/worktree lifecycle. Do not mix the two CLIs in the same project — they write to overlapping state.

## See also

- [`docs/architecture/caws-vnext-command-surface.md`](../architecture/caws-vnext-command-surface.md) — doctrine source (kept commands, removed commands, invariants)
- [`docs/api/cli.md`](../api/cli.md) — full v11 CLI reference (see §5 `caws claim`)
- [`docs/guides/multi-agent-workflow.md`](multi-agent-workflow.md) — agent coordination patterns
- [`AGENTS.md`](../../AGENTS.md) — agent quickstart for working in v11 projects
- [`.claude/rules/worktree-isolation.md`](../../.claude/rules/worktree-isolation.md) — Claude Code agent rules for this repo
