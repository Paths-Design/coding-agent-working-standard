// `caws reprieve` — session-scoped guard reprieve (CAWS-GUARD-REPRIEVE-SESSION-SCOPED-001).
//
// A reprieve is a governed, per-session, expiring, machine-checkable way to SKIP a
// PreToolUse guard for exactly one agent session. It replaces the anti-pattern of
// commenting a guard out of the dispatcher's HANDLERS array (which disables it for
// EVERY agent, forever, with no reason/approver/expiry).
//
// Model: mirrors the danger-latch + scope-guard-strike substrate — a per-session
// JSON state file under the vendor `hooks/state/` dir, keyed by sanitized session
// id, gitignored operational cache (NOT .caws/ governance state), cleared by
// deletion. The one addition over the latch model: an `expires_at` field.
//
// Four subcommands:
//   grant   — resolve session → write guard-reprieve-<sanitized>.json (+ audit log)
//   show    — read + render the current session's reprieve
//   revoke  — delete the file + append audit line (mandatory --reason)
//   list    — enumerate active reprieve files in the vendor state dir
//
// The writer and the reader (lib/reprieve.sh, consulted by run-handlers.sh) both
// key on the resolved session id + sanitize_session transform, so the same session
// resolves to the same filename in every context (DANGER-LATCH-UX-001 lesson).
//
// Exit codes (uniform across v11):
//   0 = success / observation (incl. show with no reprieve, list with zero results)
//   1 = domain failure (missing flags, unknown session, malformed expiry)
//   2 = composition failure (not a repo, can't resolve vendor dir)

import * as fs from 'node:fs';
import * as path from 'node:path';

import { resolveRepoRoot } from '../../store';
import { renderDiagnostics } from '../render/diagnostic';
import { SHELL_RULES } from '../rules';

// ---------------------------------------------------------------------------
// Common option/result shapes.
// ---------------------------------------------------------------------------

export interface ReprieveCommandBase {
  readonly cwd?: string;
  readonly now?: () => Date;
  readonly out?: (line: string) => void;
  readonly err?: (line: string) => void;
  readonly showData?: boolean;
}

/** The reprieve record written to the vendor state dir. */
export interface ReprieveRecord {
  readonly session_id: string;
  readonly created_at: string;
  readonly expires_at: string;
  readonly approved_by: string;
  readonly reason: string;
  readonly handlers: readonly string[];
}

/** The vendor dirs to probe, in priority order. Mirrors agent-surface.sh's
 *  surface→dir map. The first that has a hooks/state/ substrate wins; if none
 *  does, we default to .claude (the agent-surface.sh default). */
const VENDOR_DIRS = [
  '.claude',
  '.codex',
  '.zcode',
  '.cursor',
  '.windsurf',
  '.opencode',
] as const;

function setupIO(opts: ReprieveCommandBase) {
  const cwd = opts.cwd ?? process.cwd();
  const nowFn = opts.now ?? (() => new Date());
  const out = opts.out ?? ((s: string) => process.stdout.write(s + '\n'));
  const err = opts.err ?? ((s: string) => process.stderr.write(s + '\n'));
  const showData = opts.showData === true;
  return { cwd, nowFn, out, err, showData };
}

/**
 * Resolve the repo root + the vendor state dir for a reprieve. Returns the
 * absolute path to `hooks/state/` (created if missing) and the vendor dir name.
 *
 * The vendor dir is detected by probing which dot-dir has a `hooks/state/`
 * substrate already (the latch creates it on first use). If none exists yet,
 * default to `.claude` (agent-surface.sh's default). An explicit `--surface`
 * override selects a specific vendor dir without probing.
 */
