/** CPython 3.11.13 renderer calendar interpretation. No filesystem or publication authority. */
import type { RendererCalendarPort } from './render-prepare';
import type { JsonNumber } from './lossless-json';
import { renderFloat } from './render-values';
import { isPythonDecimalCodepoint, PYTHON_DECIMAL_PATTERN } from './python-unicode-profile';

export const RENDERER_CALENDAR_PROFILE = 'cpython-3.11.13-renderer-calendar.v1' as const;
export const LOCAL_CALENDAR_REQUEST = 'caws.renderer-calendar.local.request.v1' as const;
export const LOCAL_CALENDAR_REPLY = 'caws.renderer-calendar.local.reply.v1' as const;
export const MAX_LOCAL_CALENDAR_BATCH = 256;
export const MAX_LOCAL_CALENDAR_QUERIES = 65_536;
const SECOND = 1_000_000n;
const DAY = 86_400n;
const EPOCH = 719_163n * DAY;
const MIN_I64 = -(1n << 63n),
  MAX_I64 = (1n << 63n) - 1n;
type EnvironmentValue = Readonly<{ kind: 'absent' }> | Readonly<{ kind: 'present'; value: string }>;
export interface RendererCalendarContext {
  readonly originalPid: number;
  readonly tz: EnvironmentValue;
  readonly tzdir: EnvironmentValue;
}
export interface LocalCalendarRequest {
  readonly schema: typeof LOCAL_CALENDAR_REQUEST;
  readonly profile: typeof RENDERER_CALENDAR_PROFILE;
  readonly id: string;
  readonly runtimeDigest: string;
  readonly token: string;
  readonly sequence: number;
  readonly seconds: readonly string[];
}
export interface RendererLocalCalendarPort {
  observe(
    request: LocalCalendarRequest,
    signal: AbortSignal,
    deadlineEpochMs: number
  ): Promise<unknown>;
}
export class RendererCalendarContractError extends Error {
  constructor(
    readonly category:
      | 'profile'
      | 'request'
      | 'reply'
      | 'transport'
      | 'cancelled'
      | 'deadline'
      | 'query_limit'
      | 'unresolved',
    message: string
  ) {
    super(message);
    this.name = 'RendererCalendarContractError';
  }
}
export class RendererCalendarReferenceError extends Error {
  constructor(
    readonly referenceType: 'ValueError' | 'OverflowError' | 'OSError',
    message: string,
    readonly errno?: number
  ) {
    super(message);
    this.name = 'RendererCalendarReferenceError';
  }
}
export interface ParsedRendererTimestamp {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly microsecond: number;
  readonly offsetMicroseconds: bigint | null;
}
const leap = (year: number): boolean => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
function ordinal(year: number, month: number, day: number): bigint {
  const y = year - 1;
  let days = 365 * y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) + day;
  const before = [0, 0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  days += before[month]! + (month > 2 && leap(year) ? 1 : 0);
  return BigInt(days);
}
function dateFromOrdinal(value: bigint): readonly [number, number, number] | null {
  if (value < 1n || value > 3_652_059n) return null;
  let low = 1,
    high = 10_000;
  while (low + 1 < high) {
    const middle = (low + high) >>> 1;
    if (ordinal(middle, 1, 1) <= value) low = middle;
    else high = middle;
  }
  let month = 1;
  while (month < 12 && ordinal(low, month + 1, 1) <= value) month++;
  return [low, month, Number(value - ordinal(low, month, 1)) + 1];
}
function checkedDate(year: number, month: number, day: number): boolean {
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1) return false;
  return day <= [31, leap(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
}
const asciiDigit = (byte: number): boolean => byte >= 48 && byte <= 57;
function iso(value: string): ParsedRendererTimestamp | null {
  // CPython sanitizes a lone surrogate only at a possible separator position.
  const points = Array.from(value);
  if (points.length < 7) return null;
  for (const position of [7, 8, 10]) {
    const cp = points[position]?.codePointAt(0);
    if (cp !== undefined && cp >= 0xd800 && cp <= 0xdfff) {
      points[position] = 'T';
      break;
    }
  }
  if (
    points.some((p) => {
      const cp = p.codePointAt(0)!;
      return cp >= 0xd800 && cp <= 0xdfff;
    })
  )
    return null;
  const bytes = Buffer.from(points.join(''), 'utf8');
  const at = (position: number): number => bytes[position] ?? 0;
  const len = bytes.length;
  let separator: number;
  if (len === 7) separator = 7;
  else if (at(4) === 45) {
    if (at(5) !== 87) separator = 10;
    else if (len < 8) return null;
    else if (len > 8 && at(8) === 45) {
      if (len === 9) return null;
      separator = len > 10 && asciiDigit(at(10)) ? 8 : 10;
    } else separator = 8;
  } else if (at(4) === 87) {
    let position = 7;
    while (position < len && asciiDigit(at(position))) position++;
    separator = position < 9 ? position : position % 2 === 0 ? 7 : 8;
  } else separator = 8;
  let p = 0;
  const digits = (count: number): number | null => {
    let result = 0;
    for (let index = 0; index < count; index++) {
      const byte = at(p++);
      if (!asciiDigit(byte)) return null;
      result = result * 10 + byte - 48;
    }
    return result;
  };
  let year = digits(4);
  if (year === null) return null;
  const separated = at(p) === 45;
  if (separated) p++;
  let month: number | null, day: number | null;
  if (at(p) === 87) {
    p++;
    const week = digits(2);
    if (week === null || year < 1 || year > 9999) return null;
    let weekday: number | null = 1;
    if (p < separator) {
      if (separated && at(p++) !== 45) return null;
      weekday = digits(1);
    }
    if (weekday === null || weekday < 1 || weekday > 7 || week < 1 || week > 53) return null;
    const jan4 = ordinal(year, 1, 4);
    const monday = jan4 - ((jan4 - 1n) % 7n);
    const nextJan4 = ordinal(year + 1, 1, 4);
    const nextMonday = nextJan4 - ((nextJan4 - 1n) % 7n);
    const start = monday + BigInt(week - 1) * 7n;
    if (start >= nextMonday) return null;
    const date = dateFromOrdinal(start + BigInt(weekday - 1));
    if (!date) return null;
    [year, month, day] = date;
  } else {
    month = digits(2);
    if (separated && at(p++) !== 45) return null;
    day = digits(2);
  }
  if (month === null || day === null || !checkedDate(year, month, day)) return null;
  type Time = { fields: [number, number, number, number]; rv: number };
  const time = (start: number, end: number): Time | null => {
    p = start;
    const fields: [number, number, number, number] = [0, 0, 0, 0];
    let withColon = true;
    for (let index = 0; index < 3; index++) {
      const part = digits(2);
      if (part === null) return null;
      fields[index] = part;
      const c = at(p++);
      if (index === 0) withColon = c === 58;
      if (p >= end) return { fields, rv: c === 0 ? 0 : 1 };
      if (withColon && c === 58) continue;
      if (c === 46 || c === 44) break;
      if (!withColon) p--;
      else return null;
    }
    const count = Math.min(6, end - p);
    if (count < 1) return null;
    const fraction = digits(count);
    if (fraction === null) return null;
    fields[3] = fraction * 10 ** (6 - count);
    while (asciiDigit(at(p))) p++;
    return { fields, rv: at(p) === 0 ? 0 : 1 };
  };
  let fields: [number, number, number, number] = [0, 0, 0, 0],
    offset: bigint | null = null;
  if (len > separator) {
    const first = at(separator);
    const width = first < 128 ? 1 : (first & 0xf0) === 0xe0 ? 3 : (first & 0xf0) === 0xf0 ? 4 : 2;
    const start = separator + width;
    let zone = start;
    while (zone < len && ![90, 43, 45].includes(at(zone))) zone++;
    const parsed = time(start, zone);
    if (!parsed) return null;
    fields = parsed.fields;
    if (zone === len) {
      if (parsed.rv !== 0) return null;
    } else if (at(zone) === 90) {
      if (at(zone + 1) !== 0) return null;
      offset = 0n;
    } else {
      const negative = at(zone) === 45;
      const tz = time(zone + 1, len);
      if (!tz || tz.rv !== 0) return null;
      const [h, m, s, us] = tz.fields,
        seconds = h * 3600 + m * 60 + s;
      // The accelerator interns UTC when the integral offset is zero, including a fractional offset.
      offset =
        seconds === 0 ? 0n : BigInt(negative ? -1 : 1) * (BigInt(seconds) * SECOND + BigInt(us));
      if (offset <= -DAY * SECOND || offset >= DAY * SECOND) return null;
    }
  }
  const [hour, minute, second, microsecond] = fields;
  if (hour > 23 || minute > 59 || second > 59) return null;
  return Object.freeze({
    year,
    month,
    day,
    hour,
    minute,
    second,
    microsecond,
    offsetMicroseconds: offset,
  });
}
const D = PYTHON_DECIMAL_PATTERN;
const fallbackPrefix = `(${D}{4})-(1[0-2]|0[1-9]|[1-9])-(3[01]|[12]${D}|0[1-9]|[1-9]| [1-9])[Tt](2[0-3]|[01]${D}|${D}):([0-5]${D}|${D}):(6[01]|[0-5]${D}|${D})`;
const fallbackOffset = `[+-]${D}${D}:?[0-5]${D}(?::?[0-5]${D}(?:\\.${D}{1,6})?)?|Z`;
const fallbacks = [
  new RegExp(`^${fallbackPrefix}([Zz])(?![\\s\\S])`, 'u'),
  new RegExp(`^${fallbackPrefix}\\.([0-9]{1,6})([Zz])(?![\\s\\S])`, 'u'),
  new RegExp(`^${fallbackPrefix}(${fallbackOffset})(?![\\s\\S])`, 'u'),
  new RegExp(`^${fallbackPrefix}\\.([0-9]{1,6})(${fallbackOffset})(?![\\s\\S])`, 'u'),
];
function decimal(value: string): number {
  let result = 0;
  for (const point of Array.from(value)) {
    if (point === ' ') continue;
    const cp = point.codePointAt(0)!;
    let zero = cp;
    while (zero > 0 && isPythonDecimalCodepoint(zero - 1)) zero--;
    result = result * 10 + ((cp - zero) % 10);
  }
  return result;
}
function fallback(value: string): ParsedRendererTimestamp | null {
  for (let index = 0; index < fallbacks.length; index++) {
    const match = fallbacks[index]!.exec(value);
    if (!match) continue;
    const [year, month, day, hour, minute, second] = match.slice(1, 7).map(decimal) as [
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    if (!checkedDate(year, month, day) || hour > 23 || minute > 59 || second > 59) continue;
    const fractional = index % 2 === 1;
    const microsecond = fractional ? Number(match[7]!.padEnd(6, '0')) : 0;
    let offsetMicroseconds: bigint | null = null;
    if (index > 1) {
      const z = Array.from(match[fractional ? 8 : 7]!);
      if (z[0] === 'Z') offsetMicroseconds = 0n;
      else {
        if (z[3] === ':') {
          z.splice(3, 1);
          if (z.length > 5) {
            if (z[5] !== ':') continue;
            z.splice(5, 1);
          }
        }
        // _strptime's permissive %z regex also matches +HHMM:SS. Its
        // subsequent int(seconds) rejects the remaining colon; it is not a digit.
        if (z.slice(1, 7).some((point) => !isPythonDecimalCodepoint(point.codePointAt(0)!)))
          continue;
        const h = decimal(z.slice(1, 3).join('')),
          m = decimal(z.slice(3, 5).join(''));
        const s = decimal(z.slice(5, 7).join(''));
        const fraction = z.slice(8);
        while (fraction.length < 6) fraction.push('0');
        const us = decimal(fraction.join(''));
        offsetMicroseconds =
          BigInt(z[0] === '-' ? -1 : 1) * (BigInt(h * 3600 + m * 60 + s) * SECOND + BigInt(us));
        if (offsetMicroseconds <= -DAY * SECOND || offsetMicroseconds >= DAY * SECOND) continue;
      }
    }
    return Object.freeze({
      year,
      month,
      day,
      hour,
      minute,
      second,
      microsecond,
      offsetMicroseconds,
    });
  }
  return null;
}
function profile(value: string): void {
  if (value !== RENDERER_CALENDAR_PROFILE)
    throw new RendererCalendarContractError('profile', 'Unsupported renderer calendar profile');
}
/** Null means precisely the renderer's caught invalid-input case. The two modes intentionally differ. */
export function parseRendererTimestamp(
  selectedProfile: string,
  mode: 'duration' | 'epoch',
  value: string | null
): ParsedRendererTimestamp | null {
  profile(selectedProfile);
  if ((value !== null && typeof value !== 'string') || (mode !== 'duration' && mode !== 'epoch'))
    throw new RendererCalendarContractError('request', 'Invalid renderer timestamp request');
  if (value === null || value === '') return null;
  if (mode === 'epoch') return iso(value.replace(/Z/g, '+00:00'));
  return (value.includes('T') ? iso(value.replace(/Z/g, '+00:00')) : null) ?? fallback(value);
}
function wallSeconds(value: ParsedRendererTimestamp): bigint {
  return (
    ordinal(value.year, value.month, value.day) * DAY +
    BigInt(value.hour * 3600 + value.minute * 60 + value.second)
  );
}
function roundedRatio(numerator: bigint, denominator: bigint): bigint {
  const lower = numerator / denominator,
    remainder = numerator % denominator;
  return remainder * 2n > denominator || (remainder * 2n === denominator && lower % 2n !== 0n)
    ? lower + 1n
    : lower;
}
/** One correctly-rounded division of exact integer microseconds, without premature bigint conversion. */
function binary64Ratio(numerator: bigint, denominator: bigint): number {
  if (numerator === 0n) return 0;
  const sign = numerator < 0n ? -1 : 1,
    magnitude = numerator < 0n ? -numerator : numerator;
  let exponent = magnitude.toString(2).length - denominator.toString(2).length;
  if (
    exponent >= 0
      ? magnitude < denominator << BigInt(exponent)
      : magnitude << BigInt(-exponent) < denominator
  )
    exponent--;
  const shift = 52 - exponent;
  const mantissa =
    shift >= 0
      ? roundedRatio(magnitude << BigInt(shift), denominator)
      : roundedRatio(magnitude, denominator << BigInt(-shift));
  return sign * Number(mantissa) * 2 ** (exponent - 52);
}
function roundTwo(value: number): number {
  if (value === 0) return value;
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, Math.abs(value), false);
  const bits = view.getBigUint64(0, false),
    exponent = Number((bits >> 52n) & 0x7ffn) - 1023 - 52;
  const mantissa = (bits & ((1n << 52n) - 1n)) | (1n << 52n);
  const numerator = exponent >= 0 ? (mantissa << BigInt(exponent)) * 100n : mantissa * 100n;
  const denominator = exponent >= 0 ? 1n : 1n << BigInt(-exponent);
  const hundredths = roundedRatio(numerator, denominator);
  return value < 0 ? -binary64Ratio(hundredths, 100n) : binary64Ratio(hundredths, 100n);
}
export function rendererSecondsBetween(
  selectedProfile: string,
  first: string | null,
  second: string | null
): JsonNumber | null {
  profile(selectedProfile);
  if (!first || !second) return null;
  const a = parseRendererTimestamp(selectedProfile, 'duration', first),
    b = parseRendererTimestamp(selectedProfile, 'duration', second);
  if (!a || !b || (a.offsetMicroseconds === null) !== (b.offsetMicroseconds === null)) return null;
  const difference =
    (wallSeconds(b) - wallSeconds(a)) * SECOND +
    BigInt(b.microsecond - a.microsecond) -
    ((b.offsetMicroseconds ?? 0n) - (a.offsetMicroseconds ?? 0n));
  return renderFloat(roundTwo(binary64Ratio(difference, SECOND)));
}
type Row = Record<string, unknown>;
function calendarArray(value: unknown, category: 'request' | 'reply'): value is readonly unknown[] {
  try {
    return Array.isArray(value);
  } catch {
    throw new RendererCalendarContractError(category, 'Unreadable calendar array');
  }
}
function calendarItems(value: readonly unknown[], category: 'request' | 'reply'): unknown[] {
  let descriptors: Record<string, PropertyDescriptor>;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw new RendererCalendarContractError(category, 'Unreadable calendar array');
  }
  const length: unknown = descriptors.length?.value;
  if (
    typeof length !== 'number' ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    Object.keys(descriptors).length !== length + 1
  )
    throw new RendererCalendarContractError(category, 'Calendar array requires dense data');
  const items: unknown[] = [];
  for (let index = 0; index < length; index++) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.hasOwn(descriptor, 'value'))
      throw new RendererCalendarContractError(category, 'Calendar array requires dense data');
    items.push(descriptor.value);
  }
  return items;
}
function record(value: unknown, keys: readonly string[], category: 'request' | 'reply'): Row {
  if (!value || typeof value !== 'object')
    throw new RendererCalendarContractError(category, 'Calendar record required');
  let array: boolean;
  try {
    array = Array.isArray(value);
  } catch {
    throw new RendererCalendarContractError(category, 'Unreadable calendar record');
  }
  if (array) throw new RendererCalendarContractError(category, 'Calendar record required');
  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw new RendererCalendarContractError(category, 'Unreadable calendar record');
  }
  if (
    Object.keys(descriptors).length !== keys.length ||
    keys.some(
      (key) => !Object.hasOwn(descriptors, key) || !Object.hasOwn(descriptors[key]!, 'value')
    )
  )
    throw new RendererCalendarContractError(category, 'Calendar keys or accessors');
  return Object.fromEntries(keys.map((key) => [key, descriptors[key]!.value]));
}
function environment(value: unknown, category: 'request' | 'reply'): EnvironmentValue {
  let hasValue: boolean;
  try {
    hasValue = value !== null && typeof value === 'object' && Object.hasOwn(value, 'value');
  } catch {
    throw new RendererCalendarContractError(category, 'Unreadable timezone environment');
  }
  const tag = record(value, hasValue ? ['kind', 'value'] : ['kind'], category);
  if (tag.kind === 'absent' && !Object.hasOwn(tag, 'value'))
    return Object.freeze({ kind: 'absent' });
  if (tag.kind === 'present' && typeof tag.value === 'string' && !tag.value.includes('\0'))
    return Object.freeze({ kind: 'present', value: tag.value });
  throw new RendererCalendarContractError(category, 'Invalid original timezone environment');
}
function context(value: unknown, category: 'request' | 'reply'): RendererCalendarContext {
  const row = record(value, ['originalPid', 'tz', 'tzdir'], category);
  if (
    !Number.isSafeInteger(row.originalPid) ||
    (row.originalPid as number) <= 1 ||
    (row.originalPid as number) > 2 ** 31 - 1
  )
    throw new RendererCalendarContractError(category, 'Invalid original PID');
  return Object.freeze({
    originalPid: row.originalPid as number,
    tz: environment(row.tz, category),
    tzdir: environment(row.tzdir, category),
  });
}
type LocalResult = bigint | RendererCalendarReferenceError;
function localResult(value: unknown, seconds: string): LocalResult {
  let fields: PropertyDescriptorMap;
  try {
    fields = value && typeof value === 'object' ? Object.getOwnPropertyDescriptors(value) : {};
  } catch {
    throw new RendererCalendarContractError('reply', 'Unreadable local calendar result');
  }
  const kind = fields.kind?.value;
  const row = record(
    value,
    kind === 'os_error'
      ? ['kind', 'seconds', 'errno', 'message']
      : ['kind', 'seconds', 'tmYear', 'tmMon', 'tmMday', 'tmHour', 'tmMin', 'tmSec'],
    'reply'
  );
  if (row.seconds !== seconds)
    throw new RendererCalendarContractError('reply', 'Mismatched local calendar seconds');
  if (kind === 'os_error') {
    if (
      !Number.isInteger(row.errno) ||
      (row.errno as number) <= 0 ||
      (row.errno as number) > 2 ** 31 - 1 ||
      typeof row.message !== 'string' ||
      Buffer.byteLength(row.message) > 128 ||
      row.message.includes('\0')
    )
      throw new RendererCalendarContractError('reply', 'Malformed local OS error');
    return new RendererCalendarReferenceError('OSError', row.message, row.errno as number);
  }
  if (
    kind !== 'local_calendar' ||
    ['tmYear', 'tmMon', 'tmMday', 'tmHour', 'tmMin', 'tmSec'].some(
      (key) =>
        !Number.isInteger(row[key]) ||
        (row[key] as number) < -(2 ** 31) ||
        (row[key] as number) > 2 ** 31 - 1
    )
  )
    throw new RendererCalendarContractError('reply', 'Malformed raw local calendar');
  const year = (row.tmYear as number) + 1900;
  if (year < 1 || year > 9999)
    return new RendererCalendarReferenceError('ValueError', `year ${year} is out of range`);
  const month = (row.tmMon as number) + 1,
    day = row.tmMday as number,
    hour = row.tmHour as number,
    minute = row.tmMin as number,
    second = row.tmSec as number;
  if (
    !checkedDate(year, month, day) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59 ||
    second < 0 ||
    second > 61
  )
    throw new RendererCalendarContractError('reply', 'Invalid raw local calendar fields');
  return ordinal(year, month, day) * DAY + BigInt(hour * 3600 + minute * 60 + second);
}
/** PEP495 local inversion; fromisoformat/strptime construct fold=0. Yields POSIX seconds. */
function* localEpoch(value: ParsedRendererTimestamp): Generator<bigint, number, bigint> {
  const t = wallSeconds(value);
  const a = (yield t - EPOCH) - t;
  const u1 = t - a,
    t1 = yield u1 - EPOCH;
  let b: bigint;
  if (t1 === t) {
    const u2 = u1 - DAY;
    b = (yield u2 - EPOCH) - u2;
    if (a === b) return Number(u1 - EPOCH) + value.microsecond / 1e6;
  } else b = t1 - u1;
  const u2 = t - b,
    t2 = yield u2 - EPOCH;
  const chosen = t2 === t ? u2 : t1 === t ? u1 : u1 > u2 ? u1 : u2;
  return Number(chosen - EPOCH) + value.microsecond / 1e6;
}
export interface ResolveRendererCalendarOptions {
  readonly profile: typeof RENDERER_CALENDAR_PROFILE;
  readonly id: string;
  readonly runtimeDigest: string;
  readonly token: string;
  readonly context: RendererCalendarContext;
  /** Exactly the normalized timestamps that the selected renderer will use. */
  readonly timestamps: readonly (string | null)[];
  /** False when auxiliary input is empty: the source never evaluates sort keys then. */
  readonly sortEpochs: boolean;
  readonly maximumTimestampBytes: number;
  readonly maximumQueries: number;
  readonly port: RendererLocalCalendarPort;
  readonly signal: AbortSignal;
  readonly deadlineEpochMs: number;
}
export interface ResolvedRendererCalendar extends RendererCalendarPort {
  readonly context: RendererCalendarContext;
}
function active(signal: AbortSignal, deadline: number): void {
  if (signal.aborted)
    throw new RendererCalendarContractError('cancelled', 'Calendar resolution cancelled');
  if (Date.now() >= deadline)
    throw new RendererCalendarContractError('deadline', 'Calendar resolution deadline');
}
async function boundedObservation(
  port: RendererLocalCalendarPort,
  request: LocalCalendarRequest,
  signal: AbortSignal,
  deadline: number
): Promise<unknown> {
  active(signal, deadline);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const controller = new AbortController();
  const stop = new Promise<never>((_resolve, reject) => {
    abort = () => {
      controller.abort();
      reject(new RendererCalendarContractError('cancelled', 'Calendar resolution cancelled'));
    };
    signal.addEventListener('abort', abort, { once: true });
    timer = setTimeout(
      () => {
        controller.abort();
        reject(new RendererCalendarContractError('deadline', 'Calendar resolution deadline'));
      },
      Math.min(deadline - Date.now(), 2 ** 31 - 1)
    );
  });
  try {
    const observation = Promise.resolve().then(() => {
      active(signal, deadline);
      return port.observe(request, controller.signal, deadline);
    });
    const result = await Promise.race([observation, stop]);
    active(signal, deadline);
    return result;
  } catch (error) {
    if (error instanceof RendererCalendarContractError) throw error;
    throw new RendererCalendarContractError(
      'transport',
      `Local calendar observation failed: ${String(error)}`
    );
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (abort) signal.removeEventListener('abort', abort);
  }
}
/** Resolution owns no renderer effects. Port failures reject; reference OS errors surface at exact use. */
export async function resolveRendererCalendar(
  options: ResolveRendererCalendarOptions
): Promise<ResolvedRendererCalendar> {
  profile(options.profile);
  const { id, runtimeDigest, token, signal, deadlineEpochMs } = options;
  if (
    typeof id !== 'string' ||
    !/^[A-Za-z0-9._:-]{1,256}(?![\s\S])/.test(id) ||
    typeof runtimeDigest !== 'string' ||
    !/^[a-f0-9]{64}(?![\s\S])/.test(runtimeDigest) ||
    typeof token !== 'string' ||
    !/^[A-Za-z0-9._:-]{1,128}(?![\s\S])/.test(token) ||
    typeof options.sortEpochs !== 'boolean' ||
    !Number.isSafeInteger(options.maximumQueries) ||
    options.maximumQueries < 1 ||
    options.maximumQueries > MAX_LOCAL_CALENDAR_QUERIES ||
    !Number.isSafeInteger(options.maximumTimestampBytes) ||
    options.maximumTimestampBytes < 0 ||
    !Number.isSafeInteger(deadlineEpochMs) ||
    !calendarArray(options.timestamps, 'request') ||
    typeof options.port?.observe !== 'function'
  )
    throw new RendererCalendarContractError('request', 'Invalid calendar resolution input');
  const original = context(options.context, 'request');
  const port = Object.freeze({ observe: options.port.observe.bind(options.port) });
  const maximumQueries = options.maximumQueries,
    sortEpochs = options.sortEpochs;
  let totalBytes = 0;
  const timestamps = new Set<string | null>();
  for (const timestamp of calendarItems(options.timestamps, 'request')) {
    if (timestamp !== null && typeof timestamp !== 'string')
      throw new RendererCalendarContractError(
        'request',
        'Timestamp catalog requires normalized text'
      );
    totalBytes += timestamp === null ? 0 : Buffer.byteLength(timestamp);
    if (totalBytes > options.maximumTimestampBytes)
      throw new RendererCalendarContractError(
        'request',
        'Timestamp catalog exceeds caller byte frontier'
      );
    timestamps.add(timestamp);
  }
  active(signal, deadlineEpochMs);
  const epochs = new Map<string | null, number | null | RendererCalendarReferenceError>();
  const pending = new Map<
    string,
    { generator: Generator<bigint, number, bigint>; seconds: bigint }
  >();
  for (const timestamp of timestamps) {
    if (!sortEpochs) continue;
    const parsed = parseRendererTimestamp(options.profile, 'epoch', timestamp);
    if (!parsed) epochs.set(timestamp, null);
    else if (parsed.offsetMicroseconds !== null)
      epochs.set(
        timestamp,
        binary64Ratio(
          (wallSeconds(parsed) - EPOCH) * SECOND +
            BigInt(parsed.microsecond) -
            parsed.offsetMicroseconds,
          SECOND
        )
      );
    else {
      const generator = localEpoch(parsed),
        next = generator.next();
      if (next.done)
        throw new RendererCalendarContractError(
          'request',
          'Local inversion requires its original observation'
        );
      pending.set(timestamp!, { generator, seconds: next.value });
    }
  }
  const cache = new Map<string, LocalResult>();
  let sequence = 0,
    queryCount = 0;
  while (pending.size) {
    active(signal, deadlineEpochMs);
    const needed = [...new Set([...pending.values()].map((job) => job.seconds.toString()))].filter(
      (second) => !cache.has(second)
    );
    if (queryCount + needed.length > maximumQueries)
      throw new RendererCalendarContractError('query_limit', 'Calendar query frontier exceeded');
    for (let offset = 0; offset < needed.length; offset += MAX_LOCAL_CALENDAR_BATCH) {
      const seconds = Object.freeze(needed.slice(offset, offset + MAX_LOCAL_CALENDAR_BATCH));
      if (seconds.some((s) => BigInt(s) < MIN_I64 || BigInt(s) > MAX_I64))
        throw new RendererCalendarReferenceError(
          'OverflowError',
          'timestamp out of range for platform time_t'
        );
      if (sequence >= 2 ** 32 - 1)
        throw new RendererCalendarContractError(
          'query_limit',
          'Calendar sequence frontier exceeded'
        );
      const request = Object.freeze({
        schema: LOCAL_CALENDAR_REQUEST,
        profile: RENDERER_CALENDAR_PROFILE,
        id,
        runtimeDigest,
        token,
        sequence: ++sequence,
        seconds,
      });
      const reply = record(
        await boundedObservation(port, request, signal, deadlineEpochMs),
        ['schema', 'profile', 'id', 'runtimeDigest', 'token', 'sequence', 'context', 'results'],
        'reply'
      );
      if (
        reply.schema !== LOCAL_CALENDAR_REPLY ||
        reply.profile !== RENDERER_CALENDAR_PROFILE ||
        reply.id !== id ||
        reply.runtimeDigest !== runtimeDigest ||
        reply.token !== token ||
        reply.sequence !== sequence ||
        JSON.stringify(context(reply.context, 'reply')) !== JSON.stringify(original) ||
        !calendarArray(reply.results, 'reply')
      )
        throw new RendererCalendarContractError(
          'reply',
          'Local calendar correlation or original environment mismatch'
        );
      const results = calendarItems(reply.results, 'reply');
      if (results.length !== seconds.length)
        throw new RendererCalendarContractError('reply', 'Local calendar result count mismatch');
      seconds.forEach((second, index) => cache.set(second, localResult(results[index], second)));
      queryCount += seconds.length;
    }
    for (const [timestamp, job] of pending) {
      const result = cache.get(job.seconds.toString());
      if (result === undefined)
        throw new RendererCalendarContractError('reply', 'Missing local calendar result');
      if (result instanceof RendererCalendarReferenceError) {
        epochs.set(timestamp, result.referenceType === 'ValueError' ? null : result);
        pending.delete(timestamp);
        continue;
      }
      const next = job.generator.next(result);
      if (next.done) {
        epochs.set(timestamp, next.value);
        pending.delete(timestamp);
      } else job.seconds = next.value;
    }
  }
  const known = (timestamp: string | null): void => {
    if (!timestamps.has(timestamp))
      throw new RendererCalendarContractError(
        'unresolved',
        'Timestamp was not in the immutable calendar catalog'
      );
  };
  return Object.freeze({
    profileId: RENDERER_CALENDAR_PROFILE,
    timezone: JSON.stringify(original),
    context: original,
    epochSeconds(timestamp: string | null): number | null {
      known(timestamp);
      if (!sortEpochs || !epochs.has(timestamp))
        throw new RendererCalendarContractError('unresolved', 'Epoch sorting was not resolved');
      const value = epochs.get(timestamp)!;
      if (value instanceof RendererCalendarReferenceError) throw value;
      return value;
    },
    secondsBetween(first: string | null, second: string | null): JsonNumber | null {
      if (first !== null) known(first);
      if (second !== null) known(second);
      return rendererSecondsBetween(RENDERER_CALENDAR_PROFILE, first, second);
    },
  });
}
