import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LOCAL_CALENDAR_REPLY,
  MAX_LOCAL_CALENDAR_BATCH,
  RENDERER_CALENDAR_PROFILE as PROFILE,
  RendererCalendarContractError,
  RendererCalendarReferenceError,
  parseRendererTimestamp,
  rendererSecondsBetween,
  resolveRendererCalendar,
  type LocalCalendarRequest,
  type RendererCalendarContext,
  type RendererLocalCalendarPort,
  type ResolveRendererCalendarOptions,
} from '../../src/transcripts/renderer-calendar';

const original: RendererCalendarContext = Object.freeze({
  originalPid: 1234,
  tz: Object.freeze({ kind: 'present', value: 'UTC' }),
  tzdir: Object.freeze({ kind: 'absent' }),
});
function options(
  timestamps: readonly (string | null)[],
  port: RendererLocalCalendarPort
): ResolveRendererCalendarOptions {
  return {
    profile: PROFILE,
    id: 'original-1',
    runtimeDigest: 'a'.repeat(64),
    token: 'db25e411-7ec4-4ec6-b5d4-3bd167c144a1',
    context: original,
    timestamps,
    sortEpochs: true,
    maximumTimestampBytes: 1_000_000,
    maximumQueries: 65536,
    port,
    signal: new AbortController().signal,
    deadlineEpochMs: Date.now() + 10_000,
  };
}
function reply(
  request: LocalCalendarRequest,
  results: readonly unknown[],
  context = original
): unknown {
  return {
    schema: LOCAL_CALENDAR_REPLY,
    profile: PROFILE,
    id: request.id,
    runtimeDigest: request.runtimeDigest,
    token: request.token,
    sequence: request.sequence,
    context,
    results,
  };
}
function fields(
  seconds: string,
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0
) {
  return {
    kind: 'local_calendar',
    seconds,
    tmYear: year - 1900,
    tmMon: month - 1,
    tmMday: day,
    tmHour: hour,
    tmMin: minute,
    tmSec: second,
  };
}
function catalogPort(
  catalog: Readonly<Record<string, ReturnType<typeof fields>>>,
  calls: LocalCalendarRequest[],
  context = original
): RendererLocalCalendarPort {
  return {
    async observe(request) {
      calls.push(request);
      return reply(
        request,
        request.seconds.map((seconds) => {
          assert.ok(
            Object.hasOwn(catalog, seconds),
            `No retained calendar observation for ${seconds}`
          );
          return catalog[seconds]!;
        }),
        context
      );
    },
  };
}
const noPort: RendererLocalCalendarPort = {
  async observe() {
    assert.fail('Aware/invalid timestamps must not query local time');
  },
};
const parsed = (mode: 'duration' | 'epoch', value: string | null) =>
  parseRendererTimestamp(PROFILE, mode, value);

test('duration and epoch retain different date-only, separator and fallback admission', () => {
  assert.equal(parsed('duration', '2026-01-02'), null);
  assert.deepEqual(parsed('epoch', '2026-01-02'), {
    year: 2026,
    month: 1,
    day: 2,
    hour: 0,
    minute: 0,
    second: 0,
    microsecond: 0,
    offsetMicroseconds: null,
  });
  assert.equal(parsed('duration', '2026-01-02 03:04:05'), null);
  assert.equal(parsed('epoch', '2026-01-02 03:04:05')?.hour, 3);
  assert.equal(parsed('epoch', '2026-1-2T3:4:5Z'), null);
  assert.equal(parsed('duration', '2026-1-2T3:4:5Z')?.offsetMicroseconds, null);
  assert.equal(parsed('duration', '2026-01-02T03:04:05Z')?.offsetMicroseconds, 0n);
  assert.equal(parsed('duration', '2026-01-02t03:04:05z')?.offsetMicroseconds, null);
  assert.equal(parsed('epoch', '2026-01-02t03:04:05z'), null);
  assert.equal(rendererSecondsBetween(PROFILE, '2026-1-2T3:4:5Z', '2026-01-02T03:04:06Z'), null);
});

