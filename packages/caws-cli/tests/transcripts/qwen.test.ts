import test from 'node:test';
import assert from 'node:assert/strict';
import {
  QWEN_ADAPTER,
  QWEN_ADAPTER_REVISION,
  QWEN_TOOL_NAME_MAP,
  QwenProjectionError,
  matchesQwen,
  normalizeQwen,
} from '../../src/transcripts/harness-qwen';
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
  return normalizeQwen(row(source)).map(({ event }) =>
    jsonObject(
      Object.entries(event).filter((entry): entry is [string, JsonValue] => entry[1] !== undefined)
    )
  );
}
function assertEvents(source: string, expected: string): void {
  assert.deepEqual(events(source), parsePythonJson(expected));
}
function fails(source: string, type: 'list' | 'dict', match = false): void {
  assert.throws(
    () => (match ? matchesQwen(row(source)) : normalizeQwen(row(source))),
    (error: unknown) => {
      assert.ok(error instanceof QwenProjectionError);
      assert.equal(error.pythonType, 'TypeError');
      assert.equal(error.message, `unhashable type: '${type}'`);
      return true;
    }
  );
}

test('binds immutable stateless adapter identity and the exact historical tool map', () => {
  assert.equal(QWEN_ADAPTER.id, 'qwen-code');
  assert.equal(QWEN_ADAPTER.revision, QWEN_ADAPTER_REVISION);
  assert.equal(
    QWEN_ADAPTER_REVISION,
    `native-qwen/1;interpretation-profile:${UNICODE_PROFILE_ID};python-sha256:6d204c98df6a3dcfc5625f98f11a0645513987cc535e19b6368af4334e53b605`
  );
  assert.equal(QWEN_ADAPTER.createState(), null);
  assert.equal(QWEN_ADAPTER.cloneState(null), null);
  assert.deepEqual(QWEN_ADAPTER.normalize(row('{}'), null), {
    state: null,
    events: [],
  });
  assert.equal(Object.isFrozen(QWEN_ADAPTER), true);
  assert.equal(Object.isFrozen(QWEN_TOOL_NAME_MAP), true);
  assert.equal(Reflect.set(QWEN_TOOL_NAME_MAP, 'write_file', 'changed'), false);
  assert.deepEqual(QWEN_TOOL_NAME_MAP, {
    write_file: 'Write',
    edit: 'Edit',
    read_file: 'Read',
    run_shell_command: 'Bash',
    glob: 'Glob',
    grep_search: 'Grep',
    notebook_edit: 'NotebookEdit',
    web_fetch: 'WebFetch',
    agent: 'Agent',
    skill: 'Skill',
    exit_plan_mode: 'ExitPlanMode',
  });
});

test('claims nonempty parts even when no usable part exists and preserves presence short-circuiting', () => {
  for (const source of [
    '{"type":"tool_result"}',
    '{"type":"user","message":{"parts":[null],"content":"Claude content"}}',
    '{"type":"assistant","message":{"parts":[false]}}',
    '{"type":"user","message":{"parts":[{}]}}',
    '{"type":"system","systemPayload":null,"subtype":[]}',
    '{"type":"system","systemPayload":false,"subtype":{}}',
  ])
    assert.equal(matchesQwen(row(source)), true, source);
  for (const source of [
    '{}',
    '{"type":[]}',
    '{"type":{}}',
    '{"type":1}',
    '{"type":true}',
    '{"type":"unknown"}',
    '{"type":"user"}',
    '{"type":"user","message":null}',
    '{"type":"assistant","message":{"parts":[]}}',
    '{"type":"user","message":{"parts":{},"content":"Claude"}}',
  ]) {
    assert.equal(matchesQwen(row(source)), false, source);
    assert.deepEqual(normalizeQwen(row(source)), [], source);
  }
  for (const subtype of [
    'ui_telemetry',
    'attribution_snapshot',
    'file_history_snapshot',
    'slash_command',
    'at_command',
  ]) {
    const source = JSON.stringify({ type: 'system', subtype });
    assert.equal(matchesQwen(row(source)), true);
    assert.deepEqual(normalizeQwen(row(source)), []);
  }
  assert.equal(matchesQwen(row('{"type":"system","subtype":"future"}')), false);
  fails('{"type":"system","subtype":[]}', 'list', true);
  fails('{"type":"system","subtype":{}}', 'dict', true);
  assert.deepEqual(normalizeQwen(row('{"type":"system","subtype":[]}')), []);
  assert.deepEqual(
    normalizeQwen(row('{"type":"user","message":{"parts":[null],"content":"must not leak"}}')),
    []
  );
});

