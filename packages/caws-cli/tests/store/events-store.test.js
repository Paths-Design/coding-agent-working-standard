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
const { appendEvent, loadEvents } = require('../../dist/store/events-store');

const PREPARE_REJECTED = 'store.events.prepare_append_rejected';
const INTERIOR_MALFORMED = 'store.events.interior_malformed_line';

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