test('revoked timestamp and result arrays retain distinct typed refusal categories', async () => {
  const request = Proxy.revocable([], {});
  request.revoke();
  let calls = 0;
  const port: RendererLocalCalendarPort = {
    async observe(input) {
      calls++;
      const results = Proxy.revocable([], {});
      results.revoke();
      return reply(input, results.proxy);
    },
  };
  await assert.rejects(
    resolveRendererCalendar(options(request.proxy, port)),
    (error: unknown) =>
      error instanceof RendererCalendarContractError &&
      error.category === 'request' &&
      error.message === 'Unreadable calendar array'
  );
  assert.equal(calls, 0);
  await assert.rejects(
    resolveRendererCalendar(options(['1970-01-01'], port)),
    (error: unknown) =>
      error instanceof RendererCalendarContractError &&
      error.category === 'reply' &&
      error.message === 'Unreadable calendar array'
  );
  assert.equal(calls, 1);
});

test('fallback short fractions pad exact microseconds without admitting a seventh digit', () => {
  // Actual pinned CPython renderer outcomes, selected-boundary-probes-01/fractions.json.
  for (const [timestamp, microsecond] of [
    ['2026-1-2T3:4:5.1Z', 100000],
    ['2026-1-2t3:4:5.12z', 120000],
    ['2026-1-2T3:4:5.123Z', 123000],
  ] as const) {
    assert.equal(parsed('duration', timestamp)?.microsecond, microsecond);
    assert.equal(parsed('duration', timestamp)?.offsetMicroseconds, null);
    assert.equal(parsed('epoch', timestamp), null);
  }
  assert.equal(parsed('duration', '2026-1-2T3:4:5.1234567Z'), null);
});

test('ISO basic/week dates, reduced time, commas and microsecond truncation remain distinct', () => {
  for (const value of ['20260102T030405Z', '2026-W01-5T03:04:05Z', '2026W015T030405Z'])
    assert.deepEqual(parsed('epoch', value), parsed('epoch', '2026-01-02T03:04:05Z'));
  assert.equal(parsed('epoch', '2026-W01')?.year, 2025);
  assert.equal(parsed('epoch', '2026-W01')?.day, 29);
  assert.equal(parsed('epoch', '2026-01-02T03')?.minute, 0);
  assert.equal(parsed('epoch', '2026-01-02T03:04')?.second, 0);
  assert.equal(parsed('epoch', '2026-01-02T03,123456789')?.microsecond, 123456);
  assert.equal(parsed('epoch', '2026-01-02T03:04:05.123456789Z')?.microsecond, 123456);
  assert.equal(parsed('epoch', '2026-01-02\ud80003:04:05')?.hour, 3);
  assert.equal(parsed('duration', '2026-01-02\ud80003:04:05'), null);
  assert.equal(parsed('epoch', '2026-01-02🕐03:04:05')?.hour, 3);
});

test('ISO week 53 is admitted only when the source year has that week', () => {
  assert.equal(parsed('epoch', '2019-W53-1T00:00:00Z'), null);
  assert.equal(parsed('duration', '2019-W53-1T00:00:00Z'), null);
  assert.deepEqual(
    parsed('epoch', '2020-W53-7T00:00:00Z'),
    parsed('epoch', '2021-01-03T00:00:00Z')
  );
  assert.equal(parsed('epoch', '9999-W52-7T00:00:00Z'), null);
});

test('offset arithmetic preserves integral normalization and accelerator zero-offset fraction behavior', () => {
  assert.equal(parsed('epoch', '2026-01-02T03:04:05+00:99:99')?.offsetMicroseconds, 6_039_000_000n);
  assert.equal(
    parsed('epoch', '2026-01-02T03:04:05-01:02:03.456789')?.offsetMicroseconds,
    -3_723_456_789n
  );
  assert.equal(parsed('epoch', '2026-01-02T03:04:05+00:00:00.5')?.offsetMicroseconds, 0n);
  assert.equal(parsed('duration', '2026-1-2T3:4:5+00:00:00.5')?.offsetMicroseconds, 500_000n);
  assert.equal(parsed('duration', '٢٠٢٦-1-2T3:4:5Z')?.year, 2026);
  assert.equal(parsed('epoch', '٢٠٢٦-01-02T03:04:05Z'), null);
});

