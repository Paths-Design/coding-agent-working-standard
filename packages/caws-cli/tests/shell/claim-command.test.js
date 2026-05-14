/**
 * Tests for `runClaimCommand`.
 *
 * Authority invariants under test:
 *   - worktrees.json[name].owner is SOLE ownership authority.
 *   - agents.json is freshness/display only; stale heartbeat is NOT
 *     abandonment.
 *   - prior_owners is append-only; takeover adds, never truncates.
 *
 * Exit codes:
 *   0 = ownership is yours (same-session OK or successful takeover)
 *   1 = ownership refused (foreign without --takeover, unowned, etc.)
 *   2 = composition error (no repo root / not in worktree / etc.)
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { runClaimCommand } = require('../../dist/shell');
const { loadAgents, loadWorktrees } = require('../../dist/store');

const NOW = new Date('2026-05-14T18:00:00.000Z');
// 2 days before NOW — older than the default 24h staleness ttl.
const OLD = new Date('2026-05-12T18:00:00.000Z');

function mkTempGitRepo(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync('git', ['init', '--quiet', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@test.com']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
  execFileSync('git', [
    '-C', root, 'commit', '--quiet', '--allow-empty', '-m', 'init',
  ]);
  fs.mkdirSync(path.join(root, '.caws', 'specs'), { recursive: true });
  return root;
}

function rmrf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

function captureRun(opts) {
  const outLines = [];
  const errLines = [];
  const code = runClaimCommand({
    now: () => NOW,
    out: (s) => outLines.push(s),
    err: (s) => errLines.push(s),
    ...opts,
  });
  return { code, stdout: outLines.join('\n'), stderr: errLines.join('\n') };
}

/**
 * Set up a temp repo + linked worktree + worktrees.json with given owner.
 * Returns { mainRoot, worktreeRoot, cleanup }.
 */
