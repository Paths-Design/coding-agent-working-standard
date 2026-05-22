// WORKTREE-REGISTRY-LEGACY-ENVELOPE-MIGRATION-001
//
// Pure-ish helper for converting v10.2 envelope-shaped
// .caws/worktrees.json into the v11 flat-map shape.
//
// Discipline:
//   - The classifier (detectWorktreesRegistryShape) and planner
//     (planMigration) are pure: they take fileContents + specs +
//     a path-existence callback and return a plan. No fs reads,
//     no process.env, no Date.now usage.
//   - The shell command wraps the pure logic with real fs.existsSync
//     and writeFileAtomic. The shell layer is responsible for IO.
//   - writeFileAtomic semantics (verified at audit gate, commit
//     a83927c): fsync + rename-on-same-filesystem atomicity. The
//     migration relies on file-content atomicity (readers see
//     either the old bytes or the new bytes; never partial), NOT
//     on crash-safety past power loss or parent-directory
//     durability.
//   - loadSpecs semantics (verified at audit gate): read-only
//     filesystem, returns specs + diagnostics. The migration
//     consumes only `result.specs[]` for the destroyed-record
//     policy check. A12 acceptance: when specs.length === 0 AND
//     diagnostics contains READ_IO_FAILED, the migration refuses
//     because the destroyed-record claim check cannot be verified.
//     Benign loadSpecs diagnostics (non-yaml-skipped, duplicate-id)
//     do NOT cause refusal.
//
// What this module does NOT do:
//   - Read or write the filesystem (the shell command does that).
//   - Append events (Decision 2: no new event in this slice).
//   - Modify doctor's H1 rule (Decision 3: detection is explicit
//     in this migration path; doctor stays unchanged).
//   - Repair half-states (lives in PRUNE-REPAIR-WORKTREE-001 after
//     authority closes).

import { err, isOk, ok, type Diagnostic, type Result } from '@paths.design/caws-kernel';

// ---- Stable rule ids ------------------------------------------------------
//
// Co-located with the migration logic, following the pattern in
// doctor-snapshot.ts where diagnostic rule ids are defined inline rather
// than registered in STORE_RULES. This keeps the contract local to the
// migration surface and avoids touching the cross-cutting rules.ts file.

export const MIGRATION_RULES = {
  /** A10/A1: shape detection — file is in v10.2 envelope shape. */
  LEGACY_ENVELOPE_DETECTED: 'store.worktrees_migration.legacy_envelope_detected',
  /** A5: shape detection — ambiguous mix of envelope and flat-map structure. */
  MIXED_SHAPE_REFUSED: 'store.worktrees_migration.mixed_shape_refused',
  /** A4: at least one destroyed record blocks omission (spec claims it OR path present). */
  DESTROYED_RECORD_BLOCKS_OMISSION:
    'store.worktrees_migration.destroyed_record_blocks_omission',
  /** A12: spec load failed in a way that makes the claim check unverifiable. */
  SPEC_LOAD_FAILED_POLICY_UNVERIFIABLE:
    'store.worktrees_migration.spec_load_failed_policy_unverifiable',
  /** A6: file already in v11 flat-map shape; no-op. */
  ALREADY_MIGRATED: 'store.worktrees_migration.already_migrated',
  /** IO/parse error reading the file before classification. */
  READ_FAILED: 'store.worktrees_migration.read_failed',
} as const;

export type MigrationRule = (typeof MIGRATION_RULES)[keyof typeof MIGRATION_RULES];

// ---- Shape detection ------------------------------------------------------

export type RegistryShape =
  | { readonly kind: 'flat'; readonly recordCount: number }
  | {
      readonly kind: 'legacy_envelope';
      readonly version: number;
      readonly nestedRecordCount: number;
    }
  | { readonly kind: 'mixed'; readonly reason: string }
  | { readonly kind: 'empty'; readonly reason: 'empty_object' };

function migrationDiagnostic(
  rule: MigrationRule,
  message: string,
  opts: {
    readonly severity?: Diagnostic['severity'];
    readonly subject?: string;
    readonly data?: Diagnostic['data'];
    readonly narrowRepair?: string;
  } = {}
): Diagnostic {
  return {
    rule,
    authority: 'kernel/diagnostics',
    severity: opts.severity ?? 'error',
    message,
    ...(opts.subject !== undefined ? { subject: opts.subject } : {}),
    ...(opts.data !== undefined ? { data: opts.data } : {}),
    ...(opts.narrowRepair !== undefined ? { narrowRepair: opts.narrowRepair } : {}),
  };
}

