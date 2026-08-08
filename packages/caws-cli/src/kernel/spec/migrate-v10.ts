// v10 → v11 spec YAML transformer.
//
// PURE: no filesystem, network, env-var, git, or shell-flag access.
// Input is a parsed YAML object; output is a discriminated union describing
// what the transformer did or refused. The CLI store layer owns reading
// files and writing reports; the shell owns flag parsing and rendering.
//
// Doctrine sources:
//   - .caws/specs/CAWS-MIGRATE-V10-SPECS-001.yaml invariants 1-12
//   - Acceptance A1-A7 (transformer surface)
//   - CLAUDE.md trap #3 (tier-2 contracts), trap #6 (non_functional keys)
//
// Authority boundary: the transformer NEVER laundered authority claims.
//   - blast_radius.modules: [] → REFUSED, no synthesis from scope.in.
//   - lifecycle_state outside v11 enum → REFUSED, requires per-spec mapping.
//   - All unknown fields → reported verbatim, never silently dropped.

import { diagnostic } from '../diagnostics';
import type { Diagnostic } from '../diagnostics/types';
import { err, ok } from '../result';
import type { Result } from '../result/types';

// --- Public types ---------------------------------------------------------

/**
 * Rules namespaced spec.migrate.*. Refusals and warnings both reference
 * these stable identifiers in their `rule` field. Tests and downstream
 * tooling depend on these literals.
 */
export const MIGRATE_RULES = {
  // Refusal codes (outcome.kind === 'refused')
  ALREADY_V11: 'spec.migrate.already_v11_no_migration_needed',
  NOT_AN_OBJECT: 'spec.migrate.input_not_an_object',
  MISSING_ID: 'spec.migrate.missing_id',
  MISSING_TITLE: 'spec.migrate.missing_title',
  BLAST_RADIUS_MODULES_EMPTY: 'spec.migrate.blast_radius_modules_empty',
  BLAST_RADIUS_MODULES_MISSING: 'spec.migrate.blast_radius_modules_missing',
  LIFECYCLE_UNMAPPED: 'spec.migrate.lifecycle_unmapped',
  RISK_TIER_UNRESOLVABLE: 'spec.migrate.risk_tier_unresolvable',
  MODE_UNRESOLVABLE: 'spec.migrate.mode_unresolvable',
  SCOPE_IN_MISSING: 'spec.migrate.scope_in_missing',

  // Warning codes (outcome.kind === 'migrated_with_warnings')
  SAFE_RENAME: 'spec.migrate.safe_rename',
  NF_SUBKEY_RENAME: 'spec.migrate.non_functional_subkey_rename',
  RISK_TIER_COERCED: 'spec.migrate.risk_tier_coerced',
  CREATED_AT_COERCED: 'spec.migrate.created_at_coerced',
  MODE_OVERRIDDEN_FROM_TYPE: 'spec.migrate.mode_overridden_from_type',
  MODE_TYPE_DISAGREEMENT: 'spec.migrate.mode_type_disagreement',
  LIFECYCLE_MAPPING_APPLIED: 'spec.migrate.lifecycle_mapping_applied',
  UNHANDLED_FIELD_PRESERVED: 'spec.migrate.unhandled_field_preserved',
} as const;

export type MigrateRule = (typeof MIGRATE_RULES)[keyof typeof MIGRATE_RULES];

/**
 * Top-level v10 → v11 safe-rename table. Authoritative source.
 *
 * `value_preserved: true` means the value is moved unchanged; no type
 * coercion is applied at this layer. (Risk tier coercion is a separate
 * concern handled below.)
 */
export const SAFE_RENAMES: ReadonlyArray<{ from: string; to: string }> = [
  { from: 'status', to: 'lifecycle_state' },
  { from: 'acceptance_criteria', to: 'acceptance' },
  { from: 'created', to: 'created_at' },
];

/**
 * `non_functional` subkey renames. v10 used short forms; v11 enumerates
 * exactly { accessibility, performance, reliability, security } per
 * spec.v1.json. The 'a11y' / 'perf' shortforms get renamed in place.
 */
export const NF_SUBKEY_RENAMES: ReadonlyArray<{ from: string; to: string }> = [
  { from: 'a11y', to: 'accessibility' },
  { from: 'perf', to: 'performance' },
];

