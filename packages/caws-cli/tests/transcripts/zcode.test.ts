import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  ZCODE_ADAPTER,
  ZCODE_ADAPTER_REVISION,
  ZCODE_NOISE_PREFIXES,
  createZcodeState,
  cloneZcodeState,
  matchesZcode,
  normalizeZcode,
  type ZcodeState,
} from '../../src/transcripts/harness-zcode';
import {
  getMember,
  isJsonObject,
  jsonObject,
  parsePythonJson,
  type JsonObject,
  type JsonValue,
} from '../../src/transcripts/lossless-json';
import {
  createAdapterState,
  makeNormalizationContext,
  normalizeOccurrence,
  type TranscriptAdapter,
} from '../../src/transcripts/harness-common';
import { decodeOccurrence } from '../../src/transcripts/source-occurrence';
import { UNICODE_PROFILE_ID } from '../../src/transcripts/python-unicode-profile';

function row(source: string): JsonObject {
  const value = parsePythonJson(source);
  assert.ok(isJsonObject(value));
  return value;
}
function events(source: string, state = createZcodeState()): JsonValue[] {
  return normalizeZcode(row(source), state).map(({ event }) =>
    jsonObject(
      Object.entries(event).filter((entry): entry is [string, JsonValue] => entry[1] !== undefined)
    )
  );
}
function expected(source: string, wanted: string, state?: ZcodeState): void {
  assert.deepEqual(events(source, state), parsePythonJson(wanted));
}
function occurrence(source: string | Uint8Array, framing: 'complete' | 'partial' = 'complete') {
  return decodeOccurrence(typeof source === 'string' ? Buffer.from(source) : source, {
    sourceId: 'source',
    sourceGeneration: 'generation',
    occurrenceId: 'occurrence',
    byteOffset: 9007199254740993n,
    lineOrdinal: 9007199254740995n,
    framing,
  });
}

test('pins native adapter identity and noise declaration without installing a consumer', () => {
  assert.equal(ZCODE_ADAPTER.id, 'zcode');
  assert.equal(
    ZCODE_ADAPTER_REVISION,
    `native-zcode/1;interpretation-profile:${UNICODE_PROFILE_ID};python-sha256:3c8cd2b60bc9011f81f56176ace3ea524c334b938e3ba561fac84e6466e021b4`
  );
  assert.equal(ZCODE_ADAPTER.revision, ZCODE_ADAPTER_REVISION);
  assert.equal(Object.isFrozen(ZCODE_ADAPTER), true);
  assert.equal(Object.isFrozen(ZCODE_NOISE_PREFIXES), true);
  assert.deepEqual(ZCODE_NOISE_PREFIXES, ["The TodoWrite tool hasn't been used recently"]);
  assert.deepEqual(ZCODE_ADAPTER.createState(), {});
});

test('matches only strict model_io equality while direct projection does not enforce its matcher', () => {
  assert.equal(matchesZcode(row('{"type":"model_io"}')), true);
  for (const kind of [
    '"MODEL_IO"',
    '"model_io "',
    '"assistant"',
    '""',
    'null',
    'false',
    '0',
    '[]',
    '{}',
  ])
    assert.equal(matchesZcode(row(`{"type":${kind}}`)), false, kind);
  assert.equal(matchesZcode(row('{}')), false);
  for (const source of [
    '{"type":[],"turnId":"A","response":{"text":"visible"}}',
    '{"type":{},"turnId":"A","response":{"text":"visible"}}',
    '{"turnId":"A","response":{"text":"visible"}}',
  ])
    expected(
      source,
      '[{"ev":"turn_boundary","turn_id":"A","ts":null},{"ev":"assistant_text","text":"visible","ts":null}]'
    );
});

test('emits a boundary before malformed response validation and creates null state on empty projection', () => {
  for (const response of ['null', 'false', '0', '"text"', '[]', '{}']) {
    const state = createZcodeState();
    expected(
      `{"type":"model_io","turnId":"A","startedAt":"start","response":${response}}`,
      '[{"ev":"turn_boundary","turn_id":"A","ts":"start"}]',
      state
    );
    assert.deepEqual(state, { zcode_turn_id: 'A' });
  }
  const state = createZcodeState();
  assert.deepEqual(events('{"type":"model_io"}', state), []);
  assert.deepEqual(state, { zcode_turn_id: null });
  assert.deepEqual(Object.keys(state), ['zcode_turn_id']);
});

