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

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  type ActorKind,
  type DoctorFinding,
  DOCTOR_RULES,
  inspectProjectState,
  isOk,
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
} from '../../store/worktrees-writer';
import { clearSpecBinding } from '../../store/specs-writer';
import { buildActor } from '../session/actor';
import { resolveSession, resolveSessionCandidates } from '../session/resolve-session';
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
 */
function decideRepair(finding: DoctorFinding): RepairDecision {
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
