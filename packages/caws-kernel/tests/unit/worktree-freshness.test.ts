import { heartbeatAge, isStaleByTTL, refreshAgentClaim } from '../../src/worktree';
import type { AgentRecord, AgentRegistry } from '../../src/worktree';
import { isOk } from '../../src/result';

const NOW = new Date('2026-05-09T12:00:00.000Z');

describe('refreshAgentClaim', () => {
  it('builds a refresh_agent patch with the injected now', () => {
    const r = refreshAgentClaim({}, { session_id: 'sess-1', platform: 'cli' }, NOW);
    expect(isOk(r)).toBe(true);
    if (isOk(r) && r.value.kind === 'refresh_agent') {
      expect(r.value.session.session_id).toBe('sess-1');
      expect(r.value.last_active).toBe(NOW.toISOString());
    }
  });

  it('includes bound_worktree and bound_spec_id when provided', () => {
    const r = refreshAgentClaim(
      {},
      { session_id: 'sess-1' },
      NOW,
      { bound_worktree: 'wt-foo', bound_spec_id: 'FOO-1' }
    );
    if (isOk(r) && r.value.kind === 'refresh_agent') {
      expect(r.value.bound_worktree).toBe('wt-foo');
      expect(r.value.bound_spec_id).toBe('FOO-1');
    }
  });

  it('omits bound fields when not provided', () => {
    const r = refreshAgentClaim({}, { session_id: 'sess-1' }, NOW);
    if (isOk(r) && r.value.kind === 'refresh_agent') {
      expect(r.value.bound_worktree).toBeUndefined();
      expect(r.value.bound_spec_id).toBeUndefined();
    }
  });

  it('produces a deterministic patch given identical inputs', () => {
    const a = refreshAgentClaim({}, { session_id: 'sess-1' }, NOW);
    const b = refreshAgentClaim({}, { session_id: 'sess-1' }, NOW);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('does not mutate the input agents registry', () => {
    const agents: AgentRegistry = {};
    refreshAgentClaim(agents, { session_id: 'sess-1' }, NOW);
    expect(Object.keys(agents)).toEqual([]);
  });
});

describe('heartbeatAge', () => {
  function rec(last_active: string): AgentRecord {
    return { session_id: 'sess-1', last_active };
  }

  it('returns 0 when last_active is now', () => {
    expect(heartbeatAge(rec(NOW.toISOString()), NOW)).toBe(0);
  });

  it('returns positive ms when last_active is in the past', () => {
    const ago = new Date(NOW.getTime() - 60_000).toISOString();
    expect(heartbeatAge(rec(ago), NOW)).toBe(60_000);
  });

  it('returns Infinity when last_active is unparseable', () => {
    expect(heartbeatAge(rec('not-a-date'), NOW)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('isStaleByTTL', () => {
  function rec(ageMs: number): AgentRecord {
    return {
      session_id: 'sess-1',
      last_active: new Date(NOW.getTime() - ageMs).toISOString(),
    };
  }

  it('false when age <= TTL', () => {
    expect(isStaleByTTL(rec(60_000), 120_000, NOW)).toBe(false);
  });

  it('true when age > TTL', () => {
    expect(isStaleByTTL(rec(120_001), 120_000, NOW)).toBe(true);
  });

  it('is display/hygiene only — does NOT make takeover authority', () => {
    // This is a contract reminder, not a behavioral test. The fact that
    // a record is stale here must not be consulted by ownership.ts.
    // The corresponding behavioral assertion lives in worktree-ownership.test.ts.
    expect(isStaleByTTL(rec(1_000_000), 1, NOW)).toBe(true);
  });
});
