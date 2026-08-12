'use strict';

/**
 * A tier-1 spec is creatable through the CLI
 * (CAWS-DEFECT-SPECS-CREATE-AUTHORING-01, Sterling ledger N15).
 *
 * The defect this suite pins: `specs create --risk-tier 1` refused with
 * requirements its own flag surface could not satisfy. The ledger named
 * non_functional.security; the validator actually demands THREE fields —
 * observability, rollback, and non_functional.security (verified by running
 * the pre-fix binary: all three errors emit together). None had a flag, so the
 * only route to a tier-1 spec was hand-writing the YAML, bypassing the template
 * discipline `create` exists to enforce.
 *
 * The fix adds --observability, --rollback, and --security (each repeatable).
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { runSpecsCreateCommand } = require('../../dist/shell/commands/specs');
const { initProject } = require('../../dist/store/init-store');
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

function runCreate(root, id, opts = {}) {
  const out = [];
  const err = [];
  const code = runSpecsCreateCommand({
    cwd: root,
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'specs-create-security-test' },
    id,
    title: 'tier one fixture',
    mode: 'feature',
    riskTier: '1',
    contract: ['core-api:api'],
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    now: () => new Date('2026-08-12T00:00:00.000Z'),
    ...opts,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

function readSpec(cawsDir, id) {
  const p = path.join(cawsDir, 'specs', `${id}.yaml`);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

const TIER1_FLAGS = {
  observability: ['Log the refusal reason for each governed operation.'],
  rollback: ['Revert the implementation commit and rerun caws doctor.'],
  security: ['No new secret material is logged or persisted.'],
};

describe('caws specs create --risk-tier 1 is satisfiable from the CLI', () => {
  test('supplying all three tier-1 fields creates a valid spec', () => {
    const { root, cawsDir } = mkRepo();

    const result = runCreate(root, 'TIER1-001', TIER1_FLAGS);

    // HEADLINE: before the fix this was unreachable — the validator demanded
    // three fields the command surface could not supply.
    expect(result.code).toBe(0);
    const spec = readSpec(cawsDir, 'TIER1-001');
    expect(spec).toContain('risk_tier: 1');
    expect(spec).toContain('observability:');
    expect(spec).toContain('Log the refusal reason for each governed operation.');
    expect(spec).toContain('rollback:');
    expect(spec).toContain('Revert the implementation commit and rerun caws doctor.');
    expect(spec).toContain('non_functional:');
    expect(spec).toContain('  security:');
    expect(spec).toContain('No new secret material is logged or persisted.');
    // The scaffold's empty-map form must NOT survive alongside the real block.
    expect(spec).not.toContain('non_functional: {}');
  });

  test('each flag is repeatable and preserves caller order', () => {
    const { root, cawsDir } = mkRepo();

    const result = runCreate(root, 'TIER1-002', {
      observability: ['first observability', 'second observability'],
      rollback: ['first rollback', 'second rollback'],
      security: ['first security', 'second security'],
    });

    expect(result.code).toBe(0);
    const spec = readSpec(cawsDir, 'TIER1-002');
    for (const v of ['first observability', 'second observability', 'first rollback',
      'second rollback', 'first security', 'second security']) {
      expect(spec).toContain(v);
    }
    expect(spec.indexOf('first security')).toBeLessThan(spec.indexOf('second security'));
  });

  test('the created tier-1 spec passes caws specs validate, not just create', () => {
    const { root } = mkRepo();
    runCreate(root, 'TIER1-003', TIER1_FLAGS);

    // create writing a body the validator would reject would be a half-fix:
    // valid enough to land, invalid at the next gate run.
    const validated = spawnSync(
      process.execPath,
      [CLI, 'specs', 'validate', '.caws/specs/TIER1-003.yaml'],
      { cwd: root, encoding: 'utf8', env: { ...process.env, CAWS_QUIET: '1' } }
    );

    expect(validated.status).toBe(0);
    expect(validated.stdout).toContain('is valid');
  });

  // CAWS-DEFECT-SPECS-CREATE-AUTHORING-01 / register.ts opt-forwarding: a flag
  // Commander parses is NOT necessarily a flag the handler receives. The
  // handler tests above would all pass with the register.ts mapping missing,
  // so the flags are proven once through the full parse path.
  test('the flags survive the full CLI parse path, not just the handler', () => {
    const { root } = mkRepo();

    const created = spawnSync(
      process.execPath,
      [
        CLI, 'specs', 'create', 'TIER1-004',
        '--title', 'full parse path',
        '--mode', 'feature',
        '--risk-tier', '1',
        '--contract', 'core-api:api',
        '--observability', 'obs via CLI',
        '--rollback', 'rb via CLI',
        '--security', 'sec via CLI',
      ],
      {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, CAWS_QUIET: '1', CLAUDE_CODE_SESSION_ID: 'tier1-cli-test' },
      }
    );

    expect(created.status).toBe(0);
    const spec = fs.readFileSync(path.join(root, '.caws', 'specs', 'TIER1-004.yaml'), 'utf8');
    expect(spec).toContain('obs via CLI');
    expect(spec).toContain('rb via CLI');
    expect(spec).toContain('sec via CLI');
  });
});

describe('the refusal names the flags that satisfy it', () => {
  test('a tier-1 create with no tier-1 flags is refused and names all three', () => {
    const { root, cawsDir } = mkRepo();

    const result = runCreate(root, 'TIER1-101', {});

    expect(result.code).not.toBe(0);
    expect(readSpec(cawsDir, 'TIER1-101')).toBeNull();
    // An operator must not have to discover that the surface can meet its own
    // demand — the refusal names the flags.
    expect(result.err).toContain('--observability');
    expect(result.err).toContain('--rollback');
    expect(result.err).toContain('--security');
  });

  test('a partial tier-1 create names only the flags still missing', () => {
    const { root } = mkRepo();

    const result = runCreate(root, 'TIER1-102', { security: ['only security supplied'] });

    expect(result.code).not.toBe(0);
    expect(result.err).toContain('--observability');
    expect(result.err).toContain('--rollback');
    // security was supplied; re-prescribing it would send the operator to
    // re-pass a flag they already passed.
    expect(result.err).not.toContain('--security');
  });
});

describe('lower tiers are unaffected', () => {
  test('a tier-3 chore spec still creates with no tier-1 flags and renders non_functional: {}', () => {
    const { root, cawsDir } = mkRepo();

    const result = runCreate(root, 'TIER3-001', {
      mode: 'chore',
      riskTier: '3',
      contract: undefined,
    });

    expect(result.code).toBe(0);
    const spec = readSpec(cawsDir, 'TIER3-001');
    expect(spec).toContain('non_functional: {}');
    expect(spec).not.toContain('observability:');
  });

  test('a tier-3 spec may still supply the fields voluntarily', () => {
    const { root, cawsDir } = mkRepo();

    const result = runCreate(root, 'TIER3-002', {
      mode: 'chore',
      riskTier: '3',
      contract: undefined,
      security: ['voluntary on tier 3'],
    });

    expect(result.code).toBe(0);
    expect(readSpec(cawsDir, 'TIER3-002')).toContain('voluntary on tier 3');
  });
});
