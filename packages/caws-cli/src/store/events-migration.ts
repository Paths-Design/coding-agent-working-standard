// Pure migration module for v10→v11 events.jsonl rotation
// (CAWS-MIGRATE-V10-EVENTS-001 A9).
//
// This module contains zero filesystem I/O and zero shell parsing. It
// classifies a raw events.jsonl payload, gathers actor-shape stats and
// tail metadata, and produces a deterministic rotation plan. The shell
// reads files, calls into this module, prints the plan, and (on --apply)
// invokes rotateEvents in events-store.ts. The shell is the only layer
// that touches `.caws/`.
//
// This mirrors the worktrees-migration.ts precedent: pure detector +
// pure planner + shell-does-IO. Refer to worktrees-migration.ts for the
// canonical pattern.
//
// Note on validation: detectEventsLogShape NEVER calls validateChainedEvent.
// Calling the strict validator on a v10 line is the exact failure mode
// this slice exists to repair (the v11 envelope shape rejects every line
// where actor is a string). The detector parses each line with JSON.parse
// defensively and classifies actor shape by direct type inspection. See
// docs/architecture/caws-vnext-command-surface.md invariant 14 and the
// rotateEvents tolerant-scan helper in events-store.ts.

import { diagnostic } from '@paths.design/caws-kernel';
import { err, ok, type Diagnostic, type Result } from '@paths.design/caws-kernel';

// ---------------------------------------------------------------------------
// Migration-local rule constants
//
// These rules are local to the migration surface and named with the
// `store.events.migration.*` prefix. They are emitted only by this
// module and by the shell command that invokes it (A10).
// ---------------------------------------------------------------------------

export const MIGRATION_RULES = {
  /** events.jsonl could not be JSON-parsed at all; every line failed. */
  UNPARSEABLE_INPUT: 'store.events.migration.unparseable_input',
  /** events.jsonl is empty; there is nothing to migrate or rotate. */
  EMPTY_INPUT: 'store.events.migration.empty_input',
  /** A v10-shape spec YAML was detected during half-upgrade scan. */
  V10_SPEC_DETECTED: 'store.events.migration.v10_spec_detected',
} as const;

export type MigrationRule = (typeof MIGRATION_RULES)[keyof typeof MIGRATION_RULES];

// ---------------------------------------------------------------------------
// Events-log shape detection
// ---------------------------------------------------------------------------

export interface ActorShapeStats {
  readonly v10_string_actor: number;
  readonly v11_object_actor: number;
  readonly unparseable: number;
}

export type EventsLogKind =
  /** Every parseable line has a string actor (v10 envelope). */
  | 'all_v10'
  /** Every parseable line has a structured actor (v11 envelope). */
  | 'all_v11'
  /** Lines exist with both shapes. */
  | 'mixed_v10_v11'
  /** The file has zero non-empty lines. */
  | 'empty'
  /** No line could be JSON-parsed. */
  | 'unparseable_only';

export interface EventsLogShape {
  readonly kind: EventsLogKind;
  readonly stats: ActorShapeStats;
  /** Total non-empty lines (parseable + unparseable). */
  readonly lineCount: number;
  /** Tail event_hash if the last non-empty line parsed and carried one. */
  readonly tailHash: string | null;
  /** Tail seq if the last non-empty line parsed and carried a valid integer. */
  readonly tailSeq: number | null;
}

/**
 * Classify the actor-shape of every non-empty line in a raw events.jsonl
 * payload. Pure: takes the file contents as a string, returns the
 * detection result. No filesystem access.
 *
 * Errors:
 *   - returns Err for an empty input. The shell treats this as "nothing
 *     to do" rather than a hard error — the same condition rotateEvents
 *     refuses on, so the migration command can short-circuit before
 *     calling into the store.
 *
 * The detector deliberately does NOT call validateChainedEvent: the
 * whole point of this slice is to handle v10-shape lines that the
 * strict validator rejects. JSON.parse + direct actor-shape inspection
 * is the entire contract.
 */
