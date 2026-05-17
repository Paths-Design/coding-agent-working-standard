// Events store — the ONLY write path for .caws/events.jsonl.
//
// Semantics carried over verbatim from the legacy implementation, now
// resting on the evidence kernel:
//
//   - Append-only JSONL.
//   - Each line is exactly one `ChainedEvent`, canonical-hashed.
//   - Append acquires a lock file via `fs.openSync(lockPath, 'wx')`.
//   - Stale lock recovery: if `wx` fails with EEXIST and the lockfile is
//     older than 30 seconds, the stale file is removed and re-tried.
//     Up to 3 acquisition attempts in total; further contention is Err.
//   - Reading tolerates a trailing partial line (crash-recovery). An
//     interior malformed line is Err.
//   - Callers pass `EventBody`, never `ChainedEvent`. The store re-reads
//     the tail, calls `prepareAppend`, and writes the new line.
//
// This module is the only place outside the kernel that creates chained
// events. All other code paths (CLI commands, hooks, future store
// callers) must go through here.

import * as fs from 'fs';
import * as path from 'path';
import {
  err,
  isOk,
  ok,
  prepareAppend,
  validateChainedEvent,
  type ChainedEvent,
  type Diagnostic,
  type EventBody,
  type Result,
} from '@paths.design/caws-kernel';
import { storeDiagnostic } from './repo-root';
import { STORE_RULES } from './rules';
import type { EventsLoadResult } from './types';

const LOCK_STALE_MS = 30_000;
const LOCK_MAX_ATTEMPTS = 3;
const LOCK_RETRY_DELAY_MS = 50;

// ----------------------------------------------------------------------------
// loadEvents
// ----------------------------------------------------------------------------

/**
 * Load events from `.caws/events.jsonl`.
 *
 * Outcomes:
 *   - missing file → Ok({ events: [], warnings: [] })
 *   - empty file → Ok({ events: [], warnings: [] })
 *   - valid JSONL → Ok({ events, warnings: [] })
 *   - trailing partial line → Ok({ events, warnings: [trailing_partial_line] })
 *   - interior malformed line → Err
 *   - line parses as JSON but fails validateChainedEvent → Err
 */
export function loadEvents(cawsDir: string): Result<EventsLoadResult> {
  const filePath = path.join(cawsDir, 'events.jsonl');
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    const cause = e as { code?: string; message?: string };
    if (cause.code === 'ENOENT') {
      return ok({ events: [], warnings: [] });
    }
    return err(
      storeDiagnostic(
        STORE_RULES.READ_IO_FAILED,
        `Failed to read events.jsonl: ${cause.message ?? 'unknown error'}.`,
        { subject: filePath, data: { code: cause.code } }
      )
    );
  }

  return parseJsonlContent(raw, filePath);
}

