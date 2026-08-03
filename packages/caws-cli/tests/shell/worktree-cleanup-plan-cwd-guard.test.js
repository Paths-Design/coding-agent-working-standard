'use strict';

// caws worktree cleanup-plan --apply: the cwd self-destruct guard must
// fire when the operator's cwd is inside a destroy-ready worktree
// (CAWS-FIX-CWD-GUARD-COVERAGE-001, hole 1).
//
// Before this fix, runWorktreePhysicalCleanupPlanCommand called
// destroyWorktree WITHOUT callerCwd, so the guard's
// `if (input.callerCwd !== undefined)` short-circuited and the destroy
// proceeded regardless of cwd — deleting the directory under the
// operator's shell and wedging every subsequent spawn with ENOENT.
//
// Threading callerCwd: cwd means the guard fires, the per-item outcome
// becomes { action: 'failed', reason: /Refusing to destroy.../ }, and the
// worktree dir + registry entry are unchanged.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { runWorktreePhysicalCleanupPlanCommand } = require('../../dist/shell/commands/worktree');
const { initProject } = require('../../dist/store/init-store');

const repos = [];

afterAll(() => {
  for (const r of repos) {
    try {
      execFileSync('git', ['-C', r, 'worktree', 'prune'], { stdio: 'ignore' });
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(r, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function mkRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-cwd-guard-cleanup-'));
  execFileSync('git', ['init', '--quiet', '-b', 'main', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 't@test.com']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
  execFileSync('git', ['-C', root, 'commit', '--quiet', '--allow-empty', '-m', 'init']);
  repos.push(root);
  return root;
}

function setupCaws(repoRoot) {
  const r = initProject(repoRoot);
  if (!r.ok) throw new Error('initProject failed: ' + JSON.stringify(r.errors));
  return path.join(repoRoot, '.caws');
}

function createPhysicalWorktree(repoRoot, cawsDir, name) {
  const wtPath = path.join(cawsDir, 'worktrees', name);
  fs.mkdirSync(path.dirname(wtPath), { recursive: true });
  execFileSync('git', ['-C', repoRoot, 'worktree', 'add', '--quiet', '-b', name, wtPath, 'main']);
  return wtPath;
}

function writeClosedSpecWithWorktree(cawsDir, id, worktreeName) {
  const body = `id: ${id}
title: 'cwd-guard cleanup fixture'
risk_tier: 3
mode: chore
lifecycle_state: closed
resolution: completed
worktree: ${worktreeName}
created_at: '2026-07-04T00:00:00.000Z'
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
  - 'fixture spec'
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

function readRegistry(cawsDir) {
  const raw = fs.readFileSync(path.join(cawsDir, 'worktrees.json'), 'utf8');
  return JSON.parse(raw);
}

// Build a fixture with one destroy-ready worktree (closed spec, clean tree,
// unowned). The worktree's directory is the cwd the operator will be
// "sitting in" for the test.
function fixture() {
  const repoRoot = mkRepo();
  const caws = setupCaws(repoRoot);
  const wtPath = createPhysicalWorktree(repoRoot, caws, 'wt-ready');
  writeClosedSpecWithWorktree(caws, 'READY-001', 'wt-ready');
  writeRegistry(caws, {
    'wt-ready': {
      specId: 'READY-001',
      branch: 'wt-ready',
      baseBranch: 'main',
      path: wtPath,
    },
  });
  return { repoRoot, caws, wtPath };
}

function runCleanupPlan(cwd, opts = {}) {
  const out = [];
  const err = [];
  const code = runWorktreePhysicalCleanupPlanCommand({
    cwd,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    now: () => new Date('2026-07-04T12:00:00.000Z'),
    ...opts,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('caws worktree cleanup-plan --apply cwd self-destruct guard (CAWS-FIX-CWD-GUARD-COVERAGE-001)', () => {
  test('refuses to destroy a destroy-ready worktree when the operator cwd is inside it (A1)', () => {
    const { repoRoot, caws, wtPath } = fixture();

    // Operator runs cleanup-plan --apply FROM INSIDE the worktree dir.
    const result = runCleanupPlan(wtPath, {
      state: ['destroy-ready'],
      apply: true,
      json: true,
    });

    // Exit 1: at least one candidate failed (the destroy was refused).
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.out);
    expect(payload.counts).toEqual({ applied: 0, refused: 0, failed: 1 });

    const outcome = payload.outcomes.find((o) => o.subject === 'wt-ready');
    expect(outcome).toBeDefined();
    expect(outcome.action).toBe('failed');
    expect(outcome.reason).toMatch(/Refusing to destroy worktree "wt-ready"/);
    expect(outcome.reason).toMatch(/current directory is inside it/);

    // The guard fired BEFORE any mutation: the worktree dir and registry
    // entry are unchanged. The operator's shell is not wedged.
    expect(fs.existsSync(wtPath)).toBe(true);
    const registry = readRegistry(caws);
    expect(registry['wt-ready']).toBeDefined();
  });

  test('destroys normally when the operator cwd is the repo root (A2)', () => {
    const { repoRoot, caws, wtPath } = fixture();

    // Operator runs from the repo root — NOT inside the worktree.
    const result = runCleanupPlan(repoRoot, {
      state: ['destroy-ready'],
      apply: true,
      json: true,
    });

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.out);
    expect(payload.counts).toEqual({ applied: 1, refused: 0, failed: 0 });
    expect(payload.outcomes[0].subject).toBe('wt-ready');
    expect(payload.outcomes[0].action).toBe('applied');

    // Destroyed: dir gone, registry entry removed.
    expect(fs.existsSync(wtPath)).toBe(false);
    const registry = readRegistry(caws);
    expect(registry['wt-ready']).toBeUndefined();
  });

  test('refuses when cwd is a DESCENDANT of the worktree dir, not just the dir itself', () => {
    const { repoRoot, caws, wtPath } = fixture();
    // A subdirectory inside the worktree.
    const nestedCwd = path.join(wtPath, 'packages', 'caws-cli');
    fs.mkdirSync(nestedCwd, { recursive: true });

    const result = runCleanupPlan(nestedCwd, {
      state: ['destroy-ready'],
      apply: true,
      json: true,
    });

    expect(result.code).toBe(1);
    const payload = JSON.parse(result.out);
    expect(payload.outcomes[0].action).toBe('failed');
    expect(payload.outcomes[0].reason).toMatch(/Refusing to destroy worktree "wt-ready"/);
    expect(fs.existsSync(wtPath)).toBe(true);
    expect(readRegistry(caws)['wt-ready']).toBeDefined();
  });
});
