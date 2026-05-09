// Determinism + namespace-contract integration for the worktree kernel.
//
// The kernel must produce byte-identical patches for byte-identical inputs.
// Time MUST be injected, never read from Date.now().

import {
  WORKTREE_RULES,
  WORKTREE_RULE_PREFIXES,
  assertOwnership,
  bindWorktree,
  refreshAgentClaim,
  takeoverClaim,
} from '../../src/worktree';
import type { SessionIdentity, WorktreeRegistry } from '../../src/worktree';
import type { Spec } from '../../src/spec/types';
import { isOk } from '../../src/result';

const NOW = new Date('2026-05-09T00:00:00.000Z');
const ALICE: SessionIdentity = { session_id: 'sess-alice', platform: 'claude-code' };
const BOB: SessionIdentity = { session_id: 'sess-bob', platform: 'cursor' };

function makeSpec(): Spec {
  return {
    id: 'TEST-1',
    title: 'Test spec',
    risk_tier: 3,
    mode: 'feature',
    lifecycle_state: 'active',
    blast_radius: { modules: ['src/test'] },
    scope: { in: ['src/**'] },
    invariants: ['none'],
    acceptance: [{ id: 'A1', given: 'g', when: 'w', then: 't' }],
    non_functional: {},
    contracts: [],
  };
}

describe('worktree kernel — determinism (injected time only)', () => {
  it('bindWorktree produces byte-equal JSON for identical inputs', () => {
    const a = bindWorktree(makeSpec(), {}, 'wt-foo', ALICE, {}, NOW);
    const b = bindWorktree(makeSpec(), {}, 'wt-foo', ALICE, {}, NOW);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('assertOwnership takeover patch is byte-equal for identical now', () => {
    const registry: WorktreeRegistry = {
      'wt-foo': { specId: 'X-1', owner: ALICE, last_heartbeat: NOW.toISOString() },
    };
    const a = assertOwnership(registry, 'wt-foo', BOB, { takeover: true }, NOW);
    const b = assertOwnership(registry, 'wt-foo', BOB, { takeover: true }, NOW);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('takeoverClaim is byte-equal for identical inputs', () => {
    const registry: WorktreeRegistry = {
      'wt-foo': { specId: 'X-1', owner: ALICE, last_heartbeat: NOW.toISOString() },
    };
    const a = takeoverClaim(registry, 'wt-foo', BOB, NOW);
    const b = takeoverClaim(registry, 'wt-foo', BOB, NOW);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('refreshAgentClaim is byte-equal for identical now', () => {
    const a = refreshAgentClaim({}, ALICE, NOW);
    const b = refreshAgentClaim({}, ALICE, NOW);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('different `now` values produce different patches', () => {
    const a = bindWorktree(makeSpec(), {}, 'wt-foo', ALICE, {}, NOW);
    const b = bindWorktree(makeSpec(), {}, 'wt-foo', ALICE, {}, new Date(NOW.getTime() + 1));
    if (isOk(a) && isOk(b) && a.value.kind === 'bind_worktree' && b.value.kind === 'bind_worktree') {
      expect(a.value.when).not.toBe(b.value.when);
    } else {
      throw new Error('expected both to be Ok');
    }
  });
});

describe('worktree kernel — public namespace contract', () => {
  it('every WORKTREE_RULES value falls under one of the published prefixes', () => {
    for (const value of Object.values(WORKTREE_RULES)) {
      expect(WORKTREE_RULE_PREFIXES.some((p) => value.startsWith(p))).toBe(true);
    }
  });

  it('rule constants are stable strings (no symbols, no objects)', () => {
    for (const [, value] of Object.entries(WORKTREE_RULES)) {
      expect(typeof value).toBe('string');
      expect(value.length).toBeGreaterThan(0);
    }
  });
});
