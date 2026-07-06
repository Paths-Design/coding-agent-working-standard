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
//                                value is the literal "unknown")
//   2.5. Durable hook envelope → platform = envelope.platform ?? "claude-code"
//                                (CAWS-SESSION-ID-DURABLE-HOOK-ENVELOPE-001;
//                                bridges HOOK_SESSION_ID across agent-Bash
//                                invocations where the env var doesn't
//                                propagate. Reads
//                                <repo_root>/.caws/sessions/<id>/.session-envelope.json
//                                (new home; legacy <repo_root>/tmp/<id>/ is
//                                a bounded read-both fallback —
//                                CAWS-SESSION-LOG-RELOCATE-001)
//                                files written by hook scripts. Filters by
//                                repo_root + 24h freshness on last_seen_at.
//                                Refuses with typed ambiguity diagnostic
//                                when two or more candidates match;
//                                NEVER newest-wins. The platform field is
//                                sourced from CAWS_PLATFORM_FLAG by
//                                parse-input.sh
//                                (CAWS-RESOLVER-PLATFORM-FROM-ENVELOPE-001);
//                                absent on legacy envelopes, which fall back
//                                to 'claude-code'.)
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

// CAWS-SESSION-ID-DURABLE-HOOK-ENVELOPE-001
// CAWS-SESSION-LOG-RELOCATE-001: per-session state moved out of repo-root
// tmp/ to `<repoRoot>/.caws/sessions/`. The resolver scans the new home
// first and, as a BOUNDED transition fallback, the legacy `tmp/` home so an
// in-flight session whose envelope was written to the old path before this
// slice landed is not orphaned. New writes go ONLY to .caws/sessions/.
//
// NOTE: the new envelope home is `<cawsDir>/sessions/`, the SAME directory
// that holds capsules (`<id>.json`) and the caller-pointer
// (`.caller-session.json`). Envelopes live in per-session SUBDIRS
// (`<id>/.session-envelope.json`), so they don't collide with the flat
// capsule files; capsule scanning skips dotfiles + non-`.json` entries so
// the caller-pointer and session subdirs are not mis-parsed as capsules.
const DURABLE_ENVELOPE_NEW_DIRNAME = SESSIONS_DIRNAME; // under .caws/
// LEGACY-TMP-FALLBACK (CAWS-SESSION-LOG-RELOCATE-001): remove this legacy
// read once pre-relocation tmp/<id>/ envelope dirs have aged out past the
// freshness window (see docs/failure-lineage.md). Dual-read is a bounded
// transition aid, NOT an indefinite contract.
const DURABLE_ENVELOPE_LEGACY_DIRNAME = 'tmp'; // legacy repo-root tmp/
const DURABLE_ENVELOPE_FILENAME = '.session-envelope.json';
const DURABLE_ENVELOPE_FRESHNESS_MS = 24 * 60 * 60 * 1000;

// CAWS-WORKTREE-OWNERSHIP-HARNESS-ID-001
// Per-repo caller-session pointer. CAWS-SESSION-LOG-RELOCATE-001 moved it
// from `<repoRoot>/tmp/.caller-session.json` to
// `<repoRoot>/.caws/sessions/.caller-session.json` (read new-then-legacy).
// Written/refreshed by the hook (parse-input.sh) from the authoritative
// hook-payload session_id. Consumed ONLY to disambiguate the
// >=2-fresh-envelope case in agent-Bash where HOOK_SESSION_ID is absent.
// Evidence, not authority: it can only narrow an ambiguous candidate set
// to the caller's own envelope; it never widens authority, never relaxes
// the foreign-claim refusal, and is NEVER a newest-wins fallback.
const CALLER_SESSION_POINTER_FILENAME = '.caller-session.json';

interface CallerSessionPointerShape {
  readonly session_id: string;
  readonly repo_root: string;
  readonly last_seen_at: string;
}

function isCallerSessionPointerShape(
  v: unknown
): v is CallerSessionPointerShape {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.session_id === 'string' &&
    o.session_id.length > 0 &&
    typeof o.last_seen_at === 'string'
  );
}

