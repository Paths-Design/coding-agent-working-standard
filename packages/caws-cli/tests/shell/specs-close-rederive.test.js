'use strict';

/**
 * The close gate re-derives citations (CAWS-SPECS-VERIFY-ACS-REDERIVE-001):
 * A4 (staleness caught at close), A5 (a recorded command never executes on
 * close or merge), A9 (close/merge spawn no test runner), A10 (warn-mode is
 * actually warn), A11 (the report reaches both renderers), A12 (the close
 * summary prints self-reported and narrative-only counts).
 *
 * Boundary made explicit: close re-derives the NON-EXECUTING classes only
 * (cited commit, cited artifact). A stale TEST citation is therefore caught by
 * `caws specs verify-acs --run` and at record time by `--verify`, not at
 * close — close never spawns a runner (A9), and the runner-instrument below
 * proves that negative is not vacuous.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  runSpecsCloseCommand,
  runSpecsEvidenceCommand,
  runSpecsVerifyAcsCommand,
} = require('../../dist/shell/commands/specs');
const { runWorktreeMergeCommand } = require('../../dist/shell/commands/worktree');
const { createWorktree, mergeWorktree } = require('../../dist/store/worktrees-writer');
const { createSpec } = require('../../dist/store/specs-writer');
const { initProject } = require('../../dist/store/init-store');
const { cleanupAll, git, makeTempRepo } = require('../helpers/git-repo-factory');

afterAll(() => {
  cleanupAll();
});

const SESSION_ID = 'specs-close-rederive-test';
const SESSION = { session_id: SESSION_ID, platform: 'jest' };
const ACTOR = { kind: 'agent', id: 'jest', session_id: SESSION_ID };
const CANDIDATES = { candidates: [{ identity: SESSION, source: 'hook_env' }], trace: [] };
const NOW = () => new Date('2026-09-16T12:00:00.000Z');
const JEST_BIN = fs.realpathSync(path.resolve(__dirname, '../../../../node_modules/.bin/jest'));

function write(root, rel, content, mode) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, mode !== undefined ? { mode } : undefined);
}

function commitAll(root, message) {
  git(root, ['add', '-A']);
  git(root, ['commit', '--quiet', '--no-verify', '-m', message]);
}

/**
 * A CAWS project whose spec is created through the real writer (so it is
 * bindable for the merge path), with a jest package under js/, a committed
 * artifact, and the runner instrumented: node_modules/.bin/jest is a shim
 * that records every invocation to `runner-calls.log` before delegating to
 * the real jest. A close or merge that spawned a runner would leave a line.
 */
function mkProject(id, scopeIn) {
  const root = makeTempRepo();
  const initialized = initProject(root);
  if (!initialized.ok) throw new Error('initProject failed: ' + JSON.stringify(initialized.errors));
  const cawsDir = path.join(root, '.caws');
  const created = createSpec(cawsDir, {
    id,
    title: 'close re-derive fixture',
    mode: 'chore',
    riskTier: 3,
    actor: ACTOR,
    scopeIn,
  });
  if (!created.ok || created.value.kind !== 'success') {
    throw new Error('createSpec failed: ' + JSON.stringify(created));
  }
  write(root, '.gitignore', 'node_modules/\nrunner-calls.log\ncaws-exec-probe\n.caws/worktrees/\n');
  write(root, 'js/jest.config.js', "module.exports = { testEnvironment: 'node' };\n");
  write(root, 'js/tests/sample.test.js', "test('adds', () => { expect(1 + 1).toBe(2); });\n");
  write(root, 'docs/report.md', '# report\n');
  commitAll(root, 'fixture');
  const head = git(root, ['rev-parse', 'HEAD']).trim();

  const log = path.join(root, 'runner-calls.log');
  fs.mkdirSync(path.join(root, 'node_modules', '.bin'), { recursive: true });
  write(
    root,
    'node_modules/.bin/jest',
    `#!/usr/bin/env node\nrequire('fs').appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n');\nrequire(${JSON.stringify(JEST_BIN)});\n`,
    0o755
  );
  return { root, cawsDir, head, log };
}

function runnerCalls(log) {
  return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [];
}

function record(root, id, ac, fields) {
  const out = [];
  const err = [];
  const code = runSpecsEvidenceCommand({
    cwd: root,
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: SESSION_ID },
    id,
    ac,
    status: 'pass',
    evidenceRef: `narrative for ${ac}`,
    now: NOW,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    ...fields,
  });
  if (code !== 0) throw new Error(`record ${ac} failed (${code}): ${err.join('\n')}`);
  return { out: out.join('\n'), err: err.join('\n') };
}

