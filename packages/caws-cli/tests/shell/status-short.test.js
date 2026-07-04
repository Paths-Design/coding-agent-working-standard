'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { initProject } = require('../../dist/store/init-store');
const { runStatusCommand } = require('../../dist/shell/commands/status');
const { COMMAND_SURFACE_METADATA } = require('../../dist/shell/command-metadata');
const { cleanupAll, makeTempRepo } = require('../helpers/git-repo-factory');

const CLI = path.resolve(__dirname, '..', '..', 'dist', 'index.js');

afterAll(() => {
  cleanupAll();
});

function mkRepo() {
  const root = makeTempRepo();
  const initialized = initProject(root);
  if (!initialized.ok) throw new Error('initProject failed: ' + JSON.stringify(initialized.errors));
  return { root, caws: path.join(root, '.caws') };
}

function writeSpec(cawsDir, id, lifecycleState, opts = {}) {
  const worktree = opts.worktree !== undefined ? `worktree: ${opts.worktree}\n` : '';
  const body = `id: ${id}
title: '${id}'
risk_tier: 3
mode: chore
lifecycle_state: ${lifecycleState}
${worktree}created_at: '2026-06-01T00:00:00.000Z'
updated_at: '2026-07-03T00:00:00.000Z'
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
  fs.writeFileSync(path.join(cawsDir, 'specs', `${id}.yaml`), body);
}

function writeRegistry(cawsDir, entries) {
  fs.writeFileSync(path.join(cawsDir, 'worktrees.json'), JSON.stringify(entries, null, 2) + '\n');
}

function readBytes(p) {
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

function runStatus(root, opts) {
  const out = [];
  const err = [];
  const code = runStatusCommand({
    cwd: root,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    now: () => new Date('2026-07-04T00:00:00.000Z'),
    ...opts,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

function statusMeta() {
  return COMMAND_SURFACE_METADATA.find((command) => command.name === 'status');
}

describe('caws status --short', () => {
  test('renders compact read-only status without full dashboard panels', () => {
    const { root, caws } = mkRepo();
    writeSpec(caws, 'STATUS-SHORT-001', 'active', { worktree: 'wt-status-short' });
    writeRegistry(caws, {
      'wt-status-short': {
        specId: 'STATUS-SHORT-001',
        branch: 'status-short',
        baseBranch: 'main',
        path: path.join(caws, 'worktrees', 'wt-status-short'),
      },
    });
    const beforeSpec = readBytes(path.join(caws, 'specs', 'STATUS-SHORT-001.yaml'));
    const beforeRegistry = readBytes(path.join(caws, 'worktrees.json'));
    const beforeEvents = readBytes(path.join(caws, 'events.jsonl'));

    const result = runStatus(root, { short: true });

    expect(result.code).toBe(0);
    expect(result.out).toContain('CAWS Status (short)');
    expect(result.out).toContain('specs:');
    expect(result.out).toContain('1 active');
    expect(result.out).toContain('worktrees: 1');
    expect(result.out).toContain('doctor:');
    expect(result.out).toContain('binding:');
    expect(result.out).not.toContain('Project');
    expect(result.out).not.toContain('Current context');
    expect(readBytes(path.join(caws, 'specs', 'STATUS-SHORT-001.yaml'))).toBe(beforeSpec);
    expect(readBytes(path.join(caws, 'worktrees.json'))).toBe(beforeRegistry);
    expect(readBytes(path.join(caws, 'events.jsonl'))).toBe(beforeEvents);
  });

  test('spawned CLI accepts --short', () => {
    const { root } = mkRepo();

    const result = spawnSync(process.execPath, [CLI, 'status', '--short'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'status-short-test' },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('CAWS Status (short)');
  });

  test('--short --json keeps the existing JSON status schema', () => {
    const { root, caws } = mkRepo();
    writeSpec(caws, 'STATUS-SHORT-002', 'active');

    const result = runStatus(root, { short: true, json: true });

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.out);
    expect(payload).toMatchObject({ ok: true, read_only: true });
    expect(payload.specs.count).toBe(1);
    expect(payload.panels).toEqual(['specs', 'worktrees', 'agents', 'doctor']);
    expect(result.out).not.toContain('CAWS Status (short)');
  });

  test('metadata lists --short', () => {
    expect(statusMeta().options.map((option) => option.flag)).toContain('--short');
  });
});