test('deduplicates A then missing then A and emits a new boundary only for B', () => {
  const state = createZcodeState();
  const observed = [
    '{"type":"model_io","turnId":"A","response":{"text":"first"}}',
    '{"type":"model_io","response":{"text":"missing"}}',
    '{"type":"model_io","turnId":"A","response":{"text":"same"}}',
    '{"type":"model_io","turnId":"B","response":{"text":"changed"}}',
  ].flatMap((source) => events(source, state));
  assert.deepEqual(
    observed,
    parsePythonJson(
      '[{"ev":"turn_boundary","turn_id":"A","ts":null},{"ev":"assistant_text","text":"first","ts":null},{"ev":"assistant_text","text":"missing","ts":null},{"ev":"assistant_text","text":"same","ts":null},{"ev":"turn_boundary","turn_id":"B","ts":null},{"ev":"assistant_text","text":"changed","ts":null}]'
    )
  );
  assert.deepEqual(state, { zcode_turn_id: 'B' });
  for (const turnId of ['null', 'false', 'true', '0', '1', '[]', '{}', '""']) {
    expected(`{"type":"model_io","turnId":${turnId}}`, '[]', state);
    assert.deepEqual(state, { zcode_turn_id: 'B' });
  }
  expected(
    '{"type":"model_io","turnId":" "}',
    '[{"ev":"turn_boundary","turn_id":" ","ts":null}]',
    state
  );
  assert.deepEqual(state, { zcode_turn_id: ' ' });
});

test('constructed immutable seeded values survive invalid IDs and clone independently at the state bag', () => {
  // Ordinary private state contains only missing/null/string; these are explicit seeded controls.
  for (const seed of ['null', 'false', '0', 'NaN', '[]', '{"nested":[9007199254740993]}', '""']) {
    const value = parsePythonJson(seed);
    const original: ZcodeState = { zcode_turn_id: value };
    const draft = cloneZcodeState(original);
    assert.notEqual(draft, original);
    assert.equal(draft.zcode_turn_id, value);
    expected('{"type":"model_io","turnId":false}', '[]', draft);
    assert.equal(draft.zcode_turn_id, value);
    expected(
      '{"type":"model_io","turnId":"A"}',
      '[{"ev":"turn_boundary","turn_id":"A","ts":null}]',
      draft
    );
    assert.equal(draft.zcode_turn_id, 'A');
    assert.equal(original.zcode_turn_id, value);
  }
  const empty = createZcodeState();
  const draft = cloneZcodeState(empty);
  expected('{}', '[]', draft);
  assert.deepEqual(empty, {});
  assert.deepEqual(draft, { zcode_turn_id: null });
});

test('uses Python truthiness and operand order independently for start and completion timestamps', () => {
  for (const [fields, started, completed] of [
    ['"startedAt":"S","timestamp":"T","completedAt":"C"', 'S', 'C'],
    ['"startedAt":0,"timestamp":"T","completedAt":false', 'T', 'T'],
    ['"startedAt":false,"timestamp":0,"completedAt":[]', null, null],
    ['"startedAt":[],"timestamp":{},"completedAt":""', null, null],
    [
      '"startedAt":true,"timestamp":false,"completedAt":{}',
      '1970-01-01T00:00:01Z',
      '1970-01-01T00:00:01Z',
    ],
    ['"startedAt":"S","timestamp":"T","completedAt":null', 'S', 'T'],
    ['"startedAt":"S","completedAt":0', 'S', 'S'],
    ['"startedAt":{},"timestamp":0,"completedAt":{"x":1}', null, "{'x': 1}"],
    ['"startedAt":[0],"timestamp":null', '[0]', '[0]'],
  ] as const)
    expected(
      `{"type":"model_io","turnId":"A",${fields},"response":{"text":"text"}}`,
      JSON.stringify([
        { ev: 'turn_boundary', turn_id: 'A', ts: started },
        { ev: 'assistant_text', text: 'text', ts: completed },
      ])
    );
});

