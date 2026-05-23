/**
 * Tests for the `caws agents` shell command group.
 *
 * MULTI-AGENT-ACTIVITY-REGISTRY-001 acceptance A9–A11, A13 (partial).
 *
 * Covers:
 *   - A9: register/heartbeat/stop write valid lease files via leases-store
 *   - A9 contract: --json output is CAWS-native (no Claude Code hook envelope)
 *   - A10: --throttle skips write but returns active-summary
 *   - A13 prep: status read-only by default (status command not yet wired —
 *     covered in commit 4)
 *   - list --active = TTL-classified active (not raw status field)
 *   - show / prune basic operation
 *   - unsafe / unknown session id REFUSED before any I/O
 */

'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  runAgentsRegisterCommand,
  runAgentsHeartbeatCommand,
  runAgentsStopCommand,
  runAgentsListCommand,
  runAgentsShowCommand,
  runAgentsPruneCommand,
} = require('../../dist/shell');

function mkTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-agents-shell-'));
  execFileSync('git', ['init', '-q', dir], { stdio: 'ignore' });
  // Create a single commit so HEAD resolves and abbrev-ref works.
  fs.writeFileSync(path.join(dir, '.gitignore'), '');
  execFileSync('git', ['-C', dir, 'add', '.gitignore'], { stdio: 'ignore' });
  execFileSync(
    'git',
    [
      '-C',
      dir,
      '-c',
      'user.email=test@test',
      '-c',
      'user.name=test',
      'commit',
      '-qm',
      'init',
    ],
    { stdio: 'ignore' }
  );
  fs.mkdirSync(path.join(dir, '.caws'));
  return dir;
}

function captureRun(fn) {
  const outLines = [];
  const errLines = [];
  const NOW = new Date('2026-05-23T10:00:00.000Z');
  const code = fn({
    out: (s) => outLines.push(s),
    err: (s) => errLines.push(s),
    now: () => NOW,
  });
  return { code, stdout: outLines.join('\n'), stderr: errLines.join('\n') };
}

// ─── A9: register writes lease + JSON shape ───────────────────────────────

describe('caws agents register (A9)', () => {
  let repo;
  afterEach(() => repo && fs.rmSync(repo, { recursive: true, force: true }));

  it('writes a valid AgentLease at .caws/leases/<safe-id>.json', () => {
    repo = mkTempRepo();
    const result = captureRun((io) =>
      runAgentsRegisterCommand({
        ...io,
        cwd: repo,
        sessionId: 'caws-test-A',
        platform: 'claude-code',
        reason: 'session_start',
        json: true,
      })
    );
    expect(result.code).toBe(0);

    const leasePath = path.join(repo, '.caws', 'leases', 'caws-test-A.json');
    expect(fs.existsSync(leasePath)).toBe(true);
    const lease = JSON.parse(fs.readFileSync(leasePath, 'utf8'));
    expect(lease.session_id).toBe('caws-test-A');
    expect(lease.platform).toBe('claude-code');
    expect(lease.status).toBe('active');
    expect(lease.lease_version).toBe(1);
    expect(lease.last_seen_reason).toBe('session_start');
    expect(lease.bound_worktree).toBeUndefined(); // no worktree context in test
    expect(typeof lease.git_common_dir).toBe('string');
    expect(typeof lease.git_dir).toBe('string');
    expect(typeof lease.pid).toBe('number');
  });

  it('--json output matches the documented CAWS-native shape', () => {
    repo = mkTempRepo();
    const result = captureRun((io) =>
      runAgentsRegisterCommand({
        ...io,
        cwd: repo,
        sessionId: 'caws-test-B',
        platform: 'claude-code',
        json: true,
        includeActiveSummary: true,
      })
    );
    expect(result.code).toBe(0);

    const payload = JSON.parse(result.stdout);
    // Field-level contract assertions (not snapshot — shape is the
    // permanent contract input for the hook layer).
    expect(payload.ok).toBe(true);
    expect(payload.session_id).toBe('caws-test-B');
    expect(payload.lease_path).toBe('.caws/leases/caws-test-B.json');
    expect(payload.wrote).toBe(true);
    expect(payload.throttled).toBe(false);
    expect(typeof payload.active_agent_count).toBe('number');
    expect(Array.isArray(payload.active_agents)).toBe(true);
    expect(payload.active_agent_count).toBe(1);
    expect(payload.active_agents[0].session_id).toBe('caws-test-B');
    expect(payload.active_agents[0].is_self).toBe(true);
    expect(payload.active_agents[0].git_dir_kind).toBe('canonical');
    expect(typeof payload.active_agents[0].last_active_age_ms).toBe('number');
  });

  it('NEGATIVE: --json output never contains Claude Code hook envelope strings', () => {
    repo = mkTempRepo();
    const result = captureRun((io) =>
      runAgentsRegisterCommand({
        ...io,
        cwd: repo,
        sessionId: 'caws-test-C',
        platform: 'claude-code',
        json: true,
        includeActiveSummary: true,
      })
    );
    expect(result.code).toBe(0);
    // The CLI MUST be hook-protocol-agnostic.
    expect(result.stdout).not.toMatch(/hookSpecificOutput/);
    expect(result.stdout).not.toMatch(/hookEventName/);
    expect(result.stdout).not.toMatch(/additionalContext/);
    expect(result.stdout).not.toMatch(/permissionDecision/);
    expect(result.stdout).not.toMatch(/updatedInput/);
  });

  it('refuses --session-id unknown', () => {
    repo = mkTempRepo();
    const result = captureRun((io) =>
      runAgentsRegisterCommand({
        ...io,
        cwd: repo,
        sessionId: 'unknown',
        platform: 'claude-code',
        json: true,
      })
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/invalid --session-id/);
    expect(fs.existsSync(path.join(repo, '.caws', 'leases'))).toBe(false);
  });

  it('refuses unsafe --session-id (path separators)', () => {
    repo = mkTempRepo();
    const result = captureRun((io) =>
      runAgentsRegisterCommand({
        ...io,
        cwd: repo,
        sessionId: '../escape',
        platform: 'claude-code',
        json: true,
      })
    );
    expect(result.code).toBe(1);
    expect(fs.existsSync(path.join(repo, '.caws', 'leases'))).toBe(false);
  });
});

