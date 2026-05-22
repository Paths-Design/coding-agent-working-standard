// `caws worktree` command group — v11 worktree lifecycle commands.
//
// CLI-WORKTREE-001: canonical replacement for hand-edited
// .caws/worktrees.json. Five subcommands:
//   - caws worktree create <name> --spec <id>
//   - caws worktree list
//   - caws worktree bind <name> --spec <id>
//   - caws worktree destroy <name> [--abandon-unmerged]
//   - caws worktree merge <name> [--dry-run]
//
// Discipline:
//   - All mutation paths go through worktrees-writer (which uses the
//     lifecycle-transaction substrate + applyRegistryPatch).
//   - Destroy is non-forceful. There is NO --force. The only override
//     is --abandon-unmerged, which still respects ownership and clean
//     working tree.
//   - Merge auto-closes the bound spec through specs-writer.closeSpec.
//     The shell does not call appendEvent directly.

import * as fs from 'node:fs';
import * as path from 'node:path';

import { type ActorKind, isOk } from '@paths.design/caws-kernel';

import { loadSpecs, resolveRepoRoot, writeFileAtomic } from '../../store';
import {
  type MigrationPlan,
  type RecordOmissionDecision,
  planMigration,
} from '../../store/worktrees-migration';
import {
  bindWorktreeRepair,
  createWorktree,
  destroyWorktree,
  listWorktreesPretty,
  mergeWorktree,
} from '../../store/worktrees-writer';
import { buildActor } from '../session/actor';
import { resolveSession } from '../session/resolve-session';
import { renderDiagnostics } from '../render/diagnostic';

interface BaseCommandOptions {
  readonly cwd?: string;
  readonly now?: () => Date;
  readonly env?: NodeJS.ProcessEnv;
  readonly out?: (line: string) => void;
  readonly err?: (line: string) => void;
  readonly showData?: boolean;
  readonly actorKind?: ActorKind;
}

function setupIO(opts: BaseCommandOptions) {
  const cwd = opts.cwd ?? process.cwd();
  const nowFn = opts.now ?? (() => new Date());
  const env = opts.env ?? process.env;
  const out = opts.out ?? ((s: string) => process.stdout.write(s + '\n'));
  const errFn = opts.err ?? ((s: string) => process.stderr.write(s + '\n'));
  const showData = opts.showData === true;
  return { cwd, nowFn, env, out, err: errFn, showData };
}

function resolveCawsCtx(
  cwd: string,
  errFn: (line: string) => void,
  showData: boolean,
  cmd: string
): { repoRoot: string; cawsDir: string } | null {
  const r = resolveRepoRoot(cwd);
  if (!r.ok) {
    errFn(`caws worktree ${cmd}: failed to resolve repo root.`);
    errFn(renderDiagnostics(r.errors, { showData }));
    return null;
  }
  return { repoRoot: r.value.repoRoot, cawsDir: r.value.cawsDir };
}

function buildActorPair(
  cawsDir: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  nowFn: () => Date,
  actorKind: ActorKind | undefined,
  errFn: (line: string) => void,
  showData: boolean,
  cmd: string
): { session: { session_id: string; platform?: string }; actor: ReturnType<typeof buildActor> } | null {
  const sessionResult = resolveSession({
    cawsDir,
    worktreeRoot: cwd,
    env,
    now: nowFn,
    allowMint: true,
  });
  if (!sessionResult.ok) {
    errFn(`caws worktree ${cmd}: failed to resolve session identity.`);
    errFn(renderDiagnostics(sessionResult.errors, { showData }));
    return null;
  }
  const actor = buildActor({
    session: sessionResult.value,
    kind: actorKind ?? 'agent',
  });
  return {
    session: {
      session_id: sessionResult.value.identity.session_id,
      ...(sessionResult.value.identity.platform !== undefined
        ? { platform: sessionResult.value.identity.platform }
        : {}),
    },
    actor,
  };
}

