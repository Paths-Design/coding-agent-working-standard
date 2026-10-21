'use strict';
const {
  STORE_TIMESTAMP_PROFILE,
  prepareStoreTimestamp,
  finishStoreTimestamp,
  StoreTimestampReferenceError,
  StoreTimestampContractError,
} = require('../../dist/transcripts/store-timestamp');
const prepare = (cell) => prepareStoreTimestamp(STORE_TIMESTAMP_PROFILE, cell);
const real = (value) => prepare({ storageClass: 'real', value });
const integer = (value) => prepare({ storageClass: 'integer', value });
const bits = (value) => {
  const buffer = Buffer.alloc(8);
  buffer.writeDoubleBE(value);
  return buffer.toString('hex');
};
const fromBits = (hex) => Buffer.from(hex, 'hex').readDoubleBE();
const calendar = (prepared, overrides = {}) => ({
  kind: 'utc_calendar',
  seconds: prepared.seconds,
  tmYear: 70,
  tmMon: 0,
  tmMday: 1,
  tmHour: 0,
  tmMin: 0,
  tmSec: 0,
  ...overrides,
});
function failure(run, Class, expected) {
  let caught;
  try {
    run();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(Class);
  for (const [key, value] of Object.entries(expected)) expect(caught[key]).toBe(value);
  return caught;
}
const contract = (run, category, code) =>
  failure(run, StoreTimestampContractError, {
    ...(category ? { category } : {}),
    ...(code ? { code } : {}),
  });
const reference = (run, referenceType, message) =>
  failure(run, StoreTimestampReferenceError, { referenceType, ...(message ? { message } : {}) });

describe('explicit SQL timestamp preparation', () => {
  test('profile refusal occurs before reading a cell', () => {
    const trap = jest.fn(() => {
      throw Error('Cell must not be inspected');
    });
    const cell = new Proxy({}, { ownKeys: trap });
    for (const profile of [undefined, null, '', 'cpython-3.9', new String(STORE_TIMESTAMP_PROFILE)])
      contract(() => prepareStoreTimestamp(profile, cell), 'request', 'unsupported_profile');
    expect(trap).not.toHaveBeenCalled();
  });
  test('nonnumeric SQL classes return null without touching/coercing payloads', () => {
    const getter = jest.fn(() => {
      throw Error('No coercion');
    });
    for (const storageClass of ['null', 'text', 'blob']) {
      const cell = Object.defineProperty({ storageClass }, 'value', { get: getter });
      expect(prepare(cell)).toBeNull();
    }
    expect(getter).not.toHaveBeenCalled();
  });
  test('requires own tagged numeric data and exact signed64 INTEGER values', () => {
    for (const cell of [
      null,
      undefined,
      [],
      true,
      1,
      '1',
      {},
      { storageClass: 'boolean' },
      Object.create({ storageClass: 'integer', value: 1n }),
    ])
      contract(() => prepare(cell), 'request');
    for (const value of [1, '1', true, new Number(1), -(1n << 63n) - 1n, 1n << 63n])
      contract(() => integer(value), 'request', 'invalid_i64');
    expect(integer(-(1n << 63n)).seconds).toBe(-9223372036854776n);
    expect(integer((1n << 63n) - 1n).seconds).toBe(9223372036854776n);
  });
  test('REAL is binary64 only and accessors/proxy failures remain contract failures', () => {
    for (const value of [1n, '1', true, null, new Number(1)])
      contract(() => real(value), 'request', 'invalid_real');
    const getter = jest.fn(() => {
      throw new StoreTimestampReferenceError('OSError', 'fake');
    });
    contract(
      () => prepare(Object.defineProperty({ storageClass: 'real' }, 'value', { get: getter })),
      'request'
    );
    expect(getter).not.toHaveBeenCalled();
    contract(() => prepare(new Proxy({}, { ownKeys: getter })), 'request', 'unreadable_record');
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    contract(() => prepare(revoked.proxy), 'request', 'unreadable_record');
  });
  test.each([9007199254740995n, -9007199254740995n])(
    'rounds INTEGER true division once: %s',
    (value) => {
      const prepared = integer(value);
      const expected = value < 0n ? -9007199254740.994 : 9007199254740.994;
      expect(prepared.quotientBinary64Hex).toBe(bits(expected));
      expect(prepared.quotientBinary64Hex).not.toBe(bits(Number(value) / 1000));
    }
  );
  test('INTEGER zero and REAL signed zero preserve quotient distinction and normalize the pair', () => {
    expect(integer(0n).quotientBinary64Hex).toBe('0000000000000000');
    expect(real(-0).quotientBinary64Hex).toBe('8000000000000000');
    for (const cell of [integer(0n), real(-0), real(0)]) {
      expect(cell.seconds).toBe(0n);
      expect(cell.microseconds).toBe(0);
      expect(Object.is(cell.microseconds, -0)).toBe(false);
    }
  });
  test.each([
    [1.25, 0n, 1250],
    [-1.25, -1n, 998750],
    [0.0005, 0n, 0],
    [-0.0005, 0n, 0],
    [0.0005000000000000001, 0n, 1],
    [0.0004999999999999999, 0n, 0],
    [-0.0005000000000000001, -1n, 999999],
    [0.0015, 0n, 2],
    [-0.0015, -1n, 999998],
    [0.0025, 0n, 2],
    [999.9999, 1n, 0],
    [-999.9999, -1n, 0],
  ])('normalizes half-even microseconds for %s ms', (value, seconds, microseconds) => {
    expect(real(value)).toMatchObject({ seconds, microseconds });
  });
  test('calendar-edge INTEGER keeps the binary64 division/fraction result', () => {
    expect(integer(253402300799999n)).toMatchObject({
      seconds: 253402300799n,
      microseconds: 998993,
    });
    expect(real(253402300799999.97)).toMatchObject({
      seconds: 253402300799n,
      microseconds: 999969,
    });
  });
  test('NaN and nonfinite/out-of-time_t results preserve distinct reference failures', () => {
    reference(() => real(NaN), 'ValueError', 'Invalid value NaN (not a number)');
    for (const value of [
      Infinity,
      -Infinity,
      1e308,
      -1e308,
      fromBits('447f400000000000'),
      fromBits('c47f400000000001'),
    ])
      reference(() => real(value), 'OverflowError', 'timestamp out of range for platform time_t');
    expect(real(fromBits('c47f400000000000')).seconds).toBe(-(1n << 63n));
    expect(real(fromBits('447f3fffffffffff')).seconds < 1n << 63n).toBe(true);
  });
  test('preparation freezes exact seconds and diagnostics', () => {
    const prepared = integer(1n);
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(typeof prepared.seconds).toBe('bigint');
    expect(prepared.profile).toBe(STORE_TIMESTAMP_PROFILE);
    expect(() => {
      prepared.seconds = 7n;
    }).toThrow(TypeError);
    expect(() => JSON.stringify(prepared)).toThrow(TypeError); // Caller must transport exact seconds explicitly.
  });
});

describe('supplied UTC calendar finishing', () => {
  test('null preparation returns null before any supplied-result inspection', () => {
    const trap = jest.fn(() => {
      throw Error('No result inspection');
    });
    expect(finishStoreTimestamp(null, new Proxy({}, { ownKeys: trap }))).toBeNull();
    expect(trap).not.toHaveBeenCalled();
  });
  test('forged or copied preparations fail before supplied OS errors', () => {
    const prepared = integer(0n);
    const trap = jest.fn(() => {
      throw Error('No result inspection');
    });
    for (const value of [undefined, {}, Object.freeze({ ...prepared }), 0, '0'])
      contract(
        () => finishStoreTimestamp(value, new Proxy({}, { ownKeys: trap })),
        'preparation',
        'invalid_preparation'
      );
    expect(trap).not.toHaveBeenCalled();
  });
  test('OS failure takes precedence over all calendar fields and keeps errno/message', () => {
    const prepared = integer(0n),
      getter = jest.fn(() => {
        throw Error('Do not inspect calendar');
      });
    const result = {
      kind: 'os_error',
      seconds: prepared.seconds,
      errno: 84,
      message: '[Errno 84] Value too large to be stored in data type',
    };
    Object.defineProperty(result, 'tmYear', { get: getter });
    const err = reference(() => finishStoreTimestamp(prepared, result), 'OSError', result.message);
    expect(err.errno).toBe(84);
    expect(getter).not.toHaveBeenCalled();
  });
  test.each(['transport', 'cancelled', 'callback'])(
    'port failure %s stays separate from reference errors',
    (category) => {
      const prepared = integer(0n);
      const err = contract(
        () =>
          finishStoreTimestamp(prepared, {
            kind: 'port_failure',
            seconds: prepared.seconds,
            failure: category,
            message: 'unavailable',
          }),
        category,
        'calendar_port_failure'
      );
      expect(err).not.toBeInstanceOf(StoreTimestampReferenceError);
    }
  );
  test('mismatched seconds cannot attach either success or OS failure to the preparation', () => {
    const prepared = integer(1000n);
    for (const result of [
      calendar(prepared, { seconds: 0n }),
      { kind: 'os_error', seconds: '1', errno: 84, message: 'failure' },
    ])
      contract(
        () => finishStoreTimestamp(prepared, result),
        'calendar_result',
        'mismatched_seconds'
      );
  });
  test('malformed result and OS envelopes cannot manufacture reference OSError', () => {
    const prepared = integer(0n);
    for (const result of [
      undefined,
      null,
      [],
      {},
      { kind: 'other', seconds: 0n },
      { kind: 'os_error', seconds: 0n, errno: 0, message: 'zero is for owner to resolve' },
      { kind: 'os_error', seconds: 0n, errno: -1, message: 'bad' },
      { kind: 'os_error', seconds: 0n, errno: 84, message: null },
      { kind: 'port_failure', seconds: 0n, failure: 'OSError', message: 'fake' },
    ])
      contract(() => finishStoreTimestamp(prepared, result), 'calendar_result');
    const getter = jest.fn(() => {
      throw Error('accessor');
    });
    contract(
      () =>
        finishStoreTimestamp(
          prepared,
          Object.defineProperty({ kind: 'utc_calendar' }, 'seconds', { get: getter })
        ),
      'calendar_result'
    );
    expect(getter).not.toHaveBeenCalled();
  });
  test('raw fields are signed C integers; malformed port values are not calendar ValueError', () => {
    const prepared = integer(0n);
    for (const key of ['tmYear', 'tmMon', 'tmMday', 'tmHour', 'tmMin', 'tmSec'])
      for (const bad of [
        undefined,
        null,
        true,
        '1',
        1n,
        1.25,
        Infinity,
        NaN,
        2 ** 31,
        -(2 ** 31) - 1,
      ])
        contract(
          () => finishStoreTimestamp(prepared, calendar(prepared, { [key]: bad })),
          'calendar_result',
          'invalid_' + key
        );
  });
  test('extreme C-int year-addition band is explicitly unqualified', () => {
    const prepared = integer(0n);
    for (const tmYear of [2 ** 31 - 1900, 2 ** 31 - 1])
      contract(
        () => finishStoreTimestamp(prepared, calendar(prepared, { tmYear })),
        'unqualified_profile',
        'year_addition_band'
      );
    reference(
      () => finishStoreTimestamp(prepared, calendar(prepared, { tmYear: 2 ** 31 - 1901 })),
      'ValueError',
      'year 2147483647 is out of range'
    );
  });
  test.each([
    [{ tmYear: -1900 }, 'year 0 is out of range'],
    [{ tmYear: 8100 }, 'year 10000 is out of range'],
    [{ tmMon: -1 }, 'month must be in 1..12'],
    [{ tmMon: 12 }, 'month must be in 1..12'],
    [{ tmMday: 0 }, 'day is out of range for month'],
    [{ tmMon: 3, tmMday: 31 }, 'day is out of range for month'],
    [{ tmYear: 0, tmMon: 1, tmMday: 29 }, 'day is out of range for month'],
    [{ tmHour: -1 }, 'hour must be in 0..23'],
    [{ tmHour: 24 }, 'hour must be in 0..23'],
    [{ tmMin: -1 }, 'minute must be in 0..59'],
    [{ tmMin: 60 }, 'minute must be in 0..59'],
    [{ tmSec: -1 }, 'second must be in 0..59'],
  ])('calendar validation preserves date-before-time failure for %j', (override, message) => {
    const prepared = integer(0n);
    reference(
      () => finishStoreTimestamp(prepared, calendar(prepared, override)),
      'ValueError',
      message
    );
  });
  test('year before month before day before time validation', () => {
    const prepared = integer(0n);
    reference(
      () =>
        finishStoreTimestamp(
          prepared,
          calendar(prepared, { tmYear: -1900, tmMon: -1, tmMday: 0, tmHour: 99 })
        ),
      'ValueError',
      'year 0 is out of range'
    );
    reference(
      () =>
        finishStoreTimestamp(prepared, calendar(prepared, { tmMon: -1, tmMday: 0, tmHour: 99 })),
      'ValueError',
      'month must be in 1..12'
    );
  });
  test('UTC auto formatting and leap calendar values', () => {
    const zero = integer(0n),
      fraction = integer(1n);
    expect(finishStoreTimestamp(zero, calendar(zero))).toBe('1970-01-01T00:00:00+00:00');
    expect(finishStoreTimestamp(fraction, calendar(fraction))).toBe(
      '1970-01-01T00:00:00.001000+00:00'
    );
    expect(finishStoreTimestamp(zero, calendar(zero, { tmYear: -1899 }))).toBe(
      '0001-01-01T00:00:00+00:00'
    );
    expect(finishStoreTimestamp(zero, calendar(zero, { tmYear: 100, tmMon: 1, tmMday: 29 }))).toBe(
      '2000-02-29T00:00:00+00:00'
    );
  });
  test.each([59, 60, 61, 2 ** 31 - 1])(
    'all nonnegative leap seconds above59 clamp: %s',
    (tmSec) => {
      const prepared = real(0.0005000000000000001);
      expect(finishStoreTimestamp(prepared, calendar(prepared, { tmSec }))).toBe(
        '1970-01-01T00:00:59.000001+00:00'
      );
    }
  );
  test('supplied calendar determines the date; no default Date or callback executes', () => {
    const OriginalDate = globalThis.Date;
    globalThis.Date = class {
      constructor() {
        throw Error('Date forbidden');
      }
    };
    try {
      const prepared = integer(0n);
      expect(
        finishStoreTimestamp(
          prepared,
          calendar(prepared, {
            tmYear: 123,
            tmMon: 11,
            tmMday: 31,
            tmHour: 23,
            tmMin: 58,
            tmSec: 1,
          })
        )
      ).toBe('2023-12-31T23:58:01+00:00');
      contract(
        () =>
          finishStoreTimestamp(prepared, () => {
            throw Error('Callback forbidden');
          }),
        'calendar_result'
      );
    } finally {
      globalThis.Date = OriginalDate;
    }
  });
});
