import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDshAdapter,
  DSH_ADAPTER_REVISION,
  DSH_EVENT_TYPES,
  DshProjectionError,
  createDshState,
  cloneDshState,
  createDshIndex,
  inspectDshState,
  matchesDsh,
  normalizeDsh as normalizeDshWithDecoder,
  type DshState,
  type DshTuple,
  type DshNode,
} from '../../src/transcripts/harness-dsh';
import {
  getMember,
  isJsonObject,
  jsonNumber,
  jsonObject,
  parsePythonJson,
  pythonJsonDumps,
  type JsonObject,
  type JsonValue,
} from '../../src/transcripts/lossless-json';
import {
  createAdapterState,
  makeNormalizationContext,
  normalizeOccurrence,
} from '../../src/transcripts/harness-common';
import { decodeOccurrence } from '../../src/transcripts/source-occurrence';
// This fixture selects one observed interpreter profile; production selection is caller-owned.
const PINNED_EMBEDDED_JSON = Object.freeze({
  id: 'test-cpython-3.11.13-int4300',
  decode: (source: string): JsonValue =>
    parsePythonJson(source, {
      admitNumberToken: (token): void => {
        if (token.numberKind !== 'integer') return;
        const digits = token.lexeme.length - (token.lexeme.startsWith('-') ? 1 : 0);
        if (digits > 4300)
          throw new DshProjectionError(
            'ValueError',
            `Exceeds the limit (4300 digits) for integer string conversion: value has ${digits} digits; use sys.set_int_max_str_digits() to increase the limit`
          );
      },
    }),
});
const DSH_ADAPTER = createDshAdapter(PINNED_EMBEDDED_JSON);
function normalizeDsh(row: JsonObject, state: DshState) {
  return normalizeDshWithDecoder(row, state, PINNED_EMBEDDED_JSON.decode);
}
function row(source: string): JsonObject {
  const value = parsePythonJson(source);
  assert.ok(isJsonObject(value));
  return value;
}
function events(source: string, state = createDshState()): JsonValue[] {
  return normalizeDsh(row(source), state).map(({ event }) =>
    jsonObject(
      Object.entries(event).filter((entry): entry is [string, JsonValue] => entry[1] !== undefined)
    )
  );
}
function expected(source: string, wanted: string, state?: DshState): void {
  assert.deepEqual(events(source, state), parsePythonJson(wanted));
}
function error(
  action: () => unknown,
  pythonType: DshProjectionError['pythonType'],
  message: string
): void {
  assert.throws(action, (failure: unknown) => {
    assert.ok(failure instanceof DshProjectionError);
    assert.equal(failure.pythonType, pythonType);
    assert.equal(failure.message, message);
    return true;
  });
}

test('claims exactly the complete DSH and governance kinds, including hash failures', () => {
  assert.equal(DSH_ADAPTER.id, 'dsh');
  assert.equal(
    DSH_ADAPTER.revision,
    `${DSH_ADAPTER_REVISION};embedded-json:${PINNED_EMBEDDED_JSON.id}`
  );
  assert.ok(
    DSH_ADAPTER_REVISION.includes(
      '328305c956708a3413e5e8e9a4101681da53d30b972b41b3be3ec14b5125f1ab'
    )
  );
  assert.equal(Object.isFrozen(DSH_ADAPTER), true);
  assert.equal(Object.isFrozen(DSH_EVENT_TYPES), true);
  assert.equal(DSH_EVENT_TYPES.length, 13);
  assert.deepEqual(DSH_ADAPTER.createState(), {});
  for (const kind of DSH_EVENT_TYPES)
    assert.equal(matchesDsh(row(JSON.stringify({ type: kind }))), true, kind);
  for (const kind of [
    'assistant/chunk',
    'text-chunks',
    'reasoning-chunks',
    'tool-call-chunks',
    'agent/start',
    'request/start',
    'goal/change',
    'todo/write',
    'sandbox/start',
    'permission/request',
    '',
    null,
    1,
    true,
  ]) {
    assert.equal(matchesDsh(row(JSON.stringify({ type: kind }))), false);
    assert.deepEqual(
      normalizeDsh(row(JSON.stringify({ type: kind, data: {} })), createDshState()),
      []
    );
  }
  for (const [kind, type] of [
    [[], 'list'],
    [{}, 'dict'],
  ] as const) {
    const source = JSON.stringify({ type: kind, data: {} });
    error(() => matchesDsh(row(source)), 'TypeError', `unhashable type: '${type}'`);
    error(
      () => normalizeDsh(row(source), createDshState()),
      'TypeError',
      `unhashable type: '${type}'`
    );
    assert.deepEqual(normalizeDsh(row(JSON.stringify({ type: kind })), createDshState()), []);
  }
});

