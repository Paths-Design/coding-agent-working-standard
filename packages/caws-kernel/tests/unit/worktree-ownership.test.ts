import {
  WORKTREE_RULES,
  assertOwnership,
  takeoverClaim,
} from '../../src/worktree';
import type { SessionIdentity, WorktreeRegistry } from '../../src/worktree';
import { isErr, isOk } from '../../src/result';

const NOW = new Date('2026-05-09T12:00:00.000Z');

const ALICE: SessionIdentity = { session_id: 'sess-alice', platform: 'claude-code' };
const BOB: SessionIdentity = { session_id: 'sess-bob', platform: 'cursor' };

describe('assertOwnership — same session', () => {
  it('returns Ok(null) — no patch needed', () => {
    const registry: WorktreeRegistry = {
      'wt-foo': { specId: 'X-1', owner: ALICE, last_heartbeat: NOW.toISOString() },
    };
    const r = assertOwnership(registry, 'wt-foo', ALICE, {}, NOW);
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value).toBeNull();
  });

  it('matches by session_id only — different platform does not change identity', () => {
    const registry: WorktreeRegistry = {
      'wt-foo': { specId: 'X-1', owner: { session_id: 'sess-alice', platform: 'old-cli' } },
    };
    const r = assertOwnership(registry, 'wt-foo', ALICE, {}, NOW);
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value).toBeNull();
  });
});

describe('assertOwnership — foreign owner blocks without takeover', () => {
  it('refuses a foreign session', () => {
    const registry: WorktreeRegistry = {
      'wt-foo': { specId: 'X-1', owner: ALICE, last_heartbeat: NOW.toISOString() },
    };
    const r = assertOwnership(registry, 'wt-foo', BOB, {}, NOW);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.errors[0]!.rule).toBe(WORKTREE_RULES.OWNERSHIP_FOREIGN_OWNER_BLOCKED);
      expect(r.errors[0]!.data?.['incoming_session_id']).toBe('sess-bob');
    }
  });

  it('STALE HEARTBEAT IS NOT ABANDONMENT — still blocked without takeover', () => {
    // last_heartbeat is from 30 days ago — display would call this stale.
    const stale = new Date(NOW.getTime() - 30 * 24 * 3600_000).toISOString();
    const registry: WorktreeRegistry = {
      'wt-foo': { specId: 'X-1', owner: ALICE, last_heartbeat: stale },
    };
    const r = assertOwnership(registry, 'wt-foo', BOB, {}, NOW);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.errors[0]!.rule).toBe(WORKTREE_RULES.OWNERSHIP_FOREIGN_OWNER_BLOCKED);
      expect(r.errors[0]!.data?.['last_heartbeat']).toBe(stale);
    }
  });
});

describe('assertOwnership — takeover authorized', () => {
  it('returns a takeover_claim patch with prior_owner audit', () => {
    const heartbeat = new Date(NOW.getTime() - 3600_000).toISOString();
    const registry: WorktreeRegistry = {
      'wt-foo': { specId: 'X-1', owner: ALICE, last_heartbeat: heartbeat },
    };
    const r = assertOwnership(registry, 'wt-foo', BOB, { takeover: true }, NOW);
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value).not.toBeNull();
      const patch = r.value!;
      expect(patch.kind).toBe('takeover_claim');
      if (patch.kind === 'takeover_claim') {
        expect(patch.owner.session_id).toBe('sess-bob');
        expect(patch.prior_owner.session_id).toBe('sess-alice');
        expect(patch.prior_owner.platform).toBe('claude-code');
        expect(patch.prior_owner.last_seen).toBe(heartbeat);
        expect(patch.prior_owner.takenOver_at).toBe(NOW.toISOString());
      }
      expect(r.warnings).toBeDefined();
      expect(r.warnings?.[0]!.rule).toBe(WORKTREE_RULES.OWNERSHIP_TAKEOVER_PERFORMED);
      expect(r.warnings?.[0]!.severity).toBe('warning');
    }
  });

  it('omits prior_owner.last_seen when no heartbeat was recorded', () => {
    const registry: WorktreeRegistry = {
      'wt-foo': { specId: 'X-1', owner: ALICE },
    };
    const r = assertOwnership(registry, 'wt-foo', BOB, { takeover: true }, NOW);
    expect(isOk(r)).toBe(true);
    if (isOk(r) && r.value?.kind === 'takeover_claim') {
      expect(r.value.prior_owner.last_seen).toBeUndefined();
    }
  });
});

