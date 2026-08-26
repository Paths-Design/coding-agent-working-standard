// `caws working-tree check | ack` — overlapping-ownership advisory surface
// (WORKING-TREE-PROVENANCE-GUARD-001).
//
// check (read-only): the same predicate the PreToolUse guard consumes, as a
// non-mutating query. Exit 0 if no OTHER session overlaps the dirty tree, exit
// 1 if overlap exists (scriptable precondition). Never mutates the tree.
//
// ack: the operator's explicit per-session, per-path acknowledgement that
// cleans up work claimed by another session. Writes a durable
// prior_overlap_acks audit entry on the TARGET session's lease
// (operational cache — NEVER authority). Subsequent cleanup is the operator's
// action; this command only records the acknowledgement so the original
// session can later see another session touched its claimed paths.
//
// Both surfaces consult the same kernel/store predicate and never change
// scope, claim, ownership, or lifecycle state.

import * as fs from 'node:fs';
import * as path from 'node:path';

import { isOk, type EventBody } from '../../kernel';
import { appendEvent, loadLeases, resolveRepoRoot, writeFileAtomic } from '../../store';
import { checkWorkingTreeOverlap } from '../../store/working-tree-overlap';
import { renderDiagnostics } from '../render/diagnostic';
import { buildActor } from '../session/actor';
import { resolveSession } from '../session/resolve-session';

const CALLER_SESSION_POINTER_FILENAME = '.caller-session.json';

function readSelfSessionId(cawsDir: string): string | undefined {
  try {
    const raw = fs.readFileSync(path.join(cawsDir, 'sessions', CALLER_SESSION_POINTER_FILENAME), 'utf8');
    const obj = JSON.parse(raw) as { session_id?: unknown };
    return typeof obj.session_id === 'string' && obj.session_id.length > 0 ? obj.session_id : undefined;
  } catch {
    return undefined;
  }
}

export interface WorkingTreeCheckOptions {
  readonly json?: boolean;
  readonly cwd?: string;
  readonly out?: (line: string) => void;
  readonly err?: (line: string) => void;
  readonly showData?: boolean;
}

export function runWorkingTreeCheckCommand(opts: WorkingTreeCheckOptions): number {
  const cwd = opts.cwd ?? process.cwd();
  const out = opts.out ?? ((s: string) => process.stdout.write(s + '\n'));
  const err = opts.err ?? ((s: string) => process.stderr.write(s + '\n'));
  const showData = opts.showData === true;

  const rootRes = resolveRepoRoot(cwd);
  if (!rootRes.ok) {
    err('caws working-tree check: failed to resolve repo root.');
    err(renderDiagnostics(rootRes.errors, { showData }));
    return 2;
  }
  const { repoRoot, cawsDir } = rootRes.value;
  const selfSessionId = readSelfSessionId(cawsDir);
  const result = checkWorkingTreeOverlap(cawsDir, repoRoot, selfSessionId);
  const hasOverlap = result.overlaps.length > 0;

  if (opts.json === true) {
    out(
      JSON.stringify(
        {
          ok: true,
          read_only: true,
          overlap: hasOverlap,
          exit_code: hasOverlap ? 1 : 0,
          overlaps: result.overlaps.map((o) => ({
            session_id: o.sessionId,
            overlapping_paths: o.overlappingPaths,
            source: o.source,
          })),
          no_overlap_paths: result.noOverlapPaths,
          metadata_unavailable: result.metadataUnavailable,
        },
        null,
        2
      )
    );
    return hasOverlap ? 1 : 0;
  }

  if (!hasOverlap) {
    out('caws working-tree check: no overlap with another active session.');
    return 0;
  }
  out(`caws working-tree check: ${result.overlaps.length} OTHER session(s) overlap the dirty tree.`);
  for (const o of result.overlaps) {
    out(`  session ${o.sessionId} (${o.source}):`);
    for (const p of o.overlappingPaths) out(`    ${p}`);
    out(
      `  acknowledge with: caws working-tree ack --session ${o.sessionId} --paths ${o.overlappingPaths.join(' ')}`
    );
    out('');
  }
  return 1;
}

