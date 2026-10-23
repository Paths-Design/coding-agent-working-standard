/** Store-cell JSON interpretation; derived values confer no source or native authority. */
import { isSharedArrayBuffer, isUint8Array } from 'node:util/types';
import { codepointText, type CodepointText } from './codepoint-text';
import { jsonNumber, type JsonNumber } from './lossless-json';

/** Legacy explicit profile and reconstruction default; never inferred from the host. */
export const STORE_JSON_PROFILE = 'cpython-3.11.13-unicode14-int4300' as const;
export const STORE_JSON_UNLIMITED_PROFILE = 'cpython-3.11.13-unicode14-int0' as const;
export type StoreJsonProfile = typeof STORE_JSON_PROFILE | typeof STORE_JSON_UNLIMITED_PROFILE;

/** Validate the caller's qualified SQL profile. This grants no native admission. */
export function snapshotStoreJsonProfile(profile: unknown): StoreJsonProfile {
  if (profile !== STORE_JSON_PROFILE && profile !== STORE_JSON_UNLIMITED_PROFILE)
    throw new StoreJsonError('request', 'unsupported_profile', 0, 'request');
  return profile;
}
export interface StoreJsonLimits {
  readonly maxInputBytes: number;
  readonly maxDecodedCodepoints: number;
  /** JSON value nodes, including containers; object keys are bounded as strings. */
  readonly maxNodes: number;
  /** Open containers; a scalar has depth zero. */
  readonly maxDepth: number;
  readonly maxStringCodepoints: number;
  readonly maxNumberChars: number;
}
export interface StoreJsonRequest {
  readonly storageClass: 'text' | 'blob';
  readonly bytes: Uint8Array;
  readonly profile: StoreJsonProfile;
  readonly limits: StoreJsonLimits;
}
export interface StoreJsonObject {
  readonly kind: 'object';
  readonly entries: readonly (readonly [CodepointText, StoreJsonValue])[];
}
export type StoreJsonValue =
  | null
  | boolean
  | CodepointText
  | JsonNumber
  | readonly StoreJsonValue[]
  | StoreJsonObject;
export type StoreJsonErrorCategory =
  | 'request'
  | 'encoding'
  | 'syntax'
  | 'integer_limit'
  | 'resource';
export class StoreJsonError extends Error {
  constructor(
    readonly category: StoreJsonErrorCategory,
    readonly code: string,
    readonly offset: number,
    readonly offsetUnit: 'byte' | 'codepoint' | 'request'
  ) {
    super(`${category}:${code} at ${offsetUnit} ${offset}`);
    this.name = 'StoreJsonError';
  }
}
const typedArray = Object.getPrototypeOf(Uint8Array.prototype);
const getter = (key: string): ((this: Uint8Array) => unknown) =>
  Object.getOwnPropertyDescriptor(typedArray, key)!.get!;
const backingOf = getter('buffer');
const offsetOf = getter('byteOffset');
const lengthOf = getter('byteLength');
const LIMIT_KEYS = [
  'maxInputBytes',
  'maxDecodedCodepoints',
  'maxNodes',
  'maxDepth',
  'maxStringCodepoints',
  'maxNumberChars',
] as const;

/**
 * Explicit finite compatibility profile. All bytes are decoded before parsing,
 * matching the ordinary CPython bytes path. Caller limits may refuse otherwise
 * valid input; resource refusal is separate from reference semantic failures.
 * No installed-profile selection, object requirement or publication is implied.
 */
