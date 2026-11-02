import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, type Hash } from 'node:crypto';
import {
  PYTHON_HTML_PROFILE_ID,
  PYTHON_HTML_DECIMAL_DIGIT_LIMIT,
  PythonHtmlDecimalDigitLimitError,
  pythonHtmlUnescape,
} from '../../src/transcripts/python-html';
import { HTML5_ENTITIES } from '../../src/transcripts/html311/entities.generated';
import { PYTHON_HTML_MANIFEST } from '../../src/transcripts/html311/manifest.generated';
import {
  INVALID_NUMERIC_RANGES,
  NUMERIC_CORRECTIONS,
} from '../../src/transcripts/html311/numeric.generated';

function hashOutput(digest: Hash, word: Buffer, output: string): void {
  for (const character of output) {
    word.writeUInt32BE(character.codePointAt(0)!);
    digest.update(word);
  }
  word.writeUInt32BE(0xffffffff);
  digest.update(word);
}

test('binds the HTML interpretation to pinned sources and its decimal limit', () => {
  assert.equal(PYTHON_HTML_PROFILE_ID, PYTHON_HTML_MANIFEST.profileId);
  assert.match(
    PYTHON_HTML_PROFILE_ID,
    /^python-html-3\.11\.13;decimal-limit-4300;sha256:[a-f0-9]{64}$/
  );
  assert.equal(PYTHON_HTML_DECIMAL_DIGIT_LIMIT, 4300);
  assert.equal(PYTHON_HTML_MANIFEST.counts.namedReferences, 2231);
  assert.equal(PYTHON_HTML_MANIFEST.counts.semicolonlessReferences, 106);
  assert.equal(PYTHON_HTML_MANIFEST.counts.numericCorrections, 34);
  assert.equal(PYTHON_HTML_MANIFEST.counts.invalidNumericCodepoints, 126);
  assert.equal(
    PYTHON_HTML_MANIFEST.sources[0].sha256,
    '282b7cdd567bbbf3d7d7ccd49fae1d3ebc7f7ab64058d781193620913773731b'
  );
});

test('substitutes every pinned named reference without changing case-sensitive keys', () => {
  const entries = Object.entries(HTML5_ENTITIES);
  assert.equal(entries.length, 2231);
  for (const [name, value] of entries) {
    assert.equal(pythonHtmlUnescape('&' + name), value, name);
    assert.equal(
      pythonHtmlUnescape('before &' + name + ' after'),
      'before ' + value + ' after',
      name
    );
  }
  assert.equal(pythonHtmlUnescape('&NotEqualTilde;'), '\u2242\u0338');
  assert.equal(pythonHtmlUnescape('&Afr;'), '\u{1d504}');
  assert.equal(pythonHtmlUnescape('&AMP'), '&');
  assert.equal(pythonHtmlUnescape('&Amp;'), '&Amp;');
  assert.equal(pythonHtmlUnescape('&apos; &quot; &bsol;'), '\' " \\');
  assert.equal(pythonHtmlUnescape('&apos'), '&apos');
});

test('matches independent CPython outputs for every named reference and suffix variants', () => {
  const digest = createHash('sha256');
  const word = Buffer.alloc(4);
  let count = 0;
  for (const name of Object.keys(HTML5_ENTITIES).sort()) {
    const withoutSemicolon = name.endsWith(';') ? name.slice(0, -1) : name;
    for (const input of [
      '&' + name,
      '&' + name + '!',
      '&' + name + 'x',
      '&' + withoutSemicolon + ';',
    ]) {
      hashOutput(digest, word, pythonHtmlUnescape(input));
      count++;
    }
  }
  assert.equal(count, 8924);
  // Qualified CPython 3.11.13: uint32BE codepoints followed by 0xffffffff.
  // This also distinguishes an erroneous surrogate from U+FFFD.
  assert.equal(
    digest.digest('hex'),
    '02b0c43d4d6bb2b1268dd9068d0cdcc7b8b56d1b137e8ae9fc67ebfedfda8340'
  );
});

test('matches independent CPython numeric-reference outputs across the Unicode domain and overflow boundary', () => {
  for (const radix of [10, 16]) {
    const digest = createHash('sha256');
    const word = Buffer.alloc(4);
    for (let cp = 0; cp <= 0x110001; cp++) {
      const input = (radix === 16 ? '&#x' : '&#') + cp.toString(radix) + ';';
      hashOutput(digest, word, pythonHtmlUnescape(input));
    }
    assert.equal(
      digest.digest('hex'),
      '83b57177b08883bdf58e5268317b9ab3ef0e1a992844caaf7f9e288a7f11a5b9'
    );
  }
});

