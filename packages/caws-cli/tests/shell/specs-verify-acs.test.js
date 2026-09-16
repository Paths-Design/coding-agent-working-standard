'use strict';

/**
 * caws specs verify-acs (CAWS-SPECS-VERIFY-ACS-REDERIVE-001):
 * A1 (existence ≠ pass), A2 (no verdict collapse), A5 (command never runs),
 * A7 (argv injection refused), A12 (self-report visible), A13 (no false green
 * on infrastructure failure), A14 (flags exist on the built artifact).
 *
 * Handler tests bypass Commander (register.ts opt-forward false confidence),
 * so every flag is ALSO exercised once through dist/index.js. The evidence
 * block is written through the real writer (recordSpecEvidence), never by
 * hand, so what verify-acs reads is what `caws specs evidence` produces.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  runSpecsVerifyAcsCommand,
  verifyAcsVerdictLine,
  verifyAcsExitCode,
  VERIFY_ACS_SCHEMA,
} = require('../../dist/shell/commands/specs');
const { recordSpecEvidence } = require('../../dist/store/specs-writer');
const { initProject } = require('../../dist/store/init-store');
const { resetGitBinaryCache } = require('../../dist/store/git-binary');
const { SELECTABLE_TEST_RUNNERS } = require('../../dist/store/evidence-rederive');
const { COMMAND_SURFACE_METADATA } = require('../../dist/shell/command-metadata');
const { isOk } = require('../../dist/kernel');
const { cleanupAll, makeTempRepo, git } = require('../helpers/git-repo-factory');

afterAll(() => {
  cleanupAll();
});

const CLI = path.resolve(__dirname, '..', '..', 'dist', 'index.js');
const JEST_BIN = fs.realpathSync(path.resolve(__dirname, '../../../../node_modules/.bin/jest'));
const ACTOR = { kind: 'agent', id: 'jest', platform: 'jest' };
const NOW = () => new Date('2026-09-16T12:00:00.000Z');
const SPEC_ID = 'VERIFY-ACS-FIXTURE-001';

function write(root, rel, content) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

function specYaml(id) {
  return `id: ${id}
title: 'verify-acs fixture'
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
  - id: A3
    given: 'fixture'
    when: 'fixture'
    then: 'fixture'
non_functional: {}
contracts: []
`;
}

/**
 * A CAWS project with an active three-criterion spec, a jest package under
 * js/ (one passing + one failing test), a test file under plain/ with no
 * runner config above it, and everything committed so HEAD is a real
 * citation.
 */
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

function record(cawsDir, criterionId, fields) {
  const r = recordSpecEvidence(cawsDir, {
    id: SPEC_ID,
    criterionId,
    status: 'pass',
    evidenceRef: `narrative for ${criterionId}`,
    now: NOW,
    actor: ACTOR,
    ...fields,
  });
  if (!isOk(r)) throw new Error('recordSpecEvidence failed: ' + JSON.stringify(r.errors));
  if (r.value.kind !== 'success') throw new Error('recordSpecEvidence: ' + r.value.kind);
}

function runVerify(root, opts = {}) {
  const out = [];
  const err = [];
  const code = runSpecsVerifyAcsCommand({
    cwd: root,
    id: SPEC_ID,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    showData: true,
    ...opts,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

function spawnCli(root, args, envExtra = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'specs-verify-acs-test', ...envExtra },
  });
}

function snapshot(cawsDir) {
  return {
    spec: fs.readFileSync(path.join(cawsDir, 'specs', `${SPEC_ID}.yaml`), 'utf8'),
    events: fs.readFileSync(path.join(cawsDir, 'events.jsonl'), 'utf8'),
  };
}

// ─── A2 + A12: three verdicts, never collapsed; self-report visible ──────────

