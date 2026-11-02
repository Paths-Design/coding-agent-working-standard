/** Fixtures reproduce sql-profile-qualification-01's actual stock SQL cells.
 * External receipt: d3e994f7, CPython3.11.13 explicit int limit 4300 versus 0.
 * These tests exercise TS interpretation, not native admission or installed Python.
 */
const { createHash } = require('node:crypto');
const {
  parseStoreJson,
  STORE_JSON_PROFILE,
  STORE_JSON_UNLIMITED_PROFILE,
  StoreJsonError,
} = require('../../dist/transcripts/store-json');
const {
  reconstructStoreProjection,
  encodeStoreProjectionEvents,
} = require('../../dist/transcripts/store-projection');
const { reconstructNativeTranscriptStore } = require('../../dist/runtime/transcript-store-client');
const json = {
  maxInputBytes: 100000,
  maxDecodedCodepoints: 100000,
  maxNodes: 10000,
  maxDepth: 100,
  maxStringCodepoints: 100000,
  maxNumberChars: 10000,
};
const limits = { json, maxRows: 10, maxEvents: 10, maxCodepoints: 100000 };
const sqlText = (value) => ({ storageClass: 'text', bytes: Buffer.from(value) });
const clock = async (seconds) => ({
  kind: 'utc_calendar',
  seconds,
  tmYear: 123,
  tmMon: 10,
  tmMday: 14,
  tmHour: 22,
  tmMin: 13,
  tmSec: 20,
});
const fixtures = [
  ['message-int4300', 'message', '7'.repeat(4300), false],
  ['message-int4301', 'message', '7'.repeat(4301), true],
  ['message-negative4300', 'message', '-' + '7'.repeat(4300), false],
  ['message-negative4301', 'message', '-' + '7'.repeat(4301), true],
  ['part-int4301', 'part', '7'.repeat(4301), true],
  ['message-string4301', 'message', JSON.stringify('7'.repeat(4301)), false],
  ['message-float4301', 'message', '7'.repeat(4301) + '.0', false],
];
function cells(cell, token) {
  return {
    message: '{"role":"user"' + (cell === 'message' ? ',"ignored":' + token : '') + '}',
    part:
      '{"type":"text","text":"qualified-visible"' +
      (cell === 'part' ? ',"ignored":' + token : '') +
      '}',
  };
}
async function* rows(cell, token) {
  const fixture = cells(cell, token);
  yield {
    ordinal: 1,
    cells: [
      sqlText('m1'),
      sqlText(fixture.message),
      sqlText('p1'),
      sqlText(fixture.part),
      { storageClass: 'integer', value: 1700000000000n },
    ],
  };
}
const expected = Buffer.from(
  '{"type": "user", "timestamp": "2023-11-14T22:13:20+00:00", "message": {"content": [{"type": "text", "text": "qualified-visible"}]}}\n'
);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const project = (cell, token, profile, bounds = limits) =>
  reconstructStoreProjection(rows(cell, token), 'opencode', clock, bounds, profile);

test.each(fixtures)(
  '%s reproduces actual stock parser profile distinction',
  async (_name, cell, token, refuses) => {
    const unlimited = await project(cell, token, STORE_JSON_UNLIMITED_PROFILE);
    expect(unlimited.sqlProfile).toBe(STORE_JSON_UNLIMITED_PROFILE);
    expect(Buffer.from(encodeStoreProjectionEvents(unlimited, expected.length))).toEqual(expected);
    // This hash is the actual stock projector's retained output, not derived here.
    expect(digest(expected)).toBe(
      '0b3ab538fae18f30cd84072d408ccbe457181d39f9476c0f413bae55a35fc102'
    );
    const limited = project(cell, token, STORE_JSON_PROFILE);
    if (refuses)
      await expect(limited).rejects.toMatchObject({
        name: 'StoreJsonError',
        category: 'integer_limit',
        code: 'integer_digits',
      });
    else
      expect(Buffer.from(encodeStoreProjectionEvents(await limited, expected.length))).toEqual(
        expected
      );
  }
);

