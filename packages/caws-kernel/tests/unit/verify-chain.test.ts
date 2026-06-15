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

// ---------------------------------------------------------------------------
// Message-text assertions (kills StringLiteral survivors at each diagnostic site)
// The existing tests pin rule ids but never check message strings. Mutations
// that blank a message string (StringLiteral -> "") survive because nothing
// asserted the content. The tests below add toContain checks that require the
// real text to be present.
// ---------------------------------------------------------------------------

describe('verifyChain: diagnostic message content (StringLiteral killers)', () => {
  test('seq_not_integer message includes chain index and got-value', () => {
    const chain = validChain(1);
    chain[0] = { ...(chain[0] as ChainedEvent), seq: 1.5 };
    const result = verifyChain(chain);
    if (!isErr(result)) throw new Error('expected error');
    const d = result.errors.find((e) => e.rule === EVIDENCE_RULES.CHAIN_SEQ_NOT_INTEGER);
    expect(d).toBeDefined();
    expect(d!.message).toContain('0'); // chain index
    expect(d!.message).toContain('1.5'); // got-value
    expect(d!.authority).toBe('kernel/evidence');
    expect(d!.subject).toBe('[0].seq');
  });

  test('seq_not_positive message includes chain index and got-value', () => {
    const chain = validChain(1);
    chain[0] = { ...(chain[0] as ChainedEvent), seq: 0 };
    const result = verifyChain(chain);
    if (!isErr(result)) throw new Error('expected error');
    const d = result.errors.find((e) => e.rule === EVIDENCE_RULES.CHAIN_SEQ_NOT_POSITIVE);
    expect(d).toBeDefined();
    expect(d!.message).toContain('0'); // seq value
    expect(d!.authority).toBe('kernel/evidence');
    expect(d!.subject).toBe('[0].seq');
  });

  test('seq_duplicate message includes duplicate seq and chain index', () => {
    const chain = validChain(2);
    chain[1] = { ...(chain[1] as ChainedEvent), seq: 1 };
    chain[1] = { ...(chain[1] as ChainedEvent), event_hash: computeEventHash(chain[1] as ChainedEvent) };
    const result = verifyChain(chain);
    if (!isErr(result)) throw new Error('expected error');
    const d = result.errors.find((e) => e.rule === EVIDENCE_RULES.CHAIN_SEQ_DUPLICATE);
    expect(d).toBeDefined();
    expect(d!.message).toContain('1'); // duplicate seq value
    expect(d!.authority).toBe('kernel/evidence');
    expect(d!.subject).toBe('[1].seq');
  });

  test('seq_gap (non-genesis) message includes expected and got seq', () => {
    const chain = validChain(3);
    chain[2] = { ...(chain[2] as ChainedEvent), seq: 4 };
    chain[2] = { ...(chain[2] as ChainedEvent), event_hash: computeEventHash(chain[2] as ChainedEvent) };
    const result = verifyChain(chain);
    if (!isErr(result)) throw new Error('expected error');
    const d = result.errors.find((e) => e.rule === EVIDENCE_RULES.CHAIN_SEQ_GAP);
    expect(d).toBeDefined();
    expect(d!.message).toContain('3'); // expected seq
    expect(d!.message).toContain('4'); // got seq
    expect(d!.authority).toBe('kernel/evidence');
    expect(d!.subject).toBe('[2].seq');
  });

  test('seq_gap (genesis) message says genesis must have seq=1', () => {
    const chain = validChain(1);
    chain[0] = { ...(chain[0] as ChainedEvent), seq: 5 };
    chain[0] = { ...(chain[0] as ChainedEvent), event_hash: computeEventHash(chain[0] as ChainedEvent) };
    const result = verifyChain(chain);
    if (!isErr(result)) throw new Error('expected error');
    const d = result.errors.find((e) => e.rule === EVIDENCE_RULES.CHAIN_SEQ_GAP);
    expect(d).toBeDefined();
    expect(d!.message).toContain('seq=1');
    expect(d!.message).toContain('5');
    expect(d!.authority).toBe('kernel/evidence');
    expect(d!.subject).toBe('[0].seq');
  });

  test('genesis_prev_hash_not_null message includes the offending value', () => {
    const chain = validChain(1);
    const badHash = ('sha256:' + 'b'.repeat(64)) as Hash;
    chain[0] = { ...(chain[0] as ChainedEvent), prev_hash: badHash };
    chain[0] = { ...(chain[0] as ChainedEvent), event_hash: computeEventHash(chain[0] as ChainedEvent) };
    const result = verifyChain(chain);
    if (!isErr(result)) throw new Error('expected error');
    const d = result.errors.find((e) => e.rule === EVIDENCE_RULES.CHAIN_GENESIS_PREV_HASH_NOT_NULL);
    expect(d).toBeDefined();
    expect(d!.message).toContain('null');
    // The narrowRepair is non-empty and advises null
    expect(d!.narrowRepair).toContain('null');
    expect(d!.authority).toBe('kernel/evidence');
    expect(d!.subject).toBe('[0].prev_hash');
  });

  test('non_genesis_prev_hash_null message includes chain index', () => {
    const chain = validChain(2);
    chain[1] = { ...(chain[1] as ChainedEvent), prev_hash: null };
    chain[1] = { ...(chain[1] as ChainedEvent), event_hash: computeEventHash(chain[1] as ChainedEvent) };
    const result = verifyChain(chain);
    if (!isErr(result)) throw new Error('expected error');
    const d = result.errors.find((e) => e.rule === EVIDENCE_RULES.CHAIN_NON_GENESIS_PREV_HASH_NULL);
    expect(d).toBeDefined();
    expect(d!.message).toContain('1'); // chain index
    expect(d!.authority).toBe('kernel/evidence');
    expect(d!.subject).toBe('[1].prev_hash');
  });

  test('prev_hash_malformed message includes chain index', () => {
    const chain = validChain(2);
    chain[1] = { ...(chain[1] as ChainedEvent), prev_hash: 'not-a-hash' as Hash };
    chain[1] = { ...(chain[1] as ChainedEvent), event_hash: computeEventHash(chain[1] as ChainedEvent) };
    const result = verifyChain(chain);
    if (!isErr(result)) throw new Error('expected error');
    const d = result.errors.find((e) => e.rule === EVIDENCE_RULES.CHAIN_PREV_HASH_MALFORMED);
    expect(d).toBeDefined();
    expect(d!.message).toContain('1'); // chain index
    expect(d!.authority).toBe('kernel/evidence');
    expect(d!.subject).toBe('[1].prev_hash');
  });

  test('prev_hash_mismatch message includes chain index AND data.expected/actual', () => {
    const chain = validChain(2);
    const wrongHash = ('sha256:' + 'a'.repeat(64)) as Hash;
    chain[1] = { ...(chain[1] as ChainedEvent), prev_hash: wrongHash };
    const rehashed = computeEventHash(chain[1] as ChainedEvent);
    chain[1] = { ...(chain[1] as ChainedEvent), event_hash: rehashed };
    const result = verifyChain(chain);
    if (!isErr(result)) throw new Error('expected error');
    const d = result.errors.find((e) => e.rule === EVIDENCE_RULES.CHAIN_PREV_HASH_MISMATCH);
    expect(d).toBeDefined();
    expect(d!.message).toContain('1'); // chain index
    // The mismatch diagnostic carries expected (genesis event_hash) and actual (the wrong hash).
    expect(d!.data).toBeDefined();
    expect(d!.data!['expected']).not.toBe(d!.data!['actual']);
    expect(d!.data!['actual']).toBe(wrongHash);
    expect(d!.authority).toBe('kernel/evidence');
    expect(d!.subject).toBe('[1].prev_hash');
  });

  test('event_hash_malformed message includes chain index', () => {
    const chain = validChain(1);
    chain[0] = { ...(chain[0] as ChainedEvent), event_hash: 'sha256:xyz' as Hash };
    const result = verifyChain(chain);
    if (!isErr(result)) throw new Error('expected error');
    const d = result.errors.find((e) => e.rule === EVIDENCE_RULES.CHAIN_EVENT_HASH_MALFORMED);
    expect(d).toBeDefined();
    expect(d!.message).toContain('0'); // chain index
    expect(d!.authority).toBe('kernel/evidence');
    expect(d!.subject).toBe('[0].event_hash');
    // Malformed check short-circuits; mismatch must NOT fire for the same event.
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.errors.some((e) => e.rule === EVIDENCE_RULES.CHAIN_EVENT_HASH_MISMATCH)).toBe(false);
    }
  });

  test('event_hash_mismatch message includes chain index AND data.expected/actual', () => {
    const chain = validChain(2);
    const stale = (chain[1] as ChainedEvent).event_hash;
    chain[1] = { ...(chain[1] as ChainedEvent), data: { tampered: true }, event_hash: stale };
    const result = verifyChain(chain);
    if (!isErr(result)) throw new Error('expected error');
    const d = result.errors.find((e) => e.rule === EVIDENCE_RULES.CHAIN_EVENT_HASH_MISMATCH);
    expect(d).toBeDefined();
    expect(d!.message).toContain('1'); // chain index
    // Must carry the expected (recomputed) and actual (stale) hashes.
    expect(d!.data).toBeDefined();
    expect(typeof d!.data!['expected']).toBe('string');
    expect(d!.data!['actual']).toBe(stale);
    expect(d!.data!['expected']).not.toBe(stale);
    expect(d!.authority).toBe('kernel/evidence');
    expect(d!.subject).toBe('[1].event_hash');
  });
});

