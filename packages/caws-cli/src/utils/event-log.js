/**
 * @fileoverview Event Log — append-only provenance surface
 *
 * CAWS events are written once to `.caws/events.jsonl` and never rewritten.
 * Every other view (per-spec state, session registry, provenance chain) is
 * a pure function of this log. See docs/internal/EVENTS_LOG_MIGRATION.md
 * for the full design.
 *
 * Contract highlights:
 *   - Append-only. Readers tolerate partial last lines.
 *   - Hash-chained. Each event carries prev_hash and event_hash (sha256).
 *   - Fail-loud. Events missing a required spec_id throw; no silent writes.
 *   - Cross-platform file lock via `fs.openSync(lockPath, 'wx')` sentinel.
 *
 * This file ships as Phase 1 (dual-write). State-layer writes in
 * working-state.js continue unchanged; this log is additive.
 *
 * @author @darianrosebrook
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EVENTS_FILE = '.caws/events.jsonl';
const LOCK_SUFFIX = '.lock';
const HASH_DOMAIN = 'caws.events.v1';
const LOCK_RETRY_MS = 20;
const LOCK_RETRY_MAX = 50; // ~1s total

/**
 * Events that require a spec_id in their payload. appendEvent throws if
 * spec_id is missing for any event listed here. This is the fence that
 * prevents the `.caws/state/undefined.json` bug class.
 */
const REQUIRES_SPEC_ID = new Set([
  'validation_completed',
  'evaluation_completed',
  'verify_acs_completed',
  'gates_evaluated',
  'spec_created',
  'spec_updated',
  'spec_closed',
  'spec_archived',
  'spec_deleted',
  'spec_drift_detected',
  'waiver_applied',
]);

/**
 * Events that optionally carry a spec_id. These are allowed to omit it.
 * Any event not in REQUIRES_SPEC_ID and not in OPTIONAL_SPEC_ID is
 * treated as an unknown event type — appendEvent will still write it,
 * but it's recorded as-is without spec_id validation.
 */
const OPTIONAL_SPEC_ID = new Set([
  'session_started',
  'session_ended',
  'commit_made',
  'branch_switched',
  'worktree_created',
  'worktree_merged',
  'worktree_destroyed',
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the absolute path to `.caws/events.jsonl` for a project root.
 * @param {string} projectRoot
 * @returns {string}
 */
function getEventsPath(projectRoot) {
  return path.join(projectRoot, EVENTS_FILE);
}

/**
 * Canonicalize an event object for hashing. Keys are sorted alphabetically
 * and serialized with no whitespace, so two structurally-equivalent events
 * always produce the same hash regardless of key insertion order.
 *
 * This is a deliberate subset of RFC 8785 (JCS) — sufficient for our flat
 * event shape but not a full implementation.
 *
 * @param {object} obj
 * @returns {string}
 */
function canonicalJson(obj) {
  if (obj === null) return 'null';
  if (typeof obj === 'number') {
    if (!Number.isFinite(obj)) {
      throw new Error(`canonicalJson: non-finite number ${obj}`);
    }
    return JSON.stringify(obj);
  }
  if (typeof obj === 'string') return JSON.stringify(obj);
  if (typeof obj === 'boolean') return obj ? 'true' : 'false';
  if (Array.isArray(obj)) {
    return '[' + obj.map(canonicalJson).join(',') + ']';
  }
  if (typeof obj === 'object') {
    const keys = Object.keys(obj).sort();
    const parts = keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k]));
    return '{' + parts.join(',') + '}';
  }
  throw new Error(`canonicalJson: unsupported type ${typeof obj}`);
}

/**
 * Compute sha256 of the domain-separated canonical JSON of an event.
 * The `event_hash` field, if present on the input, is stripped before
 * hashing so the hash can be stored back on the event itself.
 *
 * @param {object} event
 * @returns {string} "sha256:<hex>"
 */
function computeEventHash(event) {
  const withoutHash = { ...event };
  delete withoutHash.event_hash;
  const canonical = canonicalJson(withoutHash);
  const hash = crypto
    .createHash('sha256')
    .update(HASH_DOMAIN)
    .update('\x00')
    .update(canonical)
    .digest('hex');
  return `sha256:${hash}`;
}

/**
 * Sleep for a number of milliseconds. Used by the async lock retry loop.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Synchronously sleep for a number of milliseconds. Node has no built-in
 * sync sleep; `Atomics.wait` on a dummy Int32Array blocks the thread
 * without CPU burn and is the least-ugly cross-platform option.
 * Used by the sync lock retry loop for call sites that cannot await.
 * @param {number} ms
 */
