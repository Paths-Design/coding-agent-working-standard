import {
  WORKTREE_RULES,
  bindWorktree,
  deriveBindingState,
} from '../../src/worktree';
import type { SessionIdentity, WorktreeRegistry } from '../../src/worktree';
import type { Spec } from '../../src/spec/types';
import { isErr, isOk } from '../../src/result';

const NOW = new Date('2026-05-09T00:00:00.000Z');

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

const SESS: SessionIdentity = { session_id: 'sess-1', platform: 'claude-code' };

// ---------------------------------------------------------------------------
// deriveBindingState
// ---------------------------------------------------------------------------

describe('deriveBindingState — bound', () => {
  it('returns bound when registry and spec point at each other', () => {
    const spec = makeSpec({ worktree: 'wt-foo' });
    const registry: WorktreeRegistry = { 'wt-foo': { specId: 'TEST-1', owner: SESS } };
    const state = deriveBindingState(spec, registry, 'wt-foo');
    expect(state.kind).toBe('bound');
    if (state.kind === 'bound') {
      expect(state.spec.id).toBe('TEST-1');
      expect(state.worktreeName).toBe('wt-foo');
    }
  });
});

describe('deriveBindingState — one_sided', () => {
  it('reports registry-only one_sided', () => {
    const spec = makeSpec(); // no spec.worktree
    const registry: WorktreeRegistry = { 'wt-foo': { specId: 'TEST-1' } };
    const state = deriveBindingState(spec, registry, 'wt-foo');
    expect(state.kind).toBe('one_sided');
    if (state.kind === 'one_sided') {
      expect(state.detail.registryHasSpecId).toBe(true);
      expect(state.detail.specHasWorktree).toBe(false);
      expect(state.detail.registrySpecId).toBe('TEST-1');
    }
  });

  it('reports spec-only one_sided', () => {
    const spec = makeSpec({ worktree: 'wt-foo' });
    const registry: WorktreeRegistry = {};
    const state = deriveBindingState(spec, registry, 'wt-foo');
    expect(state.kind).toBe('one_sided');
    if (state.kind === 'one_sided') {
      expect(state.detail.specHasWorktree).toBe(true);
      expect(state.detail.registryHasSpecId).toBe(false);
      expect(state.detail.specWorktree).toBe('wt-foo');
    }
  });

  it('reports cross-mismatch as one_sided (different ids)', () => {
    const spec = makeSpec({ worktree: 'wt-foo' });
    const registry: WorktreeRegistry = { 'wt-foo': { specId: 'OTHER-99' } };
    const state = deriveBindingState(spec, registry, 'wt-foo');
    expect(state.kind).toBe('one_sided');
  });
});

describe('deriveBindingState — unbound', () => {
  it('returns unbound when neither side points', () => {
    const spec = makeSpec();
    const registry: WorktreeRegistry = {};
    expect(deriveBindingState(spec, registry, 'wt-missing').kind).toBe('unbound');
  });

  it('returns unbound when registry entry exists with no specId', () => {
    const spec = makeSpec();
    const registry: WorktreeRegistry = { 'wt-foo': { branch: 'caws/wt-foo' } };
    expect(deriveBindingState(spec, registry, 'wt-foo').kind).toBe('unbound');
  });
});

// ---------------------------------------------------------------------------
// bindWorktree — fresh / idempotent / rebind
// ---------------------------------------------------------------------------

describe('bindWorktree — fresh', () => {
  it('produces a bind_worktree patch when no existing record', () => {
    const r = bindWorktree(makeSpec(), {}, 'wt-foo', SESS, {}, NOW);
    expect(isOk(r)).toBe(true);
    if (isOk(r) && r.value.kind === 'bind_worktree') {
      expect(r.value.spec_id).toBe('TEST-1');
      expect(r.value.worktree_name).toBe('wt-foo');
      expect(r.value.idempotent).toBe(false);
      expect(r.value.when).toBe(NOW.toISOString());
      expect(r.warnings).toBeUndefined();
    }
  });

  it('produces a bind_worktree patch when registry has no specId', () => {
    const registry: WorktreeRegistry = { 'wt-foo': { branch: 'caws/wt-foo' } };
    const r = bindWorktree(makeSpec(), registry, 'wt-foo', SESS, {}, NOW);
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value.kind).toBe('bind_worktree');
  });
});

