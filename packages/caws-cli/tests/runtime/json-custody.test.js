const {
  parseJsonSource,
  sameJsonSource,
  objectMemberJson,
  enrichObjectJson,
} = require('../../dist/runtime/json-custody');
const equal = (a, b) => sameJsonSource(parseJsonSource(a), parseJsonSource(b));

test('compares keys and decoded strings while distinguishing exact numeric tokens', () => {
  expect(equal('{"a":"\\u0061","b":[true,null]}', '{"b":[true,null],"a":"a"}')).toBe(true);
  for (const [a, b] of [
    ['9007199254740993', '9007199254740992'],
    ['-9007199254740993', '-9007199254740992'],
    ['-0', '-0.0'],
    ['1e400', '1e401'],
    ['-0', '0'],
    ['1', '"1"'],
    ['null', 'false'],
    ['[]', '{}'],
    ['[1]', '[]'],
    ['[1]', '[2]'],
    ['{"a":1}', '{"b":1}'],
    ['{"a":1}', '{"a":1,"b":2}'],
  ])
    expect(equal(a, b)).toBe(false);
  expect(equal('{"a":1,"a":2}', '{"a":2}')).toBe(true);
});

test('metadata replacement retains nested tokens, strings with delimiters, and escaped keys', () => {
  const source = parseJsonSource(
    String.raw` {"hook_event_name":"Wrong","hook_event_name":"AlsoWrong","\u0074ool_input":{"n":18446744073709551617,"text":"[}\""},"__proto__":{"n":-0}}` +
      '\n'
  );
  expect(objectMemberJson(source, 'tool_input')).toBe(
    String.raw`{"n":18446744073709551617,"text":"[}\""}`
  );
  expect(objectMemberJson(source, 'missing')).toBe('{}');
  expect(objectMemberJson(parseJsonSource('[]'), 'missing')).toBe('{}');
  expect(objectMemberJson(parseJsonSource('{"tool_input":null}'), 'tool_input')).toBe('{}');
  expect(enrichObjectJson(source, 'hook_event_name', 'PreToolUse')).toBe(
    String.raw`{"tool_input":{"n":18446744073709551617,"text":"[}\""},"__proto__":{"n":-0},"hook_event_name":"PreToolUse"}`
  );
  expect(enrichObjectJson(parseJsonSource('{}'), 'hook_event_name', 'Stop')).toBe(
    '{"hook_event_name":"Stop"}'
  );
  expect(() => enrichObjectJson(parseJsonSource('[]'), 'event', 'Stop')).toThrow(/object/);
});

test('rejects malformed grammar and bounds source indexing', () => {
  expect(parseJsonSource('[0]', 1, 2).root.kind).toBe('array');
  expect(parseJsonSource('0', 0, 1).root.kind).toBe('number');
  for (const source of ['{', '{"n":NaN}', '{"n":01}', '{"a":1,}'])
    expect(() => parseJsonSource(source)).toThrow();
  expect(() => parseJsonSource('[[[0]]]', 2)).toThrow(/structural limit/);
  expect(() => parseJsonSource('[1,2]', 128, 2)).toThrow(/structural limit/);
});
