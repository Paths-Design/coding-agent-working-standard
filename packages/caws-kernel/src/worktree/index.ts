// Public surface of the worktree + claim authority kernel.
//
// All exports are pure. None read files, environment variables, or call
// Date.now(). All time is injected.

export type {
  AgentRecord,
  AgentRegistry,
  BindingState,
  PriorOwner,
  RegistryPatch,
  SessionIdentity,
  SpecTransition,
  TransitionDecision,
  WorktreeRecord,
  WorktreeRegistry,
} from './types';

export { isAgentRecord } from './types';

export { WORKTREE_RULES, WORKTREE_RULE_PREFIXES } from './rules';
export type { WorktreeRule } from './rules';

export {
  WORKTREE_NAME_REGEX,
  sameSession,
  validateSessionIdentity,
  validateWorktreeName,
} from './identity';

export { bindWorktree, deriveBindingState } from './binding';
export type { BindWorktreeOptions } from './binding';

export { assertOwnership, takeoverClaim } from './ownership';
export type { AssertOwnershipOptions } from './ownership';

export { heartbeatAge, isStaleByTTL, refreshAgentClaim } from './freshness';
export type { RefreshAgentClaimOptions } from './freshness';

export { canTransitionSpecWithWorktree } from './transitions';
