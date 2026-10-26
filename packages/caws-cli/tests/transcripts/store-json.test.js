'use strict';
const {
  parseStoreJson,
  STORE_JSON_PROFILE,
  StoreJsonError,
} = require('../../dist/transcripts/store-json');
const { isCodepointText } = require('../../dist/transcripts/codepoint-text');
const limits = Object.freeze({
  maxInputBytes: 1000000,
  maxDecodedCodepoints: 1000000,
  maxNodes: 100000,
  maxDepth: 20000,
  maxStringCodepoints: 100000,
  maxNumberChars: 20000,
});
const ascii = (text) => Buffer.from(text, 'utf8');
const parse = (bytes, storageClass = 'blob', overrides = {}) =>
  parseStoreJson({
    bytes,
    storageClass,
    profile: STORE_JSON_PROFILE,
    limits: { ...limits, ...overrides },
  });
const points = (value) => {
  expect(isCodepointText(value)).toBe(true);
  return value.codepoints;
};
const error = (run, category, code) => {
  try {
    run();
    throw Error('Expected refusal');
  } catch (err) {
    expect(err).toBeInstanceOf(StoreJsonError);
    expect(err.category).toBe(category);
    if (code) expect(err.code).toBe(code);
    return err;
  }
};
const utf32 = (values, little, bom = false) => {
  const out = Buffer.alloc((values.length + Number(bom)) * 4);
  let offset = 0;
  for (const point of [...(bom ? [0xfeff] : []), ...values]) {
    if (little) out.writeUInt32LE(point, offset);
    else out.writeUInt32BE(point, offset);
    offset += 4;
  }
  return out;
};
const utf16 = (text, little, bom = false) => {
  const out = Buffer.from((bom ? '\ufeff' : '') + text, 'utf16le');
  return little ? out : out.swap16();
};
const literalPair = Buffer.from('eda0bdedb880', 'hex');
const literalHigh = Buffer.from('eda0bd', 'hex');
const literalLow = Buffer.from('edb880', 'hex');
const quoted = (middle) => Buffer.concat([ascii('"'), middle, ascii('"')]);

