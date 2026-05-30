// Pure formatter for the vNext `caws status` dashboard.
//
// Read-only: the formatter inspects already-loaded state and renders a
// summary. It does NOT mint capsules, refresh heartbeats, write events,
// or mutate any registry.
//
// Composition order (sections):
//
//   CAWS Status
//
//   Project
//     repo root / .caws / policy presence / specs by lifecycle /
//     worktree count / event count
//
//   Current context
//     cwd relation: tracked / untracked / outside repo
//     worktree name (if resolved) / bound spec id / binding state
//     current session id (or "unresolved (read-only)")
//
//   Claim (only when inside a tracked worktree)
//     reuses renderClaimPanel — same authority discipline.
//
//   Doctor
//     error/warning/info counts; top findings, capped.

import type {
  ActivitySummary,
  AgentLease,
  AgentRegistry,
  BindingState,
  DoctorFinding,
  LeaseRegistry,
  Spec,
  SessionIdentity,
  WorktreeRegistry,
} from '@paths.design/caws-kernel';

import type { ResolvedBinding } from '../binding/types';
import type { ResolvedSession } from '../session/types';
import { renderClaimPanel } from './claim';
import {
  countFindingSeverities,
  renderFindings,
} from './finding';

export interface StatusRenderInput {
  readonly repoRoot: string;
  readonly cawsDir: string;
  readonly policyLoaded: boolean;
  readonly specs: readonly Spec[];
  readonly worktrees: WorktreeRegistry;
  readonly agents: AgentRegistry;
  readonly eventCount: number;
  /** When undefined, the dashboard renders "no event chain on disk". */
  readonly eventChainOk?: boolean;

  /** Result of resolveBinding(cwd, ...). */
  readonly binding: ResolvedBinding;
  /** Result of resolveSession({ allowMint: false }). */
  readonly session: ResolvedSession | null;

  readonly doctorFindings: readonly DoctorFinding[];
  readonly now: Date;
  /** Heartbeat-stale TTL in ms; display only. Default 24h. */
  readonly staleTtlMs?: number;
  /** Cap on rendered top findings. Default 5. */
  readonly findingCap?: number;

  // ─── MULTI-AGENT-ACTIVITY-REGISTRY-001 (commit 4) ──────────────────────
  /** Lease registry — operational cache for the Agents panel. */
  readonly leases?: LeaseRegistry;
  /** Pre-computed TTL-classified active/stale/stopped buckets. */
  readonly leaseSummary?: ActivitySummary;
  /** Caller's own session id so the panel can mark `← self`. */
  readonly selfSessionId?: string | null;
}

const DEFAULT_FINDING_CAP = 5;

function countSpecsByLifecycle(specs: readonly Spec[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const s of specs) {
    counts[s.lifecycle_state] = (counts[s.lifecycle_state] ?? 0) + 1;
  }
  return counts;
}

function fmtSessionTag(identity: SessionIdentity): string {
  if (identity.platform !== undefined && identity.platform.length > 0) {
    return `${identity.session_id}:${identity.platform}`;
  }
  return identity.session_id;
}

/**
 * Render one lease row for the Agents panel.
 *
 * Format:
 *   <session-id-tag>  <platform>  <git_dir_kind>  <branch|->  <bound-spec|->  <age>  [← self]
 *
 * Distinguishes:
 *   - self vs other (← self marker)
 *   - canonical vs linked-worktree origin (git_dir_kind from realpath-
 *     normalized git_common_dir vs git_dir comparison)
 *   - bound spec / worktree when present
 */
function renderLeaseRow(lease: AgentLease, selfSessionId: string | null, now: Date): string {
  const isSelf = selfSessionId !== null && lease.session_id === selfSessionId;
  const gitKind = lease.git_common_dir === lease.git_dir ? 'canonical' : 'worktree';
  const age = formatAge(now.getTime() - Date.parse(lease.last_active));
  const branch = lease.branch ?? '-';
  const spec = lease.bound_spec_id ?? '-';
  const wtTag =
    lease.bound_worktree !== undefined
      ? `wt=${lease.bound_worktree}`
      : '';
  const parts = [
    lease.session_id,
    lease.platform,
    gitKind,
    `branch=${branch}`,
    `spec=${spec}`,
    wtTag,
    `${age} ago`,
  ].filter((s) => s.length > 0);
  return parts.join('  ') + (isSelf ? '  ← self' : '');
}

function formatAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '?';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

function describeCwdRelation(binding: ResolvedBinding): string {
  if (binding.worktreeName !== undefined) return 'inside tracked worktree';
  if (binding.source === 'none') return 'main checkout (no tracked worktree match)';
  return 'unknown';
}

function describeBindingState(
  state: BindingState,
  activeSpecCount: number
): string {
  switch (state.kind) {
    case 'bound':
      return `bound → ${state.spec.id} (worktree '${state.worktreeName}')`;
    case 'one_sided':
      return 'one_sided (corrupt asymmetric binding — see doctor)';
    case 'unbound':
      // 'unbound' means no spec is bound to THIS checkout — it does NOT mean
      // edits are unrestricted. When any spec is active, the scope guard falls
      // back to union mode and enforces every active spec's scope.in/out, so a
      // main-checkout edit is still governed. Surface that so a first-timer does
      // not misread 'unbound' as 'free' (friction-probe Event 8). With zero
      // active specs there is nothing to enforce, so the bare word is accurate.
      return activeSpecCount > 0
        ? `unbound (scope still enforced — union mode over ${activeSpecCount} active spec${
            activeSpecCount === 1 ? '' : 's'
          })`
        : 'unbound';
  }
}

