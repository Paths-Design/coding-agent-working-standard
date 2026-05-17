import {
  WORKTREE_RULES,
  canTransitionSpecWithWorktree,
} from '../../src/worktree';
import type { SpecTransition, WorktreeRegistry } from '../../src/worktree';
import type { Spec } from '../../src/spec/types';
import { isErr, isOk } from '../../src/result';

function makeSpec(overrides: Partial<Spec> = {}): Spec {
  return {
    id: 'TEST-1',
    title: 'Test spec',
    risk_tier: 3,
    mode: 'feature',
    lifecycle_state: 'active',
    blast_radius: { modules: ['src/test'] },
    scope: { in: ['src/**'] },
    invariants: ['none'],
    acceptance: [{ id: 'A1', given: 'g', when: 'w', then: 't' }],
    non_functional: {},
    contracts: [],
    ...overrides,
  };
}

describe('canTransitionSpecWithWorktree — clean transitions', () => {
  it('allows close with no bindings', () => {
    const r = canTransitionSpecWithWorktree(makeSpec(), {}, 'close');
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.allowed).toBe(true);
      expect(r.value.binding).toBeUndefined();
    }
  });

  it('allows archive with no bindings', () => {
    expect(isOk(canTransitionSpecWithWorktree(makeSpec(), {}, 'archive'))).toBe(true);
  });

  it('allows delete with no bindings', () => {
    expect(isOk(canTransitionSpecWithWorktree(makeSpec(), {}, 'delete'))).toBe(true);
  });
});

describe('canTransitionSpecWithWorktree — blocked by active binding', () => {
  function withBinding(): WorktreeRegistry {
    return { 'wt-foo': { specId: 'TEST-1' } };
  }

  it('blocks close', () => {
    const r = canTransitionSpecWithWorktree(makeSpec(), withBinding(), 'close');
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.errors[0]!.rule).toBe(WORKTREE_RULES.TRANSITION_BLOCKED_BY_ACTIVE_BINDING);
      expect(r.errors[0]!.data?.['bound_worktrees']).toEqual(['wt-foo']);
    }
  });

  it('blocks archive', () => {
    expect(isErr(canTransitionSpecWithWorktree(makeSpec(), withBinding(), 'archive'))).toBe(true);
  });

  it('blocks delete', () => {
    expect(isErr(canTransitionSpecWithWorktree(makeSpec(), withBinding(), 'delete'))).toBe(true);
  });

  it('reports all bound worktrees', () => {
    const registry: WorktreeRegistry = {
      'wt-a': { specId: 'TEST-1' },
      'wt-b': { specId: 'TEST-1' },
      'wt-other': { specId: 'OTHER-1' },
    };
    const r = canTransitionSpecWithWorktree(makeSpec(), registry, 'close');
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const list = r.errors[0]!.data?.['bound_worktrees'] as string[];
      expect(list).toContain('wt-a');
      expect(list).toContain('wt-b');
      expect(list).not.toContain('wt-other');
    }
  });
});

describe('canTransitionSpecWithWorktree — merge_finalize is the legal close vector', () => {
  it('merge_finalize is allowed even when binding exists', () => {
    const registry: WorktreeRegistry = { 'wt-foo': { specId: 'TEST-1' } };
    const r = canTransitionSpecWithWorktree(makeSpec(), registry, 'merge_finalize');
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.allowed).toBe(true);
      expect(r.value.binding).toEqual({ worktree_name: 'wt-foo', spec_id: 'TEST-1' });
    }
  });

  it('merge_finalize is allowed with no binding (idempotent close path)', () => {
    const r = canTransitionSpecWithWorktree(makeSpec(), {}, 'merge_finalize');
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.binding).toBeUndefined();
    }
  });
});

describe('canTransitionSpecWithWorktree — invalid transition', () => {
  it('refuses an unknown transition string', () => {
    const r = canTransitionSpecWithWorktree(
      makeSpec(),
      {},
      'reopen' as unknown as SpecTransition
    );
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.errors[0]!.rule).toBe(WORKTREE_RULES.TRANSITION_INVALID);
  });
});
