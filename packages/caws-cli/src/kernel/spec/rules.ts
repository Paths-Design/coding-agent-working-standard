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
  /** risk_tier is not an integer (e.g. string "T3" or "1"). */
  RISK_TIER_TYPE_REJECTED: 'spec.schema.risk_tier.type_rejected',
  /** risk_tier is an integer but outside the closed enum [1, 2, 3]. */
  RISK_TIER_OUT_OF_RANGE: 'spec.schema.risk_tier.out_of_range',
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
  /**
   * Successor declaration rules — INTRA-SPEC ONLY. These are decidable from
   * the spec's own bytes with no filesystem access, which is what keeps
   * `caws specs validate <file>` portable and deterministic. Whether a
   * target_spec_id actually RESOLVES to an authored spec is a separate,
   * repository-aware question answered by the SuccessorResolver at close
   * preflight — never here.
   */
  SUCCESSOR_DECLINED_MISSING_RATIONALE: 'spec.semantic.successor.declined_rationale_required',
  SUCCESSOR_ABSORBED_MISSING_ABSORBED_BY: 'spec.semantic.successor.absorbed_by_required',
  SUCCESSOR_RATIONALE_FORBIDDEN_EMPTY: 'spec.semantic.successor.rationale_empty',
  SUCCESSOR_DUPLICATE_TARGET: 'spec.semantic.successor.duplicate_target',
  SUCCESSOR_SELF_REFERENCE: 'spec.semantic.successor.self_reference',
  SUCCESSOR_ABSORBED_BY_SELF_REFERENCE: 'spec.semantic.successor.absorbed_by_self_reference',
  SUCCESSOR_ABSORBED_BY_EQUALS_TARGET: 'spec.semantic.successor.absorbed_by_equals_target',
  /**
   * A scope.out entry is a path-prefix of a scope.in entry within the
   * same spec, which would refuse the explicitly-admitted file at
   * scope-decision time. See SPEC-SCOPE-OVERBROAD-OUT-DETECTION-001
   * for the rationale (this rule has now recurred three times in the
   * v11.2 worktree/authority line). One diagnostic per shadowed
   * scope.in entry; the diagnostic data carries scope_out_prefix and
   * scope_in_shadowed as named fields.
   *
   * Path-segment-boundary matching: 'a/b' shadows 'a/b/c' but does
   * NOT shadow 'a/bc'. Exact equality is a distinct defect class
   * (NOT covered by this rule; deferred to a possible future
   * spec.semantic.scope.exact_conflict).
   */
  SCOPE_OVERBROAD_OUT: 'spec.semantic.scope.overbroad_out',

  /**
   * Evidence (CAWS-SPEC-AC-EVIDENCE-AUTHORITY-01). Per-criterion verified
   * status on the spec authority surface. Two INTRA-SPEC semantic rules —
   * decidable from the spec's own bytes with no filesystem access, mirroring
   * the successor declaration rules above. Whether every declared AC is
   * actually SATISFIED for closure is a separate close-gate question
   * (closeSpec), never here.
   */
  /** status=waived but waiver_reason is missing/empty — an undocumented waiver is indistinguishable from an oversight. */
  EVIDENCE_WAIVER_MISSING_REASON: 'spec.semantic.evidence.waiver_reason_required',
  /** evidence[].criterion_id does not match any declared acceptance[].id — a typo that satisfies nothing. */
  EVIDENCE_CRITERION_ID_UNKNOWN: 'spec.semantic.evidence.criterion_id_unknown',
} as const;

export type SpecRule = (typeof SPEC_RULES)[keyof typeof SPEC_RULES];