test('filters context wrappers using pinned Python whitespace and Unicode14 decimal digits', () => {
  for (const text of [
    ' --- Content from referenced files ---suffix',
    '--- End of content ---',
    'Content from /repo/file',
    'Content from /\ufeff',
    'Showing lines 1-4',
    'Showing lines \u0661suffix',
    '\u001cShowing lines \u{1d7d8}',
  ]) {
    assertEvents(JSON.stringify({ type: 'user', message: { parts: [{ text }] } }), '[]');
  }
  for (const text of [
    'Content from /',
    'Content from /\u0085tail',
    'Content from /\u001ctail',
    'Showing lines ',
    'Showing lines \u{11f50}',
    'Showing lines \u{1e4f0}',
    'showing lines 1',
    'prefix Showing lines 1',
    '\ufeffShowing lines 1',
  ]) {
    assertEvents(
      JSON.stringify({ type: 'user', message: { parts: [{ text }] } }),
      JSON.stringify([{ ev: 'user_text', text, ts: null }])
    );
  }
});

test('retains original user and interjection text without Claude wrapping or shell decoding', () => {
  assertEvents(
    '{"type":"user","uuid":"u","parentUuid":"p","message":{"parts":[null,{"text":false},{"text":"\\u001c"},{"text":" raw "},{"text":"<bash-input>echo &amp;</bash-input>"}]}}',
    '[{"ev":"user_text","text":" raw ","ts":null},{"ev":"user_text","text":"<bash-input>echo &amp;</bash-input>","ts":null}]'
  );
  assertEvents(
    '{"type":"user","subtype":"mid_turn_user_message","message":{"parts":[{"text":"  <user>steer &amp;</user>  "}]}}',
    '[{"ev":"interjection","text":"  <user>steer &amp;</user>  ","ts":null}]'
  );
  assertEvents(
    '{"type":"user","subtype":"MID_TURN_USER_MESSAGE","message":{"parts":[{"text":"x"}]}}',
    '[{"ev":"user_text","text":"x","ts":null}]'
  );
});

test('preserves part order, strict thought flags and text-before-call precedence without usage events', () => {
  assertEvents(
    '{"type":"assistant","timestamp":true,"message":{"model":"ignored","usage":{"input_tokens":7},"parts":[null,{"text":"think","thought":true,"functionCall":{"name":["bad"]}},{"text":"visible","thought":1},{"text":"string flag","thought":"true"},{"text":" ","functionCall":{"name":"read_file","id":null,"args":[]}},{"text":false,"functionCall":{"name":"future","args":{"run_in_background":"false"}}},{"text":"last"}]}}',
    '[{"ev":"assistant_text","text":"think","ts":"1970-01-01T00:00:01Z","thought":true},{"ev":"assistant_text","text":"visible","ts":"1970-01-01T00:00:01Z"},{"ev":"assistant_text","text":"string flag","ts":"1970-01-01T00:00:01Z"},{"ev":"tool_use","name":"Read","id":null,"input":{},"ts":"1970-01-01T00:00:01Z"},{"ev":"tool_use","name":"future","id":"","input":{"run_in_background":"false"},"ts":"1970-01-01T00:00:01Z"},{"ev":"assistant_text","text":"last","ts":"1970-01-01T00:00:01Z"}]'
  );
  const located = normalizeQwen(
    row('{"type":"assistant","message":{"parts":[null,{"text":"x"},{"functionCall":{}}]}}')
  );
  assert.deepEqual(
    located.map(({ nativeMemberPath }) => nativeMemberPath),
    [
      ['message', 'parts', 1],
      ['message', 'parts', 2, 'functionCall'],
    ]
  );
});

