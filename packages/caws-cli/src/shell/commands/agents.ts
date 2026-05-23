// `caws agents` command group — agent-liveness substrate operations.
//
// MULTI-AGENT-ACTIVITY-REGISTRY-001 acceptance A9–A10, A13.
//
// Subcommands:
//   - caws agents register   [--session-id <id>] [--platform <p>] [--reason <r>] [--json] [--include-active-summary]
//   - caws agents heartbeat  [--session-id <id>] [--platform <p>] [--reason <r>] [--throttle <ms>] [--json] [--include-active-summary]
//   - caws agents stop       [--session-id <id>] [--platform <p>] [--json]
//   - caws agents list       [--include-stale] [--include-stopped] [--active] [--json]
//   - caws agents show <id>  [--json]
//   - caws agents prune      [--status stopped|stale] [--older-than <ms>] [--dry-run] [--json]
//
// Hook IO boundary (load-bearing — spec invariant 5):
//   The CLI emits CAWS-native JSON ONLY. It never emits Claude Code's
//   `hookSpecificOutput` envelope, never emits `additionalContext` /
//   `permissionDecision` / `hookEventName`. The hook script (agent-
//   heartbeat.sh) is the SOLE composer of Claude Code's hook envelope.
//   A future Cursor/Codex/terminal integration consumes the same CAWS
//   JSON and emits its own envelope.
//
// Session identity resolution:
//   - When `--session-id <id>` is provided, it overrides resolveSession's
//     env-walking. The id is validated through safeLeaseFilename before
//     any I/O; 'unknown', empty, or unsafe ids are refused.
//   - When omitted, resolveSession is used (for human-invoked list/show/
//     prune that need their own identity; read-only commands skip it).
//   - Hook-invoked commands MUST pass --session-id explicitly.
//
// Read vs write semantics:
//   - register / heartbeat / stop / prune: write paths through
//     applyLeasePatch / applyLeasePatches.
//   - list / show: read-only via loadLeases + summarizeActiveAgents.

import * as fs from 'node:fs';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';

import {
  isOk,
  registerAgentSession,
  heartbeatAgentSession,
  stopAgentSession,
  summarizeActiveAgents,
  type AgentLease,
  type LeaseContext,
  type LeaseReason,
  type LeaseRegistry,
  type SessionIdentity,
} from '@paths.design/caws-kernel';

import {
  applyLeasePatch,
  loadLeases,
  pruneLeasesByStatus,
  resolveRepoRoot,
  safeLeaseFilename,
} from '../../store';
import { renderDiagnostics } from '../render/diagnostic';
import { resolveSession } from '../session/resolve-session';

// ─── shared option shape ──────────────────────────────────────────────────

interface BaseAgentsOpts {
  readonly cwd?: string;
  readonly now?: () => Date;
  readonly env?: NodeJS.ProcessEnv;
  readonly out?: (line: string) => void;
  readonly err?: (line: string) => void;
  readonly showData?: boolean;
  readonly json?: boolean;
  /** Explicit session identity (overrides resolveSession). Hook-invoked
   *  commands MUST pass this; the value is validated as a safe filename
   *  BEFORE any I/O. */
  readonly sessionId?: string;
  readonly platform?: string;
}

function setupIO(opts: BaseAgentsOpts) {
  const cwd = opts.cwd ?? process.cwd();
  const nowFn = opts.now ?? (() => new Date());
  const env = opts.env ?? process.env;
  const out = opts.out ?? ((s: string) => process.stdout.write(s + '\n'));
  const err = opts.err ?? ((s: string) => process.stderr.write(s + '\n'));
  const showData = opts.showData === true;
  const json = opts.json === true;
  return { cwd, nowFn, env, out, err, showData, json };
}

function emitJson(out: (line: string) => void, payload: unknown): void {
  out(JSON.stringify(payload, null, 2));
}

// ─── git path normalization (canonical vs worktree detection) ────────────

