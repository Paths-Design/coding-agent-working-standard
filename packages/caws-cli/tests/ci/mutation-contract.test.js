'use strict';

/**
 * Mutation CI contract tests.
 *
 * These tests pin the integrity boundary around mutation testing, not any
 * particular survivor count. A green result must mean that the declared
 * source inventory is current, every mutation target exists, and every
 * target independently clears its floor. Missing work is a failure, never a
 * reason to average or skip.
 *
 * [CAWS-CI-MUTATION-PROOF-DURABILITY-001]
 */

const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { nodeProcessEnv } = require('../../scripts/lib/node-process-env.cjs');
const yaml = require('js-yaml');

const PACKAGE_ROOT = path.resolve(__dirname, '../..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '../..');
const POLICY = path.join(PACKAGE_ROOT, 'mutation-policy.json');
const VALIDATOR = path.join(PACKAGE_ROOT, 'scripts/validate-mutation-policy.mjs');
const REPORT_ASSERTION = path.join(PACKAGE_ROOT, 'scripts/assert-mutation-report.mjs');
const INPUT_IDENTITY = path.join(PACKAGE_ROOT, 'scripts/mutation-input-identity.mjs');
const { createStrykerConfig } = require(path.join(PACKAGE_ROOT, 'scripts/stryker-config.cjs'));

const tempDirs = [];

afterEach(() => {
  const errors = [];
  for (const dir of tempDirs.splice(0)) {
    try {
      if (process.env.CAWS_MUTATION_TEST_ARTIFACT_DIR) {
        const original = fs.realpathSync(dir);
        fs.mkdirSync(process.env.CAWS_MUTATION_TEST_ARTIFACT_DIR, { recursive: true });
        const root = fs.realpathSync(process.env.CAWS_MUTATION_TEST_ARTIFACT_DIR);
        if (root === original || root.startsWith(original + path.sep)) {
          throw new Error('Mutation test artifact destination must be outside its fixture');
        }
        const retained = fs.mkdtempSync(path.join(root, 'fixture-'));
        fs.cpSync(original, path.join(retained, 'state'), { recursive: true, dereference: false });
        fs.writeFileSync(
          path.join(retained, 'index.json'),
          JSON.stringify(
            {
              testName: expect.getState().currentTestName,
              originalPath: original,
            },
            null,
            2
          ) + '\n'
        );
      }
    } catch (error) {
      errors.push(error);
    } finally {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (error) {
        errors.push(error);
      }
    }
  }
  if (errors.length)
    throw new AggregateError(errors, 'Mutation fixture retention or cleanup failed');
});

function makeTempDir(prefix = 'caws-mutation-contract-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function runNode(script, args = []) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: PACKAGE_ROOT,
    env: nodeProcessEnv(),
    encoding: 'utf8',
  });
}

function writeJson(dir, name, value) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return file;
}

function loadPolicy() {
  return JSON.parse(fs.readFileSync(POLICY, 'utf8'));
}

function mutationPolicy(surfaceTargets) {
  return {
    schemaVersion: 1,
    surfaces: {
      fixture: {
        threshold: 80,
        targets: surfaceTargets.map((mutate) => ({
          source: mutate.replace(/^dist\//, 'src/').replace(/\.js$/, '.ts'),
          reportPath: mutate,
        })),
      },
    },
  };
}

function report(files) {
  return {
    schemaVersion: '2.0',
    files: Object.fromEntries(
      Object.entries(files).map(([file, statuses]) => [
        file,
        {
          language: 'javascript',
          source: 'fixture source',
          mutants: statuses.map((status, index) => ({
            id: String(index),
            mutatorName: 'fixture',
            replacement: 'fixture',
            status,
            location: {
              start: { line: 1, column: 0 },
              end: { line: 1, column: 1 },
            },
          })),
        },
      ])
    ),
  };
}

function runReportAssertion(policy, mutationReport) {
  const dir = makeTempDir();
  const policyFile = writeJson(dir, 'policy.json', policy);
  const reportFile = writeJson(dir, 'report.json', mutationReport);
  return runNode(REPORT_ASSERTION, [
    '--policy',
    policyFile,
    '--surface',
    'fixture',
    '--report',
    reportFile,
  ]);
}

// These miniature packages exercise qualification mechanics through the real
// runner/helper children. Their build and Stryker executables are explicit
// fixtures, so passing them establishes neither mutation coverage nor Jest's
// consumption of an emitted candidate module.
function qualificationFixture({ buildBody, coreBody } = {}) {
  const repoRoot = fs.realpathSync(makeTempDir('caws-mutation-binding-'));
  const packageRoot = path.join(repoRoot, 'packages/caws-cli');
  const put = (file, contents) => {
    const destination = path.join(packageRoot, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, contents);
    return destination;
  };
  for (const directory of ['src', 'scripts', 'tests', 'templates', 'surfaces']) {
    fs.mkdirSync(path.join(packageRoot, directory), { recursive: true });
  }
  fs.mkdirSync(path.join(repoRoot, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'docs/fixture.md'), '# Fixture reference\n');
  fs.writeFileSync(path.join(repoRoot, 'LICENSE'), 'Fixture root license\n');
  fs.writeFileSync(path.join(repoRoot, 'package.json'), '{"private":true}\n');
  fs.writeFileSync(path.join(repoRoot, 'package-lock.json'), '{"lockfileVersion":3}\n');
  put(
    'package.json',
    JSON.stringify({
      name: 'caws-mutation-binding-fixture',
      private: true,
      scripts: { build: 'node scripts/build-fixture.cjs' },
      devDependencies: { '@stryker-mutator/core': '9.6.1' },
    })
  );
  put('src/transcripts/unicode14/LICENSE.txt', 'Fixture Unicode license\n');
  put('src/transcripts/html311/LICENSE.txt', 'Fixture HTML license\n');
  const source = 'module.exports = 1;\n';
  const testSource = "test('fixture amount', () => expect(1).toBe(1));\n";
  put('src/store/a.ts', source);
  put('tests/store/a.test.js', testSource);
  const policy = {
    schemaVersion: 1,
    sourceRoots: ['src/store'],
    proofGroups: [
      {
        id: 'fixture-store',
        strategy: 'mutation',
        command: 'node scripts/run-mutation.mjs',
        rationale: 'Exercise the ordinary qualification wrapper against a finite package.',
        files: ['src/store/a.ts'],
      },
    ],
    surfaces: {
      store: {
        config: 'stryker.conf.cjs',
        reportDir: 'reports/mutation-store',
        threshold: 80,
        coverageAnalysis: 'perTest',
        buildCommand: 'node scripts/build-fixture.cjs',
        targets: [{ source: 'src/store/a.ts' }],
        tests: ['tests/store/a.test.js'],
      },
    },
  };
  put('mutation-policy.json', `${JSON.stringify(policy)}\n`);
  for (const file of [
    'run-mutation.mjs',
    'assert-mutation-report.mjs',
    'validate-mutation-policy.mjs',
    'mutation-input-identity.mjs',
    'stryker-config.cjs',
    'clean-staged-docs.mjs',
    'lib/node-process-env.cjs',
  ]) {
    put(`scripts/${file}`, fs.readFileSync(path.join(PACKAGE_ROOT, 'scripts', file)));
  }
  put(
    'stryker.conf.cjs',
    "module.exports = require('./scripts/stryker-config.cjs').createStrykerConfig('store');\n"
  );
  put('scripts/build-fixture.cjs', buildBody || fixtureBuildBody());
  put(
    'node_modules/@stryker-mutator/core/package.json',
    JSON.stringify({
      name: '@stryker-mutator/core',
      version: '9.6.1',
      bin: { stryker: 'bin/stryker.cjs' },
    })
  );
  put('node_modules/@stryker-mutator/core/bin/stryker.cjs', coreBody || 'process.exit(0);\n');
  return { repoRoot, packageRoot, policy, source, testSource, put };
}

function fixtureBuildBody(before = '') {
  return `
    const fs = require('node:fs');
    ${before}
    fs.mkdirSync('dist/store', { recursive: true });
    fs.writeFileSync('dist/store/a.js', fs.readFileSync('src/store/a.ts'));
    fs.writeFileSync('dist/index.js', 'module.exports = 1;\\n');
    fs.chmodSync('dist/index.js', 0o755);
    import('./clean-staged-docs.mjs').then(({ stageLicenseTransport }) => {
      stageLicenseTransport(process.cwd());
      console.log('fixture build emitted JavaScript and staged owned licenses');
    }).catch(error => { console.error(error); process.exitCode = 1; });
  `;
}

function addSplitDependencyFixture(fixture) {
  const metadata = JSON.parse(
    fs.readFileSync(path.join(fixture.packageRoot, 'package.json'), 'utf8')
  );
  metadata.devDependencies.chalk = '4.1.2';
  fixture.put('package.json', JSON.stringify(metadata));
  const writePackage = (root, name, version, body, dependencies = {}) => {
    const directory = path.join(root, 'node_modules', name);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, 'package.json'),
      JSON.stringify({
        name,
        version,
        main: 'index.cjs',
        dependencies,
      })
    );
    fs.writeFileSync(path.join(directory, 'index.cjs'), body);
  };
  // Finite dependency fixtures model distinct normal nested/hoisted resolution;
  // they do not stand in for installed chalk package behavior.
  writePackage(
    fixture.packageRoot,
    'chalk',
    '4.1.2',
    "module.exports = { color: 'local-chalk-4', style: require('ansi-styles') };\n",
    { 'ansi-styles': '4.3.0' }
  );
  writePackage(fixture.packageRoot, 'ansi-styles', '4.3.0', "module.exports = 'local-ansi-4';\n");
  writePackage(
    fixture.repoRoot,
    'chalk',
    '5.0.0',
    "module.exports = { color: 'hoisted-chalk-5', style: require('ansi-styles') };\n",
    { 'ansi-styles': '5.0.0' }
  );
  writePackage(fixture.repoRoot, 'ansi-styles', '5.0.0', "module.exports = 'hoisted-ansi-5';\n");
}

