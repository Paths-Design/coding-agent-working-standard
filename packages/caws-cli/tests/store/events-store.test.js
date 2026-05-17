/**
 * Tests for events-store: load tolerance + append correctness.
 *
 *   - missing file → Ok({events: [], warnings: []})
 *   - empty file → Ok({events: [], warnings: []})
 *   - valid 2-event chain → Ok(2 events, no warnings)
 *   - trailing partial line → Ok(events, warnings: [trailing])
 *   - interior malformed line → Err
 *   - invalid event shape → Err
 *   - appendEvent uses prepareAppend and refuses pre-chained input
 *   - appendEvent acquires + releases the lock
 *   - appendEvent recovers a stale lock
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  appendEvent,
  loadEvents,
  STORE_RULES,
} = require('../../dist/store');

function mkTempCawsDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'caws-events-store-'));
}

const VALID_BODY_1 = {
  event: 'spec_created',
  ts: '2026-05-12T10:00:00.000Z',
  actor: { kind: 'agent', id: 'darian' },
  spec_id: 'X-1',
  data: { title: 'Test feature', risk_tier: 2, mode: 'feature', lifecycle_state: 'draft' },
};
const VALID_BODY_2 = {
  event: 'spec_validated',
  ts: '2026-05-12T10:01:00.000Z',
  actor: { kind: 'agent', id: 'darian' },
  spec_id: 'X-1',
  data: { passed: true, error_count: 0, warning_count: 0 },
};

describe('loadEvents — tolerance and errors', () => {
  let cawsDir;
  afterEach(() => fs.rmSync(cawsDir, { recursive: true, force: true }));

  it('missing file → Ok empty', () => {
    cawsDir = mkTempCawsDir();
    const r = loadEvents(cawsDir);
    expect(r.ok).toBe(true);
    expect(r.value.events).toEqual([]);
    expect(r.value.warnings).toEqual([]);
  });

  it('empty file → Ok empty', () => {
    cawsDir = mkTempCawsDir();
    fs.writeFileSync(path.join(cawsDir, 'events.jsonl'), '');
    const r = loadEvents(cawsDir);
    expect(r.ok).toBe(true);
    expect(r.value.events).toEqual([]);
  });

  it('round-trips a written chain through loadEvents', () => {
    cawsDir = mkTempCawsDir();
    const a = appendEvent(cawsDir, VALID_BODY_1);
    expect(a.ok).toBe(true);
    const b = appendEvent(cawsDir, VALID_BODY_2);
    expect(b.ok).toBe(true);
    const r = loadEvents(cawsDir);
    expect(r.ok).toBe(true);
    expect(r.value.events).toHaveLength(2);
    expect(r.value.events[0].seq).toBe(1);
    expect(r.value.events[1].seq).toBe(2);
    expect(r.value.events[1].prev_hash).toBe(r.value.events[0].event_hash);
  });

  it('trailing partial line → Ok + warning', () => {
    cawsDir = mkTempCawsDir();
    // First append a valid event normally.
    const ok = appendEvent(cawsDir, VALID_BODY_1);
    expect(ok.ok).toBe(true);
    // Then corrupt the file by appending a partial JSON line WITHOUT trailing newline.
    fs.appendFileSync(path.join(cawsDir, 'events.jsonl'), '{"event":"spec_');
    const r = loadEvents(cawsDir);
    expect(r.ok).toBe(true);
    expect(r.value.events).toHaveLength(1);
    expect(r.value.warnings).toHaveLength(1);
    expect(r.value.warnings[0].rule).toBe(STORE_RULES.EVENTS_TRAILING_PARTIAL_LINE);
  });

  it('interior malformed line → Err', () => {
    cawsDir = mkTempCawsDir();
    // Manually craft: valid line, BAD line with newline, valid line.
    const eventsPath = path.join(cawsDir, 'events.jsonl');
    // Append one valid event first, capture its JSON line for re-use.
    const ok = appendEvent(cawsDir, VALID_BODY_1);
    expect(ok.ok).toBe(true);
    fs.appendFileSync(eventsPath, 'this is not json\n');
    // Add a valid third line; we don't care about chain integrity for
    // this test — we only care that load reports interior malformed line.
    fs.appendFileSync(eventsPath, JSON.stringify(ok.value) + '\n');
    const r = loadEvents(cawsDir);
    expect(r.ok).toBe(false);
    expect(r.errors[0].rule).toBe(STORE_RULES.EVENTS_INTERIOR_MALFORMED_LINE);
  });

  it('invalid event shape → Err with EVENTS_INVALID_EVENT_SHAPE', () => {
    cawsDir = mkTempCawsDir();
    // A line that parses as JSON but is not a valid ChainedEvent.
    fs.writeFileSync(
      path.join(cawsDir, 'events.jsonl'),
      JSON.stringify({ event: 'spec_created' }) + '\n'
    );
    const r = loadEvents(cawsDir);
    expect(r.ok).toBe(false);
    expect(r.errors[0].rule).toBe(STORE_RULES.EVENTS_INVALID_EVENT_SHAPE);
  });
});

describe('appendEvent — semantics', () => {
  let cawsDir;
  afterEach(() => fs.rmSync(cawsDir, { recursive: true, force: true }));

  it('genesis: seq=1, prev_hash=null', () => {
    cawsDir = mkTempCawsDir();
    const r = appendEvent(cawsDir, VALID_BODY_1);
    expect(r.ok).toBe(true);
    expect(r.value.seq).toBe(1);
    expect(r.value.prev_hash).toBeNull();
    expect(r.value.event_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('chains: seq increments and prev_hash links', () => {
    cawsDir = mkTempCawsDir();
    const a = appendEvent(cawsDir, VALID_BODY_1);
    const b = appendEvent(cawsDir, VALID_BODY_2);
    expect(a.ok && b.ok).toBe(true);
    expect(b.value.seq).toBe(2);
    expect(b.value.prev_hash).toBe(a.value.event_hash);
  });

  it('release lock after success: subsequent append acquires cleanly', () => {
    cawsDir = mkTempCawsDir();
    const a = appendEvent(cawsDir, VALID_BODY_1);
    expect(a.ok).toBe(true);
    // No stray lockfile should remain.
    expect(fs.existsSync(path.join(cawsDir, 'events.jsonl.lock'))).toBe(false);
    const b = appendEvent(cawsDir, VALID_BODY_2);
    expect(b.ok).toBe(true);
  });

  it('rejects a kernel-invalid body with EVENTS_PREPARE_APPEND_REJECTED', () => {
    cawsDir = mkTempCawsDir();
    // Missing required `actor`.
    const r = appendEvent(cawsDir, {
      event: 'spec_created',
      ts: '2026-05-12T10:00:00.000Z',
      spec_id: 'X-1',
      data: { title: 'X', risk_tier: 2, mode: 'feature', lifecycle_state: 'draft' },
    });
    expect(r.ok).toBe(false);
    expect(r.errors[0].rule).toBe(STORE_RULES.EVENTS_PREPARE_APPEND_REJECTED);
    // No file should have been created.
    expect(fs.existsSync(path.join(cawsDir, 'events.jsonl'))).toBe(false);
  });

  it('recovers a stale lock file (>30s old)', () => {
    cawsDir = mkTempCawsDir();
    const lockPath = path.join(cawsDir, 'events.jsonl.lock');
    fs.writeFileSync(lockPath, '{}');
    // Backdate the lock mtime to 60s ago.
    const sixtySecAgo = Date.now() - 60_000;
    fs.utimesSync(lockPath, sixtySecAgo / 1000, sixtySecAgo / 1000);

    const r = appendEvent(cawsDir, VALID_BODY_1);
    expect(r.ok).toBe(true);
    // After success the lock is released.
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('throws on programmer error: cawsDir does not exist', () => {
    expect(() =>
      appendEvent('/tmp/this-dir-does-not-exist-caws-test', VALID_BODY_1)
    ).toThrow();
  });
});
