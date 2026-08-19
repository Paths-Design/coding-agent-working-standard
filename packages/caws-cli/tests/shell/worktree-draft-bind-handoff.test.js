'use strict';

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

function writeDraftSpec(cawsDir, id) {
  const body = `id: ${id}
title: 'Draft bind handoff fixture'
risk_tier: 3
mode: chore
lifecycle_state: draft
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

function expectUnchanged(before, after) {
  expect(after).toEqual(before);
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

describe('worktree draft spec activation handoff', () => {
  test('create refusal for a draft spec includes specs activate handoff without mutation', () => {
    const root = mkRepo();
    const cawsDir = path.join(root, '.caws');
    writeDraftSpec(cawsDir, 'DRAFT-BIND-001');
    const wtPath = path.join(cawsDir, 'worktrees', 'wt-draft');
    const before = snapshot(cawsDir, 'DRAFT-BIND-001', wtPath);

    const result = runCreate(root, 'DRAFT-BIND-001');

    expect(result.code).toBe(1);
    expect(result.err).toContain('lifecycle_state "draft"');
    expect(result.err).toContain('Next: caws specs activate DRAFT-BIND-001');
    expect(result.err).toContain('Activation runs the draft spec preflight');
    expect(result.err).toContain('next_command');
    expect(result.err).toContain('caws specs activate DRAFT-BIND-001');
    expectUnchanged(before, snapshot(cawsDir, 'DRAFT-BIND-001', wtPath));
  });

  test('bind refusal for a draft spec includes specs activate handoff without mutation', () => {
    const root = mkRepo();
    const cawsDir = path.join(root, '.caws');
    const wtPath = path.join(cawsDir, 'worktrees', 'wt-existing');
    fs.mkdirSync(wtPath, { recursive: true });
    writeDraftSpec(cawsDir, 'DRAFT-BIND-002');
    writeRegistry(cawsDir, {
      'wt-existing': {
        branch: 'wt-existing',
        baseBranch: 'main',
        path: wtPath,
      },
    });
    const before = snapshot(cawsDir, 'DRAFT-BIND-002', wtPath);

    const result = runBind(root, 'DRAFT-BIND-002');

    expect(result.code).toBe(1);
    expect(result.err).toContain('lifecycle_state "draft"');
    expect(result.err).toContain('Next: caws specs activate DRAFT-BIND-002');
    expect(result.err).toContain('Activation runs the draft spec preflight');
    expect(result.err).toContain('next_command');
    expectUnchanged(before, snapshot(cawsDir, 'DRAFT-BIND-002', wtPath));
  });
});
