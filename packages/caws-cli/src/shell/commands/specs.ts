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

import { resolveRepoRoot, runSpecsMigrateApply } from '../../store';
import type {
  MigrationReport,
  SpecsMigrateApplyResult,
} from '../../store';
import {
  activateSpec,
  amendScopeSpec,
  archiveSpec,
  closeSpec,
  createSpec,
  listSpecs,
  pruneArchive,
  recoverArchivedSpec,
  retireDraftSpec,
  showSpec,
} from '../../store/specs-writer';
import type { LifecycleMapping } from '@paths.design/caws-kernel';
import { SPEC_MODES, SPEC_RESOLUTIONS } from '@paths.design/caws-kernel';
import * as fs from 'node:fs';
import { buildActor } from '../session/actor';
import { resolveSession } from '../session/resolve-session';
import { renderDiagnostics } from '../render/diagnostic';

// --mode / --resolution validation reads the kernel's single enum source
// (SPEC_MODES / SPEC_RESOLUTIONS) rather than re-declaring the values here.
// This eliminated the prior local VALID_MODES / VALID_RESOLUTIONS duplicate
// (CAWS-CLI-HELP-METADATA-AUTHORITY-001). The kernel arrays mirror
// spec.v1.json, which remains the validation authority.
const VALID_MODES = SPEC_MODES;
type ValidMode = (typeof VALID_MODES)[number];

const VALID_RESOLUTIONS = SPEC_RESOLUTIONS;
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

/**
 * Surface a non-landed audit commit. The lifecycle YAML change has been
 * applied to the working tree (the transaction succeeded), but the
 * automatic audit commit did NOT land — typically because the target was
 * dirty before the write, or a consumer pre-commit hook refused. A
 * lifecycle command MUST NOT print a bare success line while leaving the
 * change uncommitted: the user has to know to commit it manually, or the
 * spec sits dirty and the next session inherits ambiguous state.
 *
 * Emits the warning on stderr only; does NOT change the command's exit
 * code. The lifecycle OPERATION succeeded (the YAML change is on disk);
 * whether the audit COMMIT landed is a separate fact, surfaced loudly but
 * never turned into a command failure. Flipping the exit code conflates
 * the two and breaks callers that legitimately run where the repo cannot
 * auto-commit. (CAWS-AUTOCOMMIT-INTEGRITY-001 surfaced it;
 * CAWS-AUTOCOMMIT-INTEGRITY-002 corrected the exit-code policy.)
 */
function surfaceAuditCommit(
  auditCommit: { readonly kind: string; readonly reason?: string } | undefined,
  err: (s: string) => void
): void {
  if (auditCommit !== undefined && auditCommit.kind === 'refused_dirty') {
    err('caws specs: the lifecycle change was applied but NOT committed.');
    if (auditCommit.reason !== undefined && auditCommit.reason.length > 0) {
      err(`  reason: ${auditCommit.reason}`);
    }
    err(
      '  The spec YAML is changed in your working tree but the audit commit ' +
        'did not land. Commit it manually (git add <spec> && git commit), ' +
        'then verify with git log.'
    );
  }
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
  readonly title?: string;
  readonly mode?: string;
  readonly riskTier?: number | string;
  readonly legacyType?: string;
  /**
   * Repeatable --scope-in <path>. When supplied, scope.in is written with the
   * given paths at creation time, so the spec ships ready to enforce
   * (CAWS-SPECS-CREATE-SCOPE-IN-001).
   */
  readonly scopeIn?: readonly string[];
}

const SPECS_CREATE_USAGE = [
  'Usage:',
  '  caws specs create <id> --title "<short title>" --mode <feature|refactor|fix|doc|chore> --risk-tier <1|2|3> [--scope-in <path>]...',
  '',
  'Example:',
  '  caws specs create FEAT-001 --title "Trivial first slice" --mode chore --risk-tier 3',
  '  caws specs create FEAT-002 --title "Render slice" --mode feature --risk-tier 3 --scope-in src/render.js --scope-in tests/render.test.js',
  '',
  'Notes:',
  '  --type is not supported in v11. Use --mode instead.',
  '  Risk tier 3 is appropriate for docs, tests, harnesses, and low-blast-radius slices.',
  '  --scope-in (repeatable) writes scope.in at creation time, so you never hand-edit it.',
  '  To widen scope later, use `caws specs amend-scope <id> --add <path>` (governed; no hand-edit).',
  '  Invariants and acceptance still need filling in via the spec YAML before iteration.',
].join('\n');