test('maps exactly eleven tool names and preserves Python truthiness for unknown names and arguments', () => {
  for (const [name, mapped] of Object.entries(QWEN_TOOL_NAME_MAP)) {
    assertEvents(
      JSON.stringify({
        type: 'assistant',
        message: { parts: [{ functionCall: { name, args: { x: 1 } } }] },
      }),
      JSON.stringify([{ ev: 'tool_use', name: mapped, id: '', input: { x: 1 }, ts: null }])
    );
  }
  for (const name of ['', null, false, 0, [], {}]) {
    assertEvents(
      JSON.stringify({
        type: 'assistant',
        message: { parts: [{ functionCall: { name, args: false } }] },
      }),
      '[{"ev":"tool_use","name":"","id":"","input":{},"ts":null}]'
    );
  }
  for (const name of ['constructor', '__proto__', 'toString', 'future', true, 7]) {
    assertEvents(
      JSON.stringify({
        type: 'assistant',
        message: { parts: [{ functionCall: { name } }] },
      }),
      JSON.stringify([{ ev: 'tool_use', name, id: '', input: {}, ts: null }])
    );
  }
  assertEvents(
    '{"type":"assistant","message":{"parts":[{"functionCall":{"name":9007199254740993,"id":NaN,"args":{"n":9007199254740993,"run_in_background":"true"}}}]}}',
    '[{"ev":"tool_use","name":9007199254740993,"id":NaN,"input":{"n":9007199254740993,"run_in_background":"true"},"ts":null}]'
  );
  fails('{"type":"assistant","message":{"parts":[{"functionCall":{"name":[1]}}]}}', 'list');
  fails('{"type":"assistant","message":{"parts":[{"functionCall":{"name":{"x":1}}}]}}', 'dict');
});

test('uses only dictionary response payloads and serializes nonstring output without sorting or ASCII escaping', () => {
  assertEvents(
    '{"type":"tool_result","message":{"parts":[null,{"functionResponse":{"response":{"output":" raw "}}},{"functionResponse":{"response":{"output":null}}},{"functionResponse":{"response":{"output":false}}},{"functionResponse":{"response":{"output":{"z":"é","a":9007199254740993,"b":NaN}}}},{"functionResponse":{"response":["ignored"]}},{"functionResponse":false}]}}',
    JSON.stringify([
      {
        ev: 'tool_result',
        id: '',
        content: ' raw ',
        is_error: false,
        ts: null,
      },
      { ev: 'tool_result', id: '', content: 'null', is_error: false, ts: null },
      {
        ev: 'tool_result',
        id: '',
        content: 'false',
        is_error: false,
        ts: null,
      },
      {
        ev: 'tool_result',
        id: '',
        content: '{"z": "é", "a": 9007199254740993, "b": NaN}',
        is_error: false,
        ts: null,
      },
      { ev: 'tool_result', id: '', content: '', is_error: false, ts: null },
    ])
  );
  const results = normalizeQwen(
    row('{"type":"tool_result","message":{"parts":[null,{"functionResponse":{}}]}}')
  );
  assert.deepEqual(results[0]!.nativeMemberPath, ['message', 'parts', 1, 'functionResponse']);
});

