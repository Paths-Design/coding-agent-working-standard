/**
 * Tests for `runClaimCommand` --paths surface
 * (SESSION-OWNERSHIP-METADATA-001 commit 3).
 *
 * Covers:
 *   - --paths writes claimed_paths into the current session's agents.json
 *     record, verbatim.
 *   - omitting --paths leaves any existing claimed_paths untouched.
 *   - passing --paths [] explicitly clears existing claimed_paths.
 *   - 256-entry cap enforced at the CLI surface; over-cap fails closed
 *     with exit 2 and a user-facing message; agents.json untouched.
 *   - structural validation (empty string, null byte) fails closed at CLI.
 *   - --paths writes only the current session's record; sibling sessions'
 *     records remain byte-identical.
 *
 * Out of scope:
 *   - takeover semantics (covered by claim-command.test.js)
 *   - foreign-claim refusal
 *   - 1000-cap on last_modified_paths (writer-side, tested in
 *     agents-writer-paths.test.js)
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { runClaimCommand } = require('../../dist/shell');
const { CLAIM_PATHS_MAX } = require('../../dist/shell/commands/claim');

const NOW = new Date('2026-05-23T00:00:00.000Z');

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
        ? { last_heartbeat: '2026-05-22T23:00:00.000Z' }
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

function readAgents(cawsDir) {
  const p = path.join(cawsDir, 'agents.json');
  if (!fs.existsSync(p)) return {};
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

describe('runClaimCommand --paths — happy path', () => {
  let env;
  afterEach(() => env && env.cleanup());

  it('records claimed_paths verbatim on the current session record', () => {
    env = mkRepoWithWorktree({
      prefix: 'caws-claim-paths-record-',
      owner: { session_id: 'sess-1', platform: 'claude-code' },
    });
    const r = captureRun({
      cwd: env.worktreeRoot,
      env: { CLAUDE_SESSION_ID: 'sess-1' },
      paths: ['packages/foo/**', 'tests/foo.test.js'],
    });
    expect(r.code).toBe(0);
    const agents = readAgents(path.join(env.mainRoot, '.caws'));
    expect(agents['sess-1'].claimed_paths).toEqual([
      'packages/foo/**',
      'tests/foo.test.js',
    ]);
  });

  it('stores paths verbatim with no normalization', () => {
    env = mkRepoWithWorktree({
      prefix: 'caws-claim-paths-verbatim-',
      owner: { session_id: 'sess-1', platform: 'claude-code' },
    });
    const verbatim = [
      'packages/foo/**',
      './relative/path',
      '/absolute/path',
      'trailing/slash/',
    ];
    const r = captureRun({
      cwd: env.worktreeRoot,
      env: { CLAUDE_SESSION_ID: 'sess-1' },
      paths: verbatim,
    });
    expect(r.code).toBe(0);
    const agents = readAgents(path.join(env.mainRoot, '.caws'));
    expect(agents['sess-1'].claimed_paths).toEqual(verbatim);
  });

  it('empty --paths array explicitly clears any existing claim', () => {
    env = mkRepoWithWorktree({
      prefix: 'caws-claim-paths-clear-',
      owner: { session_id: 'sess-1', platform: 'claude-code' },
    });
    // First write with paths.
    captureRun({
      cwd: env.worktreeRoot,
      env: { CLAUDE_SESSION_ID: 'sess-1' },
      paths: ['initial/claim'],
    });
    // Now clear.
    const r = captureRun({
      cwd: env.worktreeRoot,
      env: { CLAUDE_SESSION_ID: 'sess-1' },
      paths: [],
    });
    expect(r.code).toBe(0);
    const agents = readAgents(path.join(env.mainRoot, '.caws'));
    expect(agents['sess-1'].claimed_paths).toEqual([]);
  });

  it('omitting --paths leaves any existing claimed_paths untouched', () => {
    env = mkRepoWithWorktree({
      prefix: 'caws-claim-paths-omit-',
      owner: { session_id: 'sess-1', platform: 'claude-code' },
    });
    // First, set a claim.
    captureRun({
      cwd: env.worktreeRoot,
      env: { CLAUDE_SESSION_ID: 'sess-1' },
      paths: ['existing/claim'],
    });
    // Then re-claim without --paths.
    const r = captureRun({
      cwd: env.worktreeRoot,
      env: { CLAUDE_SESSION_ID: 'sess-1' },
      // no paths
    });
    expect(r.code).toBe(0);
    const agents = readAgents(path.join(env.mainRoot, '.caws'));
    expect(agents['sess-1'].claimed_paths).toEqual(['existing/claim']);
  });
});

describe('runClaimCommand --paths — CLI cap (256)', () => {
  let env;
  afterEach(() => env && env.cleanup());

  it('CLAIM_PATHS_MAX is 256', () => {
    expect(CLAIM_PATHS_MAX).toBe(256);
  });

  it('exactly 256 entries pass through', () => {
    env = mkRepoWithWorktree({
      prefix: 'caws-claim-paths-256-',
      owner: { session_id: 'sess-1', platform: 'claude-code' },
    });
    const paths = Array.from({ length: CLAIM_PATHS_MAX }, (_, i) => `p/${i}`);
    const r = captureRun({
      cwd: env.worktreeRoot,
      env: { CLAUDE_SESSION_ID: 'sess-1' },
      paths,
    });
    expect(r.code).toBe(0);
    const agents = readAgents(path.join(env.mainRoot, '.caws'));
    expect(agents['sess-1'].claimed_paths.length).toBe(CLAIM_PATHS_MAX);
  });

  it('257 entries fail closed with exit 2; agents.json unchanged', () => {
    env = mkRepoWithWorktree({
      prefix: 'caws-claim-paths-overcap-',
      owner: { session_id: 'sess-1', platform: 'claude-code' },
    });
    const paths = Array.from({ length: 257 }, (_, i) => `p/${i}`);
    const r = captureRun({
      cwd: env.worktreeRoot,
      env: { CLAUDE_SESSION_ID: 'sess-1' },
      paths,
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/257 entries exceeds the 256-entry cap/);
    expect(r.stderr).toMatch(/coarser globs/);
    // No partial write: agents.json should not have a claimed_paths for sess-1.
    const agentsFile = path.join(env.mainRoot, '.caws', 'agents.json');
    if (fs.existsSync(agentsFile)) {
      const agents = readAgents(path.join(env.mainRoot, '.caws'));
      const record = agents['sess-1'];
      if (record !== undefined) {
        expect(record.claimed_paths).toBeUndefined();
      }
    }
  });
});

describe('runClaimCommand --paths — structural validation', () => {
  let env;
  afterEach(() => env && env.cleanup());

  it('empty string entry fails closed with exit 2', () => {
    env = mkRepoWithWorktree({
      prefix: 'caws-claim-paths-empty-',
      owner: { session_id: 'sess-1', platform: 'claude-code' },
    });
    const r = captureRun({
      cwd: env.worktreeRoot,
      env: { CLAUDE_SESSION_ID: 'sess-1' },
      paths: ['valid', '', 'also-valid'],
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/index 1 is the empty string/);
  });

  it('NUL byte entry fails closed with exit 2', () => {
    env = mkRepoWithWorktree({
      prefix: 'caws-claim-paths-nul-',
      owner: { session_id: 'sess-1', platform: 'claude-code' },
    });
    const r = captureRun({
      cwd: env.worktreeRoot,
      env: { CLAUDE_SESSION_ID: 'sess-1' },
      paths: ['ok', 'bad\0path'],
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/index 1 contains a NUL byte/);
  });
});

describe('runClaimCommand --paths — cross-session non-clobber', () => {
  let env;
  afterEach(() => env && env.cleanup());

  it("writing session A's --paths leaves session B's record byte-identical", () => {
    env = mkRepoWithWorktree({
      prefix: 'caws-claim-paths-other-',
      owner: { session_id: 'sess-a', platform: 'claude-code' },
    });
    // Pre-populate agents.json with a sibling record.
    const cawsDir = path.join(env.mainRoot, '.caws');
    fs.writeFileSync(
      path.join(cawsDir, 'agents.json'),
      JSON.stringify(
        {
          'sess-b': {
            session_id: 'sess-b',
            last_active: '2026-05-22T00:00:00.000Z',
            platform: 'darwin',
            claimed_paths: ['sess-b/own/claim'],
            last_modified_paths: ['sess-b/mod-1.ts'],
          },
        },
        null,
        2
      )
    );
    const r = captureRun({
      cwd: env.worktreeRoot,
      env: { CLAUDE_SESSION_ID: 'sess-a' },
      paths: ['sess-a/new/claim'],
    });
    expect(r.code).toBe(0);
    const agents = readAgents(cawsDir);
    expect(agents['sess-b']).toEqual({
      session_id: 'sess-b',
      last_active: '2026-05-22T00:00:00.000Z',
      platform: 'darwin',
      claimed_paths: ['sess-b/own/claim'],
      last_modified_paths: ['sess-b/mod-1.ts'],
    });
    expect(agents['sess-a'].claimed_paths).toEqual(['sess-a/new/claim']);
  });
});
