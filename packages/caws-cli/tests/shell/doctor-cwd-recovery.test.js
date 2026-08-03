'use strict';

// Unit tests for detectWedgedSessions (CAWS-GUARD-CWD-RECOVERY-001).
//
// detectWedgedSessions(cawsDir) loads .caws/leases/*.json and emits one
// error-severity finding per RUNNING (active|stopping) session whose
// recorded cwd does not exist on disk — the wedge condition where the
// session's sticky shell cwd was deleted out from under it. These tests
// drive the function directly against temp .caws/leases/ dirs with
// hand-written lease JSON.

const fs = require('fs');
const os = require('os');
const path = require('path');

const { detectWedgedSessions, AGENT_CWD_GONE_RULE } = require('../../dist/shell/cwd-recovery');

const ROOTS = [];

function mkCaws() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-cwd-recovery-'));
  ROOTS.push(root);
  const caws = path.join(root, '.caws');
  fs.mkdirSync(path.join(caws, 'leases'), { recursive: true });
  return caws;
}

afterAll(() => {
  for (const r of ROOTS) {
    try {
      fs.rmSync(r, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

// Minimal lease shape (loadLeases validates lease_version + session_id +
// a string status; the AgentLease fields beyond those are passed through).
function writeLease(cawsDir, sessionId, overrides = {}) {
  const lease = {
    lease_version: 1,
    session_id: sessionId,
    platform: 'zcode',
    status: 'active',
    started_at: '2026-08-03T00:00:00.000Z',
    last_active: '2026-08-03T19:00:00.000Z',
    repo_root: '/repo',
    cwd: '/repo',
    git_common_dir: '/repo/.git',
    git_dir: '/repo/.git',
    ...overrides,
  };
  fs.writeFileSync(path.join(cawsDir, 'leases', `${sessionId}.json`), JSON.stringify(lease, null, 2));
  return lease;
}

describe('detectWedgedSessions (CAWS-GUARD-CWD-RECOVERY-001)', () => {
  test('flags an active session whose cwd does not exist (A1)', () => {
    const caws = mkCaws();
    // A gone cwd — a path nothing creates on disk.
    writeLease(caws, 'sess-wedged', {
      status: 'active',
      cwd: '/definitely/gone/worktree-dir',
      repo_root: '/repo-root-x',
      branch: 'wt-gone',
      pid: 12345,
    });

    const findings = detectWedgedSessions(caws);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    expect(f.rule).toBe(AGENT_CWD_GONE_RULE);
    expect(f.severity).toBe('error');
    expect(f.subject).toBe('sess-wedged');
    expect(f.message).toMatch(/wedged/);
    expect(f.message).toMatch(/\/definitely\/gone\/worktree-dir/);
    expect(f.message).toMatch(/ENOENT/);
    expect(f.narrowRepair).toMatch(/cd \/repo-root-x/);
    expect(f.data).toMatchObject({
      session_id: 'sess-wedged',
      cwd: '/definitely/gone/worktree-dir',
      repo_root: '/repo-root-x',
      branch: 'wt-gone',
      pid: 12345,
    });
  });

  test('does NOT flag an active session whose cwd DOES exist (A2)', () => {
    const caws = mkCaws();
    // A real temp dir that exists on disk.
    const realCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'real-cwd-'));
    writeLease(caws, 'sess-ok', { status: 'active', cwd: realCwd, repo_root: realCwd });

    const findings = detectWedgedSessions(caws);
    expect(findings).toHaveLength(0);
  });

  test('does NOT flag a STOPPED session even with a gone cwd (A3)', () => {
    const caws = mkCaws();
    // A stopped session will not spawn a shell, so a gone cwd is harmless.
    writeLease(caws, 'sess-stopped', {
      status: 'stopped',
      cwd: '/definitely/gone',
      stopped_at: '2026-08-03T19:00:00.000Z',
    });

    const findings = detectWedgedSessions(caws);
    expect(findings).toHaveLength(0);
  });

  test('flags a STOPPING session with a gone cwd (A4) — stopping can still spawn', () => {
    const caws = mkCaws();
    writeLease(caws, 'sess-stopping', {
      status: 'stopping',
      cwd: '/definitely/gone',
      repo_root: '/repo-stop',
    });

    const findings = detectWedgedSessions(caws);
    expect(findings).toHaveLength(1);
    expect(findings[0].subject).toBe('sess-stopping');
    expect(findings[0].severity).toBe('error');
  });

  test('emits one finding per wedged session (multiple wedged)', () => {
    const caws = mkCaws();
    writeLease(caws, 'sess-w1', { status: 'active', cwd: '/gone/1', repo_root: '/r' });
    writeLease(caws, 'sess-w2', { status: 'active', cwd: '/gone/2', repo_root: '/r' });
    writeLease(caws, 'sess-ok', { status: 'active', cwd: caws, repo_root: '/r' });

    const findings = detectWedgedSessions(caws);
    expect(findings).toHaveLength(2);
    const subjects = findings.map((f) => f.subject).sort();
    expect(subjects).toEqual(['sess-w1', 'sess-w2']);
  });

  test('returns no findings when .caws/leases/ is empty (no sessions)', () => {
    const caws = mkCaws();
    expect(detectWedgedSessions(caws)).toEqual([]);
  });

  test('returns no findings when .caws/leases/ dir is missing (lenient)', () => {
    const caws = mkCaws();
    fs.rmSync(path.join(caws, 'leases'), { recursive: true, force: true });
    expect(detectWedgedSessions(caws)).toEqual([]);
  });

  test('skips a malformed lease without crashing (lenient loadLeases)', () => {
    const caws = mkCaws();
    // A lease file that is not valid JSON → loadLeases drops it per-file.
    fs.writeFileSync(path.join(caws, 'leases', 'sess-broken.json'), '{ not valid json');
    writeLease(caws, 'sess-good', { status: 'active', cwd: '/gone', repo_root: '/r' });

    const findings = detectWedgedSessions(caws);
    // Only the well-formed wedged lease is flagged; the broken one is dropped.
    expect(findings).toHaveLength(1);
    expect(findings[0].subject).toBe('sess-good');
  });
});
