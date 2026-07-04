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

describe('worktree cleanup --status aliases', () => {
  test('worktree prune --status filters the same state classes as --state', () => {
    const { root, cawsDir } = mkRepo();
    writeRegistry(cawsDir, {
      'wt-ghost': { branch: 'wt-ghost', baseBranch: 'main' },
    });

    const result = runCli(root, ['worktree', 'prune', '--status', 'ghost-registry', '--json']);

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.read_only).toBe(true);
    expect(payload.candidates).toHaveLength(1);
    expect(payload.candidates[0].subject).toBe('wt-ghost');
    expect(payload.candidates[0].state_class).toBe('ghost-registry');
  });

  test('worktree cleanup-plan --status is accepted as a state-class filter', () => {
    const { root } = mkRepo();

    const result = runCli(root, ['worktree', 'cleanup-plan', '--status', 'destroy-ready', '--json']);

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.read_only).toBe(true);
    expect(payload.filters.state).toEqual(['destroy-ready']);
  });

  test('worktree cleanup commands refuse both --state and --status before planning', () => {
    const { root } = mkRepo();

    const prune = runCli(root, [
      'worktree',
      'prune',
      '--state',
      'ghost-registry',
      '--status',
      'dead-binding',
      '--json',
    ]);
    const cleanup = runCli(root, [
      'worktree',
      'cleanup-plan',
      '--state',
      'destroy-ready',
      '--status',
      'dirty-refused',
      '--json',
    ]);

    expect(prune.status).toBe(1);
    expect(prune.stderr).toContain('use either --state or --status, not both');
    expect(prune.stdout).toBe('');
    expect(cleanup.status).toBe(1);
    expect(cleanup.stderr).toContain('use either --state or --status, not both');
    expect(cleanup.stdout).toBe('');
  });

  test('nested help lists --status next to --state for both cleanup leaves', () => {
    const { root } = mkRepo();

    const prune = runCli(root, ['worktree', 'prune', '--help']);
    const cleanup = runCli(root, ['worktree', 'cleanup-plan', '--help']);

    expect(prune.status).toBe(0);
    expect(prune.stdout).toContain('--state <classes>');
    expect(prune.stdout).toContain('--status <classes>');
    expect(prune.stdout).toContain('Alias for --state <classes>');
    expect(cleanup.status).toBe(0);
    expect(cleanup.stdout).toContain('--state <classes>');
    expect(cleanup.stdout).toContain('--status <classes>');
    expect(cleanup.stdout).toContain('Alias for --state <classes>');
  });
});
