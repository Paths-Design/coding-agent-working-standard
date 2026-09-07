// Shell session identity model.
//
// The shell resolves a session identity for the current invocation. This is
// used both for display ("which agent is doing this?") and — for governed
// writes — for authority decisions in the kernel.
//
// Source priority (see resolve-session.ts for the authoritative chain):
//   1.   CLAUDE_SESSION_ID env (operator override)
//   1.5. CLAUDE_CODE_SESSION_ID env (Claude Code harness UUID; survives the
//        tool boundary into agent-Bash — CAWS-SESSION-ID-AGENT-BASH-
//        PROPAGATION-001)
//   1.6. CODEX_THREAD_ID env (Codex harness thread id; survives the tool
//        boundary — CAWS-SESSION-RESOLVER-GUARD-DIVERGENCE-001 A1)
//   1.7. CAWS_SESSION_ID env (generic escape hatch for any harness; same slice)
//   2.   HOOK_SESSION_ID env (hook envelope; does not propagate to agent-Bash)
//   2.5. durable hook envelope on disk
//   3.   CAWS session capsule bound to this shell+worktree
//   4.   CURSOR_TRACE_ID env (low-stability fallback)
//   5.   minted capsule (write-class only)
//
// `agents.json last-active` is NEVER an authority source.

import type { SessionIdentity } from '../../kernel';

export type SessionSource =
  | 'surface_pinned_env'
  | 'claude_env'
  | 'claude_code_env'
  | 'codex_thread_env'
  | 'dsh_env'
  | 'caws_env'
  | 'hook_env'
  | 'agent_pid_record'
  | 'durable_hook_envelope'
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
  /**
   * For `source: 'durable_hook_envelope'`, the on-disk envelope file path
   * that produced the identity. CAWS-SESSION-ID-DURABLE-HOOK-ENVELOPE-001.
   */
  readonly envelopePath?: string;
}

/**
 * CAWS-SESSION-ID-DURABLE-HOOK-ENVELOPE-001: durable hook-session
 * envelope written by hook scripts to bridge HOOK_SESSION_ID across
 * process boundaries (e.g., agent-issued Bash tool calls where the
 * env var doesn't propagate). One envelope file per session, written
 * at `<repo_root>/.caws/sessions/<session_id>/.session-envelope.json`
 * (CAWS-SESSION-LOG-RELOCATE-001; the legacy
 * `<repo_root>/tmp/<session_id>/` path is read as a bounded transition
 * fallback). Refreshed on every hook fire so long-lived sessions stay
 * within the freshness window.
 */
export interface DurableHookEnvelope {
  readonly session_id: string;
  readonly repo_root: string;
  readonly created_at: string;
  readonly last_seen_at: string;
  readonly hook_event: string;
  /**
   * Surface identity written by parse-input.sh
   * (CAWS-RESOLVER-PLATFORM-FROM-ENVELOPE-001). Optional: absent on envelopes
   * written by older parse-input.sh; readers fall back to 'claude-code'.
   */
  readonly platform?: string;
}

export interface SessionCapsule {
  readonly session_id: string;
  readonly platform: string;
  readonly minted_at: string;
  readonly worktree_root: string;
}

/**
 * One candidate identity returned by resolveSessionCandidates.
 *
 * Tagged with the source that produced it so the caller can render
 * a diagnostic trace ("we admitted because env source X matched
 * registry owner Y").
 */
export interface SessionCandidate {
  readonly identity: SessionIdentity;
  readonly source: SessionSource;
  /** Capsule on-disk path when source is 'capsule'; undefined for env sources. */
  readonly capsulePath?: string;
  /**
   * Durable-envelope on-disk path when source is 'durable_hook_envelope';
   * undefined for all other sources. CAWS-WORKTREE-DESTROY-GHOST-ENTRY-
   * OWNER-UNRESOLVABLE-001 — lets a refusal diagnostic point at the exact
   * envelope file the candidate came from.
   */
  readonly envelopePath?: string;
}

