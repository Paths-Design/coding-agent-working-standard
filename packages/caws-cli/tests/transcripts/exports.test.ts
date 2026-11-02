import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as transcript from '../../src/transcripts';
import type { OccurrenceCoordinates } from '../../src/transcripts';
import * as lossless from '../../src/transcripts/lossless-json';
import * as common from '../../src/transcripts/harness-common';
import * as codex from '../../src/transcripts/harness-codex';
import * as claude from '../../src/transcripts/harness-claude';
import * as codepoints from '../../src/transcripts/codepoint-text';
import * as unicode from '../../src/transcripts/python-unicode-profile';
import * as values from '../../src/transcripts/render-values';
import * as reader from '../../src/transcripts/render-reader';
import * as accumulator from '../../src/transcripts/render-accumulator';
import * as artifacts from '../../src/transcripts/render-artifacts';
import * as preparation from '../../src/transcripts/render-prepare';
import * as numeric from '../../src/transcripts/transcript-json-profile';
import { decodeOccurrence, isParsedRow } from '../../src/transcripts/source-occurrence';
import { PYTHON_DECIMAL_PATTERN } from '../../src/transcripts/python-unicode';

test('public barrel binds every declared runtime export group to its origin', () => {
  const groups: readonly (readonly [string, Readonly<Record<string, unknown>>])[] = [
    ['lossless-json', lossless],
    ['harness-common', common],
    ['harness-codex', codex],
    ['harness-claude', claude],
    ['codepoint-text', codepoints],
    ['python-unicode-profile', unicode],
    ['render-values', values],
    ['render-reader', reader],
    ['render-accumulator', accumulator],
    ['render-artifacts', artifacts],
    ['render-prepare', preparation],
    ['transcript-json-profile', numeric],
  ];
  const publicValues = transcript as Readonly<Record<string, unknown>>;
  let checkedGroups = 0;
  let checkedBindings = 0;
  for (const [moduleName, origin] of groups) {
    const exports = Object.entries(origin);
    assert.ok(exports.length > 0, `${moduleName} must expose runtime values`);
    for (const [name, value] of exports) {
      assert.strictEqual(publicValues[name], value, `${moduleName}.${name}`);
      checkedBindings++;
    }
    checkedGroups++;
  }
  assert.equal(checkedGroups, 12);
  assert.ok(checkedBindings > checkedGroups, 'Runtime binding checks must not be empty');
  const selective = { decodeOccurrence, isParsedRow };
  let checkedSelective = 0;
  for (const [name, value] of Object.entries(selective)) {
    assert.strictEqual(publicValues[name], value, `source-occurrence.${name}`);
    checkedSelective++;
  }
  assert.equal(checkedSelective, 2);
});

test('typed barrel consumer retains exact occurrence bytes and large integer semantics', () => {
  const coordinates: OccurrenceCoordinates = {
    sourceId: 'export-consumer',
    sourceGeneration: 'generation-1',
    occurrenceId: 'row-1',
    byteOffset: 17n,
    lineOrdinal: 3n,
    framing: 'complete',
  };
  const original = Buffer.from(' {"n":9007199254740993}\n', 'utf8');
  const callerBytes = Buffer.from(original);
  const decoded = transcript.decodeOccurrence(callerBytes, coordinates);
  assert.equal(decoded.disposition, 'parsed');
  if (decoded.disposition !== 'parsed') throw new Error('Expected parsed export consumer row');
  assert.deepEqual(transcript.getMember(decoded.row, 'n'), {
    kind: 'number',
    numberKind: 'integer',
    lexeme: '9007199254740993',
  });
  assert.equal(transcript.isParsedRow(decoded), true);
  assert.equal(transcript.isParsedRow({ ...decoded }), false);
  callerBytes.fill(0);
  assert.deepEqual(decoded.source, {
    ...coordinates,
    coordinateAuthority: 'caller_asserted',
    rawBase64: original.toString('base64'),
    sha256: createHash('sha256').update(original).digest('hex'),
    byteLength: original.length,
  });
  assert.deepEqual(Buffer.from(decoded.source.rawBase64, 'base64'), original);
  assert.equal(
    transcript.decodeOccurrence(Buffer.from([0xff]), coordinates).disposition,
    'invalid_utf8'
  );
});

test('barrel numeric-profile consumer admits the boundary and rejects the next digit', () => {
  assert.equal(transcript.RENDER_JSON_4300.id, 'cpython3.11-json/int-max-str-digits:4300');
  assert.equal(transcript.RENDER_JSON_4300.integerMaxDigits, 4300);
  const boundary = '1'.repeat(4300);
  const parsed = transcript.parseTranscriptJson(
    '{"n":' + boundary + '}',
    transcript.RENDER_JSON_4300
  );
  assert.deepEqual(transcript.getMember(parsed, 'n'), {
    kind: 'number',
    numberKind: 'integer',
    lexeme: boundary,
  });
  assert.throws(
    () => transcript.parseTranscriptJson('{"n":' + boundary + '1}', transcript.RENDER_JSON_4300),
    (error: unknown) => {
      assert.ok(error instanceof transcript.TranscriptJsonNumericConversionError);
      assert.equal(error.message, 'Integer exceeds selected 4300-digit limit');
      return true;
    }
  );
});

test('Unicode shim consumer uses pinned decimal semantics through the public bindings', () => {
  assert.equal(PYTHON_DECIMAL_PATTERN, unicode.PYTHON_DECIMAL_PATTERN);
  assert.equal(transcript.PYTHON_DECIMAL_PATTERN, PYTHON_DECIMAL_PATTERN);
  const decimal = new RegExp('^(?:' + PYTHON_DECIMAL_PATTERN + ')+$', 'u');
  const samples: readonly (readonly [string, boolean])[] = [
    ['7', true],
    ['\u0661', true],
    ['7\u0661', true],
    ['\u00b2', false],
    ['\u{1e4f0}', false],
    ['A', false],
    ['', false],
  ];
  let checked = 0;
  for (const [input, expected] of samples) {
    assert.equal(decimal.test(input), expected, JSON.stringify(input));
    checked++;
  }
  assert.equal(checked, 7);
  assert.equal(transcript.lookupPythonLiteralName('SPACE'), 0x20);
  assert.equal(transcript.lookupPythonLiteralName('SPACE '), null);
});
