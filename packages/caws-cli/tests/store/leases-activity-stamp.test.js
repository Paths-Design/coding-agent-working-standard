'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  applyLeasePatch,
  leaseActivityStampPath,
  loadLeases,
  touchLeaseActivity,
} = require('../../dist/store/leases-store');

const RECORDED = '2026-10-20T12:00:00.000Z';
const LATER = new Date('2026-10-20T12:05:00.000Z');
const EARLIER = new Date('2026-10-20T11:00:00.000Z');

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture(sessions = ['stamped']) {
  const cawsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-lease-stamp-'));
  roots.push(cawsDir);
  fs.mkdirSync(path.join(cawsDir, 'leases'));
  for (const session of sessions)
    fs.writeFileSync(
      path.join(cawsDir, 'leases', session + '.json'),
      JSON.stringify({ session_id: session, status: 'active', last_active: RECORDED })
    );
  return cawsDir;
}
function stamp(cawsDir, session, at) {
  const file = leaseActivityStampPath(cawsDir, session);
  fs.writeFileSync(file, '');
  fs.utimesSync(file, at, at);
  return file;
}

test('a stamp later than the recorded value becomes the reported last_active', () => {
  const cawsDir = fixture(['stamped', 'plain']);
  stamp(cawsDir, 'stamped', LATER);
  const loaded = loadLeases(cawsDir).value;
  expect(loaded.leases.stamped.last_active).toBe(LATER.toISOString());
  expect(loaded.recordedLastActive).toEqual({ stamped: RECORDED });
  // A session without a stamp is untouched, and the lease file is never rewritten.
  expect(loaded.leases.plain.last_active).toBe(RECORDED);
  expect(
    JSON.parse(fs.readFileSync(path.join(cawsDir, 'leases/stamped.json'), 'utf8')).last_active
  ).toBe(RECORDED);
});

test('a stamp older than the recorded value never moves last_active backward', () => {
  const cawsDir = fixture();
  stamp(cawsDir, 'stamped', EARLIER);
  const loaded = loadLeases(cawsDir).value;
  expect(loaded.leases.stamped.last_active).toBe(RECORDED);
  expect(loaded.recordedLastActive).toEqual({});
});

test('a stamp dated in the future is a clock fault and is ignored', () => {
  const cawsDir = fixture();
  stamp(cawsDir, 'stamped', new Date(Date.now() + 3_600_000));
  expect(loadLeases(cawsDir).value.leases.stamped.last_active).toBe(RECORDED);
});

test('a stamp without a lease creates no lease and no diagnostic', () => {
  const cawsDir = fixture([]);
  stamp(cawsDir, 'ghost', LATER);
  const loaded = loadLeases(cawsDir).value;
  expect(loaded.leases).toEqual({});
  expect(loaded.diagnostics).toEqual([]);
});

test('a stamp does not repair a lease whose recorded last_active does not parse', () => {
  const cawsDir = fixture([]);
  fs.writeFileSync(
    path.join(cawsDir, 'leases/broken.json'),
    JSON.stringify({ session_id: 'broken', status: 'active', last_active: 'not a date' })
  );
  stamp(cawsDir, 'broken', LATER);
  expect(loadLeases(cawsDir).value.leases.broken.last_active).toBe('not a date');
});

test('a stamp that is not a regular file is ignored', () => {
  const cawsDir = fixture();
  const target = path.join(cawsDir, 'elsewhere');
  fs.writeFileSync(target, '');
  fs.utimesSync(target, LATER, LATER);
  fs.symlinkSync(target, leaseActivityStampPath(cawsDir, 'stamped'));
  expect(loadLeases(cawsDir).value.leases.stamped.last_active).toBe(RECORDED);
});

test('touching activity stamps a leased session at the given instant', () => {
  const cawsDir = fixture();
  expect(touchLeaseActivity(cawsDir, 'stamped', LATER)).toBe(true);
  expect(fs.statSync(leaseActivityStampPath(cawsDir, 'stamped')).mtimeMs).toBe(LATER.getTime());
  expect(loadLeases(cawsDir).value.leases.stamped.last_active).toBe(LATER.toISOString());
});

test('touching activity refuses a session with no lease, an unsafe id, and the unknown id', () => {
  const cawsDir = fixture();
  fs.writeFileSync(path.join(cawsDir, 'escape.json'), '{}');
  fs.writeFileSync(path.join(cawsDir, 'leases/unknown.json'), '{"session_id":"unknown"}');
  expect(touchLeaseActivity(cawsDir, 'absent', LATER)).toBe(false);
  expect(touchLeaseActivity(cawsDir, '../escape', LATER)).toBe(false);
  expect(touchLeaseActivity(cawsDir, 'unknown', LATER)).toBe(false);
  expect(fs.readdirSync(path.join(cawsDir, 'leases')).sort()).toEqual([
    'stamped.json',
    'unknown.json',
  ]);
  expect(fs.existsSync(path.join(cawsDir, 'escape.active'))).toBe(false);
});

test('a stop with a later stamp present never writes the stamp time into the lease', () => {
  const cawsDir = fixture();
  stamp(cawsDir, 'stamped', LATER);
  const result = applyLeasePatch(cawsDir, {
    kind: 'mark_stopped',
    session_id: 'stamped',
    transitioned_at: '2026-10-20T12:06:00.000Z',
  });
  expect(result.ok).toBe(true);
  const written = JSON.parse(fs.readFileSync(path.join(cawsDir, 'leases/stamped.json'), 'utf8'));
  expect(written.status).toBe('stopped');
  expect(written.last_active).toBe(RECORDED);
  // Readers still see the later activity; it lives only in the stamp.
  expect(loadLeases(cawsDir).value.leases.stamped.last_active).toBe(LATER.toISOString());
});

test('deleting a lease removes every sidecar, and only that session`s', () => {
  const cawsDir = fixture(['gone', 'kept']);
  const leases = path.join(cawsDir, 'leases');
  for (const session of ['gone', 'kept'])
    for (const suffix of ['.active', '.hb', '.hb.lease', '.mail'])
      fs.writeFileSync(path.join(leases, session + suffix), '');
  const result = applyLeasePatch(cawsDir, { kind: 'delete_lease', session_id: 'gone' });
  expect(result.ok).toBe(true);
  expect(fs.readdirSync(leases).sort()).toEqual([
    'kept.active',
    'kept.hb',
    'kept.hb.lease',
    'kept.json',
    'kept.mail',
  ]);
});

test('deleting an already absent lease still clears sidecars left behind', () => {
  const cawsDir = fixture([]);
  stamp(cawsDir, 'orphan', LATER);
  const result = applyLeasePatch(cawsDir, { kind: 'delete_lease', session_id: 'orphan' });
  expect(result.ok).toBe(true);
  expect(fs.readdirSync(path.join(cawsDir, 'leases'))).toEqual([]);
});
