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
  if (!initialized.ok) throw new Error('initProject failed: ' + JSON.stringify(initialized.errors));
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

function readBytes(p) {
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

function snapshot(root, id) {
  return {
    spec: readBytes(specPath(root, id)),
    events: readBytes(eventsPath(root)),
  };
}

function specsCreateMeta() {
  const specs = COMMAND_SURFACE_METADATA.find((command) => command.name === 'specs');
  return specs.subcommands.find((subcommand) => subcommand.name === 'create');
}

describe('caws specs create --tier alias', () => {
  test('metadata exposes --tier as an alias for --risk-tier', () => {
    const create = specsCreateMeta();
    const tier = create.options.find((option) => option.flag === '--tier <n>');

    expect(tier.description).toContain('Alias for --risk-tier');
    expect(tier.description).toContain('risk_tier');
  });

  test('creates a spec with canonical risk_tier when --tier is supplied', () => {
    const root = mkRepo();

    const result = runCreate(root, {
      id: 'TIER-ALIAS-001',
      title: 'Tier alias',
      mode: 'chore',
      tier: 3,
      scopeIn: ['packages/example.ts'],
    });

    expect(result.code).toBe(0);
    const spec = readBytes(specPath(root, 'TIER-ALIAS-001'));
    expect(spec).toContain('risk_tier: 3');
    expect(spec).toContain('mode: chore');
    expect(readBytes(eventsPath(root))).toContain('spec_created');
  });

  test('plan mode accepts --tier and remains read-only', () => {
    const root = mkRepo();

    const result = runCreate(root, {
      id: 'TIER-PLAN-001',
      title: 'Tier plan',
      mode: 'feature',
      tier: '3',
      scopeIn: ['src/foo.ts'],
      plan: true,
      json: true,
    });
    const json = JSON.parse(result.out);

    expect(result.code).toBe(0);
    expect(json).toMatchObject({
      ok: true,
      dry_run: true,
      read_only: true,
      id: 'TIER-PLAN-001',
      valid: true,
    });
    expect(json.candidate.risk_tier).toBe(3);
    expect(fs.existsSync(specPath(root, 'TIER-PLAN-001'))).toBe(false);
    expect(fs.existsSync(eventsPath(root))).toBe(false);
  });

  test('refuses --risk-tier plus --tier before mutation', () => {
    const root = mkRepo();
    const before = snapshot(root, 'TIER-CONFLICT-001');

    const result = runCreate(root, {
      id: 'TIER-CONFLICT-001',
      title: 'Tier conflict',
      mode: 'chore',
      riskTier: 3,
      tier: 3,
    });

    expect(result.code).toBe(1);
    expect(result.err).toContain('--risk-tier and --tier both write risk_tier');
    expect(snapshot(root, 'TIER-CONFLICT-001')).toEqual(before);
  });
});
