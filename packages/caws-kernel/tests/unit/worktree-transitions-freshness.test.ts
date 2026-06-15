/**
 * Unit tests for worktree transitions + freshness (A3).
 *
 * CAWS-TEST-KERNEL-PURE-001. Two pure modules:
 *   - transitions.canTransitionSpecWithWorktree: the lifecycle-vs-active-binding
 *     gate. merge_finalize is the ONLY transition allowed while a worktree is
 *     bound; close/archive/delete are blocked by an active binding (E15 — stale
 *     registry after merge is what the merge_finalize path prevents).
 *   - freshness.isStaleByTTL / heartbeatAge: display-only predicates. The
 *     doctrine (E11/E19) is asserted as a VALUE: these compute staleness for
 *     display; they are deterministic against an injected `now` and never
 *     authorize anything.
 *
 * `now` is injected, so every freshness assertion is deterministic (no
 * reliance on wall-clock) — the non_functional.reliability requirement.
 */

import { canTransitionSpecWithWorktree } from '../../src/worktree/transitions';
import { heartbeatAge, isStaleByTTL, refreshAgentClaim } from '../../src/worktree/freshness';
import { WORKTREE_RULES } from '../../src/worktree/rules';
import { isOk, isErr } from '../../src/result/construct';
import type { Spec } from '../../src/spec/types';
import type {
  SpecTransition,
  WorktreeRegistry,
  AgentRecord,
  AgentRegistry,
  SessionIdentity,
} from '../../src/worktree/types';

const spec = { id: 'SPEC-1' } as unknown as Spec;

/** A registry mapping name -> a record whose only meaningful field is specId. */
function registry(entries: Record<string, string>): WorktreeRegistry {
  const out: Record<string, unknown> = {};
  for (const [name, specId] of Object.entries(entries)) out[name] = { specId };
  return out as WorktreeRegistry;
}

const EMPTY = registry({});

describe('canTransitionSpecWithWorktree: invalid transition', () => {
  test('unknown transition -> Err transition.invalid_transition', () => {
    const r = canTransitionSpecWithWorktree(spec, EMPTY, 'frobnicate' as SpecTransition);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.errors[0]!.rule).toBe(WORKTREE_RULES.TRANSITION_INVALID);
  });
});

describe('canTransitionSpecWithWorktree: close/archive/delete blocked by active binding (E15)', () => {
  const blocked: SpecTransition[] = ['close', 'archive', 'delete'];

  test.each(blocked)('%s is BLOCKED when a worktree is bound to the spec', (t) => {
    const r = canTransitionSpecWithWorktree(spec, registry({ 'wt-a': 'SPEC-1' }), t);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.errors[0]!.rule).toBe(WORKTREE_RULES.TRANSITION_BLOCKED_BY_ACTIVE_BINDING);
      // The diagnostic names the offending worktree so the shell can act.
      expect(r.errors[0]!.data?.bound_worktrees).toEqual(['wt-a']);
    }
  });

  test.each(blocked)('%s is ALLOWED when no worktree is bound', (t) => {
    const r = canTransitionSpecWithWorktree(spec, EMPTY, t);
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value.allowed).toBe(true);
  });

  test('a binding to a DIFFERENT spec does not block (matches by specId)', () => {
    const r = canTransitionSpecWithWorktree(spec, registry({ 'wt-other': 'SPEC-2' }), 'close');
    expect(isOk(r)).toBe(true);
  });
});

describe('canTransitionSpecWithWorktree: merge_finalize is the legal close-while-bound vector', () => {
  test('merge_finalize is ALLOWED even with an active binding', () => {
    const r = canTransitionSpecWithWorktree(spec, registry({ 'wt-a': 'SPEC-1' }), 'merge_finalize');
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.allowed).toBe(true);
      // It reports the binding it's finalizing.
      expect(r.value.binding).toEqual({ worktree_name: 'wt-a', spec_id: 'SPEC-1' });
    }
  });

  test('merge_finalize with NO binding is allowed and reports no binding', () => {
    const r = canTransitionSpecWithWorktree(spec, EMPTY, 'merge_finalize');
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value.binding).toBeUndefined();
  });
});

