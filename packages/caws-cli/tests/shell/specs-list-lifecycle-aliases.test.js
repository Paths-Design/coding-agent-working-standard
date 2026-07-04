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
  if (!initialized.ok) throw new Error('initProject failed: ' + JSON.stringify(initialized.errors));
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

function specsListMeta() {
  const specs = COMMAND_SURFACE_METADATA.find((command) => command.name === 'specs');
  return specs.subcommands.find((subcommand) => subcommand.name === 'list');
}

describe('caws specs list lifecycle aliases', () => {
  test('spawned CLI accepts --active as --status active', () => {
    const { root, cawsDir } = mkRepo();
    writeSpec(cawsDir, 'LIST-ACTIVE-001', 'active');
    writeSpec(cawsDir, 'LIST-DRAFT-001', 'draft');
    writeSpec(cawsDir, 'LIST-CLOSED-001', 'closed');

    const result = runCli(root, ['specs', 'list', '--active']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('LIST-ACTIVE-001');
    expect(result.stdout).not.toContain('LIST-DRAFT-001');
    expect(result.stdout).not.toContain('LIST-CLOSED-001');
    expect(result.stderr).toBe('');
  });

  test('--lifecycle and --state match --status output', () => {
    const { root, cawsDir } = mkRepo();
    writeSpec(cawsDir, 'LIST-ACTIVE-001', 'active');
    writeSpec(cawsDir, 'LIST-CLOSED-001', 'closed');

    const status = runList(root, { status: 'active' });
    const lifecycle = runList(root, { lifecycle: 'active' });
    const state = runList(root, { state: 'active' });

    expect(lifecycle).toEqual(status);
    expect(state).toEqual(status);
  });

  test('boolean lifecycle aliases route to draft and closed filters', () => {
    const { root, cawsDir } = mkRepo();
    writeSpec(cawsDir, 'LIST-ACTIVE-001', 'active');
    writeSpec(cawsDir, 'LIST-DRAFT-001', 'draft');
    writeSpec(cawsDir, 'LIST-CLOSED-001', 'closed');

    const draft = runList(root, { draft: true });
    const closed = runList(root, { closed: true });

    expect(draft.code).toBe(0);
    expect(draft.out).toContain('LIST-DRAFT-001');
    expect(draft.out).not.toContain('LIST-ACTIVE-001');
    expect(closed.code).toBe(0);
    expect(closed.out).toContain('LIST-CLOSED-001');
    expect(closed.out).not.toContain('LIST-ACTIVE-001');
  });

  test('conflicting lifecycle selectors refuse before mutation', () => {
    const { root, cawsDir } = mkRepo();
    writeSpec(cawsDir, 'LIST-ACTIVE-001', 'active');
    const before = snapshot(cawsDir);

    const result = runList(root, { status: 'active', active: true });

    expect(result.code).toBe(1);
    expect(result.err).toContain('lifecycle selectors --status, --active conflict');
    expect(snapshot(cawsDir)).toEqual(before);
  });

  test('metadata lists lifecycle aliases without changing --archived meaning', () => {
    const list = specsListMeta();
    const flags = list.options.map((option) => option.flag);

    expect(flags).toContain('--active');
    expect(flags).toContain('--draft');
    expect(flags).toContain('--closed');
    expect(flags).toContain('--lifecycle <state>');
    expect(flags).toContain('--state <state>');
    expect(flags).toContain('--archived');
  });
});
