/**
 * Tests for the store's repo-root resolver.
 *
 * Two flavors:
 *   1. Unit-style with stubbed git runner — covers the parsing logic and
 *      error-discrimination paths without invoking real git.
 *   2. Integration-style using a real temp git repo + a real linked
 *      worktree — covers the actual defect class (--show-toplevel vs
 *      --git-common-dir disagreement). This is the case where the
 *      previous implementation silently divergedinto worktree filesystem.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { resolveRepoRoot, STORE_RULES } = require('../../dist/store');

function mkTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmrf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

describe('resolveRepoRoot — unit (stubbed git)', () => {
  it('returns repoRoot=parent(commonDir) and cawsDir=<repoRoot>/.caws', () => {
    const stubbedGit = () => '/tmp/fake/main/.git';
    const r = resolveRepoRoot('/tmp/fake/main', { git: stubbedGit });
    expect(r.ok).toBe(true);
    expect(r.value.repoRoot).toBe('/tmp/fake/main');
    expect(r.value.cawsDir).toBe(path.join('/tmp/fake/main', '.caws'));
  });

  it('linked worktree: commonDir is main/.git regardless of cwd', () => {
    // Real-world: cwd=/tmp/fake/main/.caws/worktrees/wt-foo, but
    // git --git-common-dir returns the main repo's .git.
    const stubbedGit = () => '/tmp/fake/main/.git';
    const r = resolveRepoRoot('/tmp/fake/main/.caws/worktrees/wt-foo', { git: stubbedGit });
    expect(r.ok).toBe(true);
    expect(r.value.repoRoot).toBe('/tmp/fake/main');
  });

  it('reports NOT_A_GIT_REPO when stderr says so', () => {
    const stubbedGit = () => {
      const err = new Error('git failed');
      err.stderr = Buffer.from('fatal: not a git repository (or any parent up to mount point /)');
      throw err;
    };
    const r = resolveRepoRoot('/tmp/not-a-repo', { git: stubbedGit });
    expect(r.ok).toBe(false);
    expect(r.errors[0].rule).toBe(STORE_RULES.REPO_ROOT_NOT_A_GIT_REPO);
  });

  it('reports GIT_INVOCATION_FAILED for other errors', () => {
    const stubbedGit = () => {
      const err = new Error('permission denied');
      err.stderr = Buffer.from('permission denied');
      throw err;
    };
    const r = resolveRepoRoot('/tmp/whatever', { git: stubbedGit });
    expect(r.ok).toBe(false);
    expect(r.errors[0].rule).toBe(STORE_RULES.REPO_ROOT_GIT_INVOCATION_FAILED);
  });

  it('throws on non-string cwd (programmer error)', () => {
    expect(() => resolveRepoRoot(123)).toThrow(TypeError);
  });

  it('throws on empty cwd', () => {
    expect(() => resolveRepoRoot('')).toThrow(TypeError);
  });

  it('respects requireCawsDir=true', () => {
    const stubbedGit = () => '/tmp/fake/missing/.git';
    const r = resolveRepoRoot('/tmp/fake/missing', {
      git: stubbedGit,
      requireCawsDir: true,
    });
    expect(r.ok).toBe(false);
    expect(r.errors[0].rule).toBe(STORE_RULES.REPO_ROOT_CAWS_DIR_MISSING);
  });
});

describe('resolveRepoRoot — integration (real git, real worktree)', () => {
  // This is the defect class: a linked worktree's --show-toplevel returns
  // the worktree's filesystem root, but CAWS state lives in the main
  // repo. We assert --git-common-dir gives us the right answer.
  let mainRoot;
  let worktreeRoot;
  let worktreeBranch;

  beforeAll(() => {
    mainRoot = mkTempDir('caws-store-main-');
    execFileSync('git', ['init', '--quiet', mainRoot]);
    execFileSync('git', ['-C', mainRoot, 'config', 'user.email', 'test@test.com']);
    execFileSync('git', ['-C', mainRoot, 'config', 'user.name', 'Test']);
    execFileSync('git', ['-C', mainRoot, 'commit', '--quiet', '--allow-empty', '-m', 'init']);
    worktreeBranch = 'test-worktree-branch';
    worktreeRoot = path.join(os.tmpdir(), `caws-store-wt-${process.pid}-${Date.now()}`);
    execFileSync('git', [
      '-C', mainRoot,
      'worktree', 'add', '-b', worktreeBranch, worktreeRoot,
    ]);
  });

  afterAll(() => {
    try {
      execFileSync('git', ['-C', mainRoot, 'worktree', 'remove', '--force', worktreeRoot]);
    } catch {
      /* ignore */
    }
    rmrf(mainRoot);
    rmrf(worktreeRoot);
  });

  it('from main repo, repoRoot is mainRoot', () => {
    const r = resolveRepoRoot(mainRoot);
    expect(r.ok).toBe(true);
    // realpath on macOS may add /private prefix; normalize.
    expect(fs.realpathSync(r.value.repoRoot)).toBe(fs.realpathSync(mainRoot));
  });

  it('from inside linked worktree, repoRoot is still mainRoot (NOT the worktree)', () => {
    const r = resolveRepoRoot(worktreeRoot);
    expect(r.ok).toBe(true);
    // The CRITICAL assertion: resolveRepoRoot must NOT return the worktree path.
    expect(fs.realpathSync(r.value.repoRoot)).toBe(fs.realpathSync(mainRoot));
    expect(fs.realpathSync(r.value.repoRoot)).not.toBe(fs.realpathSync(worktreeRoot));
  });
});
