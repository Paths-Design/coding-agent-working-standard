---
description: Rules for safe multi-agent git worktree isolation
globs:
---

# Multi-Agent Worktree Safety

When multiple agents are working on this project, each agent MUST work in its own git worktree. Never have two agents committing to the same branch.

## Before starting work

1. Check if worktrees exist: `caws worktree list` shows all active worktrees with their branch, spec binding, and owner session.
2. If you're inside a worktree, run `caws status` — the Claim panel shows the current owner, any prior_owners audit history, and any session-log pointer under `.caws/sessions/<sessionId>/` if your harness produces one. For cross-session inspection use `caws agents list` / `caws agents show <id>` (read-only liveness substrate — operational cache, never authority).
3. If worktrees are active and you are on the base branch, switch to your assigned worktree.
4. If no worktree exists for you, create one with `caws worktree create <name> --spec <id>`. For setting up multiple worktrees in parallel, loop `caws worktree create` per spec — there is no `caws parallel setup` in v11; that surface was removed and is not planned to return.

## Foreign-claim soft-block (CAWSFIX-31/32)

`caws worktree bind`, `merge`, and `claim` refuse to mutate a worktree whose `worktrees.json:owner` is a session id different from the current session — unless `--takeover` is supplied. The refusal prints a structured warning naming the claimer as `<sessionId>:<platform>`, any session-log pointer under `.caws/sessions/<sessionId>/`, and the exact `--takeover` command.

**Stale lease is evidence, never authority.** This is doctrine invariant §6.8 in `docs/architecture/caws-vnext-command-surface.md`. Leases ship today (per-session files under `.caws/leases/`, surfaced by `caws agents list`). A stale lease or stale heartbeat may justify a louder warning or richer takeover context — it does NOT silently authorize a takeover or relax the foreign-claim refusal. Paused sessions are not ended sessions. The only authority transition is: prior owner exists → new session supplies `--takeover` → registry updates and audit event appends in one lifecycle transaction. Take over only with explicit user authorization.

`--takeover` writes a durable `prior_owners` audit on the worktree entry. In v11.2, takeover will additionally emit a `claim_taken_over.v1` event into the hash-chained `events.jsonl` (the audit gap that exists in v11.0–v11.1.x).

## Forbidden operations when worktrees are active

- `git commit --amend` -- rewrites history that other agents depend on
- `git stash` / `git stash pop` -- stash is shared across all worktrees; using it can destroy another agent's uncommitted work
- `git reset --hard` -- discards work that other agents may depend on
- `git push --force` -- rewrites remote history
- Direct commits to the base branch -- only `merge(worktree):` and `wip(checkpoint):` formats are allowed
- Copying files between your worktree and the main repo directory -- defeats isolation

## Merging worktree branches back to base

Merge commits ARE allowed on the base branch while other worktrees are active. This lets you incrementally merge completed work without waiting for all agents to finish.

**Governed path (preferred): `caws worktree merge <name>`.** From the canonical checkout, after committing all work on the worktree branch, run:

```bash
caws worktree merge <name>            # readiness check first: caws worktree merge <name> --dry-run
```

This is one governed transaction: it checks ownership + clean-tree + binding prerequisites, computes and lands the merge with a `merge(worktree): <name>` message, **auto-closes the bound spec** (`spec_closed`), appends `worktree_merged`, and **deletes the merged branch** — over the v11 flat-map `worktrees.json`. The merge also de-registers the worktree, so a follow-up `caws worktree destroy <name>` reporting "not found in registry" is the expected success signal, not an error.

### Why it is safe to merge while other agents are working

**The merge never checks out the base branch.** Checking out the base would mutate the canonical working tree's HEAD — a resource every concurrent agent shares. Instead the merge happens entirely in the object database:

```
git merge-tree --write-tree <base> <branch>   # merged tree; no working tree, no index, no HEAD
git commit-tree <tree> -p <base> -p <branch>  # the merge commit object
git update-ref refs/heads/<base> <new> <old>  # ATOMIC compare-and-swap
```

The third step is the only instant at which the merge becomes real. Passing the base SHA the merge was computed against makes it a compare-and-swap: if another agent advanced the base in between, **git itself refuses** ("is at X but expected Y") and nothing is written.

This is stronger than a lock. There is no blocking, no deadlock, no stale-lock recovery, and it stays correct across processes, containers, and machines — including when a human or CI moves the ref. It is also crash-safe by construction: the objects written before the CAS are unreferenced, so an interrupted merge is invisible rather than half-applied.

**Losing the race is normal, not an error.** The merge re-reads the base, recomputes, and retries (bounded at 5 attempts). Only a genuine conflict or an exhausted retry budget surfaces as a failure, and the diagnostic says which — contention names the base branch and the retry command; a conflict names the conflicting paths and leaves the working tree clean.

**Branch deletion uses `git branch -d`, never `-D`.** After a successful CAS the branch is provably an ancestor of the new base, so `-d` cannot lose work. If `-d` ever refuses, the merge still reports success (it completed) and warns with git's own reason plus the commands to reconcile.

**Manual fallback (only if the governed command genuinely cannot be used):**

1. Switch to the base branch: `git checkout main` (be aware this bare checkout can trip the danger latch, and mutates the working tree every other agent shares).
2. Merge with: `git merge --no-ff <worktree-branch>`
3. The commit-msg hook enforces the `merge(worktree): <description>` format for non-FF merges.
4. For manual merge commits: `git commit -m "merge(worktree): integrate scenarios work"`
5. Then destroy the now-merged worktree: `caws worktree destroy <name>`, and delete the branch: `git branch -d <branch>`.

The manual path reintroduces the concurrency hazard the governed command removes — it is a last resort, not an equivalent. (The `WORKTREE-MERGE-V11-SHAPE-001` registry-shape crash that once forced this fallback is fixed; the governed command reads the flat-map registry natively.)

## Virtual environment in worktrees

Do NOT create a new virtual environment in your worktree. Use the main repo's venv:

```bash
source <main-repo-path>/.venv/bin/activate
```

If your project uses `.caws/scope.json`, the `designatedVenvPath` field specifies the correct venv location.

## When your work is done

1. Commit all changes to your worktree branch
2. Run tests in your worktree to verify
3. Merge with the governed path: `caws worktree merge <name>` (checks prerequisites, lands the merge via compare-and-swap without checking out the base, auto-closes the bound spec, appends `worktree_merged`, and deletes the merged branch). Use `--dry-run` first to confirm readiness.
4. Destroy the now-merged worktree: `caws worktree destroy <name>` — "not found in registry" here means the merge already de-registered it, which is success.

The branch is deleted for you in step 3; there is no separate `git branch -d`.

(Manual fallback only if the governed command cannot be used: `git checkout main && git merge --no-ff <branch>` in the `merge(worktree):` format, then `caws worktree destroy <name>` and `git branch -d <branch>` — but be aware the bare `git checkout main` can trip the danger latch AND mutates the working tree shared by every other agent.)
