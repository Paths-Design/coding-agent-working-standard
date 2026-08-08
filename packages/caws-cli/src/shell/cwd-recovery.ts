// Doctor drift check: detect sessions wedged by a gone cwd
// (CAWS-GUARD-CWD-RECOVERY-001).
//
// When `caws worktree merge/destroy` (or a manual `git worktree remove`,
// or a crash mid-merge) deletes a worktree directory while a session's
// sticky shell cwd is inside it, every subsequent shell spawn in that
// session fails ENOENT — the session is permanently wedged with no
// self-recovery path (the spawn dies before any `cd` can run). Nothing
// in `caws` previously surfaced this; the operator had to notice the
// ENOENT storms and guess the cause.
//
// This file makes `caws doctor` detect the condition and route to the
// recovery (cd to repo_root, or restart the session there). It is a
// CLI/shell concern, NOT a kernel one, mirroring detectGitignoreDrift
// (src/init/gitignore-drift.ts) and detectBuildStaleness
// (src/shell/build-freshness.ts): a shell-owned DoctorFinding appended to
// the report alongside the kernel findings. The kernel's existing
// agent-lease findings consume a boolean map the STORE builds, but
// routing through that path would require a cross-package kernel release
// for a recovery-only observability finding; the shell-owned precedent is
// sanctioned and smaller-surface.

import * as fs from 'fs';

import type { DoctorFinding } from '../kernel';

import { loadLeases } from '../store/leases-store';
import { storeDiagnostic } from '../store/repo-root';

/** Rule id for the wedged-session finding (shell. prefix marks a
 * non-kernel-owned finding, matching GITIGNORE_DRIFT_RULE and
 * BUILD_DIST_STALE_RULE). */
export const AGENT_CWD_GONE_RULE = 'shell.agent.cwd_gone';

/**
 * Build the wedged-session doctor findings. Returns one error-severity
 * finding per RUNNING session (status active or stopping — a stopped
 * session will not spawn, so a gone cwd is harmless) whose recorded cwd
 * does not exist on disk.
 *
 * The check is read-only: it loads leases via the existing lenient
 * loadLeases (a malformed lease is dropped, not crashed on), stats each
 * running lease's cwd via fs.existsSync, and never mutates .caws/.
 *
 * @param cawsDir The project's .caws/ directory (where leases/ lives).
 */
export function detectWedgedSessions(cawsDir: string): DoctorFinding[] {
  const leasesResult = loadLeases(cawsDir);
  if (!leasesResult.ok) return []; // lenient: never block doctor on a load error

  const findings: DoctorFinding[] = [];
  for (const lease of Object.values(leasesResult.value.leases)) {
    // Only running sessions can wedge — a stopped session won't spawn.
    if (lease.status !== 'active' && lease.status !== 'stopping') continue;
    // Fail-open on transient fs errors: a thrown stat must not crash doctor.
    // existsSync returns false for a missing path AND for a fs error, which
    // is exactly the wedge signal — but guard explicitly so the intent is
    // clear and a future fs-api change can't silently invert it.
    let cwdExists = true;
    try {
      cwdExists = fs.existsSync(lease.cwd);
    } catch {
      cwdExists = true; // fail-open: do not fabricate a finding on a stat error
    }
    if (cwdExists) continue;

    findings.push(
      storeDiagnostic(
        AGENT_CWD_GONE_RULE,
        `Session ${lease.session_id} is wedged: its shell cwd (${lease.cwd}) ` +
          'does not exist on disk. The directory was removed (typically by a ' +
          '`caws worktree merge/destroy`, a manual `git worktree remove`, or a ' +
          'crash mid-merge) while the session was inside it. Every subsequent ' +
          'shell spawn in this session fails ENOENT and cannot self-recover.',
        {
          severity: 'error',
          subject: lease.session_id,
          narrowRepair:
            `Reset this session's shell cwd: \`cd ${lease.repo_root}\` ` +
            '(or restart the session rooted at the repo root). The session ' +
            'cannot run any further commands until its cwd points at an ' +
            'existing directory. CAWS will not change a live session\'s ' +
            'shell cwd automatically.',
          data: {
            session_id: lease.session_id,
            cwd: lease.cwd,
            repo_root: lease.repo_root,
            ...(lease.branch !== undefined ? { branch: lease.branch } : {}),
            ...(lease.pid !== undefined ? { pid: lease.pid } : {}),
          },
        }
      ) as DoctorFinding
    );
  }
  return findings;
}
