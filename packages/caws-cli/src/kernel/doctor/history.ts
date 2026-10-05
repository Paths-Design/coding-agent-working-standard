import type { ChainedEvent } from '../evidence/types';
import type { Spec } from '../spec/types';
import type { Waiver } from '../waiver/types';

export function unmetObligations(spec: Spec): Record<string, unknown> {
  const evidence = new Map((spec.evidence ?? []).map((e) => [e.criterion_id, e]));
  return {
    unmet_acceptance: (spec.acceptance ?? [])
      .filter(
        (a) => evidence.get(a.id)?.status !== 'pass' && evidence.get(a.id)?.status !== 'waived'
      )
      .map((a) => ({
        criterion_id: a.id,
        then: a.then,
        status: evidence.get(a.id)?.status ?? 'unrecorded',
        evidence_ref: evidence.get(a.id)?.evidence_ref ?? null,
      })),
  };
}

export function historicalWaiverUses(events: readonly ChainedEvent[], waivers: readonly Waiver[]) {
  const byId = new Map(waivers.map((w) => [w.id, w]));
  const uses: {
    waiver_id: string;
    event_seq: number;
    event_hash: string;
    event_ts: string;
    classification: string;
    gate_id: unknown;
    spec_id: string | null;
  }[] = [];
  for (const event of events) {
    if (event.event !== 'gate_evaluated') continue;
    const data = event.data as { waiver_ids?: unknown; gate_id?: unknown };
    if (!Array.isArray(data?.waiver_ids)) continue;
    for (const id of new Set(data.waiver_ids.filter((v): v is string => typeof v === 'string'))) {
      const w = byId.get(id);
      let classification = 'unknown';
      if (w) {
        const t = Date.parse(event.ts),
          created = Date.parse(w.created_at),
          expiry = Date.parse(w.expires_at);
        const revoked = Date.parse(w.revocation?.revoked_at ?? '');
        if (
          [t, created, expiry].every(Number.isFinite) &&
          created < expiry &&
          (w.status !== 'revoked' || Number.isFinite(revoked))
        ) {
          classification =
            t < created
              ? 'before_creation'
              : t >= expiry
                ? 'expired'
                : w.status === 'revoked' && t >= revoked
                  ? 'post_revocation'
                  : typeof data.gate_id !== 'string'
                    ? 'unknown'
                    : !w.gates.includes(data.gate_id)
                      ? 'gate_not_covered'
                      : w.scope?.spec_id && w.scope.spec_id !== event.spec_id
                        ? 'spec_not_covered'
                        : 'within_recorded_bounds';
        }
      }
      uses.push({
        waiver_id: id,
        event_seq: event.seq,
        event_hash: event.event_hash,
        event_ts: event.ts,
        classification,
        gate_id: data.gate_id ?? null,
        spec_id: event.spec_id ?? null,
      });
    }
  }
  return uses;
}

/** Replay dispositions against the current incarnation, never all uses of a name. */
export function worktreeHistory(events: readonly ChainedEvent[]) {
  const pending = new Map<string, ChainedEvent>();
  const releasedPaths = new Set<string>();
  for (const event of events) {
    const d = event.data as Record<string, unknown>;
    if (event.event === 'worktree_created' && typeof d.name === 'string') {
      pending.set(d.name, event);
      if (typeof d.path === 'string') releasedPaths.delete(d.path);
    } else if (event.event === 'worktree_untracked' && typeof d.worktree_name === 'string') {
      pending.delete(d.worktree_name);
      if (typeof d.path === 'string') releasedPaths.add(d.path);
    } else if (event.event === 'worktree_destroyed' && typeof d.worktree_name === 'string') {
      pending.delete(d.worktree_name);
      if (typeof d.path === 'string') releasedPaths.delete(d.path);
    } else if (event.event === 'worktree_pruned' && typeof d.worktree_name === 'string') {
      const creation = pending.get(d.worktree_name);
      if (
        d.h_class === 'ghost_registry' ||
        (creation &&
          d.h_class === 'verified_dead_creation' &&
          d.created_event_seq === creation.seq &&
          d.created_event_hash === creation.event_hash)
      ) {
        pending.delete(d.worktree_name);
      }
    }
  }
  return { pending, releasedPaths };
}
