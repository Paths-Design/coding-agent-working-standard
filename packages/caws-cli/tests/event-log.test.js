/**
 * Event Log Unit Tests (EVLOG-001 Phase 1)
 *
 * Covers the appendEvent contract, chain continuity, fail-loud validation
 * of required spec_id, partial-line tolerance in readEvents, and the
 * verifyChain helper used by the parity test.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  appendEvent,
  appendEventSync,
  readEvents,
  verifyChain,
  _internal,
} = require('../src/utils/event-log');

const { canonicalJson, computeEventHash, HASH_DOMAIN } = _internal;

let tmpDir;
let eventsPath;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-evlog-test-'));
  fs.mkdirSync(path.join(tmpDir, '.caws'), { recursive: true });
  eventsPath = path.join(tmpDir, '.caws', 'events.jsonl');
});

afterEach(() => {
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// canonicalJson — the foundation of reproducible hashing
// ---------------------------------------------------------------------------

describe('canonicalJson', () => {
  test('sorts keys alphabetically regardless of insertion order', () => {
    const a = { foo: 1, bar: 2, baz: 3 };
    const b = { baz: 3, bar: 2, foo: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe('{"bar":2,"baz":3,"foo":1}');
  });

  test('recurses into nested objects and arrays', () => {
    const obj = {
      outer: { z: 1, a: 2 },
      arr: [{ y: 1, x: 2 }, 3, 'four'],
    };
    expect(canonicalJson(obj)).toBe(
      '{"arr":[{"x":2,"y":1},3,"four"],"outer":{"a":2,"z":1}}'
    );
  });

  test('serializes primitives predictably', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(true)).toBe('true');
    expect(canonicalJson(false)).toBe('false');
    expect(canonicalJson(42)).toBe('42');
    expect(canonicalJson('hello')).toBe('"hello"');
  });

  test('throws on non-finite numbers', () => {
    expect(() => canonicalJson(NaN)).toThrow(/non-finite/);
    expect(() => canonicalJson(Infinity)).toThrow(/non-finite/);
  });
});

// ---------------------------------------------------------------------------
// computeEventHash — hash is stable, excludes event_hash, uses domain
// ---------------------------------------------------------------------------

describe('computeEventHash', () => {
  test('excludes the event_hash field from its own computation', () => {
    const event = { seq: 1, event: 'spec_created', data: { id: 'X-001' } };
    const hashA = computeEventHash(event);
    const hashB = computeEventHash({ ...event, event_hash: 'sha256:stale' });
    expect(hashA).toBe(hashB);
  });

  test('changes when any field changes', () => {
    const base = { seq: 1, event: 'spec_created', data: { id: 'X-001' } };
    expect(computeEventHash(base)).not.toBe(
      computeEventHash({ ...base, seq: 2 })
    );
    expect(computeEventHash(base)).not.toBe(
      computeEventHash({ ...base, data: { id: 'X-002' } })
    );
  });

  test('is domain-separated to avoid collision with other sha256 streams', () => {
    // Two different domains over the same payload must produce different hashes.
    // We can't directly swap the domain (it's a const) but we can verify that
    // our hash is not equal to a raw sha256 of the canonical JSON.
    const crypto = require('crypto');
    const event = { seq: 1, event: 'spec_created' };
    const raw = crypto
      .createHash('sha256')
      .update(canonicalJson(event))
      .digest('hex');
    expect(computeEventHash(event)).not.toBe('sha256:' + raw);
  });

  test('uses the declared HASH_DOMAIN', () => {
    // Reproduce the hash manually to pin the domain string in tests.
    const crypto = require('crypto');
    const event = { seq: 1, event: 'spec_created' };
    const expected =
      'sha256:' +
      crypto
        .createHash('sha256')
        .update(HASH_DOMAIN)
        .update('\x00')
        .update(canonicalJson(event))
        .digest('hex');
    expect(computeEventHash(event)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// appendEvent — genesis, continuation, contract enforcement
// ---------------------------------------------------------------------------

describe('appendEvent — genesis and continuation', () => {
  test('writes a genesis event with seq=1 and empty prev_hash', async () => {
    const result = await appendEvent(
      {
        actor: 'cli',
        event: 'spec_created',
        spec_id: 'TEST-001',
        data: { id: 'TEST-001', type: 'feature', title: 'Test', risk_tier: 3, mode: 'development' },
      },
      { projectRoot: tmpDir }
    );

    expect(result.seq).toBe(1);
    expect(result.prev_hash).toBe('');
    expect(result.event_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(fs.existsSync(eventsPath)).toBe(true);
  });

  test('second event has seq=2 and prev_hash linking to genesis', async () => {
    const first = await appendEvent(
      { actor: 'cli', event: 'spec_created', spec_id: 'TEST-001', data: { id: 'TEST-001' } },
      { projectRoot: tmpDir }
    );
    const second = await appendEvent(
      {
        actor: 'cli',
        event: 'validation_completed',
        spec_id: 'TEST-001',
        data: { passed: true, compliance_score: 90, grade: 'A', error_count: 0, warning_count: 0 },
      },
      { projectRoot: tmpDir }
    );

    expect(second.seq).toBe(2);
    expect(second.prev_hash).toBe(first.event_hash);
    expect(second.event_hash).not.toBe(first.event_hash);
  });

  test('multiple appends produce a contiguous chain verifiable end-to-end', async () => {
    for (let i = 0; i < 5; i++) {
      await appendEvent(
        {
          actor: 'cli',
          event: 'validation_completed',
          spec_id: 'TEST-001',
          data: { passed: true, error_count: 0, warning_count: 0, iter: i },
        },
        { projectRoot: tmpDir }
      );
    }

    const chainResult = verifyChain({ projectRoot: tmpDir });
    expect(chainResult.ok).toBe(true);
    expect(chainResult.count).toBe(5);
  });

  test('written event has seq, ts, session_id, actor, event, data, prev_hash, event_hash', async () => {
    await appendEvent(
      {
        actor: 'hook',
        event: 'session_started',
        data: { session_id: 'sess-123', role: 'worker', branch: 'main', head_rev: 'abcdef' },
      },
      { projectRoot: tmpDir, session_id: 'sess-123' }
    );

    const events = readEvents({ projectRoot: tmpDir });
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e.seq).toBe(1);
    expect(typeof e.ts).toBe('string');
    expect(e.session_id).toBe('sess-123');
    expect(e.actor).toBe('hook');
    expect(e.event).toBe('session_started');
    expect(e.data).toEqual({ session_id: 'sess-123', role: 'worker', branch: 'main', head_rev: 'abcdef' });
    expect(e.prev_hash).toBe('');
    expect(e.event_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test('omits spec_id from the written event when not provided for optional-spec events', async () => {
    await appendEvent(
      { actor: 'cli', event: 'session_started', data: {} },
      { projectRoot: tmpDir }
    );
    const events = readEvents({ projectRoot: tmpDir });
    expect(events[0]).not.toHaveProperty('spec_id');
  });
});

// ---------------------------------------------------------------------------
// appendEvent — fail-loud contract
// ---------------------------------------------------------------------------

describe('appendEvent — contract enforcement', () => {
  test('throws when event type requires spec_id and it is undefined', async () => {
    await expect(
      appendEvent(
        { actor: 'cli', event: 'validation_completed', data: { passed: true } },
        { projectRoot: tmpDir }
      )
    ).rejects.toThrow(/requires a non-empty spec_id/);
    expect(fs.existsSync(eventsPath)).toBe(false);
  });

  test('throws when spec_id is null', async () => {
    await expect(
      appendEvent(
        { actor: 'cli', event: 'spec_created', spec_id: null, data: { id: null } },
        { projectRoot: tmpDir }
      )
    ).rejects.toThrow(/requires a non-empty spec_id/);
    expect(fs.existsSync(eventsPath)).toBe(false);
  });

  test('throws when spec_id is an empty string', async () => {
    await expect(
      appendEvent(
        { actor: 'cli', event: 'spec_closed', spec_id: '', data: {} },
        { projectRoot: tmpDir }
      )
    ).rejects.toThrow(/requires a non-empty spec_id/);
    expect(fs.existsSync(eventsPath)).toBe(false);
  });

  test('throws when spec_id is whitespace-only', async () => {
    await expect(
      appendEvent(
        { actor: 'cli', event: 'spec_deleted', spec_id: '   ', data: {} },
        { projectRoot: tmpDir }
      )
    ).rejects.toThrow(/requires a non-empty spec_id/);
    expect(fs.existsSync(eventsPath)).toBe(false);
  });

  test('throws when actor is missing', async () => {
    await expect(
      appendEvent({ event: 'session_started', data: {} }, { projectRoot: tmpDir })
    ).rejects.toThrow(/`actor` is required/);
  });

  test('throws when event is missing', async () => {
    await expect(
      appendEvent({ actor: 'cli', data: {} }, { projectRoot: tmpDir })
    ).rejects.toThrow(/`event` is required/);
  });

  test('error message mentions the fence purpose', async () => {
    // Future maintainers must not swallow this. The message is part of the contract.
    await expect(
      appendEvent(
        { actor: 'cli', event: 'validation_completed', data: { passed: true } },
        { projectRoot: tmpDir }
      )
    ).rejects.toThrow(/undefined\.json/);
  });

  test('allows optional-spec events to omit spec_id without throwing', async () => {
    await expect(
      appendEvent(
        { actor: 'cli', event: 'session_started', data: { session_id: 's1' } },
        { projectRoot: tmpDir }
      )
    ).resolves.toMatchObject({ seq: 1 });
  });
});

// ---------------------------------------------------------------------------
// readEvents — tolerance and round-trip
// ---------------------------------------------------------------------------

describe('readEvents', () => {
  test('returns [] when the log does not exist', () => {
    expect(readEvents({ projectRoot: tmpDir })).toEqual([]);
  });

  test('round-trips a sequence of appends', async () => {
    for (let i = 0; i < 3; i++) {
      await appendEvent(
        {
          actor: 'cli',
          event: 'validation_completed',
          spec_id: 'TEST-001',
          data: { passed: true, iter: i },
        },
        { projectRoot: tmpDir }
      );
    }
    const events = readEvents({ projectRoot: tmpDir });
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(events.map((e) => e.data.iter)).toEqual([0, 1, 2]);
  });

  test('tolerates a partial trailing line (simulated crash mid-write)', async () => {
    await appendEvent(
      { actor: 'cli', event: 'validation_completed', spec_id: 'TEST-001', data: { passed: true } },
      { projectRoot: tmpDir }
    );
    // Append a partial line as if a writer crashed.
    fs.appendFileSync(eventsPath, '{"seq":2,"event":"partial"');

    const events = readEvents({ projectRoot: tmpDir });
    expect(events).toHaveLength(1);
    expect(events[0].seq).toBe(1);
  });

  test('strict mode throws on partial trailing line', async () => {
    await appendEvent(
      { actor: 'cli', event: 'validation_completed', spec_id: 'TEST-001', data: { passed: true } },
      { projectRoot: tmpDir }
    );
    fs.appendFileSync(eventsPath, '{"broken":');
    expect(() => readEvents({ projectRoot: tmpDir, strict: true })).toThrow(/partial/);
  });

  test('throws on malformed interior line (not just trailing)', async () => {
    fs.writeFileSync(eventsPath, '{"seq":1,"event":"ok"}\n{"broken\n{"seq":3}\n');
    expect(() => readEvents({ projectRoot: tmpDir })).toThrow(/malformed line/);
  });
});

// ---------------------------------------------------------------------------
// appendEvent — corrupt tail fails loud
// ---------------------------------------------------------------------------

describe('appendEvent — corrupt tail handling', () => {
  test('throws when the last line of the log is malformed', async () => {
    fs.writeFileSync(eventsPath, '{"seq":1,"event":"ok"}\n{not valid json\n');
    await expect(
      appendEvent(
        { actor: 'cli', event: 'validation_completed', spec_id: 'TEST-001', data: { passed: true } },
        { projectRoot: tmpDir }
      )
    ).rejects.toThrow(/last line.*malformed/);
  });

  test('throws when the last event has no integer seq', async () => {
    fs.writeFileSync(eventsPath, '{"seq":"not-a-number","event":"ok"}\n');
    await expect(
      appendEvent(
        { actor: 'cli', event: 'validation_completed', spec_id: 'TEST-001', data: { passed: true } },
        { projectRoot: tmpDir }
      )
    ).rejects.toThrow(/missing integer seq/);
  });
});

// ---------------------------------------------------------------------------
// verifyChain — end-to-end validation
// ---------------------------------------------------------------------------

describe('verifyChain', () => {
  test('returns ok:true on a clean chain', async () => {
    for (let i = 0; i < 3; i++) {
      await appendEvent(
        { actor: 'cli', event: 'validation_completed', spec_id: 'T-001', data: { iter: i } },
        { projectRoot: tmpDir }
      );
    }
    expect(verifyChain({ projectRoot: tmpDir })).toEqual({ ok: true, count: 3 });
  });

  test('detects event_hash tampering', async () => {
    await appendEvent(
      { actor: 'cli', event: 'validation_completed', spec_id: 'T-001', data: { passed: true } },
      { projectRoot: tmpDir }
    );
    // Tamper with the single event: rewrite with mutated data but preserve the hash.
    const content = fs.readFileSync(eventsPath, 'utf8');
    const tampered = content.replace('"passed":true', '"passed":false');
    fs.writeFileSync(eventsPath, tampered);

    const result = verifyChain({ projectRoot: tmpDir });
    expect(result.ok).toBe(false);
    expect(result.firstBadSeq).toBe(1);
    expect(result.reason).toMatch(/event_hash mismatch/);
  });

  test('detects prev_hash mismatch', async () => {
    await appendEvent(
      { actor: 'cli', event: 'validation_completed', spec_id: 'T-001', data: { iter: 0 } },
      { projectRoot: tmpDir }
    );
    await appendEvent(
      { actor: 'cli', event: 'validation_completed', spec_id: 'T-001', data: { iter: 1 } },
      { projectRoot: tmpDir }
    );
    // Corrupt the prev_hash of the second event — we need to rebuild the event_hash
    // to match the mutated body, otherwise the event_hash check would fire first.
    const lines = fs.readFileSync(eventsPath, 'utf8').trim().split('\n');
    const second = JSON.parse(lines[1]);
    second.prev_hash = 'sha256:deadbeef' + '0'.repeat(56);
    second.event_hash = computeEventHash(second);
    lines[1] = JSON.stringify(second);
    fs.writeFileSync(eventsPath, lines.join('\n') + '\n');

    const result = verifyChain({ projectRoot: tmpDir });
    expect(result.ok).toBe(false);
    expect(result.firstBadSeq).toBe(2);
    expect(result.reason).toMatch(/prev_hash mismatch/);
  });
});

// ---------------------------------------------------------------------------
// appendEventSync — parity with async variant
// ---------------------------------------------------------------------------

describe('appendEventSync', () => {
  test('writes an event with the same shape as the async variant', () => {
    const result = appendEventSync(
      { actor: 'cli', event: 'session_started', data: { session_id: 's-sync', role: 'worker' } },
      { projectRoot: tmpDir, session_id: 's-sync' }
    );
    expect(result.seq).toBe(1);
    expect(result.prev_hash).toBe('');
    expect(result.event_hash).toMatch(/^sha256:[0-9a-f]{64}$/);

    const events = readEvents({ projectRoot: tmpDir });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      seq: 1,
      actor: 'cli',
      event: 'session_started',
      session_id: 's-sync',
    });
  });

  test('continues the chain started by an async appendEvent', async () => {
    const async1 = await appendEvent(
      { actor: 'cli', event: 'validation_completed', spec_id: 'T-001', data: { passed: true } },
      { projectRoot: tmpDir }
    );
    const sync2 = appendEventSync(
      { actor: 'cli', event: 'session_ended', data: { session_id: 's2', files_touched: ['a.js'] } },
      { projectRoot: tmpDir }
    );
    expect(sync2.seq).toBe(2);
    expect(sync2.prev_hash).toBe(async1.event_hash);
    expect(verifyChain({ projectRoot: tmpDir }).ok).toBe(true);
  });

  test('enforces the same spec_id contract as the async variant', () => {
    expect(() =>
      appendEventSync(
        { actor: 'cli', event: 'validation_completed', data: { passed: true } },
        { projectRoot: tmpDir }
      )
    ).toThrow(/requires a non-empty spec_id/);
    expect(fs.existsSync(eventsPath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Concurrent writer correctness (sanity, not a full fuzz)
// ---------------------------------------------------------------------------

describe('appendEvent — concurrent writes', () => {
  test('two concurrent appendEvent calls produce a well-formed chain', async () => {
    // Fire N appends in parallel from the same process. The lock should
    // serialize them within one process; the result must verify.
    const N = 20;
    const tasks = [];
    for (let i = 0; i < N; i++) {
      tasks.push(
        appendEvent(
          {
            actor: 'cli',
            event: 'validation_completed',
            spec_id: 'T-001',
            data: { iter: i },
          },
          { projectRoot: tmpDir }
        )
      );
    }
    await Promise.all(tasks);

    const events = readEvents({ projectRoot: tmpDir });
    expect(events).toHaveLength(N);
    // seqs must be 1..N in file order (the lock guarantees serialization).
    expect(events.map((e) => e.seq)).toEqual(Array.from({ length: N }, (_, i) => i + 1));
    expect(verifyChain({ projectRoot: tmpDir }).ok).toBe(true);
  });
});
