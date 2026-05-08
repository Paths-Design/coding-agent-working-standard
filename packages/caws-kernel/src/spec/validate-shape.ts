import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import type { ErrorObject, ValidateFunction } from 'ajv';
import { diagnostic } from '../diagnostics';
import type { Diagnostic } from '../diagnostics/types';
import { err, ok } from '../result';
import type { Result } from '../result/types';
import specSchema from '../schemas/spec.v1.json';
import { SPEC_RULES } from './rules';
import type { Spec } from './types';

/**
 * Module-level lazy singleton AJV validator.
 *
 * Contract:
 *  - The AJV instance is constructed once per process lifetime and reused
 *    across every call to validateSpecShape.
 *  - allErrors:true and strict:true are fixed; this validator is not
 *    parameterizable. If a future need arises (e.g. relaxing strict mode
 *    for a migration-only path), introduce a separate validator alongside
 *    rather than mutating this one.
 *  - Tests across files share the same compiled validator. This is
 *    intentional: the schema is immutable per release, and recompiling
 *    per-test would only mask schema-load races. No reset hook is exposed.
 *  - Node worker threads each get a fresh module instance, so cross-thread
 *    aliasing is not a concern.
 */
let validator: ValidateFunction | null = null;

function getValidator(): ValidateFunction {
  if (validator !== null) return validator;
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  validator = ajv.compile(specSchema as object);
  return validator;
}

export interface ShapeValidateOptions {
  sourcePath?: string;
}

/**
 * Validate an unknown value against spec.v1.json (schema layer only).
 *
 * On success, returns Ok with the value cast to Spec — the cast is safe
 * because the schema's strict shape forbids unknown fields.
 * Tier-gated rules (T1 contracts, T1 observability, etc.) are NOT checked
 * here; they live in validate-semantics.ts.
 */
export function validateSpecShape(input: unknown, options: ShapeValidateOptions = {}): Result<Spec> {
  const validate = getValidator();
  const valid = validate(input);
  if (valid) {
    return ok(input as Spec);
  }
  const errors = (validate.errors ?? []).map((e) => ajvErrorToDiagnostic(e, options.sourcePath));
  if (errors.length === 0) {
    // Defensive — should never happen.
    return err(
      diagnostic({
        rule: SPEC_RULES.SCHEMA_VIOLATION,
        authority: 'kernel/spec',
        message: 'Schema validation failed without producing errors.',
        ...(options.sourcePath !== undefined && { subject: options.sourcePath }),
      }),
    );
  }
  return err(errors);
}

function ajvErrorToDiagnostic(e: ErrorObject, sourcePath: string | undefined): Diagnostic {
  const pointer = e.instancePath || '/';
  const subject = sourcePath !== undefined ? `${sourcePath}${pointer}` : pointer;

  // Stable rule ids for well-known violations.
  const rule = pickStableRule(e);

  // Construct a short, present-tense message.
  const message = formatMessage(e);
  const narrowRepair = formatRepair(e);

  return diagnostic({
    rule,
    authority: 'kernel/spec',
    message,
    subject,
    location: { pointer },
    ...(narrowRepair !== undefined && { narrowRepair }),
    data: {
      ajvKeyword: e.keyword,
      ajvParams: e.params,
      ajvSchemaPath: e.schemaPath,
    },
  });
}

