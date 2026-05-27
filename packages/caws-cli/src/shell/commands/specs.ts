// `caws specs` command group — v11 spec lifecycle commands.
//
// CLI-SPECS-001: the canonical replacement for manual lifecycle YAML
// edits. Five subcommands:
//   - caws specs create <id> --title <title> --mode <mode> --risk-tier <n>
//   - caws specs list [--archived]
//   - caws specs show <id>
//   - caws specs close <id> --resolution <r> [--reason <text>] [--merge-commit <sha>] [--superseded-by <id>]
//   - caws specs archive <id> [--reason <text>]
//
// Discipline:
//   - All mutation paths go through specs-writer (which uses the
//     lifecycle-transaction substrate from Slice 4).
//   - The shell never appends events directly. Event append happens
//     inside the writer, which routes through appendEvent.
//   - The shell never patches YAML directly. yaml-patch lives in the
//     store layer.
//   - The shell parses CLI args, builds an actor envelope, calls the
//     writer, and renders the outcome.

import * as path from 'node:path';

import { isOk, type Actor, type ActorKind } from '@paths.design/caws-kernel';

import { resolveRepoRoot } from '../../store';
import {
  archiveSpec,
  closeSpec,
  createSpec,
  listSpecs,
  showSpec,
} from '../../store/specs-writer';
import { buildActor } from '../session/actor';
import { resolveSession } from '../session/resolve-session';
import { renderDiagnostics } from '../render/diagnostic';

const VALID_MODES = ['feature', 'refactor', 'fix', 'doc', 'chore'] as const;
type ValidMode = (typeof VALID_MODES)[number];

const VALID_RESOLUTIONS = ['completed', 'superseded', 'abandoned'] as const;
type ValidResolution = (typeof VALID_RESOLUTIONS)[number];

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
    errFn(`caws specs ${cmd}: failed to resolve repo root.`);
    errFn(renderDiagnostics(r.errors, { showData }));
    return null;
  }
  return { repoRoot: r.value.repoRoot, cawsDir: r.value.cawsDir };
}

function buildActorOrError(
  cawsDir: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  nowFn: () => Date,
  actorKind: ActorKind | undefined,
  errFn: (line: string) => void,
  showData: boolean,
  cmd: string
): Actor | null {
  const sessionResult = resolveSession({
    cawsDir,
    worktreeRoot: cwd,
    env,
    now: nowFn,
    allowMint: true,
  });
  if (!sessionResult.ok) {
    errFn(`caws specs ${cmd}: failed to resolve session identity.`);
    errFn(renderDiagnostics(sessionResult.errors, { showData }));
    return null;
  }
  return buildActor({
    session: sessionResult.value,
    kind: actorKind ?? 'agent',
  });
}

// ─── caws specs create ────────────────────────────────────────────────────

export interface SpecsCreateOptions extends BaseCommandOptions {
  readonly id: string;
  readonly title: string;
  readonly mode: string;
  readonly riskTier: number | string;
}

export function runSpecsCreateCommand(opts: SpecsCreateOptions): number {
  const { cwd, nowFn, env, out, err, showData } = setupIO(opts);

  if (!VALID_MODES.includes(opts.mode as ValidMode)) {
    err(
      `caws specs create: invalid --mode "${opts.mode}". Expected one of: ${VALID_MODES.join(', ')}.`
    );
    return 1;
  }
  const riskTier = typeof opts.riskTier === 'string'
    ? Number.parseInt(opts.riskTier, 10)
    : opts.riskTier;
  if (riskTier !== 1 && riskTier !== 2 && riskTier !== 3) {
    err(
      `caws specs create: invalid --risk-tier "${opts.riskTier}". Expected 1, 2, or 3.`
    );
    return 1;
  }

  const ctx = resolveCawsCtx(cwd, err, showData, 'create');
  if (ctx === null) return 2;

  const actor = buildActorOrError(
    ctx.cawsDir, cwd, env, nowFn, opts.actorKind, err, showData, 'create'
  );
  if (actor === null) return 2;

  const result = createSpec(ctx.cawsDir, {
    id: opts.id,
    title: opts.title,
    mode: opts.mode as ValidMode,
    riskTier: riskTier as 1 | 2 | 3,
    initialState: 'active',
    now: nowFn,
    actor,
  });
  if (!isOk(result)) {
    err('caws specs create: failed.');
    err(renderDiagnostics(result.errors, { showData }));
    return 1;
  }
  const outcome = result.value;
  if (outcome.kind === 'partial_failure_recovered') {
    err('caws specs create: partial failure recovered (no state change).');
    err(renderDiagnostics(outcome.cause, { showData }));
    return 1;
  }
  const relSpecPath = path.relative(ctx.repoRoot, outcome.path);
  out(`created ${outcome.id} at ${relSpecPath} (lifecycle_state: active)`);
  // CAWS-FIRST-CONTACT-UX-001 A4: the spec ships with TODO placeholders
  // in scope.in. Until those are replaced with real file paths, scope-guard
  // will reject every edit because no path is admitted. New users hit
  // this immediately and conclude CAWS is broken.
  out('');
  out('Next: open the spec and replace TODO placeholders before editing files.');
  out(`  edit: ${relSpecPath}`);
  out('  scope.in must list the file paths your slice will touch.');
  out('  Until then, scope-guard rejects every edit (no path admitted).');
  return 0;
}

// ─── caws specs list ──────────────────────────────────────────────────────

