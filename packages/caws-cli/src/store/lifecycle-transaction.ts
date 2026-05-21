// Lifecycle mutation transaction wrapper.
//
// LIFECYCLE-MUTATION-001 substrate: multi-file lifecycle mutations
// serialize through .caws/state.lock and produce a typed outcome that
// names partial-failure explicitly. The transaction is NOT a database
// transaction — filesystem rollback is best-effort, and the useful
// invariant is "partial failure is detected, named, and recoverable,"
// not "rollback always succeeds."
//
// Operation order (within the critical section):
//   1. acquire lifecycle lock (already done by withLifecycleLock or
//      directly by the caller)
//   2. read all affected files; capture original bytes for rollback
//   3. compute planned writes (caller-provided)
//   4. validate planned state via kernel hooks (caller-provided)
//   5. write files in deterministic order using writeFileAtomic
//      with preserveMode: true (per A2)
//   6. append the transaction's event(s) through appendEvent (the SOLE
//      v11 writer of events.jsonl)
//   7. if event append fails, attempt rollback of all written files
//      from captured original bytes; produce LIFECYCLE_PARTIAL_FAILURE_*
//   8. release lock (caller's `finally`)
//
// fsyncDir posture (A3):
//   This module does NOT call fsyncDir by default. Rationale: v11.1
//   accepts rename durability without parent-directory fsync for two
//   reasons. (a) writeFileAtomic already does file-content fsync before
//   rename, which is the durability primitive that survives kernel
//   crashes; only power loss between rename and dirent flush is at risk.
//   (b) The lock + event-append step provides a recovery anchor: if a
//   crash leaves the filesystem in a partially-renamed state, the next
//   transaction's read step will see whichever state the filesystem
//   committed, and the event log's last entry tells the operator the
//   last fully-acknowledged transition. Power-loss safety is therefore
//   bounded by the audit log, not by directory fsync. Callers needing
//   stronger durability may pass an `fsyncAfter: true` option.

import * as fs from 'fs';

import {
  type ChainedEvent,
  type EventBody,
  err,
  ok,
  type Result,
  type Diagnostic,
} from '@paths.design/caws-kernel';

import { writeFileAtomic, fsyncDir } from './atomic-write';
import { appendEvent } from './events-store';
import { storeDiagnostic } from './repo-root';
import { STORE_RULES } from './rules';

// ─── Plan and result types ───────────────────────────────────────────────

/** A single file write the transaction will perform. Order in
 *  `plannedWrites` is the order writes are applied. */
export interface LifecycleFileWrite {
  /** Absolute path of the file to write. */
  readonly path: string;
  /** New contents for this file. */
  readonly contents: string | Buffer;
  /** When true, writeFileAtomic preserves the target's existing mode. */
  readonly preserveMode?: boolean;
}

/** Inputs to a lifecycle transaction. */
export interface LifecycleTransactionPlan {
  /** Path to the .caws/ directory (passed through to appendEvent). */
  readonly cawsDir: string;
  /** Files to write in deterministic order. */
  readonly plannedWrites: readonly LifecycleFileWrite[];
  /** Event(s) to append after state writes succeed. Appended in array
   *  order. The transaction supports multiple events per command (e.g.,
   *  worktree create emits worktree_created then worktree_bound). */
  readonly events: readonly EventBody[];
  /** Optional pre-write validation. Runs AFTER the lock is held and
   *  files are read, BEFORE any write. Returns Err to abort the
   *  transaction with LIFECYCLE_PLAN_REJECTED. */
  readonly validate?: () => Result<void>;
  /** When true, call fsyncDir on each affected directory after writes.
   *  Defaults to false; see module header for rationale. */
  readonly fsyncAfter?: boolean;
}

/** Per-file pre-state captured before writes. Used for rollback. */
interface FileSnapshot {
  readonly path: string;
  /** Original bytes; null when the file did not exist (rollback = delete). */
  readonly originalContents: Buffer | null;
  /** Original mode (lower 12 bits) when the file existed; undefined otherwise. */
  readonly originalMode: number | undefined;
}

/** Success outcome: all state writes + all event appends succeeded. */
export interface LifecycleTransactionSuccess {
  readonly kind: 'success';
  readonly writes: readonly { readonly path: string }[];
  readonly appendedEvents: readonly ChainedEvent[];
}

/** Partial-failure-recovered: state writes succeeded, event append
 *  failed, rollback succeeded. The repository is in its pre-transaction
 *  state. */
export interface LifecyclePartialRecovered {
  readonly kind: 'partial_failure_recovered';
  readonly cause: readonly Diagnostic[];
  readonly rolledBack: readonly string[];
}