// ─── caws worktree create ─────────────────────────────────────────────────

export interface WorktreeCreateOptions extends BaseCommandOptions {
  readonly name: string;
  readonly specId: string;
  readonly baseBranch?: string;
  readonly branch?: string;
}

export function runWorktreeCreateCommand(opts: WorktreeCreateOptions): number {
  const { cwd, nowFn, env, out, err, showData } = setupIO(opts);
  const ctx = resolveCawsCtx(cwd, err, showData, 'create');
  if (ctx === null) return 2;
  const id = buildActorPair(ctx.cawsDir, cwd, env, nowFn, opts.actorKind, err, showData, 'create');
  if (id === null) return 2;

  const input: Parameters<typeof createWorktree>[1] = {
    name: opts.name,
    specId: opts.specId,
    session: id.session,
    actor: id.actor,
    now: nowFn,
  };
  if (opts.baseBranch !== undefined)
    (input as { baseBranch?: string }).baseBranch = opts.baseBranch;
  if (opts.branch !== undefined) (input as { branch?: string }).branch = opts.branch;

  const result = createWorktree(ctx.cawsDir, input);
  if (!isOk(result)) {
    err('caws worktree create: failed.');
    err(renderDiagnostics(result.errors, { showData }));
    return 1;
  }
  const outcome = result.value;
  if (outcome.kind === 'partial_failure_recovered') {
    err('caws worktree create: partial failure recovered (no state change).');
    err(renderDiagnostics(outcome.cause, { showData }));
    return 1;
  }
  if (outcome.kind === 'dry_run') {
    err('caws worktree create: unexpected dry_run outcome from createWorktree.');
    return 2;
  }
  const wtPath = outcome.data?.path ?? '';
  out(
    `created ${outcome.name} at ${path.relative(ctx.repoRoot, String(wtPath))} (spec: ${opts.specId})`
  );
  return 0;
}

// ─── caws worktree list ───────────────────────────────────────────────────

export type WorktreeListOptions = BaseCommandOptions;

export function runWorktreeListCommand(opts: WorktreeListOptions = {}): number {
  const { cwd, out, err, showData } = setupIO(opts);
  const ctx = resolveCawsCtx(cwd, err, showData, 'list');
  if (ctx === null) return 2;

  const result = listWorktreesPretty(ctx.cawsDir);
  if (!isOk(result)) {
    err('caws worktree list: failed.');
    err(renderDiagnostics(result.errors, { showData }));
    return 1;
  }
  if (result.value.entries.length === 0) {
    out('(no worktrees registered)');
    return 0;
  }
  for (const entry of result.value.entries) {
    const rel = path.relative(ctx.repoRoot, entry.path);
    const ownerStr = entry.owner ? entry.owner.session_id.slice(0, 8) : 'unowned';
    const specStr = entry.specId ?? '(unbound)';
    out(
      `${entry.name.padEnd(28)} ${entry.branch.padEnd(20)} → ${entry.baseBranch.padEnd(12)} spec=${specStr.padEnd(20)} owner=${ownerStr.padEnd(10)} ${rel}`
    );
  }
  return 0;
}

// ─── caws worktree bind ───────────────────────────────────────────────────

export interface WorktreeBindOptions extends BaseCommandOptions {
  readonly name: string;
  readonly specId: string;
}

export function runWorktreeBindCommand(opts: WorktreeBindOptions): number {
  const { cwd, nowFn, env, out, err, showData } = setupIO(opts);
  const ctx = resolveCawsCtx(cwd, err, showData, 'bind');
  if (ctx === null) return 2;
  const id = buildActorPair(ctx.cawsDir, cwd, env, nowFn, opts.actorKind, err, showData, 'bind');
  if (id === null) return 2;

  const result = bindWorktreeRepair(ctx.cawsDir, {
    name: opts.name,
    specId: opts.specId,
    session: id.session,
    actor: id.actor,
    now: nowFn,
  });
  if (!isOk(result)) {
    err('caws worktree bind: failed.');
    err(renderDiagnostics(result.errors, { showData }));
    return 1;
  }
  const outcome = result.value;
  if (outcome.kind === 'partial_failure_recovered') {
    err('caws worktree bind: partial failure recovered (no state change).');
    err(renderDiagnostics(outcome.cause, { showData }));
    return 1;
  }
  if (outcome.kind === 'dry_run') {
    err('caws worktree bind: unexpected dry_run outcome.');
    return 2;
  }
  out(`bound ${outcome.name} → ${opts.specId}`);
  return 0;
}

