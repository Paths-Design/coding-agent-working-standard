'use strict';

// CAWS-SPEC-ACTIVATION-BINDS-001 — binding a worktree is what activates the
// spec. This file previously pinned the opposite contract (create/bind REFUSE
// a draft and hand off to `caws specs activate`); that refusal is what forced
// `specs create` to mint `active`, which is why repos accumulated dozens of
// active specs nobody was working. The behavior being pinned now:
//
//   - create/bind ACCEPT a draft and promote it to active in the same
//     lifecycle transaction as the binding writes,
//   - the promotion appends spec_activated LAST, so a rolled-back append
//     can never leave an activation claim the spec body did not receive,
//   - a failed create/bind leaves the spec draft (no half-activated spec),
//   - a terminal spec (closed/archived) is still refused,
//   - `caws specs activate` remains available standalone.

const fs = require('fs');
const path = require('path');

const {
  runWorktreeBindCommand,
  runWorktreeCreateCommand,
} = require('../../dist/shell/commands/worktree');
const { initProject } = require('../../dist/store/init-store');
const { cleanupAll, makeTempRepo } = require('../helpers/git-repo-factory');

afterAll(() => {
  cleanupAll();
});

function mkRepo() {
  const root = makeTempRepo();
  const initialized = initProject(root);
  if (!initialized.ok) throw new Error('initProject failed: ' + JSON.stringify(initialized.errors));
  return root;
}

function specBody(id, lifecycleState, extra = '') {
  return `id: ${id}
title: 'Draft bind activation fixture'
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
${extra}`;
}

function writeSpec(cawsDir, id, lifecycleState, extra) {
  fs.writeFileSync(path.join(cawsDir, 'specs', `${id}.yaml`), specBody(id, lifecycleState, extra));
}

function writeRegistry(cawsDir, entries) {
  fs.writeFileSync(path.join(cawsDir, 'worktrees.json'), JSON.stringify(entries, null, 2) + '\n');
}

function readSpec(cawsDir, id) {
  return fs.readFileSync(path.join(cawsDir, 'specs', `${id}.yaml`), 'utf8');
}

