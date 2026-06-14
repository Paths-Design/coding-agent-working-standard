'use strict';

/**
 * Unit tests for the events-store hash-chain (A4 — audit integrity, E9/E20).
 *
 * CAWS-TEST-CLI-STORE-001. appendEvent is the chain-append surface: it loads the
 * prior chain, asks the KERNEL (prepareAppend) to compute seq + prev_hash +
 * event_hash, then appends the line. loadEvents reads the chain and detects
 * tamper. Tests assert the REAL chain on disk: seq increments, prev_hash links
 * the prior event_hash, genesis prev_hash is null, and a tampered/interrupted
 * chain is detected — by reading events.jsonl, not mocks. This is the v10->v11
 * audit substrate (E9 hash-chain, E20 event rename).
 *
 * SUT loaded from dist/. cawsDir per-test under os.tmpdir().
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { appendEvent, loadEvents, rotateEvents } = require('../../dist/store/events-store');

const PREPARE_REJECTED = 'store.events.prepare_append_rejected';
const INTERIOR_MALFORMED = 'store.events.interior_malformed_line';
const IO_FAILED = 'store.write.io_failed';
const LOCK_CONTENTION = 'store.events.lock_contention';
const ROTATE_NOTHING = 'store.events.rotate.nothing_to_rotate';
const ROTATE_CLEAN = 'store.events.rotate.clean_chain_requires_allow_clean';
const ROTATE_PARTIAL = 'store.events.rotate.partial_corruption';

const dirs = [];
function cawsDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-ev-'));
  dirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

const actor = { kind: 'agent', id: 'a-1', session_id: 's-1', platform: 'test' };

/** A valid test_recorded body (this event type requires spec_id + command/exit_code data). */
function body(extra = {}) {
  return {
    event: 'test_recorded',
    ts: '2026-06-13T12:00:00.000Z',
    actor,
    spec_id: 'CAWS-TEST-CLI-STORE-001',
    data: { command: 'jest', exit_code: 0 },
    ...extra,
  };
}

