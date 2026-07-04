'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { runScopeCommand } = require('../../dist/shell/index');
const {
  buildScopeDecisionJson,
  renderDecision,
} = require('../../dist/shell/render/decision');
const { initProject } = require('../../dist/store/init-store');

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

function mkRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-scope-remediation-'));
  execFileSync('git', ['init', '--quiet', '-b', 'main', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 't@test.com']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
  execFileSync('git', ['-C', root, 'commit', '--quiet', '--allow-empty', '-m', 'init']);
  repos.push(root);
  const r = initProject(root);
  if (!r.ok) throw new Error('initProject failed: ' + JSON.stringify(r.errors));
  return { root, caws: path.join(root, '.caws') };
}

function writeSpec(caws, id, scopeIn, { worktree } = {}) {
  const wtLine = worktree !== undefined ? `worktree: ${worktree}\n` : '';
  const inLines = scopeIn.map((p) => `    - ${p}`).join('\n');
  const body = `id: ${id}
title: 'Scope remediation fixture'
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
  - 'fixture spec'
acceptance:
  - id: A1
    given: 'fixture'
    when: 'fixture'
    then: 'fixture'
non_functional:
  reliability:
    - 'fixture'
contracts: []
`;
  fs.writeFileSync(path.join(caws, 'specs', `${id}.yaml`), body);
}

function writeRegistry(caws, entries) {
  fs.writeFileSync(path.join(caws, 'worktrees.json'), JSON.stringify(entries, null, 2) + '\n');
}

function runCheckJson(repoRoot, p) {
  const lines = [];
  const code = runScopeCommand({
    path: p,
    cwd: repoRoot,
    mode: 'check',
    json: true,
    out: (s) => lines.push(s),
    err: () => {},
  });
  return { code, json: JSON.parse(lines.join('\n')) };
}

describe('scope remediation JSON contract', () => {
  test('bound scope.in miss includes governed amend-scope commands', () => {
    const decision = {
      kind: 'reject',
      rule: 'scope.reject.scope_in_miss',
      authority: 'kernel/scope',
      path: 'packages/new/file.ts',
      normalizedPath: 'packages/new/file.ts',
      bindingState: 'bound',
      message: 'Path does not match scope.in',
      narrowRepair: 'Add a covering entry to scope.in.',
      data: { specId: 'FIXTURE-001' },
    };
    const ctx = {
      binding: { kind: 'bound', spec: { id: 'FIXTURE-001' }, worktreeName: 'fixture-wt' },
      worktreeName: 'fixture-wt',
      source: 'registry_path_match',
    };

    const json = buildScopeDecisionJson(decision, ctx);
    expect(json.remediation.summary).toContain('FIXTURE-001');
    expect(json.remediation.commands).toEqual([
      {
        command: 'caws specs amend-scope FIXTURE-001 --add packages/new/file.ts',
        description: 'Add the path to scope.in, making it editable and worktree-claimed.',
        mutates: true,
      },
      {
        command: 'caws specs amend-scope FIXTURE-001 --add-support packages/new/file.ts',
        description: 'Add the path to scope.support, making it editable but not worktree-claimed.',
        mutates: true,
      },
    ]);
  });

  test('admit and invalid path decisions omit remediation commands', () => {
    const admit = buildScopeDecisionJson({
      kind: 'admit',
      rule: 'scope.admit.scope_in',
      authority: 'kernel/scope',
      path: 'packages/ok/file.ts',
      bindingState: 'bound',
      message: 'admitted',
      data: { specId: 'FIXTURE-001' },
    });
    const invalid = buildScopeDecisionJson({
      kind: 'invalid_path',
      rule: 'scope.invalid.parent_traversal',
      authority: 'kernel/scope',
      path: '../escape.ts',
      bindingState: 'bound',
      message: 'invalid',
    });
    expect(admit.remediation).toBeUndefined();
    expect(invalid.remediation).toBeUndefined();
  });

  test('human no-authority output names the bind handoff for tracked unbound worktrees', () => {
    const output = renderDecision(
      {
        kind: 'no_authority',
        rule: 'scope.no_authority.unbound',
        authority: 'kernel/scope',
        path: 'packages/x.ts',
        bindingState: 'unbound',
        message: 'No spec is bound',
      },
      {
        boundContext: {
          binding: { kind: 'unbound' },
          worktreeName: 'unbound-wt',
          source: 'registry_path_match',
        },
      }
    );

    expect(output).toContain('caws worktree bind unbound-wt --spec <spec-id>');
    expect(output).toContain('caws specs list');
  });
});

describe('caws scope check --json remediation behavior', () => {
  test('unbound check emits remediation JSON and preserves refusal exit code', () => {
    const { root } = mkRepo();
    const { code, json } = runCheckJson(root, 'packages/no-owner/file.ts');

    expect(code).toBe(1);
    expect(json.decision).toBe('no_authority');
    expect(json.remediation.commands.map((c) => c.command)).toContain(
      'caws worktree create <name> --spec <spec-id>'
    );
  });

  test('ambiguous binding check emits claimant inspect commands in JSON', () => {
    const { root, caws } = mkRepo();
    writeSpec(caws, 'OWNER-A-001', ['packages/shared'], { worktree: 'wt-a' });
    writeSpec(caws, 'OWNER-B-001', ['packages/shared'], { worktree: 'wt-b' });
    writeRegistry(caws, {
      'wt-a': { specId: 'OWNER-A-001', baseBranch: 'main', path: path.join(caws, 'worktrees', 'wt-a') },
      'wt-b': { specId: 'OWNER-B-001', baseBranch: 'main', path: path.join(caws, 'worktrees', 'wt-b') },
    });

    const { code, json } = runCheckJson(root, 'packages/shared/file.ts');

    expect(code).toBe(1);
    expect(json.rule).toBe('scope.no_authority.ambiguous_binding');
    expect(json.ambiguousClaimants).toEqual(['OWNER-A-001', 'OWNER-B-001']);
    expect(json.remediation.commands).toEqual([
      {
        command: 'caws specs show OWNER-A-001',
        description: 'Inspect claimant OWNER-A-001 bound to worktree wt-a.',
        mutates: false,
      },
      {
        command: 'caws specs show OWNER-B-001',
        description: 'Inspect claimant OWNER-B-001 bound to worktree wt-b.',
        mutates: false,
      },
    ]);
  });
});
