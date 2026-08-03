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

import { sleepSyncMs } from './repo-root';

// CAWS-FIX-N3-BIND-INDEX-LOCK-RETRY-001: the audit commit must tolerate a
// transient .git/index.lock held by a concurrent git process (a sibling
// agent's commit) rather than stranding the staged spec change. The
// retry budget and delay mirror the merge CAS loop
// (MERGE_CAS_MAX_ATTEMPTS = 5) and the file-lock retry loops
// (LOCK_RETRY_DELAY_MS = 50); overridable via AutoCommitInput so tests
// can exercise exhaustion deterministically without real timing.
const INDEX_LOCK_MAX_ATTEMPTS_DEFAULT = 5;
const INDEX_LOCK_RETRY_DELAY_MS_DEFAULT = 50;

/**
 * True when a git failure reason indicates .git/index.lock contention —
 * git emits both of these (the fatal EEXIST line and the explanatory
 * paragraph) for an add or a commit under a held lock, stable across
 * versions. Non-matching reasons (a pre-commit hook refusal, a genuine
 * error) are NOT contention and must not be retried.
 * (CAWS-FIX-N3-BIND-INDEX-LOCK-RETRY-001.)
 */
function isIndexLockContention(reason: string): boolean {
  return /index\.lock'?: File exists|Another git process seems to be running in this repository/.test(
    reason
  );
}

/**
 * The exhaustion diagnostic for persistent index.lock contention. Used by
 * both the `git add` and `git commit` final-attempt contention branches so
 * the operator is told the failure was contention (a concurrent git
 * process held the lock), not a bare "git add/commit failed" that reads
 * like a hook refusal. (CAWS-FIX-N3-BIND-INDEX-LOCK-RETRY-001.)
 */
