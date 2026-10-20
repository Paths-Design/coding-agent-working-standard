import test from 'node:test';
import assert from 'node:assert/strict';
import {
  asBool,
  codepointLength,
  codepointOrder,
  codepointSlice,
  decodeStructuredTextPayload,
  parseContextAuthorityBlock,
  parseHookStdout,
  parseTimestamp,
  patchPaths,
  pythonStrip,
} from '../../src/transcripts/harness-common';
import {
  getMember,
  jsonNumber,
  jsonObject,
  parsePythonJson,
  pythonJsonDumps,
  type JsonValue,
} from '../../src/transcripts/lossless-json';

const dump = (value: JsonValue): string => pythonJsonDumps(value, { ensureAscii: false });

test('normalizes only the exact lowercase boolean strings and retains all other JSON values', () => {
  assert.equal(asBool('true'), true);
  assert.equal(asBool('false'), false);
  const object = jsonObject([['value', 'false']]);
  const integer = jsonNumber('9007199254740993');
  for (const value of [
    undefined,
    null,
    false,
    true,
    '',
    'TRUE',
    'False',
    ' true ',
    integer,
    object,
    [],
  ] as const) {
    assert.equal(asBool(value), value);
  }
});

test('uses Python whitespace and Unicode codepoint boundaries rather than JS trim or UTF-16 lengths', () => {
  assert.equal(pythonStrip('\u001c\u001d\u001e\u001f\u0085\u2007 x \u3000'), 'x');
  assert.equal(pythonStrip('\ufeff x \ufeff'), '\ufeff x \ufeff');
  assert.equal(pythonStrip('\u180e x \u180e'), '\u180e x \u180e');
  assert.equal(codepointLength('A😀B'), 3);
  assert.equal(codepointSlice('A😀B', 1, 2), '😀');
  assert.equal(codepointSlice('A😀B', -2), '😀B');
  assert.equal(codepointSlice('A😀B', 2, 1), '');
  assert.ok(codepointOrder('\ue000', '😀') < 0);
  assert.ok(codepointOrder('😀', '😀a') < 0);
});

test('interprets timestamps only deliberately, retaining fallback strings and exact large integers', () => {
  for (const value of [
    undefined,
    null,
    false,
    '',
    [],
    jsonObject([]),
    jsonNumber('0'),
    jsonNumber('-0.0'),
  ] as const) {
    assert.equal(parseTimestamp(value), null);
  }
  assert.equal(parseTimestamp('not an ISO date'), 'not an ISO date');
  assert.equal(parseTimestamp(true), '1970-01-01T00:00:01Z');
  assert.equal(parseTimestamp(jsonNumber('1')), '1970-01-01T00:00:01Z');
  assert.equal(parseTimestamp(jsonNumber('-1')), '1969-12-31T23:59:59Z');
  assert.equal(parseTimestamp(jsonNumber('1.25')), '1970-01-01T00:00:01Z');
  assert.equal(parseTimestamp(jsonNumber('-0.25')), '1969-12-31T23:59:59Z');
  assert.equal(parseTimestamp(jsonNumber('0.9999999')), '1970-01-01T00:00:01Z');
  assert.equal(parseTimestamp(jsonNumber('9007199254740993')), '9007199254740993');
  // The qualified CPython/macOS oracle formats the lower supported year with four digits.
  assert.equal(parseTimestamp(jsonNumber('-62135596800')), '0001-01-01T00:00:00Z');
  assert.equal(parseTimestamp(['a', true]), "['a', True]");
});

test('extracts nonblank text blocks in order without trimming their payloads or dropping malformed input', () => {
  assert.equal(
    decodeStructuredTextPayload(' \u001c[{"text":" one "},{"text":"\u0085"},{"text":"two"},7] '),
    ' one \n\ntwo'
  );
  assert.equal(decodeStructuredTextPayload('{"text":"only"}'), 'only');
  for (const raw of [
    'plain',
    '  plain  ',
    '[broken',
    '[{"text":false}]',
    '{"text":" "}',
    '0',
    '',
  ]) {
    assert.equal(decodeStructuredTextPayload(raw), raw);
  }
  const retained = jsonObject([['text', 'unchanged']]);
  assert.equal(decodeStructuredTextPayload(retained), retained);
  assert.equal(decodeStructuredTextPayload(false), '');
  assert.equal(decodeStructuredTextPayload([]), '');
});

