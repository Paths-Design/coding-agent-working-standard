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

describe('caws specs prune-archive handoff', () => {
  test('runtime no-op preserves archive bodies and prints replacement commands', () => {
    const { root, cawsDir } = mkRepo();
    const archivePath = path.join(cawsDir, 'specs', '.archive', 'ARCHIVED-001.yaml');
    fs.mkdirSync(path.dirname(archivePath), { recursive: true });
    fs.writeFileSync(archivePath, 'canonical archive body\n');

    for (const args of [
      ['specs', 'prune-archive'],
      ['specs', 'prune-archive', '--apply'],
    ]) {
      const result = runCli(root, args);

      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain('no-op');
      expect(result.stdout).toContain('caws specs archive --status closed');
      expect(result.stdout).toContain('caws specs restore <id> --as draft');
      expect(result.stdout).toContain('caws specs recover <id> --out <path>');
      expect(fs.readFileSync(archivePath, 'utf8')).toBe('canonical archive body\n');
    }
  });

  test('nested help describes archive, restore, and recover handoffs', () => {
    const { root } = mkRepo();

    const result = runCli(root, ['specs', 'prune-archive', '--help']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Compatibility no-op');
    expect(result.stdout).toMatch(/caws\s+specs\s+archive\s+--status\s+closed/);
    expect(result.stdout).toMatch(/caws\s+specs\s+restore/);
    expect(result.stdout).toMatch(/caws\s+specs\s+recover/);
    expect(result.stdout).toContain('--apply');
  });
});
