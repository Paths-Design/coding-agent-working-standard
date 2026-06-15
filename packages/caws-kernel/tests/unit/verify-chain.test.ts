/**
 * End-to-end tamper-detection tests for verifyChain (E9/E20 — audit integrity).
 *
 * CAWS-TEST-KERNEL-VERIFYCHAIN-001. verify.ts is the composed chain-integrity
 * detector that the store/shell layers rely on to prove the .caws/events.jsonl
 * audit log has not been altered. Before this slice it had ZERO unit tests —
 * only the primitive computeEventHash was covered, so "a tampered chain is
 * detected" was proven by inference, not directly.
 *
 * These tests build a REAL valid chain (each event_hash computed by the same
 * kernel build, each prev_hash linked to its predecessor), then corrupt
 * exactly ONE field per case and assert the SPECIFIC rule id fires — not
 * merely Result.ok === false. A structural-only assertion would pass while the
 * wrong detector ran; pinning the rule id is what makes the test kill the
 * mutant that swaps one rule for another.
 *
 * The detector is pure (no I/O), so these are deterministic in-memory tests.
 */

import { verifyChain } from '../../src/evidence/verify';
import { computeEventHash } from '../../src/evidence/hash';
import { isErr, isOk } from '../../src/result';
import { EVIDENCE_RULES } from '../../src/evidence/rules';
import { type Actor, type ChainedEvent, type Hash } from '../../src/evidence/types';

const actor: Actor = { kind: 'agent', id: 'a1', session_id: 's1', platform: 'test' };

/**
 * Build a valid linked chain of `n` events: seq 1..n, genesis prev_hash null,
 * each non-genesis prev_hash === the prior event_hash, each event_hash the
 * real computed hash. This is the ground-truth a real append loop produces.
 */
function validChain(n: number): ChainedEvent[] {
  const events: ChainedEvent[] = [];
  let prev: Hash | null = null;
  for (let seq = 1; seq <= n; seq++) {
    const body = {
      seq,
      event: 'test_recorded' as const,
      ts: `2026-06-13T00:00:0${seq}.000Z`,
      actor,
      spec_id: 'CAWS-TEST-KERNEL-VERIFYCHAIN-001',
      data: { command: 'jest', exit_code: 0, n: seq },
      prev_hash: prev,
    };
    const event_hash = computeEventHash(body);
    const ev: ChainedEvent = { ...body, event_hash };
    events.push(ev);
    prev = event_hash;
  }
  return events;
}

/** The set of rule ids present in an Err result (for exact-rule assertions). */
function rulesOf(result: ReturnType<typeof verifyChain>): string[] {
  if (!isErr(result)) return [];
  return result.errors.map((e) => e.rule);
}

describe('verifyChain: the happy path does not false-positive (A1)', () => {
  test('a valid single-event (genesis) chain is ok', () => {
    const result = verifyChain(validChain(1));
    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(result.value).toHaveLength(1);
  });

  test('a valid multi-event chain is ok and echoes the input back', () => {
    const chain = validChain(4);
    const result = verifyChain(chain);
    expect(isOk(result)).toBe(true);
    // The detector echoes the exact input — callers depend on the pass-through.
    if (isOk(result)) expect(result.value).toBe(chain);
  });

  test('an empty chain is ok by definition (A5)', () => {
    const result = verifyChain([]);
    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(result.value).toHaveLength(0);
  });
});

