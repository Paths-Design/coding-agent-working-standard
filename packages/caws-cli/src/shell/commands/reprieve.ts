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
/**
 * The env vars that indicate an agent session, in resolver precedence order.
 *
 * CAWS-REPRIEVE-NO-SELF-GRANT-001: the self-grant refusal keys on the UNION of
 * this list, and session resolution reads it in order. They MUST be the same
 * list: if the guard checked a subset, an agent whose harness exports a var
 * outside that subset would resolve a session (and grant) while reading as a
 * human. Sharing the constant makes that drift impossible to introduce silently.
 */
const AGENT_SESSION_VARS = [
  'CLAUDE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ID',
  'CODEX_THREAD_ID',
  'CAWS_SESSION_ID',
  'HOOK_SESSION_ID',
  'CURSOR_TRACE_ID',
] as const;

function envHasValue(env: NodeJS.ProcessEnv, name: string): boolean {
  const v = env[name];
  return typeof v === 'string' && v.length > 0 && v !== 'unknown';
}

/**
 * Names every agent-session var currently set. Empty means "no agent session
 * detected" — the human path.
 */
export function detectAgentSessionVars(env: NodeJS.ProcessEnv): string[] {
  return AGENT_SESSION_VARS.filter((name) => envHasValue(env, name));
}