// ─── caws worktree destroy ────────────────────────────────────────────────

export interface WorktreeDestroyOptions extends BaseCommandOptions {
  readonly name: string;
  readonly abandonUnmerged?: boolean;
}

export function runWorktreeDestroyCommand(opts: WorktreeDestroyOptions): number {
  const { cwd, nowFn, env, out, err, showData } = setupIO(opts);
  const ctx = resolveCawsCtx(cwd, err, showData, 'destroy');
  if (ctx === null) return 2;
  const id = buildActorPair(ctx.cawsDir, cwd, env, nowFn, opts.actorKind, err, showData, 'destroy');
  if (id === null) return 2;

  const input: Parameters<typeof destroyWorktree>[1] = {
    name: opts.name,
    session: id.session,
    actor: id.actor,
    now: nowFn,
  };
  if (opts.abandonUnmerged === true)
    (input as { abandonUnmerged?: boolean }).abandonUnmerged = true;

  const result = destroyWorktree(ctx.cawsDir, input);
  if (!isOk(result)) {
    err('caws worktree destroy: failed.');
    err(renderDiagnostics(result.errors, { showData }));
    return 1;
  }
  const outcome = result.value;
  if (outcome.kind === 'partial_failure_recovered') {
    err('caws worktree destroy: partial failure recovered (no state change).');
    err(renderDiagnostics(outcome.cause, { showData }));
    return 1;
  }
  if (outcome.kind === 'dry_run') {
    err('caws worktree destroy: unexpected dry_run outcome.');
    return 2;
  }
  out(`destroyed ${outcome.name}`);
  return 0;
}

// ─── caws worktree merge ──────────────────────────────────────────────────

export interface WorktreeMergeOptions extends BaseCommandOptions {
  readonly name: string;
  readonly dryRun?: boolean;
  readonly message?: string;
}

export function runWorktreeMergeCommand(opts: WorktreeMergeOptions): number {
  const { cwd, nowFn, env, out, err, showData } = setupIO(opts);
  const ctx = resolveCawsCtx(cwd, err, showData, 'merge');
  if (ctx === null) return 2;
  const id = buildActorPair(ctx.cawsDir, cwd, env, nowFn, opts.actorKind, err, showData, 'merge');
  if (id === null) return 2;

  const input: Parameters<typeof mergeWorktree>[1] = {
    name: opts.name,
    session: id.session,
    actor: id.actor,
    now: nowFn,
  };
  if (opts.dryRun === true) (input as { dryRun?: boolean }).dryRun = true;
  if (opts.message !== undefined) (input as { message?: string }).message = opts.message;

  const result = mergeWorktree(ctx.cawsDir, input);
  if (!isOk(result)) {
    err('caws worktree merge: failed.');
    err(renderDiagnostics(result.errors, { showData }));
    return 1;
  }
  const outcome = result.value;
  if (outcome.kind === 'partial_failure_recovered') {
    err('caws worktree merge: partial failure recovered (no state change).');
    err(renderDiagnostics(outcome.cause, { showData }));
    return 1;
  }
  if (outcome.kind === 'dry_run') {
    if (outcome.canProceed) {
      out(`caws worktree merge ${outcome.name} --dry-run: ready to merge.`);
    } else {
      err(`caws worktree merge ${outcome.name} --dry-run: NOT ready to merge.`);
      for (const f of outcome.findings) err(`  - ${f}`);
      return 1;
    }
    return 0;
  }
  out(
    `merged ${outcome.name} (merge_commit: ${outcome.data?.merge_commit}; auto_closed_spec: ${outcome.data?.spec_id})`
  );
  return 0;
}

