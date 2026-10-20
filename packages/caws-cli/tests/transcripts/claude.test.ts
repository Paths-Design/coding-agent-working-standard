import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CLAUDE_ADAPTER,
  CLAUDE_ADAPTER_REVISION,
  CLAUDE_NOISE_PREFIXES,
  ClaudeProjectionError,
  extractTextFromContentBlocks,
  extractToolResultContent,
  matchesClaude,
  normalizeClaude,
} from '../../src/transcripts/harness-claude';
import { PYTHON_HTML_PROFILE_ID } from '../../src/transcripts/python-html';
import {
  createAdapterState,
  makeNormalizationContext,
  normalizeOccurrence,
} from '../../src/transcripts/harness-common';
import { decodeOccurrence } from '../../src/transcripts/source-occurrence';
import {
  encodeSourceJson,
  isJsonObject,
  jsonNumber,
  parsePythonJson,
  type JsonObject,
} from '../../src/transcripts/lossless-json';
function row(source: string): JsonObject {
  const value = parsePythonJson(source);
  assert(isJsonObject(value));
  return value;
}
function events(source: string) {
  return normalizeClaude(row(source)).map(({ event }) => event);
}
// Exact expected values below are derived from the SHA-bound historical adapter.
function errorType(source: string, type: ClaudeProjectionError['pythonType'], match = false): void {
  assert.throws(
    () => (match ? matchesClaude(row(source)) : normalizeClaude(row(source))),
    (error: unknown) => error instanceof ClaudeProjectionError && error.pythonType === type
  );
}
test('broad Claude matching and malformed type failures preserve historical dispatch', () => {
  for (const type of [
    'user',
    'assistant',
    'attachment',
    'ai-title',
    'cost-state',
    'queue-operation',
    'system',
  ])
    assert.equal(matchesClaude(row(JSON.stringify({ type }))), true);
  for (const source of ['{}', '{"type":null}', '{"type":true}', '{"type":1}', '{"type":"qwen"}'])
    assert.equal(matchesClaude(row(source)), false);
  for (const source of ['{"type":[]}', '{"type":{}}']) {
    errorType(source, 'TypeError', true);
    errorType(source, 'TypeError');
  }
  assert.equal(CLAUDE_ADAPTER.createState(), null);
  assert.equal(CLAUDE_ADAPTER.cloneState(null), null);
  assert(Object.isFrozen(CLAUDE_ADAPTER));
  assert.throws(() => {
    (CLAUDE_ADAPTER as unknown as { revision: string }).revision = 'forged';
  }, TypeError);
  assert.throws(() => {
    (CLAUDE_ADAPTER as unknown as { matches: unknown }).matches = () => false;
  }, TypeError);
  assert.equal(CLAUDE_ADAPTER.matches(row('{\"type\":\"user\"}')), true);
  assert(CLAUDE_ADAPTER_REVISION.includes(PYTHON_HTML_PROFILE_ID));
  assert(
    CLAUDE_ADAPTER_REVISION.includes(
      'c6d94da874c7af48c9dcb90e5f6fa53671bf04154f8a1b8e3c945e71c853026d'
    )
  );
  assert.equal(CLAUDE_NOISE_PREFIXES[6], '<!-- copy-turn:');
});
test('content flattening honors text precedence, Python whitespace and JSON false/zero', () => {
  assert.equal(
    extractTextFromContentBlocks(
      parsePythonJson(
        '[null,1,{"type":"json","text":" keep ","json":1},{"type":"json","text":"\\u001c","json":false},{"type":"json","json":0},{"type":"json","json":{"é":1}},{"type":"json","json":null}]'
      )
    ),
    ' keep \n\nfalse\n\n0\n\n{"é": 1}'
  );
  assert.equal(extractTextFromContentBlocks(false), '');
  assert.equal(extractTextFromContentBlocks('  '), '  ');
  assert.equal(extractTextFromContentBlocks(parsePythonJson('[{"text":"\\ufeff"}]')), '\ufeff');
});
test('tool-result precedence and nonstring fallback retain historical values', () => {
  assert.equal(
    extractToolResultContent(
      row('{"tool_use_result":{"file":{"content":" file "},"text":"text"},"content":"other"}')
    ),
    ' file '
  );
  assert.equal(
    extractToolResultContent(
      row('{"tool_use_result":{"file":{"content":"  "},"text":"text"},"content":"other"}')
    ),
    'text'
  );
  assert.equal(extractToolResultContent(row('{"content":[{"text":"block"}]}')), 'block');
  for (const raw of ['[1]', '{"x":2}', 'true', '7']) {
    const source = row(`{"content":${raw}}`);
    assert.equal(encodeSourceJson(extractToolResultContent(source)), raw);
  }
  for (const raw of ['null', 'false', '0', '[]', '{}'])
    assert.equal(extractToolResultContent(row(`{"content":${raw}}`)), '');
});
test('user block ordering, raw tool metadata and nonempty string lineage are preserved', () => {
  const result = normalizeClaude(
    row(
      '{"type":"user","uuid":"u","parentUuid":"p","message":{"content":[false,{"type":"text","text":"first"},{"type":"tool_result","tool_use_id":null,"content":[1],"is_error":"false","tool_use_result":{"unknown":7}},{"type":"text","text":"last"}]}}'
    )
  );
  assert.deepEqual(
    result.map(({ nativeMemberPath }) => nativeMemberPath),
    [
      ['message', 'content', 1],
      ['message', 'content', 2],
      ['message', 'content', 3],
    ]
  );
  assert.deepEqual(
    result.map(({ event }) => event.ev),
    ['user_text', 'tool_result', 'user_text']
  );
  assert.deepEqual(result[0]!.event, {
    ev: 'user_text',
    text: 'first',
    ts: null,
    uuid: 'u',
    parent_uuid: 'p',
  });
  assert.equal(result[1]!.event.id, null);
  assert.equal(result[1]!.event.is_error, 'false');
  assert.equal(encodeSourceJson(result[1]!.event.content!), '[1]');
  assert.equal(encodeSourceJson(result[1]!.event.tool_use_result!), '{"unknown":7}');
  assert.deepEqual(events('{"type":"user","uuid":1,"parentUuid":"","message":{"content":""}}'), [
    { ev: 'user_text', text: '', ts: null },
  ]);
});
test('shell wrappers decode matched interiors only, with strict startswith dispatch', () => {
  assert.deepEqual(
    events(
      '{"type":"user","uuid":"u","message":{"content":"<bash-input>echo &amp; &NotEqualTilde;</bash-input>tail &gt;"}}'
    ),
    [{ ev: 'user_shell', command: 'echo & ≂̸', ts: null }]
  );
  assert.deepEqual(events('{"type":"user","message":{"content":"<bash-input>broken &gt;"}}'), [
    { ev: 'user_shell', command: '<bash-input>broken &gt;', ts: null },
  ]);
  assert.deepEqual(
    events(
      '{"type":"user","message":{"content":"<bash-stderr>err &lt;</bash-stderr><bash-stdout>out &gt;</bash-stdout>"}}'
    ),
    [{ ev: 'user_shell', stdout: 'out >', stderr: 'err <', ts: null }]
  );
  assert.deepEqual(events('{"type":"user","message":{"content":" <bash-input>x</bash-input>"}}'), [
    { ev: 'user_text', text: ' <bash-input>x</bash-input>', ts: null },
  ]);
  assert.deepEqual(events('{"type":"user","message":{"content":"<bash-stdout>broken &gt;"}}'), [
    { ev: 'user_shell', stdout: '', stderr: '', ts: null },
  ]);
});
test('assistant events and duplicate metadata preserve ordering, Python truthiness and exact numeric custody', () => {
  const raw =
    '{"type":"assistant","requestId":"r","message":{"id":"m","model":{"x":1},"stop_reason":true,"usage":{"input_tokens":9007199254740993,"output_tokens":true,"cache_read_input_tokens":1e999,"cache_creation_input_tokens":"9","extra":99},"content":[{"type":"text","text":false},{"type":"thinking","thinking":[],"text":"fallback"},{"type":"thinking","thinking":[1],"text":"dropped"},{"type":"tool_use","name":"Agent","input":{"run_in_background":"false","other":"true"}}]}}';
  const first = events(raw),
    second = events(raw);
  assert.deepEqual(second, first);
  assert.deepEqual(
    first.map(({ ev }) => ev),
    ['assistant_text', 'reasoning', 'tool_use', 'assistant_meta']
  );
  assert.equal(first[0]!.text, false);
  assert.equal(first[1]!.text, 'fallback');
  assert.equal(encodeSourceJson(first[2]!.input!), '{"run_in_background":false,"other":"true"}');
  assert.equal(
    encodeSourceJson(first[3]!.usage!),
    '{"input_tokens":9007199254740993,"output_tokens":true,"cache_read_input_tokens":1e999}'
  );
  assert.equal(first[3]!.message_id, 'm');
  assert.equal(first[3]!.request_id, 'r');
  assert.equal(encodeSourceJson(first[3]!.model!), '{"x":1}');
  assert.equal(first[3]!.stop_reason, true);
  assert.deepEqual(
    events(
      '{"type":"assistant","message":{"model":{},"stop_reason":[],"usage":{"input_tokens":"3"}}}'
    ),
    []
  );
  assert.deepEqual(events('{"type":"assistant","message":{"content":"ignored","model":"model"}}'), [
    { ev: 'assistant_meta', ts: null, model: 'model' },
  ]);
});
test('control numeric copying differs from message count int conversion', () => {
  const event = events(
    '{"type":"cost-state","totalCostUSD":true,"totalAPIDuration":1e999,"totalToolDuration":9007199254740993,"totalLinesAdded":false,"totalLinesRemoved":"1","modelUsage":{"𐀀":{},"":null,"a":0}}'
  )[0]!;
  assert.equal(event.cost_usd, true);
  assert.equal(event.lines_added, false);
  assert.deepEqual(event.models, ['a', '', '𐀀']);
  assert.equal(encodeSourceJson(event.api_duration_ms!), '1e999');
  assert.equal(encodeSourceJson(event.tool_duration_ms!), '9007199254740993');
  assert.equal(event.lines_removed, undefined);
  for (const [raw, expected] of [
    ['true', '1'],
    ['false', '0'],
    ['-1.9', '-1'],
    ['9007199254740993', '9007199254740993'],
    ['9007199254740993.0', '9007199254740992'],
    [
      '1e100',
      '10000000000000000159028911097599180468360808563945281389781327557747838772170381060813469985856815104',
    ],
  ])
    assert.equal(
      encodeSourceJson(
        events(`{"type":"system","subtype":"turn_duration","messageCount":${raw}}`)[0]!
          .message_count!
      ),
      expected
    );
  errorType('{"type":"system","subtype":"turn_duration","messageCount":NaN}', 'ValueError');
  for (const raw of ['Infinity', '-Infinity', '1e999'])
    errorType(`{"type":"system","subtype":"turn_duration","messageCount":${raw}}`, 'OverflowError');
  assert.deepEqual(
    events('{"type":"system","subtype":"turn_duration","durationMs":null,"messageCount":"2"}'),
    [{ ev: 'control', subtype: 'turn_duration', ts: null }]
  );
});
test('empty control fields follow each historical guard independently', () => {
  assert.deepEqual(events('{"type":"ai-title","aiTitle":" title "}'), [
    { ev: 'control', subtype: 'session_title', text: ' title ', ts: null },
  ]);
  assert.deepEqual(events('{"type":"ai-title","aiTitle":" "}'), []);
  assert.deepEqual(events('{"type":"queue-operation","operation":" "}'), [
    { ev: 'control', subtype: 'queue_operation', text: ' ', ts: null },
  ]);
  assert.deepEqual(
    events('{"type":"system","subtype":"informational","content":"notice","level":" "}'),
    [{ ev: 'control', subtype: 'system_notice', text: 'notice', ts: null, level: ' ' }]
  );
  assert.deepEqual(events('{"type":"system","subtype":[],"content":"notice"}'), []);
  assert.deepEqual(events('{"type":"system","subtype":"stop_hook_summary","content":"text"}'), []);
  assert.deepEqual(events('{"type":"cost-state"}'), [
    { ev: 'control', subtype: 'cost_state', ts: null },
  ]);
});
test('human interjections support structured blocks, legacy repr, and Python whitespace wrapping', () => {
  assert.deepEqual(
    events(
      '{"type":"attachment","attachment":{"type":"queued_command","origin":{"kind":"human"},"prompt":[{"text":"\\u001c<user> hello </user>\\u001c"}]}}'
    ),
    [{ ev: 'interjection', text: 'hello', ts: null }]
  );
  const legacy = {
    type: 'attachment',
    attachment:
      "{'type': 'queued_command', 'origin': 'human', 'prompt': '<user>hi</user>', 'commandMode': 'normal'}",
  };
  assert.deepEqual(events(JSON.stringify(legacy)), [{ ev: 'interjection', text: 'hi', ts: null }]);
  const empty = {
    ...legacy,
    attachment:
      "{'type': 'queued_command', 'origin': 'human', 'prompt': '', 'commandMode': 'normal'}",
  };
  assert.deepEqual(events(JSON.stringify(empty)), [{ ev: 'interjection', text: '', ts: null }]);
  assert.deepEqual(
    events(
      '{"type":"attachment","attachment":{"type":"queued_command","origin":{"kind":"agent"},"prompt":"hi"}}'
    ),
    []
  );
  assert.deepEqual(
    events(
      '{"type":"attachment","attachment":{"type":"queued_command","origin":{"kind":"human"},"prompt":" "}}'
    ),
    []
  );
});
test('hook context includes source metadata and hook-event precedence', () => {
  const stdout = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'native',
      additionalContext: 'context-authority: target\naccepted:\n - yes',
    },
  });
  const result = events(
    JSON.stringify({
      type: 'attachment',
      timestamp: 1,
      attachment: {
        type: 'hook_success',
        stdout,
        hookName: 'hook',
        hookEvent: 'fallback',
        toolUseID: 'tool',
        exitCode: false,
        durationMs: 12,
      },
    })
  )[0]!;
  assert.equal(result.ev, 'hook_context');
  assert.equal(result.hook_event, 'native');
  assert.equal(result.hook_name, 'hook');
  assert.equal(result.tool_use_id, 'tool');
  assert.equal(result.exit_code, false);
  assert.deepEqual(result.duration_ms, jsonNumber('12'));
  assert.equal(result.ts, '1970-01-01T00:00:01Z');
  assert.equal(
    encodeSourceJson(result.context_authority!),
    '{"target":"target","sections":{"accepted":["yes"]}}'
  );
  const fallback = events(
    JSON.stringify({
      type: 'attachment',
      attachment: {
        type: 'hook_success',
        stdout: JSON.stringify({
          hookSpecificOutput: { hookEventName: false, additionalContext: 'ctx' },
        }),
        hookEvent: 'fallback',
      },
    })
  )[0]!;
  assert.equal(fallback.hook_event, 'fallback');
  assert.equal(fallback.tool_use_id, null);
  assert.deepEqual(
    events('{"type":"attachment","attachment":{"type":"hook_success","stdout":"not-json"}}'),
    []
  );
});
test('malformed message and user text throw while assistant text retains arbitrary values', () => {
  for (const kind of ['user', 'assistant'])
    for (const raw of ['null', 'false', '1', '"x"', '[]'])
      errorType(`{"type":"${kind}","message":${raw}}`, 'AttributeError');
  for (const raw of ['null', 'false', '1', '[]', '{}'])
    errorType(
      `{"type":"user","message":{"content":[{"type":"text","text":${raw}}]}}`,
      'AttributeError'
    );
  assert.deepEqual(
    events('{"type":"assistant","message":{"content":[{"type":"text","text":null}]}}'),
    [{ ev: 'assistant_text', text: null, ts: null }]
  );
  assert.deepEqual(events('{"type":"user"}'), []);
  assert.deepEqual(events('{"type":"assistant"}'), []);
});
test('synthetic occurrences preserve bytes, duplicate keys and immutable source across normalizations', () => {
  const bytes = Buffer.from(
    ' {"type":"assistant","message":{"content":[{"type":"tool_use","input":{"run_in_background":"true","unknown":9007199254740993}}]},"foreign":1,"foreign":2}\n'
  );
  const parsed = decodeOccurrence(bytes, {
    sourceId: 'synthetic',
    sourceGeneration: 'g',
    occurrenceId: 'o',
    framing: 'complete',
    byteOffset: 9n,
    lineOrdinal: 2n,
  });
  assert.equal(parsed.disposition, 'parsed');
  const context = makeNormalizationContext({ surface: 'claude-code' }, [CLAUDE_ADAPTER]);
  const state = createAdapterState(CLAUDE_ADAPTER, 'synthetic', 'g', context);
  const normalized = normalizeOccurrence(parsed, state, context, CLAUDE_ADAPTER);
  assert.equal(normalized.source, parsed.source);
  assert.equal(normalized.original, parsed);
  assert.equal(Buffer.from(normalized.source.rawBase64, 'base64').toString(), bytes.toString());
  assert.deepEqual(normalized.events[0]!.nativeMemberPath, ['message', 'content', 0]);
  assert.equal(
    encodeSourceJson(normalized.events[0]!.event.input!),
    '{"run_in_background":true,"unknown":9007199254740993}'
  );
  assert.equal(normalized.events[0]!.event.source_harness, 'claude');
  assert.equal(normalized.commitAllowed, true);
  assert(Object.isFrozen(normalized.events[0]!.event.input));
  assert.throws(() => {
    (normalized.events[0]!.nativeMemberPath as unknown as string[]).push('bad');
  }, TypeError);
  assert.equal(
    parsed.disposition === 'parsed' ? encodeSourceJson(parsed.row) : '',
    '{"type":"assistant","message":{"content":[{"type":"tool_use","input":{"run_in_background":"true","unknown":9007199254740993}}]},"foreign":2}'
  );
  assert.deepEqual(
    normalizeOccurrence(parsed, state, context, CLAUDE_ADAPTER).events,
    normalized.events
  );
});
