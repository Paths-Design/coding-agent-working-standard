'use strict';

/**
 * Store-layer contract for WORKTREE-LANE-DIVERGENCE-SURFACE-001.
 *
 * computeLaneDivergence is the single computation both `caws worktree list`
 * and `caws status` read. Everything above it is formatting, so the semantics
 * have to be pinned here:
 *
 *   - which side of the range is `ahead` and which is `behind` (a swap is the
 *     obvious mutation and produces a plausible-looking wrong answer);
 *   - `containsBase` is about the BASE being an ancestor, not about the lane
 *     being empty — a lane 1 ahead / 0 behind still contains its base;
 *   - an unresolvable ref yields nulls plus a reason, never a fabricated 0/0,
 *     because 0/0 reads as "this lane is current";
 *   - the computation writes nothing.
 */

const fs = require('fs');
const path = require('path');

const { computeLaneDivergence, formatLaneCounts } = require('../../dist/store');
const { cleanupAll, git, makeTempRepo } = require('../helpers/git-repo-factory');

afterAll(() => {
  cleanupAll();
});

/** Commit `message` on the current branch, touching one uniquely-named file. */
let seq = 0;
function commit(root, message) {
  seq += 1;
  const rel = `lane-fixture-${seq}.txt`;
  fs.writeFileSync(path.join(root, rel), `${message}\n`);
  git(root, ['add', rel]);
  git(root, ['commit', '--quiet', '-m', message]);
}

/** Every ref name → sha, so a test can assert nothing moved. */
function refSnapshot(root) {
  return git(root, ['for-each-ref', '--format=%(refname) %(objectname)']);
}

describe('computeLaneDivergence', () => {
  test('reports branch-only commits as ahead and base-only commits as behind', () => {
    const root = makeTempRepo();
    // Asymmetric on purpose: 2 vs 3 cannot survive a swapped ahead/behind.
    git(root, ['checkout', '--quiet', '-b', 'wt-demo']);
    commit(root, 'lane commit 1');
    commit(root, 'lane commit 2');
    git(root, ['checkout', '--quiet', 'main']);
    commit(root, 'base commit 1');
    commit(root, 'base commit 2');
    commit(root, 'base commit 3');

    const d = computeLaneDivergence(root, 'wt-demo', 'main');

    expect(d.unknownReason).toBeNull();
    expect(d.ahead).toBe(2);
    expect(d.behind).toBe(3);
    expect(d.containsBase).toBe(false);
    expect(d.branch).toBe('wt-demo');
    expect(d.baseBranch).toBe('main');
    expect(formatLaneCounts(d)).toBe('ahead=2 behind=3');

    // Corroborate against git's own answer for the same range, so the test
    // fails if the argument order into rev-list is reversed rather than only
    // if the parse is.
    const raw = git(root, ['rev-list', '--left-right', '--count', 'main...wt-demo']);
    expect(raw.split(/\s+/)).toEqual(['3', '2']);
  });

  test('a lane with its own commits but no base drift still contains base', () => {
    const root = makeTempRepo();
    git(root, ['checkout', '--quiet', '-b', 'wt-ahead']);
    commit(root, 'lane only commit');
    git(root, ['checkout', '--quiet', 'main']);

    const d = computeLaneDivergence(root, 'wt-ahead', 'main');

    // containsBase is NOT "the lane is empty" — this lane has work and is
    // still fully current with its base.
    expect(d.ahead).toBe(1);
    expect(d.behind).toBe(0);
    expect(d.containsBase).toBe(true);
    expect(formatLaneCounts(d)).toBe('ahead=1 behind=0');
  });

  test('a branch sitting exactly at base reports 0/0 and contains base', () => {
    const root = makeTempRepo();
    git(root, ['branch', 'wt-fresh']);

    const d = computeLaneDivergence(root, 'wt-fresh', 'main');

    expect(d.ahead).toBe(0);
    expect(d.behind).toBe(0);
    expect(d.containsBase).toBe(true);
    expect(d.unknownReason).toBeNull();
  });

  test('an unresolvable branch ref yields nulls and names the ref, never 0/0', () => {
    const root = makeTempRepo();

    const d = computeLaneDivergence(root, 'wt-deleted', 'main');

    expect(d.ahead).toBeNull();
    expect(d.behind).toBeNull();
    expect(d.containsBase).toBeNull();
    expect(d.unknownReason).toBe("branch ref 'wt-deleted' does not resolve");
    expect(formatLaneCounts(d)).toBe('ahead=? behind=?');
  });

  test('an unresolvable base ref is reported as the BASE failing, not the branch', () => {
    const root = makeTempRepo();
    git(root, ['branch', 'wt-demo']);

    const d = computeLaneDivergence(root, 'wt-demo', 'trunk');

    expect(d.unknownReason).toBe("base ref 'trunk' does not resolve");
    expect(d.ahead).toBeNull();
    expect(d.behind).toBeNull();
  });

  test('a registry entry missing branch or base is reported as a registry gap', () => {
    const root = makeTempRepo();

    expect(computeLaneDivergence(root, '', 'main').unknownReason).toBe(
      'registry entry records no branch'
    );
    expect(computeLaneDivergence(root, 'main', '').unknownReason).toBe(
      'registry entry records no base branch'
    );
  });

  test('the literal legacy placeholder "unknown" degrades instead of throwing', () => {
    const root = makeTempRepo();

    // listWorktreesPretty substitutes 'unknown' for a record with no branch;
    // that string must not reach git as a real ref and must not crash.
    const d = computeLaneDivergence(root, 'unknown', 'unknown');

    expect(d.unknownReason).toBe("branch ref 'unknown' does not resolve");
  });

  test('computing divergence writes nothing: HEAD and every ref are unchanged', () => {
    const root = makeTempRepo();
    git(root, ['checkout', '--quiet', '-b', 'wt-demo']);
    commit(root, 'lane commit');
    git(root, ['checkout', '--quiet', 'main']);
    commit(root, 'base commit');

    const headBefore = git(root, ['rev-parse', 'HEAD']);
    const branchBefore = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const refsBefore = refSnapshot(root);
    const statusBefore = git(root, ['status', '--porcelain']);

    computeLaneDivergence(root, 'wt-demo', 'main');
    computeLaneDivergence(root, 'wt-missing', 'main');

    expect(git(root, ['rev-parse', 'HEAD'])).toBe(headBefore);
    expect(git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(branchBefore);
    expect(refSnapshot(root)).toBe(refsBefore);
    expect(git(root, ['status', '--porcelain'])).toBe(statusBefore);
  });
});