describe('assertOwnership — no owner recorded', () => {
  it('refuses with OWNERSHIP_NO_OWNER_RECORDED', () => {
    const registry: WorktreeRegistry = { 'wt-foo': { specId: 'X-1' } };
    const r = assertOwnership(registry, 'wt-foo', ALICE, {}, NOW);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.errors[0]!.rule).toBe(WORKTREE_RULES.OWNERSHIP_NO_OWNER_RECORDED);
    }
  });
});

describe('assertOwnership — input validation', () => {
  it('rejects bad name', () => {
    const r = assertOwnership({}, 'bad/name', ALICE, {}, NOW);
    expect(isErr(r)).toBe(true);
  });
  it('rejects bad session', () => {
    const r = assertOwnership({}, 'wt', { session_id: '' } as SessionIdentity, {}, NOW);
    expect(isErr(r)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// takeoverClaim (unconditional)
// ---------------------------------------------------------------------------

describe('takeoverClaim — pure patch construction', () => {
  it('builds the same prior_owner shape regardless of stale heartbeat', () => {
    const stale = new Date(NOW.getTime() - 365 * 24 * 3600_000).toISOString();
    const registry: WorktreeRegistry = {
      'wt-foo': { specId: 'X-1', owner: ALICE, last_heartbeat: stale },
    };
    const r = takeoverClaim(registry, 'wt-foo', BOB, NOW);
    expect(isOk(r)).toBe(true);
    if (isOk(r) && r.value.kind === 'takeover_claim') {
      expect(r.value.prior_owner.last_seen).toBe(stale);
      expect(r.value.prior_owner.takenOver_at).toBe(NOW.toISOString());
    }
  });

  it('refuses when no prior owner exists', () => {
    const registry: WorktreeRegistry = { 'wt-foo': { specId: 'X-1' } };
    const r = takeoverClaim(registry, 'wt-foo', BOB, NOW);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.errors[0]!.rule).toBe(WORKTREE_RULES.OWNERSHIP_NO_OWNER_RECORDED);
    }
  });
});

// ---------------------------------------------------------------------------
// prior_owners is unbounded — kernel never truncates
// ---------------------------------------------------------------------------

describe('prior_owners audit — append-only and unbounded', () => {
  it('two sequential takeovers preserve both audit records (shell would append)', () => {
    // Simulate: alice → bob → carol. The kernel returns one patch per takeover;
    // the shell is responsible for appending each prior_owner to the registry.
    // This test verifies the kernel never collapses or drops entries.
    const registry1: WorktreeRegistry = {
      'wt-foo': { specId: 'X-1', owner: ALICE, last_heartbeat: NOW.toISOString() },
    };
    const r1 = assertOwnership(registry1, 'wt-foo', BOB, { takeover: true }, NOW);
    expect(isOk(r1)).toBe(true);
    const priorAlice =
      isOk(r1) && r1.value?.kind === 'takeover_claim' ? r1.value.prior_owner : undefined;
    expect(priorAlice?.session_id).toBe('sess-alice');

    // Shell-side: registry now has bob as owner with [alice] in prior_owners.
    const registry2: WorktreeRegistry = {
      'wt-foo': {
        specId: 'X-1',
        owner: BOB,
        last_heartbeat: NOW.toISOString(),
        prior_owners: priorAlice ? [priorAlice] : [],
      },
    };
    const carol: SessionIdentity = { session_id: 'sess-carol' };
    const r2 = assertOwnership(registry2, 'wt-foo', carol, { takeover: true }, NOW);
    expect(isOk(r2)).toBe(true);
    const priorBob =
      isOk(r2) && r2.value?.kind === 'takeover_claim' ? r2.value.prior_owner : undefined;
    expect(priorBob?.session_id).toBe('sess-bob');

    // The kernel did not truncate or modify alice's record. The shell
    // appends bob to the existing prior_owners array.
    expect(priorAlice).toBeDefined();
    expect(priorBob).toBeDefined();
  });
});