/**
 * Risk tier coercion table. v10 specs frequently used string forms;
 * v11 requires integer 1/2/3.
 */
export const RISK_TIER_COERCIONS: ReadonlyMap<string, 1 | 2 | 3> = new Map([
  ['T1', 1], ['1', 1],
  ['T2', 2], ['2', 2],
  ['T3', 3], ['3', 3],
]);

/**
 * Mode values admitted by v11. Used by both `mode` direct admission
 * and `type → mode` fallback.
 */
export const V11_MODES: ReadonlySet<string> = new Set([
  'feature', 'refactor', 'fix', 'doc', 'chore',
]);

/**
 * v11 lifecycle_state enum. Values outside this set require an explicit
 * per-spec mapping via options.lifecycleMapping; auto-defaults are
 * forbidden (invariant 6).
 */
export const V11_LIFECYCLE_STATES: ReadonlySet<string> = new Set([
  'draft', 'active', 'closed', 'archived',
]);

/**
 * Top-level v10 fields that have no v11 home and are reported (not
 * silently dropped). Per invariant 4 they go to `report_only_fields`.
 *
 * Membership semantics (load-bearing):
 *   - Fields IN this set are deleted from migrated output, preserved
 *     verbatim under `report_only_fields`, and surfaced as
 *     `spec.migrate.unhandled_field_preserved` warnings.
 *   - Fields NOT in this set stay in output. The post-write validator
 *     (`parseAndValidateSpec`) rejects them via `additionalProperties:
 *     false` on spec.v1, which triggers `post_write_validation_failed`
 *     and an apply-time rollback.
 *
 * This list is the union of two evidence rounds against real corpora:
 *   1. Sterling's 27-spec recon (pre-7.1): change_budget, bounded_claim,
 *      description, type, feature_id, success_criteria, human_override,
 *      reasoning_engine, tools.
 *   2. Commit 7 Sterling real-checkout smoke (560 specs, 38 migratable)
 *      surfaced 14 additional v10-only top-level names. PWF=38/38 until
 *      they were classified as report-only and excluded from output.
 *
 * NOT a refusal list — these fields are preserved verbatim in the
 * report for operator review. Adding a name here does NOT weaken
 * spec.v1 schema strictness; it only changes the migrator's
 * classification from "leave in output → kernel rejects → PWF" to
 * "delete from output → warning + report entry → migrated".
 */
export const KNOWN_REPORT_ONLY_TOP_LEVEL: ReadonlySet<string> = new Set([
  // Round 1 (Sterling 27-spec recon)
  'change_budget',
  'bounded_claim',
  'description',
  'type', // dropped after mode resolution (the value may be preserved)
  'feature_id',
  'success_criteria',
  'human_override',
  'reasoning_engine',
  'tools',
  // Round 2 (commit 7 Sterling 560-spec real-checkout smoke)
  'target',
  'migrations',
  'threats',
  'dependencies',
  'related_specs',
  'related_docs',
  'kind',
  'test_strategy',
  'closure_path',
  'determinism',
  'fail_closed',
  'byte_identity',
  'acceptance_criteria_summary',
  'authority_boundary',
]);

export interface LifecycleMapping {
  /** Maps spec.id → { lifecycle_state, optional closure_notes }. */
  readonly [specId: string]: {
    readonly lifecycle_state: 'draft' | 'active' | 'closed' | 'archived';
    readonly closure_notes?: string;
    readonly resolution?: 'completed' | 'superseded' | 'abandoned';
  };
}

export interface MigrateOptions {
  /**
   * Per-spec mapping for lifecycle values outside the v11 enum. The
   * transformer NEVER supplies a default; operators must opt in
   * per-spec to map 'superseded' / 'proven' / 'frozen' to a v11 value.
   */
  readonly lifecycleMapping?: LifecycleMapping;
}

export interface MigrateSource {
  /** Optional file path used in diagnostic.subject only. */
  readonly path?: string;
  /** sha256 of the original YAML bytes. Recorded by the store layer
   *  in the durable report; not consumed by transformer logic. */
  readonly contentDigest?: string;
}

export interface SafeRenameApplied {
  readonly from: string;
  readonly to: string;
}

export interface CoercionApplied {
  readonly field: string;
  readonly from: unknown;
  readonly to: unknown;
}

export type ModeSource = 'mode' | 'type' | 'unresolvable';

