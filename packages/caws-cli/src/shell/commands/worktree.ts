// `caws worktree` command group — v11 worktree lifecycle commands.
//
// CLI-WORKTREE-001: canonical replacement for hand-edited
// .caws/worktrees.json. Five subcommands:
//   - caws worktree create <name> --spec <id>
//   - caws worktree list
//   - caws worktree bind <name> --spec <id>
//   - caws worktree destroy <name> [--abandon-unmerged|--force]
//   - caws worktree untrack <name> --reason <why> [--apply]
//   - caws worktree merge <name> [--dry-run]
//
// Discipline:
//   - All mutation paths go through worktrees-writer (which uses the
//     lifecycle-transaction substrate + applyRegistryPatch).
//   - Destroy is non-forceful. --force is a compatibility alias for
//     --abandon-unmerged only; both still respect ownership and clean
//     working tree.
//   - Merge auto-closes the bound spec through specs-writer.closeSpec.
//     The shell does not call appendEvent directly.

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  type ActorKind,
  type DoctorFinding,
  DOCTOR_RULES,
  inspectProjectState,
  isOk,
  type Spec,
  type WorktreeRecord,
} from '@paths.design/caws-kernel';

import { loadSpecs, loadWorktrees, resolveRepoRoot, writeFileAtomic } from '../../store';
import { composeDoctorSnapshot } from '../../store/doctor-snapshot';
import { configureWorktreeSparseCheckout } from '../../store/git-sparse-checkout';
import type {
  WorktreeArtifactLinkStatus,
  WorktreeArtifactLinkSummary,
} from '../../store/worktree-artifacts';
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
  pruneWorktree,
  untrackWorktree,
} from '../../store/worktrees-writer';
import { clearSpecBinding } from '../../store/specs-writer';
import { buildActor } from '../session/actor';
import { admitsOwner, resolveSession, resolveSessionCandidates } from '../session/resolve-session';
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

/**
 * Surface a non-landed audit commit for a worktree lifecycle transition.
 * The transition succeeded (worktrees.json / spec binding is updated in
 * the working tree), but the automatic audit commit did NOT land. The
 * command MUST NOT report bare success while leaving the registry change
 * uncommitted — the next session would inherit ambiguous control-plane
 * state. Emits the warning on stderr only; does NOT change the command's
 * exit code — the worktree OPERATION succeeded, and whether the audit
 * COMMIT landed is surfaced loudly but never turned into a command
 * failure. (CAWS-AUTOCOMMIT-INTEGRITY-001 surfaced it;
 * CAWS-AUTOCOMMIT-INTEGRITY-002 corrected the exit-code policy.)
 */
function surfaceAuditCommit(
  auditCommit: unknown,
  err: (s: string) => void
): void {
  const ac =
    auditCommit !== null && typeof auditCommit === 'object'
      ? (auditCommit as { kind?: unknown; reason?: unknown })
      : undefined;
  if (ac !== undefined && ac.kind === 'refused_dirty') {
    err('caws worktree: the transition was applied but NOT committed.');
    if (typeof ac.reason === 'string' && ac.reason.length > 0) {
      err(`  reason: ${ac.reason}`);
    }
    err(
      '  The control-plane change is in your working tree but the audit ' +
        'commit did not land. Commit it manually, then verify with git log.'
    );
  }
}

function surfaceArtifactLinks(
  summary: unknown,
  out: (s: string) => void
): void {
  const artifactSummary = coerceArtifactSummary(summary);
  out('Artifacts:');
  if (artifactSummary === undefined || artifactSummary.statuses.length === 0) {
    out('  no recognized dependency/cache artifacts were linked.');
    out('  If tests report missing dependencies, install them inside the worktree before retrying.');
    return;
  }

  for (const item of artifactSummary.statuses) {
    out(`  ${formatArtifactStatus(item)}`);
    if (item.unlinkCommand !== undefined) out(`    unlink: ${item.unlinkCommand}`);
    if (requiresInstall(item)) out(`    install: ${item.installHint}`);
  }
}

function coerceArtifactSummary(value: unknown): WorktreeArtifactLinkSummary | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const maybe = value as { statuses?: unknown };
  if (!Array.isArray(maybe.statuses)) return undefined;
  return {
    statuses: maybe.statuses.filter(isArtifactStatus),
  };
}

function isArtifactStatus(value: unknown): value is WorktreeArtifactLinkStatus {
  if (value === null || typeof value !== 'object') return false;
  const maybe = value as { path?: unknown; kind?: unknown; state?: unknown; installHint?: unknown };
  return (
    typeof maybe.path === 'string' &&
    typeof maybe.kind === 'string' &&
    typeof maybe.state === 'string' &&
    typeof maybe.installHint === 'string'
  );
}

function formatArtifactStatus(item: WorktreeArtifactLinkStatus): string {
  if (item.state === 'linked') {
    return `linked ${item.path} -> ${item.linkTarget ?? item.source ?? '(target unknown)'}`;
  }
  if (item.state === 'already_linked') {
    return `already linked ${item.path} -> ${item.linkTarget ?? item.source ?? '(target unknown)'}`;
  }
  const reason = item.reason !== undefined ? `: ${item.reason}` : '';
  return `${item.state.replace(/_/g, ' ')} ${item.path}${reason}`;
}

function requiresInstall(item: WorktreeArtifactLinkStatus): boolean {
  return (
    item.state === 'missing_target' ||
    item.state === 'lock_mismatch' ||
    item.state === 'link_failed' ||
    item.state === 'skipped_not_ignored'
  );
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
  const relWtPath = path.relative(ctx.repoRoot, String(wtPath));
  out(`created ${outcome.name} at ${relWtPath} (spec: ${opts.specId})`);
  // CAWS-FIRST-CONTACT-UX-001 A3: tell the user where to work next.
  // Without this hint, users continue editing in the canonical checkout
  // and trigger union-mode scope behavior they can't explain.
  out(`Next: cd ${relWtPath} to start working in the bound worktree.`);
  surfaceArtifactLinks(outcome.data?.artifact_links, out);
  surfaceAuditCommit(outcome.data?.audit_commit, err);
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
  /** Forced ownership steal (WORKTREE-ISOLATION-HARDENING-001 Fix 4). */
  readonly steal?: boolean;
  readonly reason?: string;
}

