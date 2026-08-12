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

/**
 * CAWS-DEFECT-AC-EVIDENCE-WINDOW-01.
 *
 * The advisory above fires from the SUCCESS outcome — i.e. after the close has
 * already landed. At that instant the spec is closed, so every `caws specs
 * evidence` command the advisory prints is refused by the freeze. A remediation
 * that the CLI itself rejects teaches the reader to treat the advisory as noise;
 * and because the advisory is terminal output, the gap it names dies with the
 * session that closed the spec.
 */
describe('CAWS-DEFECT-AC-EVIDENCE-WINDOW-01: the advisory is achievable and durable', () => {
  test('A1: the advisory names the reopen that makes its own commands runnable', () => {
    const root = mkRepo();
    const cawsDir = path.join(root, '.caws');
    writeActiveSpec(cawsDir, 'ACWIN-001');

    const result = runClose(root, 'ACWIN-001');

    expect(result.code).toBe(0);
    // The prescribed command is refused until the spec is reopened, so the
    // reopen must be named — with the spec id, not as a bare concept.
    expect(result.err).toContain('caws specs reopen ACWIN-001');
    // and the reader must be told WHY the reopen is needed, otherwise the
    // three-step sequence reads as ceremony.
    expect(result.err).toContain('frozen');
    // Ordering is load-bearing: reopen precedes the record, and the re-close
    // follows it. Assert the actual sequence, not just co-presence.
    const reopenAt = result.err.indexOf('caws specs reopen ACWIN-001');
    const recordAt = result.err.indexOf('caws specs evidence ACWIN-001 --ac A1');
    const recloseAt = result.err.indexOf('caws specs close ACWIN-001');
    expect(reopenAt).toBeGreaterThan(-1);
    expect(recordAt).toBeGreaterThan(reopenAt);
    expect(recloseAt).toBeGreaterThan(reopenAt);
  });

  test('A1: the advisory points at --no-close as the way to avoid the round trip', () => {
    const root = mkRepo();
    const cawsDir = path.join(root, '.caws');
    writeActiveSpec(cawsDir, 'ACWIN-002');

    const result = runClose(root, 'ACWIN-002');

    expect(result.err).toContain('caws worktree merge <name> --no-close');
  });

  test('A2: closure_notes carries the operator reason VERBATIM — no machine annotation', () => {
    const root = mkRepo();
    const cawsDir = path.join(root, '.caws');
    writeActiveSpec(
      cawsDir,
      'ACWIN-003',
      evidence([{ id: 'A1', status: 'pass', ref: 'npx jest -t A1' }])
    );

    const result = runClose(root, 'ACWIN-003');
    expect(result.code).toBe(0);

    const onDisk = fs.readFileSync(path.join(cawsDir, 'specs', 'ACWIN-003.yaml'), 'utf8');
    const notesLine = onDisk.split('\n').find((l) => l.startsWith('closure_notes:'));
    // closure_notes is the OPERATOR's field. Appending machine text to it is a
    // softer form of the clobbering CAWS-CLI-MERGE-AUTOCLOSE-PRESERVE-CLOSURE-
    // NOTES-001 forbids, and it broke 12 tests across 6 suites that pin exact
    // content. The gap is recorded on the event and re-derived by `specs show`.
    expect(notesLine).toBe("closure_notes: 'fixture close'");
  });

  test('A2: the closed spec still parses and the reason escape is intact', () => {
    const root = mkRepo();
    const cawsDir = path.join(root, '.caws');
    // A reason carrying a single quote exercises the YAML escape path.
    writeActiveSpec(cawsDir, 'ACWIN-005');
    const result = runClose(root, 'ACWIN-005', { reason: "operator's own notes" });
    expect(result.code).toBe(0);

    const validated = spawnSync(
      process.execPath,
      [CLI, 'specs', 'validate', path.join('.caws', 'specs', 'ACWIN-005.yaml')],
      { cwd: root, encoding: 'utf8', env: { ...process.env, CAWS_QUIET: '1' } }
    );
    expect(validated.status).toBe(0);

    const onDisk = fs.readFileSync(path.join(cawsDir, 'specs', 'ACWIN-005.yaml'), 'utf8');
    expect(onDisk).toContain("closure_notes: 'operator''s own notes'");
  });

  test('A2: caws specs show re-derives the gap on a CLOSED spec', () => {
    const root = mkRepo();
    const cawsDir = path.join(root, '.caws');
    writeActiveSpec(
      cawsDir,
      'ACWIN-004',
      evidence([{ id: 'A1', status: 'pass', ref: 'npx jest -t A1' }])
    );
    expect(runClose(root, 'ACWIN-004').code).toBe(0);

    const shown = spawnSync(process.execPath, [CLI, 'specs', 'show', 'ACWIN-004'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, CAWS_QUIET: '1' },
    });

    expect(shown.status).toBe(0);
    // The spec body itself still goes to stdout unpolluted — this output is
    // piped into editors and parsers.
    expect(shown.stdout).toContain('id: ACWIN-004');
    expect(shown.stdout).not.toContain('caws advisory');
    // The gap reaches a future reader who never saw the closing session.
    expect(shown.stderr).toContain('A2 (missing)');
    expect(shown.stderr).not.toContain('A1 (');
    expect(shown.stderr).toContain('caws specs reopen ACWIN-004');
  });

  test('A2: a fully-evidenced closed spec shows NO advisory', () => {
    const root = mkRepo();
    const cawsDir = path.join(root, '.caws');
    writeActiveSpec(
      cawsDir,
      'ACWIN-008',
      evidence([
        { id: 'A1', status: 'pass', ref: 'npx jest -t A1' },
        { id: 'A2', status: 'waived', waiverReason: 'covered by A1' },
      ])
    );
    expect(runClose(root, 'ACWIN-008').code).toBe(0);

    const shown = spawnSync(process.execPath, [CLI, 'specs', 'show', 'ACWIN-008'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, CAWS_QUIET: '1' },
    });
    expect(shown.status).toBe(0);
    expect(shown.stderr).not.toContain('caws advisory');
  });

  test('A2: an ACTIVE spec with no evidence shows NO advisory — that is normal mid-slice', () => {
    const root = mkRepo();
    const cawsDir = path.join(root, '.caws');
    writeActiveSpec(cawsDir, 'ACWIN-009');

    const shown = spawnSync(process.execPath, [CLI, 'specs', 'show', 'ACWIN-009'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, CAWS_QUIET: '1' },
    });
    expect(shown.status).toBe(0);
    // Warning on every active spec would make the advisory constant, and a
    // constant advisory is one readers learn to skip.
    expect(shown.stderr).not.toContain('caws advisory');
  });

  test('A2: the derivation is not stale — recording evidence after a reopen clears it', () => {
    const root = mkRepo();
    const cawsDir = path.join(root, '.caws');
    writeActiveSpec(cawsDir, 'ACWIN-010');
    expect(runClose(root, 'ACWIN-010').code).toBe(0);

    const env = { ...process.env, CAWS_QUIET: '1', CLAUDE_CODE_SESSION_ID: 'acwin-restale' };
    const run = (args) => spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8', env });

    expect(run(['specs', 'reopen', 'ACWIN-010', '--reason', 'recording missed evidence']).status).toBe(0);
    for (const ac of ['A1', 'A2']) {
      expect(
        run(['specs', 'evidence', 'ACWIN-010', '--ac', ac, '--status', 'pass', '--evidence-ref', 'npx jest']).status
      ).toBe(0);
    }
    expect(run(['specs', 'close', 'ACWIN-010', '--resolution', 'completed', '--reason', 'evidence in']).status).toBe(0);

    // THIS is why the list is derived and not stored: a field written at the
    // FIRST close would still name A1 and A2 as gaps after they were filled.
    const shown = run(['specs', 'show', 'ACWIN-010']);
    expect(shown.status).toBe(0);
    expect(shown.stderr).not.toContain('caws advisory');
  });

  test('A2: the spec_closed event closure_notes is the operator reason, unannotated', () => {
    const root = mkRepo();
    const cawsDir = path.join(root, '.caws');
    writeActiveSpec(cawsDir, 'ACWIN-006');
    expect(runClose(root, 'ACWIN-006').code).toBe(0);

    const events = fs
      .readFileSync(path.join(cawsDir, 'events.jsonl'), 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l));
    const closed = events.filter((e) => e.event === 'spec_closed' && e.spec_id === 'ACWIN-006');
    expect(closed).toHaveLength(1);
    // `closure_notes` means the same thing on the event as in the YAML: what
    // the operator said. Overloading either with a machine gap report is the
    // same mistake in two places.
    expect(closed[0].data.closure_notes).toBe('fixture close');

    // The close-time state remains recoverable from the chain itself: no
    // ac_recorded event for this spec precedes the spec_closed.
    const acBefore = events.filter(
      (e) => e.event === 'ac_recorded' && e.spec_id === 'ACWIN-006'
    );
    expect(acBefore).toHaveLength(0);
  });

  test('A5: the freeze is preserved — evidence against a CLOSED spec is still refused', () => {
    const root = mkRepo();
    const cawsDir = path.join(root, '.caws');
    writeActiveSpec(cawsDir, 'ACWIN-007');
    expect(runClose(root, 'ACWIN-007').code).toBe(0);

    const attempt = spawnSync(
      process.execPath,
      [
        CLI, 'specs', 'evidence', 'ACWIN-007',
        '--ac', 'A1', '--status', 'pass', '--evidence-ref', 'npx jest -t A1',
      ],
      {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, CAWS_QUIET: '1', CLAUDE_CODE_SESSION_ID: 'acwin-freeze-test' },
      }
    );

    // This slice widens the window BEFORE the freeze; it must not open the
    // freeze itself. If this ever goes green with status 0, closed specs have
    // become editable and the closure authority is no longer authoritative.
    expect(attempt.status).not.toBe(0);
    const combined = `${attempt.stdout}${attempt.stderr}`;
    expect(combined).toMatch(/active or draft|closed/i);

    // And the spec's evidence block on disk is unchanged by the refused write.
    const onDisk = fs.readFileSync(path.join(cawsDir, 'specs', 'ACWIN-007.yaml'), 'utf8');
    expect(onDisk).not.toContain('criterion_id: A1');
  });
});
