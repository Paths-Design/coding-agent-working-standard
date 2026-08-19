export * from './types';
export { SCOPE_RULES, SCOPE_RULE_PREFIXES } from './rules';
export type { ScopeRule } from './rules';
export { evaluatePath, evaluatePathResult } from './evaluate';
// The scope.in / non_governed_zones matcher, exported so callers that RANK or
// EXPLAIN scope fit decide it with the same function evaluatePath decides with.
// A second implementation of these semantics is a trap: the ranking surface and
// the admission surface must never disagree about which spec claims a path.
export { matchGlob } from './match';
export { evaluateContention } from './contention';
export type {
  ContentionResult,
  ContentionClaimant,
  ContentionUndeterminedReason,
  EvaluateContentionInput,
} from './contention';