test('converts milliseconds before content validation with microsecond rounding, carry and calendar failures', () => {
  for (const [time, ts] of [
    ['false', '1970-01-01T00:00:00.000Z'],
    ['true', '1970-01-01T00:00:00.001Z'],
    ['0', '1970-01-01T00:00:00.000Z'],
    ['-0.0', '1970-01-01T00:00:00.000Z'],
    ['-1', '1969-12-31T23:59:59.999Z'],
    ['1785792371657', '2026-08-03T21:26:11.657Z'],
    ['999.9995', '1970-01-01T00:00:01.000Z'],
    ['-0.0005', '1970-01-01T00:00:00.000Z'],
    ['-62135596800000', '0001-01-01T00:00:00.000Z'],
    ['253402300799999', '9999-12-31T23:59:59.998Z'],
    ['253402300799999.0', '9999-12-31T23:59:59.998Z'],
  ])
    expected(
      `{"type":"turn/start","time":${time},"data":{}}`,
      JSON.stringify([{ ev: 'turn_boundary', turn_id: null, ts }])
    );
  for (const [time, ts] of [
    ['null', null],
    ['""', null],
    ['"1000"', '1000'],
    ['[]', null],
    ['[0]', '[0]'],
  ] as const)
    expected(
      `{"type":"turn/start","time":${time},"data":{}}`,
      JSON.stringify([{ ev: 'turn_boundary', turn_id: null, ts }])
    );
  for (const [time, type, message] of [
    ['NaN', 'ValueError', 'Invalid value NaN (not a number)'],
    ['Infinity', 'OverflowError', 'timestamp out of range for platform time_t'],
    ['-Infinity', 'OverflowError', 'timestamp out of range for platform time_t'],
    ['1e20', 'OSError', '[Errno 84] Value too large to be stored in data type'],
    ['253402300800000', 'ValueError', 'year 10000 is out of range'],
    ['-62135596801000', 'ValueError', 'year 0 is out of range'],
    ['9007199254740995', 'ValueError', 'year 287396 is out of range'],
  ] as const)
    error(() => normalizeDsh(row(`{"time":${time}}`), createDshState()), type, message);
  error(
    () => normalizeDsh(row(`{"time":1${'0'.repeat(309)}}`), createDshState()),
    'OverflowError',
    'int too large to convert to float'
  );
});

test('requires human source and preserves text while ordering all reasoning before visible text and usage', () => {
  for (const source of [
    'null',
    '{}',
    '{"kind":"agent-instructions"}',
    '{"kind":"skill-catalog"}',
    '"user"',
  ])
    expected(
      `{"type":"user/message","data":{"source":${source},"content":[{"type":"text","text":"hidden"}]}}`,
      '[]'
    );
  expected(
    '{"type":"user/message","data":{"source":{"kind":"user"},"content":[null,{"type":"reasoning","text":"hidden"},{"type":"text","text":"\\u001c"},{"type":"text","text":" keep "},{"type":"text","text":"\\ufeff"}]}}',
    '[{"ev":"user_text","text":" keep ","ts":null},{"ev":"user_text","text":"\\ufeff","ts":null}]'
  );
  const source =
    '{"type":"assistant/message","data":{"message":{"source":{"model":"m"},"content":[{"type":"text","text":"first visible"},{"type":"reasoning","text":"thought"},{"type":"text","text":"last visible"},{"type":"tool-call","text":"skip"}]},"usage":{"inputTokens":true,"outputTokens":9007199254740993,"cacheReadTokens":1.5,"reasoningTokens":NaN,"other":9}}}';
  expected(
    source,
    '[{"ev":"reasoning","text":"thought","ts":null},{"ev":"assistant_text","text":"first visible","ts":null},{"ev":"assistant_text","text":"last visible","ts":null},{"ev":"assistant_meta","ts":null,"usage":{"input_tokens":true,"output_tokens":9007199254740993,"cache_read_input_tokens":1.5,"reasoning_output_tokens":NaN},"model":"m"}]'
  );
  assert.deepEqual(
    normalizeDsh(row(source), createDshState()).map(({ nativeMemberPath }) => nativeMemberPath),
    [
      ['data', 'message', 'content', 1],
      ['data', 'message', 'content', 0],
      ['data', 'message', 'content', 2],
      ['data', 'message'],
    ]
  );
  expected(
    '{"type":"assistant/message","data":{"message":{},"usage":{"inputTokens":"2","outputTokens":null}}}',
    '[]'
  );
  error(
    () =>
      events('{"type":"user/message","data":{"source":{"kind":"user"},"content":[{"type":[]}]}}'),
    'TypeError',
    "unhashable type: 'list'"
  );
});

