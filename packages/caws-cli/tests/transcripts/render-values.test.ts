import test from 'node:test';
import assert from 'node:assert/strict';
import { codepointText, isCodepointText } from '../../src/transcripts/codepoint-text.js';
import { jsonNumber, parsePythonJson } from '../../src/transcripts/lossless-json.js';
import {
  renderObject,
  renderGet,
  renderSet,
  renderHas,
  renderEntries,
  renderJsonDumps,
  renderJsonBytes,
  renderTextLength,
  renderTextSlice,
  renderTextEqual,
  renderTextOrder,
  renderTextConcat,
  renderTextContains,
  renderTextStartsWith,
  renderTextEndsWith,
  renderTextStrip,
  renderTextSplitLines,
  renderTextCompactWhitespace,
  renderInteger,
  renderFloat,
  renderAdd,
  renderSubtract,
  renderDivide,
  renderGreaterThan,
  renderTruthy,
  renderEqual,
} from '../../src/transcripts/render-values.js';

const profile = 'renderer-test-profile';
test('renderer objects preserve arbitrary insertion order, source numbers and deep ownership', () => {
  const items = [jsonNumber('9007199254740993')];
  const value = renderObject([
    ['2', items],
    ['__proto__', true],
    ['10', null],
    ['2', items],
  ]);
  items.push(jsonNumber('4'));
  assert.equal(renderJsonDumps(value), '{"2": [9007199254740993], "__proto__": true, "10": null}');
  assert.equal(renderGet(value, 'missing'), undefined);
  assert.equal(renderHas(value, '__proto__'), true);
  const changed = renderSet(value, '2', jsonNumber('7'));
  assert.equal(renderJsonDumps(changed), '{"2": 7, "__proto__": true, "10": null}');
  assert.deepEqual(
    renderEntries(changed).map(([key]) => key),
    ['2', '__proto__', '10']
  );
  assert.equal(renderJsonDumps(value), '{"2": [9007199254740993], "__proto__": true, "10": null}');
  assert.equal(Object.isFrozen(renderGet(value, '2')), true);
  assert.equal(Object.isFrozen(items), false);
  assert.equal(
    renderJsonDumps(parsePythonJson('{"9":1e1,"1":-0,"a":[1.0]}')),
    '{"9": 10.0, "1": 0, "a": [1.0]}'
  );
});

test('CP pair and astral values and keys stay distinct before the explicit ASCII projection', () => {
  const pair = codepointText([0xd83d, 0xde00], profile),
    astral = codepointText([0x1f600], profile);
  assert.equal(renderTextLength(pair), 2);
  assert.equal(renderTextLength(astral), 1);
  assert.equal(renderTextEqual(pair, astral), false);
  assert.equal(renderTextEqual(astral, '😀'), true);
  const value = renderObject([
    [pair, pair],
    [astral, astral],
  ]);
  assert.equal(value.entries.length, 2);
  assert.equal(renderGet(value, pair), pair);
  assert.equal(renderGet(value, '😀'), astral);
  assert.equal(renderJsonDumps(pair), renderJsonDumps(astral));
  assert.equal(renderJsonDumps(pair), '"\\ud83d\\ude00"');
  assert.throws(() => renderJsonBytes(value, { ensureAscii: false }), /surrogate/);
  assert.throws(() => renderJsonDumps('\ud800', { ensureAscii: false }), /surrogate/);
  assert.throws(
    () => renderJsonDumps(codepointText([0xdc00], profile), { ensureAscii: false }),
    /surrogate/
  );
  assert.equal(
    Buffer.from(renderJsonBytes(astral, { ensureAscii: false })).toString('hex'),
    '22f09f988022'
  );
});

test('Python indent, escaping, sort order and no LF apply recursively', () => {
  const value = renderObject([
    ['z', [jsonNumber('1.0'), renderObject([])]],
    ['é', '\x00\x7f'],
    ['a', []],
  ]);
  assert.equal(
    renderJsonDumps(value, { indent: 2 }),
    '{\n  "z": [\n    1.0,\n    {}\n  ],\n  "\\u00e9": "\\u0000\\u007f",\n  "a": []\n}'
  );
  const sorted = renderJsonDumps(value, { indent: 2, ensureAscii: false, sortKeys: true });
  assert.equal(sorted, '{\n  "a": [],\n  "z": [\n    1.0,\n    {}\n  ],\n  "é": "\\u0000\x7f"\n}');
  assert.equal(sorted.endsWith('\n'), false);
  assert.equal(
    renderJsonDumps(
      renderObject([
        ['\u{10000}', null],
        ['\ue000', null],
      ]),
      { sortKeys: true }
    ),
    '{"\\ue000": null, "\\ud800\\udc00": null}'
  );
  assert.equal(
    renderJsonDumps(parsePythonJson('[NaN,Infinity,-Infinity,-0.0,1e23]')),
    '[NaN, Infinity, -Infinity, -0.0, 1e+23]'
  );
});

