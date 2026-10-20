/**
 * Transcript JSON follows Python json's semantic profile, including arbitrary
 * integers and its explicit non-finite constants. This is distinct from the
 * runtime's strict JSON source-custody scanner: neither profile widens the other.
 * Number tokens remain source data until a named semantic operation interprets
 * them. JSON.parse is used only for an isolated, already-scanned string token.
 */
export type JsonNumber = Readonly<{
  kind: 'number';
  lexeme: string;
  numberKind: 'integer' | 'float';
}>;
export type JsonObject = Readonly<{
  kind: 'object';
  entries: readonly (readonly [string, JsonValue])[];
}>;
export type JsonValue = null | boolean | string | JsonNumber | readonly JsonValue[] | JsonObject;
export class UnsupportedPythonProfileError extends RangeError {
  readonly code = 'PYTHON_PROFILE_UNSUPPORTED';
  readonly operation = 'repr-unicode-14';
  constructor() {
    super('Python Unicode 14 repr classification is not established for this character');
    this.name = 'UnsupportedPythonProfileError';
  }
}
const NUMBER = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?(?![\s\S])/;
const INTEGER = /^-?(?:0|[1-9][0-9]*)(?![\s\S])/;
const CONSTANTS = new Set(['NaN', 'Infinity', '-Infinity']);
const NAN: JsonNumber = Object.freeze({ kind: 'number', lexeme: 'NaN', numberKind: 'float' });

export function jsonNumber(lexeme: string): JsonNumber {
  if (!NUMBER.test(lexeme) && !CONSTANTS.has(lexeme))
    throw new SyntaxError('Invalid Python JSON number token');
  if (lexeme === 'NaN') return NAN; // Python's JSON decoder also interns its NaN constant.
  return Object.freeze({
    kind: 'number',
    lexeme,
    numberKind: INTEGER.test(lexeme) ? 'integer' : 'float',
  });
}
export function isJsonNumber(value: unknown): value is JsonNumber {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Partial<JsonNumber>;
  return (
    item.kind === 'number' &&
    typeof item.lexeme === 'string' &&
    (NUMBER.test(item.lexeme) || CONSTANTS.has(item.lexeme)) &&
    item.numberKind === (INTEGER.test(item.lexeme) ? 'integer' : 'float')
  );
}
export function isJsonObject(value: unknown): value is JsonObject {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (value as Partial<JsonObject>).kind === 'object' &&
    Array.isArray((value as Partial<JsonObject>).entries)
  );
}
function immutable(value: JsonValue): JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (isJsonNumber(value)) return jsonNumber(value.lexeme);
  if (Array.isArray(value)) return Object.freeze(value.map(immutable));
  if (isJsonObject(value)) return jsonObject(value.entries);
  throw new TypeError('Value is outside the transcript JSON contract');
}
export function jsonObject(entries: readonly (readonly [string, JsonValue])[]): JsonObject {
  const values = new Map<string, JsonValue>();
  for (const [key, value] of entries) {
    if (typeof key !== 'string') throw new TypeError('JSON object keys must be strings');
    values.set(key, immutable(value));
  }
  return Object.freeze({
    kind: 'object',
    entries: Object.freeze([...values].map(([key, value]) => Object.freeze([key, value] as const))),
  });
}
export function getMember(value: JsonValue | undefined, key: string): JsonValue | undefined {
  return isJsonObject(value) ? value.entries.find(([name]) => name === key)?.[1] : undefined;
}
export function hasMember(value: JsonValue | undefined, key: string): boolean {
  return isJsonObject(value) && value.entries.some(([name]) => name === key);
}

