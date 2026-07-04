'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  buildWorktreePrunePlan,
  runWorktreePruneCommand,
} = require('../../dist/shell/commands/worktree');
const { initProject } = require('../../dist/store/init-store');
const { DOCTOR_RULES } = require('@paths.design/caws-kernel');

const repos = [];

afterAll(() => {
  for (const r of repos) {
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

function writeSpec(cawsDir, id, { state = 'active', worktree } = {}) {
  const wtLine = worktree !== undefined ? `worktree: ${worktree}\n` : '';
  const resolutionLine =
    state === 'closed' || state === 'archived' ? `resolution: completed\n` : '';
  const body = `id: ${id}
title: 'Cleanup fixture spec'
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

function makeWorktreeDir(cawsDir, name) {
  fs.mkdirSync(path.join(cawsDir, 'worktrees', name), { recursive: true });
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

function snapshotState(cawsDir, specIds) {
  const specs = {};
  for (const id of specIds) specs[id] = readBytes(path.join(cawsDir, 'specs', `${id}.yaml`));
  return {
    registry: readBytes(path.join(cawsDir, 'worktrees.json')),
    events: readBytes(path.join(cawsDir, 'events.jsonl')),
    eventCount: readEventsRaw(cawsDir).length,
    specs,
  };
}

function expectUnchanged(before, after) {
  expect(after.registry).toBe(before.registry);
  expect(after.events).toBe(before.events);
  expect(after.eventCount).toBe(before.eventCount);
  expect(after.specs).toEqual(before.specs);
}

function eventsOfType(cawsDir, type) {
  return readEventsRaw(cawsDir).filter((e) => e.event === type);
}

function runPrune(repoRoot, opts = {}) {
  const out = [];
  const err = [];
  const code = runWorktreePruneCommand({
    cwd: repoRoot,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    now: () => new Date('2026-07-04T12:00:00.000Z'),
    ...opts,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

function cleanupRepo() {
  const repoRoot = mkRepo('caws-wt-prune-');
  const caws = setupCaws(repoRoot);
  writeRegistry(caws, {
    'wt-ghost': { branch: 'wt-ghost', baseBranch: 'main' },
  });
  writeSpec(caws, 'GHOST-BIND-001', { state: 'active', worktree: 'wt-dead' });
  return { repoRoot, caws };
}

describe('caws worktree prune read-only cleanup plan', () => {
  test('plans ghost registry and dead binding classes without mutating state', () => {
    const { repoRoot, caws } = cleanupRepo();
    const before = snapshotState(caws, ['GHOST-BIND-001']);

    const result = runPrune(repoRoot);

    expect(result.code).toBe(0);
    expect(result.out).toContain('caws worktree prune: read-only cleanup plan');
    expect(result.out).toContain('ghost-registry wt-ghost');
    expect(result.out).toContain('dead-binding GHOST-BIND-001');
    expect(result.out).toContain('next: caws worktree repair --dry-run && caws worktree repair');
    expectUnchanged(before, snapshotState(caws, ['GHOST-BIND-001']));
  });

  test('json output exposes matching state classes and honors filters', () => {
    const { repoRoot, caws } = cleanupRepo();
    const before = snapshotState(caws, ['GHOST-BIND-001']);

    const result = runPrune(repoRoot, { state: ['ghost-registry'], json: true });

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.out);
    expect(payload.read_only).toBe(true);
    expect(payload.dry_run).toBe(true);
    expect(payload.candidates).toHaveLength(1);
    expect(payload.candidates[0].subject).toBe('wt-ghost');
    expect(payload.candidates[0].state_class).toBe('ghost-registry');
    expect(payload.counts_by_state).toEqual({ 'ghost-registry': 1 });
    expectUnchanged(before, snapshotState(caws, ['GHOST-BIND-001']));
  });

  test('apply executes only repairable classes and records expected audit events', () => {
    const { repoRoot, caws } = cleanupRepo();
    const result = runPrune(repoRoot, { apply: true, json: true });

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.out);
    expect(payload.read_only).toBe(false);
    expect(payload.dry_run).toBe(false);
    expect(payload.counts).toEqual({ applied: 2, refused: 0, failed: 0 });
    expect(payload.outcomes.map((item) => item.action)).toEqual(['applied', 'applied']);

    const registry = JSON.parse(readBytes(path.join(caws, 'worktrees.json')));
    expect(registry['wt-ghost']).toBeUndefined();
    expect(readBytes(path.join(caws, 'specs', 'GHOST-BIND-001.yaml'))).not.toMatch(/worktree: wt-dead/);
    expect(eventsOfType(caws, 'worktree_pruned')).toHaveLength(1);
    expect(eventsOfType(caws, 'spec_binding_cleared')).toHaveLength(1);
  });

  test('apply refuses non-apply classes without mutating state', () => {
    const repoRoot = mkRepo('caws-wt-prune-refuse-');
    const caws = setupCaws(repoRoot);
    writeRegistry(caws, {
      'wt-owned': {
        branch: 'wt-owned',
        baseBranch: 'main',
        owner: { session_id: 'foreign-session', platform: 'test' },
      },
    });
    makeWorktreeDir(caws, 'wt-owned');
    const before = snapshotState(caws, []);

    const result = runPrune(repoRoot, {
      state: ['owner-lease-missing-refused'],
      apply: true,
      json: true,
    });

    expect(result.code).toBe(1);
    const payload = JSON.parse(result.out);
    expect(payload.counts).toEqual({ applied: 0, refused: 1, failed: 0 });
    expect(payload.outcomes[0].action).toBe('refused');
    expect(payload.outcomes[0].state_class).toBe('owner-lease-missing-refused');
    expectUnchanged(before, snapshotState(caws, []));
  });

  test('unknown state filters refuse before mutation', () => {
    const { repoRoot, caws } = cleanupRepo();
    const before = snapshotState(caws, ['GHOST-BIND-001']);

    const result = runPrune(repoRoot, { state: ['not-a-state'] });

    expect(result.code).toBe(1);
    expect(result.err).toContain('unknown --state value(s): not-a-state');
    expectUnchanged(before, snapshotState(caws, ['GHOST-BIND-001']));
  });

  test('pure classifier surfaces event orphans and stale-owner drift as refused plan items', () => {
    const plan = buildWorktreePrunePlan([
      {
        rule: DOCTOR_RULES.WORKTREE_EVENT_WITHOUT_CONTROL_PLANE_BINDING,
        severity: 'warning',
        message: 'orphan',
        subject: 'wt-orphan',
        data: { worktree_name: 'wt-orphan', created_event_seq: 10 },
      },
      {
        rule: DOCTOR_RULES.WORKTREE_OWNER_LEASE_MISSING,
        severity: 'warning',
        message: 'owner stale',
        subject: 'wt-stale-owner',
        data: { worktree_name: 'wt-stale-owner', owner_session_id: 'sess-old' },
      },
    ]);

    expect(plan.ok).toBe(true);
    expect(plan.items.map((item) => item.state_class)).toEqual([
      'event-orphan-refused',
      'owner-lease-missing-refused',
    ]);
    expect(plan.items[0].allowed_mutation).toBeNull();
    expect(plan.items[1].refusal_reason).toMatch(/leases are not authority/);
  });
});
