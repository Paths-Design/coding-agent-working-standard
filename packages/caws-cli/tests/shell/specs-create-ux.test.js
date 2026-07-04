'use strict';

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

function specsCreateMeta() {
  const specs = COMMAND_SURFACE_METADATA.find((command) => command.name === 'specs');
  return specs.subcommands.find((subcommand) => subcommand.name === 'create');
}

describe('caws specs create UX diagnostics', () => {
  test('help metadata shows contract tuple shape, example, and tier requirement', () => {
    const create = specsCreateMeta();
    const contract = create.options.find((option) => option.flag === '--contract <spec>');

    expect(contract.description).toContain('"name:type[:path]"');
    expect(contract.description).toContain('--contract "core-api:behavior"');
    expect(contract.description).toContain('Tier 1/2 specs REQUIRE at least one contract');
  });

  test('invalid inverted contract tuple prints accepted shape and corrected example', () => {
    const root = mkRepo();
    const result = runCreate(root, {
      id: 'BAD-CONTRACT-001',
      title: 'Bad contract',
      mode: 'feature',
      riskTier: 2,
      contract: ['behavior:verifychain-detects-tamper'],
    });

    expect(result.code).toBe(1);
    expect(result.err).toContain(
      'type "verifychain-detects-tamper" is not one of api, schema, contract-test, behavior'
    );
    expect(result.err).toContain(
      'Contract shape: {name, type: api|schema|contract-test|behavior, path?, description?}'
    );
    expect(result.err).toContain('Example: --contract "core-api:behavior"');
    expect(result.err).toContain(
      'Did you mean --contract "verifychain-detects-tamper:behavior"?'
    );
  });
});