function lifecycleOf(cawsDir, id) {
  const m = /^lifecycle_state:\s*(\S+)\s*$/m.exec(readSpec(cawsDir, id));
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

function readBytes(p) {
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

function snapshot(cawsDir, specId, worktreePath) {
  return {
    spec: readBytes(path.join(cawsDir, 'specs', `${specId}.yaml`)),
    registry: readBytes(path.join(cawsDir, 'worktrees.json')),
    events: readBytes(path.join(cawsDir, 'events.jsonl')),
    worktreeExists: worktreePath !== undefined ? fs.existsSync(worktreePath) : undefined,
  };
}

function runCreate(root, specId, name = 'wt-draft') {
  const out = [];
  const err = [];
  const code = runWorktreeCreateCommand({
    cwd: root,
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'draft-bind-test' },
    name,
    specId,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    showData: true,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

function runBind(root, specId, name = 'wt-existing') {
  const out = [];
  const err = [];
  const code = runWorktreeBindCommand({
    cwd: root,
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'draft-bind-test' },
    name,
    specId,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    showData: true,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('worktree binding confers spec activation', () => {
  test('create promotes a draft spec to active and records spec_activated before the binding events', () => {
    const root = mkRepo();
    const cawsDir = path.join(root, '.caws');
    writeSpec(cawsDir, 'DRAFT-BIND-001', 'draft');
    const eventsBefore = readEvents(cawsDir).length;

    const result = runCreate(root, 'DRAFT-BIND-001');

    expect(result.code).toBe(0);
    // The spec body itself is now active, not just the registry.
    expect(lifecycleOf(cawsDir, 'DRAFT-BIND-001')).toBe('active');
    // The promotion moved updated_at off the draft's authoring timestamp, so
    // staleness checks measure from the bind, not from when the draft was
    // written.
    expect(readSpec(cawsDir, 'DRAFT-BIND-001')).not.toContain(
      "updated_at: '2026-07-04T00:00:00.000Z'"
    );
    // The registry side of the binding landed too.
    const registry = JSON.parse(readBytes(path.join(cawsDir, 'worktrees.json')));
    expect(registry['wt-draft'].specId).toBe('DRAFT-BIND-001');

    const appended = readEvents(cawsDir).slice(eventsBefore);
    const kinds = appended.map((e) => e.event);
    expect(kinds).toEqual(['worktree_created', 'worktree_bound', 'spec_activated']);
    const activated = appended[2];
    expect(activated.spec_id).toBe('DRAFT-BIND-001');
    // Exactly the two fields spec_activated.v1.json allows — the schema is
    // additionalProperties:false, so an extra "activated_by" would be rejected
    // by the lifecycle validator and roll the whole transaction back.
    expect(activated.data).toEqual({
      previous_lifecycle_state: 'draft',
      lifecycle_state: 'active',
    });
  });

  test('bind promotes a draft spec on an existing unbound worktree entry', () => {
    const root = mkRepo();
    const cawsDir = path.join(root, '.caws');
    const wtPath = path.join(cawsDir, 'worktrees', 'wt-existing');
    fs.mkdirSync(wtPath, { recursive: true });
    writeSpec(cawsDir, 'DRAFT-BIND-002', 'draft');
    writeRegistry(cawsDir, {
      'wt-existing': {
        branch: 'wt-existing',
        baseBranch: 'main',
        path: wtPath,
      },
    });
    const eventsBefore = readEvents(cawsDir).length;

    const result = runBind(root, 'DRAFT-BIND-002');

    expect(result.code).toBe(0);
    expect(lifecycleOf(cawsDir, 'DRAFT-BIND-002')).toBe('active');

    const appended = readEvents(cawsDir).slice(eventsBefore);
    expect(appended.map((e) => e.event)).toEqual(['worktree_bound', 'spec_activated']);
  });

  test('binding an already-active spec appends no spec_activated event', () => {
    const root = mkRepo();
    const cawsDir = path.join(root, '.caws');
    writeSpec(cawsDir, 'ACTIVE-BIND-003', 'active');
    const eventsBefore = readEvents(cawsDir).length;

    const result = runCreate(root, 'ACTIVE-BIND-003', 'wt-active');

    expect(result.code).toBe(0);
    const appended = readEvents(cawsDir).slice(eventsBefore);
    expect(appended.map((e) => e.event)).toEqual(['worktree_created', 'worktree_bound']);
  });

  test('binding does not launder an incomplete draft into an active spec', () => {
    const root = mkRepo();
    const cawsDir = path.join(root, '.caws');
    // risk_tier 2 + mode fix + contracts: [] fails the tier-2 contract rule.
    // Before this slice the operator was told to run `caws specs activate`,
    // which applied that check; the check must still apply now that binding is
    // the activation path, or binding becomes a way around spec completeness.
    const body = specBody('DRAFT-BIND-004', 'draft')
      .replace('risk_tier: 3', 'risk_tier: 2')
      .replace('mode: chore', 'mode: fix');
    fs.writeFileSync(path.join(cawsDir, 'specs', 'DRAFT-BIND-004.yaml'), body);
    const wtPath = path.join(cawsDir, 'worktrees', 'wt-invalid');
    const before = snapshot(cawsDir, 'DRAFT-BIND-004', wtPath);

    const result = runCreate(root, 'DRAFT-BIND-004', 'wt-invalid');

    expect(result.code).toBe(1);
    expect(result.err).toContain('contract');
    // Nothing moved: no spec write, no registry entry, no event, no worktree.
    expect(snapshot(cawsDir, 'DRAFT-BIND-004', wtPath)).toEqual(before);
    expect(lifecycleOf(cawsDir, 'DRAFT-BIND-004')).toBe('draft');
  });

  test('a closed spec is still refused, and the refusal names the reopen path', () => {
    const root = mkRepo();
    const cawsDir = path.join(root, '.caws');
    writeSpec(
      cawsDir,
      'CLOSED-BIND-005',
      'closed',
      "resolution: completed\nclosure_notes: 'fixture closure'\n"
    );
    const wtPath = path.join(cawsDir, 'worktrees', 'wt-closed');
    const before = snapshot(cawsDir, 'CLOSED-BIND-005', wtPath);

    const result = runCreate(root, 'CLOSED-BIND-005', 'wt-closed');

    expect(result.code).toBe(1);
    expect(result.err).toContain('only draft or active specs can be bound to a worktree');
    expect(result.err).toContain('caws specs reopen CLOSED-BIND-005');
    expect(snapshot(cawsDir, 'CLOSED-BIND-005', wtPath)).toEqual(before);
  });

  test('a rolled-back create leaves the spec draft — activation is atomic with binding', () => {
    const root = mkRepo();
    const cawsDir = path.join(root, '.caws');
    writeSpec(cawsDir, 'DRAFT-BIND-006', 'draft');
    const eventsBefore = readEvents(cawsDir).length;

    // The shipped fault seam fails the transaction while appending
    // worktree_bound — i.e. AFTER spec_activated has already been planned and
    // the promoted spec bytes staged. If activation were a separate write, the
    // spec would be left active with no worktree: the exact half-state this
    // slice must not create.
    process.env.CAWS_TEST_INJECT_LIFECYCLE_FAULT = JSON.stringify({
      eventMatch: 'worktree_bound',
      cause: 'activation-atomicity-probe',
    });
    let result;
    try {
      result = runCreate(root, 'DRAFT-BIND-006', 'wt-rollback');
    } finally {
      delete process.env.CAWS_TEST_INJECT_LIFECYCLE_FAULT;
    }

    expect(result.code).not.toBe(0);
    expect(lifecycleOf(cawsDir, 'DRAFT-BIND-006')).toBe('draft');
    // The rollback un-wrote the spec body but CANNOT un-append events already
    // chained. Because spec_activated is appended last, the surviving residue
    // is worktree_created only — the pre-existing half-state class doctor
    // already reports. No event asserts an activation the body never received.
    const appended = readEvents(cawsDir).slice(eventsBefore);
    expect(appended.map((e) => e.event)).not.toContain('spec_activated');
    expect(appended.map((e) => e.event)).toEqual(['worktree_created']);
    // The registry side was compensated too, so nothing points at the spec.
    const registry = JSON.parse(readBytes(path.join(cawsDir, 'worktrees.json')));
    expect(registry['wt-rollback']).toBeUndefined();
  });

  test('positive control: the same create succeeds and activates without the fault', () => {
    const root = mkRepo();
    const cawsDir = path.join(root, '.caws');
    writeSpec(cawsDir, 'DRAFT-BIND-007', 'draft');

    const result = runCreate(root, 'DRAFT-BIND-007', 'wt-rollback');

    expect(result.code).toBe(0);
    expect(lifecycleOf(cawsDir, 'DRAFT-BIND-007')).toBe('active');
  });
});
