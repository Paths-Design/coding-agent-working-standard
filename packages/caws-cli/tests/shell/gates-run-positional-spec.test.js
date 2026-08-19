'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { initProject } = require('../../dist/store/init-store');
const { COMMAND_SURFACE_METADATA } = require('../../dist/shell/command-metadata');
const { runSpecsCreateCommand } = require('../../dist/shell/commands/specs');
const { cleanupAll, makeTempRepo } = require('../helpers/git-repo-factory');

const CLI = path.resolve(__dirname, '..', '..', 'dist', 'index.js');

afterAll(() => {
  cleanupAll();
});

function mkRepo() {
  const root = makeTempRepo();
  const initialized = initProject(root);
  if (!initialized.ok) throw new Error('initProject failed: ' + JSON.stringify(initialized.errors));
  const createCode = runSpecsCreateCommand({
    cwd: root,
    id: 'GATES-RUN-001',
    title: 'Gates run positional spec',
    mode: 'fix',
    tier: 3,
    scopeIn: ['README.md'],
    now: () => new Date('2026-07-04T00:00:00.000Z'),
    out: () => {},
    err: () => {},
  });
  if (createCode !== 0) throw new Error(`spec create failed with code ${createCode}`);
  return root;
}

function eventsPath(root) {
  return path.join(root, '.caws', 'events.jsonl');
}

function readEvents(root) {
  const p = eventsPath(root);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

function runCli(root, args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      CLAUDE_CODE_SESSION_ID: 'gates-run-positional-spec-test',
    },
  });
}

function gatesRunMeta() {
  const gates = COMMAND_SURFACE_METADATA.find((command) => command.name === 'gates');
  return gates.subcommands.find((subcommand) => subcommand.name === 'run');
}

describe('caws gates run positional spec id', () => {
  test('spawned CLI accepts a positional spec id as an alias for --spec', () => {
    const root = mkRepo();

    const result = runCli(root, ['gates', 'run', 'GATES-RUN-001']);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('Overall: OK');
    expect(readEvents(root)).toContain('"event":"gate_evaluated"');
    expect(readEvents(root)).toContain('"spec_id":"GATES-RUN-001"');
  });

  test('refuses positional id plus --spec before writing gate events', () => {
    const root = mkRepo();
    const before = readEvents(root);

    const result = runCli(root, [
      'gates',
      'run',
      'GATES-RUN-001',
      '--spec',
      'GATES-RUN-OTHER-001',
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('positional <spec> and --spec both name the spec id');
    expect(readEvents(root)).toBe(before);
  });

  test('metadata shows optional positional spec and --spec alias', () => {
    const run = gatesRunMeta();

    expect(run.argument).toMatchObject({ name: 'spec', required: false });
    expect(run.options.map((option) => option.flag)).toContain('--spec <id>');
    expect(run.options.find((option) => option.flag === '--spec <id>').description).toContain(
      'aliases positional <spec>'
    );
  });
});
