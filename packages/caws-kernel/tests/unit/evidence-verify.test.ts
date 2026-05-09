import {
  EVIDENCE_RULES,
  prepareAppend,
  verifyChain,
  type ChainedEvent,
  type EventBody,
  type Hash,
} from '../../src/evidence';
import { isErr, isOk } from '../../src/result';

const goodActor = { kind: 'agent' as const, id: 'darian' };
const goodTs = '2026-05-08T00:00:00.000Z';

function buildChain(n: number): ChainedEvent[] {
  const events: ChainedEvent[] = [];
  let prev: ChainedEvent | null = null;
  for (let i = 0; i < n; i++) {
    const body: EventBody = {
      event: 'spec_created',
      ts: new Date(Date.parse(goodTs) + i * 1000).toISOString(),
      actor: goodActor,
      spec_id: `FOO-${i + 1}`,
      data: { title: `Spec ${i + 1}`, risk_tier: 2, mode: 'feature', lifecycle_state: 'draft' },
    };
    const r = prepareAppend(prev, body);
    if (!isOk(r)) throw new Error(`prepareAppend failed at i=${i}: ${JSON.stringify(r.errors)}`);
    events.push(r.value);
    prev = r.value;
  }
  return events;
}

describe('verifyChain — happy path', () => {
  it('accepts an empty chain', () => {
    expect(isOk(verifyChain([]))).toBe(true);
  });

  it('accepts a 1-event chain (genesis only)', () => {
    const chain = buildChain(1);
    expect(isOk(verifyChain(chain))).toBe(true);
  });

  it('accepts a 5-event chain', () => {
    const chain = buildChain(5);
    expect(isOk(verifyChain(chain))).toBe(true);
  });
});

describe('verifyChain — sequence integrity', () => {
  it('detects seq gap (1, 2, 4)', () => {
    const c = buildChain(4);
    // Skip seq 3 and renumber the last so indexes are 0, 1, 3 (gap).
    const tampered: ChainedEvent[] = [c[0]!, c[1]!, c[3]!];
    const r = verifyChain(tampered);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.errors.map((e) => e.rule)).toContain(EVIDENCE_RULES.CHAIN_SEQ_GAP);
    }
  });

  it('detects duplicate seq', () => {
    const c = buildChain(2);
    const dupe: ChainedEvent[] = [c[0]!, { ...c[1]!, seq: 1 }];
    const r = verifyChain(dupe);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.errors.map((e) => e.rule)).toContain(EVIDENCE_RULES.CHAIN_SEQ_DUPLICATE);
    }
  });

  it('detects genesis with seq != 1', () => {
    const c = buildChain(1);
    const tampered: ChainedEvent[] = [{ ...c[0]!, seq: 2 }];
    const r = verifyChain(tampered);
    expect(isErr(r)).toBe(true);
  });
});

describe('verifyChain — prev_hash integrity', () => {
  it('detects genesis with non-null prev_hash', () => {
    const c = buildChain(1);
    const tampered: ChainedEvent[] = [
      { ...c[0]!, prev_hash: ('sha256:' + 'a'.repeat(64)) as Hash },
    ];
    const r = verifyChain(tampered);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.errors.map((e) => e.rule)).toContain(
        EVIDENCE_RULES.CHAIN_GENESIS_PREV_HASH_NOT_NULL
      );
    }
  });

  it('detects non-genesis with null prev_hash', () => {
    const c = buildChain(2);
    const tampered: ChainedEvent[] = [c[0]!, { ...c[1]!, prev_hash: null }];
    const r = verifyChain(tampered);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.errors.map((e) => e.rule)).toContain(EVIDENCE_RULES.CHAIN_NON_GENESIS_PREV_HASH_NULL);
    }
  });

  it('detects prev_hash mismatch (rewriten predecessor link)', () => {
    const c = buildChain(2);
    const tampered: ChainedEvent[] = [
      c[0]!,
      { ...c[1]!, prev_hash: ('sha256:' + 'a'.repeat(64)) as Hash },
    ];
    const r = verifyChain(tampered);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.errors.map((e) => e.rule)).toContain(EVIDENCE_RULES.CHAIN_PREV_HASH_MISMATCH);
    }
  });

  it('detects malformed prev_hash on non-genesis', () => {
    const c = buildChain(2);
    const tampered = [c[0]!, { ...c[1]!, prev_hash: 'garbage' as unknown as Hash }];
    const r = verifyChain(tampered);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.errors.map((e) => e.rule)).toContain(EVIDENCE_RULES.CHAIN_PREV_HASH_MALFORMED);
    }
  });
});

describe('verifyChain — event_hash integrity (tamper detection)', () => {
  it('detects body tampering (data field changed after hashing)', () => {
    const c = buildChain(2);
    const tampered: ChainedEvent[] = [
      c[0]!,
      { ...c[1]!, data: { ...c[1]!.data, title: 'Tampered' } },
    ];
    const r = verifyChain(tampered);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.errors.map((e) => e.rule)).toContain(EVIDENCE_RULES.CHAIN_EVENT_HASH_MISMATCH);
    }
  });

  it('detects ts tampering', () => {
    const c = buildChain(2);
    const tampered: ChainedEvent[] = [c[0]!, { ...c[1]!, ts: '2099-01-01T00:00:00.000Z' }];
    const r = verifyChain(tampered);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.errors.map((e) => e.rule)).toContain(EVIDENCE_RULES.CHAIN_EVENT_HASH_MISMATCH);
    }
  });

  it('detects actor tampering', () => {
    const c = buildChain(2);
    const tampered: ChainedEvent[] = [
      c[0]!,
      { ...c[1]!, actor: { kind: 'human', id: 'attacker' } },
    ];
    const r = verifyChain(tampered);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.errors.map((e) => e.rule)).toContain(EVIDENCE_RULES.CHAIN_EVENT_HASH_MISMATCH);
    }
  });

  it('detects malformed event_hash', () => {
    const c = buildChain(1);
    const tampered = [{ ...c[0]!, event_hash: 'not-a-hash' as unknown as Hash }];
    const r = verifyChain(tampered);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.errors.map((e) => e.rule)).toContain(EVIDENCE_RULES.CHAIN_EVENT_HASH_MALFORMED);
    }
  });
});

describe('verifyChain — collects all violations (allErrors style)', () => {
  it('reports multiple violations in one pass instead of stopping at the first', () => {
    const c = buildChain(3);
    // Tamper TWO events at once.
    const tampered: ChainedEvent[] = [
      c[0]!,
      { ...c[1]!, data: { ...c[1]!.data, title: 'Tampered 1' } },
      { ...c[2]!, data: { ...c[2]!.data, title: 'Tampered 2' } },
    ];
    const r = verifyChain(tampered);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const mismatches = r.errors.filter(
        (e) => e.rule === EVIDENCE_RULES.CHAIN_EVENT_HASH_MISMATCH
      );
      // At minimum 2 mismatches; one per tampered event. There may also be
      // a prev_hash_mismatch on event[2] because event[1]'s recomputed
      // hash differs from what event[2] points back to.
      expect(mismatches.length).toBeGreaterThanOrEqual(2);
    }
  });
});
