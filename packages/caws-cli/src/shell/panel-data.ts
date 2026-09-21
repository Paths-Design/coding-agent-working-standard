// Shared panel-data selectors for CAWS read-only dashboards.
//
// CAWS-TUI-DASHBOARD-001. Single source of panel assembly for every
// read-only dashboard surface: `caws status --json` and `caws tui` both
// build their panel payloads through this module (spec invariant:
// "panel data assembly has a single source"). `buildStatusPanelPayload`
// was moved verbatim from runStatusCommand's JSON branch; the invariant
// "status --json output shape and rendered status output are unchanged
// by the selector extraction" is pinned by tests/shell/tui-dashboard.test.js.
//
// Read-only contract: nothing in this module writes governance state. It
// composes the same store/kernel read primitives runStatusCommand uses,
// so the status-is-observability posture (command-surface doctrine §6.7)
// extends to the TUI surface by construction: a dashboard can only show
// what these selectors can read.

import {
  effectiveWaiversForGate,
  inspectProjectState,
  summarizeActiveAgents,
  type ActivitySummary,
  type LeaseRegistry,
} from '../kernel';
import {
  composeDoctorSnapshot,
  composeStoreSnapshot,
  computeLaneDivergence,
  inboxAllMessages,
  loadBridges,
  loadLeases,
  type LaneDivergence,
  resolveRepoRoot,
} from '../store';
import { resolveBinding } from './binding/resolve-binding';
import { renderStaleTelemetryAdvisory } from './render/stale-telemetry-advisory';
import type { StatusPanel } from './render/status';
import { resolveCallerSession } from './session/resolve-session';

type DoctorSnapshot = ReturnType<typeof composeDoctorSnapshot>['snapshot'];
type DoctorFindings = ReturnType<typeof inspectProjectState>['findings'];
type Binding = ReturnType<typeof resolveBinding>;

/** Defensive echo of runStatusCommand's feature-detect: a partial or stale
 *  install whose kernel lacks summarizeActiveAgents must degrade to a typed
 *  empty summary, never crash the dashboard. */
export const KERNEL_FEATURE_UNAVAILABLE_DIAGNOSTIC =
  'caws: kernel does not export summarizeActiveAgents; agent activity unavailable. ' +
  'This typically means caws-cli is paired with a pre-1.1.0 kernel. Reinstall: ' +
  'npm install -g @paths.design/caws-cli@latest';

const EMPTY_ACTIVITY_SUMMARY: ActivitySummary = {
  total: 0,
  active: [],
  stale: [],
  stopped: [],
};

/** Moved verbatim from status.ts (was private countByLifecycle). */
export function countByLifecycle(
  specs: readonly { readonly lifecycle_state: string }[]
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const spec of specs) counts[spec.lifecycle_state] = (counts[spec.lifecycle_state] ?? 0) + 1;
  return counts;
}

/** Moved verbatim from status.ts (was private countDoctorFindings). */
export function countDoctorFindings(findings: readonly { readonly severity: string }[]): {
  readonly errors: number;
  readonly warnings: number;
  readonly infos: number;
} {
  let errors = 0;
  let warnings = 0;
  let infos = 0;
  for (const finding of findings) {
    if (finding.severity === 'error') errors++;
    else if (finding.severity === 'warning') warnings++;
    else infos++;
  }
  return { errors, warnings, infos };
}

/** Inputs to the status JSON payload assembly. These are exactly the values
 *  the JSON branch of runStatusCommand read from its locals — nothing more. */
export interface StatusPanelPayloadInput {
  /** Selected panels; the JSON branch defaults to all four when unset. */
  readonly jsonPanels: readonly StatusPanel[];
  readonly specs: DoctorSnapshot['specs'];
  readonly worktrees: DoctorSnapshot['worktrees'];
  /** Post-heartbeat lease summary (status re-summarizes after --heartbeat). */
  readonly leaseSummary: ActivitySummary;
  readonly selfSessionId: string | null;
  /** True when no panel filter flags were passed (panels === undefined):
   *  gates the lane block exactly as the original branch did. */
  readonly defaultMode: boolean;
  readonly lane: LaneDivergence | undefined;
  /** The bound worktree name for the lane block (`binding.worktreeName` —
   *  the original payload carried it, not a literal null). */
  readonly laneWorktree: string | null;
  readonly doctorFindings: DoctorFindings;
  readonly mailSummary: { readonly count: number; readonly oldestAgeMs: number | null };
  readonly wantsHeartbeat: boolean;
}

/** Single source of the `caws status --json` payload — and therefore of the
 *  data behind the TUI's specs/worktrees/agents/doctor panels. Body moved
 *  verbatim from runStatusCommand's JSON branch (status.ts 413–489 at
 *  extraction time); only the `out(JSON.stringify(...))` tail stayed in the
 *  command. */