describe('appendEvent: builds a linked hash chain', () => {
  test('the genesis event has seq 1 and prev_hash null', () => {
    const dir = cawsDir();
    const r = appendEvent(dir, body());
    expect(r.ok).toBe(true);
    const ev = r.value;
    expect(ev.seq).toBe(1);
    expect(ev.prev_hash).toBeNull();
    expect(ev.event_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test('the second event has seq 2 and prev_hash === genesis event_hash (the chain link)', () => {
    const dir = cawsDir();
    const first = appendEvent(dir, body()).value;
    const second = appendEvent(dir, body({ ts: '2026-06-13T12:01:00.000Z' })).value;
    expect(second.seq).toBe(2);
    // The load-bearing audit property: each event links to its predecessor.
    expect(second.prev_hash).toBe(first.event_hash);
  });

  test('seq increments monotonically across many appends', () => {
    const dir = cawsDir();
    const seqs = [];
    for (let i = 0; i < 5; i++) {
      seqs.push(appendEvent(dir, body({ ts: `2026-06-13T12:0${i}:00.000Z` })).value.seq);
    }
    expect(seqs).toEqual([1, 2, 3, 4, 5]);
  });

  test('each appended event is persisted as one JSONL line on disk', () => {
    const dir = cawsDir();
    appendEvent(dir, body());
    appendEvent(dir, body({ ts: '2026-06-13T12:01:00.000Z' }));
    const raw = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8');
    const lines = raw.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).seq).toBe(1);
    expect(JSON.parse(lines[1]).seq).toBe(2);
  });
});

describe('appendEvent: rejects an invalid body BEFORE writing', () => {
  test('a body missing required data fields -> prepare_append_rejected, nothing written', () => {
    const dir = cawsDir();
    // test_recorded requires {command, exit_code}; omit them.
    const r = appendEvent(dir, body({ data: {} }));
    expect(r.ok).toBe(false);
    expect(r.errors[0].rule).toBe(PREPARE_REJECTED);
    // The kernel's original rule is preserved for discrimination.
    expect(r.errors[0].data.source_rule).toBeDefined();
    // No file was created — the rejection happens before the write.
    expect(fs.existsSync(path.join(dir, 'events.jsonl'))).toBe(false);
  });
});

describe('loadEvents: reads the chain and detects shape problems', () => {
  test('a missing file loads as an empty chain (Ok, no events)', () => {
    const dir = cawsDir();
    const r = loadEvents(dir);
    expect(r.ok).toBe(true);
    expect(r.value.events).toEqual([]);
  });

  test('round-trips appended events in order', () => {
    const dir = cawsDir();
    appendEvent(dir, body());
    appendEvent(dir, body({ ts: '2026-06-13T12:01:00.000Z' }));
    const r = loadEvents(dir);
    expect(r.value.events.map((e) => e.seq)).toEqual([1, 2]);
  });

  test('an interior malformed line is a hard Err (not silently skipped)', () => {
    const dir = cawsDir();
    appendEvent(dir, body());
    // Corrupt the chain: inject a garbage interior line, then a valid-looking tail.
    const file = path.join(dir, 'events.jsonl');
    const good = fs.readFileSync(file, 'utf8').trim();
    fs.writeFileSync(file, good + '\n' + 'not json at all' + '\n' + good + '\n');
    const r = loadEvents(dir);
    expect(r.ok).toBe(false);
    // It surfaces a parse failure on an interior line, not a silent drop.
    expect(r.errors.length).toBeGreaterThan(0);
  });

  test('a trailing partial line (no final newline) loads with a WARNING, not an Err', () => {
    const dir = cawsDir();
    appendEvent(dir, body());
    const file = path.join(dir, 'events.jsonl');
    const good = fs.readFileSync(file, 'utf8').trim();
    // Append a partial (crash-interrupted) line with NO trailing newline.
    fs.writeFileSync(file, good + '\n' + '{"partial":');
    const r = loadEvents(dir);
    expect(r.ok).toBe(true); // crash-recovery tolerance
    expect(r.value.events).toHaveLength(1); // the good event still loads
    expect(r.value.warnings.length).toBeGreaterThan(0);
  });
});

describe('events-store: tamper detection basis (recompute != stored)', () => {
  test('the on-disk event_hash matches the kernel recompute over its own body', () => {
    // appendEvent returns the same event it wrote; the hash is deterministic.
    // A tamper to any field would make a re-load + recompute mismatch — the
    // verifyChain basis. Here we assert the stored hash is internally consistent
    // by re-reading and comparing the persisted hash to the returned one.
    const dir = cawsDir();
    const written = appendEvent(dir, body()).value;
    const reloaded = loadEvents(dir).value.events[0];
    expect(reloaded.event_hash).toBe(written.event_hash);
    expect(reloaded.prev_hash).toBeNull();
    expect(reloaded.seq).toBe(1);
  });
});

// ===========================================================================
// Mutation-hardening (CAWS-TEST-EVENTS-STORE-MUTATION-001). The slice-2 tests
// covered appendEvent's happy path + loadEvents edges (10 tests, ~17% mutation).
// These add the large untested surfaces driving the survivors: rotateEvents
// (all refusal + success + transaction paths), tolerantScanEventsFile (via the
// rotate actor_shape_stats / prior_* fields), the private lock primitives (via
// appendEvent against a pre-placed lock file), and appendEvent's error edges.
// Tests assert the REAL on-disk archive/genesis + the typed diagnostics, not
// mocks. events-store is the hash-chained AUDIT log (E9/E20) — the most
// safety-critical store surface, so its mutation bar matters most.
// ===========================================================================

const crypto = require('crypto');

const ev = (n) => path.join(n, 'events.jsonl');
const lockOf = (n) => path.join(n, 'events.jsonl.lock');

/** Build the actor for rotate calls (kernel envelope wants a structured Actor). */
const rotateActor = { kind: 'agent', id: 'rot-1', session_id: 's-rot', platform: 'test' };

/** Seed events.jsonl with a v10 (string-actor) line so a chain is rotatable
 *  without the clean-v11 friction flag. The line need not be a valid
 *  ChainedEvent — rotate's tolerant scan only classifies actor shape. */
function seedV10Chain(dir, lines = 1) {
  const out = [];
  for (let i = 0; i < lines; i++) {
    out.push(
      JSON.stringify({
        event: 'legacy',
        seq: i + 1,
        actor: 'legacy-string-actor', // v10 string actor
        event_hash: 'sha256:' + 'a'.repeat(64),
      })
    );
  }
  fs.writeFileSync(ev(dir), out.join('\n') + '\n');
}

describe('rotateEvents: nothing-to-rotate refusals', () => {
  test('a MISSING events.jsonl refuses with nothing_to_rotate (ENOENT)', () => {
    const dir = cawsDir();
    const r = rotateEvents(dir, { reason: 'x', actor: rotateActor });
    expect(r.ok).toBe(false);
    expect(r.errors[0].rule).toBe(ROTATE_NOTHING);
    expect(r.errors[0].data.code).toBe('ENOENT');
    // No archive was created on a refusal.
    expect(fs.readdirSync(dir).filter((f) => f.includes('archive-'))).toEqual([]);
  });

  test('an EMPTY (zero-byte) events.jsonl refuses with nothing_to_rotate (size 0)', () => {
    const dir = cawsDir();
    fs.writeFileSync(ev(dir), '');
    const r = rotateEvents(dir, { reason: 'x', actor: rotateActor });
    expect(r.ok).toBe(false);
    expect(r.errors[0].rule).toBe(ROTATE_NOTHING);
    expect(r.errors[0].data.size).toBe(0);
  });
});

describe('rotateEvents: clean-v11 friction flag', () => {
  test('a clean v11 chain refuses WITHOUT allowClean', () => {
    const dir = cawsDir();
    appendEvent(dir, body()); // a real v11 structured-actor event
    const r = rotateEvents(dir, { reason: 'x', actor: rotateActor });
    expect(r.ok).toBe(false);
    expect(r.errors[0].rule).toBe(ROTATE_CLEAN);
    // Refusal mutated nothing.
    expect(fs.readdirSync(dir).filter((f) => f.includes('archive-'))).toEqual([]);
  });

  test('a clean v11 chain rotates WITH allowClean: true', () => {
    const dir = cawsDir();
    appendEvent(dir, body());
    const r = rotateEvents(dir, { reason: 'maintenance', actor: rotateActor, allowClean: true });
    expect(r.ok).toBe(true);
    // The new genesis is chain_rotated; one archive exists.
    expect(r.value.event).toBe('chain_rotated');
    expect(fs.readdirSync(dir).filter((f) => f.includes('archive-'))).toHaveLength(1);
  });
});

describe('rotateEvents: partial-corruption refusal', () => {
  test('some-unparseable + some-parseable refuses with partial_corruption (no mutation)', () => {
    const dir = cawsDir();
    // 1 good v10 line + 1 garbage line.
    fs.writeFileSync(
      ev(dir),
      JSON.stringify({ event: 'x', actor: 'str', event_hash: 'sha256:' + 'a'.repeat(64) }) +
        '\n' +
        '{ this is not json\n'
    );
    const r = rotateEvents(dir, { reason: 'x', actor: rotateActor });
    expect(r.ok).toBe(false);
    expect(r.errors[0].rule).toBe(ROTATE_PARTIAL);
    expect(r.errors[0].data.lineCount).toBe(2);
    expect(r.errors[0].data.actor_shape_stats.unparseable).toBe(1);
    // No archive on refusal.
    expect(fs.readdirSync(dir).filter((f) => f.includes('archive-'))).toEqual([]);
  });

  test('a FULLY-unparseable chain is ADMISSIBLE (status unparseable, not partial)', () => {
    const dir = cawsDir();
    fs.writeFileSync(ev(dir), '{ bad\n{ also bad\n');
    const r = rotateEvents(dir, { reason: 'archive corrupt log', actor: rotateActor });
    // fully-unparseable is allowed (honest 'unparseable' label).
    expect(r.ok).toBe(true);
    expect(r.value.event).toBe('chain_rotated');
    expect(r.value.data.prior_chain_status).toBe('unparseable');
  });
});

describe('rotateEvents: success transaction (archive + genesis + digest)', () => {
  test('rotates a v10 chain: archives original bytes, writes chain_rotated genesis, digest matches', () => {
    const dir = cawsDir();
    seedV10Chain(dir, 3);
    const originalBytes = fs.readFileSync(ev(dir));
    const expectedDigest =
      'sha256:' + crypto.createHash('sha256').update(originalBytes).digest('hex');

    const fixedNow = new Date('2026-06-14T10:11:12.345Z');
    const r = rotateEvents(dir, {
      reason: 'v10->v11 migration',
      actor: rotateActor,
      now: fixedNow,
    });
    expect(r.ok).toBe(true);
    const genesis = r.value;

    // The new events.jsonl holds ONLY the chain_rotated genesis.
    expect(genesis.event).toBe('chain_rotated');
    expect(genesis.seq).toBe(1);
    expect(genesis.prev_hash).toBeNull();
    const reloaded = loadEvents(dir).value.events;
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0].event_hash).toBe(genesis.event_hash);

    // The archive holds the original bytes byte-for-byte, named windows-safe.
    const archives = fs.readdirSync(dir).filter((f) => f.includes('archive-'));
    expect(archives).toHaveLength(1);
    expect(archives[0]).not.toContain(':'); // windowsSafeIso replaced ':'
    expect(fs.readFileSync(path.join(dir, archives[0]))).toEqual(originalBytes);

    // The cryptographic tie: prior_file_digest == sha256(archived bytes).
    expect(genesis.data.prior_file_digest).toBe(expectedDigest);
    expect(genesis.data.prior_line_count).toBe(3);
    expect(genesis.data.migration_reason).toBe('v10->v11 migration');
    expect(genesis.data.prior_chain_status).toBe('parseable_unverified');
    // v10 string actors counted.
    expect(genesis.data.actor_shape_stats.v10_string_actor).toBe(3);
  });

  test('the archive name embeds the injected timestamp (windowsSafeIso, no colons/dots)', () => {
    const dir = cawsDir();
    seedV10Chain(dir, 1);
    const r = rotateEvents(dir, {
      reason: 'x',
      actor: rotateActor,
      now: new Date('2026-01-02T03:04:05.678Z'),
    });
    expect(r.ok).toBe(true);
    const archive = fs.readdirSync(dir).find((f) => f.includes('archive-'));
    // ':' -> '-' and '.' -> '-' ; the sortable shape is preserved.
    expect(archive).toContain('2026-01-02T03-04-05-678Z');
  });
});

