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

  // chain_rotated — see CAWS-MIGRATE-V10-EVENTS-001 A3. The payload
  // is evidentiary, not decorative: it must cite the prior tail hash,
  // archive path, archive sha256 digest, prior line count, chain
  // status, actor-shape stats, and migration reason. Every required
  // field is enforced by the AJV schema; the tests below pin the
  // contract so a future schema edit cannot silently weaken it.

  const goodChainRotatedData = () => ({
    prior_tail_hash: HASH_A,
    prior_file_path: 'events.jsonl.archive-2026-05-22T23-15-00-000Z',
    prior_file_digest: HASH_B,
    prior_line_count: 3,
    prior_chain_status: 'parseable_unverified',
    actor_shape_stats: { v10_string_actor: 3, v11_object_actor: 0, unparseable: 0 },
    migration_reason: 'v10 → v11 migration smoke',
  });

  const goodChainRotatedBody = (over: Partial<EventBody> = {}): EventBody => ({
    event: 'chain_rotated',
    ts: goodTs,
    actor: goodActor,
    data: goodChainRotatedData(),
    ...over,
  });

  it('accepts a fully-valid chain_rotated body', () => {
    const r = validateEventBody(goodChainRotatedBody());
    expect(isOk(r)).toBe(true);
  });

  it('accepts chain_rotated with optional prior_seq', () => {
    const r = validateEventBody(
      goodChainRotatedBody({
        data: { ...goodChainRotatedData(), prior_seq: 3 },
      })
    );
    expect(isOk(r)).toBe(true);
  });

  it('rejects chain_rotated missing prior_file_digest', () => {
    const { prior_file_digest: _omit, ...partial } = goodChainRotatedData();
    const r = validateEventBody(goodChainRotatedBody({ data: partial }));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.errors.map((e) => e.rule)).toContain(EVIDENCE_RULES.EVENT_PAYLOAD_INVALID);
    }
  });

  it('rejects chain_rotated missing migration_reason', () => {
    const { migration_reason: _omit, ...partial } = goodChainRotatedData();
    const r = validateEventBody(goodChainRotatedBody({ data: partial }));
    expect(isErr(r)).toBe(true);
  });

  it('rejects chain_rotated with empty migration_reason', () => {
    const r = validateEventBody(
      goodChainRotatedBody({
        data: { ...goodChainRotatedData(), migration_reason: '' },
      })
    );
    expect(isErr(r)).toBe(true);
  });

  it('rejects chain_rotated with prior_chain_status outside the enum', () => {
    // 'verified' is deliberately excluded — v10 hashes cannot be
    // reverified under v11 code (different envelope shape).
    const r = validateEventBody(
      goodChainRotatedBody({
        data: { ...goodChainRotatedData(), prior_chain_status: 'verified' },
      })
    );
    expect(isErr(r)).toBe(true);
  });

  it('rejects chain_rotated with prior_file_digest not matching sha256 pattern', () => {
    const r = validateEventBody(
      goodChainRotatedBody({
        data: { ...goodChainRotatedData(), prior_file_digest: 'not-a-hash' },
      })
    );
    expect(isErr(r)).toBe(true);
  });

  it('rejects chain_rotated with additionalProperties on the data block', () => {
    const r = validateEventBody(
      goodChainRotatedBody({
        data: { ...goodChainRotatedData(), unexpected_field: 'nope' },
      })
    );
    expect(isErr(r)).toBe(true);
  });

  it('rejects chain_rotated with actor_shape_stats missing a count', () => {
    const r = validateEventBody(
      goodChainRotatedBody({
        data: {
          ...goodChainRotatedData(),
          actor_shape_stats: { v10_string_actor: 3, v11_object_actor: 0 },
        },
      })
    );
    expect(isErr(r)).toBe(true);
  });

  it('rejects chain_rotated carrying spec_id (NO_SPEC_ID class)', () => {
    const r = validateEventBody(
      goodChainRotatedBody({ spec_id: 'FOO-1' })
    );
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.errors.map((e) => e.rule)).toContain(
        EVIDENCE_RULES.EVENT_SPEC_ID_FORBIDDEN
      );
    }
  });

  it('accepts chain_rotated with prior_tail_hash null', () => {
    // Forward-compat: rotateEvents currently refuses against empty
    // prior chains, but the schema admits null prior_tail_hash for a
    // future policy that might rotate truly empty logs.
    const r = validateEventBody(
      goodChainRotatedBody({
        data: { ...goodChainRotatedData(), prior_tail_hash: null },
      })
    );
    expect(isOk(r)).toBe(true);
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