describe('verifyChain: event_hash content tamper (A2 — the core integrity property)', () => {
  // Each case alters ONE content field of an otherwise-valid event AFTER its
  // event_hash was computed, so the stored hash no longer matches a re-hash.
  // This is the literal "someone edited events.jsonl" attack.
  const contentFields: Array<[string, (ev: ChainedEvent) => ChainedEvent]> = [
    ['data', (ev) => ({ ...ev, data: { command: 'rm -rf /', exit_code: 0 } })],
    ['ts', (ev) => ({ ...ev, ts: '2099-01-01T00:00:00.000Z' })],
    ['actor.id', (ev) => ({ ...ev, actor: { ...ev.actor, id: 'impostor' } })],
    ['spec_id', (ev) => ({ ...ev, spec_id: 'OTHER-SPEC-999' })],
    ['event', (ev) => ({ ...ev, event: 'spec_closed' })],
  ];

  test.each(contentFields)(
    'altering %s after hashing -> event_hash_mismatch (the stored hash no longer matches a re-hash)',
    (_label, mutate) => {
      const chain = validChain(2);
      // Tamper the second event's content but KEEP its (now-stale) event_hash.
      chain[1] = { ...mutate(chain[1] as ChainedEvent), event_hash: (chain[1] as ChainedEvent).event_hash };
      const result = verifyChain(chain);
      expect(isErr(result)).toBe(true);
      expect(rulesOf(result)).toContain(EVIDENCE_RULES.CHAIN_EVENT_HASH_MISMATCH);
    }
  );

  test('the mismatch diagnostic carries expected (recompute) != actual (stored) as concrete evidence', () => {
    const chain = validChain(2);
    const stale = (chain[1] as ChainedEvent).event_hash;
    chain[1] = { ...(chain[1] as ChainedEvent), data: { tampered: true }, event_hash: stale };
    const result = verifyChain(chain);
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      const d = result.errors.find((e) => e.rule === EVIDENCE_RULES.CHAIN_EVENT_HASH_MISMATCH);
      expect(d).toBeDefined();
      // The recomputed (expected) hash differs from the stored (actual) one.
      expect(d?.data?.expected).not.toBe(d?.data?.actual);
      expect(d?.data?.actual).toBe(stale);
    }
  });
});

describe('verifyChain: prev_hash chain-link tamper (A3)', () => {
  test('a broken prev_hash link -> prev_hash_mismatch', () => {
    const chain = validChain(2);
    // Point the second event at a hash that is NOT the genesis event_hash.
    chain[1] = {
      ...(chain[1] as ChainedEvent),
      prev_hash: ('sha256:' + 'a'.repeat(64)) as Hash,
    };
    // Re-hash so we isolate prev_hash_mismatch from event_hash_mismatch:
    // prev_hash IS part of the hashed material, so recompute the event_hash to
    // keep the event internally consistent — the ONLY fault is the broken link.
    const rehashed = computeEventHash(chain[1] as ChainedEvent);
    chain[1] = { ...(chain[1] as ChainedEvent), event_hash: rehashed };
    const result = verifyChain(chain);
    expect(isErr(result)).toBe(true);
    const rules = rulesOf(result);
    expect(rules).toContain(EVIDENCE_RULES.CHAIN_PREV_HASH_MISMATCH);
    // And NOT event_hash_mismatch — we kept the event internally consistent.
    expect(rules).not.toContain(EVIDENCE_RULES.CHAIN_EVENT_HASH_MISMATCH);
  });
});

describe('verifyChain: seq integrity (A4)', () => {
  test('a seq gap (1, 2, 4) -> seq_gap', () => {
    const chain = validChain(3);
    chain[2] = { ...(chain[2] as ChainedEvent), seq: 4 };
    chain[2] = { ...(chain[2] as ChainedEvent), event_hash: computeEventHash(chain[2] as ChainedEvent) };
    expect(rulesOf(verifyChain(chain))).toContain(EVIDENCE_RULES.CHAIN_SEQ_GAP);
  });

  test('a duplicate seq -> seq_duplicate', () => {
    const chain = validChain(2);
    chain[1] = { ...(chain[1] as ChainedEvent), seq: 1 };
    chain[1] = { ...(chain[1] as ChainedEvent), event_hash: computeEventHash(chain[1] as ChainedEvent) };
    expect(rulesOf(verifyChain(chain))).toContain(EVIDENCE_RULES.CHAIN_SEQ_DUPLICATE);
  });

  test('a non-integer seq -> seq_not_integer', () => {
    const chain = validChain(1);
    chain[0] = { ...(chain[0] as ChainedEvent), seq: 1.5 };
    expect(rulesOf(verifyChain(chain))).toContain(EVIDENCE_RULES.CHAIN_SEQ_NOT_INTEGER);
  });

  test('a seq < 1 -> seq_not_positive', () => {
    const chain = validChain(1);
    chain[0] = { ...(chain[0] as ChainedEvent), seq: 0 };
    expect(rulesOf(verifyChain(chain))).toContain(EVIDENCE_RULES.CHAIN_SEQ_NOT_POSITIVE);
  });

  test('genesis seq != 1 -> seq_gap (genesis must be seq 1)', () => {
    const chain = validChain(1);
    chain[0] = { ...(chain[0] as ChainedEvent), seq: 5 };
    chain[0] = { ...(chain[0] as ChainedEvent), event_hash: computeEventHash(chain[0] as ChainedEvent) };
    expect(rulesOf(verifyChain(chain))).toContain(EVIDENCE_RULES.CHAIN_SEQ_GAP);
  });
});