test('delegates numeric calendar limits nonfinite values and tiny negative rounding to common timestamp interpretation', () => {
  for (const [timestamp, ts] of [
    ['0', null],
    ['-0.0', null],
    ['true', '1970-01-01T00:00:01Z'],
    ['1', '1970-01-01T00:00:01Z'],
    ['NaN', 'nan'],
    ['Infinity', 'inf'],
    ['-Infinity', '-inf'],
    ['1e309', 'inf'],
    ['9007199254740993', '9007199254740993'],
    ['-62135596800', '0001-01-01T00:00:00Z'],
    ['-62135596801', '-62135596801'],
    ['253402300799', '9999-12-31T23:59:59Z'],
    ['253402300800', '253402300800'],
    ['-0.0000005', '1970-01-01T00:00:00Z'],
    ['-0.0000005000000001', '1969-12-31T23:59:59Z'],
    ['0.9999996', '1970-01-01T00:00:01Z'],
    ['""', null],
    ['"0"', '0'],
    ['" invalid date "', ' invalid date '],
  ] as const)
    expected(
      `{"type":"model_io","turnId":"A","timestamp":${timestamp},"response":{"text":"text","toolCalls":[{}]}}`,
      JSON.stringify([
        { ev: 'turn_boundary', turn_id: 'A', ts },
        { ev: 'assistant_text', text: 'text', ts },
        { ev: 'tool_use', name: '', id: '', input: {}, ts },
      ])
    );
  const integer = '1' + '0'.repeat(309);
  expected(
    `{"type":"model_io","timestamp":${integer},"response":{"text":"text"}}`,
    JSON.stringify([{ ev: 'assistant_text', text: 'text', ts: integer }])
  );
});

test('preserves nonblank text verbatim, emits no reasoning and keeps text before tools', () => {
  for (const text of ['null', 'true', '0', '[]', '{}', '""', '" \\t\\n\\u001c\\u0085"'])
    expected(`{"type":"model_io","response":{"text":${text},"reasoning":"hidden"}}`, '[]');
  for (const text of ['  keep\n', '\ufeff', '\u200b', '😀\ud800'])
    expected(
      JSON.stringify({
        type: 'model_io',
        response: { text, reasoning: 'hidden', toolCalls: [{}] },
      }),
      JSON.stringify([
        { ev: 'assistant_text', text, ts: null },
        { ev: 'tool_use', name: '', id: '', input: {}, ts: null },
      ])
    );
});

test('emits only dictionary tool calls, preserves explicit null/default distinctions and never decodes string inputs', () => {
  expected(
    '{"type":"model_io","response":{"text":"before","toolCalls":[null,[],false,0,"skip",{}, {"name":null,"id":null,"input":null},{"name":[1],"id":{"i":2},"input":{"large":9007199254740993,"zero":-0.0,"float":1e0,"nan":NaN,"nested":[true,null]}}]}}',
    '[{"ev":"assistant_text","text":"before","ts":null},{"ev":"tool_use","name":"","id":"","input":{},"ts":null},{"ev":"tool_use","name":null,"id":null,"input":{},"ts":null},{"ev":"tool_use","name":[1],"id":{"i":2},"input":{"large":9007199254740993,"zero":-0.0,"float":1e0,"nan":NaN,"nested":[true,null]},"ts":null}]'
  );
  for (const input of ['null', 'false', '0', '[]', '"{\\"x\\":1}"', '"invalid"'])
    expected(
      `{"type":"model_io","response":{"toolCalls":[{"input":${input}}]}}`,
      '[{"ev":"tool_use","name":"","id":"","input":{},"ts":null}]'
    );
  for (const calls of ['null', '{}', '"calls"', 'false', '0'])
    expected(`{"type":"model_io","response":{"toolCalls":${calls}}}`, '[]');
  const native = row('{"response":{"toolCalls":[{"input":{"large":9007199254740993}}]}}');
  const calls = getMember(getMember(native, 'response'), 'toolCalls');
  assert.ok(Array.isArray(calls));
  assert.equal(
    normalizeZcode(native, createZcodeState())[0]!.event.input,
    getMember(calls[0], 'input')
  );
});

