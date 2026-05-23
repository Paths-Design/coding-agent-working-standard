// `caws events migrate | rotate | verify-archive` — the maintenance
// command surface for the v11.2 event-log writer (CAWS-MIGRATE-V10-EVENTS-001
// A10/A11). See docs/architecture/caws-vnext-command-surface.md §6
// invariant 14 + the Maintenance / control-plane subsection.
//
// Three commands, with distinct semantics:
//
//   events migrate  — v10→v11 chain migration. Reads the log, scans
//                     specs (MUST succeed, refuses on scan-unavailable),
//                     runs the planner, prints a dry-run report. With
//                     --apply, invokes rotateEvents iff the plan was
//                     'rotate'. Refuses unparseable_only (migration
//                     cannot claim it found a v10 chain).
//
//   events rotate   — lower-level maintenance rotation. Bypasses the
//                     planner; calls rotateEvents directly. Admits
//                     fully-unparseable logs under prior_chain_status:
//                     'unparseable' (evidence quarantine). Distinct
//                     semantic from migration. --reason is required;
//                     --allow-clean is the friction flag.
//
//   events verify-archive — recompute the archive file's sha256 and
//                     line count, compare against the values committed
//                     in the most recent chain_rotated event. Five
//                     distinguishable failure modes (digest mismatch,
//                     line-count mismatch, missing archive, no rotation
//                     event in chain, current chain unloadable).
//
// All three commands invoke kernel-validated paths. The shell never
// writes events.jsonl directly; rotateEvents (via prepareAppend) is
// the only mutation surface. See invariant 14.

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import {
  diagnostic,
  type Actor,
  type ActorKind,
  type ChainedEvent,
  type Diagnostic,
} from '@paths.design/caws-kernel';

import {
  loadEvents,
  resolveRepoRoot,
  rotateEvents,
  STORE_RULES,
} from '../../store';
import {
  detectEventsLogShape,
  detectV10SpecsPresent,
  MIGRATION_RULES,
  planEventsRotation,
  type SpecYamlInput,
} from '../../store/events-migration';
import { buildActor } from '../session/actor';
import { resolveSession } from '../session/resolve-session';
import { renderDiagnostics } from '../render/diagnostic';

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

interface BaseCommandOptions {
  /** Working directory. Defaults to process.cwd(). */
  readonly cwd?: string;
  /** Injected clock for tests. */
  readonly now?: () => Date;
  /** Injected env for tests. */
  readonly env?: NodeJS.ProcessEnv;
  /** Stdout sink. */
  readonly out?: (line: string) => void;
  /** Stderr sink. */
  readonly err?: (line: string) => void;
  /** Show optional `data` blocks on rendered errors. */
  readonly showData?: boolean;
}

function defaults(opts: BaseCommandOptions): {
  cwd: string;
  now: () => Date;
  env: NodeJS.ProcessEnv;
  out: (line: string) => void;
  err: (line: string) => void;
  showData: boolean;
} {
  return {
    cwd: opts.cwd ?? process.cwd(),
    now: opts.now ?? (() => new Date()),
    env: opts.env ?? process.env,
    out: opts.out ?? ((s: string) => process.stdout.write(s + '\n')),
    err: opts.err ?? ((s: string) => process.stderr.write(s + '\n')),
    showData: opts.showData === true,
  };
}

// ---------------------------------------------------------------------------
// Spec scan — mandatory by default (per A10 + half-upgrade refusal invariant)
// ---------------------------------------------------------------------------
//
// The shell scans .caws/specs/*.yaml at invocation time. If the directory
// is missing, unreadable, or empty-of-yaml-files when at least one v11
// spec should exist (per Status), the shell refuses. Sparse-checkout
// exclusion of .caws/specs/ counts as "missing"; the operator must run
// from a checkout where the spec authority is visible, or the migration
// command cannot enforce the half-upgrade refusal correctly.
//
// Returns either { ok: true, files: SpecYamlInput[] } or a typed
// SPEC_SCAN_UNAVAILABLE diagnostic. The empty-directory case is treated
// as "scan completed, zero v10 specs found" — that's a valid finding,
// not unavailability.

interface SpecScanResult {
  readonly ok: boolean;
  readonly files?: readonly SpecYamlInput[];
  readonly diagnostic?: Diagnostic;
}