/**
 * Build the ordered list of session-state home directories to scan:
 * the NEW `.caws/sessions/` home first, then the LEGACY repo-root `tmp/`
 * home (CAWS-SESSION-LOG-RELOCATE-001 bounded read-both fallback).
 *
 * Derived from repoRoot (= `path.dirname(cawsDir)`). The new home is
 * `<repoRoot>/.caws/sessions`; the legacy home is `<repoRoot>/tmp`.
 */
function sessionStateHomes(repoRoot: string): {
  newDir: string;
  legacyDir: string;
  all: string[];
} {
  const newDir = path.join(
    repoRoot,
    '.caws',
    DURABLE_ENVELOPE_NEW_DIRNAME
  );
  const legacyDir = path.join(repoRoot, DURABLE_ENVELOPE_LEGACY_DIRNAME);
  return { newDir, legacyDir, all: [newDir, legacyDir] };
}

/**
 * Read the caller-session pointer and return the named session_id IFF a
 * pointer exists, parses, is repo-matched, and is fresh (same freshness
 * window as envelopes). Scans the NEW `.caws/sessions/.caller-session.json`
 * first, then the LEGACY `tmp/.caller-session.json` (read-both fallback,
 * CAWS-SESSION-LOG-RELOCATE-001) — first positive hit wins.
 * Returns null on any miss — absent, unreadable, malformed, repo
 * mismatch, or stale, in BOTH homes. Total and non-throwing: a
 * missing/bad pointer MUST degrade to the existing ambiguity refusal,
 * never to a guess.
 */
function readCallerSessionPointer(args: {
  repoRootReal: string;
  dirs: string[];
  nowMs: number;
}): string | null {
  for (const dir of args.dirs) {
    const hit = readCallerSessionPointerFromDir({
      repoRootReal: args.repoRootReal,
      dir,
      nowMs: args.nowMs,
    });
    if (hit !== null) return hit;
  }
  return null;
}

/** Single-directory caller-pointer read (see readCallerSessionPointer). */
function readCallerSessionPointerFromDir(args: {
  repoRootReal: string;
  dir: string;
  nowMs: number;
}): string | null {
  const pointerPath = path.join(args.dir, CALLER_SESSION_POINTER_FILENAME);
  let raw: string;
  try {
    raw = fs.readFileSync(pointerPath, 'utf8');
  } catch {
    return null; // absent or unreadable
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // malformed
  }
  if (!isCallerSessionPointerShape(parsed)) return null;

  // Repo-root filter (realpath both sides; tolerate a missing field by
  // skipping the filter only when the pointer omits repo_root — but the
  // shape guard requires session_id + last_seen_at, not repo_root, so a
  // pointer without repo_root is treated as repo-agnostic and accepted).
  if (typeof (parsed as { repo_root?: unknown }).repo_root === 'string') {
    let pointerRepoReal: string;
    try {
      pointerRepoReal = fs.realpathSync((parsed as CallerSessionPointerShape).repo_root);
    } catch {
      pointerRepoReal = (parsed as CallerSessionPointerShape).repo_root;
    }
    if (pointerRepoReal !== args.repoRootReal) return null;
  }

  // Freshness filter on last_seen_at, same window as envelopes.
  const lastSeenMs = Date.parse(parsed.last_seen_at);
  if (
    !Number.isFinite(lastSeenMs) ||
    lastSeenMs < args.nowMs - DURABLE_ENVELOPE_FRESHNESS_MS
  ) {
    return null; // stale
  }
  return parsed.session_id;
}

interface DurableEnvelopeShape {
  readonly session_id: string;
  readonly repo_root: string;
  readonly created_at: string;
  readonly last_seen_at: string;
  readonly hook_event: string;
  /**
   * Surface identity written by parse-input.sh
   * (CAWS-RESOLVER-PLATFORM-FROM-ENVELOPE-001): claude-code, codex, opencode,
   * zcode, cursor, or windsurf. Absent on envelopes written by older
   * parse-input.sh; the resolver falls back to 'claude-code' for back-compat
   * so a legacy envelope resolves identically to pre-fix behavior.
   */
  readonly platform?: string;
}

interface DurableEnvelopeCandidate {
  readonly envelope: DurableEnvelopeShape;
  readonly envelopePath: string;
}

function isDurableEnvelopeShape(v: unknown): v is DurableEnvelopeShape {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.session_id === 'string' &&
    o.session_id.length > 0 &&
    typeof o.repo_root === 'string' &&
    typeof o.last_seen_at === 'string'
  );
}