test('all Unicode14 decimal blocks decode actual CPython digit values including adjacent mathematical blocks', () => {
  // Zero points from actual CPython 3.11.13 unicodedata.decimal over all 0x110000
  // codepoints. Each following 9 digits has actual values 1..9; five mathematical
  // blocks are adjacent, so range length alone cannot supply a digit value.
  const zeros = [
    0x30, 0x660, 0x6f0, 0x7c0, 0x966, 0x9e6, 0xa66, 0xae6, 0xb66, 0xbe6, 0xc66, 0xce6, 0xd66, 0xde6,
    0xe50, 0xed0, 0xf20, 0x1040, 0x1090, 0x17e0, 0x1810, 0x1946, 0x19d0, 0x1a80, 0x1a90, 0x1b50,
    0x1bb0, 0x1c40, 0x1c50, 0xa620, 0xa8d0, 0xa900, 0xa9d0, 0xa9f0, 0xaa50, 0xabf0, 0xff10, 0x104a0,
    0x10d30, 0x11066, 0x110f0, 0x11136, 0x111d0, 0x112f0, 0x11450, 0x114d0, 0x11650, 0x116c0,
    0x11730, 0x118e0, 0x11950, 0x11c50, 0x11d50, 0x11da0, 0x16a60, 0x16ac0, 0x16b50, 0x1d7ce,
    0x1d7d8, 0x1d7e2, 0x1d7ec, 0x1d7f6, 0x1e140, 0x1e2f0, 0x1e950, 0x1fbf0,
  ];
  assert.equal(zeros.length, 66);
  for (const zero of zeros)
    for (let digit = 0; digit < 10; digit++) {
      const value = `200${String.fromCodePoint(zero + digit)}-1-2T3:4:5Z`;
      assert.equal(parsed('duration', value)?.year, 2000 + digit, value);
    }
  for (const cp of [0x2f, 0x3a, 0x665 - 10, 0x11f50, 0x1e4f0])
    assert.equal(parsed('duration', `200${String.fromCodePoint(cp)}-1-2T3:4:5Z`), null);
});

test('fallback offset integer conversion rejects mixed colon positions and retains adjacent legal forms', () => {
  for (const offset of ['+0102:03', '+01:0203', '-0102:03', '-01:0203', '+٠١٠٢:٠٣']) {
    const timestamp = `2026-1-2T3:4:5${offset}`;
    assert.equal(parsed('duration', timestamp), null, offset);
    assert.equal(rendererSecondsBetween(PROFILE, timestamp, '2026-01-02T03:04:05Z'), null, offset);
  }
  for (const offset of ['+010203', '+01:02:03'])
    assert.equal(
      parsed('duration', `2026-1-2T3:4:5${offset}`)?.offsetMicroseconds,
      3_723_000_000n,
      offset
    );
  for (const offset of ['+0102', '+01:02'])
    assert.equal(
      parsed('duration', `2026-1-2T3:4:5${offset}`)?.offsetMicroseconds,
      3_720_000_000n,
      offset
    );
});

test('invalid timestamps are caught values rather than guessed dates', () => {
  for (const value of [
    null,
    '',
    'unknown',
    '2026-02-29T00:00:00Z',
    '0000-01-01T00:00:00Z',
    '10000-01-01T00:00:00Z',
    '2026-01-01T24:00:00Z',
    '2026-01-01T00:60:00Z',
    '2026-01-01T00:00:60Z',
    '2026-W54-1T00:00:00Z',
    '2026-W01-0T00:00:00Z',
    '2026-01-01T00:00:00+24:00',
    ' 2026-01-01T00:00:00Z',
  ]) {
    assert.equal(parsed('epoch', value), null, String(value));
    assert.equal(parsed('duration', value), null, String(value));
  }
  assert.throws(
    () => parseRendererTimestamp('fixture', 'epoch', null),
    RendererCalendarContractError
  );
  assert.throws(
    () => parseRendererTimestamp(PROFILE, 'other' as 'epoch', null),
    RendererCalendarContractError
  );
});

test('duration uses exact microseconds, awareness, Python decimal rounding and signed zero', () => {
  const start = '2026-01-01T00:00:00Z';
  for (const [fraction, expected] of [
    ['2.675', '2.67'],
    ['1.005', '1.0'],
    ['0.005', '0.01'],
    ['0.015', '0.01'],
    ['0.000001', '0.0'],
  ] as const) {
    const [seconds, digits] = fraction.split('.');
    const end = `2026-01-01T00:00:${seconds!.padStart(2, '0')}.${digits!}Z`;
    assert.equal(rendererSecondsBetween(PROFILE, start, end)?.lexeme, expected);
  }
  assert.equal(
    rendererSecondsBetween(PROFILE, '2026-01-01T00:00:00.000001Z', start)?.lexeme,
    '-0.0'
  );
  assert.equal(
    rendererSecondsBetween(PROFILE, '2026-01-01T00:00:00+01:00', start)?.lexeme,
    '3600.0'
  );
  assert.equal(rendererSecondsBetween(PROFILE, '2026-01-01T00:00:00', start), null);
  assert.equal(
    rendererSecondsBetween(PROFILE, '2026-01-01T01:59:59', '2026-01-01T03:00:00')?.lexeme,
    '3601.0'
  );
  assert.equal(
    rendererSecondsBetween(PROFILE, '0001-01-01T00:00:00Z', '9999-12-31T23:59:59.999999Z')?.lexeme,
    '315537897600.0'
  );
  assert.equal(rendererSecondsBetween(PROFILE, null, start), null);
});