export function runSpecsCreateCommand(opts: SpecsCreateOptions): number {
  const { cwd, nowFn, env, out, err, showData } = setupIO(opts);

  if (opts.legacyType !== undefined) {
    err('caws specs create: --type is not supported in v11. Use --mode instead.');
    err(SPECS_CREATE_USAGE);
    return 1;
  }

  const missing = [
    opts.title === undefined ? '--title' : undefined,
    opts.mode === undefined ? '--mode' : undefined,
    opts.riskTier === undefined ? '--risk-tier' : undefined,
  ].filter((v): v is string => v !== undefined);
  if (missing.length > 0) {
    err(`caws specs create: missing required options: ${missing.join(', ')}`);
    err(SPECS_CREATE_USAGE);
    return 1;
  }

  const title = opts.title;
  const mode = opts.mode;
  const rawRiskTier = opts.riskTier;
  if (title === undefined || mode === undefined || rawRiskTier === undefined) {
    err('caws specs create: missing required options.');
    err(SPECS_CREATE_USAGE);
    return 1;
  }

  if (!VALID_MODES.includes(mode as ValidMode)) {
    err(
      `caws specs create: invalid --mode "${mode}". Expected one of: ${VALID_MODES.join(', ')}.`
    );
    return 1;
  }
  const riskTier = typeof rawRiskTier === 'string'
    ? Number.parseInt(rawRiskTier, 10)
    : rawRiskTier;
  if (riskTier !== 1 && riskTier !== 2 && riskTier !== 3) {
    err(
      `caws specs create: invalid --risk-tier "${rawRiskTier}". Expected 1, 2, or 3.`
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
    title,
    mode: mode as ValidMode,
    riskTier: riskTier as 1 | 2 | 3,
    initialState: 'active',
    now: nowFn,
    actor,
    ...(opts.scopeIn !== undefined && opts.scopeIn.length > 0
      ? { scopeIn: opts.scopeIn }
      : {}),
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
  // CAWS-SPECS-CREATE-SCOPE-IN-001: when --scope-in was supplied, scope.in is
  // already populated in the created spec, so the guidance must NOT tell the
  // user to hand-edit the YAML to set it — that instruction is the very
  // silent-failure surface this slice removes. Branch the guidance: confirm
  // the populated scope and point at `caws specs amend-scope` for later
  // widening (the governed mutation), instead of a raw YAML edit.
  //
  // CAWS-SPEC-CREATE-FIRSTTIMER-UX-001 A3: do NOT over-promise enforcement.
  // The previous hint claimed "scope-guard rejects every edit", but a fresh
  // spec on the main checkout is `binding: unbound`, and scope-guard FAILS
  // OPEN when it cannot decide authority (scope.no_authority.unbound) — so
  // edits on main are NOT rejected by scope-guard. scope.in enforcement is
  // authoritative inside the spec's bound worktree; base-branch writes are
  // governed by the worktree-write-guard, not scope-guard. State that truth.
  const scopeInWasPopulated =
    opts.scopeIn !== undefined && opts.scopeIn.length > 0;
  out('');
  // CAWS-SPECS-CREATE-COMMIT-BEFORE-WORKTREE-GUIDANCE-001: both branches must
  // tell the first-timer to COMMIT the spec (after filling in the body) BEFORE
  // `caws worktree create`. The body fields (invariants/acceptance) have no CLI
  // setter and are hand-edited, which leaves the spec YAML dirty; walking that
  // dirty tree straight into `worktree create` produces the confusing "the
  // transition was applied but NOT committed" warning. Committing first keeps
  // the audit commit clean. We also name how to inspect the filled-in spec —
  // there is intentionally no `caws specs validate` verb in v11.
  if (scopeInWasPopulated) {
    out('Next: scope.in is set from --scope-in. Fill in invariants + acceptance, then:');
    out(
      `  1. caws specs show ${outcome.id}   (re-read the spec; or run \`caws doctor\` to check for drift)`
    );
    out(
      `  2. git add .caws/specs/${outcome.id}.yaml && git commit   (commit BEFORE the worktree so its audit commit is clean)`
    );
    out(
      `  3. caws worktree create <name> --spec ${outcome.id}   (binds + enforces scope.in)`
    );
    out(
      '  Later: caws specs amend-scope ' +
        outcome.id +
        ' --add <path>   (the governed way to widen scope — no hand-edit)'
    );
  } else {
    out('Next: set scope.in via the governed mutation, not a raw YAML edit:');
    out(
      '  1. caws specs amend-scope ' +
        outcome.id +
        ' --add <path> --add <path>   (writes canonical, appends an audit event)'
    );
    out('  2. Fill in invariants + acceptance, then inspect with `caws specs show ' +
        outcome.id +
        '` (or `caws doctor`).');
    out(
      `  3. git add .caws/specs/${outcome.id}.yaml && git commit   (commit BEFORE the worktree so its audit commit is clean)`
    );
    out(`  4. caws worktree create <name> --spec ${outcome.id}`);
    out(
      '  (scope.in is authoritative inside that worktree; base-branch writes are'
    );
    out('  governed by the worktree-write-guard, not scope.in.)');
  }
  out(
    '  Tier 1/2 specs also require a `contract` — see docs/guides/caws-contracts.md.'
  );
  surfaceAuditCommit(outcome.data?.audit_commit, err);
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
    out('-- archived (recoverable from history) --');
    for (const entry of archived) {
      const blobDisplay = entry.blob_sha !== null
        ? `blob ${entry.blob_sha.slice(0, 8)}`
        : 'legacy (no blob_sha; use git log --follow)';
      out(`${entry.id.padEnd(28)} archived ${entry.archived_at}  ${blobDisplay}`);
      out(`  recover: caws specs recover ${entry.id}`);
    }
  }
  return 0;
}

// ─── caws specs show ──────────────────────────────────────────────────────

export interface SpecsShowOptions extends BaseCommandOptions {
  readonly id: string;
  /**
   * CAWS-ARCHIVE-AS-TOMBSTONE-001: when true, look up the spec body
   * via the event log + git blob_sha (recoverArchivedSpec). Default
   * false → showSpec walks only the active path. This split makes the
   * archive surface explicit, eliminating the v11.1.x transparent
   * fallback that surfaced archived specs as if they were current.
   */
  readonly archived?: boolean;
}

export function runSpecsShowCommand(opts: SpecsShowOptions): number {
  const { cwd, out, err, showData } = setupIO(opts);
  const ctx = resolveCawsCtx(cwd, err, showData, 'show');
  if (ctx === null) return 2;

  if (opts.archived === true) {
    const result = recoverArchivedSpec(ctx.cawsDir, opts.id);
    if (!isOk(result)) {
      err('caws specs show: failed.');
      err(renderDiagnostics(result.errors, { showData }));
      return 1;
    }
    out(result.value.source);
    return 0;
  }

  const result = showSpec(ctx.cawsDir, opts.id);
  if (!isOk(result)) {
    err('caws specs show: failed.');
    err(renderDiagnostics(result.errors, { showData }));
    return 1;
  }
  out(result.value.source);
  return 0;
}

// ─── caws specs recover ──────────────────────────────────────────────────
//
// CAWS-ARCHIVE-AS-TOMBSTONE-001: dedicated command for recovering an
// archived spec body via the event log's blob_sha + git show. Distinct
// from `show --archived` for callers who think of recovery as a
// first-class operation (e.g. piping into an editor, writing to a
// specific path). Either surface returns the same bytes; both delegate
// to recoverArchivedSpec.

export interface SpecsRecoverOptions extends BaseCommandOptions {
  readonly id: string;
  /**
   * When set, write the recovered body to this path instead of stdout.
   * Named `outPath` (not `out`) to avoid shadowing
   * BaseCommandOptions.out, which is the stdout-writer callback.
   */
  readonly outPath?: string;
}

export function runSpecsRecoverCommand(opts: SpecsRecoverOptions): number {
  const { cwd, out: stdoutFn, err, showData } = setupIO(opts);
  const ctx = resolveCawsCtx(cwd, err, showData, 'recover');
  if (ctx === null) return 2;

  const result = recoverArchivedSpec(ctx.cawsDir, opts.id);
  if (!isOk(result)) {
    err('caws specs recover: failed.');
    err(renderDiagnostics(result.errors, { showData }));
    return 1;
  }

  if (typeof opts.outPath === 'string' && opts.outPath.length > 0) {
    try {
      fs.writeFileSync(opts.outPath, result.value.source);
      stdoutFn(`recovered ${opts.id} to ${opts.outPath}`);
    } catch (e) {
      err(`caws specs recover: failed to write to ${opts.outPath}: ${(e as Error).message}`);
      return 1;
    }
  } else {
    stdoutFn(result.value.source);
  }
  return 0;
}

// ─── caws specs activate ──────────────────────────────────────────────────

export interface SpecsActivateOptions extends BaseCommandOptions {
  readonly id: string;
}

export function runSpecsActivateCommand(opts: SpecsActivateOptions): number {
  const { cwd, nowFn, env, out, err, showData } = setupIO(opts);

  const ctx = resolveCawsCtx(cwd, err, showData, 'activate');
  if (ctx === null) return 2;

  const actor = buildActorOrError(
    ctx.cawsDir, cwd, env, nowFn, opts.actorKind, err, showData, 'activate'
  );
  if (actor === null) return 2;

  const result = activateSpec(ctx.cawsDir, {
    id: opts.id,
    now: nowFn,
    actor,
  });
  if (!isOk(result)) {
    err('caws specs activate: failed.');
    err(renderDiagnostics(result.errors, { showData }));
    return 1;
  }
  const outcome = result.value;
  if (outcome.kind === 'partial_failure_recovered') {
    err('caws specs activate: partial failure recovered (no state change).');
    err(renderDiagnostics(outcome.cause, { showData }));
    return 1;
  }
  out(`activated ${outcome.id}`);
  surfaceAuditCommit(outcome.data?.audit_commit, err);
  return 0;
}

// ─── caws specs amend-scope ──────────────────────────────────────────────

export interface SpecsAmendScopeOptions extends BaseCommandOptions {
  readonly id: string;
  readonly addIn?: readonly string[];
  readonly removeIn?: readonly string[];
  readonly addOut?: readonly string[];
  readonly removeOut?: readonly string[];
  readonly addSupport?: readonly string[];
  readonly removeSupport?: readonly string[];
}

export function runSpecsAmendScopeCommand(opts: SpecsAmendScopeOptions): number {
  const { cwd, nowFn, env, out, err, showData } = setupIO(opts);

  const ctx = resolveCawsCtx(cwd, err, showData, 'amend-scope');
  if (ctx === null) return 2;

  const actor = buildActorOrError(
    ctx.cawsDir, cwd, env, nowFn, opts.actorKind, err, showData, 'amend-scope'
  );
  if (actor === null) return 2;

  const result = amendScopeSpec(ctx.cawsDir, {
    id: opts.id,
    ...(opts.addIn !== undefined ? { addIn: opts.addIn } : {}),
    ...(opts.removeIn !== undefined ? { removeIn: opts.removeIn } : {}),
    ...(opts.addOut !== undefined ? { addOut: opts.addOut } : {}),
    ...(opts.removeOut !== undefined ? { removeOut: opts.removeOut } : {}),
    ...(opts.addSupport !== undefined ? { addSupport: opts.addSupport } : {}),
    ...(opts.removeSupport !== undefined ? { removeSupport: opts.removeSupport } : {}),
    now: nowFn,
    actor,
  });
  if (!isOk(result)) {
    err('caws specs amend-scope: failed.');
    err(renderDiagnostics(result.errors, { showData }));
    return 1;
  }
  const outcome = result.value;
  if (outcome.kind === 'partial_failure_recovered') {
    err('caws specs amend-scope: partial failure recovered (no state change).');
    err(renderDiagnostics(outcome.cause, { showData }));
    return 1;
  }
  out(`amended scope for ${outcome.id}`);
  surfaceAuditCommit(outcome.data?.audit_commit, err);
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
  surfaceAuditCommit(outcome.data?.audit_commit, err);
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
  surfaceAuditCommit(outcome.data?.audit_commit, err);
  return 0;
}

// ─── caws specs retire-draft (CAWS-SPECS-RETIRE-DRAFT-001) ─────────────────

export interface SpecsRetireDraftOptions extends BaseCommandOptions {
  readonly id: string;
  readonly reason?: string;
}

export function runSpecsRetireDraftCommand(
  opts: SpecsRetireDraftOptions
): number {
  const { cwd, nowFn, env, out, err, showData } = setupIO(opts);

  const ctx = resolveCawsCtx(cwd, err, showData, 'retire-draft');
  if (ctx === null) return 2;

  const actor = buildActorOrError(
    ctx.cawsDir, cwd, env, nowFn, opts.actorKind, err, showData, 'retire-draft'
  );
  if (actor === null) return 2;

  const input: Parameters<typeof retireDraftSpec>[1] = {
    id: opts.id,
    now: nowFn,
    actor,
  };
  if (opts.reason !== undefined) (input as { reason?: string }).reason = opts.reason;

  const result = retireDraftSpec(ctx.cawsDir, input);
  if (!isOk(result)) {
    err('caws specs retire-draft: failed.');
    err(renderDiagnostics(result.errors, { showData }));
    return 1;
  }
  const outcome = result.value;
  if (outcome.kind === 'partial_failure_recovered') {
    err('caws specs retire-draft: partial failure recovered (no state change).');
    err(renderDiagnostics(outcome.cause, { showData }));
    return 1;
  }
  out(`retired draft ${outcome.id} (recoverable via caws specs show ${outcome.id} --archived)`);
  surfaceAuditCommit(outcome.data?.audit_commit, err);
  return 0;
}

// ---------------------------------------------------------------------------
// caws specs migrate — adapter for runSpecsMigrateApply.
//
// Adapter discipline: this command parses flags, loads the optional
// lifecycle-mapping file, delegates to the store, renders. It does NOT
// duplicate transformer or store authority. The substrate assertion
// (cawsDir basename === '.caws') lives in the store; this shell just
// surfaces the diagnostic. Lifecycle-mapping semantics — e.g. that a
// mapped 'archived'/'closed' lifecycle requires the operator to also
// supply 'resolution' — are owned by the kernel/store; the shell does
// not auto-default.
//
// Per the spec (CAWS-MIGRATE-V10-SPECS-001 A12 / Sterling smoke):
//   - --from v10 is the only supported source in v11.2.
//   - default is dry-run (no writes); --apply opts into mutation.
//   - --apply alone refuses on any 'refused' verdict.
//   - --apply --partial writes migratable, skips refused, emits report.
//   - --lifecycle-mapping <path> supplies a JSON file: { <spec_id>: { lifecycle_state, resolution?, closure_notes? } }.
//   - --json emits a single JSON object to stdout instead of human-rendered text.
//
// Exit codes:
//   0 = success (dry-run completed OR --apply succeeded)
//   1 = store-layer refusal (substrate / refusals_present / report_write_failed)
//   2 = composition failure (repo-root, lifecycle-mapping file IO/parse)
// ---------------------------------------------------------------------------

export interface SpecsMigrateOptions extends BaseCommandOptions {
  readonly from: string;
  readonly apply?: boolean;
  readonly partial?: boolean;
  readonly lifecycleMappingPath?: string;
  readonly json?: boolean;
}

export function runSpecsMigrateCommand(opts: SpecsMigrateOptions): number {
  const { cwd, nowFn, out, err, showData } = setupIO(opts);

  // --from must be exactly 'v10' (matches caws events migrate semantics).
  if (opts.from !== 'v10') {
    err(
      `caws specs migrate: only --from v10 is supported in v11.2; got ${JSON.stringify(opts.from)}.`,
    );
    return 1;
  }

  const ctx = resolveCawsCtx(cwd, err, showData, 'migrate');
  if (ctx === null) return 2;

  // Load optional lifecycle mapping file. Composition failure (file
  // missing, unreadable, malformed JSON) is exit 2 — we cannot
  // proceed with an incomplete operator decision.
  let lifecycleMapping: LifecycleMapping | undefined;
  if (opts.lifecycleMappingPath !== undefined) {
    const loadResult = loadLifecycleMappingFile(opts.lifecycleMappingPath);
    if (!loadResult.ok) {
      err(`caws specs migrate: failed to load --lifecycle-mapping file.`);
      err(loadResult.message);
      return 2;
    }
    lifecycleMapping = loadResult.mapping;
  }

  // Delegate to the store.
  const result = runSpecsMigrateApply({
    cawsDir: ctx.cawsDir,
    from: 'v10',
    apply: opts.apply === true,
    partial: opts.partial === true,
    now: nowFn(),
    ...(lifecycleMapping !== undefined ? { lifecycleMapping } : {}),
  });

  if (!result.ok) {
    if (opts.json === true) {
      out(
        JSON.stringify(
          {
            ok: false,
            errors: result.errors.map((d) => ({
              rule: d.rule,
              message: d.message,
              ...(d.data !== undefined ? { data: d.data } : {}),
            })),
          },
          null,
          2,
        ),
      );
    } else {
      err('caws specs migrate: failed.');
      err(renderDiagnostics(result.errors, { showData }));
    }
    return 1;
  }

  if (opts.json === true) {
    renderApplyJson(result.value, out);
  } else {
    renderApplyHuman(result.value, ctx.repoRoot, opts.apply === true, out);
  }
  return 0;
}

function loadLifecycleMappingFile(
  filePath: string,
): { ok: true; mapping: LifecycleMapping } | { ok: false; message: string } {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    const cause = e as { message?: string; code?: string };
    return {
      ok: false,
      message: `Cannot read ${filePath}: ${cause.message ?? 'unknown error'} (${cause.code ?? 'unknown code'}).`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    const cause = e as { message?: string };
    return {
      ok: false,
      message: `Cannot parse ${filePath} as JSON: ${cause.message ?? 'unknown error'}.`,
    };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      message: `Lifecycle mapping file ${filePath} must be a JSON object keyed by spec id; got ${typeof parsed === 'object' ? 'array' : typeof parsed}.`,
    };
  }
  // Lightweight shape check — every value should be an object with a
  // lifecycle_state field. Kernel will do strict validation when
  // applying; this is enough to fail fast on obviously-wrong input.
  for (const [specId, entry] of Object.entries(parsed)) {
    if (typeof entry !== 'object' || entry === null) {
      return {
        ok: false,
        message: `Lifecycle mapping entry "${specId}" is not an object.`,
      };
    }
    const e = entry as Record<string, unknown>;
    if (typeof e['lifecycle_state'] !== 'string') {
      return {
        ok: false,
        message: `Lifecycle mapping entry "${specId}" is missing required string field "lifecycle_state".`,
      };
    }
  }
  return { ok: true, mapping: parsed as LifecycleMapping };
}

