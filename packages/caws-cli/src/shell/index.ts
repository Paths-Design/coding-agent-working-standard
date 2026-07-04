// Programmatic exports for the shell layer.
//
// Slice 5c lands four CLI commands (doctor, scope show, scope check,
// evidence record) registered via `registerShellCommands(program)`.
// Internals below the command surface are exported for tests and for
// adjacent shell modules that need them (hooks, status renderer).

export { SHELL_RULES, SHELL_RULE_PREFIXES } from './rules';
export type { ShellRule } from './rules';

export {
  resolveSession,
  describeSessionSource,
  resolveSessionCandidates,
  admitsOwner,
  describeCandidateTrace,
} from './session/resolve-session';
export type {
  CandidateTraceEntry,
  ResolveCandidatesOptions,
  ResolveSessionOptions,
  ResolvedSession,
  SessionCandidate,
  SessionCandidates,
  SessionCapsule,
  SessionSource,
} from './session/types';

export { buildActor } from './session/actor';
export type { BuildActorOptions } from './session/actor';

export {
  resolveBinding,
  parseWorktreePorcelain,
} from './binding/resolve-binding';
export type {
  GitWorktreeEntry,
  ResolveBindingInput,
  ResolvedBinding,
} from './binding/types';

export {
  renderDiagnostic,
  renderDiagnostics,
  countSeverities,
} from './render/diagnostic';
export type { RenderDiagnosticsOptions } from './render/diagnostic';
export {
  renderFinding,
  renderFindings,
  countFindingSeverities,
} from './render/finding';
export type { RenderFindingsOptions } from './render/finding';
export { renderDecision } from './render/decision';
export type { RenderDecisionOptions } from './render/decision';

export { runDoctorCommand } from './commands/doctor';
export type { DoctorCommandOptions } from './commands/doctor';

export { runScopeCommand, runScopeContentionCommand } from './commands/scope';
export type {
  ScopeCommandOptions,
  ScopeMode,
  ScopeContentionOptions,
} from './commands/scope';

export { runEvidenceRecordCommand } from './commands/evidence';
export type {
  EvidenceKind,
  EvidenceRecordOptions,
} from './commands/evidence';

export {
  runEventsMigrateCommand,
  runEventsRotateCommand,
  runEventsVerifyArchiveCommand,
} from './commands/events';
export type {
  EventsMigrateCommandOptions,
  EventsRotateCommandOptions,
  EventsVerifyArchiveCommandOptions,
} from './commands/events';

export { runClaimCommand } from './commands/claim';
export type { ClaimCommandOptions } from './commands/claim';

export { renderClaimPanel, classifyOwnership } from './render/claim';
export type { ClaimPanelInput, OwnershipRelation } from './render/claim';

export { runStatusCommand } from './commands/status';
export type { StatusCommandOptions } from './commands/status';

export { renderStatus } from './render/status';
export type { StatusRenderInput } from './render/status';

export { runGatesRunCommand } from './commands/gates';
export type {
  GatesRunCommandOptions,
  GatesRunCommandRequest,
} from './commands/gates';

export { runPrepushCommand } from './commands/prepush';
export type { PrepushCommandOptions } from './commands/prepush';

export { renderGatesRun } from './render/gates';
export {
  validateGatesReport,
} from './gates/gate-result-contract';
export type {
  GatesReport,
  GatesViolation,
  GatesWarning,
} from './gates/gate-result-contract';
export { deriveDispositions } from './gates/disposition';
export type {
  DispositionResult,
  GateDisposition,
  GateOutcome,
} from './gates/disposition';

export { filterWaivedViolations } from './gates/waiver-filter';
export type {
  WaiverFilterInput,
  WaiverFilterResult,
  WaiverEvidence,
} from './gates/waiver-filter';

export {
  runWaiverCreateCommand,
  runWaiverListCommand,
  runWaiverShowCommand,
  runWaiverRevokeCommand,
} from './commands/waiver';
export type {
  WaiverCreateOptions,
  WaiverListOptions,
  WaiverShowOptions,
  WaiverRevokeOptions,
} from './commands/waiver';

