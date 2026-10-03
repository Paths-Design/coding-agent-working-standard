// budget_limit evaluator.
//
// Compares staged diff size to the policy's per-risk-tier sizing goal.
//
// Rules:
//   - Risk tier comes from the active spec (1, 2, or 3).
//   - The goal comes from policy.risk_tiers[tier] (max_files, max_loc).
//   - An observation fires when files_changed > max_files or
//     loc_changed > max_loc. Each threshold crossed is one observation.
//
// budget_limit is advisory (kernel ADVISORY_GATES): disposition never lets
// it block. The message is what an agent reads, so it says outright not to
// cut work to fit — a line count is a planning signal, scope is the boundary.

import type { Spec } from '../../../kernel';
import type { Policy } from '../../../kernel';

import type { GatesViolation } from '../gate-result-contract';
import { listStagedChanges, totalInsertions, type StagedFileChange } from './diff-helpers';

const SIZING_GOAL_ADVICE =
  'A sizing goal, not a limit: do not trim, defer or stub work to fit it. ' +
  'If the change is larger than planned, say so in the spec.';

export interface BudgetLimitInput {
  readonly spec: Spec;
  readonly policy: Policy;
  readonly repoRoot: string;
  /** Override the staged-diff source (tests). */
  readonly stagedChanges?: readonly StagedFileChange[];
}

export interface BudgetLimitResult {
  readonly violations: readonly GatesViolation[];
  /** Observed budget consumption, regardless of whether a violation fired.
   *  Useful for telemetry/diagnostics; not used for blocking. */
  readonly observed: {
    readonly files_changed: number;
    readonly loc_changed: number;
    readonly max_files: number | null;
    readonly max_loc: number | null;
  };
}

function tierKey(tier: number | undefined): '1' | '2' | '3' | undefined {
  if (tier === 1) return '1';
  if (tier === 2) return '2';
  if (tier === 3) return '3';
  return undefined;
}

export function evaluateBudgetLimit(input: BudgetLimitInput): BudgetLimitResult {
  const changes = input.stagedChanges ?? listStagedChanges(input.repoRoot);
  const files_changed = changes.length;
  const loc_changed = totalInsertions(changes);

  const tk = tierKey(input.spec.risk_tier);
  if (tk === undefined) {
    // Tierless specs have no legacy sizing goal. Never invent a tier or
    // report a zero-sized budget for them.
    return {
      violations: [],
      observed: { files_changed, loc_changed, max_files: null, max_loc: null },
    };
  }
  const budget = input.policy.risk_tiers[tk];
  const { max_files, max_loc } = budget;

  const violations: GatesViolation[] = [];
  if (files_changed > max_files) {
    violations.push({
      gate: 'budget_limit',
      type: 'max_files_exceeded',
      message:
        `Staged change touches ${files_changed} file(s); the risk-tier ${input.spec.risk_tier} ` +
        `sizing goal is ${max_files}. ${SIZING_GOAL_ADVICE}`,
      severity: 'warn',
    });
  }
  if (loc_changed > max_loc) {
    violations.push({
      gate: 'budget_limit',
      type: 'max_loc_exceeded',
      message:
        `Staged change adds ${loc_changed} line(s); the risk-tier ${input.spec.risk_tier} ` +
        `sizing goal is ${max_loc}. ${SIZING_GOAL_ADVICE}`,
      severity: 'warn',
    });
  }

  return {
    violations,
    observed: { files_changed, loc_changed, max_files, max_loc },
  };
}