function pickStableRule(e: ErrorObject): string {
  const params = (e.params ?? {}) as Record<string, unknown>;
  const additionalProperty = typeof params['additionalProperty'] === 'string' ? params['additionalProperty'] : undefined;

  // additionalProperties: false catches forbidden surfaces by name.
  if (e.keyword === 'additionalProperties' && additionalProperty !== undefined) {
    switch (additionalProperty) {
      case 'change_budget':
        return SPEC_RULES.FORBIDDEN_FIELD_CHANGE_BUDGET;
      case 'acceptance_criteria':
        return SPEC_RULES.FORBIDDEN_FIELD_ACCEPTANCE_CRITERIA;
      case 'include':
        return SPEC_RULES.FORBIDDEN_FIELD_SCOPE_INCLUDE;
      case 'exclude':
        return SPEC_RULES.FORBIDDEN_FIELD_SCOPE_EXCLUDE;
      case 'status':
        return SPEC_RULES.FORBIDDEN_FIELD_STATUS;
      default:
        return SPEC_RULES.SCHEMA_VIOLATION;
    }
  }

  // mode enum violation when value is "development" specifically.
  if (e.keyword === 'enum' && e.instancePath === '/mode') {
    return SPEC_RULES.MODE_DEVELOPMENT_REMOVED;
  }

  // risk_tier non-integer (e.g. "T3", "1" string) lands as a type error.
  if (e.instancePath === '/risk_tier' && e.keyword === 'type') {
    return SPEC_RULES.RISK_TIER_TYPE_REJECTED;
  }
  // risk_tier integer but outside [1, 2, 3] lands as an enum error.
  if (e.instancePath === '/risk_tier' && e.keyword === 'enum') {
    return SPEC_RULES.RISK_TIER_OUT_OF_RANGE;
  }

  // scope.in empty.
  if (e.instancePath === '/scope/in' && e.keyword === 'minItems') {
    return SPEC_RULES.SCOPE_IN_EMPTY;
  }

  // scope.out glob char rejected by the per-item 'not'.
  if (e.instancePath?.startsWith('/scope/out/') && e.keyword === 'not') {
    return SPEC_RULES.SCOPE_OUT_GLOB_FORBIDDEN;
  }

  // id pattern.
  if (e.instancePath === '/id' && e.keyword === 'pattern') {
    return SPEC_RULES.ID_PATTERN_VIOLATION;
  }

  return SPEC_RULES.SCHEMA_VIOLATION;
}

function formatMessage(e: ErrorObject): string {
  const params = (e.params ?? {}) as Record<string, unknown>;
  switch (e.keyword) {
    case 'additionalProperties':
      return `Unknown field "${String(params['additionalProperty'])}" is not permitted.`;
    case 'required':
      return `Missing required field "${String(params['missingProperty'])}".`;
    case 'enum':
      return `Value not in permitted enum: ${JSON.stringify(params['allowedValues'])}.`;
    case 'type':
      return `Expected ${String(params['type'])}.`;
    case 'minItems':
      return `Array must have at least ${String(params['limit'])} item(s).`;
    case 'pattern':
      return `Value does not match required pattern.`;
    case 'not':
      return e.message ?? 'Forbidden value.';
    default:
      return e.message ?? `Schema violation (${e.keyword}).`;
  }
}

function formatRepair(e: ErrorObject): string | undefined {
  const params = (e.params ?? {}) as Record<string, unknown>;
  const additionalProperty = typeof params['additionalProperty'] === 'string' ? params['additionalProperty'] : undefined;

  if (e.keyword === 'additionalProperties' && additionalProperty !== undefined) {
    switch (additionalProperty) {
      case 'change_budget':
        return 'Remove change_budget from the spec. Budgets derive from policy.yaml risk_tiers.';
      case 'acceptance_criteria':
        return 'Rename acceptance_criteria to acceptance. The alias was removed.';
      case 'include':
        return 'Rename scope.include to scope.in.';
      case 'exclude':
        return 'Rename scope.exclude to scope.out.';
      case 'status':
        return 'Use lifecycle_state (draft|active|closed|archived) instead of status.';
      default:
        return `Remove field "${additionalProperty}" — the schema admits no other top-level fields.`;
    }
  }

  if (e.keyword === 'enum' && e.instancePath === '/mode') {
    return 'Use one of: feature, refactor, fix, doc, chore.';
  }

  if (e.instancePath === '/risk_tier' && e.keyword === 'type') {
    return 'Use integer 1, 2, or 3 (not a string like "T3" or "1").';
  }
  if (e.instancePath === '/risk_tier' && e.keyword === 'enum') {
    return 'Use integer 1, 2, or 3 — values outside this range are not permitted.';
  }

  if (e.instancePath === '/scope/in' && e.keyword === 'minItems') {
    return 'Add at least one path to scope.in.';
  }

  if (e.instancePath?.startsWith('/scope/out/') && e.keyword === 'not') {
    return 'Use directory paths only. Glob patterns (* or ?) are not allowed in scope.out.';
  }

  if (e.instancePath === '/id' && e.keyword === 'pattern') {
    return 'Spec id must match ^[A-Z][A-Z0-9]*(-[A-Z0-9]+)*-\\d+[a-z]*$ (e.g. FOO-1, CAWSFIX-31a).';
  }

  if (e.keyword === 'required') {
    const missing = String(params['missingProperty']);
    return `Add field "${missing}" to the spec.`;
  }

  return undefined;
}