describe('verifyChain: prev_hash shape rules (A4)', () => {
  test('genesis prev_hash != null -> genesis_prev_hash_not_null', () => {
    const chain = validChain(1);
    chain[0] = {
      ...(chain[0] as ChainedEvent),
      prev_hash: ('sha256:' + 'b'.repeat(64)) as Hash,
    };
    chain[0] = { ...(chain[0] as ChainedEvent), event_hash: computeEventHash(chain[0] as ChainedEvent) };
    expect(rulesOf(verifyChain(chain))).toContain(EVIDENCE_RULES.CHAIN_GENESIS_PREV_HASH_NOT_NULL);
  });

  test('non-genesis prev_hash null -> non_genesis_prev_hash_null', () => {
    const chain = validChain(2);
    chain[1] = { ...(chain[1] as ChainedEvent), prev_hash: null };
    chain[1] = { ...(chain[1] as ChainedEvent), event_hash: computeEventHash(chain[1] as ChainedEvent) };
    expect(rulesOf(verifyChain(chain))).toContain(EVIDENCE_RULES.CHAIN_NON_GENESIS_PREV_HASH_NULL);
  });

  test('a malformed prev_hash (not sha256:<hex>) -> prev_hash_malformed', () => {
    const chain = validChain(2);
    chain[1] = { ...(chain[1] as ChainedEvent), prev_hash: 'not-a-hash' as Hash };
    chain[1] = { ...(chain[1] as ChainedEvent), event_hash: computeEventHash(chain[1] as ChainedEvent) };
    expect(rulesOf(verifyChain(chain))).toContain(EVIDENCE_RULES.CHAIN_PREV_HASH_MALFORMED);
  });
});

describe('verifyChain: event_hash shape rules (A4)', () => {
  test('a malformed event_hash (not sha256:<hex>) -> event_hash_malformed', () => {
    const chain = validChain(1);
    chain[0] = { ...(chain[0] as ChainedEvent), event_hash: 'sha256:xyz' as Hash };
    const rules = rulesOf(verifyChain(chain));
    expect(rules).toContain(EVIDENCE_RULES.CHAIN_EVENT_HASH_MALFORMED);
    // A malformed hash short-circuits the content re-hash, so mismatch must NOT
    // also fire for the same event (the detector reports the shape fault only).
    expect(rules).not.toContain(EVIDENCE_RULES.CHAIN_EVENT_HASH_MISMATCH);
  });
});

describe('verifyChain: allErrors accumulation (A4 — midchain tamper does not hide later tamper)', () => {
  test('two independent faults at different indices are BOTH reported', () => {
    const chain = validChain(3);
    // Fault 1: content tamper at index 1 (keep stale hash -> event_hash_mismatch).
    chain[1] = {
      ...(chain[1] as ChainedEvent),
      data: { tampered: 'index1' },
      event_hash: (chain[1] as ChainedEvent).event_hash,
    };
    // Fault 2: duplicate seq at index 2.
    chain[2] = { ...(chain[2] as ChainedEvent), seq: 1 };
    chain[2] = { ...(chain[2] as ChainedEvent), event_hash: computeEventHash(chain[2] as ChainedEvent) };
    const rules = rulesOf(verifyChain(chain));
    // The first fault does not stop the walk; both detectors fire.
    expect(rules).toContain(EVIDENCE_RULES.CHAIN_EVENT_HASH_MISMATCH);
    expect(rules).toContain(EVIDENCE_RULES.CHAIN_SEQ_DUPLICATE);
  });
});
