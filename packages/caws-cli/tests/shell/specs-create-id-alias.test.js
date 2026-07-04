'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { initProject } = require('../../dist/store/init-store');
const { runSpecsCreateCommand } = require('../../dist/shell/commands/specs');
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
  return root;
}

function specPath(root, id) {
  return path.join(root, '.caws', 'specs', `${id}.yaml`);
}

function eventsPath(root) {
  return path.join(root, '.caws', 'events.jsonl');
}

function readBytes(p) {
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

function snapshot(root, id) {
  return {
    spec: readBytes(specPath(root, id)),
    events: readBytes(eventsPath(root)),
  };
}

function runCreate(root, opts) {
  const out = [];
  const err = [];
  const code = runSpecsCreateCommand({
    cwd: root,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    now: () => new Date('2026-07-04T01:02:03.000Z'),
    ...opts,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

function spawnCli(root, args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'specs-create-id-alias-test' },
  });
}

function specsCreateMeta() {
  const specs = COMMAND_SURFACE_METADATA.find((command) => command.name === 'specs');
  return specs.subcommands.find((subcommand) => subcommand.name === 'create');
}

describe('caws specs create --id alias', () => {
  test('spawned CLI accepts --id without positional id', () => {
    const root = mkRepo();

    const result = spawnCli(root, [
      'specs',
      'create',
      '--id',
      'CREATE-ID-001',
      '--title',
      'Create id alias',
      '--mode',
      'chore',
      '--tier',
      '3',
      '--scope-in',
      'README.md',
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('created CREATE-ID-001');
    expect(readBytes(specPath(root, 'CREATE-ID-001'))).toContain('id: CREATE-ID-001');
    expect(readBytes(eventsPath(root))).toContain('spec_created');
  });

  test('refuses positional id plus --id before mutation', () => {
    const root = mkRepo();
    const before = snapshot(root, 'CREATE-ID-002');

    const result = runCreate(root, {
      id: 'CREATE-ID-002',
      idOption: 'CREATE-ID-OTHER-002',
      title: 'Create id conflict',
      mode: 'chore',
      tier: 3,
      scopeIn: ['README.md'],
    });

    expect(result.code).toBe(1);
    expect(result.err).toContain('positional <id> and --id both name the spec id');
    expect(snapshot(root, 'CREATE-ID-002')).toEqual(before);
  });

  test('metadata shows optional positional id and --id alias', () => {
    const create = specsCreateMeta();

    expect(create.argument).toMatchObject({ name: 'id', required: false });
    expect(create.options.map((option) => option.flag)).toContain('--id <id>');
  });
});
