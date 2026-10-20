import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CODEX_ADAPTER,
  CODEX_ADAPTER_REVISION,
  UnsupportedCodexStringEscape,
  UnsupportedCodexIdentifierProfile,
  balancedCallArgument,
  cloneCodexState,
  codexOutputIsError,
  createCodexState,
  decodeJsString,
  decodeMapping,
  extractCodexInnerActions,
  extractCodexSourceIndex,
  matchesCodex,
  normalizeCodexRow,
  truncateCodexText,
  type CodexState,
} from '../../src/transcripts/harness-codex';
import {
  encodeSourceJson,
  getMember,
  isJsonObject,
  jsonObject,
  parsePythonJson,
  pythonJsonDumps,
  type JsonObject,
  type JsonValue,
} from '../../src/transcripts/lossless-json';
import type { CanonicalEvent } from '../../src/transcripts/harness-common';

function row(source: string): JsonObject {
  const value = parsePythonJson(source);
  assert(isJsonObject(value));
  return value;
}
function norm(source: string, state: CodexState = createCodexState()) {
  return normalizeCodexRow(row(source), state);
}
function item(payload: string, state: CodexState = createCodexState()) {
  return norm(`{"type":"response_item","payload":${payload}}`, state);
}
function only(result: ReturnType<typeof normalizeCodexRow>): CanonicalEvent {
  assert.equal(result.events.length, 1);
  return result.events[0]!.event;
}
function exact(value: JsonValue | undefined): string {
  assert.notEqual(value, undefined);
  return encodeSourceJson(value!);
}
const boundary = '{"type":"turn_context","payload":{"turn_id":"turn-A","model":"fixture"}}';
const call = (id: string) =>
  `{"type":"function_call","name":"Read","call_id":${id},"arguments":"{}"}`;
const output = (id: string) => `{"type":"function_call_output","call_id":${id},"output":"done"}`;
const developer =
  '{"type":"message","role":"developer","content":[{"type":"input_text","text":"[guard.sh] detail"}]}';

test('Codex adapter identity and matching preserve ownership of uninteresting event rows', () => {
  assert.equal(CODEX_ADAPTER.id, 'codex');
  assert.equal(
    CODEX_ADAPTER_REVISION,
    'native-codex/1;unicode:14.0.0;python-sha256:fca73c2b632122bc471322b38452db3ea41cf3eab693d02be757fd9217b31ee0'
  );
  for (const type of ['turn_context', 'response_item', 'token_usage_record', 'event_msg'])
    assert.equal(matchesCodex(row(`{"type":"${type}"}`)), true);
  assert.equal(matchesCodex(row('{"type":"assistant"}')), false);
  assert.equal(matchesCodex(row('{"type":1}')), false);
  assert.deepEqual(norm('{"type":"event_msg","payload":{"type":"item_completed"}}').events, []);
  assert.deepEqual(norm('{"type":"response_item","payload":[]}').events, []);
});

test('unsafe numeric IDs and nested tool arguments remain exact and distinct', () => {
  const a = item(
    '{"type":"function_call","call_id":9007199254740992,"name":"Read","arguments":"{\\"limit\\":9007199254740993,\\"nested\\":{\\"offset\\":-9007199254740995}}"}'
  );
  const b = item(
    '{"type":"function_call","call_id":9007199254740993,"name":"Read","arguments":{"limit":9007199254740995}}',
    a.state
  );
  assert.equal(exact(only(a).id), '9007199254740992');
  assert.equal(exact(only(b).id), '9007199254740993');
  assert.equal(exact(getMember(only(a).input, 'limit')), '9007199254740993');
  assert.equal(exact(getMember(getMember(only(a).input, 'nested'), 'offset')), '-9007199254740995');
  assert.equal(exact(getMember(only(b).input, 'limit')), '9007199254740995');
  const unrelated = item(output('9007199254740992'), b.state);
  assert.equal(exact(unrelated.state.pendingToolId), '9007199254740993');
  assert.equal(item(output('9007199254740993'), unrelated.state).state.pendingToolId, undefined);
});

