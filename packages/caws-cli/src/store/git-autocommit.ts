// Shared utility for committing CAWS-authored writes to canonical state.
//
// CAWS-FIRST-CONTACT-UX-001 Fix 5/6.
//
// Problem: every caws subcommand that mutates .caws/worktrees.json (or
// other governance files) writes the file but does NOT commit it. The
// next agent walks in, sees a dirty registry, and either commits it
// blindly, leaves it, or stashes — each path produces different
// downstream confusion. Without a CLI-authored commit, no agent ever
// has a clean baseline to work from.
//
// Solution: this module exposes one function, `autoCommit`, that the
// worktrees-writer (and similar writers) call as the final step of a
// successful lifecycle transaction. The function is total over three
// observable states:
//
//   1. cwd is NOT inside a git working tree -> skip with kind:'skipped_no_git'
//      (defense-in-depth; caws worktree commands cannot reach this
//      branch in production because resolveRepoRoot requires git)
//
//   2. target file was dirty BEFORE the writer's own write (i.e. there
//      were unrelated uncommitted changes to the file already) -> refuse
//      commit with kind:'refused_dirty'. The writer's change still lands
//      in the working tree; the user resolves manually.
//
//   3. target file was clean BEFORE the writer's own write -> commit
//      succeeds with kind:'committed' and the resulting sha.
//
// The utility intentionally does NOT use --no-verify, --no-gpg-sign,
// or any hook-bypass flag. It interacts with whatever pre-commit /
// commit-msg hooks the consumer project has installed. Upstream caws
// ships no .git/hooks/pre-commit, so a vanilla caws-init'd project has
// nothing to interact with; downstream consumers (like Sterling) that
// install their own hooks remain responsible for admitting
// `chore(caws):` commits if they want CAWS auto-commits to land
// without manual hook configuration.
//
// The dirty-detection contract is "dirty before the writer's own
// write." The caller passes in `wasDirtyBeforeWrite: boolean` because
// only the caller knows what state the file was in before it called
// fs.writeFileSync. The utility does not try to re-derive that by
// reading git twice (race-prone and ambiguous: a dirty file with the
// writer's change applied looks identical to a dirty file without).

import { execFileSync } from 'child_process';
import * as path from 'path';

export type AutoCommitKind =
  | 'committed'
  | 'refused_dirty'
  | 'skipped_no_git';

export interface AutoCommitOutcome {
  readonly kind: AutoCommitKind;
  /** Present only when kind === 'committed'. The short sha of the
   *  resulting commit. */
  readonly sha?: string;
  /** Present when kind === 'refused_dirty'. A human-readable reason
   *  the caller should surface to the user. */
  readonly reason?: string;
}

export interface AutoCommitInput {
  /** Absolute path to the repo root. Used as cwd for git operations. */
  readonly repoRoot: string;
  /** Paths to stage and commit, repo-root-relative. Must be the exact
   *  set the writer wrote. Other dirty files will NOT be staged. */
  readonly paths: readonly string[];
  /** Conventional commit message. Should start with `chore(caws): `. */
  readonly message: string;
  /** Whether ANY of the target paths were dirty before the writer's
   *  own write. The caller knows this; the utility cannot rederive it
   *  after the write has landed. */
  readonly wasDirtyBeforeWrite: boolean;
}

function runGit(
  args: readonly string[],
  cwd: string
): { ok: true; stdout: string } | { ok: false; reason: string } {
  try {
    const stdout = execFileSync('git', [...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, stdout: stdout.toString() };
  } catch (e) {
    const cause = e as { message?: string; stderr?: Buffer | string };
    const stderr: string =
      cause.stderr instanceof Buffer
        ? cause.stderr.toString()
        : typeof cause.stderr === 'string'
          ? cause.stderr
          : '';
    const message: string =
      typeof cause.message === 'string' ? cause.message : '';
    return { ok: false, reason: stderr || message || 'unknown git error' };
  }
}

function isInsideGitWorkingTree(cwd: string): boolean {
  const r = runGit(['rev-parse', '--is-inside-work-tree'], cwd);
  if (!r.ok) return false;
  return r.stdout.trim() === 'true';
}

/**
 * Stage and commit CAWS-authored writes as the final step of a
 * lifecycle transaction.
 *
 * Returns an outcome describing what happened; never throws. Callers
 * should treat all three outcome kinds as non-fatal: a refused or
 * skipped commit does NOT mean the writer's transaction failed, only
 * that the audit-trail commit could not be authored automatically.
 */
export function autoCommit(input: AutoCommitInput): AutoCommitOutcome {
  if (!isInsideGitWorkingTree(input.repoRoot)) {
    return { kind: 'skipped_no_git' };
  }

  if (input.wasDirtyBeforeWrite) {
    return {
      kind: 'refused_dirty',
      reason:
        `${input.paths.join(', ')} was dirty before the caws write. ` +
        'The caws write has been applied to the working tree but not committed. ' +
        'Resolve the prior change manually (git add + git commit, or git checkout -- <path> to discard), ' +
        'then re-run the caws command if you want a clean audit commit.',
    };
  }

  // Stage exactly the writer's paths. Do NOT use `git add -A` —
  // that would silently stage unrelated dirty files.
  const addResult = runGit(['add', '--', ...input.paths], input.repoRoot);
  if (!addResult.ok) {
    return {
      kind: 'refused_dirty',
      reason: `git add failed: ${addResult.reason.trim()}`,
    };
  }

  // Check whether `git add` actually staged anything. If the writer's
  // write was a no-op (file already matched), there's nothing to
  // commit and we should NOT create an empty commit.
  const diffCached = runGit(
    ['diff', '--cached', '--name-only', '--', ...input.paths],
    input.repoRoot
  );
  if (!diffCached.ok) {
    return {
      kind: 'refused_dirty',
      reason: `git diff --cached failed: ${diffCached.reason.trim()}`,
    };
  }
  if (diffCached.stdout.trim().length === 0) {
    // Nothing to commit. Treat as 'committed' with no sha — the
    // writer's intended state IS already in HEAD.
    return { kind: 'committed', sha: '' };
  }

  const commitResult = runGit(
    ['commit', '-m', input.message],
    input.repoRoot
  );
  if (!commitResult.ok) {
    // Commit failed. Most likely a pre-commit hook refused (downstream
    // consumer hooks, not anything CAWS ships). Surface the hook's
    // reason verbatim; do NOT retry with --no-verify.
    return {
      kind: 'refused_dirty',
      reason: `git commit failed: ${commitResult.reason.trim()}`,
    };
  }

  // Capture the resulting sha for evidence/audit.
  const shaResult = runGit(
    ['rev-parse', '--short', 'HEAD'],
    input.repoRoot
  );
  const sha = shaResult.ok ? shaResult.stdout.trim() : '';
  return { kind: 'committed', sha };
}

/**
 * Helper: detect whether a path is dirty in the working tree. Callers
 * that need to populate `wasDirtyBeforeWrite` can use this BEFORE
 * calling fs.writeFileSync.
 */
export function isPathDirty(repoRoot: string, relPath: string): boolean {
  const r = runGit(['status', '--porcelain', '--', relPath], repoRoot);
  if (!r.ok) return false;
  return r.stdout.trim().length > 0;
}

/**
 * Helper: convert an absolute path to a repo-root-relative path. The
 * autocommit utility wants relative paths so git diff/add output is
 * stable across cwds.
 */
export function relativeToRepoRoot(repoRoot: string, abs: string): string {
  return path.relative(repoRoot, abs);
}
