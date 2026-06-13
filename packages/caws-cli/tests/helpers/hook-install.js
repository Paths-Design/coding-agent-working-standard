'use strict';

/**
 * Shared hook-pack install primitive for the CAWS test harness.
 *
 * CAWS-TEST-HARNESS-FOUNDATION-001 (A3). The deleted corpus reinstalled the
 * full hook pack in `beforeEach` — ~48 files at ~613ms PER TEST, the single
 * biggest runtime cost driver. This primitive runs the install ONCE per suite
 * (call it from `beforeAll`) and exposes an install counter so a test can
 * assert the once-per-suite contract is actually honored (not silently
 * regressed back to per-test).
 *
 * CRITICAL — runs the LOCAL built CLI, not the globally-installed `caws`.
 * The global `caws` on PATH is a symlink into the published npm package
 * (lib/node_modules/@paths.design/caws-cli/dist), NOT this checkout's dist.
 * Tests must exercise the code under test, so we invoke
 * `node <repo>/packages/caws-cli/dist/index.js` from the package root. Build
 * first: `turbo run build --filter=@paths.design/caws-cli --force`. If dist is
 * missing this throws a clear error rather than silently testing stale code.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// packages/caws-cli/tests/helpers -> packages/caws-cli
const CLI_PKG_ROOT = path.resolve(__dirname, '..', '..');
const CLI_DIST_ENTRY = path.join(CLI_PKG_ROOT, 'dist', 'index.js');

/** @type {number} how many times runInit has actually invoked the CLI. */
let installCount = 0;

/** Reset the install counter (call in beforeAll if a suite asserts on it). */
function resetInstallCount() {
  installCount = 0;
}

/** @returns {number} installs performed since the last reset. */
function getInstallCount() {
  return installCount;
}

/**
 * Assert the local CLI dist exists; throw a directive error if not.
 * Prevents the confusing "tests pass against stale/absent code" failure mode.
 */
function assertDistBuilt() {
  if (!fs.existsSync(CLI_DIST_ENTRY)) {
    throw new Error(
      `caws-cli dist not built at ${CLI_DIST_ENTRY}. ` +
        'Run: ./node_modules/.bin/turbo run build --filter=@paths.design/caws-cli --force ' +
        '(tests load the COMPILED surface, not src/).'
    );
  }
}

/**
 * Run `caws init` (local dist) inside a target repo, installing a hook pack.
 * @param {string} repoDir absolute path to an initialized git repo (see
 *   git-repo-factory.makeTempRepo)
 * @param {{ agentSurface?: string, extraArgs?: string[] }} [opts]
 *   agentSurface (default 'claude-code'): the hook pack to install; pass 'none'
 *   to bootstrap .caws/ without a hook pack.
 * @returns {{ stdout: string, code: number }}
 */
function runInit(repoDir, opts = {}) {
  assertDistBuilt();
  const { agentSurface = 'claude-code', extraArgs = [] } = opts;
  const args = [CLI_DIST_ENTRY, 'init', '--agent-surface', agentSurface, ...extraArgs];
  let stdout = '';
  let code = 0;
  try {
    stdout = execFileSync('node', args, {
      cwd: repoDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CI: 'true', NO_COLOR: '1' },
    });
  } catch (err) {
    // execFileSync throws on non-zero exit; surface code + captured output so
    // the caller can assert on a refusal rather than blowing up the suite.
    stdout = `${err.stdout || ''}${err.stderr || ''}`;
    code = typeof err.status === 'number' ? err.status : 1;
  }
  installCount += 1;
  return { stdout, code };
}

/**
 * Suite-scoped install helper: install ONCE, return the repo + install output,
 * and hand back a teardown. Intended usage:
 *
 *   const { makeTempRepo, cleanupAll } = require('../helpers/git-repo-factory');
 *   const { installOnce } = require('../helpers/hook-install');
 *   let ctx;
 *   beforeAll(() => { ctx = installOnce(makeTempRepo()); });
 *   afterAll(() => cleanupAll());
 *   test('...', () => { expect(ctx.code).toBe(0); });
 *
 * @param {string} repoDir
 * @param {{ agentSurface?: string }} [opts]
 * @returns {{ repoDir: string, stdout: string, code: number }}
 */
function installOnce(repoDir, opts = {}) {
  const { stdout, code } = runInit(repoDir, opts);
  return { repoDir, stdout, code };
}

module.exports = {
  CLI_PKG_ROOT,
  CLI_DIST_ENTRY,
  runInit,
  installOnce,
  assertDistBuilt,
  resetInstallCount,
  getInstallCount,
};
