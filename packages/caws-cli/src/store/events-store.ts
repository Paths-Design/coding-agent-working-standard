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

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  err,
  isOk,
  ok,
  prepareAppend,
  validateChainedEvent,
  type Actor,
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
// rotateEvents — sanctioned second writer for chain maintenance
// ----------------------------------------------------------------------------
//
// Per doctrine invariant 14 (docs/architecture/caws-vnext-command-surface.md
// §6), rotateEvents is the only writer of events.jsonl besides appendEvent.
// Both functions live in this module, both hold the same lock. Shell commands
// and migration tooling NEVER write events.jsonl directly; they invoke this
// function through the exported store surface. The lock primitives below
// (acquireLock/releaseLock/tryRecoverStaleLock) stay private — exporting them
// would create a third writer surface by exposing lock acquisition to callers
// that bypass the canonical functions.
//
// Atomicity:
//   The operation is a same-lock single critical section that performs a
//   two-step filesystem transition: rename old file → write new genesis file.
//   On a single filesystem, fs.renameSync is atomic. The genesis write is
//   fsynced before the lock is released. A crash BETWEEN the rename and the
//   genesis write leaves the archive on disk but no new events.jsonl; the
//   next caws command sees "no events.jsonl, create on first append" (per
//   invariant 5: events.jsonl is never required at rest), and the archive
//   is still verifiable by hash if the operator preserved the digest
//   out-of-band. A crash DURING the rename is a no-op (rename is atomic).
//
// Validation chain (doctrine nuance — see invariant 1 amendment):
//   The chain_rotated body is constructed in-memory by this function, then
//   passed to prepareAppend(null, body). prepareAppend invokes
//   validateEventBody, which runs the chain_rotated payload schema and
//   rejects malformed payloads BEFORE any file write. This function does NOT
//   hand-build a ChainedEvent — sequence numbers and hash linkage remain
//   kernel authority.

const ARCHIVE_PREFIX = 'events.jsonl.archive-';

export interface RotateEventsOptions {
  /**
   * Operator-supplied reason recorded verbatim into chain_rotated.data.
   * migration_reason. Required for every rotate invocation regardless of
   * chain shape; see CAWS-MIGRATE-V10-EVENTS-001 A6/A8.
   */
  readonly reason: string;
  /**
   * Actor to attribute the chain_rotated event to. The kernel envelope
   * requires a structured Actor; the shell command's buildActor() helper
   * is the conventional source.
   */
  readonly actor: Actor;
  /**
   * Friction flag. When the prior chain has only structured (v11) actors,
   * rotation is refused unless allowClean === true. Default false means
   * rotation against a clean chain is treated as an operator slip; the
   * caller must explicitly opt in to log rotation as a non-migration
   * maintenance operation. See A8.
   */
  readonly allowClean?: boolean;
  /**
   * Override the wall-clock used for the archive timestamp. Tests inject
   * a fixed Date; production omits this and the function uses new Date().
   */
  readonly now?: Date;
}

/**
 * Rotate the events.jsonl chain: archive the existing file under a
 * timestamped name and write a fresh chain whose genesis event is
 * chain_rotated, cryptographically tying the archive to the new chain
 * via prior_file_digest.
 *
 * Refusals (typed Diagnostic, no file mutations on any refusal path):
 *   - EVENTS_ROTATE_NOTHING_TO_ROTATE: file missing or zero-length.
 *   - EVENTS_ROTATE_CLEAN_CHAIN_REQUIRES_ALLOW_CLEAN: all entries are
 *     structured (v11) actors and allowClean !== true.
 *   - EVENTS_PREPARE_APPEND_REJECTED: the constructed chain_rotated body
 *     failed kernel validation (programmer error in this function or a
 *     schema change drift). Carries kernel diagnostics in data.source_rule.
 *   - WRITE_IO_FAILED: rename or genesis-write failed at the FS layer.
 *
 * On success returns the new ChainedEvent (the chain_rotated genesis event
 * that is now the entirety of the new events.jsonl).
 */
