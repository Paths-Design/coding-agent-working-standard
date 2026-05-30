/**
 * @fileoverview WORKTREE-GUARD-RISK-SURFACE-001 A5 — `caws agents prune --dead`.
 *
 * prune --dead collapses the prior verify-PID → stop → prune --status stale
 * --older-than 0 dance into one operation: an active/stopping lease on THIS
 * host whose owning process is dead is selected and (on apply) deleted.
 *
 * Safety invariants proven here:
 *   - a lease whose pid is ALIVE is never touched;
 *   - a lease on a FOREIGN host (hostname != current) is skipped (pid not
 *     checkable), never assumed dead;
 *   - a lease with NO pid recorded is treated as dead (unverifiable + running);
 *   - --dry-run reports candidates without mutating; apply deletes them;
 *   - stopped leases are out of scope for --dead.
 *
 * We target pruneDeadLeases directly (dist/store) with injected
 * isPidAlive + currentHostname so liveness is deterministic and does not
 * depend on real OS processes.
 *
 * @author @darianrosebrook
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { pruneDeadLeases, defaultIsPidAlive } = require('../../dist/store');

const HOST = 'test-host';
const NOW = new Date('2026-05-30T10:00:00.000Z');

function mkCaws() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-prune-dead-'));
  fs.mkdirSync(path.join(dir, '.caws', 'leases'), { recursive: true });
  return path.join(dir, '.caws');
}

function writeLease(cawsDir, lease) {
  const full = {
    lease_version: 1,
    platform: 'claude-code',
    started_at: '2026-05-30T09:00:00.000Z',
    last_active: '2026-05-30T09:30:00.000Z',
    repo_root: '/repo',
    cwd: '/repo',
    git_common_dir: '/repo/.git',
    git_dir: '/repo/.git',
    last_seen_reason: 'pre_tool_use',
    hostname: HOST,
    ...lease,
  };
  fs.writeFileSync(
    path.join(cawsDir, 'leases', `${full.session_id}.json`),
    JSON.stringify(full, null, 2)
  );
}

function rmCaws(cawsDir) {
  fs.rmSync(path.dirname(cawsDir), { recursive: true, force: true });
}

// A pid-liveness probe where only the pids in `alive` are alive.
const aliveSet = (...alive) => (pid) => alive.includes(pid);

describe('caws agents prune --dead (WORKTREE-GUARD-RISK-SURFACE-001 A5)', () => {
  let cawsDir;
  afterEach(() => cawsDir && rmCaws(cawsDir));

  it('selects active lease with a dead pid; leaves alive-pid lease untouched', () => {
    cawsDir = mkCaws();
    writeLease(cawsDir, { session_id: 'dead-one', status: 'active', pid: 4242 });
    writeLease(cawsDir, { session_id: 'alive-one', status: 'active', pid: 1001 });

    const r = pruneDeadLeases(cawsDir, {
      now: NOW,
      dryRun: true,
      currentHostname: HOST,
      isPidAlive: aliveSet(1001),
    });
    expect(r.ok).toBe(true);
    expect(r.value.candidates).toEqual(['dead-one']);
    expect(r.value.candidates).not.toContain('alive-one');
    // dry-run mutates nothing.
    expect(r.value.deleted).toEqual([]);
    expect(fs.existsSync(path.join(cawsDir, 'leases', 'dead-one.json'))).toBe(true);
  });

  it('apply deletes the dead lease and preserves the alive one', () => {
    cawsDir = mkCaws();
    writeLease(cawsDir, { session_id: 'dead-one', status: 'active', pid: 4242 });
    writeLease(cawsDir, { session_id: 'alive-one', status: 'active', pid: 1001 });

    const r = pruneDeadLeases(cawsDir, {
      now: NOW,
      dryRun: false,
      currentHostname: HOST,
      isPidAlive: aliveSet(1001),
    });
    expect(r.ok).toBe(true);
    expect(r.value.deleted).toEqual(['dead-one']);
    expect(fs.existsSync(path.join(cawsDir, 'leases', 'dead-one.json'))).toBe(false);
    expect(fs.existsSync(path.join(cawsDir, 'leases', 'alive-one.json'))).toBe(true);
  });

  it('skips a foreign-host lease — never assumes it is dead', () => {
    cawsDir = mkCaws();
    writeLease(cawsDir, { session_id: 'foreign', status: 'active', pid: 9999, hostname: 'other-host' });

    const r = pruneDeadLeases(cawsDir, {
      now: NOW,
      dryRun: false,
      currentHostname: HOST,
      // Even though the probe would call this pid dead, foreign host is skipped first.
      isPidAlive: aliveSet(),
    });
    expect(r.ok).toBe(true);
    expect(r.value.candidates).toEqual([]);
    expect(r.value.skippedForeignHost).toEqual(['foreign']);
    expect(fs.existsSync(path.join(cawsDir, 'leases', 'foreign.json'))).toBe(true);
  });

  it('treats an active lease with no pid as dead (unverifiable + running)', () => {
    cawsDir = mkCaws();
    const lease = {
      lease_version: 1,
      session_id: 'no-pid',
      platform: 'claude-code',
      status: 'active',
      started_at: '2026-05-30T09:00:00.000Z',
      last_active: '2026-05-30T09:30:00.000Z',
      repo_root: '/repo',
      cwd: '/repo',
      git_common_dir: '/repo/.git',
      git_dir: '/repo/.git',
      last_seen_reason: 'pre_tool_use',
      hostname: HOST,
      // no pid
    };
    fs.writeFileSync(path.join(cawsDir, 'leases', 'no-pid.json'), JSON.stringify(lease, null, 2));

    const r = pruneDeadLeases(cawsDir, {
      now: NOW,
      dryRun: true,
      currentHostname: HOST,
      isPidAlive: aliveSet(),
    });
    expect(r.ok).toBe(true);
    expect(r.value.candidates).toEqual(['no-pid']);
  });

  it('does not select stopped leases (out of scope for --dead)', () => {
    cawsDir = mkCaws();
    writeLease(cawsDir, {
      session_id: 'stopped-one',
      status: 'stopped',
      pid: 4242,
      stopped_at: '2026-05-30T09:45:00.000Z',
    });

    const r = pruneDeadLeases(cawsDir, {
      now: NOW,
      dryRun: false,
      currentHostname: HOST,
      isPidAlive: aliveSet(), // pid would be "dead", but status=stopped excludes it
    });
    expect(r.ok).toBe(true);
    expect(r.value.candidates).toEqual([]);
    expect(fs.existsSync(path.join(cawsDir, 'leases', 'stopped-one.json'))).toBe(true);
  });

  it('defaultIsPidAlive: pid 0 / negative / NaN are not alive; current process is alive', () => {
    expect(defaultIsPidAlive(0)).toBe(false);
    expect(defaultIsPidAlive(-5)).toBe(false);
    expect(defaultIsPidAlive(Number.NaN)).toBe(false);
    // The test runner's own pid is necessarily alive.
    expect(defaultIsPidAlive(process.pid)).toBe(true);
  });
});
