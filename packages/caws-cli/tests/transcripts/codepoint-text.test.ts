import test from 'node:test';
import assert from 'node:assert/strict';
import {
  type CodepointText,
  codepointText,
  codepointTextFromString,
  isCodepointText,
  textLength,
  textSlice,
  textEqual,
  textOrder,
  toJsStringLossless,
  encodeUtf8Strict,
  quoteCodepointJson,
} from '../../src/transcripts/codepoint-text.js';

const PROFILE = 'historical-python-literal-v1';
const text = (points: readonly number[]): CodepointText => codepointText(points, PROFILE);

test('keeps adjacent surrogate codepoints distinct from their astral counterpart', () => {
  const pair = text([0xd83d, 0xde00]),
    astral = text([0x1f600]);
  assert.equal(textLength(pair), 2);
  assert.equal(textLength(astral), 1);
  assert.equal(textEqual(pair, astral), false);
  assert.equal(textEqual(pair, text([0xd83d, 0xde00])), true);
  assert.equal(textEqual(pair, text([0xd83d, 0xde01])), false);
  assert.equal(textEqual(text([]), text([])), true);
  assert.deepEqual(textSlice(pair, 0, 1).codepoints, [0xd83d]);
  assert.deepEqual(textSlice(astral, 0, 1).codepoints, [0x1f600]);
  assert.deepEqual(
    codepointTextFromString('😀\ud800x\udfff', PROFILE).codepoints,
    [0x1f600, 0xd800, 0x78, 0xdfff]
  );
});

test('copies and freezes custody and rejects structural impostors', () => {
  const points = [0, 0x10ffff],
    value = text(points);
  points[0] = 65;
  assert.deepEqual(value.codepoints, [0, 0x10ffff]);
  assert.equal(Object.isFrozen(value), true);
  assert.equal(Object.isFrozen(value.codepoints), true);
  assert.equal(value.profileId, PROFILE);
  assert.throws(() => {
    (value.codepoints as number[])[0] = 65;
  }, TypeError);
  assert.throws(() => {
    (value as { profileId: string }).profileId = 'other';
  }, TypeError);
  assert.equal(isCodepointText(value), true);
  const forged = { ...value } as CodepointText;
  assert.equal(isCodepointText(forged), false);
  assert.equal(isCodepointText(Object.create(value)), false);
  assert.equal(isCodepointText(new Proxy(value, {})), false);
  assert.equal(isCodepointText(null), false);
  assert.equal(isCodepointText(''), false);
  for (const operation of [
    () => textLength(forged),
    () => textSlice(forged),
    () => textEqual(value, forged),
    () => textOrder(forged, value),
    () => toJsStringLossless(forged),
    () => encodeUtf8Strict(forged),
    () => quoteCodepointJson(forged),
  ])
    assert.throws(operation, TypeError);
});

test('rejects invalid codepoints and requires an interpretation profile', () => {
  for (const point of [-1, 0x110000, 0.5, NaN, Infinity, -Infinity, '65', null, undefined])
    assert.throws(() => text([point as number]), RangeError);
  assert.throws(() => text(Array(1) as number[]), RangeError);
  assert.throws(() => codepointText('65' as unknown as number[], PROFILE), TypeError);
  for (const profile of ['', undefined, null, 1])
    assert.throws(() => codepointText([], profile as string), TypeError);
  assert.throws(() => codepointTextFromString(65 as unknown as string, PROFILE), TypeError);
  assert.deepEqual(text([0, 0xd800, 0xdfff, 0x10ffff]).codepoints, [0, 0xd800, 0xdfff, 0x10ffff]);
});

test('slices at codepoint indexes with Python negatives, clamping and empty reversals', () => {
  const value = text([65, 0x1f600, 0xd800, 66]);
  for (const [start, end, expected] of [
    [0, 4, [65, 0x1f600, 0xd800, 66]],
    [1, 3, [0x1f600, 0xd800]],
    [-3, -1, [0x1f600, 0xd800]],
    [-99, 99, [65, 0x1f600, 0xd800, 66]],
    [3, 1, []],
    [99, 100, []],
    [-99, -98, []],
    [0, 0, []],
  ] as const) {
    const slice = textSlice(value, start, end);
    assert.deepEqual(slice.codepoints, expected);
    assert.equal(slice.profileId, PROFILE);
    assert.equal(isCodepointText(slice), true);
  }
  assert.deepEqual(textSlice(value).codepoints, value.codepoints);
  assert.deepEqual(textSlice(value, -1).codepoints, [66]);
  assert.deepEqual(textSlice(text([]), -1, 99).codepoints, []);
  for (const index of [0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, null, '1']) {
    assert.throws(() => textSlice(value, index as number), RangeError);
    assert.throws(() => textSlice(value, 0, index as number), RangeError);
  }
});

