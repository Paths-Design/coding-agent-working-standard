'use strict';

/**
 * Contract tests for CAWS-AGENTS-SHOW-LIVENESS-CLASSIFY-01.
 *
 * `caws agents show` dumped the persisted lease record and nothing else. The
 * on-disk `status` enum is exactly {active, stopping, stopped} — the kernel
 * never writes 'stale', because materializing it would mean one session
 * writing another session's lease file. Staleness is a read-time TTL
 * classification. So a session whose lease says `status: active` and whose
 * last_active is nine hours old was reported by `agents show` as active while
 * `agents list` bucketed it stale: one field being read as two different
 * facts.
 *
 * These tests pin that both facts are present, separately labelled, and that
 * the TTL rule has exactly ONE implementation — the kernel's. The boundary
 * pair (age == ttl vs age == ttl + 1) is the discriminating case: a local
 * re-derivation that used `>=` instead of `>` would pass everything else and
 * fail there.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  runAgentsRegisterCommand,
  runAgentsShowCommand,
  runAgentsListCommand,
} = require('../../dist/shell/commands/agents');
const { initProject } = require('../../dist/store/init-store');

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const T0 = new Date('2026-09-19T12:00:00.000Z');

const repos = [];
afterAll(() => {
  for (const r of repos) {
    try {
      fs.rmSync(r, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function mkRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-showlive-'));
  execFileSync('git', ['init', '--quiet', '-b', 'main', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 't@test.com']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
  execFileSync('git', ['-C', root, 'commit', '--quiet', '--allow-empty', '-m', 'init']);
  const r = initProject(root);
  if (!r.ok) throw new Error('initProject failed: ' + JSON.stringify(r.errors));
  repos.push(root);
  return root;
}

function sinks() {
  const out = [];
  const err = [];
  return { out, err, outFn: (l) => out.push(l), errFn: (l) => err.push(l) };
}

function register(root, sid) {
  const s = sinks();
  const code = runAgentsRegisterCommand({
    sessionId: sid,
    platform: 'test',
    cwd: root,
    env: { ...process.env },
    out: s.outFn,
    err: s.errFn,
  });
  if (code !== 0) throw new Error('register failed: ' + s.err.join('\n'));
}

function leasePath(root, sid) {
  return path.join(root, '.caws', 'leases', `${sid}.json`);
}

function readLease(root, sid) {
  return JSON.parse(fs.readFileSync(leasePath(root, sid), 'utf8'));
}

function patchLease(root, sid, patch) {
  const p = leasePath(root, sid);
  const lease = JSON.parse(fs.readFileSync(p, 'utf8'));
  fs.writeFileSync(p, JSON.stringify({ ...lease, ...patch }, null, 2));
}

/** Age a lease by setting last_active to `ageMs` before T0. */
function ageLease(root, sid, ageMs) {
  patchLease(root, sid, { last_active: new Date(T0.getTime() - ageMs).toISOString() });
}

function show(root, sid, extra = {}) {
  const s = sinks();
  const code = runAgentsShowCommand({
    id: sid,
    cwd: root,
    env: { ...process.env },
    now: () => T0,
    out: s.outFn,
    err: s.errFn,
    ...extra,
  });
  return { code, out: s.out, err: s.err, text: s.out.join('\n') };
}

function showJson(root, sid, extra = {}) {
  const r = show(root, sid, { ...extra, json: true });
  return { ...r, payload: JSON.parse(r.out.join('\n')) };
}

function listJson(root, extra = {}) {
  const s = sinks();
  const code = runAgentsListCommand({
    cwd: root,
    env: { ...process.env },
    now: () => T0,
    json: true,
    out: s.outFn,
    err: s.errFn,
    ...extra,
  });
  return { code, payload: JSON.parse(s.out.join('\n')) };
}

