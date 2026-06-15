/**
 * WORKTREE-REPAIR-EVENT-CONTRACT-001
 *
 * Vocabulary contract for the two honest half-state repair events:
 *   worktree_pruned     (OPTIONAL_SPEC_ID) — H1 ghost-registry entry removed.
 *   spec_binding_cleared (REQUIRES_SPEC_ID) — H4 / H3-closed stale worktree: cleared.
 *
 * These exist so PRUNE-REPAIR-WORKTREE-001 can append an HONEST, schema-valid
 * audit record instead of reusing worktree_destroyed (which asserts a LIVE
 * worktree was removed) or the schema-less spec_updated/spec_drift_detected
 * (which cannot be appended). This slice adds VOCABULARY only — no writer, no
 * repair, no doctor change. The test proves: a well-formed payload validates,
 * a malformed one is rejected, the spec-id class is enforced, and the new types
 * hash + chain-verify like any other event.
 */

import { validateEventBody } from '../../src/evidence/validate';
import { computeEventHash } from '../../src/evidence/hash';
import { verifyChain } from '../../src/evidence/verify';
import { isOk, isErr } from '../../src/result';
import { OPTIONAL_SPEC_ID, REQUIRES_SPEC_ID } from '../../src/evidence/types';
import type { Actor, ChainedEvent, Hash } from '../../src/evidence/types';

const ACTOR: Actor = { kind: 'agent', id: 'a', session_id: 's' };
const TS = '2026-06-15T00:00:00.000Z';

function rules(r: ReturnType<typeof validateEventBody>): string[] {
  return isErr(r) ? r.errors.map((e) => e.rule) : [];
}

// =========================================================================
// A1 — spec-id class registration
// =========================================================================

describe('A1: the two new types are registered with the correct spec-id class', () => {
  test('worktree_pruned is OPTIONAL_SPEC_ID', () => {
    expect(OPTIONAL_SPEC_ID.has('worktree_pruned')).toBe(true);
    expect(REQUIRES_SPEC_ID.has('worktree_pruned')).toBe(false);
  });
  test('spec_binding_cleared is REQUIRES_SPEC_ID', () => {
    expect(REQUIRES_SPEC_ID.has('spec_binding_cleared')).toBe(true);
    expect(OPTIONAL_SPEC_ID.has('spec_binding_cleared')).toBe(false);
  });
});

// =========================================================================
// A2 — worktree_pruned payload validation
// =========================================================================

describe('A2: worktree_pruned payload validation', () => {
  const valid = {
    event: 'worktree_pruned',
    ts: TS,
    actor: ACTOR,
    data: { worktree_name: 'wt-ghost', h_class: 'ghost_registry', reason: 'no backing git worktree (H1)' },
  };

  test('a well-formed worktree_pruned (no spec_id) validates', () => {
    expect(isOk(validateEventBody(valid))).toBe(true);
  });

  test('an optional spec_id is accepted when well-formed', () => {
    const r = validateEventBody({ ...valid, spec_id: 'FEAT-001', data: { ...valid.data } });
    expect(isOk(r)).toBe(true);
  });

  test('an extra/unknown data property is REJECTED (additionalProperties:false)', () => {
    const r = validateEventBody({ ...valid, data: { ...valid.data, surprise: 1 } });
    expect(isErr(r)).toBe(true);
    expect(rules(r).join(' ')).toMatch(/payload|invalid|additional/i);
  });

  test('a missing required field (reason) is REJECTED', () => {
    const r = validateEventBody({
      ...valid,
      data: { worktree_name: 'wt-ghost', h_class: 'ghost_registry' },
    });
    expect(isErr(r)).toBe(true);
  });

  test('an h_class outside the closed enum is REJECTED (cannot prune an unauthorized class)', () => {
    const r = validateEventBody({
      ...valid,
      data: { ...valid.data, h_class: 'three_way_contradiction' },
    });
    expect(isErr(r)).toBe(true);
  });
});

// =========================================================================
// A3 — spec_binding_cleared payload validation
// =========================================================================

describe('A3: spec_binding_cleared payload validation', () => {
  const valid = {
    event: 'spec_binding_cleared',
    ts: TS,
    actor: ACTOR,
    spec_id: 'FEAT-001',
    data: {
      spec_id: 'FEAT-001',
      cleared_worktree_name: 'wt-gone',
      h_class: 'ghost_spec_binding',
      reason: 'registry + git confirm no live worktree (H4)',
    },
  };

  test('a well-formed spec_binding_cleared validates', () => {
    expect(isOk(validateEventBody(valid))).toBe(true);
  });

  test('the dormant_spec_binding (H3-closed/archived) h_class is accepted', () => {
    const r = validateEventBody({
      ...valid,
      data: { ...valid.data, h_class: 'dormant_spec_binding' },
    });
    expect(isOk(r)).toBe(true);
  });

  test('a missing envelope spec_id is REJECTED (REQUIRES_SPEC_ID)', () => {
    const { spec_id: _drop, ...noSpecId } = valid;
    void _drop;
    expect(isErr(validateEventBody(noSpecId))).toBe(true);
  });

  test('an h_class outside the closed enum is REJECTED (cannot clear H3-active or H5)', () => {
    const r = validateEventBody({
      ...valid,
      data: { ...valid.data, h_class: 'active_spec_binding' },
    });
    expect(isErr(r)).toBe(true);
  });

  test('an extra data property is REJECTED (additionalProperties:false)', () => {
    const r = validateEventBody({ ...valid, data: { ...valid.data, extra: true } });
    expect(isErr(r)).toBe(true);
  });
});

// =========================================================================
// A4 — the new types hash + chain-verify like any other event
// =========================================================================

describe('A4: the new event types do not break canonical hashing or chain integrity', () => {
  test('a chain containing worktree_pruned and spec_binding_cleared verifies', () => {
    const bodies = [
      { event: 'spec_created', spec_id: 'FEAT-001', data: { title: 'x' } },
      { event: 'worktree_pruned', data: { worktree_name: 'wt-ghost', h_class: 'ghost_registry', reason: 'H1' } },
      {
        event: 'spec_binding_cleared',
        spec_id: 'FEAT-001',
        data: {
          spec_id: 'FEAT-001',
          cleared_worktree_name: 'wt-gone',
          h_class: 'ghost_spec_binding',
          reason: 'H4',
        },
      },
    ];
    const chain: ChainedEvent[] = [];
    let prev: Hash | null = null;
    bodies.forEach((b, i) => {
      const body = { seq: i + 1, ts: `2026-06-15T00:00:0${i}.000Z`, actor: ACTOR, prev_hash: prev, ...b };
      const event_hash = computeEventHash(body as unknown as ChainedEvent);
      chain.push({ ...body, event_hash } as unknown as ChainedEvent);
      prev = event_hash;
    });
    const v = verifyChain(chain);
    expect(isOk(v)).toBe(true);
  });
});
