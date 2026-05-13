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
}

export interface GitWorktreeEntry {
  /** Absolute path of the worktree on disk. */
  readonly path: string;
  /** Branch name (may be `(detached)` or `refs/heads/<x>`). */
  readonly branch?: string;
}

export interface ResolvedBinding {
  /** The kernel's `BindingState`. */
  readonly binding: BindingState;
  /**
   * The resolved worktree name, if any. `undefined` when cwd is in the main
   * checkout (no worktree).
   */
  readonly worktreeName?: string;
  /**
   * Where the worktree-name resolution came from. Helps explain `bound`
   * vs `one_sided` decisions to the user.
   */
  readonly source: 'registry_path_match' | 'git_porcelain_match' | 'none';
}
