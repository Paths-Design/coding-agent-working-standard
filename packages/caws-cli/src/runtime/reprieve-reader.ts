import * as fs from 'node:fs';
import * as path from 'node:path';

const DAY_MICROS = 86_400_000_000n;
const asciiDigits = (value: string): boolean =>
  value.length > 0 && [...value].every((char) => char >= '0' && char <= '9');
const utf8 = (value: string): boolean => Buffer.from(value, 'utf8').toString('utf8') === value;
// Match the consumed UTF-8/surrogateescape stdout profile. Low escaped bytes
// retain their identity; other unpaired surrogates cannot be emitted.
function pythonOutput(value: string): Buffer | undefined {
  const chunks: Buffer[] = [];
  let text = '';
  const flush = (): void => {
    if (text) {
      chunks.push(Buffer.from(text, 'utf8'));
      text = '';
    }
  };
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return;
      text += value[index]! + value[++index]!;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      if (code < 0xdc80 || code > 0xdcff) return;
      flush();
      chunks.push(Buffer.from([code - 0xdc00]));
    } else text += value[index]!;
  }
  flush();
  return Buffer.concat(chunks);
}
const leap = (year: number): boolean => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
function beforeYear(year: number): number {
  const previous = year - 1;
  return (
    365 * previous +
    Math.floor(previous / 4) -
    Math.floor(previous / 100) +
    Math.floor(previous / 400)
  );
}
function ordinal(year: number, month: number, day: number): number | undefined {
  const months = [31, leap(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 || day > months[month - 1]!)
    return;
  return (
    beforeYear(year) + months.slice(0, month - 1).reduce((total, count) => total + count, 0) + day
  );
}
function dateOrdinal(value: string): number | undefined {
  const calendar = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) ?? /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (calendar && calendar[0] === value)
    return ordinal(Number(calendar[1]), Number(calendar[2]), Number(calendar[3]));
  const week = /^(\d{4})-W(\d{2})(?:-(\d))?$/.exec(value) ?? /^(\d{4})W(\d{2})(\d)?$/.exec(value);
  if (!week || week[0] !== value) return;
  const year = Number(week[1]),
    number = Number(week[2]),
    weekday = Number(week[3] ?? 1);
  if (year < 1 || year > 9999 || number < 1 || number > 53 || weekday < 1 || weekday > 7) return;
  const january1 = beforeYear(year) + 1;
  const january1Weekday = (january1 - 1) % 7;
  if (number === 53 && january1Weekday !== 3 && !(january1Weekday === 2 && leap(year))) return;
  const january4 = january1 + 3;
  const result = january4 - ((january4 - 1) % 7) + (number - 1) * 7 + weekday - 1;
  return result >= 1 && result <= beforeYear(10000) ? result : undefined;
}

// Python 3.11's ISO parser also accepts reduced/basic/week dates and any
// single-codepoint datetime separator. Resolve its week-date ambiguity before
// parsing the date and time independently; a restrictive RFC3339 regex loses grants.
function dateEnd(chars: readonly string[]): number {
  if (chars.length === 7) return 7;
  if (chars[4] === '-') {
    if (chars[5] !== 'W') return 10;
    if (chars[8] !== '-') return 8;
    return chars.length > 10 && asciiDigits(chars[10]!) ? 8 : 10;
  }
  if (chars[4] !== 'W') return 8;
  let index = 7;
  while (index < chars.length && asciiDigits(chars[index]!)) index++;
  return index < 9 ? index : index % 2 === 0 ? 7 : 8;
}
type ClockParts = readonly [number, number, number, number];
function clockParts(
  bytes: Buffer,
  start: number,
  end: number
): { parts: ClockParts; terminal: boolean } | undefined {
  const parts: [number, number, number, number] = [0, 0, 0, 0];
  let cursor = start,
    separated = true;
  const at = (index: number): number => bytes[index] ?? 0;
  const digit = (byte: number): boolean => byte >= 48 && byte <= 57;
  for (let component = 0; component < 3; component++) {
    if (!digit(at(cursor)) || !digit(at(cursor + 1))) return;
    parts[component] = (at(cursor) - 48) * 10 + at(cursor + 1) - 48;
    cursor += 2;
    const next = at(cursor++);
    if (component === 0) separated = next === 58;
    // The consumed C parser tests its end pointer before separator validity.
    // A single trailing byte before a timezone therefore remains accepted.
    if (cursor >= end) return { parts, terminal: next === 0 };
    if (separated && next === 58) continue;
    if (next === 46 || next === 44) break;
    if (!separated) cursor--;
    else return;
  }
  const count = Math.min(6, end - cursor);
  if (count <= 0) return;
  let fraction = 0;
  for (let index = 0; index < count; index++) {
    const byte = at(cursor++);
    if (!digit(byte)) return;
    fraction = fraction * 10 + byte - 48;
  }
  parts[3] = fraction * 10 ** (6 - count);
  while (digit(at(cursor))) cursor++;
  return { parts, terminal: at(cursor) === 0 };
}

