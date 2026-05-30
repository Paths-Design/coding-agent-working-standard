/**
 * Tests for CAWS-LATCH-READONLY-AND-WORKTREE-GITIGNORE-001 (A5/A6):
 * the git-autocommit utility must not hard-fail when an input path is
 * intentionally gitignored (e.g. .caws/worktrees.json, which caws init
 * gitignores as ephemeral per-CLI state). It filters ignored paths before
 * staging, commits only tracked paths, and treats an all-ignored path set as
 * a clean no-op — and NEVER force-adds (-f) a gitignored path.
 *
 * Integration-style: real temp git repos, real `git`. No stubbing — the whole
 * point is the interaction with git's ignore + index model.
 *
 * @author @darianrosebrook
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { autoCommit } = require('../../dist/store/git-autocommit');

function mkBareGitRepo(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync('git', ['init', '--quiet', '-b', 'main', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@test.com']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test User']);
  execFileSync('git', [
    '-C', root, 'commit', '--quiet', '--allow-empty', '-m', 'init',
  ]);
  return root;
}

function rmrf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

function writeFile(repoRoot, relPath, content) {
  const abs = path.join(repoRoot, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function isTracked(repoRoot, relPath) {
  const r = execFileSync(
    'git',
    ['-C', repoRoot, 'ls-files', '--', relPath],
    { encoding: 'utf8' }
  );
  return r.trim().length > 0;
}

describe('autoCommit — gitignored registry state (A5/A6)', () => {
  let repoRoot;
  afterEach(() => rmrf(repoRoot));

  // ── A5: mixed path set — one gitignored, one tracked ───────────────
  it('A5: commits the tracked spec path and skips the gitignored worktrees.json', () => {
    repoRoot = mkBareGitRepo('caws-autocommit-ignore-');
    // Mirror caws init's gitignore policy: worktrees.json is ephemeral.
    writeFile(repoRoot, '.gitignore', '.caws/worktrees.json\n');
    execFileSync('git', ['-C', repoRoot, 'add', '.gitignore']);
    execFileSync('git', ['-C', repoRoot, 'commit', '--quiet', '-m', 'gitignore']);

    // The lifecycle write: a tracked spec binding + the ignored registry.
    writeFile(repoRoot, '.caws/specs/CLI-X-001.yaml', 'id: CLI-X-001\nworktree: w1\n');
    writeFile(repoRoot, '.caws/worktrees.json', '{"w1":{"spec_id":"CLI-X-001"}}\n');

    const outcome = autoCommit({
      repoRoot,
      paths: ['.caws/worktrees.json', '.caws/specs/CLI-X-001.yaml'],
      message: 'chore(caws): bind spec CLI-X-001 to worktree w1',
      wasDirtyBeforeWrite: false,
    });

    expect(outcome.kind).toBe('committed');
    expect(outcome.sha).toBeTruthy(); // a real commit landed
    // The tracked spec path is committed...
    expect(isTracked(repoRoot, '.caws/specs/CLI-X-001.yaml')).toBe(true);
    // ...and the gitignored registry was NOT force-tracked.
    expect(isTracked(repoRoot, '.caws/worktrees.json')).toBe(false);
  });

  it('A5: does not report "git add failed: paths are ignored"', () => {
    repoRoot = mkBareGitRepo('caws-autocommit-ignore2-');
    writeFile(repoRoot, '.gitignore', '.caws/worktrees.json\n');
    execFileSync('git', ['-C', repoRoot, 'add', '.gitignore']);
    execFileSync('git', ['-C', repoRoot, 'commit', '--quiet', '-m', 'gitignore']);
    writeFile(repoRoot, '.caws/specs/CLI-X-001.yaml', 'id: CLI-X-001\n');
    writeFile(repoRoot, '.caws/worktrees.json', '{"w1":{}}\n');

    const outcome = autoCommit({
      repoRoot,
      paths: ['.caws/worktrees.json', '.caws/specs/CLI-X-001.yaml'],
      message: 'chore(caws): bind',
      wasDirtyBeforeWrite: false,
    });
    // Previously this returned refused_dirty with "git add failed: ... ignored".
    expect(outcome.kind).toBe('committed');
    if (outcome.kind === 'refused_dirty') {
      expect(outcome.reason).not.toMatch(/ignored/);
    }
  });

  // ── A6: all-ignored path set → clean no-op, not a failure ──────────
  it('A6: an all-gitignored path set is committed-with-no-sha, not refused', () => {
    repoRoot = mkBareGitRepo('caws-autocommit-allignore-');
    writeFile(repoRoot, '.gitignore', '.caws/worktrees.json\n.caws/agents.json\n');
    execFileSync('git', ['-C', repoRoot, 'add', '.gitignore']);
    execFileSync('git', ['-C', repoRoot, 'commit', '--quiet', '-m', 'gitignore']);
    writeFile(repoRoot, '.caws/worktrees.json', '{"w1":{}}\n');
    writeFile(repoRoot, '.caws/agents.json', '{}\n');

    const outcome = autoCommit({
      repoRoot,
      paths: ['.caws/worktrees.json', '.caws/agents.json'],
      message: 'chore(caws): registry-only write',
      wasDirtyBeforeWrite: false,
    });
    expect(outcome.kind).toBe('committed');
    expect(outcome.sha).toBe(''); // nothing tracked to commit
    // Neither ignored file got force-tracked.
    expect(isTracked(repoRoot, '.caws/worktrees.json')).toBe(false);
    expect(isTracked(repoRoot, '.caws/agents.json')).toBe(false);
  });

  // ── regression guard: a fully-tracked path set still commits normally ─
  it('regression: an all-tracked path set commits exactly those paths', () => {
    repoRoot = mkBareGitRepo('caws-autocommit-tracked-');
    writeFile(repoRoot, '.caws/specs/CLI-Y-001.yaml', 'id: CLI-Y-001\n');

    const outcome = autoCommit({
      repoRoot,
      paths: ['.caws/specs/CLI-Y-001.yaml'],
      message: 'chore(caws): create CLI-Y-001',
      wasDirtyBeforeWrite: false,
    });
    expect(outcome.kind).toBe('committed');
    expect(outcome.sha).toBeTruthy();
    expect(isTracked(repoRoot, '.caws/specs/CLI-Y-001.yaml')).toBe(true);
  });
});
