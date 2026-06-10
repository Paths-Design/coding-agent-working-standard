---
doc_id: agent-bash-mutation-scope-bypass
authority: design
status: proposed
title: Post-Bash scope check for core-source edits/deletes that route around the scope guard
owner: "@darianrosebrook"
spec: AGENT-BASH-MUTATION-SCOPE-BYPASS-001
created: 2026-06-10
audience: maintainer
---

# Post-Bash scope check (design, not yet built)

## Problem

The scope guard (`scope-guard.sh`) enforces a spec's `scope.in` at the **Edit/Write
tool boundary**. Bash is not that boundary. failure-lineage Entry 38 quantifies the
gap from 1,478 real sessions: agents apply the majority of their edits through
`sed -i` (88), `python … write_text()` (52), `cat >>` (23), and `cp`/`mv` into
governed trees (132) — all of which mutate tracked source while the scope guard
stays silent. The `bash-write-guard` exists but only matches a narrow set of
mutation *forms* statically; a looped `"$f"` target or a heredoc payload defeats it
(the same unbounded-paraphrase problem Entry 17 admits "no matcher can catch all of").

This is not primarily an evasion problem — it is the *default editing path*. But the
effect is identical to a deliberate bypass: a change to core source lands with no
scope authority consulted.

## Threat model (narrow, on purpose)

The thing worth protecting is **editing or deleting tracked source that is costly to
restore if something goes wrong** — production code, specs, hooks, config. Explicitly
NOT in scope:

- **Harmless scratch / dump files.** `/tmp/*`, `reports/`, fingerprint JSON, scratch
  probes, build artifacts. A thrashing agent writing dump files cannot meaningfully
  damage the repo or fill the disk in a way that matters; gating these is pure
  friction. The maintainer's stance: dumps are fine.
- **Reads.** Cross-repo and in-repo reads are never gated and must stay that way.
- **Untracked new files** outside governed trees. Creating a new scratch file is not
  the danger; overwriting or deleting *existing tracked source* is.

So the guard's job is: *did this Bash command edit or delete a tracked file that the
bound spec's `scope.in` does not admit?* — and only then intervene.

## Why a post-execution `git diff` check, not a better matcher

Parsing arbitrary shell to predict its write targets is the losing arms race
(Entry 17). The matcher-independent signal is **what actually changed on disk**, which
git already computes precisely. Two viable shapes:

### Option A — PostToolUse `git diff` reconciliation (recommended)

After a Bash tool call completes, in a `PostToolUse` hook:

1. `git status --porcelain` + `git diff --name-only` (and `--diff-filter=D` for
   deletes) over **tracked** paths only — ignore untracked, ignore `.gitignore`d.
2. For each changed tracked path, run the SAME scope decision the Edit guard uses
   (`caws scope check <path>` against the bound spec).
3. If a changed tracked path is NOT admitted → surface it. Because the change already
   landed (PostToolUse is after the fact), this is **detection + a forced
   acknowledgement**, not prevention: emit a blocking notice that names the
   out-of-scope file(s) and requires the agent to either revert them or amend scope
   before continuing. Pair with the strike counter so repeated out-of-scope Bash
   edits escalate exactly like Edit-tool strikes.

**Pros:** matcher-independent (gates on real diff, not command parsing); reuses the
existing scope decision; cannot be fooled by `sed -i "$f"` loops or heredocs because
it inspects the result, not the command. **Cons:** after-the-fact — the edit already
happened, so this is "you must reconcile" rather than "you cannot." For *core source*
that is acceptable: the change is in the working tree, uncommitted, fully revertible;
the guard's value is that it cannot be silently skipped.

### Option B — PreToolUse worktree snapshot + diff (heavier)

Snapshot tracked-file hashes before the Bash call, re-hash after, diff. Equivalent
signal to A but more machinery and a per-call cost; A is preferred unless we need
true prevention (we do not, for the costly-to-restore-source threat — the working
tree is recoverable).

## Boundaries this design must respect

- **Do not gate dumps/scratch/untracked.** Restrict to tracked, non-gitignored paths.
  This is the single most important calibration to avoid re-creating over-governance.
- **Do not gate reads or pure-stdout commands.** Only fire when the diff is non-empty
  over tracked source.
- **Reuse the kernel scope decision** (`caws scope check`) so the Bash path and the
  Edit path can never disagree — same authority, same `scope.in`.
- **Strike, don't hard-block on the first occurrence**, mirroring the Edit-tool scope
  guard's progressive model — except for cross-repo writes (already hard-blocked by
  CONTAINMENT-001) and deletes of tracked source, which warrant immediate escalation.
- **Cross-repo via `cd` is already partly handled** by CONTAINMENT-001 for Edit/Write,
  but a `cd /other && sed -i` still escapes it; the post-diff check run against the
  *current* repo will not see the foreign change, so a separate note: a cross-repo
  Bash mutation is detectable only by the target repo's own PostToolUse hook (which,
  if that repo is CAWS-governed, will fire). For a non-governed sibling there is no
  enforcement — which is correct: that repo opted out of CAWS.

## Open questions for implementation

1. **Performance.** `git status` + per-path `caws scope check` on every Bash call has
   a cost. Mitigation: only run the scope check when `git status` shows tracked
   changes (the common case is none); batch the scope decisions.
2. **Generated/committed-but-noise paths.** `dist/`, lockfiles, fingerprints — some
   are tracked but routinely rewritten. The `non_governed_zones` / ALLOW_PREFIXES
   list the scope guard already honors should be reused so these don't trip the check.
3. **Delete handling.** A `rm tracked/source.ts` is higher-severity than an edit
   (harder to notice, the file is gone). Treat tracked-source deletion outside scope
   as immediate escalation, not strike-1.
4. **Interaction with auto-commit.** CAWS lifecycle commands auto-commit; the
   post-diff check must run on the agent's Bash calls, not on CAWS's own commits
   (filter by whether the change is attributable to a lifecycle transaction).

## Status

Proposed. No code written. This document is the design surface for
`AGENT-BASH-MUTATION-SCOPE-BYPASS-001`; implementation is a separate, later spec so
the calibration (especially "tracked source only, not dumps") gets the deliberate
review it needs before it ships into the load-bearing guard pack.
