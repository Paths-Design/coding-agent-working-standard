// Doctor kernel — types.
//
// The doctor is a pure diagnoser. It consumes already-loaded state and
// returns a structured report. It does NOT:
//   - read files or walk directories
//   - inspect git
//   - parse cwd
//   - append events
//   - render terminal output
//   - call Date.now() — `now` is injected by the caller
//
// The shell composes inputs (parsing YAML, listing worktrees, loading events)
// and hands them to `inspectProjectState`. Doctor returns a `DoctorReport`,
// which the shell formats for terminal/JSON/etc.

import type { Diagnostic, Severity } from '../diagnostics/types';
import type { ChainedEvent } from '../evidence/types';
import type { Policy } from '../policy/types';
import type { Spec } from '../spec/types';
import type { Waiver } from '../waiver/types';
import type { AgentRegistry, WorktreeRegistry } from '../worktree/types';

// ----------------------------------------------------------------------------
// FindingSeverity — alias of the diagnostics Severity for clarity.
// ----------------------------------------------------------------------------

export type FindingSeverity = Severity;

// ----------------------------------------------------------------------------
// DoctorFinding — one item in the report. Same envelope as Diagnostic so
// callers can pass findings through existing diagnostic pipelines.
// ----------------------------------------------------------------------------

export interface DoctorFinding {
  readonly rule: string;
  /** Always `'kernel/diagnostics'` — doctor is the diagnostics surface. */
  readonly authority: 'kernel/diagnostics';
  readonly severity: FindingSeverity;
  readonly message: string;
  readonly subject?: string;
  readonly narrowRepair?: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

// ----------------------------------------------------------------------------
// TemplateCheck — narrow shape for shell-supplied template validation.
//
// The shell validates template files outside the kernel (e.g. running
// `validateSpec` on every example under `templates/` and `docs/`) and hands
// each result to doctor as a TemplateCheck. Doctor maps the errors and
// warnings into findings preserving the incoming severity. The shell cannot
// smuggle arbitrary blobs in.
// ----------------------------------------------------------------------------

export interface TemplateCheck {
  /** Stable identifier for the template (e.g. `spec/feature.yaml`). */
  readonly template_id: string;
  /**
   * Filesystem-style path to the template, if the shell knows one. When
   * absent, doctor uses `template_id` as the finding subject — so the
   * subject of every template-derived finding is always populated.
   */
  readonly path?: string;
  readonly errors: readonly Diagnostic[];
  readonly warnings?: readonly Diagnostic[];
}

// ----------------------------------------------------------------------------
// DoctorInput — explicit, caller-provided state snapshot.
// ----------------------------------------------------------------------------

export interface DoctorInput {
  /** All specs the shell has loaded and parsed (including closed/archived). */
  readonly specs: readonly Spec[];

  /** Parsed policy if present, undefined if missing/unloadable. */
  readonly policy?: Policy;

  /** Non-fatal diagnostics the policy kernel emitted on load. */
  readonly policyWarnings?: readonly Diagnostic[];

  /** Worktree registry contents. */
  readonly worktrees?: WorktreeRegistry;

  /** Agents registry contents (display/freshness only). */
  readonly agents?: AgentRegistry;

  /** Events the shell has loaded from `.caws/events.jsonl`. */
  readonly events?: readonly ChainedEvent[];

  /** Template validation results from the shell. */
  readonly templates?: readonly TemplateCheck[];

  /**
   * Waivers the shell has loaded and validated. Doctor consumes them to
   * surface stale-active expiry, references to unknown policy gates, and
   * (when events are available) `gate_evaluated` waiver_ids that point
   * at currently-revoked waivers. The store owns I/O — doctor never
   * calls `loadWaivers`.
   */
  readonly waivers?: readonly Waiver[];

  /**
   * Per-file load diagnostics produced by the shell when reading
   * `.caws/waivers/`. Doctor passes these through as
   * `doctor.waiver.malformed_loaded` findings, preserving the
   * incoming severity. A malformed sibling MUST NOT cause valid
   * waivers to disappear from `waivers` above.
   */
  readonly waiverDiagnostics?: readonly Diagnostic[];

  /** Injected current time. */
  readonly now: Date;

  /** TTL beyond which an agent record is "stale" for display. Default 24h. */
  readonly staleAgentTtlMs?: number;

  /**
   * Threshold past which an active+unbound spec is considered "stale"
   * (not just transient). Default 1h.
   */
  readonly unboundActiveThresholdMs?: number;

  /**
   * Length threshold above which a worktree's prior_owners list is flagged
   * as hygiene warning. Default 25. Kernel never truncates.
   */
  readonly priorOwnersGrowthThreshold?: number;

