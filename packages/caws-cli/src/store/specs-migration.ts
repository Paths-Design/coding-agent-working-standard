// CAWS-MIGRATE-V10-SPECS-001 — CLI store layer for the specs migrator.
//
// Boundary:
//   - The transformer (packages/caws-kernel/src/spec/migrate-v10.ts) is pure.
//   - This module owns ALL filesystem I/O: scan, atomic write, durable report,
//     post-write validation.
//   - The shell layer (commit 4) owns flag parsing and rendering.
//
// Doctrine sources:
//   - .caws/specs/CAWS-MIGRATE-V10-SPECS-001.yaml acceptance A8-A11 + contract
//     spec-v10-migration-output.
//   - non_functional.reliability: atomic per-file write; partial failures
//     leave already-written files in v11 form (intentional — no per-batch
//     in-memory rollback for scaling reasons).
//
// What this module does NOT do:
//   - Read any file outside .caws/specs/ and .caws/migrations/.
//   - Write to the events log (migrations are not lifecycle events).
//   - Hold locks (per-file atomic write is sufficient since each spec file
//     is independent).
//   - Touch .caws/specs/.archive/ (active spec migration only — invariant 9).

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import {
  detectSpecVersion,
  err,
  isErr,
  isOk,
  migrateSpecV10,
  ok,
  parseAndValidateSpec,
  parseSpecYaml,
  type Diagnostic,
  type LifecycleMapping,
  type MigrateOutcome,
  type Result,
} from '@paths.design/caws-kernel';
import { writeFileAtomic } from './atomic-write';
import { storeDiagnostic } from './repo-root';
import { STORE_RULES } from './rules';

// --- Public types ---------------------------------------------------------

/**
 * Schema_version 1 of the durable migration report.
 * Stable contract per contract spec-v10-migration-output.
 */
export const MIGRATION_REPORT_SCHEMA_VERSION = 1;

export interface NonYamlObservation {
  readonly file: string;
  readonly kind: 'markdown_sidecar' | 'unknown_non_yaml';
}

export interface ScanEntry {
  /** Path relative to cawsDir, e.g. ".caws/specs/X.yaml". */
  readonly file: string;
  /** Best-effort spec id from the parsed object (null if absent). */
  readonly spec_id: string | null;
  /** sha256 hex of the original YAML bytes. */
  readonly old_digest: string;
  /** Outcome from the kernel transformer. */
  readonly outcome: MigrateOutcome;
  /** Original source bytes — threaded to apply for write + digest reuse. */
  readonly raw: string;
}

export interface ScanReport {
  readonly cawsDir: string;
  readonly entries: ReadonlyArray<ScanEntry>;
  readonly distribution: {
    readonly migrated: number;
    readonly migrated_with_warnings: number;
    readonly refused: number;
    readonly total: number;
  };
  readonly non_yaml: ReadonlyArray<NonYamlObservation>;
  /** Parse errors keyed by file path (does not block scan). */
  readonly parse_errors: ReadonlyArray<{ file: string; diagnostics: ReadonlyArray<Diagnostic> }>;
}

export type ReportVerdict =
  | 'migrated'
  | 'migrated_with_warnings'
  | 'refused'
  | 'post_write_validation_failed';

export interface ReportEntry {
  readonly file: string;
  readonly spec_id: string | null;
  readonly old_digest: string;
  readonly new_digest: string | null;
  readonly verdict: ReportVerdict;
  readonly safe_renames: ReadonlyArray<{ from: string; to: string }>;
  readonly coercions: ReadonlyArray<{ field: string; from: unknown; to: unknown }>;
  readonly mode_source: 'mode' | 'type' | 'unresolvable' | null;
  readonly lifecycle_mapping_used: LifecycleMapping[string] | null;
  readonly report_only_fields: Record<string, unknown>;
  readonly refusal_reasons: ReadonlyArray<string>;
  readonly post_write_validation_errors: ReadonlyArray<Diagnostic>;
}

export interface MigrationReport {
  readonly schema_version: typeof MIGRATION_REPORT_SCHEMA_VERSION;
  readonly generated_at: string;
  readonly command: string;
  readonly cwd: string;
  readonly distribution: ScanReport['distribution'] & {
    readonly post_write_validation_failed: number;
  };
  readonly non_yaml_observations: ReadonlyArray<NonYamlObservation>;
  readonly entries: ReadonlyArray<ReportEntry>;
}

export interface ApplyResult {
  readonly cawsDir: string;
  readonly partial: boolean;
  /** Path of the written report; null on dry-run. */
  readonly report_path: string | null;
  readonly report: MigrationReport;
}

