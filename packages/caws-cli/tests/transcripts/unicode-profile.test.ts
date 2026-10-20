import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  UNICODE_PROFILE_ID,
  PYTHON_DECIMAL_PATTERN,
  PYTHON_WORD_PATTERN,
  isPythonPrintableCodepoint,
  isPythonWordCodepoint,
  isPythonDecimalCodepoint,
  lookupPythonLiteralName,
} from '../../src/transcripts/python-unicode-profile';
import { UNICODE_PROFILE_MANIFEST } from '../../src/transcripts/unicode14/manifest.generated';
import { CHARACTER_NAMES } from '../../src/transcripts/unicode14/names.generated';
import {
  PRINTABLE_RANGES,
  WORD_RANGES,
  DECIMAL_RANGES,
  CJK_NAME_RANGES,
  HANGUL_JAMO,
} from '../../src/transcripts/unicode14/tables.generated';
import { NAME_ALIASES, NAMED_SEQUENCES } from './unicode14/literal-fixtures.generated';

test('binds the pinned data and generator identities to the interpretation profile', () => {
  assert.equal(UNICODE_PROFILE_ID, UNICODE_PROFILE_MANIFEST.profileId);
  assert.match(UNICODE_PROFILE_ID, /^python-3\.11\.13;unicode-14\.0\.0;sha256:[a-f0-9]{64}$/);
  assert.equal(UNICODE_PROFILE_MANIFEST.unicodeVersion, '14.0.0');
  assert.equal(UNICODE_PROFILE_MANIFEST.pythonVersion, '3.11.13');
  assert.equal(UNICODE_PROFILE_MANIFEST.counts.canonicalNames, 34527);
  assert.equal(UNICODE_PROFILE_MANIFEST.counts.aliases, 470);
  assert.equal(UNICODE_PROFILE_MANIFEST.counts.namedSequences, 461);
  assert.equal(
    UNICODE_PROFILE_MANIFEST.sources[0].sha256,
    '36018e68657fdcb3485f636630ffe8c8532e01c977703d2803f5b89d6c5feafb'
  );
});

test('matches independent CPython 3.11.13 reference bitmaps over every Unicode codepoint', () => {
  // Independently observed from the qualified CPython interpreter, not derived by
  // this generator. Each digest covers 1,114,112 one-byte boolean classifications.
  const expected: readonly (readonly [(cp: number) => boolean, number, string])[] = [
    [
      isPythonPrintableCodepoint,
      144516,
      '8a3c3a3d69c6e08239dab306dcf53a58ec670792bac351388902bb0a4c818343',
    ],
    [
      isPythonWordCodepoint,
      133548,
      'fcfdf3622ac8204aaf7c626cb8bc18f912e25dad53e028b087660a893b2c06ac',
    ],
    [
      isPythonDecimalCodepoint,
      660,
      'adacd5d8f6650309a8a0881d2af6bfd1e1f4438ab0bc50cc9133ee97012c6b89',
    ],
  ];
  for (const [predicate, expectedCount, expectedDigest] of expected) {
    const bitmap = Buffer.alloc(0x110000);
    let count = 0;
    for (let cp = 0; cp < bitmap.length; cp++) {
      if (predicate(cp)) {
        bitmap[cp] = 1;
        count++;
      }
    }
    assert.equal(count, expectedCount);
    assert.equal(createHash('sha256').update(bitmap).digest('hex'), expectedDigest);
    for (const invalid of [-1, 0x110000, 0.5, NaN, Infinity, -Infinity]) {
      assert.equal(predicate(invalid), false, String(invalid));
    }
  }
});

