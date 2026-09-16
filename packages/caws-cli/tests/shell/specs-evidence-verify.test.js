'use strict';

/**
 * caws specs evidence --verify (CAWS-SPECS-VERIFY-ACS-REDERIVE-001):
 * A4 (record-time half: a pass whose citation does not re-derive is refused
 * and nothing is written), A14 (the flag exists on the built artifact).
 *
 * The staleness half of A4 — record with --verify, break the test, close —
 * is pinned in specs-close-rederive.test.js. Here the claim is narrower:
 * --verify runs the cited check at the moment the claim is made, refuses a
 * refuted pass, records a verified one, and labels an unverifiable one.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { runSpecsEvidenceCommand } = require('../../dist/shell/commands/specs');
const { initProject } = require('../../dist/store/init-store');
const { cleanupAll, makeTempRepo, git } = require('../helpers/git-repo-factory');

afterAll(() => {
  cleanupAll();
});

const CLI = path.resolve(__dirname, '..', '..', 'dist', 'index.js');
const JEST_BIN = fs.realpathSync(path.resolve(__dirname, '../../../../node_modules/.bin/jest'));
const SPEC_ID = 'EVIDENCE-VERIFY-FIXTURE-001';

function write(root, rel, content) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

function specYaml(id) {
  return `id: ${id}
title: 'evidence --verify fixture'
risk_tier: 3
mode: chore
lifecycle_state: active
created_at: '2026-09-16T00:00:00.000Z'
updated_at: '2026-09-16T00:00:00.000Z'
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
    given: 'fixture'
    when: 'fixture'
    then: 'fixture'
  - id: A2
    given: 'fixture'
    when: 'fixture'
    then: 'fixture'
non_functional: {}
contracts: []
`;
}

function mkProject() {
  const root = makeTempRepo();
  const initialized = initProject(root);
  if (!initialized.ok) throw new Error('initProject failed: ' + JSON.stringify(initialized.errors));
  write(root, `.caws/specs/${SPEC_ID}.yaml`, specYaml(SPEC_ID));
  write(root, 'js/jest.config.js', "module.exports = { testEnvironment: 'node' };\n");
  write(
    root,
    'js/tests/sample.test.js',
    [
      "test('adds', () => { expect(1 + 1).toBe(2); });",
      "test('fails on purpose', () => { expect(1).toBe(2); });",
      '',
    ].join('\n')
  );
  write(root, 'plain/tests/orphan.test.js', "test('x', () => {});\n");
  write(root, 'docs/report.md', '# report\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '--quiet', '--no-verify', '-m', 'fixture']);
  const head = git(root, ['rev-parse', 'HEAD']).trim();
  fs.mkdirSync(path.join(root, 'node_modules', '.bin'), { recursive: true });
  fs.symlinkSync(JEST_BIN, path.join(root, 'node_modules', '.bin', 'jest'));
  return { root, cawsDir: path.join(root, '.caws'), head };
}

function readSpec(cawsDir) {
  return fs.readFileSync(path.join(cawsDir, 'specs', `${SPEC_ID}.yaml`), 'utf8');
}

function acRecordedEvents(cawsDir) {
  const p = path.join(cawsDir, 'events.jsonl');
  // No log at all is the strongest form of "nothing was recorded".
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e) => e.event === 'ac_recorded');
}

function runEvidence(root, opts) {
  const out = [];
  const err = [];
  const code = runSpecsEvidenceCommand({
    cwd: root,
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'specs-evidence-verify-test' },
    id: SPEC_ID,
    ac: 'A1',
    status: 'pass',
    evidenceRef: 'narrative',
    now: () => new Date('2026-09-16T12:00:00.000Z'),
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    showData: true,
    ...opts,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

function spawnCli(root, args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'specs-evidence-verify-test' },
  });
}

describe('caws specs evidence --verify (A4 record-time, A14)', () => {
  test('--help through dist lists --verify', () => {
    const { root } = mkProject();
    const r = spawnCli(root, ['specs', 'evidence', '--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('--verify');
    // Commander re-wraps option help; compare on collapsed whitespace.
    expect(r.stdout.replace(/\s+/g, ' ')).toContain(
      'Refuses to record status pass when the citation is refuted'
    );
  });

  test('dist: a pass citing a commit that is no object is REFUSED — exit 1, nothing written to the spec or the event log', () => {
    const { root, cawsDir } = mkProject();
    const before = readSpec(cawsDir);
    const r = spawnCli(root, [
      'specs',
      'evidence',
      SPEC_ID,
      '--ac',
      'A1',
      '--status',
      'pass',
      '--evidence-ref',
      'narrative',
      '--commit-sha',
      'deadbeefcafe',
      '--verify',
    ]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(
      'caws specs evidence --verify: refusing to record status pass for A1 — the cited evidence does not re-derive.'
    );
    expect(r.stderr).toContain(
      'A1: refuted (object_missing) — commit deadbeefcafe is not an object'
    );
    expect(r.stderr).toContain('Nothing was written.');
    expect(r.stdout).not.toContain('recorded evidence');
    expect(readSpec(cawsDir)).toBe(before);
    expect(acRecordedEvents(cawsDir)).toEqual([]);
  });

  test('dist: a pass citing HEAD is verified first, then recorded — exit 0, spec and event both carry the sha', () => {
    const { root, cawsDir, head } = mkProject();
    const r = spawnCli(root, [
      'specs',
      'evidence',
      SPEC_ID,
      '--ac',
      'A1',
      '--status',
      'pass',
      '--evidence-ref',
      'narrative',
      '--commit-sha',
      head,
      '--verify',
    ]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('verified before recording:');
    expect(r.stdout).toContain(
      `A1: verified (passed) — commit ${head} exists and is reachable from refs/heads/main [self-reported]`
    );
    expect(r.stdout).toContain(
      'recorded evidence for EVIDENCE-VERIFY-FIXTURE-001 AC A1 (status: pass)'
    );
    expect(readSpec(cawsDir)).toMatch(new RegExp(`commit_sha: ['"]?${head}['"]?`));
    const events = acRecordedEvents(cawsDir);
    expect(events).toHaveLength(1);
    expect(events[0].data.commit_sha).toBe(head);
  });

  test('--verify EXECUTES the cited test: a green jest test verifies and records; a red one is refused with test_failed', () => {
    const { root, cawsDir } = mkProject();
    const green = runEvidence(root, { testNodeid: 'js/tests/sample.test.js::adds', verify: true });
    expect(green.code).toBe(0);
    expect(green.out).toContain(
      'A1: verified (passed) — jest js/tests/sample.test.js::adds passed [self-reported]'
    );
    // The writer quotes values containing '::'.
    expect(readSpec(cawsDir)).toMatch(/test_nodeid: "?js\/tests\/sample\.test\.js::adds"?/);

    const red = runEvidence(root, {
      ac: 'A2',
      testNodeid: 'js/tests/sample.test.js::fails on purpose',
      verify: true,
    });
    expect(red.code).toBe(1);
    expect(red.err).toContain('refusing to record status pass for A2');
    expect(red.err).toMatch(/A2: refuted \(test_failed\) — jest exit 1:/);
    expect(readSpec(cawsDir)).not.toContain('criterion_id: A2');
    expect(acRecordedEvents(cawsDir)).toHaveLength(1);
  }, 60000);

  test('a nodeid naming a test that does not exist is refused with test_not_found', () => {
    const { root, cawsDir } = mkProject();
    const r = runEvidence(root, {
      testNodeid: 'js/tests/sample.test.js::no such test',
      verify: true,
    });
    expect(r.code).toBe(1);
    expect(r.err).toContain('A1: refuted (test_not_found)');
    expect(readSpec(cawsDir)).not.toContain('criterion_id: A1');
  });

  test('--verify with nothing mechanical to verify is refused, including when only --command is given', () => {
    const { root, cawsDir } = mkProject();
    const bare = runEvidence(root, { verify: true });
    expect(bare.code).toBe(1);
    expect(bare.err).toContain('caws specs evidence --verify: nothing to verify.');
    const cmd = runEvidence(root, { command: 'npm test', exitCode: 0, verify: true });
    expect(cmd.code).toBe(1);
    expect(cmd.err).toContain(
      'a --command is recorded but never executed, so it cannot be verified'
    );
    expect(readSpec(cawsDir)).not.toContain('criterion_id: A1');
    expect(acRecordedEvents(cawsDir)).toEqual([]);
  });

  test('a citation that cannot be re-derived (no runner detectable) is recorded, and named as self-reported on stderr', () => {
    const { root, cawsDir } = mkProject();
    const r = runEvidence(root, { testNodeid: 'plain/tests/orphan.test.js::x', verify: true });
    expect(r.code).toBe(0);
    expect(r.err).toContain(
      'caws specs evidence --verify: A1 could not be mechanically re-derived; recording as self-reported.'
    );
    expect(r.err).toContain('A1: not_rederived (runner_unavailable) — no test runner detected');
    expect(r.out).toContain('recorded evidence for');
    expect(readSpec(cawsDir)).toMatch(/test_nodeid: "?plain\/tests\/orphan\.test\.js::x"?/);
  });

  test('the refusal is only for status pass: --status fail with a refuted citation is recorded as fail', () => {
    const { root, cawsDir } = mkProject();
    const r = runEvidence(root, { status: 'fail', commitSha: 'deadbeefcafe', verify: true });
    expect(r.code).toBe(0);
    expect(r.out).toContain(
      'recorded evidence for EVIDENCE-VERIFY-FIXTURE-001 AC A1 (status: fail)'
    );
    expect(readSpec(cawsDir)).toContain('status: fail');
  });

  test('without --verify nothing is re-derived: the same bogus citation records as pass (the pre-slice behavior, kept)', () => {
    const { root, cawsDir } = mkProject();
    const r = runEvidence(root, { commitSha: 'deadbeefcafe' });
    expect(r.code).toBe(0);
    expect(readSpec(cawsDir)).toContain('commit_sha: deadbeefcafe');
    expect(r.out).not.toContain('verified');
  });
});