test('mapping fallback retains invalid/nonobject source and duplicate-key last value', () => {
  assert.equal(
    exact(decodeMapping('{"n":9007199254740993,"n":9007199254740995}')),
    '{"n":9007199254740995}'
  );
  for (const source of ['not json', '[1,2]', 'null'])
    assert.equal(getMember(decodeMapping(source), 'raw'), source);
  assert.equal(exact(decodeMapping(false)), '{}');
  assert.equal(exact(decodeMapping(undefined)), '{}');
});

test('structured tool output uses Python float and lexical-key serialization', () => {
  const projected = only(
    item(
      '{"type":"function_call_output","call_id":"n","output":{"n":1.0,"z":-0.0,"e":1e3,"2":"b","10":"a"}}'
    )
  );
  assert.equal(projected.content, '{"10": "a", "2": "b", "e": 1000.0, "n": 1.0, "z": -0.0}');
  assert.equal(projected.is_error, false);
  assert.equal(
    only(item('{"type":"function_call_output","output":{"n":NaN,"p":Infinity,"m":-Infinity}}'))
      .content,
    '{"m": -Infinity, "n": NaN, "p": Infinity}'
  );
  assert.equal(
    only(item('{"type":"function_call_output","output":[{"text":"hello"},{"text":"world"}]}'))
      .content,
    '[{"text": "hello"}, {"text": "world"}]'
  );
});

test('interleaved results clear only matching pending calls and boundaries do not reset them', () => {
  const original = norm(boundary).state;
  const a = item(call('"A"'), original),
    b = item(call('"B"'), a.state);
  const completedA = item(output('"A"'), b.state);
  assert.equal(completedA.state.pendingToolId, 'B');
  const boundaryAgain = norm(boundary, completedA.state);
  assert.equal(boundaryAgain.state.pendingToolId, 'B');
  const context = only(item(developer, boundaryAgain.state));
  assert.equal(context.hook_event, 'PreToolUse');
  assert.equal(context.tool_use_id, 'B');
  const completedB = item(output('"B"'), boundaryAgain.state);
  assert.equal(completedB.state.pendingToolId, undefined);
  assert.equal(only(item(developer, completedB.state)).hook_event, 'Context');
  assert.deepEqual(original, { turnSeen: true });
  assert.equal(a.state.pendingToolId, 'A');
  assert.notEqual(cloneCodexState(original), original);
});

test('Python truthiness/equality is retained for ID fallback and numeric booleans', () => {
  const pending = item('{"type":"function_call","call_id":[],"id":"fallback","name":"Read"}');
  assert.equal(only(pending).id, 'fallback');
  const boolean = item('{"type":"function_call","call_id":true,"name":"Read"}');
  assert.equal(item(output('1'), boolean.state).state.pendingToolId, undefined);
  const zero = item('{"type":"function_call","call_id":0,"id":false,"name":"Read"}');
  assert.equal(only(zero).id, false);
});

test('usage and control retain Python numeric admission including booleans and non-finite values', () => {
  const usage = only(
    norm(
      '{"type":"token_usage_record","payload":{"usage":{"input_tokens":9007199254740993,"output_tokens":true,"cached_input_tokens":NaN,"total_tokens":"99","unknown":4}}}'
    )
  );
  assert.equal(
    exact(usage.usage),
    '{"input_tokens":9007199254740993,"output_tokens":true,"cached_input_tokens":NaN}'
  );
  const abort = only(
    norm('{"type":"event_msg","payload":{"type":"turn_aborted","reason":42,"duration_ms":false}}')
  );
  assert.equal(abort.text, '42');
  assert.equal(abort.duration_ms, false);
  assert.equal(abort.subtype, 'turn_aborted');
  assert.equal(
    only(norm('{"type":"token_usage_record","payload":{"usage":{"input_tokens":"1"}}}')).usage,
    null
  );
  assert.deepEqual(norm('{"type":"token_usage_record","payload":{}}').events, []);
});

