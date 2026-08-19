'use strict';

/**
 * CAWS-SPEC-ACTIVATION-BINDS-001 — destroy undoes an activation it can prove
 * was never used.
 *
 * Binding activates a spec. If every abandoned worktree left the spec active
 * and unbound, the leak this slice closes would reopen one destroy at a time.
 * So a destroy whose branch carried NO commit returns the spec to draft.
 *
 * The condition is deliberately narrow, and the negative cases are the point:
 * spec_deactivated.v1.json records that once work has actually started the
 * one-way property of `active` is load-bearing. A branch with commits — merged
 * or abandoned — keeps the spec active, and so does a branch whose commit count
 * cannot be determined.
 */

const fs = require('fs');
const path = require('path');

const {
  runWorktreeCreateCommand,
  runWorktreeDestroyCommand,
} = require('../../dist/shell/commands/worktree');
const { initProject } = require('../../dist/store/init-store');
const { cleanupAll, makeTempRepo, git } = require('../helpers/git-repo-factory');

afterAll(() => {
  cleanupAll();
});

const SESSION = 'destroy-demote-test';

function mkRepo() {
  const root = makeTempRepo();
  const initialized = initProject(root);
  if (!initialized.ok) throw new Error('initProject failed: ' + JSON.stringify(initialized.errors));
  return root;
}

function writeSpec(cawsDir, id, lifecycleState) {
  fs.writeFileSync(
    path.join(cawsDir, 'specs', `${id}.yaml`),
    `id: ${id}
title: 'Destroy demotion fixture'
risk_tier: 3
mode: chore
lifecycle_state: ${lifecycleState}
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
`
  );
}

function lifecycleOf(cawsDir, id) {
  const m = /^lifecycle_state:\s*(\S+)\s*$/m.exec(
    fs.readFileSync(path.join(cawsDir, 'specs', `${id}.yaml`), 'utf8')
  );
  return m === null ? null : m[1];
}