export interface MigratedOutcome {
  readonly kind: 'migrated';
  readonly value: Record<string, unknown>;
  readonly safe_renames: ReadonlyArray<SafeRenameApplied>;
  readonly coercions: ReadonlyArray<CoercionApplied>;
  readonly mode_source: ModeSource;
  readonly lifecycle_mapping_used: LifecycleMapping[string] | null;
  readonly report_only_fields: Record<string, unknown>;
}

export interface MigratedWithWarningsOutcome {
  readonly kind: 'migrated_with_warnings';
  readonly value: Record<string, unknown>;
  readonly warnings: ReadonlyArray<Diagnostic>;
  readonly safe_renames: ReadonlyArray<SafeRenameApplied>;
  readonly coercions: ReadonlyArray<CoercionApplied>;
  readonly mode_source: ModeSource;
  readonly lifecycle_mapping_used: LifecycleMapping[string] | null;
  readonly report_only_fields: Record<string, unknown>;
}

export interface RefusedOutcome {
  readonly kind: 'refused';
  readonly reasons: ReadonlyArray<Diagnostic>;
  /** Best-effort spec id from the input (may be null). */
  readonly spec_id: string | null;
}

export type MigrateOutcome =
  | MigratedOutcome
  | MigratedWithWarningsOutcome
  | RefusedOutcome;

// --- Detection -------------------------------------------------------------

/**
 * Pure classifier. Mirrors the regex-level scan in events-migration.ts
 * but operates on a parsed object instead of raw bytes. A spec with ANY
 * v10 top-level marker is v10 even if v11 keys also appear (mixed-shape
 * is a problem this transformer surfaces, not papers over).
 *
 * v10 markers: `status`, `acceptance_criteria`, `type` (when co-present
 *   with other v10 signals — `type` alone could be a v11 doc field, but
 *   `type` co-present with `status` or `acceptance_criteria` is v10).
 * v11 markers: `lifecycle_state`, `mode`, `acceptance`.
 *
 * The acceptance criterion A7 says: a v11-shape spec (has
 * lifecycle_state, no status, no acceptance_criteria) classifies v11
 * and migrateSpecV10 refuses with 'already_v11_no_migration_needed'.
 */
export function detectSpecVersion(parsed: unknown): 'v10' | 'v11' | 'unknown' {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return 'unknown';
  }
  const obj = parsed as Record<string, unknown>;

  const hasStatus = 'status' in obj;
  const hasAcceptanceCriteria = 'acceptance_criteria' in obj;
  const hasLifecycleState = 'lifecycle_state' in obj;
  const hasAcceptance = 'acceptance' in obj;
  const hasMode = 'mode' in obj;
  const hasType = 'type' in obj;

  // Strong v10 signals (any wins).
  if (hasStatus || hasAcceptanceCriteria) return 'v10';

  // `type` alone is a weak signal — v11 doc-mode specs might have a
  // 'type' field meaning something else. Only call it v10 if `type` is
  // present AND no v11 markers are.
  if (hasType && !hasLifecycleState && !hasAcceptance && !hasMode) {
    return 'v10';
  }

  // Strong v11 signals.
  if (hasLifecycleState || hasAcceptance || hasMode) return 'v11';

  return 'unknown';
}

// --- Migration -------------------------------------------------------------

/**
 * Pure transformer entry point. Per invariant 2: NO I/O, NO env, NO git.
 *
 * Returns a three-kind discriminated union. The shape is stable; the
 * shell renders all three deterministically. New fields may be added to
 * an outcome variant but the `kind` enum is closed.
 */
