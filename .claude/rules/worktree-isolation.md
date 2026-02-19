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
- Direct commits to the base branch -- the pre-commit hook will block this
- Copying files between your worktree and the main repo directory -- defeats isolation

## Merging worktree branches back to base

Merge commits ARE allowed on the base branch while other worktrees are active. This lets you incrementally merge completed work without waiting for all agents to finish.

1. Destroy the worktree first: `caws worktree destroy <name>`
2. Switch to the base branch: `git checkout main`
3. Merge with: `git merge --no-ff <worktree-branch>`
4. The commit-msg hook enforces the `merge(worktree): <description>` format for non-FF merges
5. For manual merge commits: `git commit -m "merge(worktree): integrate scenarios work"`

## Virtual environment in worktrees

Do NOT create a new virtual environment in your worktree. Use the main repo's venv:

```bash
source <main-repo-path>/.venv/bin/activate
```

If your project uses `.caws/scope.json`, the `designatedVenvPath` field specifies the correct venv location.

## When your work is done

1. Commit all changes to your worktree branch
2. Run tests in your worktree to verify
3. Destroy your worktree with `caws worktree destroy <name>`
4. Merge your branch to base: `git merge --no-ff <branch>` (uses `merge(worktree):` format)
5. Delete the branch if no longer needed: `git branch -d <branch>`
4. Only merge back to the base branch after ALL other worktrees are also destroyed
