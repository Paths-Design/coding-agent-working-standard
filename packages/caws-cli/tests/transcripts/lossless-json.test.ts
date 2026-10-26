import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePythonJson,
  type JsonNumber,
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

test('Python str/repr retain type spellings under the pinned Unicode14 profile', () => {
  assert.equal(
    pythonStr(parsePythonJson('[true,null,1e1,NaN,Infinity]')),
    '[True, None, 10.0, nan, inf]'
  );
  assert.equal(
    pythonRepr(parsePythonJson('{"a":"can\'t","b":"a\\nb"}')),
    "{'a': \"can't\", 'b': 'a\\nb'}"
  );
  assert.equal(pythonRepr('\x00\x7f\xa0\xad\ud800'), "'\\x00\\x7f\\xa0\\xad\\ud800'");
  assert.equal(pythonRepr(['😀']), "['😀']");
  assert.equal(pythonRepr('π\u2028\u2029\u200b'), "'π\\u2028\\u2029\\u200b'");
  // This character is assigned after Unicode14, regardless of the Node runtime's tables.
  assert.equal(pythonRepr('\u{1fae8}'), "'\\U0001fae8'");
});

test('integer custody has no hidden decimal digit cap', () => {
  // The observed CPython reference has int_max_str_digits=4300. This codec
  // deliberately retains larger tokens; this test documents that profile
  // extension, and does not claim reference parser parity beyond that cap.
  const source = '1' + '0'.repeat(4300);
  assert.equal(encodeSourceJson(parsePythonJson(source)), source);
  assert.equal(pythonJsonDumps(parsePythonJson(source)), source);
});

test('optional admission leaves default parser and standalone number constructor uncapped', () => {
  const huge = '1' + '0'.repeat(4300);
  assert.equal(encodeSourceJson(parsePythonJson(huge)), huge);
  assert.equal(encodeSourceJson(parsePythonJson(huge, {})), huge);
  assert.equal(encodeSourceJson(jsonNumber(huge)), huge);
});

test('admission observes every numeric member once before duplicate collapse', () => {
  const seen: JsonNumber[] = [];
  const parsed = parsePythonJson('{"x":1,"nested":[2,{"x":3}],"x":4}', {
    admitNumberToken: (token) => {
      seen.push(token);
    },
  });
  assert.deepEqual(
    seen.map((token) => token.lexeme),
    ['1', '2', '3', '4']
  );
  assert.equal(encodeSourceJson(parsed), '{"x":4,"nested":[2,{"x":3}]}');
});

test('admission receives frozen tokens with integer and float spellings intact', () => {
  const seen: JsonNumber[] = [];
  const source = '[-0,1.0,1e2,NaN,Infinity,-Infinity]';
  assert.equal(
    encodeSourceJson(
      parsePythonJson(source, {
        admitNumberToken: (token) => {
          assert.equal(Object.isFrozen(token), true);
          seen.push(token);
        },
      })
    ),
    source
  );
  assert.deepEqual(
    seen.map(({ lexeme, numberKind }) => [lexeme, numberKind]),
    [
      ['-0', 'integer'],
      ['1.0', 'float'],
      ['1e2', 'float'],
      ['NaN', 'float'],
      ['Infinity', 'float'],
      ['-Infinity', 'float'],
    ]
  );
});

test('admission never visits quoted digits or numeric object keys', () => {
  const seen: JsonNumber[] = [];
  const source = '{"123":"' + '9'.repeat(4301) + '","nested":["-12","1e2"]}';
  assert.equal(
    encodeSourceJson(
      parsePythonJson(source, {
        admitNumberToken: (token) => {
          seen.push(token);
        },
      })
    ),
    source
  );
  assert.deepEqual(seen, []);
});

test('syntax before a huge number prevents that token admission', () => {
  const seen: JsonNumber[] = [];
  assert.throws(
    () =>
      parsePythonJson('{"broken":!,"later":' + '9'.repeat(4301) + '}', {
        admitNumberToken: (token) => {
          seen.push(token);
        },
      }),
    SyntaxError
  );
  assert.deepEqual(seen, []);
});

// Deliberately local policy: the codec and jsonNumber do not select a Python cap.
function cappedAdmission(
  limit: number,
  seen: JsonNumber[],
  rejection: Error
): (token: JsonNumber) => void {
  return (token) => {
    seen.push(token);
    const digits = token.lexeme.startsWith('-') ? token.lexeme.length - 1 : token.lexeme.length;
    if (token.numberKind === 'integer' && digits > limit) throw rejection;
  };
}

