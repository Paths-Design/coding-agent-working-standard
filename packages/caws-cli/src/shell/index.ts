// Programmatic exports for the shell layer.
//
// Slice 5c lands four CLI commands (doctor, scope show, scope check,
// evidence record) registered via `registerShellCommands(program)`.
// Internals below the command surface are exported for tests and for
// adjacent shell modules that need them (hooks, status renderer).

export { SHELL_RULES, SHELL_RULE_PREFIXES } from './rules';
export type { ShellRule } from './rules';

export { resolveSession, describeSessionSource } from './session/resolve-session';
export type {
  ResolveSessionOptions,
  ResolvedSession,
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

export { runScopeCommand } from './commands/scope';
export type { ScopeCommandOptions, ScopeMode } from './commands/scope';

export { runEvidenceRecordCommand } from './commands/evidence';
export type {
  EvidenceKind,
  EvidenceRecordOptions,
} from './commands/evidence';

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

export { renderGatesRun } from './render/gates';
export {
  validateGatesReport,
} from './gates/gate-result-contract';
export type {
  GatesReport,
  GatesViolation,
  GatesWarning,
} from './gates/gate-result-contract';
export { runQualityGates } from './gates/quality-gates-adapter';
export type {
  QualityGatesRunner,
  QualityGatesRunnerInput,
  RunQualityGatesOptions,
  SubprocessResult,
} from './gates/quality-gates-adapter';
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

export { registerShellCommands } from './register';
export type { RegisterShellCommandsOptions } from './register';
