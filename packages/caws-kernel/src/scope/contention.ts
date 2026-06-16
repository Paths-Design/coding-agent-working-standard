// Cross-worktree scope contention (CAWS-SCOPE-CONTENTION-CMD-001).
//
// PURE kernel evaluator. Answers: "for this path, which OTHER active worktrees
// (on the same base branch) have a bound active spec whose scope.in claims it?"
//
// This replaces the inline `node -e` + js-yaml SPEC_CONTENTION_CHECK block that
// worktree-write-guard.sh used to carry — a parallel evaluator that re-loaded
// js-yaml and re-implemented glob matching. The kernel is the single scope
// matcher (matchGlob); the hook becomes a thin caller via `caws scope
// contention`. No I/O here: the shell passes the already-loaded registry +
// specs (from composeStoreSnapshot), mirroring evaluatePath.

import type { Spec } from '../spec/types';
import type { WorktreeRegistry } from '../worktree/types';
import { matchGlob } from './match';

/** One worktree whose bound active spec scope.in admits the queried path. */
export interface ContentionClaimant {
  /** The worktree name (registry key). */
  readonly worktreeName: string;
  /** The bound spec id. */
  readonly specId: string;
  /** The scope.in entry that matched the path. */
  readonly matchedPattern: string;
}

/** Why contention could not be determined for a worktree (fail-closed signal). */
export type ContentionUndeterminedReason =
  | 'missing-specId'
  | 'missing-spec'
  | 'missing-scope';

/**
 * Result of a contention evaluation.
 *  - `claimed`: ≥1 active worktree spec scope.in admits the path.
 *  - `clear`: no active worktree claims it.
 *  - `undetermined`: an active worktree could not be evaluated (its registry
 *    entry has no specId, the bound spec is absent from the loaded set, or the
 *    bound spec has an empty scope.in). The guard must NOT treat this as clear.
 */
export type ContentionResult =
  | { readonly status: 'claimed'; readonly claimants: readonly ContentionClaimant[] }
  | { readonly status: 'clear'; readonly claimants: readonly [] }
  | {
      readonly status: 'undetermined';
      readonly reason: ContentionUndeterminedReason;
      readonly worktreeName: string;
    };

export interface EvaluateContentionInput {
  /** Repo-root-relative path being written. */
  readonly path: string;
  /** The `.caws/worktrees.json` read model (flat map keyed by name). */
  readonly worktrees: WorktreeRegistry;
  /** Specs that parsed AND validated (composeStoreSnapshot.specs). */
  readonly specs: readonly Spec[];
  /**
   * The base branch the writing session is on. Only worktrees forked from this
   * base branch contend (they share the base-branch checkout the guard governs).
   */
  readonly currentBranch: string;
  /**
   * Optional worktree-existence predicate. The registry records a `path`; the
   * shell injects a check that the directory is materialized (the inline block
   * filtered on fs.existsSync). Omitted → treat every registry entry as present
   * (pure default for unit tests).
   */
  readonly worktreeExists?: (record: {
    readonly path: string | undefined;
    readonly name: string;
  }) => boolean;
}

/**
 * Evaluate cross-worktree scope contention for a path. Pure, deterministic,
 * no I/O. Mirrors the inline SPEC_CONTENTION_CHECK semantics exactly:
 *  - consider worktrees whose baseBranch === currentBranch and that exist,
 *  - require each to have a specId AND a loaded spec AND a non-empty scope.in
 *    (else: undetermined — the guard fails closed rather than assuming clear),
 *  - a worktree whose bound spec is not `active` is skipped (not a claimant),
 *  - a path matched by a worktree's scope.in (via the kernel matchGlob) is a
 *    claimant recording the matched pattern.
 *
 * Undetermined short-circuits on the FIRST unevaluable active worktree, matching
 * the inline block (which `process.exit`ed on the first `unknown:` case): a
 * single unverifiable worktree means contention cannot be soundly decided.
 */
export function evaluateContention(input: EvaluateContentionInput): ContentionResult {
  const { path, worktrees, specs, currentBranch } = input;
  const exists = input.worktreeExists ?? (() => true);

  const specById = new Map<string, Spec>();
  for (const s of specs) specById.set(s.id, s);

  const claimants: ContentionClaimant[] = [];

  for (const [name, record] of Object.entries(worktrees)) {
    if (record.baseBranch !== currentBranch) continue;
    if (!exists({ path: record.path, name })) continue;

    const specId = record.specId;
    if (specId === undefined || specId.length === 0) {
      return { status: 'undetermined', reason: 'missing-specId', worktreeName: name };
    }

    const spec = specById.get(specId);
    if (spec === undefined) {
      return { status: 'undetermined', reason: 'missing-spec', worktreeName: name };
    }

    // A non-active spec does not contend (its scope is not being enforced).
    if (spec.lifecycle_state !== 'active') continue;

    const scopeIn = spec.scope.in ?? [];
    if (scopeIn.length === 0) {
      return { status: 'undetermined', reason: 'missing-scope', worktreeName: name };
    }

    const matched = matchGlob(path, scopeIn);
    if (matched !== null) {
      claimants.push({ worktreeName: name, specId, matchedPattern: matched });
    }
  }

  if (claimants.length > 0) {
    return { status: 'claimed', claimants };
  }
  return { status: 'clear', claimants: [] };
}
