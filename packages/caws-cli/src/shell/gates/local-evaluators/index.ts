// Local gate evaluators — caws-cli's contribution to the gates pipeline.
//
// Why local evaluators exist
// ──────────────────────────
// The quality-gates subprocess implements *code-quality* checks (naming,
// duplication, god objects, hidden TODOs, etc.). Those checks live in
// `@paths.design/quality-gates` because they're general-purpose and
// language-agnostic.
//
// CAWS *policy* gates (`budget_limit`, `scope_boundary`,
// `spec_completeness`) are different in kind: they need the active spec
// id, the spec YAML, the policy YAML, and the staged diff. Pushing them
// into the generic subprocess would couple quality-gates to caws-cli's
// state shape. Keeping them local preserves layering:
//
//   quality-gates package  : code-quality checks → JSON violations[]
//   caws-cli local         : policy/spec/diff authority checks
//                             → additional JSON violations[]
//   gates command          : merge violations, apply waivers,
//                             derive disposition, emit events
//
// Each evaluator returns the same `GatesViolation[]` shape the
// subprocess emits, so the downstream disposition/waiver pipeline is
// uniform.

import type { Spec, Policy } from '@paths.design/caws-kernel';

import type { GatesViolation } from '../gate-result-contract';
import { evaluateBudgetLimit } from './budget-limit';
import { evaluateScopeBoundary } from './scope-boundary';
import { evaluateSpecCompleteness } from './spec-completeness';
import type { StagedFileChange } from './diff-helpers';

export type { StagedFileChange } from './diff-helpers';
export { evaluateBudgetLimit } from './budget-limit';
export { evaluateScopeBoundary } from './scope-boundary';
export { evaluateSpecCompleteness } from './spec-completeness';

export interface LocalEvaluatorsInput {
  readonly spec: Spec;
  readonly policy: Policy;
  readonly repoRoot: string;
  readonly nowIso: string;
  /** Worktree name for scope diagnostics (optional). */
  readonly worktreeName?: string;
  /** Override staged-diff source (tests). When provided, all evaluators
   *  use this list instead of shelling out to git. */
  readonly stagedChanges?: readonly StagedFileChange[];
}

export interface LocalEvaluatorsResult {
  readonly violations: readonly GatesViolation[];
}

/**
 * Run all CAWS-local policy evaluators against the given spec+policy.
 * Returns a flat list of violations tagged with canonical policy gate
 * names (`budget_limit`, `scope_boundary`, `spec_completeness`).
 */
export function runLocalEvaluators(input: LocalEvaluatorsInput): LocalEvaluatorsResult {
  const violations: GatesViolation[] = [];

  const budget = evaluateBudgetLimit({
    spec: input.spec,
    policy: input.policy,
    repoRoot: input.repoRoot,
    ...(input.stagedChanges !== undefined ? { stagedChanges: input.stagedChanges } : {}),
  });
  violations.push(...budget.violations);

  const scope = evaluateScopeBoundary({
    spec: input.spec,
    policy: input.policy,
    repoRoot: input.repoRoot,
    ...(input.worktreeName !== undefined ? { worktreeName: input.worktreeName } : {}),
    ...(input.stagedChanges !== undefined ? { stagedChanges: input.stagedChanges } : {}),
  });
  violations.push(...scope.violations);

  const completeness = evaluateSpecCompleteness({
    spec: input.spec,
    nowIso: input.nowIso,
  });
  violations.push(...completeness.violations);

  return { violations };
}