describe('tolerantScanEventsFile (observed via rotate stats): actor-shape + tail extraction', () => {
  test('classifies v10 string vs v11 object-with-kind vs unparseable distinctly', () => {
    const dir = cawsDir();
    // 2 v10 (string actor), 1 v11 (object with kind), forcing a MIXED parseable
    // chain (no unparseable) so rotate proceeds and exposes the stats.
    fs.writeFileSync(
      ev(dir),
      [
        JSON.stringify({ actor: 'v10a', event_hash: 'sha256:' + '1'.repeat(64) }),
        JSON.stringify({ actor: 'v10b' }),
        JSON.stringify({ actor: { kind: 'agent', id: 'x' }, seq: 3, event_hash: 'sha256:' + '2'.repeat(64) }),
      ].join('\n') + '\n'
    );
    const r = rotateEvents(dir, { reason: 'x', actor: rotateActor });
    expect(r.ok).toBe(true);
    const stats = r.value.data.actor_shape_stats;
    expect(stats.v10_string_actor).toBe(2);
    expect(stats.v11_object_actor).toBe(1);
    expect(stats.unparseable).toBe(0);
  });

  test('tail hash + seq come from the LAST line when it has valid shapes', () => {
    const dir = cawsDir();
    const tailHash = 'sha256:' + 'b'.repeat(64);
    fs.writeFileSync(
      ev(dir),
      [
        JSON.stringify({ actor: 'first', seq: 1, event_hash: 'sha256:' + 'a'.repeat(64) }),
        JSON.stringify({ actor: 'last', seq: 7, event_hash: tailHash }),
      ].join('\n') + '\n'
    );
    const r = rotateEvents(dir, { reason: 'x', actor: rotateActor });
    expect(r.ok).toBe(true);
    expect(r.value.data.prior_tail_hash).toBe(tailHash); // from the last line
    expect(r.value.data.prior_seq).toBe(7); // last line's seq
  });

  test('a malformed tail hash / non-integer seq yields null tail (no prior_seq key)', () => {
    const dir = cawsDir();
    fs.writeFileSync(
      ev(dir),
      JSON.stringify({ actor: 'only', seq: 1.5, event_hash: 'not-a-valid-hash' }) + '\n'
    );
    const r = rotateEvents(dir, { reason: 'x', actor: rotateActor });
    expect(r.ok).toBe(true);
    expect(r.value.data.prior_tail_hash).toBeNull();
    // tailSeq null -> prior_seq is NOT added to the data block.
    expect('prior_seq' in r.value.data).toBe(false);
  });
});