export function parsePythonJson(text: string): JsonValue {
  let offset = 0;
  const fail = (): never => {
    throw new SyntaxError(`Invalid Python JSON at offset ${offset}`);
  };
  const space = (): void => {
    while (/[\x20\t\r\n]/.test(text[offset] ?? '\0')) offset++;
  };
  const string = (): string => {
    const start = offset++;
    while (offset < text.length) {
      const code = text.charCodeAt(offset++);
      if (code < 0x20) fail();
      if (code === 0x22) {
        try {
          return JSON.parse(text.slice(start, offset)) as string;
        } catch {
          return fail();
        }
      }
      if (code === 0x5c) {
        const escaped = text[offset++];
        if (escaped === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(offset, offset + 4))) fail();
          offset += 4;
        } else if (escaped === undefined || !'"\\/bfnrt'.includes(escaped)) fail();
      }
    }
    return fail();
  };
  const value = (): JsonValue => {
    space();
    const char = text[offset];
    if (char === '"') return string();
    if (char === '[') {
      offset++;
      space();
      const items: JsonValue[] = [];
      if (text[offset] === ']') {
        offset++;
        return Object.freeze(items);
      }
      for (;;) {
        items.push(value());
        space();
        if (text[offset] === ']') {
          offset++;
          return Object.freeze(items);
        }
        if (text[offset++] !== ',') fail();
      }
    }
    if (char === '{') {
      offset++;
      space();
      const entries: Array<readonly [string, JsonValue]> = [];
      if (text[offset] === '}') {
        offset++;
        return jsonObject(entries);
      }
      for (;;) {
        space();
        if (text[offset] !== '"') fail();
        const key = string();
        space();
        if (text[offset++] !== ':') fail();
        entries.push([key, value()]);
        space();
        if (text[offset] === '}') {
          offset++;
          return jsonObject(entries);
        }
        if (text[offset++] !== ',') fail();
      }
    }
    for (const [literal, result] of [
      ['null', null],
      ['true', true],
      ['false', false],
    ] as const) {
      if (text.startsWith(literal, offset)) {
        offset += literal.length;
        return result;
      }
    }
    const number =
      /^(?:-Infinity|Infinity|NaN|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(
        text.slice(offset)
      );
    if (!number) return fail();
    offset += number[0].length;
    return jsonNumber(number[0]);
  };
  const result = value();
  space();
  if (offset !== text.length) fail();
  return result;
}

function quote(value: string, ascii: boolean, escapeLoneSurrogates = false): string {
  let result = '"';
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    const short: Record<number, string> = {
      8: '\\b',
      9: '\\t',
      10: '\\n',
      12: '\\f',
      13: '\\r',
      34: '\\"',
      92: '\\\\',
    };
    if (short[code] !== undefined) result += short[code];
    else if (
      code < 0x20 ||
      (ascii && code >= 0x7f) ||
      (escapeLoneSurrogates &&
        ((code >= 0xd800 &&
          code <= 0xdbff &&
          !(value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff)) ||
          (code >= 0xdc00 &&
            code <= 0xdfff &&
            !(value.charCodeAt(index - 1) >= 0xd800 && value.charCodeAt(index - 1) <= 0xdbff))))
    )
      result += '\\u' + code.toString(16).padStart(4, '0');
    else result += value[index];
  }
  return result + '"';
}
function codepointOrder(a: string, b: string): number {
  const left = [...a],
    right = [...b];
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    const delta = left[index]!.codePointAt(0)! - right[index]!.codePointAt(0)!;
    if (delta) return delta;
  }
  return left.length - right.length;
}
type Ratio = { numerator: bigint; denominator: bigint };
const TEN = (power: number): bigint => 10n ** BigInt(power);
function binaryRatio(value: number): Ratio {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, Math.abs(value));
  const bits = view.getBigUint64(0),
    exponent = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & ((1n << 52n) - 1n);
  const significand = exponent ? (1n << 52n) + fraction : fraction;
  const shift = exponent ? exponent - 1023 - 52 : -1074;
  return shift >= 0
    ? { numerator: significand << BigInt(shift), denominator: 1n }
    : { numerator: significand, denominator: 1n << BigInt(-shift) };
}
function roundedRatio(numerator: bigint, denominator: bigint): bigint {
  const floor = numerator / denominator,
    remainder = numerator % denominator;
  return remainder * 2n > denominator || (remainder * 2n === denominator && floor % 2n !== 0n)
    ? floor + 1n
    : floor;
}
function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}
/** Closest shortest decimal that rounds back to the same binary64 value.
 * Integer arithmetic compares candidate distances and resolves midpoint ties;
 * Number conversion here interprets deliberate float candidates, never integer custody.
 */