test('governance strings retain whitespace policies and descriptor dedupe ignores model changes', () => {
  const state = createDshState();
  for (const [kind, field, subtype] of [
    ['approval/policy', 'policy', 'approval_policy'],
    ['sandbox/mode', 'mode', 'sandbox_mode'],
    ['permission/preset', 'preset', 'permission_preset'],
  ]) {
    expected(
      JSON.stringify({ type: kind, data: { [field!]: ' ', source: 'origin' } }),
      JSON.stringify([
        {
          ev: 'control',
          subtype,
          text: ' ',
          ts: null,
          ...(kind === 'permission/preset' ? {} : { source: 'origin' }),
        },
      ]),
      state
    );
  }
  expected('{"type":"session/title","data":{"title":" "}}', '[]', state);
  expected('{"type":"subagent/descriptor","data":{"label":" "}}', '[]', state);
  assert.deepEqual(Object.keys(state), []);
  expected(
    '{"type":"subagent/descriptor","data":{"label":" helper ","agentModel":"m1"}}',
    '[{"ev":"control","subtype":"subagent_descriptor","text":" helper ","ts":null,"model":"m1"}]',
    state
  );
  expected(
    '{"type":"subagent/descriptor","data":{"label":" helper ","agentModel":"m2"}}',
    '[]',
    state
  );
  assert.equal(state.dsh_control_seen!.size, 1);
  expected(
    '{"type":"subagent/descriptor","data":{"label":"helper"}}',
    '[{"ev":"control","subtype":"subagent_descriptor","text":"helper","ts":null}]',
    state
  );
  const text = '😀'.repeat(401);
  expected(
    JSON.stringify({
      type: 'agent/inbox/spliced',
      data: { inserted: [null, { content: [{ type: 'ignored', text }] }] },
    }),
    JSON.stringify([
      { ev: 'control', subtype: 'agent_inbox_spliced', text: '😀'.repeat(400), ts: null },
    ])
  );
  expected(
    '{"type":"agent/inbox/spliced","data":{"inserted":[{"content":false},{"content":"ignored"},{"content":{"a":1}}]}}',
    '[]'
  );
  error(
    () => events('{"type":"agent/inbox/spliced","data":{"inserted":[{"content":true}]}}'),
    'TypeError',
    "'bool' object is not iterable"
  );
});

test('tool arguments decode dictionaries with raw syntax fallback, and results preserve raw error values', () => {
  for (const [argumentsValue, input] of [
    ['{"x":9007199254740993}', '{"x":9007199254740993}'],
    ['{"bad":', '{"raw":"{\\"bad\\":"}'],
    ['[]', '{}'],
    ['null', '{}'],
    ['true', '{}'],
  ])
    expected(
      JSON.stringify({
        type: 'tool/call',
        data: { name: null, callId: false, arguments: argumentsValue },
      }),
      `[{"ev":"tool_use","name":null,"id":false,"input":${input},"ts":null}]`
    );
  expected(
    '{"type":"tool/call","data":{"arguments":{"run_in_background":"false"}}}',
    '[{"ev":"tool_use","name":"","id":"","input":{"run_in_background":"false"},"ts":null}]'
  );
  expected(
    '{"type":"tool/result","data":{"message":{"content":[null,{"type":[],"content":[]},{"type":"tool-result","toolCallId":null,"isError":"false","content":[{"type":"text","text":"first"},{"type":"reasoning","text":"skip"},{"type":"text","text":"last"}]},{"type":"tool-result","isError":null}]}}}',
    '[{"ev":"tool_result","id":null,"content":"first\\n\\nlast","is_error":"false","ts":null},{"ev":"tool_result","id":"","content":"","is_error":null,"ts":null}]'
  );
  error(
    () => events('{"type":"tool/result","data":{"message":{"content":null}}}'),
    'TypeError',
    "'NoneType' object is not iterable"
  );
  expected('{"type":"tool/result","data":{"message":{"content":"ignored"}}}', '[]');
});

