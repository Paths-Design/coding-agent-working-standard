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
  const workflow = yaml.load(fs.readFileSync(path.join(repoRoot, '.github/workflows/pr-checks.yml'), 'utf8'));
  const step = workflow.jobs.sanity.steps.find((entry) => entry.name === 'Security audit');
  expect(typeof step.run).toBe('string');
  const root = fixture();
  fs.writeFileSync(path.join(root, 'npm'), `#!/bin/sh\necho 'fixture registry audit verdict' >&2\nexit ${status}\n`, { mode: 0o755 });
  const result = spawnSync('/bin/bash', ['-e', '-c', step.run], {
    cwd: repoRoot,
    env: { ...process.env, PATH: `${root}${path.delimiter}${process.env.PATH}` },
    encoding: 'utf8',
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(status);
});

test('release qualification requires the same dependency audit as PR CI', () => {
  const workflow = yaml.load(fs.readFileSync(path.join(repoRoot, '.github/workflows/release-qualification.yml'), 'utf8'));
  expect(workflow.jobs.tests.steps.some((step) => step.run === 'npm run audit:dependencies' && !step.if && !step['continue-on-error'])).toBe(true);
});

test('the effective coverage config includes unexecuted runtime files and enforces a real failing verdict', () => {
  const actual = require('../../jest.config');
  const root = fixture();
  fs.mkdirSync(path.join(root, 'dist/store'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tests/helpers'), { recursive: true });
  fs.writeFileSync(path.join(root, 'dist/store/probe.js'), 'exports.value = () => 7;\n');
  fs.writeFileSync(path.join(root, 'dist/store/unexecuted.js'), Array.from({ length: 12 }, (_, n) => `exports.f${n} = () => ${n};`).join('\n'));
  fs.writeFileSync(path.join(root, 'tests/helpers/helper.js'), 'exports.value = () => 9;\n');
  const testFile = path.join(root, 'tests/probe.test.js');
  fs.writeFileSync(testFile, "test('observed values', () => { expect(require('../dist/store/probe').value()).toBe(7); expect(require('./helpers/helper').value()).toBe(9); });\n");
  const config = {
    ...actual,
    rootDir: root,
    projects: actual.projects.filter((project) => project.displayName === 'caws-cli').map((project) => ({ ...project, rootDir: root })),
    // The tiny fixture checks the actual global floor. Production path floors
    // have no corresponding source tree here and are checked by the full run.
    coverageThreshold: actual.coverageThreshold && { global: actual.coverageThreshold.global },
    coverageReporters: ['json'],
    coverageDirectory: path.join(root, 'coverage'),
  };
  fs.writeFileSync(path.join(root, 'jest.config.json'), JSON.stringify(config));
  const run = () => spawnSync(process.execPath, [require.resolve('jest/bin/jest'), '--config', path.join(root, 'jest.config.json'), '--runInBand', '--coverage'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '0' },
  });
  const deficient = run();
  expect(deficient.error).toBeUndefined();
  expect(deficient.status).toBe(1);
  expect(deficient.stderr).toMatch(/coverage.*threshold/i);
  const report = JSON.parse(fs.readFileSync(path.join(root, 'coverage/coverage-final.json'), 'utf8'));
  expect(Object.keys(report).sort()).toEqual([
    path.join(root, 'dist/store/probe.js'), path.join(root, 'dist/store/unexecuted.js'),
  ]);
  expect(Object.values(report[path.join(root, 'dist/store/unexecuted.js')].f)).toEqual(Array(12).fill(0));
  fs.appendFileSync(testFile, "test('all values', () => { const api = require('../dist/store/unexecuted'); for (let n = 0; n < 12; n++) expect(api['f' + n]()).toBe(n); });\n");
  const covered = run();
  expect(covered.error).toBeUndefined();
  expect(covered.status).toBe(0);
}, 60000);
