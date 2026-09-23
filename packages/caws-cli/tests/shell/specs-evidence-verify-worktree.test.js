'use strict';

/**
 * Re-derivation from a linked worktree (CAWS-EVIDENCE-VERIFY-FROM-BOUND-WORKTREE-01).
 *
 * Specs are canonical-only, so `caws specs evidence --verify` resolved the
 * repo root to the canonical checkout and ran the cited test there. A test
 * that existed only on the slice branch was test_not_found, and agents
 * concluded that proof needing the landed revision had to go through
 * `worktree merge --no-close`. These tests pin that re-derivation runs in the
 * worktree the command is invoked from, names that tree and its HEAD, and
 * refuses to record from a worktree with uncommitted changes.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  runSpecsEvidenceCommand,
  runSpecsVerifyAcsCommand,
} = require('../../dist/shell/commands/specs');
const { initProject } = require('../../dist/store/init-store');
const { cleanupAll, makeTempRepo, git } = require('../helpers/git-repo-factory');

const worktreeDirs = [];
afterAll(() => {
  cleanupAll();
  for (const d of worktreeDirs) fs.rmSync(d, { recursive: true, force: true });
});

const JEST_BIN = fs.realpathSync(path.resolve(__dirname, '../../../../node_modules/.bin/jest'));
const SPEC_ID = 'EVIDENCE-VERIFY-WT-FIXTURE-001';
const BRANCH_TEST = 'js/tests/branch.test.js::exists only on the branch';

function write(root, rel, content) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

function specYaml(id) {
  return `id: ${id}
title: 'evidence --verify worktree fixture'
risk_tier: 3
mode: chore
lifecycle_state: active
created_at: '2026-09-23T00:00:00.000Z'
updated_at: '2026-09-23T00:00:00.000Z'
blast_radius:
  modules:
    - tests
  data_migration: false
operational_rollback_slo: 5m
scope:
  in:
    - js
  out: []
invariants:
  - 'fixture spec'
acceptance:
  - id: A1
    given: 'fixture'
    when: 'fixture'
    then: 'fixture'
non_functional: {}
contracts: []
`;
}

function linkJest(root) {
  fs.mkdirSync(path.join(root, 'node_modules', '.bin'), { recursive: true });
  fs.symlinkSync(JEST_BIN, path.join(root, 'node_modules', '.bin', 'jest'));
}

/**
 * A canonical checkout on main, plus a linked worktree whose branch adds a
 * committed jest test that main does not have. node_modules is ignored in
 * both, as `caws worktree create` links it into real worktrees.
 */
function mkProjectWithWorktree() {
  const root = fs.realpathSync(makeTempRepo());
  const initialized = initProject(root);
  if (!initialized.ok) throw new Error('initProject failed: ' + JSON.stringify(initialized.errors));
  write(root, `.caws/specs/${SPEC_ID}.yaml`, specYaml(SPEC_ID));
  write(root, '.gitignore', 'node_modules\n');
  write(root, 'js/jest.config.js', "module.exports = { testEnvironment: 'node' };\n");
  write(root, 'js/tests/main.test.js', "test('on main', () => { expect(1).toBe(1); });\n");
  git(root, ['add', '-A']);
  git(root, ['commit', '--quiet', '--no-verify', '-m', 'fixture']);
  linkJest(root);

  const wtParent = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-verify-wt-'));
  worktreeDirs.push(wtParent);
  const wt = path.join(wtParent, 'slice');
  git(root, ['worktree', 'add', '--quiet', '-b', 'slice', wt]);
  const worktree = fs.realpathSync(wt);
  linkJest(worktree);
  write(
    worktree,
    'js/tests/branch.test.js',
    "test('exists only on the branch', () => { expect(2).toBe(2); });\n"
  );
  git(worktree, ['add', 'js/tests/branch.test.js']);
  git(worktree, ['commit', '--quiet', '--no-verify', '-m', 'branch test']);
  const head = git(worktree, ['rev-parse', 'HEAD']).trim();
  return { root, worktree, head, cawsDir: path.join(root, '.caws') };
}

function readSpec(cawsDir) {
  return fs.readFileSync(path.join(cawsDir, 'specs', `${SPEC_ID}.yaml`), 'utf8');
}