export function detectEventsLogShape(
  raw: string
): Result<EventsLogShape> {
  const trailingNewline = raw.endsWith('\n');
  const parts = raw.split('\n');
  const lines = trailingNewline ? parts.slice(0, -1) : parts;
  const nonEmpty = lines.filter((l) => l.length > 0);

  if (nonEmpty.length === 0) {
    return err(
      diagnostic({
        rule: MIGRATION_RULES.EMPTY_INPUT,
        authority: 'kernel/diagnostics',
        message:
          'events.jsonl is empty; nothing to migrate. rotateEvents refuses on the same condition (EVENTS_ROTATE_NOTHING_TO_ROTATE).',
      })
    );
  }

  let v10 = 0;
  let v11 = 0;
  let bad = 0;
  let tailHash: string | null = null;
  let tailSeq: number | null = null;

  for (let i = 0; i < nonEmpty.length; i++) {
    const line = nonEmpty[i]!;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      bad += 1;
      continue;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      bad += 1;
      continue;
    }
    const obj = parsed as Record<string, unknown>;
    const actor = obj['actor'];
    if (typeof actor === 'string') {
      v10 += 1;
    } else if (
      actor !== null &&
      typeof actor === 'object' &&
      !Array.isArray(actor) &&
      typeof (actor as Record<string, unknown>)['kind'] === 'string'
    ) {
      v11 += 1;
    } else {
      bad += 1;
    }
    if (i === nonEmpty.length - 1) {
      const eh = obj['event_hash'];
      if (typeof eh === 'string' && /^sha256:[0-9a-f]{64}$/.test(eh)) {
        tailHash = eh;
      }
      const sq = obj['seq'];
      if (typeof sq === 'number' && Number.isInteger(sq) && sq >= 1) {
        tailSeq = sq;
      }
    }
  }

  const kind: EventsLogKind = classifyKind(v10, v11, bad);
  return ok({
    kind,
    stats: { v10_string_actor: v10, v11_object_actor: v11, unparseable: bad },
    lineCount: nonEmpty.length,
    tailHash,
    tailSeq,
  });
}

function classifyKind(v10: number, v11: number, bad: number): EventsLogKind {
  const totalParseable = v10 + v11;
  if (totalParseable === 0 && bad > 0) return 'unparseable_only';
  if (v10 > 0 && v11 > 0) return 'mixed_v10_v11';
  if (v10 > 0) return 'all_v10';
  // v11 > 0 with no v10. We allow unparseable to coexist (rare crash
  // recovery line) and still report 'all_v11' — the planner's clean-chain
  // check explicitly excludes unparseable > 0 from triggering the friction
  // flag, mirroring rotateEvents's isCleanV11 condition in events-store.ts.
  if (v11 > 0) return 'all_v11';
  // No parseable lines and no unparseable lines reaches here only if the
  // input was empty, which the caller handled before classifyKind ran.
  return 'unparseable_only';
}

// ---------------------------------------------------------------------------
// Spec half-upgrade detection
// ---------------------------------------------------------------------------

export interface SpecYamlInput {
  /** Relative or absolute path; used in the report to point at the file. */
  readonly path: string;
  /** Raw YAML contents. */
  readonly raw: string;
}

export interface V10SpecsScanResult {
  /** True iff at least one input file looks v10-shape. */
  readonly detected: boolean;
  /** Files classified as v10-shape, by path. */
  readonly v10Paths: readonly string[];
  /** Files classified as v11-shape, by path. */
  readonly v11Paths: readonly string[];
  /** Files that could not be classified (parse error or no signal). */
  readonly unclassifiedPaths: readonly string[];
}

/**
 * Minimal v10-vs-v11 spec YAML scanner. Used by the events migrate
 * command to enforce the half-upgrade refusal (A10): if v10-shape spec
 * YAMLs exist alongside v10 events, the operator must either run the
 * specs migration first or explicitly pass --allow-partial-upgrade.
 *
 * Classification heuristic (per the spec's A10 invariant — "the check
 * is mechanical: scan .caws/specs/*.yaml for v10 top-level keys (type,
 * status, acceptance_criteria) and refuse if any are found"):
 *
 *   - v10: file contains any of the top-level keys `type:`, `status:`,
 *     or `acceptance_criteria:` at column 0.
 *   - v11: file contains any of the top-level keys `mode:`,
 *     `lifecycle_state:`, or `acceptance:` at column 0, AND none of
 *     the v10 keys.
 *   - unclassified: no signal in either direction (e.g., empty file,
 *     comment-only file, malformed YAML).
 *
 * This is a regex-level scan, not a full YAML parse. Deliverable 2
 * (CAWS-MIGRATE-V10-SPECS-001) may replace it with detectSpecVersion
 * from packages/caws-kernel/src/spec/migrate-v10.ts when that ships,
 * but the refusal contract owned by this slice (A10) is named here.
 */
