import {
  heartbeatAgentSession,
  summarizeActiveAgents,
  type Diagnostic,
  type LeaseContext,
  type LeaseReason,
  type LeaseRegistry,
  type SessionIdentity,
} from '../kernel';
import { applyLeasePatch, loadLeases, safeLeaseFilename } from '../store/leases-store';

export interface ActiveAgentSummaryEntry {
  readonly session_id: string;
  readonly bound_worktree: string | null;
  readonly bound_spec_id: string | null;
  readonly branch: string | null;
  readonly git_dir_kind: 'canonical' | 'worktree';
  readonly last_active_age_ms: number;
  readonly is_self: boolean;
}
export interface ActiveSummary {
  readonly active_agent_count: number;
  readonly active_agents: ReadonlyArray<ActiveAgentSummaryEntry>;
}

/** CAWS-native activity data. Harness envelopes belong to the consumer. */
export function computeActiveSummary(
  registry: LeaseRegistry,
  selfSessionId: string,
  now: Date,
  ttlMs: number = 30 * 60 * 1000
): ActiveSummary {
  // Preserve the CLI's defensive partial-install behavior.
  const summary =
    typeof summarizeActiveAgents === 'function'
      ? summarizeActiveAgents(registry, now, ttlMs)
      : null;
  const active = summary?.active ?? [];
  const entries: ActiveAgentSummaryEntry[] = active.map((lease) => ({
    session_id: lease.session_id,
    bound_worktree: lease.bound_worktree ?? null,
    bound_spec_id: lease.bound_spec_id ?? null,
    branch: lease.branch ?? null,
    git_dir_kind: lease.git_common_dir === lease.git_dir ? 'canonical' : 'worktree',
    last_active_age_ms: Math.max(0, now.getTime() - Date.parse(lease.last_active)),
    is_self: lease.session_id === selfSessionId,
  }));
  return { active_agent_count: entries.length, active_agents: entries };
}

export interface HeartbeatApplicationInput {
  readonly cawsDir: string;
  /** Already resolved by the adapter; this operation never mints identity. */
  readonly identity: SessionIdentity;
  /** Adapter-owned provenance. hook_pid is never inferred from this process. */
  readonly context: LeaseContext;
  readonly now: () => Date;
  readonly reason?: LeaseReason;
  readonly throttleMs?: number;
  readonly includeActiveSummary?: boolean;
  readonly sessionKind?: string;
  readonly forkedFrom?: string;
}
export interface HeartbeatApplicationPayload {
  readonly ok: true;
  readonly session_id: string;
  readonly lease_path: string | null;
  readonly wrote: boolean;
  readonly throttled: boolean;
  readonly active_agent_count?: number;
  readonly active_agents?: ReadonlyArray<ActiveAgentSummaryEntry>;
}
export type HeartbeatApplicationResult =
  | { readonly ok: true; readonly value: HeartbeatApplicationPayload }
  | {
      readonly ok: false;
      readonly stage: 'identity' | 'load' | 'transition' | 'apply';
      readonly errors: ReadonlyArray<Diagnostic>;
    }
  | {
      readonly ok: false;
      readonly stage: 'fork-context';
      readonly reason: 'invalid-session-kind' | 'forked-from-without-fork';
    };

export interface HeartbeatApplicationPorts {
  readonly loadLeases: typeof loadLeases;
  readonly applyLeasePatch: typeof applyLeasePatch;
}
const productionPorts: HeartbeatApplicationPorts = { loadLeases, applyLeasePatch };

/** One canonical lease-heartbeat transaction, shared by CLI and hook adapters.
 * Repository/session resolution, caller metadata and presentation stay outside.
 */
export function heartbeatAgentActivity(
  input: HeartbeatApplicationInput,
  ports: HeartbeatApplicationPorts = productionPorts
): HeartbeatApplicationResult {
  const filename = safeLeaseFilename(input.identity.session_id);
  if (!filename.ok) return { ok: false, stage: 'identity', errors: filename.errors };
  const kind = input.sessionKind;
  if (kind !== undefined && kind !== 'main' && kind !== 'fork' && kind !== 'subagent')
    return { ok: false, stage: 'fork-context', reason: 'invalid-session-kind' };
  if (input.forkedFrom !== undefined && kind !== 'fork')
    return { ok: false, stage: 'fork-context', reason: 'forked-from-without-fork' };
  const context: LeaseContext = {
    ...input.context,
    ...(kind !== undefined ? { harness_session_kind: kind } : {}),
    ...(input.forkedFrom !== undefined ? { forked_from: input.forkedFrom } : {}),
  };
  const now = input.now();
  const load = ports.loadLeases(input.cawsDir);
  if (!load.ok) return { ok: false, stage: 'load', errors: load.errors };
  let leases = load.value.leases;
  const existing = leases[input.identity.session_id];
  const throttleMs = input.throttleMs ?? 0;
  let throttled = false;
  let wrote = false;
  if (existing !== undefined && throttleMs > 0) {
    const lastActiveMs = Date.parse(existing.last_active);
    if (Number.isFinite(lastActiveMs) && now.getTime() - lastActiveMs < throttleMs)
      throttled = true;
  }
  if (!throttled) {
    const transition = heartbeatAgentSession(
      leases,
      input.identity,
      context,
      now,
      input.reason ?? 'pre_tool_use'
    );
    if (!transition.ok) return { ok: false, stage: 'transition', errors: transition.errors };
    const applied = ports.applyLeasePatch(input.cawsDir, transition.value);
    if (!applied.ok) return { ok: false, stage: 'apply', errors: applied.errors };
    wrote = applied.value.wrote;
    // A failed summary reload does not undo the completed write or fail the CLI.
    const reload = ports.loadLeases(input.cawsDir);
    if (reload.ok) leases = reload.value.leases;
  }
  return {
    ok: true,
    value: {
      ok: true,
      session_id: input.identity.session_id,
      lease_path: `.caws/leases/${filename.value}`,
      wrote,
      throttled,
      ...(input.includeActiveSummary === true
        ? computeActiveSummary(leases, input.identity.session_id, now)
        : {}),
    },
  };
}