describe('store JSON explicit profile and SQL encoding', () => {
  test('requires profile, storage class, raw bytes and every explicit finite limit', () => {
    const base = {
      bytes: ascii('null'),
      storageClass: 'text',
      profile: STORE_JSON_PROFILE,
      limits,
    };
    for (const change of [
      { profile: undefined },
      { profile: 'cpython-3.9' },
      { storageClass: 'null' },
      { storageClass: 'integer' },
      { bytes: 'null' },
      { bytes: new Uint16Array(2) },
      { limits: undefined },
    ])
      error(() => parseStoreJson({ ...base, ...change }), 'request');
    for (const key of Object.keys(limits))
      for (const invalid of [undefined, -1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])
        error(
          () => parseStoreJson({ ...base, limits: { ...limits, [key]: invalid } }),
          'request',
          'invalid_limit'
        );
  });
  test('rejects shared backing even through a Uint8Array subclass', () => {
    class Disguised extends Uint8Array {
      get buffer() {
        return new ArrayBuffer(4);
      }
    }
    error(() => parse(new Uint8Array(new SharedArrayBuffer(4))), 'request', 'shared_bytes');
    error(() => parse(new Disguised(new SharedArrayBuffer(4))), 'request', 'shared_bytes');
  });
  test('uses intrinsic view coordinates and returns independent immutable values', () => {
    class Disguised extends Uint8Array {
      get byteLength() {
        return 0;
      }
      get byteOffset() {
        return 0;
      }
    }
    const backing = ascii('xxx"snow☃"xxx');
    const view = new Disguised(backing.buffer, backing.byteOffset + 3, backing.length - 6);
    const value = parse(view);
    backing.fill(0);
    expect(points(value)).toEqual([115, 110, 111, 119, 9731]);
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.codepoints)).toBe(true);
    expect(() => value.codepoints.push(0)).toThrow();
  });
  test('TEXT preserves UTF8 BOM for syntax refusal while BLOB strips one BOM', () => {
    const bytes = Buffer.concat([Buffer.from('efbbbf', 'hex'), ascii('{"x":1}')]);
    error(() => parse(bytes, 'text'), 'syntax', 'unexpected_bom');
    expect(parse(bytes).entries[0][1].lexeme).toBe('1');
    error(
      () => parse(Buffer.concat([Buffer.from('efbbbf', 'hex'), bytes])),
      'syntax',
      'unexpected_bom'
    );
  });
  test.each(['text', 'blob'])('ordinary scalar UTF8 roundtrip: %s', (storage) => {
    expect(points(parse(ascii('"☃😀"'), storage))).toEqual([0x2603, 0x1f600]);
  });
  test.each([true, false])('BLOB UTF16 both BOM and null heuristic; little=%s', (little) => {
    for (const bom of [true, false]) {
      expect(points(parse(utf16('"😀"', little, bom)))).toEqual([0x1f600]);
      expect(parse(utf16('0', little, bom)).lexeme).toBe('0');
    }
  });
  test.each([true, false])('BLOB UTF32 both BOM and null heuristic; little=%s', (little) => {
    for (const bom of [true, false]) {
      expect(points(parse(utf32([34, 0x1f600, 34], little, bom)))).toEqual([0x1f600]);
      expect(parse(utf32([48], little, bom)).lexeme).toBe('0');
    }
  });
  test('length-three null bytes deliberately do not select UTF16', () => {
    error(() => parse(Buffer.from([48, 0, 0])), 'syntax');
    error(() => parse(Buffer.from([0, 48, 0])), 'syntax');
  });
  test.each([
    'c080',
    'c1bf',
    'e08080',
    'f0808080',
    'f4908080',
    'f5808080',
    '80',
    'ff',
    'e282',
    'e228a1',
  ])('malformed UTF8 %s is encoding failure', (hex) => {
    for (const storage of ['text', 'blob'])
      error(() => parse(Buffer.from(hex, 'hex'), storage), 'encoding', 'utf8');
  });
  test('decodes the whole cell before inspecting earlier JSON syntax', () => {
    error(
      () => parse(Buffer.concat([ascii('! this is already bad'), Buffer.from([255])])),
      'encoding'
    );
    error(() => parse(Buffer.concat([ascii('null'), Buffer.from([255])])), 'encoding');
  });
  test.each([true, false])(
    'truncated UTF16 and UTF32 and out-of-range scalar: little=%s',
    (little) => {
      error(
        () => parse(Buffer.concat([utf16('null', little, true), Buffer.from([0])])),
        'encoding'
      );
      error(
        () => parse(Buffer.concat([utf32([110, 117, 108, 108], little, true), Buffer.from([0])])),
        'encoding'
      );
      error(() => parse(utf32([34, 0x110000, 34], little, true)), 'encoding');
    }
  );
});

