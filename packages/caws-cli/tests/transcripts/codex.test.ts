import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CODEX_ADAPTER,
  CODEX_ADAPTER_REVISION,
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
  serializeCodexInnerActions,
  truncateCodexText,
  type CodexInnerAction,
  type CodexState,
} from '../../src/transcripts/harness-codex';
import {
  codepointTextFromString,
  isCodepointText,
  textLength,
  toJsStringLossless,
  type CodepointText,
} from '../../src/transcripts/codepoint-text';
import { UNICODE_PROFILE_ID } from '../../src/transcripts/python-unicode-profile';
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
function assertText(
  value: CodepointText | null | undefined,
  expected: string | readonly number[]
): void {
  assert.equal(isCodepointText(value), true);
  assert(value !== null && value !== undefined);
  assert.equal(value.profileId, UNICODE_PROFILE_ID);
  assert.deepEqual(
    value.codepoints,
    typeof expected === 'string'
      ? Array.from(expected, (character) => character.codePointAt(0)!)
      : expected
  );
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
    `native-codex/3;interpretation-profile:${UNICODE_PROFILE_ID};python-sha256:fca73c2b632122bc471322b38452db3ea41cf3eab693d02be757fd9217b31ee0`
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
  assert.equal(result.interpretationProfileId, UNICODE_PROFILE_ID);
  assert(result.disposition === 'indexed');
  assert.deepEqual(
    result.actions.map((a) => a.tool),
    ['exec_command', 'view_image']
  );
  assertText(result.actions[0]!.command, 'literal');
  for (const action of result.actions) {
    assert.equal(action.execution, 'not_observed');
    assert.equal(action.observation_boundary, 'source_syntax');
  }
  const event = only(
    item(`{"type":"custom_tool_call","name":"functions.exec","input":${pythonJsonDumps(source)}}`)
  );
  assert.equal(getMember(event.input, 'raw'), source);
});

test('literal decoding/indexing preserves Python escapes, template refusal and Unicode codepoints', () => {
  assertText(decodeJsString("'\\a\\101\\x42\\u0043\\U0001f600\\q'"), '\x07ABC😀\\q');
  assertText(decodeJsString('"\\ud800"'), '\ud800');
  assertText(decodeJsString("'\\ud800'"), '\ud800');
  assert.equal(decodeJsString("'" + '\ud800' + "'"), null);
  assertText(decodeJsString('`literal\\nline`'), 'literal\nline');
  assert.equal(decodeJsString('`runtime ${command}`'), null);
  assert.equal(decodeJsString("'unterminated"), null);
  assertText(
    truncateCodexText(codepointTextFromString('😀😀😀x', UNICODE_PROFILE_ID), 3),
    '😀😀😀...'
  );
  const patch = '*** Add File: 😀.txt\n+hello\n';
  const source = `const patch = ${pythonJsonDumps(patch)}; tools.apply_patch(patch);`;
  const actions = extractCodexInnerActions(source);
  assert.equal(actions.length, 1);
  assert.equal(actions[0]!.files!.length, 1);
  assertText(actions[0]!.files![0], '😀.txt');
  assert.equal(actions[0]!.patch_length, Array.from(patch).length);
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
  assert.equal(actions[0]!.batch_commands!.length, 2);
  assertText(actions[0]!.batch_commands![0], 'echo left');
  assertText(actions[0]!.batch_commands![1], 'echo right');
  assert.equal(actions[0]!.command, undefined);
  assertText(actions[1]!.args_preview, '{argument: 1}');
  assert.equal(actions[2]!.command, undefined);
  assert.deepEqual(balancedCallArgument('call(nested(', 4), ['nested(', 12]);
});

test('named Unicode literals use qualified names, aliases and algorithmic lookup', () => {
  const source = "tools.exec_command({cmd:'\\N{LATIN CAPITAL LETTER A}'})";
  assertText(decodeJsString("'\\N{LATIN CAPITAL LETTER A}'"), 'A');
  assertText(decodeJsString("'\\N{latin capital letter a}'"), 'A');
  assertText(decodeJsString("'\\N{NULL}\\N{BYTE ORDER MARK}'"), [0, 0xfeff]);
  assertText(
    decodeJsString("'\\N{HANGUL SYLLABLE GA}\\N{CJK UNIFIED IDEOGRAPH-4E00}'"),
    [0xac00, 0x4e00]
  );
  for (const token of [
    "'\\N{UNKNOWN CHARACTER}'",
    "'\\N{}'",
    "'\\N{KEYCAP DIGIT ONE}'",
    "'\\N'",
    "'\\N{LATIN CAPITAL LETTER A'",
  ])
    assert.equal(decodeJsString(token), null, token);
  const result = extractCodexSourceIndex(source);
  assert.equal(result.disposition, 'indexed');
  assert.equal(result.rawSource, source);
  assertText(result.actions[0]!.command, 'A');
});

