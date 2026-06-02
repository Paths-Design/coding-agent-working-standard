---
doc_id: worktree-isolation-guide
authority: reference
status: active
title: Git worktree isolation for parallel agents (v11.1)
owner: vNext rewrite team
updated: 2026-05-28
audience: consumer
---

# Git worktree isolation for parallel agents (v11.1)

## Overview

Multiple AI agents working on the same repo in parallel must work in **isolated git worktrees**. This guide covers the v11.1 workflow: create worktrees with `caws worktree create`, surface and govern ownership with `caws claim`.

> **v11.1 surface.** v11.1 ships full worktree lifecycle: `caws worktree create | list | bind | destroy | merge | migrate-registry | repair-sparse`. Use these commands — they write bidirectional bindings, emit audit events, and enforce ownership. `caws parallel setup` does not exist and is not planned; loop `caws worktree create` per spec instead.

## Why worktrees?

When 2+ agents run on the same project, the common failures are:

- **Scope drift** — agent A modifies files agent B is working on
- **Git destruction** — an agent runs `git init` or `git reset --hard`, losing work
- **File sprawl** — agents create duplicate files (`*-enhanced.*`, `*-final.*`)
- **Merge conflicts** — agents commit to the same branch simultaneously

Worktrees give each agent its own working directory and branch, so concurrent edits don't fight.

## Quick start (v11.1)

```bash
# 1. Create the worktree and bind it to a spec in one command (host-side)
caws worktree create my-proj-agent-auth --spec <spec-id>
# Creates .caws/worktrees/my-proj-agent-auth/, checks out a new branch,
# writes the bidirectional binding, and emits worktree_created + worktree_bound events.

# 2. Inside the worktree, surface ownership via CAWS
cd .caws/worktrees/my-proj-agent-auth
caws claim
# Prints: <sessionId>:<platform>, last heartbeat, any tmp/<sessionId>/ session-log path
# If the worktree has no prior owner, the current session takes it.
```

The agent now works in `.caws/worktrees/my-proj-agent-auth/` on the generated branch. `caws claim` records ownership in `.caws/worktrees.json`. List all worktrees with `caws worktree list`.

## Ownership and the foreign-claim soft-block

`caws claim`, `caws worktree bind`, `caws worktree merge`, and `caws worktree destroy` all refuse to mutate a worktree owned by a different session id without `--takeover`. The refusal looks like:

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
# Host-side: create specs then bind worktrees
caws specs create auth --title "Auth feature"
caws specs create payments --title "Payments feature"

# Edit each spec's scope.in before creating the worktrees
# .caws/specs/auth.yaml:     scope.in: [src/auth/**, tests/auth/**]
# .caws/specs/payments.yaml: scope.in: [src/payments/**, tests/payments/**]

caws worktree create proj-auth --spec auth
caws worktree create proj-payments --spec payments

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
caws specs create experiment-new-orm --title "Experiment: new ORM"
caws worktree create proj-experiment --spec experiment-new-orm
cd .caws/worktrees/proj-experiment
# ... try it ...
# If it works — merge and auto-close the bound spec:
caws worktree merge proj-experiment
caws worktree destroy proj-experiment
# If it fails — abandon:
caws worktree destroy proj-experiment --abandon-unmerged
```

## Merging work back

Use `caws worktree merge` — it merges the branch into base and auto-closes the bound spec in a single transaction. Then destroy the worktree:

```bash
# From the canonical checkout (main working directory)
caws worktree merge proj-auth
caws worktree destroy proj-auth

caws worktree merge proj-payments
caws worktree destroy proj-payments
```

`caws worktree merge` emits a `worktree_merged` event and calls `caws specs close` on the bound spec automatically. The `merge(worktree): <description>` commit-message convention is enforced by this repo's commit-msg hook for non-fast-forward merges.

## Workspace package managers (pnpm, yarn, npm workspaces)

Linked git worktrees share the main checkout's `.git/` and tracked files but **do NOT share `node_modules/`** — each worktree starts with a bare working tree. Workspace-based tools (`pnpm`, `yarn workspaces`, `npm workspaces`, `turbo`) rely on a `node_modules/` tree at the workspace root and per-package `node_modules/` symlinks, so the first thing you'll notice inside a fresh linked worktree is that `pnpm test` (or your equivalent) fails immediately with missing-binary or missing-module errors.

This is not a CAWS bug. It's how `git worktree` and workspace package managers interact.

You have two recovery options. Pick based on whether you need to run package scripts from inside the worktree or from the repo root:

**Option A — run from the repo root with a workspace filter** (preferred for short slices):

```bash
# From the canonical checkout root, target the package by name:
pnpm -F @scope/my-package test
yarn workspace @scope/my-package test
npm -w @scope/my-package test
turbo run test --filter=@scope/my-package
```

The package scripts execute against your worktree's source (because git-worktree shares the tracked files) but resolve dependencies from the canonical `node_modules/`. No extra disk, no extra install.

**Option B — install in the worktree** (preferred when the slice is long enough that you'll cd in and out often):

```bash
# From inside the linked worktree:
cd .caws/worktrees/<name>
pnpm install --prefer-offline   # or: npm install, yarn install
```

This materializes a parallel `node_modules/` tree inside the worktree. Subsequent `pnpm test` / `npm test` calls work natively. The extra disk is real (often several hundred MB for a large monorepo); only pay it for longer-lived worktrees.

**A third workaround you may see in scripts** — symlinking the canonical `node_modules/` into the worktree — works but is fragile: workspace package managers sometimes write into `node_modules/.bin/` during script execution, and a shared symlink means those writes appear in canonical's tree too. Prefer Option A or B over symlinks unless you understand the failure modes.

`node_modules/` is `.gitignore`d in every well-formed repo, so neither recovery option ever commits the dependency tree.

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


## See also

- [`docs/architecture/caws-vnext-command-surface.md`](../architecture/caws-vnext-command-surface.md) — doctrine source (kept commands, removed commands, invariants)
- [`docs/api/cli.md`](../api/cli.md) — full v11 CLI reference (see §5 `caws claim`)
- [`docs/guides/multi-agent-workflow.md`](multi-agent-workflow.md) — agent coordination patterns
- [`AGENTS.md`](../../AGENTS.md) — agent quickstart for working in v11 projects
- [`.claude/rules/worktree-isolation.md`](../../.claude/rules/worktree-isolation.md) — Claude Code agent rules for this repo