function scanSpecsDirectory(cawsDir: string): SpecScanResult {
  const specsDir = path.join(cawsDir, 'specs');
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(specsDir, { withFileTypes: true });
  } catch (e) {
    const cause = e as { code?: string; message?: string };
    return {
      ok: false,
      diagnostic: diagnostic({
        rule: MIGRATION_RULES.SPEC_SCAN_UNAVAILABLE,
        authority: 'kernel/diagnostics',
        message: `caws events migrate: cannot scan .caws/specs/ for v10-shape YAMLs (${cause.code ?? 'unknown error'}: ${cause.message ?? 'no message'}). The half-upgrade refusal cannot be enforced without a complete scan; refusing rather than silently bypassing the guard. Run from a checkout where .caws/specs/ is visible (sparse-checkout exclusion of .caws/specs/ counts as missing).`,
        subject: specsDir,
        data: { code: cause.code },
      }),
    };
  }
  const files: SpecYamlInput[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.yaml') && !entry.name.endsWith('.yml')) continue;
    const fullPath = path.join(specsDir, entry.name);
    let raw: string;
    try {
      raw = fs.readFileSync(fullPath, 'utf8');
    } catch (e) {
      const cause = e as { code?: string; message?: string };
      return {
        ok: false,
        diagnostic: diagnostic({
          rule: MIGRATION_RULES.SPEC_SCAN_UNAVAILABLE,
          authority: 'kernel/diagnostics',
          message: `caws events migrate: failed to read ${entry.name} during spec scan (${cause.code ?? 'unknown error'}). Refusing rather than bypassing the half-upgrade guard.`,
          subject: fullPath,
          data: { code: cause.code },
        }),
      };
    }
    files.push({ path: fullPath, raw });
  }
  return { ok: true, files };
}

// ---------------------------------------------------------------------------
// caws events migrate
// ---------------------------------------------------------------------------

export interface EventsMigrateCommandOptions extends BaseCommandOptions {
  /** Must be 'v10'. Required (Commander enforces). */
  readonly from: 'v10';
  /** Default true (dry-run mode). When false, --apply is in effect. */
  readonly dryRun?: boolean;
  /** Triggers the apply path. Mutually exclusive with dryRun explicitly true. */
  readonly apply?: boolean;
  /** Operator-supplied reason. Required for --apply. */
  readonly reason?: string;
  /** Actor kind for the chain_rotated genesis event. */
  readonly actorKind?: ActorKind;
  /** Actor id override. */
  readonly actorId?: string;
  /** Allow rotation when v10 specs are still present. */
  readonly allowPartialUpgrade?: boolean;
}

/**
 * Pipeline:
 *   1. Resolve repo root + session + actor (apply only needs session;
 *      dry-run reads cleanly without minting a capsule).
 *   2. Read events.jsonl raw bytes.
 *   3. detectEventsLogShape — pure classification.
 *   4. Scan .caws/specs/ — MANDATORY. Refuse on scan-unavailable.
 *   5. planEventsRotation — pure planning. Refuses on
 *      unparseable_only / partial_corruption / v10_specs / clean_chain.
 *   6. Print plan.
 *   7. If --apply AND plan === 'rotate': call rotateEvents. Assert the
 *      returned event_hash + archive_name matches what the planner
 *      proposed. A mismatch is a bug-class internal failure
 *      (INTERNAL_DRYRUN_APPLY_MISMATCH).
 *
 * Exit codes:
 *   0 = dry-run successful OR --apply rotation succeeded
 *   1 = refusal (any planner refusal, spec-scan unavailable, --apply
 *       with no reason, --apply with plan === refuse)
 *   2 = composition failure (repo-root, session, IO failure on read)
 */
