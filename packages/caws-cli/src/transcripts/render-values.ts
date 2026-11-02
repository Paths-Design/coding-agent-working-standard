/** Renderer values retain source JSON numbers and interpreted Python codepoints. */
import {
  type CodepointText,
  codepointText,
  codepointTextFromString,
  isCodepointText,
  quoteCodepointJson,
  textEqual,
  textOrder,
  textSlice,
} from './codepoint-text';
import {
  type JsonNumber,
  type JsonObject,
  type JsonValue,
  isJsonNumber,
  isJsonObject,
  jsonNumber,
  pythonEqual,
  pythonJsonDumps,
} from './lossless-json';
import {
  admitTranscriptJsonNumber,
  snapshotTranscriptJsonProfile,
  type TranscriptJsonNumericProfile,
} from './transcript-json-profile';

export type RenderText = string | CodepointText;
export type RenderKey = RenderText;
export type RenderObject = Readonly<{
  kind: 'render_object';
  entries: readonly (readonly [RenderKey, RenderValue])[];
}>;
export type RenderValue = JsonValue | CodepointText | readonly RenderValue[] | RenderObject;
export type RenderNumeric = boolean | JsonNumber;

export function isRenderText(value: unknown): value is RenderText {
  return typeof value === 'string' || isCodepointText(value);
}
function points(value: RenderText, profile?: string): CodepointText {
  return typeof value === 'string'
    ? codepointTextFromString(value, profile ?? 'renderer-js-text')
    : value;
}
/** Preserve newly adjacent surrogate codepoints when a text operation removes
 * their former boundary. A JS string would reinterpret them as one scalar. */
function restoreText(source: RenderText, codepoints: readonly number[]): RenderText {
  const text = points(source);
  const adjacentSurrogates = codepoints.some(
    (p, i) =>
      p >= 0xd800 &&
      p <= 0xdbff &&
      codepoints[i + 1] !== undefined &&
      codepoints[i + 1]! >= 0xdc00 &&
      codepoints[i + 1]! <= 0xdfff
  );
  return typeof source === 'string' && !adjacentSurrogates
    ? codepoints.map((p) => String.fromCodePoint(p)).join('')
    : codepointText(codepoints, text.profileId);
}
function pair(a: RenderText, b: RenderText): readonly [CodepointText, CodepointText] {
  const profile = isCodepointText(a) ? a.profileId : isCodepointText(b) ? b.profileId : undefined;
  return [points(a, profile), points(b, profile)];
}
export function renderTextLength(value: RenderText): number {
  return points(value).codepoints.length;
}
export function renderTextSlice(value: RenderText, start = 0, end?: number): RenderText {
  const sliced = textSlice(points(value), start, end);
  return restoreText(value, sliced.codepoints);
}
export function renderTextEqual(a: RenderText, b: RenderText): boolean {
  const [left, right] = pair(a, b);
  return textEqual(left, right);
}
export function renderTextOrder(a: RenderText, b: RenderText): -1 | 0 | 1 {
  const [left, right] = pair(a, b);
  return textOrder(left, right);
}
export function renderTextStartsWith(value: RenderText, prefix: RenderText): boolean {
  return renderTextEqual(renderTextSlice(value, 0, renderTextLength(prefix)), prefix);
}
export function renderTextEndsWith(value: RenderText, suffix: RenderText): boolean {
  const length = renderTextLength(suffix);
  return length === 0 || renderTextEqual(renderTextSlice(value, -length), suffix);
}
export function renderTextContains(value: RenderText, needle: RenderText): boolean {
  const [left, right] = pair(value, needle);
  // Validate profile compatibility even for an empty needle.
  textOrder(left, right);
  outer: for (let i = 0; i <= left.codepoints.length - right.codepoints.length; i++) {
    for (let j = 0; j < right.codepoints.length; j++)
      if (left.codepoints[i + j] !== right.codepoints[j]) continue outer;
    return true;
  }
  return false;
}
export function renderTextConcat(...values: readonly RenderText[]): RenderText {
  const profile = values.find(isCodepointText)?.profileId;
  const result: number[] = [];
  for (const value of values) {
    const text = points(value, profile);
    if (profile !== undefined && text.profileId !== profile)
      throw new RangeError('Incompatible renderer text profiles');
    for (const cp of text.codepoints) result.push(cp);
  }
  return restoreText(profile === undefined ? '' : codepointText([], profile), result);
}
// Python 3.11 str.isspace / Unicode14 White_Space plus the four C0 separators.
function whitespace(p: number): boolean {
  return (
    (p >= 9 && p <= 13) ||
    (p >= 0x1c && p <= 0x20) ||
    p === 0x85 ||
    p === 0xa0 ||
    p === 0x1680 ||
    (p >= 0x2000 && p <= 0x200a) ||
    p === 0x2028 ||
    p === 0x2029 ||
    p === 0x202f ||
    p === 0x205f ||
    p === 0x3000
  );
}
export function renderTextStrip(value: RenderText): RenderText {
  const cp = points(value).codepoints;
  let start = 0,
    end = cp.length;
  while (start < end && whitespace(cp[start]!)) start++;
  while (end > start && whitespace(cp[end - 1]!)) end--;
  return renderTextSlice(value, start, end);
}
export function renderTextCompactWhitespace(value: RenderText): RenderText {
  const stripped = renderTextStrip(value),
    source = points(stripped),
    result: number[] = [];
  let space = false;
  for (const cp of source.codepoints) {
    if (whitespace(cp)) {
      if (!space) result.push(0x20);
      space = true;
    } else {
      result.push(cp);
      space = false;
    }
  }
  return restoreText(value, result);
}
export function renderTextSplitLines(value: RenderText): readonly RenderText[] {
  const cp = points(value).codepoints,
    lines: RenderText[] = [];
  let start = 0;
  for (let i = 0; i < cp.length; i++) {
    const p = cp[i]!;
    if ([10, 11, 12, 13, 0x1c, 0x1d, 0x1e, 0x85, 0x2028, 0x2029].includes(p)) {
      lines.push(renderTextSlice(value, start, i));
      if (p === 13 && cp[i + 1] === 10) i++;
      start = i + 1;
    }
  }
  if (start < cp.length) lines.push(renderTextSlice(value, start));
  return Object.freeze(lines);
}