function addBuiltinNamedPackageFixture(fixture, { installed = true } = {}) {
  const metadata = JSON.parse(
    fs.readFileSync(path.join(fixture.packageRoot, 'package.json'), 'utf8')
  );
  metadata.devDependencies.bl = '4.1.0';
  fixture.put('package.json', JSON.stringify(metadata));
  const blManifestPath = fixture.put(
    'node_modules/bl/package.json',
    JSON.stringify({
      name: 'bl',
      version: '4.1.0',
      main: 'index.cjs',
      dependencies: { buffer: '5.7.1' },
    })
  );
  fixture.put('node_modules/bl/index.cjs', "module.exports = require('buffer/');\n");
  const bufferSource = "module.exports = 'physical-buffer-package-5.7.1';\n";
  const bufferEntryPath = path.join(fixture.packageRoot, 'node_modules/buffer/index.cjs');
  if (installed) {
    fixture.put(
      'node_modules/buffer/package.json',
      JSON.stringify({
        name: 'buffer',
        version: '5.7.1',
        main: 'index.cjs',
      })
    );
    fixture.put('node_modules/buffer/index.cjs', bufferSource);
  }
  return { blManifestPath, bufferEntryPath, bufferSource };
}

function runBuiltinNamedPackageCapture(fixture, dependency, { changeBytes = false } = {}) {
  const script = `
    import fs from 'node:fs';
    import path from 'node:path';
    import { createRequire } from 'node:module';
    import { pathToFileURL } from 'node:url';
    const packageRoot = ${JSON.stringify(fixture.packageRoot)};
    const { captureMutationInputs, assertInputsUnchanged } = await import(pathToFileURL(path.join(packageRoot, 'scripts/mutation-input-identity.mjs')));
    const policy = JSON.parse(fs.readFileSync(path.join(packageRoot, 'mutation-policy.json'), 'utf8'));
    try {
      const inputIdentity = captureMutationInputs({ packageRoot, policy, surfaceId: 'store' });
      fs.writeFileSync(${JSON.stringify(path.join(fixture.repoRoot, 'captured-inputs.json'))}, JSON.stringify(inputIdentity));
      const require = createRequire(${JSON.stringify(dependency.blManifestPath)});
      const entry = ${JSON.stringify(dependency.bufferEntryPath)};
      console.log(JSON.stringify({
        builtinResolution: require.resolve('buffer'),
        installedResolution: require.resolve('buffer/'),
        installedValue: require('buffer/'),
        files: inputIdentity.files.filter(file => file.path === 'dependency:' + entry.split(path.sep).join('/')),
      }));
      if (${JSON.stringify(changeBytes)}) {
        fs.writeFileSync(entry, "module.exports = 'changed-buffer-package-bytes';\\n");
        assertInputsUnchanged(inputIdentity, { packageRoot, policy, surfaceId: 'store' });
      }
    } catch (error) { console.error(error.message); process.exitCode = 1; }
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: fixture.packageRoot,
    env: nodeProcessEnv(),
    encoding: 'utf8',
    timeout: 15000,
  });
  retainChildObservation(fixture.repoRoot, result);
  return result;
}

function fixtureCoreBody({
  beforeSandboxBuild = '',
  afterSandbox = '',
  skipSandbox = false,
  reportBody = '',
  loggedSourceCount = 1,
  loggedMutantCount = 5,
} = {}) {
  return `
    const fs = require('node:fs');
    const path = require('node:path');
    const { spawnSync } = require('node:child_process');
    const context = JSON.parse(fs.readFileSync(process.env.CAWS_MUTATION_RUN_CONTEXT, 'utf8'));
    const config = require(path.join(process.cwd(), 'stryker.conf.cjs'));
    if (config.tempDirName !== context.tempDirName) throw new Error('fixture config/context topology mismatch');
    const sandbox = path.join(context.tempDirName, 'sandbox-fixture');
    fs.mkdirSync(sandbox, { recursive: true });
    fs.cpSync(context.packageRoot, sandbox, { recursive: true, filter: file => {
      const relative = path.relative(context.packageRoot, file).split(path.sep).join('/');
      return !['node_modules', 'reports', 'dist', '.license-transport.json', '.license-transport.lock', 'LICENSE']
        .some(excluded => relative === excluded || relative.startsWith(excluded + '/'));
    } });
    fs.writeFileSync(path.join(sandbox, 'src/store/a.ts'), 'module.exports = 2;\\n');
    fs.writeFileSync(path.join(context.tempDirName, 'foreign-sibling.txt'), 'foreign sibling must survive');
    ${beforeSandboxBuild}
    if (!${JSON.stringify(skipSandbox)}) {
      const built = spawnSync(config.buildCommand, { cwd: sandbox, shell: true, env: process.env, encoding: 'utf8' });
      process.stdout.write(built.stdout || '');
      process.stderr.write(built.stderr || '');
      const marker = path.join(sandbox, '.license-transport.json');
      fs.writeFileSync(path.join(context.repoRoot, 'fixture-build-observation.json'), JSON.stringify({
        status: built.status, sandbox,
        marker: fs.existsSync(marker) ? JSON.parse(fs.readFileSync(marker, 'utf8')) : null,
        markerInode: fs.existsSync(marker) ? fs.statSync(marker).ino : null,
        dependencyValue: fs.existsSync(path.join(sandbox, 'dist/dependency-value.json'))
          ? JSON.parse(fs.readFileSync(path.join(sandbox, 'dist/dependency-value.json'), 'utf8')) : null,
      }));
    }
    ${afterSandbox}
    const report = {
      schemaVersion: '1.0', projectRoot: context.packageRoot,
      files: { 'src/store/a.ts': {
        source: context.inputIdentity.targets['src/store/a.ts'], language: 'typescript',
        mutants: ['Killed','Killed','Killed','Killed','Survived'].map((status, index) => ({
          id: String(index), status, mutatorName: 'fixture', replacement: 'fixture',
          location: { start: { line: 1, column: 0 }, end: { line: 1, column: 1 } },
        })),
      } },
      testFiles: { 'tests/store/a.test.js': {
        source: context.inputIdentity.tests['tests/store/a.test.js'],
        tests: [{ id: '0', name: 'fixture amount' }],
      } },
    };
    ${reportBody}
    const reportDir = path.join(context.packageRoot, 'reports/mutation-store');
    fs.writeFileSync(path.join(reportDir, 'mutation-report.json'), JSON.stringify(report));
    console.log('Instrumented ${loggedSourceCount} source file(s) with ${loggedMutantCount} mutant(s)');
    console.log('fixture Stryker child completed with exit zero');
  `;
}

function runQualificationFixture(fixture, extraArgs = []) {
  const result = spawnSync(
    process.execPath,
    [
      path.join(fixture.packageRoot, 'scripts/run-mutation.mjs'),
      '--surface',
      'store',
      '--sha',
      'descriptive-fixture-label',
      ...extraArgs,
    ],
    {
      cwd: fixture.packageRoot,
      env: nodeProcessEnv(),
      encoding: 'utf8',
      timeout: 30000,
      maxBuffer: 4 * 1024 * 1024,
    }
  );
  retainChildObservation(fixture.repoRoot, result);
  const receiptPath = path.join(fixture.packageRoot, 'reports/mutation-store/mutation-run.json');
  return {
    ...result,
    receipt: fs.existsSync(receiptPath) ? JSON.parse(fs.readFileSync(receiptPath, 'utf8')) : null,
  };
}

function retainChildObservation(root, result) {
  const directory = fs.mkdtempSync(path.join(root, 'child-observation-'));
  fs.writeFileSync(path.join(directory, 'stdout.log'), result.stdout || '');
  fs.writeFileSync(path.join(directory, 'stderr.log'), result.stderr || '');
  fs.writeFileSync(
    path.join(directory, 'outcome.json'),
    JSON.stringify(
      {
        status: result.status,
        signal: result.signal,
        error: result.error?.message,
      },
      null,
      2
    ) + '\n'
  );
}

function boundReportFixture(fixture) {
  const mutationReport = report({
    'src/store/a.ts': ['Killed', 'Killed', 'Killed', 'Killed', 'Survived'],
  });
  mutationReport.files['src/store/a.ts'].source = fixture.source;
  mutationReport.testFiles = {
    'tests/store/a.test.js': {
      source: fixture.testSource,
      tests: [{ id: '0', name: 'fixture amount' }],
    },
  };
  return mutationReport;
}

function runBoundAssertion(fixture, mutationReport) {
  const reportFile = writeJson(fixture.repoRoot, 'report-fixture.json', mutationReport);
  const script = `
    import fs from 'node:fs';
    import { pathToFileURL } from 'node:url';
    const { captureMutationInputs } = await import(pathToFileURL(${JSON.stringify(INPUT_IDENTITY)}));
    const { assertMutationReport } = await import(pathToFileURL(${JSON.stringify(REPORT_ASSERTION)}));
    const packageRoot = ${JSON.stringify(fixture.packageRoot)};
    const policy = JSON.parse(fs.readFileSync(packageRoot + '/mutation-policy.json', 'utf8'));
    const inputIdentity = await captureMutationInputs({ packageRoot, policy, surfaceId: 'store' });
    const report = JSON.parse(fs.readFileSync(${JSON.stringify(reportFile)}, 'utf8'));
    const result = assertMutationReport({ policy, surfaceId: 'store', report, inputIdentity });
    console.log(JSON.stringify(result));
    process.exitCode = result.errors.length ? 1 : 0;
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: fixture.packageRoot,
    env: nodeProcessEnv(),
    encoding: 'utf8',
    timeout: 15000,
  });
  retainChildObservation(fixture.repoRoot, result);
  return result;
}

