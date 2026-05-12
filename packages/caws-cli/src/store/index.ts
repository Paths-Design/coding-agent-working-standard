// Node-only store layer — programmatic exports.
//
// This module is the bridge between the filesystem and the pure kernel.
// It is consumed programmatically; no public CLI commands are registered
// here. CLI command surface lands in Slice 5c.

export { STORE_RULES, STORE_RULE_PREFIXES } from './rules';
export type { StoreRule } from './rules';

export type {
  EventsLoadResult,
  PolicyLoadResult,
  SpecsLoadResult,
  StoreSnapshot,
} from './types';

export {
  defaultGitRunner,
  resolveRepoRoot,
  storeDiagnostic,
} from './repo-root';
export type { GitRunner, RepoRoot, ResolveRepoRootOptions } from './repo-root';

export { fsyncDir, writeFileAtomic } from './atomic-write';
export { readJsonFile } from './json-store';
export { readYamlFile, readYamlSource } from './yaml-store';

export { loadSpecs } from './specs-store';
export { loadPolicy } from './policy-store';
export { loadWorktrees } from './worktrees-store';
export { loadAgents } from './agents-store';
export { appendEvent, loadEvents } from './events-store';

export {
  composeDoctorSnapshot,
  composeStoreSnapshot,
} from './doctor-snapshot';
export type {
  ComposeDoctorOptions,
  ComposeDoctorResult,
  ComposeOptions,
} from './doctor-snapshot';
