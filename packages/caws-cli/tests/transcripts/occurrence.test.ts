import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createAdapterState,
  makeNormalizationContext,
  normalizeOccurrence,
  type CanonicalEvent,
  type LocatedEvent,
  type TranscriptAdapter,
} from '../../src/transcripts/harness-common';
import {
  getMember,
  jsonNumber,
  jsonObject,
  pythonJsonDumps,
  type JsonObject,
} from '../../src/transcripts/lossless-json';
import {
  decodeOccurrence,
  isParsedRow,
  type OccurrenceCoordinates,
  type ParsedRow,
} from '../../src/transcripts/source-occurrence';

function coords(
  occurrenceId = 'row-1',
  extra: Partial<OccurrenceCoordinates> = {}
): OccurrenceCoordinates {
  return {
    sourceId: 'stream-A',
    sourceGeneration: 'generation-1',
    occurrenceId,
    framing: 'complete',
    ...extra,
  };
}
function row(
  raw = '{}',
  occurrenceId = 'row-1',
  extra: Partial<OccurrenceCoordinates> = {}
): ParsedRow {
  return decodeOccurrence(Buffer.from(raw, 'utf8'), coords(occurrenceId, extra));
}
interface RichState {
  readonly seen: Set<string>;
  readonly times: Map<readonly [string, string], string>;
  readonly count: number;
}
const adapter: TranscriptAdapter<RichState> = {
  id: 'fixture',
  revision: 'reviewed-fixture-v1',
  matches: (raw) => getMember(raw, 'skip') !== true,
  createState: () => ({ seen: new Set(), times: new Map(), count: 0 }),
  cloneState: (state) => ({
    seen: new Set(state.seen),
    times: new Map([...state.times].map(([key, value]) => [[...key] as const, value])),
    count: state.count,
  }),
  normalize: (_raw, state) => {
    state.seen.add('observed');
    state.times.set(['turn', 'step'], 'timestamp');
    const events: LocatedEvent[] = [
      {
        event: {
          ev: 'tool_use',
          id: jsonNumber('9007199254740993'),
          name: 'Read',
          input: jsonObject([['path', 'a']]),
        },
        nativeMemberPath: ['payload', 'content', 1],
      },
      {
        event: { ev: 'assistant_text', text: 'same', source_harness: 'historical-value' },
        nativeMemberPath: ['payload', 'content', 3],
      },
    ];
    return { state: { ...state, count: state.count + 1 }, events };
  },
};
const context = () => makeNormalizationContext({}, [adapter]);

test('copies raw bytes and retains independently checkable identity without exposing a mutable buffer', () => {
  const raw = Buffer.from('{}');
  const decoded = decodeOccurrence(
    raw,
    coords('one', { byteOffset: 9007199254740993n, lineOrdinal: 1n })
  );
  raw.fill(0);
  assert.equal(decoded.disposition, 'parsed');
  assert.equal(decoded.source.rawBase64, 'e30=');
  assert.equal(
    decoded.source.sha256,
    '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a'
  );
  assert.equal(decoded.source.byteLength, 2);
  assert.equal(decoded.source.byteOffset, 9007199254740993n);
  assert.equal(decoded.source.lineOrdinal, 1n);
  assert.equal(decoded.source.coordinateAuthority, 'caller_asserted');
  assert.equal(
    Object.values(decoded.source).some((value) => value instanceof Uint8Array),
    false
  );
  assert.equal(Object.isFrozen(decoded), true);
  assert.equal(Object.isFrozen(decoded.source), true);
  assert.equal(isParsedRow(decoded), true);
  assert.equal(isParsedRow({ ...decoded }), false);
});

test('distinguishes invalid UTF-8, retained BOM, invalid JSON, non-object JSON, and partial framing', () => {
  const invalid = decodeOccurrence(
    Uint8Array.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]),
    coords()
  );
  assert.equal(invalid.disposition, 'invalid_utf8');
  assert.deepEqual(
    Buffer.from(invalid.source.rawBase64, 'base64'),
    Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d])
  );
  assert.equal(row('\ufeff{}').disposition, 'invalid_json');
  assert.equal(row('{').disposition, 'invalid_json');
  const scalar = row('9007199254740993');
  assert.equal(scalar.disposition, 'non_object');
  if (scalar.disposition !== 'non_object') throw new Error('expected scalar disposition');
  assert.equal(pythonJsonDumps(scalar.value), '9007199254740993');
  assert.equal(row('[]').disposition, 'non_object');
  assert.equal(row('null').disposition, 'non_object');
  assert.equal(row('{}', 'partial', { framing: 'partial' }).source.framing, 'partial');
  assert.equal(row('{}', 'partial', { framing: 'partial' }).disposition, 'parsed');
});