/**
 * Ownership comparison uses resolveCallerSession's precedence and NEVER
 * mints. All admitted records name that same invoking caller. Cached records
 * can corroborate an already resolved caller but cannot introduce identities.
 * A singleton capsule, a fresh envelope, a caller pointer and cwd ownership
 * are not proof that the process speaks for their recorded session.
 *
 * resolveCallerSession is also the author resolver for worktree lifecycle
 * and claim commands, so comparison and attribution agree. resolveSession
 * retains legacy cached attribution for other consumers; it must not be used
 * to admit a caller to somebody else's ownership.
 */
export interface SessionCandidates {
  /** Ordered candidates. Empty when no source resolved an identity. */
  readonly candidates: ReadonlyArray<SessionCandidate>;
  /**
   * Diagnostic-grade record of every source consulted and what it
   * returned. Renderers should surface this when admission fails so the
   * user can see EXACTLY which sources were tried and why none matched.
   * The trace exists to satisfy the spec's non_functional.reliability
   * invariant against silent fallbacks.
   */
  readonly trace: ReadonlyArray<CandidateTraceEntry>;
}

export interface CandidateTraceEntry {
  readonly source: SessionSource;
  /**
   *   - 'admitted': the source produced one or more identities (counted
   *     individually in `candidates`).
   *   - 'absent': the source was consulted but produced nothing
   *     (env var unset, capsule directory empty, etc.).
   *   - 'rejected': the source produced raw data that was refused for a
   *     specific reason (e.g. HOOK_SESSION_ID = 'unknown', malformed
   *     capsule file). The `reason` field is populated.
   *   - 'race': a capsule that existed at directory-listing time was
   *     gone by the time we tried to read it (concurrent removal,
   *     e.g. another process's `cleanupSupersededCapsules` mid-mint).
   *     Reported distinctly from 'rejected' because the file was not
   *     malformed, just absent at read time — operators should not
   *     debug it as a content problem.
   */
  readonly outcome: 'admitted' | 'absent' | 'rejected' | 'race';
  readonly reason?: string;
  /** Number of identities admitted from this source (0 unless outcome === 'admitted'). */
  readonly count?: number;
  /**
   * For `outcome: 'admitted'`, the session_ids that were admitted from
   * this source. Used by `describeCandidateTrace` to render the
   * candidate IDs in refusal diagnostics so an operator can see EXACTLY
   * which identities were considered against the registered owner.
   * Truncated to a manageable display form by the renderer; the raw
   * IDs are preserved here for callers that want to log or inspect them.
   */
  readonly admittedIds?: ReadonlyArray<string>;
}

export interface ResolveCandidatesOptions extends Pick<ResolveSessionOptions, 'agentProcessNames' | 'agentPidWalkFn'> {
  /** Reuse the caller already resolved for this invocation's actor. Prevents
   * a second PID-record read from changing identity between audit and admission. */
  readonly caller?: ResolvedSession;
  /** Injected environment. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** Injected `cawsDir` (the directory containing `sessions/`). Required. */
  readonly cawsDir: string;
  /**
   * Injected clock. Defaults to `() => new Date()`. Consumed by the
   * durable-hook-envelope source to apply the same last_seen_at freshness
   * window resolveSession uses (CAWS-WORKTREE-DESTROY-GHOST-ENTRY-OWNER-
   * UNRESOLVABLE-001). Tests inject a fixed clock to make envelope
   * freshness deterministic.
   */
  readonly now?: () => Date;
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
  /**
   * CAWS-AGENT-PID-SESSION-CORRELATION-001: override the per-surface process
   * names used by the agent-PID tier (defaults to parsing
   * CAWS_AGENT_PROCESS_NAMES from env). Injected for deterministic tests so
   * the PID-walk need not run against a real process tree.
   */
  readonly agentProcessNames?: readonly string[];
  /**
   * CAWS-AGENT-PID-SESSION-CORRELATION-001: override the PID-walk used by the
   * agent-PID tier. Returns the located agent PID + its start time, or null.
   * Injected for deterministic tests (the default walks `ps`).
   */
  readonly agentPidWalkFn?: (names: readonly string[]) => { pid: number; startEpoch: number | null } | null;
}