function resolveReprieveStateDir(
  repoRoot: string,
  err: (line: string) => void,
  showData: boolean,
  surfaceOverride?: string
): { stateDir: string; vendorDir: string; logsDir: string } | null {
  const vendorDir =
    surfaceOverride !== undefined
      ? surfaceToVendorDir(surfaceOverride, err, showData)
      : detectVendorDir(repoRoot);
  if (vendorDir === null) return null;
  const stateDir = path.join(repoRoot, vendorDir, 'hooks', 'state');
  const logsDir = path.join(repoRoot, vendorDir, 'logs');
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(logsDir, { recursive: true });
  } catch (e) {
    err(
      `caws reprieve: failed to create vendor state dir: ${(e as Error).message}`
    );
    return null;
  }
  return { stateDir, vendorDir, logsDir };
}

function surfaceToVendorDir(
  surface: string,
  err: (line: string) => void,
  showData: boolean
): string | null {
  // Same map as agent-surface.sh:102-158. Accepted as the surface name OR the
  // dot-dir itself (so both `--surface claude-code` and `--surface .claude` work).
  const map: Record<string, string> = {
    'claude-code': '.claude',
    codex: '.codex',
    zcode: '.zcode',
    cursor: '.cursor',
    windsurf: '.windsurf',
    opencode: '.opencode',
    '.claude': '.claude',
    '.codex': '.codex',
    '.zcode': '.zcode',
    '.cursor': '.cursor',
    '.windsurf': '.windsurf',
    '.opencode': '.opencode',
  };
  const v = map[surface];
  if (v === undefined) {
    err(`caws reprieve: unknown --surface "${surface}".`);
    err(
      renderDiagnostics(
        [
          {
            rule: SHELL_RULES.REPRIEVE_UNKNOWN_SURFACE,
            authority: 'kernel/diagnostics',
            severity: 'error',
            message: `Unknown agent surface: ${surface}`,
          },
        ],
        { showData }
      )
    );
    return null;
  }
  return v;
}

/** Probe which vendor dot-dir has a hooks/state/ substrate. Returns null only
 *  when an explicit override is given and invalid — the default fallback is
 *  `.claude`. */
function detectVendorDir(repoRoot: string): string {
  for (const v of VENDOR_DIRS) {
    const candidate = path.join(repoRoot, v, 'hooks', 'state');
    if (fs.existsSync(candidate)) return v;
  }
  return '.claude';
}

/**
 * Resolve the operating session id from env, mirroring the shell-side
 * resolve_caws_session_id precedence (lib/session-id.sh). The TS-side reprieve
 * command runs OUTSIDE the hook shell (it's a direct CLI invocation), so it
 * consults the boundary-crossing vars: CLAUDE_SESSION_ID → CLAUDE_CODE_SESSION_ID
 * → CODEX_THREAD_ID → CAWS_SESSION_ID → HOOK_SESSION_ID → CURSOR_TRACE_ID.
 * Returns null ("unknown") when none is set — grant refuses that.
 */
function resolveSessionId(env: NodeJS.ProcessEnv): string {
  const sources = [
    env['CLAUDE_SESSION_ID'],
    env['CLAUDE_CODE_SESSION_ID'],
    env['CODEX_THREAD_ID'],
    env['CAWS_SESSION_ID'],
    env['HOOK_SESSION_ID'],
    env['CURSOR_TRACE_ID'],
  ];
  for (const s of sources) {
    if (typeof s === 'string' && s.length > 0 && s !== 'unknown') return s;
  }
  return 'unknown';
}

/**
 * sanitize_session — the shared transform from lib/caws-state.sh:193-195.
 * Everything outside [A-Za-z0-9._-] becomes '_'. The writer (here) and the
 * reader (lib/reprieve.sh) MUST use the identical transform or the consult
 * targets the wrong filename (the DANGER-LATCH-UX-001 lesson).
 */
function sanitizeSession(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9._-]/g, '_');
}

function reprieveFileName(stateDir: string, sessionId: string): string {
  return path.join(stateDir, `guard-reprieve-${sanitizeSession(sessionId)}.json`);
}