describe('freshness: heartbeatAge (deterministic against injected now)', () => {
  const now = new Date('2026-06-13T12:00:00.000Z');

  test('age is now - last_active in ms', () => {
    const rec: AgentRecord = { session_id: 's', last_active: '2026-06-13T11:59:00.000Z' };
    expect(heartbeatAge(rec, now)).toBe(60_000); // 1 minute
  });

  test('an unparseable last_active -> Infinity (treated as infinitely stale for DISPLAY)', () => {
    const rec: AgentRecord = { session_id: 's', last_active: 'not-a-date' };
    expect(heartbeatAge(rec, now)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('freshness: isStaleByTTL (display/hygiene predicate, NEVER authority — E11/E19)', () => {
  const now = new Date('2026-06-13T12:00:00.000Z');
  const ttl = 5 * 60_000; // 5 minutes

  test('within TTL -> not stale', () => {
    const rec: AgentRecord = { session_id: 's', last_active: '2026-06-13T11:58:00.000Z' }; // 2m ago
    expect(isStaleByTTL(rec, ttl, now)).toBe(false);
  });

  test('older than TTL -> stale', () => {
    const rec: AgentRecord = { session_id: 's', last_active: '2026-06-13T11:50:00.000Z' }; // 10m ago
    expect(isStaleByTTL(rec, ttl, now)).toBe(true);
  });

  test('exactly AT the TTL boundary -> NOT stale (strict >, not >=)', () => {
    const rec: AgentRecord = { session_id: 's', last_active: '2026-06-13T11:55:00.000Z' }; // exactly 5m
    // The predicate is `age > ttl`, so age === ttl is not stale. A mutation to
    // >= would flip this case.
    expect(heartbeatAge(rec, now)).toBe(ttl);
    expect(isStaleByTTL(rec, ttl, now)).toBe(false);
  });

  test('staleness is purely temporal — it does not consider ownership (doctrine: stale != abandoned)', () => {
    // Two records with identical age are equally stale regardless of bound_worktree.
    const a: AgentRecord = { session_id: 'a', last_active: '2026-06-13T11:50:00.000Z', bound_worktree: 'wt-a' };
    const b: AgentRecord = { session_id: 'b', last_active: '2026-06-13T11:50:00.000Z' };
    expect(isStaleByTTL(a, ttl, now)).toBe(isStaleByTTL(b, ttl, now));
  });
});

// ---------------------------------------------------------------------------
// refreshAgentClaim — the freshness-patch builder. Previously had ZERO test
// coverage (the whole function was NoCoverage in the mutation report). It
// records "this session is alive now" as a refresh_agent RegistryPatch; it
// NEVER mutates ownership or authorizes takeover (E11/E19 doctrine).
// ---------------------------------------------------------------------------

const NO_AGENTS = {} as unknown as AgentRegistry;
const NOW = new Date('2026-06-13T12:00:00.000Z');

describe('refreshAgentClaim: valid session -> refresh_agent patch', () => {
  test('returns Ok with a refresh_agent patch echoing the session and now', () => {
    const session: SessionIdentity = { session_id: 's-1', platform: 'claude-code' };
    const r = refreshAgentClaim(NO_AGENTS, session, NOW);
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      // kills L40 ObjectLiteral ({}) — the patch object must carry these fields.
      expect(r.value.kind).toBe('refresh_agent');
      expect(r.value.session).toEqual(session);
      // kills L41 StringLiteral — last_active is now.toISOString(), not "".
      expect(r.value.last_active).toBe('2026-06-13T12:00:00.000Z');
    }
  });

  test('records ONLY freshness — no ownership/takeover field on the patch', () => {
    const session: SessionIdentity = { session_id: 's-1' };
    const r = refreshAgentClaim(NO_AGENTS, session, NOW);
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      // Doctrine: refresh is freshness only. No bound_worktree/bound_spec_id
      // unless explicitly opted in, and never an ownership-seizing field.
      expect(r.value).not.toHaveProperty('bound_worktree');
      expect(r.value).not.toHaveProperty('bound_spec_id');
      expect(r.value.kind).toBe('refresh_agent');
    }
  });

  test('bound_worktree opt-in is included when provided (kills L44 conditional spread)', () => {
    const session: SessionIdentity = { session_id: 's-1' };
    const r = refreshAgentClaim(NO_AGENTS, session, NOW, { bound_worktree: 'wt-x' });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.bound_worktree).toBe('wt-x');
      // the false arm: bound_spec_id NOT provided -> absent
      expect(r.value).not.toHaveProperty('bound_spec_id');
    }
  });

  test('bound_spec_id opt-in is included when provided (kills L45 conditional spread)', () => {
    const session: SessionIdentity = { session_id: 's-1' };
    const r = refreshAgentClaim(NO_AGENTS, session, NOW, { bound_spec_id: 'SPEC-9' });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.bound_spec_id).toBe('SPEC-9');
      expect(r.value).not.toHaveProperty('bound_worktree');
    }
  });

  test('both opt-ins together are both present', () => {
    const session: SessionIdentity = { session_id: 's-1' };
    const r = refreshAgentClaim(NO_AGENTS, session, NOW, {
      bound_worktree: 'wt-x',
      bound_spec_id: 'SPEC-9',
    });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.bound_worktree).toBe('wt-x');
      expect(r.value.bound_spec_id).toBe('SPEC-9');
    }
  });

  test('empty-string opt-ins are treated as absent (falsy guard, not included)', () => {
    const session: SessionIdentity = { session_id: 's-1' };
    const r = refreshAgentClaim(NO_AGENTS, session, NOW, {
      bound_worktree: '',
      bound_spec_id: '',
    });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      // The `opts.bound_worktree ? ... : {}` guard drops empty strings.
      expect(r.value).not.toHaveProperty('bound_worktree');
      expect(r.value).not.toHaveProperty('bound_spec_id');
    }
  });
});

describe('refreshAgentClaim: invalid session -> Err passthrough (kills L37 early-return)', () => {
  test('an empty session_id propagates the validation Err (does NOT build a patch)', () => {
    const bad: SessionIdentity = { session_id: '' };
    const r = refreshAgentClaim(NO_AGENTS, bad, NOW);
    // kills L37 ConditionalExpression/EqualityOperator: if the `ok === false`
    // guard is inverted/removed, an invalid session would wrongly yield a patch.
    expect(isErr(r)).toBe(true);
  });

  test('a whitespace-only session_id is rejected (validation trims)', () => {
    const bad: SessionIdentity = { session_id: '   ' };
    const r = refreshAgentClaim(NO_AGENTS, bad, NOW);
    expect(isErr(r)).toBe(true);
  });
});
