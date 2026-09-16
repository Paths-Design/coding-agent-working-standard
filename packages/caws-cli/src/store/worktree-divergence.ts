// Lane divergence: how far a worktree's branch has moved relative to its base.
//
// `caws worktree list` and `caws status` both answer "what is this lane?" but
// neither could answer "is this lane current?". Agents had to drop to raw git
// (`git rev-list --left-right --count main...HEAD`) to learn that a lane was
// 1129 commits behind base — a fact that changes what you do next, and one the
// governed surfaces already had every input to report.
//
// Three properties this module holds, in the order they matter:
//
//   READ-ONLY. Only `rev-parse --verify` and `rev-list --count` run here. No
//   ref is written, no working tree is touched, nothing under `.caws/` moves.
//   `caws status` is byte-stable by contract and calls into this; that
//   contract survives because nothing here can mutate.
//
//   DEGRADES, NEVER FAILS. A deleted branch, an absent base, a legacy registry
//   record carrying the literal string `unknown` as its branch — each yields
//   `{ ahead: null, behind: null, unknownReason: <why> }`. Fabricating 0/0 for
//   an unresolvable ref would read as "this lane is current", which is the one
//   wrong answer; and a divergence failure never changes a caller's exit code.
//
//   LOCAL REFS, POINT IN TIME. Worktrees share one object database and one ref
//   namespace with the canonical checkout, so `main` here is *local* main. It
//   may already be behind a peer's landed work, and it can move between this
//   read and any later decision. These counts orient a human; they are not a
//   merge-time guarantee. `caws worktree merge` reconciles for real, via the
//   compare-and-swap on the base ref.

import { runGit } from './repo-root';

/**
 * One lane's position relative to its base branch.
 *
 * `ahead`/`behind`/`containsBase` are all non-null together, or all null
 * together with `unknownReason` populated — there is no partial answer.
 */
export interface LaneDivergence {
  /** The lane's branch, as recorded in the worktree registry. */
  readonly branch: string;
  /** The branch the lane forked from and would merge back into. */
  readonly baseBranch: string;
  /** Commits on `branch` that are not on `baseBranch`. Null when unresolvable. */
  readonly ahead: number | null;
  /** Commits on `baseBranch` that are not on `branch`. Null when unresolvable. */
  readonly behind: number | null;
  /**
   * True iff every commit on `baseBranch` is reachable from `branch` — i.e.
   * the base is an ancestor, so the lane already contains all of it. This is
   * exactly `behind === 0`; it is named separately because "is this lane
   * current?" is the question callers ask, and `behind === 0` is the answer
   * only if you already know which side of the range `behind` counts.
   */
  readonly containsBase: boolean | null;
  /** Why the counts are unavailable. Null exactly when the counts resolved. */
  readonly unknownReason: string | null;
}

function unresolved(
  branch: string,
  baseBranch: string,
  unknownReason: string
): LaneDivergence {
  return {
    branch,
    baseBranch,
    ahead: null,
    behind: null,
    containsBase: null,
    unknownReason,
  };
}

/** Does this ref name resolve to a commit in `repoRoot`? */
function refResolves(repoRoot: string, ref: string): boolean {
  // `--verify` + the `^{commit}` peel rejects a ref that exists but does not
  // name a commit; `--quiet` keeps git's "unknown revision" noise off stderr,
  // which would otherwise land in the caller's captured output.
  return runGit(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], repoRoot).ok;
}

/**
 * Compute `branch`'s divergence from `baseBranch` using the shared ref
 * namespace at `repoRoot`.
 *
 * `repoRoot` is the CANONICAL repo root, not a linked worktree path. Both are
 * correct — worktrees share the object database — but the canonical root is
 * the one every caller already has resolved, and using it consistently means
 * two surfaces reading the same lane cannot disagree.
 */
export function computeLaneDivergence(
  repoRoot: string,
  branch: string,
  baseBranch: string
): LaneDivergence {
  if (branch.length === 0) {
    return unresolved(branch, baseBranch, 'registry entry records no branch');
  }
  if (baseBranch.length === 0) {
    return unresolved(branch, baseBranch, 'registry entry records no base branch');
  }
  if (!refResolves(repoRoot, branch)) {
    return unresolved(branch, baseBranch, `branch ref '${branch}' does not resolve`);
  }
  if (!refResolves(repoRoot, baseBranch)) {
    return unresolved(branch, baseBranch, `base ref '${baseBranch}' does not resolve`);
  }

  // `A...B` with --left-right --count prints "<left>\t<right>": commits
  // reachable from A but not B, then from B but not A. With A=base and
  // B=branch that is exactly (behind, ahead).
  const counts = runGit(
    ['rev-list', '--left-right', '--count', `${baseBranch}...${branch}`],
    repoRoot
  );
  if (!counts.ok) {
    return unresolved(branch, baseBranch, `git rev-list failed: ${counts.reason.trim()}`);
  }
  const fields = counts.stdout.trim().split(/\s+/);
  const behind = Number.parseInt(fields[0] ?? '', 10);
  const ahead = Number.parseInt(fields[1] ?? '', 10);
  if (!Number.isFinite(behind) || !Number.isFinite(ahead)) {
    return unresolved(
      branch,
      baseBranch,
      `git rev-list returned unparseable counts: ${JSON.stringify(counts.stdout.trim())}`
    );
  }

  return {
    branch,
    baseBranch,
    ahead,
    behind,
    containsBase: behind === 0,
    unknownReason: null,
  };
}

/**
 * The compact per-row form: `ahead=2 behind=3`, or `ahead=? behind=?` when
 * unresolvable. Shared by every surface so a lane reads identically wherever
 * it appears.
 */
export function formatLaneCounts(divergence: LaneDivergence): string {
  if (divergence.unknownReason !== null) return 'ahead=? behind=?';
  return `ahead=${divergence.ahead} behind=${divergence.behind}`;
}
