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
    env: {},
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
  test('help metadata shows contract tuple shape, example, without a tier requirement', () => {
    const create = specsCreateMeta();
    const contract = create.options.find((option) => option.flag === '--contract <spec>');

    expect(contract.description).toContain('"name:type[:path]"');
    expect(contract.description).toContain('--contract "core-api:behavior"');
    expect(contract.description).not.toMatch(/tier/i);
  });

  test('invalid inverted contract tuple prints accepted shape and corrected example', () => {
    const root = mkRepo();
    const result = runCreate(root, {
      id: 'BAD-CONTRACT-001',
      title: 'Bad contract',
      mode: 'feature',
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
    expect(result.err).toContain('Did you mean --contract "verifychain-detects-tamper:behavior"?');
  });

  test('create without optional contracts succeeds without a retry demand', () => {
    const root = mkRepo();
    const result = runCreate(root, {
      id: 'NO-CONTRACT-001',
      title: 'No boundary',
      mode: 'feature',
    });
    expect(result.code).toBe(0);
    expect(result.err).not.toContain('Retry:');
    expect(result.out).not.toMatch(/tier/i);
  });

  test('create with a malformed contract still prints the contract retry hint', () => {
    const root = mkRepo();
    const result = runCreate(root, {
      id: 'MALFORMED-CONTRACT-001',
      title: 'Malformed contract',
      mode: 'feature',
      contract: ['bare-token-without-colon'],
    });

    expect(result.code).toBe(1);
    // The hint should reach the operator regardless of malformed input.
    expect(result.err).toContain('Contract shape:');
  });
});