test('requires an explicit embedded decoder and preserves its identity, failures and syntax fallback', () => {
  const calls: string[] = [];
  const profile = {
    id: 'test-observed-decoder',
    decode: (source: string): JsonValue => {
      calls.push(source);
      return parsePythonJson(source);
    },
  };
  const adapter = createDshAdapter(profile);
  const revision = adapter.revision;
  profile.id = 'mutated';
  profile.decode = (): never => {
    throw new Error('replacement must not run');
  };
  const source = ' {"n":9007199254740993,"n":2,"flag":NaN} ';
  const input = row(JSON.stringify({ type: 'tool/call', data: { arguments: source } }));
  const projected = adapter.normalize(input, createDshState());
  assert.deepEqual(calls, [source]);
  assert.deepEqual(projected.events[0]!.event.input, parsePythonJson(source));
  assert.equal(adapter.revision, revision);
  assert.ok(revision.endsWith(';embedded-json:test-observed-decoder'));
  assert.equal(Object.isFrozen(adapter), true);
  adapter.normalize(row('{"type":"tool/call","data":{"arguments":{}}}'), createDshState());
  assert.deepEqual(calls, [source]);
  for (const failure of [
    new DshProjectionError('RecursionError', 'caller budget exhausted'),
    new RangeError('caller range'),
  ]) {
    const refusing = createDshAdapter({
      id: 'test-refusing',
      decode: () => {
        throw failure;
      },
    });
    assert.throws(
      () => refusing.normalize(input, createDshState()),
      (error) => error === failure
    );
    const context = makeNormalizationContext({ surface: 'dsh' }, [refusing]);
    const state = createAdapterState(refusing, 'source', 'generation', context);
    const parsed = decodeOccurrence(
      Buffer.from(JSON.stringify({ type: 'tool/call', data: { arguments: source } })),
      {
        sourceId: 'source',
        sourceGeneration: 'generation',
        occurrenceId: 'decoder-refusal',
        framing: 'complete',
      }
    );
    assert.throws(
      () => normalizeOccurrence(parsed, state, context, refusing),
      (error) => error === failure
    );
    assert.deepEqual(state.value, {});
  }
  const malformed = createDshAdapter({
    id: 'test-syntax',
    decode: () => {
      throw new SyntaxError('malformed');
    },
  });
  assert.equal(
    getMember(malformed.normalize(input, createDshState()).events[0]!.event.input, 'raw'),
    source
  );
  const uncapped = createDshAdapter({ id: 'test-uncapped-codec', decode: parsePythonJson });
  const huge = `{"unused":${'1'.repeat(4301)},"n":0}`;
  assert.deepEqual(
    uncapped.normalize(
      row(JSON.stringify({ type: 'tool/call', data: { arguments: huge } })),
      createDshState()
    ).events[0]!.event.input,
    parsePythonJson(huge)
  );
  assert.notEqual(uncapped.revision, DSH_ADAPTER.revision);
  assert.throws(() => createDshAdapter({ id: '', decode: parsePythonJson }), TypeError);
});