describe('three verdicts, never collapsed (A2) and self-report labeling (A12)', () => {
  test('one verified, one refuted, one narrative -> 1/1/1 in --json through dist, exit 1', () => {
    const { root, cawsDir, head } = mkProject();
    record(cawsDir, 'A1', { commitSha: head });
    record(cawsDir, 'A2', { artifactPath: 'docs/nope.md' });
    record(cawsDir, 'A3', {});

    const r = spawnCli(root, ['specs', 'verify-acs', SPEC_ID, '--json']);
    expect(r.status).toBe(1);
    const payload = JSON.parse(r.stdout);
    expect(payload.schema).toBe(VERIFY_ACS_SCHEMA);
    expect(payload.schema).toBe('verify-acs.v1');
    expect(payload.id).toBe(SPEC_ID);
    expect(payload.mode).toBe('exists');
    expect(payload.strict).toBe(false);
    expect(payload.exit_code).toBe(1);
    expect(payload.summary).toEqual({
      total: 3,
      verified: 1,
      refuted: 1,
      not_rederived: 1,
      narrative_only: 1,
      self_reported: 2,
      command_declared: 0,
    });
    const byId = Object.fromEntries(payload.criteria.map((c) => [c.id, c]));
    expect(byId.A1.verdict).toBe('verified');
    expect(byId.A1.reason).toBe('passed');
    expect(byId.A1.self_reported).toBe(true);
    expect(byId.A2.verdict).toBe('refuted');
    expect(byId.A2.reason).toBe('artifact_missing');
    expect(byId.A2.self_reported).toBe(true);
    expect(byId.A3.verdict).toBe('not_rederived');
    expect(byId.A3.reason).toBe('no_mechanical_field');
    expect(byId.A3.self_reported).toBe(false);
  });

  test('the printed summary carries the same 1/1/1 and the REFUTED verdict line; the table marks self-reported rows', () => {
    const { root, cawsDir, head } = mkProject();
    record(cawsDir, 'A1', { commitSha: head });
    record(cawsDir, 'A2', { artifactPath: 'docs/nope.md' });
    record(cawsDir, 'A3', {});

    const r = runVerify(root);
    expect(r.code).toBe(1);
    expect(r.out).toContain(
      'summary: 3 criteria — verified 1, refuted 1, not_rederived 1 (narrative-only 1, self-reported 2, command declared 0)'
    );
    expect(r.out).toContain(
      'verdict: REFUTED — 1 criterion/criteria cite evidence that does not re-derive; unverifiable: 1 (not counted as pass)'
    );
    expect(r.out).toMatch(
      /A1: verified \(passed\) — commit [0-9a-f]{40} exists and is reachable from refs\/heads\/main \[self-reported\]/
    );
    expect(r.out).toContain(
      'A2: refuted (artifact_missing) — docs/nope.md not found at HEAD [self-reported]'
    );
    expect(r.out).toContain('A3: not_rederived (no_mechanical_field)');
    expect(r.out).not.toContain('A3: not_rederived (no_mechanical_field) — ');
    expect(r.out).not.toContain('all mechanically-verifiable ACs passed');
  });

  test('verify-acs is read-only: spec bytes and events.jsonl are identical before and after', () => {
    const { root, cawsDir, head } = mkProject();
    record(cawsDir, 'A1', { commitSha: head });
    record(cawsDir, 'A2', { artifactPath: 'docs/nope.md' });
    const before = snapshot(cawsDir);
    runVerify(root);
    runVerify(root, { run: true, strict: true });
    spawnCli(root, ['specs', 'verify-acs', SPEC_ID, '--run', '--json']);
    expect(snapshot(cawsDir)).toEqual(before);
  });
});

// ─── A1: existence ≠ pass ─────────────────────────────────────────────────────