describe('CAWS-AGENTS-SHOW-LIVENESS-CLASSIFY-01', () => {
  // ── B1: the two facts are distinct and both present ────────────────────
  test('B1: a lease persisted active but aged past the TTL reports status active AND liveness stale', () => {
    const root = mkRepo();
    register(root, 'sess-b1');
    ageLease(root, 'sess-b1', 9 * 60 * 60 * 1000); // 9h

    const { code, payload } = showJson(root, 'sess-b1');
    expect(code).toBe(0);
    // The persisted record is returned unchanged...
    expect(payload.lease.status).toBe('active');
    // ...and the derived verdict disagrees with it, which is the point.
    expect(payload.liveness.classification).toBe('stale');
    expect(payload.liveness.persisted_status).toBe('active');
    expect(payload.liveness.agrees_with_persisted_status).toBe(false);
    expect(payload.liveness.source).toBe('derived');
  });

  test('B1b: the human rendering labels each fact with where it came from', () => {
    const root = mkRepo();
    register(root, 'sess-b1b');
    ageLease(root, 'sess-b1b', 9 * 60 * 60 * 1000);

    const r = show(root, 'sess-b1b');
    expect(r.code).toBe(0);
    expect(r.text).toMatch(/persisted status:\s+active/);
    expect(r.text).toMatch(/derived liveness:\s+stale/);
    // The label must say the derived verdict is not on disk, or a reader has
    // no way to know which of the two the lease file actually contains.
    expect(r.text).toContain('not persisted');
  });

  test('B1c: a fresh lease agrees with its persisted status, and says so', () => {
    const root = mkRepo();
    register(root, 'sess-b1c');
    ageLease(root, 'sess-b1c', 60 * 1000); // 1m — well inside the TTL

    const { payload } = showJson(root, 'sess-b1c');
    expect(payload.liveness.classification).toBe('active');
    expect(payload.liveness.agrees_with_persisted_status).toBe(true);
  });

  test('B1d: a stopped lease classifies stopped regardless of age', () => {
    const root = mkRepo();
    register(root, 'sess-b1d');
    patchLease(root, 'sess-b1d', { status: 'stopped' });
    ageLease(root, 'sess-b1d', 9 * 60 * 60 * 1000);

    const { payload } = showJson(root, 'sess-b1d');
    expect(payload.lease.status).toBe('stopped');
    expect(payload.liveness.classification).toBe('stopped');
    expect(payload.liveness.agrees_with_persisted_status).toBe(true);
  });

  test('B1e: a fresh "stopping" lease classifies active, and the mismatch is literal, not a fault', () => {
    // `stopping` is a lifecycle phase with no counterpart among the liveness
    // buckets, so agrees_with_persisted_status is false here even though
    // nothing is wrong. Pinning it keeps that a documented consequence of a
    // value comparison rather than something a reader discovers as a bug.
    const root = mkRepo();
    register(root, 'sess-b1e');
    patchLease(root, 'sess-b1e', { status: 'stopping' });
    ageLease(root, 'sess-b1e', 60 * 1000);

    const { payload } = showJson(root, 'sess-b1e');
    expect(payload.lease.status).toBe('stopping');
    expect(payload.liveness.classification).toBe('active');
    expect(payload.liveness.agrees_with_persisted_status).toBe(false);
  });

  // ── the single-implementation invariant ────────────────────────────────
  test('B2: show and list place the same lease in the same bucket at the same instant', () => {
    const root = mkRepo();
    register(root, 'sess-b2');
    ageLease(root, 'sess-b2', 9 * 60 * 60 * 1000);

    const shown = showJson(root, 'sess-b2');
    const listed = listJson(root, { includeStale: true });

    expect(shown.payload.liveness.classification).toBe('stale');
    expect(listed.payload.stale.map((l) => l.session_id)).toContain('sess-b2');
    expect(listed.payload.active.map((l) => l.session_id)).not.toContain('sess-b2');
  });

  test('B2b: at exactly the TTL the lease is still active — the kernel rule is `age > ttl`, strictly', () => {
    // The discriminating case for "one implementation". A local re-derivation
    // written with >= instead of > passes every other test in this file and
    // fails only here.
    const root = mkRepo();
    register(root, 'sess-boundary-eq');
    ageLease(root, 'sess-boundary-eq', DEFAULT_TTL_MS);

    const shown = showJson(root, 'sess-boundary-eq');
    const listed = listJson(root, { includeStale: true });
    expect(shown.payload.liveness.classification).toBe('active');
    expect(listed.payload.active.map((l) => l.session_id)).toContain('sess-boundary-eq');
  });

  test('B2c: one millisecond past the TTL it is stale, in both surfaces', () => {
    const root = mkRepo();
    register(root, 'sess-boundary-gt');
    ageLease(root, 'sess-boundary-gt', DEFAULT_TTL_MS + 1);

    const shown = showJson(root, 'sess-boundary-gt');
    const listed = listJson(root, { includeStale: true });
    expect(shown.payload.liveness.classification).toBe('stale');
    expect(listed.payload.stale.map((l) => l.session_id)).toContain('sess-boundary-gt');
  });

  test('B2d: an unparseable last_active is treated as infinitely stale, and the age is not invented', () => {
    const root = mkRepo();
    register(root, 'sess-unparseable');
    patchLease(root, 'sess-unparseable', { last_active: 'not-a-timestamp' });

    const { payload } = showJson(root, 'sess-unparseable');
    expect(payload.liveness.classification).toBe('stale');
    // No age can be computed from a timestamp that does not parse; reporting
    // a number here would be fabricating one.
    expect(payload.liveness.last_active_age_ms).toBeNull();
  });

  // ── B3: the threshold is selectable and disclosed ──────────────────────
  test('B3: --stale-ttl-ms changes the verdict and the TTL used is disclosed', () => {
    const root = mkRepo();
    register(root, 'sess-b3');
    ageLease(root, 'sess-b3', 10 * 60 * 1000); // 10m: fresh at 30m, stale at 5m

    const dflt = showJson(root, 'sess-b3');
    expect(dflt.payload.liveness.classification).toBe('active');
    expect(dflt.payload.liveness.ttl_ms).toBe(DEFAULT_TTL_MS);

    const tight = showJson(root, 'sess-b3', { staleTtlMs: 5 * 60 * 1000 });
    expect(tight.payload.liveness.classification).toBe('stale');
    expect(tight.payload.liveness.ttl_ms).toBe(5 * 60 * 1000);

    // Same lease, same instant, different threshold — so the threshold has to
    // be visible or the two verdicts look like a contradiction.
    const tightText = show(root, 'sess-b3', { staleTtlMs: 5 * 60 * 1000 });
    expect(tightText.text).toContain('300000');
  });

  // ── B4: parity ─────────────────────────────────────────────────────────
  test('B4: the human and --json renderings carry the same four facts', () => {
    const root = mkRepo();
    register(root, 'sess-b4');
    ageLease(root, 'sess-b4', 9 * 60 * 60 * 1000);

    const { payload } = showJson(root, 'sess-b4');
    const text = show(root, 'sess-b4').text;

    expect(text).toContain(payload.liveness.persisted_status);
    expect(text).toContain(payload.liveness.classification);
    expect(text).toContain(String(payload.liveness.ttl_ms));
    expect(text).toContain(String(payload.liveness.last_active_age_ms));
    // The record itself is still reachable from the human form.
    expect(text).toContain('"session_id": "sess-b4"');
  });

  test('B4b: a missing lease still refuses the same way in both renderings', () => {
    const root = mkRepo();
    const j = show(root, 'sess-absent', { json: true });
    expect(j.code).toBe(1);
    expect(JSON.parse(j.out.join('\n'))).toMatchObject({ ok: false, error: 'not_found' });

    const h = show(root, 'sess-absent');
    expect(h.code).toBe(1);
    expect(h.err.join('\n')).toContain('no lease for "sess-absent"');
  });

  // ── the classification is never written back ───────────────────────────
  test('showing a stale lease does not write "stale" to disk', () => {
    // Load-bearing: 'stale' is read-side only. Persisting it would mean this
    // session writing another session's lease file, which breaks the
    // per-session-file ownership that makes atomic writes safe.
    const root = mkRepo();
    register(root, 'sess-nowrite');
    ageLease(root, 'sess-nowrite', 9 * 60 * 60 * 1000);
    const before = readLease(root, 'sess-nowrite');
    const beforeMtime = fs.statSync(leasePath(root, 'sess-nowrite')).mtimeMs;

    expect(showJson(root, 'sess-nowrite').payload.liveness.classification).toBe('stale');

    const after = readLease(root, 'sess-nowrite');
    expect(after.status).toBe('active');
    expect(after).toEqual(before);
    expect(fs.statSync(leasePath(root, 'sess-nowrite')).mtimeMs).toBe(beforeMtime);
  });
});