test('strips Python whitespace before parsing while retaining exact unstripped raw bytes and frozen AST', () => {
  const raw = '\u001c\u0085{"a":[{"n":9007199254740993}],"a":[2]}\u3000';
  const decoded = row(raw);
  assert.equal(decoded.disposition, 'parsed');
  if (decoded.disposition !== 'parsed') throw new Error('expected object');
  assert.equal(Buffer.from(decoded.source.rawBase64, 'base64').toString('utf8'), raw);
  assert.equal(pythonJsonDumps(decoded.row), '{"a": [2]}');
  assert.equal(Object.isFrozen(decoded.row), true);
  assert.equal(Object.isFrozen(decoded.row.entries), true);
  const value = getMember(decoded.row, 'a');
  assert.equal(Object.isFrozen(value), true);
  assert.throws(() => (decoded.row.entries as unknown as [string, unknown][]).push(['x', 1]));
});

test('preserves repeated equal content as distinct caller-labeled occurrences without certifying uniqueness', () => {
  const a = row('{}', 'occurrence-A', { byteOffset: 0n });
  const b = row('{}', 'occurrence-B', { byteOffset: 3n });
  assert.equal(a.source.sha256, b.source.sha256);
  assert.equal(a.source.rawBase64, b.source.rawBase64);
  assert.equal(a.source.occurrenceId, 'occurrence-A');
  assert.equal(b.source.occurrenceId, 'occurrence-B');
  assert.notEqual(a.source, b.source);
  assert.notEqual(a.source.byteOffset, b.source.byteOffset);
  // Cross-occurrence label uniqueness belongs to the caller, not this single-occurrence decoder.
  assert.equal(row('{}', 'occurrence-A').source.coordinateAuthority, 'caller_asserted');
});

test('refuses missing labels, malformed framing, and lossy numeric coordinates at ingress', () => {
  assert.throws(() => decodeOccurrence(Buffer.from('{}'), coords('')), TypeError);
  assert.throws(
    () => decodeOccurrence(Buffer.from('{}'), coords('x', { sourceId: '' })),
    TypeError
  );
  assert.throws(
    () => decodeOccurrence(Buffer.from('{}'), coords('x', { byteOffset: -1n })),
    TypeError
  );
  assert.throws(
    () => decodeOccurrence(Buffer.from('{}'), coords('x', { lineOrdinal: 1 as unknown as bigint })),
    TypeError
  );
  assert.throws(
    () => decodeOccurrence(Buffer.from('{}'), coords('x', { framing: 'unknown' as 'complete' })),
    TypeError
  );
});

test('preserves event order, native paths, occurrence multiplicity, and lossless tool IDs', () => {
  const ctx = context(),
    initial = createAdapterState(adapter, 'stream-A', 'generation-1', ctx);
  const first = normalizeOccurrence(row('{}', 'first'), initial, ctx, adapter);
  const second = normalizeOccurrence(row('{}', 'second'), first.nextState, ctx, adapter);
  assert.equal(first.disposition, 'normalized');
  assert.equal(first.commitAllowed, true);
  assert.deepEqual(
    first.events.map((event) => event.emissionIndex),
    [0, 1]
  );
  assert.deepEqual(
    first.events.map((event) => event.nativeMemberPath),
    [
      ['payload', 'content', 1],
      ['payload', 'content', 3],
    ]
  );
  assert.equal(pythonJsonDumps(first.events[0]!.event.id!), '9007199254740993');
  assert.equal(first.events[0]!.source.occurrenceId, 'first');
  assert.equal(second.events[0]!.source.occurrenceId, 'second');
  assert.equal(first.events.length, 2);
  assert.equal(second.events.length, 2);
  assert.equal(second.nextState.value.count, 2);
  assert.equal(initial.value.count, 0);
  assert.equal(initial.value.seen.size, 0);
  assert.equal(initial.value.times.size, 0);
  assert.equal(Object.isFrozen(first.events[0]!.nativeMemberPath), true);
  assert.equal(Object.isFrozen(first.events[0]!.event), true);
});