test('exact hundredth ties use even parity on both signs and adjacent microseconds', () => {
  const start = '2026-01-01T00:00:00Z';
  for (const [fraction, positive, negative] of [
    ['125000', '0.12', '-0.12'],
    ['375000', '0.38', '-0.38'],
    ['124999', '0.12', '-0.12'],
    ['125001', '0.13', '-0.13'],
  ] as const) {
    const end = `2026-01-01T00:00:00.${fraction}Z`;
    assert.equal(rendererSecondsBetween(PROFILE, start, end)?.lexeme, positive);
    assert.equal(rendererSecondsBetween(PROFILE, end, start)?.lexeme, negative);
  }
});

test('resolved aware epochs use no local port and reject timestamps outside their captured catalog', async () => {
  const timestamps = [
    '1970-01-01T00:00:00Z',
    '1970-01-01T00:00:00.000001Z',
    '1970-01-01T01:00:00+01:00',
    null,
  ];
  const calendar = await resolveRendererCalendar(options(timestamps, noPort));
  assert.equal(calendar.epochSeconds(timestamps[0]!), 0);
  assert.equal(calendar.epochSeconds(timestamps[1]!), 0.000001);
  assert.equal(calendar.epochSeconds(timestamps[2]!), 0);
  assert.equal(calendar.epochSeconds(null), null);
  assert.equal(Object.isFrozen(calendar), true);
  assert.equal(Object.isFrozen(calendar.context), true);
  assert.throws(() => calendar.epochSeconds('1970-01-02'), RendererCalendarContractError);
});

test('naive epochs invert through original observations and batch/deduplicate each round', async () => {
  const calls: LocalCalendarRequest[] = [];
  const catalog = {
    '0': fields('0', 1970, 1, 1),
    '-86400': fields('-86400', 1969, 12, 31),
    '3600': fields('3600', 1970, 1, 1, 1),
    '-82800': fields('-82800', 1969, 12, 31, 1),
  };
  const timestamps = [
    '1970-01-01',
    '1970-01-01T00:00:00.000001',
    '1970-01-01T01:00:00',
    '1970-01-01',
  ];
  const calendar = await resolveRendererCalendar(options(timestamps, catalogPort(catalog, calls)));
  assert.deepEqual(
    calls.map((call) => call.seconds),
    [
      ['0', '3600'],
      ['-86400', '-82800'],
    ]
  );
  assert.deepEqual(
    calls.map((call) => call.sequence),
    [1, 2]
  );
  assert.equal(calendar.epochSeconds(timestamps[0]!), 0);
  assert.equal(calendar.epochSeconds(timestamps[1]!), 0.000001);
  assert.equal(calendar.epochSeconds(timestamps[2]!), 3600);
});

test('New York gap chooses later candidate and ambiguous fold chooses earlier candidate', async () => {
  const ny: RendererCalendarContext = {
    ...original,
    tz: { kind: 'present', value: 'America/New_York' },
  };
  const calls: LocalCalendarRequest[] = [];
  const catalog = {
    '1710037800': fields('1710037800', 2024, 3, 9, 21, 30),
    '1710055800': fields('1710055800', 2024, 3, 10, 3, 30),
    '1710052200': fields('1710052200', 2024, 3, 10, 1, 30),
    '1730597400': fields('1730597400', 2024, 11, 2, 21, 30),
    '1730611800': fields('1730611800', 2024, 11, 3, 1, 30),
    '1730525400': fields('1730525400', 2024, 11, 2, 1, 30),
  };
  const timestamps = ['2024-03-10T02:30:00', '2024-11-03T01:30:00'];
  const calendar = await resolveRendererCalendar({
    ...options(timestamps, catalogPort(catalog, calls, ny)),
    context: ny,
  });
  assert.equal(calendar.epochSeconds(timestamps[0]!), 1710055800);
  assert.equal(calendar.epochSeconds(timestamps[1]!), 1730611800);
  assert.deepEqual(
    calls.map((call) => call.seconds.length),
    [2, 2, 2]
  );
});