// ─── A10: heartbeat throttle ──────────────────────────────────────────────

describe('caws agents heartbeat (A10)', () => {
  let repo;
  afterEach(() => repo && fs.rmSync(repo, { recursive: true, force: true }));

  it('first call writes; second call within throttle skips write but returns summary', () => {
    repo = mkTempRepo();
    // First heartbeat — no existing lease, must write.
    const r1 = captureRun((io) =>
      runAgentsHeartbeatCommand({
        ...io,
        cwd: repo,
        sessionId: 'caws-hb-A',
        platform: 'claude-code',
        throttleMs: 30000,
        json: true,
        includeActiveSummary: true,
      })
    );
    expect(r1.code).toBe(0);
    const p1 = JSON.parse(r1.stdout);
    expect(p1.wrote).toBe(true);
    expect(p1.throttled).toBe(false);
    expect(p1.active_agent_count).toBe(1);

    // Second heartbeat — within throttle window (now is fixed in test
    // harness; throttle is 30s, elapsed is 0s).
    const r2 = captureRun((io) =>
      runAgentsHeartbeatCommand({
        ...io,
        cwd: repo,
        sessionId: 'caws-hb-A',
        platform: 'claude-code',
        throttleMs: 30000,
        json: true,
        includeActiveSummary: true,
      })
    );
    expect(r2.code).toBe(0);
    const p2 = JSON.parse(r2.stdout);
    expect(p2.wrote).toBe(false);
    expect(p2.throttled).toBe(true);
    // Active summary is still returned during throttle.
    expect(p2.active_agent_count).toBe(1);
    expect(p2.active_agents[0].session_id).toBe('caws-hb-A');
  });

  it('refuses --session-id unknown before any I/O', () => {
    repo = mkTempRepo();
    const result = captureRun((io) =>
      runAgentsHeartbeatCommand({
        ...io,
        cwd: repo,
        sessionId: 'unknown',
        json: true,
      })
    );
    expect(result.code).toBe(1);
    expect(fs.existsSync(path.join(repo, '.caws', 'leases'))).toBe(false);
  });

  it('NEGATIVE: --json output is CAWS-native only', () => {
    repo = mkTempRepo();
    const result = captureRun((io) =>
      runAgentsHeartbeatCommand({
        ...io,
        cwd: repo,
        sessionId: 'caws-hb-B',
        json: true,
        includeActiveSummary: true,
      })
    );
    expect(result.code).toBe(0);
    expect(result.stdout).not.toMatch(/hookSpecificOutput|hookEventName|additionalContext|permissionDecision/);
  });
});

// ─── stop ──────────────────────────────────────────────────────────────────

