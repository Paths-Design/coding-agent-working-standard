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
