import {
  DOMAIN_SEPARATOR,
  HASH_REGEX,
  computeEventHash,
  type ChainedEvent,
  type EventBody,
  type Hash,
} from '../../src/evidence';
import { createHash } from 'crypto';

const baseBody: EventBody = {
  event: 'spec_created',
  ts: '2026-05-08T00:00:00.000Z',
  actor: { kind: 'agent', id: 'test-agent', session_id: 'sess-1' },
  spec_id: 'FOO-1',
  data: { title: 'Test feature', risk_tier: 2, mode: 'feature', lifecycle_state: 'draft' },
};

describe('computeEventHash — format', () => {
  it('returns sha256:<64 lowercase hex>', () => {
    const h = computeEventHash({ ...baseBody, seq: 1, prev_hash: null });
    expect(h).toMatch(HASH_REGEX);
    expect(h.startsWith('sha256:')).toBe(true);
    expect(h.length).toBe('sha256:'.length + 64);
  });
});

describe('computeEventHash — determinism', () => {
  it('same input → same hash, every time', () => {
    const evt = { ...baseBody, seq: 1, prev_hash: null as Hash | null };
    const h1 = computeEventHash(evt);
    const h2 = computeEventHash(evt);
    expect(h1).toBe(h2);
  });

  it('insertion-order-equal events produce the same hash', () => {
    const a = { ...baseBody, seq: 1, prev_hash: null as Hash | null };
    const b: typeof a = {
      seq: 1,
      prev_hash: null,
      data: a.data,
      actor: a.actor,
      spec_id: a.spec_id,
      ts: a.ts,
      event: a.event,
    };
    expect(computeEventHash(a)).toBe(computeEventHash(b));
  });
});

describe('computeEventHash — exclusion of event_hash', () => {
  it('strips event_hash before hashing (idempotent re-hash)', () => {
    const partial = { ...baseBody, seq: 1, prev_hash: null as Hash | null };
    const h1 = computeEventHash(partial);

    const chained: ChainedEvent = { ...partial, event_hash: h1 };
    const h2 = computeEventHash(chained);

    expect(h2).toBe(h1);
  });
});

describe('computeEventHash — sensitivity (every field is hashed)', () => {
  function hashWith(overrides: Partial<EventBody & { seq: number; prev_hash: Hash | null }>): Hash {
    return computeEventHash({ ...baseBody, seq: 1, prev_hash: null, ...overrides });
  }

  const baseHash = hashWith({});

  it('event type changes the hash', () => {
    expect(hashWith({ event: 'spec_validated' })).not.toBe(baseHash);
  });

  it('ts changes the hash', () => {
    expect(hashWith({ ts: '2026-05-09T00:00:00.000Z' })).not.toBe(baseHash);
  });

  it('actor.id changes the hash', () => {
    expect(hashWith({ actor: { ...baseBody.actor, id: 'other' } })).not.toBe(baseHash);
  });

  it('actor.kind changes the hash', () => {
    expect(hashWith({ actor: { ...baseBody.actor, kind: 'human' } })).not.toBe(baseHash);
  });

  it('actor.session_id changes the hash', () => {
    expect(hashWith({ actor: { ...baseBody.actor, session_id: 'sess-2' } })).not.toBe(baseHash);
  });

  it('spec_id changes the hash', () => {
    expect(hashWith({ spec_id: 'BAR-2' })).not.toBe(baseHash);
  });

  it('data changes the hash', () => {
    expect(
      hashWith({
        data: { ...baseBody.data, title: 'Other title' },
      })
    ).not.toBe(baseHash);
  });

  it('seq changes the hash', () => {
    expect(hashWith({ seq: 2 })).not.toBe(baseHash);
  });

  it('prev_hash changes the hash', () => {
    expect(
      hashWith({
        prev_hash: ('sha256:' + 'a'.repeat(64)) as Hash,
      })
    ).not.toBe(baseHash);
  });
});

describe('computeEventHash — domain separator', () => {
  it('matches a manual sha256(DOMAIN_SEPARATOR + canonicalJson) computation', () => {
    // Reconstruct the algorithm independently to lock the contract.
    const partial = { ...baseBody, seq: 1, prev_hash: null as Hash | null };
    // Strip event_hash if present; partial doesn't have it so canonical JSON
    // of partial is what we hash.
    // Replicate canonical JSON of partial inline:
    // The canonicalJson sorts keys lexicographically.
    const expectedCanon =
      '{' +
      [
        '"actor":{"id":"test-agent","kind":"agent","session_id":"sess-1"}',
        '"data":{"lifecycle_state":"draft","mode":"feature","risk_tier":2,"title":"Test feature"}',
        '"event":"spec_created"',
        '"prev_hash":null',
        '"seq":1',
        '"spec_id":"FOO-1"',
        '"ts":"2026-05-08T00:00:00.000Z"',
      ].join(',') +
      '}';

    const h = createHash('sha256');
    h.update(DOMAIN_SEPARATOR, 'utf8');
    h.update(expectedCanon, 'utf8');
    const expected: Hash = `sha256:${h.digest('hex')}` as Hash;

    expect(computeEventHash(partial)).toBe(expected);
  });

  it('the same content WITHOUT the domain separator hashes differently', () => {
    const partial = { ...baseBody, seq: 1, prev_hash: null as Hash | null };
    const withSeparator = computeEventHash(partial);

    // Reconstruct the canonical JSON inline (must match exactly).
    const canon =
      '{' +
      [
        '"actor":{"id":"test-agent","kind":"agent","session_id":"sess-1"}',
        '"data":{"lifecycle_state":"draft","mode":"feature","risk_tier":2,"title":"Test feature"}',
        '"event":"spec_created"',
        '"prev_hash":null',
        '"seq":1',
        '"spec_id":"FOO-1"',
        '"ts":"2026-05-08T00:00:00.000Z"',
      ].join(',') +
      '}';

    const noSeparator = createHash('sha256').update(canon, 'utf8').digest('hex');
    expect(withSeparator).not.toBe(`sha256:${noSeparator}`);
  });
});
