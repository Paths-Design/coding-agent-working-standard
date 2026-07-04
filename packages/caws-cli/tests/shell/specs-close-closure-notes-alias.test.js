'use strict';

const fs = require('fs');
const path = require('path');

const { runSpecsCloseCommand } = require('../../dist/shell/commands/specs');
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
title: 'Close closure notes alias fixture'
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

function snapshot(cawsDir, specId) {
  return {
    spec: readBytes(path.join(cawsDir, 'specs', `${specId}.yaml`)),
    events: readBytes(path.join(cawsDir, 'events.jsonl')),
  };
}

function runClose(root, id, opts = {}) {
  const out = [];
  const err = [];
  const code = runSpecsCloseCommand({
    cwd: root,
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'specs-close-closure-notes-test' },
    id,
    resolution: 'completed',
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    showData: true,
    now: () => new Date('2026-07-04T12:00:00.000Z'),
    ...opts,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

function findLeaf(groupName, leafName) {
  const group = COMMAND_SURFACE_METADATA.find((command) => command.name === groupName);
  if (!group) throw new Error(`missing group ${groupName}`);
  const leaf = group.subcommands.find((command) => command.name === leafName);
  if (!leaf) throw new Error(`missing leaf ${groupName} ${leafName}`);
  return leaf;
}

describe('caws specs close --closure-notes alias', () => {
  test('closes an active spec and writes closure_notes', () => {
    const root = mkRepo();
    const cawsDir = path.join(root, '.caws');
    writeActiveSpec(cawsDir, 'CLOSE-NOTES-001');

    const result = runClose(root, 'CLOSE-NOTES-001', { closureNotes: 'completed through alias' });

    expect(result.code).toBe(0);
    expect(result.out).toContain('closed CLOSE-NOTES-001');
    const spec = readBytes(path.join(cawsDir, 'specs', 'CLOSE-NOTES-001.yaml'));
    expect(spec).toContain('lifecycle_state: closed');
    expect(spec).toContain('resolution: completed');
    expect(spec).toContain("closure_notes: 'completed through alias'");
    expect(readBytes(path.join(cawsDir, 'events.jsonl'))).toContain('spec_closed');
  });

  test('refuses competing --reason and --closure-notes before mutation', () => {
    const root = mkRepo();
    const cawsDir = path.join(root, '.caws');
    writeActiveSpec(cawsDir, 'CLOSE-NOTES-002');
    const before = snapshot(cawsDir, 'CLOSE-NOTES-002');

    const result = runClose(root, 'CLOSE-NOTES-002', {
      reason: 'reason note',
      closureNotes: 'alias note',
    });

    expect(result.code).toBe(1);
    expect(result.err).toContain('--reason and --closure-notes');
    expect(snapshot(cawsDir, 'CLOSE-NOTES-002')).toEqual(before);
  });

  test('metadata surfaces the alias on nested help', () => {
    const close = findLeaf('specs', 'close');

    expect(close.options.map((option) => option.flag)).toContain('--closure-notes <text>');
  });
});