test('uses longest named-prefix matching and exactly one substitution pass', () => {
  for (const [input, expected] of [
    ['&notit;', '\u00acit;'],
    ['&notin;', '\u2209'],
    ['&amp;amp;', '&amp;'],
    ['&amp;#65;', '&#65;'],
    ['&copy=1', '\u00a9=1'],
    ['&ampx', '&x'],
    ['&unknown;', '&unknown;'],
    ['&constructor;', '&constructor;'],
    ['&__proto__;', '&__proto__;'],
    ['&&amp;', '&&'],
    ['&; &#; &#x;', '&; &#; &#x;'],
    ['&amp\t; &amp\n; &amp\f;', '&\t; &\n; &\f;'],
  ] as const)
    assert.equal(pythonHtmlUnescape(input), expected, input);
  const astralTail = '\u{1f600}'.repeat(40);
  assert.equal(pythonHtmlUnescape('&amp' + astralTail), '&' + astralTail);
  assert.equal(pythonHtmlUnescape('raw\ud800\0\r\n'), 'raw\ud800\0\r\n');
});

test('recognizes ASCII decimal/hex references with optional semicolons and no signs', () => {
  for (const [input, expected] of [
    ['&#65;', 'A'],
    ['&#65', 'A'],
    ['&#65x', 'Ax'],
    ['&#x41;', 'A'],
    ['&#X41', 'A'],
    ['&#x41g', 'Ag'],
    ['&#00065;', 'A'],
    ['&#x000041;', 'A'],
    ['&#0x41;', '\ufffdx41;'],
    ['&#+65;', '&#+65;'],
    ['&#-65;', '&#-65;'],
    ['&#\u0661;', '&#\u0661;'],
    ['&#x+41;', '&#x+41;'],
    ['&#x-41;', '&#x-41;'],
  ] as const)
    assert.equal(pythonHtmlUnescape(input), expected, input);
});

test('applies numeric corrections before invalid-codepoint removal', () => {
  for (const [input, expected] of [
    ['&#0;', '\ufffd'],
    ['&#13;', '\r'],
    ['&#128;', '\u20ac'],
    ['&#129;', '\u0081'],
    ['&#x9F;', '\u0178'],
    ['&#1;', ''],
    ['&#11;', ''],
    ['&#127;', ''],
    ['&#9;', '\t'],
    ['&#10;', '\n'],
    ['&#12;', '\f'],
    ['&#xD7FF;', '\ud7ff'],
    ['&#xD800;', '\ufffd'],
    ['&#xDFFF;', '\ufffd'],
    ['&#xE000;', '\ue000'],
    ['&#xFDD0;', ''],
    ['&#xFDEF;', ''],
    ['&#xFDF0;', '\ufdf0'],
    ['&#x1FFFF;', ''],
    ['&#x10FFFD;', '\u{10fffd}'],
    ['&#x10FFFF;', ''],
    ['&#x110000;', '\ufffd'],
    ['&#999999999999999999999;', '\ufffd'],
  ] as const)
    assert.equal(pythonHtmlUnescape(input), expected, input);
  for (const [cp, replacement] of Object.entries(NUMERIC_CORRECTIONS)) {
    assert.equal(pythonHtmlUnescape('&#' + cp + ';'), replacement, cp);
  }
});

test('counts every decimal digit including leading zeroes before interpreting a reference', () => {
  assert.equal(pythonHtmlUnescape('&#' + '0'.repeat(4300) + ';'), '\ufffd');
  assert.equal(pythonHtmlUnescape('&#' + '9'.repeat(4300)), '\ufffd');
  assert.equal(pythonHtmlUnescape('&#' + '0'.repeat(4298) + '65;'), 'A');
  for (const [digits, body] of [
    [4301, '0'.repeat(4301)],
    [4301, '0'.repeat(4299) + '65'],
    [4302, '9'.repeat(4302)],
  ] as const) {
    for (const terminator of [';', 'x', '']) {
      assert.throws(
        () => pythonHtmlUnescape('prefix &#' + body + terminator),
        (error: unknown) => {
          assert.ok(error instanceof PythonHtmlDecimalDigitLimitError);
          assert.equal(error.code, 'PYTHON_HTML_DECIMAL_DIGIT_LIMIT');
          assert.equal(error.limit, 4300);
          assert.equal(error.digits, digits);
          assert.equal(
            error.message,
            `Exceeds the limit (4300 digits) for integer string conversion: value has ${digits} digits; use sys.set_int_max_str_digits() to increase the limit`
          );
          return true;
        }
      );
    }
  }
  assert.equal(pythonHtmlUnescape('&#x' + '0'.repeat(10000) + '41;'), 'A');
  assert.equal(pythonHtmlUnescape('&#x' + 'f'.repeat(10000) + ';'), '\ufffd');
});