test('two-hour transitions retain the later gap and discover the earlier fold solution', async () => {
  // Actual CPython3.11.13 localtime fields and datetime.timestamp results under
  // XST-2XDT-4,M3.2.0/2,M11.1.0/2, captured with unchanged original environment.
  const context: RendererCalendarContext = {
    ...original,
    tz: { kind: 'present', value: 'XST-2XDT-4,M3.2.0/2,M11.1.0/2' },
  };
  const calls: LocalCalendarRequest[] = [];
  const catalog = {
    '1710037800': fields('1710037800', 2024, 3, 10, 6, 30),
    '1710023400': fields('1710023400', 2024, 3, 10, 0, 30),
    '1710030600': fields('1710030600', 2024, 3, 10, 4, 30),
    '1730597400': fields('1730597400', 2024, 11, 3, 3, 30),
    '1730590200': fields('1730590200', 2024, 11, 3, 1, 30),
    '1730503800': fields('1730503800', 2024, 11, 2, 3, 30),
    '1730583000': fields('1730583000', 2024, 11, 3, 1, 30),
  };
  const timestamps = ['2024-03-10T02:30:00', '2024-11-03T01:30:00'];
  const calendar = await resolveRendererCalendar({
    ...options(timestamps, catalogPort(catalog, calls, context)),
    context,
  });
  assert.equal(calendar.epochSeconds(timestamps[0]!), 1710030600);
  assert.equal(calendar.epochSeconds(timestamps[1]!), 1730583000);
  assert.deepEqual(
    calls.map((call) => call.seconds),
    [
      ['1710037800', '1730597400'],
      ['1710023400', '1730590200'],
      ['1710030600', '1730503800'],
      ['1730583000'],
    ]
  );
});

test('after a forward transition the first valid inverse survives an invalid later candidate', async () => {
  // Actual CPython renderer epochs and raw local fields, selected-boundary-probes-01.
  const context: RendererCalendarContext = {
    ...original,
    tz: { kind: 'present', value: 'XST-2XDT-4,M3.2.0/2,M11.1.0/2' },
  };
  const calls: LocalCalendarRequest[] = [];
  const catalog = {
    1710052200: fields('1710052200', 2024, 3, 10, 10, 30),
    1710037800: fields('1710037800', 2024, 3, 10, 6, 30),
    1709951400: fields('1709951400', 2024, 3, 9, 4, 30),
    1710045000: fields('1710045000', 2024, 3, 10, 8, 30),
    1710138600: fields('1710138600', 2024, 3, 11, 10, 30),
    1710124200: fields('1710124200', 2024, 3, 11, 6, 30),
  };
  const timestamps = ['2024-03-10T06:30:00', '2024-03-11T06:30:00'];
  const calendar = await resolveRendererCalendar({
    ...options(timestamps, catalogPort(catalog, calls, context)),
    context,
  });
  assert.equal(calendar.epochSeconds(timestamps[0]!), 1710037800);
  assert.equal(calendar.epochSeconds(timestamps[1]!), 1710124200);
  assert.deepEqual(
    calls.map((call) => call.seconds),
    [['1710052200', '1710138600'], ['1710037800', '1710124200'], ['1709951400'], ['1710045000']]
  );
});

test('negative DST reverses gap and fold seasons without repeating cached observations', async () => {
  // Actual CPython3.11.13 observations under XST0XDT1,M3.2.0/2,M11.1.0/2.
  const context: RendererCalendarContext = {
    ...original,
    tz: { kind: 'present', value: 'XST0XDT1,M3.2.0/2,M11.1.0/2' },
  };
  const calls: LocalCalendarRequest[] = [];
  const catalog = {
    '1710034200': fields('1710034200', 2024, 3, 10, 1, 30),
    '1709947800': fields('1709947800', 2024, 3, 9, 1, 30),
    '1730601000': fields('1730601000', 2024, 11, 3, 1, 30),
    '1730604600': fields('1730604600', 2024, 11, 3, 3, 30),
  };
  const timestamps = ['2024-03-10T01:30:00', '2024-11-03T02:30:00'];
  const calendar = await resolveRendererCalendar({
    ...options(timestamps, catalogPort(catalog, calls, context)),
    context,
  });
  assert.equal(calendar.epochSeconds(timestamps[0]!), 1710034200);
  assert.equal(calendar.epochSeconds(timestamps[1]!), 1730604600);
  assert.deepEqual(
    calls.map((call) => call.seconds),
    [['1710034200', '1730601000'], ['1730604600'], ['1709947800']]
  );
});

