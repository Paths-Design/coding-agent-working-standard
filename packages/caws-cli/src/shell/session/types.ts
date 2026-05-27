// Shell session identity model.
//
// The shell resolves a session identity for the current invocation. This is
// used both for display ("which agent is doing this?") and — for governed
// writes — for authority decisions in the kernel.
//
// Source priority (pinned in the rewrite plan):
//   1. CLAUDE_SESSION_ID env
//   2. CAWS session capsule bound to this shell+worktree
//   3. CURSOR_TRACE_ID env (low-stability fallback)
//
// `agents.json last-active` is NEVER an authority source.

import type { SessionIdentity } from '@paths.design/caws-kernel';

export type SessionSource =
  | 'claude_env'
  | 'hook_env'
  | 'capsule'
  | 'cursor_env'
  | 'minted';

export interface ResolvedSession {
  /** The kernel-shaped session identity. */
  readonly identity: SessionIdentity;
  /** Where the identity came from. Influences display and audit. */
  readonly source: SessionSource;
  /**
   * For `source: 'capsule'` and `source: 'minted'`, the on-disk capsule path
   * that was read or written. Useful for diagnostics rendering.
   */
  readonly capsulePath?: string;
}

export interface SessionCapsule {
  readonly session_id: string;
  readonly platform: string;
  readonly minted_at: string;
  readonly worktree_root: string;
}

export interface ResolveSessionOptions {
  /**
   * `false` (default): read-only resolution — never mints a capsule. If no
   *   stable identity exists, returns `Err(SESSION_NO_STABLE_IDENTITY)`.
   * `true`: governed-write resolution — mints a capsule if no stable
   *   identity is found. Always returns `Ok(ResolvedSession)` on success.
   */
  readonly allowMint?: boolean;
  /**
   * Injected environment. Defaults to `process.env`. Used by tests.
   */
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Injected clock. Defaults to `() => new Date()`. Used by tests.
   */
  readonly now?: () => Date;
  /**
   * Injected platform label. Defaults to `process.platform`.
   */
  readonly platform?: string;
  /**
   * Injected `cawsDir` (the directory containing `sessions/`). Required.
   */
  readonly cawsDir: string;
  /**
   * Worktree root path the session is bound to, when minting. The capsule
   * records this so a later resolution can refuse stale capsules from
   * other worktrees.
   */
  readonly worktreeRoot: string;
  /**
   * Random-ish suffix generator for minted session ids. Defaults to a
   * crypto-backed implementation. Injected for deterministic tests.
   */
  readonly mintIdSuffix?: () => string;
}
