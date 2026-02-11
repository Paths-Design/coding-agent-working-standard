# Git Worktree Isolation Guide

## Overview

CAWS git worktree isolation gives each AI agent a physically separate working directory backed by its own git branch. This prevents agents from interfering with each other's work — the most common source of catastrophic failures in multi-agent workflows.

## Why Worktrees?

When running 2-3 AI agents in parallel, common failures include:

- **Scope drift**: Agent A modifies files Agent B is working on
- **Git destruction**: An agent runs `git init` or `git reset --hard`, losing work
- **File sprawl**: Agents create duplicate files (`*-enhanced.*`, `*-final.*`)
- **Merge conflicts**: Agents commit to the same branch simultaneously

Worktrees solve this by giving each agent its own:
- Working directory (different filesystem path)
- Git branch (independent commit history)
- Sparse checkout (only sees relevant files)

## Quick Start

```bash
# Initialize CAWS (lite mode is sufficient)
caws init . --mode lite

# Create worktrees for each agent
caws worktree create agent-auth --scope "src/auth/**,tests/auth/**"
caws worktree create agent-dashboard --scope "src/dashboard/**,tests/dashboard/**"
caws worktree create agent-api --scope "src/api/**,tests/api/**"

# Each agent works in its own directory
# Agent 1: cd .caws/worktrees/agent-auth/
# Agent 2: cd .caws/worktrees/agent-dashboard/
# Agent 3: cd .caws/worktrees/agent-api/
```

## Lifecycle

### Create

```bash
caws worktree create <name> [options]

Options:
  --scope <patterns>      Sparse checkout patterns (comma-separated)
  --base-branch <branch>  Branch to create from (default: current)
  --spec-id <id>          Auto-generate a working spec (standard+ modes)
```

Creates:
- `.caws/worktrees/<name>/` — the worktree directory
- `caws/<name>` — the git branch
- Registry entry in `.caws/worktrees.json`

### List

```bash
caws worktree list
```

Shows all registered worktrees with status (active, orphaned, missing, destroyed).

### Destroy

```bash
caws worktree destroy <name> [options]

Options:
  --delete-branch  Also delete the git branch
  --force          Force removal even if worktree has uncommitted changes
```

### Prune

```bash
caws worktree prune [options]

Options:
  --max-age <days>  Remove entries older than N days (default: 30)
```

## Patterns

### Pattern 1: Feature-per-Agent

Each agent owns a feature directory:

```bash
caws worktree create auth --scope "src/auth/**,tests/auth/**"
caws worktree create payments --scope "src/payments/**,tests/payments/**"
```

### Pattern 2: Layer-per-Agent

Each agent owns a layer:

```bash
caws worktree create frontend --scope "src/components/**,src/pages/**"
caws worktree create backend --scope "src/api/**,src/services/**"
caws worktree create infra --scope "infra/**,deploy/**"
```

### Pattern 3: Safe Experimentation

Worktrees for risky experiments that can be safely discarded:

```bash
caws worktree create experiment-new-orm --scope "src/db/**"
# ... experiment fails ...
caws worktree destroy experiment-new-orm --delete-branch --force
```

## Integration with CAWS Modes

| Mode       | Worktree Behavior |
|------------|-------------------|
| Lite       | Worktrees get `.caws/scope.json` copied |
| Simple     | Same as Lite |
| Standard   | Auto-generates a working spec with `--spec-id` |
| Enterprise | Full spec + audit trail per worktree |

## Merging Work Back

After agents complete their work in worktrees:

```bash
# From the main working directory
git checkout main

# Merge each agent's branch
git merge caws/agent-auth
git merge caws/agent-dashboard
git merge caws/agent-api

# Clean up
caws worktree destroy agent-auth --delete-branch
caws worktree destroy agent-dashboard --delete-branch
caws worktree destroy agent-api --delete-branch
caws worktree prune --max-age 0
```

## Filesystem Layout

```
project/
├── .caws/
│   ├── scope.json            # Lite mode config
│   ├── mode.json             # Current mode
│   ├── worktrees.json        # Registry (gitignored)
│   └── worktrees/            # Worktree dirs (gitignored)
│       ├── agent-auth/       # Agent 1's isolated workspace
│       │   ├── .caws/        # Copied config
│       │   ├── src/auth/     # Sparse checkout
│       │   └── tests/auth/
│       └── agent-dashboard/  # Agent 2's isolated workspace
│           ├── .caws/
│           ├── src/dashboard/
│           └── tests/dashboard/
├── src/                      # Main working directory
├── tests/
└── .gitignore                # Includes .caws/worktrees/
```

## Troubleshooting

**Worktree shows "orphaned" status**: The git worktree was removed outside of CAWS. Run `caws worktree prune` to clean up.

**Worktree shows "missing" status**: The directory was deleted. Run `caws worktree prune` to remove the registry entry, or recreate with `caws worktree create`.

**Can't delete worktree**: Use `--force` flag. The worktree may have uncommitted changes.

**Sparse checkout not working**: Your git version may not support `sparse-checkout`. Update git to 2.25+ or create worktrees without `--scope`.