export function detectV10SpecsPresent(
  files: readonly SpecYamlInput[]
): V10SpecsScanResult {
  const v10Paths: string[] = [];
  const v11Paths: string[] = [];
  const unclassifiedPaths: string[] = [];

  const V10_KEY = /^(?:type|status|acceptance_criteria):/m;
  const V11_KEY = /^(?:mode|lifecycle_state|acceptance):/m;

  for (const file of files) {
    const hasV10 = V10_KEY.test(file.raw);
    const hasV11 = V11_KEY.test(file.raw);
    if (hasV10) {
      // Any v10 signal wins, even if v11 keys also appear (mixed-shape
      // spec is itself a problem the specs migration owns).
      v10Paths.push(file.path);
    } else if (hasV11) {
      v11Paths.push(file.path);
    } else {
      unclassifiedPaths.push(file.path);
    }
  }

  return {
    detected: v10Paths.length > 0,
    v10Paths,
    v11Paths,
    unclassifiedPaths,
  };
}

// ---------------------------------------------------------------------------
// Rotation plan
// ---------------------------------------------------------------------------

export interface PlanOptions {
  /** Operator-supplied reason. Mirrors rotateEvents's reason field. */
  readonly reason: string;
  /** Pass-through to the rotateEvents allowClean friction flag. */
  readonly allowClean?: boolean;
  /** When true, ignores v10-spec presence and admits rotation anyway. */
  readonly allowPartialUpgrade?: boolean;
  /** Required for archive-name proposal. The shell injects new Date(). */
  readonly now: Date;
  /**
   * Optional v10-spec scan result. When omitted, the planner does NOT
   * fire the half-upgrade refusal — that requires the caller (the shell)
   * to have scanned the specs directory. When present and detected:true
   * AND allowPartialUpgrade !== true, the plan is a refusal.
   */
  readonly v10Specs?: V10SpecsScanResult;
}

/** Why a plan refused, when kind === 'refuse'. */
export type PlanRefusalCause =
  | 'empty'
  | 'unparseable_only'
  | 'clean_chain_requires_allow_clean'
  | 'v10_specs_require_allow_partial_upgrade';

/** Plan to rotate. The shell may invoke rotateEvents with these inputs. */
export interface RotatePlan {
  readonly kind: 'rotate';
  /** Pass-through to rotateEvents. */
  readonly reason: string;
  /** Pass-through to rotateEvents. */
  readonly allowClean: boolean;
  /** Pass-through to rotateEvents. */
  readonly now: Date;
  /** What the proposed archive will be named. Informational; rotateEvents
   *  computes the same name from its own `now` parameter. */
  readonly proposedArchiveName: string;
  /** The detected shape that justified the plan; included so dry-run can
   *  render the full classification next to the rotation summary. */
  readonly detection: EventsLogShape;
  /** v10-spec scan result if the caller provided one; informational. */
  readonly v10Specs?: V10SpecsScanResult;
}

/** Plan to refuse, with a structured cause and the diagnostic the
 *  shell should emit. */
export interface RefusePlan {
  readonly kind: 'refuse';
  readonly cause: PlanRefusalCause;
  readonly diagnostic: Diagnostic;
  /** Detection result that informed the refusal, when applicable. */
  readonly detection?: EventsLogShape;
  /** v10-spec scan result, when the refusal was triggered by it. */
  readonly v10Specs?: V10SpecsScanResult;
}

export type RotationPlan = RotatePlan | RefusePlan;

const ARCHIVE_PREFIX = 'events.jsonl.archive-';

/**
 * Compose a deterministic rotation plan from a previously-detected
 * events-log shape plus operator policy. Pure: no I/O, no clock access
 * (the caller supplies opts.now).
 *
 * The planner is structurally consistent with rotateEvents's refusal
 * logic in events-store.ts — same conditions, same diagnostic rules
 * (sourced from STORE_RULES not from MIGRATION_RULES, so a `rotate
 * --apply` later that goes through rotateEvents will emit the same
 * rule ids). The migration command can therefore present a dry-run
 * plan that exactly mirrors what would happen at apply time.
 *
 * Order of refusal checks (highest precedence first):
 *   1. unparseable_only        — nothing to rotate; the log is corrupt
 *      and the operator must inspect before any archiving.
 *   2. v10_specs_present       — half-upgrade refusal; requires
 *      allowPartialUpgrade.
 *   3. clean_chain (all_v11)   — friction flag; requires allowClean.
 *
 * If all checks pass, returns RotatePlan with the proposed archive
 * name and the inputs the shell will pass to rotateEvents.
 */