describe('caws agents stop', () => {
  let repo;
  afterEach(() => repo && fs.rmSync(repo, { recursive: true, force: true }));

  it('marks an existing lease stopped, preserving other fields', () => {
    repo = mkTempRepo();
    captureRun((io) =>
      runAgentsRegisterCommand({ ...io, cwd: repo, sessionId: 'caws-stop-A', platform: 'claude-code' })
    );
    const beforePath = path.join(repo, '.caws', 'leases', 'caws-stop-A.json');
    const before = JSON.parse(fs.readFileSync(beforePath, 'utf8'));

    const r = captureRun((io) =>
      runAgentsStopCommand({ ...io, cwd: repo, sessionId: 'caws-stop-A', platform: 'claude-code', json: true })
    );
    expect(r.code).toBe(0);
    const payload = JSON.parse(r.stdout);
    expect(payload.wrote).toBe(true);

    const after = JSON.parse(fs.readFileSync(beforePath, 'utf8'));
    expect(after.status).toBe('stopped');
    expect(after.stopped_at).toBeDefined();
    expect(after.last_seen_reason).toBe('session_stop');
    // Preserved:
    expect(after.started_at).toBe(before.started_at);
    expect(after.pid).toBe(before.pid);
  });

  it('warn no-op on missing prior lease', () => {
    repo = mkTempRepo();
    const r = captureRun((io) =>
      runAgentsStopCommand({ ...io, cwd: repo, sessionId: 'never-registered', platform: 'claude-code', json: true })
    );
    expect(r.code).toBe(0);
    const payload = JSON.parse(r.stdout);
    expect(payload.wrote).toBe(false);
    expect(payload.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rule: 'store.leases.stop_no_prior_lease', severity: 'warning' }),
      ])
    );
    // No file created.
    expect(fs.existsSync(path.join(repo, '.caws', 'leases', 'never-registered.json'))).toBe(false);
  });
});

// ─── list (TTL-classified active) ─────────────────────────────────────────

describe('caws agents list', () => {
  let repo;
  afterEach(() => repo && fs.rmSync(repo, { recursive: true, force: true }));

  it('--active means TTL-classified active, not raw status field', () => {
    repo = mkTempRepo();
    // Write a lease with status='active' but last_active far in the past.
    const leasesDir = path.join(repo, '.caws', 'leases');
    fs.mkdirSync(leasesDir, { recursive: true });
    const oldButActive = {
      lease_version: 1,
      session_id: 'old',
      platform: 'claude-code',
      status: 'active', // raw status says active...
      started_at: '2026-05-22T00:00:00.000Z',
      last_active: '2026-05-22T00:00:00.000Z', // ...but 34h old
      repo_root: repo,
      cwd: repo,
      git_common_dir: '/x',
      git_dir: '/x',
      last_seen_reason: 'pre_tool_use',
    };
    fs.writeFileSync(path.join(leasesDir, 'old.json'), JSON.stringify(oldButActive));

    // Default TTL is 30m. now is 2026-05-23T10:00 (test harness).
    // "old" is 34h stale → must be classified as stale, NOT active.
    const r = captureRun((io) =>
      runAgentsListCommand({ ...io, cwd: repo, json: true, activeOnly: true })
    );
    expect(r.code).toBe(0);
    const payload = JSON.parse(r.stdout);
    expect(payload.counts.active).toBe(0); // TTL-classified, not raw
    expect(payload.counts.stale).toBe(1);
    expect(payload.active).toEqual([]);
  });

  it('--include-stale surfaces stale records; default does not', () => {
    repo = mkTempRepo();
    const leasesDir = path.join(repo, '.caws', 'leases');
    fs.mkdirSync(leasesDir, { recursive: true });
    fs.writeFileSync(
      path.join(leasesDir, 'stale.json'),
      JSON.stringify({
        lease_version: 1,
        session_id: 'stale',
        platform: 'cli',
        status: 'active',
        started_at: '2026-05-22T00:00:00.000Z',
        last_active: '2026-05-22T00:00:00.000Z',
        repo_root: repo,
        cwd: repo,
        git_common_dir: '/x',
        git_dir: '/x',
        last_seen_reason: 'pre_tool_use',
      })
    );

    const without = captureRun((io) => runAgentsListCommand({ ...io, cwd: repo, json: true }));
    const woPayload = JSON.parse(without.stdout);
    expect(woPayload.stale).toBeUndefined();
    expect(woPayload.counts.stale).toBe(1);

    const withFlag = captureRun((io) =>
      runAgentsListCommand({ ...io, cwd: repo, json: true, includeStale: true })
    );
    const wPayload = JSON.parse(withFlag.stdout);
    expect(Array.isArray(wPayload.stale)).toBe(true);
    expect(wPayload.stale[0].session_id).toBe('stale');
  });
});