describe('store JSON codepoint strings and keys', () => {
  test('literal UTF8 surrogate pair is distinct from astral and escaped pair', () => {
    expect(points(parse(quoted(literalPair)))).toEqual([0xd83d, 0xde00]);
    error(() => parse(quoted(literalPair), 'text'), 'encoding', 'utf8');
    expect(points(parse(ascii('"😀"')))).toEqual([0x1f600]);
    expect(points(parse(ascii('"\\ud83d\\ude00"')))).toEqual([0x1f600]);
  });
  test('physical UTF16 pair combines, UTF32 surrogate units remain separate', () => {
    expect(points(parse(utf16('"\ud83d\ude00"', true, true)))).toEqual([0x1f600]);
    for (const little of [true, false])
      expect(points(parse(utf32([34, 0xd83d, 0xde00, 34], little, true)))).toEqual([
        0xd83d, 0xde00,
      ]);
  });
  test('mixed literal and escaped halves do not coalesce', () => {
    expect(points(parse(quoted(Buffer.concat([literalHigh, ascii('\\ude00')]))))).toEqual([
      0xd83d, 0xde00,
    ]);
    expect(points(parse(quoted(Buffer.concat([ascii('\\ud83d'), literalLow]))))).toEqual([
      0xd83d, 0xde00,
    ]);
  });
  test('lone and reversed halves are retained without publication validation', () => {
    expect(points(parse(quoted(literalHigh)))).toEqual([0xd83d]);
    expect(points(parse(ascii('"\\ude00\\ud83d"')))).toEqual([0xde00, 0xd83d]);
    expect(points(parse(ascii('"\\ud83dX\\ude00"')))).toEqual([0xd83d, 88, 0xde00]);
  });
  test('duplicate equality uses codepoints, last value wins in first insertion slot', () => {
    const bytes = Buffer.concat([
      ascii('{"😀":1,"'),
      literalPair,
      ascii('":2,"\\ud83d\\ude00":3,"a":4,"a":5}'),
    ]);
    const value = parse(bytes);
    expect(value.entries.map(([key]) => points(key))).toEqual([[0x1f600], [0xd83d, 0xde00], [97]]);
    expect(value.entries.map(([, number]) => number.lexeme)).toEqual(['3', '2', '5']);
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.entries)).toBe(true);
    expect(value.entries.every(Object.isFrozen)).toBe(true);
    expect(() => value.entries.push([])).toThrow();
  });
  test('keys have no prototype or Unicode normalization side effect', () => {
    const value = parse(ascii('{"__proto__":1,"constructor":2,"é":3,"é":4,"":5,"":6}'));
    expect(value.entries.length).toBe(5);
    expect(points(value.entries[2][0])).toEqual([233]);
    expect(points(value.entries[3][0])).toEqual([101, 769]);
    expect(value.entries[4][1].lexeme).toBe('6');
    expect({}.polluted).toBeUndefined();
  });
  test('JSON escapes preserve semantic controls and reject unescaped controls', () => {
    expect(points(parse(ascii(String.raw`"\b\f\n\r\t\/\\\"\u0000"`)))).toEqual([
      8, 12, 10, 13, 9, 47, 92, 34, 0,
    ]);
    for (let code = 0; code < 32; code++) error(() => parse(Buffer.from([34, code, 34])), 'syntax');
  });
});