test('Python numeric accumulation never rounds integers and preserves float and bool types', () => {
  const huge = jsonNumber('9007199254740993');
  assert.equal(renderJsonDumps(renderAdd(huge, true)), '9007199254740994');
  assert.equal(renderJsonDumps(renderSubtract(huge, jsonNumber('9007199254740992'))), '1');
  assert.equal(renderJsonDumps(renderAdd(jsonNumber('1.0'), true)), '2.0');
  assert.equal(renderJsonDumps(renderFloat(-0)), '-0.0');
  assert.equal(renderGreaterThan(huge, jsonNumber('9007199254740993.0')), true);
  assert.equal(renderEqual(huge, jsonNumber('9007199254740993.0')), false);
  assert.equal(renderEqual(true, jsonNumber('1.0')), true);
  assert.equal(renderEqual(jsonNumber('NaN'), jsonNumber('NaN')), false);
  assert.equal(renderEqual([jsonNumber('NaN')], [jsonNumber('NaN')]), true);
  assert.equal(renderTruthy(jsonNumber('NaN')), true);
  assert.equal(renderTruthy(jsonNumber('-0.0')), false);
  assert.equal(renderTruthy(renderObject([])), false);
  assert.equal(renderTruthy(codepointText([], profile)), false);
  assert.throws(() => renderInteger(9007199254740992), /exact/);
  assert.throws(() => renderAdd(jsonNumber('1' + '0'.repeat(400)), jsonNumber('0.0')), /too large/);
  assert.equal(renderJsonDumps(renderAdd(jsonNumber('1e308'), jsonNumber('1e308'))), 'Infinity');
});

test('true division uses bigint ratios with rounding, subnormals and Python overflow', () => {
  assert.equal(renderJsonDumps(renderDivide(jsonNumber('1'), jsonNumber('10'))), '0.1');
  const huge = jsonNumber('1' + '0'.repeat(400));
  assert.equal(renderJsonDumps(renderDivide(huge, huge)), '1.0');
  assert.equal(renderJsonDumps(renderDivide(false, jsonNumber('-1'))), '-0.0');
  assert.equal(
    renderJsonDumps(renderDivide(jsonNumber('1'), renderInteger(1n << 1074n))),
    '5e-324'
  );
  assert.equal(renderJsonDumps(renderDivide(jsonNumber('1'), renderInteger(1n << 1075n))), '0.0');
  assert.equal(
    renderJsonDumps(renderDivide(jsonNumber('3'), renderInteger(1n << 1075n))),
    '1e-323'
  );
  assert.throws(() => renderDivide(huge, true), /too large/);
  assert.throws(() => renderDivide(true, false), /zero/);
  assert.equal(renderJsonDumps(renderDivide(jsonNumber('Infinity'), true)), 'Infinity');
});

test('text helpers preserve interpreted codepoints, Python whitespace and line boundaries', () => {
  const value = codepointText([0x20, 0xd83d, 0xde00, 0x85, 0x61, 0x2028], profile);
  const stripped = renderTextStrip(value);
  assert.equal(renderTextLength(stripped), 4);
  assert.equal(renderJsonDumps(renderTextSlice(stripped, 0, 1)), '"\\ud83d"');
  assert.equal(renderTextStartsWith(stripped, codepointText([0xd83d], profile)), true);
  assert.equal(renderTextEndsWith(stripped, 'a'), true);
  assert.equal(renderTextEndsWith(stripped, ''), true);
  assert.equal(renderTextContains(stripped, '😀'), false);
  assert.equal(renderTextContains(stripped, codepointText([0xde00, 0x85], profile)), true);
  assert.equal(renderTextOrder(codepointText([0x10000], profile), '\ue000'), 1);
  const joined = renderTextConcat('(', stripped, ')');
  assert.equal(isCodepointText(joined), true);
  assert.equal(renderTextLength(joined), 6);
  assert.equal(renderJsonDumps(renderTextCompactWhitespace(value)), '"\\ud83d\\ude00 a"');
  assert.deepEqual(renderTextSplitLines('a\r\nb\x85\n'), ['a', 'b', '']);
  assert.deepEqual(renderTextSplitLines(''), []);
  assert.deepEqual(renderTextSplitLines('\n'), ['']);
  assert.equal(renderTextStrip('\x1f\ufeff\x1f'), '\ufeff');
  assert.throws(() => renderTextConcat(value, codepointText([], 'other-profile')), /profiles/);
  const adjacent = renderTextConcat('\ud83d', '\ude00');
  assert.equal(isCodepointText(adjacent), true);
  assert.equal(renderTextLength(adjacent), 2);
  assert.throws(() => renderJsonBytes(adjacent, { ensureAscii: false }), /surrogate/);
  assert.throws(
    () => renderDivide(jsonNumber('1' + '0'.repeat(400)), jsonNumber('0.0')),
    /too large/
  );
});
