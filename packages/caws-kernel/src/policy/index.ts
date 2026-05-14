import { flatMap } from '../result/combinators';
import type { Result } from '../result/types';
import { parsePolicyYaml, type ParseOptions } from './parse';
import { validatePolicyShape } from './validate-shape';
import { validatePolicySemantics } from './validate-semantics';
import type { Policy } from './types';

// Re-export policy-owned types. The legacy `Waiver`/`WaiverStatus`
// shapes in policy/types.ts are budget-raise waivers used by
// derive-budget; the public `Waiver` type is the gate-violation
// waiver defined in `../waiver`. Avoid the name clash by aliasing
// the legacy names with a `Budget` prefix.
export type {
  EditRules,
  GateConfig,
  GateId,
  GateMode,
  Policy,
  RiskTierBudget,
  WaiversPolicy,
  WaiverApprover,
  WaiverDelta,
  EffectiveBudget,
  SkipReason,
  AppliedWaiverEntry,
  SkippedWaiverEntry,
  BudgetDerivationTrace,
} from './types';
// Legacy budget-raise waiver types aliased to avoid the name clash
// with the new gate-violation `Waiver` from `../waiver`.
export type { Waiver as BudgetWaiver, WaiverStatus as BudgetWaiverStatus } from './types';
export { POLICY_RULES, CRITICAL_GATES, RISKY_ROOT_FILES, type PolicyRule } from './rules';
export { parsePolicyYaml } from './parse';
export { validatePolicyShape } from './validate-shape';
export { validatePolicySemantics } from './validate-semantics';
export { deriveBudget, type DeriveBudgetOptions } from './derive-budget';

/**
 * Parse YAML, validate against the schema, and run semantic checks.
 *
 * Rule namespaces:
 *  - policy.yaml.*    parse layer
 *  - policy.schema.*  schema layer (AJV)
 *  - policy.semantic.* semantic layer (monotonicity, gate-mode warnings, root-passthrough warnings)
 *  - policy.budget.*  budget derivation (separate function)
 */
export function parseAndValidatePolicy(source: string, options: ParseOptions = {}): Result<Policy> {
  const parsed = parsePolicyYaml(source, options);
  const validated = flatMap(parsed, (value) => validatePolicyShape(value, options));
  return flatMap(validated, (policy) => validatePolicySemantics(policy, options));
}
