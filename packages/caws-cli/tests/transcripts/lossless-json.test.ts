import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePythonJson,
  encodeSourceJson,
  pythonJsonDumps,
  jsonNumber,
  jsonObject,
  getMember,
  hasMember,
  isJsonNumber,
  isJsonObject,
  pythonTruthy,
  pythonEqual,
  pythonStr,
  pythonRepr,
  UnsupportedPythonProfileError,
} from '../../src/transcripts/lossless-json.js';

test('retains adjacent unsafe integers, nested numbers and separate nested JSON strings', () => {
  const source =
    '{"a":9007199254740992,"b":9007199254740993,"nested":[-9007199254740993,18446744073709551617]}';
  const parsed = parsePythonJson(source);
  assert.equal(encodeSourceJson(parsed), source);
  assert.equal(pythonEqual(getMember(parsed, 'a'), getMember(parsed, 'b')), false);
  const outer = parsePythonJson(String.raw`{"arguments":"{\"id\":9007199254740993}"}`);
  const argumentsText = getMember(outer, 'arguments');
  assert.equal(typeof argumentsText, 'string');
  assert.equal(
    encodeSourceJson(parsePythonJson(argumentsText as string)),
    '{"id":9007199254740993}'
  );
});

test('separates source spelling from interpreted Python integer and binary64 formatting', () => {
  const cases: readonly (readonly [string, string])[] = [
    ['1e1', '10.0'],
    ['1e400', 'Infinity'],
    ['-1e400', '-Infinity'],
    ['NaN', 'NaN'],
    ['Infinity', 'Infinity'],
    ['-Infinity', '-Infinity'],
    ['1.0', '1.0'],
    ['-0', '0'],
    ['-0.0', '-0.0'],
    ['-1e-400', '-0.0'],
    ['9007199254740993.0', '9007199254740992.0'],
    ['1e15', '1000000000000000.0'],
    ['1e16', '1e+16'],
    ['1e23', '1e+23'],
    ['1e-4', '0.0001'],
    ['1e-5', '1e-05'],
    ['1e-6', '1e-06'],
    ['5e-324', '5e-324'],
    ['2.2250738585072014e-308', '2.2250738585072014e-308'],
    ['1.7976931348623157e308', '1.7976931348623157e+308'],
    ['1.234567890123456789', '1.2345678901234567'],
    ['1000000000000000128.0', '1.0000000000000001e+18'],
  ];
  for (const [source, interpreted] of cases) {
    const value = parsePythonJson(source);
    assert.equal(encodeSourceJson(value), source, 'source token: ' + source);
    assert.equal(pythonJsonDumps(value), interpreted, 'interpreted float: ' + source);
  }
});

test('object order is insertion order, duplicate values replace in their first key slot', () => {
  const value = parsePythonJson('{"2":2,"10":10,"2":3,"__proto__":{"safe":true}}');
  assert.equal(encodeSourceJson(value), '{"2":3,"10":10,"__proto__":{"safe":true}}');
  assert.equal(pythonJsonDumps(value), '{"2": 3, "10": 10, "__proto__": {"safe": true}}');
  assert.equal(
    pythonJsonDumps(value, { sortKeys: true }),
    '{"10": 10, "2": 3, "__proto__": {"safe": true}}'
  );
  assert.equal(hasMember(value, '__proto__'), true);
  assert.equal(hasMember(value, 'missing'), false);
  assert.equal(getMember(value, 'missing'), undefined);
  assert.equal(getMember(null, '__proto__'), undefined);
  assert.equal(isJsonObject(value), true);
  assert.equal(({} as { safe?: boolean }).safe, undefined);
});

test('Unicode escaping preserves astral and lone surrogate values and sorts code points', () => {
  const value = parsePythonJson(String.raw`["é","\ud83d\ude00","\ud800","\udc00","\u007f"]`);
  assert.equal(
    pythonJsonDumps(value),
    String.raw`["\u00e9", "\ud83d\ude00", "\ud800", "\udc00", "\u007f"]`
  );
  assert.equal(
    pythonJsonDumps(value, { ensureAscii: false }),
    '["é", "😀", "\ud800", "\udc00", "\x7f"]'
  );
  const keys = jsonObject([
    ['\u{10000}', null],
    ['\ue000', null],
  ]);
  assert.equal(
    pythonJsonDumps(keys, { sortKeys: true }),
    String.raw`{"\ue000": null, "\ud800\udc00": null}`
  );
  assert.equal(pythonEqual(parsePythonJson(encodeSourceJson(value)), value), true);
  assert.equal(encodeSourceJson(value), '["é","😀","\\ud800","\\udc00","\x7f"]');
  assert.equal(pythonStr('😀\ud800'), '😀\ud800');
});