function runEvidence(cwd, opts) {
  const out = [];
  const err = [];
  const code = runSpecsEvidenceCommand({
    cwd,
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'specs-evidence-verify-worktree-test' },
    id: SPEC_ID,
    ac: 'A1',
    status: 'pass',
    evidenceRef: 'narrative',
    now: () => new Date('2026-09-23T12:00:00.000Z'),
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    showData: true,
    ...opts,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

function runVerifyAcs(cwd, opts = {}) {
  const out = [];
  const err = [];
  const code = runSpecsVerifyAcsCommand({
    cwd,
    id: SPEC_ID,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    showData: true,
    ...opts,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('evidence --verify re-derives in the invoking linked worktree', () => {
  test('a committed test that exists only on the worktree branch verifies from inside the worktree, naming the tree and HEAD', () => {
    const { worktree, head, cawsDir } = mkProjectWithWorktree();
    const r = runEvidence(worktree, { testNodeid: BRANCH_TEST, verify: true });
    expect(r.err).not.toContain('refusing');
    expect(r.code).toBe(0);
    expect(r.out).toContain('verified before recording:');
    expect(r.out).toContain(`re-derived against worktree ${worktree} at ${head}`);
    expect(r.out).toContain(
      `A1: verified (passed) — jest ${BRANCH_TEST} passed (1 test executed) [agent-cited]`
    );
    // The spec written is the canonical one: the worktree has no spec store.
    expect(readSpec(cawsDir)).toContain('criterion_id: A1');
  }, 60000);

  test('the same citation from the canonical checkout is still refused: the test is not on main', () => {
    const { root, cawsDir } = mkProjectWithWorktree();
    const r = runEvidence(root, { testNodeid: BRANCH_TEST, verify: true });
    expect(r.code).toBe(1);
    expect(r.err).toContain(
      'A1: refuted (test_not_found) — test file not found: js/tests/branch.test.js'
    );
    expect(r.out).not.toContain('re-derived against worktree');
    expect(readSpec(cawsDir)).not.toContain('criterion_id: A1');
  });

  test('a worktree with an uncommitted edit is refused before anything runs; nothing is written', () => {
    const { worktree, cawsDir } = mkProjectWithWorktree();
    write(worktree, 'js/tests/branch.test.js', "test('exists only on the branch', () => {});\n");
    write(worktree, 'js/scratch.js', '// untracked\n');
    const before = readSpec(cawsDir);
    const r = runEvidence(worktree, { testNodeid: BRANCH_TEST, verify: true });
    expect(r.code).toBe(1);
    expect(r.err).toContain(
      `caws specs evidence --verify: refusing to verify from worktree ${worktree} — it has uncommitted changes, so a verified result would not name committed code:`
    );
    expect(r.err).toContain(' M js/tests/branch.test.js');
    expect(r.err).toContain('?? js/scratch.js');
    expect(r.err).toContain(
      'Nothing was written. Commit the work in the worktree, then record again.'
    );
    expect(r.out).not.toContain('verified before recording');
    expect(readSpec(cawsDir)).toBe(before);
  });
});

describe('verify-acs --run re-derives in the invoking linked worktree', () => {
  test('from the worktree the branch-only test verifies and the header names the tree and HEAD', () => {
    const { worktree, head, cawsDir } = mkProjectWithWorktree();
    const rec = runEvidence(worktree, { testNodeid: BRANCH_TEST });
    expect(rec.code).toBe(0);
    const r = runVerifyAcs(worktree, { run: true });
    expect(r.out).toContain(`tree: worktree ${worktree} at ${head}`);
    expect(r.out).toContain('A1: verified (passed)');
    expect(readSpec(cawsDir)).toContain('criterion_id: A1');
  }, 60000);

  test('from canonical the same spec re-derives against canonical and names no worktree', () => {
    const { root, worktree } = mkProjectWithWorktree();
    runEvidence(worktree, { testNodeid: BRANCH_TEST });
    const r = runVerifyAcs(root, { run: true });
    expect(r.out).not.toContain('tree: worktree');
    expect(r.out).toContain('A1: refuted (test_not_found)');
  });
});