test('uses Python truthiness for result IDs and exact string status comparison', () => {
  for (const id of ['', null, false, 0, [], {}]) {
    assertEvents(
      JSON.stringify({
        type: 'tool_result',
        toolCallResult: { callId: 'fallback', status: '' },
        message: { parts: [{ functionResponse: { id } }] },
      }),
      '[{"ev":"tool_result","id":"fallback","content":"","is_error":true,"ts":null}]'
    );
  }
  for (const id of ['own', true, 8, [1], { x: 1 }]) {
    assertEvents(
      JSON.stringify({
        type: 'tool_result',
        toolCallResult: { callId: 'fallback' },
        message: { parts: [{ functionResponse: { id } }] },
      }),
      JSON.stringify([{ ev: 'tool_result', id, content: '', is_error: false, ts: null }])
    );
  }
  for (const [status, isError] of [
    ['success', false],
    ['Success', true],
    ['', true],
    ['failed', true],
    [null, false],
    [false, false],
    [1, false],
    [{}, false],
  ] as const) {
    assertEvents(
      JSON.stringify({
        type: 'tool_result',
        toolCallResult: { callId: null, status },
        message: { parts: [{ functionResponse: { id: 0 } }] },
      }),
      JSON.stringify([
        {
          ev: 'tool_result',
          id: null,
          content: '',
          is_error: isError,
          ts: null,
        },
      ])
    );
  }
});

test('preserves raw occurrences and frozen envelopes, including empty matched and partial dispositions', () => {
  const adapters = [QWEN_ADAPTER];
  const context = makeNormalizationContext({ surface: 'qwen-code' }, adapters);
  const state = createAdapterState(QWEN_ADAPTER, 'source', 'generation', context);
  const raw = Buffer.from(
    '{"type":"assistant","message":{"parts":[{"functionCall":{"name":"write_file","args":{"value":1,"value":9007199254740993}}}]}}'
  );
  const parsed = decodeOccurrence(raw, {
    sourceId: 'source',
    sourceGeneration: 'generation',
    occurrenceId: 'row-1',
    framing: 'complete',
  });
  const before = Buffer.from(raw);
  const result = normalizeOccurrence(parsed, state, context, QWEN_ADAPTER);
  assert.equal(result.disposition, 'normalized');
  assert.equal(result.commitAllowed, true);
  assert.equal(result.nextState.value, null);
  assert.equal(result.events[0]!.event.source_harness, 'qwen-code');
  assert.equal(result.events[0]!.emissionIndex, 0);
  assert.deepEqual(result.events[0]!.nativeMemberPath, ['message', 'parts', 0, 'functionCall']);
  assert.equal(result.source.rawBase64, before.toString('base64'));
  assert.equal(Object.isFrozen(result.events[0]!), true);
  assert.equal(Object.isFrozen(result.events[0]!.nativeMemberPath), true);
  assert.equal(Object.isFrozen(result.events[0]!.event), true);
  const input = result.events[0]!.event.input;
  assert.ok(isJsonObject(input));
  assert.equal(pythonJsonDumps(getMember(input, 'value')!), '9007199254740993');
  assert.equal(Object.isFrozen(input.entries), true);
  raw.fill(0);
  assert.equal(result.source.rawBase64, before.toString('base64'));
  const empty = decodeOccurrence(
    Buffer.from('{"type":"user","message":{"parts":[null],"content":"must not leak"}}'),
    {
      sourceId: 'source',
      sourceGeneration: 'generation',
      occurrenceId: 'row-2',
      framing: 'complete',
    }
  );
  const emptyResult = normalizeOccurrence(empty, state, context, QWEN_ADAPTER);
  assert.equal(emptyResult.disposition, 'normalized');
  assert.equal(emptyResult.commitAllowed, true);
  assert.deepEqual(emptyResult.events, []);
  const partial = decodeOccurrence(before, {
    sourceId: 'source',
    sourceGeneration: 'generation',
    occurrenceId: 'row-3',
    framing: 'partial',
  });
  const tentative = normalizeOccurrence(partial, state, context, QWEN_ADAPTER);
  assert.equal(tentative.tentative, true);
  assert.equal(tentative.commitAllowed, false);
  assert.equal(tentative.events.length, 1);
  assert.equal(state.value, null);
});
