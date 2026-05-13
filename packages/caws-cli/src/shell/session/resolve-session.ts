// resolve-session — establish a SessionIdentity for the current shell call.
//
// This is the SOLE shell-side authority for "who is running this command?".
// Source order is pinned by the rewrite plan:
//
//   1. CLAUDE_SESSION_ID env  → platform = "claude-code"
//   2. CAWS session capsule    → on-disk `.caws/sessions/<id>.json` that
//                                names the current worktree root
//   3. CURSOR_TRACE_ID env     → platform = "cursor" (low-stability fallback)
//   4. mint a new capsule (only when `allowMint: true` is passed by the
//      caller — read-only commands MUST NOT pass this flag)
//
// Anything beyond this list — for example, inferring identity from
// `agents.json` last-active — is NOT permitted. agents.json freshness is
// display-only.

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

function mintCapsule(
  opts: ResolveSessionOptions
): Result<{ capsule: SessionCapsule; capsulePath: string }> {
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
  return ok({ capsule, capsulePath });
}

export function resolveSession(
  opts: ResolveSessionOptions
): Result<ResolvedSession> {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const allowMint = opts.allowMint === true;

  // 1. CLAUDE_SESSION_ID env (authority source #1)
  const claudeId = env['CLAUDE_SESSION_ID'];
  if (typeof claudeId === 'string' && claudeId.length > 0) {
    return ok({
      identity: { session_id: claudeId, platform: 'claude-code' },
      source: 'claude_env',
    });
  }

  // 2. Capsule on disk (authority source #2)
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

  // 3. CURSOR_TRACE_ID env (low-stability fallback)
  const cursorId = env['CURSOR_TRACE_ID'];
  if (typeof cursorId === 'string' && cursorId.length > 0) {
    return ok({
      identity: { session_id: cursorId, platform: 'cursor' },
      source: 'cursor_env',
    });
  }

  // 4. Mint a capsule — only when caller has opted in.
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
  return ok({
    identity: {
      session_id: minted.value.capsule.session_id,
      platform: minted.value.capsule.platform,
    },
    source: 'minted',
    capsulePath: minted.value.capsulePath,
  });
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
