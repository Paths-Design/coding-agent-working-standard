import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import type { ErrorObject, ValidateFunction } from 'ajv';
import { diagnostic } from '../diagnostics';
import type { Diagnostic } from '../diagnostics/types';
import { err, ok } from '../result';
import type { Result } from '../result/types';
import policySchema from '../schemas/policy.v1.json';
import { POLICY_RULES } from './rules';
import type { Policy } from './types';

/**
 * Module-level lazy singleton AJV validator.
 * See ../spec/validate-shape.ts for the contract — same rules apply here.
 */
let validator: ValidateFunction | null = null;

function getValidator(): ValidateFunction {
  if (validator !== null) return validator;
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  validator = ajv.compile(policySchema as object);
  return validator;
}

export interface ShapeValidateOptions {
  sourcePath?: string;
}

/**
 * Validate an unknown value against policy.v1.json.
 *
 * Stable rule ids cover the well-known drifts: label on tier objects,
 * misplaced approvers, unknown gate, unknown gate mode, missing required
 * gates, broad non_governed_zones, slash-containing root_passthrough.
 * Other AJV violations land in policy.schema.violation.
 */
export function validatePolicyShape(input: unknown, options: ShapeValidateOptions = {}): Result<Policy> {
  const validate = getValidator();
  const valid = validate(input);
  if (valid) {
    return ok(input as Policy);
  }
  const errors = (validate.errors ?? []).map((e) => ajvErrorToDiagnostic(e, options.sourcePath));
  if (errors.length === 0) {
    return err(
      diagnostic({
        rule: POLICY_RULES.SCHEMA_VIOLATION,
        authority: 'kernel/policy',
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
  const rule = pickStableRule(e);
  const message = formatMessage(e);
  const narrowRepair = formatRepair(e);

  return diagnostic({
    rule,
    authority: 'kernel/policy',
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
  const additional = typeof params['additionalProperty'] === 'string' ? params['additionalProperty'] : undefined;

  // additionalProperties: false on /risk_tiers/<n> with key 'label'
  if (
    e.keyword === 'additionalProperties' &&
    additional === 'label' &&
    e.instancePath.startsWith('/risk_tiers/')
  ) {
    return POLICY_RULES.FORBIDDEN_TIER_LABEL;
  }

  // additionalProperties: false on /edit_rules with key 'min_approvers_for_budget_raise'
  if (
    e.keyword === 'additionalProperties' &&
    additional === 'min_approvers_for_budget_raise' &&
    e.instancePath === '/edit_rules'
  ) {
    return POLICY_RULES.MISPLACED_APPROVERS_FIELD;
  }

  // additionalProperties: false on /gates with an unrecognized gate name
  if (e.keyword === 'additionalProperties' && additional !== undefined && e.instancePath === '/gates') {
    return POLICY_RULES.UNKNOWN_GATE;
  }

  // gate mode enum violation
  if (e.keyword === 'enum' && e.instancePath.endsWith('/mode') && e.instancePath.startsWith('/gates/')) {
    return POLICY_RULES.UNKNOWN_GATE_MODE;
  }

  // missing required gate
  if (e.keyword === 'required' && e.instancePath === '/gates') {
    return POLICY_RULES.MISSING_REQUIRED_GATE;
  }

  // top-level allOf branch: broad non_governed_zone rejected
  if (e.keyword === 'not' && e.instancePath.startsWith('/non_governed_zones/')) {
    return POLICY_RULES.BROAD_NON_GOVERNED_ZONE;
  }

  // root_passthrough item containing '/'
  if (e.keyword === 'not' && e.instancePath.startsWith('/root_passthrough/')) {
    return POLICY_RULES.ROOT_PASSTHROUGH_HAS_SLASH;
  }

  return POLICY_RULES.SCHEMA_VIOLATION;
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
    case 'const':
      return `Expected exact value ${JSON.stringify(params['allowedValue'])}.`;
    case 'not':
      return e.message ?? 'Forbidden value.';
    default:
      return e.message ?? `Schema violation (${e.keyword}).`;
  }
}

function formatRepair(e: ErrorObject): string | undefined {
  const params = (e.params ?? {}) as Record<string, unknown>;
  const additional = typeof params['additionalProperty'] === 'string' ? params['additionalProperty'] : undefined;

  if (e.keyword === 'additionalProperties') {
    if (additional === 'label' && e.instancePath.startsWith('/risk_tiers/')) {
      return 'Use "description" on the tier object instead of "label".';
    }
    if (additional === 'min_approvers_for_budget_raise' && e.instancePath === '/edit_rules') {
      return 'Move min_approvers_for_budget_raise from edit_rules to waivers.';
    }
    if (additional !== undefined && e.instancePath === '/gates') {
      return `Remove "${additional}" from gates. Allowed gates: budget_limit, spec_completeness, scope_boundary, god_object, todo_detection.`;
    }
    if (additional !== undefined) {
      return `Remove field "${additional}" — the schema admits no other fields here.`;
    }
  }

  if (e.keyword === 'enum' && e.instancePath.endsWith('/mode') && e.instancePath.startsWith('/gates/')) {
    return 'Use one of: block, warn, skip.';
  }

  if (e.keyword === 'required' && e.instancePath === '/gates') {
    const missing = String(params['missingProperty']);
    return `Add the "${missing}" gate. budget_limit, spec_completeness, and scope_boundary are required.`;
  }

  if (e.keyword === 'not' && e.instancePath.startsWith('/non_governed_zones/')) {
    return 'Use a more specific glob, or set non_governed_zones_force: true to opt into authority-relinquishing patterns.';
  }

  if (e.keyword === 'not' && e.instancePath.startsWith('/root_passthrough/')) {
    return 'root_passthrough entries must be plain filenames with no path separators.';
  }

  if (e.keyword === 'required') {
    const missing = String(params['missingProperty']);
    return `Add field "${missing}" to the policy.`;
  }

  return undefined;
}