export function migrateSpecV10(
  parsed: unknown,
  source: MigrateSource = {},
  options: MigrateOptions = {},
): Result<MigrateOutcome> {
  // --- A7: idempotency guard --------------------------------------------
  const version = detectSpecVersion(parsed);
  if (version === 'v11') {
    return ok({
      kind: 'refused',
      reasons: [
        diagnostic({
          rule: MIGRATE_RULES.ALREADY_V11,
          authority: 'kernel/spec',
          message:
            'Input is already a v11-shape spec; migration is a no-op refusal (not a silent transformation).',
          ...(source.path !== undefined && { subject: source.path }),
          severity: 'info',
          narrowRepair:
            'No action needed; the spec is already in the v11 shape.',
        }),
      ],
      spec_id: extractSpecId(parsed),
    });
  }

  // --- Input gate -------------------------------------------------------
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return err(
      diagnostic({
        rule: MIGRATE_RULES.NOT_AN_OBJECT,
        authority: 'kernel/spec',
        message:
          'Spec input is not a plain object; the transformer requires an object root.',
        ...(source.path !== undefined && { subject: source.path }),
        narrowRepair: 'Provide a parsed YAML mapping (not a scalar or array).',
      }),
    );
  }

  const inputObj = parsed as Record<string, unknown>;
  const specId = extractSpecId(inputObj);

  // --- Refusal collection -----------------------------------------------
  // We collect ALL hard refusals before returning so the operator sees
  // every blocker in a single pass, not one at a time.
  const refusals: Diagnostic[] = [];

  // Required-field presence.
  if (specId === null) {
    refusals.push(
      diagnostic({
        rule: MIGRATE_RULES.MISSING_ID,
        authority: 'kernel/spec',
        message: 'Spec is missing an id field.',
        ...(source.path !== undefined && { subject: source.path }),
        narrowRepair: 'Author must add a top-level `id` field.',
      }),
    );
  }
  if (
    typeof inputObj['title'] !== 'string' ||
    inputObj['title'].length === 0
  ) {
    refusals.push(
      diagnostic({
        rule: MIGRATE_RULES.MISSING_TITLE,
        authority: 'kernel/spec',
        message: 'Spec is missing a non-empty title.',
        ...(source.path !== undefined && { subject: source.path }),
        narrowRepair: 'Author must add a top-level `title` string.',
      }),
    );
  }

  // blast_radius.modules: synthesis is FORBIDDEN per invariant 1.
  const blastRadiusRefusal = checkBlastRadiusModules(inputObj, source);
  if (blastRadiusRefusal !== null) refusals.push(blastRadiusRefusal);

  // scope.in: a missing scope is a v11 schema violation, refuse early.
  const scopeRefusal = checkScopeIn(inputObj, source);
  if (scopeRefusal !== null) refusals.push(scopeRefusal);

  // --- Build the v11 output, collecting warnings ------------------------
  const warnings: Diagnostic[] = [];
  const safeRenames: SafeRenameApplied[] = [];
  const coercions: CoercionApplied[] = [];
  const reportOnly: Record<string, unknown> = {};

  // Copy the input verbatim, then mutate. The transformer is a value
  // function from the caller's perspective; this local mutation never
  // escapes.
  const output: Record<string, unknown> = { ...inputObj };

  // Top-level safe renames.
  for (const { from, to } of SAFE_RENAMES) {
    if (from in output) {
      // If the target also exists, the v10 input is mixed-shape; treat
      // the existing v11 key as authoritative and report the v10 value.
      if (to in output && output[to] !== output[from]) {
        reportOnly[`${from}_dropped_because_${to}_present`] = output[from];
        delete output[from];
        warnings.push(
          diagnostic({
            rule: MIGRATE_RULES.SAFE_RENAME,
            authority: 'kernel/spec',
            message: `Mixed-shape: v10 field "${from}" and v11 field "${to}" both present; preserved v11, recorded v10 in report.`,
            ...(source.path !== undefined && { subject: source.path }),
            severity: 'warning',
            data: { from, to, value_preserved: false, conflict: 'mixed_shape' },
          }),
        );
      } else {
        output[to] = output[from];
        delete output[from];
        safeRenames.push({ from, to });
        warnings.push(
          diagnostic({
            rule: MIGRATE_RULES.SAFE_RENAME,
            authority: 'kernel/spec',
            message: `Renamed v10 field "${from}" to v11 field "${to}".`,
            ...(source.path !== undefined && { subject: source.path }),
            severity: 'warning',
            data: { from, to, value_preserved: true },
          }),
        );
      }
    }
  }

  // created_at coercion: v10 commonly used bare YYYY-MM-DD dates;
  // v11 schema requires `date-time` format. Coerce bare dates to
  // midnight UTC and record as a coercion entry so the operator
  // sees the change in the migration report. Anything that isn't a
  // bare YYYY-MM-DD or a parseable date-time is left as-is and will
  // surface as a schema violation at post-write validation (correct
  // — we don't want to silently coerce arbitrary nonsense).
  const createdAt = output['created_at'];
  if (typeof createdAt === 'string') {
    const coerced = coerceBareDateToIsoDateTime(createdAt);
    if (coerced !== null && coerced !== createdAt) {
      coercions.push({ field: 'created_at', from: createdAt, to: coerced });
      output['created_at'] = coerced;
      warnings.push(
        diagnostic({
          rule: MIGRATE_RULES.CREATED_AT_COERCED,
          authority: 'kernel/spec',
          message: `Coerced bare-date created_at "${createdAt}" to ISO date-time "${coerced}" (v11 schema requires date-time format).`,
          ...(source.path !== undefined && { subject: source.path }),
          severity: 'warning',
          data: { from: createdAt, to: coerced },
        }),
      );
    }
  }

  // non_functional subkey renames.
  const nfOriginal = output['non_functional'];
  if (typeof nfOriginal === 'object' && nfOriginal !== null && !Array.isArray(nfOriginal)) {
    const nf = { ...(nfOriginal as Record<string, unknown>) };
    for (const { from, to } of NF_SUBKEY_RENAMES) {
      if (from in nf) {
        if (to in nf && nf[to] !== nf[from]) {
          reportOnly[`non_functional.${from}_dropped_because_${to}_present`] = nf[from];
          delete nf[from];
          warnings.push(
            diagnostic({
              rule: MIGRATE_RULES.NF_SUBKEY_RENAME,
              authority: 'kernel/spec',
              message: `Mixed-shape: non_functional.${from} and non_functional.${to} both present; preserved v11, recorded v10 in report.`,
              ...(source.path !== undefined && { subject: source.path }),
              severity: 'warning',
              data: { from: `non_functional.${from}`, to: `non_functional.${to}`, conflict: 'mixed_shape' },
            }),
          );
        } else {
          nf[to] = nf[from];
          delete nf[from];
          safeRenames.push({ from: `non_functional.${from}`, to: `non_functional.${to}` });
          warnings.push(
            diagnostic({
              rule: MIGRATE_RULES.NF_SUBKEY_RENAME,
              authority: 'kernel/spec',
              message: `Renamed non_functional.${from} to non_functional.${to}.`,
              ...(source.path !== undefined && { subject: source.path }),
              severity: 'warning',
              data: { from: `non_functional.${from}`, to: `non_functional.${to}`, value_preserved: true },
            }),
          );
        }
      }
    }
    output['non_functional'] = nf;
  }

  // risk_tier coercion.
  const tierResult = coerceRiskTier(output['risk_tier']);
  if (tierResult.kind === 'unresolvable') {
    refusals.push(
      diagnostic({
        rule: MIGRATE_RULES.RISK_TIER_UNRESOLVABLE,
        authority: 'kernel/spec',
        message: `risk_tier value "${String(output['risk_tier'])}" cannot be coerced to 1/2/3.`,
        ...(source.path !== undefined && { subject: source.path }),
        narrowRepair:
          'Author must set risk_tier to integer 1, 2, or 3 (or string "T1"/"T2"/"T3" which coerce).',
        data: { raw: output['risk_tier'] },
      }),
    );
  } else if (tierResult.kind === 'coerced') {
    coercions.push({
      field: 'risk_tier',
      from: tierResult.from,
      to: tierResult.to,
    });
    output['risk_tier'] = tierResult.to;
    warnings.push(
      diagnostic({
        rule: MIGRATE_RULES.RISK_TIER_COERCED,
        authority: 'kernel/spec',
        message: `Coerced risk_tier from ${JSON.stringify(tierResult.from)} to integer ${tierResult.to}.`,
        ...(source.path !== undefined && { subject: source.path }),
        severity: 'warning',
        data: { from: tierResult.from, to: tierResult.to },
      }),
    );
  }
  // tierResult.kind === 'already_int' → no change, no warning.

  // mode resolution (A3, A4).
  const modeResult = resolveMode(output['mode'], output['type']);
  let modeSource: ModeSource = 'unresolvable';
  if (modeResult.kind === 'unresolvable') {
    refusals.push(
      diagnostic({
        rule: MIGRATE_RULES.MODE_UNRESOLVABLE,
        authority: 'kernel/spec',
        message: `Cannot resolve a v11 mode from mode=${JSON.stringify(output['mode'])} type=${JSON.stringify(output['type'])}.`,
        ...(source.path !== undefined && { subject: source.path }),
        narrowRepair:
          'Author must set `mode` to one of feature/refactor/fix/doc/chore.',
        data: { mode: output['mode'], type: output['type'] },
      }),
    );
  } else {
    modeSource = modeResult.source;
    output['mode'] = modeResult.value;
    if (modeResult.source === 'type') {
      warnings.push(
        diagnostic({
          rule: MIGRATE_RULES.MODE_OVERRIDDEN_FROM_TYPE,
          authority: 'kernel/spec',
          message: `mode resolved from type field (mode="${String(modeResult.originalMode)}" was not a v11 mode; type="${String(modeResult.value)}" used).`,
          ...(source.path !== undefined && { subject: source.path }),
          severity: 'warning',
          data: {
            original_mode: modeResult.originalMode,
            resolved_mode: modeResult.value,
            source: 'type',
          },
        }),
      );
    } else if (modeResult.source === 'mode' && modeResult.typeDisagreed) {
      warnings.push(
        diagnostic({
          rule: MIGRATE_RULES.MODE_TYPE_DISAGREEMENT,
          authority: 'kernel/spec',
          message: `mode (${String(modeResult.value)}) and type (${String(output['type'])}) disagree; preserved mode per v11 authority.`,
          ...(source.path !== undefined && { subject: source.path }),
          severity: 'warning',
          data: { mode: modeResult.value, type: output['type'] },
        }),
      );
    }
  }

  // type is dropped from v11 output regardless of mode_source.
  // Preserve its value verbatim in the report.
  if ('type' in output) {
    reportOnly['type'] = output['type'];
    delete output['type'];
  }

  // lifecycle_state mapping (A6).
  const lifecycleResult = resolveLifecycle(
    output['lifecycle_state'],
    specId,
    options.lifecycleMapping,
  );
  let lifecycleMappingUsed: LifecycleMapping[string] | null = null;
  if (lifecycleResult.kind === 'unmapped') {
    refusals.push(
      diagnostic({
        rule: MIGRATE_RULES.LIFECYCLE_UNMAPPED,
        authority: 'kernel/spec',
        message: `lifecycle_state value "${String(lifecycleResult.value)}" has no v11 enum mapping and no --lifecycle-mapping entry was supplied for this spec.`,
        ...(source.path !== undefined && { subject: source.path }),
        narrowRepair:
          'Operator must supply --lifecycle-mapping <path> with an entry for this spec id, OR re-author the spec with one of {draft, active, closed, archived}.',
        data: { value: lifecycleResult.value, spec_id: specId },
      }),
    );
  } else if (lifecycleResult.kind === 'mapped') {
    output['lifecycle_state'] = lifecycleResult.mapping.lifecycle_state;
    if (lifecycleResult.mapping.closure_notes !== undefined) {
      output['closure_notes'] = lifecycleResult.mapping.closure_notes;
    }
    if (lifecycleResult.mapping.resolution !== undefined) {
      output['resolution'] = lifecycleResult.mapping.resolution;
    }
    lifecycleMappingUsed = lifecycleResult.mapping;
    warnings.push(
      diagnostic({
        rule: MIGRATE_RULES.LIFECYCLE_MAPPING_APPLIED,
        authority: 'kernel/spec',
        message: `Applied operator-supplied lifecycle mapping: ${String(lifecycleResult.originalValue)} → ${lifecycleResult.mapping.lifecycle_state}.`,
        ...(source.path !== undefined && { subject: source.path }),
        severity: 'warning',
        data: {
          original_value: lifecycleResult.originalValue,
          source: 'mapping',
          mapping: lifecycleResult.mapping,
        },
      }),
    );
  }
  // lifecycleResult.kind === 'already_valid' or 'missing' → no change.

  // Unhandled fields: anything in the input not consumed by a rename,
  // not a known v11 field, and not a known report-only field gets
  // recorded as an unhandled-field warning + preserved in reportOnly.
  // We do NOT delete unknown fields from output; the post-write
  // validator (the standard parseAndValidateSpec) will reject any
  // field that isn't in spec.v1.json's additionalProperties: false set.
  // The presence in reportOnly is a paper trail.
  for (const key of Object.keys(inputObj)) {
    if (KNOWN_REPORT_ONLY_TOP_LEVEL.has(key) && !(key in reportOnly)) {
      reportOnly[key] = inputObj[key];
      warnings.push(
        diagnostic({
          rule: MIGRATE_RULES.UNHANDLED_FIELD_PRESERVED,
          authority: 'kernel/spec',
          message: `v10 field "${key}" has no v11 equivalent; preserved verbatim in migration report.`,
          ...(source.path !== undefined && { subject: source.path }),
          severity: 'warning',
          data: { field: key },
        }),
      );
      delete output[key];
    }
  }

  // --- Refusal short-circuit -------------------------------------------
  if (refusals.length > 0) {
    return ok({
      kind: 'refused',
      reasons: refusals,
      spec_id: specId,
    });
  }

  // --- Pick the success variant ----------------------------------------
  if (warnings.length === 0) {
    return ok({
      kind: 'migrated',
      value: output,
      safe_renames: safeRenames,
      coercions,
      mode_source: modeSource,
      lifecycle_mapping_used: lifecycleMappingUsed,
      report_only_fields: reportOnly,
    });
  }

  return ok({
    kind: 'migrated_with_warnings',
    value: output,
    warnings,
    safe_renames: safeRenames,
    coercions,
    mode_source: modeSource,
    lifecycle_mapping_used: lifecycleMappingUsed,
    report_only_fields: reportOnly,
  });
}