/**
 * Classify the raw .caws/worktrees.json bytes. Pure: no fs access.
 *
 * Recognized shapes:
 *   - `flat`: a JSON object with zero or more keys that are NOT
 *     `version` (number) AND NOT `worktrees` (object) — i.e., the
 *     v11 shape where each top-level key is a worktree name.
 *   - `legacy_envelope`: a JSON object whose keys are EXACTLY
 *     {version: number, worktrees: object}. No other top-level keys.
 *   - `mixed`: a JSON object that has BOTH legacy-envelope keys AND
 *     additional keys that look like flat-map records.
 *   - `empty`: a JSON object with zero keys (`{}`).
 *
 * A12-relevant note: the classifier does NOT need spec input. The
 * spec-load policy check happens at the planner step.
 */
export function detectWorktreesRegistryShape(
  fileContents: string
): Result<RegistryShape> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fileContents);
  } catch (e) {
    const msg = (e as { message?: string }).message ?? 'unknown JSON error';
    return err(
      migrationDiagnostic(
        MIGRATION_RULES.READ_FAILED,
        `worktrees.json could not be parsed as JSON: ${msg}`
      )
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return err(
      migrationDiagnostic(
        MIGRATION_RULES.READ_FAILED,
        `worktrees.json is not a JSON object.`
      )
    );
  }
  const obj = parsed as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 0) {
    return ok({ kind: 'empty', reason: 'empty_object' });
  }
  const hasVersion =
    Object.prototype.hasOwnProperty.call(obj, 'version') &&
    typeof obj.version === 'number';
  const hasWorktreesObject =
    Object.prototype.hasOwnProperty.call(obj, 'worktrees') &&
    typeof obj.worktrees === 'object' &&
    obj.worktrees !== null &&
    !Array.isArray(obj.worktrees);

  if (hasVersion && hasWorktreesObject) {
    const otherKeys = keys.filter((k) => k !== 'version' && k !== 'worktrees');
    if (otherKeys.length > 0) {
      // Mixed: envelope keys adjacent to non-envelope record keys.
      return ok({
        kind: 'mixed',
        reason: `legacy-envelope keys (version, worktrees) coexist with non-envelope top-level keys: ${otherKeys.join(', ')}`,
      });
    }
    const nested = obj.worktrees as Record<string, unknown>;
    return ok({
      kind: 'legacy_envelope',
      version: obj.version as number,
      nestedRecordCount: Object.keys(nested).length,
    });
  }

  // No envelope. If `version` or `worktrees` appears alone (without the
  // other), classify as mixed — that combination is not a recognized
  // v10.2 shape and is not a clean flat map.
  if (hasVersion && !hasWorktreesObject) {
    return ok({
      kind: 'mixed',
      reason: 'top-level "version" number is present but the legacy "worktrees" object is not',
    });
  }
  if (!hasVersion && hasWorktreesObject) {
    return ok({
      kind: 'mixed',
      reason: 'top-level "worktrees" object is present but the legacy "version" number is not',
    });
  }

  // Pure flat map (every top-level key is treated as a worktree name).
  return ok({ kind: 'flat', recordCount: keys.length });
}

// ---- Destroyed-record policy --------------------------------------------

/**
 * One spec, narrowed to the fields the migration's policy check
 * actually reads. Avoids depending on the full kernel Spec type for
 * test fixtures.
 */
export interface MigrationSpecShape {
  readonly id: string;
  readonly worktree?: string;
}

export type RecordOmissionDecision = {
  readonly record: string;
  readonly status?: string;
} & (
  | {
      readonly omit: false;
      readonly reason: 'non_terminal' | 'spec_claims' | 'path_present';
      readonly detail: { readonly specId?: string; readonly path?: string };
    }
  | { readonly omit: true; readonly reason: 'destroyed_safe_to_omit' }
);

/**
 * Apply the destroyed-record policy to each nested record. Pure: takes
 * the parsed envelope, the loaded specs (just id + worktree?), and a
 * path-existence callback.
 *
 * Policy (invariant 3 of WORKTREE-REGISTRY-LEGACY-ENVELOPE-MIGRATION-001):
 *
 *   A record with status: "destroyed" MAY be omitted IFF BOTH:
 *     (a) No loaded spec has its `worktree:` field set to the
 *         record's key.
 *     (b) The record's `path` is undefined/null/empty OR the
 *         path does not exist on disk.
 *
 *   Otherwise, the migration refuses (whole-file refusal, not
 *   partial migration).
 *
 *   Non-terminal records (status missing or != "destroyed") are
 *   always preserved verbatim.
 */