test('test-selected embedded integer admission fails at its token before trailing syntax or duplicate overwrite', () => {
  const digits = '1'.repeat(4301);
  const message =
    'Exceeds the limit (4300 digits) for integer string conversion: value has 4301 digits; use sys.set_int_max_str_digits() to increase the limit';
  for (const args of [
    `{"n":${digits}}`,
    `{"n":-${digits}}`,
    `{"n":${digits},"n":0}`,
    `{"n":${digits}} trailing`,
    `{"n":${digits},`,
  ])
    error(
      () => events(JSON.stringify({ type: 'tool/call', data: { arguments: args } })),
      'ValueError',
      message
    );
  for (const args of [`{"n":+${digits}}`, `{"n":0${digits}}`, `{"bad":, "n":${digits}}`]) {
    const result = events(JSON.stringify({ type: 'tool/call', data: { arguments: args } }));
    assert.equal(getMember(getMember(result[0], 'input'), 'raw'), args);
  }
  for (const args of [`{"n":${digits}.0}`, `{"n":1e${digits}}`, `{"n":"${digits}"}`]) {
    const result = events(JSON.stringify({ type: 'tool/call', data: { arguments: args } }));
    assert.deepEqual(getMember(result[0], 'input'), parsePythonJson(args));
  }
  const boundary = `{"n":${'1'.repeat(4300)}}`;
  assert.deepEqual(
    getMember(
      events(JSON.stringify({ type: 'tool/call', data: { arguments: boundary } }))[0],
      'input'
    ),
    parsePythonJson(boundary)
  );
});

test('step pairing retains first keys, equates numeric kinds, rounds ties to even and preserves presence', () => {
  const state = createDshState();
  expected('{"type":"step/start","time":1000,"data":{"turn":true,"step":false}}', '[]', state);
  const originalKey = inspectDshState(state).dsh_step_start_ms![0]![0];
  expected('{"type":"step/start","time":1001,"data":{"turn":1,"step":0}}', '[]', state);
  assert.equal(inspectDshState(state).dsh_step_start_ms![0]![0], originalKey);
  assert.equal(state.dsh_step_start_ms!.size, 1);
  expected(
    '{"type":"step/end","time":1002.5,"data":{"turn":1.0,"step":-0.0}}',
    '[{"ev":"control","subtype":"step","ts":"1970-01-01T00:00:01.002Z","duration_ms":2}]',
    state
  );
  assert.equal(state.dsh_step_start_ms!.size, 0);
  for (const [end, rounded] of [
    [1000.5, 0],
    [1001.5, 2],
    [1002.5, 2],
    [999.5, 0],
    [998.5, -2],
  ]) {
    expected('{"type":"step/start","time":1000,"data":{"step":true,"turn":false}}', '[]', state);
    const result = events(
      JSON.stringify({ type: 'step/end', time: end, data: { step: true, turn: false } }),
      state
    );
    assert.equal(pythonJsonDumps(getMember(result[0], 'duration_ms')!), String(rounded));
    assert.equal(getMember(result[0], 'step'), true);
    assert.equal(getMember(result[0], 'turn'), false);
  }
  for (const key of ['NaN', 'Infinity']) {
    expected(`{"type":"step/start","time":0,"data":{"turn":${key}}}`, '[]', state);
    assert.equal(
      pythonJsonDumps(
        getMember(
          events(`{"type":"step/end","time":1,"data":{"turn":${key}}}`, state)[0],
          'duration_ms'
        )!
      ),
      '1'
    );
    assert.equal(state.dsh_step_start_ms!.size, 0);
  }
  const clean = createDshState();
  expected(
    '{"type":"step/end","data":{"turn":[]}}',
    '[{"ev":"control","subtype":"step","ts":null}]',
    clean
  );
  error(
    () => events('{"type":"step/start","data":{"turn":[]}}', clean),
    'TypeError',
    "unhashable type: 'list'"
  );
  assert.deepEqual(Object.keys(clean), ['dsh_step_start_ms']);
  expected('{"type":"step/start","data":{}}', '[]', clean);
  error(
    () => events('{"type":"step/end","data":{"turn":[]}}', clean),
    'TypeError',
    "unhashable type: 'list'"
  );
  assert.equal(clean.dsh_step_start_ms!.size, 1);
});