export interface ScanOptions {
  readonly cawsDir: string;
  readonly from: 'v10';
  readonly lifecycleMapping?: LifecycleMapping;
}

export interface ApplyOptions extends ScanOptions {
  readonly apply: boolean;
  readonly partial: boolean;
  readonly now: Date;
}

// --- Scan -----------------------------------------------------------------

/**
 * Read-only scan of .caws/specs/. Classifies each YAML via the kernel
 * detectSpecVersion + migrateSpecV10 pipeline; reports non-YAML files
 * as observations (markdown_sidecar for *.md, unknown_non_yaml for the
 * rest, EXCEPT registry.json which is the CLI's own bookkeeping and is
 * silently ignored).
 *
 * Per A8: explicitly excludes .archive/ if present. Does NOT recurse.
 * The scan is read-only — no files are modified and no events are appended.
 *
 * Failure mode: if the specs directory cannot be listed (permission
 * denied, etc.), returns err with SPECS_MIGRATE_SCAN_FAILED. Refuses
 * rather than returning an empty scan so an apply-default can't masquerade
 * as "no v10 specs found."
 */
export function runSpecsMigrateScan(opts: ScanOptions): Result<ScanReport> {
  // Defensive substrate assertion: cawsDir must point at a `.caws`
  // directory. The store does NOT trust the shell to validate this —
  // any caller (test harness, future SDK, in-process consumer) must
  // pass an absolute path whose basename is exactly `.caws`. A wrong
  // root would cause repo-root-relative paths in the report to be
  // garbage and would cause the report write to land in the wrong
  // .caws/migrations/ directory.
  const cawsDirCheck = assertCawsDirShape(opts.cawsDir);
  if (!isOk(cawsDirCheck)) return cawsDirCheck;

  const specsDir = path.join(opts.cawsDir, 'specs');

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(specsDir, { withFileTypes: true });
  } catch (e) {
    const cause = e as { message?: string; code?: string };
    return err(
      storeDiagnostic(
        STORE_RULES.SPECS_MIGRATE_SCAN_FAILED,
        `Failed to read ${specsDir}: ${cause.message ?? 'unknown error'}.`,
        {
          subject: specsDir,
          data: { code: cause.code },
          narrowRepair:
            'Verify the .caws/specs/ directory exists and is readable. The scan refuses to proceed on a directory it cannot list (so apply-default bypass cannot masquerade as "no v10 specs found").',
        },
      ),
    );
  }

  // Sort for deterministic per-file order in the report.
  entries.sort((a, b) => a.name.localeCompare(b.name));

  const scanEntries: ScanEntry[] = [];
  const nonYaml: NonYamlObservation[] = [];
  const parseErrors: { file: string; diagnostics: ReadonlyArray<Diagnostic> }[] = [];
  let migrated = 0;
  let migratedWithWarnings = 0;
  let refused = 0;

  for (const dirent of entries) {
    // Skip subdirectories (including .archive/).
    if (!dirent.isFile()) continue;

    const fullPath = path.join(specsDir, dirent.name);
    // Path is repo-root-relative (e.g., ".caws/specs/X.yaml"), not
    // cawsDir-relative ("specs/X.yaml"). User-facing diagnostics and
    // report entries reference the path the operator would type at
    // the shell, which is repo-root-relative.
    const repoRoot = path.dirname(opts.cawsDir);
    const relPath = path.relative(repoRoot, fullPath);

    // Non-YAML files: classify and skip.
    if (!dirent.name.endsWith('.yaml') && !dirent.name.endsWith('.yml')) {
      // registry.json is CLI bookkeeping — silently ignore.
      if (dirent.name === 'registry.json') continue;
      const kind: NonYamlObservation['kind'] = dirent.name.endsWith('.md')
        ? 'markdown_sidecar'
        : 'unknown_non_yaml';
      nonYaml.push({ file: relPath, kind });
      continue;
    }

    // Read raw bytes (preserves YAML formatting for digest stability).
    let raw: string;
    try {
      raw = fs.readFileSync(fullPath, 'utf8');
    } catch (e) {
      const cause = e as { message?: string; code?: string };
      parseErrors.push({
        file: relPath,
        diagnostics: [
          storeDiagnostic(
            STORE_RULES.SPECS_MIGRATE_PARSE_FAILED,
            `Failed to read ${relPath}: ${cause.message ?? 'unknown error'}.`,
            { subject: relPath, data: { code: cause.code } },
          ),
        ],
      });
      continue;
    }

    const oldDigest = sha256Hex(raw);

    // Parse the YAML so the transformer has an object input.
    const parseResult = parseSpecYaml(raw, { sourcePath: relPath });
    if (!isOk(parseResult)) {
      parseErrors.push({ file: relPath, diagnostics: parseResult.errors });
      continue;
    }

    // Classification + transform. detectSpecVersion is the pure kernel
    // classifier; the transformer's idempotency guard (A7) refuses
    // already-v11 specs with a structured "no-op" outcome (severity=info).
    const version = detectSpecVersion(parseResult.value);
    if (version === 'v11') {
      // Already v11 — outside this migrator's job. Don't emit as refused;
      // the transformer would emit kind=refused with rule ALREADY_V11
      // (severity=info), but for scan-report distribution counts we
      // exclude already-v11 specs from the totals so the operator's
      // mental model "scan said X refusals" matches "X actionable items".
      continue;
    }

    const migrateResult = migrateSpecV10(
      parseResult.value,
      { path: relPath, contentDigest: oldDigest },
      opts.lifecycleMapping !== undefined
        ? { lifecycleMapping: opts.lifecycleMapping }
        : {},
    );
    if (!isOk(migrateResult)) {
      // Transformer returned err (non-object input, etc.) — record as
      // parse error so the scan stays usable.
      parseErrors.push({ file: relPath, diagnostics: migrateResult.errors });
      continue;
    }

    const outcome = migrateResult.value;
    const specId =
      typeof parseResult.value === 'object' &&
      parseResult.value !== null &&
      'id' in (parseResult.value as Record<string, unknown>) &&
      typeof (parseResult.value as Record<string, unknown>)['id'] === 'string'
        ? ((parseResult.value as Record<string, unknown>)['id'] as string)
        : null;

    scanEntries.push({ file: relPath, spec_id: specId, old_digest: oldDigest, outcome, raw });

    if (outcome.kind === 'migrated') migrated++;
    else if (outcome.kind === 'migrated_with_warnings') migratedWithWarnings++;
    else refused++;
  }

  return ok({
    cawsDir: opts.cawsDir,
    entries: scanEntries,
    distribution: {
      migrated,
      migrated_with_warnings: migratedWithWarnings,
      refused,
      total: scanEntries.length,
    },
    non_yaml: nonYaml,
    parse_errors: parseErrors,
  });
}

