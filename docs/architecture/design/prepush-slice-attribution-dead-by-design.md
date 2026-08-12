# Prepush slice-attribution is dead by design in a fully-utilized CAWS repo

Status: **design verdict — resolved as Option C** (`CAWS-REMOVE-PREPUSH-COMMAND-001`).
Option B was implemented first (`CAWS-PREPUSH-PROVENANCE-REWORK-001`) and fixed
the commit-attribution predicate, but left two conditions that reproduce the
same non-convergence: a live peer worktree escalates to ERROR by construction
with no acknowledgment path, and the check's own O(commits) serial-spawn
runtime exceeded the inter-arrival time of the commits it classifies. `caws
prepush` is removed; the provenance teeth remain at the merge boundary.
Author: kimi-code session, canonical checkout, 2026-08-11.
Scope: `caws prepush`'s refusal semantics (MULTI-AGENT-PUSH-RANGE-GUARD-001),
NOT its classification/report engine, which is sound and worth keeping.

## Verdict

The slice-attribution refusal model — "refuse outgoing commits not
attributable to the current slice, unless each is acknowledged with `--ack`"
— cannot work in a repository that fully utilizes CAWS. Not "is calibrated
wrong": is structurally incompatible with the architecture v11 itself
mandates (concurrent worktree lanes merging onto a shared local trunk via
CAS, CLI-generated governance commits, session-keyed ownership that outlives
sessions). The classification engine underneath is good observability and
should be preserved; the refusal predicate and the ephemeral-ack mechanism
should not.

## Evidence (live dogfood, this repo, 2026-08-11)

All of the following was observed in one session on `caws` main:

1. **The normal push is the refused push.** A 24-commit outgoing range
   (`origin/main..HEAD`) produced by three governed worktree merges plus
   spec lifecycle was classified 100% UNEXPECTED/AMBIGUOUS. The push runs
   from canonical `main`, which is bound to no spec and no worktree — so
   there is no "current slice," and *every* commit is unattributable by
   construction. The guard's default fires on the only push workflow v11's
   architecture actually produces.

2. **The target moved mid-ack.** While the operator was assembling
   `--ack` flags for the 24 SHAs, a second live agent landed
   `9622a3e8 chore(caws): create CAWS-DEFECT-CLI-ERROR-PATH-FIXES-01`
   between two `prepush` runs. Acks are ephemeral per-invocation CLI flags,
   so acknowledging is O(entire range) per attempt with zero carry-over.
   For convergence, operator review+ack time must beat the inter-arrival
   time of the next lane's merge. Operator-reported sterling numbers (not
   independently verified here): 249 commits in ~17.5h, median interval
   34s, 35 merges, 4+ concurrent agents. Against that arrival rate a manual
   full-range ack loop is queueing-unstable: it cannot converge, only be
   retried.

3. **A third of the range is the tool's own bookkeeping.** 17 of 24
   commits were `chore(caws)` spec-lifecycle commits (create / bind /
   amend-scope / reopen / close / refine) — authored by the CLI, not by any
   agent, and attributable to a now-*closed* spec. Any real spec effort
   accumulates this tail; it is a permanent reconciliation burden, not an
   exception path.

4. **Ghost residue is treated as publish-relevant state.**
   `wt-merge-notes` surfaced as a foreign-worktree WARN: owned by a dead
   session, bound to a closed spec, its branch already fully merged into
   main (`main..wt-merge-notes` empty). Destroying it required a
   `--takeover` of a corpse. `caws status` the same day showed STALE
   sessions 7 days old still registered. Ownership is session-keyed;
   sessions die; the registry accumulates ghosts; prepush reports ghosts
   alongside real findings.

5. **The ack mechanism silently fails on natural input.** `--ack <sha>`
   exact-matches against `sha.slice(0, 12)` (`prepush.ts:248`), so the
   full 40-char SHAs that `git rev-list` — the operator's obvious source —
   outputs are *silently ignored*: the refusal reprints with everything
   still "unacknowledged" and no hint why. Repeatable-flag behavior with
   multiple `--ack` flags also failed to acknowledge in dogfooding
   (single-flag works). These are implementation bugs, but they compound
   the design fault: the escape hatch itself resists use.

