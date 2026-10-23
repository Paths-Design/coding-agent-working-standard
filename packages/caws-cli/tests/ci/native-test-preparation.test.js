'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const yaml = require('js-yaml');

const packageRoot = path.resolve(__dirname, '../..');
const repoRoot = path.resolve(packageRoot, '../..');
const readJson = (relative) => JSON.parse(fs.readFileSync(path.join(repoRoot, relative), 'utf8'));
const workflow = (name) =>
  yaml.load(fs.readFileSync(path.join(repoRoot, '.github/workflows', name), 'utf8'));
const pr = workflow('pr-checks.yml');
const release = workflow('release-qualification.yml');
const preparation = (job) =>
  job.steps.find((step) => step.name === 'Prepare pinned Rust and locked Cargo dependencies');

test('each ordinary Jest route shares the build and prerequisite command', () => {
  const scripts = readJson('packages/caws-cli/package.json').scripts;
  expect(scripts.test).toBe('node scripts/run-tests.js');
  expect(scripts['test:prepare']).toBe(
    'npm run build && node scripts/prepare-test-prerequisites.js'
  );
  for (const name of [
    'test:unit',
    'test:contract',
    'test:integration',
    'test:e2e:smoke',
    'test:axe',
    'test:watch',
  ]) {
    expect(scripts[name]).toMatch(/^npm run test:prepare && jest\b/);
  }
  expect(scripts['test:bats']).toMatch(/^npm run build && bats\b/);
  expect(scripts['pretest:pytest']).toBe('npm run build');
});

test('the helper compiler configuration emits both consumers at their declared script paths', () => {
  const config = readJson('packages/caws-cli/tsconfig.qualification-tests.json');
  expect(config.extends).toBe('./tsconfig.vnext.json');
  expect(config.compilerOptions).toMatchObject({
    rootDir: '.',
    outDir: '../caws-native/target/qualification-tools',
  });
  expect(config.include).toEqual([
    'scripts/committed-turn-files.ts',
    'scripts/render-qualification-harness.ts',
  ]);
});

test('native and helper source inputs participate in the existing Turbo test cache', () => {
  const turbo = readJson('turbo.json');
  expect(turbo.globalDependencies).toEqual(
    expect.arrayContaining([
      'package-lock.json',
      'rust-toolchain.toml',
      'packages/caws-native/Cargo.toml',
      'packages/caws-native/Cargo.lock',
      'packages/caws-native/build.rs',
      'packages/caws-native/src/**',
      'packages/caws-native/tests/**',
      'packages/caws-cli/scripts/**',
      'packages/caws-cli/tsconfig*.json',
    ])
  );
  for (const name of ['test', 'test:unit']) {
    expect(turbo.tasks[name].cache).not.toBe(false);
    expect(turbo.tasks[name].inputs).toEqual(
      expect.arrayContaining(['scripts/**', 'tsconfig*.json', 'package.json'])
    );
  }
});

test.each([
  ['PR', pr.jobs.test_suite],
  ['release', release.jobs.tests],
  ['macOS custody', release.jobs['native-context-custody']],
])('%s provisions pinned Rust and locked dependencies before test compilation', (_name, job) => {
  const step = preparation(job);
  expect(step).toBeDefined();
  expect(step.if).toBeUndefined();
  expect(step['continue-on-error']).toBeUndefined();
  const testIndex = job.steps.findIndex((entry) =>
    /(?:turbo run test|npm test|npm run test:prepare)/.test(entry.run || '')
  );
  expect(job.steps.indexOf(step)).toBeLessThan(testIndex);
  // Execute the actual workflow block with observable command boundaries. No
  // Rust is invoked here; real fresh-target compilation is separate evidence.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'caws-ci-rust-preparation-')));
  try {
    const log = path.join(root, 'calls');
    for (const command of ['rustup', 'cargo']) {
      fs.writeFileSync(
        path.join(root, command),
        `#!/bin/sh\nprintf '%s\\n' '${command}' "$@" >> "$PREP_LOG"\nif [ "$PREP_FAIL" = '${command}' ]; then exit 37; fi\n`,
        { mode: 0o755 }
      );
    }
    const execute = (fail) =>
      spawnSync('/bin/bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', step.run], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${root}:/usr/bin:/bin`, PREP_LOG: log, PREP_FAIL: fail },
      });
    expect(execute('').status).toBe(0);
    expect(fs.readFileSync(log, 'utf8').trim().split('\n')).toEqual([
      'rustup',
      'toolchain',
      'install',
      '1.90.0',
      '--profile',
      'minimal',
      'cargo',
      '+1.90.0',
      'fetch',
      '--locked',
      '--manifest-path',
      'packages/caws-native/Cargo.toml',
    ]);
    fs.writeFileSync(log, '');
    expect(execute('rustup').status).toBe(37);
    expect(fs.readFileSync(log, 'utf8')).not.toContain('cargo');
    fs.writeFileSync(log, '');
    expect(execute('cargo').status).toBe(37);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('actual macOS context Git custody is a mandatory job with bounded resource use', () => {
  const job = release.jobs['native-context-custody'];
  expect(job['runs-on']).toBe('macos-latest');
  expect(job.if).toBeUndefined();
  expect(job['continue-on-error']).toBeUndefined();
  expect(job['timeout-minutes']).toBe(15);
  const custody = job.steps.find((step) => step.name === 'Exercise actual native Git custody');
  expect(custody.if).toBeUndefined();
  expect(custody['continue-on-error']).toBeUndefined();
  expect(custody.run).toContain('export CAWS_NATIVE_CUSTODY_NODE_PATH="$(command -v node)"');
  expect(custody.run).toContain(
    'cargo +1.90.0 test --locked --offline --manifest-path packages/caws-native/Cargo.toml --no-default-features --test context_git --jobs 2 -- --test-threads=1'
  );
  expect(custody.run).not.toMatch(/\|\|\s*true|--ignore|--features\s+sqlite-store/);
  expect(fs.readFileSync(path.join(repoRoot, 'rust-toolchain.toml'), 'utf8')).toContain(
    'channel = "1.90.0"'
  );
});
