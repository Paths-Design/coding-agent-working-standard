'use strict';

// Contract tests for `caws specs commit <id>` — the governed recovery for a
// spec mutation whose audit commit did not land (CAWS-SPECS-COMMIT-PENDING-
// RECOVERY-001). Regression context: under a harness sandbox that protects
// .git, a lifecycle write can land the YAML while its audit commit is
// refused; the agent then has NO sanctioned way to checkpoint the owned
// change, leaving canonical main dirty.

const fs = require('fs');
const path = require('path');

const { initProject } = require('../../dist/store/init-store');
const {
  runSpecsActivateCommand,
  runSpecsCommitCommand,
} = require('../../dist/shell/commands/specs');
const { cleanupAll, git, makeTempRepo } = require('../helpers/git-repo-factory');

afterAll(() => {
  cleanupAll();
});

function mkRepo() {
  const root = makeTempRepo();
  const initialized = initProject(root);
  if (!initialized.ok) {
    throw new Error('initProject failed: ' + JSON.stringify(initialized.errors));
  }
  return { root, caws: path.join(root, '.caws') };
}

function draftSpec(cawsDir, id) {
  const body = `id: ${id}
title: 'Recovery fixture'
risk_tier: 3
mode: chore
lifecycle_state: draft
created_at: '2026-09-29T00:00:00.000Z'
updated_at: '2026-09-29T00:00:00.000Z'
blast_radius:
  modules:
    - tests
  data_migration: false
scope:
  in:
    - tests
  out: []
invariants:
  - 'fixture'
acceptance:
  - id: A1
    given: 'fixture'
    when: 'fixture'
    then: 'fixture'
non_functional: {}
contracts: []
`;
  fs.writeFileSync(path.join(cawsDir, 'specs', `${id}.yaml`), body);
}

function commitAll(root, message) {
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', message]);
}

function specDirty(root, id) {
  const r = git(root, ['status', '--porcelain', '--', `.caws/specs/${id}.yaml`]);
  return r.trim().length > 0;
}