function executableWorkflowText(parsed) {
  const executable = [];
  for (const job of Object.values(parsed.jobs || {})) {
    if (job.if) executable.push(String(job.if));
    for (const step of job.steps || []) {
      if (step.if) executable.push(String(step.if));
      if (step.uses) executable.push(String(step.uses));
      if (step['working-directory']) executable.push(String(step['working-directory']));
      if (step.with) executable.push(JSON.stringify(step.with));
      if (step.run) {
        executable.push(
          String(step.run)
            .split('\n')
            .filter((line) => !/^\s*#/.test(line))
            .join('\n')
        );
      }
    }
  }
  return executable.join('\n');
}

describe('mutation policy topology contract', () => {
  test('the live policy accounts for every kernel/store/shell/transcript source exactly once', () => {
    const result = runNode(VALIDATOR, ['--policy', POLICY, '--root', PACKAGE_ROOT]);

    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
    // Counts are pinned on purpose: adding an inventoried source or a
    // mutation target must reconcile policy AND this pin in the same change.
    // The inventory includes inspection-prefix analysis, its entry point and shared CAWS reader metadata.
    expect(result.stdout).toMatch(/^PASS: 207 source files accounted for exactly once$/m);
    expect(result.stdout).toMatch(/^PASS: 28 mutation targets across 4 surfaces$/m);
  });

  test.each([
    'src/shell/analysis/caws-read-metadata.ts',
    'src/shell/analysis/inspection-prefix-entry.ts',
    'src/shell/analysis/inspection-prefix.ts',
    'src/shell/analysis/inspection-profiles.ts',
  ])('inspection source has one behavioral proof classification: %s', (source) => {
    // hooks-inspection-prefix exercises parsing and entry-point refusals. This
    // classification does not assert a mutation score or runtime activation.
    expect(
      loadPolicy()
        .proofGroups.filter((group) => group.files.includes(source))
        .map(({ id, strategy, command }) => ({ id, strategy, command }))
    ).toEqual([{ id: 'behavioral', strategy: 'behavioral', command: 'npm test' }]);
  });

  test('session seal preparation is classified as behavioral parsing and rendering', () => {
    const policy = loadPolicy();
    const source = 'src/transcripts/session-seal-prepare.ts';
    // Ordinary Jest reaches the pure preparer through session-seal-runtime's
    // lossless count/model/metadata and refusal controls. Classification does
    // not establish mutation coverage or grant native publication authority.
    expect(
      policy.proofGroups
        .filter((group) => group.files.includes(source))
        .map(({ id, strategy, command }) => ({ id, strategy, command }))
    ).toEqual([{ id: 'behavioral', strategy: 'behavioral', command: 'npm test' }]);
  });

  test('renderer calendar has an in-process consumer and its own unchanged mutation floor', () => {
    const policy = loadPolicy();
    const source = 'src/transcripts/renderer-calendar.ts';
    expect(
      policy.proofGroups
        .filter((group) => group.files.includes(source))
        .map(({ id, strategy }) => ({ id, strategy }))
    ).toEqual([{ id: 'mutation', strategy: 'mutation' }]);
    expect(policy.surfaces.store.targets.filter((target) => target.source === source)).toEqual([
      { source },
    ]);
    expect(policy.surfaces.store.tests).toContain(
      'tests/transcripts/renderer-calendar-mutation.test.js'
    );
    expect(policy.surfaces.store.threshold).toBe(80);
    const config = createStrykerConfig('store');
    expect(config.mutate).toContain(source);
    expect(config.jest.config.testMatch).toContain(
      '<rootDir>/tests/transcripts/renderer-calendar-mutation.test.js'
    );
    expect(config.coverageAnalysis).toBe('perTest');
    expect(config.thresholds.low).toBe(80);
  });

  test('an unclassified production source is a hard failure', () => {
    const policy = loadPolicy();
    const removed = policy.proofGroups[0].files.shift();
    const dir = makeTempDir();
    const policyFile = writeJson(dir, 'policy.json', policy);

    const result = runNode(VALIDATOR, ['--policy', policyFile, '--root', PACKAGE_ROOT]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`unclassified source: ${removed}`);
  });

  test('a source classified by two proof groups is a hard failure', () => {
    const policy = loadPolicy();
    const duplicate = policy.proofGroups[0].files[0];
    policy.proofGroups[1].files.push(duplicate);
    const dir = makeTempDir();
    const policyFile = writeJson(dir, 'policy.json', policy);

    const result = runNode(VALIDATOR, ['--policy', policyFile, '--root', PACKAGE_ROOT]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`source classified more than once: ${duplicate}`);
  });

  test('a missing mutation target or dedicated test is a hard failure', () => {
    const policy = loadPolicy();
    policy.surfaces.kernel.targets[0].source = 'src/kernel/does-not-exist.ts';
    policy.surfaces.kernel.tests.push('tests/kernel/unit/does-not-exist.test.ts');
    const dir = makeTempDir();
    const policyFile = writeJson(dir, 'policy.json', policy);

    const result = runNode(VALIDATOR, ['--policy', policyFile, '--root', PACKAGE_ROOT]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('missing mutation source: src/kernel/does-not-exist.ts');
    expect(result.stderr).toContain(
      'missing mutation test: tests/kernel/unit/does-not-exist.test.ts'
    );
  });

  test('store mutation recomputes evidence using in-process store and timestamp contracts', () => {
    const config = createStrykerConfig('store');

    expect(config.incremental).toBe(false);
    expect(config.testFiles).not.toHaveLength(0);
    expect(
      config.testFiles.every(
        (file) =>
          file.startsWith('tests/store/') ||
          file === 'tests/transcripts/store-timestamp.test.js' ||
          file === 'tests/transcripts/renderer-calendar-mutation.test.js'
      )
    ).toBe(true);
    expect(config.testFiles).toContain('tests/store/messages-behavior-store.test.js');
    expect(config.testFiles).toContain('tests/store/messages-dead-recipient-prune.test.js');
    expect(config.testFiles).toContain('tests/transcripts/store-timestamp.test.js');
    expect(config.mutate).toContain('src/transcripts/store-timestamp.ts');
    expect(config.jest.config.testMatch).toContain(
      '<rootDir>/tests/transcripts/store-timestamp.test.js'
    );
    expect(config.buildCommand).toBe('node scripts/build-cli.js');
    const store = loadPolicy().surfaces.store;
    expect(store.threshold).toBe(80);
    expect(config.mutate).toEqual([
      'src/store/apply-patch.ts',
      'src/store/atomic-write.ts',
      'src/store/events-store.ts',
      'src/store/messages-store.ts',
      'src/store/yaml-patch.ts',
      'src/transcripts/renderer-calendar.ts',
      'src/transcripts/store-timestamp.ts',
    ]);
    expect(config.testFiles).toEqual([
      'tests/store/apply-patch.test.js',
      'tests/store/atomic-write-sweep.test.js',
      'tests/store/atomic-write.test.js',
      'tests/store/events-store.test.js',
      'tests/store/messages-behavior-store.test.js',
      'tests/store/messages-dead-recipient-prune.test.js',
      'tests/store/messages-store.test.js',
      'tests/store/yaml-patch.test.js',
      'tests/transcripts/renderer-calendar-mutation.test.js',
      'tests/transcripts/store-timestamp.test.js',
    ]);
    expect(
      store.targets.find((target) => target.source === 'src/transcripts/store-timestamp.ts')
    ).toEqual({ source: 'src/transcripts/store-timestamp.ts' });
  });

  test.each(['kernel', 'store', 'shell'])(
    '%s retains ordinary coverage, floor and concurrency',
    (surface) => {
      const config = createStrykerConfig(surface);
      expect(loadPolicy().surfaces[surface].threshold).toBe(80);
      expect(config.coverageAnalysis).toBe('perTest');
      expect(config.incremental).toBe(false);
      expect(config.concurrency).toBe(2);
      expect(config.thresholds).toEqual({ high: 90, low: 80, break: null });
    }
  );

  test('omitting the timestamp mutation target leaves an uncovered mutation obligation', () => {
    const policy = loadPolicy();
    policy.surfaces.store.targets = policy.surfaces.store.targets.filter(
      (target) => target.source !== 'src/transcripts/store-timestamp.ts'
    );
    const dir = makeTempDir();
    const policyFile = writeJson(dir, 'policy.json', policy);

    const result = runNode(VALIDATOR, ['--policy', policyFile, '--root', PACKAGE_ROOT]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'mutation-classified source has no surface target: src/transcripts/store-timestamp.ts'
    );
  });

  test('analysis mutations select the child-consumer contracts without file-name test filters', () => {
    const config = require(path.join(PACKAGE_ROOT, 'stryker.analysis.conf.js'));
    expect(config.mutate).toEqual([
      'src/shell/analysis/analyze.ts',
      'src/shell/analysis/git-context.ts',
      'src/shell/analysis/interpreter-effects.ts',
      'src/shell/analysis/mutation-view.ts',
      'src/shell/analysis/policies.ts',
      'src/shell/analysis/words.ts',
    ]);
    expect(config.incremental).toBe(false);
    expect(config.coverageAnalysis).toBe('off');
    expect(config).not.toHaveProperty('testFiles');
    expect(config.jest.config.testMatch).toEqual([
      '<rootDir>/tests/shell/command-analysis.test.js',
      '<rootDir>/tests/shell/interpreter-effects.test.js',
      '<rootDir>/tests/shell/mutation-view.test.js',
    ]);
    const names = new RegExp(config.jest.config.testNamePattern);
    expect(names.test('bounded shell analysis contract profile-git-status')).toBe(true);
    expect(names.test('bounded shell analysis contract semantic mutation in policies')).toBe(false);
  });

  test.each([
    [
      'multiline benign source',
      'bounded interpreter source effects admits only modeled benign source: // writeFileSync("/foreign", "x")\nconsole.log("write /foreign/output");',
      true,
    ],
    [
      'control words inside benign source',
      'bounded interpreter source effects admits only modeled benign source: console.log("semantic mutation in data");',
      true,
    ],
    [
      'multiline control payload',
      'bounded shell analysis contract semantic mutation in policies\nsource payload',
      false,
    ],
  ])('analysis name selection handles %s', (_label, name, selected) => {
    const config = require(path.join(PACKAGE_ROOT, 'stryker.analysis.conf.js'));
    expect(new RegExp(config.jest.config.testNamePattern).test(name)).toBe(selected);
  });

  test.each(['kernel', 'store', 'shell', 'analysis'])(
    '%s sandbox excludes sibling runs while retaining source and tests',
    (surface) => {
      expect(createStrykerConfig(surface).jest.config.setupFiles).toEqual([
        '<rootDir>/tests/helpers/isolate-session-env.js',
      ]);
      const dir = makeTempDir();
      const required = [
        'src/init/runtime.ts',
        'src/store/required.ts',
        'tests/store/required.test.js',
      ];
      const generated = [
        '.stryker-kernel-tmp/sandbox/temporary.ts',
        '.stryker-store-tmp/sandbox/temporary.ts',
        '.stryker-shell-tmp/sandbox/temporary.ts',
        '.stryker-analysis-123-tmp/sandbox/temporary.ts',
        'reports/mutation-store/mutation-report.json',
        'coverage/coverage.json',
        '.license-transport.json',
        '.license-transport.lock',
      ];
      for (const file of [...required, ...generated]) {
        const destination = path.join(dir, file);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, 'fixture');
      }
      // Exercise the installed Stryker reader that actually selects sandbox
      // inputs; matching patterns ourselves would not prove its semantics.
      const core = path.dirname(require.resolve('@stryker-mutator/core/package.json'));
      const script = `
      import fs from 'node:fs/promises';
      import path from 'node:path';
      import { pathToFileURL } from 'node:url';
      const core = ${JSON.stringify(core)};
      const { defaultOptions } = await import(pathToFileURL(path.join(core, 'dist/src/config/index.js')));
      const { ProjectReader } = await import(pathToFileURL(path.join(core, 'dist/src/fs/project-reader.js')));
      const reader = new ProjectReader(fs, {}, { ...defaultOptions, ...${JSON.stringify(createStrykerConfig(surface))} });
      const files = await reader.resolveInputFileNames();
      console.log(JSON.stringify(files.map(file => path.relative(process.cwd(), file)).sort()));
    `;
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: dir,
        env: nodeProcessEnv(),
        encoding: 'utf8',
        timeout: 10000,
      });
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(required);
    }
  );

  test.each(['kernel', 'store', 'shell', 'single'])(
    '%s installed preprocessing changes selected targets while preserving generator and test inputs',
    (surface) => {
      const single = surface === 'single' ? qualificationFixture() : null;
      const dir = single ? single.packageRoot : fs.realpathSync(makeTempDir('caws-preprocessor-'));
      const config = single ? null : createStrykerConfig(surface);
      const targets = single ? ['src/store/a.ts'] : config.mutate;
      const protectedFiles = [
        'scripts/generate-runtime-assets.mjs',
        'src/runtime/advisory-truncate-entry.ts',
        'src/runtime/utf8.ts',
        'scripts/build-cli.js',
        'tests/helpers/isolate-session-env.js',
      ];
      const testFile = single ? 'tests/store/a.test.js' : config.testFiles[0];
      protectedFiles.push(testFile);
      const originals = {};
      for (const file of [...targets, ...protectedFiles]) {
        const content = targets.includes(file)
          ? 'export const fixture: number = 1;\n'
          : single && file === testFile
            ? single.testSource
            : fs.readFileSync(path.join(PACKAGE_ROOT, file), 'utf8');
        const destination = path.join(dir, file);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, content);
        originals[file] = content;
      }
      const core = path.dirname(require.resolve('@stryker-mutator/core/package.json'));
      const instrumenter = require.resolve('@stryker-mutator/instrumenter');
      const script = `
        import fs from 'node:fs/promises';
        import path from 'node:path';
        import { pathToFileURL } from 'node:url';
        const core = ${JSON.stringify(core)};
        const { defaultOptions } = await import(pathToFileURL(path.join(core, 'dist/src/config/index.js')));
        const { FileMatcher } = await import(pathToFileURL(path.join(core, 'dist/src/config/file-matcher.js')));
        const { Project } = await import(pathToFileURL(path.join(core, 'dist/src/fs/project.js')));
        const { DisableTypeChecksPreprocessor } = await import(pathToFileURL(path.join(core, 'dist/src/sandbox/disable-type-checks-preprocessor.js')));
        const { disableTypeChecks } = await import(pathToFileURL(${JSON.stringify(instrumenter)}));
        const config = ${
          single
            ? `(await import(pathToFileURL(${JSON.stringify(path.join(dir, 'stryker.conf.cjs'))}))).default`
            : JSON.stringify(config)
        };
        const targets = ${JSON.stringify(targets)};
        const files = ${JSON.stringify([...targets, ...protectedFiles])};
        const project = new Project(fs, Object.fromEntries(files.map(file => [path.resolve(file), { mutate: targets.includes(file) }])), undefined);
        const warnings = [];
        const processor = new DisableTypeChecksPreprocessor({ warn: (...args) => warnings.push(String(args[0])) },
          { ...defaultOptions, disableTypeChecks: config.disableTypeChecks }, disableTypeChecks);
        await processor.preprocess(project);
        const matcher = new FileMatcher(config.disableTypeChecks);
        const observations = {};
        for (const file of files) observations[file] = {
          matched: matcher.matches(file), content: await project.files.get(path.resolve(file)).readContent(),
        };
        console.log(JSON.stringify({ warnings, observations }));
      `;
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: dir,
        env: nodeProcessEnv(),
        encoding: 'utf8',
        timeout: 15000,
      });
      retainChildObservation(single ? single.repoRoot : dir, result);

      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      const observed = JSON.parse(result.stdout);
      expect(observed.warnings).toEqual([]);
      for (const file of targets) {
        expect(observed.observations[file]).toEqual({
          matched: true,
          content: '// @ts-nocheck\n' + originals[file],
        });
      }
      for (const file of protectedFiles) {
        expect(observed.observations[file]).toEqual({ matched: false, content: originals[file] });
      }
    }
  );
});

