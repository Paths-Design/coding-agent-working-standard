/**
 * Minimal typed fixtures for scope-evaluator tests.
 *
 * CAWS-TEST-KERNEL-PURE-001. evaluatePath reads only spec.id + spec.scope and
 * a handful of Policy fields (non_governed_zones, root_passthrough). The full
 * Spec/Policy types carry many more required fields that the evaluator never
 * touches, so these factories build the minimal type-satisfying shapes. The
 * cast is honest: these tests exercise SCOPE evaluation, not full spec/policy
 * validation (those have their own suites).
 */

import type { Policy } from '../../src/policy/types';
import type { Scope } from '../../src/spec/types';
import type { BindingState } from '../../src/worktree/types';
import type { Spec } from '../../src/spec/types';

/** A Policy with the evaluator-relevant fields set; the rest is inert filler. */
export function makePolicy(overrides: Partial<Policy> = {}): Policy {
  const tier = { max_files: 0, max_loc: 0 } as Policy['risk_tiers']['1'];
  const gate = { mode: 'block' } as Policy['gates']['budget_limit'];
  return {
    version: 1,
    risk_tiers: { '1': tier, '2': tier, '3': tier },
    gates: { budget_limit: gate, spec_completeness: gate, scope_boundary: gate },
    ...overrides,
  };
}

/** A bound BindingState carrying a spec whose only meaningful fields are id + scope. */
export function makeBound(scope: Scope, id = 'TEST-SPEC-001'): BindingState {
  const spec = { id, scope } as unknown as Spec;
  return { kind: 'bound', spec, worktreeName: 'wt-test' };
}

export const UNBOUND: BindingState = { kind: 'unbound' };

export function makeOneSided(): BindingState {
  return {
    kind: 'one_sided',
    detail: { specHasWorktree: true, registryHasSpecId: false },
  };
}
