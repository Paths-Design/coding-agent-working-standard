import { flatMap } from '../result/combinators';
import type { Result } from '../result/types';
import { parsePolicyYaml, type ParseOptions } from './parse';
import { validatePolicyShape } from './validate-shape';
import { validatePolicySemantics } from './validate-semantics';
import type { Policy } from './types';

export * from './types';
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