describe('existence is not execution (A1)', () => {
  test('a cited passing test in default mode is not_rederived/not_run — and never verified', () => {
    const { root, cawsDir } = mkProject();
    record(cawsDir, 'A1', { testNodeid: 'js/tests/sample.test.js::adds' });
    record(cawsDir, 'A2', {});
    record(cawsDir, 'A3', {});

    const r = runVerify(root);
    expect(r.code).toBe(0);
    expect(r.out).toContain(
      'mode: exists — cited tests located, not executed; pass --run to execute'
    );
    expect(r.out).toContain(
      'A1: not_rederived (not_run) — test file and name present; not executed [self-reported]'
    );
    expect(r.out).toContain(
      'verdict: nothing was mechanically verified; unverifiable: 3 (not counted as pass)'
    );
    expect(r.out).not.toContain('verified (');
  });

  test('a cited FAILING test in default mode is ALSO not_rederived — collected is neither pass nor fail', () => {
    const { root, cawsDir } = mkProject();
    record(cawsDir, 'A1', { testNodeid: 'js/tests/sample.test.js::fails on purpose' });
    const r = runVerify(root);
    expect(r.code).toBe(0);
    expect(r.out).toContain('A1: not_rederived (not_run)');
    expect(r.out).not.toContain('A1: refuted');
    expect(r.out).toContain('verified 0, refuted 0, not_rederived 3');
  });

  test('--strict turns the unverifiable count into exit 1 and says so', () => {
    const { root, cawsDir } = mkProject();
    record(cawsDir, 'A1', { testNodeid: 'js/tests/sample.test.js::adds' });
    const r = runVerify(root, { strict: true });
    expect(r.code).toBe(1);
    expect(r.out).toContain('strict: 3 not_rederived criterion/criteria → exit 1');
  });

  test('--run through dist: the passing test verifies, exit 0; the failing test refutes with test_failed, exit 1', () => {
    const { root, cawsDir } = mkProject();
    record(cawsDir, 'A1', { testNodeid: 'js/tests/sample.test.js::adds' });
    record(cawsDir, 'A2', { testNodeid: 'js/tests/sample.test.js::fails on purpose' });
    record(cawsDir, 'A3', {});

    const r = spawnCli(root, ['specs', 'verify-acs', SPEC_ID, '--run', '--json']);
    expect(r.status).toBe(1);
    const payload = JSON.parse(r.stdout);
    expect(payload.mode).toBe('run');
    const byId = Object.fromEntries(payload.criteria.map((c) => [c.id, c]));
    expect(byId.A1.verdict).toBe('verified');
    expect(byId.A1.checks[0]).toMatchObject({
      class: 'test',
      verdict: 'verified',
      reason: 'passed',
    });
    expect(byId.A2.verdict).toBe('refuted');
    expect(byId.A2.reason).toBe('test_failed');
    expect(byId.A2.checks[0].detail).toMatch(/^jest exit 1:/);
    expect(payload.summary.verified).toBe(1);
    expect(payload.summary.refuted).toBe(1);
    expect(payload.summary.not_rederived).toBe(1);
  }, 60000);

  test('--run with only passing citations prints the honest qualifier with the unverifiable count beside it', () => {
    const { root, cawsDir, head } = mkProject();
    record(cawsDir, 'A1', { testNodeid: 'js/tests/sample.test.js::adds' });
    record(cawsDir, 'A2', { commitSha: head, artifactPath: 'docs/report.md' });
    const r = runVerify(root, { run: true });
    expect(r.code).toBe(0);
    expect(r.out).toContain(
      'verdict: all mechanically-verifiable ACs passed (2 verified); unverifiable: 1 (not counted as pass)'
    );
  }, 60000);
});

// ─── A5 + A7: nothing agent-authored executes; flags cannot be smuggled ───────