// ─── caws worktree migrate-registry ──────────────────────────────────────
//
// WORKTREE-REGISTRY-LEGACY-ENVELOPE-MIGRATION-001
//
// Convert v10.2 envelope-shaped .caws/worktrees.json into the v11
// flat-map shape. Destroyed records may be omitted iff (a) no spec
// claims their name AND (b) their recorded path does not exist on
// disk; otherwise the migration refuses. Idempotent on already-flat
// files.
//
// Decisions (locked in spec invariants):
//   - No new event kind. Audit trail is the git commit.
//   - Loader (worktrees-store.ts) stays permissive; this command
//     does its own legacy-envelope detection.
//   - Doctor H1 stays unchanged. The H1 finding on subject
//     "worktrees" disappears post-migration because the envelope
//     key no longer exists in the file.
//   - writeFileAtomic provides file-content atomicity (fsync +
//     rename on same filesystem). The migration does NOT claim
//     crash-safety past power loss or parent-directory durability.
//   - A12 spec-load gate: refuse only on the narrow conjunction
//     (specs.length === 0 AND diagnostics contains READ_IO_FAILED).
//     Benign loadSpecs diagnostics do NOT cause refusal.

export interface WorktreeMigrateRegistryOptions extends BaseCommandOptions {
  /** When true, classify and report but do not write. */
  readonly dryRun?: boolean;
}

function formatDecision(d: RecordOmissionDecision): string {
  if (d.omit) {
    return `  - ${d.record.padEnd(28)} status=destroyed  -> omitted (no claiming spec; path absent)`;
  }
  const status = d.status ?? '(no status)';
  if (d.reason === 'non_terminal') {
    return `  - ${d.record.padEnd(28)} status=${status.padEnd(10)} -> preserved`;
  }
  if (d.reason === 'spec_claims') {
    const sid = d.detail.specId ?? '(unknown)';
    return `  - ${d.record.padEnd(28)} status=${status.padEnd(10)} -> BLOCKS: spec ${sid} still claims this worktree name`;
  }
  // path_present
  const p = d.detail.path ?? '(unknown)';
  return `  - ${d.record.padEnd(28)} status=${status.padEnd(10)} -> BLOCKS: recorded path ${p} exists on disk`;
}

function renderPlanReport(
  plan: MigrationPlan,
  worktreesJsonPath: string,
  dryRun: boolean,
  out: (line: string) => void
): void {
  if (plan.kind === 'no_op') {
    if (plan.reason === 'already_flat') {
      out(`${worktreesJsonPath} is already in v11 flat-map shape. No action required.`);
      out(`Record count: ${plan.recordCount}.`);
    } else {
      // empty_object
      out(`${worktreesJsonPath} is an empty object. No action required.`);
    }
    return;
  }
  if (plan.kind === 'apply') {
    out(`Classified ${worktreesJsonPath} as legacy_envelope.`);
    out('Migrating to v11 flat-map shape.');
    out('');
    out(`Nested records: ${plan.inputRecordCount}`);
    for (const d of plan.decisions) {
      out(formatDecision(d));
    }
    out('');
    const byteCount = Buffer.byteLength(plan.outputBytes, 'utf8');
    if (dryRun) {
      out(`[dry-run] Would write ${byteCount} bytes to ${worktreesJsonPath}.`);
      out(`[dry-run] Post-migration record count would be: ${plan.outputRecordCount}.`);
      out('[dry-run] No files written.');
    } else {
      out(`Wrote ${byteCount} bytes to ${worktreesJsonPath}.`);
      out(`Post-migration record count: ${plan.outputRecordCount}.`);
    }
  }
  // refuse: handled separately on stderr
}

