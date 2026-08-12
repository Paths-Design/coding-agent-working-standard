'use strict';

/**
 * AC-evidence warn-mode advisory reaches the operator on the direct close path
 * (CAWS-DEFECT-AC-EVIDENCE-VISIBILITY-01, D2 part 1).
 *
 * The defect this suite pins: closeSpec computes the set of acceptance criteria
 * lacking satisfying evidence and folds a remediation advisory into the success
 * outcome's `warnings`, but runSpecsCloseCommand never read `outcome.warnings`.
 * The gate shipped in warn mode explicitly so it would be "visible to agents
 * immediately" — it was visible to no one. Its sibling
 * runSpecsAmendScopeCommand already prints warnings; this makes close match.
 *
 * Measured motivation (Sterling, 2026-08-11): 1,091 specs closed with no
 * closure ever refused and no warning ever printed.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { runSpecsCloseCommand } = require('../../dist/shell/commands/specs');
const { initProject } = require('../../dist/store/init-store');
const { cleanupAll, git, makeTempRepo } = require('../helpers/git-repo-factory');

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

/**
 * Fixture spec with two declared acceptance criteria. `evidenceBlock` is
 * appended verbatim so each test controls exactly which criteria are satisfied.
 */
function writeActiveSpec(cawsDir, id, evidenceBlock = '') {
  const body = `id: ${id}
title: 'AC evidence advisory fixture'
risk_tier: 3
mode: chore
lifecycle_state: active
created_at: '2026-08-11T00:00:00.000Z'
updated_at: '2026-08-11T00:00:00.000Z'
blast_radius:
  modules:
    - tests
  data_migration: false
operational_rollback_slo: 5m
scope:
  in:
    - tests
  out: []
invariants:
  - 'fixture spec'
acceptance:
  - id: A1
    given: 'fixture given one'
    when: 'fixture when one'
    then: 'fixture then one'
  - id: A2
    given: 'fixture given two'
    when: 'fixture when two'
    then: 'fixture then two'
non_functional: {}
contracts: []
${evidenceBlock}`;
  fs.writeFileSync(path.join(cawsDir, 'specs', `${id}.yaml`), body);
  // Commit the fixture: an uncommitted spec makes the close emit an unrelated
  // "applied but NOT committed" advisory on the same stream we assert on.
  const repoRoot = path.dirname(cawsDir);
  git(repoRoot, ['add', '-A']);
  git(repoRoot, ['commit', '-m', `fixture: ${id}`]);
}

function evidence(entries) {
  return (
    'evidence:\n' +
    entries
      .map(
        (e) =>
          `  - criterion_id: ${e.id}\n` +
          `    status: ${e.status}\n` +
          `    recorded_at: '2026-08-11T00:00:00.000Z'\n` +
          (e.ref !== undefined ? `    evidence_ref: '${e.ref}'\n` : '') +
          (e.waiverReason !== undefined ? `    waiver_reason: '${e.waiverReason}'\n` : '')
      )
      .join('')
  );
}

function runClose(root, id, opts = {}) {
  const out = [];
  const err = [];
  const code = runSpecsCloseCommand({
    cwd: root,
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'specs-close-evidence-warning-test' },
    id,
    resolution: 'completed',
    reason: 'fixture close',
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    now: () => new Date('2026-08-11T12:00:00.000Z'),
    ...opts,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('caws specs close: the AC-evidence warn-mode advisory is printed', () => {
  test('an unsatisfied criterion names its id and the exact remediation command', () => {
    const root = mkRepo();
    const cawsDir = path.join(root, '.caws');
    writeActiveSpec(cawsDir, 'ACWARN-001');

    const result = runClose(root, 'ACWARN-001');

    // Warn mode: the close still succeeds. This is the invariant that keeps
    // warn mode from silently becoming a soft block.
    expect(result.code).toBe(0);
    expect(result.out).toContain('closed ACWARN-001');

    // The advisory itself — the whole point of warn mode.
    expect(result.err).toContain('caws advisory (non-blocking)');
    expect(result.err).toContain('A1');
    expect(result.err).toContain('A2');
    // An advisory that does not name the fix costs the reader a lookup.
    expect(result.err).toContain('caws specs evidence ACWARN-001 --ac A1 --status pass');
  });

  test('a partially-evidenced spec warns about the unsatisfied criterion only', () => {
    const root = mkRepo();
    const cawsDir = path.join(root, '.caws');
    writeActiveSpec(
      cawsDir,
      'ACWARN-002',
      evidence([{ id: 'A1', status: 'pass', ref: 'npx jest specs-close' }])
    );

    const result = runClose(root, 'ACWARN-002');

    expect(result.code).toBe(0);
    expect(result.err).toContain('caws advisory (non-blocking)');
    // A2 is the only unsatisfied criterion; A1 must not appear in the
    // remediation list or the advisory is indiscriminate.
    expect(result.err).toContain('- A2: no evidence recorded');
    expect(result.err).not.toContain('- A1: no evidence recorded');
  });

  test('a "fail" status warns even though evidence exists — fail does not satisfy closure', () => {
    const root = mkRepo();
    const cawsDir = path.join(root, '.caws');
    writeActiveSpec(
      cawsDir,
      'ACWARN-003',
      evidence([
        { id: 'A1', status: 'fail', ref: 'npx jest -t A1' },
        { id: 'A2', status: 'waived', waiverReason: 'covered by A1' },
      ])
    );

    const result = runClose(root, 'ACWARN-003');

    expect(result.code).toBe(0);
    expect(result.err).toContain('A1');
    expect(result.err).toContain('"fail"');
    // waived satisfies the gate, so A2 must not be listed as unsatisfied.
    expect(result.err).not.toMatch(/- A2:/);
  });

  test('a fully-evidenced spec closes with NO evidence advisory', () => {
    const root = mkRepo();
    const cawsDir = path.join(root, '.caws');
    writeActiveSpec(
      cawsDir,
      'ACWARN-004',
      evidence([
        { id: 'A1', status: 'pass', ref: 'npx jest -t A1' },
        { id: 'A2', status: 'waived', waiverReason: 'verified manually by the maintainer' },
      ])
    );

    const result = runClose(root, 'ACWARN-004');

    expect(result.code).toBe(0);
    expect(result.out).toContain('closed ACWARN-004');
    // A constant advisory is noise the reader learns to skip. It must appear
    // only when a criterion is genuinely unsatisfied.
    expect(result.err).not.toContain('lacking satisfying evidence');
    expect(result.err).not.toContain('caws specs evidence ACWARN-004');
  });

  test('spawned CLI prints the advisory on stderr and still exits 0', () => {
    const root = mkRepo();
    const cawsDir = path.join(root, '.caws');
    writeActiveSpec(cawsDir, 'ACWARN-005');

    const result = spawnSync(
      process.execPath,
      [CLI, 'specs', 'close', 'ACWARN-005', '--resolution', 'completed', '--reason', 'fixture'],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          CAWS_QUIET: '1',
          CLAUDE_CODE_SESSION_ID: 'specs-close-evidence-warning-cli-test',
        },
      }
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('closed ACWARN-005');
    expect(result.stderr).toContain('lacking satisfying evidence');
    expect(result.stderr).toContain('caws specs evidence ACWARN-005 --ac A1');
  });
});