export {
  renderWaiverSummary,
  renderWaiverDetail,
} from './render/waiver';
export type {
  RenderWaiverSummaryInput,
  RenderWaiverDetailInput,
} from './render/waiver';

export { runInitCommand } from './commands/init';
export type { InitCommandOptions } from './commands/init';

export {
  runSpecsCreateCommand,
  runSpecsListCommand,
  runSpecsShowCommand,
  runSpecsActivateCommand,
  runSpecsAmendScopeCommand,
  runSpecsCloseCommand,
  runSpecsArchiveCommand,
  runSpecsPruneArchiveCommand,
  runSpecsRecoverCommand,
  runSpecsRetireDraftCommand,
  runSpecsMigrateCommand,
  runSpecsValidateCommand,
} from './commands/specs';
export type {
  SpecsCreateOptions,
  SpecsListOptions,
  SpecsShowOptions,
  SpecsActivateOptions,
  SpecsCloseOptions,
  SpecsArchiveOptions,
  SpecsPruneArchiveOptions,
  SpecsRecoverOptions,
  SpecsRetireDraftOptions,
  SpecsMigrateOptions,
  SpecsValidateOptions,
} from './commands/specs';

export {
  runWorktreeCreateCommand,
  runWorktreeListCommand,
  runWorktreeBindCommand,
  runWorktreeDestroyCommand,
  runWorktreeUntrackCommand,
  runWorktreeMergeCommand,
  runWorktreeMigrateRegistryCommand,
  runWorktreePruneCommand,
  runWorktreeRepairSparseCommand,
  runWorktreeRepairCommand,
  buildWorktreePrunePlan,
  worktreePruneItemFromFinding,
} from './commands/worktree';
export type {
  WorktreeCreateOptions,
  WorktreeListOptions,
  WorktreeBindOptions,
  WorktreeDestroyOptions,
  WorktreeUntrackOptions,
  WorktreeMergeOptions,
  WorktreeMigrateRegistryOptions,
  WorktreePruneOptions,
  WorktreePrunePlanItem,
  WorktreePruneStateClass,
  WorktreeRepairSparseOptions,
  WorktreeRepairOptions,
} from './commands/worktree';

export { renderInit } from './render/init';
export type { RenderInitInput } from './render/init';

// ─── caws agents (MULTI-AGENT-ACTIVITY-REGISTRY-001) ─────────────────────
export {
  runAgentsRegisterCommand,
  runAgentsHeartbeatCommand,
  runAgentsStopCommand,
  runAgentsListCommand,
  runAgentsShowCommand,
  runAgentsPruneCommand,
} from './commands/agents';
export type {
  RegisterOpts as AgentsRegisterOptions,
  HeartbeatOpts as AgentsHeartbeatOptions,
  StopOpts as AgentsStopOptions,
  ListOpts as AgentsListOptions,
  ShowOpts as AgentsShowOptions,
  PruneOpts as AgentsPruneOptions,
} from './commands/agents';

// ─── caws message (AGENT-MESSAGE-CHANNEL-001) ────────────────────────────
export { runMessageSendCommand, runMessagePollCommand } from './commands/message';
export type {
  MessageSendCommandOptions,
  MessagePollCommandOptions,
} from './commands/message';

export { registerShellCommands } from './register';
export type { RegisterShellCommandsOptions } from './register';

// CAWS-CLI-HELP-METADATA-AUTHORITY-001: the typed single-source command
// metadata that register.ts consumes (populated group-by-group in slices 2-3)
// and that the help-metadata lock test asserts against the kernel enums +
// REGISTERED_COMMAND_GROUPS.
export { COMMAND_SURFACE_METADATA } from './command-metadata';
export type {
  CommandMeta,
  LeafCommandMeta,
  GroupCommandMeta,
  CommandOptionMeta,
  CommandArgMeta,
} from './command-metadata';