function parseJsonlContent(raw: string, filePath: string): Result<EventsLoadResult> {
  if (raw.length === 0) return ok({ events: [], warnings: [] });

  const trailingNewline = raw.endsWith('\n');
  // Split by '\n'. If the file ends with '\n', the final entry is ''.
  const parts = raw.split('\n');
  const lines = trailingNewline ? parts.slice(0, -1) : parts;

  const events: ChainedEvent[] = [];
  const warnings: Diagnostic[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const isLast = i === lines.length - 1;

    if (line.length === 0) {
      // Interior empty lines are malformed. A truly empty file was handled above.
      if (!isLast) {
        return err(
          storeDiagnostic(
            STORE_RULES.EVENTS_INTERIOR_MALFORMED_LINE,
            `events.jsonl line ${i + 1} is empty.`,
            { subject: filePath, data: { line: i + 1 } }
          )
        );
      }
      // Trailing empty line without trailing newline shouldn't happen
      // (split semantics) but skip if it does.
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (e) {
      const cause = e as { message?: string };
      // Tolerate a trailing partial line (crash-recovery). Interior
      // malformed JSON is a hard error.
      if (isLast && !trailingNewline) {
        warnings.push(
          storeDiagnostic(
            STORE_RULES.EVENTS_TRAILING_PARTIAL_LINE,
            `events.jsonl ends with a partial line (crash-recovery tolerance).`,
            {
              subject: filePath,
              data: { line: i + 1, parse_error: cause.message ?? null },
            }
          )
        );
        continue;
      }
      return err(
        storeDiagnostic(
          STORE_RULES.EVENTS_INTERIOR_MALFORMED_LINE,
          `events.jsonl line ${i + 1} is not valid JSON: ${cause.message ?? 'unknown error'}.`,
          { subject: filePath, data: { line: i + 1 } }
        )
      );
    }

    const validated = validateChainedEvent(parsed);
    if (!isOk(validated)) {
      // Wrap the kernel diagnostics with file + line metadata so the
      // shell can render a useful pointer.
      const wrapped: Diagnostic[] = validated.errors.map((d) => ({
        ...d,
        subject: filePath,
        data: { ...(d.data ?? {}), line: i + 1, source_rule: d.rule },
        rule: STORE_RULES.EVENTS_INVALID_EVENT_SHAPE,
      }));
      return err(wrapped);
    }
    events.push(validated.value);
  }

  return ok({ events, warnings });
}

// ----------------------------------------------------------------------------
// appendEvent
// ----------------------------------------------------------------------------

/**
 * Append a new event.
 *
 * Sequence under lock:
 *   1. Acquire .caws/events.jsonl.lock (with stale-recovery + bounded retry).
 *   2. Re-read the full events file to get the most-recent event.
 *   3. Call prepareAppend(lastEvent ?? null, body).
 *   4. Append the chained event as a JSON line + '\n'.
 *   5. Release the lock.
 *
 * Returns the new ChainedEvent on success. On failure, the lock is
 * released and no bytes are written.
 *
 * Callers MUST pass an `EventBody` (caller-side fields only). The store
 * never accepts a pre-chained event — sequence and hash are kernel
 * authority.
 */
export function appendEvent(
  cawsDir: string,
  body: EventBody
): Result<ChainedEvent> {
  const eventsPath = path.join(cawsDir, 'events.jsonl');
  const lockPath = `${eventsPath}.lock`;

  // Ensure parent dir exists. We don't create .caws/ itself; that's the
  // shell's bootstrap concern. But events.jsonl living somewhere with a
  // missing parent is a programmer error.
  if (!fs.existsSync(cawsDir)) {
    throw new Error(`appendEvent: cawsDir does not exist: ${cawsDir}`);
  }

  const lockFd = acquireLock(lockPath);
  if (!isOk(lockFd)) return err(lockFd.errors);

  try {
    const loaded = loadEvents(cawsDir);
    if (!isOk(loaded)) return err(loaded.errors);
    const prev = loaded.value.events[loaded.value.events.length - 1] ?? null;

    const prepared = prepareAppend(prev, body);
    if (!isOk(prepared)) {
      // Wrap kernel diagnostics with the store rule id so callers can
      // discriminate. Original rule is preserved in data.source_rule.
      const wrapped: Diagnostic[] = prepared.errors.map((d) => ({
        ...d,
        rule: STORE_RULES.EVENTS_PREPARE_APPEND_REJECTED,
        data: { ...(d.data ?? {}), source_rule: d.rule },
      }));
      return err(wrapped);
    }

    const event = prepared.value;
    const line = JSON.stringify(event) + '\n';

    // Direct append — atomic-write is the wrong tool here because the
    // file is append-only and we hold the lock.
    let fd: number | undefined;
    try {
      fd = fs.openSync(eventsPath, 'a');
      fs.writeFileSync(fd, line);
      fs.fsyncSync(fd);
    } catch (e) {
      const cause = e as { message?: string; code?: string };
      return err(
        storeDiagnostic(
          STORE_RULES.WRITE_IO_FAILED,
          `Failed to append to events.jsonl: ${cause.message ?? 'unknown error'}.`,
          { subject: eventsPath, data: { code: cause.code } }
        )
      );
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          /* ignore */
        }
      }
    }

    return ok(event);
  } finally {
    releaseLock(lockFd.value, lockPath);
  }
}

// ----------------------------------------------------------------------------
// Lock primitives
// ----------------------------------------------------------------------------

interface LockHandle {
  readonly fd: number;
}

function acquireLock(lockPath: string): Result<LockHandle> {
  for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt++) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      // Write the holder pid + timestamp so a future doctor can see who
      // is holding the lock and when they took it.
      try {
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
        fs.fsyncSync(fd);
      } catch {
        /* writing the lock body is best-effort; the lock itself is the file's existence */
      }
      return ok({ fd });
    } catch (e) {
      const cause = e as { code?: string; message?: string };
      if (cause.code !== 'EEXIST') {
        return err(
          storeDiagnostic(
            STORE_RULES.EVENTS_LOCK_CONTENTION,
            `Unexpected error acquiring events lock: ${cause.message ?? 'unknown error'}.`,
            { subject: lockPath, data: { code: cause.code } }
          )
        );
      }
      // Stale-lock recovery.
      const recovered = tryRecoverStaleLock(lockPath);
      if (!recovered) {
        // Lock is held by a fresh holder. Brief sleep, then retry.
        sleepSyncMs(LOCK_RETRY_DELAY_MS);
      }
      // Either way, loop and try again.
    }
  }

  return err(
    storeDiagnostic(
      STORE_RULES.EVENTS_LOCK_CONTENTION,
      `Could not acquire events lock after ${LOCK_MAX_ATTEMPTS} attempts.`,
      { subject: lockPath }
    )
  );
}

function releaseLock(handle: LockHandle, lockPath: string): void {
  try {
    fs.closeSync(handle.fd);
  } catch {
    /* ignore */
  }
  try {
    fs.unlinkSync(lockPath);
  } catch {
    /* ignore — best-effort */
  }
}

function tryRecoverStaleLock(lockPath: string): boolean {
  try {
    const stat = fs.statSync(lockPath);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs > LOCK_STALE_MS) {
      fs.unlinkSync(lockPath);
      return true;
    }
  } catch {
    // The file might have disappeared between attempts; treat that as
    // recovery and retry.
    return true;
  }
  return false;
}

function sleepSyncMs(ms: number): void {
  // Synchronous sleep without dragging in dependencies. Used only inside
  // the lock-acquisition retry loop.
  const end = Date.now() + ms;
  // Atomics.wait is the clean tool here but requires a SharedArrayBuffer
  // setup. Polling Date.now() is fine for the tens-of-ms scale we use.
  while (Date.now() < end) {
    // empty body — spinning briefly under contention is acceptable.
  }
}
