# ADR 0002 — Provenance Commit Shape: bookkeeping commit volume is an accepted operating cost

- **Status:** Accepted
- **Date:** 2026-10-07
- **Spec:** `CAWS-ADR-PROVENANCE-COMMIT-SHAPE-001`
- **Decision class:** Cost Acceptance Record. Extends the ADR convention
  established by [ADR 0001](0001-multi-agent-push-range-guard.md): ADRs record
  load-bearing decisions so the reasoning cannot silently bake in a wrong
  choice, and a change to an answer is an ADR amendment, not a quiet code edit.
  This ADR applies that convention to a cost that was measured and deliberately
  accepted, so that a future "why is the history like this?" lands on the
  recorded reasoning instead of a fresh re-derivation.

---

## Context

CAWS governs agents by committing governed state. Every successful spec/worktree
lifecycle transaction ends with an auto-commit of the files it wrote, under the
subject prefix `chore(caws):` (`CAWS_BOOKKEEPING_SUBJECT_PREFIX`,
`packages/caws-cli/src/store/git-autocommit.ts`), and every governed worktree
merge lands a `merge(worktree): <name>` commit
(`packages/caws-cli/src/store/worktrees-writer.ts`). The consequence is visible
in the history of every repo that runs CAWS seriously.

**Measured basis** (snapshot 2026-10-07 09:37 PDT, commits reachable from `main`
HEAD; counting method: commit subjects matching the two tooling families above):

| Repo          | Total commits | CAWS-attributed | Share | Bookkeeping on first-parent spine |
| ------------- | ------------: | --------------: | ----: | --------------------------------: |
| sterling      |        55,936 |          38,865 | 69.5% |             89% (38,566 / 43,252) |
| RC            |         1,207 |             840 | 69.6% |                   93% (810 / 867) |
| caws          |         6,864 |           4,810 | 70.1% |               84% (4,652 / 5,548) |
| full-stack-ds |         6,544 |           4,696 | 71.8% |               91% (4,507 / 4,961) |

Measurement notes, recorded so the numbers can be re-derived or discounted:

- The `chore(caws):` family covers the auto-commit verbs (`create`, `activate`,
  `deactivate`, `close`, `archive`, `amend-scope`, `amend`, `restore`, `reopen`,
  `evidence`, `retire-draft`, `bind`, `destroy`, `untrack`) plus the named
  shapes (`close <spec> post-merge of <lane>`,
  `commit pending audit state for <id>`, `port hook`, `relocate`). A minority of
  `chore(caws):` subjects are hand-typed agent/human work in the same
  convention, not tool output (~2,518 of sterling's, ~41 of RC's, ~350 of this
  repo's, ~157 of full-stack-ds's). They are not separable by author: agent
  commits land under the maintainer's git identity by design.
- sterling gained commits during measurement (55,933 → 55,936); treat all
  figures as a point-in-time snapshot, not an invariant.
- "First-parent spine" is canonical `main`'s own history. The spec lifecycle
  mostly runs in the canonical checkout, and each merge adds its auto-close on
  the base, so the spine — not the lane side-branches — carries most of the
  bookkeeping.