/** Consumed Python-reader expiry semantics, as exact UTC Unix microseconds.
 * Naive values mean UTC; fractions truncate after six digits. This parses data,
 * never supplies time authority or activates a grant. Invalid input is absent. */
export function parseReprieveExpiry(value: unknown): bigint | undefined {
  if (typeof value !== 'string' || !value || pythonOutput(value) === undefined) return;
  const chars = [...value.replaceAll('Z', '+00:00')];
  if (chars.length < 7) return;
  const end = dateEnd(chars);
  if (
    chars.some((char, index) => {
      const point = char.codePointAt(0)!;
      return point >= 0xd800 && point <= 0xdfff && index !== end;
    })
  )
    return;
  const day = dateOrdinal(chars.slice(0, end).join(''));
  if (day === undefined) return;
  if (chars.length === end) return BigInt(day - 719163) * DAY_MICROS;
  const time = chars.slice(end + 1).join('');
  if (!time) return;
  const bytes = Buffer.from(time, 'utf8');
  const offsetAt = bytes.findIndex((byte) => byte === 43 || byte === 45);
  const parsed = clockParts(bytes, 0, offsetAt < 0 ? bytes.length : offsetAt);
  if (!parsed || (offsetAt < 0 && !parsed.terminal)) return;
  const main = parsed.parts;
  if (main[0] > 23 || main[1] > 59 || main[2] > 59) return;
  let offset = 0n;
  if (offsetAt >= 0) {
    const parsedZone = clockParts(bytes, offsetAt + 1, bytes.length);
    if (!parsedZone || !parsedZone.terminal) return;
    const zone = parsedZone.parts;
    const whole = zone[0] * 3600 + zone[1] * 60 + zone[2];
    // The consumed CPython reader normalizes offset components, but treats a
    // zero whole-second offset as UTC even when its fraction is nonzero.
    offset = whole === 0 ? 0n : BigInt(whole) * 1_000_000n + BigInt(zone[3]);
    if (offset >= DAY_MICROS) return;
    if (bytes[offsetAt] === 45) offset = -offset;
  }
  return (
    BigInt(day - 719163) * DAY_MICROS +
    BigInt(main[0] * 3600 + main[1] * 60 + main[2]) * 1_000_000n +
    BigInt(main[3]) -
    offset
  );
}