test('no auxiliary sorting performs no epoch queries and preserves duration access', async () => {
  const timestamp = '2024-03-10T02:30:00';
  const calendar = await resolveRendererCalendar({
    ...options([timestamp], noPort),
    sortEpochs: false,
  });
  assert.equal(calendar.secondsBetween(timestamp, timestamp)?.lexeme, '0.0');
  assert.throws(() => calendar.epochSeconds(timestamp), RendererCalendarContractError);
});

test('local out-of-datetime year maps to caught ValueError; real OS failure remains observable at use', async () => {
  const timestamp = '1970-01-01';
  const os: RendererLocalCalendarPort = {
    async observe(request) {
      return reply(
        request,
        request.seconds.map((seconds) => ({
          kind: 'os_error',
          seconds,
          errno: 75,
          message: 'Value too large for defined data type',
        }))
      );
    },
  };
  const calendar = await resolveRendererCalendar(options([timestamp], os));
  assert.throws(
    () => calendar.epochSeconds(timestamp),
    (error: unknown) =>
      error instanceof RendererCalendarReferenceError &&
      error.referenceType === 'OSError' &&
      error.errno === 75 &&
      error.message === 'Value too large for defined data type'
  );
  const invalidYear: RendererLocalCalendarPort = {
    async observe(request) {
      return reply(
        request,
        request.seconds.map((seconds) => fields(seconds, 10000, 1, 1))
      );
    },
  };
  assert.equal(
    (await resolveRendererCalendar(options([timestamp], invalidYear))).epochSeconds(timestamp),
    null
  );
});

test('wrong identity, sequence, result order, raw fields and environment cannot become epochs', async () => {
  const mutators: Array<(row: Record<string, unknown>) => void> = [
    (row) => {
      row.id = 'other';
    },
    (row) => {
      row.token = 'c'.repeat(64);
    },
    (row) => {
      row.runtimeDigest = 'c'.repeat(64);
    },
    (row) => {
      row.profile = 'fixture';
    },
    (row) => {
      row.sequence = 2;
    },
    (row) => {
      row.context = { ...original, originalPid: 5678 };
    },
    (row) => {
      row.context = { ...original, tz: { kind: 'absent' } };
    },
    (row) => {
      row.context = { ...original, tz: { kind: 'present', value: '' } };
    },
    (row) => {
      row.context = { ...original, tzdir: { kind: 'present', value: '' } };
    },
    (row) => {
      row.results = [];
    },
    (row) => {
      row.results = [fields('1', 1970, 1, 1)];
    },
    (row) => {
      row.results = [{ ...fields('0', 1970, 1, 1), tmMon: 12 }];
    },
    (row) => {
      row.results = [{ ...fields('0', 1970, 1, 1), tmYear: 2 ** 31 }];
    },
    (row) => {
      row.results = [{ kind: 'os_error', seconds: '0', errno: 0, message: 'unknown' }];
    },
    (row) => {
      row.results = [{ kind: 'os_error', seconds: '0', errno: 5, message: 'a'.repeat(129) }];
    },
    (row) => {
      row.extra = true;
    },
  ];
  for (const mutate of mutators) {
    let count = 0;
    const port: RendererLocalCalendarPort = {
      async observe(request) {
        count++;
        const row = reply(request, [fields('0', 1970, 1, 1)]) as Record<string, unknown>;
        mutate(row);
        return row;
      },
    };
    await assert.rejects(
      resolveRendererCalendar(options(['1970-01-01'], port)),
      RendererCalendarContractError
    );
    assert.equal(count, 1);
  }
});

test('unreadable records keep typed failures while primitive and array records refuse before inspection', async () => {
  const expected = (category: 'request' | 'reply', message: string) => (error: unknown) =>
    error instanceof RendererCalendarContractError &&
    error.category === category &&
    error.message === message;
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  await assert.rejects(
    resolveRendererCalendar({
      ...options([], noPort),
      context: revoked.proxy as RendererCalendarContext,
    }),
    expected('request', 'Unreadable calendar record')
  );
  for (const value of [null, 1, []])
    await assert.rejects(
      resolveRendererCalendar({
        ...options([], noPort),
        context: value as unknown as RendererCalendarContext,
      }),
      expected('request', 'Calendar record required')
    );
  let inspections = 0;
  const array = new Proxy([], {
    ownKeys() {
      inspections++;
      throw new Error('Array must refuse before reflection');
    },
  });
  await assert.rejects(
    resolveRendererCalendar({
      ...options([], noPort),
      context: array as unknown as RendererCalendarContext,
    }),
    expected('request', 'Calendar record required')
  );
  assert.equal(inspections, 0);
  await assert.rejects(
    resolveRendererCalendar(
      options(['1970-01-01'], {
        async observe(request) {
          return reply(
            request,
            [fields('0', 1970, 1, 1)],
            revoked.proxy as RendererCalendarContext
          );
        },
      })
    ),
    expected('reply', 'Unreadable calendar record')
  );
});