describe('agent-authored strings never execute (A5) and argv injection is refused (A7)', () => {
  test('a recorded command is never run: the probe file is absent, the reason is command_not_executed, the note is printed', () => {
    const { root, cawsDir } = mkProject();
    const probe = path.join(root, 'caws-exec-probe');
    record(cawsDir, 'A1', { command: `touch ${probe}`, exitCode: 0 });

    const text = runVerify(root, { run: true });
    const json = spawnCli(root, ['specs', 'verify-acs', SPEC_ID, '--run', '--json']);
    expect(fs.existsSync(probe)).toBe(false);
    const byId = Object.fromEntries(JSON.parse(json.stdout).criteria.map((c) => [c.id, c]));
    expect(byId.A1.verdict).toBe('not_rederived');
    expect(byId.A1.reason).toBe('command_not_executed');
    expect(text.out).toContain(
      'note: 1 criterion/criteria declare a command; a recorded command is never executed by CAWS'
    );
    expect(JSON.parse(json.stdout).summary.command_declared).toBe(1);
  });

  // A refused target is a citation that can never re-derive, so it is
  // REFUTED (exit 1 by default), not merely unverifiable — otherwise a
  // smuggled runner flag would read as exit 0 on every non-strict run.
  test('a nodeid that is a runner flag is refused before any spawn: refuted/target_refused, exit 1', () => {
    const { root, cawsDir } = mkProject();
    record(cawsDir, 'A1', { testNodeid: '--collect-only' });
    record(cawsDir, 'A2', { testNodeid: '-p no:cacheprovider' });
    const r = runVerify(root, { run: true });
    expect(r.code).toBe(1);
    expect(r.out).toContain(
      'A1: refuted (target_refused) — test_nodeid "--collect-only" begins with "-"; a nodeid is an operand, not a runner flag [self-reported]'
    );
    expect(r.out).toContain(
      'A2: refuted (target_refused) — test_nodeid "-p no:cacheprovider" begins with "-"; a nodeid is an operand, not a runner flag [self-reported]'
    );
    expect(r.out).toContain('verified 0, refuted 2, not_rederived 1');
    expect(r.out).not.toContain('verified (');
  });
});

// ─── A13: infrastructure failure is never green ──────────────────────────────

describe('no false green on infrastructure failure (A13)', () => {
  test('no runner detectable above the cited test -> not_rederived/runner_unavailable; verdict says nothing was verified; --strict exits 1', () => {
    const { root, cawsDir } = mkProject();
    record(cawsDir, 'A1', { testNodeid: 'plain/tests/orphan.test.js::x' });
    const r = runVerify(root, { run: true });
    expect(r.code).toBe(0);
    expect(r.out).toContain('A1: not_rederived (runner_unavailable) — no test runner detected');
    expect(r.out).toContain('verdict: nothing was mechanically verified');
    expect(r.out).not.toContain('passed');
    expect(runVerify(root, { run: true, strict: true }).code).toBe(1);
  });

  test('a runner override that is detected but not implemented -> runner_unavailable naming the gap', () => {
    const { root, cawsDir } = mkProject();
    record(cawsDir, 'A1', { testNodeid: 'js/tests/sample.test.js::adds' });
    const r = runVerify(root, { run: true, runner: 'vitest' });
    expect(r.out).toContain(
      'A1: not_rederived (runner_unavailable) — runner vitest detected; re-derivation is not implemented'
    );
  });

  test('CAWS_GIT_BINARY=/nonexistent: the command fails before any verdict and prints no passed line (in-process)', () => {
    const { root, cawsDir, head } = mkProject();
    record(cawsDir, 'A1', { commitSha: head });
    const prev = process.env.CAWS_GIT_BINARY;
    process.env.CAWS_GIT_BINARY = '/nonexistent/git';
    resetGitBinaryCache();
    let r;
    try {
      r = runVerify(root);
    } finally {
      if (prev === undefined) delete process.env.CAWS_GIT_BINARY;
      else process.env.CAWS_GIT_BINARY = prev;
      resetGitBinaryCache();
    }
    expect(r.code).not.toBe(0);
    expect(r.out).not.toContain('passed');
    expect(r.out).not.toContain('verified');
  });

  test('CAWS_GIT_BINARY=/nonexistent through dist: non-zero exit, no verdict emitted', () => {
    const { root, cawsDir, head } = mkProject();
    record(cawsDir, 'A1', { commitSha: head });
    const r = spawnCli(root, ['specs', 'verify-acs', SPEC_ID, '--json'], {
      CAWS_GIT_BINARY: '/nonexistent/git',
    });
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain('"verified": 1');
    expect(r.stdout).not.toContain('all mechanically-verifiable');
  });

  test('verifyAcsVerdictLine / verifyAcsExitCode contract', () => {
    const s = (verified, refuted, not_rederived) => ({
      total: verified + refuted + not_rederived,
      verified,
      refuted,
      not_rederived,
      narrative_only: 0,
      self_reported: 0,
      command_declared: 0,
    });
    expect(verifyAcsVerdictLine(s(0, 0, 3))).toBe(
      'verdict: nothing was mechanically verified; unverifiable: 3 (not counted as pass)'
    );
    expect(verifyAcsVerdictLine(s(2, 0, 1))).toBe(
      'verdict: all mechanically-verifiable ACs passed (2 verified); unverifiable: 1 (not counted as pass)'
    );
    expect(verifyAcsVerdictLine(s(2, 1, 0))).toBe(
      'verdict: REFUTED — 1 criterion/criteria cite evidence that does not re-derive; unverifiable: 0 (not counted as pass)'
    );
    expect(verifyAcsExitCode(s(0, 0, 3), false)).toBe(0);
    expect(verifyAcsExitCode(s(0, 0, 3), true)).toBe(1);
    expect(verifyAcsExitCode(s(1, 1, 0), false)).toBe(1);
    expect(verifyAcsExitCode(s(3, 0, 0), true)).toBe(0);
  });
});

