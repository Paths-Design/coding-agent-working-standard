'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { initProject } = require('../../dist/store/init-store');
const { cleanupAll, makeTempRepo } = require('../helpers/git-repo-factory');

const CLI = path.resolve(__dirname, '..', '..', 'dist', 'index.js');

afterAll(() => {
  cleanupAll();
});

function mkRepo() {
  const root = makeTempRepo();
  const initialized = initProject(root);
  if (!initialized.ok) {
    throw new Error('initProject failed: ' + JSON.stringify(initialized.errors));
  }
  return { root, cawsDir: path.join(root, '.caws') };
}

function runCli(root, args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, CAWS_QUIET: '1' },
  });
}

function writeMapping(root, filename, body) {
  const filePath = path.join(root, filename);
  fs.writeFileSync(filePath, body);
  return filePath;
}

function expectNoMigrationMutation(cawsDir) {
  expect(fs.existsSync(path.join(cawsDir, 'events.jsonl'))).toBe(false);
  expect(fs.existsSync(path.join(cawsDir, 'leases'))).toBe(false);
  expect(fs.existsSync(path.join(cawsDir, 'migrations'))).toBe(false);
}

function expectMappingGuidance(output) {
  expect(output).toContain('Expected --lifecycle-mapping JSON shape:');
  expect(output).toContain('"<spec-id>": {');
  expect(output).toContain('"lifecycle_state": "active|draft|closed|archived"');
  expect(output).toContain('"resolution": "implemented"');
  expect(output).toContain('Example mapping file:');
  expect(output).toContain('"FEAT-123": {');
  expect(output).toContain('"lifecycle_state": "closed"');
  expect(output).toContain(
    'caws specs migrate --from v10 --lifecycle-mapping lifecycle-map.json'
  );
}

describe('caws specs migrate --lifecycle-mapping guidance', () => {
  test('malformed mapping JSON prints expected schema and example without mutating', () => {
    const { root, cawsDir } = mkRepo();
    const mappingPath = writeMapping(root, 'lifecycle-map.json', '{bad json');

    const result = runCli(root, [
      'specs',
      'migrate',
      '--from',
      'v10',
      '--lifecycle-mapping',
      mappingPath,
    ]);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(
      'caws specs migrate: failed to load --lifecycle-mapping file.'
    );
    expect(result.stderr).toContain(`Cannot parse ${mappingPath} as JSON`);
    expectMappingGuidance(result.stderr);
    expect(result.stderr).not.toContain('{bad json');
    expectNoMigrationMutation(cawsDir);
  });

  test.each([
    ['root array', '[{"lifecycle_state":"closed"}]', 'must be a JSON object keyed by spec id'],
    ['entry scalar', '{"FEAT-1":"closed"}', 'Lifecycle mapping entry "FEAT-1" is not an object'],
    [
      'missing lifecycle_state',
      '{"FEAT-1":{"resolution":"implemented"}}',
      'Lifecycle mapping entry "FEAT-1" is missing required string field "lifecycle_state"',
    ],
  ])('invalid mapping shape (%s) prints the same schema guidance', (_label, body, reason) => {
    const { root, cawsDir } = mkRepo();
    const mappingPath = writeMapping(root, 'lifecycle-map.json', body);

    const result = runCli(root, [
      'specs',
      'migrate',
      '--from',
      'v10',
      '--lifecycle-mapping',
      mappingPath,
    ]);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(reason);
    expectMappingGuidance(result.stderr);
    expect(result.stderr).not.toContain(body);
    expectNoMigrationMutation(cawsDir);
  });
});