test('keeps exported data and provenance immutable at runtime under one profile identity', () => {
  const identity = UNICODE_PROFILE_ID;
  for (const ranges of [PRINTABLE_RANGES, WORD_RANGES, DECIMAL_RANGES, CJK_NAME_RANGES]) {
    assert.equal(Object.isFrozen(ranges), true);
    for (const range of ranges) assert.equal(Object.isFrozen(range), true);
    assert.equal(Reflect.set(ranges, 0, [0, 0x10ffff]), false);
    assert.equal(Reflect.set(ranges[0]!, 0, 0), false);
    assert.equal(Reflect.set(ranges[0]!, 1, 0x10ffff), false);
  }
  assert.equal(Object.isFrozen(HANGUL_JAMO), true);
  for (const column of HANGUL_JAMO) assert.equal(Object.isFrozen(column), true);
  assert.equal(Reflect.set(HANGUL_JAMO, 0, ['Z']), false);
  assert.equal(Reflect.set(HANGUL_JAMO[0]!, 0, 'Z'), false);
  assert.equal(Object.isFrozen(CHARACTER_NAMES), true);
  assert.equal(Reflect.set(CHARACTER_NAMES, 'SPACE', 0), false);
  const assertFrozen = (value: unknown): void => {
    if (value !== null && typeof value === 'object') {
      assert.equal(Object.isFrozen(value), true);
      for (const member of Object.values(value)) assertFrozen(member);
    }
  };
  assertFrozen(UNICODE_PROFILE_MANIFEST);
  assert.equal(Reflect.set(UNICODE_PROFILE_MANIFEST, 'profileId', 'tampered'), false);
  assert.equal(Reflect.set(UNICODE_PROFILE_MANIFEST.sources[0], 'sha256', 'tampered'), false);
  assert.equal(Reflect.set(UNICODE_PROFILE_MANIFEST.counts, 'wordCodepoints', 0), false);
  assert.equal(
    Reflect.set(UNICODE_PROFILE_MANIFEST.outputSha256, 'names.generated.ts', 'tampered'),
    false
  );
  assert.equal(UNICODE_PROFILE_ID, identity);
  assert.equal(isPythonPrintableCodepoint(0), false);
  assert.equal(isPythonWordCodepoint(0x20), false);
  assert.equal(isPythonDecimalCodepoint(0x41), false);
  assert.equal(lookupPythonLiteralName('HANGUL SYLLABLE GA'), 0xac00);
  assert.equal(lookupPythonLiteralName('CJK UNIFIED IDEOGRAPH-3400'), 0x3400);
  assert.equal(lookupPythonLiteralName('SPACE'), 0x20);
});

test('classifies Python printability, word membership and decimal distinctions explicitly', () => {
  for (const cp of [0x20, 0x41, 0x301, 0x1f600]) assert.equal(isPythonPrintableCodepoint(cp), true);
  for (const cp of [0, 0x7f, 0xa0, 0x200d, 0x2028, 0x2029, 0xd800, 0xe000, 0x10ffff]) {
    assert.equal(isPythonPrintableCodepoint(cp), false);
  }
  for (const cp of [0x5f, 0x41, 0x30, 0xb2, 0x2160, 0x4e00])
    assert.equal(isPythonWordCodepoint(cp), true);
  for (const cp of [0x20, 0x301, 0x200d, 0x203f, 0xdfff])
    assert.equal(isPythonWordCodepoint(cp), false);
  for (const cp of [0x30, 0x669, 0x1fbf0]) assert.equal(isPythonDecimalCodepoint(cp), true);
  for (const cp of [0xb2, 0x2160, 0x5f]) assert.equal(isPythonDecimalCodepoint(cp), false);
  // Kawi and Nag Mundari are post-14 controls even on a newer host ICU.
  for (const cp of [0x11f02, 0x11f50, 0x1e4d0, 0x1e4f0, 0x1c89]) {
    assert.equal(isPythonPrintableCodepoint(cp), false);
    assert.equal(isPythonWordCodepoint(cp), false);
    assert.equal(isPythonDecimalCodepoint(cp), false);
  }
});

test('exports explicit Unicode character classes with Python word and decimal semantics', () => {
  assert.equal(PYTHON_WORD_PATTERN.includes('\\p{'), false);
  assert.equal(PYTHON_DECIMAL_PATTERN.includes('\\p{'), false);
  const word = new RegExp('^' + PYTHON_WORD_PATTERN + '$', 'u');
  const decimal = new RegExp('^' + PYTHON_DECIMAL_PATTERN + '$', 'u');
  for (const cp of [
    0, 0x20, 0x30, 0x39, 0x41, 0x5f, 0xb2, 0x301, 0x660, 0x2160, 0x203f, 0xd800, 0x4e00, 0x1e4f0,
    0x1fbf0, 0x10ffff,
  ]) {
    assert.equal(word.test(String.fromCodePoint(cp)), isPythonWordCodepoint(cp));
    assert.equal(decimal.test(String.fromCodePoint(cp)), isPythonDecimalCodepoint(cp));
  }
  const startsToken = new RegExp('(?<!' + PYTHON_WORD_PATTERN + ')\\$token', 'u');
  assert.equal(startsToken.test('x$token'), false);
  assert.equal(startsToken.test('²$token'), false);
  assert.equal(startsToken.test('\u0301$token'), true);
});