export function isRenderObject(value: unknown): value is RenderObject {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (value as Partial<RenderObject>).kind === 'render_object' &&
    Array.isArray((value as Partial<RenderObject>).entries)
  );
}
export function renderEntries(
  value: JsonObject | RenderObject
): readonly (readonly [RenderKey, RenderValue])[] {
  return value.entries;
}
function own(value: RenderValue): RenderValue {
  if (value === null || typeof value === 'boolean' || isRenderText(value)) return value;
  if (isJsonNumber(value)) return jsonNumber(value.lexeme);
  if (Array.isArray(value)) return Object.freeze(value.map(own));
  if (isJsonObject(value) || isRenderObject(value)) return renderObject(value.entries);
  throw new TypeError('Value is outside the renderer value contract');
}
export function renderObject(
  entries: readonly (readonly [RenderKey, RenderValue])[] = []
): RenderObject {
  const result: Array<readonly [RenderKey, RenderValue]> = [];
  for (const [key, value] of entries) {
    if (!isRenderText(key)) throw new TypeError('Renderer object keys must be text');
    const index = result.findIndex(([candidate]) => renderTextEqual(candidate, key));
    const entry = Object.freeze([index < 0 ? key : result[index]![0], own(value)] as const);
    if (index < 0) result.push(entry);
    else result[index] = entry;
  }
  return Object.freeze({ kind: 'render_object', entries: Object.freeze(result) });
}
export function renderGet(value: RenderValue | undefined, key: RenderKey): RenderValue | undefined {
  return isJsonObject(value) || isRenderObject(value)
    ? value.entries.find(([candidate]) => renderTextEqual(candidate, key))?.[1]
    : undefined;
}
export function renderHas(value: RenderValue | undefined, key: RenderKey): boolean {
  return isJsonObject(value) || isRenderObject(value)
    ? value.entries.some(([candidate]) => renderTextEqual(candidate, key))
    : false;
}
export function renderSet(
  value: JsonObject | RenderObject,
  key: RenderKey,
  item: RenderValue
): RenderObject {
  return renderObject([...value.entries, [key, item]]);
}
export function renderInteger(value: bigint | number): JsonNumber {
  if (typeof value === 'number' && !Number.isSafeInteger(value))
    throw new RangeError('Generated integer must be exact');
  return jsonNumber(value.toString());
}
export function renderFloat(value: number): JsonNumber {
  if (typeof value !== 'number') throw new TypeError('Expected binary64 number');
  const spelling = Object.is(value, -0) ? '-0.0' : value.toString();
  return jsonNumber(Number.isFinite(value) && !/[.eE]/.test(spelling) ? spelling + '.0' : spelling);
}
export function renderIsNumeric(value: RenderValue | undefined): value is RenderNumeric {
  return typeof value === 'boolean' || isJsonNumber(value);
}
function numeric(value: RenderNumeric): bigint | number {
  if (typeof value === 'boolean') return value ? 1n : 0n;
  if (!isJsonNumber(value)) throw new TypeError('Expected Python numeric value');
  return value.numberKind === 'integer' ? BigInt(value.lexeme) : Number(value.lexeme);
}
function float(value: bigint | number): number {
  const result = Number(value);
  if (typeof value === 'bigint' && !Number.isFinite(result))
    throw new RangeError('Python integer too large to convert to float');
  return result;
}
function arithmetic(a: RenderNumeric, b: RenderNumeric, subtract: boolean): JsonNumber {
  const left = numeric(a),
    right = numeric(b);
  if (typeof left === 'bigint' && typeof right === 'bigint')
    return renderInteger(subtract ? left - right : left + right);
  return renderFloat(subtract ? float(left) - float(right) : float(left) + float(right));
}
export function renderAdd(a: RenderNumeric, b: RenderNumeric): JsonNumber {
  return arithmetic(a, b, false);
}
export function renderSubtract(a: RenderNumeric, b: RenderNumeric): JsonNumber {
  return arithmetic(a, b, true);
}
function roundedRatio(a: bigint, b: bigint): bigint {
  const q = a / b,
    r = a % b;
  return 2n * r > b || (2n * r === b && q % 2n !== 0n) ? q + 1n : q;
}
function integerDivide(left: bigint, right: bigint): number {
  const negative = left < 0n !== right < 0n,
    a = left < 0n ? -left : left,
    b = right < 0n ? -right : right;
  if (a === 0n) return negative ? -0 : 0;
  let exponent = a.toString(2).length - b.toString(2).length;
  if (exponent >= 0 ? a < b << BigInt(exponent) : a << BigInt(-exponent) < b) exponent--;
  if (exponent > 1023) throw new RangeError('Python integer division result too large for float');
  if (exponent < -1075) return negative ? -0 : 0;
  const shift = Math.min(1074, 52 - exponent);
  const q = shift >= 0 ? roundedRatio(a << BigInt(shift), b) : roundedRatio(a, b << BigInt(-shift));
  const result = Number(q) * 2 ** -shift;
  if (!Number.isFinite(result))
    throw new RangeError('Python integer division result too large for float');
  return negative ? -result : result;
}
export function renderDivide(a: RenderNumeric, b: RenderNumeric): JsonNumber {
  const left = numeric(a),
    right = numeric(b);
  if (typeof left === 'bigint' && typeof right === 'bigint') {
    if (right === 0n) throw new RangeError('Python division by zero');
    return renderFloat(integerDivide(left, right));
  }
  const leftFloat = float(left),
    rightFloat = float(right);
  if (rightFloat === 0) throw new RangeError('Python division by zero');
  return renderFloat(leftFloat / rightFloat);
}
export function renderGreaterThan(a: RenderNumeric, b: RenderNumeric): boolean {
  return numeric(a) > numeric(b);
}
export function renderTruthy(value: RenderValue | undefined): boolean {
  if (value === undefined || value === null || value === false) return false;
  if (isRenderText(value)) return renderTextLength(value) !== 0;
  if (renderIsNumeric(value)) {
    const n = numeric(value);
    return n !== 0n && n !== 0;
  }
  if (Array.isArray(value)) return value.length !== 0;
  return (isJsonObject(value) || isRenderObject(value)) && value.entries.length !== 0;
}
export function renderEqual(a: RenderValue | undefined, b: RenderValue | undefined): boolean {
  if (isRenderText(a) && isRenderText(b)) return renderTextEqual(a, b);
  if (renderIsNumeric(a) || renderIsNumeric(b)) return pythonEqual(a as JsonValue, b as JsonValue);
  if (a === b) return true;
  const memberEqual = (x: RenderValue, y: RenderValue): boolean => x === y || renderEqual(x, y);
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((v, i) => memberEqual(v, b[i]!));
  if ((isRenderObject(a) || isJsonObject(a)) && (isRenderObject(b) || isJsonObject(b)))
    return (
      a.entries.length === b.entries.length &&
      a.entries.every(([key, value]) => {
        const other = renderGet(b, key);
        return other !== undefined && memberEqual(value, other);
      })
    );
  return false;
}

