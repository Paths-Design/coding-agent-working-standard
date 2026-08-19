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

// ---------------------------------------------------------------------------
// CAWS-DEFECT-AMEND-SCOPE-EXCESS-ARGS-SILENT-DROP-01 — full CLI parse path.
//
// Commander ^11 defaults to allowExcessArguments(true), so
// `amend-scope <id> --add a b` bound `a` to --add, treated `b` as a stray
// operand, silently discarded it, and printed "amended scope" (observed live
// 2026-08-19). Handler-level tests above CANNOT see this: they bypass
// Commander entirely. These tests spawn dist/index.js so the argument-
// absorption behavior itself is what is pinned.
// ---------------------------------------------------------------------------

const { spawnSync } = require('child_process');
const CLI = path.resolve(__dirname, '..', '..', 'dist', 'index.js');

function spawnCli(root, args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'specs-amend-scope-excess-args-test' },
  });
}

function readSpecScopeIn(root, id) {
  const body = readBytes(path.join(root, '.caws', 'specs', `${id}.yaml`));
  const match = body.match(/scope:\n {2}in:\n((?: {4}- .*\n)+)/);
  return match ? match[1].split('\n').filter(Boolean).map((l) => l.replace(/^ {4}- /, '').replace(/^'(.*)'$/, '$1')) : [];
}

describe('amend-scope excess positional arguments (full CLI parse path)', () => {
  test('A1: a stray positional after --add errors naming the token and the repeatable form; NOTHING is amended', () => {
    const root = mkRepo();
    const cawsDir = path.join(root, '.caws');
    writeActiveSpec(cawsDir, 'EXCESS-ARGS-A1-001');
    const before = readSpecScopeIn(root, 'EXCESS-ARGS-A1-001');

    const result = spawnCli(root, [
      'specs', 'amend-scope', 'EXCESS-ARGS-A1-001',
      '--add', 'docs/a.md', 'docs/b.md',
    ]);
    const output = `${result.stdout}${result.stderr}`;

    // Non-zero exit, no false success line.
    expect(result.status).not.toBe(0);
    expect(output).not.toContain('amended scope');
    // The diagnostic names the dropped token and the repeatable remediation.
    expect(output).toContain('docs/b.md');
    expect(output).toContain('nothing was applied');
    expect(output).toContain('--add <value> --add <value2>');
    // And the spec is NOT partially amended — not even the first path.
    expect(readSpecScopeIn(root, 'EXCESS-ARGS-A1-001')).toEqual(before);
  });

  test('A2: the repeatable form adds both paths in one call and one spec_scope_amended event', () => {
    const root = mkRepo();
    const cawsDir = path.join(root, '.caws');
    writeActiveSpec(cawsDir, 'EXCESS-ARGS-A2-001');

    const result = spawnCli(root, [
      'specs', 'amend-scope', 'EXCESS-ARGS-A2-001',
      '--add', 'docs/a.md', '--add', 'docs/b.md',
    ]);

    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('amended scope');
    const scopeIn = readSpecScopeIn(root, 'EXCESS-ARGS-A2-001');
    expect(scopeIn).toContain('docs/a.md');
    expect(scopeIn).toContain('docs/b.md');
    const amended = readEvents(cawsDir).filter((event) => event.event === 'spec_scope_amended');
    expect(amended).toHaveLength(1);
    expect(amended[0].data.added_in).toEqual(['docs/a.md', 'docs/b.md']);
  });

  test('a stray positional on a no-argument leaf is also refused (guard is universal)', () => {
    const root = mkRepo();
    const result = spawnCli(root, ['specs', 'list', 'stray-token']);
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status).not.toBe(0);
    expect(output).toContain('stray-token');
    expect(output).toContain('no positional arguments');
  });
});