function indexLockExhaustedReason(maxAttempts: number): string {
  return (
    `git commit could not land after ${maxAttempts} attempts: .git/index.lock was held by a concurrent git process. ` +
    'The caws write is intact in the working tree (staged); retry the caws command once the other git process has finished.'
  );
}

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
  /**
   * Override the index.lock-contention retry budget. Defaults to 5
   * (INDEX_LOCK_MAX_ATTEMPTS_DEFAULT). Exposed so tests can exercise the
   * exhaustion path deterministically without real timing.
   * (CAWS-FIX-N3-BIND-INDEX-LOCK-RETRY-001.)
   */
  readonly indexLockMaxAttempts?: number;
  /**
   * Override the inter-attempt synchronous delay in milliseconds.
   * Defaults to 50 (INDEX_LOCK_RETRY_DELAY_MS_DEFAULT).
   * (CAWS-FIX-N3-BIND-INDEX-LOCK-RETRY-001.)
   */
  readonly indexLockRetryDelayMs?: number;
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

  // Drop intentionally-gitignored paths before staging. `caws init` ignores
  // ephemeral per-CLI registry state (.caws/worktrees.json, agents.json) as
  // a deliberate policy; a lifecycle transition that includes such a path in
  // its audit-commit set must NOT hard-fail on "git add: paths are ignored",
  // and must NEVER force-add (`-f`) — force-tracking a file the gitignore
  // says to keep untracked would violate that policy. We commit only the
  // remaining TRACKED authority paths (e.g. the spec binding). If every path
  // is ignored, there is nothing tracked to commit — a clean no-op, not a
  // failure. (CAWS-LATCH-READONLY-AND-WORKTREE-GITIGNORE-001 A5/A6)
  const trackablePaths = input.paths.filter((p) => {
    // `git check-ignore -q <path>` exits 0 when the path IS ignored.
    const ignored = runGit(['check-ignore', '-q', '--', p], input.repoRoot);
    return !ignored.ok;
  });
  if (trackablePaths.length === 0) {
    // All input paths are gitignored ephemeral state — nothing tracked to
    // commit. The writer's intended state is on disk; treat as committed
    // with no sha rather than refusing.
    return { kind: 'committed', sha: '' };
  }

  // Stage and commit the writer's TRACKED paths.
  //
  // CAWS-FIX-N3-BIND-INDEX-LOCK-RETRY-001: the add -> diff --cached ->
  // commit sequence runs inside a bounded retry loop that treats a
  // concurrent .git/index.lock (a sibling agent's commit holding the
  // shared index lock) as transient contention. On an index.lock
  // collision we sleep briefly and re-run the WHOLE sequence — re-running
  // `git add` is safe because the commit is path-scoped
  // (CAWS-AUTOCOMMIT-INTEGRITY-001): only the writer's TRACKED paths are
  // ever committed, so re-staging cannot sweep foreign staged files into
  // the audit commit. Any NON-contention failure (a pre-commit hook
  // refusal, a genuine git error) breaks out immediately with the
  // existing refused_dirty outcome — the never --no-verify / hook-respect
  // contract is unchanged.
  const maxAttempts = input.indexLockMaxAttempts ?? INDEX_LOCK_MAX_ATTEMPTS_DEFAULT;
  const retryDelayMs = input.indexLockRetryDelayMs ?? INDEX_LOCK_RETRY_DELAY_MS_DEFAULT;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Stage exactly the writer's TRACKED paths. Do NOT use `git add -A` —
    // that would silently stage unrelated dirty files.
    const addResult = runGit(['add', '--', ...trackablePaths], input.repoRoot);
    if (!addResult.ok) {
      if (isIndexLockContention(addResult.reason) && attempt < maxAttempts) {
        sleepSyncMs(retryDelayMs);
        continue;
      }
      // On the final attempt, surface the clean contention diagnostic
      // rather than a bare "git add failed" so the operator knows the
      // cause was index.lock contention, not a hook refusal.
      if (isIndexLockContention(addResult.reason)) {
        return { kind: 'refused_dirty', reason: indexLockExhaustedReason(maxAttempts) };
      }
      return {
        kind: 'refused_dirty',
        reason: `git add failed: ${addResult.reason.trim()}`,
      };
    }

    // Check whether `git add` actually staged anything. If the writer's
    // write was a no-op (file already matched), there's nothing to
    // commit and we should NOT create an empty commit.
    const diffCached = runGit(
      ['diff', '--cached', '--name-only', '--', ...trackablePaths],
      input.repoRoot
    );
    if (!diffCached.ok) {
      // `git diff --cached` reads the index and does NOT take the lock,
      // so an index.lock collision cannot surface here. Treat any failure
      // as a genuine error — do not retry.
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

    // Commit ONLY the writer's own paths via an explicit pathspec.
    // A bare `git commit -m <msg>` commits the ENTIRE index, which under
    // a shared cross-worktree index (a concurrent sibling session may have
    // pre-staged unrelated files) would sweep those foreign files into a
    // CAWS lifecycle commit — the exact cross-session attribution failure
    // CAWS exists to prevent. Path-scoping the commit makes it total over
    // ambient index state: only `input.paths` are committed, whatever else
    // is staged: only the writer's TRACKED paths. (CAWS-AUTOCOMMIT-INTEGRITY-001)
    const commitResult = runGit(
      ['commit', '-m', input.message, '--', ...trackablePaths],
      input.repoRoot
    );
    if (commitResult.ok) {
      // Success — capture the resulting sha for evidence/audit and return.
      const shaResult = runGit(['rev-parse', '--short', 'HEAD'], input.repoRoot);
      const sha = shaResult.ok ? shaResult.stdout.trim() : '';
      return { kind: 'committed', sha };
    }
    if (isIndexLockContention(commitResult.reason) && attempt < maxAttempts) {
      sleepSyncMs(retryDelayMs);
      continue;
    }
    // On the final attempt with contention, surface the clean exhaustion
    // diagnostic. Otherwise (a non-contention failure) surface the reason
    // verbatim — never retry with --no-verify.
    if (isIndexLockContention(commitResult.reason)) {
      return { kind: 'refused_dirty', reason: indexLockExhaustedReason(maxAttempts) };
    }
    return {
      kind: 'refused_dirty',
      reason: `git commit failed: ${commitResult.reason.trim()}`,
    };
  }

  // The loop body returns from every real path (success, non-contention
  // failure, or contention-exhausted). We only reach here if the budget
  // was non-positive (maxAttempts < 1) and the loop never ran. Treat that
  // as a degenerate exhaustion — the caller asked for zero attempts, so
  // nothing committed and we surface the contention diagnostic.
  return { kind: 'refused_dirty', reason: indexLockExhaustedReason(maxAttempts) };
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