test('selected finite profiles count decimal digits and report their actual limit', () => {
  for (const limit of [640, 4300]) {
    const numericProfile = { id: `html-${limit}`, integerMaxDigits: limit };
    for (const terminator of [';', '']) {
      assert.equal(
        pythonHtmlUnescape('&#' + '0'.repeat(limit - 2) + '65' + terminator, numericProfile),
        'A'
      );
      assert.equal(
        pythonHtmlUnescape('&#' + '9'.repeat(limit) + terminator, numericProfile),
        '\ufffd'
      );
      for (const body of ['0'.repeat(limit - 1) + '65', '9'.repeat(limit + 1)]) {
        assert.throws(
          () => pythonHtmlUnescape('before &#' + body + terminator, numericProfile),
          (error: unknown) => {
            assert.ok(error instanceof PythonHtmlDecimalDigitLimitError);
            assert.equal(error.code, 'PYTHON_HTML_DECIMAL_DIGIT_LIMIT');
            assert.equal(error.limit, limit);
            assert.equal(error.digits, limit + 1);
            assert.equal(
              error.message,
              `Exceeds the limit (${limit} digits) for integer string conversion: value has ${limit + 1} digits; use sys.set_int_max_str_digits() to increase the limit`
            );
            return true;
          }
        );
      }
    }
    assert.equal(pythonHtmlUnescape('&#x' + '0'.repeat(10000) + '41;', numericProfile), 'A');
    assert.equal(pythonHtmlUnescape('&#x' + 'f'.repeat(10000) + ';', numericProfile), '\ufffd');
  }
});

test('selected zero profile permits decimal references beyond the historical limit', () => {
  const numericProfile = { id: 'html-unlimited', integerMaxDigits: 0 };
  for (const terminator of [';', '']) {
    assert.equal(
      pythonHtmlUnescape('&#' + '0'.repeat(10000) + '65' + terminator, numericProfile),
      'A'
    );
    assert.equal(
      pythonHtmlUnescape('&#' + '9'.repeat(10000) + terminator, numericProfile),
      '\ufffd'
    );
  }
  assert.equal(pythonHtmlUnescape('&amp;amp; &#x41;', numericProfile), '&amp; A');
});

test('explicit HTML numeric profiles use the shared validation even without references', () => {
  for (const integerMaxDigits of [-1, 1, 639, 640.5, NaN, Infinity])
    assert.throws(
      () => pythonHtmlUnescape('plain', { id: 'invalid', integerMaxDigits }),
      TypeError
    );
  for (const id of ['', ' '])
    assert.throws(() => pythonHtmlUnescape('&amp;', { id, integerMaxDigits: 640 }), TypeError);
});

test('keeps owned HTML tables and provenance immutable at runtime', () => {
  const identity = PYTHON_HTML_PROFILE_ID;
  assert.equal(Object.isFrozen(HTML5_ENTITIES), true);
  assert.equal(Reflect.set(HTML5_ENTITIES, 'amp;', 'changed'), false);
  assert.equal(Object.isFrozen(NUMERIC_CORRECTIONS), true);
  assert.equal(Reflect.set(NUMERIC_CORRECTIONS, 0, 'changed'), false);
  assert.equal(Object.isFrozen(INVALID_NUMERIC_RANGES), true);
  assert.equal(Reflect.set(INVALID_NUMERIC_RANGES, 0, [0, 0x10ffff]), false);
  for (const range of INVALID_NUMERIC_RANGES) assert.equal(Object.isFrozen(range), true);
  assert.equal(Reflect.set(INVALID_NUMERIC_RANGES[0]!, 0, 0), false);
  const frozen = (value: unknown): void => {
    if (value !== null && typeof value === 'object') {
      assert.equal(Object.isFrozen(value), true);
      for (const item of Object.values(value)) frozen(item);
    }
  };
  frozen(PYTHON_HTML_MANIFEST);
  assert.equal(Reflect.set(PYTHON_HTML_MANIFEST, 'decimalDigitLimit', 0), false);
  assert.equal(Reflect.set(PYTHON_HTML_MANIFEST.sources[0], 'sha256', 'changed'), false);
  assert.equal(PYTHON_HTML_PROFILE_ID, identity);
  assert.equal(pythonHtmlUnescape('&amp; &#0; &#1;'), '& \ufffd ');
});