test('source indexing uses pinned Python word continuation and boundaries while preserving Unicode literals', () => {
  const source = 'const π = 1; tools.exec_command({cmd:"echo literal"});';
  assertText(extractCodexInnerActions(source)[0]!.command, 'echo literal');
  const unicodeLiteral = '// π is a comment\nconst text = "π"; tools.view_image({path:"π.png"});';
  const supported = extractCodexSourceIndex(unicodeLiteral);
  assert.equal(supported.disposition, 'indexed');
  assert(supported.disposition === 'indexed');
  assert.equal(supported.actions.length, 1);
  assertText(supported.actions[0]!.path, 'π.png');
  const wordSource =
    'const pπ = "patch"; tools.apply_patch(pπ); tools.aπ(); tools.a²(); tools.a\u{1e4f0}(); πtools.hidden(); ²tools.hidden(); \u{1e4f0}tools.visible();';
  const actions = extractCodexInnerActions(wordSource);
  assert.deepEqual(
    actions.map((action) => action.tool),
    ['apply_patch', 'aπ', 'a²', 'visible']
  );
  assertText(actions[0]!.patch_preview, 'patch');
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

test('adjacent Python surrogate codepoints survive indexing, distinct from JSON combining', () => {
  for (const source of [
    "tools.apply_patch('\\ud83d\\ude00');",
    "tools.exec_command({cmd:'\\ud83d\\ude00'});",
  ]) {
    const result = extractCodexSourceIndex(source);
    assert.equal(result.disposition, 'indexed');
    assert.equal(result.rawSource, source);
    const action = result.actions[0]!;
    const value = action.tool === 'apply_patch' ? action.patch_preview : action.command;
    assertText(value, [0xd83d, 0xde00]);
    assert(value);
    assert.equal(textLength(value), 2);
    assert.deepEqual(toJsStringLossless(value), {
      ok: false,
      reason: 'adjacentSurrogateCollapse',
      index: 0,
      codepoint: 0xd83d,
    });
  }
  assertText(decodeJsString("'\\ud800'"), '\ud800');
  assertText(decodeJsString("'\\U0000dc00'"), '\udc00');
  assertText(decodeJsString("'😀'"), '😀');
  assertText(decodeJsString("'\\U0001f600'"), '😀');
  // json.loads combines these escaped surrogate pairs, unlike ast.literal_eval.
  assertText(decodeJsString('"\\ud83d\\ude00"'), '😀');
  const jsonLiteral = extractCodexSourceIndex('tools.apply_patch("\\ud83d\\ude00");');
  assert.equal(jsonLiteral.disposition, 'indexed');
  assert(jsonLiteral.disposition === 'indexed');
  assert.equal(jsonLiteral.actions[0]!.patch_length, 1);
});

test('literal decoding rejects malformed Python and JSON while retaining historical template replacements', () => {
  for (const token of [
    "'\\x0'",
    "'\\u000'",
    "'\\U00110000'",
    "'a\nb'",
    "'a\rb'",
    "'a\0b'",
    "'\\'",
    '"\\x41"',
    '"unterminated',
    'false',
  ])
    assert.equal(decodeJsString(token), null, token);
  assertText(decodeJsString("'\\777\\400\\8'"), [0x1ff, 0x100, 0x5c, 0x38]);
  assertText(decodeJsString("'a\\\nb\\\r\nc'"), 'abc');
  assertText(decodeJsString('`\\`\\\\\\n\\r\\t`'), '`\\\n\r\t');
  const actions = extractCodexInnerActions(
    "tools.exec_command({cmd:'',command:'fallback',workdir:''}); tools.view_image({path:''}); tools.apply_patch(''); tools.exec_command({cmd:'\\N{KEYCAP DIGIT ONE}'});"
  );
  assertText(actions[0]!.command, 'fallback');
  assert.equal(actions[0]!.workdir, undefined);
  assert.equal(actions[1]!.path, undefined);
  assert.deepEqual(actions[2]!.files, []);
  assertText(actions[2]!.patch_preview, []);
  assert.equal(actions[2]!.patch_length, 0);
  assert.equal(actions[3]!.command, undefined);
});

test('patch path extraction retains surrogate vector identity, ordered uniqueness and historical whitespace matching', () => {
  const source = String.raw`tools.apply_patch('*** Add File:\u0085\ud83d\ude00.txt\u3000\n*** Update File: \U0001f600.txt\n*** Delete File: \ud83d\ude00.txt\n*** Add File:  \nnext-line\n*** Update File: a\rb.ts\n*** Update File: second\u2028piece.ts');`;
  const action = extractCodexInnerActions(source)[0]!;
  assert.equal(action.files!.length, 5);
  assertText(action.files![0], [0xd83d, 0xde00, 46, 116, 120, 116]);
  assertText(action.files![1], '😀.txt');
  assertText(action.files![2], 'next-line');
  assertText(action.files![3], 'a\rb.ts');
  assertText(action.files![4], 'second\u2028piece.ts');
  const ignored = extractCodexInnerActions(
    String.raw`tools.apply_patch('prefix\r*** Add File: not-LF\n *** Add File: indented\n*** Rename File: unsupported');`
  )[0]!;
  assert.deepEqual(ignored.files, []);
});

test('previews slice codepoint vectors and preserve the original full patch length', () => {
  const source = `tools.apply_patch('${'a'.repeat(2999)}\\ud83d\\ude00');`;
  const action = extractCodexInnerActions(source)[0]!;
  assert.equal(action.patch_length, 3001);
  assertText(action.patch_preview, [...Array<number>(2999).fill(97), 0xd83d, 46, 46, 46]);
  assertText(truncateCodexText(null, 2), []);
  assertText(truncateCodexText(undefined, 2), []);
  for (const limit of [-1, 0.5, NaN, Infinity])
    assert.throws(() => truncateCodexText(null, limit), RangeError);
  assertText(truncateCodexText(codepointTextFromString('a', UNICODE_PROFILE_ID), 0), '...');
});

test('action serialization is an explicit non-injective projection of independently retained immutable vectors', () => {
  const pair = extractCodexInnerActions(
    String.raw`tools.exec_command({cmd:'\ud83d\ude00',workdir:'\ud800'});`
  );
  const astral = extractCodexInnerActions(
    String.raw`tools.exec_command({cmd:'\U0001f600',workdir:'\ud800'});`
  );
  assertText(pair[0]!.command, [0xd83d, 0xde00]);
  assertText(astral[0]!.command, [0x1f600]);
  const projected = serializeCodexInnerActions(pair);
  assert.equal(
    projected,
    '[{"tool": "exec_command", "observation_boundary": "source_syntax", "execution": "not_observed", "command": "\\ud83d\\ude00", "workdir": "\\ud800"}]'
  );
  assert.equal(serializeCodexInnerActions(astral), projected);
  assert.equal(serializeCodexInnerActions(pair, { ensureAscii: false }), projected);
  assert.equal(
    serializeCodexInnerActions(astral, { ensureAscii: false }),
    '[{"tool": "exec_command", "observation_boundary": "source_syntax", "execution": "not_observed", "command": "😀", "workdir": "\\ud800"}]'
  );
  assert.equal(Object.isFrozen(pair), true);
  assert.equal(Object.isFrozen(pair[0]), true);
  assert.throws(() => {
    (pair[0] as { execution: string }).execution = 'observed';
  }, TypeError);
  const patch = extractCodexInnerActions('tools.apply_patch("*** Add File: a\\n");');
  assert.equal(Object.isFrozen(patch[0]!.files), true);
  assert.equal(
    serializeCodexInnerActions(patch),
    '[{"tool": "apply_patch", "observation_boundary": "source_syntax", "execution": "not_observed", "files": ["a"], "patch_preview": "*** Add File: a\\n", "patch_length": 16}]'
  );
  const batch = extractCodexInnerActions(
    String.raw`const jobs = [['a', '\ud83d\ude00'], ['b', '\U0001f600']]; Promise.all(jobs.map(([x,cmd]) => tools.exec_command({cmd})));`
  );
  assert.equal(Object.isFrozen(batch[0]!.batch_commands), true);
  assertText(batch[0]!.batch_commands![0], [0xd83d, 0xde00]);
  assertText(batch[0]!.batch_commands![1], [0x1f600]);
  assert.equal(serializeCodexInnerActions([]), '[]');
});

test('historical action serialization rejects foreign profiles and structural text impostors', () => {
  const selected = codepointTextFromString('A', UNICODE_PROFILE_ID);
  const foreign = codepointTextFromString('A', 'foreign-interpretation-profile');
  const impostor = { ...selected } as CodepointText;
  const metadata = {
    tool: 'fixture',
    observation_boundary: 'source_syntax' as const,
    execution: 'not_observed' as const,
  };
  for (const field of [
    'command',
    'workdir',
    'path',
    'patch_preview',
    'args_preview',
    'files',
    'batch_commands',
  ] as const) {
    const isArray = field === 'files' || field === 'batch_commands';
    const action = (value: CodepointText): CodexInnerAction => ({
      ...metadata,
      [field]: isArray ? [value] : value,
    });
    assert.equal(
      serializeCodexInnerActions([action(selected)]),
      `[{"tool": "fixture", "observation_boundary": "source_syntax", "execution": "not_observed", "${field}": ${isArray ? '["A"]' : '"A"'}}]`
    );
    assert.throws(() => serializeCodexInnerActions([action(foreign)]), {
      name: 'RangeError',
      message: 'Codex action text requires the selected interpretation profile',
    });
    assert.throws(() => serializeCodexInnerActions([action(impostor)]), {
      name: 'TypeError',
      message: 'Expected constructed CodepointText for Codex action text',
    });
  }
});
