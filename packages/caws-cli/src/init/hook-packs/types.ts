// HookPackV1 — manifest model for harness-specific hook packs installed by
// `caws init --agent-surface <name>`.
//
// A hook pack is the **runtime adapter** that projects CAWS authority into
// an agent harness's lifecycle (Claude Code, Cursor, Windsurf, etc.).
// The kernel/store/shell trinity owns canonical state. The pack interposes
// at pre-Edit/Write/Bash, where the kernel cannot reach (it runs downstream
// of the agent's tool call).
//
// Every file installed by a pack carries a CAWS-MANAGED-HOOK header:
//
//   # CAWS-MANAGED-HOOK
//   # hook_pack: <id>
//   # hook_pack_version: <pack_version>
//   # caws_min_major: <caws_min_major>
//   # lineage_refs: <comma-separated lineage entry numbers>
//   # do_not_edit_directly: update via `caws init --agent-surface <id>`
//
// The marker is what install/update uses to distinguish managed files
// (safe to rewrite under explicit policy) from local user files (refused
// without --adopt/--overwrite).
//
// Lineage: every pack must declare which failure-lineage entries it covers
// (docs/failure-lineage.md). Removing or weakening
// a pack file requires naming the entry and identifying the replacement
// mechanism.

/** Supported agent harnesses. v11.1 implements claude-code only. */
export type AgentSurface =
  | 'claude-code'
  | 'cursor'
  | 'windsurf'
  | 'none';

/** Lifecycle interception points a pack may register on a harness. */
export type LifecycleEvent =
  | 'pre_bash'
  | 'pre_write'
  | 'pre_edit'
  | 'session_start'
  | 'stop';

/** A single file the pack installs, relative to the repo root. */
export interface HookPackFile {
  /** Destination path relative to repo root (e.g., `.claude/hooks/scope-guard.sh`). */
  readonly destPath: string;
  /** Source path within the templates tree, relative to the pack root
   *  (e.g., `scope-guard.sh`). */
  readonly sourcePath: string;
  /** When true, the installed file must be executable (chmod +x). */
  readonly executable: boolean;
  /** When true, this file gets a managed header prepended/verified.
   *  Set false for non-script auxiliary files where a comment marker
   *  is not appropriate (e.g., a state directory placeholder). */
  readonly managed: boolean;
}

/** State surfaces the pack reads from / writes to. Informational; used
 *  by docs and by future drift detection. */
export interface HookPackStateModel {
  /** Files/dirs the pack reads (relative to repo root). */
  readonly reads: readonly string[];
  /** Files/dirs the pack writes (relative to repo root). */
  readonly writes: readonly string[];
}

/** The pack manifest. */
export interface HookPackV1 {
  /** Pack identifier, stable across versions (e.g., "claude-code"). */
  readonly id: string;
  /** The harness this pack targets. */
  readonly targetSurface: Exclude<AgentSurface, 'none'>;
  /** Pack version. Bumps when managed file contents change in a way
   *  that requires an update on re-install. */
  readonly packVersion: number;
  /** Minimum CAWS major version this pack is compatible with. */
  readonly cawsMinMajor: number;
  /** Lifecycle events this pack registers on the harness. */
  readonly lifecycleEvents: readonly LifecycleEvent[];
  /** Files installed by this pack, in deterministic order. */
  readonly installedFiles: readonly HookPackFile[];
  /** State surfaces (read/write paths). */
  readonly stateModel: HookPackStateModel;
  /** Failure-lineage entry numbers this pack covers. */
  readonly lineageRefs: readonly number[];
  /** Human-readable summary for init output. One short sentence. */
  readonly summary: string;
  /** Activation contract: whether installed hooks take effect in the
   *  current harness session, or require a restart. */
  readonly activation: 'immediate' | 'restart_required' | 'unknown';
}

/** Managed-file header fields. Used by install for parse/emit. */
export interface ManagedHeader {
  readonly hookPack: string;
  readonly hookPackVersion: number;
  readonly cawsMinMajor: number;
  readonly lineageRefs: readonly number[];
}

/** Outcome of evaluating an installed-file path against the local filesystem
 *  during install. */
export type InstallFileState =
  /** No file at destPath; safe to create. */
  | { readonly kind: 'absent' }
  /** Managed file at destPath matching this pack/version and unchanged
   *  from bundled content. Safe to no-op. */
  | { readonly kind: 'managed_clean'; readonly header: ManagedHeader }
  /** Managed file at destPath matching this pack but at an older version.
   *  Safe to update under update policy. */
  | {
      readonly kind: 'managed_old_version';
      readonly header: ManagedHeader;
      readonly currentVersion: number;
    }
  /** Managed file at destPath matching this pack/version but content
   *  differs from bundled. Refuses without --adopt or --overwrite. */
  | { readonly kind: 'managed_drift'; readonly header: ManagedHeader }
  /** File at destPath without a managed header. Refuses without
   *  --adopt or --overwrite. */
  | { readonly kind: 'unmanaged_collision' };

/** Aggregate outcome of an install operation. */
export type HookPackInstallOutcome =
  /** Pack was installed for the first time (or new files added to an
   *  existing pack install). */
  | 'installed'
  /** Pack files all present at correct version and content; no changes. */
  | 'already_installed'
  /** Pack files updated from an older version. */
  | 'updated'
  /** Caller explicitly chose `--agent-surface none`. No pack installed. */
  | 'skipped_explicit_none'
  /** No harness detected, non-interactive mode. No pack installed, warning
   *  emitted. */
  | 'skipped_ambiguous';

/** Per-file install action recorded for reporting. */
export interface HookPackFileAction {
  readonly destPath: string;
  readonly action: 'created' | 'updated' | 'unchanged' | 'refused';
  /** When action === 'refused', the reason. */
  readonly refusalReason?:
    | 'unmanaged_collision'
    | 'managed_drift';
}

/** Result of installing a pack into a repo. */
export interface HookPackInstallResult {
  readonly outcome: HookPackInstallOutcome;
  /** The pack that was (or would have been) installed. Null when
   *  outcome is 'skipped_explicit_none' or 'skipped_ambiguous'. */
  readonly pack: HookPackV1 | null;
  /** Per-file actions. */
  readonly actions: readonly HookPackFileAction[];
  /** Whether the harness requires a session restart for hooks to take
   *  effect. Drives the activation banner. */
  readonly activation: 'immediate' | 'restart_required' | 'unknown' | 'not_applicable';
}