// --- Private helpers ------------------------------------------------------

function extractSpecId(parsed: unknown): string | null {
  if (typeof parsed !== 'object' || parsed === null) return null;
  const id = (parsed as Record<string, unknown>)['id'];
  return typeof id === 'string' && id.length > 0 ? id : null;
}

function checkBlastRadiusModules(
  inputObj: Record<string, unknown>,
  source: MigrateSource,
): Diagnostic | null {
  const br = inputObj['blast_radius'];
  if (typeof br !== 'object' || br === null || Array.isArray(br)) {
    return diagnostic({
      rule: MIGRATE_RULES.BLAST_RADIUS_MODULES_MISSING,
      authority: 'kernel/spec',
      message: 'Spec is missing blast_radius (object with modules array).',
      ...(source.path !== undefined && { subject: source.path }),
      narrowRepair:
        'Author must declare blast_radius.modules; auto-synthesis from scope.in is intentionally refused.',
    });
  }
  const modules = (br as Record<string, unknown>)['modules'];
  if (!Array.isArray(modules)) {
    return diagnostic({
      rule: MIGRATE_RULES.BLAST_RADIUS_MODULES_MISSING,
      authority: 'kernel/spec',
      message: 'blast_radius.modules is missing or not an array.',
      ...(source.path !== undefined && { subject: source.path }),
      narrowRepair:
        'Author must declare blast_radius.modules; auto-synthesis from scope.in is intentionally refused.',
    });
  }
  if (modules.length === 0) {
    return diagnostic({
      rule: MIGRATE_RULES.BLAST_RADIUS_MODULES_EMPTY,
      authority: 'kernel/spec',
      message:
        'blast_radius.modules is an empty array; v11 requires at least one module.',
      ...(source.path !== undefined && { subject: source.path }),
      narrowRepair:
        'Author must declare blast_radius.modules; auto-synthesis from scope.in is intentionally refused.',
    });
  }
  return null;
}

