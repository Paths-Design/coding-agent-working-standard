'use strict';

const fs = require('fs');
const path = require('path');

const { initProject } = require('../../dist/store/init-store');
const { runScopeCommand } = require('../../dist/shell/index');
const { cleanupAll, makeTempRepo } = require('../helpers/git-repo-factory');

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

function writeSpec(caws, id, scopeIn, { worktree } = {}) {
  const wtLine = worktree !== undefined ? `worktree: ${worktree}\n` : '';
  const inLines = scopeIn.map((p) => `    - ${p}`).join('\n');
  fs.writeFileSync(
    path.join(caws, 'specs', `${id}.yaml`),
    `id: ${id}
title: 'Authority context fixture'
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
${inLines}
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
`
  );
}

function writeRegistry(caws, entries) {
  fs.writeFileSync(path.join(caws, 'worktrees.json'), JSON.stringify(entries, null, 2) + '\n');
}

function runScopeJson(cwd, targetPath, mode = 'check') {
  const out = [];
  const err = [];
  const code = runScopeCommand({
    cwd,
    path: targetPath,
    mode,
    json: true,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });
  return { code, json: JSON.parse(out.join('\n')), err: err.join('\n') };
}

function runScopeHuman(cwd, targetPath, mode = 'show') {
  const out = [];
  const err = [];
  const code = runScopeCommand({
    cwd,
    path: targetPath,
    mode,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('scope authority-context handoff', () => {
  test('canonical unbound refusal names active spec candidates and read-only spec-context checks', () => {
    const { root, caws } = mkRepo();
    writeSpec(caws, 'ACTIVE-UNBOUND-001', ['packages/owned-a']);
    writeSpec(caws, 'ACTIVE-BOUND-001', ['packages/owned-b'], { worktree: 'wt-owned-b' });
    writeRegistry(caws, {
      'wt-owned-b': {
        specId: 'ACTIVE-BOUND-001',
        baseBranch: 'main',
        path: path.join(caws, 'worktrees', 'wt-owned-b'),
      },
    });

    const result = runScopeJson(root, 'packages/no-owner/file.ts');

    expect(result.code).toBe(1);
    expect(result.json.decision).toBe('no_authority');
    expect(result.json.remediation.authorityCandidates).toEqual([
      { specId: 'ACTIVE-BOUND-001', lifecycleState: 'active', worktreeName: 'wt-owned-b' },
      { specId: 'ACTIVE-UNBOUND-001', lifecycleState: 'active' },
    ]);
    expect(result.json.remediation.commands).toEqual([
      {
        command: 'caws specs list --status active',
        description: 'List active specs before choosing the authority context.',
        mutates: false,
      },
      {
        command: 'caws scope show packages/no-owner/file.ts --spec ACTIVE-BOUND-001',
        description: 'Read-only check whether ACTIVE-BOUND-001 is the right spec context for this path.',
        mutates: false,
      },
      {
        command: 'cd .caws/worktrees/wt-owned-b',
        description: 'Enter the existing worktree already bound to ACTIVE-BOUND-001.',
        mutates: false,
      },
      {
        command: 'caws scope show packages/no-owner/file.ts --spec ACTIVE-UNBOUND-001',
        description: 'Read-only check whether ACTIVE-UNBOUND-001 is the right spec context for this path.',
        mutates: false,
      },
      {
        command: 'caws worktree create <name> --spec ACTIVE-UNBOUND-001',
        description: 'Create a governed worktree for active spec ACTIVE-UNBOUND-001.',
        mutates: true,
      },
    ]);
    expect(result.json.remediation.notes.join('\n')).toContain(
      'does not grant current-checkout write authority'
    );
  });

  test('tracked unbound worktree suggests binding that worktree to visible active specs', () => {
    const { root, caws } = mkRepo();
    writeSpec(caws, 'ACTIVE-UNBOUND-002', ['packages/owned']);
    const unboundPath = path.join(caws, 'worktrees', 'loose-wt');
    fs.mkdirSync(unboundPath, { recursive: true });
    writeRegistry(caws, {
      'loose-wt': {
        baseBranch: 'main',
        path: unboundPath,
      },
    });

    const result = runScopeHuman(unboundPath, 'packages/no-owner/file.ts');

    expect(result.code).toBe(0);
    expect(result.out).toContain('active spec candidates:');
    expect(result.out).toContain('ACTIVE-UNBOUND-002 (no worktree)');
    expect(result.out).toContain(
      'caws scope show packages/no-owner/file.ts --spec ACTIVE-UNBOUND-002'
    );
    expect(result.out).toContain('caws worktree bind loose-wt --spec ACTIVE-UNBOUND-002');
    expect(result.out).not.toContain('caws worktree create <name> --spec <spec-id>');
  });
});