/** Append a JSONL audit record to <vendor>/logs/guard-reprieves.log. Non-fatal. */
function appendAudit(
  logsDir: string,
  record: Record<string, unknown>,
  err: (line: string) => void
): void {
  const logPath = path.join(logsDir, 'guard-reprieves.log');
  try {
    fs.appendFileSync(logPath, JSON.stringify(record) + '\n');
  } catch (e) {
    // Audit failure is non-fatal (mirrors the latch reset posture) — the
    // state operation succeeded; only the trail entry failed.
    err(`caws reprieve: warning — could not append audit log: ${(e as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// caws reprieve grant
// ---------------------------------------------------------------------------

export interface ReprieveGrantOptions extends ReprieveCommandBase {
  /** Comma-separated handler basenames to reprieve (e.g. "protected-paths.sh"). */
  readonly handlers: string;
  readonly reason: string;
  readonly approvedBy: string;
  readonly expiresAt: string;
  /** Resolve the current session from env (default). */
  readonly current?: boolean;
  /** Explicit session id (overrides --current). */
  readonly session?: string;
  /** Explicit agent surface / vendor dir (default: detect). */
  readonly surface?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Validate + report only; do not write. */
  readonly dryRun?: boolean;
  readonly json?: boolean;
}

export function runReprieveGrantCommand(opts: ReprieveGrantOptions): number {
  const { cwd, nowFn, out, err, showData } = setupIO(opts);
  const now = nowFn();

  const repo = resolveRepoRoot(cwd);
  if (!repo.ok) {
    err('caws reprieve grant: failed to resolve repo root.');
    err(renderDiagnostics(repo.errors, { showData }));
    return 2;
  }
  const state = resolveReprieveStateDir(
    repo.value.repoRoot,
    err,
    showData,
    opts.surface
  );
  if (state === null) return 2;

  // Resolve the session id. --session wins; else --current resolves from env.
  const env = opts.env ?? process.env;
  const sessionId =
    opts.session ?? (opts.current !== false ? resolveSessionId(env) : 'unknown');
  if (sessionId === 'unknown' || sessionId.length === 0) {
    err(
      'caws reprieve grant: could not resolve a session id. Pass --session <id>, or run with CAWS_SESSION_ID/CLAUDE_SESSION_ID/CODEX_THREAD_ID set.'
    );
    return 1;
  }

  // Parse + validate the handlers list.
  const handlers = opts.handlers
    .split(',')
    .map((h) => h.trim())
    .filter((h) => h.length > 0);
  if (handlers.length === 0) {
    err('caws reprieve grant: --handlers requires at least one handler basename.');
    return 1;
  }

  // Validate expiry: ISO-8601 and in the future.
  let expiresAt: Date;
  try {
    expiresAt = new Date(opts.expiresAt);
    if (!Number.isFinite(expiresAt.getTime())) {
      throw new Error('invalid date');
    }
  } catch {
    err(`caws reprieve grant: --expires-at "${opts.expiresAt}" is not a valid ISO-8601 timestamp.`);
    return 1;
  }
  if (expiresAt.getTime() <= now.getTime()) {
    err(`caws reprieve grant: --expires-at "${opts.expiresAt}" is in the past. A reprieve must expire in the future.`);
    return 1;
  }
  if (!opts.approvedBy || opts.approvedBy.length === 0) {
    err('caws reprieve grant: --approved-by is required.');
    return 1;
  }
  if (!opts.reason || opts.reason.length === 0) {
    err('caws reprieve grant: --reason is required.');
    return 1;
  }

  const record: ReprieveRecord = {
    session_id: sessionId,
    created_at: now.toISOString(),
    expires_at: opts.expiresAt,
    approved_by: opts.approvedBy,
    reason: opts.reason,
    handlers,
  };
  const filePath = reprieveFileName(state.stateDir, sessionId);

  if (opts.dryRun === true) {
    const payload = opts.json
      ? JSON.stringify({ ok: true, dry_run: true, would_write: true, reprieve: record, target: filePath }, null, 2)
      : `caws reprieve grant --dry-run: would write ${filePath}\n  session: ${sessionId}\n  handlers: ${handlers.join(', ')}\n  expires: ${opts.expiresAt}`;
    out(payload);
    return 0;
  }

  // Atomic write: temp + rename (the writeFileAtomic substrate is in store/, but
  // this command writes to the VENDOR dir, not .caws/, so a local atomic write
  // avoids pulling a store dependency for a non-governance file).
  try {
    const tmp = `${filePath}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n');
    fs.renameSync(tmp, filePath);
  } catch (e) {
    err(`caws reprieve grant: failed to write reprieve file: ${(e as Error).message}`);
    return 2;
  }

  appendAudit(
    state.logsDir,
    {
      ts: now.toISOString(),
      action: 'grant',
      session_id: sessionId,
      handlers,
      reason: opts.reason,
      approved_by: opts.approvedBy,
      expires_at: opts.expiresAt,
      file: filePath,
    },
    err
  );

  if (opts.json === true) {
    out(JSON.stringify({ ok: true, reprieve: record, target: filePath }, null, 2));
  } else {
    out(`granted reprieve for session ${sessionId}`);
    out(`  handlers: ${handlers.join(', ')}`);
    out(`  expires:  ${opts.expiresAt}`);
    out(`  reason:   ${opts.reason}`);
    out(`  approved: ${opts.approvedBy}`);
    out(`  file:     ${filePath}`);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// caws reprieve show
// ---------------------------------------------------------------------------

export interface ReprieveShowOptions extends ReprieveCommandBase {
  readonly current?: boolean;
  readonly session?: string;
  readonly surface?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly json?: boolean;
}

export function runReprieveShowCommand(opts: ReprieveShowOptions): number {
  const { cwd, nowFn, out, err, showData } = setupIO(opts);
  const now = nowFn();
  const repo = resolveRepoRoot(cwd);
  if (!repo.ok) {
    err('caws reprieve show: failed to resolve repo root.');
    err(renderDiagnostics(repo.errors, { showData }));
    return 2;
  }
  const state = resolveReprieveStateDir(repo.value.repoRoot, err, showData, opts.surface);
  if (state === null) return 2;

  const env = opts.env ?? process.env;
  const sessionId = opts.session ?? resolveSessionId(env);
  const filePath = reprieveFileName(state.stateDir, sessionId);

  if (!fs.existsSync(filePath)) {
    if (opts.json === true) {
      out(JSON.stringify({ ok: true, session_id: sessionId, reprieve: null }, null, 2));
    } else {
      out(`no reprieve for session ${sessionId}`);
    }
    return 0;
  }
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    err(`caws reprieve show: could not read reprieve file: ${(e as Error).message}`);
    return 2;
  }
  let record: ReprieveRecord;
  try {
    record = JSON.parse(raw);
  } catch {
    err(`caws reprieve show: reprieve file is malformed JSON: ${filePath}`);
    return 1;
  }
  // Derived expiry: report whether it is still active.
  const exp = new Date(record.expires_at);
  const active = Number.isFinite(exp.getTime()) && exp.getTime() > now.getTime();
  if (opts.json === true) {
    out(JSON.stringify({ ok: true, session_id: sessionId, active, reprieve: record, file: filePath }, null, 2));
  } else {
    out(`reprieve for session ${sessionId} — ${active ? 'ACTIVE' : 'EXPIRED'}`);
    out(`  handlers: ${record.handlers.join(', ')}`);
    out(`  expires:  ${record.expires_at}`);
    out(`  reason:   ${record.reason}`);
    out(`  approved: ${record.approved_by}`);
    out(`  file:     ${filePath}`);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// caws reprieve revoke
// ---------------------------------------------------------------------------

export interface ReprieveRevokeOptions extends ReprieveCommandBase {
  readonly reason: string;
  readonly current?: boolean;
  readonly session?: string;
  readonly surface?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly json?: boolean;
}

export function runReprieveRevokeCommand(opts: ReprieveRevokeOptions): number {
  const { cwd, nowFn, out, err, showData } = setupIO(opts);
  const now = nowFn();
  const repo = resolveRepoRoot(cwd);
  if (!repo.ok) {
    err('caws reprieve revoke: failed to resolve repo root.');
    err(renderDiagnostics(repo.errors, { showData }));
    return 2;
  }
  const state = resolveReprieveStateDir(repo.value.repoRoot, err, showData, opts.surface);
  if (state === null) return 2;

  if (!opts.reason || opts.reason.length === 0) {
    err('caws reprieve revoke: --reason is required (records why the reprieve is being cleared).');
    return 1;
  }

  const env = opts.env ?? process.env;
  const sessionId = opts.session ?? resolveSessionId(env);
  const filePath = reprieveFileName(state.stateDir, sessionId);

  if (!fs.existsSync(filePath)) {
    out(`no reprieve for session ${sessionId} (nothing to revoke)`);
    return 0;
  }
  let priorRecord: ReprieveRecord | null = null;
  try {
    priorRecord = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    // Malformed — still delete it, but note the parse failure.
    priorRecord = null;
  }
  try {
    fs.unlinkSync(filePath);
  } catch (e) {
    err(`caws reprieve revoke: could not delete reprieve file: ${(e as Error).message}`);
    return 2;
  }
  appendAudit(
    state.logsDir,
    {
      ts: now.toISOString(),
      action: 'revoke',
      session_id: sessionId,
      reason: opts.reason,
      cleared_reprieve: priorRecord,
      file: filePath,
    },
    err
  );
  if (opts.json === true) {
    out(JSON.stringify({ ok: true, revoked: true, session_id: sessionId, file: filePath }, null, 2));
  } else {
    out(`revoked reprieve for session ${sessionId}`);
    out(`  file:  ${filePath}`);
    out(`  reason: ${opts.reason}`);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// caws reprieve list
// ---------------------------------------------------------------------------

export interface ReprieveListOptions extends ReprieveCommandBase {
  readonly surface?: string;
  readonly json?: boolean;
}

export function runReprieveListCommand(opts: ReprieveListOptions): number {
  const { cwd, nowFn, out, err, showData } = setupIO(opts);
  const now = nowFn();
  const repo = resolveRepoRoot(cwd);
  if (!repo.ok) {
    err('caws reprieve list: failed to resolve repo root.');
    err(renderDiagnostics(repo.errors, { showData }));
    return 2;
  }
  const state = resolveReprieveStateDir(repo.value.repoRoot, err, showData, opts.surface);
  if (state === null) return 2;

  let entries: string[] = [];
  try {
    entries = fs
      .readdirSync(state.stateDir)
      .filter((f) => f.startsWith('guard-reprieve-') && f.endsWith('.json'));
  } catch {
    // Directory doesn't exist or unreadable → no reprieves.
    entries = [];
  }

  const records: Array<ReprieveRecord & { active: boolean; file: string }> = [];
  for (const name of entries) {
    const fp = path.join(state.stateDir, name);
    try {
      const rec = JSON.parse(fs.readFileSync(fp, 'utf8')) as ReprieveRecord;
      const exp = new Date(rec.expires_at);
      const active = Number.isFinite(exp.getTime()) && exp.getTime() > now.getTime();
      records.push({ ...rec, active, file: fp });
    } catch {
      // Skip malformed files (display-only; don't fail the list).
    }
  }

  if (opts.json === true) {
    out(JSON.stringify({ ok: true, reprieves: records }, null, 2));
    return 0;
  }
  if (records.length === 0) {
    out('no reprieves');
    return 0;
  }
  for (const r of records) {
    out(`${r.session_id} — ${r.active ? 'ACTIVE' : 'EXPIRED'} — handlers: ${r.handlers.join(', ')} — expires: ${r.expires_at}`);
  }
  return 0;
}