function checkScopeIn(
  inputObj: Record<string, unknown>,
  source: MigrateSource,
): Diagnostic | null {
  const scope = inputObj['scope'];
  if (typeof scope !== 'object' || scope === null || Array.isArray(scope)) {
    return diagnostic({
      rule: MIGRATE_RULES.SCOPE_IN_MISSING,
      authority: 'kernel/spec',
      message: 'Spec is missing scope (object with in array).',
      ...(source.path !== undefined && { subject: source.path }),
      narrowRepair: 'Author must declare scope.in with at least one path.',
    });
  }
  const scopeIn = (scope as Record<string, unknown>)['in'];
  if (!Array.isArray(scopeIn) || scopeIn.length === 0) {
    return diagnostic({
      rule: MIGRATE_RULES.SCOPE_IN_MISSING,
      authority: 'kernel/spec',
      message: 'scope.in is missing or empty; v11 requires at least one entry.',
      ...(source.path !== undefined && { subject: source.path }),
      narrowRepair: 'Author must declare scope.in with at least one path.',
    });
  }
  return null;
}

type RiskTierCoercion =
  | { kind: 'already_int'; value: 1 | 2 | 3 }
  | { kind: 'coerced'; from: unknown; to: 1 | 2 | 3 }
  | { kind: 'unresolvable' };

