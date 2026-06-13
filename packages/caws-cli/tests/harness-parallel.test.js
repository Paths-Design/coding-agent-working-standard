'use strict';

/**
 * Parallel-contention proof for CAWS-TEST-HARNESS-FOUNDATION-001 (A4).
 *
 * The deleted corpus DEADLOCKED under jest's default parallel workers. The
 * root cause was fixture contention on shared on-disk state: when fixtures
 * created repos / ran `caws init` against paths inside the project tree, two
 * workers raced on the same git index and the same `.caws/` runtime files
 * (worktrees.json, leases/, the guard-strike files). `--runInBand` masked it
 * by serializing everything.
 *
 * This suite reproduces the contention shape the old one died on — multiple
 * concurrent `caws init` runs — but against PER-CALL isolated temp repos from
 * the factory. If isolation is correct, N concurrent installs all complete and
 * each repo is independently valid. If a future change reintroduces shared
 * state, this is where the hang/cross-talk surfaces.
 *
 * Existence of this file ALSO forces jest to schedule >1 test suite, so
 * running the tests/ dir spins up multiple workers — exercising the real
 * cross-worker path, not a single-worker illusion.
 */

const fs = require('fs');
const path = require('path');
const { makeTempRepo, cleanupAll, git } = require('./helpers/git-repo-factory');
const { runInit } = require('./helpers/hook-install');

describe('harness: parallel install contention (A4)', () => {
  afterAll(() => cleanupAll());

  test('N concurrent caws init runs into isolated repos all complete', async () => {
    const N = 4;
    const repos = Array.from({ length: N }, () => makeTempRepo());

    // Fire all installs concurrently. The old corpus would deadlock here if
    // the repos shared on-disk state; isolated repos let them truly overlap.
    const results = await Promise.all(
      repos.map((repo) => Promise.resolve().then(() => runInit(repo, { agentSurface: 'claude-code' })))
    );

    // Every install succeeded.
    for (const r of results) {
      expect(r.code).toBe(0);
    }
    // Every repo is independently a valid initialized CAWS project.
    for (const repo of repos) {
      expect(fs.existsSync(path.join(repo, '.caws'))).toBe(true);
      // Each repo's git state is its own: no cross-repo index bleed.
      expect(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main');
    }
    // All repo paths are distinct.
    expect(new Set(repos).size).toBe(N);
  }, 120000);
});
