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
 *  - No network, no shared submodule cache.
 *
 * CAWS-GIT-SPAWN-COST-001 — HOW A REPO IS BUILT, AND WHY IT CHANGED
 *
 * A repo used to be six `git` subprocesses: init, four configs, and an empty
 * root commit. Measured inside a jest worker that cost **1257 ms per repo**,
 * because each spawn pays macOS's PATH walk (see src/store/git-binary.ts).
 * Two changes, in this order:
 *
 *   bare `git`, 6 spawns        1257.6 ms   <- what this file used to do
 *   resolved binary, 6 spawns    202.4 ms   6.2x
 *   copy a prebuilt template       5.1 ms   248x
 *
 * So a repo is now materialized by `fs.cpSync` from a template built ONCE per
 * (worker, shape). A git repository is position-independent — nothing in
 * `.git/` records its own absolute path — which the parity test pins by
 * asserting `rev-parse --show-toplevel` on a copy resolves to the copy.
 *
 * ONE BEHAVIORAL DIFFERENCE, stated because it is load-bearing: every repo of
 * the same shape from the same worker now shares a root-commit SHA, where
 * before each got a distinct one from its own timestamp. A test that needs two
 * repos with *different* histories must commit into them; it can no longer
 * rely on the root commits happening to differ.
 *
 * Cleanup: callers register repos for teardown. `cleanupAll()` (call in
 * afterAll) removes every repo this module created in the current worker.
 * Templates are NOT part of that set — they outlive individual test files so
 * each worker pays for them once — and are removed by the process-exit hook.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { resolveGitBinary } = require('../../dist/store');

const WORKER = process.env.JEST_WORKER_ID || '0';
/** @type {Set<string>} repos created in THIS worker, for teardown. */
const created = new Set();
/** @type {Map<string, string>} shape key -> template repo path, per worker. */
const templates = new Map();

/** Hermetic git env for a repo. Pins HOME and both config scopes at the repo. */
function hermeticEnv(repoDir) {
  return {
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
}

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
  try {
    return execFileSync(resolveGitBinary(), ['-C', repoDir, ...args], {
      env: hermeticEnv(repoDir),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (err) {
    if (opts.allowFail) return '';
    throw err;
  }
}

/** A fresh unique directory under the OS temp dir, namespaced by worker. */
function mkUniqueDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-w${WORKER}-`));
}

/**
 * The template repo for one shape, built on first request and reused after.
 *
 * Keyed by the options that change the repo's CONTENT, so two shapes never
 * share a template. Building is the old six-spawn path — paid once per worker
 * per shape instead of once per test.
 */
function ensureTemplate(defaultBranch, initialCommit) {
  const key = `${defaultBranch}|${initialCommit}`;
  const existing = templates.get(key);
  if (existing !== undefined && fs.existsSync(existing)) return existing;

  const dir = mkUniqueDir('caws-tmpl');
  git(dir, ['init', '-q', '-b', defaultBranch]);
  git(dir, ['config', 'user.name', 'CAWS Test']);
  git(dir, ['config', 'user.email', 'test@caws.invalid']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  // Detach from any global hooks/templates that could mutate behavior.
  git(dir, ['config', 'core.hooksPath', '/dev/null']);
  if (initialCommit) {
    git(dir, ['commit', '-q', '--allow-empty', '-m', 'root commit']);
  }
  templates.set(key, dir);
  return dir;
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
  const template = ensureTemplate(defaultBranch, initialCommit);
  const repoDir = mkUniqueDir('caws-test');
  created.add(repoDir);
  // `force: true` so the mkdtemp-created destination is written into rather
  // than refused as already-existing.
  fs.cpSync(template, repoDir, { recursive: true, force: true });
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
// Templates are only ever removed here — they must survive cleanupAll() so a
// worker builds each shape once, not once per test file.
process.once('exit', () => {
  for (const repoDir of [...created, ...templates.values()]) {
    try {
      fs.rmSync(repoDir, { recursive: true, force: true });
    } catch {
      /* best-effort on exit */
    }
  }
});

module.exports = { makeTempRepo, cleanupRepo, cleanupAll, git };
