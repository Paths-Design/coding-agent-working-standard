// Doctor drift check: detect a CAWS project whose ephemeral .caws/ runtime
// state is NOT git-ignored (CAWS-DOCTOR-GITIGNORE-DRIFT-001).
//
// CAWS-INIT-GITIGNORE-MANAGE-001 makes `caws init` write a managed .gitignore
// block ignoring ephemeral .caws/ state. But projects created BEFORE that
// feature (or whose block drifted) leave worktrees.json / agents.json /
// leases/ / events.jsonl untracked-but-not-ignored, and users only discover it
// by accident. `caws doctor` surfaces that drift here and routes to the
// idempotent `caws init` fix.
//
// This is a CLI/shell concern, NOT a kernel one: the kernel's
// inspectProjectState knows nothing about .gitignore or init's managed-block
// format. The check lives here and doctor appends its finding alongside the
// kernel findings.
//
// Drift determination REUSES gitignore-manage (computeGitignore +
// EPHEMERAL_CAWS_ENTRIES) so doctor and init can never disagree about what
// counts as drift or which paths are ephemeral.

import * as fs from 'fs';
import * as path from 'path';

import type { DoctorFinding } from '@paths.design/caws-kernel';

import {
  EPHEMERAL_CAWS_ENTRIES,
  computeGitignore,
} from './gitignore-manage';

/** Rule id for the gitignore-drift finding (mirrors the kernel rule-id style). */
export const GITIGNORE_DRIFT_RULE = 'shell.gitignore.ephemeral_state_untracked';

/** True when `repoRoot` is inside a git working tree (a .gitignore is
 * meaningful only then). Pure FS check — the canonical .git marker exists at
 * the repo root for both normal checkouts and the main worktree. We avoid
 * spawning git here; doctor already resolved the repo root, and a .git entry
 * (dir or file) at the root is a reliable signal. */
function hasGitDir(repoRoot: string): boolean {
  return fs.existsSync(path.join(repoRoot, '.git'));
}

/** True when .caws/specs/ holds at least one spec YAML — i.e. this is a real
 * CAWS project, not a bare bootstrap. */
function hasAnySpec(cawsDir: string): boolean {
  const specsDir = path.join(cawsDir, 'specs');
  let entries: string[];
  try {
    entries = fs.readdirSync(specsDir);
  } catch {
    return false;
  }
  return entries.some((name) => name.endsWith('.yaml') || name.endsWith('.yml'));
}

/**
 * Inspect the repo for ungitignored ephemeral .caws/ state. Returns a single
 * WARNING DoctorFinding when there is genuine drift, or null otherwise.
 *
 * Emits a finding only when ALL hold:
 *   1. repoRoot is a git working tree (a .gitignore is meaningful),
 *   2. .caws/ has at least one spec (a real project),
 *   3. computeGitignore(currentContent) would CHANGE the file — i.e. the
 *      managed block is absent or stale, leaving ephemeral paths un-ignored.
 *
 * The check is read-only; it never writes .gitignore (that is `caws init`'s
 * job). Severity is WARNING so it does not flip doctor's exit code.
 */
export function detectGitignoreDrift(
  repoRoot: string,
  cawsDir: string
): DoctorFinding | null {
  if (!hasGitDir(repoRoot)) return null;
  if (!hasAnySpec(cawsDir)) return null;

  let existing: string | null = null;
  try {
    existing = fs.readFileSync(path.join(repoRoot, '.gitignore'), 'utf8');
  } catch {
    existing = null; // absent → drift (block needs creating)
  }

  // Reuse the exact drift logic init uses. A non-'unchanged'/'adopted' outcome
  // means the managed block is missing or stale — i.e. ephemeral state is not
  // (fully) ignored.
  const { outcome } = computeGitignore(existing, {});
  const isDrifted = outcome !== 'unchanged';
  if (!isDrifted) return null;

  return {
    rule: GITIGNORE_DRIFT_RULE,
    authority: 'kernel/diagnostics',
    severity: 'warning',
    message:
      'Ephemeral .caws/ runtime state is not git-ignored. Without ignore rules, ' +
      'per-CLI/per-session state (worktrees.json, agents.json, leases/, ' +
      'events.jsonl, caches) can be accidentally committed.',
    subject: '.gitignore',
    narrowRepair:
      'Run `caws init` (idempotent) to write/update the managed CAWS ' +
      `.gitignore block. It ignores: ${EPHEMERAL_CAWS_ENTRIES.join(', ')}. ` +
      'Authority state (.caws/specs/, .caws/policy.yaml, .caws/waivers/) stays ' +
      'tracked.',
    data: {
      gitignore_outcome_if_init_ran: outcome,
      ephemeral_entries: EPHEMERAL_CAWS_ENTRIES,
    },
  };
}