export function runEventsMigrateCommand(
  opts: EventsMigrateCommandOptions
): number {
  const { cwd, now, env, out, err, showData } = defaults(opts);
  const isApply = opts.apply === true;
  const isDryRun = !isApply; // default

  if (opts.from !== 'v10') {
    err(`caws events migrate: only --from v10 is supported in v11.2; got ${JSON.stringify(opts.from)}.`);
    return 1;
  }

  if (isApply && (typeof opts.reason !== 'string' || opts.reason.length === 0)) {
    err('caws events migrate --apply: --reason "<text>" is required (the value is recorded verbatim into the chain_rotated payload).');
    return 1;
  }

  // 1. Repo root.
  const rootResult = resolveRepoRoot(cwd);
  if (!rootResult.ok) {
    err('caws events migrate: failed to resolve repo root.');
    err(renderDiagnostics(rootResult.errors, { showData }));
    return 2;
  }
  const { cawsDir } = rootResult.value;

  // 2. Read events.jsonl.
  const eventsPath = path.join(cawsDir, 'events.jsonl');
  let raw: string;
  try {
    raw = fs.readFileSync(eventsPath, 'utf8');
  } catch (e) {
    const cause = e as { code?: string; message?: string };
    if (cause.code === 'ENOENT') {
      err('caws events migrate: events.jsonl does not exist. There is nothing to migrate.');
      err(`(rule: ${MIGRATION_RULES.EMPTY_INPUT})`);
      return 1;
    }
    err(`caws events migrate: failed to read events.jsonl (${cause.code ?? 'unknown error'}): ${cause.message ?? 'no message'}.`);
    return 2;
  }

  // 3. Detect.
  const detection = detectEventsLogShape(raw);
  if (!detection.ok) {
    err('caws events migrate: refuse.');
    err(renderDiagnostics(detection.errors, { showData }));
    return 1;
  }

  // Honor the "events migrate refuses fully-unparseable" semantic. The
  // planner already refuses unparseable_only with UNPARSEABLE_INPUT;
  // we re-route the diagnostic through MIGRATE_UNPARSEABLE_REFUSED so
  // the shell-facing rule reflects the migration-command framing rather
  // than the generic planner rule.
  if (detection.value.kind === 'unparseable_only') {
    err('caws events migrate: refuse — fully-unparseable events.jsonl.');
    err(renderDiagnostics(
      [
        diagnostic({
          rule: MIGRATION_RULES.MIGRATE_UNPARSEABLE_REFUSED,
          authority: 'kernel/diagnostics',
          message: `events.jsonl has no JSON-parseable lines (${detection.value.stats.unparseable} unparseable, ${detection.value.lineCount} total). Migration cannot claim it found a v10 chain. If you want to archive the corrupt log as evidence quarantine, use 'caws events rotate --reason "<text>"' (which admits fully-unparseable logs under the honest 'unparseable' status).`,
          subject: eventsPath,
        }),
      ],
      { showData }
    ));
    return 1;
  }

  // 4. Scan .caws/specs/ — MANDATORY.
  const specScan = scanSpecsDirectory(cawsDir);
  if (!specScan.ok) {
    err('caws events migrate: refuse.');
    err(renderDiagnostics([specScan.diagnostic!], { showData }));
    return 1;
  }
  const v10Specs = detectV10SpecsPresent(specScan.files!);

  // 5. Plan.
  const plan = planEventsRotation(detection.value, {
    reason: opts.reason ?? '',
    now: now(),
    v10Specs,
    ...(opts.allowPartialUpgrade === true ? { allowPartialUpgrade: true } : {}),
    // allowClean is NOT a migrate-mode option; rotate users may use it.
  });

  // 6. Print plan.
  printMigratePlan(plan, isDryRun, out);

  if (plan.kind === 'refuse') {
    err(renderDiagnostics([plan.diagnostic], { showData }));
    return 1;
  }

  if (isDryRun) {
    out(
      `[dry-run] No filesystem changes. Re-run with --apply --reason "<text>" to execute the rotation.`
    );
    return 0;
  }

  // 7. Apply path: resolve session + actor, call rotateEvents.
  const sessionResult = resolveSession({
    cawsDir,
    worktreeRoot: cwd,
    env,
    now,
    allowMint: true,
  });
  if (!sessionResult.ok) {
    err('caws events migrate: failed to resolve session identity.');
    err(renderDiagnostics(sessionResult.errors, { showData }));
    return 2;
  }
  const actor: Actor = buildActor({
    session: sessionResult.value,
    kind: opts.actorKind ?? 'agent',
    ...(opts.actorId !== undefined ? { id: opts.actorId } : {}),
  });

  // For dry-run/apply agreement, capture the plan's proposed archive
  // name now and pass the SAME `now` through to rotateEvents. If the
  // resulting archive name differs from the proposed name, that is a
  // bug-class internal failure (programmer error, not operator).
  const planNow = plan.now;
  const proposedArchive = plan.proposedArchiveName;

  const rotateResult = rotateEvents(cawsDir, {
    reason: opts.reason!,
    actor,
    now: planNow,
    // migrate path never auto-rotates a clean v11 chain — the planner
    // would have refused with clean_chain_requires_allow_clean above.
  });

  if (!rotateResult.ok) {
    err('caws events migrate --apply: rotateEvents failed after dry-run admitted the plan. This indicates state changed between plan and apply (concurrent writer? operator edit?).');
    err(renderDiagnostics(rotateResult.errors, { showData }));
    return 1;
  }

  const event = rotateResult.value;
  const actualArchive = event.data['prior_file_path'];
  if (actualArchive !== proposedArchive) {
    err(`caws events migrate --apply: INTERNAL FAILURE — dry-run proposed archive name "${proposedArchive}" but rotateEvents produced "${actualArchive}". This is a programmer error; investigate windowsSafeIso parity between events-migration.ts and events-store.ts.`);
    err(`(rule: ${MIGRATION_RULES.INTERNAL_DRYRUN_APPLY_MISMATCH})`);
    return 2;
  }

  out(`applied. chain_rotated genesis written.`);
  out(`  seq=${event.seq}`);
  out(`  event_hash=${event.event_hash}`);
  out(`  archive=${actualArchive}`);
  return 0;
}