export function planEventsRotation(
  detection: EventsLogShape,
  opts: PlanOptions
): RotationPlan {
  // 1. unparseable_only — refuse outright; rotation here would archive
  //    a corrupt chain without operator inspection. The shell points
  //    at the file and asks the operator what to do.
  if (detection.kind === 'unparseable_only') {
    return {
      kind: 'refuse',
      cause: 'unparseable_only',
      diagnostic: diagnostic({
        rule: MIGRATION_RULES.UNPARSEABLE_INPUT,
        authority: 'kernel/diagnostics',
        message: `events.jsonl has no JSON-parseable lines (${detection.stats.unparseable} unparseable, ${detection.lineCount} total). Inspect the file before rotation; manual recovery may be required.`,
      }),
      detection,
    };
  }

  // 2. Half-upgrade refusal. The planner only fires this when the
  //    caller has supplied a v10Specs scan AND detected: true. The
  //    contract is "if you scanned and found v10 specs, the planner
  //    enforces; if you didn't scan, the planner trusts you."
  if (
    opts.v10Specs?.detected === true &&
    opts.allowPartialUpgrade !== true
  ) {
    return {
      kind: 'refuse',
      cause: 'v10_specs_require_allow_partial_upgrade',
      diagnostic: diagnostic({
        rule: MIGRATION_RULES.V10_SPEC_DETECTED,
        authority: 'kernel/diagnostics',
        message: `events migrate --apply refuses: ${opts.v10Specs.v10Paths.length} v10-shape spec(s) detected (${opts.v10Specs.v10Paths.join(', ')}). Run 'caws specs migrate --from v10 --dry-run' first or pass --allow-partial-upgrade.`,
        narrowRepair:
          "Run 'caws specs migrate --from v10' to migrate specs first, then re-run 'caws events migrate --apply'. If you intentionally want the events log to migrate ahead of specs, pass --allow-partial-upgrade.",
      }),
      detection,
      v10Specs: opts.v10Specs,
    };
  }

  // 3. Clean v11 chain friction flag. Mirrors rotateEvents's isCleanV11
  //    check in events-store.ts so dry-run and apply agree.
  const isCleanV11 =
    detection.kind === 'all_v11' &&
    detection.stats.v10_string_actor === 0 &&
    detection.stats.unparseable === 0 &&
    detection.stats.v11_object_actor > 0;
  if (isCleanV11 && opts.allowClean !== true) {
    return {
      kind: 'refuse',
      cause: 'clean_chain_requires_allow_clean',
      diagnostic: diagnostic({
        rule: 'store.events.rotate.clean_chain_requires_allow_clean',
        authority: 'kernel/diagnostics',
        message: `rotateEvents would refuse: prior chain is a clean v11 chain (${detection.stats.v11_object_actor} structured actors); pass allowClean: true (CLI: --allow-clean) to rotate it anyway.`,
        narrowRepair:
          'If you intend to rotate a healthy v11 chain (e.g., for operational reasons unrelated to migration), pass --allow-clean. Otherwise, no rotation is needed.',
      }),
      detection,
    };
  }

  // All checks passed. Compose the rotate plan.
  return {
    kind: 'rotate',
    reason: opts.reason,
    allowClean: opts.allowClean === true,
    now: opts.now,
    proposedArchiveName: `${ARCHIVE_PREFIX}${windowsSafeIso(opts.now)}`,
    detection,
    ...(opts.v10Specs !== undefined ? { v10Specs: opts.v10Specs } : {}),
  };
}

/**
 * Windows-safe ISO timestamp for archive filenames. Replaces both ':'
 * and '.' with '-' so the archive name is filesystem-safe everywhere.
 * Must match events-store.ts windowsSafeIso exactly so the planner's
 * proposedArchiveName matches what rotateEvents will actually use.
 */
function windowsSafeIso(d: Date): string {
  return d.toISOString().replace(/:/g, '-').replace(/\./g, '-');
}
