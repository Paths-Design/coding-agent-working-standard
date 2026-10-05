// Dashboard model builder for `caws tui` (CAWS-TUI-DASHBOARD-001).
//
// Consumes the SAME payload builder as `caws status --json`
// (buildStatusPanelPayload) — the single-source selector contract — plus the
// TUI-only gates panel, and shapes both into a render-ready model. No
// strings are produced here beyond short labels; frame rendering lives in
// frame.ts. Read-only: everything here derives from gathered state.

import { basename } from 'node:path';

import {
  buildGatesPanel,
  buildStatusPanelPayload,
  type GatheredDashboardState,
} from '../panel-data';

export interface DashboardModel {
  readonly project: string;
  readonly policyLoaded: boolean;
  readonly bindingLine: string;
  readonly sessionLine: string;
  readonly eventsLine: string;
  readonly doctorLine: string;
  readonly laneLine?: string;
  readonly specs: readonly {
    readonly id: string;
    readonly state: string;
    readonly worktree?: string;
  }[];
  readonly specsByLifecycle: Record<string, number>;
  readonly worktrees: readonly {
    readonly name: string;
    readonly specId?: string;
    readonly owner?: string;
  }[];
  readonly agents: {
    readonly total: number;
    readonly active: number;
    readonly stale: number;
    readonly stopped: number;
    readonly self: string | null;
  };
  readonly doctor: {
    readonly counts: { readonly errors: number; readonly warnings: number; readonly infos: number };
    readonly findings: readonly {
      readonly severity: string;
      readonly rule: string;
      readonly message: string;
    }[];
  };
  readonly gates: {
    readonly ok: boolean;
    readonly reason?: 'no_policy' | 'composition';
    readonly rows: readonly {
      readonly gate_id: string;
      readonly mode: string;
      readonly enabled: boolean;
      readonly waivers: number;
    }[];
  };
}

interface SpecsPayloadView {
  readonly count: number;
  readonly by_lifecycle: Record<string, number>;
  readonly items: readonly {
    readonly id: string;
    readonly lifecycle_state: string;
    readonly worktree?: string;
  }[];
}
interface WorktreesPayloadView {
  readonly count: number;
  readonly items: readonly {
    readonly name: string;
    readonly spec_id?: string;
    readonly owner?: string;
  }[];
}
interface AgentsPayloadView {
  readonly leases: {
    readonly total: number;
    readonly active: readonly unknown[];
    readonly stale: readonly unknown[];
    readonly stopped: readonly unknown[];
  };
  readonly self_session_id: string | null;
}
interface DoctorPayloadView {
  readonly counts: { readonly errors: number; readonly warnings: number; readonly infos: number };
  readonly findings: readonly {
    readonly severity: string;
    readonly rule: string;
    readonly message: string;
  }[];
}
interface LanePayloadView {
  readonly worktree: string | null;
  readonly branch: string;
  readonly base_branch: string;
  readonly ahead: number | string;
  readonly behind: number | string;
  readonly contains_base: boolean;
  readonly unknown_reason?: string;
}

/** Build the dashboard model. Panel DATA flows through buildStatusPanelPayload
 *  (the same assembly `status --json` uses); only presentation shaping
 *  happens here. */
export function buildDashboardModel(state: GatheredDashboardState): DashboardModel {
  const payload = buildStatusPanelPayload({
    jsonPanels: ['specs', 'worktrees', 'agents', 'doctor'],
    specs: state.snapshot.specs,
    worktrees: state.snapshot.worktrees,
    leaseSummary: state.leaseSummary,
    selfSessionId: state.selfSessionId,
    wantsHeartbeat: false,
    defaultMode: true,
    lane: state.lane,
    laneWorktree: state.binding.worktreeName ?? null,
    doctorFindings: state.findings,
    mailSummary: state.mailSummary,
  });

  const specsPanel = payload.specs as SpecsPayloadView | undefined;
  const worktreesPanel = payload.worktrees as WorktreesPayloadView | undefined;
  const agentsPanel = payload.agents as AgentsPayloadView | undefined;
  const doctorPanel = payload.doctor as DoctorPayloadView | undefined;
  const lanePayload = payload.lane as LanePayloadView | undefined;

  const kind = state.binding.binding.kind;
  const bindingLine =
    kind === 'bound'
      ? `bound: ${state.binding.binding.spec.id}${
          state.binding.worktreeName !== undefined ? ` · wt ${state.binding.worktreeName}` : ''
        }`
      : 'unbound (no write authority in this checkout)';

  let laneLine: string | undefined;
  if (lanePayload !== undefined) {
    laneLine =
      typeof lanePayload.ahead === 'number' && typeof lanePayload.behind === 'number'
        ? `lane ${lanePayload.worktree ?? '?'}: ${lanePayload.branch} ← ${lanePayload.base_branch} ` +
          `(ahead ${lanePayload.ahead}, behind ${lanePayload.behind})`
        : `lane ${lanePayload.worktree ?? '?'}: unknown divergence${
            lanePayload.unknown_reason !== undefined ? ` (${lanePayload.unknown_reason})` : ''
          }`;
  }

  const gates = buildGatesPanel({
    repoRoot: state.repoRoot,
    cawsDir: state.cawsDir,
    now: state.now,
  });

  return {
    project: basename(state.repoRoot),
    policyLoaded: state.snapshot.policy !== undefined,
    bindingLine,
    sessionLine: state.selfSessionId ?? 'no resolvable session identity',
    eventsLine: `${state.snapshot.events.length} events (chain ${
      state.snapshot.events.length === 0 ? 'empty' : state.chainBroken ? 'BROKEN' : 'ok'
    })`,
    doctorLine: doctorPanel
      ? `doctor: ${doctorPanel.counts.errors}E / ${doctorPanel.counts.warnings}W / ${doctorPanel.counts.infos}I`
      : 'doctor: unavailable',
    ...(laneLine !== undefined ? { laneLine } : {}),
    specs:
      specsPanel?.items.map((s) => ({
        id: s.id,
        state: s.lifecycle_state,
        ...(s.worktree !== undefined ? { worktree: s.worktree } : {}),
      })) ?? [],
    specsByLifecycle: specsPanel?.by_lifecycle ?? {},
    worktrees:
      worktreesPanel?.items.map((w) => ({
        name: w.name,
        ...(w.spec_id !== undefined ? { specId: w.spec_id } : {}),
        ...(w.owner !== undefined ? { owner: w.owner } : {}),
      })) ?? [],
    agents: {
      total: agentsPanel?.leases.total ?? 0,
      active: agentsPanel?.leases.active.length ?? 0,
      stale: agentsPanel?.leases.stale.length ?? 0,
      stopped: agentsPanel?.leases.stopped.length ?? 0,
      self: agentsPanel?.self_session_id ?? null,
    },
    doctor: {
      counts: doctorPanel?.counts ?? { errors: 0, warnings: 0, infos: 0 },
      findings: doctorPanel?.findings ?? [],
    },
    gates:
      gates.ok === true
        ? {
            ok: true,
            rows: gates.gates.map((g) => ({
              gate_id: g.gate_id,
              mode: g.mode,
              enabled: g.enabled,
              waivers: g.effective_waiver_count,
            })),
          }
        : { ok: false, rows: [], ...(gates.ok === false ? { reason: gates.reason } : {}) },
  };
}