/**
 * Coerce a bare ISO date (YYYY-MM-DD) to an ISO date-time at midnight
 * UTC. Returns null when the input is not a bare date the migrator
 * should touch.
 *
 * Decision rules:
 *   - "2026-01-01" → "2026-01-01T00:00:00.000Z" (coerced)
 *   - "2026-01-01T00:00:00.000Z" → returned unchanged (no coercion)
 *   - "yesterday", "tbd", "" → null (not a bare date; transformer
 *     leaves the value alone and post-write validation will reject it)
 *   - any string with T or Z but malformed → null (the v11 schema
 *     date-time format check is authoritative; we don't second-guess it)
 *
 * The bare-date pattern is exact: 4 digits, dash, 2 digits, dash, 2
 * digits, end. No leading whitespace, no trailing chars, no time
 * component. Anything looser is the validator's job to reject.
 */
const BARE_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function coerceBareDateToIsoDateTime(value: string): string | null {
  const m = BARE_DATE_RE.exec(value);
  if (m === null) return null;
  const [, yyyy, mm, dd] = m;
  // Validate via round-trip: parse the candidate ISO date-time, format
  // the parsed Date back to ISO, and confirm the Y/M/D segment matches.
  // JavaScript's Date is permissive (Feb 30 silently becomes Mar 2),
  // so we cannot rely on Date.parse alone. Round-trip equality is the
  // strict check.
  const iso = `${value}T00:00:00.000Z`;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return null;
  const roundTripDate = parsed.toISOString().slice(0, 10); // 'YYYY-MM-DD'
  if (roundTripDate !== `${yyyy}-${mm}-${dd}`) return null;
  return iso;
}

