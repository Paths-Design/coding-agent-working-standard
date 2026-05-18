// spec_completeness evaluator.
//
// Bridges spec health into gate disposition. The kernel/schema layer
// already enforces structural completeness (required fields, minItems
// on invariants/acceptance, lifecycle_state shape, etc.); a spec that
// fails schema validation never reaches this evaluator — composeStoreSnapshot
// excludes it, and gates.ts already refuses the run.
//
// So this evaluator covers the *semantic* completeness checks that the
// schema cannot enforce alone:
//
//   1. The active spec must be in lifecycle_state === 'active'. Running
//      gates against a closed/archived/draft spec is a category error.
//      Schema admits all four states; only 'active' is a valid gating
//      target.
//
//   2. blast_radius.modules must be non-empty. The schema requires
//      `modules` to exist but does not require minItems > 0.
//
//   3. If the spec has experimental_mode.enabled and expires_at is in
//      the past, the experimental status is stale — a completeness
//      issue surfaced for the operator to either renew or remove.
//
// Each failure produces one violation with gate: 'spec_completeness'.
// `caws-cli` shell decides whether to block based on policy.

import type { Spec } from '@paths.design/caws-kernel';

import type { GatesViolation } from '../gate-result-contract';

export interface SpecCompletenessInput {
  readonly spec: Spec;
  /** Current ISO timestamp for evaluating experimental_mode.expires_at. */
  readonly nowIso: string;
}

export interface SpecCompletenessResult {
  readonly violations: readonly GatesViolation[];
}

export function evaluateSpecCompleteness(input: SpecCompletenessInput): SpecCompletenessResult {
  const violations: GatesViolation[] = [];

  // Rule 1: lifecycle_state must be active for gating.
  if (input.spec.lifecycle_state !== 'active') {
    violations.push({
      gate: 'spec_completeness',
      type: 'spec_not_active',
      message:
        `Spec ${input.spec.id} is in lifecycle_state '${input.spec.lifecycle_state}'; ` +
        `gates only enforce against active specs. ` +
        `Either reopen the spec or run gates against an active spec.`,
      severity: 'fail',
    });
  }

  // Rule 2: blast_radius.modules must be non-empty.
  if (
    input.spec.blast_radius === undefined ||
    !Array.isArray(input.spec.blast_radius.modules) ||
    input.spec.blast_radius.modules.length === 0
  ) {
    violations.push({
      gate: 'spec_completeness',
      type: 'blast_radius_empty',
      message:
        `Spec ${input.spec.id} has no blast_radius.modules; risk evaluation ` +
        `cannot proceed without a declared blast radius.`,
      severity: 'fail',
    });
  }

  // Rule 3: experimental_mode expiry.
  const exp = input.spec.experimental_mode;
  if (exp !== undefined && exp.enabled === true) {
    if (typeof exp.expires_at === 'string') {
      const expDate = Date.parse(exp.expires_at);
      const now = Date.parse(input.nowIso);
      if (Number.isFinite(expDate) && Number.isFinite(now) && expDate < now) {
        violations.push({
          gate: 'spec_completeness',
          type: 'experimental_mode_expired',
          message:
            `Spec ${input.spec.id} has experimental_mode.enabled=true but expires_at ` +
            `(${exp.expires_at}) is in the past. Renew or remove the experimental status.`,
          severity: 'fail',
        });
      }
    }
  }

  return { violations };
}