test('explicit query and byte frontiers refuse before excess observations', async () => {
  const calls: LocalCalendarRequest[] = [];
  const port = catalogPort({ '0': fields('0', 1970, 1, 1) }, calls);
  await assert.rejects(
    resolveRendererCalendar({ ...options(['1970-01-01'], port), maximumQueries: 1 }),
    (error: unknown) =>
      error instanceof RendererCalendarContractError && error.category === 'query_limit'
  );
  assert.equal(calls.length, 1);
  calls.length = 0;
  await assert.rejects(
    resolveRendererCalendar({ ...options(['1970-01-01'], port), maximumTimestampBytes: 1 }),
    RendererCalendarContractError
  );
  assert.equal(calls.length, 0);
  await assert.rejects(
    resolveRendererCalendar({ ...options([], noPort), maximumQueries: 65537 }),
    RendererCalendarContractError
  );
  for (const token of ['', 'a'.repeat(129), 'a\0b', 'é'.repeat(65), 'a/b', 'a\n'])
    await assert.rejects(
      resolveRendererCalendar({ ...options([], noPort), token }),
      RendererCalendarContractError
    );
  assert.equal(
    (await resolveRendererCalendar({ ...options([], noPort), token: 'a'.repeat(128) })).profileId,
    PROFILE
  );
  assert.equal(MAX_LOCAL_CALENDAR_BATCH, 256);
});

test('257 distinct local probes use exactly two ordered bounded batches', async () => {
  const timestamps = Array.from(
    { length: 257 },
    (_, index) =>
      `1970-01-01T00:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}`
  );
  const calls: LocalCalendarRequest[] = [];
  const port: RendererLocalCalendarPort = {
    async observe(request) {
      calls.push(request);
      return reply(
        request,
        request.seconds.map((seconds) => ({
          kind: 'os_error',
          seconds,
          errno: 5,
          message: 'Input/output error',
        }))
      );
    },
  };
  const calendar = await resolveRendererCalendar(options(timestamps, port));
  assert.deepEqual(
    calls.map((request) => request.seconds.length),
    [256, 1]
  );
  assert.deepEqual(
    calls.flatMap((request) => request.seconds),
    Array.from({ length: 257 }, (_, index) => String(index))
  );
  assert.deepEqual(
    calls.map((request) => request.sequence),
    [1, 2]
  );
  for (const timestamp of [timestamps[0]!, timestamps[256]!])
    assert.throws(() => calendar.epochSeconds(timestamp), RendererCalendarReferenceError);
});

test('two-second responses cannot swap positions or execute a result getter', async () => {
  const timestamps = ['1970-01-01', '1970-01-01T01:00:00'];
  const swapped: RendererLocalCalendarPort = {
    async observe(request) {
      return reply(request, [fields('3600', 1970, 1, 1, 1), fields('0', 1970, 1, 1)]);
    },
  };
  await assert.rejects(
    resolveRendererCalendar(options(timestamps, swapped)),
    RendererCalendarContractError
  );
  let getters = 0;
  const accessor: RendererLocalCalendarPort = {
    async observe(request) {
      const result = { ...fields('0', 1970, 1, 1) };
      Object.defineProperty(result, 'tmYear', {
        get() {
          getters++;
          return 70;
        },
      });
      return reply(request, [result]);
    },
  };
  await assert.rejects(
    resolveRendererCalendar(options([timestamps[0]!], accessor)),
    RendererCalendarContractError
  );
  assert.equal(getters, 0);
});