test('boundaries retain numeric/environment values and return independent state', () => {
  const state = Object.freeze({ turnSeen: false, pendingToolId: 'prior' });
  const result = norm(
    '{"type":"turn_context","timestamp":0,"payload":{"turn_id":9007199254740993,"model":"x","effort":false,"cwd":" ","approval_policy":1.0,"sandbox_policy":{}}}',
    state
  );
  assert.equal(only(result).ts, null);
  assert.equal(exact(only(result).turn_id), '9007199254740993');
  assert.equal(only(result).effort, false);
  assert.equal(only(result).cwd, undefined);
  assert.equal(exact(only(result).approval_policy), '1.0');
  assert.equal(only(result).sandbox_policy, undefined);
  assert.equal(result.state.pendingToolId, 'prior');
  assert.equal(result.state.turnSeen, true);
  assert.equal(state.turnSeen, false);
});

test('message filtering retains original content positions and duplicate text occurrences', () => {
  const result = item(
    '{"type":"message","role":"user","internal_chat_message_metadata_passthrough":{"content_item_kinds":["context.injected","user.text","user.text"]},"content":[{"type":"input_text","text":"injected"},{"type":"input_text","text":"same"},{"type":"input_text","text":"same"},{"type":"input_text","text":"unclassified"}]}'
  );
  assert.deepEqual(
    result.events.map((x) => x.event.text),
    ['same', 'same']
  );
  assert.deepEqual(
    result.events.map((x) => x.nativeMemberPath),
    [
      ['payload', 'content', 1],
      ['payload', 'content', 2],
    ]
  );
  assert.deepEqual(
    item(
      '{"type":"message","role":"user","content":[{"type":"input_text","text":"# AGENTS.md instructions for /fixture"},{"type":"input_text","text":"same-row human"}]}'
    ).events,
    []
  );
  assert.deepEqual(
    item(
      '{"type":"message","role":"assistant","channel":"analysis","content":[{"type":"output_text","text":"private analysis"}]}'
    ).events,
    []
  );
});

test('reasoning summaries retain duplicate occurrences and skip ciphertext-only rows', () => {
  const result = item(
    '{"type":"reasoning","encrypted_content":"opaque","summary":[{"text":"same"},{"text":"same"},{"text":" "},null]}'
  );
  assert.deepEqual(
    result.events.map((x) => x.event.text),
    ['same', 'same']
  );
  assert.deepEqual(
    result.events.map((x) => x.nativeMemberPath),
    [
      ['payload', 'summary', 0],
      ['payload', 'summary', 1],
    ]
  );
  assert.deepEqual(
    item('{"type":"reasoning","encrypted_content":"opaque","summary":[]}').events,
    []
  );
});

test('developer context is gated by turn history and pending state survives unknown compaction rows', () => {
  assert.deepEqual(item(developer).events, []);
  const pending = item(call('"A"'), norm(boundary).state).state;
  const unchanged = norm('{"type":"event_msg","payload":{"type":"context_compacted"}}', pending);
  assert.deepEqual(unchanged.events, []);
  assert.deepEqual(unchanged.state, pending);
  assert.notEqual(unchanged.state, pending);
  const context = only(
    item(
      '{"type":"message","role":"developer","content":[{"type":"input_text","text":"context-authority: fixture\\nchoices:\\n- retained"}]}',
      unchanged.state
    )
  );
  assert.equal(context.hook_name, 'casr-context.sh');
  assert.equal(context.tool_use_id, 'A');
  assert.equal(getMember(context.context_authority, 'target'), 'fixture');
});

