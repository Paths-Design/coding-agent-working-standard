// `caws status` — vNext read-only dashboard.
//
// Hard constraint: status MUST NOT mutate anything by default. It loads
// state, runs the kernel diagnoser, and renders. It does NOT mint
// capsules, refresh heartbeats, write events, mutate worktrees.json, or
// alter agents.json. Ownership mutation belongs to `caws claim`; spec
// lifecycle belongs to `caws spec *`; event emission belongs to
// `caws evidence record`.
//
// MULTI-AGENT-ACTIVITY-REGISTRY-001 — narrowed status mutation rule
// (spec invariant 6, tightened in commit 4):
//
//   caws status                            → read-only (default)
//   caws status --session-id X             → read-only; identity only
//   caws status --heartbeat                → may write current session's lease
//   caws status --heartbeat --session-id X → writes explicit session's lease
//
// `--session-id` alone NEVER mutates. Only `--heartbeat` triggers a
// lease write. This narrows the §6 invariant 7 carve-out ("status may
// update leases") to require an explicit operator opt-in: default purity
// is safer, and prevents `status --session-id <other>` from accidentally
// impersonating or refreshing another session's lease.
//
// Status renders an "Agents" panel BEFORE the Doctor panel when leases
// exist. The panel distinguishes self/other, canonical/worktree,
// active/stale/stopped, and bound spec/worktree.
//
// Pipeline:
//   1. resolveRepoRoot(cwd)
//   2. composeDoctorSnapshot(...)                → snapshot + doctorInput
//   3. inspectProjectState(doctorInput)          → DoctorReport
//   4. resolveBinding(cwd, registry, specs)
//   5. resolveSession({ allowMint: false })      — read-only; never mints
//   6. loadLeases(cawsDir)                       — read-only
//   7. summarizeActiveAgents(leases, now, ttl)   — pure classification
//   8. If --heartbeat: applyLeasePatch(write_lease for self)
//   9. renderStatus(...)                         → stdout
//  10. exit 0 (regardless of doctor findings) or 2 on composition error

import {
  heartbeatAgentSession,
  inspectProjectState,
  summarizeActiveAgents,
  type ActivitySummary,
  type LeaseContext,
  type LeaseRegistry,
  type SessionIdentity,
} from '@paths.design/caws-kernel';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';

import {
  applyLeasePatch,
  composeDoctorSnapshot,
  loadLeases,
  resolveRepoRoot,
  safeLeaseFilename,
} from '../../store';
import { resolveBinding } from '../binding/resolve-binding';
import { renderDiagnostics } from '../render/diagnostic';
import { renderStatus, type StatusPanel } from '../render/status';
import { resolveSession } from '../session/resolve-session';

const DEFAULT_LEASE_STALE_TTL_MS = 30 * 60 * 1000; // 30m

/**
 * Safe wrapper around `summarizeActiveAgents` that defends against the
 * kernel symbol being absent at runtime.
 *
 * The crash this guards (Bug-001/002 from USER-E2E-SETUP-REHEARSAL-001)
 * occurs when caws-cli@11.1.x was installed against an older kernel
 * version (1.0.0) that predates the leases substrate. The cli's dep
 * range (`^1.0.0` at the time of the rehearsal) could resolve to a
 * kernel without `summarizeActiveAgents`, producing the symptom:
 *
 *   `(0 , caws_kernel_1.summarizeActiveAgents) is not a function`
 *
 * The dep range was tightened to `^1.1.0` in this slice, which prevents
 * future installs from hitting this case. The defensive guard below is
 * the second-half belt-and-suspenders: future kernel revs that remove
 * or rename the function, or partial/broken installs that strip the
 * dist artifact, still produce a typed diagnostic instead of a Node
 * "is not a function" crash with exit 0.
 *
 * Returns `null` when the kernel function is unavailable so callers can
 * route to a typed empty `ActivitySummary` + emit a one-line diagnostic.
 * Returns the kernel's summary unchanged when the function is present.
 */
