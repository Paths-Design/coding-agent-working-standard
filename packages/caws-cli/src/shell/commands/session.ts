// `caws session prune` — dry-run-default retention for `.caws/sessions/`.
//
// SESSION-LOG-RETENTION-SCOPE-001. Session logs are OPERATIONAL CACHE: never
// events.jsonl, never read by the kernel for scope/ownership/claim decisions.
// This command prunes ONLY stale per-session turn history, preserves the
// identity capsule (.session-envelope.json) + .meta.json (per-path exclusion),
// protects the current session + sessions with a live lease, and NEVER appends
// an event or touches governed state.
//
// Exit codes: 0 = plan/applied; 2 = repo-root / composition failure.

import * as fs from 'node:fs';
import * as path from 'node:path';

import { isOk } from '../../kernel';
import { loadLeases, resolveRepoRoot } from '../../store';
import {
  applySessionLogRetention,
  DEFAULT_SESSION_LOG_RETENTION_MS,
  planSessionLogRetention,
} from '../../store/session-log-retention';
import { renderDiagnostics } from '../render/diagnostic';

const CALLER_SESSION_POINTER_FILENAME = '.caller-session.json';
/** A lease is "live" when not stopped and last_active is within this window. */
const LIVE_LEASE_TTL_MS = 15 * 60 * 1000;

export interface SessionPruneOptions {
  /** Retention window in ms. Defaults to 30 days. */
  readonly olderThanMs?: number;
  /** Apply the prune instead of dry-run. Default: dry-run. */
  readonly apply?: boolean;
  /** Emit a machine-readable JSON plan/outcome. */
  readonly json?: boolean;
  readonly cwd?: string;
  readonly now?: () => Date;
  readonly out?: (line: string) => void;
  readonly err?: (line: string) => void;
  readonly showData?: boolean;
}

function readCallerSessionId(cawsDir: string): string | undefined {
  const p = path.join(cawsDir, 'sessions', CALLER_SESSION_POINTER_FILENAME);
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const obj = JSON.parse(raw) as { session_id?: unknown };
    return typeof obj.session_id === 'string' && obj.session_id.length > 0
      ? obj.session_id
      : undefined;
  } catch {
    return undefined;
  }
}

function liveSessionIds(cawsDir: string, now: number): ReadonlySet<string> {
  const loaded = loadLeases(cawsDir);
  const ids = new Set<string>();
  if (!isOk(loaded)) return ids;
  for (const lease of Object.values(loaded.value.leases)) {
    if (lease.status === 'stopped') continue;
    const lastActive = Date.parse(lease.last_active);
    if (!Number.isNaN(lastActive) && now - lastActive <= LIVE_LEASE_TTL_MS) {
      ids.add(lease.session_id);
    }
  }
  return ids;
}

export function runSessionPruneCommand(opts: SessionPruneOptions): number {
  const cwd = opts.cwd ?? process.cwd();
  const nowFn = opts.now ?? (() => new Date());
  const out = opts.out ?? ((s: string) => process.stdout.write(s + '\n'));
  const err = opts.err ?? ((s: string) => process.stderr.write(s + '\n'));
  const showData = opts.showData === true;

  const rootRes = resolveRepoRoot(cwd);
  if (!rootRes.ok) {
    err('caws session prune: failed to resolve repo root.');
    err(renderDiagnostics(rootRes.errors, { showData }));
    return 2;
  }
  const cawsDir = rootRes.value.cawsDir;
  const now = nowFn().getTime();

  const retentionMs = opts.olderThanMs ?? DEFAULT_SESSION_LOG_RETENTION_MS;
  const currentSessionId = readCallerSessionId(cawsDir);
  const plan = planSessionLogRetention(cawsDir, {
    retentionMs,
    now,
    ...(currentSessionId !== undefined ? { currentSessionId } : {}),
    liveSessionIds: liveSessionIds(cawsDir, now),
  });

  const applied = opts.apply === true;
  const removed = applied ? applySessionLogRetention(plan.candidates) : 0;

  if (opts.json === true) {
    out(
      JSON.stringify(
        {
          ok: true,
          read_only: !applied,
          dry_run: !applied,
          apply: applied,
          retention_ms: retentionMs,
          candidate_count: plan.candidates.length,
          protected_ids: plan.protectedIds,
          skipped_ids: plan.skippedIds,
          total_turn_files: plan.totalTurnFiles,
          ...(applied ? { removed } : {}),
          candidates: plan.candidates.map((c) => ({
            session_id: c.sessionId,
            turn_files: c.turnFiles.map((f) => path.relative(path.join(cawsDir, 'sessions'), f)),
            last_activity_ms: c.lastActivityMs,
          })),
        },
        null,
        2
      )
    );
    return 0;
  }

  out(
    `caws session prune (${applied ? 'apply' : 'dry-run'}): ${plan.candidates.length} candidate(s), ${plan.totalTurnFiles} turn file(s)`
  );
  if (plan.candidates.length === 0) {
    out('  (no eligible session-log turn histories)');
  } else {
    for (const c of plan.candidates) {
      out(`  ${c.sessionId}  ${c.turnFiles.length} turn file(s)`);
    }
  }
  if (plan.protectedIds.length > 0) {
    out(`  protected: ${plan.protectedIds.join(', ')}`);
  }
  return 0;
}
