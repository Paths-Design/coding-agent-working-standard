---
description: Rules for safe multi-agent git worktree isolation
globs:
---

# Multi-Agent Worktree Safety

When multiple agents are working on this project, each agent MUST work in its own git worktree. Never have two agents committing to the same branch.

## Before starting work

1. Check if worktrees exist: look for `.caws/worktrees.json` or `.caws/parallel.json`
2. If worktrees are active and you are on the base branch, switch to your assigned worktree
3. If no worktree exists for you, create one with `caws worktree create <name>` or `caws parallel setup <plan-file>`

## Forbidden operations when worktrees are active

- `git commit --amend` -- rewrites history that other agents depend on
- `git stash` / `git stash pop` -- stash is shared across all worktrees; using it can destroy another agent's uncommitted work
- `git reset --hard` -- discards work that other agents may depend on
- `git push --force` -- rewrites remote history
- Committing to the base branch -- the pre-commit hook will block this, but do not attempt it

## When your work is done

1. Commit all changes to your worktree branch
2. Run tests in your worktree to verify
3. Only merge back to the base branch after ALL other worktrees are also complete
4. Destroy your worktree with `caws worktree destroy <name> --delete-branch` or `caws parallel teardown --delete-branches`