function readEvents(cawsDir) {
  const p = path.join(cawsDir, 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

function run(fn, args) {
  const out = [];
  const err = [];
  const code = fn({
    cwd: args.root,
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: SESSION },
    ...args,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    showData: true,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

/** Create a bound worktree from a draft spec (which the bind activates). */
function setupBound(specId, name) {
  const root = mkRepo();
  const cawsDir = path.join(root, '.caws');
  writeSpec(cawsDir, specId, 'draft');
  const created = run(runWorktreeCreateCommand, { root, name, specId });
  expect(created.code).toBe(0);
  expect(lifecycleOf(cawsDir, specId)).toBe('active');
  return { root, cawsDir, wtPath: path.join(cawsDir, 'worktrees', name) };
}

describe('worktree destroy demotes an unstarted slice', () => {
  test('a branch with no commits returns the spec to draft and records spec_deactivated', () => {
    const { root, cawsDir } = setupBound('DESTROY-DEMOTE-001', 'wt-empty');
    const eventsBefore = readEvents(cawsDir).length;

    const result = run(runWorktreeDestroyCommand, { root, name: 'wt-empty' });

    expect(result.code).toBe(0);
    expect(lifecycleOf(cawsDir, 'DESTROY-DEMOTE-001')).toBe('draft');
    // The binding pointer is gone too — draft AND unbound, the pre-create state.
    expect(
      fs.readFileSync(path.join(cawsDir, 'specs', 'DESTROY-DEMOTE-001.yaml'), 'utf8')
    ).not.toMatch(/^worktree:/m);

    const appended = readEvents(cawsDir).slice(eventsBefore);
    expect(appended.map((e) => e.event)).toEqual(['worktree_destroyed', 'spec_deactivated']);
    const demoted = appended[1];
    expect(demoted.spec_id).toBe('DESTROY-DEMOTE-001');
    expect(demoted.data.previous_lifecycle_state).toBe('active');
    expect(demoted.data.reason).toContain('still at the commit it was forked from');

    // The operator is told, rather than discovering it later via doctor.
    expect(result.out).toContain('DESTROY-DEMOTE-001 returned to draft');
  });

  test('a branch that carried a commit keeps the spec active', () => {
    const { root, cawsDir, wtPath } = setupBound('DESTROY-KEEP-002', 'wt-worked');
    // Real work on the branch, committed inside the worktree.
    fs.writeFileSync(path.join(wtPath, 'worked.txt'), 'real work\n');
    git(wtPath, ['add', 'worked.txt']);
    git(wtPath, ['commit', '-m', 'chore: real work on the slice']);
    const eventsBefore = readEvents(cawsDir).length;

    const result = run(runWorktreeDestroyCommand, {
      root,
      name: 'wt-worked',
      abandonUnmerged: true,
    });

    expect(result.code).toBe(0);
    // Work started, so `active` is load-bearing and must survive the destroy.
    expect(lifecycleOf(cawsDir, 'DESTROY-KEEP-002')).toBe('active');
    const appended = readEvents(cawsDir).slice(eventsBefore);
    expect(appended.map((e) => e.event)).toEqual(['worktree_destroyed']);
    expect(result.out).not.toContain('returned to draft');
  });

  test('an indeterminate fork point keeps the spec active (fail conservative)', () => {
    const { root, cawsDir } = setupBound('DESTROY-UNKNOWN-003', 'wt-unknown');
    // Strip baseSha, reproducing a registry entry written before the field
    // existed. The writer can no longer prove the branch never moved, and must
    // NOT read "cannot prove it moved" as "it did not move".
    const registryPath = path.join(cawsDir, 'worktrees.json');
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    delete registry['wt-unknown'].baseSha;
    fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2) + '\n');
    const eventsBefore = readEvents(cawsDir).length;

    const result = run(runWorktreeDestroyCommand, { root, name: 'wt-unknown' });

    expect(result.code).toBe(0);
    expect(lifecycleOf(cawsDir, 'DESTROY-UNKNOWN-003')).toBe('active');
    expect(readEvents(cawsDir).slice(eventsBefore).map((e) => e.event)).toEqual([
      'worktree_destroyed',
    ]);
  });

  test('a MERGED branch keeps the spec active — reachability alone cannot tell it from an unstarted one', () => {
    // This is the case that makes the fork-sha comparison necessary. After a
    // merge, `git rev-list --count base..branch` is 0 for a branch that did ALL
    // the work, exactly as it is for one that did none. Since worktree merge
    // tears down via destroy, a reachability-based check demotes a spec whose
    // work just landed.
    const { root, cawsDir, wtPath } = setupBound('DESTROY-MERGED-005', 'wt-merged');
    fs.writeFileSync(path.join(wtPath, 'landed.txt'), 'work that lands\n');
    git(wtPath, ['add', 'landed.txt']);
    git(wtPath, ['commit', '-m', 'chore: work that lands']);
    // Fast-forward main onto the branch: now nothing is "beyond base".
    const branchTip = git(root, ['rev-parse', 'wt-merged']).trim();
    git(root, ['merge', '--ff-only', branchTip]);

    const result = run(runWorktreeDestroyCommand, { root, name: 'wt-merged' });

    expect(result.code).toBe(0);
    expect(lifecycleOf(cawsDir, 'DESTROY-MERGED-005')).toBe('active');
    expect(result.out).not.toContain('returned to draft');
  });

  test('a spec active before the bind is demoted too — the signal is the branch, not who promoted it', () => {
    // Guard against reading the demotion as "undo what I did": the writer keys
    // on the branch being empty, not on whether THIS bind performed the
    // promotion. An already-active spec with an untouched branch is equally an
    // unstarted slice.
    const root = mkRepo();
    const cawsDir = path.join(root, '.caws');
    writeSpec(cawsDir, 'DESTROY-PREACTIVE-004', 'active');
    expect(
      run(runWorktreeCreateCommand, { root, name: 'wt-pre', specId: 'DESTROY-PREACTIVE-004' }).code
    ).toBe(0);

    const result = run(runWorktreeDestroyCommand, { root, name: 'wt-pre' });

    expect(result.code).toBe(0);
    expect(lifecycleOf(cawsDir, 'DESTROY-PREACTIVE-004')).toBe('draft');
  });
});
