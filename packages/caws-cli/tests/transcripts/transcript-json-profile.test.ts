import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTranscriptJson,
  snapshotTranscriptJsonProfile,
  TranscriptJsonNumericConversionError,
  type TranscriptJsonNumericProfile,
} from '../../src/transcripts/transcript-json-profile';
import { getMember, jsonNumber, jsonObject } from '../../src/transcripts/lossless-json';
import { decodeMapping, codexOutputIsError } from '../../src/transcripts/harness-codex';
import { decodeStructuredTextPayload, parseHookStdout } from '../../src/transcripts/harness-common';

const limited = { id: 'python-json-4300', integerMaxDigits: 4300 };
const huge = '1'.repeat(4301);

test('numeric profiles are validated and copied into frozen data', () => {
  const supplied = { ...limited };
  const selected = snapshotTranscriptJsonProfile(supplied);
  supplied.integerMaxDigits = 0;
  supplied.id = 'changed';
  assert.deepEqual(selected, limited);
  assert.equal(Object.isFrozen(selected), true);
  assert.notEqual(selected, supplied);
  for (const invalid of [
    null,
    {},
    { id: '', integerMaxDigits: 0 },
    { id: ' ', integerMaxDigits: 0 },
    ...[-1, 1, 639, 640.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map((integerMaxDigits) => ({
      id: 'bad',
      integerMaxDigits,
    })),
  ])
    assert.throws(
      () => snapshotTranscriptJsonProfile(invalid as TranscriptJsonNumericProfile),
      TypeError
    );
  assert.deepEqual(snapshotTranscriptJsonProfile({ id: 'minimum', integerMaxDigits: 640 }), {
    id: 'minimum',
    integerMaxDigits: 640,
  });
});

test('selected JSON integer conversion enforces signed boundaries while historical and zero remain unlimited', () => {
  for (const sign of ['', '-']) {
    assert.deepEqual(
      parseTranscriptJson(sign + '1'.repeat(4300), limited),
      jsonNumber(sign + '1'.repeat(4300))
    );
    assert.throws(
      () => parseTranscriptJson(sign + huge, limited),
      TranscriptJsonNumericConversionError
    );
    assert.deepEqual(parseTranscriptJson(sign + huge), jsonNumber(sign + huge));
    assert.deepEqual(
      parseTranscriptJson(sign + huge, { id: 'unlimited', integerMaxDigits: 0 }),
      jsonNumber(sign + huge)
    );
  }
  assert.deepEqual(
    parseTranscriptJson('1'.repeat(640), { id: 'minimum', integerMaxDigits: 640 }),
    jsonNumber('1'.repeat(640))
  );
  assert.throws(
    () => parseTranscriptJson('1'.repeat(641), { id: 'minimum', integerMaxDigits: 640 }),
    TranscriptJsonNumericConversionError
  );
});

test('numeric conversion occurs before later syntax failure and duplicate overwrite', () => {
  for (const raw of [`[${huge},]`, `{"x":${huge},"x":0}`, `[${huge} invalid`, `${huge} trailing`])
    assert.throws(() => parseTranscriptJson(raw, limited), TranscriptJsonNumericConversionError);
  assert.throws(() => parseTranscriptJson(`[invalid,${huge}]`, limited), SyntaxError);
  assert.throws(() => parseTranscriptJson('[1,]', limited), SyntaxError);
  assert.deepEqual(
    parseTranscriptJson('{"x":1,"x":2}', limited),
    jsonObject([['x', jsonNumber('2')]])
  );
});

test('integer limits exclude quoted digits, decimal/exponent tokens, and Python constants', () => {
  assert.equal(parseTranscriptJson(JSON.stringify(huge), limited), huge);
  for (const token of [`${huge}.0`, `${huge}e0`, '1e9999', 'NaN', 'Infinity', '-Infinity'])
    assert.deepEqual(parseTranscriptJson(token, limited), jsonNumber(token));
});

test('mapping and hook helpers propagate numeric conversion but preserve malformed JSON fallbacks', () => {
  const mapping = `{"n":${huge}}`;
  const hook = `{"n":${huge},"hookSpecificOutput":{"additionalContext":"retained"}}`;
  assert.throws(() => decodeMapping(mapping, limited), TranscriptJsonNumericConversionError);
  assert.throws(() => parseHookStdout(hook, limited), TranscriptJsonNumericConversionError);
  assert.deepEqual(getMember(decodeMapping(mapping), 'n'), jsonNumber(huge));
  assert.equal(getMember(parseHookStdout(hook)!, 'additional_context'), 'retained');
  assert.equal(getMember(decodeMapping('[1,]', limited), 'raw'), '[1,]');
  assert.equal(parseHookStdout('[1,]', limited), null);
  assert.equal(parseHookStdout('[]', limited), null);
});

test('structured text and output classifier catch selected numeric failures and retain their raw/false fallback', () => {
  const structured = `[{"text":"decoded","n":${huge}}]`;
  const classified = `[{"is_error":true,"n":${huge}}]`;
  assert.equal(decodeStructuredTextPayload(structured), 'decoded');
  assert.equal(decodeStructuredTextPayload(structured, limited), structured);
  assert.equal(codexOutputIsError(classified, ''), true);
  assert.equal(codexOutputIsError(classified, '', limited), false);
  assert.equal(codexOutputIsError('Process exited with code 1', '', limited), true);
  assert.equal(codexOutputIsError('not JSON', 'tool failed: rejected', limited), true);
  assert.equal(decodeStructuredTextPayload('[1,]', limited), '[1,]');
  assert.equal(codexOutputIsError('[1,]', '', limited), false);
});