test('clones state containers and exposes direct draft pop-before-round errors without mutating occurrence caller state', () => {
  const descriptor = createDshState();
  events('{"type":"subagent/descriptor","data":{"label":"helper"}}', descriptor);
  const descriptorClone = cloneDshState(descriptor);
  assert.notEqual(descriptorClone, descriptor);
  assert.equal(descriptorClone.dsh_control_seen, descriptor.dsh_control_seen);
  events('{"type":"subagent/descriptor","data":{"label":"another"}}', descriptorClone);
  assert.equal(descriptorClone.dsh_control_seen!.size, 2);
  assert.equal(descriptor.dsh_control_seen!.size, 1);
  const seeded: DshState = {
    dsh_step_start_ms: createDshIndex([[['turn', null], jsonNumber('NaN')]]),
  };
  const cloned = cloneDshState(seeded);
  assert.equal(cloned.dsh_step_start_ms, seeded.dsh_step_start_ms);
  assert.equal(
    inspectDshState(cloned).dsh_step_start_ms![0]![0],
    inspectDshState(seeded).dsh_step_start_ms![0]![0]
  );
  error(
    () => events('{"type":"step/end","time":0,"data":{"turn":"turn"}}', cloned),
    'ValueError',
    'cannot convert float NaN to integer'
  );
  assert.equal(cloned.dsh_step_start_ms!.size, 0);
  assert.equal(seeded.dsh_step_start_ms!.size, 1);
  const context = makeNormalizationContext({ surface: 'dsh' }, [DSH_ADAPTER]);
  const initial = createAdapterState(DSH_ADAPTER, 'source', 'generation', context);
  const state = { ...initial, value: seeded };
  const parsed = decodeOccurrence(
    Buffer.from('{"type":"step/end","time":0,"data":{"turn":"turn"}}'),
    {
      sourceId: 'source',
      sourceGeneration: 'generation',
      occurrenceId: 'failed',
      framing: 'complete',
    }
  );
  error(
    () => normalizeOccurrence(parsed, state, context, DSH_ADAPTER),
    'ValueError',
    'cannot convert float NaN to integer'
  );
  assert.equal(seeded.dsh_step_start_ms!.size, 1);
});

test('occurrences preserve custody and framing, isolate tentative state and refuse context or source mismatch', () => {
  const context = makeNormalizationContext({ surface: 'dsh' }, [DSH_ADAPTER]);
  const state = createAdapterState(DSH_ADAPTER, 'source', 'generation', context);
  const raw = Buffer.from('{"type":"subagent/descriptor","data":{"label":"helper"}}');
  const before = Buffer.from(raw);
  const partial = decodeOccurrence(raw, {
    sourceId: 'source',
    sourceGeneration: 'generation',
    occurrenceId: 'partial',
    framing: 'partial',
  });
  const result = normalizeOccurrence(partial, state, context, DSH_ADAPTER);
  assert.equal(result.disposition, 'normalized');
  assert.equal(result.tentative, true);
  assert.equal(result.commitAllowed, false);
  assert.equal(result.nextState.value.dsh_control_seen!.size, 1);
  assert.deepEqual(state.value, {});
  assert.equal(result.source.rawBase64, before.toString('base64'));
  raw.fill(0);
  assert.equal(result.source.rawBase64, before.toString('base64'));
  assert.equal(Object.isFrozen(result.events[0]!.event), true);
  assert.equal(Object.isFrozen(result.events[0]!), true);
  const complete = decodeOccurrence(Buffer.from('{"type":"tool/call","data":{}}'), {
    sourceId: 'source',
    sourceGeneration: 'generation',
    occurrenceId: 'complete',
    framing: 'complete',
  });
  const projected = normalizeOccurrence(complete, state, context, DSH_ADAPTER);
  assert.equal(projected.commitAllowed, true);
  assert.equal(projected.events[0]!.event.source_harness, 'dsh');
  assert.deepEqual(projected.events[0]!.nativeMemberPath, ['data']);
  assert.equal(projected.events[0]!.emissionIndex, 0);
  const different = makeNormalizationContext({ surface: 'codex' }, [DSH_ADAPTER]);
  assert.equal(
    normalizeOccurrence(complete, state, different, DSH_ADAPTER).disposition,
    'context_mismatch'
  );
  const other = decodeOccurrence(Buffer.from('{"type":"turn/start","data":{}}'), {
    sourceId: 'other',
    sourceGeneration: 'generation',
    occurrenceId: 'foreign',
    framing: 'complete',
  });
  assert.equal(
    normalizeOccurrence(other, state, context, DSH_ADAPTER).disposition,
    'source_mismatch'
  );
  const empty = decodeOccurrence(Buffer.from('{"type":"user/message","data":{}}'), {
    sourceId: 'source',
    sourceGeneration: 'generation',
    occurrenceId: 'empty',
    framing: 'complete',
  });
  const emptyResult = normalizeOccurrence(empty, state, context, DSH_ADAPTER);
  assert.equal(emptyResult.disposition, 'normalized');
  assert.deepEqual(emptyResult.events, []);
  assert.equal(emptyResult.commitAllowed, true);
});

