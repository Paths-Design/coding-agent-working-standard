'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { runScopeCommand, runScopePlanCommand } = require('../../dist/shell/commands/scope');
const { initProject } = require('../../dist/store/init-store');

const repos = [];

afterAll(() => {
  for (const repo of repos) {
    try {
      fs.rmSync(repo, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function mkRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-scope-spec-context-'));
  execFileSync('git', ['init', '--quiet', '-b', 'main', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'scope-spec@test.com']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Scope Spec Test']);
  execFileSync('git', ['-C', root, 'commit', '--quiet', '--allow-empty', '-m', 'init']);
  repos.push(root);
  const initialized = initProject(root);
  if (!initialized.ok) throw new Error('initProject failed: ' + JSON.stringify(initialized.errors));
  return { root, caws: path.join(root, '.caws') };
}

function writeSpec(caws, id, scopeIn, { state = 'active', worktree } = {}) {
  const wtLine = worktree !== undefined ? `worktree: ${worktree}\n` : '';
  const inLines = scopeIn.map((p) => `    - ${p}`).join('\n');
  const body = `id: ${id}
title: 'Scope explicit spec fixture'
risk_tier: 3
mode: chore
lifecycle_state: ${state}
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
  out:
    - packages/fixture/private
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

function readBytes(p) {
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

function snapshot(caws) {
  const specsDir = path.join(caws, 'specs');
  return {
    specs: Object.fromEntries(
      fs.readdirSync(specsDir)
        .filter((entry) => entry.endsWith('.yaml'))
        .sort()
        .map((entry) => [entry, readBytes(path.join(specsDir, entry))])
    ),
    events: readBytes(path.join(caws, 'events.jsonl')),
  };
}

function runShow(root, p, opts = {}) {
  const out = [];
  const err = [];
  const code = runScopeCommand({
    cwd: root,
    path: p,
    mode: 'show',
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    ...opts,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

function runCheck(root, p, opts = {}) {
  const out = [];
  const err = [];
  const code = runScopeCommand({
    cwd: root,
    path: p,
    mode: 'check',
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    ...opts,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

function runPlan(root, opts = {}) {
  const out = [];
  const err = [];
  const code = runScopePlanCommand({
    cwd: root,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    ...opts,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('scope explicit --spec context', () => {
  test('scope show evaluates an unbound checkout against a named spec without mutation', () => {
    const { root, caws } = mkRepo();
    writeSpec(caws, 'SCOPE-SPEC-001', ['packages/fixture']);
    const before = snapshot(caws);

    const result = runShow(root, 'packages/fixture/file.ts', { specId: 'SCOPE-SPEC-001' });

    expect(result.code).toBe(0);
    expect(result.out).toContain('ADMIT');
    expect(result.out).toContain('spec SCOPE-SPEC-001');
    expect(result.out).toContain('explicit spec context: SCOPE-SPEC-001 (active, read-only)');
    expect(result.out).toContain('does not prove the current checkout owns write authority');
    expect(snapshot(caws)).toEqual(before);
  });

  test('scope check --json rejects misses with spec_context mode and remediation', () => {
    const { root, caws } = mkRepo();
    writeSpec(caws, 'SCOPE-SPEC-002', ['packages/fixture']);
    const before = snapshot(caws);

    const result = runCheck(root, 'packages/other/file.ts', {
      specId: 'SCOPE-SPEC-002',
      json: true,
    });
    const json = JSON.parse(result.out);

    expect(result.code).toBe(1);
    expect(json.decision).toBe('reject');
    expect(json.mode).toBe('spec_context');
    expect(json.source).toBe('explicit_spec');
    expect(json.boundSpecId).toBe('SCOPE-SPEC-002');
    expect(json.remediation.commands.map((command) => command.command)).toContain(
      'caws specs amend-scope SCOPE-SPEC-002 --add packages/other/file.ts'
    );
    expect(snapshot(caws)).toEqual(before);
  });

  test('scope plan --spec evaluates every path against the named spec', () => {
    const { root, caws } = mkRepo();
    writeSpec(caws, 'SCOPE-SPEC-003', ['packages/fixture']);
    const before = snapshot(caws);

    const result = runPlan(root, {
      paths: ['packages/fixture/file.ts', 'packages/other/file.ts'],
      specId: 'SCOPE-SPEC-003',
      json: true,
    });
    const json = JSON.parse(result.out);

    expect(result.code).toBe(0);
    expect(json.read_only).toBe(true);
    expect(json.counts).toEqual({ admit: 1, reject: 1, no_authority: 0, invalid_path: 0 });
    expect(json.paths.map((entry) => entry.mode)).toEqual(['spec_context', 'spec_context']);
    expect(json.paths.map((entry) => entry.source)).toEqual(['explicit_spec', 'explicit_spec']);
    expect(snapshot(caws)).toEqual(before);
  });

  test('missing --spec id fails before evaluation and leaves state unchanged', () => {
    const { root, caws } = mkRepo();
    writeSpec(caws, 'SCOPE-SPEC-004', ['packages/fixture']);
    const before = snapshot(caws);

    const result = runShow(root, 'packages/fixture/file.ts', { specId: 'NO-SUCH-SPEC' });

    expect(result.code).toBe(1);
    expect(result.err).toContain('spec "NO-SUCH-SPEC" not found');
    expect(result.err).toContain('caws specs list');
    expect(result.out).toBe('');
    expect(snapshot(caws)).toEqual(before);
  });
});
