/** Pure arithmetic and supplied-calendar interpretation; no native/source authority. */
export const STORE_TIMESTAMP_PROFILE = 'cpython-3.11.13-binary64-time_t64-tm32-utc' as const;
export type StoreTimestampCell =
  | Readonly<{ storageClass: 'integer'; value: bigint }>
  | Readonly<{ storageClass: 'real'; value: number }>
  | Readonly<{ storageClass: 'null' | 'text' | 'blob' }>;
declare const preparedBrand: unique symbol;
export type PreparedStoreTimestamp = Readonly<{
  kind: 'prepared_store_timestamp';
  profile: typeof STORE_TIMESTAMP_PROFILE;
  seconds: bigint;
  microseconds: number;
  /** Diagnostic arithmetic observation, not an adoption identity. */
  quotientBinary64Hex: string;
  [preparedBrand]: true;
}>;
export type StoreUtcCalendarResult =
  | Readonly<{
      kind: 'utc_calendar';
      seconds: bigint;
      tmYear: number;
      tmMon: number;
      tmMday: number;
      tmHour: number;
      tmMin: number;
      tmSec: number;
    }>
  | Readonly<{ kind: 'os_error'; seconds: bigint; errno: number; message: string }>
  | Readonly<{
      kind: 'port_failure';
      seconds: bigint;
      failure: 'transport' | 'cancelled' | 'callback';
      message: string;
    }>;
export class StoreTimestampReferenceError extends Error {
  constructor(
    readonly referenceType: 'ValueError' | 'OverflowError' | 'OSError',
    message: string,
    readonly errno: number | undefined = undefined
  ) {
    super(message);
    this.name = 'StoreTimestampReferenceError';
  }
}
export class StoreTimestampContractError extends Error {
  constructor(
    readonly category:
      | 'request'
      | 'preparation'
      | 'calendar_result'
      | 'transport'
      | 'cancelled'
      | 'callback'
      | 'unqualified_profile',
    readonly code: string,
    message = code
  ) {
    super(message);
    this.name = 'StoreTimestampContractError';
  }
}
const preparations = new WeakSet<object>();
const MIN_I64 = -(1n << 63n);
const MAX_I64 = (1n << 63n) - 1n;
const MIN_I32 = -(2 ** 31);
const MAX_I32 = 2 ** 31 - 1;

/** Read only own data properties. Getters/proxies cannot become reference OS failures. */
function dataFields(
  value: unknown,
  category: 'request' | 'calendar_result'
): Record<string, PropertyDescriptor> {
  if (value === null || typeof value !== 'object')
    throw new StoreTimestampContractError(category, 'invalid_record');
  try {
    if (Array.isArray(value)) throw new Error('Array is not a record');
    return Object.getOwnPropertyDescriptors(value);
  } catch {
    throw new StoreTimestampContractError(category, 'unreadable_record');
  }
}
function field(
  fields: Record<string, PropertyDescriptor>,
  name: string,
  category: 'request' | 'calendar_result'
): unknown {
  const descriptor = Object.prototype.hasOwnProperty.call(fields, name) ? fields[name] : undefined;
  if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value'))
    throw new StoreTimestampContractError(category, 'missing_or_accessor_' + name);
  return descriptor.value;
}
function quotientBits(value: number): string {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value, false);
  return (
    view.getUint32(0, false).toString(16).padStart(8, '0') +
    view.getUint32(4, false).toString(16).padStart(8, '0')
  );
}

/** Correctly round the exact i64/1000 rational once, using bounded integer work. */
function integerSeconds(value: bigint): number {
  if (value === 0n) return 0;
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  // 1000 has ten bits; this estimate is at most one binade too high.
  let exponent = magnitude.toString(2).length - 10;
  if (
    exponent >= 0 ? magnitude < 1000n << BigInt(exponent) : magnitude << BigInt(-exponent) < 1000n
  )
    exponent--;
  const shift = 52 - exponent;
  const numerator = shift >= 0 ? magnitude << BigInt(shift) : magnitude;
  const denominator = shift >= 0 ? 1000n : 1000n << BigInt(-shift);
  let mantissa = numerator / denominator;
  const remainder = numerator % denominator;
  if (2n * remainder > denominator || (2n * remainder === denominator && (mantissa & 1n) !== 0n))
    mantissa++;
  // The rounded mantissa is <=2**53. Both conversion and binary scaling are exact.
  const result = Number(mantissa) * 2 ** (exponent - 52);
  return negative ? -result : result;
}
function roundEven(value: number): number {
  const magnitude = Math.abs(value);
  const lower = Math.floor(magnitude);
  const fraction = magnitude - lower;
  const rounded = fraction > 0.5 || (fraction === 0.5 && lower % 2 !== 0) ? lower + 1 : lower;
  return value < 0 ? -rounded : rounded;
}