function mkRepoWithWorktree({ prefix, owner }) {
  const mainRoot = mkTempGitRepo(prefix);
  const worktreeRoot = path.join(
    os.tmpdir(),
    `${prefix}wt-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  );
  execFileSync('git', [
    '-C', mainRoot, 'worktree', 'add', '-b', `b-${Date.now().toString(36)}`,
    worktreeRoot,
  ]);
  const registry = {
    'wt-foo': {
      path: worktreeRoot,
      ...(owner !== undefined ? { owner } : {}),
      ...(owner !== undefined
        ? { last_heartbeat: '2026-05-14T11:00:00.000Z' }
        : {}),
    },
  };
  fs.writeFileSync(
    path.join(mainRoot, '.caws', 'worktrees.json'),
    JSON.stringify(registry, null, 2)
  );
  return {
    mainRoot,
    worktreeRoot,
    cleanup: () => {
      try {
        execFileSync('git', [
          '-C', mainRoot, 'worktree', 'remove', '--force', worktreeRoot,
        ]);
      } catch { /* ignore */ }
      rmrf(mainRoot);
      rmrf(worktreeRoot);
    },
  };
}

describe('runClaimCommand — exit 2 composition', () => {
  let nonGitDir;
  afterEach(() => rmrf(nonGitDir));

  it('cwd outside a git repo → exit 2', () => {
    nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-claim-nogit-'));
    const r = captureRun({
      cwd: nonGitDir,
      env: { CLAUDE_SESSION_ID: 'sess-1' },
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/failed to resolve repo root/);
  });

  it('inside repo but NOT inside a tracked worktree → exit 2', () => {
    const mainRoot = mkTempGitRepo('caws-claim-mainonly-');
    try {
      const r = captureRun({
        cwd: mainRoot,
        env: { CLAUDE_SESSION_ID: 'sess-1' },
      });
      expect(r.code).toBe(2);
      expect(r.stderr).toMatch(/not inside a CAWS-tracked worktree/);
    } finally {
      rmrf(mainRoot);
    }
  });
});

describe('runClaimCommand — same-session OK', () => {
  let env;
  afterEach(() => env && env.cleanup());

  it('claim on a worktree we already own → exit 0, OWNED (you)', () => {
    env = mkRepoWithWorktree({
      prefix: 'caws-claim-same-',
      owner: { session_id: 'sess-1', platform: 'claude-code' },
    });
    const r = captureRun({
      cwd: env.worktreeRoot,
      env: { CLAUDE_SESSION_ID: 'sess-1' },
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/OWNED \(you\)/);
    expect(r.stdout).toMatch(/sess-1:claude-code/);

    // agents.json was refreshed with our session
    const cawsDir = path.join(env.mainRoot, '.caws');
    const agents = loadAgents(cawsDir);
    expect(agents.ok).toBe(true);
    expect(agents.value['sess-1']).toBeDefined();
    expect(agents.value['sess-1'].bound_worktree).toBe('wt-foo');
    expect(agents.value['sess-1'].last_active).toBe(NOW.toISOString());

    // worktrees.json owner is unchanged (no patch was applied)
    const wts = loadWorktrees(cawsDir);
    expect(wts.value['wt-foo'].owner.session_id).toBe('sess-1');
    // No prior_owners ever materialized on a same-session path
    expect(wts.value['wt-foo'].prior_owners).toBeUndefined();
  });
});

describe('runClaimCommand — foreign owner blocked without --takeover', () => {
  let env;
  afterEach(() => env && env.cleanup());

  it('foreign owner → exit 1, panel shows OWNED (foreign), no takeover', () => {
    env = mkRepoWithWorktree({
      prefix: 'caws-claim-foreign-',
      owner: { session_id: 'sess-other', platform: 'cursor' },
    });
    const r = captureRun({
      cwd: env.worktreeRoot,
      env: { CLAUDE_SESSION_ID: 'sess-me' },
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/ownership refused/);
    // Panel rendered to stderr, showing the foreign owner
    expect(r.stderr).toMatch(/OWNED \(foreign\)/);
    expect(r.stderr).toMatch(/sess-other:cursor/);

    // worktrees.json owner unchanged: still sess-other
    const cawsDir = path.join(env.mainRoot, '.caws');
    const wts = loadWorktrees(cawsDir);
    expect(wts.value['wt-foo'].owner.session_id).toBe('sess-other');
    // No prior_owners written
    expect(wts.value['wt-foo'].prior_owners).toBeUndefined();
  });

  it('stale foreign heartbeat is STILL NOT abandonment — exit 1 without --takeover', () => {
    env = mkRepoWithWorktree({
      prefix: 'caws-claim-stale-',
      owner: { session_id: 'sess-other', platform: 'cursor' },
    });
    // Pre-write an agents.json with a stale heartbeat for sess-other
    fs.writeFileSync(
      path.join(env.mainRoot, '.caws', 'agents.json'),
      JSON.stringify({
        'sess-other': {
          session_id: 'sess-other',
          platform: 'cursor',
          last_active: OLD.toISOString(), // 2 days old, exceeds 24h default
        },
      })
    );
    const r = captureRun({
      cwd: env.worktreeRoot,
      env: { CLAUDE_SESSION_ID: 'sess-me' },
    });
    // Authority is still worktrees.json.owner — staleness does not override
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/OWNED \(foreign\)/);
    expect(r.stderr).toMatch(/stale.*display only/);
  });
});

describe('runClaimCommand — foreign owner with --takeover succeeds', () => {
  let env;
  afterEach(() => env && env.cleanup());

  it('--takeover writes prior_owners audit, new owner, exit 0', () => {
    env = mkRepoWithWorktree({
      prefix: 'caws-claim-takeover-',
      owner: { session_id: 'sess-other', platform: 'cursor' },
    });
    const r = captureRun({
      cwd: env.worktreeRoot,
      env: { CLAUDE_SESSION_ID: 'sess-me' },
      takeover: true,
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/OWNED \(you\)/);

    const cawsDir = path.join(env.mainRoot, '.caws');
    const wts = loadWorktrees(cawsDir);
    // New owner installed
    expect(wts.value['wt-foo'].owner.session_id).toBe('sess-me');
    // prior_owners has exactly one entry, naming the displaced session
    expect(wts.value['wt-foo'].prior_owners).toHaveLength(1);
    expect(wts.value['wt-foo'].prior_owners[0].session_id).toBe('sess-other');
    // Audit record carries platform and a takenOver_at timestamp
    expect(wts.value['wt-foo'].prior_owners[0].platform).toBe('cursor');
    expect(wts.value['wt-foo'].prior_owners[0].takenOver_at).toBe(NOW.toISOString());
  });

  it('takeover is append-only: pre-existing prior_owners survive', () => {
    env = mkRepoWithWorktree({
      prefix: 'caws-claim-append-',
      owner: { session_id: 'sess-other', platform: 'cursor' },
    });
    // Seed a pre-existing prior_owners entry
    const regPath = path.join(env.mainRoot, '.caws', 'worktrees.json');
    const reg = JSON.parse(fs.readFileSync(regPath, 'utf8'));
    reg['wt-foo'].prior_owners = [
      {
        session_id: 'sess-historical',
        platform: 'claude-code',
        last_seen: '2026-05-01T00:00:00.000Z',
        takenOver_at: '2026-05-01T00:00:01.000Z',
      },
    ];
    fs.writeFileSync(regPath, JSON.stringify(reg, null, 2));

    const r = captureRun({
      cwd: env.worktreeRoot,
      env: { CLAUDE_SESSION_ID: 'sess-me' },
      takeover: true,
    });
    expect(r.code).toBe(0);
    const wts = loadWorktrees(path.join(env.mainRoot, '.caws'));
    // Two prior_owners: the historical one + the just-displaced sess-other
    expect(wts.value['wt-foo'].prior_owners).toHaveLength(2);
    expect(wts.value['wt-foo'].prior_owners[0].session_id).toBe('sess-historical');
    expect(wts.value['wt-foo'].prior_owners[1].session_id).toBe('sess-other');
  });
});

describe('runClaimCommand — unowned worktree', () => {
  let env;
  afterEach(() => env && env.cleanup());

  it('no owner recorded → exit 1 (kernel does not silently mint ownership)', () => {
    env = mkRepoWithWorktree({
      prefix: 'caws-claim-unowned-',
      // owner deliberately omitted
    });
    const r = captureRun({
      cwd: env.worktreeRoot,
      env: { CLAUDE_SESSION_ID: 'sess-me' },
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/ownership refused/);
    // Diagnostic should mention the no-owner-recorded rule
    expect(r.stderr).toMatch(/no_owner_recorded|UNOWNED/i);
  });
});
