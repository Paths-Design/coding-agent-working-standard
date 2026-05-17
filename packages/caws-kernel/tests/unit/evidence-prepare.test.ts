import {
  EVIDENCE_RULES,
  HASH_REGEX,
  computeEventHash,
  prepareAppend,
  type ChainedEvent,
  type EventBody,
  type Hash,
} from '../../src/evidence';
import { isErr, isOk } from '../../src/result';

const goodTs = '2026-05-08T00:00:00.000Z';
const goodTs2 = '2026-05-08T00:00:01.000Z';

const specCreatedBody = (over: Partial<EventBody> = {}): EventBody => ({
  event: 'spec_created',
  ts: goodTs,
  actor: { kind: 'agent', id: 'darian', session_id: 'sess-1' },
  spec_id: 'FOO-1',
  data: { title: 'Test feature', risk_tier: 2, mode: 'feature', lifecycle_state: 'draft' },
  ...over,
});

describe('prepareAppend — genesis', () => {
  it('produces seq=1 and prev_hash=null for null prev', () => {
    const r = prepareAppend(null, specCreatedBody());
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.seq).toBe(1);
      expect(r.value.prev_hash).toBeNull();
      expect(r.value.event_hash).toMatch(HASH_REGEX);
    }
  });

  it('genesis is deterministic — same body twice → same event_hash', () => {
    const a = prepareAppend(null, specCreatedBody());
    const b = prepareAppend(null, specCreatedBody());
    expect(isOk(a) && isOk(b)).toBe(true);
    if (isOk(a) && isOk(b)) {
      expect(a.value.event_hash).toBe(b.value.event_hash);
    }
  });
});

describe('prepareAppend — chained', () => {
  it('seq increments and prev_hash links to predecessor', () => {
    const g = prepareAppend(null, specCreatedBody());
    expect(isOk(g)).toBe(true);
    if (!isOk(g)) return;

    const next = prepareAppend(
      g.value,
      specCreatedBody({ ts: goodTs2, spec_id: 'FOO-2' })
    );
    expect(isOk(next)).toBe(true);
    if (isOk(next)) {
      expect(next.value.seq).toBe(2);
      expect(next.value.prev_hash).toBe(g.value.event_hash);
      expect(next.value.event_hash).toMatch(HASH_REGEX);
      expect(next.value.event_hash).not.toBe(g.value.event_hash);
    }
  });

  it('event_hash agrees with computeEventHash(prepared)', () => {
    const g = prepareAppend(null, specCreatedBody());
    if (!isOk(g)) throw new Error('genesis failed');
    const expected = computeEventHash(g.value);
    expect(g.value.event_hash).toBe(expected);
  });
});

describe('prepareAppend — body validation', () => {
  it('forwards body validation errors verbatim', () => {
    const r = prepareAppend(null, {
      // missing actor
      event: 'spec_created',
      ts: goodTs,
      spec_id: 'FOO-1',
      data: { title: 'X', risk_tier: 2, mode: 'feature', lifecycle_state: 'draft' },
    });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.errors.map((e) => e.rule)).toContain(EVIDENCE_RULES.ACTOR_MISSING);
    }
  });

  it('rejects caller-supplied seq on the body', () => {
    const r = prepareAppend(null, {
      ...specCreatedBody(),
      seq: 99,
    } as unknown as EventBody);
    expect(isErr(r)).toBe(true);
  });
});

describe('prepareAppend — prev shape', () => {
  it('rejects prev with non-integer seq', () => {
    const fakePrev = {
      seq: 1.5,
      event: 'spec_created',
      ts: goodTs,
      actor: { kind: 'agent', id: 'x' },
      data: {},
      prev_hash: null,
      event_hash: ('sha256:' + 'a'.repeat(64)) as Hash,
    } as unknown as ChainedEvent;
    const r = prepareAppend(fakePrev, specCreatedBody());
    expect(isErr(r)).toBe(true);
  });

  it('rejects prev with malformed event_hash', () => {
    const fakePrev = {
      seq: 1,
      event: 'spec_created',
      ts: goodTs,
      actor: { kind: 'agent', id: 'x' },
      data: {},
      prev_hash: null,
      event_hash: 'not-a-hash',
    } as unknown as ChainedEvent;
    const r = prepareAppend(fakePrev, specCreatedBody());
    expect(isErr(r)).toBe(true);
  });
});

describe('prepareAppend — spec_id omission semantics', () => {
  it('OPTIONAL_SPEC_ID without spec_id omits the field from the chained event', () => {
    const r = prepareAppend(null, {
      event: 'commit_made',
      ts: goodTs,
      actor: { kind: 'agent', id: 'x' },
      data: {},
    });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(Object.prototype.hasOwnProperty.call(r.value, 'spec_id')).toBe(false);
      expect(r.value.spec_id).toBeUndefined();
    }
  });

  it('OPTIONAL_SPEC_ID with spec_id includes it', () => {
    const r = prepareAppend(null, {
      event: 'commit_made',
      ts: goodTs,
      actor: { kind: 'agent', id: 'x' },
      spec_id: 'FOO-1',
      data: {},
    });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.spec_id).toBe('FOO-1');
    }
  });

  it('two events that differ only in spec_id presence have different hashes', () => {
    const a = prepareAppend(null, {
      event: 'commit_made',
      ts: goodTs,
      actor: { kind: 'agent', id: 'x' },
      data: {},
    });
    const b = prepareAppend(null, {
      event: 'commit_made',
      ts: goodTs,
      actor: { kind: 'agent', id: 'x' },
      spec_id: 'FOO-1',
      data: {},
    });
    expect(isOk(a) && isOk(b)).toBe(true);
    if (isOk(a) && isOk(b)) {
      expect(a.value.event_hash).not.toBe(b.value.event_hash);
    }
  });
});