/**
 * Scan one or more session-state home directories for durable
 * hook-session envelopes (`<dir>/<id>/.session-envelope.json`) matching
 * the current call's repo_root and within the freshness window.
 *
 * CAWS-SESSION-LOG-RELOCATE-001: `args.dirs` is the ordered home list
 * (new `.caws/sessions/` first, legacy `tmp/` second). The scan visits
 * every directory and DEDUPES by session_id — the FIRST directory that
 * yields a given session_id wins, so a relocated envelope at the new
 * path shadows a stale duplicate left behind in legacy `tmp/`.
 *
 * Returns:
 *   - { candidates: [...] } filtered, freshness-checked, deduped.
 *     Caller decides accept/refuse based on count.
 *   - Diagnostic warnings for any malformed envelopes encountered
 *     (non-fatal — the scan continues past malformed files).
 *
 * Per invariant 5: scan failures are non-fatal. A missing or
 * unreadable directory contributes no candidates and no warnings.
 * The durable-envelope path is operational cache; the resolver falls
 * through cleanly when nothing matches.
 *
 * Per invariant 7: stale envelopes (last_seen_at > 24h ago) are
 * silently skipped — never deleted from the read path. Cleanup is
 * operator-driven (`rm -rf .caws/sessions/<id>/`).
 */