function renderPlanData(plan: MigrationPlan, out: (line: string) => void): void {
  // --data: structured JSON dump of the plan for tooling consumers.
  // Shape is the same kind/decisions/counts structure rendered above,
  // but machine-parseable.
  const payload =
    plan.kind === 'no_op'
      ? { kind: plan.kind, reason: plan.reason, ...('recordCount' in plan ? { recordCount: plan.recordCount } : {}) }
      : plan.kind === 'apply'
        ? {
            kind: plan.kind,
            inputRecordCount: plan.inputRecordCount,
            outputRecordCount: plan.outputRecordCount,
            outputByteLength: Buffer.byteLength(plan.outputBytes, 'utf8'),
            decisions: plan.decisions,
          }
        : {
            kind: plan.kind,
            reason: plan.reason,
            diagnostic: plan.diagnostic,
            ...(plan.decisions ? { decisions: plan.decisions } : {}),
          };
  out(JSON.stringify(payload, null, 2));
}

export function runWorktreeMigrateRegistryCommand(
  opts: WorktreeMigrateRegistryOptions
): number {
  const { cwd, out, err, showData } = setupIO(opts);
  const ctx = resolveCawsCtx(cwd, err, showData, 'migrate-registry');
  if (ctx === null) return 2;

  const worktreesJsonPath = path.join(ctx.cawsDir, 'worktrees.json');

  // Read worktrees.json. ENOENT means there is nothing to migrate.
  let fileContents: string;
  try {
    fileContents = fs.readFileSync(worktreesJsonPath, 'utf8');
  } catch (e) {
    const cause = e as { code?: string; message?: string };
    if (cause.code === 'ENOENT') {
      out(`${worktreesJsonPath} does not exist. Nothing to migrate.`);
      return 0;
    }
    err(`caws worktree migrate-registry: failed to read ${worktreesJsonPath}: ${cause.message ?? 'unknown error'}`);
    return 2;
  }

  // Load specs for the destroyed-record policy check.
  // We pass the loadSpecs result through unchanged; planMigration's
  // A12 gate decides whether the load is verifiable.
  const specsResult = loadSpecs(ctx.cawsDir);
  const specs = specsResult.specs.map((s) => ({
    id: s.id,
    ...(s.worktree !== undefined ? { worktree: s.worktree } : {}),
  }));

  const plan = planMigration(
    fileContents,
    specs,
    specsResult.diagnostics,
    (p: string) => fs.existsSync(p)
  );

  const dryRun = opts.dryRun === true;

  // Refusals: stderr + nonzero exit. No write under any refusal path.
  if (plan.kind === 'refuse') {
    err('caws worktree migrate-registry: refused.');
    err(plan.diagnostic.message);
    if (plan.decisions) {
      err('');
      err(`Nested records: ${plan.decisions.length}`);
      for (const d of plan.decisions) {
        err(formatDecision(d));
      }
    }
    if (plan.diagnostic.narrowRepair !== undefined) {
      err('');
      err(plan.diagnostic.narrowRepair);
    }
    err('');
    err('No changes were made.');
    if (showData) {
      renderPlanData(plan, err);
    }
    // read_failed -> 2 (IO/parse error class), everything else -> 1 (policy refusal).
    return plan.reason === 'read_failed' ? 2 : 1;
  }

  // no_op or apply: stdout + zero exit.
  renderPlanReport(plan, worktreesJsonPath, dryRun, out);

  if (plan.kind === 'apply' && !dryRun) {
    const writeResult = writeFileAtomic(worktreesJsonPath, plan.outputBytes);
    if (!isOk(writeResult)) {
      err('caws worktree migrate-registry: failed to write migrated file.');
      err(renderDiagnostics(writeResult.errors, { showData }));
      return 2;
    }
  }

  if (showData) {
    renderPlanData(plan, out);
  }

  return 0;
}
