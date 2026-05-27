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
  CandidateTraceEntry,
  ResolveCandidatesOptions,
  ResolveSessionOptions,
  ResolvedSession,
  SessionCandidate,
  SessionCandidates,
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

// ─── resolveSessionCandidates ───────────────────────────────────────────
//
// Multi-source admission helper. Returns ZERO or more SessionIdentity
// candidates plus a diagnostic trace. NEVER mints. Designed for the
// ownership-comparison surfaces (worktree destroy, merge) where the
// question is "is the invoking process speaking for the registered
// owner?" rather than "what identity should we stamp on a new record?".
//
// Source order MIRRORS resolveSession (CLAUDE_SESSION_ID,
// HOOK_SESSION_ID, capsules, CURSOR_TRACE_ID) but is EXHAUSTIVE — every
// source is consulted, not first-match. Capsules contribute every
// well-formed entry under .caws/sessions/*.json regardless of
// worktree_root, eliminating the cwd-sensitivity that caused
// CAWS-WORKTREE-DESTROY-SESSION-RESOLUTION-001.
//
// Why no mint: ownership comparison should never invent an identity
// that didn't exist before the comparison started. Minting on a failed
// match would (a) leave a stale capsule on disk after a refused
// comparison and (b) make the comparison's "no match" outcome
// non-reproducible because the mint randomized state. The right
// behavior on no-candidates-match is the refusal that the destroy/merge
// command already issues, surfaced with the trace so the user sees
// which sources were consulted.

function readAllCapsules(
  cawsDir: string
): {
  candidates: SessionCandidate[];
  trace: CandidateTraceEntry;
} {
  const sessionsDir = path.join(cawsDir, SESSIONS_DIRNAME);
  let entries: string[];
  try {
    entries = fs.readdirSync(sessionsDir);
  } catch {
    return {
      candidates: [],
      trace: {
        source: 'capsule',
        outcome: 'absent',
        reason: 'sessions directory does not exist',
        count: 0,
      },
    };
  }
  // CAWS-WORKTREE-DESTROY-SESSION-RESOLUTION-001 L7: pin iteration
  // order so candidate ordering and diagnostic rendering are stable
  // across runs (readdirSync returns FS-order, which is not portable).
  entries.sort();

  const candidates: SessionCandidate[] = [];
  let rejectedCount = 0;
  let raceCount = 0;
  const rejectionReasons: string[] = [];
  const raceReasons: string[] = [];
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const capsulePath = path.join(sessionsDir, name);
    let raw: string;
    try {
      raw = fs.readFileSync(capsulePath, 'utf8');
    } catch (e) {
      // CAWS-WORKTREE-DESTROY-SESSION-RESOLUTION-001 L1: ENOENT
      // between readdir and readFile means a sibling process (e.g.,
      // another mint's cleanupSupersededCapsules) removed the file.
      // Surface as 'race' so operators don't debug it as a content
      // problem. Any other error (EACCES, EIO) is a real read failure.
      const err = e as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        raceCount++;
        raceReasons.push(`concurrent-removal: ${name}`);
      } else {
        rejectedCount++;
        rejectionReasons.push(`unreadable: ${name}: ${err.message}`);
      }
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      rejectedCount++;
      rejectionReasons.push(`unparseable: ${name}`);
      continue;
    }
    if (!isCapsuleShape(parsed)) {
      rejectedCount++;
      rejectionReasons.push(`malformed: ${name}`);
      continue;
    }
    candidates.push({
      identity: {
        session_id: parsed.session_id,
        platform: parsed.platform,
      },
      source: 'capsule',
      capsulePath,
    });
  }
  if (candidates.length > 0) {
    // CAWS-WORKTREE-DESTROY-SESSION-RESOLUTION-001 L2: record the
    // admitted session_ids so describeCandidateTrace can render them
    // in refusal diagnostics. The trace's job is to let an operator
    // see EXACTLY which identities were considered, not just a count.
    return {
      candidates,
      trace: {
        source: 'capsule',
        outcome: 'admitted',
        count: candidates.length,
        admittedIds: candidates.map((c) => c.identity.session_id),
      },
    };
  }
  if (rejectedCount > 0) {
    return {
      candidates: [],
      trace: {
        source: 'capsule',
        outcome: 'rejected',
        reason: rejectionReasons.join('; '),
        count: 0,
      },
    };
  }
  if (raceCount > 0) {
    return {
      candidates: [],
      trace: {
        source: 'capsule',
        outcome: 'race',
        reason: raceReasons.join('; '),
        count: 0,
      },
    };
  }
  return {
    candidates: [],
    trace: {
      source: 'capsule',
      outcome: 'absent',
      reason: 'no capsule files in sessions directory',
      count: 0,
    },
  };
}

/**
 * Resolve every session identity the current process can plausibly
 * speak for. See SessionCandidates docs in ./types.ts for the contract.
 *
 * Pure function over (env, cawsDir, on-disk capsule files). No mutation,
 * no minting, no side effects.
 */