describe('per-file mutation report contract', () => {
  test('offline scoring accepts synthetic source while describing SHA as a supplied label', () => {
    const dir = makeTempDir();
    const policyFile = writeJson(dir, 'policy.json', mutationPolicy(['dist/a.js']));
    const reportFile = writeJson(dir, 'report.json', report({ 'dist/a.js': ['Killed'] }));
    const summary = path.join(dir, 'summary.md');
    const result = runNode(REPORT_ASSERTION, [
      '--policy',
      policyFile,
      '--surface',
      'fixture',
      '--report',
      reportFile,
      '--summary',
      summary,
      '--sha',
      'descriptive-unverified-label',
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Offline mutation score calculation');
    const text = fs.readFileSync(summary, 'utf8');
    expect(text).toContain('Descriptive SHA (not verified): `descriptive-unverified-label`');
    expect(text).not.toContain('Tested SHA');
  });

  test('a target exactly at its floor passes with an explicit per-file verdict', () => {
    const result = runReportAssertion(
      mutationPolicy(['dist/a.js']),
      report({ 'dist/a.js': ['Killed', 'Killed', 'Killed', 'Killed', 'Survived'] })
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PASS dist/a.js 80.00% (4/5 detected)');
  });

  test('a zero-mutant target fails instead of receiving a perfect empty score', () => {
    const result = runReportAssertion(mutationPolicy(['dist/a.js']), report({ 'dist/a.js': [] }));

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('FAIL dist/a.js has zero valid mutants');
  });

  test('a report missing a declared target fails', () => {
    const result = runReportAssertion(
      mutationPolicy(['dist/a.js']),
      report({ 'dist/not-a.js': ['Killed'] })
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('FAIL missing report entry for dist/a.js');
  });

  test('a report with stale or missing test topology fails', () => {
    const policy = mutationPolicy(['dist/a.js']);
    policy.surfaces.fixture.tests = ['tests/current.test.js'];
    const mutationReport = report({ 'dist/a.js': ['Killed'] });
    mutationReport.testFiles = {
      'tests/stale.test.js': { tests: [] },
    };

    const result = runReportAssertion(policy, mutationReport);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('FAIL missing report test file tests/current.test.js');
    expect(result.stderr).toContain(
      'FAIL undeclared test file in mutation report: tests/stale.test.js'
    );
  });

  test('a weak file fails even when a large strong file makes the aggregate exceed 80', () => {
    const strong = Array.from({ length: 100 }, () => 'Killed');
    const result = runReportAssertion(
      mutationPolicy(['dist/strong.js', 'dist/weak.js']),
      report({
        'dist/strong.js': strong,
        'dist/weak.js': ['Killed', 'Survived'],
      })
    );

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('PASS dist/strong.js 100.00% (100/100 detected)');
    expect(result.stderr).toContain('FAIL dist/weak.js 50.00% is below 80.00%');
  });

  test('NoCoverage counts as undetected, not as an excluded mutant', () => {
    const result = runReportAssertion(
      mutationPolicy(['dist/a.js']),
      report({ 'dist/a.js': ['Killed', 'Killed', 'Killed', 'Killed', 'NoCoverage'] })
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PASS dist/a.js 80.00% (4/5 detected)');
  });
});

describe('captured-input mutation report qualification', () => {
  test('matching original source and discovered test text preserves the per-file floor', () => {
    const fixture = qualificationFixture();
    const result = runBoundAssertion(fixture, boundReportFixture(fixture));

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      errors: [],
      verdicts: [{ file: 'src/store/a.ts', detected: 4, valid: 5, score: 80, passed: true }],
    });
  });

  test.each([
    [
      'target',
      (value) => {
        value.files['src/store/a.ts'].source = 'module.exports = 2;\n';
      },
      'src/store/a.ts source does not match captured input',
    ],
    [
      'test',
      (value) => {
        value.testFiles['tests/store/a.test.js'].source += '// stale test\n';
      },
      'tests/store/a.test.js test source does not match captured input',
    ],
  ])('%s text mismatch refuses an otherwise passing report', (_kind, change, diagnostic) => {
    const fixture = qualificationFixture();
    const value = boundReportFixture(fixture);
    change(value);
    const result = runBoundAssertion(fixture, value);

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).errors).toContain(diagnostic);
  });

  test.each(['target', 'test'])('%s source must be present and string-valued', (kind) => {
    const fixture = qualificationFixture();
    for (const invalid of [undefined, null, 42]) {
      const value = boundReportFixture(fixture);
      const entry =
        kind === 'target'
          ? value.files['src/store/a.ts']
          : value.testFiles['tests/store/a.test.js'];
      if (invalid === undefined) delete entry.source;
      else entry.source = invalid;
      const result = runBoundAssertion(fixture, value);

      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout).errors).toContain(
        kind === 'target'
          ? 'src/store/a.ts source does not match captured input'
          : 'tests/store/a.test.js test source does not match captured input'
      );
    }
  });

  test.each([
    ['empty', []],
    ['missing', undefined],
    ['non-array', {}],
  ])('%s discovered test inventory cannot qualify a selected suite', (_kind, tests) => {
    const fixture = qualificationFixture();
    const value = boundReportFixture(fixture);
    if (tests === undefined) delete value.testFiles['tests/store/a.test.js'].tests;
    else value.testFiles['tests/store/a.test.js'].tests = tests;
    const result = runBoundAssertion(fixture, value);

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).errors).toContain(
      'tests/store/a.test.js has empty discovered tests'
    );
  });

  test.each(
    [null, {}, [], { id: 0, name: 'fixture' }, { id: '0', name: null }].map((definition) => [
      definition,
    ])
  )('malformed discovered definition %j cannot qualify a selected suite', (definition) => {
    const fixture = qualificationFixture();
    const value = boundReportFixture(fixture);
    value.testFiles['tests/store/a.test.js'].tests = [definition];
    const result = runBoundAssertion(fixture, value);

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).errors).toContain(
      'tests/store/a.test.js has malformed discovered test definition'
    );
  });

  test('a discovered test may have an empty string name', () => {
    const fixture = qualificationFixture();
    const value = boundReportFixture(fixture);
    value.testFiles['tests/store/a.test.js'].tests = [{ id: '0', name: '' }];
    const result = runBoundAssertion(fixture, value);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).errors).toEqual([]);
  });

  test('absolute report paths are anchored to captured package input, not report-provided root', () => {
    const fixture = qualificationFixture();
    const value = boundReportFixture(fixture);
    value.projectRoot = path.join(fixture.repoRoot, 'foreign');
    value.files = {
      [path.join(fixture.packageRoot, 'src/store/a.ts')]: value.files['src/store/a.ts'],
    };
    value.testFiles = {
      [path.join(fixture.packageRoot, 'tests/store/a.test.js')]:
        value.testFiles['tests/store/a.test.js'],
    };
    const result = runBoundAssertion(fixture, value);

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).errors).toEqual([]);
  });
});

