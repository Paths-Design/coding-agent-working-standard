// Stable rule identifiers for spec diagnostics.
// These are part of the public contract — tests and agent-side handling
// reference them by string. Renaming any of these is a breaking change.

export const SPEC_RULES = {
  // Parse layer
  YAML_PARSE_FAILED: 'spec.yaml.parse_failed',
  EMPTY_DOCUMENT: 'spec.yaml.empty_document',
  NOT_AN_OBJECT: 'spec.yaml.not_an_object',

  // Schema layer (delegated to AJV; rule ids surface AJV's keyword + path)
  SCHEMA_VIOLATION: 'spec.schema.violation',
  FORBIDDEN_FIELD_CHANGE_BUDGET: 'spec.schema.forbidden_field.change_budget',
  FORBIDDEN_FIELD_ACCEPTANCE_CRITERIA: 'spec.schema.forbidden_field.acceptance_criteria',
  FORBIDDEN_FIELD_SCOPE_INCLUDE: 'spec.schema.forbidden_field.scope_include',
  FORBIDDEN_FIELD_SCOPE_EXCLUDE: 'spec.schema.forbidden_field.scope_exclude',
  FORBIDDEN_FIELD_STATUS: 'spec.schema.forbidden_field.status',
  MODE_DEVELOPMENT_REMOVED: 'spec.schema.mode.development_removed',
  RISK_TIER_STRING_REJECTED: 'spec.schema.risk_tier.string_rejected',
  SCOPE_IN_EMPTY: 'spec.schema.scope.in_empty',
  SCOPE_OUT_GLOB_FORBIDDEN: 'spec.schema.scope.out_glob_forbidden',
  ID_PATTERN_VIOLATION: 'spec.schema.id.pattern_violation',

  // Semantic layer
  TIER1_MISSING_CONTRACTS: 'spec.semantic.tier1.contracts_required',
  TIER2_MISSING_CONTRACTS: 'spec.semantic.tier2.contracts_required',
  TIER1_MISSING_OBSERVABILITY: 'spec.semantic.tier1.observability_required',
  TIER1_MISSING_ROLLBACK: 'spec.semantic.tier1.rollback_required',
  TIER1_MISSING_SECURITY: 'spec.semantic.tier1.security_required',
  EXPERIMENTAL_MODE_TIER_RESTRICTED: 'spec.semantic.experimental_mode.tier_restricted',
  RESOLUTION_REQUIRES_CLOSURE: 'spec.semantic.resolution.requires_closure',
  CLOSED_SPEC_MISSING_RESOLUTION: 'spec.semantic.closed.resolution_required',
  SUPERSEDES_SELF_REFERENCE: 'spec.semantic.supersedes.self_reference',
} as const;

export type SpecRule = (typeof SPEC_RULES)[keyof typeof SPEC_RULES];
