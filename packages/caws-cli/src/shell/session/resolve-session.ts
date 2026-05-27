// resolve-session — establish a SessionIdentity for the current shell call.
//
// This is the SOLE shell-side authority for "who is running this command?".
// Source order:
//
//   1. CLAUDE_SESSION_ID env  → platform = "claude-code"
//                                (operator-set override; deliberate)
//   2. HOOK_SESSION_ID env    → platform = "claude-code"
//                                (harness-stable id exported by the
//                                Claude Code hook envelope via
//                                lib/parse-input.sh; refused if the
//                                value is the literal "unknown",
//                                which is the parse-input.sh fallback
//                                when the hook payload lacks an id —
//                                admitting "unknown" would alias every
//                                broken-context invocation into one
//                                shared capsule)
//   3. CAWS session capsule    → on-disk `.caws/sessions/<id>.json` that
//                                names the current worktree root
//   4. CURSOR_TRACE_ID env     → platform = "cursor" (low-stability fallback)
//   5. mint a new capsule (only when `allowMint: true` is passed by the
//      caller — read-only commands MUST NOT pass this flag). The mint
//      path DELETES any pre-existing capsule for the same worktree_root
//      before writing the new one; cleanup failures are non-fatal
//      warnings.
//
// Anything beyond this list — for example, inferring identity from
// `agents.json` last-active — is NOT permitted. agents.json freshness is
// display-only.
//
// The HOOK_SESSION_ID admission + mint-cleanup were added by
// CAWS-SESSION-ID-DRIFT-ENV-PRECEDENCE-001 to eliminate recurring
// "OWNED (foreign)" refusals after Claude Code session restarts that
// were forcing agents to normalize `caws claim --takeover`, defeating
// the audit contract.

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  err,
  ok,
  type Diagnostic,
  type Result,
} from '@paths.design/caws-kernel';
import { SHELL_RULES } from '../rules';
import { writeFileAtomic } from '../../store/atomic-write';
import type {
  ResolveSessionOptions,
  ResolvedSession,
  SessionCapsule,
} from './types';

const SESSIONS_DIRNAME = 'sessions';

function diag(
  rule: string,
  message: string,
  data?: Record<string, unknown>
): Diagnostic {
  const base: Diagnostic = {
    rule,
    authority: 'kernel/diagnostics',
    severity: 'error',
    message,
  };
  if (data !== undefined) {
    return { ...base, data };
  }
  return base;
}

function infoDiag(
  rule: string,
  message: string,
  data?: Record<string, unknown>
): Diagnostic {
  const base: Diagnostic = {
    rule,
    authority: 'kernel/diagnostics',
    severity: 'info',
    message,
  };
  if (data !== undefined) {
    return { ...base, data };
  }
  return base;
}

function readCapsule(
  cawsDir: string,
  worktreeRoot: string
): { capsule: SessionCapsule; capsulePath: string } | null {
  const sessionsDir = path.join(cawsDir, SESSIONS_DIRNAME);
  let entries: string[];
  try {
    entries = fs.readdirSync(sessionsDir);
  } catch {
    return null;
  }
  // Resolve real paths so /tmp vs /private/tmp on macOS doesn't fool us.
  let worktreeRealRoot: string;
  try {
    worktreeRealRoot = fs.realpathSync(worktreeRoot);
  } catch {
    worktreeRealRoot = worktreeRoot;
  }
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const capsulePath = path.join(sessionsDir, name);
    let raw: string;
    try {
      raw = fs.readFileSync(capsulePath, 'utf8');
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!isCapsuleShape(parsed)) continue;
    let capsuleWorktreeReal: string;
    try {
      capsuleWorktreeReal = fs.realpathSync(parsed.worktree_root);
    } catch {
      capsuleWorktreeReal = parsed.worktree_root;
    }
    if (capsuleWorktreeReal === worktreeRealRoot) {
      return { capsule: parsed, capsulePath };
    }
  }
  return null;
}

function isCapsuleShape(value: unknown): value is SessionCapsule {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['session_id'] === 'string' &&
    typeof v['platform'] === 'string' &&
    typeof v['minted_at'] === 'string' &&
    typeof v['worktree_root'] === 'string'
  );
}

function defaultMintIdSuffix(): string {
  return crypto.randomBytes(6).toString('hex');
}