// ─── show ─────────────────────────────────────────────────────────────────

describe('caws agents show', () => {
  let repo;
  afterEach(() => repo && fs.rmSync(repo, { recursive: true, force: true }));

  it('returns the lease for an existing session', () => {
    repo = mkTempRepo();
    captureRun((io) =>
      runAgentsRegisterCommand({ ...io, cwd: repo, sessionId: 'show-A', platform: 'cli' })
    );
    const r = captureRun((io) => runAgentsShowCommand({ ...io, cwd: repo, id: 'show-A', json: true }));
    expect(r.code).toBe(0);
    const payload = JSON.parse(r.stdout);
    expect(payload.ok).toBe(true);
    expect(payload.lease.session_id).toBe('show-A');
  });

  it('returns not_found for a missing session', () => {
    repo = mkTempRepo();
    const r = captureRun((io) => runAgentsShowCommand({ ...io, cwd: repo, id: 'missing', json: true }));
    expect(r.code).toBe(1);
    const payload = JSON.parse(r.stdout);
    expect(payload.ok).toBe(false);
    expect(payload.error).toBe('not_found');
  });

  it('refuses unsafe id', () => {
    repo = mkTempRepo();
    const r = captureRun((io) => runAgentsShowCommand({ ...io, cwd: repo, id: '../escape', json: true }));
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/invalid session id/);
  });
});

// ─── prune (default dry-run) ──────────────────────────────────────────────

describe('caws agents prune', () => {
  let repo;
  afterEach(() => repo && fs.rmSync(repo, { recursive: true, force: true }));

  it('default is dry-run (no deletes)', () => {
    repo = mkTempRepo();
    const leasesDir = path.join(repo, '.caws', 'leases');
    fs.mkdirSync(leasesDir, { recursive: true });
    fs.writeFileSync(
      path.join(leasesDir, 'old.json'),
      JSON.stringify({
        lease_version: 1,
        session_id: 'old',
        platform: 'cli',
        status: 'stopped',
        started_at: '2026-05-20T00:00:00.000Z',
        last_active: '2026-05-20T00:00:00.000Z',
        stopped_at: '2026-05-20T00:00:00.000Z',
        repo_root: repo,
        cwd: repo,
        git_common_dir: '/x',
        git_dir: '/x',
        last_seen_reason: 'session_stop',
      })
    );

    const r = captureRun((io) =>
      runAgentsPruneCommand({
        ...io,
        cwd: repo,
        status: 'stopped',
        olderThanMs: 1000,
        json: true,
        // apply: omitted → dry-run
      })
    );
    expect(r.code).toBe(0);
    const payload = JSON.parse(r.stdout);
    expect(payload.dry_run).toBe(true);
    expect(payload.candidates).toEqual(['old']);
    expect(payload.deleted).toEqual([]);
    expect(fs.existsSync(path.join(leasesDir, 'old.json'))).toBe(true);
  });

  it('--apply deletes', () => {
    repo = mkTempRepo();
    const leasesDir = path.join(repo, '.caws', 'leases');
    fs.mkdirSync(leasesDir, { recursive: true });
    fs.writeFileSync(
      path.join(leasesDir, 'old.json'),
      JSON.stringify({
        lease_version: 1,
        session_id: 'old',
        platform: 'cli',
        status: 'stopped',
        started_at: '2026-05-20T00:00:00.000Z',
        last_active: '2026-05-20T00:00:00.000Z',
        stopped_at: '2026-05-20T00:00:00.000Z',
        repo_root: repo,
        cwd: repo,
        git_common_dir: '/x',
        git_dir: '/x',
        last_seen_reason: 'session_stop',
      })
    );

    const r = captureRun((io) =>
      runAgentsPruneCommand({
        ...io,
        cwd: repo,
        status: 'stopped',
        olderThanMs: 1000,
        apply: true,
        json: true,
      })
    );
    expect(r.code).toBe(0);
    const payload = JSON.parse(r.stdout);
    expect(payload.dry_run).toBe(false);
    expect(payload.deleted).toEqual(['old']);
    expect(fs.existsSync(path.join(leasesDir, 'old.json'))).toBe(false);
  });
});