test('local integer cap counts digits without sign and exempts complete floats', () => {
  const boundary = '1' + '0'.repeat(4299);
  const huge = boundary + '0';
  const rejection = new RangeError('test-local integer admission');
  const accepted: JsonNumber[] = [];
  const source = '[' + boundary + ',-' + boundary + ',' + huge + '.0,1e' + huge + ']';
  assert.equal(
    encodeSourceJson(
      parsePythonJson(source, {
        admitNumberToken: cappedAdmission(4300, accepted, rejection),
      })
    ),
    source
  );
  assert.deepEqual(
    accepted.map((token) => token.numberKind),
    ['integer', 'integer', 'float', 'float']
  );
  for (const input of [huge, '-' + huge]) {
    const seen: JsonNumber[] = [];
    assert.throws(
      () =>
        parsePythonJson(input, {
          admitNumberToken: cappedAdmission(4300, seen, rejection),
        }),
      (error: unknown) => {
        assert.equal(error, rejection);
        return true;
      }
    );
    assert.deepEqual(
      seen.map((token) => token.lexeme),
      [input]
    );
  }
});

test('admission failure precedes syntax after huge integer prefixes and overwritten members', () => {
  const huge = '1' + '0'.repeat(4300);
  const sources = [
    huge + 'x',
    huge + '.',
    huge + 'e',
    huge + 'e+',
    '{"x":' + huge + ',!}',
    '{"x":' + huge + ',"x":1}',
  ];
  for (const source of sources) {
    const seen: JsonNumber[] = [];
    const rejection = new RangeError('test-local integer admission');
    assert.throws(
      () =>
        parsePythonJson(source, {
          admitNumberToken: cappedAdmission(4300, seen, rejection),
        }),
      (error: unknown) => {
        assert.equal(error, rejection);
        return true;
      }
    );
    assert.deepEqual(
      seen.map((token) => token.lexeme),
      [huge]
    );
  }
});

test('leading zero admits only its zero prefix before later syntax rejection', () => {
  for (const source of ['0' + '9'.repeat(4301), '-0' + '9'.repeat(4301)]) {
    const seen: JsonNumber[] = [];
    assert.throws(
      () =>
        parsePythonJson(source, {
          admitNumberToken: cappedAdmission(4300, seen, new RangeError('unexpected cap rejection')),
        }),
      SyntaxError
    );
    assert.deepEqual(
      seen.map((token) => token.lexeme),
      [source.startsWith('-') ? '-0' : '0']
    );
  }
});

test('callback failures preserve thrown object identity and stop further admission', () => {
  const failure = Object.freeze({ admissionFailure: true });
  const seen: JsonNumber[] = [];
  assert.throws(
    () =>
      parsePythonJson('[1,2]', {
        admitNumberToken: (token) => {
          seen.push(token);
          throw failure;
        },
      }),
    (error: unknown) => {
      assert.equal(error, failure);
      return true;
    }
  );
  assert.deepEqual(
    seen.map((token) => token.lexeme),
    ['1']
  );
});

test('admission visits repeated lexemes and repeated NaN occurrences separately', () => {
  const seen: JsonNumber[] = [];
  const source = '[1,1,NaN,NaN]';
  assert.equal(
    encodeSourceJson(
      parsePythonJson(source, {
        admitNumberToken: (token) => {
          assert.equal(Object.isFrozen(token), true);
          seen.push(token);
        },
      })
    ),
    source
  );
  assert.deepEqual(
    seen.map((token) => token.lexeme),
    ['1', '1', 'NaN', 'NaN']
  );
});

test('admission refuses a huge unused field before any later wanted field', () => {
  const huge = '1'.repeat(4301);
  const seen: JsonNumber[] = [];
  const rejection = new RangeError('test-local integer admission');
  assert.throws(
    () =>
      parsePythonJson('{"unused":' + huge + ',"wanted":"ok"}', {
        admitNumberToken: cappedAdmission(4300, seen, rejection),
      }),
    (error: unknown) => {
      assert.equal(error, rejection);
      return true;
    }
  );
  assert.deepEqual(
    seen.map((token) => token.lexeme),
    [huge]
  );
});
