import { type AgentLease, type LeaseRegistry } from '../../kernel';

/**
 * Identity-backed conjoining telemetry (CAWS-AGENTS-CONJOINING-PRECISION-001).
 *
 * `forked_from` is the relation evidence. Activity-window overlap is retained
 * only as a bounded diagnostic for recent same-platform leases whose harness
 * identity is incomplete. It never confirms a relationship.
 */
/** Seven days. Kept literal so the public telemetry contract is mechanically pinned. */
export const CONJOINING_RETENTION_MS = 604_800_000;
export const CONJOINED_TEXT_DETAIL_LIMIT = 10;

export interface ConfirmedConjoinedPair {
  readonly a: string;
  readonly b: string;
  readonly parent: string;
  readonly child: string;
  readonly source: 'explicit_fork_identity';
}

export interface UnresolvedConjoinedPair {
  readonly a: string;
  readonly b: string;
  readonly reason: 'missing_fork_identity';
}

export interface ConjoiningIdentitySummary {
  readonly retention_ms: number;
  readonly recent_leases: number;
  readonly excluded_leases: number;
  readonly classified_leases: number;
  readonly unclassified_leases: number;
  readonly rejected_overlap_pairs: number;
}

export interface ConjoiningTelemetry {
  readonly confirmed: ReadonlyArray<ConfirmedConjoinedPair>;
  readonly unresolved: ReadonlyArray<UnresolvedConjoinedPair>;
  readonly identity: ConjoiningIdentitySummary;
}

function hasCompleteForkIdentity(lease: AgentLease): boolean {
  if (lease.harness_session_kind === 'fork') {
    return typeof lease.forked_from === 'string' && lease.forked_from.length > 0;
  }
  return lease.harness_session_kind === 'main' || lease.harness_session_kind === 'subagent';
}

function hasOverlappingActivity(x: AgentLease, y: AgentLease): boolean {
  const xs = Date.parse(x.started_at);
  const ys = Date.parse(y.started_at);
  if (!Number.isFinite(xs) || !Number.isFinite(ys)) return false;
  // Both last_active values were already validated by the recent-leases filter.
  return xs <= Date.parse(y.last_active) && ys <= Date.parse(x.last_active);
}

export function deriveConjoiningTelemetry(leases: LeaseRegistry, now: Date): ConjoiningTelemetry {
  const recentEntries = Object.entries(leases)
    .filter(([, lease]) => {
      const lastActive = Date.parse(lease.last_active);
      return Number.isFinite(lastActive) && now.getTime() - lastActive <= CONJOINING_RETENTION_MS;
    })
    .sort(([a], [b]) => a.localeCompare(b));
  const recent = new Map<string, AgentLease>(recentEntries);
  const confirmed: ConfirmedConjoinedPair[] = [];
  const confirmedKeys = new Set<string>();

  for (const [childId, child] of recentEntries) {
    if (child.harness_session_kind !== 'fork' || !hasCompleteForkIdentity(child)) continue;
    const parentId = child.forked_from as string;
    if (!recent.has(parentId) || parentId === childId) continue;
    const key = [parentId, childId].sort().join('\0');
    if (confirmedKeys.has(key)) continue;
    confirmedKeys.add(key);
    confirmed.push({
      a: parentId,
      b: childId,
      parent: parentId,
      child: childId,
      source: 'explicit_fork_identity',
    });
  }

  const unresolved: UnresolvedConjoinedPair[] = [];
  let rejectedOverlapPairs = 0;
  for (let i = 0; i < recentEntries.length; i++) {
    const [aId, x] = recentEntries[i] as [string, AgentLease];
    for (let j = i + 1; j < recentEntries.length; j++) {
      const [bId, y] = recentEntries[j] as [string, AgentLease];
      if (typeof x.hostname !== 'string' || x.hostname.length === 0 || x.hostname !== y.hostname)
        continue;
      if (x.repo_root !== y.repo_root || !hasOverlappingActivity(x, y)) continue;
      const key = [aId, bId].sort().join('\0');
      if (confirmedKeys.has(key)) continue;

      const sameKnownPlatform = x.platform === y.platform;
      const missingIdentity = !hasCompleteForkIdentity(x) || !hasCompleteForkIdentity(y);
      if (sameKnownPlatform && missingIdentity) {
        unresolved.push({ a: aId, b: bId, reason: 'missing_fork_identity' });
      } else {
        rejectedOverlapPairs++;
      }
    }
  }

  const classifiedLeases = recentEntries.filter(([, lease]) =>
    hasCompleteForkIdentity(lease)
  ).length;
  return {
    confirmed,
    unresolved,
    identity: {
      retention_ms: CONJOINING_RETENTION_MS,
      recent_leases: recentEntries.length,
      excluded_leases: Object.keys(leases).length - recentEntries.length,
      classified_leases: classifiedLeases,
      unclassified_leases: recentEntries.length - classifiedLeases,
      rejected_overlap_pairs: rejectedOverlapPairs,
    },
  };
}