export interface SpecsListOptions extends BaseCommandOptions {
  /** Include archived specs in the listing. */
  readonly includeArchived?: boolean;
}

export function runSpecsListCommand(opts: SpecsListOptions = {}): number {
  const { cwd, out, err, showData } = setupIO(opts);
  const ctx = resolveCawsCtx(cwd, err, showData, 'list');
  if (ctx === null) return 2;

  const result = listSpecs(ctx.cawsDir, {
    includeArchived: opts.includeArchived === true,
  });
  if (!isOk(result)) {
    err('caws specs list: failed.');
    err(renderDiagnostics(result.errors, { showData }));
    return 1;
  }
  const { active, archived } = result.value;
  if (active.length === 0 && archived.length === 0) {
    out('(no specs)');
    return 0;
  }

  for (const entry of active) {
    const rel = path.relative(ctx.repoRoot, entry.path);
    out(`${entry.id.padEnd(28)} ${entry.lifecycle_state.padEnd(8)} ${entry.title}`);
    void rel;
  }
  if (opts.includeArchived === true && archived.length > 0) {
    out('');
    out('-- archived --');
    for (const entry of archived) {
      out(`${entry.id.padEnd(28)} ${entry.lifecycle_state.padEnd(8)} ${entry.title}`);
    }
  }
  return 0;
}

// ─── caws specs show ──────────────────────────────────────────────────────

export interface SpecsShowOptions extends BaseCommandOptions {
  readonly id: string;
}

export function runSpecsShowCommand(opts: SpecsShowOptions): number {
  const { cwd, out, err, showData } = setupIO(opts);
  const ctx = resolveCawsCtx(cwd, err, showData, 'show');
  if (ctx === null) return 2;

  const result = showSpec(ctx.cawsDir, opts.id);
  if (!isOk(result)) {
    err('caws specs show: failed.');
    err(renderDiagnostics(result.errors, { showData }));
    return 1;
  }
  // Print the raw source so the user gets byte-faithful output
  // (comments preserved, etc).
  out(result.value.source);
  return 0;
}

// ─── caws specs close ─────────────────────────────────────────────────────

export interface SpecsCloseOptions extends BaseCommandOptions {
  readonly id: string;
  readonly resolution: string;
  readonly reason?: string;
  readonly mergeCommit?: string;
  readonly supersededBy?: string;
}

export function runSpecsCloseCommand(opts: SpecsCloseOptions): number {
  const { cwd, nowFn, env, out, err, showData } = setupIO(opts);

  if (!VALID_RESOLUTIONS.includes(opts.resolution as ValidResolution)) {
    err(
      `caws specs close: invalid --resolution "${opts.resolution}". Expected one of: ${VALID_RESOLUTIONS.join(', ')}.`
    );
    return 1;
  }

  const ctx = resolveCawsCtx(cwd, err, showData, 'close');
  if (ctx === null) return 2;

  const actor = buildActorOrError(
    ctx.cawsDir, cwd, env, nowFn, opts.actorKind, err, showData, 'close'
  );
  if (actor === null) return 2;

  const input: Parameters<typeof closeSpec>[1] = {
    id: opts.id,
    resolution: opts.resolution as ValidResolution,
    now: nowFn,
    actor,
  };
  if (opts.reason !== undefined) (input as { reason?: string }).reason = opts.reason;
  if (opts.mergeCommit !== undefined) (input as { mergeCommit?: string }).mergeCommit = opts.mergeCommit;
  if (opts.supersededBy !== undefined) (input as { supersededBy?: string }).supersededBy = opts.supersededBy;

  const result = closeSpec(ctx.cawsDir, input);
  if (!isOk(result)) {
    err('caws specs close: failed.');
    err(renderDiagnostics(result.errors, { showData }));
    return 1;
  }
  const outcome = result.value;
  if (outcome.kind === 'partial_failure_recovered') {
    err('caws specs close: partial failure recovered (no state change).');
    err(renderDiagnostics(outcome.cause, { showData }));
    return 1;
  }
  out(`closed ${outcome.id} (resolution: ${opts.resolution})`);
  return 0;
}

// ─── caws specs archive ───────────────────────────────────────────────────

export interface SpecsArchiveOptions extends BaseCommandOptions {
  readonly id: string;
  readonly reason?: string;
}

export function runSpecsArchiveCommand(opts: SpecsArchiveOptions): number {
  const { cwd, nowFn, env, out, err, showData } = setupIO(opts);

  const ctx = resolveCawsCtx(cwd, err, showData, 'archive');
  if (ctx === null) return 2;

  const actor = buildActorOrError(
    ctx.cawsDir, cwd, env, nowFn, opts.actorKind, err, showData, 'archive'
  );
  if (actor === null) return 2;

  const input: Parameters<typeof archiveSpec>[1] = {
    id: opts.id,
    now: nowFn,
    actor,
  };
  if (opts.reason !== undefined) (input as { reason?: string }).reason = opts.reason;

  const result = archiveSpec(ctx.cawsDir, input);
  if (!isOk(result)) {
    err('caws specs archive: failed.');
    err(renderDiagnostics(result.errors, { showData }));
    return 1;
  }
  const outcome = result.value;
  if (outcome.kind === 'partial_failure_recovered') {
    err('caws specs archive: partial failure recovered (no state change).');
    err(renderDiagnostics(outcome.cause, { showData }));
    return 1;
  }
  out(`archived ${outcome.id} → ${path.relative(ctx.repoRoot, outcome.path)}`);
  return 0;
}
