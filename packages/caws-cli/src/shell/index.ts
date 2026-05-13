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
