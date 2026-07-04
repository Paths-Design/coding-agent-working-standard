'use strict';

const fs = require('fs');
const path = require('path');

const { initProject } = require('../../dist/store/init-store');
const { runWorktreeDestroyCommand } = require('../../dist/shell/commands/worktree');
const { cleanupAll, makeTempRepo } = require('../helpers/git-repo-factory');

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

function readBytes(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

function snapshot(cawsDir) {
  return {
    registry: readBytes(path.join(cawsDir, 'worktrees.json')),
    events: readBytes(path.join(cawsDir, 'events.jsonl')),
    specs: fs.readdirSync(path.join(cawsDir, 'specs')).sort().map((name) => [
      name,
      readBytes(path.join(cawsDir, 'specs', name)),
    ]),
    worktreeNames: fs.existsSync(path.join(cawsDir, 'worktrees'))
      ? fs.readdirSync(path.join(cawsDir, 'worktrees')).sort()
      : [],
  };
}

function runDestroy(root, name) {
  const out = [];
  const err = [];
  const code = runWorktreeDestroyCommand({
    cwd: root,
    name,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    now: () => new Date('2026-07-04T12:00:00.000Z'),
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('caws worktree destroy missing registry handoff', () => {
  test('refuses missing registry entries with cleanup guidance and no mutation', () => {
    const { root, cawsDir } = mkRepo();
    const before = snapshot(cawsDir);

    const result = runDestroy(root, 'missing-worktree');

    expect(result.code).toBe(1);
    expect(result.out).toBe('');
    expect(result.err).toContain('Worktree "missing-worktree" not found in registry.');
    expect(result.err).toContain('repair:');
    expect(result.err).toContain('caws worktree list');
    expect(result.err).toContain('caws worktree prune --include missing-worktree');
    expect(result.err).toContain('caws worktree cleanup-plan --include missing-worktree');
    expect(snapshot(cawsDir)).toEqual(before);
  });
});
