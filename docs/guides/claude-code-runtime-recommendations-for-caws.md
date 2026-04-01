# Claude Code-Informed Runtime Recommendations for CAWS

**Last Updated**: 2026-03-31
**Status**: Design Recommendations

---

## Purpose

This document turns the CAWS/Claude Code comparison into concrete architectural recommendations for CAWS.

These are recommendations only.
They are not implementation commitments.

The framing is intentionally CAWS-native:

CAWS is an immune system for agentic development failures.
Any runtime improvements should make that immune system stronger, earlier, more adaptive, and less friction-heavy.

---

## Executive Summary

CAWS already does several critical things well:

- policy-driven workflow discipline
- risk-based rigor
- provenance
- multi-agent isolation
- explicit waiver and scope-control mechanisms

What CAWS can learn from Claude Code is mostly about runtime capability:

- better active-state handling
- better long-session coherence
- richer code intelligence
- bounded sidecar workflows
- deeper lifecycle automation

The recommendation is not to reposition CAWS as a coding assistant.
The recommendation is to make CAWS a smarter and more operationally effective governance/runtime layer for agentic work.

---

## Architectural Direction

CAWS should continue to be:

- spec-first
- contract-first
- gate-driven
- provenance-rich
- risk-aware

CAWS should become more:

- stateful at runtime
- semantically aware of repository structure
- able to maintain current-work context
- able to automate governance maintenance tasks safely
- able to guide agents through failures with less ambiguity

---

## Recommended Additions

### 1. Add an Explicit Working-State Layer

CAWS has working specs, but it could benefit from a first-class runtime working state.

This should track:

- current objective
- current implementation phase
- touched files
- active blockers
- unresolved quality gate failures
- open waiver dependencies
- next recommended actions

This is not a replacement for the working spec.
It is a live runtime companion to it.

### 2. Add Context-Lifecycle Awareness

CAWS currently tells agents what the rules are.
It could do more to help them maintain coherent active context over longer work.

Potential capabilities:

- active context summaries
- checkpointed task state
- scope-aware context trimming
- summary provenance
- visible "what changed since last evaluation" records

This would make iterative `evaluate` and `iterate` flows more powerful.

### 3. Add a Semantic Code Intelligence Substrate

Quality gates, scope checks, and multi-agent coordination become significantly more useful if CAWS understands:

- definitions
- references
- symbol ownership
- call graph relevance
- dependency impact

This would improve:

- scope validation
- merge planning
- conflict detection
- risk assessment
- quality guidance

### 4. Add Bounded Governance Sidecars

CAWS already has strong workflow commands.
It could benefit from tightly scoped helper flows for:

- waiver drafting
- provenance summarization
- spec drift analysis
- quality-gap diagnosis
- post-run audit summaries

These should be constrained, policy-aware, and non-authoritative by default.

### 5. Add Lifecycle Automation Around Critical Events

Potential event points:

- before work starts
- after spec validation
- after edits
- after failed evaluation
- before merge
- after merge
- when budget or scope pressure rises

This would allow CAWS to move from static guardrails to more adaptive operating discipline.

### 6. Add Richer Runtime Feedback for Agents

CAWS already returns structured evaluation and iteration guidance.
The next improvement is better runtime feedback on:

- why a gate failed
- what evidence is missing
- what file/symbols are relevant
- whether the issue is policy, scope, quality, or architectural
- what the smallest safe next step is

This makes CAWS easier for weaker or less context-capable agents to follow.

---

## High-Value Feature Areas

### Working State

Why it matters:

- reduces repeated rediscovery
- improves iterative guidance quality
- makes failure recovery cleaner

### Semantic Code Intelligence

Why it matters:

- improves scope fencing
- improves merge/conflict understanding
- improves quality recommendations

### Governance Sidecars

Why it matters:

- keeps policy-sensitive maintenance separate from main implementation work
- reduces noise in the main agent loop

### Lifecycle Hooks

Why it matters:

- turns governance from static rules into active workflow behavior
- creates earlier immune responses to failure patterns

---

## What This Strengthens in CAWS

These recommendations reinforce CAWS's strongest roles:

- preventing silent policy bypass
- catching risky drift earlier
- making multi-agent work safer
- reducing ambiguity around compliance
- making quality discipline easier to sustain

They should make CAWS feel less like a set of rules agents must remember and more like a system that actively helps them stay inside the lines.

---

## What This Does Not Mean

These recommendations do not mean:

- turn CAWS into a monolithic coding REPL
- replace specs with inferred context
- replace dual control with autonomous policy changes
- deprioritize contract-first development
- make governance secondary to productivity

CAWS should remain governance-forward.
The runtime additions should support that role, not dilute it.

---

## Suggested Priorities

If CAWS were to adopt these ideas incrementally, the order with the best leverage would likely be:

1. working-state model
2. semantic code intelligence
3. lifecycle automation around evaluation and scope/budget pressure
4. bounded sidecar flows for governance maintenance
5. deeper context-lifecycle support for long-running sessions

This sequence improves both usability and enforcement without forcing a full platform rewrite.

---

## Bottom Line

The strongest Claude Code lessons for CAWS are not about becoming a better autonomous coder.
They are about becoming a better runtime steward for agentic work.

CAWS already has a strong immune philosophy.
What it can learn from Claude Code is how to build a more sensor-rich, stateful, and operationally adaptive immune response.
