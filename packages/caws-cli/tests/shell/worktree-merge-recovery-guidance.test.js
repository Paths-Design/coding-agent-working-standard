'use strict';

const fs = require('fs');
const path = require('path');

const { initProject } = require('../../dist/store/init-store');
const { runWorktreeMergeCommand } = require('../../dist/shell/commands/worktree');
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

function writeRegistry(cawsDir, entries) {
  fs.writeFileSync(path.join(cawsDir, 'worktrees.json'), JSON.stringify(entries, null, 2) + '\n');
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
  };
}

function setupNotReadyRepo() {
  const { root, cawsDir } = mkRepo();
  writeRegistry(cawsDir, {
    'wt-unready': {
      branch: 'feature/wt-unready',
      baseBranch: 'main',
      path: path.join(cawsDir, 'worktrees', 'wt-unready'),
    },
  });
  return { root, cawsDir };
}

function runMerge(root, opts = {}) {
  const out = [];
  const err = [];
  const code = runWorktreeMergeCommand({
    cwd: root,
    name: 'wt-unready',
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    now: () => new Date('2026-07-04T12:00:00.000Z'),
    ...opts,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

function parseJsonFrom(text) {
  const start = text.indexOf('{');
  if (start < 0) throw new Error(`no JSON object in: ${text}`);
  return JSON.parse(text.slice(start));
}

describe('caws worktree merge recovery guidance', () => {
  test('dry-run --data emits a read-only recovery payload for not-ready merges', () => {
    const { root, cawsDir } = setupNotReadyRepo();
    const before = snapshot(cawsDir);

    const result = runMerge(root, { dryRun: true, showData: true });

    expect(result.code).toBe(1);
    expect(result.err).toContain('NOT ready to merge');
    expect(result.err).toContain('no spec_id binding on this worktree');
    const payload = parseJsonFrom(result.err);
    expect(payload).toMatchObject({
      read_only: true,
      dry_run: true,
      can_proceed: false,
      findings: ['no spec_id binding on this worktree'],
      worktree: {
        name: 'wt-unready',
        branch: 'feature/wt-unready',
        base_branch: 'main',
      },
    });
    expect(payload.next_commands).toEqual(expect.arrayContaining([
      'caws worktree merge wt-unready --dry-run --data',
      'caws worktree list --data',
      'caws worktree cleanup-plan --include wt-unready --json',
      'git rev-list --left-right --count main...feature/wt-unready',
      'git merge-tree --write-tree main feature/wt-unready',
    ]));
    expect(snapshot(cawsDir)).toEqual(before);
  });

  test('non-dry-run prerequisite refusal includes repair guidance and no mutation', () => {
    const { root, cawsDir } = setupNotReadyRepo();
    const before = snapshot(cawsDir);

    const result = runMerge(root);

    expect(result.code).toBe(1);
    expect(result.err).toContain('prerequisites unmet');
    expect(result.err).toContain('repair:');
    expect(result.err).toContain('caws worktree merge wt-unready --dry-run --data');
    expect(result.err).toContain('caws worktree list --data');
    expect(result.err).toContain('caws worktree cleanup-plan --include wt-unready --json');
    expect(result.err).toContain('git rev-list --left-right --count main...feature/wt-unready');
    expect(snapshot(cawsDir)).toEqual(before);
  });
});