test('absent, empty and explicit environment context remain distinct in the resolved identity', async () => {
  const contexts: RendererCalendarContext[] = [
    { originalPid: 1234, tz: { kind: 'absent' }, tzdir: { kind: 'absent' } },
    { originalPid: 1234, tz: { kind: 'present', value: '' }, tzdir: { kind: 'absent' } },
    {
      originalPid: 1234,
      tz: { kind: 'present', value: 'UTC' },
      tzdir: { kind: 'present', value: '' },
    },
  ];
  const identities: string[] = [];
  for (const context of contexts) {
    const calendar = await resolveRendererCalendar({
      ...options(['1970-01-01T00:00:00Z'], noPort),
      context,
    });
    assert.deepEqual(calendar.context, context);
    identities.push(calendar.timezone);
  }
  assert.equal(new Set(identities).size, 3);
});

test('cancellation/deadline and callback failure never become caught timestamp nulls', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    resolveRendererCalendar({ ...options([], noPort), signal: controller.signal }),
    (error: unknown) =>
      error instanceof RendererCalendarContractError && error.category === 'cancelled'
  );
  await assert.rejects(
    resolveRendererCalendar({ ...options([], noPort), deadlineEpochMs: Date.now() - 1 }),
    (error: unknown) =>
      error instanceof RendererCalendarContractError && error.category === 'deadline'
  );
  const failed: RendererLocalCalendarPort = {
    async observe() {
      throw new Error('original frontend unavailable');
    },
  };
  await assert.rejects(
    resolveRendererCalendar(options(['1970-01-01'], failed)),
    (error: unknown) =>
      error instanceof RendererCalendarContractError && error.category === 'transport'
  );
  const late = new AbortController();
  let calls = 0,
    release: ((value: unknown) => void) | undefined;
  const delayed: RendererLocalCalendarPort = {
    observe() {
      calls++;
      return new Promise((resolve) => {
        release = resolve;
        late.abort();
      });
    },
  };
  await assert.rejects(
    resolveRendererCalendar({ ...options(['1970-01-01'], delayed), signal: late.signal }),
    RendererCalendarContractError
  );
  assert.equal(calls, 1);
  assert.equal(typeof release, 'function');
  release!({ fabricated: true });
  assert.equal(calls, 1);
});

test('calendar arrays snapshot data without executing length, index, or iterator getters', async () => {
  let reads = 0;
  const request = new Proxy(['1970-01-01T00:00:00Z'], {
    get() {
      reads++;
      throw new Error('live request array read');
    },
  });
  const aware = await resolveRendererCalendar(options(request, noPort));
  assert.equal(aware.epochSeconds('1970-01-01T00:00:00Z'), 0);
  const naive = await resolveRendererCalendar(
    options(['1970-01-01'], {
      async observe(request) {
        return reply(
          request,
          new Proxy(
            request.seconds.map((seconds) => {
              assert.ok(seconds === '0' || seconds === '-86400');
              return seconds === '0' ? fields(seconds, 1970, 1, 1) : fields(seconds, 1969, 12, 31);
            }),
            {
              get() {
                reads++;
                throw new Error('live result array read');
              },
            }
          )
        );
      },
    })
  );
  assert.equal(naive.epochSeconds('1970-01-01'), 0);
  assert.equal(reads, 0);
});

test('calendar array descriptor traps, sparse entries, and accessors retain typed refusals', async () => {
  let getters = 0;
  const variants = <T>(values: T[]): T[][] => {
    const accessor = [...values];
    Object.defineProperty(accessor, '0', {
      get() {
        getters++;
        return values[0];
      },
    });
    return [
      new Proxy([...values], {
        ownKeys() {
          throw new Error('array ownKeys');
        },
      }),
      new Proxy([...values], {
        getOwnPropertyDescriptor() {
          throw new Error('array descriptor');
        },
      }),
      accessor,
      new Array<T>(values.length),
      Object.assign([...values], { extra: true }),
    ];
  };
  const expected = (category: 'request' | 'reply' | 'transport') => (error: unknown) =>
    error instanceof RendererCalendarContractError && error.category === category;
  for (const timestamps of variants(['1970-01-01']))
    await assert.rejects(resolveRendererCalendar(options(timestamps, noPort)), expected('request'));
  for (const results of variants([fields('0', 1970, 1, 1)]))
    await assert.rejects(
      resolveRendererCalendar(
        options(['1970-01-01'], {
          async observe(request) {
            return reply(request, results);
          },
        })
      ),
      expected('reply')
    );
  assert.equal(getters, 0);
  await assert.rejects(
    resolveRendererCalendar(
      options(['1970-01-01'], {
        async observe() {
          throw new Error('outside array boundary');
        },
      })
    ),
    expected('transport')
  );
});
