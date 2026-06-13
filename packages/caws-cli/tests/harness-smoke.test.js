'use strict';

/**
 * Harness self-proof for CAWS-TEST-HARNESS-FOUNDATION-001.
 *
 * This is NOT a SUT test (no production behavior is asserted here). It proves
 * the harness PRIMITIVES the rest of the campaign depends on actually work:
 *  - A2: the git-repo factory produces isolated, real, per-worker temp repos.
 *  - A3: the hook-install primitive installs ONCE per suite (beforeAll), not
 *        per test, and the install counter is honest.
 *  - A4: these run under jest's default parallel workers without deadlock
 *        (this file plus its siblings exercise the parallel path; the
 *        per-worker temp-dir isolation is what makes that safe).
 *
 * Kept as a permanent regression guard: if a future change regresses the
 * factory's isolation or the once-per-suite install contract, this fails.
 */

const fs = require('fs');
const path = require('path');
const {
  makeTempRepo,
  cleanupAll,
  git,
} = require('./helpers/git-repo-factory');
const {
  installOnce,
  getInstallCount,
  resetInstallCount,
  CLI_DIST_ENTRY,
} = require('./helpers/hook-install');

describe('harness: git-repo factory (A2)', () => {
  afterAll(() => cleanupAll());

  test('creates a real, isolated git repo with HEAD', () => {
    const repo = makeTempRepo();
    expect(fs.existsSync(path.join(repo, '.git'))).toBe(true);
    // Real repo: HEAD resolves to the empty root commit.
    const head = git(repo, ['rev-parse', 'HEAD']);
    expect(head).toMatch(/^[0-9a-f]{40}$/);
    // Default branch is main.
    expect(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main');
  });

  test('two repos are distinct directories and do not share an index', () => {
    const a = makeTempRepo();
    const b = makeTempRepo();
    expect(a).not.toBe(b);
    // Stage a file in A; B's index must be unaffected (isolation proof).
    fs.writeFileSync(path.join(a, 'only-in-a.txt'), 'x');
    git(a, ['add', 'only-in-a.txt']);
    expect(git(a, ['diff', '--cached', '--name-only'])).toBe('only-in-a.txt');
    expect(git(b, ['diff', '--cached', '--name-only'])).toBe('');
  });

  test('repo lives under the OS temp dir, never under the project tree', () => {
    const repo = makeTempRepo();
    const os = require('os');
    expect(repo.startsWith(os.tmpdir())).toBe(true);
    expect(repo.includes('/packages/caws-cli/')).toBe(false);
  });

  test('initialCommit:false yields a repo with no HEAD', () => {
    const repo = makeTempRepo({ initialCommit: false });
    // rev-parse HEAD fails (no commit yet); git() with allowFail returns ''.
    expect(git(repo, ['rev-parse', 'HEAD'], { allowFail: true })).toBe('');
  });
});

describe('harness: shared hook-install primitive (A3)', () => {
  let ctx;

  beforeAll(() => {
    resetInstallCount();
    ctx = installOnce(makeTempRepo(), { agentSurface: 'claude-code' });
  });
  afterAll(() => cleanupAll());

  test('the local dist CLI entry exists (tests run against built code, not global caws)', () => {
    expect(fs.existsSync(CLI_DIST_ENTRY)).toBe(true);
    expect(CLI_DIST_ENTRY).toMatch(/packages\/caws-cli\/dist\/index\.js$/);
  });

  test('init succeeded and created .caws/', () => {
    expect(ctx.code).toBe(0);
    expect(fs.existsSync(path.join(ctx.repoDir, '.caws'))).toBe(true);
  });

  test('install ran exactly ONCE for the whole suite (beforeAll, not beforeEach)', () => {
    // Three test() bodies in this describe; if install were per-test the count
    // would climb to 3. The once-per-suite contract pins it at 1.
    expect(getInstallCount()).toBe(1);
  });
});
