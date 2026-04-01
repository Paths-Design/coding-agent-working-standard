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

const cleanup = run('npm', ['run', 'test:cleanup']);
if (cleanup.status !== 0) {
  process.exit(cleanup.status || 1);
}

process.exit(jest.status || 0);