function renderApplyHuman(
  result: SpecsMigrateApplyResult,
  repoRoot: string,
  applied: boolean,
  out: (line: string) => void,
): void {
  const tag = applied ? '[apply]' : '[dry-run]';
  const r: MigrationReport = result.report;
  out(`${tag} caws specs migrate --from v10`);
  out(
    `  distribution: migrated=${r.distribution.migrated} migrated_with_warnings=${r.distribution.migrated_with_warnings} refused=${r.distribution.refused} post_write_validation_failed=${r.distribution.post_write_validation_failed} total=${r.distribution.total}`,
  );
  if (r.non_yaml_observations.length > 0) {
    out(`  non_yaml observations:`);
    for (const obs of r.non_yaml_observations) {
      out(`    - ${obs.file} (${obs.kind})`);
    }
  }
  // Per-entry summary. Operator sees what's actionable; full detail is
  // in the durable report (and --json).
  for (const e of r.entries) {
    const tagPrefix = entryTag(e.verdict);
    const idStr = e.spec_id ?? '(no id)';
    out(`  ${tagPrefix} ${e.file} (${idStr}) — ${e.verdict}`);
    if (e.verdict === 'refused' && e.refusal_reasons.length > 0) {
      for (const reason of e.refusal_reasons) {
        out(`      reason: ${reason}`);
      }
    }
    if (e.verdict === 'post_write_validation_failed' && e.post_write_validation_errors.length > 0) {
      for (const v of e.post_write_validation_errors) {
        out(`      validation: ${v.rule}: ${v.message}`);
      }
    }
  }
  if (result.report_path !== null) {
    out(`  report: ${path.relative(repoRoot, result.report_path)}`);
  } else {
    out(`  report: (dry-run; not persisted)`);
  }
}

