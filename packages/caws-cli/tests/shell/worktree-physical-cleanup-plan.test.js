'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { runWorktreePhysicalCleanupPlanCommand } = require('../../dist/shell/commands/worktree');
const { initProject } = require('../../dist/store/init-store');

const repos = [];

afterAll(() => {
  for (const r of repos) {
    try {
      execFileSync('git', ['-C', r, 'worktree', 'prune'], { stdio: 'ignore' });
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(r, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function mkRepo(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync('git', ['init', '--quiet', '-b', 'main', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 't@test.com']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
  execFileSync('git', ['-C', root, 'commit', '--quiet', '--allow-empty', '-m', 'init']);
  repos.push(root);
  return root;
}

function setupCaws(repoRoot) {
  const r = initProject(repoRoot);
  if (!r.ok) throw new Error('initProject failed: ' + JSON.stringify(r.errors));
  return path.join(repoRoot, '.caws');
}

function createPhysicalWorktree(repoRoot, cawsDir, name) {
  const wtPath = path.join(cawsDir, 'worktrees', name);
  fs.mkdirSync(path.dirname(wtPath), { recursive: true });
  execFileSync('git', ['-C', repoRoot, 'worktree', 'add', '--quiet', '-b', name, wtPath, 'main']);
  return wtPath;
}

function writeSpec(cawsDir, id, { state = 'active', worktree } = {}) {
  const wtLine = worktree !== undefined ? `worktree: ${worktree}\n` : '';
  const resolutionLine =
    state === 'closed' || state === 'archived' ? `resolution: completed\n` : '';
  const body = `id: ${id}
title: 'Physical cleanup fixture spec'
risk_tier: 3
mode: chore
lifecycle_state: ${state}
${resolutionLine}${wtLine}created_at: '2026-07-04T00:00:00.000Z'
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

function readBytes(p) {
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

function statusFor(p) {
  if (!fs.existsSync(p)) return null;
  return execFileSync('git', ['-C', p, 'status', '--porcelain'], { encoding: 'utf8' });
}

function snapshotState(cawsDir, specIds, worktreePaths) {
  const specs = {};
  for (const id of specIds) specs[id] = readBytes(path.join(cawsDir, 'specs', `${id}.yaml`));
  const worktrees = {};
  for (const [name, wtPath] of Object.entries(worktreePaths)) {
    worktrees[name] = {
      exists: fs.existsSync(wtPath),
      status: statusFor(wtPath),
    };
  }
  return {
    registry: readBytes(path.join(cawsDir, 'worktrees.json')),
    events: readBytes(path.join(cawsDir, 'events.jsonl')),
    specs,
    worktrees,
  };
}

function expectUnchanged(before, after) {
  expect(after.registry).toBe(before.registry);
  expect(after.events).toBe(before.events);
  expect(after.specs).toEqual(before.specs);
  expect(after.worktrees).toEqual(before.worktrees);
}

function runCleanupPlan(repoRoot, opts = {}) {
  const out = [];
  const err = [];
  const code = runWorktreePhysicalCleanupPlanCommand({
    cwd: repoRoot,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    now: () => new Date('2026-07-04T12:00:00.000Z'),
    ...opts,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

function cleanupFixture() {
  const repoRoot = mkRepo('caws-wt-physical-plan-');
  const caws = setupCaws(repoRoot);
  const paths = {
    ready: createPhysicalWorktree(repoRoot, caws, 'wt-ready'),
    dirty: createPhysicalWorktree(repoRoot, caws, 'wt-dirty'),
    unmerged: createPhysicalWorktree(repoRoot, caws, 'wt-unmerged'),
    active: createPhysicalWorktree(repoRoot, caws, 'wt-active'),
    foreign: createPhysicalWorktree(repoRoot, caws, 'wt-foreign'),
    unregistered: createPhysicalWorktree(repoRoot, caws, 'wt-unregistered'),
  };

  fs.writeFileSync(path.join(paths.dirty, 'dirty.txt'), 'dirty\n');
  fs.writeFileSync(path.join(paths.unmerged, 'branch-only.txt'), 'branch only\n');
  execFileSync('git', ['-C', paths.unmerged, 'add', 'branch-only.txt']);
  execFileSync('git', ['-C', paths.unmerged, 'commit', '--quiet', '-m', 'branch only']);

  writeSpec(caws, 'READY-001', { state: 'closed', worktree: 'wt-ready' });
  writeSpec(caws, 'DIRTY-001', { state: 'closed', worktree: 'wt-dirty' });
  writeSpec(caws, 'UNMERGED-001', { state: 'closed', worktree: 'wt-unmerged' });
  writeSpec(caws, 'ACTIVE-001', { state: 'active', worktree: 'wt-active' });
  writeSpec(caws, 'FOREIGN-001', { state: 'closed', worktree: 'wt-foreign' });

  writeRegistry(caws, {
    'wt-ready': {
      specId: 'READY-001',
      branch: 'wt-ready',
      baseBranch: 'main',
      path: paths.ready,
    },
    'wt-dirty': {
      specId: 'DIRTY-001',
      branch: 'wt-dirty',
      baseBranch: 'main',
      path: paths.dirty,
    },
    'wt-unmerged': {
      specId: 'UNMERGED-001',
      branch: 'wt-unmerged',
      baseBranch: 'main',
      path: paths.unmerged,
    },
    'wt-active': {
      specId: 'ACTIVE-001',
      branch: 'wt-active',
      baseBranch: 'main',
      path: paths.active,
    },
    'wt-foreign': {
      specId: 'FOREIGN-001',
      branch: 'wt-foreign',
      baseBranch: 'main',
      path: paths.foreign,
      owner: { session_id: 'foreign-session', platform: 'test' },
    },
  });
  return { repoRoot, caws, paths };
}

describe('caws worktree cleanup-plan', () => {
  test('classifies physical cleanup states without mutating files or CAWS state', () => {
    const { repoRoot, caws, paths } = cleanupFixture();
    const before = snapshotState(
      caws,
      ['READY-001', 'DIRTY-001', 'UNMERGED-001', 'ACTIVE-001', 'FOREIGN-001'],
      paths
    );

    const result = runCleanupPlan(repoRoot, { json: true });

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.out);
    expect(payload.read_only).toBe(true);
    expect(payload.dry_run).toBe(true);
    const statesBySubject = Object.fromEntries(
      payload.candidates.map((item) => [item.subject, item.state_class])
    );
    expect(statesBySubject['wt-ready']).toBe('destroy-ready');
    expect(statesBySubject['wt-dirty']).toBe('dirty-refused');
    expect(statesBySubject['wt-unmerged']).toBe('unmerged-refused');
    expect(statesBySubject['wt-active']).toBe('active-bound-refused');
    expect(statesBySubject['wt-foreign']).toBe('foreign-owned-refused');
    expect(statesBySubject['wt-unregistered']).toBe('unregistered-physical-refused');
    expect(payload.candidates.find((item) => item.subject === 'wt-ready').next_command).toBe(
      'caws worktree destroy wt-ready'
    );
    expectUnchanged(
      before,
      snapshotState(caws, ['READY-001', 'DIRTY-001', 'UNMERGED-001', 'ACTIVE-001', 'FOREIGN-001'], paths)
    );
  });

  test('honors state/include/exclude filters', () => {
    const { repoRoot } = cleanupFixture();

    const result = runCleanupPlan(repoRoot, {
      state: ['destroy-ready', 'dirty-refused'],
      include: ['wt-ready', 'wt-dirty'],
      exclude: ['wt-dirty'],
      json: true,
    });

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.out);
    expect(payload.candidates.map((item) => item.subject)).toEqual(['wt-ready']);
    expect(payload.counts_by_state).toEqual({ 'destroy-ready': 1 });
  });

  test('unknown state filters refuse before planning', () => {
    const { repoRoot } = cleanupFixture();

    const result = runCleanupPlan(repoRoot, { state: ['not-a-state'] });

    expect(result.code).toBe(1);
    expect(result.err).toContain('unknown --state value(s): not-a-state');
  });

  test('human output distinguishes cleanup-plan from prune/apply behavior', () => {
    const { repoRoot } = cleanupFixture();

    const result = runCleanupPlan(repoRoot, { state: ['unregistered-physical-refused'] });

    expect(result.code).toBe(0);
    expect(result.out).toContain('caws worktree cleanup-plan: read-only physical cleanup plan');
    expect(result.out).toContain('unregistered-physical-refused wt-unregistered');
    expect(result.out).toContain('allowed: refused');
  });

  test('apply refuses without an explicit selector before mutating', () => {
    const { repoRoot, caws, paths } = cleanupFixture();
    const before = snapshotState(
      caws,
      ['READY-001', 'DIRTY-001', 'UNMERGED-001', 'ACTIVE-001', 'FOREIGN-001'],
      paths
    );

    const result = runCleanupPlan(repoRoot, { apply: true, json: true });

    expect(result.code).toBe(1);
    expect(result.err).toContain('Add at least one explicit selector');
    expect(result.out).toBe('');
    expectUnchanged(
      before,
      snapshotState(caws, ['READY-001', 'DIRTY-001', 'UNMERGED-001', 'ACTIVE-001', 'FOREIGN-001'], paths)
    );
  });

  test('apply destroys only selected destroy-ready candidates through guarded destroy path', () => {
    const { repoRoot, caws, paths } = cleanupFixture();

    const result = runCleanupPlan(repoRoot, {
      include: ['wt-ready', 'wt-dirty'],
      apply: true,
      json: true,
    });

    expect(result.code).toBe(1);
    const payload = JSON.parse(result.out);
    expect(payload.read_only).toBe(false);
    expect(payload.dry_run).toBe(false);
    expect(payload.counts).toEqual({ applied: 1, refused: 1, failed: 0 });
    expect(payload.outcomes.map((item) => [item.subject, item.action])).toEqual([
      ['wt-ready', 'applied'],
      ['wt-dirty', 'refused'],
    ]);
    expect(payload.outcomes[0].mutation).toContain('destroyWorktree');
    expect(fs.existsSync(paths.ready)).toBe(false);
    expect(fs.existsSync(paths.dirty)).toBe(true);

    const registry = JSON.parse(readBytes(path.join(caws, 'worktrees.json')));
    expect(registry['wt-ready']).toBeUndefined();
    expect(registry['wt-dirty']).toBeDefined();
    expect(readBytes(path.join(caws, 'specs', 'READY-001.yaml'))).not.toMatch(/worktree: wt-ready/);
    expect(readBytes(path.join(caws, 'specs', 'DIRTY-001.yaml'))).toMatch(/worktree: wt-dirty/);
  });

  test('apply with state destroy-ready can delete all currently ready candidates', () => {
    const { repoRoot, caws, paths } = cleanupFixture();

    const result = runCleanupPlan(repoRoot, {
      state: ['destroy-ready'],
      apply: true,
      json: true,
    });

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.out);
    expect(payload.counts).toEqual({ applied: 1, refused: 0, failed: 0 });
    expect(payload.outcomes[0].subject).toBe('wt-ready');
    expect(fs.existsSync(paths.ready)).toBe(false);
    const registry = JSON.parse(readBytes(path.join(caws, 'worktrees.json')));
    expect(registry['wt-ready']).toBeUndefined();
  });
});