export function renderStatus(input: StatusRenderInput): string {
  const lines: string[] = [];
  lines.push('CAWS Status');
  lines.push('');

  // -------- Project --------
  lines.push('Project');
  lines.push(`  repo root:   ${input.repoRoot}`);
  lines.push(`  .caws dir:   ${input.cawsDir}`);
  lines.push(`  policy:      ${input.policyLoaded ? 'loaded' : 'MISSING'}`);

  const lifecycle = countSpecsByLifecycle(input.specs);
  const lifecycleSummary =
    input.specs.length === 0
      ? '0 specs'
      : Object.entries(lifecycle)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => `${v} ${k}`)
          .join(', ');
  lines.push(`  specs:       ${lifecycleSummary}`);

  const worktreeCount = Object.keys(input.worktrees).length;
  lines.push(`  worktrees:   ${worktreeCount}`);

  const eventLine =
    input.eventChainOk === undefined
      ? `${input.eventCount} events`
      : input.eventChainOk
      ? `${input.eventCount} events (chain OK)`
      : `${input.eventCount} events (CHAIN BROKEN — see doctor)`;
  lines.push(`  events:      ${eventLine}`);

  // -------- Current context --------
  lines.push('');
  lines.push('Current context');
  lines.push(`  cwd:         ${describeCwdRelation(input.binding)}`);
  if (input.binding.worktreeName !== undefined) {
    lines.push(`  worktree:    ${input.binding.worktreeName}`);
  }
  const activeSpecCount = lifecycle['active'] ?? 0;
  lines.push(
    `  binding:     ${describeBindingState(input.binding.binding, activeSpecCount)}`
  );

  if (input.session !== null) {
    lines.push(
      `  session:     ${fmtSessionTag(input.session.identity)} (source: ${input.session.source})`
    );
  } else {
    lines.push('  session:     unresolved (read-only; no capsule minted)');
  }

  // -------- Claim (only when inside a tracked worktree) --------
  if (input.binding.worktreeName !== undefined && input.session !== null) {
    const wtName = input.binding.worktreeName;
    const record = input.worktrees[wtName];
    if (record !== undefined) {
      lines.push('');
      const agentRecord =
        record.owner !== undefined ? input.agents[record.owner.session_id] : undefined;
      lines.push(
        renderClaimPanel({
          worktreeName: wtName,
          worktreeRecord: record,
          ...(agentRecord !== undefined ? { agentRecord } : {}),
          currentSession: input.session.identity,
          now: input.now,
          ...(input.staleTtlMs !== undefined ? { staleTtlMs: input.staleTtlMs } : {}),
        })
      );
    }
  }

  // -------- Agents (MULTI-AGENT-ACTIVITY-REGISTRY-001) --------
  // Renders BEFORE Doctor when leases exist. Distinguishes self/other,
  // canonical/worktree, active/stale/stopped, bound spec/worktree.
  // Transition rule: if leases exist, use leases; otherwise omit panel
  // (agents.json legacy fallback is rendered inside the Claim panel
  // already, when the worktree owner has an agents.json record).
  if (input.leaseSummary !== undefined && input.leaseSummary.total > 0) {
    lines.push('');
    lines.push('Agents');
    const s = input.leaseSummary;
    const parallelTag = s.active.length > 1 ? '  (parallel)' : '';
    lines.push(`  active:   ${s.active.length}${parallelTag}`);
    lines.push(`  stale:    ${s.stale.length}`);
    lines.push(`  stopped:  ${s.stopped.length}`);
    if (s.active.length > 0 || s.stale.length > 0 || s.stopped.length > 0) {
      lines.push('');
    }
    for (const lease of s.active) {
      lines.push(`  ${renderLeaseRow(lease, input.selfSessionId ?? null, input.now)}`);
    }
    for (const lease of s.stale) {
      lines.push(`  ${renderLeaseRow(lease, input.selfSessionId ?? null, input.now)}  STALE`);
    }
    for (const lease of s.stopped) {
      lines.push(`  ${renderLeaseRow(lease, input.selfSessionId ?? null, input.now)}  stopped`);
    }
  }

  // -------- Doctor --------
  lines.push('');
  lines.push('Doctor');
  const counts = countFindingSeverities(input.doctorFindings);
  lines.push(
    `  Summary:   ${counts.errors}E / ${counts.warnings}W / ${counts.infos}I`
  );
  if (input.doctorFindings.length === 0) {
    lines.push('  (no findings)');
  } else {
    const cap = input.findingCap ?? DEFAULT_FINDING_CAP;
    // Sort by severity rank (error > warning > info) and take top `cap`.
    const rank: Record<DoctorFinding['severity'], number> = {
      error: 0,
      warning: 1,
      info: 2,
    };
    const top = [...input.doctorFindings]
      .sort((a, b) => rank[a.severity] - rank[b.severity])
      .slice(0, cap);
    lines.push(renderFindings(top));
    if (input.doctorFindings.length > cap) {
      lines.push(
        `  … ${input.doctorFindings.length - cap} more — run \`caws doctor\` for full list`
      );
    }
  }

  return lines.join('\n');
}
