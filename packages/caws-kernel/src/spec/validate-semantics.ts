import { diagnostic } from '../diagnostics';
import type { Diagnostic } from '../diagnostics/types';
import { err, ok } from '../result';
import type { Result } from '../result/types';
import { SPEC_RULES } from './rules';
import type { Spec } from './types';

export interface SemanticOptions {
  sourcePath?: string;
}

/**
 * Tier-gated and lifecycle-shape semantic rules. Runs after the schema
 * has confirmed the structural shape.
 *
 * Out of scope (deferred to lifecycle / worktree / evidence slices):
 * - "cannot close while a worktree is bound"
 * - "evidence must exist before closure"
 * - "supersedes/superseded_by must form a valid graph"
 */
export function validateSpecSemantics(spec: Spec, options: SemanticOptions = {}): Result<Spec> {
  const errors: Diagnostic[] = [];
  const subjectBase = options.sourcePath ?? spec.id;

  // Tier 1+2 require contracts (unless mode === chore).
  // Schema permits empty contracts: [] for tier 3 / chore mode.
  if (spec.mode !== 'chore') {
    if (spec.risk_tier === 1 && spec.contracts.length === 0) {
      errors.push(
        diagnostic({
          rule: SPEC_RULES.TIER1_MISSING_CONTRACTS,
          authority: 'kernel/spec',
          message: 'Tier 1 specs require at least one contract.',
          subject: subjectBase,
          location: { pointer: '/contracts' },
          narrowRepair: 'Add at least one contract or change risk_tier to 3 or mode to chore.',
        }),
      );
    } else if (spec.risk_tier === 2 && spec.contracts.length === 0) {
      errors.push(
        diagnostic({
          rule: SPEC_RULES.TIER2_MISSING_CONTRACTS,
          authority: 'kernel/spec',
          message: 'Tier 2 specs require at least one contract.',
          subject: subjectBase,
          location: { pointer: '/contracts' },
          narrowRepair: 'Add at least one contract or change risk_tier to 3 or mode to chore.',
        }),
      );
    }
  }

  // Tier 1: observability + rollback + non_functional.security all required non-empty.
  if (spec.risk_tier === 1) {
    if (!spec.observability || spec.observability.length === 0) {
      errors.push(
        diagnostic({
          rule: SPEC_RULES.TIER1_MISSING_OBSERVABILITY,
          authority: 'kernel/spec',
          message: 'Tier 1 specs require non-empty observability.',
          subject: subjectBase,
          location: { pointer: '/observability' },
          narrowRepair: 'Add at least one observability item (log, metric, trace, alert).',
        }),
      );
    }
    if (!spec.rollback || spec.rollback.length === 0) {
      errors.push(
        diagnostic({
          rule: SPEC_RULES.TIER1_MISSING_ROLLBACK,
          authority: 'kernel/spec',
          message: 'Tier 1 specs require non-empty rollback.',
          subject: subjectBase,
          location: { pointer: '/rollback' },
          narrowRepair: 'Add at least one rollback step.',
        }),
      );
    }
    const sec = spec.non_functional.security;
    if (!sec || sec.length === 0) {
      errors.push(
        diagnostic({
          rule: SPEC_RULES.TIER1_MISSING_SECURITY,
          authority: 'kernel/spec',
          message: 'Tier 1 specs require non-empty non_functional.security.',
          subject: subjectBase,
          location: { pointer: '/non_functional/security' },
          narrowRepair: 'Add at least one security requirement.',
        }),
      );
    }
  }

  // experimental_mode is only valid on Tier 3.
  if (spec.experimental_mode !== undefined && spec.risk_tier !== 3) {
    errors.push(
      diagnostic({
        rule: SPEC_RULES.EXPERIMENTAL_MODE_TIER_RESTRICTED,
        authority: 'kernel/spec',
        message: 'experimental_mode is only valid on Tier 3 specs.',
        subject: subjectBase,
        location: { pointer: '/experimental_mode' },
        narrowRepair: 'Remove experimental_mode or change risk_tier to 3.',
      }),
    );
  }

  // resolution may exist only when lifecycle_state is closed or archived.
  if (spec.resolution !== undefined && spec.lifecycle_state !== 'closed' && spec.lifecycle_state !== 'archived') {
    errors.push(
      diagnostic({
        rule: SPEC_RULES.RESOLUTION_REQUIRES_CLOSURE,
        authority: 'kernel/spec',
        message: `resolution is only valid when lifecycle_state is closed or archived (got ${spec.lifecycle_state}).`,
        subject: subjectBase,
        location: { pointer: '/resolution' },
        narrowRepair: 'Remove resolution, or transition lifecycle_state to closed.',
      }),
    );
  }

  // closed/archived specs should have a resolution recorded.
  if (
    (spec.lifecycle_state === 'closed' || spec.lifecycle_state === 'archived') &&
    spec.resolution === undefined
  ) {
    errors.push(
      diagnostic({
        rule: SPEC_RULES.CLOSED_SPEC_MISSING_RESOLUTION,
        authority: 'kernel/spec',
        message: `${spec.lifecycle_state} specs must record a resolution.`,
        subject: subjectBase,
        location: { pointer: '/resolution' },
        narrowRepair: 'Set resolution to one of: completed, superseded, abandoned.',
      }),
    );
  }

  // supersedes self-reference.
  if (spec.supersedes !== undefined && spec.supersedes === spec.id) {
    errors.push(
      diagnostic({
        rule: SPEC_RULES.SUPERSEDES_SELF_REFERENCE,
        authority: 'kernel/spec',
        message: 'A spec cannot supersede itself.',
        subject: subjectBase,
        location: { pointer: '/supersedes' },
        narrowRepair: 'Remove the self-reference or change the supersedes target.',
      }),
    );
  }

  if (errors.length > 0) {
    return err(errors);
  }
  return ok(spec);
}
