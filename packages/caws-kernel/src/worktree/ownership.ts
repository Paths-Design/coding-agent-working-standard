// Ownership claim assertion and takeover audit.
//
// Authority discipline:
//   - The owner of `worktrees.json[name]` is THE source of truth.
//   - `agents.json` last_active is freshness/display only; it never
//     authorizes a takeover, even when stale.
//   - Same-session ownership: assertOwnership returns Ok with no patch.
//   - Foreign-session ownership: assertOwnership returns Err unless
//     `opts.takeover === true`; with the flag it returns the takeover patch.
//   - Takeover ALWAYS appends to `prior_owners`. The kernel never truncates.

import { diagnostic } from '../diagnostics/construct';
import type { Diagnostic } from '../diagnostics/types';
import { err, ok } from '../result/construct';
import type { Result } from '../result/types';
import { sameSession, validateSessionIdentity, validateWorktreeName } from './identity';
import { WORKTREE_RULES } from './rules';
import type { PriorOwner, RegistryPatch, SessionIdentity, WorktreeRegistry } from './types';

// ----------------------------------------------------------------------------
// assertOwnership
// ----------------------------------------------------------------------------

export interface AssertOwnershipOptions {
  /**
   * Authority bit: when true, allow takeover of a foreign-owned worktree
   * and return the corresponding takeover_claim patch. Without it, foreign
   * ownership is a hard refusal.
   */
  readonly takeover?: boolean;
}

/**
 * Assert that `session` may operate on `worktreeName`.
 *
 * Returns:
 *   - Ok<null>           — same-session, no patch needed.
 *   - Ok<takeover patch> — foreign owner + opts.takeover === true.
 *                          Patch carries the prior owner audit record.
 *                          A WARNING diagnostic (OWNERSHIP_TAKEOVER_PERFORMED)
 *                          is attached.
 *   - Err                — foreign owner + opts.takeover not true.
 *                          Or no owner recorded (per AssertOwnership policy:
 *                          unowned is a soft block; the shell may treat it as
 *                          a fresh claim, but the kernel does not silently
 *                          mint ownership).
 */
export function assertOwnership(
  registry: WorktreeRegistry,
  worktreeName: string,
  session: SessionIdentity,
  opts: AssertOwnershipOptions,
  now: Date
): Result<RegistryPatch | null> {
  const nameRes = validateWorktreeName(worktreeName);
  if (nameRes.ok === false) return nameRes;
  const name = nameRes.value;

  const sessionRes = validateSessionIdentity(session);
  if (sessionRes.ok === false) return sessionRes;
  const me = sessionRes.value;

  const record = registry[name];
  const owner = record?.owner;

  if (!owner) {
    // No owner recorded. The kernel does NOT silently mint ownership.
    // The caller's bind/refresh path will set ownership; assertOwnership is
    // narrowly about claim conflict, so unowned is reported as such.
    return err(
      diagnostic({
        rule: WORKTREE_RULES.OWNERSHIP_NO_OWNER_RECORDED,
        authority: 'kernel/worktree',
        message: `Worktree "${name}" has no recorded owner.`,
        subject: name,
        narrowRepair: 'Bind the worktree (`caws worktree bind`) to record an owner.',
      })
    );
  }

  if (sameSession(owner, me)) {
    return ok(null);
  }

  // Foreign owner.
  if (!opts.takeover) {
    const heartbeat = record?.last_heartbeat;
    return err(
      diagnostic({
        rule: WORKTREE_RULES.OWNERSHIP_FOREIGN_OWNER_BLOCKED,
        authority: 'kernel/worktree',
        message: `Worktree "${name}" is owned by ${formatOwner(owner)}; takeover not authorized.`,
        subject: name,
        narrowRepair: `Pass { takeover: true } only with explicit user authorization. Stale heartbeat is NOT abandonment.`,
        data: {
          owner: { session_id: owner.session_id, ...(owner.platform ? { platform: owner.platform } : {}) },
          last_heartbeat: heartbeat ?? null,
          incoming_session_id: me.session_id,
        },
      })
    );
  }

  // Takeover authorized.
  const priorOwner: PriorOwner = {
    session_id: owner.session_id,
    ...(owner.platform ? { platform: owner.platform } : {}),
    ...(record?.last_heartbeat ? { last_seen: record.last_heartbeat } : {}),
    takenOver_at: now.toISOString(),
  };

  const warning: Diagnostic = diagnostic({
    rule: WORKTREE_RULES.OWNERSHIP_TAKEOVER_PERFORMED,
    authority: 'kernel/worktree',
    message: `Worktree "${name}" taken over from ${formatOwner(owner)} by ${formatOwner(me)}.`,
    subject: name,
    severity: 'warning',
    data: {
      prior_owner: priorOwner,
      new_owner: me,
    },
  });

  return ok(
    {
      kind: 'takeover_claim',
      worktree_name: name,
      owner: me,
      prior_owner: priorOwner,
      when: now.toISOString(),
    },
    [warning]
  );
}

// ----------------------------------------------------------------------------
// takeoverClaim
// ----------------------------------------------------------------------------

/**
 * Construct a takeover patch unconditionally (the caller has already
 * authorized the takeover). Useful for shells that combine bind + takeover
 * into one call. Does NOT consult the registry's same-session check; if
 * the caller passes the same session, the patch will still record a
 * takeover audit (which is almost never what a shell wants — prefer
 * `assertOwnership({ takeover: true })`).
 *
 * Validates name and session inputs. Pulls prior owner from registry; if
 * no prior owner exists, returns Err.
 */
export function takeoverClaim(
  registry: WorktreeRegistry,
  worktreeName: string,
  newSession: SessionIdentity,
  now: Date
): Result<RegistryPatch> {
  const nameRes = validateWorktreeName(worktreeName);
  if (nameRes.ok === false) return nameRes;
  const name = nameRes.value;

  const sessionRes = validateSessionIdentity(newSession);
  if (sessionRes.ok === false) return sessionRes;
  const me = sessionRes.value;

  const record = registry[name];
  const owner = record?.owner;
  if (!owner) {
    return err(
      diagnostic({
        rule: WORKTREE_RULES.OWNERSHIP_NO_OWNER_RECORDED,
        authority: 'kernel/worktree',
        message: `Worktree "${name}" has no recorded owner; takeover requires a prior owner.`,
        subject: name,
        narrowRepair: 'Use bindWorktree to establish initial ownership.',
      })
    );
  }

  const priorOwner: PriorOwner = {
    session_id: owner.session_id,
    ...(owner.platform ? { platform: owner.platform } : {}),
    ...(record.last_heartbeat ? { last_seen: record.last_heartbeat } : {}),
    takenOver_at: now.toISOString(),
  };

  return ok({
    kind: 'takeover_claim',
    worktree_name: name,
    owner: me,
    prior_owner: priorOwner,
    when: now.toISOString(),
  });
}

function formatOwner(o: SessionIdentity): string {
  return o.platform ? `${o.session_id}:${o.platform}` : o.session_id;
}
