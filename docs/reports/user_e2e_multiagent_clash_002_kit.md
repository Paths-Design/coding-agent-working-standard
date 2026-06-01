# Task: Multi-agent contention friction probe (CAWS coordination)

You are testing how CAWS coordination behaves when **more than one agent works the same
repo at once**. Your job is **not** to ship software and **not** to make agents cooperate
— it is to drive genuine contention between agents and **record where CAWS coordination
resists, breaks, or behaves surprisingly**, as a structured log.

Report only what *actually happens* from real tool calls. Do not assume, predict, or
reproduce any particular failure — there is no script of expected problems. A clean run
that finds nothing is a valid, useful result. So is one that uncovers a real seam.

Run this **after** the single-agent probe (`user_e2e_setup_rehearsal_001_kit.md`) — that
one covers a lone agent's experience; this one is specifically about *contention between
agents*.

## Where you are running (read first)

You have been launched **inside** the disposable clash-probe repo. Because you are rooted
here, *this repo's* `.claude/settings.json` is your **live hook chain**, and any subagents
you spawn (or sibling sessions the operator starts) contend over the same repo state.
Your tool calls — and theirs — pass through the real CAWS hooks.

Confirm before anything else: `pwd` and `git rev-parse --show-toplevel`. If you are not
inside the clash-probe repo, **stop and report** — wrong root invalidates the probe.

## Method — non-negotiable

**All contention must be produced by real work through real tools — yours and any
subagents'.** A valid event is: a real Write / Edit / Bash / `caws` call (by you or a
subagent) clashed with another agent's real claim or state, and something resisted,
mis-resolved, or behaved surprisingly. Record the verbatim message the harness showed.

**Forbidden:**
- Do **not** hand-feed payloads into hook scripts. Out-of-band invocation can't reveal
  lease races, cross-agent state bleed, or coordination breaks — the very things this
  probe is about. If you catch yourself doing it, **stop**.
- Do **not** simulate a clash by narrating what two agents *would* do. Spawn real
  subagents (or, per Phase 0, drive a real second session) issuing real conflicting calls.
- Do **not** read source to predict an outcome and write it up as observed.

If you genuinely cannot manufacture real contention, that is the finding — **stop and
report it**, don't fabricate one.

## Setup

The repo and your session were prepared by the operator (git init + `caws init
--agent-surface claude-code` + any hook activation). Confirm you are governed: verify the
hook pack is wired and active for this session (the proof is your first real tool call
being seen by a hook). If tool calls sail through when you'd expect governance, that's a
finding — report it.

> **Operator note (not a task for the agent):** repo creation and the git/caws init steps
> are currently human-owned. An open improvement is to drive them (and any session
> restart hook activation requires) without a human in the loop so the probe runs
> unattended. Until then the operator sets up; the agent records the experience.

## Phase 0 — Characterize agent identity (do this FIRST; everything hinges on it)

Before any clash, answer the question the rest depends on: **when you spawn subagents via
the Task/Agent tool, what identity do they carry?**

1. Spawn two trivial subagents (each runs e.g. `echo "$CLAUDE_SESSION_ID"; caws agents
   list; pwd`). Capture: do they share the parent's session id, or get their own? Does
   `caws agents list` show one entry, two, or none? Do they share the parent's CWD /
   worktree, or get isolated ones?
2. Record the answer plainly — it determines what a "clash" even means here:
   - **If subagents share one identity/lease:** a clash between two subagents is an
     *intra-session* race (two writers under one lease; the guard sees one agent). That is
     itself a finding — note it.
   - **If subagents get distinct identities:** you can stage genuine inter-agent
     contention.
3. **If you cannot produce real inter-agent contention with subagents** (they share one
   identity and no second session is available), say so explicitly and note that the
   fallback is two independent sessions in the same repo. Characterizing the limit is a
   valid result; do not fake distinct identities.

## Phase 1 — Drive contention and record what happens

Steer toward genuine contention between agents and record CAWS's behavior at each point.
You do not need to hit all of these; pursue the ones your Phase-0 identity finding makes
reachable. For each, note what *should* happen under worktree isolation vs. what actually
does.

- **Overlapping scope.** Two agents create specs whose `scope.in` overlaps the same files,
  each in its own worktree, and both edit the shared file. What does each agent's guard
  do? Does the right owner get named? When a guard names the owner, note that the refusal
  now leads with `CAWS worktree-write-guard` and tells you your **session** (not just a
  shell `cd`) must be rooted in the owning worktree — record whether that wording is clear.
  - **`scope.support` is a deliberate NON-claiming surface (new — exercise the distinction).**
    A path in a spec's `scope.support` is editable like `scope.in` but **never establishes a
    worktree claim**. So two agents both listing the same file in `scope.support` is *not* a
    claim-clash (the worktree-write-guard will not hard-block on it), whereas a `scope.in`
    overlap is. Stage both and record the difference: a `scope.in` overlap should produce a
    `claimed:*` hard block from the non-owning checkout; a `scope.support` overlap should not.
    If `scope.support` ever produces a claim/hard-block, that is a high-value defect — the
    whole point of the class is that it does not claim.
- **Lease / registry race.** Two agents create or bind worktrees near-simultaneously. Does
  `caws agents list` / the registry stay consistent, or do entries duplicate / go missing
  / half-write?
- **Cross-agent state bleed.** Agent A leaves uncommitted changes; agent B observes them
  (e.g. `git status`) — does B mistake them for its own, or try to stash/checkpoint work
  it didn't do?
- **Abandoned agent.** One agent is killed / abandoned mid-claim before committing. What
  state does it leave (lease, worktree, branch)? Can it be cleaned up, and by what command?
- **Session stop.** An agent reaches a normal stop. Is its lease/registration cleaned up,
  or does it linger?
- **Mutual wedge.** Can two contending agents reach a state where *neither* can proceed
  without operator intervention? A reachable wedge is high-value — record exactly how.

## Recording

For every contention event:

| Field | What to capture |
|---|---|
| Setup | The exact sequence (which agent did what) that produced the contention |
| What happened | Verbatim messages, registry state, which agent was blocked/asked/admitted |
| Expected | What worktree-isolation / coordination *should* have done |
| Verdict | resisted-correctly / broke / surprising-but-survivable |
| Better behavior | What CAWS should do instead (or "this was correct") |

Lead the log with the **Phase 0 identity finding** — it frames everything after it.
Manufacturing an abandoned-agent / stale-lease state is in-scope here (unlike the
single-agent probe) — you are *meant* to stress the cleanup machinery.

## Deliverable

Write to `CLASH-LOG.md` at the repo root (your CWD). Record as you go; no scratch-file
spray. Subagents should return findings to you, not litter the tree. End with a synthesis:
which behaviors were correct coordination, which were real friction, and whether any
mutual wedge is reachable.

Do not pad. If contention mostly resolved cleanly, say so and report the few real events.
An honest short log beats a padded one.

## Cleanup

This repo is disposable. If you abandoned or killed agents, note any lease/worktree state
you could **not** clean up so the operator can finish — do not leave the host's
`caws agents list` polluted with entries pointing at a deleted repo.
