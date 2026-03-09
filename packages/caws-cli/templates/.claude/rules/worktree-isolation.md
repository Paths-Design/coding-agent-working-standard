---
description: Rules for safe multi-agent git worktree isolation
globs:
---

# Multi-Agent Worktree Safety

When multiple agents are working on this project, each agent MUST work in its own git worktree. Never have two agents committing to the same branch.

## Before starting work

1. Check if worktrees exist: `caws worktree list` shows all active worktrees with last commit time and owner
2. If worktrees are active and you are on the base branch, switch to your assigned worktree
3. If no worktree exists for you, create one with `caws worktree create <name>` or `caws parallel setup <plan-file>`
4. **Never touch a worktree you did not create.** Do not destroy, prune, stash, or "clean up" another agent's worktree — even if it looks stale. Another agent may be actively working in it. If you think a worktree is abandoned, leave it alone and let the user decide.

## Forbidden operations when worktrees are active

- `git commit --amend` -- rewrites history that other agents depend on
- `git rebase` -- rewrites branch history; the hook blocks this automatically while worktrees are active. If you need code from main, create a new worktree from current main instead
- `git cherry-pick` -- replays commits across branches; blocked while worktrees are active to prevent cross-boundary contamination
- `git stash` / `git stash pop` -- stash is shared across all worktrees; using it can destroy another agent's uncommitted work
- `git reset --hard` -- discards work that other agents may depend on
- `git push --force` -- rewrites remote history
- Direct commits to the base branch -- only `merge(worktree):` and `wip(checkpoint):` formats are allowed
- Copying files between your worktree and the main repo directory -- defeats isolation
- Destroying another agent's worktree -- even with `--force`. If you did not create it, do not destroy it. Period.

## Merging worktree branches back to base

Merge commits ARE allowed on the base branch while other worktrees are active. This lets you incrementally merge completed work without waiting for all agents to finish.

### Recommended: use `caws worktree merge`

The `merge` command handles the full sequence (conflict check, destroy, merge, cleanup):

```bash
# Preview conflicts before merging
caws worktree merge <name> --dry-run

# Merge (destroys worktree, merges branch, deletes branch)
caws worktree merge <name>

# Merge with custom commit message
caws worktree merge <name> --message "merge(worktree): description of changes"
```

### Manual merge (if you need more control)

1. Destroy the worktree first: `caws worktree destroy <name>`
2. Switch to the base branch: `git checkout main`
3. Merge with: `git merge --no-ff <worktree-branch>`
4. The commit-msg hook enforces the `merge(worktree): <description>` format for non-FF merges
5. For manual merge commits: `git commit -m "merge(worktree): integrate scenarios work"`

### Conflict resolution during merge

The write guard allows edits on the base branch while a merge is in progress (MERGE_HEAD exists). This lets you resolve merge conflicts without needing to abort and retry. After resolving, commit with the `merge(worktree):` format.

## What the write guard allows on the base branch

Even when worktrees are active, the following edits are allowed on the base branch:

- `.claude/` and `.caws/` configuration files
- `docs/` directory (documentation changes are benign)
- Any file while a merge is in progress (conflict resolution)

## Virtual environment in worktrees

Do NOT create a new virtual environment in your worktree. Use the main repo's venv:

```bash
source <main-repo-path>/.venv/bin/activate
```

If your project uses `.caws/scope.json`, the `designatedVenvPath` field specifies the correct venv location.

## When your work is done

1. Commit all changes to your worktree branch
2. Run tests in your worktree to verify
3. Merge: `caws worktree merge <name>` (handles destroy + merge + branch cleanup)
4. Or manually: destroy worktree, then `git merge --no-ff <branch>`, then delete branch