function lexicalRecordPath(value: string): string {
  const prefix =
    value.startsWith('//') && !value.startsWith('///') ? '//' : value.startsWith('/') ? '/' : '';
  return (
    prefix +
      value
        .split('/')
        .filter((part) => part && part !== '.')
        .join('/') || '.'
  );
}
function unredirectedRecord(value: string): boolean {
  let cursor = lexicalRecordPath(value);
  for (let level = 0; level <= 4; level++) {
    if (fs.lstatSync(cursor).isSymbolicLink()) return false;
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return true;
}
function joinRaw(base: string, rest: string): string {
  return rest.startsWith('/') ? rest : base + (base.endsWith('/') ? '' : '/') + rest;
}
/** Non-strict realpath retains missing tails, like os.path.realpath. */
function legacyRealpath(value: string): string {
  if (!utf8(value) || value.includes('\0')) throw new Error('Unsupported path encoding');
  const seen = new Map<string, string | undefined>();
  const resolve = (base: string, rest: string): readonly [string, boolean] => {
    if (rest.startsWith('/')) {
      base = '/';
      rest = rest.slice(1);
    }
    const parts = rest.split('/');
    for (let index = 0; index < parts.length; index++) {
      const name = parts[index]!;
      if (!name || name === '.') continue;
      if (name === '..') {
        base = path.dirname(base);
        continue;
      }
      const next = path.join(base, name);
      let link = false;
      try {
        link = fs.lstatSync(next).isSymbolicLink();
      } catch {
        /* Non-strict lookup keeps unresolved components. */
      }
      if (!link) {
        base = next;
        continue;
      }
      const remaining = parts.slice(index + 1).join('/');
      if (seen.has(next)) {
        const known = seen.get(next);
        if (known === undefined) return [joinRaw(next, remaining), false];
        base = known;
        continue;
      }
      seen.set(next, undefined);
      const rawTarget = fs.readlinkSync(next, { encoding: 'buffer' });
      const linkTarget = rawTarget.toString('utf8');
      if (!Buffer.from(linkTarget, 'utf8').equals(rawTarget))
        throw new Error('Unsupported link encoding');
      const [target, complete] = resolve(base, linkTarget);
      if (!complete) return [joinRaw(target, remaining), false];
      seen.set(next, target);
      base = target;
    }
    return [base, true];
  };
  let base = '/';
  if (!value.startsWith('/')) {
    const rawCwd = fs.realpathSync.native('.', { encoding: 'buffer' });
    base = rawCwd.toString('utf8');
    if (!Buffer.from(base, 'utf8').equals(rawCwd)) throw new Error('Unsupported cwd encoding');
  }
  return path.resolve(resolve(base, value)[0]);
}

// Python json.load accepts these numeric constants. Preserve their non-string
// type (including for malformed repo_root), rather than converting them to null.
function pythonJson(value: string): unknown {
  let result = '',
    quoted = false,
    escaped = false;
  for (let index = 0; index < value.length; index++) {
    const char = value[index]!;
    if (quoted) {
      result += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') {
      quoted = true;
      result += char;
      continue;
    }
    const token = ['-Infinity', 'Infinity', 'NaN'].find((word) => value.startsWith(word, index));
    const boundary = (text: string | undefined): boolean =>
      text === undefined || ' \t\r\n,:[]{}'.includes(text);
    if (token && boundary(value[index - 1]) && boundary(value[index + token.length])) {
      result += '1e999';
      index += token.length - 1;
    } else result += char;
  }
  return JSON.parse(result);
}

export interface ReprieveMatch {
  readonly expiresAt: string;
  readonly reason: string;
}
/** Exact consumed output bytes; undefined cannot authorize a skip. */
export function serializeReprieveMatch(match: ReprieveMatch): Buffer | undefined {
  return pythonOutput(`ADMIT\t${match.expiresAt}\t${match.reason}\n`);
}
/** Read only; every failure leaves the guard running. now is a core-test seam. */
export function readReprieve(
  recordPath: string,
  handler: string,
  sessionId: string,
  canonicalRepoRoot: string,
  now: () => number = Date.now
): ReprieveMatch | undefined {
  try {
    if (
      !sessionId ||
      sessionId === 'unknown' ||
      !utf8(recordPath) ||
      !utf8(handler) ||
      !utf8(sessionId) ||
      !utf8(canonicalRepoRoot) ||
      !unredirectedRecord(recordPath)
    )
      return;
    const bytes = fs.readFileSync(recordPath);
    const text = bytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(bytes)) return;
    const value = pythonJson(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const record = value as Record<string, unknown>;
    if (record.session_id !== sessionId || Object.hasOwn(record, 'revoked_at')) return;
    if (
      ['created_at', 'approved_by', 'reason'].some(
        (key) => typeof record[key] !== 'string' || !record[key]
      )
    )
      return;
    const expiresAt = record.expires_at;
    const expires = parseReprieveExpiry(expiresAt);
    if (typeof expiresAt !== 'string' || expires === undefined) return;
    if (
      !Array.isArray(record.handlers) ||
      record.handlers.some((entry) => typeof entry !== 'string') ||
      !record.handlers.includes(handler)
    )
      return;
    if (record.repo_root !== undefined && record.repo_root !== null) {
      if (
        typeof record.repo_root !== 'string' ||
        !record.repo_root ||
        legacyRealpath(record.repo_root) !== legacyRealpath(canonicalRepoRoot)
      )
        return;
    }
    const reason = record.reason as string;
    const match = { expiresAt, reason };
    if (serializeReprieveMatch(match) === undefined) return;
    // Sample after scope lookups and output validation. Reserve the current
    // millisecond so an already-expired submillisecond value cannot admit at
    // this sample; a valid final fraction below 1ms may be declined early.
    const milliseconds = now();
    if (!Number.isSafeInteger(milliseconds)) return;
    if (expires < (BigInt(milliseconds) + 1n) * 1000n) return;
    return match;
  } catch {
    return;
  }
}