function printMigratePlan(
  plan: ReturnType<typeof planEventsRotation>,
  isDryRun: boolean,
  out: (line: string) => void
): void {
  const tag = isDryRun ? '[dry-run]' : '[apply]';
  if (plan.kind === 'refuse') {
    out(`${tag} plan: refuse (${plan.cause})`);
    if (plan.detection) {
      out(`  detection: ${plan.detection.kind}, ${plan.detection.lineCount} lines`);
      out(`    v10_string_actor=${plan.detection.stats.v10_string_actor}, v11_object_actor=${plan.detection.stats.v11_object_actor}, unparseable=${plan.detection.stats.unparseable}`);
    }
    if (plan.v10Specs) {
      out(`  v10 specs: ${plan.v10Specs.v10Paths.length} detected (${plan.v10Specs.v10Paths.join(', ')})`);
    }
    return;
  }
  out(`${tag} plan: rotate`);
  out(`  detection: ${plan.detection.kind}, ${plan.detection.lineCount} lines`);
  out(`    v10_string_actor=${plan.detection.stats.v10_string_actor}, v11_object_actor=${plan.detection.stats.v11_object_actor}, unparseable=${plan.detection.stats.unparseable}`);
  out(`  proposed archive: ${plan.proposedArchiveName}`);
  if (plan.v10Specs) {
    out(`  v10 specs scan: ${plan.v10Specs.v10Paths.length} v10, ${plan.v10Specs.v11Paths.length} v11, ${plan.v10Specs.unclassifiedPaths.length} unclassified`);
  }
  if (plan.allowClean) {
    out(`  flags: --allow-clean`);
  }
}

// ---------------------------------------------------------------------------
// caws events rotate
// ---------------------------------------------------------------------------

export interface EventsRotateCommandOptions extends BaseCommandOptions {
  /** Required — recorded verbatim into the chain_rotated payload. */
  readonly reason: string;
  /** Actor kind for the chain_rotated genesis event. */
  readonly actorKind?: ActorKind;
  /** Actor id override. */
  readonly actorId?: string;
  /** Friction flag: allow rotation against a clean v11 chain. */
  readonly allowClean?: boolean;
}

/**
 * Lower-level maintenance rotation. Bypasses the migration planner;
 * calls rotateEvents directly. Admits fully-unparseable logs (under
 * prior_chain_status: 'unparseable', the honest label) for evidence-
 * quarantine use cases. Does NOT scan .caws/specs/ — that's a
 * migrate-mode concern.
 *
 * Required: --reason. Friction flag: --allow-clean.
 *
 * Exit codes:
 *   0 = rotation succeeded
 *   1 = rotateEvents refused (empty, partial_corruption, clean-chain
 *       without --allow-clean) OR --reason missing
 *   2 = composition failure (repo-root, session)
 */
