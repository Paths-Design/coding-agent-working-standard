'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const yaml = require('js-yaml');

const packageRoot = path.resolve(__dirname, '../..');
const repoRoot = path.resolve(packageRoot, '../..');
const temporary = [];

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'caws-release-hardening-')));
  temporary.push(root);
  return root;
}

afterAll(() => {
  for (const root of temporary) fs.rmSync(root, { recursive: true, force: true });
});

test.each([0, 1, 42])('the actual PR audit step preserves npm exit status %s', (status) => {
  const workflow = yaml.load(
    fs.readFileSync(path.join(repoRoot, '.github/workflows/pr-checks.yml'), 'utf8')
  );
  const step = workflow.jobs.sanity.steps.find((entry) => entry.name === 'Security audit');
  expect(typeof step.run).toBe('string');
  const root = fixture();
  fs.writeFileSync(
    path.join(root, 'npm'),
    `#!/bin/sh\necho 'fixture registry audit verdict' >&2\nexit ${status}\n`,
    { mode: 0o755 }
  );
  const result = spawnSync('/bin/bash', ['-e', '-c', step.run], {
    cwd: repoRoot,
    env: { ...process.env, PATH: `${root}${path.delimiter}${process.env.PATH}` },
    encoding: 'utf8',
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(status);
});

test('release qualification requires the same dependency audit as PR CI', () => {
  const workflow = yaml.load(
    fs.readFileSync(path.join(repoRoot, '.github/workflows/release-qualification.yml'), 'utf8')
  );
  expect(
    workflow.jobs.tests.steps.some(
      (step) =>
        step.run === 'npm run audit:dependencies --workspaces=false' &&
        !step.if &&
        !step['continue-on-error']
    )
  ).toBe(true);
});

test.each([0, 17])('real npm routes the workflow audit to root and preserves exit %s', (status) => {
  const root = fixture();
  fs.mkdirSync(path.join(root, 'packages/fixture'), { recursive: true });
  fs.writeFileSync(path.join(root, '.npmrc'), 'workspaces=true\n');
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({
      private: true,
      workspaces: ['packages/*'],
      scripts: {
        'audit:dependencies': `node -e "console.log('ROOT_AUDIT_EXECUTED'); process.exit(${status})"`,
      },
    })
  );
  fs.writeFileSync(
    path.join(root, 'packages/fixture/package.json'),
    JSON.stringify({ name: 'fixture', version: '1.0.0' })
  );
  for (const name of ['pr-checks.yml', 'release-qualification.yml']) {
    const workflow = yaml.load(
      fs.readFileSync(path.join(repoRoot, '.github/workflows', name), 'utf8')
    );
    const steps = (workflow.jobs.sanity || workflow.jobs.tests).steps;
    const step = steps.find((entry) => entry.run?.startsWith('npm run audit:dependencies'));
    const result = spawnSync('/bin/bash', ['-e', '-c', step.run], { cwd: root, encoding: 'utf8' });
    expect(result.stdout).toContain('ROOT_AUDIT_EXECUTED');
    expect(result.status).toBe(status);
  }
});

test('the effective coverage config includes unexecuted runtime files and enforces a real failing verdict', () => {
  const actual = require('../../jest.config');
  const workspace = fixture();
  const root = path.join(workspace, 'packages/caws-cli');
  fs.mkdirSync(path.join(root, 'dist/store'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tests/helpers'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts/lib'), { recursive: true });
  fs.mkdirSync(path.join(workspace, 'packages/caws-native'), { recursive: true });
  for (const relative of [
    'tests/helpers/isolate-session-env.js',
    'tests/helpers/load-native-test-prerequisites.js',
    'scripts/lib/native-test-prerequisite-receipt.cjs',
  ]) {
    fs.copyFileSync(path.join(packageRoot, relative), path.join(root, relative));
  }
  fs.writeFileSync(path.join(root, 'dist/store/probe.js'), 'exports.value = () => 7;\n');
  fs.writeFileSync(
    path.join(root, 'dist/store/unexecuted.js'),
    Array.from({ length: 12 }, (_, n) => `exports.f${n} = () => ${n};`).join('\n')
  );
  fs.writeFileSync(path.join(root, 'tests/helpers/helper.js'), 'exports.value = () => 9;\n');
  const testFile = path.join(root, 'tests/probe.test.js');
  fs.writeFileSync(
    testFile,
    "test('observed values', () => { expect(require('../dist/store/probe').value()).toBe(7); expect(require('./helpers/helper').value()).toBe(9); });\n"
  );
  const config = {
    ...actual,
    rootDir: root,
    projects: actual.projects
      .filter((project) => project.displayName === 'caws-cli')
      .map((project) => ({ ...project, rootDir: root })),
    // The tiny fixture checks the actual global floor. Production path floors
    // have no corresponding source tree here and are checked by the full run.
    coverageThreshold: actual.coverageThreshold && { global: actual.coverageThreshold.global },
    coverageReporters: ['json'],
    coverageDirectory: path.join(root, 'coverage'),
  };
  fs.writeFileSync(path.join(root, 'jest.config.json'), JSON.stringify(config));
  const childEnvironment = { ...process.env, FORCE_COLOR: '0' };
  delete childEnvironment.CAWS_TEST_GUARD_STRIKES_CORE_TEST_BINARY;
  const run = () =>
    spawnSync(
      process.execPath,
      [
        require.resolve('jest/bin/jest'),
        '--config',
        path.join(root, 'jest.config.json'),
        '--runInBand',
        '--coverage',
      ],
      {
        cwd: root,
        encoding: 'utf8',
        env: childEnvironment,
      }
    );
  const deficient = run();
  expect(deficient.error).toBeUndefined();
  expect(deficient.status).toBe(1);
  expect(deficient.stderr).toMatch(/coverage.*threshold/i);
  const report = JSON.parse(
    fs.readFileSync(path.join(root, 'coverage/coverage-final.json'), 'utf8')
  );
  expect(Object.keys(report).sort()).toEqual([
    path.join(root, 'dist/store/probe.js'),
    path.join(root, 'dist/store/unexecuted.js'),
  ]);
  expect(Object.values(report[path.join(root, 'dist/store/unexecuted.js')].f)).toEqual(
    Array(12).fill(0)
  );
  fs.appendFileSync(
    testFile,
    "test('all values', () => { const api = require('../dist/store/unexecuted'); for (let n = 0; n < 12; n++) expect(api['f' + n]()).toBe(n); });\n"
  );
  const covered = run();
  expect(covered.error).toBeUndefined();
  expect(covered.status).toBe(0);
}, 60000);

test('lint ignores generated reports but retains authored source rules', async () => {
  const { ESLint } = require('eslint');
  const lint = new ESLint({
    cwd: packageRoot,
    overrideConfigFile: true,
    overrideConfig: require('../../eslint.config'),
  });
  const report = path.join(packageRoot, 'reports/fixture/generated.js');
  expect(await lint.isPathIgnored(report)).toBe(true);
  const [ignored] = await lint.lintText('const unusedProbe = 1;\n', { filePath: report });
  expect(ignored.errorCount).toBe(0);
  expect(ignored.messages.some((message) => /ignored/i.test(message.message))).toBe(true);
  for (const relative of [
    'src/probe.js',
    'scripts/probe.mjs',
    'scripts/probe.cjs',
    'templates/probe.js',
    'tests/probe.js',
    'src/probe.ts',
    'scripts/probe.ts',
    'templates/probe.ts',
    'tests/probe.ts',
  ]) {
    const filePath = path.join(packageRoot, relative);
    expect(await lint.isPathIgnored(filePath)).toBe(false);
    const [result] = await lint.lintText('const unusedProbe = 1;\n', { filePath });
    expect(result.errorCount).toBeGreaterThan(0);
    expect(
      result.messages.some(
        (message) =>
          message.ruleId === 'no-unused-vars' ||
          message.ruleId === '@typescript-eslint/no-unused-vars'
      )
    ).toBe(true);
  }
});

test('Jest excludes report package collisions without hiding authored tests or modules', () => {
  const actual = require('../../jest.config');
  const root = fixture();
  const put = (relative, bytes) => {
    const dest = path.join(root, relative);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, bytes);
  };
  put(
    'src/authored/package.json',
    JSON.stringify({ name: 'caws-crawler-probe', main: 'index.js' })
  );
  put('src/authored/index.js', 'module.exports = 17;\n');
  put(
    'reports/generated/package.json',
    JSON.stringify({ name: 'caws-crawler-probe', main: 'index.js' })
  );
  put('reports/generated/index.js', 'module.exports = 99;\n');
  put(
    'tests/visible.test.js',
    "test('main selected', () => expect(require('caws-crawler-probe')).toBe(17));\n"
  );
  put(
    'tests/kernel/visible.test.ts',
    "test('kernel selected', () => expect(require('caws-crawler-probe')).toBe(17));\n"
  );
  const config = {
    ...actual,
    rootDir: root,
    projects: actual.projects.map((project) => ({
      ...project,
      rootDir: root,
      // Crawler-only fixture: no native preparation or TS compilation claim.
      globalSetup: undefined,
      setupFiles: [],
      transform: {},
    })),
  };
  const configPath = path.join(root, 'jest.config.json');
  const run = (args, label) => {
    const command = [
      require.resolve('jest/bin/jest'),
      '--config',
      configPath,
      '--runInBand',
      '--no-cache',
      ...args,
    ];
    const result = spawnSync(process.execPath, command, {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, FORCE_COLOR: '0' },
    });
    if (process.env.CAWS_RELEASE_ARTIFACT_DIR) {
      fs.mkdirSync(process.env.CAWS_RELEASE_ARTIFACT_DIR, { recursive: true });
      fs.writeFileSync(
        path.join(
          process.env.CAWS_RELEASE_ARTIFACT_DIR,
          path.basename(root) + '-' + label + '.json'
        ),
        JSON.stringify(
          {
            command: [process.execPath, ...command],
            cwd: root,
            status: result.status,
            signal: result.signal,
            stdout: result.stdout,
            stderr: result.stderr,
            configuration: config,
          },
          null,
          2
        )
      );
    }
    return result;
  };
  const save = () => fs.writeFileSync(configPath, JSON.stringify(config));
  save();
  const listed = run(['--listTests', '--json'], 'selection');
  expect(listed.error).toBeUndefined();
  expect(listed.status).toBe(0);
  expect(JSON.parse(listed.stdout).sort()).toEqual(
    [
      path.join(root, 'tests/visible.test.js'),
      path.join(root, 'tests/kernel/visible.test.ts'),
    ].sort()
  );
  const good = run([], 'ignored-report');
  expect(good.error).toBeUndefined();
  expect(good.status).toBe(0);
  expect(good.stderr).not.toMatch(/Haste module naming collision/i);
  expect(good.stderr).toMatch(/2 passed/);

  put('src/authored/index.js', 'module.exports = 18;\n');
  const badSource = run([], 'authored-fault');
  expect(badSource.error).toBeUndefined();
  expect(badSource.status).toBe(1);
  expect(badSource.stderr).toMatch(/Expected: 17/);
  put('src/authored/index.js', 'module.exports = 17;\n');

  // Removing this boundary must make the duplicate observable to the crawler.
  config.projects.forEach((project) => {
    project.modulePathIgnorePatterns = [];
  });
  save();
  const colliding = run([], 'removed-boundary');
  expect(colliding.error).toBeUndefined();
  expect(colliding.stdout + colliding.stderr).toMatch(/Haste module naming collision/i);
  expect(colliding.stderr).toContain('several different files');
  expect(colliding.status).not.toBe(0);
}, 60000);