test('persistent scalar indexes preserve Python numeric equality, insertion order and immutable nodes', () => {
  const state = createDshState();
  const keys = [
    'true',
    '1',
    '1.0',
    'false',
    '0',
    '-0.0',
    '9007199254740992',
    '9007199254740992.0',
    '9007199254740993',
    '0.5',
    '5e-1',
    'Infinity',
    '1e999',
    '"integer:1"',
    '"a\\u0000b"',
    'null',
  ];
  for (const turn of keys) events(`{"type":"step/start","data":{"turn":${turn}}}`, state);
  assert.equal(state.dsh_step_start_ms!.size, 9);
  assert.deepEqual(
    inspectDshState(state).dsh_step_start_ms!.map(([tuple]) => tuple[0]),
    [
      true,
      false,
      jsonNumber('9007199254740992'),
      jsonNumber('9007199254740993'),
      jsonNumber('0.5'),
      jsonNumber('Infinity'),
      'integer:1',
      'a\0b',
      null,
    ]
  );
  const view = inspectDshState(state);
  assert.equal(Object.isFrozen(view), true);
  assert.equal(Object.isFrozen(view.dsh_step_start_ms!), true);
  const validate = (root: DshNode | null): number => {
    if (root === null) return 0;
    assert.equal(Object.isFrozen(root), true);
    assert.equal(Object.isFrozen(root.entry), true);
    assert.equal(Object.isFrozen(root.entry.tuple), true);
    const left = validate(root.left),
      right = validate(root.right);
    assert.ok(Math.abs(left - right) <= 1);
    assert.equal(root.height, 1 + Math.max(left, right));
    return root.height;
  };
  validate(state.dsh_step_start_ms!.root);
  // Explicit constructed NaN objects differ; ordinary decoder NaNs are interned.
  const first = Object.freeze({
    kind: 'number' as const,
    numberKind: 'float' as const,
    lexeme: 'NaN',
  });
  const second = Object.freeze({
    kind: 'number' as const,
    numberKind: 'float' as const,
    lexeme: 'NaN',
  });
  const index = createDshIndex([
    [[first, null], null],
    [[second, null], null],
    [[jsonNumber('NaN'), null], null],
    [[jsonNumber('NaN'), null], null],
  ]);
  assert.equal(index.size, 3);
  const reinsert = createDshState();
  for (const turn of ['"a"', '"b"', '"c"'])
    events(`{"type":"step/start","data":{"turn":${turn}}}`, reinsert);
  events('{"type":"step/end","data":{"turn":"b"}}', reinsert);
  events('{"type":"step/start","data":{"turn":"b"}}', reinsert);
  assert.deepEqual(
    inspectDshState(reinsert).dsh_step_start_ms!.map(([tuple]) => tuple[0]),
    ['a', 'c', 'b']
  );
  events('{"type":"subagent/descriptor","data":{"label":"label"}}', reinsert);
  assert.deepEqual(Object.keys(inspectDshState(reinsert)), [
    'dsh_step_start_ms',
    'dsh_control_seen',
  ]);
});