export function runEventsRotateCommand(
  opts: EventsRotateCommandOptions
): number {
  const { cwd, now, env, out, err, showData } = defaults(opts);

  if (typeof opts.reason !== 'string' || opts.reason.length === 0) {
    err('caws events rotate: --reason "<text>" is required (recorded verbatim into the chain_rotated payload).');
    return 1;
  }

  const rootResult = resolveRepoRoot(cwd);
  if (!rootResult.ok) {
    err('caws events rotate: failed to resolve repo root.');
    err(renderDiagnostics(rootResult.errors, { showData }));
    return 2;
  }
  const { cawsDir } = rootResult.value;

  const sessionResult = resolveSession({
    cawsDir,
    worktreeRoot: cwd,
    env,
    now,
    allowMint: true,
  });
  if (!sessionResult.ok) {
    err('caws events rotate: failed to resolve session identity.');
    err(renderDiagnostics(sessionResult.errors, { showData }));
    return 2;
  }
  const actor: Actor = buildActor({
    session: sessionResult.value,
    kind: opts.actorKind ?? 'agent',
    ...(opts.actorId !== undefined ? { id: opts.actorId } : {}),
  });

  const rotateResult = rotateEvents(cawsDir, {
    reason: opts.reason,
    actor,
    now: now(),
    ...(opts.allowClean === true ? { allowClean: true } : {}),
  });
  if (!rotateResult.ok) {
    err('caws events rotate: refuse.');
    err(renderDiagnostics(rotateResult.errors, { showData }));
    return 1;
  }

  const event = rotateResult.value;
  out(`rotated. chain_rotated genesis written.`);
  out(`  seq=${event.seq}`);
  out(`  event_hash=${event.event_hash}`);
  out(`  archive=${event.data['prior_file_path']}`);
  out(`  prior_chain_status=${event.data['prior_chain_status']}`);
  out(`  prior_line_count=${event.data['prior_line_count']}`);
  return 0;
}

// ---------------------------------------------------------------------------
// caws events verify-archive
// ---------------------------------------------------------------------------

export interface EventsVerifyArchiveCommandOptions extends BaseCommandOptions {
  // No operator-facing options. Reads the most recent chain_rotated
  // event from .caws/events.jsonl, recomputes the archive file's
  // sha256 + line count, asserts both match the committed payload.
}

/**
 * Pipeline:
 *   1. resolveRepoRoot
 *   2. loadEvents — if the load itself fails (malformed JSON, bad
 *      chain shape), surface VERIFY_CURRENT_CHAIN_INVALID.
 *   3. Find the most recent event with event === 'chain_rotated'. If
 *      none, surface VERIFY_NO_ROTATION_EVENT.
 *   4. Stat the archive file named in prior_file_path. If missing,
 *      surface VERIFY_ARCHIVE_MISSING.
 *   5. Recompute sha256 + line count of the archive file. Compare
 *      against prior_file_digest and prior_line_count.
 *      - digest mismatch → EVENTS_ARCHIVE_DIGEST_MISMATCH
 *      - line-count mismatch → EVENTS_ARCHIVE_LINE_COUNT_MISMATCH
 *   6. If both match, print verification summary.
 *
 * Each of the five failure modes is a distinct exit-1 diagnostic, so
 * operators and tooling can discriminate without parsing message text.
 *
 * Exit codes:
 *   0 = verification succeeded
 *   1 = any verification failure (one of the 5 modes)
 *   2 = composition failure
 */
