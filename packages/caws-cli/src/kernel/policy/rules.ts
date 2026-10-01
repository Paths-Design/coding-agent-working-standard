// Stable rule identifiers for policy + budget diagnostics.
// Public contract; renaming is a breaking change.

export const POLICY_RULES = {
  // Parse layer
  YAML_PARSE_FAILED: 'policy.yaml.parse_failed',
  EMPTY_DOCUMENT: 'policy.yaml.empty_document',
  NOT_AN_OBJECT: 'policy.yaml.not_an_object',

  // Schema layer (AJV-driven; rule ids surface specific well-known violations)
  SCHEMA_VIOLATION: 'policy.schema.violation',
  FORBIDDEN_TIER_LABEL: 'policy.schema.tier.label_forbidden',
  MISPLACED_APPROVERS_FIELD: 'policy.schema.edit_rules.approvers_misplaced',
  UNKNOWN_GATE: 'policy.schema.gates.unknown',
  UNKNOWN_GATE_MODE: 'policy.schema.gates.unknown_mode',
  MISSING_REQUIRED_GATE: 'policy.schema.gates.missing_required',
  BROAD_NON_GOVERNED_ZONE: 'policy.schema.non_governed_zones.too_broad',
  ROOT_PASSTHROUGH_HAS_SLASH: 'policy.schema.root_passthrough.contains_slash',

  // Semantic layer
  TIER_NON_MONOTONIC_FILES: 'policy.semantic.risk_tiers.non_monotonic_files',
  TIER_NON_MONOTONIC_LOC: 'policy.semantic.risk_tiers.non_monotonic_loc',
  CRITICAL_GATE_NOT_BLOCKING: 'policy.semantic.gates.critical_not_blocking',
  ADVISORY_GATE_BLOCK_NOT_HONORED: 'policy.semantic.gates.advisory_block_not_honored',
  NON_GOVERNED_FORCE_USED: 'policy.semantic.non_governed_zones.force_used',
  ROOT_PASSTHROUGH_RISKY_FILE: 'policy.semantic.root_passthrough.risky_file',

  // Budget derivation
  BUDGET_TIER_NOT_FOUND: 'policy.budget.tier_not_found',
  WAIVER_MALFORMED: 'policy.budget.waiver.malformed',
} as const;

export type PolicyRule = (typeof POLICY_RULES)[keyof typeof POLICY_RULES];

/** Critical gates that should default to block-mode (semantic warning otherwise). */
export const CRITICAL_GATES = ['spec_completeness', 'scope_boundary'] as const;

/**
 * Gates that report but never block, whatever mode policy declares. A
 * risk-tier change budget is a sizing goal: enforcing it pushed agents to
 * trim, defer or stub work to fit a line count, and the boundary CAWS
 * enforces is scope. A declared `block` is honored as `warn` and reported
 * (ADVISORY_GATE_BLOCK_NOT_HONORED) so the config never silently misstates
 * what runs.
 */
export const ADVISORY_GATES = ['budget_limit'] as const;

/**
 * High-blast-radius root-level filenames that warrant a warning when listed
 * in policy.root_passthrough. These are not rejected — the team may have
 * a legitimate reason — but the diagnostic should be loud.
 */
export const RISKY_ROOT_FILES = [
  'package.json',
  'package-lock.json',
  'turbo.json',
  'tsconfig.json',
  '.gitignore',
  'CLAUDE.md',
  'CODEOWNERS',
  'eslint.config.js',
  '.npmrc',
  '.nvmrc',
] as const;
