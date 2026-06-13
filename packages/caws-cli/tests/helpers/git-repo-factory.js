'use strict';

/**
 * Isolated temp-git-repo factory for the CAWS test harness.
 *
 * CAWS-TEST-HARNESS-FOUNDATION-001 (A2, A4). This is the centerpiece of the
 * deadlock fix. The deleted corpus deadlocked under jest's parallel workers
 * because fixtures contended on shared on-disk state — the git index, the
 * working tree, and `.caws/` runtime files (leases, worktrees.json, the strike
 * files). Every repo created here is a UNIQUE directory under the OS temp dir,
 * never under the project tree, so two workers can never touch the same index
 * or `.caws/` state.
 *
 * Isolation guarantees:
 *  - Each repo is `fs.mkdtemp`-unique AND namespaced by jest worker id
 *    (JEST_WORKER_ID) so even same-millisecond creations across workers don't
 *    collide.
 *  - `git` runs with `-C <repo>` and an env that pins HOME/GIT_CONFIG_* to the
 *    repo, so a developer's global git config (hooks, templates, signing) can't
 *    leak in and make a test machine-dependent.
 *  - No network, no shared submodule cache: `git init` + local config + an
 *    empty root commit. ~tens of ms, not the 198ms the old factory cost.
 *
 * Cleanup: callers register repos for teardown. `cleanupAll()` (call in
 * afterAll) removes every repo this module created in the current worker. A
 * process-exit hook is a backstop so a thrown test never leaks a temp dir.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const WORKER = process.env.JEST_WORKER_ID || '0';
/** @type {Set<string>} repos created in THIS worker, for teardown. */
const created = new Set();

/**
 * Run a git subcommand inside a repo with a hermetic environment.
 * Throws on non-zero exit (execFileSync default) so a failed git op fails the
 * test loudly instead of silently producing a half-initialized repo.
 * @param {string} repoDir
 * @param {string[]} args
 * @param {{ allowFail?: boolean }} [opts]
 * @returns {string} stdout, trimmed
 */
function git(repoDir, args, opts = {}) {
  const env = {
    ...process.env,
    // Hermetic: do not read or write the developer's global/system git config,
    // and disable any global hooks/templates that would otherwise run.
    HOME: repoDir,
    GIT_CONFIG_GLOBAL: path.join(repoDir, '.gitconfig-test'),
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'CAWS Test',
    GIT_AUTHOR_EMAIL: 'test@caws.invalid',
    GIT_COMMITTER_NAME: 'CAWS Test',
    GIT_COMMITTER_EMAIL: 'test@caws.invalid',
  };
  try {
    return execFileSync('git', ['-C', repoDir, ...args], {
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (err) {
    if (opts.allowFail) return '';
    throw err;
  }
}

/**
 * Create a fresh, isolated git repo and return its absolute path.
 * @param {{ initialCommit?: boolean, defaultBranch?: string }} [opts]
 *   initialCommit (default true): create an empty root commit so the repo has
 *   a HEAD (many CAWS commands assume a commit exists).
 *   defaultBranch (default 'main'): the initial branch name.
 * @returns {string} absolute path to the repo root
 */
function makeTempRepo(opts = {}) {
  const { initialCommit = true, defaultBranch = 'main' } = opts;
  const base = path.join(os.tmpdir(), `caws-test-w${WORKER}-`);
  const repoDir = fs.mkdtempSync(base);
  created.add(repoDir);

  git(repoDir, ['init', '-q', '-b', defaultBranch]);
  git(repoDir, ['config', 'user.name', 'CAWS Test']);
  git(repoDir, ['config', 'user.email', 'test@caws.invalid']);
  git(repoDir, ['config', 'commit.gpgsign', 'false']);
  // Detach from any global hooks/templates that could mutate behavior.
  git(repoDir, ['config', 'core.hooksPath', '/dev/null']);

  if (initialCommit) {
    git(repoDir, ['commit', '-q', '--allow-empty', '-m', 'root commit']);
  }
  return repoDir;
}

/**
 * Remove a single temp repo. Safe to call twice; ignores already-removed.
 * @param {string} repoDir
 */
function cleanupRepo(repoDir) {
  if (!created.has(repoDir)) return;
  fs.rmSync(repoDir, { recursive: true, force: true });
  created.delete(repoDir);
}

/** Remove every temp repo created in this worker. Call in afterAll. */
function cleanupAll() {
  for (const repoDir of [...created]) cleanupRepo(repoDir);
}

// Backstop: a thrown test that skips afterAll should not leak temp dirs.
process.once('exit', () => {
  for (const repoDir of created) {
    try {
      fs.rmSync(repoDir, { recursive: true, force: true });
    } catch {
      /* best-effort on exit */
    }
  }
});

module.exports = { makeTempRepo, cleanupRepo, cleanupAll, git };