export interface WorkingTreeAckOptions {
  readonly sessionId: string;
  readonly paths: readonly string[];
  readonly target?: string;
  readonly cwd?: string;
  readonly now?: () => Date;
  readonly env?: NodeJS.ProcessEnv;
  readonly out?: (line: string) => void;
  readonly err?: (line: string) => void;
  readonly showData?: boolean;
}

export function runWorkingTreeAckCommand(opts: WorkingTreeAckOptions): number {
  const cwd = opts.cwd ?? process.cwd();
  const nowFn = opts.now ?? (() => new Date());
  const out = opts.out ?? ((s: string) => process.stdout.write(s + '\n'));
  const err = opts.err ?? ((s: string) => process.stderr.write(s + '\n'));
  const showData = opts.showData === true;

  if (typeof opts.sessionId !== 'string' || opts.sessionId.length === 0) {
    err('caws working-tree ack: --session <id> is required.');
    return 1;
  }
  if (opts.paths.length === 0) {
    err('caws working-tree ack: at least one --paths <path> is required.');
    return 1;
  }

  const rootRes = resolveRepoRoot(cwd);
  if (!rootRes.ok) {
    err('caws working-tree ack: failed to resolve repo root.');
    err(renderDiagnostics(rootRes.errors, { showData }));
    return 2;
  }
  const cawsDir = rootRes.value.cawsDir;

  const leases = loadLeases(cawsDir);
  if (!isOk(leases)) {
    err('caws working-tree ack: failed to load leases.');
    err(renderDiagnostics(leases.errors, { showData }));
    return 2;
  }
  const target = leases.value.leases[opts.sessionId];
  if (target === undefined) {
    err(`caws working-tree ack: no lease for session "${opts.sessionId}".`);
    return 1;
  }

  const ack = {
    acked_by_session: readSelfSessionId(cawsDir) ?? 'unknown',
    acked_at: nowFn().toISOString(),
    paths: [...opts.paths],
    ...(opts.target !== undefined ? { target_command: opts.target } : {}),
  };
  const prior = Array.isArray(target.prior_overlap_acks) ? (target.prior_overlap_acks as unknown[]) : [];
  const updated = { ...target, prior_overlap_acks: [...prior, ack] };
  const leasePath = path.join(cawsDir, 'leases', `${opts.sessionId}.json`);
  const w = writeFileAtomic(leasePath, JSON.stringify(updated, null, 2) + '\n');
  if (!w.ok) {
    err('caws working-tree ack: failed to write the ack record.');
    err(renderDiagnostics(w.errors, { showData }));
    return 1;
  }

  // MULTI-AGENT-HANDOFF-EVENT-001 A3: the ack is the explicit handoff trigger.
  // Append an overlap_ack_proceed event so the handoff is first-class in the
  // audit chain (provenance, never authority). Failure to append is surfaced
  // loudly but does NOT undo the ack — the lease record (operational cache)
  // already carries it, and the two surfaces reconcile via the audit trail.
  const env = opts.env ?? process.env;
  const sessionResult = resolveSession({ cawsDir, worktreeRoot: cwd, env, now: nowFn, allowMint: true });
  if (sessionResult.ok) {
    const receivingSessionId = sessionResult.value.identity.session_id;
    const actor = buildActor({ session: sessionResult.value, kind: 'agent' });
    const body = {
      event: 'overlap_ack_proceed',
      ts: nowFn().toISOString(),
      actor,
      data: {
        source_session: opts.sessionId,
        receiving_session: receivingSessionId,
        paths: [...opts.paths],
        target_command: opts.target ?? 'unrecorded-cleanup',
      },
    } as unknown as EventBody;
    const appended = appendEvent(cawsDir, body);
    if (!appended.ok) {
      err('caws working-tree ack: the ack was recorded but the overlap_ack_proceed event could not be appended.');
      err(renderDiagnostics(appended.errors, { showData }));
    }
  }

  out(`acked overlap for session ${opts.sessionId}: ${opts.paths.join(', ')}`);
  out(`  prior_overlap_acks now has ${prior.length + 1} entry/entries on session ${opts.sessionId}.`);
  return 0;
}
