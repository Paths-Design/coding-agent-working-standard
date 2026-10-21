import test from 'node:test';
import assert from 'node:assert/strict';
import {
  KIMI_ADAPTER,
  KIMI_ADAPTER_REVISION,
  KimiProjectionError,
  matchesKimi,
  normalizeKimi,
} from '../../src/transcripts/harness-kimi';
import { UNICODE_PROFILE_ID } from '../../src/transcripts/python-unicode-profile';
import {
  getMember,
  isJsonObject,
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

function row(source: string): JsonObject {
  const value = parsePythonJson(source);
  assert.ok(isJsonObject(value));
  return value;
}
function events(source: string): JsonValue[] {
  return normalizeKimi(row(source)).map(({ event }) =>
    jsonObject(
      Object.entries(event).filter((entry): entry is [string, JsonValue] => entry[1] !== undefined)
    )
  );
}
function assertEvents(source: string, expected: string): void {
  assert.deepEqual(events(source), parsePythonJson(expected));
}
function fails(
  source: string,
  pythonType: 'TypeError' | 'OverflowError',
  message: string,
  match = false
): void {
  assert.throws(
    () => (match ? matchesKimi(row(source)) : normalizeKimi(row(source))),
    (error: unknown) => {
      assert.ok(error instanceof KimiProjectionError);
      assert.equal(error.pythonType, pythonType);
      assert.equal(error.message, message);
      return true;
    }
  );
}

test('binds immutable stateless identity to the historical Python and interpretation profile', () => {
  assert.equal(KIMI_ADAPTER.id, 'kimi-code');
  assert.equal(KIMI_ADAPTER.revision, KIMI_ADAPTER_REVISION);
  assert.equal(
    KIMI_ADAPTER_REVISION,
    `native-kimi/1;interpretation-profile:${UNICODE_PROFILE_ID};python-sha256:da87e0bcc13af003c144b17b03b41487d76b0004b9ac496bd689678bfb726b5f`
  );
  assert.equal(KIMI_ADAPTER.createState(), null);
  assert.equal(KIMI_ADAPTER.cloneState(null), null);
  assert.deepEqual(KIMI_ADAPTER.normalize(row('{}'), null), { state: null, events: [] });
  assert.equal(Object.isFrozen(KIMI_ADAPTER), true);
  assert.equal(Reflect.set(KIMI_ADAPTER, 'id', 'changed'), false);
});

test('claims only the two wire kinds with numeric time including booleans and nonfinite values', () => {
  for (const time of [
    '0',
    '-0',
    'false',
    'true',
    '1',
    '1.0',
    'NaN',
    'Infinity',
    '-Infinity',
    '9007199254740995',
    '1e999',
  ]) {
    for (const kind of ['turn.prompt', 'context.append_loop_event']) {
      assert.equal(matchesKimi(row(`{"time":${time},"type":"${kind}"}`)), true);
      assert.deepEqual(normalizeKimi(row(`{"time":${time},"type":"${kind}"}`)), []);
    }
  }
  for (const source of [
    '{}',
    '{"type":"turn.prompt"}',
    '{"time":"1","type":"turn.prompt"}',
    '{"time":null,"type":"turn.prompt"}',
    '{"time":[],"type":"turn.prompt"}',
    '{"time":{},"type":"context.append_loop_event"}',
    '{"time":1}',
    '{"time":1,"type":"context.append_message"}',
    '{"time":1,"type":"metadata"}',
    '{"time":1,"type":"TURN.PROMPT"}',
    '{"time":1,"type":false}',
    '{"time":1,"type":1}',
    '{"time":1,"type":null}',
  ])
    assert.equal(matchesKimi(row(source)), false, source);
});

test('short-circuits nonnumeric time before unhashable kind checks while normalization uses equality', () => {
  for (const kind of ['[]', '{}']) {
    for (const time of ['null', '"1"', '[]', '{}'])
      assert.equal(matchesKimi(row(`{"time":${time},"type":${kind}}`)), false);
    const type = kind === '[]' ? 'list' : 'dict';
    for (const time of ['0', 'false', 'true', 'NaN', 'Infinity'])
      fails(`{"time":${time},"type":${kind}}`, 'TypeError', `unhashable type: '${type}'`, true);
    assert.deepEqual(normalizeKimi(row(`{"time":1,"type":${kind}}`)), []);
  }
});

// Fixed outputs from the historical Python adapter include values for which
// float(integer)/1000 double-rounds or overflows before the actual division.
const OVERFLOW_THRESHOLD =
  '179769313486231580793728971405303415079934132710037826936173778980444968292764750946649017977587207096330286416692887910946555547851940402630657488671505820681908902000708383676273854845817711531764475730270069855571366959622842914819860834936475292719074168444365510704342711559699508093042880177904174497792000';

test('converts arbitrary integer milliseconds once with finite quotient and exact overflow boundaries', () => {
  const finiteCases: Array<readonly [string, string | null]> = [
    ['0', null],
    ['-0', null],
    ['-1', '1969-12-31T23:59:59Z'],
    ['1785792371657', '2026-08-03T21:26:11Z'],
    ['-62135596800000', '0001-01-01T00:00:00Z'],
    ['253402300799999', '9999-12-31T23:59:59Z'],
    ['1' + '0'.repeat(309), '1e+306'],
    ['-1' + '0'.repeat(309), '-1e+306'],
    ['9007199254740995', '9007199254740.994'],
    ['-9007199254740995', '-9007199254740.994'],
    [(BigInt(OVERFLOW_THRESHOLD) - 1n).toString(), '1.7976931348623157e+308'],
    [(-BigInt(OVERFLOW_THRESHOLD) + 1n).toString(), '-1.7976931348623157e+308'],
  ];
  for (const [time, ts] of finiteCases) {
    const source = `{"time":${time},"type":"turn.prompt","input":[{"text":"x"}]}`;
    assert.equal(matchesKimi(row(source)), true);
    assertEvents(source, JSON.stringify([{ ev: 'user_text', text: 'x', ts }]));
  }
  for (const time of [
    OVERFLOW_THRESHOLD,
    '-' + OVERFLOW_THRESHOLD,
    (BigInt(OVERFLOW_THRESHOLD) + 1n).toString(),
    (-BigInt(OVERFLOW_THRESHOLD) - 1n).toString(),
  ]) {
    const source = `{"time":${time},"type":"turn.prompt","input":[{"text":"x"}]}`;
    assert.equal(matchesKimi(row(source)), true);
    fails(source, 'OverflowError', 'integer division result too large for a float');
    // Conversion happens before even an ignored kind is tested.
    fails(
      `{"time":${time},"type":"ignored"}`,
      'OverflowError',
      'integer division result too large for a float'
    );
  }
});

test('preserves float timestamp fallback, boolean milliseconds and numeric-only direct conversion', () => {
  for (const [time, ts] of [
    ['false', null],
    ['true', '1970-01-01T00:00:00Z'],
    ['-0.0', null],
    ['-0.0005', '1970-01-01T00:00:00Z'],
    ['NaN', 'nan'],
    ['Infinity', 'inf'],
    ['-Infinity', '-inf'],
    ['1e999', 'inf'],
    ['-1e999', '-inf'],
    ['1000000000000000', '1000000000000.0'],
    ['1000000000000000.0', '1000000000000.0'],
  ] as const) {
    assertEvents(
      `{"time":${time},"type":"turn.prompt","input":[{"text":"x"}]}`,
      JSON.stringify([{ ev: 'user_text', text: 'x', ts }])
    );
  }
  for (const time of ['null', '"1785792371657"', '[]', '{}']) {
    assertEvents(
      `{"time":${time},"type":"turn.prompt","input":[{"text":"x"}]}`,
      '[{"ev":"user_text","text":"x","ts":null}]'
    );
  }
  assertEvents(
    '{"type":"turn.prompt","input":[{"text":"x"}]}',
    '[{"ev":"user_text","text":"x","ts":null}]'
  );
});

test('iterates prompt blocks in source order without block-type filtering or text rewriting', () => {
  const source =
    '{"time":0,"type":"turn.prompt","input":[null,false,1,"ignored",[],{}, {"text":false},{"text":"\\u001c\\u0085"},{"type":"image","text":" raw "},{"text":"<bash-input>echo &amp;</bash-input>"},{"text":"\\ufeff"},{"type":"think","text":"last"}],"origin":{"kind":"steering"}}';
  assertEvents(
    source,
    '[{"ev":"user_text","text":" raw ","ts":null},{"ev":"user_text","text":"<bash-input>echo &amp;</bash-input>","ts":null},{"ev":"user_text","text":"\\ufeff","ts":null},{"ev":"user_text","text":"last","ts":null}]'
  );
  assert.deepEqual(
    normalizeKimi(row(source)).map(({ nativeMemberPath }) => nativeMemberPath),
    [
      ['input', 8],
      ['input', 9],
      ['input', 10],
      ['input', 11],
    ]
  );
});

test('handles Python prompt truthiness and iterable scalars while rejecting truthy numeric scalars', () => {
  for (const input of [
    'null',
    'false',
    '0',
    '-0.0',
    '[]',
    '{}',
    '""',
    '"truthy text"',
    '{"text":"dictionary values are not blocks"}',
  ]) {
    assertEvents(`{"time":1,"type":"turn.prompt","input":${input}}`, '[]');
  }
  assertEvents('{"time":1,"type":"turn.prompt"}', '[]');
  for (const [input, type] of [
    ['true', 'bool'],
    ['1', 'int'],
    ['-1', 'int'],
    ['1.0', 'float'],
    ['NaN', 'float'],
    ['Infinity', 'float'],
  ] as const)
    fails(
      `{"time":1,"type":"turn.prompt","input":${input}}`,
      'TypeError',
      `'${type}' object is not iterable`
    );
});

test('emits text and think content parts as assistant text without thought flags', () => {
  for (const [part, text] of [
    [{ type: 'text', text: ' visible ', think: 'ignored', thought: true }, ' visible '],
    [{ type: 'think', think: ' reasoning ', text: 'ignored', thought: true }, ' reasoning '],
    [{ type: 'text', text: '\ufeff' }, '\ufeff'],
  ] as const) {
    const source = JSON.stringify({
      time: 0,
      type: 'context.append_loop_event',
      event: { type: 'content.part', part },
    });
    assertEvents(source, JSON.stringify([{ ev: 'assistant_text', text, ts: null }]));
    assert.deepEqual(normalizeKimi(row(source))[0]!.nativeMemberPath, ['event', 'part']);
  }
  for (const part of [
    null,
    false,
    [],
    'text',
    {},
    { type: 'text', text: '\u001c\u0085' },
    { type: 'text', text: 1 },
    { type: 'think', text: 'wrong field' },
    { type: 'Text', text: 'wrong type' },
    { type: [], text: 'wrong type' },
    { type: {}, think: 'wrong type' },
  ]) {
    assertEvents(
      JSON.stringify({
        time: 1,
        type: 'context.append_loop_event',
        event: { type: 'content.part', part },
      }),
      '[]'
    );
  }
  for (const event of [
    null,
    false,
    [],
    'event',
    {},
    { type: 'step.begin', usage: { tokens: 4 } },
    { type: 'step.end' },
    { type: 'unknown' },
    { type: [] },
    { type: {} },
  ]) {
    assertEvents(JSON.stringify({ time: 1, type: 'context.append_loop_event', event }), '[]');
  }
  assertEvents(
    '{"time":1,"type":"context.append_message","input":[{"text":"duplicate prompt"}]}',
    '[]'
  );
});

test('shallow-clones tool args and appends file_path only when absent with a string path', () => {
  const source =
    '{"time":0,"type":"context.append_loop_event","event":{"type":"tool.call","name":"write_file","toolCallId":"id","args":{"path":"/tmp/x","nested":{"x":1},"__proto__":"own","constructor":false}}}';
  const parsed = row(source);
  const original = getMember(getMember(parsed, 'event'), 'args');
  assert.ok(isJsonObject(original));
  const before = pythonJsonDumps(parsed);
  const projected = normalizeKimi(parsed)[0]!;
  const input = projected.event.input;
  assert.ok(isJsonObject(input));
  assert.notEqual(input, original);
  assert.notEqual(input.entries, original.entries);
  assert.equal(getMember(input, 'nested'), getMember(original, 'nested'));
  assert.equal(pythonJsonDumps(parsed), before);
  assert.equal(getMember(original, 'file_path'), undefined);
  assert.deepEqual(
    input.entries.map(([key]) => key),
    ['path', 'nested', '__proto__', 'constructor', 'file_path']
  );
  assert.deepEqual(projected.nativeMemberPath, ['event']);
  assertEvents(
    source,
    '[{"ev":"tool_use","name":"write_file","id":"id","input":{"path":"/tmp/x","nested":{"x":1},"__proto__":"own","constructor":false,"file_path":"/tmp/x"},"ts":null}]'
  );
  for (const filePath of ['', null, false, 0, [], {}]) {
    assertEvents(
      JSON.stringify({
        time: 0,
        type: 'context.append_loop_event',
        event: { type: 'tool.call', args: { path: '/tmp/x', file_path: filePath } },
      }),
      JSON.stringify([
        {
          ev: 'tool_use',
          name: '',
          id: '',
          input: { path: '/tmp/x', file_path: filePath },
          ts: null,
        },
      ])
    );
  }
  assertEvents(
    '{"time":0,"type":"context.append_loop_event","event":{"type":"tool.call","args":{"path":""}}}',
    '[{"ev":"tool_use","name":"","id":"","input":{"path":"","file_path":""},"ts":null}]'
  );
  for (const path of [null, false, 1, [], {}])
    assertEvents(
      JSON.stringify({
        time: 0,
        type: 'context.append_loop_event',
        event: { type: 'tool.call', args: { path } },
      }),
      JSON.stringify([{ ev: 'tool_use', name: '', id: '', input: { path }, ts: null }])
    );
  for (const args of [null, false, 1, [], 'args'])
    assertEvents(
      JSON.stringify({
        time: 0,
        type: 'context.append_loop_event',
        event: { type: 'tool.call', args },
      }),
      '[{"ev":"tool_use","name":"","id":"","input":{},"ts":null}]'
    );
});

test('passes arbitrary tool names and IDs through without mapping, hash checks or truthy defaults', () => {
  for (const value of [
    null,
    false,
    0,
    true,
    1,
    '',
    'constructor',
    'read_file',
    [],
    [1],
    {},
    { x: 1 },
  ]) {
    assertEvents(
      JSON.stringify({
        time: 0,
        type: 'context.append_loop_event',
        event: { type: 'tool.call', name: value, toolCallId: value },
      }),
      JSON.stringify([{ ev: 'tool_use', name: value, id: value, input: {}, ts: null }])
    );
  }
  assertEvents(
    '{"time":0,"type":"context.append_loop_event","event":{"type":"tool.call","name":9007199254740993,"toolCallId":NaN}}',
    '[{"ev":"tool_use","name":9007199254740993,"id":NaN,"input":{},"ts":null}]'
  );
  assertEvents(
    '{"time":0,"type":"context.append_loop_event","event":{"type":"tool.call"}}',
    '[{"ev":"tool_use","name":"","id":"","input":{},"ts":null}]'
  );
});

test('serializes result output with Python JSON and uses Python isError truthiness', () => {
  for (const result of [null, false, 1, [], 'result', {}]) {
    assertEvents(
      JSON.stringify({
        time: 0,
        type: 'context.append_loop_event',
        event: { type: 'tool.result', result },
      }),
      '[{"ev":"tool_result","id":"","content":"","is_error":false,"ts":null}]'
    );
  }
  for (const [output, content] of [
    [' raw ', ' raw '],
    [null, 'null'],
    [false, 'false'],
    [[], '[]'],
    [{ z: 'é', a: 1 }, '{"z": "é", "a": 1}'],
  ] as const) {
    assertEvents(
      JSON.stringify({
        time: 0,
        type: 'context.append_loop_event',
        event: { type: 'tool.result', toolCallId: null, result: { output } },
      }),
      JSON.stringify([{ ev: 'tool_result', id: null, content, is_error: false, ts: null }])
    );
  }
  assertEvents(
    '{"time":0,"type":"context.append_loop_event","event":{"type":"tool.result","toolCallId":9007199254740993,"result":{"output":{"z":"é","a":9007199254740993,"b":NaN}}}}',
    '[{"ev":"tool_result","id":9007199254740993,"content":' +
      JSON.stringify('{"z": "é", "a": 9007199254740993, "b": NaN}') +
      ',"is_error":false,"ts":null}]'
  );
  for (const [isError, expected] of [
    [null, false],
    [false, false],
    [0, false],
    ['', false],
    [[], false],
    [{}, false],
    [true, true],
    [1, true],
    ['false', true],
    [[0], true],
    [{ x: false }, true],
  ] as const) {
    assertEvents(
      JSON.stringify({
        time: 0,
        type: 'context.append_loop_event',
        event: { type: 'tool.result', toolCallId: false, result: { isError } },
      }),
      JSON.stringify([{ ev: 'tool_result', id: false, content: '', is_error: expected, ts: null }])
    );
  }
  assertEvents(
    '{"time":0,"type":"context.append_loop_event","event":{"type":"tool.result","result":{"isError":NaN}}}',
    '[{"ev":"tool_result","id":"","content":"","is_error":true,"ts":null}]'
  );
  assert.deepEqual(
    normalizeKimi(
      row('{"time":0,"type":"context.append_loop_event","event":{"type":"tool.result"}}')
    )[0]!.nativeMemberPath,
    ['event']
  );
});

test('retains raw bytes and frozen envelopes for complete, partial and empty matched occurrences', () => {
  const context = makeNormalizationContext({ surface: 'kimi-code' }, [KIMI_ADAPTER]);
  const state = createAdapterState(KIMI_ADAPTER, 'source', 'generation', context);
  const raw = Buffer.from(
    '{"time":0,"type":"context.append_loop_event","event":{"type":"tool.call","name":"Write","toolCallId":"id","args":{"path":"a","value":1,"value":9007199254740993,"nan":NaN,"surrogate":"\\ud800"}}}'
  );
  const before = Buffer.from(raw);
  const decode = (bytes: Buffer, occurrenceId: string, framing: 'complete' | 'partial') =>
    decodeOccurrence(bytes, {
      sourceId: 'source',
      sourceGeneration: 'generation',
      occurrenceId,
      framing,
    });
  const complete = normalizeOccurrence(
    decode(raw, 'complete', 'complete'),
    state,
    context,
    KIMI_ADAPTER
  );
  assert.equal(complete.disposition, 'normalized');
  assert.equal(complete.commitAllowed, true);
  assert.equal(complete.tentative, false);
  assert.equal(complete.nextState.value, null);
  assert.equal(complete.events.length, 1);
  const envelope = complete.events[0]!;
  assert.equal(envelope.event.source_harness, 'kimi-code');
  assert.equal(envelope.emissionIndex, 0);
  assert.deepEqual(envelope.nativeMemberPath, ['event']);
  assert.equal(complete.source.rawBase64, before.toString('base64'));
  assert.equal(Object.isFrozen(complete), true);
  assert.equal(Object.isFrozen(complete.source), true);
  assert.equal(Object.isFrozen(complete.events), true);
  assert.equal(Object.isFrozen(envelope), true);
  assert.equal(Object.isFrozen(envelope.nativeMemberPath), true);
  assert.equal(Object.isFrozen(envelope.event), true);
  const input = envelope.event.input;
  assert.ok(isJsonObject(input));
  assert.equal(pythonJsonDumps(getMember(input, 'value')!), '9007199254740993');
  assert.equal(pythonJsonDumps(getMember(input, 'nan')!), 'NaN');
  assert.equal(getMember(input, 'surrogate'), '\ud800');
  assert.equal(getMember(input, 'file_path'), 'a');
  assert.equal(Object.isFrozen(input), true);
  assert.equal(Object.isFrozen(input.entries), true);
  assert.equal(input.entries.every(Object.isFrozen), true);
  raw.fill(0);
  assert.equal(complete.source.rawBase64, before.toString('base64'));
  const partial = normalizeOccurrence(
    decode(before, 'partial', 'partial'),
    state,
    context,
    KIMI_ADAPTER
  );
  assert.equal(partial.disposition, 'normalized');
  assert.equal(partial.tentative, true);
  assert.equal(partial.commitAllowed, false);
  assert.deepEqual(
    partial.events.map(({ event, nativeMemberPath }) => ({ event, nativeMemberPath })),
    complete.events.map(({ event, nativeMemberPath }) => ({ event, nativeMemberPath }))
  );
  const empty = normalizeOccurrence(
    decode(
      Buffer.from(
        '{"time":false,"type":"context.append_loop_event","event":{"type":"step.begin"}}'
      ),
      'empty',
      'complete'
    ),
    state,
    context,
    KIMI_ADAPTER
  );
  assert.equal(empty.disposition, 'normalized');
  assert.equal(empty.commitAllowed, true);
  assert.deepEqual(empty.events, []);
  assert.equal(state.value, null);
});