function sleepSync(ms) {
  const buf = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buf, 0, 0, ms);
}

/**
 * Acquire an exclusive lock on the events file by creating a sentinel
 * lockfile with the `wx` flag (fails atomically if the file already
 * exists). Retries with a short backoff.
 *
 * Returns an opaque handle that must be passed to releaseLock.
 *
 * @param {string} eventsPath
 * @returns {Promise<{lockPath: string, fd: number}>}
 */
async function acquireLock(eventsPath) {
  const lockPath = eventsPath + LOCK_SUFFIX;
  const dir = path.dirname(eventsPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  for (let attempt = 0; attempt < LOCK_RETRY_MAX; attempt++) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      // Write pid to the lock so stale locks are diagnosable.
      fs.writeSync(fd, String(process.pid));
      return { lockPath, fd };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      // Check for stale lock (>30s old) — clean it up so one crashed
      // writer doesn't block forever. This is still race-prone against
      // another writer that just grabbed it; we accept that risk because
      // the worst case is a rejected append, not corruption.
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > 30_000) {
          fs.unlinkSync(lockPath);
          continue; // retry immediately without backoff
        }
      } catch {
        /* stat failed — file may have been released; retry */
      }
      await sleep(LOCK_RETRY_MS);
    }
  }
  throw new Error(
    `event-log: could not acquire lock on ${lockPath} after ${LOCK_RETRY_MAX * LOCK_RETRY_MS}ms — another writer may be stuck`
  );
}

/**
 * Synchronous lock acquirer. Same behavior as `acquireLock` but blocks
 * the thread via `sleepSync`. Intended for call sites that cannot await
 * (e.g. session-manager.startSession/endSession which are synchronous
 * for historical reasons).
 *
 * @param {string} eventsPath
 * @returns {{lockPath: string, fd: number}}
 */
function acquireLockSync(eventsPath) {
  const lockPath = eventsPath + LOCK_SUFFIX;
  const dir = path.dirname(eventsPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  for (let attempt = 0; attempt < LOCK_RETRY_MAX; attempt++) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeSync(fd, String(process.pid));
      return { lockPath, fd };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > 30_000) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch {
        /* stat failed — retry */
      }
      sleepSync(LOCK_RETRY_MS);
    }
  }
  throw new Error(
    `event-log: could not acquire lock on ${lockPath} after ${LOCK_RETRY_MAX * LOCK_RETRY_MS}ms — another writer may be stuck`
  );
}

/**
 * Release a lock acquired via acquireLock. Never throws; a failed release
 * is logged but not propagated, because the caller has already written.
 *
 * @param {{lockPath: string, fd: number}} handle
 */
function releaseLock(handle) {
  try {
    fs.closeSync(handle.fd);
  } catch {
    /* close failure is non-fatal; the unlink below is the real release */
  }
  try {
    fs.unlinkSync(handle.lockPath);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      // Surface unexpected release failures on stderr so they're diagnosable.
      // eslint-disable-next-line no-console
      console.error(`event-log: failed to release lock ${handle.lockPath}: ${err.message}`);
    }
  }
}

/**
 * Read the last non-empty line of a file without loading the whole file
 * into memory. Used to find the tail of the event log for seq/prev_hash
 * continuity.
 *
 * Returns `null` if the file does not exist or contains only whitespace.
 *
 * @param {string} filePath
 * @returns {string|null}
 */
