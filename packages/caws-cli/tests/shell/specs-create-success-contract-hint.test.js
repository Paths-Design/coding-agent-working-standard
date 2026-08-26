'use strict';

/**
 * CAWS-SPECS-CREATE-SUCCESS-CONTRACT-HINT-001 — a successful `caws specs
 * create` must not state a requirement that is satisfied or inapplicable.
 *
 * The success path closed with an unconditional
 * "Tier 1/2 specs require at least one contract." That sentence was false in
 * every state it could reach: a tier-1/2 create is REFUSED without contracts,
 * so on success the contracts are already there; a tier-3 create is not
 * governed by the rule at all; and the one reachable carve-out (tier-1/2 with
 * mode: chore, which writes `contracts: []`) is exempt because of the mode, not
 * short of a requirement.
 *
 * Being the final stdout line is what made it expensive rather than merely
 * untidy: an agent reading the tail of an exit-0 create saw a requirement
 * failure, concluded the command had failed, found the spec on disk anyway,
 * and hand-authored the YAML — bypassing spec_created and the audit commit.
 * So the last line of a successful create is pinned too, not just the claim.
 */

const path = require('path');
const { spawnSync } = require('child_process');

const { initProject } = require('../../dist/store/init-store');
const { runSpecsCreateCommand } = require('../../dist/shell/commands/specs');
const { cleanupAll, makeTempRepo } = require('../helpers/git-repo-factory');

const CLI = path.resolve(__dirname, '..', '..', 'dist', 'index.js');

/** The claim under test: a requirement stated on a path that satisfied it. */
const CONTRACT_REQUIREMENT_CLAIM = 'require at least one contract';

afterAll(() => {
  cleanupAll();
});

function setupRepo() {
  const root = makeTempRepo();
  const initialized = initProject(root);
  if (!initialized.ok) throw new Error('initProject failed');
  return { root, cawsDir: path.join(root, '.caws') };
}

/** The tier-1 trio, required by the kernel for every tier-1 create. */
const TIER1_FIELDS = {
  observability: ['Log the decision path for each governed operation.'],
  rollback: ['Revert the implementation commit.'],
  security: ['No secret material is logged.'],
};

function runCreate(cwd, id, opts = {}) {
  const out = [];
  const err = [];
  const code = runSpecsCreateCommand({
    cwd,
    now: () => new Date('2026-08-25T12:00:00.000Z'),
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'test-session' },
    id,
    title: 'contract hint fixture',
    mode: 'chore',
    riskTier: '3',
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    ...opts,
  });
  return { code, lines: out, out: out.join('\n'), err: err.join('\n') };
}

describe('a successful create does not state an unmet contract requirement', () => {
  test('tier-2 create that supplied --contract is not told it needs a contract', () => {
    const { root } = setupRepo();

    const result = runCreate(root, 'HINT-TIER2-001', {
      mode: 'fix',
      riskTier: '2',
      contract: ['core-api:behavior:packages/caws-cli/src/index.ts'],
    });

    expect(result.code).toBe(0);
    // The contract is in the written spec; telling the operator it is missing
    // is the CLI contradicting the file it just wrote.
    expect(result.out).not.toContain(CONTRACT_REQUIREMENT_CLAIM);
  });

  test('tier-1 create that supplied --contract is not told it needs a contract', () => {
    const { root } = setupRepo();

    const result = runCreate(root, 'HINT-TIER1-002', {
      mode: 'fix',
      riskTier: '1',
      contract: ['core-api:behavior'],
      ...TIER1_FIELDS,
    });

    expect(result.code).toBe(0);
    expect(result.out).not.toContain(CONTRACT_REQUIREMENT_CLAIM);
  });

  test('tier-3 create is not told about a tier-1/2 rule that cannot apply to it', () => {
    const { root } = setupRepo();

    const result = runCreate(root, 'HINT-TIER3-003');

    expect(result.code).toBe(0);
    expect(result.out).not.toContain(CONTRACT_REQUIREMENT_CLAIM);
    expect(result.out).not.toContain('Tier 1/2');
  });

  test('tier-1 chore create is told the mode waives contracts, not that one is missing', () => {
    const { root } = setupRepo();

    // The only reachable success state with `contracts: []` on a tier-1/2 spec.
    // Contracts are waived here BY THE MODE; saying "requires at least one"
    // describes a rule this spec is exempt from.
    const result = runCreate(root, 'HINT-CHORE-004', {
      mode: 'chore',
      riskTier: '1',
      ...TIER1_FIELDS,
    });

    expect(result.code).toBe(0);
    expect(result.out).not.toContain(CONTRACT_REQUIREMENT_CLAIM);
    expect(result.out).toContain('mode: chore');
    expect(result.out).toContain('--contract');
  });
});

describe('the last line of a successful create is an actionable next step', () => {
  // The tail-read failure mode: whatever this line says IS the result, for any
  // reader piping through `tail`. A caveat here reads as a verdict.
  test.each([
    ['tier-3', 'HINT-LAST-TIER3-005', {}],
    [
      'tier-2 with contract',
      'HINT-LAST-TIER2-006',
      { mode: 'fix', riskTier: '2', contract: ['core-api:behavior'] },
    ],
    ['tier-1 chore', 'HINT-LAST-CHORE-007', { mode: 'chore', riskTier: '1', ...TIER1_FIELDS }],
  ])('%s: the final stdout line does not read as a requirement failure', (_label, id, opts) => {
    const { root } = setupRepo();

    const result = runCreate(root, id, opts);

    expect(result.code).toBe(0);
    const lastLine = result.lines[result.lines.length - 1];
    expect(lastLine).not.toContain('require');
    expect(lastLine).not.toContain(CONTRACT_REQUIREMENT_CLAIM);
  });
});

describe('the failure path keeps the contract remediation it needs', () => {
  test('a tier-2 create with no contract still gets the shape and a retry command', () => {
    const { root } = setupRepo();

    // This is the state the orientation was written for, and the only one where
    // it is true. Removing it from the success path must not remove it here.
    const result = runCreate(root, 'HINT-REFUSED-006', { mode: 'fix', riskTier: '2' });

    expect(result.code).toBe(1);
    expect(result.err).toContain(CONTRACT_REQUIREMENT_CLAIM);
    expect(result.err).toContain('--contract "name:type[:path]"');
    expect(result.err).toContain('Retry: caws specs create HINT-REFUSED-006');
  });
});

describe('the behavior survives Commander parsing', () => {
  test('spawned CLI: a tier-2 create with --contract prints no requirement claim', () => {
    const { root } = setupRepo();

    // Handler-level assertions cannot see a register.ts mapping that drops
    // --contract; only a full-parse-path run distinguishes "the flag reached
    // the writer" from "the flag parsed".
    const result = spawnSync(
      process.execPath,
      [
        CLI, 'specs', 'create', 'HINT-SPAWN-007',
        '--title', 'spawned contract hint fixture',
        '--mode', 'fix',
        '--risk-tier', '2',
        '--contract', 'core-api:behavior:packages/caws-cli/src/index.ts',
      ],
      {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, CAWS_QUIET: '1', CLAUDE_CODE_SESSION_ID: 'test-session' },
      }
    );

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain(CONTRACT_REQUIREMENT_CLAIM);

    const stdoutLines = result.stdout.split('\n').filter((l) => l.trim().length > 0);
    expect(stdoutLines[stdoutLines.length - 1]).not.toContain('require');
  });
});