export function runEventsVerifyArchiveCommand(
  opts: EventsVerifyArchiveCommandOptions
): number {
  const { cwd, out, err, showData } = defaults(opts);

  const rootResult = resolveRepoRoot(cwd);
  if (!rootResult.ok) {
    err('caws events verify-archive: failed to resolve repo root.');
    err(renderDiagnostics(rootResult.errors, { showData }));
    return 2;
  }
  const { cawsDir } = rootResult.value;

  // 2. Load events. If the current chain itself can't be parsed/validated,
  //    we cannot identify the most recent chain_rotated.
  const loaded = loadEvents(cawsDir);
  if (!loaded.ok) {
    err('caws events verify-archive: cannot load current events.jsonl; verification depends on locating the most recent chain_rotated event.');
    err(renderDiagnostics(
      [
        diagnostic({
          rule: MIGRATION_RULES.VERIFY_CURRENT_CHAIN_INVALID,
          authority: 'kernel/diagnostics',
          message: `events.jsonl could not be loaded as a valid hash-chained log. The underlying store diagnostics follow.`,
          subject: path.join(cawsDir, 'events.jsonl'),
        }),
        ...loaded.errors,
      ],
      { showData }
    ));
    return 1;
  }

  // 3. Walk events backward to find the most recent chain_rotated.
  let mostRecentRotation: ChainedEvent | null = null;
  for (let i = loaded.value.events.length - 1; i >= 0; i--) {
    if (loaded.value.events[i]!.event === 'chain_rotated') {
      mostRecentRotation = loaded.value.events[i]!;
      break;
    }
  }
  if (mostRecentRotation === null) {
    err('caws events verify-archive: no chain_rotated event found in current events.jsonl. Nothing to verify against.');
    err(renderDiagnostics(
      [
        diagnostic({
          rule: MIGRATION_RULES.VERIFY_NO_ROTATION_EVENT,
          authority: 'kernel/diagnostics',
          message: `The current events.jsonl chain contains ${loaded.value.events.length} event(s) but no chain_rotated event. verify-archive needs at least one rotation event to know what to verify.`,
        }),
      ],
      { showData }
    ));
    return 1;
  }

  // 4. Locate the archive.
  const archiveName = mostRecentRotation.data['prior_file_path'] as string;
  const expectedDigest = mostRecentRotation.data['prior_file_digest'] as string;
  const expectedLineCount = mostRecentRotation.data['prior_line_count'] as number;
  const archivePath = path.join(cawsDir, archiveName);

  if (!fs.existsSync(archivePath)) {
    err('caws events verify-archive: archive file is missing.');
    err(renderDiagnostics(
      [
        diagnostic({
          rule: MIGRATION_RULES.VERIFY_ARCHIVE_MISSING,
          authority: 'kernel/diagnostics',
          message: `Archive file ${archiveName} (named by chain_rotated event seq=${mostRecentRotation.seq}) does not exist at ${archivePath}.`,
          subject: archivePath,
        }),
      ],
      { showData }
    ));
    return 1;
  }

  // 5. Recompute sha256 + line count and compare.
  const archiveBytes = fs.readFileSync(archivePath);
  const actualDigest = `sha256:${crypto.createHash('sha256').update(archiveBytes).digest('hex')}`;
  const actualLineCount = countNonEmptyLines(archiveBytes.toString('utf8'));

  if (actualDigest !== expectedDigest) {
    err('caws events verify-archive: archive digest mismatch (tamper detection).');
    err(renderDiagnostics(
      [
        diagnostic({
          rule: STORE_RULES.EVENTS_ARCHIVE_DIGEST_MISMATCH,
          authority: 'kernel/diagnostics',
          message: `Archive ${archiveName} sha256 does not match the chain_rotated committed digest. Expected ${expectedDigest}, got ${actualDigest}. The archive may have been edited after rotation.`,
          subject: archivePath,
          data: { expected: expectedDigest, actual: actualDigest },
        }),
      ],
      { showData }
    ));
    return 1;
  }

  if (actualLineCount !== expectedLineCount) {
    err('caws events verify-archive: archive line-count mismatch.');
    err(renderDiagnostics(
      [
        diagnostic({
          rule: STORE_RULES.EVENTS_ARCHIVE_LINE_COUNT_MISMATCH,
          authority: 'kernel/diagnostics',
          message: `Archive ${archiveName} non-empty line count does not match the chain_rotated committed count. Expected ${expectedLineCount}, got ${actualLineCount}.`,
          subject: archivePath,
          data: { expected: expectedLineCount, actual: actualLineCount },
        }),
      ],
      { showData }
    ));
    return 1;
  }

  out(`verified. archive matches chain_rotated payload.`);
  out(`  archive: ${archiveName}`);
  out(`  sha256: ${actualDigest}`);
  out(`  lines: ${actualLineCount}`);
  out(`  rotation event seq: ${mostRecentRotation.seq}`);
  return 0;
}

function countNonEmptyLines(raw: string): number {
  if (raw.length === 0) return 0;
  const trailingNewline = raw.endsWith('\n');
  const parts = raw.split('\n');
  const lines = trailingNewline ? parts.slice(0, -1) : parts;
  return lines.filter((l) => l.length > 0).length;
}