function callSummarizeActiveAgentsSafe(
  leases: LeaseRegistry,
  now: Date,
  ttlMs: number
): ActivitySummary | null {
  if (typeof summarizeActiveAgents !== 'function') {
    return null;
  }
  return summarizeActiveAgents(leases, now, ttlMs);
}

const KERNEL_FEATURE_UNAVAILABLE_DIAGNOSTIC =
  'caws: kernel does not export summarizeActiveAgents; agent activity unavailable. ' +
  'This typically means caws-cli is paired with a pre-1.1.0 kernel. Reinstall: ' +
  'npm install -g @paths.design/caws-cli@latest';

const EMPTY_ACTIVITY_SUMMARY: ActivitySummary = {
  total: 0,
  active: [],
  stale: [],
  stopped: [],
};

export interface StatusCommandOptions {
  readonly cwd?: string;
  readonly now?: () => Date;
  readonly env?: NodeJS.ProcessEnv;
  readonly out?: (line: string) => void;
  readonly err?: (line: string) => void;
  /** Stale heartbeat TTL in ms; display only. Default 24h. */
  readonly staleTtlMs?: number;
  /** Stale lease TTL for the Agents panel (separate from the agents.json
   *  stale-heartbeat TTL above). Default 30m. */
  readonly leaseStaleTtlMs?: number;
  /** Cap on rendered top findings. Default 5. */
  readonly findingCap?: number;
  /** Show structured data blocks on rendered diagnostics. */
  readonly showData?: boolean;
  /** Opt-in lease mutation. When true, status writes/refreshes the
   *  current session's lease as a heartbeat. Default false. */
  readonly heartbeat?: boolean;
  /** Explicit session id (overrides resolveSession). Identity only by
   *  default — does NOT trigger a lease write unless --heartbeat is
   *  also passed. */
  readonly sessionId?: string;
  /** Platform tag for the lease record (only used when --heartbeat). */
  readonly platform?: string;
  readonly specs?: boolean;
  readonly worktrees?: boolean;
  readonly agents?: boolean;
  readonly doctor?: boolean;
  readonly json?: boolean;
}

function selectedPanels(opts: StatusCommandOptions): readonly StatusPanel[] | undefined {
  const panels: StatusPanel[] = [];
  if (opts.specs === true) panels.push('specs');
  if (opts.worktrees === true) panels.push('worktrees');
  if (opts.agents === true) panels.push('agents');
  if (opts.doctor === true) panels.push('doctor');
  return panels.length > 0 ? panels : undefined;
}

function countByLifecycle(specs: readonly { readonly lifecycle_state: string }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const spec of specs) counts[spec.lifecycle_state] = (counts[spec.lifecycle_state] ?? 0) + 1;
  return counts;
}

