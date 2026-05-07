import { flatMap } from '../result/combinators';
import type { Result } from '../result/types';
import { parseSpecYaml, type ParseOptions } from './parse';
import { validateSpecShape } from './validate-shape';
import { validateSpecSemantics } from './validate-semantics';
import type { Spec } from './types';

export * from './types';
export { SPEC_RULES, type SpecRule } from './rules';
export { parseSpecYaml } from './parse';
export { validateSpecShape } from './validate-shape';
export { validateSpecSemantics } from './validate-semantics';

/**
 * Parse YAML, validate against the schema, and run semantic checks.
 *
 * Errors from each layer keep their distinct rule namespaces:
 *  - spec.yaml.*    parse layer
 *  - spec.schema.*  schema layer (AJV-driven)
 *  - spec.semantic.* semantic layer (tier-gated)
 */
export function parseAndValidateSpec(source: string, options: ParseOptions = {}): Result<Spec> {
  const parsed = parseSpecYaml(source, options);
  const validated = flatMap(parsed, (value) => validateSpecShape(value, options));
  return flatMap(validated, (spec) => validateSpecSemantics(spec, options));
}
