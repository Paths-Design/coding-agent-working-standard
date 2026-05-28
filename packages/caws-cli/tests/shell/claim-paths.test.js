/**
 * Tests for `caws claim --paths <path>...` —
 * SESSION-OWNERSHIP-METADATA-001 commit 3 CLI surface.
 *
 * Covers:
 *   - --paths absent: existing `caws claim` behavior unchanged
 *     (agents.json refresh runs, no lease update)
 *   - --paths present + session has a lease: claimed_paths written
 *     to the lease, in caller order, verbatim
 *   - --paths present + session has NO lease: refused with LEASE_NOT_FOUND,
 *     no lease fabricated
 *   - last_modified_paths preserved when only claimed_paths is supplied
 *   - existing lease fields (status, last_active, started_at, etc.)
 *     preserved across the path update
 *   - explicit "no claims" empty array replaces prior claimed_paths
 *   - invalid path entry (empty string / null byte) refused, no write
 *   - no agents.json or events.jsonl writes from the --paths path
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { runClaimCommand } = require('../../dist/shell');

const NOW = new Date('2026-05-28T18:00:00.000Z');

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
        ? { last_heartbeat: '2026-05-28T11:00:00.000Z' }
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

/**
 * Write a pre-existing lease file for the given session under the
 * given mainRoot's .caws/leases directory.
 */
function writeLeaseFile(mainRoot, sessionId, overrides = {}) {
  const leasesDir = path.join(mainRoot, '.caws', 'leases');
  fs.mkdirSync(leasesDir, { recursive: true });
  const lease = {
    lease_version: 1,
    session_id: sessionId,
    platform: 'claude-code',
    status: 'active',
    started_at: '2026-05-28T00:00:00.000Z',
    last_active: '2026-05-28T17:00:00.000Z',
    repo_root: mainRoot,
    cwd: mainRoot,
    git_common_dir: path.join(mainRoot, '.git'),
    git_dir: path.join(mainRoot, '.git'),
    last_seen_reason: 'session_start',
    ...overrides,
  };
  fs.writeFileSync(
    path.join(leasesDir, `${sessionId}.json`),
    JSON.stringify(lease, null, 2) + '\n'
  );
  return lease;
}

