/**
 * Unit tests for computeEventHash (A4 — hash-chain integrity, lineage E9).
 *
 * CAWS-TEST-KERNEL-PURE-001. These pin the ACTUAL hash algorithm documented in
 * hash.ts: sha256(DOMAIN_SEPARATOR + canonicalJson(event minus event_hash)),
 * formatted `sha256:<64 hex>`. The expected hash is recomputed independently
 * from the documented recipe (not hardcoded as a magic string), so a mutation
 * to the domain separator, the canonicalization, or the stripping is killed.
 */

import { createHash } from 'crypto';
import { computeEventHash, type HashableEvent } from '../../src/evidence/hash';
import { canonicalJson } from '../../src/evidence/canonical-json';
import {
  DOMAIN_SEPARATOR,
  HASH_REGEX,
  type Actor,
  type ChainedEvent,
  type Hash,
} from '../../src/evidence/types';

const actor: Actor = { kind: 'agent', id: 'a1', session_id: 's1', platform: 'test' };

/** A not-yet-hashed event (EventBody + seq + prev_hash), the prepareAppend input shape. */
const baseEvent: HashableEvent = {
  event: 'test_recorded',
  ts: '2026-06-13T00:00:00.000Z',
  actor,
  spec_id: 'CAWS-TEST-KERNEL-PURE-001',
  data: { command: 'jest', exit_code: 0 },
  seq: 1,
  prev_hash: null,
};

/** Independent re-implementation of the documented recipe, for cross-check. */
function expectedHash(ev: HashableEvent): string {
  const { event_hash: _drop, ...rest } = ev as ChainedEvent;
  void _drop;
  const h = createHash('sha256');
  h.update(DOMAIN_SEPARATOR, 'utf8');
  h.update(canonicalJson(rest), 'utf8');
  return `sha256:${h.digest('hex')}`;
}

describe('computeEventHash: format + recipe', () => {
  test('output matches sha256:<64 hex> shape', () => {
    const hash = computeEventHash(baseEvent);
    expect(hash).toMatch(HASH_REGEX);
    expect(hash.startsWith('sha256:')).toBe(true);
  });

  test('matches the documented domain-separated recipe exactly', () => {
    expect(computeEventHash(baseEvent)).toBe(expectedHash(baseEvent));
  });

  test('the domain separator is load-bearing (hash differs from a no-separator hash)', () => {
    const { event_hash: _d, ...rest } = baseEvent as ChainedEvent;
    void _d;
    const withoutSeparator = `sha256:${createHash('sha256')
      .update(canonicalJson(rest), 'utf8')
      .digest('hex')}`;
    // If a mutation dropped DOMAIN_SEPARATOR, the hash would collapse to this.
    expect(computeEventHash(baseEvent)).not.toBe(withoutSeparator);
  });
});

describe('computeEventHash: purity + idempotency', () => {
  test('same input -> same hash, every call', () => {
    expect(computeEventHash(baseEvent)).toBe(computeEventHash(baseEvent));
  });

  test('different data -> different hash', () => {
    const other: HashableEvent = { ...baseEvent, data: { command: 'jest', exit_code: 1 } };
    expect(computeEventHash(other)).not.toBe(computeEventHash(baseEvent));
  });

  test('different seq -> different hash (seq is part of the claim)', () => {
    const other: HashableEvent = { ...baseEvent, seq: 2 };
    expect(computeEventHash(other)).not.toBe(computeEventHash(baseEvent));
  });

  test('different prev_hash -> different hash (chain link is part of the claim)', () => {
    const other: HashableEvent = {
      ...baseEvent,
      prev_hash: 'sha256:' + 'a'.repeat(64) as Hash,
    };
    expect(computeEventHash(other)).not.toBe(computeEventHash(baseEvent));
  });
});

describe('computeEventHash: event_hash stripping (re-hashing is idempotent)', () => {
  test('a fully-chained event re-hashes to the SAME value (event_hash is excluded)', () => {
    const computed = computeEventHash(baseEvent);
    const chained: ChainedEvent = {
      seq: baseEvent.seq,
      event: baseEvent.event,
      ts: baseEvent.ts,
      actor,
      spec_id: baseEvent.spec_id,
      data: baseEvent.data,
      prev_hash: baseEvent.prev_hash,
      event_hash: computed,
    };
    // Passing the stored event back in must reproduce the same hash.
    expect(computeEventHash(chained)).toBe(computed);
  });

  test('a WRONG stored event_hash does not change the recomputed hash', () => {
    const correct = computeEventHash(baseEvent);
    const tampered: ChainedEvent = {
      seq: baseEvent.seq,
      event: baseEvent.event,
      ts: baseEvent.ts,
      actor,
      spec_id: baseEvent.spec_id,
      data: baseEvent.data,
      prev_hash: baseEvent.prev_hash,
      event_hash: ('sha256:' + 'f'.repeat(64)) as Hash,
    };
    // Recompute ignores the stored (tampered) event_hash -> verifyChain can
    // detect the tamper because recompute != stored.
    expect(computeEventHash(tampered)).toBe(correct);
    expect(computeEventHash(tampered)).not.toBe(tampered.event_hash);
  });
});