test('admits ordinary names and every alias kind with ASCII case variation only', () => {
  for (const [name, cp] of [
    ['LATIN CAPITAL LETTER A', 0x41],
    ['PILCROW SIGN', 0xb6],
    ['REPLACEMENT CHARACTER', 0xfffd],
    ['NUSHU CHARACTER-1B170', 0x1b170],
    ['KHITAN SMALL SCRIPT CHARACTER-18B00', 0x18b00],
  ] as const) {
    assert.equal(lookupPythonLiteralName(name), cp);
    assert.equal(lookupPythonLiteralName(name.toLowerCase()), cp);
  }
  assert.equal(NAME_ALIASES.length, 470);
  assert.deepEqual([...new Set(NAME_ALIASES.map(([, , kind]) => kind))].sort(), [
    'abbreviation',
    'alternate',
    'control',
    'correction',
    'figment',
  ]);
  for (const [name, cp] of NAME_ALIASES) {
    assert.equal(lookupPythonLiteralName(name), cp, name);
    assert.equal(lookupPythonLiteralName(name.toLowerCase()), cp, name);
  }
  for (const invalid of [
    '',
    'UNKNOWN',
    'constructor',
    '__proto__',
    'SPACE ',
    ' SPACE',
    'LATIN  CAPITAL LETTER A',
    'LATIN_CAPITAL_LETTER_A',
    'LATIN CAPITAL LETTER A\0',
    'LATIN CAPITAL LETTER A\n',
    'LATIN CAPITAL LETTER \u017f',
    'LAT\u0131N CAPITAL LETTER A',
    'KAWI LETTER A',
    'NAG MUNDARI LETTER O',
  ]) {
    assert.equal(lookupPythonLiteralName(invalid), null, invalid);
  }
});

test('preserves case-sensitive algorithmic Hangul names and longest Jamo matching', () => {
  for (const [name, cp] of [
    ['GA', 0xac00],
    ['GGWEOSS', 0xafe8],
    ['DOLS', 0xb3d0],
    ['RYAN', 0xb7b8],
    ['MWIK', 0xbba0],
    ['BBWAEM', 0xbf88],
    ['SSEOL', 0xc370],
    ['YI', 0xc758],
    ['JJYOSS', 0xcb40],
    ['KYEOLS', 0xcf28],
    ['PAN', 0xd310],
    ['HWEOK', 0xd6f8],
    ['HIH', 0xd7a3],
  ] as const) {
    assert.equal(lookupPythonLiteralName('HANGUL SYLLABLE ' + name), cp);
    assert.equal(lookupPythonLiteralName('hangul syllable ' + name), null);
    assert.equal(lookupPythonLiteralName('HANGUL SYLLABLE ' + name.toLowerCase()), null);
  }
  for (const name of ['', 'G', 'GAZ', 'GGG', 'GA ', ' GA', 'G\0A']) {
    assert.equal(lookupPythonLiteralName('HANGUL SYLLABLE ' + name), null, name);
  }
});

test('admits only the precise historical CJK algorithmic ranges and four/five uppercase hex digits', () => {
  const ranges = [
    [0x3400, 0x4dbf],
    [0x4e00, 0x9fff],
    [0x20000, 0x2a6df],
    [0x2a700, 0x2b738],
    [0x2b740, 0x2b81d],
    [0x2b820, 0x2cea1],
    [0x2ceb0, 0x2ebe0],
    [0x30000, 0x3134a],
  ] as const;
  for (const [start, end] of ranges) {
    for (const cp of [start, end])
      assert.equal(
        lookupPythonLiteralName('CJK UNIFIED IDEOGRAPH-' + cp.toString(16).toUpperCase()),
        cp
      );
    for (const cp of [start - 1, end + 1])
      assert.equal(
        lookupPythonLiteralName('CJK UNIFIED IDEOGRAPH-' + cp.toString(16).toUpperCase()),
        null
      );
  }
  assert.equal(lookupPythonLiteralName('CJK UNIFIED IDEOGRAPH-03400'), 0x3400);
  for (const name of [
    'CJK UNIFIED IDEOGRAPH-003400',
    'cjk unified ideograph-3400',
    'CJK UNIFIED IDEOGRAPH-4e00',
    'CJK UNIFIED IDEOGRAPH-3400 ',
    'CJK UNIFIED IDEOGRAPH-3400\n',
    'CJK UNIFIED IDEOGRAPH-3400\r',
    'CJK UNIFIED IDEOGRAPH-3400\u2028',
    'CJK UNIFIED IDEOGRAPH-31350',
    'TANGUT IDEOGRAPH-17000',
    'TANGUT IDEOGRAPH-18D00',
  ]) {
    assert.equal(lookupPythonLiteralName(name), null, name);
  }
});

test('rejects every Unicode named sequence as a Python literal name', () => {
  assert.equal(NAMED_SEQUENCES.length, 461);
  for (const [name, codepoints] of NAMED_SEQUENCES) {
    assert.ok(codepoints.length > 1, name);
    assert.equal(lookupPythonLiteralName(name), null, name);
    assert.equal(lookupPythonLiteralName(name.toLowerCase()), null, name);
  }
});