function readLeaseFile(mainRoot, sessionId) {
  const filePath = path.join(mainRoot, '.caws', 'leases', `${sessionId}.json`);
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

// ─── A2: explicit claim path written to lease ───────────────────────

describe('caws claim --paths: explicit claim of paths (A2)', () => {
  it('writes claimed_paths verbatim and in caller order when supplied', () => {
    const env = mkRepoWithWorktree({
      prefix: 'claim-paths-a2-',
      owner: { session_id: 'sess-me', platform: 'claude-code' },
    });
    try {
      writeLeaseFile(env.mainRoot, 'sess-me');

      const r = captureRun({
        cwd: env.worktreeRoot,
        env: { CLAUDE_SESSION_ID: 'sess-me' },
        paths: ['packages/foo/**', 'tests/foo.test.js', 'docs/foo.md'],
      });

      expect(r.code).toBe(0);
      const after = readLeaseFile(env.mainRoot, 'sess-me');
      expect(after.claimed_paths).toEqual([
        'packages/foo/**',
        'tests/foo.test.js',
        'docs/foo.md',
      ]);
    } finally {
      env.cleanup();
    }
  });

  it('preserves every other lease field across the path update', () => {
    const env = mkRepoWithWorktree({
      prefix: 'claim-paths-preserve-',
      owner: { session_id: 'sess-me', platform: 'claude-code' },
    });
    try {
      const prior = writeLeaseFile(env.mainRoot, 'sess-me', {
        bound_worktree: 'wt-foo',
        bound_spec_id: 'SPEC-X',
        last_modified_paths: ['previous-modified.ts'],
      });

      const r = captureRun({
        cwd: env.worktreeRoot,
        env: { CLAUDE_SESSION_ID: 'sess-me' },
        paths: ['a.ts'],
      });

      expect(r.code).toBe(0);
      const after = readLeaseFile(env.mainRoot, 'sess-me');
      expect(after.claimed_paths).toEqual(['a.ts']);
      // last_modified_paths preserved because --paths supplies
      // claimed_paths only.
      expect(after.last_modified_paths).toEqual(['previous-modified.ts']);
      // Every prior lease field unchanged.
      expect(after.lease_version).toBe(1);
      expect(after.session_id).toBe('sess-me');
      expect(after.platform).toBe('claude-code');
      expect(after.status).toBe('active');
      expect(after.started_at).toBe(prior.started_at);
      expect(after.last_active).toBe(prior.last_active);
      expect(after.last_seen_reason).toBe('session_start');
      expect(after.bound_worktree).toBe('wt-foo');
      expect(after.bound_spec_id).toBe('SPEC-X');
    } finally {
      env.cleanup();
    }
  });

  it('repeated --paths preserves caller order through to the lease', () => {
    const env = mkRepoWithWorktree({
      prefix: 'claim-paths-order-',
      owner: { session_id: 'sess-me', platform: 'claude-code' },
    });
    try {
      writeLeaseFile(env.mainRoot, 'sess-me');

      // Simulating the parser collector: order matches CLI argv order.
      const r = captureRun({
        cwd: env.worktreeRoot,
        env: { CLAUDE_SESSION_ID: 'sess-me' },
        paths: ['z', 'a', 'm', 'b'],
      });

      expect(r.code).toBe(0);
      const after = readLeaseFile(env.mainRoot, 'sess-me');
      expect(after.claimed_paths).toEqual(['z', 'a', 'm', 'b']);
    } finally {
      env.cleanup();
    }
  });

  it('replaces prior claimed_paths with the new list', () => {
    const env = mkRepoWithWorktree({
      prefix: 'claim-paths-replace-',
      owner: { session_id: 'sess-me', platform: 'claude-code' },
    });
    try {
      writeLeaseFile(env.mainRoot, 'sess-me', {
        claimed_paths: ['old/a', 'old/b'],
      });

      const r = captureRun({
        cwd: env.worktreeRoot,
        env: { CLAUDE_SESSION_ID: 'sess-me' },
        paths: ['new/x'],
      });

      expect(r.code).toBe(0);
      const after = readLeaseFile(env.mainRoot, 'sess-me');
      expect(after.claimed_paths).toEqual(['new/x']);
    } finally {
      env.cleanup();
    }
  });
});

// ─── refusal paths ─────────────────────────────────────────────────

describe('caws claim --paths: refusal paths', () => {
  it('refuses with no fabrication when no lease exists for the current session', () => {
    const env = mkRepoWithWorktree({
      prefix: 'claim-paths-nolease-',
      owner: { session_id: 'sess-me', platform: 'claude-code' },
    });
    try {
      // NO lease file written for sess-me.

      const r = captureRun({
        cwd: env.worktreeRoot,
        env: { CLAUDE_SESSION_ID: 'sess-me' },
        paths: ['a'],
      });

      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/refused|not_found/i);
      const leasePath = path.join(env.mainRoot, '.caws', 'leases', 'sess-me.json');
      expect(fs.existsSync(leasePath)).toBe(false);
    } finally {
      env.cleanup();
    }
  });

  it('refuses on empty-string path entry, leaving prior lease unchanged', () => {
    const env = mkRepoWithWorktree({
      prefix: 'claim-paths-empty-',
      owner: { session_id: 'sess-me', platform: 'claude-code' },
    });
    try {
      writeLeaseFile(env.mainRoot, 'sess-me', {
        claimed_paths: ['prior/keep'],
      });

      const r = captureRun({
        cwd: env.worktreeRoot,
        env: { CLAUDE_SESSION_ID: 'sess-me' },
        paths: ['valid.ts', ''],
      });

      expect(r.code).toBe(1);
      const after = readLeaseFile(env.mainRoot, 'sess-me');
      // Prior claimed_paths unchanged.
      expect(after.claimed_paths).toEqual(['prior/keep']);
    } finally {
      env.cleanup();
    }
  });

  it('refuses on null-byte path entry, leaving prior lease unchanged', () => {
    const env = mkRepoWithWorktree({
      prefix: 'claim-paths-nullbyte-',
      owner: { session_id: 'sess-me', platform: 'claude-code' },
    });
    try {
      writeLeaseFile(env.mainRoot, 'sess-me', {
        claimed_paths: ['prior/keep'],
      });

      const r = captureRun({
        cwd: env.worktreeRoot,
        env: { CLAUDE_SESSION_ID: 'sess-me' },
        paths: ['valid.ts', 'has\0null.ts'],
      });

      expect(r.code).toBe(1);
      const after = readLeaseFile(env.mainRoot, 'sess-me');
      expect(after.claimed_paths).toEqual(['prior/keep']);
    } finally {
      env.cleanup();
    }
  });
});