export function buildStatusPanelPayload(input: StatusPanelPayloadInput): Record<string, unknown> {
  const jsonPanels = input.jsonPanels;
  const payload: Record<string, unknown> = {
    ok: true,
    read_only: !input.wantsHeartbeat,
    panels: jsonPanels,
  };
  if (jsonPanels.includes('specs')) {
    payload.specs = {
      count: input.specs.length,
      by_lifecycle: countByLifecycle(input.specs),
      items: input.specs.map((spec) => ({
        id: spec.id,
        title: spec.title,
        lifecycle_state: spec.lifecycle_state,
        ...(spec.worktree !== undefined ? { worktree: spec.worktree } : {}),
      })),
    };
  }
  if (jsonPanels.includes('worktrees')) {
    payload.worktrees = {
      count: Object.keys(input.worktrees).length,
      items: Object.entries(input.worktrees).map(([name, record]) => ({
        name,
        spec_id: record.specId,
        path: record.path,
        ...(record.owner !== undefined ? { owner: record.owner } : {}),
      })),
    };
  }
  if (jsonPanels.includes('agents')) {
    payload.agents = {
      leases: {
        total: input.leaseSummary.total,
        active: input.leaseSummary.active,
        stale: input.leaseSummary.stale,
        stopped: input.leaseSummary.stopped,
      },
      self_session_id: input.selfSessionId,
    };
  }
  // Mirrors the text path: Current context (and therefore the lane) renders
  // only in default mode, never under a focused-panel selection.
  if (input.defaultMode && input.lane !== undefined) {
    payload.lane = {
      worktree: input.laneWorktree,
      branch: input.lane.branch,
      base_branch: input.lane.baseBranch,
      ahead: input.lane.ahead,
      behind: input.lane.behind,
      contains_base: input.lane.containsBase,
      unknown_reason: input.lane.unknownReason,
    };
  }
  if (jsonPanels.includes('doctor')) {
    payload.doctor = {
      counts: countDoctorFindings(input.doctorFindings),
      findings: input.doctorFindings,
    };
  }
  // CAWS-TELEMETRY-REPAIR-RESILIENCE-001: JSON consumers get the same
  // advisory the human path renders, as plain text under a stable field —
  // additive-only: the field appears exactly when a stale-telemetry
  // advisory exists, so the payload is byte-identical otherwise.
  const advisoryBlock = renderStaleTelemetryAdvisory(input.doctorFindings);
  if (advisoryBlock.length > 0) {
    payload.stale_telemetry_advisory = advisoryBlock;
  }
  if (input.mailSummary.count > 0) {
    payload.messages = {
      undelivered: input.mailSummary.count,
      ...(input.mailSummary.oldestAgeMs !== null
        ? { oldest_age_ms: input.mailSummary.oldestAgeMs }
        : {}),
    };
  }
  return payload;
}

// ─── TUI dashboard gathering ─────────────────────────────────────────────

export type GatheredDashboardState = {
  readonly ok: true;
  readonly repoRoot: string;
  readonly cawsDir: string;
  readonly now: Date;
  readonly snapshot: DoctorSnapshot;
  readonly findings: DoctorFindings;
  readonly binding: Binding;
  readonly selfSessionId: string | null;
  readonly leases: LeaseRegistry;
  readonly leaseSummary: ActivitySummary;
  readonly chainBroken: boolean;
  readonly lane: LaneDivergence | undefined;
  readonly mailSummary: { readonly count: number; readonly oldestAgeMs: number | null };
};

export type GatherDashboardFailure = {
  readonly ok: false;
  readonly stage: 'repo_root' | 'composition' | 'kernel';
  readonly message: string;
};

/** Read-side orchestration for the TUI dashboard: the same store/kernel
 *  primitives runStatusCommand uses (resolve → compose → inspect → bind →
 *  session → leases → summarize), with no heartbeat write and no mint.
 *  Assembling this here (rather than reaching into status.ts internals)
 *  keeps the command layer the only owner of orchestration while the panel
 *  ASSEMBLY stays single-source via buildStatusPanelPayload. */