// --- Apply ----------------------------------------------------------------

/**
 * Run a scan, then optionally write the migrated YAMLs to disk + a
 * durable migration report.
 *
 * apply=false (dry-run): produces an in-memory MigrationReport but
 *   writes NOTHING to disk (no spec writes, no report file).
 *
 * apply=true, partial=false: refuses if any scan entry is 'refused';
 *   no writes occur. Returns err with SPECS_MIGRATE_REFUSALS_PRESENT
 *   naming the first refused file and count.
 *
 * apply=true, partial=true: writes only the auto-migratable specs.
 *   Each write is preceded by post-write validation via the canonical
 *   parseAndValidateSpec; failure rolls back that single file (the
 *   on-disk YAML is byte-identical to the pre-call state) and records
 *   verdict='post_write_validation_failed' in the report. Other files
 *   in the batch are NOT rolled back (per non_functional reliability).
 *
 * The report is written ATOMICALLY via writeFileAtomic to
 *   .caws/migrations/v10-specs/<ISO>.json, ONCE per apply invocation,
 *   AFTER all per-file decisions are recorded.
 */
export function runSpecsMigrateApply(opts: ApplyOptions): Result<ApplyResult> {
  // --- Scan first --------------------------------------------------------
  const scanResult = runSpecsMigrateScan(opts);
  if (!isOk(scanResult)) {
    return scanResult;
  }
  const scan = scanResult.value;

  // --- A9: refusal-by-default for apply without partial ------------------
  if (opts.apply && !opts.partial && scan.distribution.refused > 0) {
    const firstRefused = scan.entries.find((e) => e.outcome.kind === 'refused');
    return err(
      storeDiagnostic(
        STORE_RULES.SPECS_MIGRATE_REFUSALS_PRESENT,
        `caws specs migrate --apply refused: ${scan.distribution.refused} of ${scan.distribution.total} spec(s) hit a 'refused' verdict (first: ${firstRefused?.file ?? 'unknown'}). Re-run with --partial to write the auto-migratable subset and skip refused, OR with --lifecycle-mapping <path> to unblock the unmapped-lifecycle cluster.`,
        {
          subject: opts.cawsDir,
          data: {
            refused_count: scan.distribution.refused,
            total: scan.distribution.total,
            first_refused: firstRefused?.file ?? null,
          },
          narrowRepair:
            'Either fix the refused specs by hand (read the refusal reasons in the dry-run report), or re-run with --partial to apply the migratable subset, or supply --lifecycle-mapping to resolve the unmapped-lifecycle cluster.',
        },
      ),
    );
  }

  // --- Build per-file report entries -------------------------------------
  const reportEntries: ReportEntry[] = [];
  let postWriteFailed = 0;

  for (const entry of scan.entries) {
    const reportEntry = buildBaseReportEntry(entry);

    // Dry-run or refused: don't attempt the write. The report records
    // the outcome as-is.
    if (!opts.apply || entry.outcome.kind === 'refused') {
      reportEntries.push(reportEntry);
      continue;
    }

    // apply=true && (migrated || migrated_with_warnings):
    // Serialize, post-write-validate, atomic write.
    const serializedSpec =
      entry.outcome.kind === 'migrated'
        ? entry.outcome.value
        : entry.outcome.value;
    let serialized: string;
    try {
      serialized = yaml.dump(serializedSpec, {
        noRefs: true,
        sortKeys: false,
        lineWidth: 100,
      });
    } catch (e) {
      const cause = e as { message?: string };
      reportEntries.push({
        ...reportEntry,
        verdict: 'post_write_validation_failed',
        post_write_validation_errors: [
          storeDiagnostic(
            STORE_RULES.SPECS_MIGRATE_POST_WRITE_VALIDATION_FAILED,
            `Failed to serialize migrated spec to YAML: ${cause.message ?? 'unknown error'}.`,
            { subject: entry.file },
          ),
        ],
      });
      postWriteFailed++;
      continue;
    }

    // Post-write validation: run the canonical parseAndValidateSpec
    // on the serialized output BEFORE the disk write. If validation
    // fails, the file is never written (transformer-bug guard).
    const validationResult = parseAndValidateSpec(serialized, {
      sourcePath: entry.file,
    });
    if (!isOk(validationResult)) {
      reportEntries.push({
        ...reportEntry,
        verdict: 'post_write_validation_failed',
        post_write_validation_errors: validationResult.errors,
      });
      postWriteFailed++;
      continue;
    }

    // Atomic write.
    const fullPath = path.join(opts.cawsDir, '..', entry.file);
    const writeResult = writeFileAtomic(fullPath, serialized);
    if (!isOk(writeResult)) {
      // Write failed — record as post_write_validation_failed (the
      // write didn't happen, so the file is byte-identical to pre-call).
      reportEntries.push({
        ...reportEntry,
        verdict: 'post_write_validation_failed',
        post_write_validation_errors: writeResult.errors,
      });
      postWriteFailed++;
      continue;
    }

    // Success — compute new digest from what we wrote.
    reportEntries.push({
      ...reportEntry,
      new_digest: sha256Hex(serialized),
    });
  }

  // --- Build the report --------------------------------------------------
  const report: MigrationReport = {
    schema_version: MIGRATION_REPORT_SCHEMA_VERSION,
    generated_at: opts.now.toISOString(),
    command: buildCommandString(opts),
    cwd: opts.cawsDir,
    distribution: {
      ...scan.distribution,
      post_write_validation_failed: postWriteFailed,
    },
    non_yaml_observations: scan.non_yaml,
    entries: reportEntries,
  };

  // --- Write the durable report (apply only) ----------------------------
  let reportPath: string | null = null;
  if (opts.apply) {
    const writeRes = writeMigrationReport(opts.cawsDir, report);
    if (!isOk(writeRes)) {
      // Report write failed AFTER spec writes succeeded — surface as
      // err so the caller knows the audit trail is incomplete even
      // though the migrations landed.
      return err(
        storeDiagnostic(
          STORE_RULES.SPECS_MIGRATE_REPORT_WRITE_FAILED,
          `Spec migrations were written to disk, but writing the durable migration report failed: ${writeRes.errors[0]?.message ?? 'unknown error'}. The migrations are on disk; only the audit trail is missing.`,
          {
            subject: opts.cawsDir,
            data: {
              partial: opts.partial,
              spec_write_count: reportEntries.filter(
                (e) => e.verdict === 'migrated' || e.verdict === 'migrated_with_warnings',
              ).length,
            },
            narrowRepair:
              'Investigate the .caws/migrations/v10-specs/ directory permissions. The spec writes themselves cannot be rolled back; treat this as an audit-trail gap and document the migration manually.',
          },
        ),
      );
    }
    reportPath = writeRes.value;
  }

  return ok({
    cawsDir: opts.cawsDir,
    partial: opts.partial,
    report_path: reportPath,
    report,
  });
}