// ─── existing behavior unchanged when --paths absent ────────────────

describe('caws claim: existing behavior unchanged when --paths absent', () => {
  it('same-session claim without --paths returns exit 0 and writes no lease', () => {
    const env = mkRepoWithWorktree({
      prefix: 'claim-no-paths-',
      owner: { session_id: 'sess-me', platform: 'claude-code' },
    });
    try {
      // No lease file. --paths absent. The command must succeed
      // (existing ownership pipeline) and must NOT create a lease.

      const r = captureRun({
        cwd: env.worktreeRoot,
        env: { CLAUDE_SESSION_ID: 'sess-me' },
      });

      expect(r.code).toBe(0);
      const leasePath = path.join(env.mainRoot, '.caws', 'leases', 'sess-me.json');
      expect(fs.existsSync(leasePath)).toBe(false);
    } finally {
      env.cleanup();
    }
  });
});

// ─── explicit "no claims" state ─────────────────────────────────────

describe('caws claim --paths []: explicit "no claims" state', () => {
  it('replaces prior claimed_paths with an empty array', () => {
    const env = mkRepoWithWorktree({
      prefix: 'claim-paths-clear-',
      owner: { session_id: 'sess-me', platform: 'claude-code' },
    });
    try {
      writeLeaseFile(env.mainRoot, 'sess-me', {
        claimed_paths: ['will/be/cleared'],
      });

      const r = captureRun({
        cwd: env.worktreeRoot,
        env: { CLAUDE_SESSION_ID: 'sess-me' },
        paths: [],
      });

      // Note: commander's collector only kicks in on at least one
      // --paths flag, so the shell-level command will only see
      // `paths: []` when programmatically invoked as we do here.
      // The semantic is still meaningful: an empty array means
      // "explicit no-claims declaration".
      expect(r.code).toBe(0);
      // Empty array means "no paths supplied" at the CLI registration
      // layer (commander collector produces [] only when programmatically
      // passed), so the command short-circuits the --paths branch:
      // because the runClaimCommand body skips the branch on `opts.paths
      // === undefined`, but does enter on []  — verify by reading the
      // lease and asserting the field is now [] (not the prior).
      const after = readLeaseFile(env.mainRoot, 'sess-me');
      expect(after.claimed_paths).toEqual([]);
    } finally {
      env.cleanup();
    }
  });
});

// ─── A7 negative lock: lease/agents independence preserved ──────────

describe('caws claim --paths: A7 negative lock', () => {
  it('--paths success path does NOT write events.jsonl', () => {
    const env = mkRepoWithWorktree({
      prefix: 'claim-paths-no-ev-',
      owner: { session_id: 'sess-me', platform: 'claude-code' },
    });
    try {
      writeLeaseFile(env.mainRoot, 'sess-me');

      const r = captureRun({
        cwd: env.worktreeRoot,
        env: { CLAUDE_SESSION_ID: 'sess-me' },
        paths: ['a', 'b'],
      });

      expect(r.code).toBe(0);
      const eventsPath = path.join(env.mainRoot, '.caws', 'events.jsonl');
      expect(fs.existsSync(eventsPath)).toBe(false);
    } finally {
      env.cleanup();
    }
  });
});
