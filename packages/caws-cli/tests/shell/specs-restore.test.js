'use strict';

const fs = require('fs');
const path = require('path');

const { initProject } = require('../../dist/store/init-store');
const { archiveSpec } = require('../../dist/store/specs-writer');
const { loadEvents } = require('../../dist/store/events-store');
const { runSpecsRestoreCommand } = require('../../dist/shell/commands/specs');
const { cleanupAll, git, makeTempRepo } = require('../helpers/git-repo-factory');

const ACTOR = { kind: 'agent', id: 'jest', platform: 'jest' };

afterAll(() => {
  cleanupAll();
});

function mkRepo() {
  const root = makeTempRepo();
  const initialized = initProject(root);
  if (!initialized.ok) {
    throw new Error('initProject failed: ' + JSON.stringify(initialized.errors));
  }
  return { root, caws: path.join(root, '.caws') };
}

function writeClosedSpec(cawsDir, id) {
  const body = `id: ${id}
title: 'Restore fixture'
risk_tier: 3
mode: chore
lifecycle_state: closed
resolution: completed
worktree: stale-worktree
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
  - 'fixture'
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

function commitAll(root, message) {
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', message]);
}

function eventCount(cawsDir) {
  const loaded = loadEvents(cawsDir);
  if (!loaded.ok) throw new Error('loadEvents failed: ' + JSON.stringify(loaded.errors));
  return loaded.value.events.length;
}

function latestEvent(cawsDir, eventName, id) {
  const loaded = loadEvents(cawsDir);
  if (!loaded.ok) throw new Error('loadEvents failed: ' + JSON.stringify(loaded.errors));
  return [...loaded.value.events]
    .reverse()
    .find((event) => event.event === eventName && event.spec_id === id);
}

function runRestore(root, opts) {
  const out = [];
  const err = [];
  const code = runSpecsRestoreCommand({
    cwd: root,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    now: () => new Date('2026-07-04T02:03:04.000Z'),
    ...opts,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('caws specs restore', () => {
  test('dry-run plans restoration without appending events, then apply restores as draft', () => {
    const { root, caws } = mkRepo();
    const id = 'RESTORE-SPEC-001';
    const canonicalPath = path.join(caws, 'specs', `${id}.yaml`);
    writeClosedSpec(caws, id);
    commitAll(root, 'add closed restore fixture');

    const archived = archiveSpec(caws, {
      id,
      actor: ACTOR,
      now: () => new Date('2026-07-04T01:02:03.000Z'),
    });
    expect(archived.ok).toBe(true);
    expect(fs.existsSync(canonicalPath)).toBe(false);
    const beforePlanEvents = eventCount(caws);

    const plan = runRestore(root, { id, targetState: 'draft', json: true });

    expect(plan.code).toBe(0);
    const payload = JSON.parse(plan.out);
    expect(payload).toMatchObject({
      ok: true,
      dry_run: true,
      read_only: true,
      id,
      target_path: `.caws/specs/${id}.yaml`,
      target_lifecycle_state: 'draft',
      worktree_binding_cleared: true,
      valid: true,
    });
    expect(payload.source.event).toBe('spec_archived');
    expect(payload.command).toBe(`caws specs restore ${id} --as draft --apply`);
    expect(eventCount(caws)).toBe(beforePlanEvents);
    expect(fs.existsSync(canonicalPath)).toBe(false);

    const applied = runRestore(root, { id, targetState: 'draft', apply: true });

    expect(applied.code).toBe(0);
    expect(applied.out).toContain(`restored ${id} to .caws/specs/${id}.yaml`);
    const restored = fs.readFileSync(canonicalPath, 'utf8');
    expect(restored).toContain('lifecycle_state: draft');
    expect(restored).toContain("updated_at: '2026-07-04T02:03:04.000Z'");
    expect(restored).not.toMatch(/^resolution:/m);
    expect(restored).not.toMatch(/^worktree:/m);

    const event = latestEvent(caws, 'spec_restored', id);
    expect(event.data).toMatchObject({
      source_event: 'spec_archived',
      from_path: `.caws/specs/${id}.yaml`,
      restored_path: `.caws/specs/${id}.yaml`,
      restored_lifecycle_state: 'draft',
    });
    expect(git(root, ['log', '-1', '--pretty=%s'])).toBe(`chore(caws): restore ${id}`);
  });

  test('refuses to overwrite an existing canonical spec', () => {
    const { root, caws } = mkRepo();
    const id = 'RESTORE-SPEC-002';
    writeClosedSpec(caws, id);
    commitAll(root, 'add closed restore fixture');
    const before = fs.readFileSync(path.join(caws, 'specs', `${id}.yaml`), 'utf8');

    const result = runRestore(root, { id, targetState: 'active' });

    expect(result.code).toBe(1);
    expect(result.err).toContain('restore refuses to overwrite canonical control-plane state');
    expect(fs.readFileSync(path.join(caws, 'specs', `${id}.yaml`), 'utf8')).toBe(before);
  });
});