export function classifyRecordsForMigration(
  nestedRecords: Record<string, unknown>,
  specs: readonly MigrationSpecShape[],
  pathExistsCheck: (path: string) => boolean
): readonly RecordOmissionDecision[] {
  const decisions: RecordOmissionDecision[] = [];

  // Build a name -> claiming spec id index. Multiple specs claiming
  // the same name (a separate doctor concern; not our problem) — we
  // take the first match for diagnostic naming.
  const claims = new Map<string, string>();
  for (const spec of specs) {
    if (typeof spec.worktree === 'string' && spec.worktree.length > 0) {
      if (!claims.has(spec.worktree)) {
        claims.set(spec.worktree, spec.id);
      }
    }
  }

  for (const [key, raw] of Object.entries(nestedRecords)) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      // Non-object nested value (defensive). Treat as non-terminal —
      // preserve verbatim. The kernel's regular registry validation
      // will surface it later if it's malformed.
      decisions.push({
        record: key,
        omit: false,
        reason: 'non_terminal',
        detail: {},
      });
      continue;
    }
    const record = raw as Record<string, unknown>;
    const status = typeof record.status === 'string' ? record.status : undefined;

    if (status !== 'destroyed') {
      decisions.push({
        record: key,
        omit: false,
        reason: 'non_terminal',
        ...(status !== undefined ? { status } : {}),
        detail: {},
      });
      continue;
    }

    // Status is "destroyed". Check policy conditions (a) and (b).
    const claimingSpec = claims.get(key);
    if (claimingSpec !== undefined) {
      decisions.push({
        record: key,
        status,
        omit: false,
        reason: 'spec_claims',
        detail: { specId: claimingSpec },
      });
      continue;
    }

    const recordedPath =
      typeof record.path === 'string' && record.path.length > 0
        ? record.path
        : undefined;
    if (recordedPath !== undefined && pathExistsCheck(recordedPath)) {
      decisions.push({
        record: key,
        status,
        omit: false,
        reason: 'path_present',
        detail: { path: recordedPath },
      });
      continue;
    }

    decisions.push({
      record: key,
      status,
      omit: true,
      reason: 'destroyed_safe_to_omit',
    });
  }
  return decisions;
}

// ---- Migration plan ------------------------------------------------------

export type MigrationPlan =
  | {
      readonly kind: 'no_op';
      readonly reason: 'already_flat';
      readonly recordCount: number;
    }
  | {
      readonly kind: 'no_op';
      readonly reason: 'empty_object';
    }
  | {
      readonly kind: 'apply';
      readonly decisions: readonly RecordOmissionDecision[];
      /** The bytes to write. Always JSON.stringify(flatMap, null, 2) + '\n'. */
      readonly outputBytes: string;
      /** Pre-migration nested-record count, for reporting. */
      readonly inputRecordCount: number;
      /** Post-migration record count after omissions. */
      readonly outputRecordCount: number;
    }
  | {
      readonly kind: 'refuse';
      readonly reason: 'destroyed_blocked' | 'mixed_shape' | 'spec_load_failed' | 'read_failed';
      readonly diagnostic: Diagnostic;
      /** Per-record decisions when refusal is policy-driven. Empty for shape-level refusals. */
      readonly decisions?: readonly RecordOmissionDecision[];
    };

/**
 * A12 gate: detect the precise spec-load failure mode that makes the
 * destroyed-record policy unverifiable. Returns true iff
 *   specs.length === 0 AND diagnostics contains READ_IO_FAILED.
 * Other diagnostics (SPECS_NON_YAML_SKIPPED, SPECS_DUPLICATE_ID,
 * SPECS_SPEC_INVALID) MUST NOT cause refusal — those do not make
 * the spec universe unknowable.
 */
export function isSpecLoadVerifiable(
  specs: readonly MigrationSpecShape[],
  diagnostics: readonly Diagnostic[]
): boolean {
  if (specs.length > 0) return true;
  const hasReadIoFailed = diagnostics.some(
    (d) => d.rule === 'store.read.io_failed'
  );
  return !hasReadIoFailed;
}

/**
 * Compose shape detection + record classification into a single plan.
 *
 * Refusal precedence (locked):
 *   1. read_failed (JSON parse / non-object): shape-level refusal.
 *   2. mixed_shape: shape-level refusal.
 *   3. already_flat / empty_object: no_op.
 *   4. legacy_envelope + spec-load unverifiable (A12): refuse.
 *   5. legacy_envelope + any destroyed record blocks omission: refuse.
 *   6. legacy_envelope clean: apply.
 *
 * Note: spec-load verifiability is checked ONLY when the file is in
 * legacy_envelope shape AND at least one destroyed record exists. A
 * legacy envelope with zero destroyed records has no claim check to
 * verify, so a spec-load failure does not block migration. Per the
 * audit, this preserves the narrow refusal posture.
 */
