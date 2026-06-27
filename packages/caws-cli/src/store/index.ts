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

// ─── v10→v11 spec migration (CAWS-MIGRATE-V10-SPECS-001) ─────────────────
export {
  runSpecsMigrateScan,
  runSpecsMigrateApply,
  MIGRATION_REPORT_SCHEMA_VERSION,
} from './specs-migration';
export type {
  ScanEntry,
  ScanReport,
  ReportEntry,
  ReportVerdict,
  MigrationReport,
  ApplyResult as SpecsMigrateApplyResult,
  ScanOptions as SpecsMigrateScanOptions,
  ApplyOptions as SpecsMigrateApplyOptions,
  NonYamlObservation,
} from './specs-migration';

export { loadPolicy } from './policy-store';
export { loadWorktrees } from './worktrees-store';
export { loadAgents } from './agents-store';
export { appendEvent, loadEvents, rotateEvents } from './events-store';
export type { RotateEventsOptions } from './events-store';

export { applyRegistryPatch } from './apply-patch';

// ─── leases (MULTI-AGENT-ACTIVITY-REGISTRY-001) ──────────────────────────
// Lease I/O surface — separate from applyRegistryPatch. LeasePatch is
// applied ONLY through applyLeasePatch / applyLeasePatches.
export {
  safeLeaseFilename,
  loadLeases,
  applyLeasePatch,
  applyLeasePatches,
  pruneLeasesByStatus,
  pruneDeadLeases,
  defaultIsPidAlive,
} from './leases-store';
export type {
  LoadLeasesResult,
  PruneOptions,
  PruneResult,
  PruneDeadOptions,
  PruneDeadResult,
} from './leases-store';

export { loadWaivers, writeWaiver, markRevoked } from './waivers-store';
export type { WaiversLoadResult } from './waivers-store';

export { initProject, DEFAULT_POLICY_YAML } from './init-store';
export type { InitOutcome, InitProjectResult } from './init-store';

export {
  composeDoctorSnapshot,
  composeStoreSnapshot,
} from './doctor-snapshot';
export type {
  ComposeDoctorOptions,
  ComposeDoctorResult,
  ComposeOptions,
} from './doctor-snapshot';

// ─── messages (AGENT-MESSAGE-CHANNEL-001) ───────────────────────────────
// Inter-agent message channel over .caws/messages.jsonl — separate from the
// events audit chain by design. sendMessage refuses a non-live recipient.
export {
  sendMessage,
  pollMessage,
  inboxCount,
  channelHistory,
  isRecipientLive,
  channelId,
} from './messages-store';
export type { MessageRecord, MessageActor, PollResult, PollOptions } from './messages-store';