describe('store JSON numbers, grammar and resource boundaries', () => {
  test.each([
    '9007199254740993',
    '-0',
    '1.2300',
    '1E+003',
    '1e400',
    'NaN',
    'Infinity',
    '-Infinity',
  ])('preserves numeric lexeme %s', (text) => {
    expect(parse(ascii(text))).toEqual({
      kind: 'number',
      lexeme: text,
      numberKind: /^-?(0|[1-9][0-9]*)$/.test(text) ? 'integer' : 'float',
    });
  });
  test('4300 integer digits admitted; 4301 refused before collapse or later syntax', () => {
    expect(parse(ascii('9'.repeat(4300))).lexeme.length).toBe(4300);
    for (const text of [
      '9'.repeat(4301),
      '-' + '9'.repeat(4301),
      '9'.repeat(4301) + 'x',
      '9'.repeat(4301) + '.',
      '{"x":' + '9'.repeat(4301) + ',"x":0}',
    ])
      error(() => parse(ascii(text)), 'integer_limit', 'integer_digits');
    expect(parse(ascii('9'.repeat(4301) + '.0')).numberKind).toBe('float');
    expect(parse(ascii('9'.repeat(4301) + 'e0')).numberKind).toBe('float');
  });
  test('recognizes numeric prefixes in sequential order', () => {
    error(() => parse(ascii('0' + '9'.repeat(4301))), 'syntax', 'extra_data');
    error(() => parse(ascii('null ' + '9'.repeat(4301))), 'syntax', 'extra_data');
    error(() => parse(ascii('{bad:' + '9'.repeat(4301) + '}')), 'syntax');
  });
  test.each([
    '',
    ' ',
    '[1,]',
    '{"x":1,}',
    '[,]',
    '{,}',
    '{"x" 1}',
    '"\\uZZZZ"',
    '"\\x20"',
    '"unterminated',
    '-NaN',
    '+Infinity',
    '+1',
    '.1',
    '1.',
    '1e',
    '1e+',
    '01',
    '1١',
    '1.١',
    '1e١',
    '12０',
    'True',
    'undefined',
    'null null',
  ])('rejects malformed JSON %j', (text) => {
    error(() => parse(ascii(text)), 'syntax');
  });
  test('root scalar, array and nested object are admitted without object projection policy', () => {
    expect(parse(ascii('true'))).toBe(true);
    expect(parse(ascii('false'))).toBe(false);
    expect(parse(ascii('null'))).toBeNull();
    expect(parse(ascii('[null,{"v":[true,false]}]'))[1].entries[0][1]).toEqual([true, false]);
  });
  test('each explicit limit admits its boundary and refuses the next unit', () => {
    expect(
      parse(ascii('0'), 'text', {
        maxInputBytes: 1,
        maxDecodedCodepoints: 1,
        maxNodes: 1,
        maxDepth: 0,
        maxNumberChars: 1,
      }).lexeme
    ).toBe('0');
    error(() => parse(ascii('0'), 'text', { maxInputBytes: 0 }), 'resource', 'input_bytes');
    error(
      () => parse(ascii('0'), 'text', { maxDecodedCodepoints: 0 }),
      'resource',
      'decoded_codepoints'
    );
    error(() => parse(ascii('0'), 'text', { maxNodes: 0 }), 'resource', 'nodes');
    error(() => parse(ascii('0'), 'text', { maxNumberChars: 0 }), 'resource', 'number_chars');
    expect(points(parse(ascii('"😀"'), 'blob', { maxStringCodepoints: 1 }))).toEqual([0x1f600]);
    error(
      () => parse(ascii('"a"'), 'blob', { maxStringCodepoints: 0 }),
      'resource',
      'string_codepoints'
    );
    error(
      () => parse(ascii('{"a":null}'), 'blob', { maxStringCodepoints: 0 }),
      'resource',
      'string_codepoints'
    );
    expect(parse(ascii('[null]'), 'blob', { maxDepth: 1, maxNodes: 2 })).toEqual([null]);
    error(() => parse(ascii('[[]]'), 'blob', { maxDepth: 1 }), 'resource', 'depth');
    error(() => parse(ascii('[null]'), 'blob', { maxNodes: 1 }), 'resource', 'nodes');
  });
  test('discarded duplicate values count toward resources', () => {
    error(() => parse(ascii('{"x":0,"x":1}'), 'blob', { maxNodes: 2 }), 'resource', 'nodes');
    error(
      () => parse(ascii('{"x":"too long","x":0}'), 'blob', { maxStringCodepoints: 3 }),
      'resource',
      'string_codepoints'
    );
  });
  test('deep parsing and freezing use an explicit stack', () => {
    const depth = 12000;
    let value = parse(ascii('['.repeat(depth) + 'null' + ']'.repeat(depth)), 'blob', {
      maxDepth: depth,
      maxNodes: depth + 1,
    });
    for (let index = 0; index < depth; index++) {
      expect(Object.isFrozen(value)).toBe(true);
      value = value[0];
    }
    expect(value).toBeNull();
    error(
      () =>
        parse(ascii('['.repeat(depth) + 'null' + ']'.repeat(depth)), 'blob', {
          maxDepth: depth - 1,
        }),
      'resource',
      'depth'
    );
  });
});