export function runWorktreeBindCommand(opts: WorktreeBindOptions): number {
  const { cwd, nowFn, env, out, err, showData } = setupIO(opts);
  const ctx = resolveCawsCtx(cwd, err, showData, 'bind');
  if (ctx === null) return 2;
  const id = buildActorPair(ctx.cawsDir, cwd, env, nowFn, opts.actorKind, err, showData, 'bind');
  if (id === null) return 2;

  // Ownership-comparison surface for the foreign-owner guard (Fix 4) — the same
  // exhaustive candidate set destroy/merge build. Distinct from id.session
  // (single-identity event actor).
  const sessionCandidates = resolveSessionCandidates({ cawsDir: ctx.cawsDir, env });

  const result = bindWorktreeRepair(ctx.cawsDir, {
    name: opts.name,
    specId: opts.specId,
    session: id.session,
    sessionCandidates,
    actor: id.actor,
    now: nowFn,
    ...(opts.steal === true ? { steal: true } : {}),
    ...(opts.reason !== undefined ? { stealReason: opts.reason } : {}),
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
  if (opts.steal === true) {
    out(`bound ${outcome.name} → ${opts.specId} (ownership SEIZED — worktree_ownership_seized event appended)`);
  } else {
    out(`bound ${outcome.name} → ${opts.specId}`);
  }
  surfaceAuditCommit(outcome.data?.audit_commit, err);
  return 0;
}

// ─── caws worktree destroy ────────────────────────────────────────────────

export interface WorktreeDestroyOptions extends BaseCommandOptions {
  readonly name: string;
  readonly abandonUnmerged?: boolean;
  readonly force?: boolean;
}

export function runWorktreeDestroyCommand(opts: WorktreeDestroyOptions): number {
  const { cwd, nowFn, env, out, err, showData } = setupIO(opts);
  const ctx = resolveCawsCtx(cwd, err, showData, 'destroy');
  if (ctx === null) return 2;
  const id = buildActorPair(ctx.cawsDir, cwd, env, nowFn, opts.actorKind, err, showData, 'destroy');
  if (id === null) return 2;

  // Ownership-comparison surface: build the exhaustive candidate set
  // (across all capsules + env sources) for the writer's admission test.
  // Distinct from `id.session` (single-identity actor for the event).
  // See CAWS-WORKTREE-DESTROY-SESSION-RESOLUTION-001.
  const sessionCandidates = resolveSessionCandidates({
    cawsDir: ctx.cawsDir,
    env,
  });

  const input: Parameters<typeof destroyWorktree>[1] = {
    name: opts.name,
    session: id.session,
    sessionCandidates,
    actor: id.actor,
    now: nowFn,
  };
  if (opts.abandonUnmerged === true || opts.force === true)
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
  surfaceAuditCommit(outcome.data?.audit_commit, err);
  return 0;
}

// ─── caws worktree untrack ────────────────────────────────────────────────

export interface WorktreeUntrackOptions extends BaseCommandOptions {
  readonly name: string;
  readonly reason?: string;
  readonly apply?: boolean;
  readonly json?: boolean;
}

export function runWorktreeUntrackCommand(opts: WorktreeUntrackOptions): number {
  const { cwd, nowFn, env, out, err, showData } = setupIO(opts);
  const ctx = resolveCawsCtx(cwd, err, showData, 'untrack');
  if (ctx === null) return 2;

  const reason = (opts.reason ?? '').trim();
  if (reason.length === 0) {
    err('caws worktree untrack: --reason is required and must be non-empty.');
    return 1;
  }

  const id = buildActorPair(ctx.cawsDir, cwd, env, nowFn, opts.actorKind, err, showData, 'untrack');
  if (id === null) return 2;
  const sessionCandidates = resolveSessionCandidates({ cawsDir: ctx.cawsDir, env });

  const result = untrackWorktree(ctx.cawsDir, {
    name: opts.name,
    reason,
    session: id.session,
    sessionCandidates,
    actor: id.actor,
    now: nowFn,
    dryRun: opts.apply !== true,
  });

  if (!isOk(result)) {
    err('caws worktree untrack: failed.');
    err(renderDiagnostics(result.errors, { showData }));
    return 1;
  }

  const outcome = result.value;
  if (outcome.kind === 'partial_failure_recovered') {
    err('caws worktree untrack: partial failure recovered (no state change).');
    err(renderDiagnostics(outcome.cause, { showData }));
    return 1;
  }

  if (outcome.kind === 'dry_run') {
    if (opts.json === true) {
      out(JSON.stringify({
        ok: true,
        dry_run: true,
        read_only: true,
        name: outcome.name,
        reason,
        findings: outcome.findings,
      }, null, 2));
    } else {
      out(`caws worktree untrack ${outcome.name}: dry-run plan`);
      for (const finding of outcome.findings) out(`- ${finding}`);
      out('To apply: rerun with --apply.');
    }
    return outcome.canProceed ? 0 : 1;
  }

  if (opts.json === true) {
    out(JSON.stringify({
      ok: true,
      dry_run: false,
      read_only: false,
      name: outcome.name,
      action: outcome.action,
      data: outcome.data ?? {},
    }, null, 2));
  } else {
    out(`untracked ${outcome.name} (physical directory preserved)`);
  }
  surfaceAuditCommit(outcome.data?.audit_commit, err);
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

  // See destroy: ownership-comparison surface needs the exhaustive
  // candidate set, distinct from the single-identity actor.
  const sessionCandidates = resolveSessionCandidates({
    cawsDir: ctx.cawsDir,
    env,
  });

  const input: Parameters<typeof mergeWorktree>[1] = {
    name: opts.name,
    session: id.session,
    sessionCandidates,
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
      if (showData === true && outcome.data !== undefined) {
        out(JSON.stringify(outcome.data, null, 2));
      }
    } else {
      err(`caws worktree merge ${outcome.name} --dry-run: NOT ready to merge.`);
      for (const f of outcome.findings) err(`  - ${f}`);
      if (showData === true && outcome.data !== undefined) {
        err(JSON.stringify(outcome.data, null, 2));
      }
      return 1;
    }
    return 0;
  }
  out(
    `merged ${outcome.name} (merge_commit: ${outcome.data?.merge_commit}; auto_closed_spec: ${outcome.data?.spec_id})`
  );
  surfaceAuditCommit(outcome.data?.audit_commit, err);
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

// ─── caws worktree cleanup-plan ───────────────────────────────────────────

export type WorktreePhysicalCleanupStateClass =
  | 'destroy-ready'
  | 'unbound-clean-candidate'
  | 'dirty-refused'
  | 'unmerged-refused'
  | 'active-bound-refused'
  | 'foreign-owned-refused'
  | 'missing-directory-refused'
  | 'not-git-worktree-refused'
  | 'unknown-spec-refused'
  | 'unregistered-physical-refused'
  | 'git-observation-unavailable';

export interface WorktreePhysicalCleanupPlanItem {
  readonly subject: string;
  readonly state_class: WorktreePhysicalCleanupStateClass;
  readonly registered: boolean;
  readonly path: string;
  readonly spec_id?: string;
  readonly lifecycle_state?: string;
  readonly owner_session_id?: string;
  readonly branch?: string;
  readonly base_branch?: string;
  readonly clean?: boolean;
  readonly merged?: boolean;
  readonly allowed_mutation: string | null;
  readonly refusal_reason?: string;
  readonly next_command: string;
  readonly details: Record<string, unknown>;
}

export interface WorktreePhysicalCleanupOptions extends BaseCommandOptions {
  readonly state?: readonly string[];
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  readonly apply?: boolean;
  readonly json?: boolean;
}

type WorktreePhysicalCleanupApplyOutcome =
  | {
      readonly subject: string;
      readonly state_class: WorktreePhysicalCleanupStateClass;
      readonly action: 'applied';
      readonly mutation: string;
    }
  | {
      readonly subject: string;
      readonly state_class: WorktreePhysicalCleanupStateClass;
      readonly action: 'refused';
      readonly reason: string;
    }
  | {
      readonly subject: string;
      readonly state_class: WorktreePhysicalCleanupStateClass;
      readonly action: 'failed';
      readonly reason: string;
    };

interface PhysicalGitWorktree {
  readonly path: string;
  readonly branch?: string;
}

const WORKTREE_PHYSICAL_CLEANUP_STATES: readonly WorktreePhysicalCleanupStateClass[] = [
  'destroy-ready',
  'unbound-clean-candidate',
  'dirty-refused',
  'unmerged-refused',
  'active-bound-refused',
  'foreign-owned-refused',
  'missing-directory-refused',
  'not-git-worktree-refused',
  'unknown-spec-refused',
  'unregistered-physical-refused',
  'git-observation-unavailable',
] as const;

function defaultWorktreePath(cawsDir: string, name: string): string {
  return path.join(cawsDir, 'worktrees', name);
}

function gitOutput(cwd: string, args: readonly string[]): { ok: true; stdout: string } | { ok: false; reason: string } {
  try {
    const stdout = execFileSync('git', [...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString();
    return { ok: true, stdout };
  } catch (e) {
    const cause = e as { message?: string; stderr?: Buffer | string };
    const stderr =
      cause.stderr instanceof Buffer
        ? cause.stderr.toString()
        : typeof cause.stderr === 'string'
          ? cause.stderr
          : (cause.message ?? 'unknown git error');
    return { ok: false, reason: stderr.trim() };
  }
}

function listPhysicalGitWorktrees(repoRoot: string): { ok: true; worktrees: readonly PhysicalGitWorktree[] } | { ok: false; reason: string } {
  const out = gitOutput(repoRoot, ['worktree', 'list', '--porcelain']);
  if (!out.ok) return { ok: false, reason: out.reason };

  const worktrees: PhysicalGitWorktree[] = [];
  let currentPath: string | undefined;
  let currentBranch: string | undefined;
  const flush = () => {
    if (currentPath !== undefined) {
      worktrees.push({
        path: currentPath,
        ...(currentBranch !== undefined ? { branch: currentBranch } : {}),
      });
    }
    currentPath = undefined;
    currentBranch = undefined;
  };

  for (const line of out.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      flush();
      currentPath = line.slice('worktree '.length).trim();
    } else if (line.startsWith('branch ')) {
      currentBranch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
    }
  }
  flush();
  return { ok: true, worktrees };
}

function isCleanWorktree(worktreePath: string): { ok: true; clean: boolean; output: string } | { ok: false; reason: string } {
  const status = gitOutput(worktreePath, ['status', '--porcelain']);
  if (!status.ok) return { ok: false, reason: status.reason };
  return { ok: true, clean: status.stdout.trim().length === 0, output: status.stdout };
}

function isMerged(repoRoot: string, branch: string, baseBranch: string): { ok: true; merged: boolean } | { ok: false; reason: string } {
  const branchCheck = gitOutput(repoRoot, ['rev-parse', '--verify', branch]);
  if (!branchCheck.ok) return { ok: false, reason: branchCheck.reason };
  const baseCheck = gitOutput(repoRoot, ['rev-parse', '--verify', baseBranch]);
  if (!baseCheck.ok) return { ok: false, reason: baseCheck.reason };
  const merged = gitOutput(repoRoot, ['merge-base', '--is-ancestor', branch, baseBranch]);
  return { ok: true, merged: merged.ok };
}

function specLifecycle(specs: readonly Spec[], specId: string | undefined): string | undefined {
  if (specId === undefined) return undefined;
  return specs.find((spec) => spec.id === specId)?.lifecycle_state;
}

function physicalItem(
  input: {
    readonly name: string;
    readonly entry: WorktreeRecord;
    readonly cawsDir: string;
    readonly repoRoot: string;
    readonly specs: readonly Spec[];
    readonly sessionCandidates: ReturnType<typeof resolveSessionCandidates>;
  }
): WorktreePhysicalCleanupPlanItem {
  const wtPath = input.entry.path ?? defaultWorktreePath(input.cawsDir, input.name);
  const baseDetails: Record<string, unknown> = {
    registry_path: input.entry.path,
    default_path: defaultWorktreePath(input.cawsDir, input.name),
  };
  const lifecycle = specLifecycle(input.specs, input.entry.specId);

  const common = {
    subject: input.name,
    registered: true,
    path: wtPath,
    ...(input.entry.specId !== undefined ? { spec_id: input.entry.specId } : {}),
    ...(lifecycle !== undefined ? { lifecycle_state: lifecycle } : {}),
    ...(input.entry.owner !== undefined ? { owner_session_id: input.entry.owner.session_id } : {}),
    ...(input.entry.branch !== undefined ? { branch: input.entry.branch } : {}),
    ...(input.entry.baseBranch !== undefined ? { base_branch: input.entry.baseBranch } : {}),
  };

  if (!fs.existsSync(wtPath)) {
    return {
      ...common,
      state_class: 'missing-directory-refused',
      allowed_mutation: null,
      refusal_reason: 'The registry entry has no physical directory; this is control-plane residue, not a physical cleanup candidate.',
      next_command: `caws worktree prune --include ${input.name}`,
      details: baseDetails,
    };
  }

  if (!isGitWorktree(wtPath)) {
    return {
      ...common,
      state_class: 'not-git-worktree-refused',
      allowed_mutation: null,
      refusal_reason: 'The path exists but is not a git worktree, so CAWS will not classify it for physical cleanup.',
      next_command: 'Inspect the directory manually; do not delete it through CAWS.',
      details: baseDetails,
    };
  }

  if (input.entry.owner !== undefined && admitsOwner(input.sessionCandidates, input.entry.owner.session_id) === null) {
    return {
      ...common,
      state_class: 'foreign-owned-refused',
      allowed_mutation: null,
      refusal_reason: `Registered owner ${input.entry.owner.session_id} is not the current session; leases are not sufficient authority for cleanup.`,
      next_command: `Inspect ownership with caws worktree list and caws agents list before any caws claim --takeover.`,
      details: baseDetails,
    };
  }

  const clean = isCleanWorktree(wtPath);
  if (!clean.ok) {
    return {
      ...common,
      state_class: 'git-observation-unavailable',
      allowed_mutation: null,
      refusal_reason: `Unable to inspect worktree cleanliness: ${clean.reason}`,
      next_command: 'Fix git observation and rerun caws worktree cleanup-plan.',
      details: baseDetails,
    };
  }
  if (!clean.clean) {
    return {
      ...common,
      clean: false,
      state_class: 'dirty-refused',
      allowed_mutation: null,
      refusal_reason: 'The physical worktree has uncommitted changes.',
      next_command: `Commit or intentionally preserve changes before caws worktree destroy ${input.name}.`,
      details: { ...baseDetails, status: clean.output },
    };
  }

  let merged: boolean | undefined;
  if (input.entry.branch !== undefined && input.entry.baseBranch !== undefined) {
    const merge = isMerged(input.repoRoot, input.entry.branch, input.entry.baseBranch);
    if (!merge.ok) {
      return {
        ...common,
        clean: true,
        state_class: 'git-observation-unavailable',
        allowed_mutation: null,
        refusal_reason: `Unable to inspect merge status: ${merge.reason}`,
        next_command: 'Fix git branch/base observation and rerun caws worktree cleanup-plan.',
        details: baseDetails,
      };
    }
    merged = merge.merged;
    if (!merge.merged) {
      return {
        ...common,
        clean: true,
        merged: false,
        state_class: 'unmerged-refused',
        allowed_mutation: null,
        refusal_reason: `Branch ${input.entry.branch} is not merged into ${input.entry.baseBranch}.`,
        next_command: `Merge first, or use caws worktree destroy ${input.name} --abandon-unmerged only with explicit intent.`,
        details: baseDetails,
      };
    }
  }

  if (input.entry.specId !== undefined && lifecycle === undefined) {
    return {
      ...common,
      clean: true,
      ...(merged !== undefined ? { merged } : {}),
      state_class: 'unknown-spec-refused',
      allowed_mutation: null,
      refusal_reason: `Registry binds spec ${input.entry.specId}, but that spec is not loaded.`,
      next_command: 'Restore the spec or inspect caws doctor before destroying this worktree.',
      details: baseDetails,
    };
  }

  if (lifecycle !== undefined && lifecycle !== 'closed' && lifecycle !== 'archived' && lifecycle !== 'retired') {
    return {
      ...common,
      clean: true,
      ...(merged !== undefined ? { merged } : {}),
      state_class: 'active-bound-refused',
      allowed_mutation: null,
      refusal_reason: `Bound spec ${input.entry.specId} is lifecycle_state ${lifecycle}; physical cleanup must not remove active/draft work.`,
      next_command: `Close, retire, or untrack the spec/worktree intentionally before caws worktree destroy ${input.name}.`,
      details: baseDetails,
    };
  }

  if (input.entry.specId === undefined) {
    return {
      ...common,
      clean: true,
      ...(merged !== undefined ? { merged } : {}),
      state_class: 'unbound-clean-candidate',
      allowed_mutation: 'eligible for single-worktree destroy; cleanup-plan itself is read-only',
      next_command: `caws worktree destroy ${input.name}`,
      details: baseDetails,
    };
  }

  return {
    ...common,
    clean: true,
    ...(merged !== undefined ? { merged } : {}),
    state_class: 'destroy-ready',
    allowed_mutation: 'eligible for single-worktree destroy; cleanup-plan itself is read-only',
    next_command: `caws worktree destroy ${input.name}`,
    details: baseDetails,
  };
}

function unregisteredPhysicalItems(
  repoRoot: string,
  cawsDir: string,
  registry: Record<string, WorktreeRecord>
): WorktreePhysicalCleanupPlanItem[] {
  const physical = listPhysicalGitWorktrees(repoRoot);
  if (!physical.ok) {
    return [
      {
        subject: '.caws/worktrees',
        state_class: 'git-observation-unavailable',
        registered: false,
        path: path.join(cawsDir, 'worktrees'),
        allowed_mutation: null,
        refusal_reason: `Unable to enumerate physical git worktrees: ${physical.reason}`,
        next_command: 'Fix git worktree observation and rerun caws worktree cleanup-plan.',
        details: {},
      },
    ];
  }

  const physicalRoot = realpathSafe(path.join(cawsDir, 'worktrees'));
  const registeredPaths = new Set(
    Object.entries(registry).map(([name, entry]) => realpathSafe(entry.path ?? defaultWorktreePath(cawsDir, name)))
  );
  const items: WorktreePhysicalCleanupPlanItem[] = [];
  for (const wt of physical.worktrees) {
    const real = realpathSafe(wt.path);
    if (real === realpathSafe(repoRoot)) continue;
    if (!real.startsWith(physicalRoot + path.sep)) continue;
    if (registeredPaths.has(real)) continue;
    const subject = path.basename(real);
    items.push({
      subject,
      state_class: 'unregistered-physical-refused',
      registered: false,
      path: wt.path,
      ...(wt.branch !== undefined ? { branch: wt.branch } : {}),
      allowed_mutation: null,
      refusal_reason: 'A physical git worktree exists under .caws/worktrees but has no CAWS registry entry.',
      next_command: 'Inspect with git worktree list and caws doctor before deciding whether to register, preserve, or remove it manually.',
      details: {},
    });
  }
  return items;
}

function selectedByPhysicalFilters(
  item: WorktreePhysicalCleanupPlanItem,
  filters: {
    readonly states?: ReadonlySet<string>;
    readonly include?: ReadonlySet<string>;
    readonly exclude?: ReadonlySet<string>;
  }
): boolean {
  if (filters.states !== undefined && !filters.states.has(item.state_class)) return false;
  if (
    filters.include !== undefined &&
    !filters.include.has(item.subject) &&
    !filters.include.has(item.path) &&
    (item.spec_id === undefined || !filters.include.has(item.spec_id))
  ) return false;
  if (
    filters.exclude !== undefined &&
    (filters.exclude.has(item.subject) ||
      filters.exclude.has(item.path) ||
      (item.spec_id !== undefined && filters.exclude.has(item.spec_id)))
  ) return false;
  return true;
}

export function buildWorktreePhysicalCleanupPlan(input: {
  readonly repoRoot: string;
  readonly cawsDir: string;
  readonly registry: Record<string, WorktreeRecord>;
  readonly specs: readonly Spec[];
  readonly sessionCandidates: ReturnType<typeof resolveSessionCandidates>;
  readonly state?: readonly string[];
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
}): { readonly ok: true; readonly items: readonly WorktreePhysicalCleanupPlanItem[] } | { readonly ok: false; readonly message: string } {
  const stateSet = input.state !== undefined && input.state.length > 0 ? new Set(input.state) : undefined;
  if (stateSet !== undefined) {
    const unknown = [...stateSet].filter((state) => !WORKTREE_PHYSICAL_CLEANUP_STATES.includes(state as WorktreePhysicalCleanupStateClass));
    if (unknown.length > 0) {
      return {
        ok: false,
        message: `unknown --state value(s): ${unknown.join(', ')}. Expected one of: ${WORKTREE_PHYSICAL_CLEANUP_STATES.join(', ')}`,
      };
    }
  }

  const includeSet = input.include !== undefined && input.include.length > 0 ? new Set(input.include) : undefined;
  const excludeSet = input.exclude !== undefined && input.exclude.length > 0 ? new Set(input.exclude) : undefined;
  const filters = {
    ...(stateSet !== undefined ? { states: stateSet } : {}),
    ...(includeSet !== undefined ? { include: includeSet } : {}),
    ...(excludeSet !== undefined ? { exclude: excludeSet } : {}),
  };

  const registered = Object.entries(input.registry).map(([name, entry]) =>
    physicalItem({
      name,
      entry,
      cawsDir: input.cawsDir,
      repoRoot: input.repoRoot,
      specs: input.specs,
      sessionCandidates: input.sessionCandidates,
    })
  );
  const unregistered = unregisteredPhysicalItems(input.repoRoot, input.cawsDir, input.registry);
  return {
    ok: true,
    items: [...registered, ...unregistered].filter((item) => selectedByPhysicalFilters(item, filters)),
  };
}

function physicalCountsByState(items: readonly WorktreePhysicalCleanupPlanItem[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) counts[item.state_class] = (counts[item.state_class] ?? 0) + 1;
  return counts;
}

function physicalApplyCounts(outcomes: readonly WorktreePhysicalCleanupApplyOutcome[]): Record<string, number> {
  return {
    applied: outcomes.filter((item) => item.action === 'applied').length,
    refused: outcomes.filter((item) => item.action === 'refused').length,
    failed: outcomes.filter((item) => item.action === 'failed').length,
  };
}

function renderWorktreePhysicalCleanupPlan(
  items: readonly WorktreePhysicalCleanupPlanItem[],
  out: (line: string) => void
): void {
  out(`caws worktree cleanup-plan: read-only physical cleanup plan (${items.length} item(s))`);
  if (items.length === 0) {
    out('(no physical worktree cleanup items)');
    return;
  }
  for (const item of items) {
    out(`- ${item.state_class} ${item.subject}`);
    out(`  path: ${item.path}`);
    if (item.spec_id !== undefined) out(`  spec: ${item.spec_id}${item.lifecycle_state !== undefined ? ` (${item.lifecycle_state})` : ''}`);
    if (item.branch !== undefined) out(`  branch: ${item.branch}${item.base_branch !== undefined ? ` -> ${item.base_branch}` : ''}`);
    if (item.owner_session_id !== undefined) out(`  owner: ${item.owner_session_id}`);
    out(`  registered: ${item.registered ? 'yes' : 'no'}`);
    if (item.clean !== undefined) out(`  clean: ${item.clean ? 'yes' : 'no'}`);
    if (item.merged !== undefined) out(`  merged: ${item.merged ? 'yes' : 'no'}`);
    out(`  allowed: ${item.allowed_mutation ?? 'refused'}`);
    if (item.refusal_reason !== undefined) out(`  refusal: ${item.refusal_reason}`);
    out(`  next: ${item.next_command}`);
  }
}

function renderWorktreePhysicalCleanupApply(
  outcomes: readonly WorktreePhysicalCleanupApplyOutcome[],
  out: (line: string) => void
): void {
  const counts = physicalApplyCounts(outcomes);
  out(
    `caws worktree cleanup-plan --apply: ${counts.applied} applied, ` +
      `${counts.refused} refused, ${counts.failed} failed`
  );
  for (const item of outcomes) {
    if (item.action === 'applied') {
      out(`- APPLIED ${item.state_class} ${item.subject}: ${item.mutation}`);
    } else {
      out(`- ${item.action.toUpperCase()} ${item.state_class} ${item.subject}: ${item.reason}`);
    }
  }
}

function hasExplicitPhysicalCleanupSelector(opts: WorktreePhysicalCleanupOptions): boolean {
  return (
    (opts.state !== undefined && opts.state.length > 0) ||
    (opts.include !== undefined && opts.include.length > 0) ||
    (opts.exclude !== undefined && opts.exclude.length > 0)
  );
}

export function runWorktreePhysicalCleanupPlanCommand(opts: WorktreePhysicalCleanupOptions): number {
  const { cwd, nowFn, env, out, err, showData } = setupIO(opts);
  const ctx = resolveCawsCtx(cwd, err, showData, 'cleanup-plan');
  if (ctx === null) return 2;

  const registry = loadWorktrees(ctx.cawsDir);
  if (!isOk(registry)) {
    err('caws worktree cleanup-plan: failed to load worktrees registry.');
    err(renderDiagnostics(registry.errors, { showData }));
    return 2;
  }
  const specsResult = loadSpecs(ctx.cawsDir);
  if (specsResult.diagnostics.some((d) => d.severity === 'error')) {
    err('caws worktree cleanup-plan: failed to load specs.');
    err(renderDiagnostics(specsResult.diagnostics, { showData }));
    return 2;
  }

  const plan = buildWorktreePhysicalCleanupPlan({
    repoRoot: ctx.repoRoot,
    cawsDir: ctx.cawsDir,
    registry: registry.value,
    specs: specsResult.specs,
    sessionCandidates: resolveSessionCandidates({ cawsDir: ctx.cawsDir, env }),
    ...(opts.state !== undefined ? { state: opts.state } : {}),
    ...(opts.include !== undefined ? { include: opts.include } : {}),
    ...(opts.exclude !== undefined ? { exclude: opts.exclude } : {}),
  });
  if (!plan.ok) {
    err(`caws worktree cleanup-plan: ${plan.message}`);
    return 1;
  }

  if (opts.apply === true) {
    if (!hasExplicitPhysicalCleanupSelector(opts)) {
      err('caws worktree cleanup-plan --apply: refused.');
      err('  Add at least one explicit selector: --state, --include, or --exclude.');
      err('  First apply class is intentionally narrow; use --state destroy-ready to apply all currently ready candidates.');
      return 1;
    }

    const id = buildActorPair(ctx.cawsDir, cwd, env, nowFn, opts.actorKind, err, showData, 'cleanup-plan');
    if (id === null) return 2;
    const sessionCandidates = resolveSessionCandidates({ cawsDir: ctx.cawsDir, env });
    const outcomes: WorktreePhysicalCleanupApplyOutcome[] = [];

    for (const item of plan.items) {
      if (item.state_class !== 'destroy-ready') {
        outcomes.push({
          subject: item.subject,
          state_class: item.state_class,
          action: 'refused',
          reason:
            item.refusal_reason ??
            'Only destroy-ready registered worktrees are apply-capable in cleanup-plan --apply.',
        });
        continue;
      }

      const result = destroyWorktree(ctx.cawsDir, {
        name: item.subject,
        session: id.session,
        sessionCandidates,
        actor: id.actor,
        now: nowFn,
      });
      if (!isOk(result)) {
        outcomes.push({
          subject: item.subject,
          state_class: item.state_class,
          action: 'failed',
          reason: firstErrorMessage(result.errors),
        });
      } else if (result.value.kind === 'partial_failure_recovered') {
        outcomes.push({
          subject: item.subject,
          state_class: item.state_class,
          action: 'failed',
          reason: 'partial failure recovered; no state change',
        });
      } else {
        outcomes.push({
          subject: item.subject,
          state_class: item.state_class,
          action: 'applied',
          mutation: 'destroyed physical git worktree through destroyWorktree',
        });
      }
    }

    if (opts.json === true) {
      out(JSON.stringify({
        ok: !outcomes.some((item) => item.action !== 'applied'),
        dry_run: false,
        read_only: false,
        outcomes,
        counts: physicalApplyCounts(outcomes),
        filters: {
          state: opts.state ?? [],
          include: opts.include ?? [],
          exclude: opts.exclude ?? [],
        },
      }, null, 2));
    } else {
      renderWorktreePhysicalCleanupApply(outcomes, out);
    }
    return outcomes.some((item) => item.action !== 'applied') ? 1 : 0;
  }

  if (opts.json === true) {
    out(JSON.stringify({
      ok: true,
      dry_run: true,
      read_only: true,
      candidates: plan.items,
      counts_by_state: physicalCountsByState(plan.items),
      filters: {
        state: opts.state ?? [],
        include: opts.include ?? [],
        exclude: opts.exclude ?? [],
      },
    }, null, 2));
    return 0;
  }

  renderWorktreePhysicalCleanupPlan(plan.items, out);
  return 0;
}

// ─── caws worktree repair-sparse ─────────────────────────────────────────
//
// WORKTREE-SPEC-CANONICAL-ACCESS-GUARD-001 A4 + A5.
//
// First-class subcommand to restore the sparse-checkout invariant on a
// linked CAWS worktree (`/*` + `!/.caws/specs/`). Replaces the pattern
// of agents asking the user to run `git sparse-checkout` commands by
// hand or to invoke ad-hoc Node scripts that import
// configureWorktreeSparseCheckout directly.
//
// Behavior:
//   - Resolve <name> in .caws/worktrees.json registry; refuse if absent.
//   - Resolve on-disk path; refuse if missing.
//   - Refuse if the target IS the canonical checkout (realpath equality).
//   - Refuse if the target is not a git worktree (no .git file/dir).
//   - Refuse if <wt>/.caws/specs/ contains dirty or untracked files
//     (`git status --porcelain .caws/specs/` non-empty). No stash, no
//     git clean, no reset --hard, no file deletion is attempted. The
//     lineage on stash/destroy as a work-loss class is explicit
//     (see CLAUDE.md "Implementation hygiene"); the repair command
//     must not regress it.
//   - On success: call configureWorktreeSparseCheckout (kernel helper);
//     verify post-condition (core.sparseCheckout=true and .caws/specs
//     absent on disk); return 0.
//   - Idempotent: invoking on a healthy worktree returns 0 with a
//     no-op-shaped diagnostic.

export interface WorktreeRepairSparseOptions extends BaseCommandOptions {
  readonly name: string;
}

function realpathSafe(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

function isGitWorktree(p: string): boolean {
  // A linked worktree has a `.git` file (not directory) pointing at the
  // canonical checkout's `.git/worktrees/<name>/` directory. A canonical
  // checkout has `.git/` as a directory. Either shape proves "is a git
  // worktree of some kind." Absence of `.git` entirely → not a worktree.
  const dotGit = path.join(p, '.git');
  try {
    return fs.existsSync(dotGit);
  } catch {
    return false;
  }
}

function gitStatusPorcelain(cwd: string, pathspec: string): { ok: true; output: string } | { ok: false; reason: string } {
  try {
    const output = execFileSync('git', ['status', '--porcelain', '--', pathspec], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, output: output.toString() };
  } catch (e) {
    const cause = e as { message?: string; stderr?: Buffer | string };
    const stderr =
      cause.stderr instanceof Buffer
        ? cause.stderr.toString()
        : typeof cause.stderr === 'string'
          ? cause.stderr
          : (cause.message ?? 'unknown git error');
    return { ok: false, reason: stderr.trim() };
  }
}

function gitConfigGet(cwd: string, key: string): string | null {
  try {
    const output = execFileSync('git', ['config', '--get', key], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return output.toString().trim();
  } catch {
    // `git config --get` exits non-zero when the key is absent; treat as null.
    return null;
  }
}

export function runWorktreeRepairSparseCommand(opts: WorktreeRepairSparseOptions): number {
  const { cwd, out, err, showData } = setupIO(opts);
  const ctx = resolveCawsCtx(cwd, err, showData, 'repair-sparse');
  if (ctx === null) return 2;

  // A5a: registry lookup.
  const registryResult = loadWorktrees(ctx.cawsDir);
  if (!isOk(registryResult)) {
    err('caws worktree repair-sparse: failed to load worktrees registry.');
    err(renderDiagnostics(registryResult.errors, { showData }));
    return 2;
  }
  const entry = registryResult.value[opts.name];
  if (entry === undefined) {
    err(`caws worktree repair-sparse: missing-registry: '${opts.name}' is not in .caws/worktrees.json.`);
    err(`  Recovery: run 'caws worktree list' to see registered worktrees, or 'caws worktree create ${opts.name} --spec <id>' if this is a new worktree.`);
    return 1;
  }

  // A5b: on-disk path presence.
  const recordedPath = entry.path;
  if (typeof recordedPath !== 'string' || recordedPath.length === 0) {
    err(`caws worktree repair-sparse: missing-path: registry entry for '${opts.name}' has no recorded path.`);
    return 1;
  }
  if (!fs.existsSync(recordedPath)) {
    err(`caws worktree repair-sparse: missing-path: recorded path for '${opts.name}' does not exist on disk.`);
    err(`  Recorded path: ${recordedPath}`);
    err(`  Recovery: re-create the worktree with 'caws worktree create ${opts.name} --spec <id>'.`);
    return 1;
  }

  // A5c: canonical-checkout refusal. Use realpath comparison to be
  // drift-immune to macOS /var vs /private/var symlinks.
  const targetReal = realpathSafe(recordedPath);
  const canonicalReal = realpathSafe(ctx.repoRoot);
  if (targetReal === canonicalReal) {
    err(`caws worktree repair-sparse: canonical-target-refused: '${opts.name}' resolves to the canonical checkout itself.`);
    err(`  The canonical checkout IS spec authority — sparse-checkout is not applied there by design.`);
    err(`  This command is only for linked worktrees created via 'caws worktree create'.`);
    return 1;
  }

  // A5d: must be a git worktree (sanity — a stale directory after manual
  // `git worktree remove` would pass A5b but fail this).
  if (!isGitWorktree(targetReal)) {
    err(`caws worktree repair-sparse: not-a-worktree: '${opts.name}' exists on disk but is not a git worktree.`);
    err(`  Resolved path: ${targetReal}`);
    err(`  No .git file or directory found at the target. The CAWS registry and git's worktree registry may have diverged.`);
    err(`  Recovery: investigate manually. Do NOT delete or recreate without understanding why the divergence occurred.`);
    return 1;
  }

  // A5e: dirty-specs refusal. Non-destructive — no stash, no clean, no
  // reset, no deletion. If the user has uncommitted work under .caws/
  // specs (e.g., from a previous sparse-disable + edit session), we
  // refuse and direct them to a manual recovery path.
  const dirtyCheck = gitStatusPorcelain(targetReal, '.caws/specs');
  if (!dirtyCheck.ok) {
    err(`caws worktree repair-sparse: git-status-failed: unable to check .caws/specs cleanliness in '${opts.name}'.`);
    err(`  git stderr: ${dirtyCheck.reason}`);
    return 2;
  }
  if (dirtyCheck.output.trim().length > 0) {
    err(`caws worktree repair-sparse: dirty-specs-refused: '${opts.name}'/.caws/specs/ contains uncommitted changes.`);
    err(`  git status --porcelain .caws/specs/ output:`);
    for (const line of dirtyCheck.output.trim().split('\n')) {
      err(`    ${line}`);
    }
    err(`  This command will NOT stash, clean, reset, or delete those files. Doing so risks losing work that was`);
    err(`  authored under .caws/specs/ inside this worktree (which would be non-authoritative spec copies — but`);
    err(`  may still represent intent worth preserving).`);
    err(`  Recovery (manual): from inside the worktree, commit or remove the dirty files first, then re-run`);
    err(`  'caws worktree repair-sparse ${opts.name}' from the canonical checkout.`);
    return 1;
  }

  // Idempotency check: if sparse-checkout is already enabled and
  // .caws/specs/ is already absent, we have nothing to do.
  const sparseFlag = gitConfigGet(targetReal, 'core.sparseCheckout');
  const specsDir = path.join(targetReal, '.caws', 'specs');
  const specsAbsent = !fs.existsSync(specsDir);
  if (sparseFlag === 'true' && specsAbsent) {
    out(`caws worktree repair-sparse: ${opts.name} already has the sparse invariant (core.sparseCheckout=true, .caws/specs absent). No action taken.`);
    return 0;
  }

  // A4: apply the kernel helper.
  const repairResult = configureWorktreeSparseCheckout(targetReal);
  if (!repairResult.ok) {
    err(`caws worktree repair-sparse: failed at step '${repairResult.step}': ${repairResult.reason}`);
    return 2;
  }

  // Post-condition verification. configureWorktreeSparseCheckout already
  // calls `git checkout` to re-materialize, so .caws/specs/ should be
  // absent now. Verify explicitly.
  const postSparseFlag = gitConfigGet(targetReal, 'core.sparseCheckout');
  const postSpecsAbsent = !fs.existsSync(specsDir);
  if (postSparseFlag !== 'true' || !postSpecsAbsent) {
    err(`caws worktree repair-sparse: post-condition violation for '${opts.name}'.`);
    err(`  core.sparseCheckout=${postSparseFlag ?? '(absent)'} (expected: true)`);
    err(`  .caws/specs/ absent=${postSpecsAbsent} (expected: true)`);
    err(`  The kernel helper reported success but the invariant is not satisfied. This is likely a defect.`);
    return 2;
  }

  out(`caws worktree repair-sparse: ${opts.name} sparse invariant restored (core.sparseCheckout=true, .caws/specs absent).`);
  return 0;
}

// ─── caws worktree repair (PRUNE-REPAIR-WORKTREE-001) ─────────────────────
//
// The terminal slice of the Diagnose -> Decide -> Repair arc. This command is
// an EXECUTOR of doctor doctrine, NOT a second authority engine. It runs the
// exact doctor pipeline (composeDoctorSnapshot -> inspectProjectState), then
// classifies each finding through the §1.4 half-state decision matrix and
// dispatches ONLY the matrix-unambiguous classes to the store writers:
//
//   H1  ghost registry  (doctor.worktree.ghost_registry_entry)
//        -> pruneWorktree           (worktree_pruned, h_class: ghost_registry)
//   H4  ghost spec binding  (doctor.binding.spec_missing_registry, active,
//        canonical_dir_present === false)
//        -> clearSpecBinding        (spec_binding_cleared, ghost_spec_binding)
//   H3-dormant  (doctor.binding.spec_missing_registry, closed/archived)
//        -> clearSpecBinding        (spec_binding_cleared, dormant_spec_binding)
//
// Everything else is REFUSED with a doctrine-pointer diagnostic and ZERO
// mutation: H2 (registry->missing-spec), H3 on an ACTIVE spec whose dir still
// exists (recreate-vs-clear ambiguity), H5 (3-way), H6 (foreign physical), the
// event-backed orphan, and any one-sided/foreign binding the matrix did not
// authorize. The command NEVER touches a git worktree directory — the writers
// mutate only worktrees.json and canonical spec YAML.
//
// The classification reads doctor EVIDENCE (the finding rule + its data
// payload: lifecycle_state, canonical_dir_present); it does not re-derive which
// surface wins. The matrix decides; the writers execute.

export interface WorktreeRepairOptions extends BaseCommandOptions {
  readonly dryRun?: boolean;
}

export type WorktreePruneStateClass =
  | 'ghost-registry'
  | 'dead-binding'
  | 'closed-spec-residue'
  | 'missing-spec-refused'
  | 'active-binding-refused'
  | 'binding-contradiction-refused'
  | 'foreign-physical-refused'
  | 'event-orphan-refused'
  | 'one-sided-binding-refused'
  | 'non-governable-binding-refused'
  | 'owner-lease-missing-refused'
  | 'git-observation-unavailable';

export interface WorktreePrunePlanItem {
  readonly subject: string;
  readonly state_class: WorktreePruneStateClass;
  readonly source_rule: string;
  readonly severity: DoctorFinding['severity'];
  readonly allowed_mutation: string | null;
  readonly refusal_reason?: string;
  readonly next_command: string;
  readonly details: Record<string, unknown>;
}

export interface WorktreePruneOptions extends BaseCommandOptions {
  readonly state?: readonly string[];
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  readonly apply?: boolean;
  readonly json?: boolean;
}

type WorktreePruneApplyOutcome =
  | {
      readonly subject: string;
      readonly state_class: WorktreePruneStateClass;
      readonly action: 'applied';
      readonly mutation: string;
    }
  | {
      readonly subject: string;
      readonly state_class: WorktreePruneStateClass;
      readonly action: 'refused';
      readonly reason: string;
    }
  | {
      readonly subject: string;
      readonly state_class: WorktreePruneStateClass;
      readonly action: 'failed';
      readonly reason: string;
    };

/** What the matrix decided for a single doctor finding. */
type RepairDecision =
  | { kind: 'prune_ghost_registry'; worktreeName: string }
  | {
      kind: 'clear_spec_binding';
      specId: string;
      worktreeName: string;
      hClass: 'ghost_spec_binding' | 'dormant_spec_binding';
    }
  | { kind: 'refuse'; reason: string }
  | { kind: 'ignore' };

/**
 * The §1.4 decision matrix as a pure function over doctor evidence. Reads only
 * the finding's rule and its data payload — never re-derives classification.
 * `refuse` carries the doctrine-pointer reason; `ignore` is for findings
 * outside the half-state taxonomy (e.g. a gitignore-drift info) that repair
 * neither acts on nor refuses.
 *
 * Exported so the classifier can be unit-tested directly for the refuse-only
 * classes (H6 foreign-physical, event-orphan) whose end-to-end fixtures would
 * require a real git worktree / a hand-built hash chain — the dispatch is
 * identical to the H5/H2 refuse arms proven end-to-end, so the cheaper proof is
 * to pin the decision here.
 */
export function decideRepair(finding: DoctorFinding): RepairDecision {
  const data = (finding.data ?? {}) as Record<string, unknown>;
  switch (finding.rule) {
    case DOCTOR_RULES.WORKTREE_GHOST_REGISTRY_ENTRY: {
      const worktreeName =
        typeof data.worktree_name === 'string'
          ? data.worktree_name
          : finding.subject;
      if (typeof worktreeName !== 'string' || worktreeName.length === 0) {
        return { kind: 'refuse', reason: 'H1 ghost finding has no worktree name; cannot prune safely.' };
      }
      return { kind: 'prune_ghost_registry', worktreeName };
    }
    case DOCTOR_RULES.BINDING_SPEC_MISSING_REGISTRY: {
      // Spec points to a worktree with no registry entry. The matrix splits on
      // lifecycle + canonical-dir observation:
      //   closed/archived          -> H3-dormant: clear (dormant_spec_binding)
      //   active + dir absent       -> H4 ghost:   clear (ghost_spec_binding)
      //   active + dir present/unk  -> H3-active ambiguity: REFUSE
      const specId =
        typeof data.spec_id === 'string' ? data.spec_id : finding.subject;
      const worktreeName =
        typeof data.worktree_name === 'string' ? data.worktree_name : '(unknown)';
      if (typeof specId !== 'string' || specId.length === 0) {
        return { kind: 'refuse', reason: 'binding finding has no spec id; cannot clear safely.' };
      }
      const lifecycle = data.lifecycle_state;
      if (lifecycle === 'closed' || lifecycle === 'archived') {
        return { kind: 'clear_spec_binding', specId, worktreeName, hClass: 'dormant_spec_binding' };
      }
      // Active spec. Only an OBSERVED-absent canonical dir makes this an
      // unambiguous H4 ghost. If the dir is present, or observation was
      // unavailable, recreate-vs-clear is ambiguous — refuse.
      if (data.canonical_dir_observed === true && data.canonical_dir_present === false) {
        return { kind: 'clear_spec_binding', specId, worktreeName, hClass: 'ghost_spec_binding' };
      }
      return {
        kind: 'refuse',
        reason:
          `H3 on an active spec (${specId}): the worktree dir is present or unobserved, so recreate-vs-clear is ambiguous. ` +
          'Resolve under WORKTREE-SPEC-AUTHORITY-CONTROL-PLANE-002, or destroy/recreate the worktree explicitly.',
      };
    }
    case DOCTOR_RULES.BINDING_REGISTRY_MISSING_SPEC:
      return {
        kind: 'refuse',
        reason:
          'H2 (registry binds a spec that is not loaded): restore the spec file or destroy the worktree. ' +
          'Repair does not delete registry entries that still claim a (possibly recoverable) spec.',
      };
    case DOCTOR_RULES.WORKTREE_BINDING_CONTRADICTION_3WAY:
      return {
        kind: 'refuse',
        reason:
          'H5 (3-way authority contradiction): ambiguous authority split, no automatic repair. ' +
          'See WORKTREE-SPEC-AUTHORITY-CONTROL-PLANE-002.',
      };
    case DOCTOR_RULES.WORKTREE_FOREIGN_PHYSICAL:
      return {
        kind: 'refuse',
        reason:
          'H6 (foreign physical worktree): a git worktree dir exists that CAWS did not register. ' +
          'Repair never touches git worktree directories; resolve manually.',
      };
    case DOCTOR_RULES.WORKTREE_EVENT_WITHOUT_CONTROL_PLANE_BINDING:
      return {
        kind: 'refuse',
        reason:
          'Event-backed orphan: events reference a worktree with no live control-plane binding. ' +
          'This needs authority reconciliation, not a mechanical prune.',
      };
    case DOCTOR_RULES.BINDING_ONE_SIDED:
    case DOCTOR_RULES.BINDING_SPEC_POINTS_TO_FOREIGN_BINDING:
      return {
        kind: 'refuse',
        reason:
          'One-sided / foreign binding: this slice does not reconcile general one-sided bindings ' +
          '(that was the superseded draft framing). The matrix authorizes only ghost prune and dead-binding clear.',
      };
    default:
      return { kind: 'ignore' };
  }
}

const WORKTREE_PRUNE_STATES: readonly WorktreePruneStateClass[] = [
  'ghost-registry',
  'dead-binding',
  'closed-spec-residue',
  'missing-spec-refused',
  'active-binding-refused',
  'binding-contradiction-refused',
  'foreign-physical-refused',
  'event-orphan-refused',
  'one-sided-binding-refused',
  'non-governable-binding-refused',
  'owner-lease-missing-refused',
  'git-observation-unavailable',
] as const;

function findingSubject(finding: DoctorFinding, data: Record<string, unknown>): string {
  if (typeof data.worktree_name === 'string' && data.worktree_name.length > 0) {
    return data.worktree_name;
  }
  if (typeof data.spec_id === 'string' && data.spec_id.length > 0) {
    return data.spec_id;
  }
  if (typeof data.path === 'string' && data.path.length > 0) {
    return data.path;
  }
  return typeof finding.subject === 'string' && finding.subject.length > 0
    ? finding.subject
    : finding.rule;
}

function repairItemFromDecision(
  finding: DoctorFinding,
  decision: RepairDecision
): WorktreePrunePlanItem | null {
  const data = (finding.data ?? {}) as Record<string, unknown>;
  const subject = findingSubject(finding, data);
  if (decision.kind === 'ignore') return null;
  if (decision.kind === 'prune_ghost_registry') {
    return {
      subject: decision.worktreeName,
      state_class: 'ghost-registry',
      source_rule: finding.rule,
      severity: finding.severity,
      allowed_mutation: 'prune registry entry and append worktree_pruned via caws worktree repair',
      next_command: `caws worktree repair --dry-run && caws worktree repair`,
      details: data,
    };
  }
  if (decision.kind === 'clear_spec_binding') {
    const stateClass =
      decision.hClass === 'dormant_spec_binding' ? 'closed-spec-residue' : 'dead-binding';
    return {
      subject: decision.specId,
      state_class: stateClass,
      source_rule: finding.rule,
      severity: finding.severity,
      allowed_mutation: 'clear stale spec worktree binding and append spec_binding_cleared via caws worktree repair',
      next_command: `caws worktree repair --dry-run && caws worktree repair`,
      details: {
        ...data,
        worktree_name: decision.worktreeName,
        h_class: decision.hClass,
      },
    };
  }

  let stateClass: WorktreePruneStateClass;
  switch (finding.rule) {
    case DOCTOR_RULES.BINDING_REGISTRY_MISSING_SPEC:
      stateClass = 'missing-spec-refused';
      break;
    case DOCTOR_RULES.BINDING_SPEC_MISSING_REGISTRY:
      stateClass = 'active-binding-refused';
      break;
    case DOCTOR_RULES.WORKTREE_BINDING_CONTRADICTION_3WAY:
      stateClass = 'binding-contradiction-refused';
      break;
    case DOCTOR_RULES.WORKTREE_FOREIGN_PHYSICAL:
      stateClass = 'foreign-physical-refused';
      break;
    case DOCTOR_RULES.WORKTREE_EVENT_WITHOUT_CONTROL_PLANE_BINDING:
      stateClass = 'event-orphan-refused';
      break;
    case DOCTOR_RULES.BINDING_ONE_SIDED:
    case DOCTOR_RULES.BINDING_SPEC_POINTS_TO_FOREIGN_BINDING:
      stateClass = 'one-sided-binding-refused';
      break;
    default:
      stateClass = 'one-sided-binding-refused';
      break;
  }
  return {
    subject,
    state_class: stateClass,
    source_rule: finding.rule,
    severity: finding.severity,
    allowed_mutation: null,
    refusal_reason: decision.reason,
    next_command: finding.narrowRepair ?? 'Inspect with caws doctor --data before mutating.',
    details: data,
  };
}

export function worktreePruneItemFromFinding(
  finding: DoctorFinding
): WorktreePrunePlanItem | null {
  const data = (finding.data ?? {}) as Record<string, unknown>;
  const repairDecision = decideRepair(finding);
  const repairItem = repairItemFromDecision(finding, repairDecision);
  if (repairItem !== null) return repairItem;

  if (finding.rule === DOCTOR_RULES.BINDING_SPEC_NOT_GOVERNABLE) {
    return {
      subject: findingSubject(finding, data),
      state_class: 'non-governable-binding-refused',
      source_rule: finding.rule,
      severity: finding.severity,
      allowed_mutation: null,
      refusal_reason:
        'The registry/spec binding points at a non-active spec; choose archive/recover/destroy intent explicitly.',
      next_command: finding.narrowRepair ?? 'Inspect with caws doctor --data before mutating.',
      details: data,
    };
  }
  if (finding.rule === DOCTOR_RULES.WORKTREE_OWNER_LEASE_MISSING) {
    return {
      subject: findingSubject(finding, data),
      state_class: 'owner-lease-missing-refused',
      source_rule: finding.rule,
      severity: finding.severity,
      allowed_mutation: null,
      refusal_reason:
        'The owner lease is stale or absent, but leases are not authority; cleanup requires explicit handoff/takeover intent.',
      next_command: finding.narrowRepair ?? 'Inspect owner state with caws worktree list and caws agents list.',
      details: data,
    };
  }
  if (finding.rule === DOCTOR_RULES.WORKTREE_GIT_OBSERVATION_UNAVAILABLE) {
    return {
      subject: findingSubject(finding, data),
      state_class: 'git-observation-unavailable',
      source_rule: finding.rule,
      severity: finding.severity,
      allowed_mutation: null,
      refusal_reason:
        'Git worktree observation failed, so cleanup classes that depend on git state are incomplete.',
      next_command: finding.narrowRepair ?? 'Fix git observation and rerun caws worktree prune.',
      details: data,
    };
  }
  return null;
}

function selectedByFilters(
  item: WorktreePrunePlanItem,
  filters: {
    readonly states?: ReadonlySet<string>;
    readonly include?: ReadonlySet<string>;
    readonly exclude?: ReadonlySet<string>;
  }
): boolean {
  if (filters.states !== undefined && !filters.states.has(item.state_class)) return false;
  if (filters.include !== undefined && !filters.include.has(item.subject)) return false;
  if (filters.exclude !== undefined && filters.exclude.has(item.subject)) return false;
  return true;
}

export function buildWorktreePrunePlan(
  findings: readonly DoctorFinding[],
  filters: {
    readonly states?: readonly string[];
    readonly include?: readonly string[];
    readonly exclude?: readonly string[];
  } = {}
): { readonly ok: true; readonly items: readonly WorktreePrunePlanItem[] } | { readonly ok: false; readonly message: string } {
  const stateSet =
    filters.states !== undefined && filters.states.length > 0
      ? new Set(filters.states)
      : undefined;
  if (stateSet !== undefined) {
    const unknown = [...stateSet].filter((state) => !WORKTREE_PRUNE_STATES.includes(state as WorktreePruneStateClass));
    if (unknown.length > 0) {
      return {
        ok: false,
        message: `unknown --state value(s): ${unknown.join(', ')}. Expected one of: ${WORKTREE_PRUNE_STATES.join(', ')}`,
      };
    }
  }
  const includeSet =
    filters.include !== undefined && filters.include.length > 0
      ? new Set(filters.include)
      : undefined;
  const excludeSet =
    filters.exclude !== undefined && filters.exclude.length > 0
      ? new Set(filters.exclude)
      : undefined;
  const normalizedFilters: {
    states?: ReadonlySet<string>;
    include?: ReadonlySet<string>;
    exclude?: ReadonlySet<string>;
  } = {
    ...(stateSet !== undefined ? { states: stateSet } : {}),
    ...(includeSet !== undefined ? { include: includeSet } : {}),
    ...(excludeSet !== undefined ? { exclude: excludeSet } : {}),
  };
  const selected = findings
    .map(worktreePruneItemFromFinding)
    .filter((item): item is WorktreePrunePlanItem => item !== null)
    .filter((item) => selectedByFilters(item, normalizedFilters));
  return { ok: true, items: selected };
}

function countsByState(items: readonly WorktreePrunePlanItem[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    counts[item.state_class] = (counts[item.state_class] ?? 0) + 1;
  }
  return counts;
}

function renderWorktreePrunePlan(
  items: readonly WorktreePrunePlanItem[],
  out: (line: string) => void
): void {
  out(`caws worktree prune: read-only cleanup plan (${items.length} candidate(s))`);
  if (items.length === 0) {
    out('(no worktree cleanup candidates)');
    return;
  }
  for (const item of items) {
    const allowed = item.allowed_mutation ?? 'refused';
    out(`- ${item.state_class} ${item.subject}`);
    out(`  source: ${item.source_rule} (${item.severity})`);
    out(`  allowed: ${allowed}`);
    if (item.refusal_reason !== undefined) out(`  refusal: ${item.refusal_reason}`);
    out(`  next: ${item.next_command}`);
  }
}

function renderWorktreePruneApply(
  outcomes: readonly WorktreePruneApplyOutcome[],
  out: (line: string) => void
): void {
  const applied = outcomes.filter((item) => item.action === 'applied').length;
  const refused = outcomes.filter((item) => item.action === 'refused').length;
  const failed = outcomes.filter((item) => item.action === 'failed').length;
  out(`caws worktree prune --apply: ${applied} applied, ${refused} refused, ${failed} failed`);
  for (const item of outcomes) {
    if (item.action === 'applied') {
      out(`- APPLIED ${item.state_class} ${item.subject}: ${item.mutation}`);
    } else {
      out(`- ${item.action.toUpperCase()} ${item.state_class} ${item.subject}: ${item.reason}`);
    }
  }
}

function pruneApplyCounts(outcomes: readonly WorktreePruneApplyOutcome[]): Record<string, number> {
  return {
    applied: outcomes.filter((item) => item.action === 'applied').length,
    refused: outcomes.filter((item) => item.action === 'refused').length,
    failed: outcomes.filter((item) => item.action === 'failed').length,
  };
}

function firstErrorMessage(errors: readonly { readonly message: string }[]): string {
  return errors.map((e) => e.message).join('; ');
}

export function runWorktreePruneCommand(opts: WorktreePruneOptions): number {
  const { cwd, nowFn, env, out, err, showData } = setupIO(opts);
  const ctx = resolveCawsCtx(cwd, err, showData, 'prune');
  if (ctx === null) return 2;

  let findings: readonly DoctorFinding[];
  try {
    const { doctorInput } = composeDoctorSnapshot({
      repoRoot: ctx.repoRoot,
      cawsDir: ctx.cawsDir,
      now: nowFn(),
    });
    findings = inspectProjectState(doctorInput).findings;
  } catch (e) {
    err(`caws worktree prune: doctor composition failed: ${(e as Error).message}`);
    return 2;
  }

  const plan = buildWorktreePrunePlan(findings, {
    ...(opts.state !== undefined ? { states: opts.state } : {}),
    ...(opts.include !== undefined ? { include: opts.include } : {}),
    ...(opts.exclude !== undefined ? { exclude: opts.exclude } : {}),
  });
  if (!plan.ok) {
    err(`caws worktree prune: ${plan.message}`);
    return 1;
  }

  if (opts.apply === true) {
    const id = buildActorPair(ctx.cawsDir, cwd, env, nowFn, opts.actorKind, err, showData, 'prune');
    if (id === null) return 2;
    const sessionCandidates = resolveSessionCandidates({ cawsDir: ctx.cawsDir, env });
    const outcomes: WorktreePruneApplyOutcome[] = [];

    for (const item of plan.items) {
      if (item.state_class === 'ghost-registry') {
        const result = pruneWorktree(ctx.cawsDir, {
          name: item.subject,
          session: id.session,
          sessionCandidates,
          actor: id.actor,
          reason: 'caws worktree prune --apply: ghost-registry cleanup.',
          now: nowFn,
        });
        if (!isOk(result)) {
          outcomes.push({
            subject: item.subject,
            state_class: item.state_class,
            action: 'failed',
            reason: firstErrorMessage(result.errors),
          });
        } else if (result.value.kind === 'partial_failure_recovered') {
          outcomes.push({
            subject: item.subject,
            state_class: item.state_class,
            action: 'failed',
            reason: 'partial failure recovered; no state change',
          });
        } else {
          outcomes.push({
            subject: item.subject,
            state_class: item.state_class,
            action: 'applied',
            mutation: 'removed registry entry and appended worktree_pruned',
          });
        }
        continue;
      }

      if (item.state_class === 'dead-binding' || item.state_class === 'closed-spec-residue') {
        const worktreeName =
          typeof item.details.worktree_name === 'string' && item.details.worktree_name.length > 0
            ? item.details.worktree_name
            : '(unknown)';
        const hClass =
          item.state_class === 'closed-spec-residue'
            ? 'dormant_spec_binding'
            : 'ghost_spec_binding';
        const result = clearSpecBinding(ctx.cawsDir, {
          id: item.subject,
          clearedWorktreeName: worktreeName,
          hClass,
          reason: `caws worktree prune --apply: ${item.state_class} cleanup.`,
          actor: id.actor,
          now: nowFn,
        });
        if (!isOk(result)) {
          outcomes.push({
            subject: item.subject,
            state_class: item.state_class,
            action: 'failed',
            reason: firstErrorMessage(result.errors),
          });
        } else {
          outcomes.push({
            subject: item.subject,
            state_class: item.state_class,
            action: 'applied',
            mutation: 'cleared spec worktree binding and appended spec_binding_cleared',
          });
        }
        continue;
      }

      outcomes.push({
        subject: item.subject,
        state_class: item.state_class,
        action: 'refused',
        reason: item.refusal_reason ?? 'state class is not apply-capable',
      });
    }

    if (opts.json === true) {
      out(JSON.stringify({
        ok: !outcomes.some((item) => item.action !== 'applied'),
        dry_run: false,
        read_only: false,
        outcomes,
        counts: pruneApplyCounts(outcomes),
        filters: {
          state: opts.state ?? [],
          include: opts.include ?? [],
          exclude: opts.exclude ?? [],
        },
      }, null, 2));
    } else {
      renderWorktreePruneApply(outcomes, out);
    }
    return outcomes.some((item) => item.action !== 'applied') ? 1 : 0;
  }

  if (opts.json === true) {
    out(JSON.stringify({
      ok: true,
      dry_run: true,
      read_only: true,
      candidates: plan.items,
      counts_by_state: countsByState(plan.items),
      filters: {
        state: opts.state ?? [],
        include: opts.include ?? [],
        exclude: opts.exclude ?? [],
      },
    }, null, 2));
    return 0;
  }

  renderWorktreePrunePlan(plan.items, out);
  return 0;
}

export function runWorktreeRepairCommand(opts: WorktreeRepairOptions): number {
  const { cwd, nowFn, env, out, err, showData } = setupIO(opts);
  const dryRun = opts.dryRun === true;
  const ctx = resolveCawsCtx(cwd, err, showData, 'repair');
  if (ctx === null) return 2;

  // Run the exact doctor pipeline — repair consumes doctor evidence, it does
  // not maintain its own state model.
  let findings: readonly DoctorFinding[];
  try {
    const { doctorInput } = composeDoctorSnapshot({
      repoRoot: ctx.repoRoot,
      cawsDir: ctx.cawsDir,
      now: nowFn(),
    });
    findings = inspectProjectState(doctorInput).findings;
  } catch (e) {
    err(`caws worktree repair: doctor composition failed: ${(e as Error).message}`);
    return 2;
  }

  // Actor + ownership candidates (only needed for an actual mutation, but
  // resolving up front keeps the dispatch loop simple and lets dry-run report
  // accurately even when no mutation will occur).
  const id = buildActorPair(ctx.cawsDir, cwd, env, nowFn, opts.actorKind, err, showData, 'repair');
  if (id === null) return 2;
  const sessionCandidates = resolveSessionCandidates({ cawsDir: ctx.cawsDir, env });

  let repaired = 0;
  let refused = 0;
  let failed = 0;

  for (const finding of findings) {
    const decision = decideRepair(finding);
    if (decision.kind === 'ignore') continue;

    if (decision.kind === 'refuse') {
      refused += 1;
      out(`REFUSE ${finding.subject ?? finding.rule}: ${decision.reason}`);
      continue;
    }

    if (decision.kind === 'prune_ghost_registry') {
      const verb = dryRun ? 'WOULD PRUNE' : 'PRUNE';
      out(
        `${verb} ${decision.worktreeName} (H1 ghost_registry): remove registry entry; ` +
          'append worktree_pruned.'
      );
      const result = pruneWorktree(ctx.cawsDir, {
        name: decision.worktreeName,
        session: id.session,
        sessionCandidates,
        actor: id.actor,
        reason: 'caws worktree repair: H1 ghost registry entry (backing dir absent).',
        now: nowFn,
        dryRun,
      });
      if (!isOk(result)) {
        failed += 1;
        err(`  failed: ${decision.worktreeName}`);
        err(renderDiagnostics(result.errors, { showData }));
        continue;
      }
      if (result.value.kind === 'partial_failure_recovered') {
        failed += 1;
        err(`  partial failure recovered (no state change): ${decision.worktreeName}`);
        continue;
      }
      repaired += 1;
      continue;
    }

    // clear_spec_binding (H4 / H3-dormant)
    const verb = dryRun ? 'WOULD CLEAR' : 'CLEAR';
    out(
      `${verb} ${decision.specId} (${decision.hClass}): clear stale worktree: field ` +
        `(was "${decision.worktreeName}"); append spec_binding_cleared.`
    );
    const result = clearSpecBinding(ctx.cawsDir, {
      id: decision.specId,
      clearedWorktreeName: decision.worktreeName,
      hClass: decision.hClass,
      reason: `caws worktree repair: ${decision.hClass} (dead spec->worktree binding).`,
      actor: id.actor,
      now: nowFn,
      dryRun,
    });
    if (!isOk(result)) {
      failed += 1;
      err(`  failed: ${decision.specId}`);
      err(renderDiagnostics(result.errors, { showData }));
      continue;
    }
    repaired += 1;
  }

  const verb = dryRun ? 'planned' : 'applied';
  out(
    `caws worktree repair: ${repaired} ${verb}, ${refused} refused, ${failed} failed ` +
      `(${dryRun ? 'dry-run — nothing mutated' : 'mutations committed via lifecycle transaction'}).`
  );
  // Exit non-zero when any repair failed (an honest operation error). A pure
  // refusal set is exit 0: refusing an ambiguous class is correct behavior, not
  // a failure. dry-run is always exit 0 (it reports, never fails).
  return failed > 0 && !dryRun ? 1 : 0;
}
