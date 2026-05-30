# Task: Multi-agent contention seam-finding (CAWS coordination)

You are starting with fresh context. Run this **after** the single-agent baseline probe
(`user_e2e_setup_rehearsal_001_kit.md`) — that probe characterizes the guard's *decision
model*; this one characterizes the *coordination machinery* under genuine contention.

Your job is **not** to build software and **not** to make multiple agents cooperate. It
is to **find the seams where CAWS coordination breaks when agents clash** — overlapping
scope claims, racing the lease registry, one agent seeing another's uncommitted state,
abandoned agents leaving ghost leases. This is pre-release adversarial testing in a
sandbox: surface the coordination breaks *here* so they don't surface in a real
multi-agent consumer repo. You are deliberately steering toward contention, not away
from it.

## Where you are running (read this first)

You have been launched **inside** the clash-probe repo — your current working directory is
the disposable test project the human created for you (e.g.
`~/Desktop/Projects/caws-opera/caws-clash-probe/`). This matters: because you are rooted here, *this
repo's* `.claude/settings.json` is your **live hook chain**, and any subagents you spawn
inherit (or contend over) the same repo state. Your tool calls — and theirs — pass through
the real CAWS hooks. That is the point: the contention is real, recorded from what your
harness actually shows you and your subagents.

Confirm before anything else: `pwd` and `git rev-parse --show-toplevel`. If you are **not**
inside the clash-probe repo (you're in `caws`, `sterling`, or bare `Projects/`), **stop and
report** — wrong root invalidates the probe. The hook chain is fixed at launch, not by
`cd`.

## Method — this is non-negotiable

**All contention must be produced by real work through real tools — yours and your
subagents'.** A valid contention event is: a real Write / Edit / Bash / `caws` tool call
(by you or a subagent) clashed with another agent's real claim or state, and a hook or the
CLI blocked, challenged, or mis-resolved it. The message you record is the one the
**harness actually showed**, verbatim.

**Forbidden — these produce worthless signal:**
- Do **not** hand-feed synthetic payloads into guard scripts (e.g.
  `printf '...' | bash .claude/hooks/scope-guard.sh`). Out-of-band script invocation cannot
  reveal lease races, cross-agent state bleed, or double-block deadlocks — the very things
  this brief tests. If you catch yourself piping a fabricated `tool_input` into a hook,
  **stop**.
- Do **not** simulate a "clash" by narrating what two agents *would* do. Spawn real
  subagents (or, per the Phase 0 fallback, drive a second real session) and make them issue
  real, conflicting tool calls.
- Do **not** read hook/CLI source to *predict* a contention outcome and write it up as
  observed. Reading to understand a clash you already triggered is fine; substituting
  static analysis for a live clash is not.

If you genuinely cannot manufacture real contention (e.g. subagents share one identity and
can't race each other, and no second session is available), that is the finding — **stop
and report it**, don't fabricate one.

## Authority and boundaries

- You may create and modify files freely **inside the clash-probe repo** (your CWD) and
  its worktrees. It is disposable.
- **Do not modify** the existing repos `sterling`, `caws`, or `surgery-ward`. Reading is
  fine (spec reference); no edits/commits/`caws` state changes there.
- **Verify the CLI:** the human has installed the current CLI globally from the dist
  build — run `caws --version`, expect **11.1.8**. If missing or different, stop and tell
  the human; do not rebuild or `npm link` inside `caws` yourself.

## Setup

The human has already created the clash-probe repo and launched you inside it. Bring it to
a testable state:

1. If the repo has no commits, make one (`touch README.md && git add README.md && git
   commit -m "chore: initial commit"`), then run `caws init` in your CWD. Confirm the
   danger-latch, worktree-write-guard, and block-dangerous handlers are live in
   `.claude/settings.json` — and remember that *present* ≠ *active on your session*; the
   real proof is the first live block in Phase 1. If tool calls sail through where a block
   was expected, that's a finding (hooks not wired), not a license to simulate.

## Phase 0 — Characterize subagent identity (do this FIRST; everything depends on it)

Before any clash, answer the question the rest of the test hinges on: **when you spawn
subagents via the Task/Agent tool, what identity do they carry?**

1. Spawn two trivial subagents (e.g. each runs `echo $CLAUDE_SESSION_ID 2>/dev/null;
   caws agents list; pwd`). Capture:
   - Do they share the **parent's session ID**, or get their own?
   - Does `caws agents list` show one lease, two, or none for them?
   - Do they share the parent's CWD / worktree, or get isolated ones?
2. Record the answer explicitly. It determines what the clash actually tests:
   - **If subagents share one session ID/lease:** a "clash" between two subagents is an
     *intra-session* race — two writers under one lease. The guard sees one agent. That
     is itself a finding (the worktree model assumes one-agent-per-lease; subagents
     violate that assumption silently).
   - **If subagents get distinct IDs/leases:** you can stage true inter-agent
     contention, which is what the worktree isolation model is designed for.
3. **Decision gate:** if subagents share one identity and you cannot produce genuine
   inter-agent contention with them, say so in the log and note that the fallback
   mechanism (two independent Claude Code sessions in the same repo) is required to test
   inter-agent seams. Do not fake distinct identities. Characterizing the limit is a
   valid result.

## Phase 1 — Seek the coordination seams

Drive toward each of these deliberately. For every one, record what *should* happen
under the worktree-isolation model vs. what *actually* happens.

1. **Overlapping scope claim.** Two agents create specs whose `scope.in` overlaps the
   same files. Both try to edit a shared file. Does the guard block the second? Does it
   block *both*? Does it block *neither* (union-mode fallback)? Does the block name the
   right owner?
2. **Lease registry race.** Two agents create/bind worktrees near-simultaneously. Does
   `caws agents list` / the registry end up consistent, or are there duplicate / missing
   / half-written entries?
3. **Cross-agent uncommitted-state bleed.** Agent A edits a file on a shared branch;
   agent B runs `git status` and sees A's unstaged changes. Does B's guard mistake them
   for its own? Does B try to stash/checkpoint/explain work it didn't do? (This is the
   exact failure the worktree-isolation doctrine exists to prevent — verify it's
   actually prevented.)
4. **Ghost lease (A5).** Start an agent with a registered active lease, then **abandon /
   kill it mid-claim** (e.g. terminate the subagent or session before it commits).
   Confirm a lease with status `active` but a dead PID now exists. Then: does
   `caws agents prune --dead` reap it? Does the next write get blocked by the ghost?
5. **Session-stop unregister (A6).** Let an agent reach a normal stop/SessionEnd. Does
   the Stop hook (`agent-stop.sh`) unregister its lease, or does it linger?
6. **Wedge attempt.** Can two clashing agents put the repo into a state where *neither*
   can proceed without modifying a forbidden repo or disabling a hook? (e.g. one trips
   the danger latch, blocking the other; both blocked on each other's worktrees.) A
   reachable wedge is a high-value finding.

## Recording rules

- A block that takes N steps to escape is N data points. Record every clear/escape and
  whether escaping one re-tripped another (double-block / cascading deadlock).
- After recording, you may clear latches
  (`.claude/hooks/reset-danger-latch.sh --all --reason "<why safe>"`) and take documented
  escape paths to continue, so you capture the *full* contention sequence.
- Manufacturing ghost leases (item 4) is in-scope here — unlike probe 001, you are
  *meant* to seed stale state to test the reaping/unregister machinery.

## Deliverable

Write to `CLASH-LOG.md` **at the root of the clash-probe repo** (your CWD). Do **not**
write into the `caws` repo.

**Recording discipline:** record as you go, appending to `CLASH-LOG.md` directly — do not
spray intermediate scratch files (`_ref.txt`, `_out.txt`, etc.) across the repo. If you
must capture long output, use a single `.probe-scratch/` dir and delete it before
finishing. `CLASH-LOG.md` should be the only new artifact at the repo root when you stop.
Note that subagents writing their own scratch files is the same hazard at higher volume —
have them return findings to you, not litter the tree.

Lead with the **Phase 0 identity finding** — it frames everything else. Then, for every
contention event:

| Field | What to capture |
|---|---|
| Seam | Which Phase-1 item (overlapping scope / lease race / state bleed / ghost lease / session-stop / wedge) |
| Setup | The exact sequence that produced the contention |
| Expected | What the worktree-isolation model says *should* happen |
| Actual | What actually happened (verbatim messages, registry state, who-blocked-whom) |
| Verdict | seam-confirmed (broke) / held-correctly / ambiguous |
| AC | Spec AC(s) witnessed (A1 correct-block, A2/A3 should-ask, A5 ghost-lease, A6 unregister, A7 composite-risk) |
| Fix category | relax pattern / surface risk + ask / unregister stale state / prune dead lease / better error message / **coordination defect** |

Tag `AC: NONE — possible scope gap` for any seam the spec doesn't cover. Those are the
highest-value findings: a coordination break with no AC means
`WORKTREE-GUARD-RISK-SURFACE-001` is underscoped.

## Handoff: copy-paste block for the caws-repo agent

You run **outside** the caws repo and cannot file specs/commits there. End `CLASH-LOG.md`
with a fenced code block a caws agent can paste into spec
`WORKTREE-GUARD-RISK-SURFACE-001`'s working notes. One line per witnessed AC:
`A<n>: <seam-confirmed / held-correctly / scope-gap> — <evidence pointer to event #>`.
End with a one-line recommended next action (e.g. "A5 reproduced by event #4: ghost
lease survived until manual `prune --dead`; session-stop (A6) did NOT unregister —
implement agent-stop.sh unregister + ship prune --dead in the slice. Subagents share one
session ID (Phase 0), so worktree model's one-agent-per-lease assumption is violated —
possible scope gap, no AC covers it").

Do not invent witnesses you didn't hit. "Subagents share identity, so true inter-agent
contention requires the two-session fallback — not run this pass" is a valid, useful
result. Say it plainly.

## Cleanup

This repo is disposable. When done, the orchestrating human may `rm -rf
~/Desktop/Projects/caws-opera/caws-clash-probe/`. If you abandoned/killed agents in Phase 1, note
any leases you could **not** reap so cleanup is complete — do not leave the host's
`caws agents list` polluted with leases pointing at the deleted repo.

## What this feeds

caws spec **WORKTREE-GUARD-RISK-SURFACE-001** — specifically the coordination ACs
(A5 ghost-lease prune, A6 session-stop unregister) and the worktree-isolation guarantees
the single-agent probe cannot exercise. Your clash log is the contention-side
falsification corpus: it proves whether coordination survives genuine multi-agent
pressure, or names exactly where it breaks.