describe('bindWorktree — idempotent same-spec', () => {
  it('returns idempotent=true patch when existing binds the same spec', () => {
    const registry: WorktreeRegistry = { 'wt-foo': { specId: 'TEST-1' } };
    const r = bindWorktree(makeSpec(), registry, 'wt-foo', SESS, {}, NOW);
    expect(isOk(r)).toBe(true);
    if (isOk(r) && r.value.kind === 'bind_worktree') {
      expect(r.value.idempotent).toBe(true);
      expect(r.warnings).toBeUndefined();
    }
  });
});

describe('bindWorktree — rebind discipline (option B)', () => {
  it('refuses different-spec rebind without explicit flag', () => {
    const registry: WorktreeRegistry = { 'wt-foo': { specId: 'OTHER-99' } };
    const r = bindWorktree(makeSpec(), registry, 'wt-foo', SESS, {}, NOW);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.errors[0]!.rule).toBe(WORKTREE_RULES.BINDING_REBIND_REQUIRES_EXPLICIT_FLAG);
      expect(r.errors[0]!.data?.['from_spec_id']).toBe('OTHER-99');
      expect(r.errors[0]!.data?.['to_spec_id']).toBe('TEST-1');
    }
  });

  it('accepts different-spec rebind with rebind:true and emits a warning', () => {
    const registry: WorktreeRegistry = { 'wt-foo': { specId: 'OTHER-99' } };
    const r = bindWorktree(makeSpec(), registry, 'wt-foo', SESS, { rebind: true }, NOW);
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.kind).toBe('rebind_worktree');
      if (r.value.kind === 'rebind_worktree') {
        expect(r.value.from_spec_id).toBe('OTHER-99');
        expect(r.value.to_spec_id).toBe('TEST-1');
      }
      expect(r.warnings).toBeDefined();
      expect(r.warnings?.[0]!.rule).toBe(WORKTREE_RULES.BINDING_REBIND_PERFORMED);
      expect(r.warnings?.[0]!.severity).toBe('warning');
    }
  });

  it('does NOT pair the rebind warning with a refusal — it ships only on success', () => {
    const registry: WorktreeRegistry = { 'wt-foo': { specId: 'OTHER-99' } };
    const refused = bindWorktree(makeSpec(), registry, 'wt-foo', SESS, {}, NOW);
    expect(isErr(refused)).toBe(true);
    if (isErr(refused)) {
      // No `BINDING_REBIND_PERFORMED` should appear among the errors.
      expect(refused.errors.map((e) => e.rule)).not.toContain(
        WORKTREE_RULES.BINDING_REBIND_PERFORMED
      );
    }
  });
});

describe('bindWorktree — governable state', () => {
  it('refuses to bind a closed spec', () => {
    const r = bindWorktree(
      makeSpec({ lifecycle_state: 'closed' }),
      {},
      'wt-foo',
      SESS,
      {},
      NOW
    );
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.errors[0]!.rule).toBe(WORKTREE_RULES.BINDING_SPEC_NOT_GOVERNABLE);
    }
  });

  it('refuses to bind an archived spec', () => {
    const r = bindWorktree(
      makeSpec({ lifecycle_state: 'archived' }),
      {},
      'wt-foo',
      SESS,
      {},
      NOW
    );
    expect(isErr(r)).toBe(true);
  });

  it('allows binding draft and active specs', () => {
    expect(
      isOk(bindWorktree(makeSpec({ lifecycle_state: 'draft' }), {}, 'wt-foo', SESS, {}, NOW))
    ).toBe(true);
    expect(
      isOk(bindWorktree(makeSpec({ lifecycle_state: 'active' }), {}, 'wt-foo', SESS, {}, NOW))
    ).toBe(true);
  });
});

describe('bindWorktree — input validation', () => {
  it('refuses bad worktree name', () => {
    const r = bindWorktree(makeSpec(), {}, 'no slashes/here', SESS, {}, NOW);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.errors[0]!.rule).toBe(WORKTREE_RULES.IDENTITY_NAME_INVALID);
  });

  it('refuses empty session_id', () => {
    const r = bindWorktree(
      makeSpec(),
      {},
      'wt-foo',
      { session_id: '' } as SessionIdentity,
      {},
      NOW
    );
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.errors[0]!.rule).toBe(WORKTREE_RULES.IDENTITY_SESSION_ID_EMPTY);
  });
});