export function rotateEvents(
  cawsDir: string,
  opts: RotateEventsOptions
): Result<ChainedEvent> {
  const eventsPath = path.join(cawsDir, 'events.jsonl');
  const lockPath = `${eventsPath}.lock`;

  if (!fs.existsSync(cawsDir)) {
    throw new Error(`rotateEvents: cawsDir does not exist: ${cawsDir}`);
  }

  const lockFd = acquireLock(lockPath);
  if (!isOk(lockFd)) return err(lockFd.errors);

  try {
    // ── 1. Refuse if there is nothing to rotate. ──────────────────────────
    let stat: fs.Stats;
    try {
      stat = fs.statSync(eventsPath);
    } catch (e) {
      const cause = e as { code?: string };
      if (cause.code === 'ENOENT') {
        return err(
          storeDiagnostic(
            STORE_RULES.EVENTS_ROTATE_NOTHING_TO_ROTATE,
            'rotateEvents refuses: events.jsonl does not exist.',
            { subject: eventsPath, data: { code: 'ENOENT' } }
          )
        );
      }
      throw e;
    }
    if (stat.size === 0) {
      return err(
        storeDiagnostic(
          STORE_RULES.EVENTS_ROTATE_NOTHING_TO_ROTATE,
          'rotateEvents refuses: events.jsonl is empty.',
          { subject: eventsPath, data: { size: 0 } }
        )
      );
    }

    // ── 2. Read the file once for sha256 + tolerant scan. ────────────────
    // Streaming is overkill for the sizes events.jsonl reaches in practice
    // (sterling's worst case is 1500 lines ≈ a few hundred KB); a single
    // readFileSync is simpler and the lock is held throughout anyway.
    const rawBytes = fs.readFileSync(eventsPath);
    const priorFileDigest = `sha256:${crypto
      .createHash('sha256')
      .update(rawBytes)
      .digest('hex')}` as const;

    const scanResult = tolerantScanEventsFile(rawBytes.toString('utf8'));

    // ── 3a. Partial-corruption refusal. ───────────────────────────────────
    // A log that has SOME unparseable lines alongside parseable ones
    // cannot be honestly labeled by the prior_chain_status enum:
    // 'parseable_unverified' implies every line parsed, and
    // 'unparseable' implies every line did not. Refuse rather than ship
    // a dishonest label. The fully-unparseable case is still admissible
    // (status: 'unparseable' is the honest label) for operators who
    // explicitly want to archive a fully-corrupt log; the trap is only
    // mixed parseable + unparseable.
    //
    // A future opt-in path (e.g. opts.allowCorruptArchive + a new
    // 'partially_unparseable' enum value on chain_rotated) may be added
    // in a later slice if recovery from partial corruption becomes a
    // first-class operator concern. Not in v11.2 scope.
    const hasPartialCorruption =
      scanResult.stats.unparseable > 0 &&
      scanResult.stats.unparseable < scanResult.lineCount;
    if (hasPartialCorruption) {
      return err(
        storeDiagnostic(
          STORE_RULES.EVENTS_ROTATE_PARTIAL_CORRUPTION,
          `rotateEvents refuses: events.jsonl has ${scanResult.stats.unparseable} unparseable line(s) alongside ${scanResult.stats.v10_string_actor + scanResult.stats.v11_object_actor} parseable line(s). Mixed parseable + unparseable cannot be honestly labeled by the chain_rotated payload (no enum value covers the case). Inspect the file and recover manually, or remove the corrupt lines before retrying.`,
          {
            subject: eventsPath,
            data: { actor_shape_stats: scanResult.stats, lineCount: scanResult.lineCount },
          }
        )
      );
    }

    // ── 3b. Clean-chain refusal (friction flag). ─────────────────────────
    // A clean v11 chain has only structured actors. Refuse unless the
    // operator explicitly opted in via allowClean: true. The intent is to
    // make general log rotation explicit-and-auditable, not to forbid it.
    const isCleanV11 =
      scanResult.stats.v10_string_actor === 0 &&
      scanResult.stats.unparseable === 0 &&
      scanResult.stats.v11_object_actor > 0;
    if (isCleanV11 && opts.allowClean !== true) {
      return err(
        storeDiagnostic(
          STORE_RULES.EVENTS_ROTATE_CLEAN_CHAIN_REQUIRES_ALLOW_CLEAN,
          'rotateEvents refuses: prior chain is a clean v11 chain (all structured actors); pass allowClean: true (CLI: --allow-clean) to rotate it anyway.',
          {
            subject: eventsPath,
            data: { actor_shape_stats: scanResult.stats },
          }
        )
      );
    }

    // ── 4. Build the chain_rotated body. ────────────────────────────────
    const nowDate = opts.now ?? new Date();
    const archiveName = `${ARCHIVE_PREFIX}${windowsSafeIso(nowDate)}`;
    const archivePath = path.join(cawsDir, archiveName);

    const priorChainStatus: 'parseable_unverified' | 'unparseable' | 'empty' =
      scanResult.stats.unparseable > 0 &&
      scanResult.stats.v10_string_actor === 0 &&
      scanResult.stats.v11_object_actor === 0
        ? 'unparseable'
        : 'parseable_unverified';

    const data: Record<string, unknown> = {
      prior_tail_hash: scanResult.tailHash,
      prior_file_path: archiveName,
      prior_file_digest: priorFileDigest,
      prior_line_count: scanResult.lineCount,
      prior_chain_status: priorChainStatus,
      actor_shape_stats: scanResult.stats,
      migration_reason: opts.reason,
    };
    if (scanResult.tailSeq !== null) {
      data.prior_seq = scanResult.tailSeq;
    }

    const body: EventBody = {
      event: 'chain_rotated',
      ts: nowDate.toISOString(),
      actor: opts.actor,
      data,
    };

    // ── 5. Kernel validation BEFORE any file mutation. ──────────────────
    // prepareAppend invokes validateEventBody, which runs the chain_rotated
    // payload schema. A malformed body fails here, no file is touched. This
    // is the doctrine-compliant validation chain (invariant 1 amendment).
    const prepared = prepareAppend(null, body);
    if (!isOk(prepared)) {
      const wrapped: Diagnostic[] = prepared.errors.map((d) => ({
        ...d,
        rule: STORE_RULES.EVENTS_PREPARE_APPEND_REJECTED,
        data: { ...(d.data ?? {}), source_rule: d.rule },
      }));
      return err(wrapped);
    }
    const genesisEvent = prepared.value;
    const genesisLine = JSON.stringify(genesisEvent) + '\n';

    // ── 6. Two-step filesystem transition: rename then write+fsync. ────
    // Both steps are inside the same lock critical section. Same-filesystem
    // rename is atomic; the new genesis write is fsynced before lock
    // release. A crash between rename and genesis-write leaves the archive
    // intact and no events.jsonl, recoverable per invariant 5.
    try {
      fs.renameSync(eventsPath, archivePath);
    } catch (e) {
      const cause = e as { message?: string; code?: string };
      return err(
        storeDiagnostic(
          STORE_RULES.WRITE_IO_FAILED,
          `Failed to rename events.jsonl to archive: ${cause.message ?? 'unknown error'}.`,
          {
            subject: eventsPath,
            data: { code: cause.code, archivePath },
          }
        )
      );
    }

    let fd: number | undefined;
    try {
      fd = fs.openSync(eventsPath, 'w');
      fs.writeFileSync(fd, genesisLine);
      fs.fsyncSync(fd);
    } catch (e) {
      const cause = e as { message?: string; code?: string };
      return err(
        storeDiagnostic(
          STORE_RULES.WRITE_IO_FAILED,
          `Failed to write chain_rotated genesis event after archive rename: ${cause.message ?? 'unknown error'}. The archive at ${archivePath} is intact; the next caws command will see no events.jsonl and create one on first append (per doctrine invariant 5).`,
          {
            subject: eventsPath,
            data: { code: cause.code, archivePath },
          }
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

    return ok(genesisEvent);
  } finally {
    releaseLock(lockFd.value, lockPath);
  }
}

/**
 * Tolerant scan of an events.jsonl file's raw text. Used by rotateEvents
 * to extract the prior tail hash + seq and tally actor-shape stats WITHOUT
 * invoking validateChainedEvent. Calling the strict validator on a v10 line
 * is the exact failure mode the rotation slice exists to repair.
 *
 * Each non-empty line is JSON.parse'd defensively. Lines that fail parse
 * are counted as unparseable. Lines that parse contribute their actor
 * shape to the stats; the actor is classified by direct type inspection
 * (typeof obj.actor === 'string' → v10; non-null object with kind → v11).
 *
 * The tail hash and tail seq come from the last non-empty line iff it
 * parsed cleanly and carried the expected fields; otherwise they are null.
 */
interface TolerantScanResult {
  readonly stats: {
    readonly v10_string_actor: number;
    readonly v11_object_actor: number;
    readonly unparseable: number;
  };
  readonly lineCount: number;
  readonly tailHash: string | null;
  readonly tailSeq: number | null;
}

function tolerantScanEventsFile(raw: string): TolerantScanResult {
  const trailingNewline = raw.endsWith('\n');
  const parts = raw.split('\n');
  const lines = trailingNewline ? parts.slice(0, -1) : parts;
  const nonEmpty = lines.filter((l) => l.length > 0);

  let v10 = 0;
  let v11 = 0;
  let bad = 0;
  let tailHash: string | null = null;
  let tailSeq: number | null = null;

  for (let i = 0; i < nonEmpty.length; i++) {
    const line = nonEmpty[i]!;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      bad += 1;
      continue;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      bad += 1;
      continue;
    }
    const obj = parsed as Record<string, unknown>;

    const actor = obj['actor'];
    if (typeof actor === 'string') {
      v10 += 1;
    } else if (
      actor !== null &&
      typeof actor === 'object' &&
      !Array.isArray(actor) &&
      typeof (actor as Record<string, unknown>)['kind'] === 'string'
    ) {
      v11 += 1;
    } else {
      bad += 1;
    }

    // Tail extraction: only the last non-empty line contributes; only
    // accept event_hash/seq if their shapes look right (no full validation).
    if (i === nonEmpty.length - 1) {
      const eh = obj['event_hash'];
      if (typeof eh === 'string' && /^sha256:[0-9a-f]{64}$/.test(eh)) {
        tailHash = eh;
      }
      const sq = obj['seq'];
      if (typeof sq === 'number' && Number.isInteger(sq) && sq >= 1) {
        tailSeq = sq;
      }
    }
  }

  return {
    stats: {
      v10_string_actor: v10,
      v11_object_actor: v11,
      unparseable: bad,
    },
    lineCount: nonEmpty.length,
    tailHash,
    tailSeq,
  };
}

/**
 * Windows-safe ISO timestamp for archive filenames. Replaces ':' with '-'
 * (colons are forbidden in Windows filesystem names) while keeping the
 * sortable yyyy-mm-ddThh-mm-ss-sssZ shape.
 */
function windowsSafeIso(d: Date): string {
  return d.toISOString().replace(/:/g, '-').replace(/\./g, '-');
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
