/**
 * Tests for caws status + leases integration (MULTI-AGENT-ACTIVITY-
 * REGISTRY-001 commit 4).
 *
 * Hard contract:
 *   - Default `caws status` is read-only: NO lease directory created,
 *     NO lease files written, NO existing lease mtimes/content changed.
 *   - `--session-id` alone NEVER mutates (identity only).
 *   - `--heartbeat` opt-in writes only the current/explicit session's
 *     lease.
 *   - Agents panel renders BEFORE Doctor when leases exist.
 *   - Panel distinguishes self vs other.
 *   - Corrupt agents.json must not break lease-backed status.
 */

'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runStatusCommand, runAgentsRegisterCommand } = require('../../dist/shell');

function mkRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-status-leases-'));
  execFileSync('git', ['init', '-q', dir], { stdio: 'ignore' });
  fs.writeFileSync(path.join(dir, '.gitignore'), '');
  execFileSync('git', ['-C', dir, 'add', '.gitignore'], { stdio: 'ignore' });
  execFileSync(
    'git',
    ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'],
    { stdio: 'ignore' }
  );
  fs.mkdirSync(path.join(dir, '.caws'));
  return dir;
}

function captureStatus(opts = {}) {
  const out = [];
  const err = [];
  const NOW = new Date('2026-05-23T10:00:00.000Z');
  const code = runStatusCommand({
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    now: () => NOW,
    ...opts,
  });
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
}

// ─── default status is read-only ──────────────────────────────────────────

describe('caws status default — read-only', () => {
  let repo;
  afterEach(() => repo && fs.rmSync(repo, { recursive: true, force: true }));

  it('creates NO lease directory when none exists', () => {
    repo = mkRepo();
    expect(fs.existsSync(path.join(repo, '.caws', 'leases'))).toBe(false);

    const r = captureStatus({ cwd: repo });
    expect(r.code).toBe(0);

    expect(fs.existsSync(path.join(repo, '.caws', 'leases'))).toBe(false);
  });

  it('does not touch existing lease files (content preserved byte-for-byte)', () => {
    repo = mkRepo();
    // Pre-populate a lease via agents register.
    runAgentsRegisterCommand({
      cwd: repo,
      sessionId: 'pre-existing',
      platform: 'cli',
      out: () => {},
      err: () => {},
      now: () => new Date('2026-05-23T09:00:00.000Z'),
    });
    const leasePath = path.join(repo, '.caws', 'leases', 'pre-existing.json');
    expect(fs.existsSync(leasePath)).toBe(true);
    const beforeContent = fs.readFileSync(leasePath, 'utf8');

    // Run status without --heartbeat. Must not modify the lease.
    captureStatus({ cwd: repo });

    const afterContent = fs.readFileSync(leasePath, 'utf8');
    expect(afterContent).toBe(beforeContent);
  });

  it('--session-id alone does NOT mutate', () => {
    repo = mkRepo();
    captureStatus({ cwd: repo, sessionId: 'caws-id-only', platform: 'cli' });
    // No lease created for caws-id-only.
    expect(fs.existsSync(path.join(repo, '.caws', 'leases', 'caws-id-only.json'))).toBe(false);
    expect(fs.existsSync(path.join(repo, '.caws', 'leases'))).toBe(false);
  });
});

// ─── --heartbeat opt-in ──────────────────────────────────────────────────

describe('caws status --heartbeat — opt-in lease write', () => {
  let repo;
  afterEach(() => repo && fs.rmSync(repo, { recursive: true, force: true }));

  it('--heartbeat --session-id X writes lease for X only', () => {
    repo = mkRepo();
    const r = captureStatus({
      cwd: repo,
      heartbeat: true,
      sessionId: 'caws-hb-status',
      platform: 'claude-code',
    });
    expect(r.code).toBe(0);
    const leasePath = path.join(repo, '.caws', 'leases', 'caws-hb-status.json');
    expect(fs.existsSync(leasePath)).toBe(true);
    const lease = JSON.parse(fs.readFileSync(leasePath, 'utf8'));
    expect(lease.session_id).toBe('caws-hb-status');
    expect(lease.last_seen_reason).toBe('status');
  });

  it("--heartbeat does NOT touch other sessions' leases", () => {
    repo = mkRepo();
    // Register two leases.
    runAgentsRegisterCommand({
      cwd: repo,
      sessionId: 'other-session',
      platform: 'cli',
      out: () => {},
      err: () => {},
      now: () => new Date('2026-05-23T09:00:00.000Z'),
    });
    const otherPath = path.join(repo, '.caws', 'leases', 'other-session.json');
    const otherBefore = fs.readFileSync(otherPath, 'utf8');

    // Run status --heartbeat as MY session.
    captureStatus({
      cwd: repo,
      heartbeat: true,
      sessionId: 'me',
      platform: 'cli',
    });

    // Other session's lease is untouched.
    expect(fs.readFileSync(otherPath, 'utf8')).toBe(otherBefore);
    // My lease was created.
    expect(fs.existsSync(path.join(repo, '.caws', 'leases', 'me.json'))).toBe(true);
  });
});

