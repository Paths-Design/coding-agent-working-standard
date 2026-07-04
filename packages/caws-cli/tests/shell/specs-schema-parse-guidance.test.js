'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { initProject } = require('../../dist/store/init-store');
const { cleanupAll, makeTempRepo } = require('../helpers/git-repo-factory');

const CLI = path.resolve(__dirname, '..', '..', 'dist', 'index.js');
const tempDirs = [];

afterAll(() => {
  cleanupAll();
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function mkRepo() {
  const root = makeTempRepo();
  const initialized = initProject(root);
  if (!initialized.ok) {
    throw new Error('initProject failed: ' + JSON.stringify(initialized.errors));
  }
  return { root, cawsDir: path.join(root, '.caws') };
}

function mkTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-spec-schema-parse-'));
  tempDirs.push(dir);
  return dir;
}

function runCli(cwd, args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, CAWS_QUIET: '1' },
  });
}

function invalidSpecYaml(id) {
  return [
    `id: ${id}`,
    'title: Bad spec',
    'risk_tier: 3',
    'mode: fix',
    'lifecycle_state: active',
    'blast_radius:',
    '  modules:',
    '    - test',
    '  data_migration: false',
    'scope:',
    '  in:',
    '    - README.md',
    '  out: []',
    'invariants: should-be-array',
    'acceptance: []',
    'non_functional: {}',
    'contracts: []',
    '',
  ].join('\n');
}

function expectGuidance(output, validatePath) {
  expect(output).toContain('Expected array');
  expect(output).toContain(`Validate this file: caws specs validate ${validatePath}`);
  expect(output).toContain('Common v11 YAML array shapes:');
  expect(output).toContain('invariants:');
  expect(output).toContain("- 'State the invariant as a quoted string.'");
  expect(output).toContain('acceptance:');
  expect(output).toContain('given:');
  expect(output).toContain('contracts:');
  expect(output).toContain('type: behavior');
}

describe('caws specs schema parse guidance', () => {
  test('specs show points invalid canonical spec at validate and array YAML examples', () => {
    const { root, cawsDir } = mkRepo();
    const specPath = path.join(cawsDir, 'specs', 'BAD-SPEC-001.yaml');
    fs.writeFileSync(specPath, invalidSpecYaml('BAD-SPEC-001'));
    const resolvedSpecPath = fs.realpathSync(specPath);

    const result = runCli(root, ['specs', 'show', 'BAD-SPEC-001']);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('caws specs show: failed.');
    expectGuidance(result.stderr, resolvedSpecPath);
    expect(fs.existsSync(path.join(cawsDir, 'events.jsonl'))).toBe(false);
    expect(fs.existsSync(path.join(cawsDir, 'leases'))).toBe(false);
  });

  test('specs validate gives file-specific guidance without .caws state', () => {
    const root = mkTempDir();
    const specPath = path.join(root, 'bad-spec.yaml');
    fs.writeFileSync(specPath, invalidSpecYaml('BAD-SPEC-002'));

    const result = runCli(root, ['specs', 'validate', specPath]);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(`caws specs validate: ${specPath} is invalid.`);
    expectGuidance(result.stderr, specPath);
    expect(fs.existsSync(path.join(root, '.caws'))).toBe(false);
  });
});
