---
doc_id: coding-rigor
authority: guide
status: active
title: Coding rigor for review, testing and completion
owner: CAWS maintainers
updated: 2026-10-03
audience: consumer
---

# Coding rigor for review, testing and completion

This is the working standard for human and agent contributions. It connects
acceptance, source review, falsifiable tests and observable runtime evidence.
Project specs and policy own authority; this guide does not grant permission to
edit, record acceptance, take over work or publish.

## Establish context and intended behavior

Record the requested scope, revision, working-tree state, selected diff and
actual target branch/merge base. Inspect relevant callers, consumer contracts,
schemas and repository checks. Treat historical summaries as leads and verify
current claims against source or runtime. Preserve unrelated work.

Review requests authorize inspection and findings. Implementation, governance
evidence and publication follow their corresponding authorization and CAWS
binding. Existing authorization carries forward; do not add confirmation steps
for routine work already requested.

For each acceptance criterion, define:

| Field                | Required content                                            |
| -------------------- | ----------------------------------------------------------- |
| Setup and trigger    | Concrete Given/When conditions                              |
| Expected observation | Semantic value, state transition, output or preserved bytes |
| Verification         | Specific test, command, runtime scenario or inspection      |
| Counterexample       | A meaningful wrong behavior the check must detect           |
| Remaining gap        | What that observation cannot establish and how to close it  |

Rank failure modes by severity and describe trigger, incorrect result, cost,
correction and resolve-now/defer decision. Prioritize authority mistakes,
irreversible operations and dependencies whose correction becomes more expensive
as consumers adopt them. Do not manufacture findings to appear rigorous: trace
the failure or name the missing evidence. State the strongest objection when
changing course and say plainly when the plan is sound.

## Trace the route and challenge the oracle

Follow input through the real entry point, validation, authority decision,
producer, state change and consumer-visible result. Inspect rejection, boundary,
partial-failure, concurrency and cleanup behavior where relevant. For package or
harness claims, inspect installation, bootstrap and delivery boundaries too.

Tests must assert semantic values and execute their assertions. Conditional
assertions that disappear on failure, shape-only checks and mocks replacing the
promised integration can all produce false confidence. Derive expected behavior
from requirements and consumer contracts; either implementation or test may be
wrong. Do not change production solely to satisfy an arbitrary assertion.

For consequential logic, establish sensitivity with meaningful negative controls
or mutation testing. Examples include a safe runner preserving a sentinel while
a deliberately unsafe control changes it, or a signal-handler receipt paired
with a suppressed-signal control. A process disappearing or an escalation stamp
alone does not establish signal delivery.

Inspect per-file mutation results and surviving/uncovered cases. Never lower
declared floors or silently remove targets to pass. A killed mutant establishes
sensitivity to that change; correctness still depends on a sound expected result
and the behavior exercised. Distinguish an equivalent mutant demonstrated
against the valid input domain from an uninvestigated survivor.

## Choose proportionate checks and retain evidence

Small behavior changes need focused semantic checks. Documentation changes need
source/command/link checks. Authority, persistence, lifecycle and
state-transition logic require stronger rejection and partial-failure coverage.
Releases retain the project's required broad tests, coverage, per-file mutation
floors and installed/native scenarios. Passing a narrow check does not waive a
required gate.

For expensive scenarios, establish time budgets, progress, acceptance and stop
conditions before launch. An interrupted or timed-out run has no passing
verdict; preserve diagnostics and clean up only owned subprocesses. A refusal
emitted after its consumer's deadline does not establish delivered enforcement.

Retain exact commands, cwd/environment choices, revision, selected tests,
original exit status, relevant stdout/stderr, skips and observed values. For
side effects, inspect before/after state. For packaged claims, retain the
artifact and hash and verify the executable actually resolved. Do not let
ambient global tools, caches or fixtures stand in for the candidate.

Keep failed, superseded and interrupted attempts with their disposition. Do not
combine separate partial runs into one complete qualification. If source changes
after a run, rerun affected checks or demonstrate input correspondence and state
the limits of reuse. Hashes establish byte identity, not semantic correctness.

Generated evidence stays outside source commits. Establish retention before
worktree teardown, preserving only repository-owned material and excluding
secrets or unrelated data. Canonical CAWS acceptance is recorded through
`caws specs evidence`; distinguish inspected observations from self-reported
records and automatically re-derived evidence. Neither a record nor a closed
spec establishes a merge, deployment or native observation.

## Report the conclusion and its limits

Use this compact record for each material claim or finding:

> Claim → intended behavior → failure trigger → concrete evidence → remaining
> uncertainty → disposition

Lead with the most consequential finding. Cite the file/line or runtime
artifact, trigger, incorrect result, impact and proposed correction. Report
checks with their actual statuses and print the relevant runtime values or state
alongside artifact references; a pass count alone is insufficient.

Distinguish source inspection, test execution, installed-package behavior,
actual native execution, recorded acceptance, remote CI, merge and deployment.
State what could still be incorrect despite passing tests, exactly which
additional observation or instrumentation would close each material gap, and
what was not verified. Exit zero can coexist with warnings, skips or incomplete
observations.

Separate next actions into **investigate**, **implement** and **change**, each
with where and why. Commit logical source changes under the owned spec. Keep
review readiness, functional acceptance and release readiness explicit and
distinct.