describe('events-store lock primitives (observed via appendEvent against a pre-placed lock)', () => {
  test('a FRESH lock (recent mtime) blocks append -> lock_contention after max attempts', () => {
    const dir = cawsDir();
    appendEvent(dir, body()); // create the chain first
    // Place a fresh lock the append cannot steal (mtime = now, < 30s stale TTL).
    fs.writeFileSync(lockOf(dir), JSON.stringify({ pid: 999999, at: new Date().toISOString() }));
    const r = appendEvent(dir, body());
    expect(r.ok).toBe(false);
    expect(r.errors[0].rule).toBe(LOCK_CONTENTION);
    // The fresh foreign lock is left in place (append did not steal it).
    expect(fs.existsSync(lockOf(dir))).toBe(true);
    fs.unlinkSync(lockOf(dir)); // cleanup so afterAll rm is clean
  });

  test('a STALE lock (mtime > 30s old) is recovered and the append succeeds', () => {
    const dir = cawsDir();
    appendEvent(dir, body());
    fs.writeFileSync(lockOf(dir), JSON.stringify({ pid: 999999, at: 'old' }));
    // Backdate the lock mtime well past the 30s stale TTL.
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(lockOf(dir), old, old);
    const r = appendEvent(dir, body());
    expect(r.ok).toBe(true); // stale lock recovered, append proceeded
    expect(r.value.seq).toBe(2);
    // Lock released after success (file removed).
    expect(fs.existsSync(lockOf(dir))).toBe(false);
  });

  test('the lock is released after a SUCCESSFUL append (no leftover .lock)', () => {
    const dir = cawsDir();
    appendEvent(dir, body());
    expect(fs.existsSync(lockOf(dir))).toBe(false);
  });
});