test('shell tool normalization preserves cmd presence even when its value is null or empty', () => {
  for (const name of ['exec_command', 'functions.exec_command', 'shell_command']) {
    const event = only(
      item(
        `{"type":"function_call","name":"${name}","arguments":{"cmd":"","command":"must not win","limit":9007199254740993}}`
      )
    );
    assert.equal(event.name, 'Bash');
    assert.equal(getMember(event.input, 'command'), '');
    assert.equal(exact(getMember(event.input, 'limit')), '9007199254740993');
  }
  assert.equal(
    getMember(
      only(
        item(
          '{"type":"function_call","name":"exec_command","arguments":{"cmd":null,"command":"x"}}'
        )
      ).input,
      'command'
    ),
    null
  );
  assert.equal(
    only(item('{"type":"function_call","name":"functions.exec","arguments":"const x = 1;"}')).name,
    'functions.exec'
  );
});

test('static inner actions preserve raw program and never claim observed execution', () => {
  const source =
    '// tools.exec_command({cmd:"comment"})\nconst text = "tools.view_image({path: \'quoted\'})";\nif (false) { tools.exec_command({cmd:"literal", workdir:"/fixture"}); }\nawait tools.view_image({path:"image.png"});';
  const result = extractCodexSourceIndex(source);
  assert.equal(result.disposition, 'indexed');
  assert.equal(result.rawSource, source);
  assert.equal(result.observationBoundary, 'source_syntax');
  assert.equal(result.execution, 'not_observed');
  assert(result.disposition === 'indexed');
  assert.deepEqual(
    result.actions.map((a) => getMember(a, 'tool')),
    ['exec_command', 'view_image']
  );
  assert.equal(getMember(result.actions[0], 'command'), 'literal');
  for (const action of result.actions) {
    assert.equal(getMember(action, 'execution'), 'not_observed');
    assert.equal(getMember(action, 'observation_boundary'), 'source_syntax');
  }
  const event = only(
    item(`{"type":"custom_tool_call","name":"functions.exec","input":${pythonJsonDumps(source)}}`)
  );
  assert.equal(getMember(event.input, 'raw'), source);
});

test('literal decoding/indexing preserves Python escapes, template refusal and Unicode codepoints', () => {
  assert.equal(decodeJsString("'\\a\\101\\x42\\u0043\\U0001f600\\q'"), '\x07ABC😀\\q');
  assert.equal(decodeJsString('"\\ud800"'), '\ud800');
  assert.equal(decodeJsString("'\\ud800'"), '\ud800');
  assert.equal(decodeJsString("'" + '\ud800' + "'"), null);
  assert.equal(decodeJsString('`literal\\nline`'), 'literal\nline');
  assert.equal(decodeJsString('`runtime ${command}`'), null);
  assert.equal(decodeJsString("'unterminated"), null);
  assert.equal(truncateCodexText('😀😀😀x', 3), '😀😀😀...');
  const patch = '*** Add File: 😀.txt\n+hello\n';
  const source = `const patch = ${pythonJsonDumps(patch)}; tools.apply_patch(patch);`;
  const actions = extractCodexInnerActions(source);
  assert.equal(actions.length, 1);
  assert.equal(exact(getMember(actions[0], 'files')), '["😀.txt"]');
  assert.equal(exact(getMember(actions[0], 'patch_length')), String(Array.from(patch).length));
  assert.deepEqual(balancedCallArgument('call("(literal)", nested(1)) rest', 4), [
    '"(literal)", nested(1)',
    28,
  ]);
});

test('static indexing retains batch literals, generic argument previews and unresolved interpolation', () => {
  const source =
    'const jobs = [["left", "echo left"], ["right", "echo right"]]; Promise.all(jobs.map(([label,cmd]) => tools.exec_command({cmd}))); tools.unknown({argument: 1}); tools.exec_command({cmd:`echo ${runtime}`});';
  const actions = extractCodexInnerActions(source);
  assert.equal(actions.length, 3);
  assert.equal(exact(getMember(actions[0], 'batch_commands')), '["echo left","echo right"]');
  assert.equal(getMember(actions[0], 'command'), undefined);
  assert.equal(getMember(actions[1], 'args_preview'), '{argument: 1}');
  assert.equal(getMember(actions[2], 'command'), undefined);
  assert.deepEqual(balancedCallArgument('call(nested(', 4), ['nested(', 12]);
});