function runClose(root, id) {
  const out = [];
  const err = [];
  const code = runSpecsCloseCommand({
    cwd: root,
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: SESSION_ID },
    id,
    resolution: 'completed',
    reason: 'fixture close',
    now: NOW,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

function runVerifyAcs(root, id, opts = {}) {
  const out = [];
  const err = [];
  const code = runSpecsVerifyAcsCommand({
    cwd: root,
    id,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    ...opts,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

/** Bind a worktree to the spec, put one in-scope commit on it, and merge it back through the SHELL command. */
function createLaneWithWork(root, cawsDir, id, name) {
  const created = createWorktree(cawsDir, { name, specId: id, session: SESSION, actor: ACTOR });
  if (!created.ok || created.value.kind !== 'success') {
    throw new Error('createWorktree failed: ' + JSON.stringify(created));
  }
  const wtPath = path.join(cawsDir, 'worktrees', name);
  fs.writeFileSync(path.join(wtPath, 'payload.txt'), 'work product\n');
  execFileSync('git', ['-C', wtPath, 'add', 'payload.txt']);
  execFileSync('git', ['-C', wtPath, 'commit', '--quiet', '--no-verify', '-m', 'feat: work']);
  return wtPath;
}

function runMergeShell(root, name) {
  const out = [];
  const err = [];
  const code = runWorktreeMergeCommand({
    cwd: root,
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: SESSION_ID },
    name,
    now: NOW,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

// ─── A10 + A12 + A3-at-close: hostile fixtures still close, and are named ────

describe('close re-derives citations in warn-mode (A10, A12)', () => {
  test('a pass citing HEAD is verified at close and the summary prints the counts', () => {
    const id = 'CLOSE-REDERIVE-001';
    const { root, head } = mkProject(id, ['payload.txt']);
    // createSpec declares exactly one criterion (A1); each verdict class gets
    // its own fixture below rather than three criteria on one spec.
    record(root, id, 'A1', { commitSha: head });
    const r = runClose(root, id);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`closed ${id}`);
    expect(r.err).not.toContain('does NOT re-derive');
    expect(r.err).toContain(
      `Evidence at close for "${id}": 1 criteria — verified 1, refuted 0, not_rederived 0 (self-reported 1, narrative-only 0, command declared 0)`
    );
  });

  test('a pass citing an artifact that is not in the tree is refuted at close — named, exit 0', () => {
    const id = 'CLOSE-REDERIVE-002';
    const { root } = mkProject(id, ['payload.txt']);
    record(root, id, 'A1', { artifactPath: 'docs/nope.md' });
    const r = runClose(root, id);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`closed ${id}`);
    expect(r.err).toContain('caws advisory (non-blocking)');
    expect(r.err).toContain(
      'recorded as pass whose cited evidence does NOT re-derive [warn-mode: close proceeded]'
    );
    expect(r.err).toContain(
      'A1: refuted (artifact_missing) — docs/nope.md not found at HEAD [self-reported]'
    );
    expect(r.err).toContain(`caws specs reopen ${id} --reason`);
    expect(r.err).toContain('--verify');
    expect(r.err).toContain(
      'verified 0, refuted 1, not_rederived 0 (self-reported 1, narrative-only 0'
    );
  });

  test('a pass citing a commit that is no object is refuted at close with a DIFFERENT reason than the artifact case', () => {
    const id = 'CLOSE-REDERIVE-003';
    const { root } = mkProject(id, ['payload.txt']);
    record(root, id, 'A1', { commitSha: 'deadbeefcafe' });
    const r = runClose(root, id);
    expect(r.code).toBe(0);
    expect(r.err).toContain('A1: refuted (object_missing) — commit deadbeefcafe is not an object');
  });

  test('a narrative-only pass is not refuted, and the summary says it is narrative-only', () => {
    const id = 'CLOSE-REDERIVE-004';
    const { root } = mkProject(id, ['payload.txt']);
    record(root, id, 'A1', {});
    const r = runClose(root, id);
    expect(r.code).toBe(0);
    expect(r.err).not.toContain('does NOT re-derive');
    expect(r.err).toContain(
      'verified 0, refuted 0, not_rederived 1 (self-reported 0, narrative-only 1'
    );
  });

  test('a spec with no evidence at all prints the pre-existing missing-evidence advisory and NO re-derivation summary', () => {
    const id = 'CLOSE-REDERIVE-005';
    const { root } = mkProject(id, ['payload.txt']);
    const r = runClose(root, id);
    expect(r.code).toBe(0);
    expect(r.err).toContain('lacking satisfying evidence');
    expect(r.err).not.toContain('Evidence at close for');
  });
});

// ─── A4: staleness caught at close ───────────────────────────────────────────

describe('staleness is caught at close (A4)', () => {
  test('record pass --verify against a present artifact; delete the artifact; close names the criterion as refuted', () => {
    const id = 'CLOSE-STALE-001';
    const { root } = mkProject(id, ['payload.txt']);
    const rec = record(root, id, 'A1', { artifactPath: 'docs/report.md', verify: true });
    expect(rec.out).toContain('A1: verified (passed) — docs/report.md present at HEAD');

    fs.rmSync(path.join(root, 'docs', 'report.md'));
    commitAll(root, 'remove the artifact');

    const r = runClose(root, id);
    expect(r.code).toBe(0);
    expect(r.err).toContain(
      'A1: refuted (artifact_missing) — docs/report.md not found at HEAD [self-reported]'
    );
  });

  test('a stale TEST citation is caught by verify-acs --run (close does not execute tests — by design, see A9)', () => {
    const id = 'CLOSE-STALE-002';
    const { root, log } = mkProject(id, ['payload.txt']);
    const rec = record(root, id, 'A1', {
      testNodeid: 'js/tests/sample.test.js::adds',
      verify: true,
    });
    expect(rec.out).toContain('A1: verified (passed) — jest js/tests/sample.test.js::adds passed');
    expect(runnerCalls(log)).toHaveLength(1);

    write(root, 'js/tests/sample.test.js', "test('adds', () => { expect(1 + 1).toBe(3); });\n");
    commitAll(root, 'break the test');

    const v = runVerifyAcs(root, id, { run: true });
    expect(v.code).toBe(1);
    expect(v.out).toMatch(/A1: refuted \(test_failed\) — jest exit 1:/);
    expect(runnerCalls(log)).toHaveLength(2);

    const r = runClose(root, id);
    expect(r.code).toBe(0);
    // The now-red test is NOT named refuted at close: the test class is not
    // re-derived there. The summary says so and counts it as not_rederived.
    expect(r.err).not.toContain('refuted (test_failed)');
    expect(r.err).toContain('verified 0, refuted 0, not_rederived 1 (self-reported 1');
    expect(r.err).toContain('cited tests are not executed at close');
    expect(runnerCalls(log)).toHaveLength(2);
  }, 60000);
});

// ─── A5 + A9: close and merge execute nothing agent-authored, spawn no runner ─

describe('close and merge never execute a recorded command and never spawn a runner (A5, A9)', () => {
  test('specs close: probe file absent, runner log empty, summary counts the declared command', () => {
    const id = 'CLOSE-NOEXEC-001';
    const { root, log } = mkProject(id, ['payload.txt']);
    const probe = path.join(root, 'caws-exec-probe');
    record(root, id, 'A1', {
      command: `touch ${probe}`,
      exitCode: 0,
      testNodeid: 'js/tests/sample.test.js::adds',
    });
    const r = runClose(root, id);
    expect(r.code).toBe(0);
    expect(fs.existsSync(probe)).toBe(false);
    expect(runnerCalls(log)).toEqual([]);
    expect(r.err).toContain('command declared 1');
  });

  test('worktree merge (shell): merge lands, spec auto-closes, probe absent, runner log empty, refuted citation on stderr (A11)', () => {
    const id = 'MERGE-NOEXEC-001';
    const { root, cawsDir, log } = mkProject(id, ['payload.txt']);
    const probe = path.join(root, 'caws-exec-probe');
    record(root, id, 'A1', {
      command: `touch ${probe}`,
      exitCode: 0,
      testNodeid: 'js/tests/sample.test.js::adds',
      artifactPath: 'docs/nope.md',
    });
    commitAll(root, 'record evidence');
    createLaneWithWork(root, cawsDir, id, 'wt-noexec');

    const m = runMergeShell(root, 'wt-noexec');
    expect(m.code).toBe(0);
    expect(fs.existsSync(probe)).toBe(false);
    expect(runnerCalls(log)).toEqual([]);
    // The same criterion line the direct close prints, on the merge renderer.
    expect(m.err).toContain('caws advisory (non-blocking)');
    expect(m.err).toContain(
      'A1: refuted (artifact_missing) — docs/nope.md not found at HEAD [self-reported]'
    );
    expect(m.err).toContain(`Evidence at close for "${id}"`);
    expect(m.err).toContain('command declared 1');
  });

  test('worktree merge (store): the report is carried under data.evidence_warnings, the key the merge renderer reads', () => {
    const id = 'MERGE-KEY-001';
    const { root, cawsDir } = mkProject(id, ['payload.txt']);
    record(root, id, 'A1', { commitSha: 'deadbeefcafe' });
    commitAll(root, 'record evidence');
    createLaneWithWork(root, cawsDir, id, 'wt-key');

    const result = mergeWorktree(cawsDir, {
      name: 'wt-key',
      session: SESSION,
      sessionCandidates: CANDIDATES,
      actor: ACTOR,
      now: NOW,
    });
    expect(result.ok).toBe(true);
    expect(result.value.kind).toBe('success');
    const warnings = result.value.data.evidence_warnings;
    expect(Array.isArray(warnings)).toBe(true);
    expect(warnings.join('\n')).toContain(
      'A1: refuted (object_missing) — commit deadbeefcafe is not an object'
    );
    expect(warnings.join('\n')).toContain(`Evidence at close for "${id}"`);
  });
});
