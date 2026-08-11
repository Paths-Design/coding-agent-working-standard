'use strict';

// Full commander-parse-path regression for the specs-evidence --status parent
// shadow (same class as CAWS-CLI-SPECS-ARCHIVE-STATUS-PARENT-SHADOW-001).
//
// The specs group declares a group-level `--status` compat option (it powers
// `caws specs --status <s>` -> `specs list`). Commander binds a `--status`
// appearing after the leaf name to the PARENT, so the evidence leaf's own
// `--status` was unreachable: as a .requiredOption() it failed every
// invocation with "required option '--status <s>' not specified", making
// `caws specs evidence` unusable from the real CLI while handler-level tests
// (which call runSpecsEvidenceCommand directly) stayed green. The fix drops
// the commander-level requirement and routes the value via optsWithGlobals();
// these tests spawn the real dist CLI so they can only pass when the flag
// actually reaches the handler.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { initProject } = require('../../dist/store/init-store');
const { cleanupAll, git, makeTempRepo } = require('../helpers/git-repo-factory');

const CLI = path.resolve(__dirname, '..', '..', 'dist', 'index.js');

afterAll(() => {
  cleanupAll();
});

function mkRepo() {
  const root = makeTempRepo();
  const initialized = initProject(root);
  if (!initialized.ok) {
    throw new Error('initProject failed: ' + JSON.stringify(initialized.errors));
  }
  return root;
}

function specPath(root, id) {
  return path.join(root, '.caws', 'specs', `${id}.yaml`);
}

function writeActiveSpec(root, id) {
  const body = `id: ${id}
title: '${id}'
risk_tier: 3
mode: chore
lifecycle_state: active
created_at: '2026-08-11T00:00:00.000Z'
updated_at: '2026-08-11T00:00:00.000Z'
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
  fs.writeFileSync(specPath(root, id), body);
}

function commitAll(root, message) {
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', message]);
}

function spawnCli(root, args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'specs-evidence-status-routing-test' },
  });
}

describe('caws specs evidence --status routing (full CLI parse path)', () => {
  test('A1: `specs evidence <id> --ac A1 --status pass --evidence-ref <ref>` records evidence', () => {
    const root = mkRepo();
    writeActiveSpec(root, 'EV-ROUTE-A-001');
    commitAll(root, 'add active fixture');

    const result = spawnCli(root, [
      'specs', 'evidence', 'EV-ROUTE-A-001',
      '--ac', 'A1', '--status', 'pass', '--evidence-ref', 'npm test',
    ]);
    const output = `${result.stdout}${result.stderr}`;

    // The pre-fix failure mode: commander rejects every invocation because the
    // leaf's required --status is shadowed by the parent group option.
    expect(output).not.toContain("required option '--status <s>' not specified");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('recorded evidence for EV-ROUTE-A-001 AC A1 (status: pass)');
    expect(fs.readFileSync(specPath(root, 'EV-ROUTE-A-001'), 'utf8')).toContain('status: pass');
  });

  test('A2: missing --status fails with handler-owned guidance, not a commander parse error', () => {
    const root = mkRepo();
    writeActiveSpec(root, 'EV-ROUTE-B-001');
    commitAll(root, 'add active fixture');

    const result = spawnCli(root, ['specs', 'evidence', 'EV-ROUTE-B-001', '--ac', 'A1']);
    const output = `${result.stdout}${result.stderr}`;

    expect(output).not.toContain("required option '--status <s>' not specified");
    expect(result.status).toBe(1);
    expect(output).toContain('caws specs evidence: missing --status (required)');
  });

  test('A3: invalid --status value is rejected by the handler with the closed enum', () => {
    const root = mkRepo();
    writeActiveSpec(root, 'EV-ROUTE-C-001');
    commitAll(root, 'add active fixture');

    const result = spawnCli(root, [
      'specs', 'evidence', 'EV-ROUTE-C-001',
      '--ac', 'A1', '--status', 'bogus', '--evidence-ref', 'npm test',
    ]);
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain('caws specs evidence: invalid --status. Got "bogus"');
    expect(output).toContain('pass|fail|unchecked|waived');
  });
});
