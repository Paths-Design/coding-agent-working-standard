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
import { renderStatus } from '../render/status';
import { resolveSession } from '../session/resolve-session';

const DEFAULT_LEASE_STALE_TTL_MS = 30 * 60 * 1000; // 30m

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
  const leaseTtl = opts.leaseStaleTtlMs ?? DEFAULT_LEASE_STALE_TTL_MS;
  const summary: ActivitySummary = summarizeActiveAgents(leases, now, leaseTtl);

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

  out(
    renderStatus({
      repoRoot,
      cawsDir,
      policyLoaded: snapshot.policy !== undefined,
      specs: snapshot.specs,
      worktrees: snapshot.worktrees,
      agents: snapshot.agents,
      leases,
      leaseSummary: wantsHeartbeat
        ? summarizeActiveAgents(leases, now, leaseTtl)
        : summary,
      selfSessionId: sessionIdentity?.session_id ?? null,
      eventCount: snapshot.events.length,
      ...(snapshot.events.length > 0 ? { eventChainOk: !chainBroken } : {}),
      binding,
      session: sessionResult.ok ? sessionResult.value : null,
      doctorFindings: report.findings,
      now,
      ...(opts.staleTtlMs !== undefined ? { staleTtlMs: opts.staleTtlMs } : {}),
      ...(opts.findingCap !== undefined ? { findingCap: opts.findingCap } : {}),
    })
  );

  // Surface lease-load diagnostics in showData mode (non-blocking).
  if (showData && Array.isArray(leasesDiagnostics) && leasesDiagnostics.length > 0) {
    err(renderDiagnostics(leasesDiagnostics as never, { showData }));
  }

  return 0;
}