function resolveSessionId(env: NodeJS.ProcessEnv): string {
  for (const name of AGENT_SESSION_VARS) {
    if (envHasValue(env, name)) return env[name] as string;
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

/**
 * Accepted duration units for `--for`. Longer aliases first so that "hr" is
 * matched before "h" — otherwise "1hr30m" parses "h" and then chokes on "r".
 */
const DURATION_UNITS: ReadonlyArray<readonly [string, number]> = [
  ['d', 86400],
  ['hr', 3600],
  ['h', 3600],
  ['m', 60],
  ['s', 1],
];

/** Human-facing list of what `--for` accepts; used in every refusal message. */
export const DURATION_UNITS_HELP = 's (seconds), m (minutes), h/hr (hours), d (days)';

/**
 * Parse a relative duration like "30m", "1h30m", "1hr30m", "120s", "2d" into
 * whole seconds. Returns null for anything unparseable.
 *
 * CAWS-REPRIEVE-RELATIVE-EXPIRY-001 A2: components may be concatenated and are
 * summed. A bare number ("30") is REFUSED rather than assumed to be minutes —
 * guessing the unit on an expiry is the "silently does something other than
 * what was asked" class, and the caller gets the unit list instead.
 */
export function parseDurationToSeconds(raw: string): number | null {
  const text = raw.trim().toLowerCase();
  if (text.length === 0) return null;

  let rest = text;
  let total = 0;
  let matched = 0;

  while (rest.length > 0) {
    const num = /^(\d+)/.exec(rest);
    if (num === null) return null;
    const value = Number.parseInt(num[1] as string, 10);
    rest = rest.slice((num[1] as string).length);

    const unit = DURATION_UNITS.find(([suffix]) => rest.startsWith(suffix));
    if (unit === undefined) return null;
    rest = rest.slice(unit[0].length);

    total += value * unit[1];
    matched += 1;
  }

  if (matched === 0) return null;
  return total;
}

export interface ReprieveGrantOptions extends ReprieveCommandBase {
  /** Comma-separated handler basenames to reprieve (e.g. "protected-paths.sh"). */
  readonly handlers: string;
  readonly reason: string;
  readonly approvedBy: string;
  /** Absolute ISO-8601 expiry. Mutually exclusive with `for`. */
  readonly expiresAt?: string;
  /** Relative duration from now (e.g. "90m"). Mutually exclusive with `expiresAt`. */
  readonly for?: string;
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

  // CAWS-REPRIEVE-NO-SELF-GRANT-001: an agent may not lift a guard that
  // constrains it. This runs FIRST — before repo resolution, before the state
  // dir is created — so a refused grant leaves nothing behind.
  //
  // Keyed on the union of AGENT_SESSION_VARS rather than CAWS_SESSION_ID alone.
  // In the transcript that motivated this, a Codex agent self-granted twice
  // with CAWS_SESSION_ID unset (it is fourth in precedence, behind the harness
  // vars), so a CAWS_SESSION_ID-only check would have permitted the exact event
  // it exists to stop, while blocking a human who happened to export it.
  //
  // Scope note: this raises the cost of self-granting, it does not make it
  // impossible — an env check is only as strong as the environment the agent
  // controls. Clearing the vars to evade it also breaks session resolution
  // below, so evasion is self-punishing rather than free, but the durable gate
  // is human approval outside the agent's process tree
  // (CAWS-SESSION-IDENTITY-INVERSION-001).
  const agentEnv = opts.env ?? process.env;
  const agentVars = detectAgentSessionVars(agentEnv);
  if (agentVars.length > 0) {
    err('caws reprieve grant: agents cannot grant their own reprieves.');
    err(`  detected agent session via: ${agentVars.join(', ')}`);
    err('  A reprieve weakens a guard, so it must be authorized by a human, not');
    err('  by the session the guard constrains.');
    err('');
    err('  Ask the user to run this from a terminal OUTSIDE the agent session:');
    err(
      `    caws reprieve grant --handlers ${opts.handlers} --reason "<why this is safe>" --approved-by "<their id>" --for 30m`
    );
    return 1;
  }

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

  // Resolve the expiry from exactly one of --for (relative) or --expires-at
  // (absolute). CAWS-REPRIEVE-RELATIVE-EXPIRY-001 A3/A4: two sources would make
  // the audit record ambiguous about what was actually approved, and zero
  // sources previously left absolute ISO as the only discoverable path — which
  // forces UTC arithmetic on the operator at exactly the moment they are
  // blocked by a guard.
  const relative = opts.for;
  const absolute = opts.expiresAt;
  if (relative !== undefined && absolute !== undefined) {
    err(
      'caws reprieve grant: --for and --expires-at are mutually exclusive. Pass --for <duration> for a relative expiry (e.g. --for 30m), or --expires-at <iso> for an absolute one — not both.'
    );
    return 1;
  }
  if (relative === undefined && absolute === undefined) {
    err(
      `caws reprieve grant: an expiry is required. Pass --for <duration> (e.g. --for 30m; units: ${DURATION_UNITS_HELP}), or --expires-at <iso> (e.g. --expires-at ${new Date(now.getTime() + 30 * 60_000).toISOString()}).`
    );
    return 1;
  }

  // The stored value is always a concrete absolute ISO-8601 timestamp (A1): the
  // record is an audit artifact read later by lib/reprieve.sh, so it must not
  // carry a relative string that would need re-evaluation against a different "now".
  let expiresAt: Date;
  let storedExpiry: string;

  if (relative !== undefined) {
    const seconds = parseDurationToSeconds(relative);
    if (seconds === null) {
      err(
        `caws reprieve grant: --for "${relative}" is not a valid duration. Accepted units: ${DURATION_UNITS_HELP}. Examples: 30m, 90m, 1h30m, 1hr30m, 120s, 2d.`
      );
      return 1;
    }
    if (seconds <= 0) {
      err(
        `caws reprieve grant: --for "${relative}" resolves to ${seconds} seconds. A reprieve must expire in the future.`
      );
      return 1;
    }
    expiresAt = new Date(now.getTime() + seconds * 1000);
    storedExpiry = expiresAt.toISOString();
  } else {
    // Validate expiry: ISO-8601, timezone-qualified, and in the future.
    // CAWS-GUARD-REPRIEVE-NAIVE-EXPIRY-001: a timezone-less --expires-at (e.g.
    // "2026-07-19T04:00:00") is REFUSED here, not silently accepted. The reader
    // (lib/reprieve.sh) assumes UTC for naive values to tolerate legacy files,
    // but the writer must fail loud: otherwise the grant reports success and the
    // reprieve is silently inert (the "reports success while doing nothing" class).
    // Require a trailing Z or a +/- offset. The stored value is the user's input
    // verbatim — do NOT silently normalize, so the audit trail shows what was approved.
    const RAW_EXPIRY = absolute as string;
    if (!/[Zz]|[+-]\d\d:?\d\d$/.test(RAW_EXPIRY.trim())) {
      err(
        `caws reprieve grant: --expires-at "${RAW_EXPIRY}" is missing a timezone. Append 'Z' (UTC) or a +/-HH:MM offset, e.g. --expires-at ${RAW_EXPIRY.trim()}Z`
      );
      return 1;
    }
    expiresAt = new Date(RAW_EXPIRY);
    if (!Number.isFinite(expiresAt.getTime())) {
      err(
        `caws reprieve grant: --expires-at "${RAW_EXPIRY}" is not a valid ISO-8601 timestamp. Expected YYYY-MM-DDTHH:MM:SSZ, e.g. ${new Date(now.getTime() + 30 * 60_000).toISOString()}. To avoid computing a timestamp, use --for 30m instead.`
      );
      return 1;
    }
    // Report "now" alongside the refusal: an operator reasoning in local time
    // near a UTC date boundary otherwise cannot see why a same-day timestamp is
    // already past, and burns retries guessing.
    if (expiresAt.getTime() <= now.getTime()) {
      err(
        `caws reprieve grant: --expires-at "${RAW_EXPIRY}" is in the past (now: ${now.toISOString()}). A reprieve must expire in the future. For a relative expiry, use --for 30m.`
      );
      return 1;
    }
    storedExpiry = RAW_EXPIRY;
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
    expires_at: storedExpiry,
    approved_by: opts.approvedBy,
    reason: opts.reason,
    handlers,
  };
  const filePath = reprieveFileName(state.stateDir, sessionId);

  if (opts.dryRun === true) {
    const payload = opts.json
      ? JSON.stringify({ ok: true, dry_run: true, would_write: true, reprieve: record, target: filePath }, null, 2)
      : `caws reprieve grant --dry-run: would write ${filePath}\n  session: ${sessionId}\n  handlers: ${handlers.join(', ')}\n  expires: ${storedExpiry}`;
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
      expires_at: storedExpiry,
      file: filePath,
    },
    err
  );

  if (opts.json === true) {
    out(JSON.stringify({ ok: true, reprieve: record, target: filePath }, null, 2));
  } else {
    out(`granted reprieve for session ${sessionId}`);
    out(`  handlers: ${handlers.join(', ')}`);
    out(`  expires:  ${storedExpiry}`);
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