6. **Attribution heuristics are too lossy to review against.** A
   hook-pack sync commit was pinned to `CAWS-SESSION-LOG-QWEN-001` via
   `file_touch` (wrong spec, right files); zero-file object-db merges are
   AMBIGUOUS; cross-cutting implementation commits attribute to 10–11
   specs at once. Faced with a 24–249 SHA list classified this noisily,
   the operator's only viable move is bulk `--ack`. A guard whose realistic
   use is rubber-stamping produces compliance theater, not assurance — and
   trains operators to click through the *next* refusal too.

## The structural faults

1. **Wrong predicate.** Prepush asks "is this commit attributable to the
   *pushing* session's slice?" v11 abolished the workflow where that
   question has an answer: `caws worktree merge` lands lanes directly onto
   local trunk with bounded CAS retry ("losing that race is normal, not an
   error" — AGENTS.md), and there is no per-slice remote push. The only
   push that exists is trunk-publish, where the pusher is never the author
   of the range. The right predicate is commit *provenance* (was this
   commit produced inside governance?), not *attribution to self*.

2. **Non-convergent retry.** Ephemeral, full-range, manual acks versus a
   trunk advancing at multi-agent merge cadence. See Evidence 2.

3. **Conflated refusal classes.** Unattributed commits, foreign-worktree
   presence, and unmerged-branch origin are three distinct facts needing
   three distinct resolutions, reported in one bucket under one refusal.

4. **Guard-stack contradiction (sterling, operator-reported).** In
   sterling's configuration the worktree guards prevent agents from
   pushing at all while any worktree is active, so the only possible push
   is a canonical human publish — the exact context where slice
   attribution misfires. The guard stack's permitted-push set is the empty
   intersection of its layers. (Verified locally: this repo's *shared*
   hook guards contain no `git push` block; the push-impossibility is a
   property of sterling's guard configuration and is cited here as
   operator-reported.)

## What survives

- **The classification/report engine** (per-commit spec attribution,
  origin-worktree detection, dirty-state overlay) is good observability.
  Demoted to advisory output, it is genuinely useful at publish time.
- **Unvetted-direct-commit detection.** The supply-chain risk actually
  worth a human boundary is a commit landing on trunk that governance
  never touched — not a commit authored by a *different governed lane*.
- **ERROR-severity foreign-worktree detection**, once pruned by the
  agents-liveness substrate so ghost registrations don't page a human.

## Replacement direction

The provenance record already exists: `events.jsonl`. Every governed
landing emits `worktree_merged` / spec-lifecycle events; CLI bookkeeping
commits are recognizable by shape. A trunk-appropriate check inverts the
predicate:

- For each outgoing commit: produced by a governed merge event, or
  recognizable CLI governance bookkeeping, or **a direct-on-trunk commit
  governance never touched**. Refuse only the third class (plus
  ERROR-severity foreign worktrees after liveness pruning).
- If acknowledgments remain, make them persistent and incremental (keyed
  by SHA in `.caws/` state), so a moving trunk means acknowledging the
  *delta* since last pass — an O(delta) operation that can converge.
- Distinguish **publish** (origin behind local trunk; commits already
  vetted by their lanes) from **ship** (this session's own slice is in the
  range). Prepush today only models the second; the first is the only one
  that occurs.

## Options for the doctrine decision

The doctrine doc owns the v11 command surface; this doc is the evidence
base. The options:

- **A. Demote to advisory.** Prepush keeps its report, exits 0 with
  warnings unless it finds an ungoverned direct commit or an
  ERROR-severity foreign worktree. Smallest change; keeps the observability
  value; removes the theater.
- **B. Rework around ledger provenance.** Implement the events-ledger
  check and persistent acks above. Larger change; makes the guard real
  instead of removed.
- **C. Remove from the surface.** If neither A nor B is funded, removal
  beats a guard whose only honest outcome in a fully-utilized repo is a
  bulk-ack ritual.

Also worth fixing regardless (observed in Evidence 5): prefix-tolerant
`--ack` matching and the repeatable-flag behavior in `prepush.ts`.