function entryTag(verdict: string): string {
  switch (verdict) {
    case 'migrated':
      return 'OK   ';
    case 'migrated_with_warnings':
      return 'WARN ';
    case 'refused':
      return 'REF  ';
    case 'post_write_validation_failed':
      return 'PWF  ';
    default:
      return '?    ';
  }
}

function renderApplyJson(
  result: SpecsMigrateApplyResult,
  out: (line: string) => void,
): void {
  // Preserve the store's report shape verbatim (per the contract
  // spec-v10-migration-output). Do not invent a second report shape.
  out(
    JSON.stringify(
      {
        ok: true,
        cawsDir: result.cawsDir,
        partial: result.partial,
        report_path: result.report_path,
        report: result.report,
      },
      null,
      2,
    ),
  );
}

// ─── caws specs prune-archive (CAWS-ARCHIVE-AS-TOMBSTONE-001 A8/A9) ─────
//
// Migrates legacy .caws/specs/.archive/<id>.yaml bodies. Dry-run by
// default; --apply executes. The prove-recovery-or-quarantine
// invariant is absolute — there is NO override flag that would let
// prune delete an unrecoverable body.

export interface SpecsPruneArchiveOptions extends BaseCommandOptions {
  /** Default false → dry-run. Pass true to mutate the filesystem. */
  readonly apply?: boolean;
}