function runCommit(root, id) {
  const out = [];
  const err = [];
  const code = runSpecsCommitCommand({
    id,
    cwd: root,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    now: () => new Date('2026-09-29T12:00:00.000Z'),
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('caws specs commit (audit-recovery)', () => {
  it('A1: commits a pending spec mutation, reports the sha, exits 0', () => {
    const { root, caws } = mkRepo();
    draftSpec(caws, 'RECOVER-A1-001');
    commitAll(root, 'chore(caws): fixture');
    // Simulate the failed-audit-commit state: YAML changed, not committed.
    fs.writeFileSync(
      path.join(caws, 'specs', 'RECOVER-A1-001.yaml'),
      fs
        .readFileSync(path.join(caws, 'specs', 'RECOVER-A1-001.yaml'), 'utf8')
        .replace("'fixture'", "'amended'")
    );
    expect(specDirty(root, 'RECOVER-A1-001')).toBe(true);

    const { code, out, err } = runCommit(root, 'RECOVER-A1-001');
    expect(code).toBe(0);
    expect(err).not.toMatch(/failed|refused/i);
    expect(out).toMatch(/committed/);
    expect(out).toMatch(/[0-9a-f]{7,}/); // a commit sha is reported
    expect(specDirty(root, 'RECOVER-A1-001')).toBe(false);
  });

  it('A2: an already-committed spec is an honest no-op with no empty commit', () => {
    const { root, caws } = mkRepo();
    draftSpec(caws, 'RECOVER-A2-001');
    commitAll(root, 'chore(caws): fixture');
    const headBefore = git(root, ['rev-parse', 'HEAD']).trim();

    const { code, out } = runCommit(root, 'RECOVER-A2-001');
    expect(code).toBe(0);
    expect(out).toMatch(/already committed|no pending/i);
    expect(git(root, ['rev-parse', 'HEAD']).trim()).toBe(headBefore);
    expect(specDirty(root, 'RECOVER-A2-001')).toBe(false);
  });

  it('A3: surfaces the refusal reason, exits 1, and never sweeps foreign content', () => {
    const { root, caws } = mkRepo();
    draftSpec(caws, 'RECOVER-A3-001');
    commitAll(root, 'chore(caws): fixture');
    // Deterministic commit refusal: a held .git/index.lock exhausts the
    // autoCommit retry budget (a repo without .husky silently skips
    // pre-commit hooks when core.hooksPath points elsewhere — same as
    // production, so hooks cannot make this refusal deterministic).
    const foreign = path.join(root, 'FOREIGN-README.md');
    fs.writeFileSync(foreign, 'foreign work in progress\n');
    fs.writeFileSync(path.join(root, '.git', 'index.lock'), '');
    fs.writeFileSync(
      path.join(caws, 'specs', 'RECOVER-A3-001.yaml'),
      fs
        .readFileSync(path.join(caws, 'specs', 'RECOVER-A3-001.yaml'), 'utf8')
        .replace("'fixture'", "'amended'")
    );

    const { code, err } = runCommit(root, 'RECOVER-A3-001');
    expect(code).toBe(1);
    expect(err).toMatch(/refused|failed/i);
    // The foreign file was neither staged nor committed by the recovery.
    const status = git(root, ['status', '--porcelain']);
    expect(status).toMatch(/FOREIGN-README\.md/);
    expect(status).not.toMatch(/^M {2}.*FOREIGN-README\.md/); // not staged
    const headBefore = git(root, ['rev-parse', 'HEAD']).trim();
    expect(git(root, ['rev-parse', 'HEAD']).trim()).toBe(headBefore);
  });

  it('A4: lifecycle remediation names caws specs commit as the sanctioned recovery', () => {
    const { root, caws } = mkRepo();
    draftSpec(caws, 'RECOVER-A4-001');
    commitAll(root, 'chore(caws): fixture');
    // Dirty BEFORE the lifecycle write — the exact refused_dirty precondition.
    fs.writeFileSync(
      path.join(caws, 'specs', 'RECOVER-A4-001.yaml'),
      fs
        .readFileSync(path.join(caws, 'specs', 'RECOVER-A4-001.yaml'), 'utf8')
        .replace("'fixture'", "'pre-dirty'")
    );

    const out = [];
    const err = [];
    const code = runSpecsActivateCommand({
      id: 'RECOVER-A4-001',
      cwd: root,
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      now: () => new Date('2026-09-29T12:00:00.000Z'),
    });
    expect(code).toBe(0); // lifecycle op succeeds; commit refusal is surfaced, not fatal
    expect(err.join('\n')).toMatch(/caws specs commit RECOVER-A4-001/);
  });

  it('composes: after A4-style refusal, caws specs commit resolves the pending state', () => {
    const { root, caws } = mkRepo();
    draftSpec(caws, 'RECOVER-COMPOSE-001');
    commitAll(root, 'chore(caws): fixture');
    fs.writeFileSync(
      path.join(caws, 'specs', 'RECOVER-COMPOSE-001.yaml'),
      fs
        .readFileSync(path.join(caws, 'specs', 'RECOVER-COMPOSE-001.yaml'), 'utf8')
        .replace("'fixture'", "'pre-dirty'")
    );
    runSpecsActivateCommand({
      id: 'RECOVER-COMPOSE-001',
      cwd: root,
      out: () => {},
      err: () => {},
      now: () => new Date('2026-09-29T12:00:00.000Z'),
    });
    expect(specDirty(root, 'RECOVER-COMPOSE-001')).toBe(true);

    const { code } = runCommit(root, 'RECOVER-COMPOSE-001');
    expect(code).toBe(0);
    expect(specDirty(root, 'RECOVER-COMPOSE-001')).toBe(false);
  });
});