test('compares lexicographic codepoints under explicit matching profiles', () => {
  for (const [left, right, expected] of [
    [[], [], 0],
    [[], [0], -1],
    [[65], [65, 0], -1],
    [[65, 0], [65], 1],
    [[65], [65], 0],
    [[65], [66], -1],
    [[66], [65], 1],
    [[0xe000], [0x10000], -1],
    [[0xd83d, 0xde00], [0x1f600], -1],
  ] as const)
    assert.equal(textOrder(text(left), text(right)), expected);
  const other = codepointText([65], 'another-profile');
  assert.throws(() => textEqual(text([65]), other), RangeError);
  assert.throws(() => textOrder(text([65]), other), RangeError);
  assert.throws(() => textEqual(text([]), codepointText([], 'another-profile')), RangeError);
});

test('refuses JavaScript string collapse while permitting exactly representable codepoint sequences', () => {
  assert.deepEqual(toJsStringLossless(text([65, 0xd83d, 0xde00])), {
    ok: false,
    reason: 'adjacentSurrogateCollapse',
    index: 1,
    codepoint: 0xd83d,
  });
  for (const points of [
    [],
    [0x1f600],
    [0xd800],
    [0xdfff],
    [0xdfff, 0xd800],
    [0xd800, 65, 0xdc00],
    [0xd800, 0x1f600, 0xdc00],
    [0xdbff, 0xdbff],
  ] as const) {
    const value = text(points),
      result = toJsStringLossless(value);
    assert.equal(result.ok, true);
    if (!result.ok) assert.fail('Expected exact JavaScript representation');
    assert.equal(textEqual(codepointTextFromString(result.value, PROFILE), value), true);
  }
  assert.deepEqual(toJsStringLossless(text([0xdbff, 0xdfff])), {
    ok: false,
    reason: 'adjacentSurrogateCollapse',
    index: 0,
    codepoint: 0xdbff,
  });
});

test('strict UTF-8 encodes scalar boundaries and refuses every surrogate codepoint', () => {
  const encoded = encodeUtf8Strict(
    text([0, 0x7f, 0x80, 0x7ff, 0x800, 0xd7ff, 0xe000, 0xffff, 0x10000, 0x10ffff])
  );
  assert.equal(encoded.ok, true);
  if (!encoded.ok) assert.fail('Expected UTF-8 encoding');
  assert.deepEqual(
    [...encoded.value],
    [
      0, 127, 194, 128, 223, 191, 224, 160, 128, 237, 159, 191, 238, 128, 128, 239, 191, 191, 240,
      144, 128, 128, 244, 143, 191, 191,
    ]
  );
  const empty = encodeUtf8Strict(text([]));
  assert.equal(empty.ok, true);
  if (!empty.ok) assert.fail('Expected empty UTF-8 encoding');
  assert.deepEqual([...empty.value], []);
  for (const point of [0xd800, 0xdbff, 0xdc00, 0xdfff])
    assert.deepEqual(encodeUtf8Strict(text([65, point])), {
      ok: false,
      reason: 'unencodableSurrogate',
      index: 1,
      codepoint: point,
    });
  assert.deepEqual(encodeUtf8Strict(text([0xd83d, 0xde00])), {
    ok: false,
    reason: 'unencodableSurrogate',
    index: 0,
    codepoint: 0xd83d,
  });
});

test('quotes JSON explicitly and documents the ensure-ascii projection collision', () => {
  const value = text([0, 8, 9, 10, 12, 13, 34, 92, 31, 32, 47, 126, 127, 0xe9, 0x1f600]);
  assert.equal(
    quoteCodepointJson(value),
    '"\\u0000\\b\\t\\n\\f\\r\\"\\\\\\u001f /~\\u007f\\u00e9\\ud83d\\ude00"'
  );
  assert.equal(
    quoteCodepointJson(value, false),
    '"\\u0000\\b\\t\\n\\f\\r\\"\\\\\\u001f /~\x7fé😀"'
  );
  assert.equal(quoteCodepointJson(text([])), '""');
  assert.equal(quoteCodepointJson(text([0x10000, 0x10ffff])), '"\\ud800\\udc00\\udbff\\udfff"');
  assert.equal(quoteCodepointJson(text([0xd83d, 0xde00]), false), '"\\ud83d\\ude00"');
  assert.equal(quoteCodepointJson(text([0x1f600]), false), '"😀"');
  assert.equal(quoteCodepointJson(text([0xd800, 0xdfff]), false), '"\\ud800\\udfff"');
  assert.equal(quoteCodepointJson(text([0xd83d, 0xde00])), quoteCodepointJson(text([0x1f600])));
  assert.throws(() => quoteCodepointJson(text([]), 'false' as unknown as boolean), TypeError);
});
