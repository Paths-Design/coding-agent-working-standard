---
description: Rules for safe multi-agent git worktree isolation
globs:
---

# Multi-Agent Worktree Safety

When multiple agents are working on this project, each agent MUST work in its own git worktree. Never have two agents committing to the same branch.

## Before starting work

1. Check if worktrees exist: `caws worktree list` shows all active worktrees with last commit time and owner
2. Check who's actually working: `caws agents list` shows registered sessions and their bound worktree/spec, formatted as `<sessionId>:<platform>`
3. If you're inside a worktree, run `caws status` — the Claim panel shows the current owner, last heartbeat, and any session-log pointer under `tmp/<sessionId>/`
4. If worktrees are active and you are on the base branch, switch to your assigned worktree
5. If no worktree exists for you, create one with `caws worktree create <name>` or `caws parallel setup <plan-file>`

## Foreign-claim soft-block (CAWSFIX-31/32)

`caws worktree bind`, `merge`, and `claim` refuse to mutate a worktree whose `worktrees.json:owner` is a session id different from the current session — unless `--takeover` is supplied. The refusal prints a structured warning naming the claimer as `<sessionId>:<platform>`, the heartbeat age, any session-log pointer under `tmp/<sessionId>/`, and the exact `--takeover` command.

**Decision-gating uses session-id equality only.** A stale heartbeat is NOT authorization to take over — paused sessions are not ended sessions. Read the session log under `tmp/<sessionId>/` for context first. Take over only with explicit user authorization. `--takeover` writes a durable `prior_owners` audit on the worktree entry.

## Forbidden operations when worktrees are active

- `git commit --amend` -- rewrites history that other agents depend on
- `git stash` / `git stash pop` -- stash is shared across all worktrees; using it can destroy another agent's uncommitted work
- `git reset --hard` -- discards work that other agents may depend on
- `git push --force` -- rewrites remote history
- Direct commits to the base branch -- only `merge(worktree):` and `wip(checkpoint):` formats are allowed
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
