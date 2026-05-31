/**
 * Tests for configureWorktreeSparseCheckout
 * (WORKTREE-SPEC-AUTHORITY-CONTROL-PLANE-001 A1; coverage backfill under
 * CAWS-CLI-COVERAGE-FLOOR-001).
 *
 * The SUT runs three sequential git steps (sparse-checkout init → set →
 * checkout) against a freshly-added `--no-checkout` worktree, returning a
 * Result-shape `{ ok: true }` or `{ ok: false, reason, step }` on the first
 * failing step. The integration path only ever exercised the happy path; these
 * tests cover the happy path explicitly plus the `init`-step failure branch.
 *
 * The `set` and `checkout` failure branches are best-effort: triggering them
 * reliably requires corrupting git state between steps, which is fragile on
 * CI. The `init` failure (a non-git directory) plus the happy path together
 * cover the function's primary branching; the remaining two failure returns
 * are noted as pending a test-seam extraction.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  configureWorktreeSparseCheckout,
} = require('../../dist/store/git-sparse-checkout');

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Create a real temp git repo with a committed README and a .caws/specs file. */
function mkTempRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsc-test-'));
  execFileSync('git', ['init', '--quiet', '-b', 'main', root], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  git(root, ['config', 'user.email', 'test@test.com']);
  git(root, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(root, 'README.md'), 'hello\n');
  fs.mkdirSync(path.join(root, '.caws', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(root, '.caws', 'specs', 'X.yaml'), 'id: X\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '--quiet', '-m', 'init']);
  return root;
}

describe('configureWorktreeSparseCheckout', () => {
  const cleanups = [];

  afterEach(() => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop();
      try {
        fn();
      } catch {
        // best-effort temp cleanup
      }
    }
  });

  it('happy path: materializes the tree but excludes .caws/specs/', () => {
    const root = mkTempRepo();
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    // Detached HEAD so the worktree does not collide with main checked out
    // in `root` itself. --no-checkout leaves the tree empty for the SUT.
    const wt = path.join(os.tmpdir(), path.basename(root) + '-wt');
    git(root, ['worktree', 'add', '--no-checkout', '--detach', wt]);
    cleanups.push(() => {
      try {
        git(root, ['worktree', 'remove', '--force', wt]);
      } catch {
        fs.rmSync(wt, { recursive: true, force: true });
      }
    });

    const result = configureWorktreeSparseCheckout(wt);

    expect(result.ok).toBe(true);
    // The normal tree is checked out…
    expect(fs.existsSync(path.join(wt, 'README.md'))).toBe(true);
    // …but the control-plane authority directory is excluded.
    expect(fs.existsSync(path.join(wt, '.caws', 'specs', 'X.yaml'))).toBe(false);
  });

  it('init failure: a non-git directory returns { ok:false, step:"init" }', () => {
    const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), 'gsc-nonrepo-'));
    cleanups.push(() => fs.rmSync(notARepo, { recursive: true, force: true }));

    const result = configureWorktreeSparseCheckout(notARepo);

    expect(result.ok).toBe(false);
    expect(result.step).toBe('init');
    expect(typeof result.reason).toBe('string');
    expect(result.reason.length).toBeGreaterThan(0);
  });
});