function coerceRiskTier(raw: unknown): RiskTierCoercion {
  if (raw === 1 || raw === 2 || raw === 3) {
    return { kind: 'already_int', value: raw };
  }
  if (typeof raw === 'string') {
    const coerced = RISK_TIER_COERCIONS.get(raw);
    if (coerced !== undefined) {
      return { kind: 'coerced', from: raw, to: coerced };
    }
  }
  return { kind: 'unresolvable' };
}

type ModeResolution =
  | { kind: 'resolved'; value: string; source: 'mode'; originalMode?: unknown; typeDisagreed: boolean }
  | { kind: 'resolved'; value: string; source: 'type'; originalMode: unknown; typeDisagreed: false }
  | { kind: 'unresolvable' };

function resolveMode(rawMode: unknown, rawType: unknown): ModeResolution {
  // Case 1: spec.mode is in v11 enum → use it.
  if (typeof rawMode === 'string' && V11_MODES.has(rawMode)) {
    const typeIsAlsoValid =
      typeof rawType === 'string' && V11_MODES.has(rawType);
    const typeDisagreed = typeIsAlsoValid && rawType !== rawMode;
    return {
      kind: 'resolved',
      value: rawMode,
      source: 'mode',
      originalMode: rawMode,
      typeDisagreed,
    };
  }
  // Case 2: type coerces to a v11 mode → fall back to type.
  if (typeof rawType === 'string' && V11_MODES.has(rawType)) {
    return {
      kind: 'resolved',
      value: rawType,
      source: 'type',
      originalMode: rawMode,
      typeDisagreed: false,
    };
  }
  // Case 3: neither.
  return { kind: 'unresolvable' };
}

type LifecycleResolution =
  | { kind: 'already_valid'; value: string }
  | { kind: 'missing' }
  | {
      kind: 'mapped';
      originalValue: unknown;
      mapping: LifecycleMapping[string];
    }
  | { kind: 'unmapped'; value: unknown };

function resolveLifecycle(
  raw: unknown,
  specId: string | null,
  mapping: LifecycleMapping | undefined,
): LifecycleResolution {
  if (raw === undefined || raw === null) {
    return { kind: 'missing' };
  }
  if (typeof raw === 'string' && V11_LIFECYCLE_STATES.has(raw)) {
    return { kind: 'already_valid', value: raw };
  }
  if (mapping !== undefined && specId !== null && specId in mapping) {
    const entry = mapping[specId];
    if (entry !== undefined) {
      return { kind: 'mapped', originalValue: raw, mapping: entry };
    }
  }
  return { kind: 'unmapped', value: raw };
}