/** Partial-failure-unrecovered: state writes succeeded, event append
 *  failed, AND rollback also failed. The repository may be in a
 *  partial state. The caller MUST handle the recovery instruction. */
export interface LifecyclePartialUnrecovered {
  readonly kind: 'partial_failure_unrecovered';
  readonly cause: readonly Diagnostic[];
  readonly plannedEvents: readonly EventBody[];
  readonly writesCompleted: readonly string[];
  readonly rolledBack: readonly string[];
  readonly rollbackFailed: readonly { readonly path: string; readonly reason: string }[];
  readonly recoveryInstruction: string;
}

export type LifecycleTransactionResult =
  | LifecycleTransactionSuccess
  | LifecyclePartialRecovered
  | LifecyclePartialUnrecovered;

// ─── Implementation ──────────────────────────────────────────────────────

function captureSnapshot(filePath: string): FileSnapshot {
  try {
    const stat = fs.statSync(filePath);
    const originalContents = fs.readFileSync(filePath);
    return {
      path: filePath,
      originalContents,
      originalMode: stat.mode & 0o7777,
    };
  } catch (e) {
    const cause = e as { code?: string };
    if (cause.code === 'ENOENT') {
      return { path: filePath, originalContents: null, originalMode: undefined };
    }
    // Any other read failure: surface as a snapshot we don't trust.
    // Treat as "file did not exist" for rollback purposes; the
    // transaction's write step will hit the same error and abort.
    return { path: filePath, originalContents: null, originalMode: undefined };
  }
}

function rollbackOne(
  snapshot: FileSnapshot
): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  try {
    if (snapshot.originalContents === null) {
      // File didn't exist before; rollback is to delete it.
      try {
        fs.unlinkSync(snapshot.path);
      } catch (e) {
        const cause = e as { code?: string };
        // Already gone — treat as success.
        if (cause.code === 'ENOENT') return { ok: true };
        return { ok: false, reason: `failed to remove ${snapshot.path}: ${cause.code ?? 'unknown'}` };
      }
      return { ok: true };
    }
    // Restore prior contents. Use writeFileAtomic with the captured
    // mode so the rollback itself is atomic at the file level.
    const opts =
      snapshot.originalMode !== undefined ? { preserveMode: true } : {};
    // Pre-stage the target file with original mode by chmod-then-write
    // is overkill; writeFileAtomic with preserveMode will stat the
    // target (which currently has the failed-transaction bytes and
    // possibly a different mode). Safer: write first with default
    // mode, then chmod explicitly.
    const writeResult = writeFileAtomic(snapshot.path, snapshot.originalContents, opts);
    if (!writeResult.ok) {
      return { ok: false, reason: `writeFileAtomic failed during rollback: ${snapshot.path}` };
    }
    if (snapshot.originalMode !== undefined) {
      try {
        fs.chmodSync(snapshot.path, snapshot.originalMode);
      } catch {
        // Mode-restore failure during rollback: contents are restored
        // but mode may be wrong. We do NOT escalate to unrecovered for
        // a mode-only failure; the file content is correct.
      }
    }
    return { ok: true };
  } catch (e) {
    const cause = e as { message?: string };
    return { ok: false, reason: cause.message ?? 'unknown rollback error' };
  }
}

function buildRecoveryInstruction(
  plannedEvents: readonly EventBody[],
  writesCompleted: readonly string[],
  rolledBack: readonly string[],
  rollbackFailed: readonly { readonly path: string }[]
): string {
  const lines: string[] = [
    'Lifecycle transaction left the repository in a partial state.',
    `  ${writesCompleted.length} file write(s) completed before failure.`,
    `  ${rolledBack.length} successfully rolled back; ${rollbackFailed.length} rollback failure(s).`,
    '',
    `Files that may need manual inspection:`,
  ];
  for (const f of rollbackFailed) {
    lines.push(`  ${f.path} (rollback failed)`);
  }
  lines.push('');
  lines.push(`Events that were NOT appended (${plannedEvents.length}):`);
  for (const ev of plannedEvents) {
    lines.push(`  ${ev.event} (spec_id=${(ev as { spec_id?: string }).spec_id ?? 'n/a'})`);
  }
  lines.push('');
  lines.push('Required action: review each listed file against the planned event payload above to');
  lines.push('determine whether to redo the lifecycle transition or to manually restore prior state.');
  lines.push('Do NOT hand-author entries into events.jsonl.');
  return lines.join('\n');
}