test('complete occurrence retains exact bytes paths attribution and frozen envelopes', () => {
  const bytes = Buffer.from(
    ' {"type":"model_io","turnId":"A","response":{"text":" keep ","toolCalls":[null,false,{"name":"Read","id":"call","input":{"n":9007199254740993}}]}}\r\n'
  );
  const raw = Buffer.from(bytes);
  const parsed = occurrence(bytes);
  bytes.fill(0);
  const context = makeNormalizationContext({ surface: 'zcode' }, [ZCODE_ADAPTER]);
  const state = createAdapterState(ZCODE_ADAPTER, 'source', 'generation', context);
  const result = normalizeOccurrence(parsed, state, context, ZCODE_ADAPTER);
  assert.equal(result.disposition, 'normalized');
  assert.equal(result.commitAllowed, true);
  assert.equal(result.tentative, false);
  assert.equal(result.original, parsed);
  assert.equal(result.source.rawBase64, raw.toString('base64'));
  assert.equal(result.source.sha256, createHash('sha256').update(raw).digest('hex'));
  assert.equal(result.source.byteLength, raw.length);
  assert.equal(result.source.byteOffset, 9007199254740993n);
  assert.equal(result.source.lineOrdinal, 9007199254740995n);
  assert.equal(result.source.coordinateAuthority, 'caller_asserted');
  assert.deepEqual(
    result.events.map((entry) => entry.nativeMemberPath),
    [[], ['response'], ['response', 'toolCalls', 2]]
  );
  assert.deepEqual(
    result.events.map((entry) => entry.emissionIndex),
    [0, 1, 2]
  );
  assert.deepEqual(
    result.events.map((entry) => entry.event.ev),
    ['turn_boundary', 'assistant_text', 'tool_use']
  );
  assert.equal(result.events[2]!.event.source_harness, 'zcode');
  assert.deepEqual(
    getMember(result.events[2]!.event.input, 'n'),
    parsePythonJson('9007199254740993')
  );
  assert.equal(Object.isFrozen(result.events[2]!.event.input), true);
  assert.deepEqual(result.nextState.value, { zcode_turn_id: 'A' });
  assert.deepEqual(state.value, {});
  for (const entry of result.events) {
    assert.equal(entry.source, parsed.source);
    assert.equal(entry.adapter, state.adapter);
    assert.equal(Object.isFrozen(entry), true);
    assert.equal(Object.isFrozen(entry.event), true);
    assert.equal(Object.isFrozen(entry.nativeMemberPath), true);
  }
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.events), true);
  assert.equal(Object.isFrozen(result.nextState), true);
  assert.throws(() => {
    (result.events[0]!.nativeMemberPath as (string | number)[]).push('mutation');
  }, TypeError);
});

test('matched empty occurrences own normalization while wrong kinds leave state absent', () => {
  const context = makeNormalizationContext({}, [ZCODE_ADAPTER]);
  const state = createAdapterState(ZCODE_ADAPTER, 'source', 'generation', context);
  const empty = normalizeOccurrence(
    occurrence('{"type":"model_io"}'),
    state,
    context,
    ZCODE_ADAPTER
  );
  assert.equal(empty.disposition, 'normalized');
  assert.deepEqual(empty.events, []);
  assert.equal(empty.commitAllowed, true);
  assert.deepEqual(empty.nextState.value, { zcode_turn_id: null });
  for (const type of ['"assistant"', '{}', '[]']) {
    const unmatched = normalizeOccurrence(
      occurrence(`{"type":${type},"turnId":"B"}`),
      state,
      context,
      ZCODE_ADAPTER
    );
    assert.equal(unmatched.disposition, 'unmatched');
    assert.equal(unmatched.commitAllowed, false);
    assert.deepEqual(unmatched.events, []);
    assert.equal(unmatched.nextState, state);
    assert.deepEqual(state.value, {});
  }
});

