'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { runWorktreeUntrackCommand } = require('../../dist/shell/commands/worktree');
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

function writeSpec(cawsDir, id, worktree) {
  const wtLine = worktree !== undefined ? `worktree: ${worktree}\n` : '';
  const body = `id: ${id}
title: 'Untrack fixture spec'
risk_tier: 3
mode: chore
lifecycle_state: active
${wtLine}created_at: '2026-07-04T00:00:00.000Z'
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

function readEventsRaw(cawsDir) {
  const p = path.join(cawsDir, 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  const bytes = fs.readFileSync(p, 'utf8').trim();
  if (bytes.length === 0) return [];
  return bytes.split('\n').map((l) => JSON.parse(l));
}

function eventsOfType(cawsDir, type) {
  return readEventsRaw(cawsDir).filter((e) => e.event === type);
}

function snapshotState(cawsDir, specIds, worktreePath) {
  const specs = {};
  for (const id of specIds) specs[id] = readBytes(path.join(cawsDir, 'specs', `${id}.yaml`));
  return {
    registry: readBytes(path.join(cawsDir, 'worktrees.json')),
    events: readBytes(path.join(cawsDir, 'events.jsonl')),
    eventCount: readEventsRaw(cawsDir).length,
    specs,
    worktreeExists: fs.existsSync(worktreePath),
    worktreeStatus: execFileSync('git', ['-C', worktreePath, 'status', '--porcelain'], {
      encoding: 'utf8',
    }),
  };
}

function expectUnchanged(before, after) {
  expect(after.registry).toBe(before.registry);
  expect(after.events).toBe(before.events);
  expect(after.eventCount).toBe(before.eventCount);
  expect(after.specs).toEqual(before.specs);
  expect(after.worktreeExists).toBe(before.worktreeExists);
  expect(after.worktreeStatus).toBe(before.worktreeStatus);
}

function runUntrack(repoRoot, name, opts = {}) {
  const out = [];
  const err = [];
  const code = runWorktreeUntrackCommand({
    cwd: repoRoot,
    name,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    now: () => new Date('2026-07-04T12:00:00.000Z'),
    ...opts,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

function untrackRepo({ owner } = {}) {
  const repoRoot = mkRepo('caws-wt-untrack-');
  const caws = setupCaws(repoRoot);
  const wtPath = createPhysicalWorktree(repoRoot, caws, 'wt-keep');
  writeSpec(caws, 'UNTRACK-001', 'wt-keep');
  writeRegistry(caws, {
    'wt-keep': {
      branch: 'wt-keep',
      baseBranch: 'main',
      specId: 'UNTRACK-001',
      path: wtPath,
      ...(owner !== undefined ? { owner } : {}),
    },
  });
  return { repoRoot, caws, wtPath };
}

describe('caws worktree untrack', () => {
  test('dry-run plans registry/spec release without mutating or deleting files', () => {
    const { repoRoot, caws, wtPath } = untrackRepo();
    const before = snapshotState(caws, ['UNTRACK-001'], wtPath);

    const result = runUntrack(repoRoot, 'wt-keep', { reason: 'preserve for inspection', json: true });

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.out);
    const realWtPath = fs.realpathSync(wtPath);
    expect(payload.dry_run).toBe(true);
    expect(payload.read_only).toBe(true);
    expect(payload.findings).toContain('remove registry entry "wt-keep"');
    expect(payload.findings).toContain('clear worktree: field on spec UNTRACK-001');
    expect(payload.findings).toContain(`preserve physical directory ${realWtPath}`);
    expectUnchanged(before, snapshotState(caws, ['UNTRACK-001'], wtPath));
  });

  test('apply removes only control-plane binding and records worktree_untracked', () => {
    const { repoRoot, caws, wtPath } = untrackRepo();

    const result = runUntrack(repoRoot, 'wt-keep', {
      reason: 'preserve for inspection',
      apply: true,
      json: true,
    });

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.out);
    const realWtPath = fs.realpathSync(wtPath);
    expect(payload.dry_run).toBe(false);
    expect(payload.action).toBe('untracked');
    expect(payload.data.preserved_physical_directory).toBe(true);
    expect(payload.data.cleared_spec_binding).toBe(true);
    expect(fs.existsSync(wtPath)).toBe(true);

    const registry = JSON.parse(readBytes(path.join(caws, 'worktrees.json')));
    expect(registry['wt-keep']).toBeUndefined();
    expect(readBytes(path.join(caws, 'specs', 'UNTRACK-001.yaml'))).not.toMatch(/worktree: wt-keep/);
    const events = eventsOfType(caws, 'worktree_untracked');
    expect(events).toHaveLength(1);
    expect(events[0].data.reason).toBe('preserve for inspection');
    expect(events[0].data.path).toBe(realWtPath);
  });

  test('apply refuses dirty worktrees without mutating state', () => {
    const { repoRoot, caws, wtPath } = untrackRepo();
    fs.writeFileSync(path.join(wtPath, 'dirty.txt'), 'dirty\n');
    const before = snapshotState(caws, ['UNTRACK-001'], wtPath);

    const result = runUntrack(repoRoot, 'wt-keep', {
      reason: 'preserve for inspection',
      apply: true,
    });

    expect(result.code).toBe(1);
    expect(result.err).toContain('is not clean');
    expectUnchanged(before, snapshotState(caws, ['UNTRACK-001'], wtPath));
  });

  test('apply refuses foreign owners without mutating state', () => {
    const { repoRoot, caws, wtPath } = untrackRepo({
      owner: { session_id: 'foreign-session', platform: 'test' },
    });
    const before = snapshotState(caws, ['UNTRACK-001'], wtPath);

    const result = runUntrack(repoRoot, 'wt-keep', {
      reason: 'preserve for inspection',
      apply: true,
    });

    expect(result.code).toBe(1);
    expect(result.err).toContain('owned by a different session');
    expectUnchanged(before, snapshotState(caws, ['UNTRACK-001'], wtPath));
  });
});
