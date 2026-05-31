#!/usr/bin/env node

const { spawnSync } = require('child_process');
const path = require('path');

const packageRoot = path.resolve(__dirname, '..');
const extraArgs = process.argv.slice(2);

const run = (command, args) =>
  spawnSync(command, args, {
    cwd: packageRoot,
    stdio: 'inherit',
    shell: false,
  });

const build = run('npm', ['run', 'build']);
if (build.status !== 0) {
  process.exit(build.status || 1);
}

const jest = run('npx', ['jest', ...extraArgs]);
// Capture the jest status BEFORE cleanup so a coverageThreshold miss (or any
// jest failure) always surfaces, even if the post-run temp-scrub itself exits
// non-zero. The cleanup is best-effort housekeeping; jest's result is the
// build verdict and must take precedence. [CAWS-CLI-COVERAGE-FLOOR-001]
const jestStatus = jest.status || 0;

const cleanup = run('npm', ['run', 'test:cleanup']);
if (cleanup.status !== 0) {
  // Surface the cleanup failure on stderr but do NOT let it mask a jest
  // failure. Only when jest passed does a cleanup failure decide the exit.
  process.stderr.write(
    `run-tests: test:cleanup exited ${cleanup.status}; ` +
      `jest status (${jestStatus}) takes precedence.\n`
  );
}

process.exit(jestStatus !== 0 ? jestStatus : cleanup.status || 0);