test('binds absent versus empty surface, cache generation, adapter order, and reviewed revision', () => {
  const absent = context(),
    state = createAdapterState(adapter, 'stream-A', 'generation-1', absent);
  const other = { id: 'other', revision: 'v1' };
  const contexts = [
    makeNormalizationContext({ surface: '' }, [adapter]),
    makeNormalizationContext({ cacheGeneration: '' }, [adapter]),
    makeNormalizationContext({ cacheGeneration: 'next' }, [adapter]),
    makeNormalizationContext({}, [{ ...adapter, revision: 'v2' }]),
    makeNormalizationContext({}, [adapter, other]),
  ];
  for (const changed of contexts) {
    const result = normalizeOccurrence(row(), state, changed, adapter);
    assert.equal(result.disposition, 'context_mismatch');
    assert.deepEqual(result.events, []);
    assert.equal(result.nextState, state);
    assert.equal(result.commitAllowed, false);
  }
  const ordered = makeNormalizationContext({}, [adapter, other]);
  const orderedState = createAdapterState(adapter, 'stream-A', 'generation-1', ordered);
  assert.equal(
    normalizeOccurrence(
      row(),
      orderedState,
      makeNormalizationContext({}, [other, adapter]),
      adapter
    ).disposition,
    'context_mismatch'
  );
  assert.equal(normalizeOccurrence(row(), state, context(), adapter).disposition, 'normalized');
  assert.deepEqual(absent.surface, { presence: 'absent' });
  assert.deepEqual(contexts[0]!.surface, { presence: 'present', value: '' });
  assert.throws(() => makeNormalizationContext({}, [adapter, adapter]), TypeError);
});

test('keeps source generations and independent streams separate rather than silently resetting state', () => {
  const ctx = context(),
    state = createAdapterState(adapter, 'stream-A', 'generation-1', ctx);
  for (const extra of [{ sourceId: 'stream-B' }, { sourceGeneration: 'generation-2' }]) {
    const result = normalizeOccurrence(row('{}', 'other', extra), state, ctx, adapter);
    assert.equal(result.disposition, 'source_mismatch');
    assert.equal(result.nextState, state);
    assert.deepEqual(result.events, []);
  }
  const b = createAdapterState(adapter, 'stream-B', 'generation-1', ctx);
  const aResult = normalizeOccurrence(row(), state, ctx, adapter);
  assert.equal(aResult.nextState.value.count, 1);
  assert.equal(b.value.count, 0);
  assert.equal(b.value.seen.size, 0);
  assert.equal(
    normalizeOccurrence(row('{}', 'b', { sourceId: 'stream-B' }), b, ctx, adapter).nextState.value
      .count,
    1
  );
  assert.equal(
    normalizeOccurrence(row(), state, ctx, { ...adapter, revision: 'unreviewed' }).disposition,
    'adapter_mismatch'
  );
});

test('clones adapter-specific Set and tuple Map state before a callback can mutate and throw', () => {
  const throwing: TranscriptAdapter<RichState> = {
    ...adapter,
    normalize: (_raw, state) => {
      state.seen.add('leak');
      state.times.set(['bad', 'step'], 'bad-time');
      for (const key of state.times.keys()) (key as [string, string])[0] = 'mutated';
      throw new Error('fixture failure after mutation');
    },
  };
  const ctx = context(),
    initial = createAdapterState(adapter, 'stream-A', 'generation-1', ctx);
  initial.value.times.set(['kept', 'step'], 'kept-time');
  const originalRow = row();
  assert.throws(
    () => normalizeOccurrence(originalRow, initial, ctx, throwing),
    new RegExp('fixture failure after mutation')
  );
  assert.equal(initial.value.seen.size, 0);
  assert.deepEqual([...initial.value.times], [[['kept', 'step'], 'kept-time']]);
  assert.equal(originalRow.source.rawBase64, 'e30=');
  assert.equal(initial.value.count, 0);
});

