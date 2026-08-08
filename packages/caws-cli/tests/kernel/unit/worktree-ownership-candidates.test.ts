/**
 * Unit tests for assertOwnership candidate-set admission
 * (SESSION-CAPSULE-WORKTREE-CWD-001).
 *
 * CAWS-TEST-KERNEL-PURE-001. The kernel ownership assertion gained an optional
 * sessionCandidates input mirroring the merge/bind input shape (session actor
 * + candidate set). These tests assert the four acceptance criteria directly
 * against the pure kernel function — no filesystem, no resolver, deterministic
 * against an injected `now`.
 *
 * Coverage:
 *   A3  owner admitted via sessionCandidates => Ok(null), no takeover patch.
 *   A4  sessionCandidates absent/empty => byte-for-byte prior behavior
 *       (sameSession against the single `session` only).
 *   NEG candidates that do NOT contain the owner => still refused without
 *       --takeover (no spurious admission; no cross-agent aliasing).
 *   NEG a foreign owner is still refused even when candidates are populated,
 *       and --takeover still yields the takeover_claim patch + prior_owners.
 */

import { assertOwnership } from '../../../src/kernel/worktree/ownership';
import { WORKTREE_RULES } from '../../../src/kernel/worktree/rules';
import { isOk, isErr } from '../../../src/kernel/result/construct';
import type {
  SessionIdentity,
  WorktreeRegistry,
} from '../../../src/kernel/worktree/types';

const NOW = new Date('2026-07-30T12:00:00Z');

const OWNER: SessionIdentity = { session_id: 'caws-owner', platform: 'zcode' };
const OTHER_AGENT: SessionIdentity = { session_id: 'caws-other', platform: 'zcode' };
const FRESH_MINT: SessionIdentity = { session_id: 'caws-freshmint', platform: 'none' };

function registryWithOwner(owner: SessionIdentity): WorktreeRegistry {
  return {
    'wt-demo': {
      name: 'wt-demo',
      branch: 'wt-demo',
      baseBranch: 'main',
      specId: 'SPECC',
      path: '/repo/.caws/worktrees/wt-demo',
      owner,
      last_heartbeat: '2026-07-30T11:30:00Z',
    },
  } as unknown as WorktreeRegistry;
}

describe('SESSION-CAPSULE-WORKTREE-CWD-001 — assertOwnership candidate admission', () => {
  test('A3: owner admitted via sessionCandidates => Ok(null), no patch', () => {
    // The create-then-enter scenario: the recorded owner was minted from the
    // repo root; this claim resolves to a FRESH mint (different cwd), so the
    // direct sameSession check fails. The candidate set — the cwd-independent
    // resolution — contains the owner, so same-session is satisfied.
    const reg = registryWithOwner(OWNER);
    const result = assertOwnership(reg, 'wt-demo', FRESH_MINT, {
      sessionCandidates: [FRESH_MINT, OWNER],
    }, NOW);

    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value).toBeNull();
    }
  });

  test('A3: a single matching candidate (not the actor) still admits', () => {
    // The candidate set need not contain the actor at all — only the owner.
    // This is the cwd-independent capsule read: the owner's capsule is found
    // even though the actor resolved to a different id.
    const reg = registryWithOwner(OWNER);
    const result = assertOwnership(reg, 'wt-demo', FRESH_MINT, {
      sessionCandidates: [OTHER_AGENT, OWNER],
    }, NOW);

    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(result.value).toBeNull();
  });

  test('A4: sessionCandidates absent => prior behavior (sameSession only)', () => {
    // Without candidates, a fresh-mint actor against a recorded owner is a
    // foreign-owner refusal — exactly the pre-fix behavior. Back-compat.
    const reg = registryWithOwner(OWNER);
    const result = assertOwnership(reg, 'wt-demo', FRESH_MINT, {}, NOW);

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.errors[0]?.rule).toBe(WORKTREE_RULES.OWNERSHIP_FOREIGN_OWNER_BLOCKED);
    }
  });

  test('A4: sessionCandidates empty array => prior behavior', () => {
    const reg = registryWithOwner(OWNER);
    const result = assertOwnership(reg, 'wt-demo', FRESH_MINT, {
      sessionCandidates: [],
    }, NOW);

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.errors[0]?.rule).toBe(WORKTREE_RULES.OWNERSHIP_FOREIGN_OWNER_BLOCKED);
    }
  });

  test('NEG: candidates without the owner => still refused (no cross-agent aliasing)', () => {
    // A genuine foreign agent's capsule set must NOT admit this owner. This is
    // the safety property: the candidate set is trusted because the resolver's
    // tier-2.5 corroboration gate only admits this process's own identities.
    const reg = registryWithOwner(OWNER);
    const result = assertOwnership(reg, 'wt-demo', FRESH_MINT, {
      sessionCandidates: [OTHER_AGENT, FRESH_MINT],
    }, NOW);

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.errors[0]?.rule).toBe(WORKTREE_RULES.OWNERSHIP_FOREIGN_OWNER_BLOCKED);
    }
  });

  test('NEG: foreign owner + candidates + --takeover => takeover patch + prior_owners', () => {
    // Takeover still works and still audits when authorized, even with the
    // candidate set populated and not admitting the owner.
    const reg = registryWithOwner(OWNER);
    const result = assertOwnership(reg, 'wt-demo', FRESH_MINT, {
      takeover: true,
      sessionCandidates: [FRESH_MINT],
    }, NOW);

    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      const patch = result.value;
      expect(patch).not.toBeNull();
      expect(patch?.kind).toBe('takeover_claim');
      expect(patch?.prior_owner.session_id).toBe('caws-owner');
      expect(patch?.owner.session_id).toBe('caws-freshmint');
    }
  });

  test('owner still admitted when the actor IS the owner directly (unchanged path)', () => {
    // The direct sameSession check remains the first admission path; candidates
    // are an additional, not a replacement, path.
    const reg = registryWithOwner(OWNER);
    const result = assertOwnership(reg, 'wt-demo', OWNER, {}, NOW);

    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(result.value).toBeNull();
  });
});
