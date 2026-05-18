# Event order: causal authority vs observational metadata

**Status:** doctrine (v11.1+)
**Scope:** `.caws/events.jsonl` and any future hash-chained event log

## The rule

Every event in `.caws/events.jsonl` carries two ordering-relevant fields:

- `seq` — monotonically increasing integer, allocated under the events-store lock
- `prev_hash` — content hash of the previous event, set under the same lock
- `ts` — ISO-8601 wall-clock timestamp captured by the appender

**`seq` and `prev_hash` are the causal authority.** Two events have a defined ordering relationship if and only if their `seq` values can be compared and their `prev_hash` chain links them. Consumers that need a "what happened in what order" answer MUST use these.

**`ts` is observational metadata.** It records what the appender's clock read when the event was constructed. It is useful for humans reading the log, for time-bucketed analytics, and for rough latency estimates. It is NOT a causal authority.

## Why this distinction matters

Composed lifecycle operations (e.g., `caws worktree merge`) call multiple writers in sequence:

```text
mergeWorktree → closeSpec  → append spec_closed
             → withLifecycleLock → append worktree_merged
             → destroyWorktree → append worktree_destroyed
```

Each writer historically re-read the wall clock at the moment it constructed its event. Because `closeSpec` does non-trivial work between the merge's clock read and its own (raw-byte YAML patch, transaction prepare), the timestamps could land in an order that disagreed with `seq`:

```text
seq=4 spec_closed       ts=03:31:48.572Z   ← later
seq=5 worktree_merged   ts=03:31:48.534Z   ← earlier
```

The chain was still correct (`prev_hash(5) = event_hash(4)`), but a human reading the log saw timestamps that contradicted sequence. That is a readability bug, not a correctness bug.

## Required behavior

### Causal order (MUST)

- `seq` is allocated under the events-store lock; consumers MUST use it for ordering.
- `prev_hash` MUST link to the immediately previous event's content hash. Verifiers MUST reject any chain break.
- No appender outside `events-store.appendEvent` may write to `events.jsonl`.

### Timestamp behavior (SHOULD)

- Composed lifecycle operations (one CLI invocation that produces multiple events through sub-writer calls) SHOULD capture a single baseline timestamp and thread it to every sub-writer.
- Sub-writers SHOULD accept an injected `now` factory and use it instead of `new Date()` directly.
- Individual independent appends (one-event-per-call paths) MAY read the wall clock at append time.

This gives composed operations a clean human-readable timestamp story without requiring every appender to coordinate clocks globally.

## What this is NOT

- Not a monotonic-clock guarantee across processes. Two CLI invocations on different hosts may emit events with any timestamp relationship; `seq` and the lock are what serialize them.
- Not a wall-clock-skew defense. NTP, container clocks, and clock-jump events are out of scope. CAWS does not assume `ts` is correct.
- Not a license to drop `ts`. Observational metadata is still required for audit; it just is not authoritative for order.

## Implementation reference

`packages/caws-cli/src/store/worktrees-writer.ts::mergeWorktree` is the canonical example: a single `mergeNow` is captured once, threaded through `closeSpec`, the inline `worktree_merged` append, and `destroyWorktree`.

```ts
const mergeNow = new Date((input.now ?? (() => new Date()))().getTime());
const sharedNowFactory = () => mergeNow;

closeSpec(cawsDir, { ..., now: sharedNowFactory });
// append worktree_merged with ts: mergeNow.toISOString()
destroyWorktree(cawsDir, { ..., now: sharedNowFactory });
```

## Test invariant

A unit test in `worktrees-writer.test` SHOULD assert that all three events emitted by a single `mergeWorktree` invocation share the same `ts` value when the input `now` factory is fixed. This locks the composed-operation contract in place.