// ─── A14: the flags exist on the built artifact ───────────────────────────────

describe('flags exist on the artifact (A14)', () => {
  test('specs verify-acs --help through dist lists --run, --strict, --runner, --json', () => {
    const { root } = mkProject();
    const r = spawnCli(root, ['specs', 'verify-acs', '--help']);
    expect(r.status).toBe(0);
    for (const flag of ['--run', '--strict', '--runner <name>', '--json']) {
      expect(r.stdout).toContain(flag);
    }
    expect(r.stdout).toContain('never executed');
  });

  test('metadata is the single source: leaf present, runner choices equal the selectable runners', () => {
    const specs = COMMAND_SURFACE_METADATA.find((c) => c.name === 'specs');
    const leaf = specs.subcommands.find((c) => c.name === 'verify-acs');
    expect(leaf).toBeDefined();
    expect(leaf.options.map((o) => o.flag)).toEqual(
      expect.arrayContaining(['--run', '--strict', '--runner <name>', '--json'])
    );
    const runner = leaf.options.find((o) => o.flag === '--runner <name>');
    expect(runner.allowedValues).toEqual(SELECTABLE_TEST_RUNNERS);
    expect(runner.allowedValues).not.toContain('unknown');
  });

  test('--runner with an unknown name is refused (handler) and by dist', () => {
    const { root, cawsDir } = mkProject();
    record(cawsDir, 'A1', {});
    const h = runVerify(root, { runner: 'bogus' });
    expect(h.code).toBe(1);
    expect(h.err).toContain(
      'caws specs verify-acs: invalid --runner. Got "bogus"; expected one of'
    );
    const d = spawnCli(root, ['specs', 'verify-acs', SPEC_ID, '--runner', 'bogus']);
    expect(d.status).not.toBe(0);
  });

  test('the legacy top-level `caws verify-acs` hands off to the restored command', () => {
    const { root } = mkProject();
    const r = spawnCli(root, ['verify-acs']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('caws specs verify-acs <id>');
    expect(r.stderr).not.toContain('Encode AC-evidence assertions in your test suite directly');
  });

  test('unknown spec id -> exit 1 with the failure line', () => {
    const { root } = mkProject();
    const out = [];
    const err = [];
    const code = runSpecsVerifyAcsCommand({
      cwd: root,
      id: 'NOPE-001',
      out: (l) => out.push(l),
      err: (l) => err.push(l),
    });
    expect(code).toBe(1);
    expect(err.join('\n')).toContain('caws specs verify-acs: failed.');
    expect(out).toEqual([]);
  });
});