describe('builtin-named package dependency capture', () => {
  test('builtin-named package captures the installed required package and its exact entry bytes', () => {
    const fixture = qualificationFixture();
    const dependency = addBuiltinNamedPackageFixture(fixture);
    const result = runBuiltinNamedPackageCapture(fixture, dependency);

    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const observed = JSON.parse(result.stdout);
    expect(observed.builtinResolution).toBe('buffer');
    expect(observed.installedResolution).toBe(dependency.bufferEntryPath);
    expect(observed.installedValue).toBe('physical-buffer-package-5.7.1');
    expect(observed.files).toEqual([
      {
        path: 'dependency:' + dependency.bufferEntryPath.split(path.sep).join('/'),
        sha256: createHash('sha256').update(dependency.bufferSource).digest('hex'),
        size: Buffer.byteLength(dependency.bufferSource),
        mode: fs.statSync(dependency.bufferEntryPath).mode & 0o777,
      },
    ]);
  });

  test('builtin-named package detects installed entry-byte drift after capture', () => {
    const fixture = qualificationFixture();
    const dependency = addBuiltinNamedPackageFixture(fixture);
    const result = runBuiltinNamedPackageCapture(fixture, dependency, { changeBytes: true });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).installedValue).toBe('physical-buffer-package-5.7.1');
    expect(result.stderr).toContain(
      'persistent authored/input drift: dependency:' +
        dependency.bufferEntryPath.split(path.sep).join('/')
    );
    expect(fs.readFileSync(dependency.bufferEntryPath, 'utf8')).toBe(
      "module.exports = 'changed-buffer-package-bytes';\n"
    );
  });

  test('builtin-named package refuses a missing required npm package despite the Node built-in', () => {
    const fixture = qualificationFixture();
    const dependency = addBuiltinNamedPackageFixture(fixture, { installed: false });
    const result = runBuiltinNamedPackageCapture(fixture, dependency);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'cannot resolve dependency buffer from ' + dependency.blManifestPath
    );
    expect(fs.existsSync(dependency.bufferEntryPath)).toBe(false);
    expect(fs.existsSync(path.join(fixture.repoRoot, 'captured-inputs.json'))).toBe(false);
  });
});