function readLastLine(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const stat = fs.statSync(filePath);
  if (stat.size === 0) return null;

  // Read from the end in chunks until we have at least one complete line.
  const fd = fs.openSync(filePath, 'r');
  try {
    const chunkSize = 4096;
    let buffer = Buffer.alloc(0);
    let pos = stat.size;
    while (pos > 0) {
      const readSize = Math.min(chunkSize, pos);
      pos -= readSize;
      const chunk = Buffer.alloc(readSize);
      fs.readSync(fd, chunk, 0, readSize, pos);
      buffer = Buffer.concat([chunk, buffer]);
      const text = buffer.toString('utf8');
      const lines = text.split('\n').filter((l) => l.length > 0);
      if (lines.length >= 2 || pos === 0) {
        return lines[lines.length - 1] || null;
      }
    }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Append a single event to the project's event log.
 *
 * The event is stamped with a monotonic `seq`, an ISO-8601 `ts`, a
 * `prev_hash` linking it to the previous event, and an `event_hash`
 * computed over its canonical JSON (excluding the hash field itself).
 *
 * This function is **intentionally non-tolerant**:
 *   - If `event` is an event type that requires `spec_id` and one is
 *     missing, it throws. Do NOT wrap calls in `try { ... } catch {}`.
 *   - If the lock cannot be acquired, it throws.
 *   - If the last line of the file is malformed, it throws.
 *
 * Silent loss of provenance is the current failure mode of `.caws/state/`
 * and the whole point of this module is to reverse that default.
 *
 * @param {object} params
 * @param {string} params.actor — who emitted the event (cli, hook, session, agent, subagent-name)
 * @param {string} params.event — event type from the v0 vocabulary
 * @param {string} [params.spec_id] — required for spec-scoped events, optional otherwise
 * @param {object} [params.data] — event-type-specific payload
 * @param {object} [options]
 * @param {string} [options.projectRoot] — defaults to cwd
 * @param {string} [options.session_id] — session correlator; defaults to env CAWS_SESSION_ID or "standalone"
 * @returns {Promise<{seq: number, event_hash: string, prev_hash: string}>}
 */
/**
 * Shared contract validation for both the async and sync append paths.
 * Throws on any violation. Returns a normalized descriptor the
 * file-writing helper consumes.
 *
 * @param {object} params
 * @param {object} options
 * @returns {{actor: string, event: string, spec_id: (string|undefined), data: (object|undefined), sessionId: string, eventsPath: string}}
 */
function validateAppendParams(params, options) {
  const { actor, event, spec_id, data } = params || {};
  const projectRoot = options.projectRoot || process.cwd();
  const sessionId = options.session_id || process.env.CAWS_SESSION_ID || 'standalone';

  if (!actor || typeof actor !== 'string') {
    throw new Error('event-log.appendEvent: `actor` is required (non-empty string)');
  }
  if (!event || typeof event !== 'string') {
    throw new Error('event-log.appendEvent: `event` is required (non-empty string)');
  }
  if (REQUIRES_SPEC_ID.has(event)) {
    if (!spec_id || typeof spec_id !== 'string' || spec_id.trim() === '') {
      throw new Error(
        `event-log.appendEvent: event "${event}" requires a non-empty spec_id ` +
          `(got ${JSON.stringify(spec_id)}). This is the fence that prevents the ` +
          `.caws/state/undefined.json bug class — do not catch this error and continue.`
      );
    }
  }

  return {
    actor,
    event,
    spec_id,
    data,
    sessionId,
    eventsPath: getEventsPath(projectRoot),
  };
}

/**
 * Shared critical section: read tail, build event, write. Assumes the
 * caller already holds the lock. Returns the new event (with seq, hashes).
 *
 * @param {object} ctx — output of validateAppendParams
 * @returns {{seq: number, event_hash: string, prev_hash: string}}
 */
function writeEventUnderLock(ctx) {
  const { actor, event, spec_id, data, sessionId, eventsPath } = ctx;

  const lastLine = readLastLine(eventsPath);
  let seq = 1;
  let prevHash = '';
  if (lastLine !== null) {
    let lastEvent;
    try {
      lastEvent = JSON.parse(lastLine);
    } catch (parseErr) {
      throw new Error(
        `event-log.appendEvent: last line of ${eventsPath} is malformed: ${parseErr.message}. ` +
          `The log is corrupt; manual inspection required before continuing.`
      );
    }
    if (typeof lastEvent.seq !== 'number' || !Number.isInteger(lastEvent.seq)) {
      throw new Error(
        `event-log.appendEvent: last event missing integer seq (got ${JSON.stringify(lastEvent.seq)})`
      );
    }
    seq = lastEvent.seq + 1;
    prevHash = typeof lastEvent.event_hash === 'string' ? lastEvent.event_hash : '';
  }

  const newEvent = {
    seq,
    ts: new Date().toISOString(),
    session_id: sessionId,
    actor,
    event,
  };
  if (spec_id !== undefined && spec_id !== null && spec_id !== '') {
    newEvent.spec_id = spec_id;
  }
  if (data !== undefined) {
    newEvent.data = data;
  }
  newEvent.prev_hash = prevHash;
  newEvent.event_hash = computeEventHash(newEvent);

  fs.appendFileSync(eventsPath, JSON.stringify(newEvent) + '\n', { encoding: 'utf8' });

  return {
    seq: newEvent.seq,
    event_hash: newEvent.event_hash,
    prev_hash: newEvent.prev_hash,
  };
}

async function appendEvent(params, options = {}) {
  const ctx = validateAppendParams(params, options);
  const handle = await acquireLock(ctx.eventsPath);
  try {
    return writeEventUnderLock(ctx);
  } finally {
    releaseLock(handle);
  }
}

/**
 * Synchronous variant of `appendEvent`. Same contract, same fail-loud
 * behavior. Intended for call sites that cannot await (synchronous
 * session manager functions, hooks, etc.). Blocks the thread during
 * lock contention via `Atomics.wait`.
 *
 * Prefer `appendEvent` in async contexts — it cooperates with the event
 * loop instead of blocking it.
 *
 * @param {object} params — same as appendEvent
 * @param {object} [options] — same as appendEvent
 * @returns {{seq: number, event_hash: string, prev_hash: string}}
 */
function appendEventSync(params, options = {}) {
  const ctx = validateAppendParams(params, options);
  const handle = acquireLockSync(ctx.eventsPath);
  try {
    return writeEventUnderLock(ctx);
  } finally {
    releaseLock(handle);
  }
}

/**
 * Read all events from the project's event log, in seq order.
 *
 * Tolerates a partial trailing line (from a crashed writer) by discarding
 * it. Returns an array of parsed events. The caller is responsible for
 * filtering by spec_id or event type.
 *
 * This is intentionally eager (not a stream) in Phase 1 — the expected
 * event log size for CLI-scale projects is under 10k lines, well within
 * memory. A streaming reader is a future addition when compaction lands.
 *
 * @param {object} [options]
 * @param {string} [options.projectRoot] — defaults to cwd
 * @param {boolean} [options.strict] — if true, throw on any malformed line (default false: discard trailing partial)
 * @returns {object[]}
 */
function readEvents(options = {}) {
  const projectRoot = options.projectRoot || process.cwd();
  const strict = options.strict === true;
  const eventsPath = getEventsPath(projectRoot);

  if (!fs.existsSync(eventsPath)) return [];
  const content = fs.readFileSync(eventsPath, 'utf8');
  if (content.length === 0) return [];

  const lines = content.split('\n');
  // The file ends in \n, so the split yields a trailing empty element.
  // Any other empty element is a malformed blank line.
  const events = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isLast = i === lines.length - 1;
    if (line.length === 0) {
      if (isLast) continue; // normal trailing newline
      if (strict) {
        throw new Error(`event-log.readEvents: empty line at index ${i} (strict mode)`);
      }
      continue;
    }
    try {
      events.push(JSON.parse(line));
    } catch (err) {
      if (isLast) {
        // Partial trailing line from a crashed writer — tolerate unless strict.
        if (strict) {
          throw new Error(
            `event-log.readEvents: partial trailing line (strict mode): ${err.message}`
          );
        }
        // Drop it silently; the next append will overwrite it.
        continue;
      }
      throw new Error(
        `event-log.readEvents: malformed line at index ${i}: ${err.message}. ` +
          `The log is corrupt; manual inspection required.`
      );
    }
  }
  return events;
}

/**
 * Verify the hash chain of the event log end-to-end. Walks every event,
 * recomputes its event_hash, and asserts prev_hash matches the previous
 * event's event_hash.
 *
 * Intended for a future `caws events verify` command; exported here so
 * tests can use it to prove chain continuity.
 *
 * @param {object} [options]
 * @param {string} [options.projectRoot]
 * @returns {{ok: boolean, count: number, firstBadSeq?: number, reason?: string}}
 */
function verifyChain(options = {}) {
  const events = readEvents({ ...options, strict: true });
  let prevHash = '';
  for (const event of events) {
    if (event.prev_hash !== prevHash) {
      return {
        ok: false,
        count: events.length,
        firstBadSeq: event.seq,
        reason: `prev_hash mismatch at seq ${event.seq}: expected ${JSON.stringify(prevHash)}, got ${JSON.stringify(event.prev_hash)}`,
      };
    }
    const recomputed = computeEventHash(event);
    if (recomputed !== event.event_hash) {
      return {
        ok: false,
        count: events.length,
        firstBadSeq: event.seq,
        reason: `event_hash mismatch at seq ${event.seq}: stored ${event.event_hash}, recomputed ${recomputed}`,
      };
    }
    prevHash = event.event_hash;
  }
  return { ok: true, count: events.length };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  appendEvent,
  appendEventSync,
  readEvents,
  verifyChain,

  // Exposed for tests and the renderer; not part of the stable public API.
  _internal: {
    canonicalJson,
    computeEventHash,
    readLastLine,
    REQUIRES_SPEC_ID,
    OPTIONAL_SPEC_ID,
    HASH_DOMAIN,
    EVENTS_FILE,
  },
};