/**
 * Delete any pre-existing capsule files in `sessionsDir` whose
 * `worktree_root` (resolved through fs.realpathSync — same rule
 * `readCapsule` uses) matches the given worktreeRoot.
 *
 * This is the substrate-level fix for the recurring session-id drift
 * that has been forcing agents to normalize `caws claim --takeover`.
 * Pre-fix: multiple capsules accumulate per worktree_root across
 * Claude Code session restarts; the first one found by readdirSync
 * wins, but which one wins is filesystem-order-dependent and
 * effectively random. Post-fix: at most one capsule exists for any
 * given worktree_root at any time.
 *
 * Failures are non-fatal — the new capsule is still written. The
 * caller surfaces failures as a warning Diagnostic on the Result.
 */
function cleanupSupersededCapsules(
  sessionsDir: string,
  worktreeRoot: string
): { deleted: string[]; warnings: Diagnostic[] } {
  const deleted: string[] = [];
  const warnings: Diagnostic[] = [];

  let entries: string[];
  try {
    entries = fs.readdirSync(sessionsDir);
  } catch {
    // Directory doesn't exist yet → nothing to clean up.
    return { deleted, warnings };
  }

  // Resolve real paths (matching readCapsule's logic so /tmp vs
  // /private/tmp on macOS doesn't strand stale capsules).
  let worktreeRealRoot: string;
  try {
    worktreeRealRoot = fs.realpathSync(worktreeRoot);
  } catch {
    worktreeRealRoot = worktreeRoot;
  }

  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const capsulePath = path.join(sessionsDir, name);
    let raw: string;
    try {
      raw = fs.readFileSync(capsulePath, 'utf8');
    } catch (e) {
      warnings.push(
        diag(
          SHELL_RULES.SESSION_CAPSULE_CLEANUP_FAILED,
          `Could not read capsule for cleanup: ${(e as Error).message}`,
          { capsulePath }
        )
      );
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Unparseable JSON — leave it alone; we don't know if it
      // matches our worktree_root and we shouldn't delete what we
      // can't classify.
      continue;
    }
    if (!isCapsuleShape(parsed)) continue;

    let capsuleWorktreeReal: string;
    try {
      capsuleWorktreeReal = fs.realpathSync(parsed.worktree_root);
    } catch {
      capsuleWorktreeReal = parsed.worktree_root;
    }
    if (capsuleWorktreeReal !== worktreeRealRoot) continue;

    // Match — delete.
    try {
      fs.unlinkSync(capsulePath);
      deleted.push(capsulePath);
    } catch (e) {
      warnings.push(
        diag(
          SHELL_RULES.SESSION_CAPSULE_CLEANUP_FAILED,
          `Could not delete superseded capsule: ${(e as Error).message}`,
          { capsulePath }
        )
      );
    }
  }

  return { deleted, warnings };
}

function mintCapsule(
  opts: ResolveSessionOptions
): Result<{
  capsule: SessionCapsule;
  capsulePath: string;
  cleanupWarnings: Diagnostic[];
}> {
  const now = (opts.now ?? (() => new Date()))();
  const suffix = (opts.mintIdSuffix ?? defaultMintIdSuffix)();
  const platform = opts.platform ?? process.platform;
  const sessionId = `caws-${suffix}`;
  const capsule: SessionCapsule = {
    session_id: sessionId,
    platform,
    minted_at: now.toISOString(),
    worktree_root: opts.worktreeRoot,
  };
  const sessionsDir = path.join(opts.cawsDir, SESSIONS_DIRNAME);
  try {
    fs.mkdirSync(sessionsDir, { recursive: true });
  } catch (e) {
    return err([
      diag(
        SHELL_RULES.SESSION_CAPSULE_WRITE_FAILED,
        `Failed to create sessions directory: ${(e as Error).message}`,
        { sessionsDir }
      ),
    ]);
  }
  // Cleanup BEFORE write — guarantees the per-worktree-root uniqueness
  // invariant on success. Cleanup failures are recorded as warnings;
  // the mint itself does not fail.
  const cleanup = cleanupSupersededCapsules(sessionsDir, opts.worktreeRoot);

  const capsulePath = path.join(sessionsDir, `${sessionId}.json`);
  const writeResult = writeFileAtomic(
    capsulePath,
    JSON.stringify(capsule, null, 2) + '\n'
  );
  if (!writeResult.ok) {
    return err([
      diag(
        SHELL_RULES.SESSION_CAPSULE_WRITE_FAILED,
        `Failed to write capsule: ${writeResult.errors[0]?.message ?? 'unknown error'}`,
        { capsulePath }
      ),
    ]);
  }
  return ok({
    capsule,
    capsulePath,
    cleanupWarnings: cleanup.warnings,
  });
}