test('omitting the reconstruction profile preserves the 4300 default', async () => {
  await expect(
    reconstructStoreProjection(rows('message', '7'.repeat(4301)), 'zcode', clock, limits)
  ).rejects.toMatchObject({ category: 'integer_limit', code: 'integer_digits' });
  const projection = await reconstructStoreProjection(
    rows('message', '7'.repeat(4300)),
    'zcode',
    clock,
    limits
  );
  expect(projection.sqlProfile).toBe(STORE_JSON_PROFILE);
});

test('unlimited JSON integers retain exact sign/digits while strings keep matching provenance', () => {
  for (const sign of ['', '-']) {
    const token = sign + '7'.repeat(4301);
    const value = parseStoreJson({
      storageClass: 'text',
      bytes: Buffer.from(token),
      profile: STORE_JSON_UNLIMITED_PROFILE,
      limits: json,
    });
    expect(value.lexeme).toBe(token);
    expect(value.numberKind).toBe('integer');
  }
  const value = parseStoreJson({
    storageClass: 'text',
    bytes: Buffer.from('"profile"'),
    profile: STORE_JSON_UNLIMITED_PROFILE,
    limits: json,
  });
  expect(value.profileId).toBe(STORE_JSON_UNLIMITED_PROFILE);
});

test('unlimited SQL profile does not weaken finite parser, row, event or output limits', async () => {
  const token = '7'.repeat(4301);
  for (const [key, bound, code] of [
    ['maxNumberChars', 4300, 'number_chars'],
    ['maxInputBytes', 4300, 'input_bytes'],
    ['maxDecodedCodepoints', 4300, 'decoded_codepoints'],
  ]) {
    await expect(
      project('message', token, STORE_JSON_UNLIMITED_PROFILE, {
        ...limits,
        json: { ...json, [key]: bound },
      })
    ).rejects.toMatchObject({ category: 'resource', code });
  }
  for (const key of ['maxRows', 'maxEvents']) {
    await expect(
      project('message', token, STORE_JSON_UNLIMITED_PROFILE, { ...limits, [key]: 0 })
    ).rejects.toMatchObject({ category: 'resource', code: key === 'maxRows' ? 'rows' : 'events' });
  }
  const result = await project('message', token, STORE_JSON_UNLIMITED_PROFILE);
  expect(() => encodeStoreProjectionEvents(result, expected.length - 1)).toThrow(/output_bytes/);
});

test('native reconstruction forwards explicit profile and independently checks CLOSED', async () => {
  const assertClosed = jest.fn();
  const port = { rows: () => rows('part', '7'.repeat(4301)), calendar: clock, assertClosed };
  const result = await reconstructNativeTranscriptStore(
    port,
    '/qualified/project',
    'zcode',
    limits,
    STORE_JSON_UNLIMITED_PROFILE
  );
  expect(Buffer.from(encodeStoreProjectionEvents(result, expected.length))).toEqual(expected);
  expect(assertClosed).toHaveBeenCalledTimes(1);
});

test('unknown SQL profiles cannot start acquisition, even when rows would be empty', async () => {
  const port = { rows: jest.fn(), calendar: clock, assertClosed: jest.fn() };
  await expect(
    reconstructNativeTranscriptStore(
      port,
      '/qualified/project',
      'zcode',
      limits,
      'unearned-profile'
    )
  ).rejects.toBeInstanceOf(StoreJsonError);
  expect(port.rows).not.toHaveBeenCalled();
  expect(port.assertClosed).not.toHaveBeenCalled();
  const source = { [Symbol.asyncIterator]: jest.fn() };
  await expect(
    reconstructStoreProjection(source, 'opencode', clock, limits, 'unearned-profile')
  ).rejects.toMatchObject({ category: 'request', code: 'unsupported_profile' });
  expect(source[Symbol.asyncIterator]).not.toHaveBeenCalled();
});