- What the volume does **not** touch: the auto-commit utility stages only the
  exact governed paths a writer touched (`git-autocommit.ts` — "Must be the
  exact set the writer wrote. Other dirty files will NOT be staged"). Every
  bookkeeping commit touches only `.caws/specs/`, `.caws/worktrees.json`, and
  sibling governed-state paths. `git log -- <source path>`, `git blame`, and
  `git log -S` on source files are clean by construction and always have been.
  The noise is the ledger's own audit trail, concentrated in whole-repo log
  views.

## Decision

Keep the shape. Three coupled commitments, each with the mechanism that makes
the popular alternative worse:

### D1 — Per-transaction durability commits stay

Every successful lifecycle transaction commits its governed-state change as its
final step. The commit **is** the crash protocol: the durability barrier that
makes each transaction recoverable and makes dirty governed state a transient
condition instead of a resting state. The `worktree destroy`-refuses-its-own-
audit-commit incident (see the autocommit helper commentary in
`packages/caws-cli/src/store/specs-writer.ts`, "Auto-commit helper") is the
fossil of the alternative: without the autocommit, a dirty spec YAML poisons the
_next_ writer's pre-write capture and strands two transactions in a
contradictory shape.

_Rejected alternative — batching/deferring bookkeeping commits_ (session-end or
periodic flush): widens the dirty window the entire write discipline is built to
exclude, and converts single-transaction crashes into multi-transaction losses.
Rejected on durability, not preference.

### D2 — Merge commits keep lane parents (no squash)

`merge(worktree)` commits the merged tree with both parents so `git blame` and
provenance follow work commits to their origin. Git's ancestry couples three
properties — per-transaction durability, work-commit attribution, and history
noise — and offers no carve-out that drops the third without dropping one of the
first two: a squash-merge (lane parent dropped) destroys source-line attribution
along with the noise; carving middle commits out of a parent chain requires
rewriting the work commits above them, which invalidates every evidence receipt
that cites a SHA and is precisely the operation the danger latch exists to
prevent.

_Rejected alternatives — squash-merge at the governed boundary; history
compaction/rewrite:_ rejected on attribution and audit-integrity grounds
respectively.

### D3 — The event ledger stays untracked

`.caws/events.jsonl` (hash-chained, one event per lifecycle transaction) is a
per-machine journal and stays gitignored, the same tier line as
`.caws/sessions/` and `.caws/leases/`. Committing it fails three ways:

1. **Conflict geometry.** Committed governed state merges cleanly because it is
   path-partitioned per spec; the auto-commit stages only the disjoint files a
   writer touched. A single-headed append-only log is one shared hot file at
   whose head every lane in every transaction appends. Committing it converts
   the merge CAS's "lost race = retry and recompute" into "lost race = human
   resolves a machine-format JSONL."
2. **Non-convergent semantics.** Two machines' hash chains encode two total
   orders; unioning them requires re-chaining, which mints new hashes and
   destroys the tamper-evidence that would have justified committing the log. A
   mergeable tamper-evident append-only log _is_ a git history — git already
   fills that role. The journals diverge across machines by design; forcing
   convergence is a category error.
3. **Redundancy with the committed authority.** The governance-relevant
   narrative — per-criterion evidence, closure notes, scope amendments — lives
   in `.caws/specs/<id>.yaml`, and the auto-commit stages exactly that file. A
   fresh clone carries the evidence narrative for everything that matters to
   governance. What exists only in the untracked layer is the operational
   journal (leases, sessions, message traffic, receipts): hot, machine-local
   state that should not travel.

_Rejected alternatives — committing the event chain; a committed chain-head
anchor file (single `.caws/events.head`):_ the anchor inherits the same
shared-hot-file conflict geometry as the chain, and a per-spec partition buys
nothing because the spec YAML commits already pin the content at every
transition.

### D4 — The read path, not the write path, absorbs the felt cost

Because path-scoped views are already clean by construction, the remedy surface
for whole-history questions is presentation (structured rendering from the event
chain, documented git filters), not representation. Building such a surface is
named as a follow-up, not mandated here, and its absence does not reopen this
decision.

## Maintainer rationale (2026-10-07)

> "The scope amendments, evidence recording, criteria changes. The spec keeps an
> agent fairly honest about when things that were assumed needed to be changed.
> Dirty state is something agents hate, and so the auto commit with the direct
> line of attribution was what keeps the agent from clobbering the work. So,
> maybe we're fine with this shape."

The attribution line is the feature. Each amendment, each evidence record, and
each closure is individually attributed and individually reversible; the commit
volume is the audit trail being honest about how much governed decision-making
happens.

## Accepted costs

- ~70% of whole-repo commit volume is bookkeeping in every active CAWS repo
  (69.5%–71.8% measured); the canonical spine reads 84–93% bookkeeping in
  whole-log views.
- Commit count grows linearly with agent work volume (not compounding); pack
  impact is small because bookkeeping commits touch tiny YAML files.
- Whole-repo `git log` is an archaeology view that must be filtered
  (`--grep -v '^chore(caws):'` or path scoping); agents and humans who read it
  unfiltered will see mostly bookkeeping. That is the accepted shape, not drift
  to fix.

## Revisit triggers (what would reopen this decision)

Reopening is an ADR amendment (a superseding ADR), never a quiet writer change.
Named triggers, each requiring a measurement or concrete incident, not a count:

- **Measured harm in a log-dependent workflow** — a named tool or process whose
  latency or correctness degrades demonstrably from commit volume.
- **Pack/clone growth attributable to ledger commits becoming material** at
  scale (order-of-magnitude above today's measured footprint).
- **Cross-machine operational forensics becomes a real need** — reconstruction
  of worktree/message/lease archaeology after disk loss that the committed
  registry, spec, and lease-state history cannot answer.
- **A shared runtime store emerges** (a service owning `.caws` state across
  machines), changing the transport calculus so per-transaction git commits
  could demote to anchors. (Speculative today; no such store is planned.)

## Consequences

- Runtime writers must not "optimize" the commit away: the per-transaction
  auto-commit is the durability contract (D1), and commit granularity is an
  ADR-level decision.
- New lifecycle writers must emit the bookkeeping subject prefix and stage only
  their governed paths, so the counting method above and the forged-commit shape
  check (`CAWS_BOOKKEEPING_SUBJECT_PREFIX` + governed path set,
  `git-autocommit.ts`) stay valid.
- Whole-history readability work (D4) may proceed at any time without touching
  this decision.

## References

- [ADR 0001 — Multi-Agent Push-Range Guard](0001-multi-agent-push-range-guard.md)
  (ADR convention).
- `packages/caws-cli/src/store/git-autocommit.ts` — bookkeeping subject prefix,
  path-scoped staging, governed-path shape check.
- `packages/caws-cli/src/store/specs-writer.ts` — spec lifecycle auto-commit
  helper and the dirty-state incident that motivated it.
- `packages/caws-cli/src/store/worktrees-writer.ts` — `merge(worktree)` commit
  subject and the CAS merge that never checks out the base.