interface GitDirInfo {
  readonly git_common_dir: string;
  readonly git_dir: string;
  readonly branch?: string;
}

function readGitDirInfo(cwd: string): GitDirInfo | null {
  try {
    const commonDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    const gitDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-dir'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    const commonReal = realpathSafe(commonDir);
    const gitReal = realpathSafe(gitDir);
    let branch: string | undefined;
    try {
      branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    } catch {
      // Detached HEAD or other; leave branch undefined.
    }
    return {
      git_common_dir: commonReal,
      git_dir: gitReal,
      ...(branch !== undefined && branch !== '' ? { branch } : {}),
    };
  } catch {
    return null;
  }
}

function realpathSafe(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

// ─── session identity ─────────────────────────────────────────────────────

interface ResolveIdentityResult {
  readonly identity: SessionIdentity;
  readonly source: 'flag' | 'env_capsule_mint';
}

function resolveIdentityForCommand(
  opts: BaseAgentsOpts,
  ctx: { cawsDir: string; cwd: string; env: NodeJS.ProcessEnv; nowFn: () => Date },
  allowMint: boolean,
  err: (line: string) => void
): ResolveIdentityResult | null {
  if (opts.sessionId !== undefined) {
    // Explicit flag → validate as a safe filename BEFORE any I/O.
    const fnRes = safeLeaseFilename(opts.sessionId);
    if (!isOk(fnRes)) {
      err(`caws agents: invalid --session-id "${opts.sessionId}".`);
      err(renderDiagnostics(fnRes.errors, { showData: opts.showData === true }));
      return null;
    }
    return {
      identity: {
        session_id: opts.sessionId,
        platform: opts.platform ?? 'unknown',
      },
      source: 'flag',
    };
  }

  // No flag → fall through to resolveSession (env + capsule + optional mint).
  const sessionResult = resolveSession({
    cawsDir: ctx.cawsDir,
    worktreeRoot: ctx.cwd,
    env: ctx.env,
    now: ctx.nowFn,
    allowMint,
  });
  if (!isOk(sessionResult)) {
    err('caws agents: failed to resolve session identity.');
    err(renderDiagnostics(sessionResult.errors, { showData: opts.showData === true }));
    return null;
  }
  return { identity: sessionResult.value.identity, source: 'env_capsule_mint' };
}

// ─── lease context composition ────────────────────────────────────────────

function buildLeaseContext(
  cwd: string,
  repoRoot: string,
  bound: { worktree?: string; spec_id?: string } | null,
  env: NodeJS.ProcessEnv
): LeaseContext | null {
  const gitInfo = readGitDirInfo(cwd);
  if (gitInfo === null) return null;

  const sessionLogPath =
    typeof env['HOOK_SESSION_LOG_PATH'] === 'string' && env['HOOK_SESSION_LOG_PATH'].length > 0
      ? env['HOOK_SESSION_LOG_PATH']
      : undefined;

  return {
    repo_root: repoRoot,
    cwd,
    git_common_dir: gitInfo.git_common_dir,
    git_dir: gitInfo.git_dir,
    ...(gitInfo.branch !== undefined ? { branch: gitInfo.branch } : {}),
    ...(bound?.worktree !== undefined ? { bound_worktree: bound.worktree } : {}),
    ...(bound?.spec_id !== undefined ? { bound_spec_id: bound.spec_id } : {}),
    pid: process.pid,
    hostname: os.hostname(),
    ...(sessionLogPath !== undefined ? { session_log_path: sessionLogPath } : {}),
    // hook_pack_version is omitted here — caws init's hook pack version is
    // baked into the installed managed-header at write time; the CLI does
    // not interrogate it during a single command run.
  };
}

// ─── active-summary JSON shape (CAWS-native; NEVER hook envelope) ────────

interface ActiveAgentSummaryEntry {
  readonly session_id: string;
  readonly bound_worktree: string | null;
  readonly bound_spec_id: string | null;
  readonly branch: string | null;
  readonly git_dir_kind: 'canonical' | 'worktree';
  readonly last_active_age_ms: number;
  readonly is_self: boolean;
}

interface ActiveSummary {
  readonly active_agent_count: number;
  readonly active_agents: ReadonlyArray<ActiveAgentSummaryEntry>;
}

const DEFAULT_STALE_TTL_MS = 30 * 60 * 1000; // 30m

function computeActiveSummary(
  registry: LeaseRegistry,
  selfSessionId: string,
  now: Date,
  ttlMs: number = DEFAULT_STALE_TTL_MS
): ActiveSummary {
  const summary = summarizeActiveAgents(registry, now, ttlMs);
  const entries: ActiveAgentSummaryEntry[] = summary.active.map((lease) => ({
    session_id: lease.session_id,
    bound_worktree: lease.bound_worktree ?? null,
    bound_spec_id: lease.bound_spec_id ?? null,
    branch: lease.branch ?? null,
    git_dir_kind: lease.git_common_dir === lease.git_dir ? 'canonical' : 'worktree',
    last_active_age_ms: Math.max(0, now.getTime() - Date.parse(lease.last_active)),
    is_self: lease.session_id === selfSessionId,
  }));
  return {
    active_agent_count: entries.length,
    active_agents: entries,
  };
}

// ─── caws agents register ─────────────────────────────────────────────────

export interface RegisterOpts extends BaseAgentsOpts {
  readonly reason?: LeaseReason;
  readonly includeActiveSummary?: boolean;
}

export function runAgentsRegisterCommand(opts: RegisterOpts = {}): number {
  const { cwd, nowFn, env, out, err, showData, json } = setupIO(opts);

  const repoRootResult = resolveRepoRoot(cwd);
  if (!isOk(repoRootResult)) {
    err('caws agents register: failed to resolve repo root.');
    err(renderDiagnostics(repoRootResult.errors, { showData }));
    return 2;
  }
  const { repoRoot, cawsDir } = repoRootResult.value;

  const idRes = resolveIdentityForCommand(
    opts,
    { cawsDir, cwd, env, nowFn },
    /* allowMint */ true,
    err
  );
  if (idRes === null) return 1;

  const context = buildLeaseContext(cwd, repoRoot, null, env);
  if (context === null) {
    err('caws agents register: failed to read git_common_dir/git_dir (is this a git repo?).');
    return 2;
  }

  const now = nowFn();
  const reason: LeaseReason = opts.reason ?? 'manual_register';

  // Load existing registry for upsert semantics (preserves started_at).
  const loadRes = loadLeases(cawsDir);
  if (!isOk(loadRes)) {
    err('caws agents register: lease directory unreadable.');
    err(renderDiagnostics(loadRes.errors, { showData }));
    return 2;
  }
  const leases = loadRes.value.leases;

  const patchRes = registerAgentSession(leases, idRes.identity, context, now, reason);
  if (!isOk(patchRes)) {
    err('caws agents register: kernel refused.');
    err(renderDiagnostics(patchRes.errors, { showData }));
    return 1;
  }

  const applyRes = applyLeasePatch(cawsDir, patchRes.value);
  if (!isOk(applyRes)) {
    err('caws agents register: store write failed.');
    err(renderDiagnostics(applyRes.errors, { showData }));
    return 1;
  }

  const fn = safeLeaseFilename(idRes.identity.session_id);
  const leasePath = isOk(fn) ? `.caws/leases/${fn.value}` : null;

  if (json) {
    const payload: Record<string, unknown> = {
      ok: true,
      session_id: idRes.identity.session_id,
      lease_path: leasePath,
      wrote: applyRes.value.wrote,
      throttled: false,
    };
    if (opts.includeActiveSummary === true) {
      // Re-load to pick up our own write.
      const reload = loadLeases(cawsDir);
      const registry = isOk(reload) ? reload.value.leases : leases;
      Object.assign(payload, computeActiveSummary(registry, idRes.identity.session_id, now));
    }
    emitJson(out, payload);
  } else {
    out(`registered ${idRes.identity.session_id} (lease: ${leasePath ?? '?'})`);
  }
  return 0;
}

// ─── caws agents heartbeat ────────────────────────────────────────────────

export interface HeartbeatOpts extends BaseAgentsOpts {
  readonly reason?: LeaseReason;
  readonly throttleMs?: number;
  readonly includeActiveSummary?: boolean;
}

export function runAgentsHeartbeatCommand(opts: HeartbeatOpts = {}): number {
  const { cwd, nowFn, env, out, err, showData, json } = setupIO(opts);

  const repoRootResult = resolveRepoRoot(cwd);
  if (!isOk(repoRootResult)) {
    err('caws agents heartbeat: failed to resolve repo root.');
    err(renderDiagnostics(repoRootResult.errors, { showData }));
    return 2;
  }
  const { repoRoot, cawsDir } = repoRootResult.value;

  const idRes = resolveIdentityForCommand(
    opts,
    { cawsDir, cwd, env, nowFn },
    /* allowMint */ true,
    err
  );
  if (idRes === null) return 1;

  const context = buildLeaseContext(cwd, repoRoot, null, env);
  if (context === null) {
    err('caws agents heartbeat: failed to read git_common_dir/git_dir.');
    return 2;
  }

  const now = nowFn();
  const reason: LeaseReason = opts.reason ?? 'pre_tool_use';
  const throttleMs = opts.throttleMs ?? 0;

  const loadRes = loadLeases(cawsDir);
  if (!isOk(loadRes)) {
    err('caws agents heartbeat: lease directory unreadable.');
    err(renderDiagnostics(loadRes.errors, { showData }));
    return 2;
  }
  let leases = loadRes.value.leases;

  // Throttle check: if existing lease's last_active is within throttleMs,
  // skip the write. The active-summary is still computed and returned so
  // the hook caller doesn't lose visibility during throttle windows.
  const existing = leases[idRes.identity.session_id];
  let throttled = false;
  let wrote = false;

  if (existing !== undefined && throttleMs > 0) {
    const lastActiveMs = Date.parse(existing.last_active);
    const age = now.getTime() - lastActiveMs;
    if (Number.isFinite(lastActiveMs) && age < throttleMs) {
      throttled = true;
    }
  }

  if (!throttled) {
    const patchRes = heartbeatAgentSession(leases, idRes.identity, context, now, reason);
    if (!isOk(patchRes)) {
      err('caws agents heartbeat: kernel refused.');
      err(renderDiagnostics(patchRes.errors, { showData }));
      return 1;
    }
    const applyRes = applyLeasePatch(cawsDir, patchRes.value);
    if (!isOk(applyRes)) {
      err('caws agents heartbeat: store write failed.');
      err(renderDiagnostics(applyRes.errors, { showData }));
      return 1;
    }
    wrote = applyRes.value.wrote;
    // Re-load for active summary so we include our own fresh write.
    const reload = loadLeases(cawsDir);
    if (isOk(reload)) leases = reload.value.leases;
  }

  const fn = safeLeaseFilename(idRes.identity.session_id);
  const leasePath = isOk(fn) ? `.caws/leases/${fn.value}` : null;

  if (json) {
    const payload: Record<string, unknown> = {
      ok: true,
      session_id: idRes.identity.session_id,
      lease_path: leasePath,
      wrote,
      throttled,
    };
    if (opts.includeActiveSummary === true) {
      Object.assign(payload, computeActiveSummary(leases, idRes.identity.session_id, now));
    }
    emitJson(out, payload);
  } else {
    out(
      `heartbeat ${idRes.identity.session_id} (${throttled ? 'throttled' : 'wrote'}, lease: ${leasePath ?? '?'})`
    );
  }
  return 0;
}

// ─── caws agents stop ─────────────────────────────────────────────────────

export interface StopOpts extends BaseAgentsOpts {}

export function runAgentsStopCommand(opts: StopOpts = {}): number {
  const { cwd, nowFn, env, out, err, showData, json } = setupIO(opts);

  const repoRootResult = resolveRepoRoot(cwd);
  if (!isOk(repoRootResult)) {
    err('caws agents stop: failed to resolve repo root.');
    err(renderDiagnostics(repoRootResult.errors, { showData }));
    return 2;
  }
  const { cawsDir } = repoRootResult.value;

  const idRes = resolveIdentityForCommand(
    opts,
    { cawsDir, cwd, env, nowFn },
    /* allowMint */ false, // stop on a never-existed session is best-effort, not mint
    err
  );
  if (idRes === null) return 1;

  const now = nowFn();

  const loadRes = loadLeases(cawsDir);
  if (!isOk(loadRes)) {
    err('caws agents stop: lease directory unreadable.');
    err(renderDiagnostics(loadRes.errors, { showData }));
    return 2;
  }

  const patchRes = stopAgentSession(loadRes.value.leases, idRes.identity, now);
  if (!isOk(patchRes)) {
    err('caws agents stop: kernel refused.');
    err(renderDiagnostics(patchRes.errors, { showData }));
    return 1;
  }

  const applyRes = applyLeasePatch(cawsDir, patchRes.value);
  if (!isOk(applyRes)) {
    err('caws agents stop: store write failed.');
    err(renderDiagnostics(applyRes.errors, { showData }));
    return 1;
  }

  if (json) {
    emitJson(out, {
      ok: true,
      session_id: idRes.identity.session_id,
      wrote: applyRes.value.wrote,
      diagnostics: applyRes.value.diagnostics,
    });
  } else if (applyRes.value.wrote) {
    out(`stopped ${idRes.identity.session_id}`);
  } else {
    out(`no prior lease for ${idRes.identity.session_id} (no-op)`);
  }
  return 0;
}

// ─── caws agents list ─────────────────────────────────────────────────────

export interface ListOpts extends BaseAgentsOpts {
  readonly includeStale?: boolean;
  readonly includeStopped?: boolean;
  readonly activeOnly?: boolean;
  readonly staleTtlMs?: number;
}

export function runAgentsListCommand(opts: ListOpts = {}): number {
  const { cwd, nowFn, out, err, showData, json } = setupIO(opts);

  const repoRootResult = resolveRepoRoot(cwd);
  if (!isOk(repoRootResult)) {
    err('caws agents list: failed to resolve repo root.');
    err(renderDiagnostics(repoRootResult.errors, { showData }));
    return 2;
  }
  const { cawsDir } = repoRootResult.value;

  const loadRes = loadLeases(cawsDir);
  if (!isOk(loadRes)) {
    err('caws agents list: lease directory unreadable.');
    err(renderDiagnostics(loadRes.errors, { showData }));
    return 2;
  }

  const now = nowFn();
  const ttl = opts.staleTtlMs ?? DEFAULT_STALE_TTL_MS;
  const summary = summarizeActiveAgents(loadRes.value.leases, now, ttl);

  // --active means TTL-classified active, NOT raw status field.
  // Default surfacing rules: active is always shown; stale + stopped are
  // gated by their flags. --active means active-only (overrides flags).
  const wantsStale = opts.includeStale === true && !(opts.activeOnly === true);
  const wantsStopped = opts.includeStopped === true && !(opts.activeOnly === true);

  if (json) {
    emitJson(out, {
      ok: true,
      now: now.toISOString(),
      stale_ttl_ms: ttl,
      active: summary.active,
      ...(wantsStale ? { stale: summary.stale } : {}),
      ...(wantsStopped ? { stopped: summary.stopped } : {}),
      counts: {
        active: summary.active.length,
        stale: summary.stale.length,
        stopped: summary.stopped.length,
        total: summary.total,
      },
    });
  } else {
    out(`active: ${summary.active.length}`);
    for (const l of summary.active) {
      out(`  ${l.session_id}  ${l.bound_worktree ?? '(no worktree)'}  ${l.bound_spec_id ?? '(no spec)'}`);
    }
    if (wantsStale) {
      out(`stale:  ${summary.stale.length}`);
      for (const l of summary.stale) out(`  ${l.session_id}`);
    }
    if (wantsStopped) {
      out(`stopped: ${summary.stopped.length}`);
      for (const l of summary.stopped) out(`  ${l.session_id}`);
    }
  }
  if (loadRes.value.diagnostics.length > 0 && showData) {
    err(renderDiagnostics(loadRes.value.diagnostics, { showData }));
  }
  return 0;
}

// ─── caws agents show ─────────────────────────────────────────────────────

export interface ShowOpts extends BaseAgentsOpts {
  readonly id: string;
}

export function runAgentsShowCommand(opts: ShowOpts): number {
  const { cwd, out, err, showData, json } = setupIO(opts);

  const repoRootResult = resolveRepoRoot(cwd);
  if (!isOk(repoRootResult)) {
    err('caws agents show: failed to resolve repo root.');
    return 2;
  }
  const { cawsDir } = repoRootResult.value;

  // Validate filename safety even for read — gives a clear error if the
  // user typed an unsafe id.
  const fn = safeLeaseFilename(opts.id);
  if (!isOk(fn)) {
    err(`caws agents show: invalid session id "${opts.id}".`);
    err(renderDiagnostics(fn.errors, { showData }));
    return 1;
  }

  const loadRes = loadLeases(cawsDir);
  if (!isOk(loadRes)) {
    err('caws agents show: lease directory unreadable.');
    return 2;
  }

  const lease: AgentLease | undefined = loadRes.value.leases[opts.id];
  if (lease === undefined) {
    if (json) {
      emitJson(out, { ok: false, error: 'not_found', session_id: opts.id });
    } else {
      err(`caws agents show: no lease for "${opts.id}".`);
    }
    return 1;
  }
  if (json) {
    emitJson(out, { ok: true, lease });
  } else {
    out(JSON.stringify(lease, null, 2));
  }
  return 0;
}

// ─── caws agents prune ────────────────────────────────────────────────────

export interface PruneOpts extends BaseAgentsOpts {
  readonly status: 'stopped' | 'stale';
  readonly olderThanMs: number;
  readonly staleTtlMs?: number;
  readonly apply?: boolean; // default: dry-run
}

export function runAgentsPruneCommand(opts: PruneOpts): number {
  const { cwd, nowFn, out, err, showData, json } = setupIO(opts);

  const repoRootResult = resolveRepoRoot(cwd);
  if (!isOk(repoRootResult)) {
    err('caws agents prune: failed to resolve repo root.');
    return 2;
  }
  const { cawsDir } = repoRootResult.value;

  const r = pruneLeasesByStatus(cawsDir, {
    status: opts.status,
    retentionMs: opts.olderThanMs,
    ...(opts.staleTtlMs !== undefined ? { staleTtlMs: opts.staleTtlMs } : {}),
    now: nowFn(),
    dryRun: !(opts.apply === true),
  });
  if (!isOk(r)) {
    err('caws agents prune: failed.');
    err(renderDiagnostics(r.errors, { showData }));
    return 1;
  }

  if (json) {
    emitJson(out, {
      ok: true,
      dry_run: !(opts.apply === true),
      status: opts.status,
      candidates: r.value.candidates,
      deleted: r.value.deleted,
      diagnostics: r.value.diagnostics,
    });
  } else {
    out(`prune (${opts.apply === true ? 'apply' : 'dry-run'}): ${r.value.candidates.length} candidate(s)`);
    for (const id of r.value.candidates) {
      const tag = r.value.deleted.includes(id) ? 'DELETED' : 'would-delete';
      out(`  ${tag} ${id}`);
    }
  }
  return 0;
}