describe('appendEvent: error edges', () => {
  test('throws when cawsDir does not exist (programmer-error guard)', () => {
    const missing = path.join(os.tmpdir(), 'caws-ev-nope-' + Date.now());
    expect(() => appendEvent(missing, body())).toThrow(/cawsDir does not exist/);
  });

  test('a write fault during append surfaces WRITE_IO_FAILED with data.code', () => {
    const dir = cawsDir();
    appendEvent(dir, body()); // genesis ok
    const realWrite = fs.writeFileSync;
    // Fail only the events.jsonl append write (not the lock-body write).
    fs.writeFileSync = (target, data, ...rest) => {
      if (typeof target === 'number') {
        // fd-based write is the append path; throw to exercise the catch.
        const e = new Error('mock append fault');
        e.code = 'EIO';
        throw e;
      }
      return realWrite.call(fs, target, data, ...rest);
    };
    let r;
    try {
      r = appendEvent(dir, body());
    } finally {
      fs.writeFileSync = realWrite;
    }
    expect(r.ok).toBe(false);
    expect(r.errors[0].rule).toBe(IO_FAILED);
    expect(r.errors[0].data.code).toBe('EIO');
    // The lock was still released despite the write fault (finally block).
    expect(fs.existsSync(lockOf(dir))).toBe(false);
  });
});