function scanDurableEnvelopes(args: {
  repoRoot: string;
  dirs: string[];
  now: Date;
}): { candidates: DurableEnvelopeCandidate[]; warnings: Diagnostic[] } {
  const warnings: Diagnostic[] = [];
  const candidates: DurableEnvelopeCandidate[] = [];
  const seenSessionIds = new Set<string>();

  let repoRootReal: string;
  try {
    repoRootReal = fs.realpathSync(args.repoRoot);
  } catch {
    repoRootReal = args.repoRoot;
  }

  const nowMs = args.now.getTime();
  const freshnessFloorMs = nowMs - DURABLE_ENVELOPE_FRESHNESS_MS;

  for (const dir of args.dirs) {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      // No such directory or unreadable — no candidates, no warnings.
      // Common for the legacy tmp/ home in repos that never wrote there.
      continue;
    }

    for (const name of entries) {
      // Skip dotfiles (e.g. .caller-session.json now lives in the new
      // home alongside the per-session subdirs) — only `<id>/` subdirs
      // hold envelopes.
      if (name.startsWith('.')) continue;
      const envelopePath = path.join(dir, name, DURABLE_ENVELOPE_FILENAME);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(envelopePath);
      } catch {
        // No envelope file in this <name>/ subdir (might be a
        // session-log dir, a test dir, capsule files, or any other
        // content). Skip silently.
        continue;
      }
      if (!stat.isFile()) continue;

      let raw: string;
      try {
        raw = fs.readFileSync(envelopePath, 'utf8');
      } catch (e) {
        warnings.push(
          diag(
            SHELL_RULES.SESSION_DURABLE_ENVELOPE_MALFORMED,
            `durable envelope read failed: ${(e as Error).message}`,
            { envelopePath }
          )
        );
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        warnings.push(
          diag(
            SHELL_RULES.SESSION_DURABLE_ENVELOPE_MALFORMED,
            `durable envelope JSON parse failed: ${(e as Error).message}`,
            { envelopePath }
          )
        );
        continue;
      }

      if (!isDurableEnvelopeShape(parsed)) {
        warnings.push(
          diag(
            SHELL_RULES.SESSION_DURABLE_ENVELOPE_MALFORMED,
            'durable envelope missing required fields (session_id, repo_root, last_seen_at)',
            { envelopePath }
          )
        );
        continue;
      }

      // Repo-root filter: realpath both sides to defeat /tmp vs
      // /private/tmp differences on macOS.
      let envRepoRootReal: string;
      try {
        envRepoRootReal = fs.realpathSync(parsed.repo_root);
      } catch {
        envRepoRootReal = parsed.repo_root;
      }
      if (envRepoRootReal !== repoRootReal) {
        // Envelope belongs to a different repo. Skip — NOT a warning;
        // this is normal multi-repo developer state.
        continue;
      }

      // Freshness filter on last_seen_at (NOT created_at — long-lived
      // active sessions stay fresh via per-hook refresh per invariant 2).
      const lastSeenMs = Date.parse(parsed.last_seen_at);
      if (!Number.isFinite(lastSeenMs) || lastSeenMs < freshnessFloorMs) {
        // Stale. Skip silently — operator-driven cleanup, not auto-delete.
        continue;
      }

      // Dedup by session_id. First home (new `.caws/sessions/`) wins:
      // a relocated envelope shadows a stale duplicate in legacy tmp/.
      if (seenSessionIds.has(parsed.session_id)) continue;
      seenSessionIds.add(parsed.session_id);

      candidates.push({ envelope: parsed, envelopePath });
    }
  }

  return { candidates, warnings };
}

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
    // CAWS-SESSION-LOG-RELOCATE-001: the session-state relocation put
    // `.caller-session.json` (a dotfile) in this same directory. Skip
    // dotfiles so it is not mis-read as a malformed capsule.
    if (name.startsWith('.')) continue;
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
    // CAWS-SESSION-LOG-RELOCATE-001: skip dotfiles (the relocated
    // .caller-session.json shares this directory and is not a capsule).
    if (name.startsWith('.')) continue;
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

  // 1.5. CLAUDE_CODE_SESSION_ID env (authority source #1.5 — the harness's
  //      own per-session UUID, exported by Claude Code into EVERY tool
  //      subprocess, including the agent's Bash tool. Unlike HOOK_SESSION_ID
  //      (set only inside the hook's own shell, so it does NOT propagate to
  //      an agent-issued `caws` call), CLAUDE_CODE_SESSION_ID survives the
  //      tool boundary. Admitting it here resolves the agent-Bash write path
  //      deterministically to the true caller, so concurrent sessions no
  //      longer fall through to the racy tmp/.caller-session.json pointer
  //      (the last-writer-wins singleton that caused worktree-ownership
  //      misattribution). CAWS-SESSION-ID-AGENT-BASH-PROPAGATION-001.
  //
  //      Refuse the literal 'unknown' and empty string for the same reason
  //      tier-2 does: never alias a broken context into a shared identity.
  //      Stays below CLAUDE_SESSION_ID so the operator override still wins.
  const claudeCodeId = env['CLAUDE_CODE_SESSION_ID'];
  if (
    typeof claudeCodeId === 'string' &&
    claudeCodeId.length > 0 &&
    claudeCodeId !== 'unknown'
  ) {
    return ok({
      identity: { session_id: claudeCodeId, platform: 'claude-code' },
      source: 'claude_code_env',
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

  // 2.5. Durable hook envelope on disk (authority source #2.5)
  //      CAWS-SESSION-ID-DURABLE-HOOK-ENVELOPE-001: bridges
  //      HOOK_SESSION_ID across agent-Bash invocations where the env
  //      var doesn't propagate. The hook script writes/refreshes
  //      `<repo_root>/.caws/sessions/<id>/.session-envelope.json` on every
  //      fire (CAWS-SESSION-LOG-RELOCATE-001; legacy `<repo_root>/tmp/<id>/`
  //      is read as a bounded transition fallback); the resolver scans them
  //      filtered by repo_root + freshness.
  //
  //      Authority discipline:
  //        - Repo-root filter is mandatory (no blind tmp/* scan).
  //        - Stale envelopes (>24h on last_seen_at) skipped silently.
  //        - Malformed envelopes skipped with non-fatal warning.
  //        - Two or more fresh matches → REFUSE with typed ambiguity
  //          diagnostic. NEVER newest-wins.
  //        - Zero matches → fall through to capsule (priority 3).
  //
  //      Derive repoRoot from cawsDir (cawsDir is `<repoRoot>/.caws`).
  //      CAWS-SESSION-LOG-RELOCATE-001: scan the NEW `.caws/sessions/`
  //      home first, then the LEGACY repo-root `tmp/` home (bounded
  //      read-both fallback so a pre-relocation in-flight session is not
  //      orphaned).
  const repoRoot = path.dirname(opts.cawsDir);
  const homes = sessionStateHomes(repoRoot);
  const envScan = scanDurableEnvelopes({
    repoRoot,
    dirs: homes.all,
    now: opts.now ? opts.now() : new Date(),
  });
  if (envScan.candidates.length >= 2) {
    // CAWS-WORKTREE-OWNERSHIP-HARNESS-ID-001: before refusing, consult the
    // governed caller-session pointer. In agent-Bash HOOK_SESSION_ID is
    // absent (source 2 skipped), so this pointer is the only caller-
    // identity signal available to disambiguate. If it positively names
    // exactly one of the fresh candidates, select that candidate — the
    // caller's own envelope. This is an explicit identity match, NOT a
    // recency heuristic; "NEVER newest-wins" is preserved. Absent / stale /
    // malformed / non-matching pointer → fall through to the refusal below.
    let repoRootReal: string;
    try {
      repoRootReal = fs.realpathSync(repoRoot);
    } catch {
      repoRootReal = repoRoot;
    }
    const callerId = readCallerSessionPointer({
      repoRootReal,
      dirs: homes.all,
      nowMs: (opts.now ? opts.now() : new Date()).getTime(),
    });
    if (callerId !== null) {
      const matches = envScan.candidates.filter(
        (c) => c.envelope.session_id === callerId
      );
      if (matches.length === 1) {
        const mine = matches[0]!;
        return ok(
          {
            identity: {
              session_id: mine.envelope.session_id,
              platform: mine.envelope.platform ?? 'claude-code',
            },
            source: 'durable_hook_envelope',
            envelopePath: mine.envelopePath,
          },
          envScan.warnings.length > 0 ? envScan.warnings : undefined
        );
      }
    }

    const ids = envScan.candidates.map((c) => c.envelope.session_id);
    const paths = envScan.candidates.map((c) => c.envelopePath);
    return err([
      diag(
        SHELL_RULES.SESSION_DURABLE_ENVELOPE_AMBIGUOUS,
        `Multiple fresh durable hook envelopes match repo_root ${repoRoot}. The resolver cannot pick a winner. Disambiguate by setting CLAUDE_SESSION_ID, by routing through a hook context that sets HOOK_SESSION_ID, or by removing stale .caws/sessions/<id>/ directories (or legacy tmp/<id>/ dirs) for sessions that have ended.`,
        {
          repoRoot,
          candidateCount: envScan.candidates.length,
          candidateSessionIds: ids,
          candidateEnvelopePaths: paths,
        }
      ),
      ...envScan.warnings,
    ]);
  }
  if (envScan.candidates.length === 1) {
    const sole = envScan.candidates[0]!;
    return ok(
      {
        identity: {
          session_id: sole.envelope.session_id,
          // CAWS-RESOLVER-PLATFORM-FROM-ENVELOPE-001: prefer the envelope's
          // recorded platform; fall back to 'claude-code' for legacy
          // envelopes written before the platform field existed.
          platform: sole.envelope.platform ?? 'claude-code',
        },
        source: 'durable_hook_envelope',
        envelopePath: sole.envelopePath,
      },
      envScan.warnings.length > 0 ? envScan.warnings : undefined,
    );
  }
  // envScan.candidates.length === 0: fall through to capsule.
  // Warnings (if any malformed envelopes were encountered) are dropped
  // here — the resolver returns ok() from the capsule branch and we
  // don't have a clean way to thread warnings through. Operators see
  // these via direct envelope-shape inspection.

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
    case 'claude_code_env':
      return infoDiag(
        SHELL_RULES.SESSION_RESOLVED_FROM_CLAUDE_CODE_ENV,
        `Session identity from CLAUDE_CODE_SESSION_ID env (Claude Code harness, survives the tool boundary): ${s.identity.session_id}`
      );
    case 'hook_env':
      return infoDiag(
        SHELL_RULES.SESSION_RESOLVED_FROM_HOOK_ENV,
        `Session identity from HOOK_SESSION_ID env (Claude Code hook envelope): ${s.identity.session_id}`
      );
    case 'durable_hook_envelope':
      return infoDiag(
        SHELL_RULES.SESSION_RESOLVED_FROM_DURABLE_ENVELOPE,
        `Session identity from durable hook envelope: ${s.identity.session_id}`,
        s.envelopePath !== undefined ? { envelopePath: s.envelopePath } : undefined
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
    // CAWS-SESSION-LOG-RELOCATE-001: skip dotfiles (the relocated
    // .caller-session.json shares this directory and is not a capsule).
    if (name.startsWith('.')) continue;
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

  // 1.5. CLAUDE_CODE_SESSION_ID env (refuse literal 'unknown' and empty).
  //      CAWS-SESSION-ID-AGENT-BASH-PROPAGATION-001: the harness UUID that
  //      survives the tool boundary into agent-Bash. Admitted as a candidate
  //      so ownership comparison can match a worktree owner stamped from this
  //      same source — exact session_id equality, never widens authority.
  const claudeCodeId = env['CLAUDE_CODE_SESSION_ID'];
  if (
    typeof claudeCodeId === 'string' &&
    claudeCodeId.length > 0 &&
    claudeCodeId !== 'unknown'
  ) {
    candidates.push({
      identity: { session_id: claudeCodeId, platform: 'claude-code' },
      source: 'claude_code_env',
    });
    trace.push({
      source: 'claude_code_env',
      outcome: 'admitted',
      count: 1,
      admittedIds: [claudeCodeId],
    });
  } else if (claudeCodeId === 'unknown') {
    trace.push({
      source: 'claude_code_env',
      outcome: 'rejected',
      reason: 'CLAUDE_CODE_SESSION_ID is literal "unknown"',
    });
  } else {
    trace.push({
      source: 'claude_code_env',
      outcome: 'absent',
      reason: 'CLAUDE_CODE_SESSION_ID not set',
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

  // 2.5. Durable hook envelopes on disk
  //      CAWS-WORKTREE-DESTROY-GHOST-ENTRY-OWNER-UNRESOLVABLE-001.
  //
  //      This source MIRRORS resolveSession's step 2.5 — the same
  //      scanDurableEnvelopes() over `<repoRoot>/.caws/sessions/<id>/.session-envelope.json`
  //      (new home; legacy `<repoRoot>/tmp/<id>/` is the bounded read-both
  //      fallback — CAWS-SESSION-LOG-RELOCATE-001),
  //      repo-root-filtered and freshness-checked — but with one
  //      deliberate divergence in the >=2 case.
  //
  //      resolveSession() REFUSES on >=2 fresh envelopes because it must
  //      pick exactly ONE identity to STAMP onto a new record; guessing
  //      would be newest-wins, which the spec forbids.
  //
  //      resolveSessionCandidates() ADMITS ALL fresh envelopes. This is an
  //      ownership-COMPARISON surface — the question is "can the invoking
  //      process speak for the registered owner?", answered downstream by
  //      admitsOwner()'s exact session_id equality. Admitting every fresh
  //      envelope cannot widen authority: a foreign owner whose envelope is
  //      not on disk still has no matching candidate, so the destroy/merge
  //      refusal still fires (A4). What it DOES fix is the ghost-entry case
  //      where the registered owner IS one of the fresh envelopes (the
  //      caller's own claude-code UUID session) but, in agent-Bash,
  //      HOOK_SESSION_ID is absent and no capsule carries that UUID — so the
  //      pre-fix candidate set never saw the owner, and destroy refused a
  //      worktree the caller legitimately owns. `caws status` already
  //      resolved that same UUID as "self" via this exact envelope source;
  //      this aligns the comparison surface with the display surface.
  const repoRoot = path.dirname(opts.cawsDir);
  const homes = sessionStateHomes(repoRoot);
  const envScan = scanDurableEnvelopes({
    repoRoot,
    dirs: homes.all,
    now: opts.now ? opts.now() : new Date(),
  });
  if (envScan.candidates.length > 0) {
    for (const c of envScan.candidates) {
      candidates.push({
        identity: {
          session_id: c.envelope.session_id,
          platform: c.envelope.platform ?? 'claude-code',
        },
        source: 'durable_hook_envelope',
        envelopePath: c.envelopePath,
      });
    }
    trace.push({
      source: 'durable_hook_envelope',
      outcome: 'admitted',
      count: envScan.candidates.length,
      admittedIds: envScan.candidates.map((c) => c.envelope.session_id),
    });
  } else {
    trace.push({
      source: 'durable_hook_envelope',
      outcome: 'absent',
      reason: `no fresh durable hook envelope under ${homes.newDir} (or legacy ${homes.legacyDir}) matched repo_root ${repoRoot}`,
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
