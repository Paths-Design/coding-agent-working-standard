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

function expectNoMutableEvidenceState(cawsDir) {
  expect(fs.existsSync(path.join(cawsDir, 'events.jsonl'))).toBe(false);
  expect(fs.existsSync(path.join(cawsDir, 'leases'))).toBe(false);
}

describe('caws evidence record --data parse guidance', () => {
  test.each([
    [
      'test',
      '{"command":"npm test","exit_code":0}',
      'caws evidence record --type test --spec FEAT-1 --data \'{"command":"npm test","exit_code":0}\'',
    ],
    [
      'gate',
      '{"gate_id":"budget_limit","mode":"block","result":"pass","violations":[]}',
      'caws evidence record --type gate --spec FEAT-1 --data \'{"gate_id":"budget_limit","mode":"block","result":"pass","violations":[]}\'',
    ],
    [
      'ac',
      '{"criterion_id":"A1","status":"pass","evidence_ref":"npm test"}',
      'caws evidence record --type ac --spec FEAT-1 --data \'{"criterion_id":"A1","status":"pass","evidence_ref":"npm test"}\'',
    ],
  ])(
    'malformed %s payload shows schema and valid copy-pasteable example',
    (kind, dataFragment, exampleCommand) => {
      const { root, cawsDir } = mkRepo();

      const result = runCli(root, [
        'evidence',
        'record',
        '--type',
        kind,
        '--spec',
        'FEAT-1',
        '--data',
        '{command:"npm test"}',
      ]);

      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('caws evidence record: invalid --data JSON');
      expect(result.stderr).toContain(`Run: caws evidence schema --type ${kind}`);
      expect(result.stderr).toContain(dataFragment);
      expect(result.stderr).toContain(exampleCommand);
      expect(result.stderr).toContain(
        'Tip: wrap JSON in single quotes so the shell preserves double quotes.'
      );
      expectNoMutableEvidenceState(cawsDir);
    }
  );

  test('malformed data with unknown type still points to schema discovery before mutation', () => {
    const { root, cawsDir } = mkRepo();

    const result = runCli(root, [
      'evidence',
      'record',
      '--type',
      'artifact',
      '--spec',
      'FEAT-1',
      '--data',
      '{command:"npm test"}',
    ]);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('caws evidence record: invalid --data JSON');
    expect(result.stderr).toContain('Run: caws evidence schema --type <test|gate|ac>');
    expect(result.stderr).toContain(
      'Tip: wrap JSON in single quotes so the shell preserves double quotes.'
    );
    expectNoMutableEvidenceState(cawsDir);
  });
});
