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

import * as path from 'node:path';

import { type ActorKind, isOk } from '@paths.design/caws-kernel';

import { resolveRepoRoot } from '../../store';
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

export interface WorktreeListOptions extends BaseCommandOptions {}

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