export function planMigration(
  fileContents: string,
  specs: readonly MigrationSpecShape[],
  specLoadDiagnostics: readonly Diagnostic[],
  pathExistsCheck: (path: string) => boolean
): MigrationPlan {
  const shape = detectWorktreesRegistryShape(fileContents);
  if (!isOk(shape)) {
    // err() guarantees at least one diagnostic; the [0] index is
    // safe but TypeScript can't prove it under strict mode. Fall
    // back to a synthesized read_failed diagnostic if the array is
    // somehow empty.
    const diagnostic =
      shape.errors[0] ??
      migrationDiagnostic(
        MIGRATION_RULES.READ_FAILED,
        'worktrees.json detection failed without a specific diagnostic.'
      );
    return {
      kind: 'refuse',
      reason: 'read_failed',
      diagnostic,
    };
  }

  const shapeValue = shape.value;
  if (shapeValue.kind === 'mixed') {
    return {
      kind: 'refuse',
      reason: 'mixed_shape',
      diagnostic: migrationDiagnostic(
        MIGRATION_RULES.MIXED_SHAPE_REFUSED,
        `Refused to migrate: .caws/worktrees.json has a mixed shape (${shapeValue.reason}). Resolve manually.`,
        {
          narrowRepair:
            'Hand-edit .caws/worktrees.json to either the v10.2 envelope shape or the v11 flat-map shape, then re-run the migration.',
        }
      ),
    };
  }

  if (shapeValue.kind === 'flat') {
    return { kind: 'no_op', reason: 'already_flat', recordCount: shapeValue.recordCount };
  }

  if (shapeValue.kind === 'empty') {
    return { kind: 'no_op', reason: 'empty_object' };
  }

  // shape is legacy_envelope. Parse the nested records.
  // Safe to re-parse because shape detection already validated the
  // top-level shape; this is to obtain the nested object reference.
  const parsed = JSON.parse(fileContents) as {
    version: number;
    worktrees: Record<string, unknown>;
  };
  const nested = parsed.worktrees;

  const decisions = classifyRecordsForMigration(nested, specs, pathExistsCheck);
  const hasDestroyedRecords = decisions.some(
    (d) => d.status === 'destroyed'
  );

  // A12: spec-load verifiability check fires ONLY when at least one
  // destroyed record exists (otherwise the claim check has no work).
  if (hasDestroyedRecords && !isSpecLoadVerifiable(specs, specLoadDiagnostics)) {
    return {
      kind: 'refuse',
      reason: 'spec_load_failed',
      diagnostic: migrationDiagnostic(
        MIGRATION_RULES.SPEC_LOAD_FAILED_POLICY_UNVERIFIABLE,
        'Refused to migrate: cannot verify destroyed-record policy because spec loading failed (zero parsed specs and at least one READ_IO_FAILED diagnostic from .caws/specs/).',
        {
          narrowRepair:
            'Resolve the .caws/specs/ load failure (file permissions, directory corruption, etc.), then re-run the migration.',
        }
      ),
      decisions,
    };
  }

  const blocked = decisions.filter((d) => !d.omit && d.reason !== 'non_terminal');
  if (blocked.length > 0) {
    return {
      kind: 'refuse',
      reason: 'destroyed_blocked',
      diagnostic: migrationDiagnostic(
        MIGRATION_RULES.DESTROYED_RECORD_BLOCKS_OMISSION,
        `Refused to migrate: at least one destroyed record cannot be safely omitted. ${blocked.length} record(s) blocked.`,
        {
          narrowRepair:
            'Resolve the conflict manually: clear the worktree: field on the claiming spec if the worktree is genuinely destroyed, or remove the on-disk directory if it is leftover from a destroyed worktree. Then re-run the migration.',
          data: {
            blocked: blocked.map((d) => ({
              record: d.record,
              reason: d.reason,
              detail: d.omit === false ? d.detail : undefined,
            })),
          },
        }
      ),
      decisions,
    };
  }

  // Build the flat map: preserve every record verbatim except those
  // marked omit: true.
  const flatMap: Record<string, unknown> = {};
  for (const decision of decisions) {
    if (decision.omit) continue;
    flatMap[decision.record] = nested[decision.record];
  }

  // Exact serialization: 2-space indent + trailing newline. Matches
  // the apply-patch convention so loader round-trips are byte-stable.
  const outputBytes = JSON.stringify(flatMap, null, 2) + '\n';

  return {
    kind: 'apply',
    decisions,
    outputBytes,
    inputRecordCount: shapeValue.nestedRecordCount,
    outputRecordCount: Object.keys(flatMap).length,
  };
}
