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
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'specs-create-scope-dot-alias-test' },
  });
}

function specsCreateMeta() {
  const specs = COMMAND_SURFACE_METADATA.find((command) => command.name === 'specs');
  return specs.subcommands.find((subcommand) => subcommand.name === 'create');
}

describe('caws specs create --scope.in alias', () => {
  test('spawned CLI accepts --scope.in and writes canonical scope.in', () => {
    const root = mkRepo();

    const result = spawnCli(root, [
      'specs',
      'create',
      '--id',
      'SCOPE-DOT-001',
      '--title',
      'Scope dot alias',
      '--mode',
      'chore',
      '--tier',
      '3',
      '--scope.in',
      'README.md',
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('created SCOPE-DOT-001');
    expect(result.stdout).toContain('scope.in is set from create-time scope flags');
    expect(readBytes(specPath(root, 'SCOPE-DOT-001'))).toContain("scope:\n  in:\n    - 'README.md'");
    expect(readBytes(eventsPath(root))).toContain('spec_created');
  });

  test('refuses --scope-in plus --scope.in before mutation', () => {
    const root = mkRepo();
    const before = snapshot(root, 'SCOPE-DOT-002');

    const result = runCreate(root, {
      id: 'SCOPE-DOT-002',
      title: 'Scope dot conflict',
      mode: 'chore',
      tier: 3,
      scopeIn: ['README.md'],
      scopeInDot: ['docs/guide.md'],
    });

    expect(result.code).toBe(1);
    expect(result.err).toContain('--scope-in and --scope.in both write scope.in');
    expect(snapshot(root, 'SCOPE-DOT-002')).toEqual(before);
  });

  test('metadata lists both scope aliases', () => {
    const create = specsCreateMeta();
    const flags = create.options.map((option) => option.flag);

    expect(flags).toContain('--scope-in <path>');
    expect(flags).toContain('--scope.in <path>');
  });
});