describe('ordinary runner input and build binding mechanics', () => {
  test.each(['initial capture', 'after capture'])(
    'unbound %s still rejects a conflicting PATH before any build',
    (phase) => {
      const fixture = qualificationFixture();
      const bin = path.join(fixture.repoRoot, 'conflicting');
      fs.mkdirSync(bin);
      const sentinel = path.join(fixture.repoRoot, 'conflict-sentinel');
      fs.writeFileSync(
        path.join(bin, 'node'),
        '#!/bin/sh\nprintf touched >> "$CONFLICT_SENTINEL"\nexit 91\n',
        { mode: 0o755 }
      );
      const script = `
      import fs from 'node:fs';
      import { captureMutationInputs, assertInputsUnchanged } from ${JSON.stringify('file://' + INPUT_IDENTITY)};
      const options = { packageRoot: process.cwd(), surfaceId: 'store', policy: JSON.parse(fs.readFileSync('mutation-policy.json')) };
      try {
        const captured = captureMutationInputs(options);
        console.log('initial capture succeeded');
        process.env.PATH = ${JSON.stringify(bin)} + ${JSON.stringify(path.delimiter)} + process.env.PATH;
        assertInputsUnchanged(captured, options);
      } catch (error) { console.error(error.message); process.exitCode = 1; }
    `;
      const env = nodeProcessEnv({ ...process.env, CONFLICT_SENTINEL: sentinel });
      if (phase === 'initial capture') env.PATH = bin + path.delimiter + env.PATH;
      // Intentionally unbound API probes: never pass these through an aligning spawn wrapper.
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: fixture.packageRoot,
        env,
        encoding: 'utf8',
        timeout: 15000,
      });
      retainChildObservation(fixture.repoRoot, result);
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('PATH node differs from runner Node executable');
      expect(result.stdout).toBe(phase === 'after capture' ? 'initial capture succeeded\n' : '');
      expect(fs.existsSync(sentinel)).toBe(false);
      expect(fs.existsSync(path.join(fixture.packageRoot, 'dist'))).toBe(false);
    }
  );

  test('a substituted sandbox Node executable is refused before the sandbox build', () => {
    const fixture = qualificationFixture({
      coreBody: fixtureCoreBody({
        beforeSandboxBuild: `
      const foreignBin = path.join(context.repoRoot, 'foreign-runtime');
      fs.mkdirSync(foreignBin);
      fs.copyFileSync(process.execPath, path.join(foreignBin, 'node'), fs.constants.COPYFILE_FICLONE);
      fs.chmodSync(path.join(foreignBin, 'node'), 0o755);
      process.env.PATH = foreignBin + path.delimiter + process.env.PATH;
    `,
      }),
    });
    const marker = path.join(fixture.repoRoot, 'sandbox-build-ran');
    fixture.put(
      'scripts/build-fixture.cjs',
      fixtureBuildBody(`
      if (require('node:path').basename(process.cwd()) === 'sandbox-fixture') fs.writeFileSync(${JSON.stringify(marker)}, 'unexpected build');
    `)
    );
    const result = runQualificationFixture(fixture);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('missing sandbox input: tool:');
    expect(result.receipt.build.status).toBe(0);
    expect(result.receipt.stryker.status).toBe(0);
    expect(result.receipt.error).toBe('missing executed sandbox build record');
    expect(fs.existsSync(marker)).toBe(false);
    const observed = JSON.parse(
      fs.readFileSync(path.join(fixture.repoRoot, 'fixture-build-observation.json'), 'utf8')
    );
    expect(observed.status).toBe(1);
    expect(observed.marker).toBeNull();
  });

  test('the copied environment helper remains part of immutable captured inputs', () => {
    const fixture = qualificationFixture({
      coreBody: fixtureCoreBody({
        afterSandbox:
          "fs.appendFileSync(path.join(context.packageRoot, 'scripts/lib/node-process-env.cjs'), '\\n// fixture drift\\n');",
      }),
    });
    const result = runQualificationFixture(fixture);
    expect(result.status).toBe(1);
    expect(result.receipt.build.status).toBe(0);
    expect(result.receipt.stryker.status).toBe(0);
    expect(result.receipt.error).toContain(
      'persistent authored/input drift: scripts/lib/node-process-env.cjs'
    );
  });

  test('mutation command binds every real child despite conflicting ambient PATH', () => {
    const exercise = (removeBinding) => {
      const fixture = qualificationFixture({ coreBody: fixtureCoreBody() });
      const bin = path.join(fixture.repoRoot, 'conflicting');
      fs.mkdirSync(bin);
      const sentinel = path.join(fixture.repoRoot, 'conflict-sentinel');
      fs.writeFileSync(
        path.join(bin, 'node'),
        '#!/bin/sh\nprintf touched >> "$CONFLICT_SENTINEL"\nexit 91\n',
        { mode: 0o755 }
      );
      const log = path.join(fixture.repoRoot, 'runtimes.jsonl');
      const preload = path.join(fixture.repoRoot, 'observe-runtime.cjs');
      fs.writeFileSync(
        preload,
        `const fs = require('node:fs');
        fs.appendFileSync(process.env.RUNTIME_LOG, JSON.stringify({
          node: fs.realpathSync(process.execPath), script: process.argv[1], cwd: process.cwd(),
          kept: process.env.KEEP_ME }) + '\\n');`
      );
      const runner = path.join(fixture.packageRoot, 'scripts/run-mutation.mjs');
      if (removeBinding) {
        const source = fs.readFileSync(runner, 'utf8');
        expect(source).toContain('process.env.PATH = childEnv.PATH;');
        fs.writeFileSync(runner, source.replace('process.env.PATH = childEnv.PATH;', ''));
      }
      // Deliberately RAW: an aligning fixture spawn helper would hide a missing production binding.
      const result = spawnSync(process.execPath, [runner, '--surface', 'store'], {
        cwd: fixture.packageRoot,
        encoding: 'utf8',
        timeout: 30000,
        env: {
          ...process.env,
          PATH: bin + path.delimiter + process.env.PATH,
          NODE_OPTIONS: '--require ' + preload,
          RUNTIME_LOG: log,
          KEEP_ME: 'preserved',
          CONFLICT_SENTINEL: sentinel,
        },
      });
      retainChildObservation(fixture.repoRoot, result);
      const receiptPath = path.join(
        fixture.packageRoot,
        'reports/mutation-store/mutation-run.json'
      );
      const receipt = fs.existsSync(receiptPath)
        ? JSON.parse(fs.readFileSync(receiptPath, 'utf8'))
        : null;
      return {
        fixture,
        result,
        receipt,
        sentinel,
        observations: fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse),
      };
    };
    const bound = exercise(false);
    expect({
      error: bound.result.error,
      signal: bound.result.signal,
      stderr: bound.result.stderr,
      status: bound.result.status,
    }).toEqual({ error: undefined, signal: null, stderr: '', status: 0 });
    expect(bound.receipt.status).toBe('input-build-report-bound');
    expect(
      bound.observations.every(
        (x) => x.node === fs.realpathSync(process.execPath) && x.kept === 'preserved'
      )
    ).toBe(true);
    for (const script of [
      'run-mutation.mjs',
      'npm-cli.js',
      'build-fixture.cjs',
      'stryker.cjs',
      'mutation-input-identity.mjs',
    ]) {
      expect(bound.observations.some((x) => path.basename(x.script) === script)).toBe(true);
    }
    expect(
      bound.observations.filter((x) => path.basename(x.script) === 'build-fixture.cjs')
    ).toHaveLength(2);
    expect(
      bound.observations.some(
        (x) =>
          path.basename(x.cwd) === 'sandbox-fixture' &&
          path.basename(x.script) === 'build-fixture.cjs'
      )
    ).toBe(true);
    expect(fs.existsSync(bound.sentinel)).toBe(false);
    expect(bound.receipt.inputIdentity.files).toContainEqual(
      expect.objectContaining({
        path: 'scripts/lib/node-process-env.cjs',
        sha256: createHash('sha256')
          .update(fs.readFileSync(path.join(PACKAGE_ROOT, 'scripts/lib/node-process-env.cjs')))
          .digest('hex'),
      })
    );
    const unbound = exercise(true);
    expect(unbound.result.status).toBe(1);
    expect(unbound.result.stderr).toContain('PATH node differs from runner Node executable');
    expect(unbound.receipt.build).toBeUndefined();
    expect(unbound.observations).toHaveLength(1);
    expect(fs.existsSync(unbound.sentinel)).toBe(false);
  });

  test('outer and relocated sandbox builds consume the same package-local dependency values', () => {
    const fixture = qualificationFixture({
      buildBody: fixtureBuildBody(`
        const value = require('chalk');
        fs.mkdirSync('dist', { recursive: true });
        fs.writeFileSync('dist/dependency-value.json', JSON.stringify(value));
      `),
      coreBody: fixtureCoreBody(),
    });
    addSplitDependencyFixture(fixture);
    const result = runQualificationFixture(fixture);

    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.receipt.status).toBe('input-build-report-bound');
    const expected = { color: 'local-chalk-4', style: 'local-ansi-4' };
    expect(
      JSON.parse(
        fs.readFileSync(path.join(fixture.packageRoot, 'dist/dependency-value.json'), 'utf8')
      )
    ).toEqual(expected);
    const observation = JSON.parse(
      fs.readFileSync(path.join(fixture.repoRoot, 'fixture-build-observation.json'), 'utf8')
    );
    expect(observation.status).toBe(0);
    expect(observation.dependencyValue).toEqual(expected);
    expect(require(path.join(fixture.repoRoot, 'node_modules/chalk'))).toEqual({
      color: 'hoisted-chalk-5',
      style: 'hoisted-ansi-5',
    });
    const original = result.receipt.inputIdentity.packageNodeModules;
    const sandbox = result.receipt.sandboxBuilds[0].inputIdentity.packageNodeModules;
    expect(original.canonical).toBe(path.join(fixture.packageRoot, 'node_modules'));
    expect(sandbox.canonical).toBe(original.canonical);
    expect(sandbox.targetIdentity).toEqual(original.targetIdentity);
    expect(sandbox.entryIdentity.ino).not.toBe(original.entryIdentity.ino);
  });

  test('a foreign existing sandbox dependency destination is refused and preserved', () => {
    const fixture = qualificationFixture({
      coreBody: fixtureCoreBody({
        beforeSandboxBuild: `
      fs.mkdirSync(path.join(sandbox, 'node_modules'));
      fs.writeFileSync(path.join(sandbox, 'node_modules/foreign.txt'), 'foreign dependency bytes');
    `,
      }),
    });
    const result = runQualificationFixture(fixture);

    expect(result.status).toBe(1);
    expect(result.receipt.build.status).toBe(0);
    expect(result.receipt.stryker.status).toBe(0);
    expect(result.receipt.status).toBe('failed');
    expect(result.stderr).toContain('uncertain existing sandbox dependency destination');
    const observation = JSON.parse(
      fs.readFileSync(path.join(fixture.repoRoot, 'fixture-build-observation.json'), 'utf8')
    );
    expect(observation.status).toBe(1);
    expect(
      fs.readFileSync(path.join(observation.sandbox, 'node_modules/foreign.txt'), 'utf8')
    ).toBe('foreign dependency bytes');
  });

  test('replacing the original package dependency directory refuses sandbox execution', () => {
    const fixture = qualificationFixture({
      coreBody: fixtureCoreBody({
        beforeSandboxBuild: `
      const original = path.join(context.packageRoot, 'node_modules');
      fs.renameSync(original, original + '-previous');
      fs.cpSync(original + '-previous', original, { recursive: true });
    `,
      }),
    });
    const result = runQualificationFixture(fixture);

    expect(result.status).toBe(1);
    expect(result.receipt.build.status).toBe(0);
    expect(result.receipt.stryker.status).toBe(0);
    expect(result.receipt.status).toBe('failed');
    expect(result.stderr).toContain('original package-local dependency binding changed');
    const observation = JSON.parse(
      fs.readFileSync(path.join(fixture.repoRoot, 'fixture-build-observation.json'), 'utf8')
    );
    expect(observation.status).toBe(1);
    expect(fs.existsSync(path.join(observation.sandbox, 'dist'))).toBe(false);
    expect(
      fs.existsSync(
        path.join(fixture.packageRoot, 'node_modules-previous/@stryker-mutator/core/package.json')
      )
    ).toBe(true);
  });

  test('successful real children retain run association while staging independent owned licenses', () => {
    const fixture = qualificationFixture({ coreBody: fixtureCoreBody() });
    const result = runQualificationFixture(fixture);

    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('fixture Stryker child completed with exit zero');
    expect(result.receipt.status).toBe('input-build-report-bound');
    expect(result.receipt.build.command.slice(-2)).toEqual(['run', 'build']);
    expect(result.receipt.build.cwd).toBe(fixture.packageRoot);
    expect(result.receipt.build.status).toBe(0);
    expect(result.receipt.stryker.status).toBe(0);
    expect(result.receipt.discovery).toEqual({
      sourceCount: 1,
      declaredSourceCount: 1,
      mutantCount: 5,
      reportMutantCount: 5,
    });
    expect(result.receipt.sandboxBuilds).toHaveLength(1);
    const built = result.receipt.sandboxBuilds[0];
    expect(built.runId).toBe(result.receipt.runId);
    expect(built.command).toBe('node scripts/build-fixture.cjs');
    expect(built.status).toBe(0);
    expect(path.resolve(built.cwd, '../..')).toBe(fixture.repoRoot);
    expect(result.receipt.inputIdentity.files.map((file) => file.path)).not.toContain(
      '.license-transport.json'
    );
    const marker = JSON.parse(
      fs.readFileSync(path.join(fixture.packageRoot, '.license-transport.json'), 'utf8')
    );
    const observation = JSON.parse(
      fs.readFileSync(path.join(fixture.repoRoot, 'fixture-build-observation.json'), 'utf8')
    );
    expect(marker.phase).toBe('ready');
    expect(marker.entries).toHaveLength(3);
    expect(marker.entries.map((entry) => entry.status)).toEqual(['owned', 'owned', 'owned']);
    expect(observation.marker.phase).toBe('ready');
    expect(observation.marker.entries).toHaveLength(3);
    expect(observation.markerInode).not.toBe(
      fs.statSync(path.join(fixture.packageRoot, '.license-transport.json')).ino
    );
    expect(fs.existsSync(observation.sandbox)).toBe(false);
    expect(
      fs.readFileSync(path.join(path.dirname(observation.sandbox), 'foreign-sibling.txt'), 'utf8')
    ).toBe('foreign sibling must survive');
    expect(fs.existsSync(path.join(fixture.packageRoot, '.license-transport.lock'))).toBe(false);
    expect(
      fs.existsSync(path.join(fixture.packageRoot, 'reports/mutation-store/.mutation-run.lock'))
    ).toBe(false);
    expect(
      fs.readFileSync(
        path.join(fixture.packageRoot, 'dist/transcripts/unicode14/LICENSE.txt'),
        'utf8'
      )
    ).toBe('Fixture Unicode license\n');
    const retained = path.join(
      fixture.packageRoot,
      'reports/mutation-store/runs',
      result.receipt.runId
    );
    expect(fs.readFileSync(path.join(retained, 'mutation-report.json'))).toEqual(
      fs.readFileSync(result.receipt.report.path)
    );
    expect(
      JSON.parse(fs.readFileSync(path.join(retained, 'mutation-run.json'), 'utf8')).runId
    ).toBe(result.receipt.runId);
  });

  test('persistent authored drift during a passing child cannot acquire a bound verdict', () => {
    const fixture = qualificationFixture({
      coreBody: fixtureCoreBody({
        afterSandbox:
          "fs.appendFileSync(path.join(context.packageRoot, 'src/store/a.ts'), '// changed during child\\n');",
      }),
    });
    const result = runQualificationFixture(fixture);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('fixture Stryker child completed with exit zero');
    expect(result.receipt.stryker.status).toBe(0);
    expect(result.receipt.status).toBe('failed');
    expect(result.receipt.error).toContain('persistent authored/input drift: src/store/a.ts');
    expect(fs.existsSync(path.join(fixture.packageRoot, '.license-transport.json'))).toBe(true);
  });

  test.each([
    [
      'unexpected source count',
      { loggedSourceCount: 2 },
      'instrumented source count 2 does not match declared target count 1',
    ],
    [
      'unexpected mutant count',
      { loggedMutantCount: 6 },
      'instrumented mutant count 6 does not match report mutant count 5',
    ],
    [
      'truncated positive report',
      { reportBody: "report.files['src/store/a.ts'].mutants.pop();" },
      'instrumented mutant count 5 does not match report mutant count 4',
    ],
  ])(
    '%s cannot qualify despite positive discovery and a zero-exit child',
    (_kind, coreOptions, diagnostic) => {
      const fixture = qualificationFixture({ coreBody: fixtureCoreBody(coreOptions) });
      const result = runQualificationFixture(fixture);

      expect(result.status).toBe(1);
      expect(result.receipt.stryker.status).toBe(0);
      expect(result.receipt.status).toBe('failed');
      expect(result.receipt.error).toBe(diagnostic);
    }
  );

  test('invalid verdicts count toward discovery reconciliation but still fail scoring', () => {
    const fixture = qualificationFixture({
      coreBody: fixtureCoreBody({
        loggedMutantCount: 6,
        reportBody:
          "report.files['src/store/a.ts'].mutants.push({ ...report.files['src/store/a.ts'].mutants[0], id: '5', status: 'RuntimeError' });",
      }),
    });
    const result = runQualificationFixture(fixture);

    expect(result.status).toBe(1);
    expect(result.receipt.stryker.status).toBe(0);
    expect(result.receipt.status).toBe('failed');
    expect(result.receipt.error).toBeUndefined();
    expect(result.receipt.errors).toContain(
      'src/store/a.ts has 1 invalid or pending mutant verdict(s)'
    );
  });

  test('an outer build failure retains its actual status and never launches Stryker', () => {
    const fixture = qualificationFixture({
      buildBody: "console.error('fixture outer build refusal'); process.exit(7);\n",
      coreBody: "throw new Error('Stryker must not execute after failed outer build');\n",
    });
    const result = runQualificationFixture(fixture);

    expect(result.status).toBe(1);
    expect(result.receipt.status).toBe('failed');
    expect(result.receipt.build.status).toBe(7);
    expect(result.receipt.build.output).toContain('fixture outer build refusal');
    expect(result.receipt.error).toContain('ordinary build failed');
    expect(result.receipt.stryker).toBeUndefined();
  });

  test('a zero-exit child without a sandbox build cannot qualify copied outer output', () => {
    const fixture = qualificationFixture({ coreBody: fixtureCoreBody({ skipSandbox: true }) });
    const result = runQualificationFixture(fixture);

    expect(result.status).toBe(1);
    expect(result.receipt.build.status).toBe(0);
    expect(result.receipt.stryker.status).toBe(0);
    expect(result.receipt.error).toBe('missing executed sandbox build record');
    expect(result.receipt.status).toBe('failed');
  });

  test('a failed sandbox build cannot borrow a passing child status', () => {
    const fixture = qualificationFixture({
      buildBody: fixtureBuildBody(
        "if (require('node:path').basename(process.cwd()).startsWith('sandbox-')) { console.error('fixture sandbox build refusal'); process.exit(9); }"
      ),
      coreBody: fixtureCoreBody(),
    });
    const result = runQualificationFixture(fixture);

    expect(result.status).toBe(1);
    expect(result.receipt.build.status).toBe(0);
    expect(result.receipt.stryker.status).toBe(0);
    expect(result.stderr).toContain('fixture sandbox build refusal');
    expect(result.receipt.error).toContain('detached or failed sandbox build record');
    const context = JSON.parse(
      fs.readFileSync(
        path.join(
          fixture.packageRoot,
          'reports/mutation-store/runs',
          result.receipt.runId,
          'context.json'
        ),
        'utf8'
      )
    );
    const sandboxRecord = JSON.parse(
      fs.readFileSync(path.join(context.sandboxBuildDir, 'sandbox-fixture.json'), 'utf8')
    );
    expect(sandboxRecord.status).toBe(9);
    expect(sandboxRecord.error).toContain('sandbox build failed (exit 9)');
  });

  test('a sandbox build from another run cannot qualify the current invocation', () => {
    const fixture = qualificationFixture({
      coreBody: fixtureCoreBody({
        afterSandbox: `
      const recordFile = path.join(context.sandboxBuildDir, 'sandbox-fixture.json');
      const previous = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
      previous.runId = 'different-invocation';
      fs.writeFileSync(recordFile, JSON.stringify(previous));
    `,
      }),
    });
    const result = runQualificationFixture(fixture);

    expect(result.status).toBe(1);
    expect(result.receipt.stryker.status).toBe(0);
    expect(result.receipt.status).toBe('failed');
    expect(result.receipt.error).toContain('detached or failed sandbox build record');
  });

  test('corrupt output identities cannot borrow an otherwise successful sandbox receipt', () => {
    const fixture = qualificationFixture({
      coreBody: fixtureCoreBody({
        afterSandbox: `
      const recordFile = path.join(context.sandboxBuildDir, 'sandbox-fixture.json');
      const previous = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
      previous.outputs.files[0].sha256 = '0'.repeat(64);
      fs.writeFileSync(recordFile, JSON.stringify(previous));
    `,
      }),
    });
    const result = runQualificationFixture(fixture);

    expect(result.status).toBe(1);
    expect(result.receipt.stryker.status).toBe(0);
    expect(result.receipt.status).toBe('failed');
    expect(result.receipt.error).toContain('invalid sandbox input/output digest');
  });

  test('an existing report-writer lock is preserved and refuses a second writer before building', () => {
    const fixture = qualificationFixture();
    const lock = fixture.put('reports/mutation-store/.mutation-run.lock', 'foreign writer lock\n');
    const before = fs.statSync(lock);
    const result = runQualificationFixture(fixture);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'mutation report writer lock unavailable; ownership is uncertain'
    );
    expect(result.receipt).toBeNull();
    expect(fs.readFileSync(lock, 'utf8')).toBe('foreign writer lock\n');
    expect(fs.statSync(lock).ino).toBe(before.ino);
    expect(fs.existsSync(path.join(fixture.packageRoot, 'dist'))).toBe(false);
  });

  test('a replaced writer lock forces a failed terminal record and preserves foreign ownership', () => {
    const fixture = qualificationFixture({
      coreBody: fixtureCoreBody({
        afterSandbox: `
      const lock = path.join(context.packageRoot, 'reports/mutation-store/.mutation-run.lock');
      fs.unlinkSync(lock);
      fs.writeFileSync(lock, 'replacement foreign writer\\n');
    `,
      }),
    });
    const result = runQualificationFixture(fixture);

    expect(result.status).toBe(1);
    expect(result.receipt.stryker.status).toBe(0);
    expect(result.receipt.status).toBe('failed');
    expect(result.receipt.exitCode).toBe(1);
    expect(result.receipt.lockError).toBe(
      'mutation report writer lock replaced; ownership is uncertain'
    );
    expect(
      fs.readFileSync(
        path.join(fixture.packageRoot, 'reports/mutation-store/.mutation-run.lock'),
        'utf8'
      )
    ).toBe('replacement foreign writer\n');
    const retained = path.join(
      fixture.packageRoot,
      'reports/mutation-store/runs',
      result.receipt.runId,
      'mutation-run.json'
    );
    expect(JSON.parse(fs.readFileSync(retained, 'utf8')).status).toBe('failed');
    expect(JSON.parse(fs.readFileSync(retained, 'utf8')).lockError).toBe(result.receipt.lockError);
  });

  test('emitted executable mode drift cannot pass as unchanged build output', () => {
    const fixture = qualificationFixture({
      coreBody: fixtureCoreBody({
        afterSandbox: "fs.chmodSync(path.join(context.packageRoot, 'dist/index.js'), 0o644);",
      }),
    });
    const result = runQualificationFixture(fixture);

    expect(result.status).toBe(1);
    expect(result.receipt.stryker.status).toBe(0);
    expect(result.receipt.status).toBe('failed');
    expect(result.receipt.error).toContain('emitted dist changed after build');
    expect(fs.statSync(path.join(fixture.packageRoot, 'dist/index.js')).mode & 0o777).toBe(0o644);
  });

  test('a symlink sandbox parent is refused while its foreign target remains untouched', () => {
    const fixture = qualificationFixture();
    const foreign = fs.realpathSync(makeTempDir('caws-mutation-foreign-'));
    const sentinel = path.join(foreign, 'sentinel.txt');
    fs.writeFileSync(sentinel, 'foreign bytes');
    const linked = path.join(fixture.repoRoot, '.stryker-store-linked-tmp');
    fs.symlinkSync(foreign, linked, 'dir');
    const result = spawnSync(process.execPath, ['-e', "require('./stryker.conf.cjs')"], {
      cwd: fixture.packageRoot,
      encoding: 'utf8',
      env: { ...nodeProcessEnv(), CAWS_MUTATION_TEMP_DIR: linked },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Uncertain mutation sandbox ancestry');
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('foreign bytes');
    expect(fs.lstatSync(linked).isSymbolicLink()).toBe(true);
  });
});