test('retains context authority section replacement, setdefault, indentation, and attachment behavior', () => {
  const value = parseContextAuthorityBlock(
    [
      'context-authority: target:with:colons  ',
      'active-specs: first',
      'active-specs:',
      '  - second ',
      '  plain third',
      'empty: (none)',
      'attachment: first.json',
      'attachment: second.json',
      'other:',
      '\u00a0- unicode indent counts as a new key: inline',
      '  ignored because the previous top-level section had a value',
      'active-specs: replacement',
      'active-specs:',
      '\t- final',
    ].join('\r\n')
  );
  assert.notEqual(value, null);
  assert.equal(
    dump(value!),
    '{"target": "target:with:colons", "sections": {"active_specs": ["replacement", "final"], "empty": [], "other": [], "_ unicode indent counts as a new key": ["inline"]}, "attachment": "second.json"}'
  );
  // An initial ASCII indentation is significant; splitting also follows Python splitlines.
  assert.equal(parseContextAuthorityBlock(' context-authority: nope'), null);
  assert.equal(
    dump(parseContextAuthorityBlock('context-authority: t\u0085entries:\u2028  - a\u001e  - b')!),
    '{"target": "t", "sections": {"entries": ["a", "b"]}}'
  );
  assert.equal(
    dump(parseContextAuthorityBlock('context-authority: t\n: value\n:\n  - ignored')!),
    '{"target": "t", "sections": {"": ["value"]}}'
  );
});

test('parses structured hook stdout, retaining absent versus explicit event values and nested authority', () => {
  const text = 'context-authority: target\nentries:\n  - one';
  const stdout = pythonJsonDumps(
    jsonObject([
      [
        'hookSpecificOutput',
        jsonObject([
          ['additionalContext', text],
          ['hookEventName', false],
        ]),
      ],
    ])
  );
  const parsed = parseHookStdout(stdout)!;
  assert.equal(getMember(parsed, 'hook_event'), false);
  assert.equal(getMember(parsed, 'additional_context'), text);
  assert.equal(getMember(parsed, 'kind'), 'context_authority');
  assert.equal(
    dump(getMember(parsed, 'context_authority')!),
    '{"target": "target", "sections": {"entries": ["one"]}}'
  );
  assert.equal(
    dump(parseHookStdout('{"hookSpecificOutput":{"additionalContext":"normal context"}}')!),
    '{"hook_event": null, "additional_context": "normal context", "kind": "additional_context"}'
  );
  for (const input of [
    undefined,
    null,
    false,
    '',
    ' ',
    '[1]',
    '{}',
    '{bad',
    '{"hookSpecificOutput":[]}',
    '{"hookSpecificOutput":{"additionalContext":"\\u001c"}}',
  ] as const) {
    assert.equal(parseHookStdout(input), null);
  }
});

test('extracts ordered unique patch paths with Python LF anchors, Unicode whitespace, and dot behavior', () => {
  assert.deepEqual(
    patchPaths(
      '*** Begin Patch\n*** Add File: a.ts\r\n*** Update File: b.ts\n*** Delete File: a.ts\n*** End Patch'
    ),
    ['a.ts', 'b.ts']
  );
  assert.deepEqual(
    patchPaths('*** Add File:\u0085😀.ts\u3000\n*** Update File: second\u2028piece.ts'),
    ['😀.ts', 'second\u2028piece.ts']
  );
  assert.deepEqual(
    patchPaths(
      'prefix\r*** Add File: not-an-LF-line\n *** Add File: indented\n*** Rename File: unsupported'
    ),
    []
  );
  assert.deepEqual(patchPaths('*** Add File: a\rb.ts'), ['a\rb.ts']);
  // The source regex allows its \s* to cross a newline after an otherwise empty path.
  assert.deepEqual(patchPaths('*** Add File:  \nnext-line'), ['next-line']);
});

test('retains large integers and object order inside decoded helper projections', () => {
  const raw = '{"hookSpecificOutput":{"hookEventName":9007199254740993,"additionalContext":"x"}}';
  const result = parseHookStdout(raw)!;
  assert.equal(dump(getMember(result, 'hook_event')!), '9007199254740993');
  const object = parsePythonJson('{"a":1,"b":2}');
  assert.equal(decodeStructuredTextPayload(object), object);
});

test('timestamp signed fractional rounding distinguishes the negative half-microsecond neighbors', () => {
  const cases = [
    ['-5.000000000000001e-7', '1969-12-31T23:59:59Z'],
    ['-5e-7', '1970-01-01T00:00:00Z'],
    ['-4.999999999999999e-7', '1970-01-01T00:00:00Z'],
    ['5.000000000000001e-7', '1970-01-01T00:00:00Z'],
    ['5e-7', '1970-01-01T00:00:00Z'],
    ['4.999999999999999e-7', '1970-01-01T00:00:00Z'],
    ['-0.9999995', '1969-12-31T23:59:59Z'],
    ['-1.0000005', '1969-12-31T23:59:58Z'],
  ] as const;
  for (const [token, expected] of cases)
    assert.equal(parseTimestamp(jsonNumber(token)), expected, token);
});
