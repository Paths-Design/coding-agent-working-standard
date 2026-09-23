'use strict';

const fs = require('fs');
const path = require('path');

const { initProject } = require('../../dist/store/init-store');
const { runScopeCommand, runScopePlanCommand } = require('../../dist/shell/index');
const { cleanupAll, makeTempRepo } = require('../helpers/git-repo-factory');

afterAll(() => {
  cleanupAll();
});

function mkRepo() {
  const root = makeTempRepo();
  const initialized = initProject(root);
  if (!initialized.ok) {
    throw new Error('initProject failed: ' + JSON.stringify(initialized.errors));
  }
  return { root, cawsDir: path.join(root, '.caws') };
}

function writeSpec(cawsDir, id, scopeIn, worktree) {
  const inLines = scopeIn.map((p) => `    - ${p}`).join('\n');
  const body = `id: ${id}
title: 'Target claim fixture'
risk_tier: 3
mode: chore
lifecycle_state: active
worktree: ${worktree}
created_at: '2026-07-04T00:00:00.000Z'
updated_at: '2026-07-04T00:00:00.000Z'
blast_radius:
  modules:
    - tests
  data_migration: false
operational_rollback_slo: 5m
scope:
  in:
${inLines}
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

function writeRegistry(cawsDir, entries) {
  fs.writeFileSync(path.join(cawsDir, 'worktrees.json'), JSON.stringify(entries, null, 2) + '\n');
}

function setupClaimedPathRepo() {
  const { root, cawsDir } = mkRepo();
  writeSpec(cawsDir, 'OWNER-001', ['packages/owned'], 'owned-wt');
  writeRegistry(cawsDir, {
    'owned-wt': {
      specId: 'OWNER-001',
      baseBranch: 'main',
      branch: 'owner-branch',
      path: path.join(cawsDir, 'worktrees', 'owned-wt'),
    },
  });
  return { root, cawsDir };
}

function eventsPath(cawsDir) {
  return path.join(cawsDir, 'events.jsonl');
}

function runScopeJson(root, mode) {
  const out = [];
  const err = [];
  const code = runScopeCommand({
    cwd: root,
    mode,
    path: 'packages/owned/file.ts',
    json: true,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });
  return { code, json: JSON.parse(out.join('\n')), err: err.join('\n') };
}

function runPlan(root, opts = {}) {
  const out = [];
  const err = [];
  const code = runScopePlanCommand({
    cwd: root,
    paths: ['packages/owned/file.ts'],
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    ...opts,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('scope target-scope-claim authority handoff', () => {
  test('show/check --json admit but do not report the base checkout as authoritative', () => {
    const { root, cawsDir } = setupClaimedPathRepo();

    for (const mode of ['show', 'check']) {
      const result = runScopeJson(root, mode);

      expect(result.code).toBe(0);
      expect(result.json).toMatchObject({
        decision: 'admit',
        rule: 'scope.admit.scope_in',
        source: 'target_scope_in_claim',
        mode: 'union',
        boundSpecId: 'OWNER-001',
        worktreeName: 'owned-wt',
        remediation: {
          summary:
            'Verified: worktree owned-wt is bound to OWNER-001, whose scope.in entry "packages/owned" admits this path. Edit it from inside owned-wt.',
          commands: [
            {
              command: 'cd .caws/worktrees/owned-wt',
              description:
                "Safe: a read-only move into owned-wt, the worktree that holds this path's claim.",
              mutates: false,
            },
            {
              command: 'caws claim',
              description:
                'Shows whether this session owns owned-wt; the worktree guards admit edits there only for its owner.',
              mutates: false,
            },
          ],
          // States worktree-write-guard's block_claimed branch as a fact, not a
          // possibility: a hedge here is what made agents stall on the handoff.
          notes: [
            "A write to this path from the checkout of owned-wt's base branch is blocked by worktree-write-guard, because owned-wt claims it.",
          ],
        },
      });
    }
    expect(fs.existsSync(eventsPath(cawsDir))).toBe(false);
  });

  test('scope plan groups target-claim authority handoff commands without mutation', () => {
    const { root, cawsDir } = setupClaimedPathRepo();

    const jsonResult = runPlan(root, { json: true });
    expect(jsonResult.code).toBe(0);
    const payload = JSON.parse(jsonResult.out);
    expect(payload).toMatchObject({
      ok: true,
      read_only: true,
      counts: { admit: 1, reject: 0, no_authority: 0, invalid_path: 0 },
    });
    expect(payload.paths[0]).toMatchObject({
      decision: 'admit',
      source: 'target_scope_in_claim',
      mode: 'union',
    });
    expect(payload.remediation_groups).toEqual([
      {
        command: 'cd .caws/worktrees/owned-wt',
        description:
          "Safe: a read-only move into owned-wt, the worktree that holds this path's claim.",
        mutates: false,
        paths: ['packages/owned/file.ts'],
      },
      {
        command: 'caws claim',
        description:
          'Shows whether this session owns owned-wt; the worktree guards admit edits there only for its owner.',
        mutates: false,
        paths: ['packages/owned/file.ts'],
      },
    ]);

    const humanResult = runPlan(root);
    expect(humanResult.code).toBe(0);
    expect(humanResult.out).toContain('admit=1 reject=0 no_authority=0 invalid_path=0');
    expect(humanResult.out).toContain('cd .caws/worktrees/owned-wt');
    expect(humanResult.out).toContain('caws claim');
    expect(fs.existsSync(eventsPath(cawsDir))).toBe(false);
  });
});
