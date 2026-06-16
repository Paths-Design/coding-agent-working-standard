/**
 * Unit tests for evaluateContention — cross-worktree scope contention
 * (CAWS-SCOPE-CONTENTION-CMD-001).
 *
 * Pins the ACTUAL contention decision: which active worktree's bound active
 * spec scope.in claims a path, on the same base branch. The hook's correctness
 * (worktree-write-guard.sh) rests on this being the single matcher, so tests
 * assert exact claimant identity, the closed/non-active exclusion, and the
 * fail-closed `undetermined` cases (missing specId / spec / scope) that must
 * NOT collapse to `clear`.
 */

import { evaluateContention } from '../../src/scope/contention';
import type { Spec } from '../../src/spec/types';
import type { WorktreeRegistry } from '../../src/worktree/types';

function spec(id: string, scopeIn: string[], lifecycle: Spec['lifecycle_state'] = 'active'): Spec {
  return {
    id,
    title: `${id} title`,
    risk_tier: 3,
    mode: 'chore',
    lifecycle_state: lifecycle,
    blast_radius: { modules: ['m'], data_migration: false },
    scope: { in: scopeIn, out: [] },
    invariants: ['inv'],
    acceptance: [{ id: 'A1', given: 'g', when: 'w', then: 't' }],
    non_functional: {},
    contracts: [],
  } as unknown as Spec;
}

const BRANCH = 'main';

function reg(records: WorktreeRegistry): WorktreeRegistry {
  return records;
}

describe('evaluateContention: claim detection (A1)', () => {
  test('only the worktree whose spec scope.in admits the path is a claimant', () => {
    const worktrees = reg({
      'wt-a': { specId: 'A-1', baseBranch: BRANCH, path: '/x/wt-a' },
      'wt-b': { specId: 'B-1', baseBranch: BRANCH, path: '/x/wt-b' },
    });
    const specs = [
      spec('A-1', ['packages/foo']),
      spec('B-1', ['packages/bar']),
    ];
    const r = evaluateContention({
      path: 'packages/foo/x.ts',
      worktrees,
      specs,
      currentBranch: BRANCH,
    });
    expect(r.status).toBe('claimed');
    if (r.status !== 'claimed') throw new Error('expected claimed');
    expect(r.claimants).toEqual([
      { worktreeName: 'wt-a', specId: 'A-1', matchedPattern: 'packages/foo' },
    ]);
  });

  test('a closed/non-active spec is never a claimant', () => {
    const worktrees = reg({
      'wt-a': { specId: 'A-1', baseBranch: BRANCH, path: '/x/wt-a' },
    });
    const specs = [spec('A-1', ['packages/foo'], 'closed')];
    const r = evaluateContention({
      path: 'packages/foo/x.ts',
      worktrees,
      specs,
      currentBranch: BRANCH,
    });
    expect(r.status).toBe('clear');
  });

  test('a worktree on a DIFFERENT base branch does not contend', () => {
    const worktrees = reg({
      'wt-a': { specId: 'A-1', baseBranch: 'other-branch', path: '/x/wt-a' },
    });
    const specs = [spec('A-1', ['packages/foo'])];
    const r = evaluateContention({
      path: 'packages/foo/x.ts',
      worktrees,
      specs,
      currentBranch: BRANCH,
    });
    expect(r.status).toBe('clear');
  });
});

describe('evaluateContention: clear (A2)', () => {
  test('no active worktree claims the path -> clear, empty claimants', () => {
    const worktrees = reg({
      'wt-a': { specId: 'A-1', baseBranch: BRANCH, path: '/x/wt-a' },
    });
    const specs = [spec('A-1', ['packages/foo'])];
    const r = evaluateContention({
      path: 'packages/unrelated/y.ts',
      worktrees,
      specs,
      currentBranch: BRANCH,
    });
    expect(r.status).toBe('clear');
    if (r.status === 'clear') expect(r.claimants).toEqual([]);
  });
});

describe('evaluateContention: fail-closed undetermined (A3)', () => {
  test('missing specId -> undetermined, NOT clear', () => {
    const worktrees = reg({ 'wt-a': { baseBranch: BRANCH, path: '/x/wt-a' } });
    const r = evaluateContention({
      path: 'packages/foo/x.ts',
      worktrees,
      specs: [],
      currentBranch: BRANCH,
    });
    expect(r.status).toBe('undetermined');
    if (r.status === 'undetermined') {
      expect(r.reason).toBe('missing-specId');
      expect(r.worktreeName).toBe('wt-a');
    }
  });

  test('specId present but spec not loaded -> undetermined missing-spec', () => {
    const worktrees = reg({ 'wt-a': { specId: 'GONE-1', baseBranch: BRANCH, path: '/x/wt-a' } });
    const r = evaluateContention({
      path: 'packages/foo/x.ts',
      worktrees,
      specs: [],
      currentBranch: BRANCH,
    });
    expect(r.status).toBe('undetermined');
    if (r.status === 'undetermined') expect(r.reason).toBe('missing-spec');
  });

  test('active spec with empty scope.in -> undetermined missing-scope', () => {
    const worktrees = reg({ 'wt-a': { specId: 'A-1', baseBranch: BRANCH, path: '/x/wt-a' } });
    const specs = [spec('A-1', [])];
    const r = evaluateContention({
      path: 'packages/foo/x.ts',
      worktrees,
      specs,
      currentBranch: BRANCH,
    });
    expect(r.status).toBe('undetermined');
    if (r.status === 'undetermined') expect(r.reason).toBe('missing-scope');
  });
});

describe('evaluateContention: worktree existence predicate', () => {
  test('a registry entry whose directory is absent is skipped', () => {
    const worktrees = reg({
      'wt-a': { specId: 'A-1', baseBranch: BRANCH, path: '/x/wt-a' },
    });
    const specs = [spec('A-1', ['packages/foo'])];
    const r = evaluateContention({
      path: 'packages/foo/x.ts',
      worktrees,
      specs,
      currentBranch: BRANCH,
      worktreeExists: () => false, // directory gone
    });
    expect(r.status).toBe('clear');
  });
});