test('partial rows produce isolated tentative state and complete retries start from caller state', () => {
  const context = makeNormalizationContext({}, [ZCODE_ADAPTER]);
  const state = {
    ...createAdapterState(ZCODE_ADAPTER, 'source', 'generation', context),
    value: Object.freeze({ zcode_turn_id: 'A' }),
  };
  const source = '{"type":"model_io","turnId":"B","response":{"text":"new"}}';
  const partial = normalizeOccurrence(occurrence(source, 'partial'), state, context, ZCODE_ADAPTER);
  assert.equal(partial.disposition, 'normalized');
  assert.equal(partial.tentative, true);
  assert.equal(partial.commitAllowed, false);
  assert.deepEqual(partial.nextState.value, { zcode_turn_id: 'B' });
  assert.deepEqual(state.value, { zcode_turn_id: 'A' });
  const complete = normalizeOccurrence(occurrence(source), state, context, ZCODE_ADAPTER);
  assert.equal(complete.commitAllowed, true);
  assert.deepEqual(
    complete.events.map((entry) => entry.event.ev),
    ['turn_boundary', 'assistant_text']
  );
  assert.deepEqual(state.value, { zcode_turn_id: 'A' });
  const invalid = normalizeOccurrence(
    occurrence('{"type":"model_io",', 'partial'),
    state,
    context,
    ZCODE_ADAPTER
  );
  assert.equal(invalid.disposition, 'invalid_json');
  assert.equal(invalid.tentative, true);
  assert.equal(invalid.commitAllowed, false);
  assert.equal(invalid.nextState, state);
});

test('injected failure after real projection cannot leak a drafted boundary into caller state', () => {
  const failure = new Error('injected after projection');
  const adapter: TranscriptAdapter<ZcodeState> = Object.freeze({
    ...ZCODE_ADAPTER,
    normalize(native: JsonObject, draft: ZcodeState): never {
      normalizeZcode(native, draft);
      assert.equal(draft.zcode_turn_id, 'B');
      throw failure;
    },
  });
  const context = makeNormalizationContext({}, [adapter]);
  const state = {
    ...createAdapterState(adapter, 'source', 'generation', context),
    value: { zcode_turn_id: 'A' },
  };
  assert.throws(
    () =>
      normalizeOccurrence(occurrence('{"type":"model_io","turnId":"B"}'), state, context, adapter),
    (error: unknown) => error === failure
  );
  assert.deepEqual(state.value, { zcode_turn_id: 'A' });
});

test('mismatched custody context and adapter identities refuse before projection', () => {
  const context = makeNormalizationContext({ surface: 'zcode' }, [ZCODE_ADAPTER]);
  const state = createAdapterState(ZCODE_ADAPTER, 'source', 'generation', context);
  const parsed = occurrence('{"type":"model_io","turnId":"B"}');
  const otherContext = makeNormalizationContext({ surface: 'claude-code' }, [ZCODE_ADAPTER]);
  const otherSource = decodeOccurrence(Buffer.from('{"type":"model_io","turnId":"B"}'), {
    sourceId: 'source',
    sourceGeneration: 'other-generation',
    occurrenceId: 'other',
    framing: 'complete',
  });
  for (const [result, disposition] of [
    [normalizeOccurrence(parsed, state, otherContext, ZCODE_ADAPTER), 'context_mismatch'],
    [normalizeOccurrence(otherSource, state, context, ZCODE_ADAPTER), 'source_mismatch'],
    [
      normalizeOccurrence(parsed, state, context, { ...ZCODE_ADAPTER, revision: 'other' }),
      'adapter_mismatch',
    ],
    [
      normalizeOccurrence(occurrence(Buffer.from([0xff])), state, context, ZCODE_ADAPTER),
      'invalid_utf8',
    ],
    [normalizeOccurrence(occurrence('null'), state, context, ZCODE_ADAPTER), 'non_object'],
  ] as const) {
    assert.equal(result.disposition, disposition);
    assert.equal(result.commitAllowed, false);
    assert.deepEqual(result.events, []);
    assert.equal(result.nextState, state);
    assert.deepEqual(state.value, {});
  }
});

test('tool attribution follows explicit normalization context while direct projection has no attribution', () => {
  const source = '{"type":"model_io","response":{"toolCalls":[{}]}}';
  assert.equal(normalizeZcode(row(source), createZcodeState())[0]!.event.source_harness, undefined);
  for (const [surface, attribution] of [
    [undefined, 'zcode'],
    ['unknown', 'zcode'],
    ['claude-code', 'claude'],
    ['zcode', 'zcode'],
  ] as const) {
    const context = makeNormalizationContext(surface === undefined ? {} : { surface }, [
      ZCODE_ADAPTER,
    ]);
    const state = createAdapterState(ZCODE_ADAPTER, 'source', 'generation', context);
    const result = normalizeOccurrence(occurrence(source), state, context, ZCODE_ADAPTER);
    assert.equal(result.events[0]!.event.source_harness, attribution);
    assert.equal(result.events[0]!.adapter.id, 'zcode');
  }
});