test('marks a parsed partial row tentative with an explicit prohibition on committing its state', () => {
  const ctx = context(),
    initial = createAdapterState(adapter, 'stream-A', 'generation-1', ctx);
  const partial = normalizeOccurrence(
    row('{}', 'partial', { framing: 'partial' }),
    initial,
    ctx,
    adapter
  );
  assert.equal(partial.disposition, 'normalized');
  assert.equal(partial.events.length, 2);
  assert.equal(partial.nextState.value.count, 1);
  assert.equal(partial.tentative, true);
  assert.equal(partial.commitAllowed, false);
  assert.equal(initial.value.count, 0);
});

test('returns explicit invalid/unmatched dispositions without invoking normalization or inventing events', () => {
  let calls = 0;
  const watched = {
    ...adapter,
    normalize: (raw: JsonObject, state: RichState) => {
      calls++;
      return adapter.normalize(raw, state);
    },
  };
  const ctx = context(),
    initial = createAdapterState(adapter, 'stream-A', 'generation-1', ctx);
  const cases = [
    row('{'),
    row('null'),
    decodeOccurrence(Uint8Array.from([0xff]), coords()),
    row('{"skip":true}'),
  ];
  assert.deepEqual(
    cases.map((input) => normalizeOccurrence(input, initial, ctx, watched).disposition),
    ['invalid_json', 'non_object', 'invalid_utf8', 'unmatched']
  );
  for (const input of cases) {
    const result = normalizeOccurrence(input, initial, ctx, watched);
    assert.deepEqual(result.events, []);
    assert.equal(result.original, input);
    assert.equal(result.nextState, initial);
    assert.equal(result.commitAllowed, false);
  }
  assert.equal(calls, 0);
  const forged = { ...row() } as ParsedRow;
  assert.throws(
    () => normalizeOccurrence(forged, initial, ctx, watched),
    new RegExp('decoded raw occurrence')
  );
});

test('retains matched zero-emission occurrences and their explicit state transitions', () => {
  const silent: TranscriptAdapter<RichState> = {
    ...adapter,
    normalize: (_raw, state) => ({ state: { ...state, count: state.count + 1 }, events: [] }),
  };
  const ctx = context(),
    initial = createAdapterState(silent, 'stream-A', 'generation-1', ctx);
  const source = row('{}', 'silent-row');
  const result = normalizeOccurrence(source, initial, ctx, silent);
  assert.equal(result.disposition, 'normalized');
  assert.equal(result.original, source);
  assert.equal(result.source.occurrenceId, 'silent-row');
  assert.deepEqual(result.events, []);
  assert.equal(result.nextState.value.count, 1);
  assert.equal(result.commitAllowed, true);
  assert.equal(initial.value.count, 0);
});

test('attributes only tool-use events with known surface identity and preserves unknown/absent context distinctions', () => {
  for (const surface of [undefined, '', 'unknown-surface', 'claude-code', 'opencode']) {
    const ctx = makeNormalizationContext(surface === undefined ? {} : { surface }, [adapter]);
    const initial = createAdapterState(adapter, 'stream-A', 'generation-1', ctx);
    const result = normalizeOccurrence(row(), initial, ctx, adapter);
    assert.equal(
      result.events[0]!.event.source_harness,
      surface === 'claude-code' ? 'claude' : surface === 'opencode' ? 'opencode' : 'fixture'
    );
    assert.equal(result.events[1]!.event.source_harness, 'historical-value');
    assert.deepEqual(
      ctx.surface,
      surface === undefined ? { presence: 'absent' } : { presence: 'present', value: surface }
    );
  }
});

test('refuses impossible native paths after normalization without mutating caller state', () => {
  const invalidPath = {
    ...adapter,
    normalize: (_raw: JsonObject, state: RichState) => ({
      state,
      events: [{ event: { ev: 'reasoning', text: 'x' } as CanonicalEvent, nativeMemberPath: [-1] }],
    }),
  };
  const ctx = context(),
    initial = createAdapterState(adapter, 'stream-A', 'generation-1', ctx);
  assert.throws(
    () => normalizeOccurrence(row(), initial, ctx, invalidPath),
    new RegExp('invalid native member path')
  );
  assert.equal(initial.value.count, 0);
});
