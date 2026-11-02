#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { verdict } = require('./run-tests');

// Feature-off host test preparation; qualified SQLite builds use their own coordinator.
function main(options = {}) {
  const packageRoot = options.packageRoot || path.resolve(__dirname, '..');
  const err = options.err || ((message) => process.stderr.write(message));
  const out = options.out || ((message) => process.stdout.write(message));
  const env = { ...process.env, RUSTUP_TOOLCHAIN: '1.90.0' };
  delete env.CARGO_TARGET_DIR;
  delete env.CARGO_BUILD_TARGET;
  const run = options.run || spawnSync;
  const execute = (command, args) =>
    run(command, args, { cwd: packageRoot, env, stdio: 'inherit', shell: false });
  const target = path.resolve(packageRoot, '../caws-native/target');
  const helpers = ['committed-turn-files.js', 'render-qualification-harness.js'].map((name) =>
    path.join(target, 'qualification-tools/scripts', name)
  );
  const binary = path.join(target, 'debug/caws-native');
  const requireFile = (file) => {
    if (!fs.statSync(file).isFile()) throw new Error(`Expected compiled file: ${file}`);
  };
  try {
    // CAWS can link ignored targets across worktrees. Never write another checkout's target.
    try {
      if (fs.lstatSync(target).isSymbolicLink()) {
        throw new Error(
          `Native test target must be local to this checkout; unlink the target symlink: ${target}`
        );
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const compiler = require.resolve('typescript/bin/tsc');
    let status = verdict(
      execute(process.execPath, [
        compiler,
        '-p',
        path.join(packageRoot, 'tsconfig.qualification-tests.json'),
      ]),
      'qualification test helper compilation',
      err
    );
    if (status !== 0) return status;
    for (const helper of helpers) requireFile(helper);
    status = verdict(
      execute('cargo', [
        'build',
        '--locked',
        '--offline',
        '--no-default-features',
        '--bin',
        'caws-native',
        '--jobs',
        '2',
        '--manifest-path',
        path.resolve(packageRoot, '../caws-native/Cargo.toml'),
        '--target-dir',
        target,
      ]),
      'feature-off native test compilation',
      err
    );
    if (status !== 0) return status;
    requireFile(binary);
    out(`Prepared test prerequisites (Rust 1.90.0):\n${[...helpers, binary].join('\n')}\n`);
    return 0;
  } catch (error) {
    err(`prepare-test-prerequisites: ${error.message}\n`);
    return 1;
  }
}

if (require.main === module) process.exit(main());
module.exports = { main };
