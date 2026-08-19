'use strict';

/**
 * CAWS-SPEC-ACTIVATION-BINDS-001 — `caws status` tells the truth about an
 * unbound checkout, and makes "how much of this is in flight" answerable.
 *
 * Two AX defects the draft-default exposed:
 *
 * 1. The binding line said "unbound (scope still enforced — union mode over N
 *    active specs)". The kernel does not do that: evaluatePath returns
 *    no_authority.unbound at step 1, BEFORE any spec is consulted, so the answer
 *    is identical with forty active specs or zero. Worse, naming a spec count
 *    invited the reading that more active specs means more enforcement — which
 *    is precisely what made an unworked active backlog look load-bearing.
 *
 * 2. "7 active" could not distinguish one slice in flight from six abandoned
 *    ones. Under the new model that distinction IS the health signal.
 */

const fs = require('fs');
const path = require('path');

const { initProject } = require('../../dist/store/init-store');
const { runStatusCommand } = require('../../dist/shell/commands/status');
const { cleanupAll, makeTempRepo } = require('../helpers/git-repo-factory');

afterAll(() => {
  cleanupAll();
});

function mkRepo() {
  const root = makeTempRepo();
  const initialized = initProject(root);
  if (!initialized.ok) throw new Error('initProject failed');
  return { root, caws: path.join(root, '.caws') };
}

function writeSpec(caws, id, { lifecycleState = 'active', worktree } = {}) {
  const wtLine = worktree !== undefined ? `worktree: ${worktree}\n` : '';
  fs.writeFileSync(
    path.join(caws, 'specs', `${id}.yaml`),
    `id: ${id}
title: 'Status legibility fixture'
risk_tier: 3
mode: chore
lifecycle_state: ${lifecycleState}
${wtLine}created_at: '2026-07-04T00:00:00.000Z'
updated_at: '2026-07-04T00:00:00.000Z'
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
  - 'fixture'
acceptance:
  - id: A1
    given: 'fixture'
    when: 'fixture'
    then: 'fixture'
non_functional: {}
contracts: []
`
  );
}

function writeRegistry(caws, entries) {
  fs.writeFileSync(path.join(caws, 'worktrees.json'), JSON.stringify(entries, null, 2) + '\n');
}

function runStatus(cwd) {
  const out = [];
  const err = [];
  const code = runStatusCommand({
    cwd,
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'status-legibility-test' },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('status binding line describes the actual rule', () => {
  test('an unbound checkout is not told that N active specs are being enforced', () => {
    const { root, caws } = mkRepo();
    writeSpec(caws, 'ACTIVE-A-001');
    writeSpec(caws, 'ACTIVE-B-002');
    writeSpec(caws, 'ACTIVE-C-003');

    const result = runStatus(root);

    const binding = result.out
      .split('\n')
      .find((l) => l.trim().startsWith('binding:'));

    expect(binding).toContain('unbound (no write authority here');
    expect(binding).toContain('bind one to edit');
    // The mechanism claim that was never true.
    expect(binding).not.toContain('union mode');
    // No spec count on the binding line — the answer does not depend on it.
    // (Asserted against the binding LINE, not the whole render: the doctor
    // panel legitimately says "3 active spec(s) have no bound worktree", and a
    // whole-output regex would match that and pass for the wrong reason.)
    expect(binding).not.toMatch(/\d+ active spec/);
  });

  test('the unbound line is identical whether there are three active specs or none', () => {
    const many = mkRepo();
    writeSpec(many.caws, 'ACTIVE-A-001');
    writeSpec(many.caws, 'ACTIVE-B-002');
    writeSpec(many.caws, 'ACTIVE-C-003');
    const none = mkRepo();

    const bindingLine = (text) =>
      text.split('\n').find((l) => l.trim().startsWith('binding:'));

    // This is the whole point: the kernel's answer does not vary with the
    // active-spec count, so the rendered line must not either.
    expect(bindingLine(runStatus(many.root).out)).toBe(
      bindingLine(runStatus(none.root).out)
    );
  });
});

describe('status separates work in flight from active backlog', () => {
  test('an unbound active spec is counted and pointed at doctor', () => {
    const { root, caws } = mkRepo();
    writeSpec(caws, 'BOUND-001', { worktree: 'wt-one' });
    writeSpec(caws, 'UNBOUND-002');
    writeSpec(caws, 'UNBOUND-003');
    writeRegistry(caws, {
      'wt-one': { specId: 'BOUND-001', baseBranch: 'main', path: path.join(caws, 'worktrees', 'wt-one') },
    });

    const result = runStatus(root);

    expect(result.out).toContain('1 of 3 active bound to a worktree');
    expect(result.out).toContain('2 active with no worktree (see doctor)');
  });

  test('a fully-bound active set says so without a scolding clause', () => {
    const { root, caws } = mkRepo();
    writeSpec(caws, 'BOUND-001', { worktree: 'wt-one' });
    writeRegistry(caws, {
      'wt-one': { specId: 'BOUND-001', baseBranch: 'main', path: path.join(caws, 'worktrees', 'wt-one') },
    });

    const result = runStatus(root);

    expect(result.out).toContain('1 of 1 active bound to a worktree');
    expect(result.out).not.toContain('see doctor');
  });

  test('drafts are not counted as in flight, and a draft-only repo shows no in-flight line', () => {
    const { root, caws } = mkRepo();
    writeSpec(caws, 'DRAFT-001', { lifecycleState: 'draft' });
    writeSpec(caws, 'DRAFT-002', { lifecycleState: 'draft' });

    const result = runStatus(root);

    // Drafts are the resting state; a backlog is not a health problem, so the
    // line stays off entirely rather than reporting "0 of 0".
    expect(result.out).toContain('2 draft');
    expect(result.out).not.toContain('in flight:');
  });
});