export function parseStoreJson(request: StoreJsonRequest): StoreJsonValue {
  const fail = (
    category: StoreJsonErrorCategory,
    code: string,
    offset: number,
    unit: 'byte' | 'codepoint' | 'request' = 'codepoint'
  ): never => {
    throw new StoreJsonError(category, code, offset, unit);
  };
  const profile = snapshotStoreJsonProfile(request?.profile);
  const storageClass = request.storageClass;
  if (storageClass !== 'text' && storageClass !== 'blob')
    fail('request', 'storage_class', 0, 'request');
  const limits = {} as Record<keyof StoreJsonLimits, number>;
  for (const key of LIMIT_KEYS) {
    const value = request.limits?.[key];
    if (!Number.isSafeInteger(value) || value < 0) fail('request', 'invalid_limit', 0, 'request');
    limits[key] = value;
  }
  const input = request.bytes;
  if (!isUint8Array(input)) fail('request', 'invalid_bytes', 0, 'request');
  const backing = backingOf.call(input) as ArrayBuffer;
  if (isSharedArrayBuffer(backing)) fail('request', 'shared_bytes', 0, 'request');
  const length = lengthOf.call(input) as number;
  if (length > limits.maxInputBytes) fail('resource', 'input_bytes', 0, 'byte');
  let bytes: Buffer;
  try {
    // Unpooled private storage; no caller-visible view escapes into this snapshot.
    bytes = Buffer.alloc(length);
    bytes.set(new Uint8Array(backing, offsetOf.call(input) as number, length));
  } catch {
    return fail('request', 'unavailable_bytes', 0, 'request');
  }

  type Encoding = 'utf8' | 'utf16le' | 'utf16be' | 'utf32le' | 'utf32be';
  let encoding: Encoding = 'utf8';
  let start = 0;
  if (storageClass === 'blob') {
    // CPython json.detect_encoding: BOM order and the length-two exception matter.
    if (length >= 4 && bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 0xfe && bytes[3] === 0xff) {
      encoding = 'utf32be';
      start = 4;
    } else if (
      length >= 4 &&
      bytes[0] === 0xff &&
      bytes[1] === 0xfe &&
      bytes[2] === 0 &&
      bytes[3] === 0
    ) {
      encoding = 'utf32le';
      start = 4;
    } else if (length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
      encoding = 'utf16be';
      start = 2;
    } else if (length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
      encoding = 'utf16le';
      start = 2;
    } else if (length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
      start = 3;
    else if (length >= 4) {
      if (bytes[0] === 0) encoding = bytes[1] === 0 ? 'utf32be' : 'utf16be';
      else if (bytes[1] === 0) encoding = bytes[2] === 0 && bytes[3] === 0 ? 'utf32le' : 'utf16le';
    } else if (length === 2) {
      if (bytes[0] === 0) encoding = 'utf16be';
      else if (bytes[1] === 0) encoding = 'utf16le';
    }
  }
  const points: number[] = [];
  const push = (point: number, byteOffset: number): void => {
    if (points.length >= limits.maxDecodedCodepoints)
      fail('resource', 'decoded_codepoints', byteOffset, 'byte');
    points.push(point);
  };
  const badEncoding = (offset: number): never => fail('encoding', encoding, offset, 'byte');
  if (encoding === 'utf8') {
    for (let index = start; index < length; ) {
      const first = bytes[index]!;
      if (first < 0x80) {
        push(first, index++);
        continue;
      }
      const width =
        first >= 0xc2 && first <= 0xdf
          ? 2
          : first >= 0xe0 && first <= 0xef
            ? 3
            : first >= 0xf0 && first <= 0xf4
              ? 4
              : 0;
      if (!width || index + width > length) badEncoding(index);
      let point = first & (width === 2 ? 0x1f : width === 3 ? 0x0f : 7);
      for (let next = 1; next < width; next++) {
        const byte = bytes[index + next]!;
        if (byte < 0x80 || byte > 0xbf) badEncoding(index);
        point = point * 64 + (byte & 63);
      }
      if (
        (width === 2 && point < 0x80) ||
        (width === 3 && point < 0x800) ||
        (width === 4 && point < 0x10000) ||
        point > 0x10ffff ||
        (storageClass === 'text' && point >= 0xd800 && point <= 0xdfff)
      )
        badEncoding(index);
      push(point, index);
      index += width;
    }
  } else if (encoding === 'utf16le' || encoding === 'utf16be') {
    const unit = (index: number): number =>
      encoding === 'utf16le'
        ? bytes[index]! + bytes[index + 1]! * 256
        : bytes[index]! * 256 + bytes[index + 1]!;
    for (let index = start; index < length; ) {
      if (index + 2 > length) badEncoding(index);
      const first = unit(index);
      if (first >= 0xd800 && first <= 0xdbff && index + 4 <= length) {
        const second = unit(index + 2);
        if (second >= 0xdc00 && second <= 0xdfff) {
          push(0x10000 + (first - 0xd800) * 1024 + second - 0xdc00, index);
          index += 4;
          continue;
        }
      }
      push(first, index);
      index += 2;
    }
  } else {
    for (let index = start; index < length; index += 4) {
      if (index + 4 > length) badEncoding(index);
      const point =
        encoding === 'utf32le'
          ? bytes[index]! +
            bytes[index + 1]! * 256 +
            bytes[index + 2]! * 65536 +
            bytes[index + 3]! * 16777216
          : bytes[index]! * 16777216 +
            bytes[index + 1]! * 65536 +
            bytes[index + 2]! * 256 +
            bytes[index + 3]!;
      if (point > 0x10ffff) badEncoding(index);
      push(point, index);
    }
  }

  let offset = 0;
  let nodes = 0;
  const syntax = (code = 'invalid_json'): never => fail('syntax', code, offset);
  const digit = (point: number | undefined): boolean =>
    point !== undefined && point >= 48 && point <= 57;
  const space = (): void => {
    while (
      points[offset] === 32 ||
      points[offset] === 9 ||
      points[offset] === 10 ||
      points[offset] === 13
    )
      offset++;
  };
  const hexUnit = (at: number): number | undefined => {
    let value = 0;
    for (let index = at; index < at + 4; index++) {
      const point = points[index];
      const nibble =
        point === undefined
          ? -1
          : point >= 48 && point <= 57
            ? point - 48
            : point >= 65 && point <= 70
              ? point - 55
              : point >= 97 && point <= 102
                ? point - 87
                : -1;
      if (nibble < 0) return undefined;
      value = value * 16 + nibble;
    }
    return value;
  };
  const string = (): CodepointText => {
    offset++;
    const value: number[] = [];
    const add = (point: number): void => {
      if (value.length >= limits.maxStringCodepoints) fail('resource', 'string_codepoints', offset);
      value.push(point);
    };
    while (offset < points.length) {
      let point = points[offset++]!;
      if (point === 34) return codepointText(value, profile);
      if (point < 32) syntax();
      if (point === 92) {
        const escaped = points[offset++];
        if (escaped === 117) {
          const unit = hexUnit(offset);
          if (unit === undefined) syntax();
          point = unit!;
          offset += 4;
          // Only two consecutive escaped halves coalesce at the JSON layer.
          if (
            point >= 0xd800 &&
            point <= 0xdbff &&
            points[offset] === 92 &&
            points[offset + 1] === 117
          ) {
            const low = hexUnit(offset + 2);
            if (low !== undefined && low >= 0xdc00 && low <= 0xdfff) {
              point = 0x10000 + (point - 0xd800) * 1024 + low - 0xdc00;
              offset += 6;
            }
          }
        } else {
          const simple: Readonly<Record<number, number>> = {
            34: 34,
            92: 92,
            47: 47,
            98: 8,
            102: 12,
            110: 10,
            114: 13,
            116: 9,
          };
          if (escaped === undefined || simple[escaped] === undefined) syntax();
          point = simple[escaped!]!;
        }
      }
      add(point);
    }
    return syntax();
  };
  const spelling = (from: number, to: number): string =>
    points
      .slice(from, to)
      .map((point) => String.fromCharCode(point))
      .join('');
  const matches = (text: string, at = offset): boolean =>
    [...text].every((char, index) => points[at + index] === char.charCodeAt(0));
  const number = (): JsonNumber => {
    const from = offset;
    for (const constant of ['NaN', 'Infinity', '-Infinity']) {
      if (matches(constant)) {
        if (constant.length > limits.maxNumberChars) fail('resource', 'number_chars', from);
        offset += constant.length;
        return jsonNumber(constant);
      }
    }
    if (points[offset] === 45) offset++;
    if (!digit(points[offset])) syntax();
    if (points[offset] === 48) offset++;
    else
      while (digit(points[offset])) {
        offset++;
        if (offset - from > limits.maxNumberChars) fail('resource', 'number_chars', from);
      }
    let integer = true;
    if (points[offset] === 46 && digit(points[offset + 1])) {
      integer = false;
      offset += 2;
      while (digit(points[offset])) {
        offset++;
        if (offset - from > limits.maxNumberChars) fail('resource', 'number_chars', from);
      }
    }
    if (points[offset] === 69 || points[offset] === 101) {
      let at = offset + 1;
      if (points[at] === 43 || points[at] === 45) at++;
      if (digit(points[at])) {
        integer = false;
        offset = at + 1;
        while (digit(points[offset])) {
          offset++;
          if (offset - from > limits.maxNumberChars) fail('resource', 'number_chars', from);
        }
      }
    }
    if (offset - from > limits.maxNumberChars) fail('resource', 'number_chars', from);
    const digits = offset - from - (points[from] === 45 ? 1 : 0);
    if (integer && profile === STORE_JSON_PROFILE && digits > 4300)
      fail('integer_limit', 'integer_digits', from);
    return jsonNumber(spelling(from, offset));
  };
  type Frame =
    | { kind: 'array'; items: StoreJsonValue[]; state: 'first' | 'value' | 'comma' }
    | {
        kind: 'object';
        entries: Array<readonly [CodepointText, StoreJsonValue]>;
        keys: Map<string, number>;
        key?: CodepointText;
        state: 'first' | 'key' | 'colon' | 'value' | 'comma';
      };
  const stack: Frame[] = [];
  let result: StoreJsonValue = null;
  let complete = false;
  const emit = (value: StoreJsonValue): void => {
    const parent = stack[stack.length - 1];
    if (!parent) {
      result = value;
      complete = true;
      return;
    }
    if (parent.kind === 'array') parent.items.push(value);
    else {
      const key = parent.key!;
      const identity = key.codepoints.join(',');
      const previous = parent.keys.get(identity);
      const entry = Object.freeze([key, value] as const);
      if (previous === undefined) {
        parent.keys.set(identity, parent.entries.length);
        parent.entries.push(entry);
      } else parent.entries[previous] = entry;
      delete parent.key;
    }
    parent.state = 'comma';
  };
  const value = (): void => {
    if (nodes >= limits.maxNodes) fail('resource', 'nodes', offset);
    nodes++;
    const point = points[offset];
    if (point === 91 || point === 123) {
      if (stack.length >= limits.maxDepth) fail('resource', 'depth', offset);
      offset++;
      stack.push(
        point === 91
          ? { kind: 'array', items: [], state: 'first' }
          : { kind: 'object', entries: [], keys: new Map(), state: 'first' }
      );
    } else if (point === 34) emit(string());
    else if (matches('null')) {
      offset += 4;
      emit(null);
    } else if (matches('true')) {
      offset += 4;
      emit(true);
    } else if (matches('false')) {
      offset += 5;
      emit(false);
    } else if (point === 45 || point === 78 || point === 73 || digit(point)) emit(number());
    else syntax(point === 0xfeff && offset === 0 ? 'unexpected_bom' : 'invalid_json');
  };
  while (!complete) {
    space();
    const frame = stack[stack.length - 1];
    if (!frame) {
      value();
      continue;
    }
    if (frame.kind === 'array') {
      if ((frame.state === 'first' || frame.state === 'comma') && points[offset] === 93) {
        offset++;
        stack.pop();
        emit(Object.freeze(frame.items));
      } else if (frame.state === 'comma') {
        if (points[offset++] !== 44) syntax();
        frame.state = 'value';
      } else value();
    } else if ((frame.state === 'first' || frame.state === 'comma') && points[offset] === 125) {
      offset++;
      stack.pop();
      emit(Object.freeze({ kind: 'object' as const, entries: Object.freeze(frame.entries) }));
    } else if (frame.state === 'comma') {
      if (points[offset++] !== 44) syntax();
      frame.state = 'key';
    } else if (frame.state === 'first' || frame.state === 'key') {
      if (points[offset] !== 34) syntax();
      frame.key = string();
      frame.state = 'colon';
    } else if (frame.state === 'colon') {
      if (points[offset++] !== 58) syntax();
      frame.state = 'value';
    } else value();
  }
  space();
  if (offset !== points.length) syntax('extra_data');
  return result;
}