// ---------------------------------------------------------------------------
// Conditional/logical-operator survivors in verify.ts
// ---------------------------------------------------------------------------

describe('verifyChain: conditional expression killers', () => {
  test('the undefined-slot branch emits event_envelope_invalid (L59 BlockStatement/ConditionalExpression)', () => {
    // A sparse array has an undefined hole at index 0. TypeScript disallows
    // this, but JS can construct it. verifyChain guards with `if (ev === undefined)`.
    // Mutants that replace `ev === undefined` with `false` skip the guard,
    // causing a crash when we access ev.seq. Mutants that replace with `true`
    // always emit the error and skip valid events.
    const sparse = validChain(1);
    // Insert an undefined hole at position 0 via JS array construction.
    const sparseArr: ChainedEvent[] = [];
    sparseArr.length = 1; // creates sparse array with no defined slot 0
    const result = verifyChain(sparseArr as unknown as ChainedEvent[]);
    // The undefined slot is detected — at least EVENT_ENVELOPE_INVALID fires.
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.errors[0]!.rule).toBe(EVIDENCE_RULES.EVENT_ENVELOPE_INVALID);
      expect(result.errors[0]!.message).toContain('0'); // Chain index in message
      expect(result.errors[0]!.authority).toBe('kernel/evidence');
      expect(result.errors[0]!.subject).toBe('[0]');
    }
  });

  test('seenSeqs conditional: second occurrence of same seq fires seq_duplicate (L110)', () => {
    // Tests that seenSeqs.has(ev.seq) is actually checked (not short-circuited).
    // Mutation [true] would always fire duplicate; [false] would never fire.
    const chain = validChain(3);
    // seq at index 2 duplicates seq at index 0.
    chain[2] = { ...(chain[2] as ChainedEvent), seq: 1 };
    chain[2] = { ...(chain[2] as ChainedEvent), event_hash: computeEventHash(chain[2] as ChainedEvent) };
    const rules = rulesOf(verifyChain(chain));
    expect(rules).toContain(EVIDENCE_RULES.CHAIN_SEQ_DUPLICATE);
    // The gap rule also fires (seq 1 appears again instead of 3)
    expect(rules).toContain(EVIDENCE_RULES.CHAIN_SEQ_GAP);
  });

  test('event_hash typeof check: non-string event_hash fires event_hash_malformed (L184)', () => {
    // Mutant [false] would skip the malformed check and try to re-hash something
    // that would then be compared — which could either crash or silently pass.
    const chain = validChain(1);
    // @ts-expect-error intentionally invalid for mutation testing
    chain[0] = { ...(chain[0] as ChainedEvent), event_hash: 12345 };
    const result = verifyChain(chain);
    expect(isErr(result)).toBe(true);
    // Must find event_hash_malformed specifically — not mismatch.
    // With mutant [false], shape check skipped → mismatch fires instead → find returns undefined.
    expect(isErr(result) ? result.errors.find((e) => e.rule === EVIDENCE_RULES.CHAIN_EVENT_HASH_MALFORMED) : undefined).toBeDefined();
    // Also assert: mismatch must NOT fire (malformed short-circuits re-hash).
    expect(isErr(result) ? result.errors.some((e) => e.rule === EVIDENCE_RULES.CHAIN_EVENT_HASH_MISMATCH) : false).toBe(false);
  });

  test('prev_hash_mismatch compound condition: prev is not null AND is a valid hash (L167)', () => {
    // The mismatch check only fires when prev.event_hash is a valid hash.
    // Mutant [true] would always check mismatch (even when prev is null → crash).
    // This test puts prev_hash pointing to the RIGHT hash (so mismatch doesn't fire)
    // to prove the condition works in the NOT-MISMATCHING path.
    const chain = validChain(3);
    // chain[2].prev_hash already correctly points to chain[1].event_hash.
    // Verify the chain is still ok — the mismatch guard did NOT fire spuriously.
    expect(isOk(verifyChain(chain))).toBe(true);
  });

  test('ArithmeticOperator: prev.seq + 1 change detection (L118)', () => {
    // Mutant [prev.seq - 1] would accept seq=1 after seq=2 as a "correct" gap.
    // Build chain: seq 1, seq 2, then swap seq 2's successor to seq 1 to trigger gap.
    const chain = validChain(3);
    // Change seq at index 2 to be prev.seq - 1 = 1 (not prev.seq + 1 = 3).
    // This should fail gap detection. With the mutant, prev.seq - 1 = 1 would
    // compare ev.seq(1) !== prev.seq - 1(1) = false, so NO gap fires. Real code:
    // ev.seq(1) !== prev.seq(2) + 1(3) = true, fires gap.
    chain[2] = { ...(chain[2] as ChainedEvent), seq: 1 };
    chain[2] = { ...(chain[2] as ChainedEvent), event_hash: computeEventHash(chain[2] as ChainedEvent) };
    const rules = rulesOf(verifyChain(chain));
    expect(rules).toContain(EVIDENCE_RULES.CHAIN_SEQ_GAP);
  });

  test('isHash conditional at L231: non-hash string is rejected', () => {
    // The isHash function checks typeof === string AND regex. Mutant [true] would
    // accept any value as a hash. We verify the regex is actually consulted by
    // passing a string that fails the regex but passes typeof.
    const chain = validChain(1);
    // A string that is NOT a sha256:<64hex> — fails HASH_REGEX.
    chain[0] = { ...(chain[0] as ChainedEvent), event_hash: 'sha256:tooshort' as Hash };
    const result = verifyChain(chain);
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.errors.some((e) => e.rule === EVIDENCE_RULES.CHAIN_EVENT_HASH_MALFORMED)).toBe(true);
    }
  });

  test('catch block: computeEventHash throw is caught and reported as event_hash_mismatch (L199)', () => {
    // The try { recomputed = computeEventHash(ev) } catch block converts a hash
    // computation error into an event_hash_mismatch diagnostic. To exercise this
    // path we need a ChainedEvent whose canonical JSON triggers an exception.
    // The event hash uses canonicalJson internally; supplying a non-finite number
    // in data causes canonicalJson to throw, which the catch block handles.
    const chain = validChain(1);
    // Override data with a non-serializable value AFTER setting event_hash.
    // This keeps event_hash a valid format but makes recomputation throw.
    chain[0] = {
      ...(chain[0] as ChainedEvent),
      data: { n: NaN } as unknown as Record<string, unknown>,
    };
    // event_hash already set; keep it so the shape check passes and we reach
    // the recomputation try block.
    const result = verifyChain(chain);
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      const d = result.errors.find((e) => e.rule === EVIDENCE_RULES.CHAIN_EVENT_HASH_MISMATCH);
      expect(d).toBeDefined();
      expect(d!.message).toContain('could not be recomputed');
      expect(d!.authority).toBe('kernel/evidence');
      expect(d!.subject).toBe('[0].event_hash');
    }
  });
});