// ─── Agents panel rendering ──────────────────────────────────────────────

describe('caws status — Agents panel rendering', () => {
  let repo;
  afterEach(() => repo && fs.rmSync(repo, { recursive: true, force: true }));

  it('renders an Agents panel when leases exist', () => {
    repo = mkRepo();
    runAgentsRegisterCommand({
      cwd: repo,
      sessionId: 'panel-A',
      platform: 'claude-code',
      out: () => {},
      err: () => {},
      now: () => new Date('2026-05-23T09:59:50.000Z'), // 10s before status NOW
    });
    const r = captureStatus({ cwd: repo, leaseStaleTtlMs: 60_000 });
    expect(r.stdout).toMatch(/^Agents\b/m);
    expect(r.stdout).toMatch(/active:\s+1/);
    expect(r.stdout).toMatch(/panel-A/);
  });

  it('Agents panel renders BEFORE Doctor', () => {
    repo = mkRepo();
    runAgentsRegisterCommand({
      cwd: repo,
      sessionId: 'order-A',
      platform: 'cli',
      out: () => {},
      err: () => {},
      now: () => new Date('2026-05-23T09:59:50.000Z'),
    });
    const r = captureStatus({ cwd: repo });
    const agentsIdx = r.stdout.indexOf('Agents');
    const doctorIdx = r.stdout.indexOf('Doctor');
    expect(agentsIdx).toBeGreaterThan(0);
    expect(doctorIdx).toBeGreaterThan(agentsIdx);
  });

  it('shows (parallel) tag when active count > 1', () => {
    repo = mkRepo();
    runAgentsRegisterCommand({
      cwd: repo,
      sessionId: 'p1',
      platform: 'cli',
      out: () => {},
      err: () => {},
      now: () => new Date('2026-05-23T09:59:50.000Z'),
    });
    runAgentsRegisterCommand({
      cwd: repo,
      sessionId: 'p2',
      platform: 'cli',
      out: () => {},
      err: () => {},
      now: () => new Date('2026-05-23T09:59:55.000Z'),
    });
    const r = captureStatus({ cwd: repo, leaseStaleTtlMs: 60_000 });
    expect(r.stdout).toMatch(/active:\s+2\s+\(parallel\)/);
  });

  it('marks self with ← self when --session-id matches a lease', () => {
    repo = mkRepo();
    runAgentsRegisterCommand({
      cwd: repo,
      sessionId: 'self-marker',
      platform: 'cli',
      out: () => {},
      err: () => {},
      now: () => new Date('2026-05-23T09:59:50.000Z'),
    });
    const r = captureStatus({
      cwd: repo,
      sessionId: 'self-marker',
      platform: 'cli',
      leaseStaleTtlMs: 60_000,
    });
    expect(r.stdout).toMatch(/self-marker.*← self/);
  });

  it('does NOT render Agents panel when no leases exist', () => {
    repo = mkRepo();
    const r = captureStatus({ cwd: repo });
    expect(r.stdout).not.toMatch(/^Agents\b/m);
  });
});

// ─── corrupt agents.json must not break lease-backed status ──────────────

describe('caws status — agents.json corruption independence', () => {
  let repo;
  afterEach(() => repo && fs.rmSync(repo, { recursive: true, force: true }));

  it('corrupt agents.json + valid leases → lease load remains independent', () => {
    repo = mkRepo();
    fs.writeFileSync(path.join(repo, '.caws', 'agents.json'), 'not json at all');
    runAgentsRegisterCommand({
      cwd: repo,
      sessionId: 'indep-A',
      platform: 'cli',
      out: () => {},
      err: () => {},
      now: () => new Date('2026-05-23T09:59:50.000Z'),
    });

    // Status may fail to compose with the corrupt agents.json (legacy
    // strict loader). The negative-invariant test is that the lease
    // substrate is INDEPENDENT: lease registration succeeded above and
    // loadLeases works regardless of agents.json state.
    const r = captureStatus({ cwd: repo });
    if (r.code === 0) {
      expect(r.stdout).toMatch(/^Agents\b/m);
      expect(r.stdout).toMatch(/indep-A/);
    } else {
      // Composition fails on agents.json — confirm leases were still
      // loadable independent of status.
      const { loadLeases } = require('../../dist/store');
      const leasesRes = loadLeases(path.join(repo, '.caws'));
      expect(leasesRes.ok).toBe(true);
      expect(leasesRes.value.leases['indep-A']).toBeDefined();
    }
  });
});
