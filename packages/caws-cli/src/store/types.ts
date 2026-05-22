// Node-only store types.
//
// The store layer is the bridge between the filesystem and the pure
// kernel. It loads state, delegates validation to the kernel, and returns
// either parsed values or structured Diagnostics.
//
// Discipline:
//   - The store never invents new validation rules. It parses and forwards.
//   - The store distinguishes "missing file" (often a recoverable Ok) from
//     "malformed file" (always Err).
//   - Programmer errors throw; user/repo errors return Result.

import type {
  AgentRegistry,
  ChainedEvent,
  Diagnostic,
  GitWorktreeEntry,
  Policy,
  Spec,
  Waiver,
  WorktreeRegistry,
} from '@paths.design/caws-kernel';

// ----------------------------------------------------------------------------
// SpecsLoadResult — output of specs-store.loadSpecs
// ----------------------------------------------------------------------------

export interface SpecsLoadResult {
  /** Specs that parsed AND validated. Safe to hand to the kernel. */
  readonly specs: readonly Spec[];
  /**
   * Per-file diagnostics from parse/validate. Includes:
   *   - kernel diagnostics for individual spec files that failed
   *   - store diagnostics for unreadable/skipped files
   *   - store diagnostics for duplicate spec ids
   */
  readonly diagnostics: readonly Diagnostic[];
}

// ----------------------------------------------------------------------------
// PolicyLoadResult — output of policy-store.loadPolicy
// ----------------------------------------------------------------------------

export interface PolicyLoadResult {
  /** Undefined when no policy.yaml exists or the file failed to parse. */
  readonly policy?: Policy;
  /** Non-fatal diagnostics from the kernel's policy semantics layer. */
  readonly warnings: readonly Diagnostic[];
  /** Fatal diagnostics — when present, `policy` is undefined. */
  readonly errors: readonly Diagnostic[];
}

// ----------------------------------------------------------------------------
// EventsLoadResult — output of events-store.loadEvents
// ----------------------------------------------------------------------------

export interface EventsLoadResult {
  /** Successfully parsed chained events. */
  readonly events: readonly ChainedEvent[];
  /**
   * Non-fatal diagnostics. Only one kind is currently emitted here:
   * `store.events.trailing_partial_line` when the last line was incomplete
   * (crash-recovery tolerance).
   */
  readonly warnings: readonly Diagnostic[];
}

// ----------------------------------------------------------------------------
// StoreSnapshot — the full state snapshot the shell hands to the kernel.
//
// This is a SUPERSET of DoctorInput: it carries load-time diagnostics that
// the kernel's DoctorInput doesn't represent. composeDoctorSnapshot()
// projects this onto DoctorInput by handing over valid specs/policy/etc.
// and surfacing the load diagnostics to the shell for separate display.
// ----------------------------------------------------------------------------

export interface StoreSnapshot {
  readonly repoRoot: string;
  readonly cawsDir: string;
  /** Specs that parsed AND validated. */
  readonly specs: readonly Spec[];
  /** Per-file diagnostics from loadSpecs. */
  readonly specDiagnostics: readonly Diagnostic[];
  /** Parsed policy if present. */
  readonly policy?: Policy;
  /** Non-fatal diagnostics from the policy kernel. */
  readonly policyWarnings: readonly Diagnostic[];
  /** Fatal diagnostics that prevented policy loading. */
  readonly policyErrors: readonly Diagnostic[];
  readonly worktrees: WorktreeRegistry;
  readonly agents: AgentRegistry;
  readonly events: readonly ChainedEvent[];
  readonly eventWarnings: readonly Diagnostic[];
  /** Waivers that parsed AND validated (slice 7a.5). */
  readonly waivers: readonly Waiver[];
  /** Per-file load diagnostics from loadWaivers (slice 7a.5). */
  readonly waiverDiagnostics: readonly Diagnostic[];

  // -------------------------------------------------------------------
  // Slice 7c.1 — vNext-shape facts the kernel cannot derive itself.
  //
  // The store is the only place that may stat the filesystem. Doctor
  // (kernel) consumes the booleans below; it never reads files. New
  // doctor rules in 7c.2 will fire off these surfaces.
  // -------------------------------------------------------------------

  /**
   * Presence of legacy single-spec / pre-vNext artifacts inside `.caws/`.
   * Doctor surfaces these as errors — vNext init refuses to bootstrap
   * over them, and live projects should retire them.
   */
  readonly initResidue: {
    readonly workingSpecYaml: boolean;
    readonly workingSpecSchemaJson: boolean;
  };

  /**
   * Existence facts for each canonical vNext path. Doctor needs these
   * to surface "canonical layout drift" (e.g. specs/ dir missing on a
   * live project). `eventsJsonlExists` is reported but never required:
   * the first append creates it under lock.
   *
   * `worktreeDirByName` (WORKTREE-DOCTOR-HALF-STATE-001): for each name
   * in `worktrees`, whether the canonical worktree directory
   * (`.caws/worktrees/<name>/`) exists on disk. Used by kernel H1/H4
   * detection.
   */
  readonly filesystem: {
    readonly cawsDirExists: boolean;
    readonly specsDirExists: boolean;
    readonly waiversDirExists: boolean;
    readonly policyYamlExists: boolean;
    readonly worktreesJsonExists: boolean;
    readonly agentsJsonExists: boolean;
    readonly eventsJsonlExists: boolean;
    readonly worktreeDirByName: Readonly<Record<string, boolean>>;
  };

  /**
   * WORKTREE-DOCTOR-HALF-STATE-001: linked git worktrees observed via
   * `git worktree list --porcelain`. Main worktree filtered out before
   * delivery. Undefined when observation failed; in that case
   * `gitObservationFailure` carries the reason.
   */
  readonly gitWorktrees?: readonly GitWorktreeEntry[];
  readonly gitObservationFailure?: string;

  /**
   * Diagnostics from worktrees.json / agents.json load failures that
   * the previous shape silently swallowed (the snapshot fell back to
   * `{}` on Err). Doctor needs to see these to flag "registry file is
   * malformed" without treating registry absence as drift.
   */
  readonly registryDiagnostics: readonly Diagnostic[];
}