describe('active workflow topology contract', () => {
  test('the PR shadow-file check refuses when Git cannot compute the diff', () => {
    const prChecks = yaml.load(
      fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/pr-checks.yml'), 'utf8')
    );
    const step = prChecks.jobs.sanity.steps.find(
      (item) => item.name === 'Block shadow file patterns'
    );
    expect(step).toHaveProperty('run');
    const result = spawnSync(
      '/bin/bash',
      [
        '--noprofile',
        '--norc',
        '-e',
        '-o',
        'pipefail',
        '-c',
        step.run.replaceAll('${{ github.base_ref }}', 'main'),
      ],
      {
        cwd: makeTempDir(),
        encoding: 'utf8',
        timeout: 10000,
        env: { ...process.env, BASE_REF: 'missing-base', HEAD_REF: 'missing-head', LC_ALL: 'C' },
      }
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/not a git repository/i);
  });

  test('PR checks preserve executable regression jobs and reject empty test selection', () => {
    const prChecks = yaml.load(
      fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/pr-checks.yml'), 'utf8')
    );
    const jobs = prChecks.jobs;
    for (const job of Object.values(jobs)) {
      const dependencies = Array.isArray(job.needs) ? job.needs : job.needs ? [job.needs] : [];
      for (const dependency of dependencies) expect(jobs).toHaveProperty(dependency);
    }
    expect(jobs.pr_comment.needs).toContain('hook_bats_bash32_macos');
    expect(jobs.hook_bats_bash32_macos.steps).toContainEqual(
      expect.objectContaining({ run: 'npm run test:bats:macos' })
    );
    expect(executableWorkflowText(prChecks)).not.toContain('--passWithNoTests');
    expect(executableWorkflowText(prChecks)).not.toContain('perf:budgets');
  });

  test('the removed performance suite is not exposed as an executable package check', () => {
    const metadata = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'));
    expect(metadata.scripts).not.toHaveProperty('perf:budgets');
  });

  test('the mutation workflow uses current caws-cli surfaces and retains evidence', () => {
    const workflow = fs.readFileSync(
      path.join(REPO_ROOT, '.github/workflows/mutation.yml'),
      'utf8'
    );

    expect(workflow).not.toContain('packages/caws-kernel');
    const parsed = yaml.load(workflow);
    const surfaces = ['kernel', 'store', 'shell', 'analysis'];
    expect(parsed.jobs.harness_integrity.strategy.matrix.surface).toEqual(surfaces);
    expect(parsed.jobs.mutation.strategy.matrix.surface).toEqual(surfaces);
    const scripts = JSON.parse(
      fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')
    ).scripts;
    for (const surface of surfaces) {
      const script = scripts[`mutation:run:${surface}`];
      expect(script).toContain(`--surface ${surface}`);
      expect(script.match(/--surface /g)).toHaveLength(1);
    }
    expect(workflow).toContain('mutation:dry-run');
    expect(workflow).toContain('actions/upload-artifact@v4');
    expect(workflow).toContain('GITHUB_STEP_SUMMARY');
    expect(workflow).toContain('github.sha');
  });

  test('no executable workflow step treats working-spec.yaml as current authority', () => {
    const workflowDir = path.join(REPO_ROOT, '.github/workflows');
    const offenders = [];

    for (const name of fs.readdirSync(workflowDir).filter((file) => file.endsWith('.yml'))) {
      const parsed = yaml.load(fs.readFileSync(path.join(workflowDir, name), 'utf8'));
      if (executableWorkflowText(parsed).includes('.caws/working-spec.yaml')) offenders.push(name);
    }

    expect(offenders).toEqual([]);
  });

  test('the duplicate v10 CAWS Guards workflow and PR job are retired', () => {
    expect(fs.existsSync(path.join(REPO_ROOT, '.github/workflows/caws-guards.yml'))).toBe(false);

    const prChecks = yaml.load(
      fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/pr-checks.yml'), 'utf8')
    );
    expect(prChecks.jobs).not.toHaveProperty('caws_guards');

    const cawsGate = yaml.load(
      fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/caws-gate.yml'), 'utf8')
    );
    expect(cawsGate.jobs).toHaveProperty('caws-gate');
  });
});