test('unsupported named Unicode interpretation retains source and cannot appear as an empty index', () => {
  const source = "tools.exec_command({cmd:'\\N{LATIN CAPITAL LETTER A}'})";
  assert.throws(
    () => decodeJsString("'\\N{LATIN CAPITAL LETTER A}'"),
    UnsupportedCodexStringEscape
  );
  assert.throws(() => extractCodexInnerActions(source), UnsupportedCodexStringEscape);
  const result = extractCodexSourceIndex(source);
  assert.deepEqual(result, {
    disposition: 'unsupported',
    rawSource: source,
    reason: 'named_unicode_escape',
    observationBoundary: 'source_syntax',
    execution: 'not_observed',
  });
  assert.equal('actions' in result, false);
});

test('source index explicitly declines even Python14 Unicode identifiers while preserving Unicode literals', () => {
  // Greek pi predates Unicode14: this is a declared sacrificed subset, not an invalid-source claim.
  const source = 'const π = 1; tools.exec_command({cmd:"echo literal"});';
  assert.throws(() => extractCodexInnerActions(source), UnsupportedCodexIdentifierProfile);
  assert.deepEqual(extractCodexSourceIndex(source), {
    disposition: 'unsupported',
    rawSource: source,
    reason: 'unicode_identifier_profile',
    observationBoundary: 'source_syntax',
    execution: 'not_observed',
  });
  const unicodeLiteral = '// π is a comment\nconst text = "π"; tools.view_image({path:"π.png"});';
  const supported = extractCodexSourceIndex(unicodeLiteral);
  assert.equal(supported.disposition, 'indexed');
  assert(supported.disposition === 'indexed');
  assert.equal(supported.actions.length, 1);
  assert.equal(getMember(supported.actions[0], 'path'), 'π.png');
});

test('output errors require exact booleans or the retained textual status forms', () => {
  for (const source of [
    'Process exited with code 2',
    'Process exited with code 00',
    'Process exited with code ٠',
    ' Script failed: detail',
    '[{"success":false}]',
    '{"is_error":true}',
  ])
    assert.equal(codexOutputIsError(source, source), true, source);
  for (const source of [
    'Process exited with code 0',
    '{"success":0}',
    '{"is_error":1}',
    'ordinary output',
    '{broken',
  ])
    assert.equal(codexOutputIsError(source, source), false, source);
  assert.equal(codexOutputIsError('[{"text":"Tool failed: reason"}]', 'Tool failed: reason'), true);
  // Nag Mundari digits were assigned after the pinned Python Unicode14 profile.
  for (const tail of ['\u{1e4f0}', '0\u{1e4f0}'])
    assert.equal(codexOutputIsError('Process exited with code ' + tail, ''), false);
});

test('source rows and input state remain unchanged after all normalized projections', () => {
  const source = row(
    '{"type":"response_item","payload":{"type":"function_call","name":"exec_command","call_id":"A","arguments":{"cmd":"echo unchanged","command":"before"}}}'
  );
  const before = encodeSourceJson(source),
    state = Object.freeze({ turnSeen: true, pendingToolId: 'prior' });
  const result = normalizeCodexRow(source, state);
  assert.equal(encodeSourceJson(source), before);
  assert.deepEqual(state, { turnSeen: true, pendingToolId: 'prior' });
  assert.equal(result.state.pendingToolId, 'A');
  assert.notEqual(result.state, state);
  assert.equal(getMember(only(result).input, 'command'), 'echo unchanged');
  assert.equal(exact(jsonObject([])), '{}');
});