// ─── Fault-injection seam (WORKTREE-MERGE-A2-FAULT-INJECTION-001) ────────
//
// Test-only seam that allows tests to simulate the partial_failure_recovered
// outcome (state writes succeed, event append fails, rollback succeeds)
// without sabotaging the filesystem or hand-rolling a bad event payload.
//
// Production-refusal contract: the seam is unreachable unless one of
//   - process.env.NODE_ENV === 'test'
//   - process.env.JEST_WORKER_ID is defined
// is true. In any other environment the env var is silently ignored.
//
// Activation: set CAWS_TEST_INJECT_LIFECYCLE_FAULT to a JSON string
// matching { eventMatch: string; cause?: string }. The seam fires the
// FIRST time a planned event's `event` field equals `eventMatch` during
// step-4 (event-append). When fired, the seam rolls back the writes
// that step 3 already applied (reverse order, snapshot-restore) and
// returns ok({ kind: 'partial_failure_recovered', cause, rolledBack }).
//
// The seam is intentionally SHARED — same shape will satisfy future
// regressions for specs.close, worktree.create, claim.takeover, and
// bridge claims (the broader scope tracked by
// LIFECYCLE-ROLLBACK-FAILURE-HARNESS-001).

interface InjectedFault {
  readonly eventMatch: string;
  readonly cause: string;
}

function readInjectedFault(): InjectedFault | null {
  const isTestEnv =
    process.env.NODE_ENV === 'test' ||
    process.env.JEST_WORKER_ID !== undefined;
  if (!isTestEnv) return null;
  const raw = process.env.CAWS_TEST_INJECT_LIFECYCLE_FAULT;
  if (raw === undefined || raw.length === 0) return null;
  try {
    const parsed = JSON.parse(raw) as { eventMatch?: unknown; cause?: unknown };
    if (typeof parsed.eventMatch !== 'string' || parsed.eventMatch.length === 0) {
      return null;
    }
    const cause =
      typeof parsed.cause === 'string' && parsed.cause.length > 0
        ? parsed.cause
        : 'CAWS_TEST_INJECT_LIFECYCLE_FAULT';
    return { eventMatch: parsed.eventMatch, cause };
  } catch {
    return null;
  }
}

/**
 * Run a lifecycle transaction.
 *
 * The caller MUST hold the lifecycle lock (via withLifecycleLock or
 * acquireLifecycleLock). This function does not acquire the lock
 * itself; that responsibility lives in the caller so a higher-level
 * orchestrator (CLI-SPECS-001, CLI-WORKTREE-001) can group multiple
 * conceptual mutations inside one lock if needed.
 *
 * Returns:
 *   Ok({ kind: 'success', ... })                    — everything worked
 *   Ok({ kind: 'partial_failure_recovered', ... })  — rolled back cleanly
 *   Err([LIFECYCLE_PARTIAL_FAILURE_UNRECOVERED]) — partial state remains
 *   Err([LIFECYCLE_PLAN_REJECTED])               — validate() rejected
 *   Err([LIFECYCLE_WRITE_FAILED])                — a write failed before events
 */