function floatDigits(value: number): { digits: string; power: number } {
  const { numerator, denominator } = binaryRatio(value);
  let exponent = Math.floor(Math.log10(value));
  const atLeastPower = (power: number): boolean =>
    power >= 0 ? numerator >= denominator * TEN(power) : numerator * TEN(-power) >= denominator;
  while (!atLeastPower(exponent)) exponent--;
  while (atLeastPower(exponent + 1)) exponent++;
  for (let precision = 1; precision <= 17; precision++) {
    const power = exponent - precision + 1;
    const rounded =
      power >= 0
        ? roundedRatio(numerator, denominator * TEN(power))
        : roundedRatio(numerator * TEN(-power), denominator);
    let best: { coefficient: bigint; distance: bigint; denominator: bigint } | undefined;
    for (const coefficient of [rounded - 1n, rounded, rounded + 1n]) {
      if (coefficient <= 0n || Number(coefficient.toString() + 'e' + power) !== value) continue;
      const candidateNumerator = power >= 0 ? coefficient * TEN(power) : coefficient;
      const candidateDenominator = power >= 0 ? 1n : TEN(-power);
      const distance = abs(numerator * candidateDenominator - candidateNumerator * denominator);
      if (
        !best ||
        distance * best.denominator < best.distance * candidateDenominator ||
        (distance * best.denominator === best.distance * candidateDenominator &&
          coefficient % 2n === 0n)
      )
        best = { coefficient, distance, denominator: candidateDenominator };
    }
    if (best) {
      let coefficient = best.coefficient,
        adjustedPower = power;
      while (coefficient % 10n === 0n) {
        coefficient /= 10n;
        adjustedPower++;
      }
      return { digits: coefficient.toString(), power: adjustedPower };
    }
  }
  throw new Error('Cannot establish shortest Python float representation');
}
function interpretedNumber(value: JsonNumber, json: boolean): string {
  if (value.numberKind === 'integer') return BigInt(value.lexeme).toString();
  const number = Number(value.lexeme);
  if (Number.isNaN(number)) return json ? 'NaN' : 'nan';
  if (!Number.isFinite(number))
    return number < 0 ? (json ? '-Infinity' : '-inf') : json ? 'Infinity' : 'inf';
  if (number === 0) return Object.is(number, -0) ? '-0.0' : '0.0';
  const negative = number < 0 ? '-' : '';
  const { digits, power } = floatDigits(Math.abs(number));
  const exponent = digits.length + power - 1;
  if (exponent < -4 || exponent >= 16) {
    const mantissa = digits[0] + (digits.length > 1 ? '.' + digits.slice(1) : '');
    return (
      negative +
      mantissa +
      'e' +
      (exponent < 0 ? '-' : '+') +
      Math.abs(exponent).toString().padStart(2, '0')
    );
  }
  const point = digits.length + power;
  return (
    negative +
    (power >= 0
      ? digits + '0'.repeat(power) + '.0'
      : point <= 0
        ? '0.' + '0'.repeat(-point) + digits
        : digits.slice(0, point) + '.' + digits.slice(point))
  );
}
function encode(value: JsonValue, source: boolean, ascii: boolean, sort: boolean): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return quote(value, ascii, source);
  if (isJsonNumber(value)) return source ? value.lexeme : interpretedNumber(value, true);
  const comma = source ? ',' : ', ',
    colon = source ? ':' : ': ';
  if (Array.isArray(value))
    return '[' + value.map((item) => encode(item, source, ascii, sort)).join(comma) + ']';
  if (!isJsonObject(value)) throw new TypeError('Value is outside the transcript JSON contract');
  const entries = sort
    ? [...value.entries].sort(([a], [b]) => codepointOrder(a, b))
    : value.entries;
  return (
    '{' +
    entries
      .map(([key, item]) => quote(key, ascii, source) + colon + encode(item, source, ascii, sort))
      .join(comma) +
    '}'
  );
}
export function encodeSourceJson(value: JsonValue): string {
  return encode(value, true, false, false);
}
export function pythonJsonDumps(
  value: JsonValue,
  options: { sortKeys?: boolean; ensureAscii?: boolean } = {}
): string {
  return encode(value, false, options.ensureAscii ?? true, options.sortKeys ?? false);
}
export function pythonTruthy(value: JsonValue | undefined): boolean {
  if (value === undefined || value === null || value === false || value === '') return false;
  if (isJsonNumber(value))
    return value.numberKind === 'integer'
      ? BigInt(value.lexeme) !== 0n
      : Number(value.lexeme) !== 0;
  if (Array.isArray(value)) return value.length !== 0;
  if (isJsonObject(value)) return value.entries.length !== 0;
  return true;
}
function numeric(
  value: JsonValue | undefined
): { integer: bigint } | { float: number } | undefined {
  if (typeof value === 'boolean') return { integer: value ? 1n : 0n };
  if (!isJsonNumber(value)) return undefined;
  return value.numberKind === 'integer'
    ? { integer: BigInt(value.lexeme) }
    : { float: Number(value.lexeme) };
}
export function pythonEqual(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  const left = numeric(a),
    right = numeric(b);
  if (left && right) {
    if ('integer' in left && 'integer' in right) return left.integer === right.integer;
    if ('float' in left && 'float' in right) return left.float === right.float;
    const integer = 'integer' in left ? left.integer : 'integer' in right ? right.integer : 0n;
    const float = 'float' in left ? left.float : 'float' in right ? right.float : NaN;
    if (!Number.isFinite(float)) return false;
    const ratio = binaryRatio(float);
    return integer * ratio.denominator === (float < 0 ? -ratio.numerator : ratio.numerator);
  }
  if (left || right) return false;
  if (a === b) return true;
  // Python container comparisons short-circuit identical member objects;
  // the interned JSON NaN constant therefore differs from scalar NaN equality.
  const memberEqual = (x: JsonValue, y: JsonValue): boolean => x === y || pythonEqual(x, y);
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((item, index) => memberEqual(item, b[index]!));
  if (isJsonObject(a) && isJsonObject(b))
    return (
      a.entries.length === b.entries.length &&
      a.entries.every(([key, item]) => {
        const other = getMember(b, key);
        return other !== undefined && memberEqual(item, other);
      })
    );
  return false;
}
function reprString(value: string): string {
  const delimiter = value.includes("'") && !value.includes('"') ? '"' : "'";
  let result = delimiter;
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (character === delimiter || character === '\\') result += '\\' + character;
    else if (character === '\n') result += '\\n';
    else if (character === '\r') result += '\\r';
    else if (character === '\t') result += '\\t';
    else if (
      code < 0x20 ||
      (code >= 0x7f && code <= 0xa0) ||
      code === 0xad ||
      (code >= 0xd800 && code <= 0xdfff)
    ) {
      result +=
        code <= 0xff
          ? '\\x' + code.toString(16).padStart(2, '0')
          : '\\u' + code.toString(16).padStart(4, '0');
    } else if (code <= 0xff) result += character;
    else throw new UnsupportedPythonProfileError();
  }
  return result + delimiter;
}
/** repr's Unicode classification is exact for Latin-1 and lone surrogates.
 * Other non-ASCII characters require a pinned Unicode14 table; fail explicitly
 * rather than silently use this Node installation's potentially newer table.
 * JSON dumping and pythonStr(string) do not have this classification restriction.
 */
export function pythonRepr(value: JsonValue): string {
  if (value === null) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'string') return reprString(value);
  if (isJsonNumber(value)) return interpretedNumber(value, false);
  if (Array.isArray(value)) return '[' + value.map(pythonRepr).join(', ') + ']';
  if (isJsonObject(value))
    return (
      '{' +
      value.entries.map(([key, item]) => reprString(key) + ': ' + pythonRepr(item)).join(', ') +
      '}'
    );
  throw new TypeError('Value is outside the transcript JSON contract');
}
export function pythonStr(value: JsonValue): string {
  return typeof value === 'string' ? value : pythonRepr(value);
}
