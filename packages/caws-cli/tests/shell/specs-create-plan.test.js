'use strict';

const fs = require('fs');
const path = require('path');

const { initProject } = require('../../dist/store/init-store');
const { runSpecsCreateCommand } = require('../../dist/shell/commands/specs');
const { COMMAND_SURFACE_METADATA } = require('../../dist/shell/command-metadata');
const { cleanupAll, makeTempRepo } = require('../helpers/git-repo-factory');

afterAll(() => {
  cleanupAll();
});

function mkRepo() {
  const root = makeTempRepo();
  const initialized = initProject(root);
  if (!initialized.ok) {
    throw new Error('initProject failed: ' + JSON.stringify(initialized.errors));
  }
  return root;
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

function specPath(root, id) {
  return path.join(root, '.caws', 'specs', `${id}.yaml`);
}

function eventsPath(root) {
  return path.join(root, '.caws', 'events.jsonl');
}

function specsCreateMeta() {
  const specs = COMMAND_SURFACE_METADATA.find((command) => command.name === 'specs');
  return specs.subcommands.find((subcommand) => subcommand.name === 'create');
}

describe('caws specs create --plan', () => {
  test('help metadata lists read-only plan and JSON options', () => {
    const create = specsCreateMeta();
    expect(create.options.find((option) => option.flag === '--plan').description).toContain(
      'Read-only preflight'
    );
    expect(create.options.find((option) => option.flag === '--json').description).toContain(
      'With --plan'
    );
  });

  test('tier 1 plan reports missing semantic fields without writing files or events', () => {
    const root = mkRepo();
    const result = runCreate(root, {
      id: 'PLAN-TIER-001',
      title: 'Tier one plan',
      mode: 'feature',
      riskTier: 1,
      plan: true,
    });

    expect(result.code).toBe(0);
    expect(result.out).toContain('caws specs create --plan: needs changes candidate');
    expect(result.out).toContain('/contracts');
    expect(result.out).toContain('/observability');
    expect(result.out).toContain('/rollback');
    expect(result.out).toContain('/non_functional/security');
    expect(result.out).toContain('example YAML additions:');
    expect(result.out).toContain('observability:');
    expect(result.out).toContain('rollback:');
    expect(result.out).toContain('non_functional:');
    expect(result.out).toContain('security:');
    expect(result.out).toContain('No files, events, or worktree registry entries were written.');
    expect(fs.existsSync(specPath(root, 'PLAN-TIER-001'))).toBe(false);
    expect(fs.existsSync(eventsPath(root))).toBe(false);
  });

  test('tier 1 JSON plan includes field examples for missing semantic fields', () => {
    const root = mkRepo();
    const result = runCreate(root, {
      id: 'PLAN-TIER-JSON-001',
      title: 'Tier one json plan',
      mode: 'feature',
      riskTier: 1,
      contract: ['core-api:behavior'],
      plan: true,
      json: true,
    });

    expect(result.code).toBe(0);
    const json = JSON.parse(result.out);
    expect(json.valid).toBe(false);
    expect(json.missing_fields).toEqual([
      '/observability',
      '/rollback',
      '/non_functional/security',
    ]);
    expect(json.field_examples['/observability']).toContain('observability:');
    expect(json.field_examples['/rollback']).toContain('rollback:');
    expect(json.field_examples['/non_functional/security']).toContain('non_functional:');
    expect(fs.existsSync(specPath(root, 'PLAN-TIER-JSON-001'))).toBe(false);
    expect(fs.existsSync(eventsPath(root))).toBe(false);
  });

  test('invalid contract tuple fails before any write in plan mode', () => {
    const root = mkRepo();
    const result = runCreate(root, {
      id: 'PLAN-CONTRACT-001',
      title: 'Bad contract plan',
      mode: 'feature',
      riskTier: 2,
      contract: ['behavior:verifychain-detects-tamper'],
      plan: true,
    });

    expect(result.code).toBe(1);
    expect(result.err).toContain(
      'Did you mean --contract "verifychain-detects-tamper:behavior"?'
    );
    expect(fs.existsSync(specPath(root, 'PLAN-CONTRACT-001'))).toBe(false);
    expect(fs.existsSync(eventsPath(root))).toBe(false);
  });

  test('valid tier 3 JSON plan reports candidate and still writes nothing', () => {
    const root = mkRepo();
    const result = runCreate(root, {
      id: 'PLAN-VALID-001',
      title: 'Valid plan',
      mode: 'feature',
      riskTier: 3,
      scopeIn: ['src/foo.ts', 'tests/foo.test.ts'],
      plan: true,
      json: true,
    });

    expect(result.code).toBe(0);
    const json = JSON.parse(result.out);
    expect(json).toMatchObject({
      ok: true,
      dry_run: true,
      read_only: true,
      id: 'PLAN-VALID-001',
      target_path: '.caws/specs/PLAN-VALID-001.yaml',
      valid: true,
      would_write: true,
      missing_fields: [],
    });
    expect(json.candidate.scope_in).toEqual(['src/foo.ts', 'tests/foo.test.ts']);
    expect(json.command).toContain('caws specs create PLAN-VALID-001');
    expect(fs.existsSync(specPath(root, 'PLAN-VALID-001'))).toBe(false);
    expect(fs.existsSync(eventsPath(root))).toBe(false);
  });
});
