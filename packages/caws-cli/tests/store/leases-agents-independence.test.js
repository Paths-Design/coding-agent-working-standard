/**
 * Negative-invariant tests proving .caws/agents.json and the lease
 * substrate are independent surfaces.
 *
 * MULTI-AGENT-ACTIVITY-REGISTRY-001 acceptance A12.
 *
 * Spec invariant 11: "Leases and agents.json are independent: deleting
 * or corrupting .caws/agents.json must not break lease load, write, list,
 * register, heartbeat, stop, status, or the future canonical-checkout
 * guard."
 *
 * These tests prove the new model is NOT secretly dependent on the
 * legacy substrate. If a future change couples the two (e.g. lease
 * operations start reading agents.json for identity continuity), these
 * tests catch it.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  loadLeases,
  applyLeasePatch,
  pruneLeasesByStatus,
  loadAgents,
} = require('../../dist/store');

function mkTempCawsDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'caws-lease-indep-'));
}

function makeLease(sessionId) {
  return {
    lease_version: 1,
    session_id: sessionId,
    platform: 'claude-code',
    status: 'active',
    started_at: '2026-05-23T10:00:00.000Z',
    last_active: '2026-05-23T10:00:30.000Z',
    repo_root: '/test/repo',
    cwd: '/test/repo',
    git_common_dir: '/test/repo/.git',
    git_dir: '/test/repo/.git',
    last_seen_reason: 'pre_tool_use',
  };
}

describe('leases ↔ agents.json independence (A12)', () => {
  let cawsDir;
  afterEach(() => fs.rmSync(cawsDir, { recursive: true, force: true }));

  it('case (a): agents.json absent → loadLeases / applyLeasePatch / prune all work', () => {
    cawsDir = mkTempCawsDir();
    expect(fs.existsSync(path.join(cawsDir, 'agents.json'))).toBe(false);

    // Write lease.
    const r1 = applyLeasePatch(cawsDir, {
      kind: 'write_lease',
      session_id: 'caws-A',
      lease: makeLease('caws-A'),
    });
    expect(r1.ok).toBe(true);
    expect(r1.value.wrote).toBe(true);

    // Load leases.
    const r2 = loadLeases(cawsDir);
    expect(r2.ok).toBe(true);
    expect(Object.keys(r2.value.leases)).toEqual(['caws-A']);

    // Prune (dry-run).
    const r3 = pruneLeasesByStatus(cawsDir, {
      status: 'stopped',
      retentionMs: 0,
      now: new Date('2026-05-23T12:00:00.000Z'),
    });
    expect(r3.ok).toBe(true);

    // agents.json STILL absent — we never touched it.
    expect(fs.existsSync(path.join(cawsDir, 'agents.json'))).toBe(false);
  });

  it('case (b): agents.json corrupted to "not json" → lease ops still work', () => {
    cawsDir = mkTempCawsDir();
    fs.writeFileSync(path.join(cawsDir, 'agents.json'), 'not json');

    // Sanity check: loadAgents WOULD fail on this (legacy strict loader).
    const agentsRes = loadAgents(cawsDir);
    expect(agentsRes.ok).toBe(false);

    // But lease operations are unaffected.
    const r1 = applyLeasePatch(cawsDir, {
      kind: 'write_lease',
      session_id: 'caws-B',
      lease: makeLease('caws-B'),
    });
    expect(r1.ok).toBe(true);

    const r2 = loadLeases(cawsDir);
    expect(r2.ok).toBe(true);
    expect(Object.keys(r2.value.leases)).toEqual(['caws-B']);
  });

  it('case (c): agents.json deleted MID-OPERATION → still works', () => {
    cawsDir = mkTempCawsDir();
    fs.writeFileSync(
      path.join(cawsDir, 'agents.json'),
      JSON.stringify({ 'caws-X': { session_id: 'caws-X', last_active: '2026-05-22T00:00:00.000Z' } })
    );

    // Write a lease.
    applyLeasePatch(cawsDir, {
      kind: 'write_lease',
      session_id: 'caws-X',
      lease: makeLease('caws-X'),
    });

    // Delete agents.json.
    fs.unlinkSync(path.join(cawsDir, 'agents.json'));

    // Lease operations still succeed.
    const r1 = loadLeases(cawsDir);
    expect(r1.ok).toBe(true);
    expect(Object.keys(r1.value.leases)).toEqual(['caws-X']);

    const r2 = applyLeasePatch(cawsDir, {
      kind: 'mark_stopped',
      session_id: 'caws-X',
      transitioned_at: '2026-05-23T12:00:00.000Z',
    });
    expect(r2.ok).toBe(true);
  });

  it('case (d): lease operations NEVER read agents.json', () => {
    // Static evidence: leases-store.ts source contains no read of agents.json.
    const leasesStorePath = path.join(__dirname, '..', '..', 'src', 'store', 'leases-store.ts');
    const source = fs.readFileSync(leasesStorePath, 'utf8');
    expect(source).not.toMatch(/['"]agents\.json['"]/);
    expect(source).not.toMatch(/loadAgents/);
    expect(source).not.toMatch(/agents-store/);
  });
});