/** No calendar calls or platform guesses occur in preparation. */
export function prepareStoreTimestamp(
  profile: typeof STORE_TIMESTAMP_PROFILE,
  cell: StoreTimestampCell
): PreparedStoreTimestamp | null {
  if (profile !== STORE_TIMESTAMP_PROFILE)
    throw new StoreTimestampContractError('request', 'unsupported_profile');
  const fields = dataFields(cell, 'request');
  const storageClass = field(fields, 'storageClass', 'request');
  if (storageClass === 'null' || storageClass === 'text' || storageClass === 'blob') return null;
  if (storageClass !== 'integer' && storageClass !== 'real')
    throw new StoreTimestampContractError('request', 'storage_class');
  let quotient: number;
  const value = field(fields, 'value', 'request');
  if (storageClass === 'integer') {
    if (typeof value !== 'bigint' || value < MIN_I64 || value > MAX_I64)
      throw new StoreTimestampContractError('request', 'invalid_i64');
    quotient = integerSeconds(value);
  } else if (storageClass === 'real') {
    if (typeof value !== 'number') throw new StoreTimestampContractError('request', 'invalid_real');
    quotient = value / 1000;
  } else throw new StoreTimestampContractError('request', 'storage_class');
  if (Number.isNaN(quotient))
    throw new StoreTimestampReferenceError('ValueError', 'Invalid value NaN (not a number)');
  if (!Number.isFinite(quotient))
    throw new StoreTimestampReferenceError(
      'OverflowError',
      'timestamp out of range for platform time_t'
    );
  let whole = Math.trunc(quotient);
  let microseconds = roundEven((quotient - whole) * 1_000_000);
  if (microseconds >= 1_000_000) {
    whole++;
    microseconds -= 1_000_000;
  } else if (microseconds < 0) {
    whole--;
    microseconds += 1_000_000;
  }
  // Normalize first; the upper endpoint is exclusive, including at binary64 precision.
  if (!(whole >= -(2 ** 63) && whole < 2 ** 63))
    throw new StoreTimestampReferenceError(
      'OverflowError',
      'timestamp out of range for platform time_t'
    );
  const prepared = Object.freeze({
    kind: 'prepared_store_timestamp' as const,
    profile,
    seconds: BigInt(whole),
    microseconds: microseconds === 0 ? 0 : microseconds,
    quotientBinary64Hex: quotientBits(quotient),
  }) as PreparedStoreTimestamp;
  preparations.add(prepared);
  return prepared;
}

/**
 * Interpret an explicitly supplied UTC calendar observation after asynchronous
 * work owned by the caller. Correlation by seconds detects mismatched input,
 * but neither a token nor an echoed value authenticates a native producer.
 * Actual gmtime, errno fallback, locale, transport and cleanup belong to that owner.
 */
export function finishStoreTimestamp(
  prepared: PreparedStoreTimestamp | null,
  calendarResult: unknown
): string | null {
  if (prepared === null) return null;
  if (typeof prepared !== 'object' || !preparations.has(prepared))
    throw new StoreTimestampContractError('preparation', 'invalid_preparation');
  const fields = dataFields(calendarResult, 'calendar_result');
  const kind = field(fields, 'kind', 'calendar_result');
  if (field(fields, 'seconds', 'calendar_result') !== prepared.seconds)
    throw new StoreTimestampContractError('calendar_result', 'mismatched_seconds');
  if (kind === 'os_error') {
    const errno = field(fields, 'errno', 'calendar_result');
    const message = field(fields, 'message', 'calendar_result');
    // The port owns errno==0 -> EINVAL. A malformed envelope cannot invent OSError.
    if (
      typeof errno !== 'number' ||
      !Number.isInteger(errno) ||
      errno <= 0 ||
      errno > MAX_I32 ||
      typeof message !== 'string'
    )
      throw new StoreTimestampContractError('calendar_result', 'invalid_os_error');
    throw new StoreTimestampReferenceError('OSError', message, errno);
  }
  if (kind === 'port_failure') {
    const failure = field(fields, 'failure', 'calendar_result');
    const message = field(fields, 'message', 'calendar_result');
    if (
      (failure !== 'transport' && failure !== 'cancelled' && failure !== 'callback') ||
      typeof message !== 'string'
    )
      throw new StoreTimestampContractError('calendar_result', 'invalid_port_failure');
    throw new StoreTimestampContractError(failure, 'calendar_port_failure', message);
  }
  if (kind !== 'utc_calendar')
    throw new StoreTimestampContractError('calendar_result', 'unknown_result');
  const integer = (name: string): number => {
    const value = field(fields, name, 'calendar_result');
    if (typeof value !== 'number' || !Number.isInteger(value) || value < MIN_I32 || value > MAX_I32)
      throw new StoreTimestampContractError('calendar_result', 'invalid_' + name);
    return value;
  };
  const tmYear = integer('tmYear');
  const month = integer('tmMon') + 1;
  const day = integer('tmMday');
  const hour = integer('tmHour');
  const minute = integer('tmMin');
  const second = Math.min(59, integer('tmSec'));
  if (tmYear > MAX_I32 - 1900)
    throw new StoreTimestampContractError('unqualified_profile', 'year_addition_band');
  const year = tmYear + 1900;
  const invalid = (message: string): never => {
    throw new StoreTimestampReferenceError('ValueError', message);
  };
  if (year < 1 || year > 9999) invalid(`year ${year} is out of range`);
  if (month < 1 || month > 12) invalid('month must be in 1..12');
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
  if (day < 1 || day > days) invalid('day is out of range for month');
  if (hour < 0 || hour > 23) invalid('hour must be in 0..23');
  if (minute < 0 || minute > 59) invalid('minute must be in 0..59');
  if (second < 0) invalid('second must be in 0..59');
  const pad = (value: number): string => String(value).padStart(2, '0');
  const fraction = prepared.microseconds
    ? '.' + String(prepared.microseconds).padStart(6, '0')
    : '';
  return `${String(year).padStart(4, '0')}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}${fraction}+00:00`;
}