describe('a surface that verifies nothing cannot report success', () => {
  test('no declared targets fails even when the report is also empty', () => {
    // The dangerous shape: with no targets the per-file loop never runs, so
    // no errors accumulate and the script previously exited 0 having printed
    // neither a PASS nor a FAIL. An empty report is what makes it silent —
    // any file present would have been caught as "undeclared".
    const result = runReportAssertion(mutationPolicy([]), report({}));

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('declares no targets');
  });

  test('no declared targets fails even when a report has passing files', () => {
    const result = runReportAssertion(
      mutationPolicy([]),
      report({ 'dist/a.js': ['Killed', 'Killed'] })
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('declares no targets');
  });

  test('a surface whose targets key is absent entirely fails', () => {
    const policy = mutationPolicy([]);
    delete policy.surfaces.fixture.targets;

    const result = runReportAssertion(policy, report({}));

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('declares no targets');
  });

  test('a passing surface still reports a per-file verdict', () => {
    // Negative control for the three above: the guard must not have made the
    // ordinary passing path fail.
    const result = runReportAssertion(
      mutationPolicy(['dist/a.js']),
      report({ 'dist/a.js': ['Killed', 'Killed', 'Killed', 'Killed', 'Survived'] })
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PASS dist/a.js 80.00%');
  });
});