export function resolveSessionCandidates(
  opts: ResolveCandidatesOptions
): SessionCandidates {
  const env = opts.env ?? process.env;
  const candidates: SessionCandidate[] = [];
  const trace: CandidateTraceEntry[] = [];

  // 1. CLAUDE_SESSION_ID env
  const claudeId = env['CLAUDE_SESSION_ID'];
  if (typeof claudeId === 'string' && claudeId.length > 0) {
    candidates.push({
      identity: { session_id: claudeId, platform: 'claude-code' },
      source: 'claude_env',
    });
    trace.push({
      source: 'claude_env',
      outcome: 'admitted',
      count: 1,
      admittedIds: [claudeId],
    });
  } else {
    trace.push({
      source: 'claude_env',
      outcome: 'absent',
      reason: 'CLAUDE_SESSION_ID not set',
    });
  }

  // 2. HOOK_SESSION_ID env (refuse literal 'unknown' and empty)
  const hookId = env['HOOK_SESSION_ID'];
  if (typeof hookId === 'string' && hookId.length > 0 && hookId !== 'unknown') {
    candidates.push({
      identity: { session_id: hookId, platform: 'claude-code' },
      source: 'hook_env',
    });
    trace.push({
      source: 'hook_env',
      outcome: 'admitted',
      count: 1,
      admittedIds: [hookId],
    });
  } else if (hookId === 'unknown') {
    trace.push({
      source: 'hook_env',
      outcome: 'rejected',
      reason: 'HOOK_SESSION_ID is literal "unknown" (parse-input.sh fallback)',
    });
  } else {
    trace.push({
      source: 'hook_env',
      outcome: 'absent',
      reason: 'HOOK_SESSION_ID not set',
    });
  }

  // 3. ALL capsules on disk (NOT cwd-keyed; that is the key distinction
  //    from resolveSession's step-3 behavior)
  const capsuleResult = readAllCapsules(opts.cawsDir);
  candidates.push(...capsuleResult.candidates);
  trace.push(capsuleResult.trace);

  // 4. CURSOR_TRACE_ID env (low-stability fallback)
  const cursorId = env['CURSOR_TRACE_ID'];
  if (typeof cursorId === 'string' && cursorId.length > 0) {
    candidates.push({
      identity: { session_id: cursorId, platform: 'cursor' },
      source: 'cursor_env',
    });
    trace.push({
      source: 'cursor_env',
      outcome: 'admitted',
      count: 1,
      admittedIds: [cursorId],
    });
  } else {
    trace.push({
      source: 'cursor_env',
      outcome: 'absent',
      reason: 'CURSOR_TRACE_ID not set',
    });
  }

  return { candidates, trace };
}

/**
 * Ownership-admission predicate: does any candidate in the set match
 * the given registered owner's session_id?
 *
 * Match semantics are session_id equality only. Platform is NOT
 * compared — a candidate sourced from CLAUDE_SESSION_ID env with
 * platform 'claude-code' is admissible against an owner record that
 * happens to lack platform metadata; this is the same equality rule
 * the destroyWorktree comparison uses today
 * (entry.owner.session_id !== input.session.session_id at
 * worktrees-writer.ts:772).
 */
export function admitsOwner(
  candidates: SessionCandidates,
  ownerSessionId: string
): SessionCandidate | null {
  for (const c of candidates.candidates) {
    if (c.identity.session_id === ownerSessionId) return c;
  }
  return null;
}

/**
 * Render the trace as a multi-line human-readable diagnostic. Used by
 * destroy/merge when admission fails — the user needs to see EXACTLY
 * which sources were consulted and why none matched, to satisfy the
 * spec's non_functional.reliability invariant against silent fallbacks.
 */
export function describeCandidateTrace(
  candidates: SessionCandidates
): string {
  const lines: string[] = [];
  for (const entry of candidates.trace) {
    const base = `  - ${entry.source}: ${entry.outcome}`;
    if (entry.outcome === 'admitted') {
      const count = entry.count ?? 0;
      lines.push(`${base} (count=${count})`);
      // CAWS-WORKTREE-DESTROY-SESSION-RESOLUTION-001 L2: render the
      // admitted session_ids so the operator can compare them against
      // the registered owner. IDs are truncated to the first 16 chars
      // (display-friendly; collision-resistant given the 12-hex-char
      // entropy of caws-${hex6} mint format). Full IDs remain on
      // entry.admittedIds for programmatic inspection.
      if (entry.admittedIds !== undefined && entry.admittedIds.length > 0) {
        for (const id of entry.admittedIds) {
          const display = id.length > 16 ? `${id.slice(0, 16)}…` : id;
          lines.push(`      candidate: ${display}`);
        }
      }
    } else {
      const detail = entry.reason !== undefined ? ` — ${entry.reason}` : '';
      lines.push(base + detail);
    }
  }
  return lines.join('\n');
}