export function resolveSession(
  opts: ResolveSessionOptions
): Result<ResolvedSession> {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const allowMint = opts.allowMint === true;

  // 1. CLAUDE_SESSION_ID env (authority source #1 — operator override)
  const claudeId = env['CLAUDE_SESSION_ID'];
  if (typeof claudeId === 'string' && claudeId.length > 0) {
    return ok({
      identity: { session_id: claudeId, platform: 'claude-code' },
      source: 'claude_env',
    });
  }

  // 2. HOOK_SESSION_ID env (authority source #2 — harness-stable id
  //    exported by the Claude Code hook envelope via lib/parse-input.sh).
  //    Refuse the literal 'unknown' (parse-input.sh's fallback when the
  //    hook payload lacked a session_id); admitting it would alias every
  //    broken-context invocation into one shared capsule. Empty string
  //    is also refused.
  const hookId = env['HOOK_SESSION_ID'];
  if (typeof hookId === 'string' && hookId.length > 0 && hookId !== 'unknown') {
    return ok({
      identity: { session_id: hookId, platform: 'claude-code' },
      source: 'hook_env',
    });
  }

  // 3. Capsule on disk (authority source #3)
  const cap = readCapsule(opts.cawsDir, opts.worktreeRoot);
  if (cap !== null) {
    return ok({
      identity: {
        session_id: cap.capsule.session_id,
        platform: cap.capsule.platform,
      },
      source: 'capsule',
      capsulePath: cap.capsulePath,
    });
  }

  // 4. CURSOR_TRACE_ID env (low-stability fallback)
  const cursorId = env['CURSOR_TRACE_ID'];
  if (typeof cursorId === 'string' && cursorId.length > 0) {
    return ok({
      identity: { session_id: cursorId, platform: 'cursor' },
      source: 'cursor_env',
    });
  }

  // 5. Mint a capsule — only when caller has opted in.
  if (!allowMint) {
    return err([
      diag(
        SHELL_RULES.SESSION_NO_STABLE_IDENTITY,
        'No stable session identity could be resolved. Set CLAUDE_SESSION_ID or run a write-class command to mint a capsule.',
        { platform, cawsDir: opts.cawsDir, worktreeRoot: opts.worktreeRoot }
      ),
    ]);
  }
  const minted = mintCapsule(opts);
  if (!minted.ok) return minted;
  // Thread cleanup warnings (if any) through the Result so observers
  // can see when superseded-capsule deletion failed without the mint
  // itself failing.
  const cleanupWarnings = minted.value.cleanupWarnings;
  return ok(
    {
      identity: {
        session_id: minted.value.capsule.session_id,
        platform: minted.value.capsule.platform,
      },
      source: 'minted',
      capsulePath: minted.value.capsulePath,
    },
    cleanupWarnings.length > 0 ? cleanupWarnings : undefined,
  );
}

// Re-export for shell consumers that want a single info-level finding to
// render alongside resolved-from-capsule results.
export function describeSessionSource(s: ResolvedSession): Diagnostic {
  switch (s.source) {
    case 'claude_env':
      return infoDiag(
        SHELL_RULES.SESSION_RESOLVED_FROM_CLAUDE_ENV,
        `Session identity from CLAUDE_SESSION_ID env: ${s.identity.session_id}`
      );
    case 'hook_env':
      return infoDiag(
        SHELL_RULES.SESSION_RESOLVED_FROM_HOOK_ENV,
        `Session identity from HOOK_SESSION_ID env (Claude Code hook envelope): ${s.identity.session_id}`
      );
    case 'capsule':
      return infoDiag(
        SHELL_RULES.SESSION_RESOLVED_FROM_CAPSULE,
        `Session identity from capsule: ${s.identity.session_id}`,
        s.capsulePath !== undefined ? { capsulePath: s.capsulePath } : undefined
      );
    case 'cursor_env':
      return infoDiag(
        SHELL_RULES.SESSION_RESOLVED_FROM_CURSOR_ENV,
        `Session identity from CURSOR_TRACE_ID env (low-stability fallback): ${s.identity.session_id}`
      );
    case 'minted':
      return infoDiag(
        SHELL_RULES.SESSION_CAPSULE_MINTED,
        `Minted new session capsule: ${s.identity.session_id}`,
        s.capsulePath !== undefined ? { capsulePath: s.capsulePath } : undefined
      );
  }
}
