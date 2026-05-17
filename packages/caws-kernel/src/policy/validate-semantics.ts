import { diagnostic } from '../diagnostics';
import type { Diagnostic } from '../diagnostics/types';
import { err, ok } from '../result';
import type { Result } from '../result/types';
import { CRITICAL_GATES, POLICY_RULES, RISKY_ROOT_FILES } from './rules';
import type { Policy } from './types';

export interface SemanticOptions {
  sourcePath?: string;
}

/**
 * Policy semantic checks. Runs after the schema has confirmed the
 * structural shape.
 *
 * Errors:
 *  - Non-monotonic risk tiers (T1 max > T2 max, etc.)
 *
 * Warnings (returned as Ok with warnings, not Err):
 *  - non_governed_zones_force: true is in effect
 *  - critical gates (budget_limit, spec_completeness, scope_boundary) not in block mode
 *  - root_passthrough entries that match high-blast-radius file names
 */
export function validatePolicySemantics(policy: Policy, options: SemanticOptions = {}): Result<Policy> {
  const errors: Diagnostic[] = [];
  const warnings: Diagnostic[] = [];
  const subjectBase = options.sourcePath ?? '.caws/policy.yaml';

  // --- Errors ---

  // Monotonicity: T1 ≤ T2 ≤ T3 for both max_files and max_loc.
  const t1 = policy.risk_tiers['1'];
  const t2 = policy.risk_tiers['2'];
  const t3 = policy.risk_tiers['3'];

  if (t1.max_files > t2.max_files || t2.max_files > t3.max_files) {
    errors.push(
      diagnostic({
        rule: POLICY_RULES.TIER_NON_MONOTONIC_FILES,
        authority: 'kernel/policy',
        message: `Risk-tier max_files must be monotonic: T1 (${t1.max_files}) ≤ T2 (${t2.max_files}) ≤ T3 (${t3.max_files}).`,
        subject: subjectBase,
        location: { pointer: '/risk_tiers' },
        narrowRepair:
          'Order tiers from strict to permissive: max_files must increase or stay equal as risk_tier rises.',
      }),
    );
  }

  if (t1.max_loc > t2.max_loc || t2.max_loc > t3.max_loc) {
    errors.push(
      diagnostic({
        rule: POLICY_RULES.TIER_NON_MONOTONIC_LOC,
        authority: 'kernel/policy',
        message: `Risk-tier max_loc must be monotonic: T1 (${t1.max_loc}) ≤ T2 (${t2.max_loc}) ≤ T3 (${t3.max_loc}).`,
        subject: subjectBase,
        location: { pointer: '/risk_tiers' },
        narrowRepair: 'Order tiers from strict to permissive: max_loc must increase or stay equal as risk_tier rises.',
      }),
    );
  }

  // --- Warnings ---

  // Critical gates should default to block mode.
  for (const gateId of CRITICAL_GATES) {
    const gate = policy.gates[gateId];
    if (gate && gate.mode !== 'block') {
      warnings.push(
        diagnostic({
          rule: POLICY_RULES.CRITICAL_GATE_NOT_BLOCKING,
          authority: 'kernel/policy',
          message: `Critical gate "${gateId}" is in "${gate.mode}" mode; expected "block".`,
          subject: subjectBase,
          location: { pointer: `/gates/${gateId}/mode` },
          narrowRepair: `Set gates.${gateId}.mode to "block" unless the deviation is intentional and documented.`,
          severity: 'warning',
        }),
      );
    }
  }

  // non_governed_zones_force is a deliberate authority-relinquishing flag.
  if (policy.non_governed_zones_force === true) {
    warnings.push(
      diagnostic({
        rule: POLICY_RULES.NON_GOVERNED_FORCE_USED,
        authority: 'kernel/policy',
        message:
          'non_governed_zones_force is enabled — broad non-governed-zone patterns are admitted, weakening scope authority.',
        subject: subjectBase,
        location: { pointer: '/non_governed_zones_force' },
        narrowRepair:
          'Remove non_governed_zones_force unless authority relinquishment is reviewed and documented in policy.',
        severity: 'warning',
      }),
    );
  }

  // root_passthrough warnings for high-blast-radius files.
  if (policy.root_passthrough) {
    for (const [idx, entry] of policy.root_passthrough.entries()) {
      if ((RISKY_ROOT_FILES as readonly string[]).includes(entry)) {
        warnings.push(
          diagnostic({
            rule: POLICY_RULES.ROOT_PASSTHROUGH_RISKY_FILE,
            authority: 'kernel/policy',
            message: `root_passthrough admits "${entry}", a high-blast-radius file. Edits to it bypass scope.in.`,
            subject: subjectBase,
            location: { pointer: `/root_passthrough/${idx}` },
            narrowRepair: `Remove "${entry}" from root_passthrough and list it explicitly in scope.in of any spec that needs to edit it.`,
            severity: 'warning',
          }),
        );
      }
    }
  }

  if (errors.length > 0) {
    return err(errors);
  }
  return ok(policy, warnings.length > 0 ? warnings : undefined);
}
