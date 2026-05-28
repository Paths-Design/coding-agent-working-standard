// Types for cwd → worktree binding resolution.
//
// The shell turns a `(repoRoot, cwd, worktreesRegistry, specs)` tuple into
// one of three terminal states:
//
//   - `bound`:      cwd is inside a worktree that is bidirectionally bound
//                   to a spec (registry.specId === spec.worktree === name).
//   - `one_sided`:  cwd is inside a worktree whose binding is partial. The
//                   shell reports this verbatim from the kernel; it is NOT
//                   authority.
//   - `unbound`:    cwd is not inside a CAWS-tracked worktree (or is inside
//                   the main checkout). Hooks treat this as no-authority
//                   for write-class operations.
//
// The shell never derives worktree name from `basename(cwd)`. Authority
// flows from the registry's recorded `path` field (or a git-worktree
// porcelain lookup as a deterministic fallback), never from the
// filesystem layout alone.

import type {
  BindingState,
  Spec,
  WorktreeRegistry,
} from '@paths.design/caws-kernel';

export interface ResolveBindingInput {
  /** Repo root (from store/repo-root.ts, --git-common-dir based). */
  readonly repoRoot: string;
  /** Current working directory the command was invoked from. */
  readonly cwd: string;
  /** Loaded `.caws/worktrees.json`. */
  readonly registry: WorktreeRegistry;
  /**
   * Loaded valid specs. The resolver looks up the spec referenced by the
   * registry entry's `specId`. If the spec is missing, the binding is
   * reported as `one_sided`.
   */
  readonly specs: readonly Spec[];
  /**
   * Optional pluggable git-worktree lookup, for tests. Receives `repoRoot`
   * and returns a list of `{ name?, path }` entries OR `null` when git
   * cannot be invoked. Production injects a real git runner.
   */
  readonly gitWorktreeList?: (repoRoot: string) => readonly GitWorktreeEntry[];
  /**
   * SCOPE-CHECK-CWD-BINDING-RESOLUTION-001: the repo-root-relative path whose
   * binding is being resolved. When set and the cwd does NOT match a worktree
   * (step 1 yields no candidate), resolution falls back to (2) the path's
   * worktree-location and (3) the bound spec(s) whose `scope.in` admits this
   * path. This makes `caws scope check <path>` cwd-independent: the governing
   * binding is a property of the PATH, not of where the command ran. Omitted
   * → pre-existing cwd-only behavior.
   */
  readonly targetPath?: string;
}

export interface GitWorktreeEntry {
  /** Absolute path of the worktree on disk. */
  readonly path: string;
  /** Branch name (may be `(detached)` or `refs/heads/<x>`). */
  readonly branch?: string;
}

/**
 * SCOPE-CHECK-CWD-BINDING-RESOLUTION-001: one spec that claims a target path
 * via its `scope.in`. Carried in the `ambiguous` result so the refusal is
 * actionable — the agent can name and inspect each contender.
 */
export interface BindingClaimant {
  readonly specId: string;
  readonly worktreeName: string;
  /** The exact `scope.in` entry that matched the target path. */
  readonly matchedScopeInEntry: string;
}

/**
 * SCOPE-CHECK-CWD-BINDING-RESOLUTION-001: refuse-on-conflict detail surfaced
 * when step-(3) scope.in-claim resolution finds MORE THAN ONE active bound
 * spec claiming the same target path. Carried in a DEDICATED `ambiguous`
 * field on `ResolvedBinding` (not inside `binding`) so that consumers which
 * never pass a targetPath — e.g. `caws status`, which resolves from cwd —
 * continue to see only the kernel `BindingState` and need no narrowing. Only
 * `caws scope check/show`, which passes a targetPath, inspects `ambiguous`.
 */
export interface AmbiguousBindingDetail {
  readonly targetPath: string;
  readonly claimants: readonly BindingClaimant[];
}

export interface ResolvedBinding {
  /** The kernel's `BindingState`. For an ambiguous result this is `unbound`
   * (the safe default for non-scope-check consumers); inspect `ambiguous`. */
  readonly binding: BindingState;
  /**
   * Refuse-on-conflict detail. Present ONLY when step-(3) resolution found
   * >1 claimant for the target path. When set, `binding` is `unbound` and
   * `worktreeName` is undefined — no single owner was selected, by design.
   * `caws scope check` keys its ambiguous-binding refusal off this field.
   */
  readonly ambiguous?: AmbiguousBindingDetail;
  /**
   * The resolved worktree name, if any. `undefined` when cwd is in the main
   * checkout with no resolvable target-path binding, or when ambiguous.
   */
  readonly worktreeName?: string;
  /**
   * Where the worktree-name resolution came from. Helps explain `bound`
   * vs `one_sided` decisions to the user.
   *   - target_worktree_location: step (2), path under .caws/worktrees/<name>/
   *   - target_scope_in_claim:    step (3), a bound spec's scope.in admits path
   */
  readonly source:
    | 'registry_path_match'
    | 'git_porcelain_match'
    | 'target_worktree_location'
    | 'target_scope_in_claim'
    | 'none';
}
