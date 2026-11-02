/**
 * Python-literal text can contain adjacent surrogate codepoints independently of
 * an astral codepoint. A JavaScript string cannot retain that distinction.
 * This value keeps the interpreted codepoints and their interpretation profile.
 */
declare const codepointTextBrand: unique symbol;
export type CodepointText = Readonly<{
  kind: 'codepoint_text';
  profileId: string;
  codepoints: readonly number[];
  [codepointTextBrand]: true;
}>;

const instances = new WeakSet<object>();

export function isCodepointText(value: unknown): value is CodepointText {
  return value !== null && typeof value === 'object' && instances.has(value);
}

export function codepointText(points: readonly number[], profileId: string): CodepointText {
  if (typeof profileId !== 'string' || profileId.length === 0)
    throw new TypeError('Codepoint text requires a nonempty interpretation profile');
  if (!Array.isArray(points)) throw new TypeError('Codepoints must be an array');
  const copy: number[] = [];
  for (const point of points) {
    if (!Number.isInteger(point) || point < 0 || point > 0x10ffff)
      throw new RangeError('Codepoints must be integers from 0 through 0x10ffff');
    copy.push(point);
  }
  const value = Object.freeze({
    kind: 'codepoint_text' as const,
    profileId,
    codepoints: Object.freeze(copy),
  }) as CodepointText;
  instances.add(value);
  return value;
}

/** Interpret an existing JS string: valid UTF-16 pairs denote astral codepoints. */
export function codepointTextFromString(value: string, profileId: string): CodepointText {
  if (typeof value !== 'string') throw new TypeError('Expected a JavaScript string');
  return codepointText(
    Array.from(value, (character) => character.codePointAt(0)!),
    profileId
  );
}

function checked(value: CodepointText): CodepointText {
  if (!isCodepointText(value)) throw new TypeError('Expected a constructed CodepointText');
  return value;
}

function compatible(a: CodepointText, b: CodepointText): void {
  checked(a);
  checked(b);
  if (a.profileId !== b.profileId)
    throw new RangeError('Cannot compare codepoint texts with different interpretation profiles');
}

export function textLength(value: CodepointText): number {
  return checked(value).codepoints.length;
}

function sliceIndex(index: number, length: number): number {
  if (!Number.isSafeInteger(index)) throw new RangeError('Slice indexes must be safe integers');
  return index < 0 ? Math.max(0, length + index) : Math.min(length, index);
}

/** Python's contiguous [start:end] slicing, including negative indexes and clamping. */
export function textSlice(value: CodepointText, start = 0, end?: number): CodepointText {
  const { codepoints, profileId } = checked(value);
  return codepointText(
    codepoints.slice(
      sliceIndex(start, codepoints.length),
      sliceIndex(end === undefined ? codepoints.length : end, codepoints.length)
    ),
    profileId
  );
}

export function textEqual(a: CodepointText, b: CodepointText): boolean {
  compatible(a, b);
  return (
    a.codepoints.length === b.codepoints.length &&
    a.codepoints.every((point, index) => point === b.codepoints[index])
  );
}

/** Lexicographic codepoint order, independent of JavaScript's UTF-16 ordering. */
export function textOrder(a: CodepointText, b: CodepointText): -1 | 0 | 1 {
  compatible(a, b);
  for (let index = 0; index < Math.min(a.codepoints.length, b.codepoints.length); index++) {
    const left = a.codepoints[index]!,
      right = b.codepoints[index]!;
    if (left !== right) return left < right ? -1 : 1;
  }
  return a.codepoints.length === b.codepoints.length
    ? 0
    : a.codepoints.length < b.codepoints.length
      ? -1
      : 1;
}

export type JsStringLosslessResult =
  | Readonly<{ ok: true; value: string }>
  | Readonly<{ ok: false; reason: 'adjacentSurrogateCollapse'; index: number; codepoint: number }>;

export function toJsStringLossless(value: CodepointText): JsStringLosslessResult {
  const { codepoints } = checked(value);
  let result = '';
  for (let index = 0; index < codepoints.length; index++) {
    const point = codepoints[index]!;
    const next = codepoints[index + 1];
    if (
      point >= 0xd800 &&
      point <= 0xdbff &&
      next !== undefined &&
      next >= 0xdc00 &&
      next <= 0xdfff
    )
      return { ok: false, reason: 'adjacentSurrogateCollapse', index, codepoint: point };
    result += String.fromCodePoint(point);
  }
  return { ok: true, value: result };
}

export type Utf8StrictResult =
  | Readonly<{ ok: true; value: Uint8Array }>
  | Readonly<{ ok: false; reason: 'unencodableSurrogate'; index: number; codepoint: number }>;

/** Strict Unicode UTF-8 encoding; surrogate codepoints never become replacement bytes. */
export function encodeUtf8Strict(value: CodepointText): Utf8StrictResult {
  const { codepoints } = checked(value);
  let result = '';
  for (let index = 0; index < codepoints.length; index++) {
    const point = codepoints[index]!;
    if (point >= 0xd800 && point <= 0xdfff)
      return { ok: false, reason: 'unencodableSurrogate', index, codepoint: point };
    result += String.fromCodePoint(point);
  }
  return { ok: true, value: Buffer.from(result, 'utf8') };
}

const SHORT_ESCAPES: Readonly<Record<number, string>> = Object.freeze({
  8: '\\b',
  9: '\\t',
  10: '\\n',
  12: '\\f',
  13: '\\r',
  34: '\\"',
  92: '\\\\',
});
function escapeUnit(point: number): string {
  return '\\u' + point.toString(16).padStart(4, '0');
}

/**
 * Explicit JSON projection. Surrogate codepoints are always escaped, including
 * when ensureAscii is false. With ensureAscii=true, an astral codepoint and its
 * two surrogate codepoints have identical JSON spelling; this is not a custody
 * encoding and a JSON decoder may coalesce the escapes.
 */
export function quoteCodepointJson(value: CodepointText, ensureAscii = true): string {
  checked(value);
  if (typeof ensureAscii !== 'boolean') throw new TypeError('ensureAscii must be boolean');
  let result = '"';
  for (const point of value.codepoints) {
    if (SHORT_ESCAPES[point] !== undefined) result += SHORT_ESCAPES[point];
    else if (
      point < 0x20 ||
      (point >= 0xd800 && point <= 0xdfff) ||
      (ensureAscii && point >= 0x7f)
    ) {
      if (point <= 0xffff) result += escapeUnit(point);
      else {
        const scalar = point - 0x10000;
        result += escapeUnit(0xd800 + (scalar >> 10)) + escapeUnit(0xdc00 + (scalar & 0x3ff));
      }
    } else result += String.fromCodePoint(point);
  }
  return result + '"';
}