function countDoctorFindings(findings: readonly { readonly severity: string }[]): {
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

// ─── git path normalization (shared with agents command) ─────────────────

interface GitDirInfo {
  readonly git_common_dir: string;
  readonly git_dir: string;
  readonly branch?: string;
}

function readGitDirInfo(cwd: string): GitDirInfo | null {
  try {
    const commonDir = execFileSync(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    ).trim();
    const gitDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-dir'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    let branch: string | undefined;
    try {
      branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    } catch {
      // detached HEAD; leave undefined
    }
    return {
      git_common_dir: realpathSafe(commonDir),
      git_dir: realpathSafe(gitDir),
      ...(branch !== undefined && branch !== '' ? { branch } : {}),
    };
  } catch {
    return null;
  }
}

function realpathSafe(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

export function runStatusCommand(opts: StatusCommandOptions = {}): number {
  const cwd = opts.cwd ?? process.cwd();
  const nowFn = opts.now ?? (() => new Date());
  const env = opts.env ?? process.env;
  const out = opts.out ?? ((s: string) => process.stdout.write(s + '\n'));
  const err = opts.err ?? ((s: string) => process.stderr.write(s + '\n'));
  const showData = opts.showData === true;

  // 1. Repo root
  const repoRootResult = resolveRepoRoot(cwd);
  if (!repoRootResult.ok) {
    err('caws status: failed to resolve repo root.');
    err(renderDiagnostics(repoRootResult.errors, { showData }));
    return 2;
  }
  const { repoRoot, cawsDir } = repoRootResult.value;
  const now = nowFn();

  // 2. Snapshot + doctor input
  let composition: ReturnType<typeof composeDoctorSnapshot>;
  try {
    composition = composeDoctorSnapshot({ repoRoot, cawsDir, now });
  } catch (e) {
    err(`caws status: store composition failed: ${(e as Error).message}`);
    return 2;
  }
  const { snapshot, doctorInput } = composition;

  // 3. Run the kernel diagnoser
  let report: ReturnType<typeof inspectProjectState>;
  try {
    report = inspectProjectState(doctorInput);
  } catch (e) {
    err(`caws status: kernel inspect failed: ${(e as Error).message}`);
    return 2;
  }

  // 4. Binding from cwd
  const binding = resolveBinding({
    repoRoot,
    cwd,
    registry: snapshot.worktrees,
    specs: snapshot.specs,
  });

  // 5. Session — READ-ONLY by default. Mint is only permitted when
  // --heartbeat is set (we need a stable identity to write a lease).
  const wantsHeartbeat = opts.heartbeat === true;
  let sessionIdentity: SessionIdentity | null = null;

  if (opts.sessionId !== undefined) {
    // Explicit --session-id flag — validate as safe filename for
    // future write (even if --heartbeat is not set, validating early
    // gives the operator a clear error rather than silent acceptance).
    const fnRes = safeLeaseFilename(opts.sessionId);
    if (!fnRes.ok) {
      err(`caws status: invalid --session-id "${opts.sessionId}".`);
      err(renderDiagnostics(fnRes.errors, { showData }));
      return 1;
    }
    sessionIdentity = {
      session_id: opts.sessionId,
      platform: opts.platform ?? 'unknown',
    };
  }

  const sessionResult = resolveSession({
    cawsDir,
    worktreeRoot: cwd,
    env,
    now: nowFn,
    allowMint: wantsHeartbeat && sessionIdentity === null,
  });
  if (sessionIdentity === null && sessionResult.ok) {
    sessionIdentity = sessionResult.value.identity;
  }

  // 6. Load leases (operational cache — never blocks status if leases
  // dir is missing or malformed).
  const leasesLoad = loadLeases(cawsDir);
  let leases: LeaseRegistry = {};
  let leasesDiagnostics: ReturnType<typeof loadLeases> extends infer R
    ? R extends { ok: true; value: { diagnostics: infer D } }
      ? D
      : never
    : never = [] as never;
  if (leasesLoad.ok) {
    leases = leasesLoad.value.leases;
    leasesDiagnostics = leasesLoad.value.diagnostics as never;
  } else if (showData) {
    err(renderDiagnostics(leasesLoad.errors, { showData }));
  }

  // 7. Summarize (pure read-side classification; no write side effect).
  //    Defensive feature-detect: if the kernel does not export
  //    summarizeActiveAgents (e.g., a partial/stale install or a future
  //    kernel rev that removes it), fall back to an empty summary and
  //    emit a typed diagnostic on stderr rather than crashing.
  const leaseTtl = opts.leaseStaleTtlMs ?? DEFAULT_LEASE_STALE_TTL_MS;
  const initialSummary = callSummarizeActiveAgentsSafe(leases, now, leaseTtl);
  if (initialSummary === null) {
    err(KERNEL_FEATURE_UNAVAILABLE_DIAGNOSTIC);
  }
  const summary: ActivitySummary = initialSummary ?? EMPTY_ACTIVITY_SUMMARY;

  // 8. OPT-IN heartbeat write. Only fires when --heartbeat is set.
  // --session-id alone never triggers this.
  if (wantsHeartbeat) {
    if (sessionIdentity === null) {
      err('caws status: --heartbeat requires resolvable session identity (set CLAUDE_SESSION_ID, use a capsule, or pass --session-id).');
      // Continue rendering — heartbeat failure is non-fatal.
    } else {
      const gitInfo = readGitDirInfo(cwd);
      if (gitInfo !== null) {
        const context: LeaseContext = {
          repo_root: repoRoot,
          cwd,
          git_common_dir: gitInfo.git_common_dir,
          git_dir: gitInfo.git_dir,
          ...(gitInfo.branch !== undefined ? { branch: gitInfo.branch } : {}),
          ...(binding.worktreeName !== undefined ? { bound_worktree: binding.worktreeName } : {}),
          ...(binding.binding.kind === 'bound' ? { bound_spec_id: binding.binding.spec.id } : {}),
          pid: process.pid,
          hostname: os.hostname(),
        };
        const patchRes = heartbeatAgentSession(leases, sessionIdentity, context, now, 'status');
        if (patchRes.ok) {
          const applyRes = applyLeasePatch(cawsDir, patchRes.value);
          if (applyRes.ok) {
            // Re-summarize to include the fresh write.
            const reload = loadLeases(cawsDir);
            if (reload.ok) {
              leases = reload.value.leases;
            }
          } else if (showData) {
            err(renderDiagnostics(applyRes.errors, { showData }));
          }
        }
      }
    }
  }

  // 9. Render
  const chainBroken = report.findings.some(
    (f) => f.rule === 'doctor.event.chain_invalid' && f.severity === 'error'
  );
  const panels = selectedPanels(opts);
  const effectiveLeaseSummary = wantsHeartbeat
    ? (callSummarizeActiveAgentsSafe(leases, now, leaseTtl) ?? EMPTY_ACTIVITY_SUMMARY)
    : summary;
  const renderInput = {
    repoRoot,
    cawsDir,
    policyLoaded: snapshot.policy !== undefined,
    specs: snapshot.specs,
    worktrees: snapshot.worktrees,
    agents: snapshot.agents,
    leases,
    leaseSummary: effectiveLeaseSummary,
    selfSessionId: sessionIdentity?.session_id ?? null,
    eventCount: snapshot.events.length,
    ...(snapshot.events.length > 0 ? { eventChainOk: !chainBroken } : {}),
    binding,
    session: sessionResult.ok ? sessionResult.value : null,
    doctorFindings: report.findings,
    now,
    ...(opts.staleTtlMs !== undefined ? { staleTtlMs: opts.staleTtlMs } : {}),
    ...(opts.findingCap !== undefined ? { findingCap: opts.findingCap } : {}),
    ...(panels !== undefined ? { panels } : {}),
  };

  if (opts.json === true) {
    const jsonPanels = panels ?? ['specs', 'worktrees', 'agents', 'doctor'] as const;
    const payload: Record<string, unknown> = {
      ok: true,
      read_only: !wantsHeartbeat,
      panels: jsonPanels,
    };
    if (jsonPanels.includes('specs')) {
      payload.specs = {
        count: snapshot.specs.length,
        by_lifecycle: countByLifecycle(snapshot.specs),
        items: snapshot.specs.map((spec) => ({
          id: spec.id,
          title: spec.title,
          lifecycle_state: spec.lifecycle_state,
          ...(spec.worktree !== undefined ? { worktree: spec.worktree } : {}),
        })),
      };
    }
    if (jsonPanels.includes('worktrees')) {
      payload.worktrees = {
        count: Object.keys(snapshot.worktrees).length,
        items: Object.entries(snapshot.worktrees).map(([name, record]) => ({
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
          total: effectiveLeaseSummary.total,
          active: effectiveLeaseSummary.active,
          stale: effectiveLeaseSummary.stale,
          stopped: effectiveLeaseSummary.stopped,
        },
        self_session_id: sessionIdentity?.session_id ?? null,
      };
    }
    if (jsonPanels.includes('doctor')) {
      payload.doctor = {
        counts: countDoctorFindings(report.findings),
        findings: report.findings,
      };
    }
    out(JSON.stringify(payload, null, 2));
    return 0;
  }

  out(renderStatus(renderInput));

  // Surface lease-load diagnostics in showData mode (non-blocking).
  if (showData && Array.isArray(leasesDiagnostics) && leasesDiagnostics.length > 0) {
    err(renderDiagnostics(leasesDiagnostics as never, { showData }));
  }

  return 0;
}
