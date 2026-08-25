// Session-log retention planner/executor.
//
// SESSION-LOG-RETENTION-SCOPE-001. Session logs under `.caws/sessions/` are
// OPERATIONAL CACHE (gitignored; never events.jsonl, never read by the kernel
// for scope/ownership/claim decisions). The retention surface is dry-run by
// default, prunes ONLY per-session turn history (`turn-<NNN>.json`), and
// always preserves the identity capsule (`.session-envelope.json`),
// `.meta.json`, and top-level dotfiles (per-path exclusion).
//
// Pure reads for planning (no mutation); apply is a targeted unlink of only
// `turn-*.json` files in candidate dirs. Never writes `.caws/events.jsonl` or
// any governed state.

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Default retention window: 30 days (matches the operational-cache posture). */
export const DEFAULT_SESSION_LOG_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** A per-session turn-history file. Only these are retention-eligible. */
export const SESSION_LOG_TURN_RE = /^turn-\d+\.json$/;

/** One session directory with turn history eligible for retention. */
export interface SessionLogCandidate {
  readonly sessionId: string;
  /** Absolute paths of the turn-*.json files (the retention-eligible set). */
  readonly turnFiles: readonly string[];
  /** mtime (ms) of the newest turn file. */
  readonly lastActivityMs: number;
}

export interface SessionLogRetentionPlan {
  /** Session dirs whose turn history is older than the retention window. */
  readonly candidates: readonly SessionLogCandidate[];
  /** Session dirs excluded purely because they are current / have a live lease. */
  readonly protectedIds: readonly string[];
  /** Session dirs that are fresh (under the window), not candidates. */
  readonly skippedIds: readonly string[];
  /** Sum of retention-eligible turn files across candidates. */
  readonly totalTurnFiles: number;
}

/**
 * Scan `.caws/sessions/` and classify each session dir.
 *
 * Pure read: never deletes, never writes. A dir is a CANDIDATE when it has
 * turn-*.json files whose newest mtime is older than the retention window and
 * the session is not protected. Protected (excluded): the current session and
 * any session with a live lease. Fresh dirs (no stale turns) are skipped.
 * Dirs with no turn history are ignored (nothing to retain).
 */
export function planSessionLogRetention(
  cawsDir: string,
  opts: { readonly retentionMs: number; readonly now: number; readonly currentSessionId?: string; readonly liveSessionIds?: ReadonlySet<string> }
): SessionLogRetentionPlan {
  const sessionsDir = path.join(cawsDir, 'sessions');
  if (!fs.existsSync(sessionsDir)) {
    return { candidates: [], protectedIds: [], skippedIds: [], totalTurnFiles: 0 };
  }

  const candidates: SessionLogCandidate[] = [];
  const protectedIds: string[] = [];
  const skippedIds: string[] = [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
  } catch {
    return { candidates: [], protectedIds: [], skippedIds: [], totalTurnFiles: 0 };
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue; // dotfiles (caller-session, markers) & junk are not session dirs
    if (entry.name.startsWith('.')) continue; // defensive: no dotted dirs
    const sessionId = entry.name;
    const dirPath = path.join(sessionsDir, sessionId);

    let names: string[];
    try {
      names = fs.readdirSync(dirPath);
    } catch {
      continue; // unreadable dir: skip (missing != malformed)
    }
    const turnFiles = names
      .filter((n) => SESSION_LOG_TURN_RE.test(n))
      .map((n) => path.join(dirPath, n));
    if (turnFiles.length === 0) continue; // no turn history -> nothing to retain

    let lastActivityMs = 0;
    for (const f of turnFiles) {
      try {
        const st = fs.statSync(f);
        if (st.mtimeMs > lastActivityMs) lastActivityMs = st.mtimeMs;
      } catch {
        // a turn file that vanished between read and stat: treat as not the
        // newest; it is not deleted either (it is not in the plan).
      }
    }
    if (lastActivityMs === 0) continue;

    if (opts.currentSessionId !== undefined && sessionId === opts.currentSessionId) {
      protectedIds.push(sessionId);
      continue;
    }
    if (opts.liveSessionIds?.has(sessionId) === true) {
      protectedIds.push(sessionId);
      continue;
    }
    if (opts.now - lastActivityMs > opts.retentionMs) {
      candidates.push({ sessionId, turnFiles, lastActivityMs });
    } else {
      skippedIds.push(sessionId);
    }
  }

  return {
    candidates,
    protectedIds,
    skippedIds,
    totalTurnFiles: candidates.reduce((sum, c) => sum + c.turnFiles.length, 0),
  };
}

/**
 * Delete the retention-eligible turn files in `candidates`. Per-path exclusion:
 * only `turn-*.json` files are unlinked; `.session-envelope.json`, `.meta.json`,
 * and every other path in the dir are preserved. Returns the count removed.
 * Never writes events.jsonl or any governed state.
 */
export function applySessionLogRetention(
  candidates: readonly SessionLogCandidate[]
): number {
  let removed = 0;
  for (const candidate of candidates) {
    for (const file of candidate.turnFiles) {
      try {
        fs.unlinkSync(file);
        removed += 1;
      } catch {
        // a file that vanished or is unwritable: skip it rather than fail the
        // whole apply (operational cache; best-effort is the honest contract).
      }
    }
  }
  return removed;
}