// --- Helpers --------------------------------------------------------------

function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Substrate assertion: cawsDir must be a path whose basename is
 * exactly `.caws`. Refuses with SPECS_MIGRATE_SCAN_FAILED if not,
 * naming the exact path passed and the expected shape.
 *
 * This is intentionally NOT a soft warning — a wrong root corrupts
 * every relative-path computation downstream (report entries, write
 * targets, the migrations-report directory itself). Failing hard at
 * the substrate boundary is the right answer.
 */
function assertCawsDirShape(cawsDir: string): Result<true> {
  if (typeof cawsDir !== 'string' || cawsDir.length === 0) {
    return err(
      storeDiagnostic(
        STORE_RULES.SPECS_MIGRATE_SCAN_FAILED,
        'cawsDir must be a non-empty string path.',
        {
          subject: String(cawsDir),
          narrowRepair:
            'Pass cawsDir as an absolute path whose basename is exactly ".caws" (e.g. "/path/to/repo/.caws").',
        },
      ),
    );
  }
  const base = path.basename(cawsDir);
  if (base !== '.caws') {
    return err(
      storeDiagnostic(
        STORE_RULES.SPECS_MIGRATE_SCAN_FAILED,
        `cawsDir basename must be exactly ".caws"; got "${base}" for path "${cawsDir}".`,
        {
          subject: cawsDir,
          data: { basename: base, expected: '.caws' },
          narrowRepair:
            'Pass cawsDir as the path to the .caws directory itself, not the repo root or a subdirectory. The shell layer (caws specs migrate) should compute this from resolveRepoRoot + path.join(repoRoot, ".caws").',
        },
      ),
    );
  }
  return ok(true);
}

