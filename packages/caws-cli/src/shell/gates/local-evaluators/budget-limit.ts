// budget_limit evaluator.
//
// Compares staged diff size to the policy's per-risk-tier budget.
//
// Rules:
//   - Risk tier comes from the active spec (1, 2, or 3).
//   - Budget comes from policy.risk_tiers[tier] (max_files, max_loc).
//   - A violation fires when files_changed > max_files or
//     loc_changed > max_loc. Each threshold breach is one violation.
//
// This evaluator is local (caws-cli concern). v11 deliberately keeps
// risk-tier budget enforcement in the CLI where the active spec and
// staged diff are authoritative.

import type { Spec } from '@paths.design/caws-kernel';
import type { Policy } from '@paths.design/caws-kernel';

import type { GatesViolation } from '../gate-result-contract';
import { listStagedChanges, totalInsertions, type StagedFileChange } from './diff-helpers';

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
    readonly max_files: number;
    readonly max_loc: number;
  };
}

function tierKey(tier: number): '1' | '2' | '3' | undefined {
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
    // Spec carries a risk_tier the schema accepts (1, 2, 3); anything
    // else is a spec-completeness problem, not a budget violation.
    return {
      violations: [],
      observed: { files_changed, loc_changed, max_files: 0, max_loc: 0 },
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
        `Staged change touches ${files_changed} file(s); risk-tier ${input.spec.risk_tier} ` +
        `budget allows up to ${max_files}.`,
      severity: 'fail',
    });
  }
  if (loc_changed > max_loc) {
    violations.push({
      gate: 'budget_limit',
      type: 'max_loc_exceeded',
      message:
        `Staged change adds ${loc_changed} line(s); risk-tier ${input.spec.risk_tier} ` +
        `budget allows up to ${max_loc}.`,
      severity: 'fail',
    });
  }

  return {
    violations,
    observed: { files_changed, loc_changed, max_files, max_loc },
  };
}
