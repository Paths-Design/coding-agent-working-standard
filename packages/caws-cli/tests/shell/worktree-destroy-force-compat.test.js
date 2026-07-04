'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { initProject } = require('../../dist/store/init-store');
const { runWorktreeDestroyCommand } = require('../../dist/shell/commands/worktree');
const { cleanupAll, git, makeTempRepo } = require('../helpers/git-repo-factory');

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

function writeSpec(cawsDir, id, worktree) {
  const body = `id: ${id}
title: 'Destroy force fixture spec'
risk_tier: 3
mode: chore
lifecycle_state: closed
resolution: completed
worktree: ${worktree}
created_at: '2026-07-04T00:00:00.000Z'
updated_at: '2026-07-04T00:00:00.000Z'
blast_radius:
  modules:
    - tests
  data_migration: false
operational_rollback_slo: 5m
scope:
  in:
    - tests
  out: []
invariants:
  - 'fixture spec'
acceptance:
  - id: A1
    given: 'fixture'
    when: 'fixture'
    then: 'fixture'
non_functional: {}
contracts: []
`;
  fs.writeFileSync(path.join(cawsDir, 'specs', `${id}.yaml`), body);
}

function writeRegistry(cawsDir, entries) {
  fs.writeFileSync(path.join(cawsDir, 'worktrees.json'), JSON.stringify(entries, null, 2) + '\n');
}

function createUnmergedFixture() {
  const { root, cawsDir } = mkRepo();
  const name = 'wt-unmerged';
  const specId = 'FORCE-COMPAT-001';
  const wtPath = path.join(cawsDir, 'worktrees', name);

  fs.mkdirSync(path.dirname(wtPath), { recursive: true });
  git(root, ['worktree', 'add', '--quiet', '-b', name, wtPath, 'main']);
  fs.writeFileSync(path.join(wtPath, 'branch-only.txt'), 'branch only\n');
  git(wtPath, ['add', 'branch-only.txt']);
  git(wtPath, ['commit', '--quiet', '-m', 'branch only']);

  writeSpec(cawsDir, specId, name);
  writeRegistry(cawsDir, {
    [name]: {
      specId,
      branch: name,
      baseBranch: 'main',
      path: wtPath,
    },
  });

  return { root, cawsDir, name, specId, wtPath };
}

function runDestroy(root, name, opts = {}) {
  const out = [];
  const err = [];
  const code = runWorktreeDestroyCommand({
    cwd: root,
    name,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    now: () => new Date('2026-07-04T12:00:00.000Z'),
    ...opts,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

function runCli(root, args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, CAWS_QUIET: '1' },
  });
}

describe('caws worktree destroy --force compatibility alias', () => {
  test('accepts --force and keeps the missing-registry handoff non-mutating', () => {
    const { root, cawsDir } = mkRepo();
    const before = snapshot(cawsDir);

    const result = runCli(root, ['worktree', 'destroy', 'missing-worktree', '--force']);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Worktree "missing-worktree" not found in registry.');
    expect(result.stderr).toContain('caws worktree list');
    expect(result.stderr).toContain('caws worktree prune --include missing-worktree');
    expect(result.stderr).toContain('caws worktree cleanup-plan --include missing-worktree');
    expect(result.stderr).not.toContain('unknown option');
    expect(snapshot(cawsDir)).toEqual(before);
  });

  test('maps force to the same unmerged-branch override as abandonUnmerged', () => {
    const { root, cawsDir, name, specId, wtPath } = createUnmergedFixture();
    const before = snapshot(cawsDir);

    const refused = runDestroy(root, name);

    expect(refused.code).toBe(1);
    expect(refused.err).toContain(`Branch "${name}" is not merged into "main".`);
    expect(refused.err).toContain('Pass --abandon-unmerged to destroy anyway.');
    expect(snapshot(cawsDir)).toEqual(before);
    expect(fs.existsSync(wtPath)).toBe(true);

    const forced = runDestroy(root, name, { force: true });

    expect(forced.code).toBe(0);
    expect(forced.out).toContain(`destroyed ${name}`);
    expect(fs.existsSync(wtPath)).toBe(false);
    const registry = JSON.parse(readBytes(path.join(cawsDir, 'worktrees.json')));
    expect(registry[name]).toBeUndefined();
    expect(readBytes(path.join(cawsDir, 'specs', `${specId}.yaml`))).not.toMatch(
      /^worktree:/m
    );
  });

  test('nested help lists force with narrowed compatibility semantics', () => {
    const { root } = mkRepo();

    const result = runCli(root, ['worktree', 'destroy', '--help']);
    const help = result.stdout.replace(/\s+/g, ' ');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--abandon-unmerged');
    expect(result.stdout).toContain('--force');
    expect(help).toContain('Compatibility alias for --abandon-unmerged only');
    expect(help).toContain('still respects ownership, clean checkout, and registry guardrails');
  });
});
