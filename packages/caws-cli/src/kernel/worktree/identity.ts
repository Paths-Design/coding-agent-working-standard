// Identity validators.
//
// Worktree names and session ids are authority keys. The kernel validates
// them at the point they enter the system (every public function that
// accepts one), not at JSON-schema load time.

import { diagnostic } from '../diagnostics/construct';
import type { Diagnostic } from '../diagnostics/types';
import { err, ok } from '../result/construct';
import type { Result } from '../result/types';
import { WORKTREE_RULES } from './rules';
import type { SessionIdentity } from './types';

/**
 * Worktree name regex.
 *
 * Mirrors the legacy regex (`/^[a-zA-Z0-9_-]+$/`) verbatim. This is the
 * shape `git worktree add caws/<name>` accepts as a branch suffix, the
 * shape `caws/worktrees/<name>` survives on macOS and Linux filesystems,
 * and the shape that round-trips through CLI arg parsing without quoting.
 */
export const WORKTREE_NAME_REGEX = /^[a-zA-Z0-9_-]+$/;

/**
 * Validate a worktree name.
 *
 * Pure: takes a candidate, returns a Result. Empty, whitespace-only, or
 * special-character names are rejected with a precise diagnostic.
 */
export function validateWorktreeName(name: unknown): Result<string> {
  if (typeof name !== 'string' || name.length === 0) {
    return err(
      diagnostic({
        rule: WORKTREE_RULES.IDENTITY_NAME_INVALID,
        authority: 'kernel/worktree',
        message: 'Worktree name must be a non-empty string.',
        narrowRepair: 'Pass a worktree name matching /^[a-zA-Z0-9_-]+$/.',
      })
    );
  }
  if (!WORKTREE_NAME_REGEX.test(name)) {
    return err(
      diagnostic({
        rule: WORKTREE_RULES.IDENTITY_NAME_INVALID,
        authority: 'kernel/worktree',
        message: `Worktree name "${name}" does not match the required shape.`,
        subject: name,
        narrowRepair: 'Use only letters, digits, underscores, and hyphens.',
      })
    );
  }
  return ok(name);
}

/**
 * Validate a SessionIdentity.
 *
 * - `session_id`: required, non-empty after trim.
 * - `platform`: optional, but when present must be non-empty after trim.
 *
 * Returns the normalized identity (trimmed `session_id`, trimmed `platform`
 * when present) on success.
 */
export function validateSessionIdentity(value: unknown): Result<SessionIdentity> {
  if (typeof value !== 'object' || value === null) {
    return err(
      diagnostic({
        rule: WORKTREE_RULES.IDENTITY_SESSION_ID_EMPTY,
        authority: 'kernel/worktree',
        message: 'Session identity must be an object with a session_id.',
        narrowRepair: 'Pass { session_id: <string> } and optionally { platform: <string> }.',
      })
    );
  }

  const obj = value as Record<string, unknown>;
  const rawSessionId = obj['session_id'];

  if (typeof rawSessionId !== 'string' || rawSessionId.trim().length === 0) {
    return err(
      diagnostic({
        rule: WORKTREE_RULES.IDENTITY_SESSION_ID_EMPTY,
        authority: 'kernel/worktree',
        message: 'session_id is required and must be a non-empty string.',
        narrowRepair: 'Provide a non-empty session_id.',
      })
    );
  }

  const session_id = rawSessionId.trim();
  const errors: Diagnostic[] = [];

  // Platform is optional; reject empty string when present.
  let platform: string | undefined;
  if ('platform' in obj && obj['platform'] !== undefined) {
    const rawPlatform = obj['platform'];
    if (typeof rawPlatform !== 'string' || rawPlatform.trim().length === 0) {
      errors.push(
        diagnostic({
          rule: WORKTREE_RULES.IDENTITY_SESSION_PLATFORM_EMPTY,
          authority: 'kernel/worktree',
          message: 'platform must be a non-empty string when set.',
          narrowRepair: 'Either omit platform or provide a non-empty value.',
        })
      );
    } else {
      platform = rawPlatform.trim();
    }
  }

  if (errors.length > 0) return err(errors);

  return ok(platform === undefined ? { session_id } : { session_id, platform });
}

/**
 * Pure equality on SessionIdentity (authority comparison key only).
 *
 * Ownership decisions consult `session_id` only. `platform` is display.
 */
export function sameSession(a: SessionIdentity, b: SessionIdentity): boolean {
  return a.session_id === b.session_id;
}