export function gatherDashboardState(opts: {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly now: () => Date;
  readonly leaseStaleTtlMs?: number;
  readonly staleTtlMs?: number;
}): GatheredDashboardState | GatherDashboardFailure {
  const env = opts.env ?? process.env;
  // 1. Repo root
  const repoRootResult = resolveRepoRoot(opts.cwd);
  if (!repoRootResult.ok) {
    return { ok: false, stage: 'repo_root', message: 'failed to resolve repo root.' };
  }
  const { repoRoot, cawsDir } = repoRootResult.value;
  const now = opts.now();

  // 2. Snapshot + doctor input
  let composition: ReturnType<typeof composeDoctorSnapshot>;
  try {
    composition = composeDoctorSnapshot({ repoRoot, cawsDir, now });
  } catch (e) {
    return {
      ok: false,
      stage: 'composition',
      message: `store composition failed: ${(e as Error).message}`,
    };
  }
  const { snapshot, doctorInput } = composition;

  // 3. Kernel diagnoser
  let report: ReturnType<typeof inspectProjectState>;
  try {
    report = inspectProjectState(doctorInput);
  } catch (e) {
    return {
      ok: false,
      stage: 'kernel',
      message: `kernel inspect failed: ${(e as Error).message}`,
    };
  }

  // 4. Binding from cwd (bridges surface when one already resolves — no mint)
  const bridgesLoad = loadBridges(cawsDir);
  const bridgeSession = resolveCallerSession({
    cawsDir,
    worktreeRoot: opts.cwd,
    env,
    allowMint: false,
  });
  const binding = resolveBinding({
    repoRoot,
    cwd: opts.cwd,
    registry: snapshot.worktrees,
    specs: snapshot.specs,
    ...(bridgesLoad.ok && bridgeSession.ok
      ? {
          bridges: bridgesLoad.value.bridges,
          sessionId: bridgeSession.value.identity.session_id,
        }
      : {}),
  });

  // 5. Session — read-only, never mints.
  const sessionResult = resolveCallerSession({
    cawsDir,
    worktreeRoot: opts.cwd,
    env,
    now: opts.now,
    allowMint: false,
  });
  const selfSessionId = sessionResult.ok ? sessionResult.value.identity.session_id : null;

  // 6. Leases (operational cache — missing/malformed never blocks the dashboard)
  const leasesLoad = loadLeases(cawsDir);
  const leases: LeaseRegistry = leasesLoad.ok ? leasesLoad.value.leases : {};

  // 7. Summarize (defensive, mirrors status)
  const DEFAULT_LEASE_STALE_TTL_MS = 30 * 60 * 1000; // 30m
  const ttl = opts.leaseStaleTtlMs ?? DEFAULT_LEASE_STALE_TTL_MS;
  let leaseSummary: ActivitySummary = EMPTY_ACTIVITY_SUMMARY;
  if (typeof summarizeActiveAgents === 'function') {
    leaseSummary = summarizeActiveAgents(leases, now, ttl) ?? EMPTY_ACTIVITY_SUMMARY;
  }

  // 8b. Undelivered mail summary — read-only, non-blocking.
  let mailSummary: { count: number; oldestAgeMs: number | null } = { count: 0, oldestAgeMs: null };
  try {
    const mail = inboxAllMessages(cawsDir);
    if (mail.ok) mailSummary = { count: mail.value.count, oldestAgeMs: mail.value.oldestAgeMs };
  } catch {
    /* non-blocking */
  }

  // Lane divergence — computed only when cwd is inside a tracked worktree,
  // read against the CANONICAL repo root (same rationale as status).
  const chainBroken = report.findings.some(
    (f) => f.rule === 'doctor.event.chain_invalid' && f.severity === 'error'
  );
  let lane: LaneDivergence | undefined;
  if (binding.worktreeName !== undefined) {
    const record = snapshot.worktrees[binding.worktreeName];
    if (record !== undefined) {
      lane = computeLaneDivergence(repoRoot, record.branch ?? '', record.baseBranch ?? '');
    }
  }

  return {
    ok: true,
    repoRoot,
    cawsDir,
    now,
    snapshot,
    findings: report.findings,
    binding,
    selfSessionId,
    leases,
    leaseSummary,
    chainBroken,
    lane,
    mailSummary,
  };
}

// ─── Gates panel (TUI-only assembly, same store primitives as gates list) ─

export interface GatePanelRow {
  readonly gate_id: string;
  readonly enabled: boolean;
  readonly mode: string;
  readonly effective_waiver_count: number;
}

export type GatesPanel =
  | { readonly ok: true; readonly gates: readonly GatePanelRow[] }
  | { readonly ok: false; readonly reason: 'no_policy' | 'composition' };

/** Assemble the gates panel from the same composed store snapshot the
 *  `caws gates list` command reads (policy + waivers via
 *  effectiveWaiversForGate). Deliberately NOT a re-export of the gates
 *  command internals: it reads the same authority with the same rules, and
 *  stays read-only. */
export function buildGatesPanel(opts: {
  readonly repoRoot: string;
  readonly cawsDir: string;
  readonly now: Date;
}): GatesPanel {
  let snapshot: ReturnType<typeof composeStoreSnapshot>;
  try {
    snapshot = composeStoreSnapshot({ repoRoot: opts.repoRoot, cawsDir: opts.cawsDir });
  } catch {
    return { ok: false, reason: 'composition' };
  }
  if (snapshot.policy === undefined) {
    return { ok: false, reason: 'no_policy' };
  }
  const gates: GatePanelRow[] = Object.entries(snapshot.policy.gates).map(([gateId, config]) => {
    const cfg = config as { enabled: boolean; mode: string };
    const effective = effectiveWaiversForGate({
      waivers: snapshot.waivers,
      gate: gateId,
      now: opts.now,
    });
    return {
      gate_id: gateId,
      enabled: cfg.enabled,
      mode: cfg.mode,
      effective_waiver_count: effective.length,
    };
  });
  return { ok: true, gates };
}
