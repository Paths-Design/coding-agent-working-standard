#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { verdict } = require('./run-tests');
const receipt = require('./lib/native-test-prerequisite-receipt.cjs');

// Feature-off host preparation runs once before Jest, never inside its workers.
function main(options = {}) {
  const packageRoot = options.packageRoot || path.resolve(__dirname, '..');
  const err = options.err || ((message) => process.stderr.write(message));
  const out = options.out || ((message) => process.stdout.write(message));
  const env = { ...process.env, RUSTUP_TOOLCHAIN: '1.90.0' };
  delete env.CARGO_TARGET_DIR;
  delete env.CARGO_BUILD_TARGET;
  const run = options.run || spawnSync;
  const execute = (command, args, capture = false) =>
    run(command, args, {
      cwd: packageRoot,
      env,
      stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
      shell: false,
      ...(capture ? { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 } : {}),
    });
  const observeToolchain =
    options.observeToolchain ||
    (() => {
      const rustc = execute('rustc', ['--version', '--verbose'], true);
      if (verdict(rustc, 'pinned rustc observation', err))
        throw new Error('rustc observation failed');
      const cargo = execute('cargo', ['--version'], true);
      if (verdict(cargo, 'pinned cargo observation', err))
        throw new Error('cargo observation failed');
      return receipt.toolchainObservation(rustc.stdout, cargo.stdout);
    });
  const target = path.resolve(packageRoot, '../caws-native/target');
  const manifest = path.resolve(packageRoot, '../caws-native/Cargo.toml');
  const helpers = ['committed-turn-files.js', 'render-qualification-harness.js'].map((name) =>
    path.join(target, 'qualification-tools/scripts', name)
  );
  const binary = path.join(target, 'debug/caws-native');
  const requireFile = (file) => {
    if (!fs.statSync(file).isFile()) throw new Error('Expected compiled file: ' + file);
  };
  try {
    try {
      if (fs.lstatSync(target).isSymbolicLink())
        throw new Error(
          'Native test target must be local to this checkout; unlink the target symlink: ' + target
        );
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    receipt.removeReceipt(packageRoot);
    const before = receipt.sourceFingerprint(packageRoot),
      toolchain = observeToolchain();
    let status = verdict(
      execute(process.execPath, [
        require.resolve('typescript/bin/tsc'),
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
        '1',
        '--manifest-path',
        manifest,
        '--target-dir',
        target,
      ]),
      'feature-off native test compilation',
      err
    );
    if (status !== 0) return status;
    requireFile(binary);
    const compiled = execute(
      'cargo',
      [
        'test',
        '--no-run',
        '--lib',
        '--locked',
        '--offline',
        '--no-default-features',
        '--jobs',
        '1',
        '--manifest-path',
        manifest,
        '--target-dir',
        target,
        '--message-format=json',
      ],
      true
    );
    status = verdict(compiled, 'feature-off Native libtest compilation', err);
    if (status !== 0) return status;
    const coreTest = receipt.selectCoreTestArtifact(packageRoot, compiled.stdout);
    if (JSON.stringify(toolchain) !== JSON.stringify(observeToolchain()))
      throw new Error('Rust toolchain changed during preparation');
    if (JSON.stringify(before) !== JSON.stringify(receipt.sourceFingerprint(packageRoot)))
      throw new Error('Native source inputs changed during preparation');
    receipt.publishReceipt(packageRoot, before, toolchain, coreTest);
    receipt.readReceipt(packageRoot);
    out(
      'Prepared test prerequisites (Rust 1.90.0):\n' +
        [...helpers, binary, coreTest.path].join('\n') +
        '\n'
    );
    return 0;
  } catch (error) {
    err('prepare-test-prerequisites: ' + error.message + '\n');
    return 1;
  }
}
if (require.main === module) process.exit(main());
module.exports = { main };