test('constructors own deeply immutable values without freezing caller containers', () => {
  const caller = [jsonNumber('9007199254740993')];
  const value = jsonObject([['a', caller]]);
  caller.push(jsonNumber('1'));
  assert.equal(encodeSourceJson(value), '{"a":[9007199254740993]}');
  assert.equal(Object.isFrozen(value), true);
  assert.equal(Object.isFrozen(value.entries), true);
  assert.equal(Object.isFrozen(value.entries[0]), true);
  assert.equal(Object.isFrozen(getMember(value, 'a')), true);
  assert.equal(Object.isFrozen(caller), false);
  assert.equal(isJsonNumber(jsonNumber('1e1')), true);
  assert.equal(isJsonNumber({ kind: 'number', lexeme: '1e1', numberKind: 'integer' }), false);
});

test('rejects malformed grammar without incorporating source payload in diagnostics', () => {
  const invalid = [
    '',
    ' ',
    '01',
    '-01',
    '+1',
    '1.',
    '.1',
    '1e',
    '1e+',
    '-NaN',
    'nan',
    '[1,]',
    '{"a":1,}',
    '{a:1}',
    '{"a" 1}',
    'true false',
    'nullx',
    '[1 2]',
    '"\\x41"',
    '"\\u12x4"',
    '"unclosed',
    '"line\nfeed"',
    '\ufeffnull',
  ];
  for (const source of invalid) assert.throws(() => parsePythonJson(source), SyntaxError, source);
  assert.throws(() => jsonNumber('9007199254740993oops'), SyntaxError);
  assert.throws(() => jsonNumber('1\n'), SyntaxError);
  assert.throws(
    () => parsePythonJson('{"PRIVATE_VALUE":SECRET}'),
    (error) => {
      assert(error instanceof SyntaxError);
      assert.match(error.message, /^Invalid Python JSON at offset [0-9]+$/);
      assert.equal(error.message.includes('PRIVATE_VALUE'), false);
      assert.equal(error.message.includes('SECRET'), false);
      return true;
    }
  );
});

test('truth and equality use Python numeric semantics without integer rounding', () => {
  for (const source of ['null', 'false', '0', '-0', '0.0', '-0.0', '1e-400', '""', '[]', '{}'])
    assert.equal(pythonTruthy(parsePythonJson(source)), false, source);
  for (const source of ['true', 'NaN', 'Infinity', '1', '-1', '"0"', '[0]', '{"a":null}'])
    assert.equal(pythonTruthy(parsePythonJson(source)), true, source);
  assert.equal(pythonTruthy(undefined), false);
  for (const [a, b, expected] of [
    ['true', '1', true],
    ['false', '0.0', true],
    ['1', '1e0', true],
    ['9007199254740993', '9007199254740993.0', false],
    ['9007199254740992', '9007199254740993.0', true],
    ['-9007199254740993', '-9007199254740993.0', false],
    ['1e400', 'Infinity', true],
    ['NaN', 'NaN', false],
    ['1', '"1"', false],
    ['[]', '{}', false],
    ['{"a":1,"b":true}', '{"b":1,"a":true}', true],
    ['[NaN]', '[NaN]', true],
  ] as const)
    assert.equal(pythonEqual(parsePythonJson(a), parsePythonJson(b)), expected, a + ' == ' + b);
  assert.equal(pythonEqual(undefined, undefined), true);
  assert.equal(pythonEqual(undefined, null), false);
});

test('Python str/repr retain type spellings and expose the Unicode profile boundary', () => {
  assert.equal(
    pythonStr(parsePythonJson('[true,null,1e1,NaN,Infinity]')),
    '[True, None, 10.0, nan, inf]'
  );
  assert.equal(
    pythonRepr(parsePythonJson('{"a":"can\'t","b":"a\\nb"}')),
    "{'a': \"can't\", 'b': 'a\\nb'}"
  );
  assert.equal(pythonRepr('\x00\x7f\xa0\xad\ud800'), "'\\x00\\x7f\\xa0\\xad\\ud800'");
  assert.throws(
    () => pythonRepr(['😀']),
    (error) => {
      assert(error instanceof UnsupportedPythonProfileError);
      assert.equal(error.code, 'PYTHON_PROFILE_UNSUPPORTED');
      assert.equal(error.operation, 'repr-unicode-14');
      return true;
    }
  );
});

test('integer custody has no hidden decimal digit cap', () => {
  // The observed CPython reference has int_max_str_digits=4300. This codec
  // deliberately retains larger tokens; this test documents that profile
  // extension, and does not claim reference parser parity beyond that cap.
  const source = '1' + '0'.repeat(4300);
  assert.equal(encodeSourceJson(parsePythonJson(source)), source);
  assert.equal(pythonJsonDumps(parsePythonJson(source)), source);
});
