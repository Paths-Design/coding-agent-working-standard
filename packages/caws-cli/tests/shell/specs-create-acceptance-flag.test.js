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
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'specs-create-acceptance-flag-test' },
  });
}

function specsCreateMeta() {
  const specs = COMMAND_SURFACE_METADATA.find((command) => command.name === 'specs');
  return specs.subcommands.find((subcommand) => subcommand.name === 'create');
}

describe('caws specs create --acceptance', () => {
  test('spawned CLI accepts repeatable free-text acceptance and writes v11 acceptance entries', () => {
    const root = mkRepo();

    const result = spawnCli(root, [
      'specs',
      'create',
      '--id',
      'ACCEPTANCE-001',
      '--title',
      'Acceptance flag',
      '--mode',
      'chore',
      '--tier',
      '3',
      '--scope-in',
      'README.md',
      '--acceptance',
      'Runs cleanly',
      '--acceptance',
      'Documents the behavior',
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('created ACCEPTANCE-001');
    const spec = readBytes(specPath(root, 'ACCEPTANCE-001'));
    expect(spec).toContain('acceptance:\n  - id: A1');
    expect(spec).toContain("    given: 'The spec implementation is complete.'");
    expect(spec).toContain("    when: 'The acceptance statement is evaluated.'");
    expect(spec).toContain("    then: 'Runs cleanly'");
    expect(spec).toContain('  - id: A2');
    expect(spec).toContain("    then: 'Documents the behavior'");
    expect(spec).not.toContain('acceptance_criteria');
    expect(readBytes(eventsPath(root))).toContain('spec_created');
  });

  test('structured acceptance seeds given/when/then fields', () => {
    const root = mkRepo();

    const result = runCreate(root, {
      id: 'ACCEPTANCE-002',
      title: 'Structured acceptance',
      mode: 'chore',
      tier: 3,
      scopeIn: ['README.md'],
      acceptance: ['given: a repo; when: create runs; then: YAML is valid'],
    });

    expect(result.code).toBe(0);
    const spec = readBytes(specPath(root, 'ACCEPTANCE-002'));
    expect(spec).toContain("    given: 'a repo'");
    expect(spec).toContain("    when: 'create runs'");
    expect(spec).toContain("    then: 'YAML is valid'");
  });

  test('plan JSON includes acceptance and remains read-only', () => {
    const root = mkRepo();

    const result = runCreate(root, {
      id: 'ACCEPTANCE-003',
      title: 'Acceptance plan',
      mode: 'chore',
      tier: 3,
      scopeIn: ['README.md'],
      acceptance: ['Runs cleanly'],
      plan: true,
      json: true,
    });

    expect(result.code).toBe(0);
    const json = JSON.parse(result.out);
    expect(json.read_only).toBe(true);
    expect(json.candidate.acceptance).toEqual([
      {
        given: 'The spec implementation is complete.',
        when: 'The acceptance statement is evaluated.',
        then: 'Runs cleanly',
      },
    ]);
    expect(json.command).toContain('--acceptance');
    expect(readBytes(specPath(root, 'ACCEPTANCE-003'))).toBe(null);
    expect(readBytes(eventsPath(root))).toBe(null);
  });

  test('metadata lists acceptance flag', () => {
    const create = specsCreateMeta();

    expect(create.options.map((option) => option.flag)).toContain('--acceptance <text>');
  });
});
