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

function writeRegistry(cawsDir, entries) {
  fs.writeFileSync(path.join(cawsDir, 'worktrees.json'), JSON.stringify(entries, null, 2) + '\n');
}

function runCli(root, args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, CAWS_QUIET: '1' },
  });
}

describe('worktree group-level --prune handoff', () => {
  test('worktree --prune routes to the same dry-run plan as worktree prune', () => {
    const { root, cawsDir } = mkRepo();
    writeRegistry(cawsDir, {
      'wt-ghost': { branch: 'wt-ghost', baseBranch: 'main' },
    });

    const group = runCli(root, [
      'worktree',
      '--prune',
      '--status',
      'ghost-registry',
      '--json',
    ]);
    const leaf = runCli(root, [
      'worktree',
      'prune',
      '--status',
      'ghost-registry',
      '--json',
    ]);

    expect(group.status).toBe(0);
    expect(leaf.status).toBe(0);
    expect(JSON.parse(group.stdout)).toEqual(JSON.parse(leaf.stdout));
    expect(JSON.parse(group.stdout).read_only).toBe(true);
  });

  test('worktree --prune refuses state/status ambiguity before planning', () => {
    const { root } = mkRepo();

    const result = runCli(root, [
      'worktree',
      '--prune',
      '--state',
      'ghost-registry',
      '--status',
      'dead-binding',
      '--json',
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('use either --state or --status, not both');
    expect(result.stdout).toBe('');
  });

  test('worktree help surfaces --prune as a compatibility handoff', () => {
    const { root } = mkRepo();

    const result = runCli(root, ['worktree', '--help']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--prune');
    expect(result.stdout.replace(/\s+/g, ' ')).toContain(
      'normalized to `caws worktree prune ...` before parsing'
    );
  });
});
