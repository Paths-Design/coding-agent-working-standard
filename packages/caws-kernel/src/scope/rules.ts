// Stable rule identifiers for scope diagnostics.
// Public contract — tests and agent-side handling reference them by string.
// Renaming any of these is a breaking change.
//
// Namespaces:
//   scope.admit.*         the path was admitted; rule names the source of authority
//   scope.reject.*        the path was rejected by a spec/policy rule
//   scope.no_authority.*  no bound spec exists to decide against
//   scope.invalid_path.*  the caller handed an inadmissible subject

export const SCOPE_RULES = {
  // Admit
  ADMIT_INFRA_EXEMPT: 'scope.admit.infra_exempt',
  ADMIT_NON_GOVERNED_ZONE: 'scope.admit.non_governed_zone',
  ADMIT_ROOT_PASSTHROUGH: 'scope.admit.root_passthrough',
  ADMIT_SCOPE_IN: 'scope.admit.scope_in',
  // Admitted via scope.support: editable like scope.in, but NOT a worktree
  // claim (WORKTREE-SUPPORT-SCOPE-001). Distinct rule so diagnostics can tell
  // "admitted because owned (scope.in)" from "admitted as support".
  ADMIT_SCOPE_SUPPORT: 'scope.admit.scope_support',

  // Reject
  REJECT_SCOPE_OUT: 'scope.reject.scope_out',
  REJECT_SCOPE_IN_MISS: 'scope.reject.scope_in_miss',
  REJECT_ROOT_NOT_ALLOWED: 'scope.reject.root_not_allowed',

  // No authority
  NO_AUTHORITY_UNBOUND: 'scope.no_authority.unbound',
  NO_AUTHORITY_BINDING_ONE_SIDED: 'scope.no_authority.binding_one_sided',

  // Invalid path
  INVALID_PATH_EMPTY: 'scope.invalid_path.empty',
  INVALID_PATH_ABSOLUTE: 'scope.invalid_path.absolute',
  INVALID_PATH_PARENT_TRAVERSAL: 'scope.invalid_path.parent_traversal',
  INVALID_PATH_BACKSLASH: 'scope.invalid_path.backslash',
  INVALID_PATH_NUL: 'scope.invalid_path.nul',
  INVALID_PATH_NOT_STRING: 'scope.invalid_path.not_string',
} as const;

export type ScopeRule = (typeof SCOPE_RULES)[keyof typeof SCOPE_RULES];

/** All known scope-rule namespace prefixes. */
export const SCOPE_RULE_PREFIXES = [
  'scope.admit.',
  'scope.reject.',
  'scope.no_authority.',
  'scope.invalid_path.',
] as const;