test('actual occurrence transactions share immutable roots and path-copy a logarithmic number of nodes', () => {
  const context = makeNormalizationContext({ surface: 'dsh' }, [DSH_ADAPTER]);
  let state = createAdapterState(DSH_ADAPTER, 'source', 'generation', context);
  const nodes = (root: DshNode | null, found = new Set<DshNode>()): Set<DshNode> => {
    if (root === null) return found;
    found.add(root);
    nodes(root.left, found);
    nodes(root.right, found);
    return found;
  };
  for (let turn = 0; turn < 256; turn++) {
    const old = state.value.dsh_step_start_ms,
      before = nodes(old?.root ?? null);
    const clone = cloneDshState(state.value);
    assert.equal(clone.dsh_step_start_ms, old);
    const parsed = decodeOccurrence(
      Buffer.from(JSON.stringify({ type: 'step/start', time: 1000, data: { turn } })),
      {
        sourceId: 'source',
        sourceGeneration: 'generation',
        occurrenceId: `start-${turn}`,
        framing: 'complete',
      }
    );
    const result = normalizeOccurrence(parsed, state, context, DSH_ADAPTER);
    assert.equal(result.commitAllowed, true);
    assert.deepEqual(result.events, []);
    const next = result.nextState.value.dsh_step_start_ms!;
    assert.equal(next.size, turn + 1);
    assert.ok(next.root!.height <= 2 * Math.ceil(Math.log2(turn + 2)));
    const allocated = [...nodes(next.root)].filter((candidate) => !before.has(candidate)).length;
    assert.ok(allocated <= 3 * (next.root!.height + 1), `turn ${turn}: ${allocated} new nodes`);
    assert.equal(state.value.dsh_step_start_ms, old);
    state = result.nextState;
  }
  for (let turn = 255; turn >= 0; turn--) {
    const old = state.value.dsh_step_start_ms!,
      before = nodes(old.root);
    const parsed = decodeOccurrence(
      Buffer.from(JSON.stringify({ type: 'step/end', time: 1001, data: { turn } })),
      {
        sourceId: 'source',
        sourceGeneration: 'generation',
        occurrenceId: `end-${turn}`,
        framing: 'complete',
      }
    );
    const result = normalizeOccurrence(parsed, state, context, DSH_ADAPTER),
      next = result.nextState.value.dsh_step_start_ms!;
    assert.equal(
      result.events[0]!.event.duration_ms && pythonJsonDumps(result.events[0]!.event.duration_ms),
      '1'
    );
    assert.equal(next.size, turn);
    assert.equal(old.size, turn + 1);
    const allocated = [...nodes(next.root)].filter((candidate) => !before.has(candidate)).length;
    assert.ok(allocated <= 3 * (old.root!.height + 1));
    state = result.nextState;
  }
  assert.deepEqual(inspectDshState(state.value).dsh_step_start_ms, []);
});

test('externally counted comparisons through occurrence normalization stay bounded by tree height', () => {
  const entries: Array<readonly [DshTuple, JsonValue]> = [];
  for (let index = 0; index < 1024; index++)
    entries.push([[jsonNumber(String(index)), null], jsonNumber('0')]);
  const original = createDshIndex(entries);
  let comparisons = 0;
  const counted = (root: DshNode | null): DshNode | null => {
    if (root === null) return null;
    const left = counted(root.left),
      right = counted(root.right);
    return Object.freeze({
      get key() {
        comparisons++;
        return root.key;
      },
      entry: root.entry,
      height: root.height,
      left,
      right,
    });
  };
  const index = Object.freeze({ ...original, root: counted(original.root) });
  const context = makeNormalizationContext({ surface: 'dsh' }, [DSH_ADAPTER]);
  const state = {
    ...createAdapterState(DSH_ADAPTER, 'source', 'generation', context),
    value: { dsh_step_start_ms: index } as DshState,
  };
  assert.equal(cloneDshState(state.value).dsh_step_start_ms, index);
  assert.equal(comparisons, 0);
  for (const [kind, turn, expectedSize] of [
    ['step/start', 1025, 1025],
    ['step/start', 512, 1024],
    ['step/end', 512, 1023],
    ['step/end', 1025, 1024],
  ] as const) {
    comparisons = 0;
    const parsed = decodeOccurrence(
      Buffer.from(JSON.stringify({ type: kind, time: 1, data: { turn } })),
      {
        sourceId: 'source',
        sourceGeneration: 'generation',
        occurrenceId: `${kind}-${turn}`,
        framing: 'complete',
      }
    );
    const result = normalizeOccurrence(parsed, state, context, DSH_ADAPTER);
    const observed = comparisons;
    assert.equal(result.nextState.value.dsh_step_start_ms!.size, expectedSize);
    assert.ok(observed <= 8 * (original.root!.height + 1), `${kind} visited ${observed} keys`);
    assert.equal(state.value.dsh_step_start_ms, index);
    assert.equal(index.size, 1024);
  }
});
