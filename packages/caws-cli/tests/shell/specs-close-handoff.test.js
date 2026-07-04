'use strict';

const fs = require('fs');
const path = require('path');

const { runSpecsCloseCommand } = require('../../dist/shell/commands/specs');
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

function writeSpec(cawsDir, id, state, extra = '') {
  const body = `id: ${id}
title: 'Close handoff fixture'
risk_tier: 3
mode: chore
lifecycle_state: ${state}
${extra}created_at: '2026-07-04T00:00:00.000Z'
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
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'specs-close-test' },
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

describe('caws specs close state-aware handoff', () => {
  test('already-closed refusal names inspect/archive/recover commands without mutation', () => {
    const root = mkRepo();
    const cawsDir = path.join(root, '.caws');
    writeSpec(cawsDir, 'CLOSE-HANDOFF-001', 'closed', "resolution: completed\nclosure_notes: 'already done'\n");
    const before = snapshot(cawsDir, 'CLOSE-HANDOFF-001');

    const result = runClose(root, 'CLOSE-HANDOFF-001');

    expect(result.code).toBe(1);
    expect(result.err).toContain('already closed');
    expect(result.err).toContain('close is a no-op');
    expect(result.err).toContain('Next: caws specs show CLOSE-HANDOFF-001');
    expect(result.err).toContain('Archive when finished: caws specs archive CLOSE-HANDOFF-001');
    expect(result.err).toContain('caws specs recover CLOSE-HANDOFF-001 --out <path>');
    expect(result.err).toContain('next_commands');
    expect(snapshot(cawsDir, 'CLOSE-HANDOFF-001')).toEqual(before);
  });

  test('active close still mutates through the normal close path', () => {
    const root = mkRepo();
    const cawsDir = path.join(root, '.caws');
    writeSpec(cawsDir, 'CLOSE-HANDOFF-002', 'active');

    const result = runClose(root, 'CLOSE-HANDOFF-002', { reason: 'complete' });

    expect(result.code).toBe(0);
    expect(result.out).toContain('closed CLOSE-HANDOFF-002');
    const spec = readBytes(path.join(cawsDir, 'specs', 'CLOSE-HANDOFF-002.yaml'));
    expect(spec).toContain('lifecycle_state: closed');
    expect(spec).toContain('resolution: completed');
    expect(spec).toContain("closure_notes: 'complete'");
    expect(readBytes(path.join(cawsDir, 'events.jsonl'))).toContain('spec_closed');
  });
});