export function runSpecsPruneArchiveCommand(opts: SpecsPruneArchiveOptions): number {
  const { cwd, nowFn, env, out, err, showData } = setupIO(opts);
  const ctx = resolveCawsCtx(cwd, err, showData, 'prune-archive');
  if (ctx === null) return 2;

  const actor = buildActorOrError(
    ctx.cawsDir,
    cwd,
    env,
    nowFn,
    opts.actorKind,
    err,
    showData,
    'prune-archive'
  );
  if (actor === null) return 2;

  const result = pruneArchive(ctx.cawsDir, {
    apply: opts.apply === true,
    actor,
    now: nowFn,
  });
  if (!isOk(result)) {
    err('caws specs prune-archive: failed.');
    err(renderDiagnostics(result.errors, { showData }));
    return 1;
  }

  const { plans, applied, events_appended } = result.value;
  if (plans.length === 0) {
    out('caws specs prune-archive: no legacy .caws/specs/.archive/ bodies to prune.');
    return 0;
  }

  const recoverable = plans.filter((p) => p.status === 'recoverable');
  const unrecoverable = plans.filter((p) => p.status === 'unrecoverable');
  const verb = applied ? 'Pruned' : 'Would prune';
  out(`${verb} ${plans.length} legacy archive bodies (${recoverable.length} recoverable, ${unrecoverable.length} unrecoverable):`);
  for (const plan of plans) {
    if (plan.status === 'recoverable') {
      const action = applied ? 'REMOVED' : 'would remove';
      out(`  - ${plan.id}: RECOVERABLE — ${action} (blob ${plan.blob_sha.slice(0, 8)} at commit ${plan.commit_sha.slice(0, 8)})`);
    } else {
      const action = applied ? 'QUARANTINED' : 'would quarantine';
      out(`  - ${plan.id}: UNRECOVERABLE — ${action} to .archive/.unrecoverable/${plan.id}.yaml (${plan.reason})`);
    }
  }
  if (applied) {
    out(`Appended ${events_appended} spec_archive_pruned events.`);
  } else {
    out('Dry-run complete. Pass --apply to execute. Unrecoverable bodies will be quarantined (never silently deleted); recoverable bodies will be removed (recoverable via caws specs recover <id>).');
  }
  return 0;
}