function buildCommandString(opts: ApplyOptions): string {
  const parts = ['caws specs migrate', `--from ${opts.from}`];
  if (opts.apply) parts.push('--apply');
  if (opts.partial) parts.push('--partial');
  if (opts.lifecycleMapping !== undefined) parts.push('--lifecycle-mapping <path>');
  return parts.join(' ');
}

function buildBaseReportEntry(entry: ScanEntry): ReportEntry {
  const o = entry.outcome;
  if (o.kind === 'migrated') {
    return {
      file: entry.file,
      spec_id: entry.spec_id,
      old_digest: entry.old_digest,
      new_digest: null, // populated post-write
      verdict: 'migrated',
      safe_renames: o.safe_renames,
      coercions: o.coercions,
      mode_source: o.mode_source,
      lifecycle_mapping_used: o.lifecycle_mapping_used,
      report_only_fields: o.report_only_fields,
      refusal_reasons: [],
      post_write_validation_errors: [],
    };
  }
  if (o.kind === 'migrated_with_warnings') {
    return {
      file: entry.file,
      spec_id: entry.spec_id,
      old_digest: entry.old_digest,
      new_digest: null,
      verdict: 'migrated_with_warnings',
      safe_renames: o.safe_renames,
      coercions: o.coercions,
      mode_source: o.mode_source,
      lifecycle_mapping_used: o.lifecycle_mapping_used,
      report_only_fields: o.report_only_fields,
      refusal_reasons: [],
      post_write_validation_errors: [],
    };
  }
  // refused
  return {
    file: entry.file,
    spec_id: entry.spec_id,
    old_digest: entry.old_digest,
    new_digest: null,
    verdict: 'refused',
    safe_renames: [],
    coercions: [],
    mode_source: null,
    lifecycle_mapping_used: null,
    report_only_fields: {},
    refusal_reasons: o.reasons.map((r) => r.rule),
    post_write_validation_errors: [],
  };
}

function writeMigrationReport(
  cawsDir: string,
  report: MigrationReport,
): Result<string> {
  // Windows-safe ISO timestamp (colons → hyphens), matching the events
  // archive naming convention.
  const safeStamp = report.generated_at.replace(/:/g, '-');
  const dir = path.join(cawsDir, 'migrations', 'v10-specs');
  const filePath = path.join(dir, `${safeStamp}.json`);

  // Create directory (idempotent).
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    const cause = e as { message?: string; code?: string };
    return err(
      storeDiagnostic(
        STORE_RULES.SPECS_MIGRATE_REPORT_WRITE_FAILED,
        `Failed to create migration report directory ${dir}: ${cause.message ?? 'unknown error'}.`,
        { subject: dir, data: { code: cause.code } },
      ),
    );
  }

  const writeResult = writeFileAtomic(filePath, JSON.stringify(report, null, 2));
  if (!isOk(writeResult)) {
    return err(writeResult.errors);
  }
  return ok(filePath);
}

// --- Unused-import suppression (isErr referenced for clarity in design) ---
void isErr;
