/**
 * Tests for the shared git-autocommit utility used by worktrees-writer
 * lifecycle transitions.
 *
 * CAWS-FIRST-CONTACT-UX-001 A6/A7/A8 + the empty-stage defensive case.
 *
 * Integration-style: real temp git repos, real `git` invocations. No
 * stubbing. The whole point of this utility is the interaction with
 * git's working-tree state model; mocking git defeats the test.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  autoCommit,
  isPathDirty,
  relativeToRepoRoot,
} = require('../../dist/store/git-autocommit');

function mkBareGitRepo(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync('git', ['init', '--quiet', '-b', 'main', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@test.com']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test User']);
  execFileSync('git', ['-C', root, 'commit', '--quiet', '--allow-empty', '-m', 'init']);
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

function stageAndCommit(repoRoot, message) {
  execFileSync('git', ['-C', repoRoot, 'add', '-A']);
  execFileSync('git', ['-C', repoRoot, 'commit', '--quiet', '-m', message]);
}

// ============================================================
// CAWS-AUTOCOMMIT-INTEGRITY-001 A1: path-scoped commit must NOT
// sweep a foreign pre-staged file from the shared index.
// ============================================================
describe('autoCommit — A1: path-scoped commit ignores ambient index', () => {
  let repoRoot;
  afterEach(() => rmrf(repoRoot));

  it('commits ONLY the writer\'s paths, leaving a sibling-staged file uncommitted', () => {
    repoRoot = mkBareGitRepo('autocommit-a1-pathscope-');
    // Baseline: both files exist and are committed.
    writeFile(repoRoot, '.caws/worktrees.json', '{}\n');
    writeFile(repoRoot, 'sibling.txt', 'baseline\n');
    stageAndCommit(repoRoot, 'chore: initial');

    // A concurrent sibling session pre-stages an UNRELATED file into the
    // shared index (the cross-worktree shared-index hazard).
    writeFile(repoRoot, 'sibling.txt', 'sibling work in progress\n');
    execFileSync('git', ['-C', repoRoot, 'add', '--', 'sibling.txt']);

    // The CAWS writer mutates its OWN file and calls autoCommit.
    writeFile(
      repoRoot,
      '.caws/worktrees.json',
      JSON.stringify({ foo: { specId: 'BAR-001' } }, null, 2)
    );
    const outcome = autoCommit({
      repoRoot,
      paths: ['.caws/worktrees.json'],
      message: 'chore(caws): bind foo to BAR-001',
      wasDirtyBeforeWrite: false,
    });

    expect(outcome.kind).toBe('committed');

    // The commit must contain EXACTLY the writer's path — never sibling.txt.
    const committedFiles = execFileSync(
      'git',
      ['-C', repoRoot, 'show', '--name-only', '--pretty=format:', 'HEAD'],
      { encoding: 'utf8' }
    )
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    expect(committedFiles).toEqual(['.caws/worktrees.json']);

    // sibling.txt must remain staged-but-uncommitted, untouched.
    const stagedAfter = execFileSync(
      'git',
      ['-C', repoRoot, 'diff', '--cached', '--name-only'],
      { encoding: 'utf8' }
    ).trim();
    expect(stagedAfter).toBe('sibling.txt');
  });
});

// ============================================================
// A6: clean baseline → commit succeeds, returns sha
// ============================================================
describe('autoCommit — A6: clean baseline', () => {
  let repoRoot;
  afterEach(() => rmrf(repoRoot));

  it('commits the writer\'s change and returns kind:committed with a sha', () => {
    repoRoot = mkBareGitRepo('autocommit-a6-clean-');
    // Establish baseline: .caws/worktrees.json committed as '{}'
    writeFile(repoRoot, '.caws/worktrees.json', '{}\n');
    stageAndCommit(repoRoot, 'chore: initial registry');

    // Simulate writer's mutation
    writeFile(
      repoRoot,
      '.caws/worktrees.json',
      JSON.stringify({ foo: { specId: 'BAR-001' } }, null, 2)
    );

    const outcome = autoCommit({
      repoRoot,
      paths: ['.caws/worktrees.json'],
      message: 'chore(caws): bind foo to BAR-001',
      wasDirtyBeforeWrite: false,
    });

    expect(outcome.kind).toBe('committed');
    expect(outcome.sha).toMatch(/^[0-9a-f]{7,}$/);

    // Working tree should now be clean.
    const status = execFileSync('git', ['-C', repoRoot, 'status', '--porcelain'], {
      encoding: 'utf8',
    });
    expect(status.trim()).toBe('');

    // git log should show the new commit with our exact subject.
    const subject = execFileSync(
      'git',
      ['-C', repoRoot, 'log', '-1', '--pretty=%s'],
      { encoding: 'utf8' }
    );
    expect(subject.trim()).toBe('chore(caws): bind foo to BAR-001');
  });

  it('does NOT use --no-verify (commits go through whatever hooks exist)', () => {
    // Install a pre-commit hook that fails. autoCommit MUST surface
    // that failure rather than silently bypassing it.
    repoRoot = mkBareGitRepo('autocommit-a6-hook-');
    writeFile(repoRoot, '.caws/worktrees.json', '{}\n');
    stageAndCommit(repoRoot, 'chore: initial');

    const hookDir = path.join(repoRoot, '.git', 'hooks');
    fs.mkdirSync(hookDir, { recursive: true });
    const hookPath = path.join(hookDir, 'pre-commit');
    fs.writeFileSync(
      hookPath,
      '#!/bin/sh\necho "TEST-HOOK-REFUSE" >&2\nexit 1\n'
    );
    fs.chmodSync(hookPath, 0o755);

    writeFile(repoRoot, '.caws/worktrees.json', '{"x":1}\n');
    const outcome = autoCommit({
      repoRoot,
      paths: ['.caws/worktrees.json'],
      message: 'chore(caws): test',
      wasDirtyBeforeWrite: false,
    });

    // Hook fired; commit refused; outcome surfaces the reason.
    expect(outcome.kind).toBe('refused_dirty');
    expect(outcome.reason).toMatch(/TEST-HOOK-REFUSE/);

    // The writer's write is still in the working tree.
    const wt = fs.readFileSync(
      path.join(repoRoot, '.caws/worktrees.json'),
      'utf8'
    );
    expect(wt).toBe('{"x":1}\n');
  });
});

// ============================================================
// A7: dirty pre-write → refuse, leave writer's change in tree
// ============================================================
describe('autoCommit — A7: dirty pre-write', () => {
  let repoRoot;
  afterEach(() => rmrf(repoRoot));

  it('refuses with kind:refused_dirty and a typed reason when caller signals dirty pre-write', () => {
    repoRoot = mkBareGitRepo('autocommit-a7-dirty-');
    writeFile(repoRoot, '.caws/worktrees.json', '{}\n');
    stageAndCommit(repoRoot, 'chore: initial');

    // Pretend an unrelated edit made the file dirty BEFORE the writer's
    // own write. The writer then writes its own state on top.
    writeFile(
      repoRoot,
      '.caws/worktrees.json',
      JSON.stringify({ writer_change: true }, null, 2)
    );

    const outcome = autoCommit({
      repoRoot,
      paths: ['.caws/worktrees.json'],
      message: 'chore(caws): bind foo',
      wasDirtyBeforeWrite: true, // <-- the contract input
    });

    expect(outcome.kind).toBe('refused_dirty');
    expect(outcome.reason).toMatch(/dirty before the caws write/);
    expect(outcome.reason).toMatch(/git checkout/); // recovery hint
    expect(outcome.reason).toMatch(/\.caws\/worktrees\.json/);

    // The writer's change is still in the working tree (NOT rolled back).
    const wt = fs.readFileSync(
      path.join(repoRoot, '.caws/worktrees.json'),
      'utf8'
    );
    expect(wt).toMatch(/writer_change/);

    // git status still shows the file as modified — autoCommit did not
    // stage it (because pre-write was dirty; the user must resolve).
    const status = execFileSync('git', ['-C', repoRoot, 'status', '--porcelain'], {
      encoding: 'utf8',
    });
    expect(status).toMatch(/\.caws\/worktrees\.json/);
  });
});

// ============================================================
// A8: non-git fixture (defense-in-depth contract)
// ============================================================
describe('autoCommit — A8: non-git fixture', () => {
  let dir;
  afterEach(() => rmrf(dir));

  it('returns kind:skipped_no_git without throwing, attempting commit, or mutating state', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autocommit-a8-nogit-'));
    // No `git init`. Just a plain tmpdir with a file in it.
    writeFile(dir, '.caws/worktrees.json', '{"foo":1}\n');

    const outcome = autoCommit({
      repoRoot: dir,
      paths: ['.caws/worktrees.json'],
      message: 'chore(caws): test',
      wasDirtyBeforeWrite: false,
    });

    expect(outcome.kind).toBe('skipped_no_git');
    expect(outcome.sha).toBeUndefined();
    expect(outcome.reason).toBeUndefined();

    // File contents unchanged.
    const wt = fs.readFileSync(path.join(dir, '.caws/worktrees.json'), 'utf8');
    expect(wt).toBe('{"foo":1}\n');
  });
});

// ============================================================
// Defensive: writer no-op (file already matched HEAD)
// ============================================================
describe('autoCommit — writer no-op', () => {
  let repoRoot;
  afterEach(() => rmrf(repoRoot));

  it('does not create an empty commit when the writer\'s "write" matched HEAD', () => {
    repoRoot = mkBareGitRepo('autocommit-noop-');
    writeFile(repoRoot, '.caws/worktrees.json', '{"x":1}\n');
    stageAndCommit(repoRoot, 'chore: initial');

    const before = execFileSync(
      'git', ['-C', repoRoot, 'rev-parse', 'HEAD'],
      { encoding: 'utf8' }
    ).trim();

    // Writer "writes" identical content
    writeFile(repoRoot, '.caws/worktrees.json', '{"x":1}\n');

    const outcome = autoCommit({
      repoRoot,
      paths: ['.caws/worktrees.json'],
      message: 'chore(caws): no-op',
      wasDirtyBeforeWrite: false,
    });

    expect(outcome.kind).toBe('committed');
    // sha is empty string to signal "already at HEAD"
    expect(outcome.sha).toBe('');

    const after = execFileSync(
      'git', ['-C', repoRoot, 'rev-parse', 'HEAD'],
      { encoding: 'utf8' }
    ).trim();
    expect(after).toBe(before); // no new commit
  });
});

// ============================================================
// Helpers (isPathDirty + relativeToRepoRoot)
// ============================================================
describe('autoCommit helpers', () => {
  let repoRoot;
  afterEach(() => rmrf(repoRoot));

  it('isPathDirty returns false for unchanged file, true for modified file', () => {
    repoRoot = mkBareGitRepo('autocommit-helpers-');
    writeFile(repoRoot, '.caws/worktrees.json', '{}\n');
    stageAndCommit(repoRoot, 'chore: initial');

    expect(isPathDirty(repoRoot, '.caws/worktrees.json')).toBe(false);

    writeFile(repoRoot, '.caws/worktrees.json', '{"x":1}\n');
    expect(isPathDirty(repoRoot, '.caws/worktrees.json')).toBe(true);
  });

  it('isPathDirty returns false outside a git repo (defense-in-depth)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autocommit-helpers-nogit-'));
    try {
      writeFile(dir, '.caws/worktrees.json', '{}\n');
      expect(isPathDirty(dir, '.caws/worktrees.json')).toBe(false);
    } finally {
      rmrf(dir);
    }
  });

  it('relativeToRepoRoot converts absolute to repo-relative', () => {
    const root = '/tmp/fake/repo';
    expect(relativeToRepoRoot(root, '/tmp/fake/repo/.caws/worktrees.json')).toBe(
      '.caws/worktrees.json'
    );
  });
});
