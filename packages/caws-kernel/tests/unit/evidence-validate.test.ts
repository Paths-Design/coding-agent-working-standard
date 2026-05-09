import {
  EVIDENCE_RULES,
  validateChainedEvent,
  validateEventBody,
  type Actor,
  type ChainedEvent,
  type EventBody,
  type EventType,
  type Hash,
} from '../../src/evidence';
import { isErr, isOk } from '../../src/result';

const HASH_A: Hash = ('sha256:' + 'a'.repeat(64)) as Hash;
const HASH_B: Hash = ('sha256:' + 'b'.repeat(64)) as Hash;

const goodActor: Actor = { kind: 'agent', id: 'darian', session_id: 'sess-1' };
const goodTs = '2026-05-08T00:00:00.000Z';

const goodSpecBody = (over: Partial<EventBody> = {}): EventBody => ({
  event: 'spec_created',
  ts: goodTs,
  actor: goodActor,
  spec_id: 'FOO-1',
  data: { title: 'Test feature', risk_tier: 2, mode: 'feature', lifecycle_state: 'draft' },
  ...over,
});

describe('validateEventBody — happy path', () => {
  it('accepts a well-formed REQUIRES_SPEC_ID body', () => {
    const r = validateEventBody(goodSpecBody());
    expect(isOk(r)).toBe(true);
  });

  it('accepts a well-formed NO_SPEC_ID body', () => {
    const r = validateEventBody({
      event: 'doctor_completed',
      ts: goodTs,
      actor: goodActor,
      data: { passed: true, checks_run: 3, drift_count: 0 },
    });
    expect(isOk(r)).toBe(true);
  });

  it('accepts an OPTIONAL_SPEC_ID body without spec_id', () => {
    const r = validateEventBody({
      event: 'commit_made',
      ts: goodTs,
      actor: goodActor,
      data: {},
    });
    expect(isOk(r)).toBe(true);
  });

  it('accepts an OPTIONAL_SPEC_ID body with spec_id', () => {
    const r = validateEventBody({
      event: 'commit_made',
      ts: goodTs,
      actor: goodActor,
      spec_id: 'FOO-1',
      data: {},
    });
    expect(isOk(r)).toBe(true);
  });
});

describe('validateEventBody — chain fields forbidden', () => {
  function expectFootgun(body: object) {
    const r = validateEventBody(body);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const rules = r.errors.map((e) => e.rule);
      expect(rules).toContain(EVIDENCE_RULES.EVENT_ENVELOPE_INVALID);
    }
  }

  it('rejects body with seq', () => {
    expectFootgun({ ...goodSpecBody(), seq: 1 });
  });

  it('rejects body with prev_hash', () => {
    expectFootgun({ ...goodSpecBody(), prev_hash: null });
  });

  it('rejects body with event_hash', () => {
    expectFootgun({ ...goodSpecBody(), event_hash: HASH_A });
  });
});

describe('validateEventBody — actor shape', () => {
  it('rejects missing actor', () => {
    const body = { ...goodSpecBody() } as Partial<EventBody>;
    delete body.actor;
    const r = validateEventBody(body);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.errors.map((e) => e.rule)).toContain(EVIDENCE_RULES.ACTOR_MISSING);
    }
  });

  it('rejects actor.kind outside the closed enum', () => {
    const r = validateEventBody({
      ...goodSpecBody(),
      actor: { kind: 'cron' as never, id: 'x' },
    });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.errors.map((e) => e.rule)).toContain(EVIDENCE_RULES.ACTOR_KIND_INVALID);
    }
  });

  it('rejects empty actor.id', () => {
    const r = validateEventBody({
      ...goodSpecBody(),
      actor: { kind: 'agent', id: '' },
    });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.errors.map((e) => e.rule)).toContain(EVIDENCE_RULES.ACTOR_ID_EMPTY);
    }
  });

  it('rejects empty actor.session_id when present', () => {
    const r = validateEventBody({
      ...goodSpecBody(),
      actor: { kind: 'agent', id: 'x', session_id: '' },
    });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.errors.map((e) => e.rule)).toContain(EVIDENCE_RULES.ACTOR_SESSION_ID_EMPTY);
    }
  });

  it('rejects empty actor.platform when present', () => {
    const r = validateEventBody({
      ...goodSpecBody(),
      actor: { kind: 'agent', id: 'x', platform: '' },
    });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.errors.map((e) => e.rule)).toContain(EVIDENCE_RULES.ACTOR_PLATFORM_EMPTY);
    }
  });

  it('accepts each actor.kind value', () => {
    const kinds: Actor['kind'][] = ['human', 'agent', 'system', 'automation'];
    for (const kind of kinds) {
      const r = validateEventBody({
        ...goodSpecBody(),
        actor: { kind, id: 'x' },
      });
      expect(isOk(r)).toBe(true);
    }
  });
});

