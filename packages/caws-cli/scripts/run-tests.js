#!/usr/bin/env node

const { spawnSync } = require('child_process');
const path = require('path');

const packageRoot = path.resolve(__dirname, '..');

const realRun = (command, args) =>
  spawnSync(command, args, {
    cwd: packageRoot,
    stdio: 'inherit',
    shell: false,
  });

/**
 * Collapse one spawnSync result into an exit code.
 *
 * `spawnSync().status` is null in two situations that are emphatically NOT
 * success: the child was terminated by a signal (an OOM kill on a large suite,
 * a SIGSEGV, a CI job timeout sending SIGTERM), and the child never spawned at
 * all (`.error` set). `result.status || 0` maps both of those to 0 — a green
 * verdict over a run that produced no verdict at all. Since this script's exit
 * code is what `npm test` / `turbo run test` / CI reads, that is a false pass.
 *
 * Every step therefore routes through here, and a null status is a failure that
 * says which signal or spawn error produced it.
 * [CAWS-DEFECT-TEST-VERDICT-INTEGRITY-01]
 */
function verdict(result, label, err) {
  if (result.error) {
    err(`run-tests: ${label} failed to spawn: ${result.error.message}\n`);
    return 1;
  }
  if (result.status === null || result.status === undefined) {
    err(
      `run-tests: ${label} was terminated by signal ${result.signal || 'unknown'}; ` +
        `treating as failure (no exit code was produced).\n`
    );
    return 1;
  }
  return result.status;
}

function main(options = {}) {
  const run = options.run || realRun;
  const err = options.err || ((s) => process.stderr.write(s));
  const extraArgs = options.argv || process.argv.slice(2);

  const buildStatus = verdict(run('npm', ['run', 'build']), 'npm run build', err);
  if (buildStatus !== 0) return buildStatus;

  // Capture the jest verdict BEFORE cleanup so a coverageThreshold miss (or any
  // jest failure) always surfaces, even if the post-run temp-scrub itself exits
  // non-zero. The cleanup is best-effort housekeeping; jest's result is the
  // build verdict and must take precedence. [CAWS-CLI-COVERAGE-FLOOR-001]
  const jestStatus = verdict(run('npx', ['jest', ...extraArgs]), 'jest', err);

  const cleanupStatus = verdict(run('npm', ['run', 'test:cleanup']), 'npm run test:cleanup', err);
  if (cleanupStatus !== 0) {
    // Surface the cleanup failure on stderr but do NOT let it mask a jest
    // failure. Only when jest passed does a cleanup failure decide the exit.
    err(
      `run-tests: test:cleanup exited ${cleanupStatus}; ` +
        `jest status (${jestStatus}) takes precedence.\n`
    );
  }

  return jestStatus !== 0 ? jestStatus : cleanupStatus;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = { main, verdict };