  // ---------------------------------------------------------------------
  // Slice 7c.1 — vNext-shape facts the shell observes for us.
  //
  // Doctor never reads files. The store stats the canonical paths and
  // hands the booleans across; doctor classifies them as findings in
  // 7c.2. All three are optional so callers that don't construct
  // these (older tests, ad-hoc kernel consumers) stay valid.
  // ---------------------------------------------------------------------

  /**
   * Presence of legacy single-spec / pre-vNext artifacts inside `.caws/`.
   * 7c.2 will surface these as `doctor.init.legacy_*_present` errors.
   */
  readonly initResidue?: {
    readonly workingSpecYaml: boolean;
    readonly workingSpecSchemaJson: boolean;
  };

  /**
   * Existence facts for the canonical vNext layout. 7c.2 will surface
   * absences as `doctor.init.*_missing`. `eventsJsonlExists` is reported
   * but intentionally NEVER required — the first append creates it under
   * lock, and a missing file is valid until then.
   *
   * `worktreeDirByName` (WORKTREE-DOCTOR-HALF-STATE-001): for each name
   * in `worktrees`, whether the canonical worktree directory
   * (`.caws/worktrees/<name>/`) exists on disk. Used by H1/H4 detection.
   * Optional so older test callers without this awareness stay valid;
   * when undefined, H1 silently skips its filesystem check.
   */
  readonly filesystem?: {
    readonly cawsDirExists: boolean;
    readonly specsDirExists: boolean;
    readonly waiversDirExists: boolean;
    readonly policyYamlExists: boolean;
    readonly worktreesJsonExists: boolean;
    readonly agentsJsonExists: boolean;
    readonly eventsJsonlExists: boolean;
    readonly worktreeDirByName?: Readonly<Record<string, boolean>>;
  };

  /**
   * Diagnostics from registry-load failures (worktrees.json /
   * agents.json that parsed as something other than a plain object).
   * 7c.2 will surface these as registry-malformed warnings without
   * conflating them with "registry file missing" (which is valid until
   * first write).
   */
  readonly registryDiagnostics?: readonly Diagnostic[];

  // ---------------------------------------------------------------------
  // WORKTREE-DOCTOR-HALF-STATE-001 — git worktree observation
  //
  // The store layer runs `git worktree list --porcelain` against the
  // repo root, parses the porcelain output locally (NOT importing from
  // the shell parser to preserve store/shell separation), filters out
  // the main worktree, and hands the result here. The kernel reads
  // this list as plain data — it never calls git.
  //
  // Observation is non-fatal: when git fails (no git installed, repo
  // corruption, permission error), `gitWorktrees` is undefined and
  // `gitObservationFailure` carries the reason. The kernel emits
  // `doctor.worktree.git_observation_unavailable` and silently skips
  // H1/H6 rules that require this input. The rest of the report still
  // runs.
  // ---------------------------------------------------------------------

  /**
   * Linked git worktrees observed via `git worktree list --porcelain`.
   * The main worktree (path === repoRoot) is filtered out by the store
   * layer before delivery; this list contains only linked worktrees.
   * Undefined when git observation failed.
   */
  readonly gitWorktrees?: readonly GitWorktreeEntry[];

  /**
   * Reason string when `git worktree list --porcelain` failed. Surfaced
   * as `doctor.worktree.git_observation_unavailable`. Undefined when
   * observation succeeded.
   */
  readonly gitObservationFailure?: string;
}

// ----------------------------------------------------------------------------
// GitWorktreeEntry — kernel-local shape for one entry from
// `git worktree list --porcelain`.
//
// Intentionally minimal — only the fields the doctor rules consume. A
// duplicate type with the same name exists in the shell binding layer
// (packages/caws-cli/src/shell/binding/resolve-binding.ts); deduplication
// to a shared location is deferred follow-up debt (see closure notes for
// WORKTREE-DOCTOR-HALF-STATE-001). Store-layer code (doctor-snapshot.ts)
// MUST NOT import from the shell; it constructs entries matching this
// shape from its own local porcelain parser.
// ----------------------------------------------------------------------------

export interface GitWorktreeEntry {
  /** Absolute path to the worktree directory. */
  readonly path: string;
  /** Branch ref (e.g. `refs/heads/feature-x`), if the worktree has one. */
  readonly branch?: string;
}

// ----------------------------------------------------------------------------
// DoctorReport — structured output.
// ----------------------------------------------------------------------------

export interface DoctorReport {
  readonly findings: readonly DoctorFinding[];
  readonly summary: {
    readonly errors: number;
    readonly warnings: number;
    readonly infos: number;
  };
  /** True iff zero error-severity findings. Warnings/infos do not unset clean. */
  readonly clean: boolean;
}
