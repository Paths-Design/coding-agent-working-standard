'use strict';

const fs = require('fs');
const path = require('path');

const { runSpecsAmendScopeCommand } = require('../../dist/shell/commands/specs');
const { COMMAND_SURFACE_METADATA } = require('../../dist/shell/command-metadata');
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

function writeActiveSpec(cawsDir, id) {
  const body = `id: ${id}
title: 'Amend scope reason fixture'
risk_tier: 3
mode: chore
lifecycle_state: active
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

function readBytes(p) {
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

function runAmendScope(root, id, opts = {}) {
  const out = [];
  const err = [];
  const code = runSpecsAmendScopeCommand({
    cwd: root,
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'specs-amend-scope-reason-test' },
    id,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    showData: true,
    now: () => new Date('2026-07-04T12:00:00.000Z'),
    ...opts,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

function readEvents(cawsDir) {
  return readBytes(path.join(cawsDir, 'events.jsonl'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

function findLeaf(groupName, leafName) {
  const group = COMMAND_SURFACE_METADATA.find((command) => command.name === groupName);
  if (!group) throw new Error(`missing group ${groupName}`);
  const leaf = group.subcommands.find((command) => command.name === leafName);
  if (!leaf) throw new Error(`missing leaf ${groupName} ${leafName}`);
  return leaf;
}

describe('caws specs amend-scope --reason', () => {
  test('records the reason on spec_scope_amended evidence', () => {
    const root = mkRepo();
    const cawsDir = path.join(root, '.caws');
    writeActiveSpec(cawsDir, 'AMEND-SCOPE-001');

    const result = runAmendScope(root, 'AMEND-SCOPE-001', {
      addIn: ['src/new-file.ts'],
      reason: 'scope widened for implementation file',
    });

    expect(result.code).toBe(0);
    expect(result.out).toContain('amended scope for AMEND-SCOPE-001');
    const spec = readBytes(path.join(cawsDir, 'specs', 'AMEND-SCOPE-001.yaml'));
    expect(spec).toContain('    - src/new-file.ts');

    const amended = readEvents(cawsDir).find((event) => event.event === 'spec_scope_amended');
    expect(amended).toBeDefined();
    expect(amended.data.added_in).toEqual(['src/new-file.ts']);
    expect(amended.data.reason).toBe('scope widened for implementation file');
  });

  test('metadata surfaces the reason option on nested help', () => {
    const amendScope = findLeaf('specs', 'amend-scope');

    expect(amendScope.options.map((option) => option.flag)).toContain('--reason <text>');
  });
});
