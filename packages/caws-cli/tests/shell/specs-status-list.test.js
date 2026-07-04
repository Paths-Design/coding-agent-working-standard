'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { initProject } = require('../../dist/store/init-store');
const { runSpecsListCommand } = require('../../dist/shell/commands/specs');
const { COMMAND_SURFACE_METADATA } = require('../../dist/shell/command-metadata');
const { cleanupAll, makeTempRepo } = require('../helpers/git-repo-factory');

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
  return { root, cawsDir: path.join(root, '.caws') };
}

function writeSpec(cawsDir, id, state) {
  const resolution = state === 'closed' ? 'resolution: completed\n' : '';
  const body = `id: ${id}
title: '${id}'
risk_tier: 3
mode: chore
lifecycle_state: ${state}
${resolution}created_at: '2026-07-04T00:00:00.000Z'
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

function writeArchivedEvent(cawsDir, id) {
  const event = {
    ts: '2026-07-04T01:02:03.000Z',
    event: 'spec_archived',
    spec_id: id,
    data: {
      from_path: `.caws/specs/${id}.yaml`,
      blob_sha: '1234567890abcdef',
    },
  };
  fs.writeFileSync(path.join(cawsDir, 'events.jsonl'), JSON.stringify(event) + '\n');
}

function readBytes(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

function snapshot(cawsDir) {
  const specsDir = path.join(cawsDir, 'specs');
  return {
    specs: fs.readdirSync(specsDir).sort().map((name) => [name, readBytes(path.join(specsDir, name))]),
    events: readBytes(path.join(cawsDir, 'events.jsonl')),
    worktrees: readBytes(path.join(cawsDir, 'worktrees.json')),
  };
}

function runList(root, opts = {}) {
  const out = [];
  const err = [];
  const code = runSpecsListCommand({
    cwd: root,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    ...opts,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

function runCli(root, args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, CAWS_QUIET: '1' },
  });
}

function specsMeta() {
  return COMMAND_SURFACE_METADATA.find((command) => command.name === 'specs');
}

describe('caws specs status listing', () => {
  test('list --status filters lifecycle states without mutating governed state', () => {
    const { root, cawsDir } = mkRepo();
    writeSpec(cawsDir, 'STATUS-ACTIVE-001', 'active');
    writeSpec(cawsDir, 'STATUS-DRAFT-001', 'draft');
    writeSpec(cawsDir, 'STATUS-CLOSED-001', 'closed');
    writeArchivedEvent(cawsDir, 'STATUS-ARCHIVED-001');
    const before = snapshot(cawsDir);

    const closed = runList(root, { status: 'closed' });
    const draft = runList(root, { status: 'draft' });
    const archived = runList(root, { status: 'archived' });

    expect(closed.code).toBe(0);
    expect(closed.out).toContain('STATUS-CLOSED-001');
    expect(closed.out).not.toContain('STATUS-ACTIVE-001');
    expect(closed.out).not.toContain('STATUS-DRAFT-001');

    expect(draft.code).toBe(0);
    expect(draft.out).toContain('STATUS-DRAFT-001');
    expect(draft.out).not.toContain('STATUS-CLOSED-001');

    expect(archived.code).toBe(0);
    expect(archived.out).toContain('-- archived (recoverable from history) --');
    expect(archived.out).toContain('STATUS-ARCHIVED-001');
    expect(archived.out).not.toContain('STATUS-ACTIVE-001');

    expect(snapshot(cawsDir)).toEqual(before);
  });

  test('group-level specs --status routes to the list status filter', () => {
    const { root, cawsDir } = mkRepo();
    writeSpec(cawsDir, 'STATUS-ACTIVE-001', 'active');
    writeSpec(cawsDir, 'STATUS-CLOSED-001', 'closed');

    const result = runCli(root, ['specs', '--status', 'closed']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('STATUS-CLOSED-001');
    expect(result.stdout).not.toContain('STATUS-ACTIVE-001');
    expect(result.stderr).toBe('');
  });

  test('list --status remains a leaf option in the spawned CLI', () => {
    const { root, cawsDir } = mkRepo();
    writeSpec(cawsDir, 'STATUS-ACTIVE-001', 'active');
    writeSpec(cawsDir, 'STATUS-CLOSED-001', 'closed');

    const result = runCli(root, ['specs', 'list', '--status', 'active']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('STATUS-ACTIVE-001');
    expect(result.stdout).not.toContain('STATUS-CLOSED-001');
    expect(result.stderr).toBe('');
  });

  test('invalid status prints accepted values and command handoffs', () => {
    const { root } = mkRepo();

    const direct = runList(root, { status: 'done' });
    const group = runCli(root, ['specs', '--status', 'done']);

    for (const result of [direct, { code: group.status, err: group.stderr }]) {
      expect(result.code).toBe(1);
      expect(result.err).toContain('invalid --status "done"');
      expect(result.err).toContain('active, draft, closed, archived');
      expect(result.err).toContain('caws specs list --status <active|draft|closed|archived>');
      expect(result.err).toContain('caws specs archive --status closed');
    }
  });

  test('metadata exposes status filters on group and list help', () => {
    const specs = specsMeta();
    const list = specs.subcommands.find((subcommand) => subcommand.name === 'list');

    expect(specs.options.map((option) => option.flag)).toContain('--status <status>');
    expect(list.options.map((option) => option.flag)).toContain('--status <status>');
  });
});