export type RenderJsonOptions = Readonly<{
  ensureAscii?: boolean;
  sortKeys?: boolean;
  indent?: 2;
  numericProfile?: TranscriptJsonNumericProfile;
}>;
function quote(value: RenderText, ascii: boolean): string {
  const text = points(value);
  if (!ascii && text.codepoints.some((p) => p >= 0xd800 && p <= 0xdfff))
    throw new TypeError('Renderer JSON cannot encode surrogate codepoints as strict UTF8');
  return quoteCodepointJson(text, ascii);
}
/** Strict-UTF8-encodable JSON, with Python separators and no trailing LF.
 * Non-ASCII surrogate rejection occurs before JS projection; Python's file
 * encoder rejects the same value after its in-memory json.dumps operation.
 */
export function renderJsonDumps(value: RenderValue, options: RenderJsonOptions = {}): string {
  const suppliedProfile = options.numericProfile;
  const numericProfile =
    suppliedProfile === undefined ? undefined : snapshotTranscriptJsonProfile(suppliedProfile);
  const ascii = options.ensureAscii ?? true,
    indent = options.indent;
  if (indent !== undefined && indent !== 2)
    throw new RangeError('Renderer JSON indentation must be two spaces');
  const encode = (item: RenderValue, depth: number): string => {
    if (item === null) return 'null';
    if (typeof item === 'boolean') return item ? 'true' : 'false';
    if (isRenderText(item)) return quote(item, ascii);
    if (isJsonNumber(item)) {
      if (numericProfile !== undefined) admitTranscriptJsonNumber(item, numericProfile);
      return pythonJsonDumps(item);
    }
    const array = Array.isArray(item);
    if (!array && !isJsonObject(item) && !isRenderObject(item))
      throw new TypeError('Invalid renderer JSON value');
    const entries = !array ? [...(item as JsonObject | RenderObject).entries] : [];
    if (options.sortKeys) entries.sort(([a], [b]) => renderTextOrder(a, b));
    const rows = array
      ? item.map((v) => encode(v, depth + 1))
      : entries.map(([key, v]) => quote(key, ascii) + ': ' + encode(v, depth + 1));
    const open = array ? '[' : '{',
      close = array ? ']' : '}';
    if (rows.length === 0) return open + close;
    return indent === undefined
      ? open + rows.join(', ') + close
      : open +
          '\n' +
          '  '.repeat(depth + 1) +
          rows.join(',\n' + '  '.repeat(depth + 1)) +
          '\n' +
          '  '.repeat(depth) +
          close;
  };
  return encode(value, 0);
}
export function renderJsonBytes(value: RenderValue, options: RenderJsonOptions = {}): Uint8Array {
  return Buffer.from(renderJsonDumps(value, options), 'utf8');
}