describe('validateEventBody — spec_id class enforcement', () => {
  it('REQUIRES_SPEC_ID without spec_id → spec_id_required', () => {
    const body = { ...goodSpecBody() } as Partial<EventBody>;
    delete body.spec_id;
    const r = validateEventBody(body);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.errors.map((e) => e.rule)).toContain(EVIDENCE_RULES.EVENT_SPEC_ID_REQUIRED);
    }
  });

  it('REQUIRES_SPEC_ID with whitespace-only spec_id → spec_id_required', () => {
    const r = validateEventBody({ ...goodSpecBody(), spec_id: '   ' });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.errors.map((e) => e.rule)).toContain(EVIDENCE_RULES.EVENT_SPEC_ID_REQUIRED);
    }
  });

  it('NO_SPEC_ID with spec_id → spec_id_forbidden', () => {
    const r = validateEventBody({
      event: 'session_started',
      ts: goodTs,
      actor: goodActor,
      spec_id: 'FOO-1',
      data: {},
    });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.errors.map((e) => e.rule)).toContain(EVIDENCE_RULES.EVENT_SPEC_ID_FORBIDDEN);
    }
  });

  it('spec_id with bad shape → spec_id_invalid', () => {
    const r = validateEventBody({ ...goodSpecBody(), spec_id: 'lowercase-1' });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.errors.map((e) => e.rule)).toContain(EVIDENCE_RULES.EVENT_SPEC_ID_INVALID);
    }
  });
});

describe('validateEventBody — payload schemas (per type)', () => {
  it('rejects spec_created with missing required title', () => {
    const r = validateEventBody({
      ...goodSpecBody(),
      data: { risk_tier: 2, mode: 'feature', lifecycle_state: 'draft' },
    });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.errors.map((e) => e.rule)).toContain(EVIDENCE_RULES.EVENT_PAYLOAD_INVALID);
    }
  });

  it('rejects spec_created with bad mode enum', () => {
    const r = validateEventBody({
      ...goodSpecBody(),
      data: { title: 'X', risk_tier: 2, mode: 'development', lifecycle_state: 'draft' },
    });
    expect(isErr(r)).toBe(true);
  });

  it('accepts events without per-type payload schema (data: any object)', () => {
    // session_started has no payload schema — accepts {} freely.
    const r = validateEventBody({
      event: 'session_started',
      ts: goodTs,
      actor: goodActor,
      data: { arbitrary: 'thing' },
    });
    expect(isOk(r)).toBe(true);
  });

  it('rejects missing data field entirely', () => {
    const body = { ...goodSpecBody() } as Partial<EventBody>;
    delete body.data;
    const r = validateEventBody(body);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.errors.map((e) => e.rule)).toContain(EVIDENCE_RULES.EVENT_DATA_MISSING);
    }
  });
});

describe('validateEventBody — vocabulary', () => {
  it('rejects unknown event type', () => {
    const r = validateEventBody({
      event: 'spec_unicorn',
      ts: goodTs,
      actor: goodActor,
      data: {},
    });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.errors.map((e) => e.rule)).toContain(EVIDENCE_RULES.EVENT_UNKNOWN_TYPE);
    }
  });

  it('rejects bad ts format', () => {
    const r = validateEventBody({
      event: 'doctor_completed',
      ts: '2026-05-08',
      actor: goodActor,
      data: { passed: true, checks_run: 0, drift_count: 0 },
    });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.errors.map((e) => e.rule)).toContain(EVIDENCE_RULES.EVENT_TIMESTAMP_INVALID);
    }
  });
});

describe('validateChainedEvent — happy path', () => {
  function makeChained(over: Partial<ChainedEvent> = {}): ChainedEvent {
    return {
      seq: 1,
      event: 'doctor_completed' as EventType,
      ts: goodTs,
      actor: goodActor,
      data: { passed: true, checks_run: 0, drift_count: 0 },
      prev_hash: null,
      event_hash: HASH_A,
      ...over,
    };
  }

  it('accepts a structurally valid genesis event', () => {
    const r = validateChainedEvent(makeChained());
    expect(isOk(r)).toBe(true);
  });

  it('accepts a structurally valid non-genesis event', () => {
    const r = validateChainedEvent(makeChained({ seq: 2, prev_hash: HASH_B }));
    expect(isOk(r)).toBe(true);
  });
});

describe('validateChainedEvent — chain field shape', () => {
  function bad(over: Record<string, unknown>) {
    const base = {
      seq: 1,
      event: 'doctor_completed',
      ts: goodTs,
      actor: goodActor,
      data: { passed: true, checks_run: 0, drift_count: 0 },
      prev_hash: null,
      event_hash: HASH_A,
    };
    return validateChainedEvent({ ...base, ...over });
  }

  it('rejects malformed event_hash', () => {
    const r = bad({ event_hash: 'not-a-hash' });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.errors.map((e) => e.rule)).toContain(EVIDENCE_RULES.CHAIN_EVENT_HASH_MALFORMED);
    }
  });

  it('rejects malformed prev_hash', () => {
    const r = bad({ prev_hash: 'sha256:nothex' });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.errors.map((e) => e.rule)).toContain(EVIDENCE_RULES.CHAIN_PREV_HASH_MALFORMED);
    }
  });
});
