# Task: First-time-CAWS-user friction probe (single agent)

You are a competent engineering agent using CAWS for the first time in a fresh repo.
Your job is **not** to ship the software below — it is to do normal first-time work and
**record every point where CAWS resists, surprises, or misleads you**, as a structured
friction log. The CLI you're asked to build is *bait* to generate realistic activity; the
friction log is the deliverable.

Report what *actually happens to you*, from your own real tool calls. Do not assume,
predict, or reproduce any particular failure — there is no script of expected problems.
A clean run that hits nothing is a valid and useful result. So is a run that uncovers a
genuine seam. Either way, the value is in the honest record.

## Where you are running (read first)

You have been launched **inside** the probe repo — your current working directory is the
disposable test project. Because you are rooted here, *this repo's* `.claude/settings.json`
is your **live hook chain**: your own Write / Edit / Bash tool calls pass through the real
CAWS hooks. That is the point — you get governed for real, by your own actions, and you
record what happens.

Confirm before anything else: run `pwd` and `git rev-parse --show-toplevel`. If you are
**not** inside the probe repo (you're in a parent dir, or another repo), **stop and
report** — running from the wrong root invalidates the probe. The hook chain is fixed at
session launch; you cannot `cd` your way into it.

## Method — non-negotiable

**Every friction event must come from a real tool call you issued.** A valid event is:
*you* ran a Write / Edit / Bash / `caws` command to do a legitimate step of the task, and
something resisted, surprised, or misled you — a hook blocked or asked, a CLI rejected
you, an error message pointed you wrong, a documented step didn't work.

**Forbidden — these produce worthless signal:**
- Do **not** hand-feed payloads into the hook scripts (e.g. `printf … | bash
  .claude/hooks/…`). Invoking a hook out-of-band tests it in isolation and tells you
  nothing about your live session. If you catch yourself doing this, **stop**.
- Do **not** read hook/CLI source to *predict* what would happen and write that up as if
  it happened. Reading to *understand* something you already hit is fine; substituting
  static analysis for a live attempt is not.
- Do **not** simulate, narrate, or hypothesize friction. If you didn't hit it with a real
  tool call, it is not an event. "Did not encounter X" is a fine thing to report; an
  invented X is not.

If you genuinely cannot get governed at all (your tool calls sail through with zero hook
involvement when you'd expect otherwise), that is itself the finding — **stop and report
it**, do not fall back to simulating.

## Setup

The repo and your session were prepared by the operator. Bring the repo to a testable
state, doing each step as a real first-timer would and recording any friction:

1. **Git.** If the repo has no commits, make an initial one (`git init` if needed, then a
   `README.md` commit). Record any friction.
2. **CAWS.** Run `caws init --agent-surface claude-code` to install the hook pack. Then do
   whatever its output tells you is needed to make the hooks active for your session.
   Record exactly what you had to do and any friction along the way.
3. **Confirm you are governed.** Verify the hook pack is wired and active for *this*
   session. The real proof is your first real Write/Edit/Bash being seen by a hook (step
   5). If your tool calls sail through when you'd expect governance, that's a finding —
   report it, don't simulate.

   > **Operator note (not a task for the agent):** steps 1–2 are currently human-owned
   > setup moves (git init, caws init, and any session restart the hook activation
   > requires). An open improvement is to drive these without a human in the loop so the
   > probe can run unattended end-to-end. Until then the operator runs them; the agent
   > records the experience.

## The probe

4. Pursue this single goal as a first-time user, using the normal CAWS workflow you'd
   reach for without prior knowledge of this repo:

   > "Create a CLI that returns the most recent commits formatted in markdown and renders
   > them in the terminal UI."

   Create a spec, a worktree, implement, test. Do the obvious, legitimate things.

5. **When something resists you, characterize it — don't just stop.** Try the escape the
   tool/message points you to; see if it works; see if it leads somewhere worse. Record
   the command, what resisted, the verbatim message, whether your action was legitimate,
   what you did to get past it (or "could not"), and what a better behavior would be.

6. **Stop condition.** End when **either**: (a) you complete the spec → worktree →
   first-implementation-commit cycle, **or** (b) you hit something you genuinely cannot
   get past as a first-timer, **or** (c) you've recorded ~10 distinct friction events —
   whichever comes first. You do not need the CLI to actually work.

## Deliverable

Write the friction log to `FRICTION-LOG.md` at the repo root (your CWD). Record as you go,
appending directly — do not spray scratch files across the repo. `FRICTION-LOG.md` should
be the only new artifact you leave behind beyond the work the task itself produced.

For **every** friction event, record:

| Field | What to capture |
|---|---|
| What I did | The exact command / tool call and the legitimate goal behind it |
| What resisted | Which hook or CLI surface (name it), and verbatim message |
| Legitimate? | Were you doing a genuinely reasonable first-timer thing? (yes/no + why) |
| Escape | What you did to get past it, or "could not" |
| Better behavior | What CAWS should have done instead (or "this was correct") |

End with a short synthesis: which resistances were *correct* governance (working as
intended), which were friction a real first-timer would stumble on, and — if any — where
you got genuinely stuck.

Do not pad the log. If the run was mostly clean, say so plainly and report the few real
events. An honest short log beats a padded long one.