export function runLifecycleTransaction(
  plan: LifecycleTransactionPlan
): Result<LifecycleTransactionResult> {
  // Step 1: validate plan (pre-write).
  if (plan.validate) {
    const validation = plan.validate();
    if (!validation.ok) {
      const diagnostics = validation.errors.map((d) => {
        const extra: { subject?: string; data?: Record<string, unknown> } = {
          data: { source_rule: d.rule },
        };
        if (d.subject !== undefined) extra.subject = d.subject;
        return storeDiagnostic(
          STORE_RULES.LIFECYCLE_PLAN_REJECTED,
          d.message,
          extra
        );
      });
      return err(diagnostics);
    }
  }

  // Step 2: snapshot every planned file BEFORE any write.
  const snapshots = plan.plannedWrites.map((w) => captureSnapshot(w.path));

  // Step 3: apply writes in deterministic order.
  const writesCompleted: string[] = [];
  for (let i = 0; i < plan.plannedWrites.length; i++) {
    const w = plan.plannedWrites[i];
    if (!w) continue;
    const opts = w.preserveMode === true ? { preserveMode: true } : {};
    const result = writeFileAtomic(w.path, w.contents, opts);
    if (!result.ok) {
      // Write failed; the transaction has not yet appended any events.
      // Roll back the writes that already succeeded.
      const rolledBack: string[] = [];
      const rollbackFailed: { readonly path: string; readonly reason: string }[] = [];
      for (let j = i - 1; j >= 0; j--) {
        const snap = snapshots[j];
        if (!snap) continue;
        const r = rollbackOne(snap);
        if (r.ok) rolledBack.push(snap.path);
        else rollbackFailed.push({ path: snap.path, reason: r.reason });
      }
      if (rollbackFailed.length === 0) {
        const diagnostics = result.errors.map((d) => {
          const extra: { subject?: string; data?: Record<string, unknown> } = {
            data: { source_rule: d.rule, rolled_back: rolledBack.length },
          };
          if (d.subject !== undefined) extra.subject = d.subject;
          return storeDiagnostic(
            STORE_RULES.LIFECYCLE_WRITE_FAILED,
            d.message,
            extra
          );
        });
        return err(diagnostics);
      }
      // Rollback during pre-event-write failure is itself unrecovered.
      const recoveryInstruction = buildRecoveryInstruction(
        plan.events,
        writesCompleted,
        rolledBack,
        rollbackFailed
      );
      return err(
        storeDiagnostic(
          STORE_RULES.LIFECYCLE_PARTIAL_FAILURE_UNRECOVERED,
          `Lifecycle write failed and rollback could not fully restore prior state.`,
          {
            subject: w.path,
            data: {
              writes_completed: writesCompleted,
              rolled_back: rolledBack,
              rollback_failed: rollbackFailed,
              recovery_instruction: recoveryInstruction,
            },
          }
        )
      );
    }
    writesCompleted.push(w.path);
  }

  // Step 3b (optional): fsync affected directories.
  if (plan.fsyncAfter === true) {
    const dirs = new Set<string>();
    for (const w of plan.plannedWrites) {
      const lastSlash = w.path.lastIndexOf('/');
      if (lastSlash > 0) dirs.add(w.path.slice(0, lastSlash));
    }
    for (const d of dirs) {
      fsyncDir(d);
    }
  }

  // Step 4: append events through appendEvent (the SOLE v11 events
  // writer). On any failure, attempt rollback.
  //
  // Test-only fault-injection seam (WORKTREE-MERGE-A2-FAULT-INJECTION-001):
  // when CAWS_TEST_INJECT_LIFECYCLE_FAULT names an event matching the
  // first planned event, simulate the event-append failure path so tests
  // can assert composed-lifecycle honest-completion behavior. The seam
  // is guarded by NODE_ENV/JEST_WORKER_ID; in production code paths,
  // readInjectedFault() returns null regardless of the env var.
  const injectedFault = readInjectedFault();
  const appendedEvents: ChainedEvent[] = [];
  for (let i = 0; i < plan.events.length; i++) {
    const body = plan.events[i];
    if (!body) continue;
    const shouldInject =
      injectedFault !== null && body.event === injectedFault.eventMatch;
    const result = shouldInject
      ? err(
          storeDiagnostic(
            STORE_RULES.LIFECYCLE_PARTIAL_FAILURE_UNRECOVERED,
            `Test fault-injection seam fired for event "${body.event}": ${injectedFault.cause}`,
            { subject: body.event, data: { injected_cause: injectedFault.cause } }
          )
        )
      : appendEvent(plan.cawsDir, body);
    if (!result.ok) {
      // Roll back all writes. Reverse order so latest writes are
      // restored to their pre-transaction state first.
      const rolledBack: string[] = [];
      const rollbackFailed: { readonly path: string; readonly reason: string }[] = [];
      for (let j = snapshots.length - 1; j >= 0; j--) {
        const snap = snapshots[j];
        if (!snap) continue;
        const r = rollbackOne(snap);
        if (r.ok) rolledBack.push(snap.path);
        else rollbackFailed.push({ path: snap.path, reason: r.reason });
      }

      // Also, previously-appended events in this transaction are
      // already in the log. We CANNOT un-append from a hash-chained
      // log without breaking the chain. Surface this in the recovery
      // instruction.
      if (rollbackFailed.length === 0 && appendedEvents.length === 0) {
        return ok({
          kind: 'partial_failure_recovered',
          cause: result.errors,
          rolledBack,
        });
      }
      const recoveryInstruction = buildRecoveryInstruction(
        plan.events,
        writesCompleted,
        rolledBack,
        rollbackFailed
      );
      return err(
        storeDiagnostic(
          STORE_RULES.LIFECYCLE_PARTIAL_FAILURE_UNRECOVERED,
          `Lifecycle event append failed. ${appendedEvents.length} event(s) were already appended before the failure; ${rollbackFailed.length} file(s) could not be rolled back.`,
          {
            subject: body.event,
            data: {
              writes_completed: writesCompleted,
              rolled_back: rolledBack,
              rollback_failed: rollbackFailed,
              already_appended: appendedEvents.map((e) => ({
                seq: e.seq,
                event_hash: e.event_hash,
              })),
              recovery_instruction: recoveryInstruction,
            },
          }
        )
      );
    }
    appendedEvents.push(result.value);
  }

  return ok({
    kind: 'success',
    writes: writesCompleted.map((path) => ({ path })),
    appendedEvents,
  });
}
