/** Raw transcript occurrences. Coordinates are caller assertions, never custody or cache authority. */
import { createHash } from 'node:crypto';
import {
  isJsonObject,
  parsePythonJson,
  type JsonObject,
  type JsonValue,
  type JsonNumber,
} from './lossless-json';

const PYTHON_SPACE =
  '[\\u0009-\\u000d\\u001c-\\u0020\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';
const STRIP = new RegExp(`^${PYTHON_SPACE}+|${PYTHON_SPACE}+$`, 'gu');
export const PYTHON_WHITESPACE_PATTERN = PYTHON_SPACE;
export function pythonStrip(value: string): string {
  return value.replace(STRIP, '');
}
export function codepointLength(value: string): number {
  return Array.from(value).length;
}
export function codepointSlice(value: string, start?: number, end?: number): string {
  return Array.from(value).slice(start, end).join('');
}
export function codepointOrder(left: string, right: string): number {
  const a = Array.from(left),
    b = Array.from(right);
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const order = a[i]!.codePointAt(0)! - b[i]!.codePointAt(0)!;
    if (order) return order;
  }
  return a.length - b.length;
}

export interface OccurrenceCoordinates {
  readonly sourceId: string;
  readonly sourceGeneration: string;
  /** Unique occurrence label supplied by the caller, not a content hash or an attested ID. */
  readonly occurrenceId: string;
  readonly byteOffset?: bigint;
  readonly lineOrdinal?: bigint;
  readonly framing: 'complete' | 'partial';
}
export interface SourceOccurrence extends OccurrenceCoordinates {
  readonly coordinateAuthority: 'caller_asserted';
  readonly rawBase64: string;
  readonly sha256: string;
  readonly byteLength: number;
}
declare const parsedRowBrand: unique symbol;
type Branded = { readonly [parsedRowBrand]: true; readonly source: SourceOccurrence };
export type ParsedRow = Branded &
  (
    | { readonly disposition: 'parsed'; readonly row: JsonObject }
    | { readonly disposition: 'invalid_utf8' | 'invalid_json' }
    | { readonly disposition: 'non_object'; readonly value: JsonValue }
  );
const issued = new WeakSet<object>();
export function isParsedRow(value: unknown): value is ParsedRow {
  return value !== null && typeof value === 'object' && issued.has(value);
}
function freezeJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    value.forEach(freezeJson);
    Object.freeze(value);
  } else if (value !== null && typeof value === 'object') {
    if (isJsonObject(value)) {
      for (const entry of value.entries) {
        freezeJson(entry[1]);
        Object.freeze(entry);
      }
      Object.freeze(value.entries);
    }
    Object.freeze(value);
  }
  return value;
}
export interface OccurrenceDecodeProfile {
  readonly utf8?: 'strict' | 'replace';
  /** Default true retains the historical transcript decoder's outer strip. */
  readonly stripOuterWhitespace?: boolean;
  /** Called during token conversion, before later syntax and duplicate-key collapse. */
  readonly admitNumberToken: (token: JsonNumber) => void;
}
class TokenAdmissionFailure {
  constructor(readonly cause: unknown) {}
}
/** Profile errors propagate unchanged; only JSON syntax is classified as invalid_json. */
export function decodeProfiledOccurrence(
  bytes: Uint8Array,
  coordinates: OccurrenceCoordinates,
  profile: OccurrenceDecodeProfile
): ParsedRow {
  if (typeof profile?.admitNumberToken !== 'function')
    throw new TypeError('occurrence profile requires numeric token admission');
  if (profile.utf8 !== undefined && profile.utf8 !== 'strict' && profile.utf8 !== 'replace')
    throw new TypeError('unsupported occurrence UTF8 profile');
  return decode(bytes, coordinates, profile);
}
/** Historical custody decoder retains its unbounded numeric policy. */
export function decodeOccurrence(bytes: Uint8Array, coordinates: OccurrenceCoordinates): ParsedRow {
  return decode(bytes, coordinates);
}
function decode(
  bytes: Uint8Array,
  coordinates: OccurrenceCoordinates,
  profile?: OccurrenceDecodeProfile
): ParsedRow {
  for (const value of [
    coordinates.sourceId,
    coordinates.sourceGeneration,
    coordinates.occurrenceId,
  ]) {
    if (typeof value !== 'string' || !value.length)
      throw new TypeError('occurrence labels must be nonempty strings');
  }
  if (coordinates.framing !== 'complete' && coordinates.framing !== 'partial')
    throw new TypeError('invalid occurrence framing');
  for (const value of [coordinates.byteOffset, coordinates.lineOrdinal]) {
    if (value !== undefined && (typeof value !== 'bigint' || value < 0n))
      throw new TypeError('occurrence coordinates must be nonnegative bigint');
  }
  // Copy before decoding: neither the input buffer nor a view of it escapes.
  const raw = Buffer.from(bytes);
  const source: SourceOccurrence = Object.freeze({
    sourceId: coordinates.sourceId,
    sourceGeneration: coordinates.sourceGeneration,
    occurrenceId: coordinates.occurrenceId,
    framing: coordinates.framing,
    ...(coordinates.byteOffset === undefined ? {} : { byteOffset: coordinates.byteOffset }),
    ...(coordinates.lineOrdinal === undefined ? {} : { lineOrdinal: coordinates.lineOrdinal }),
    coordinateAuthority: 'caller_asserted',
    rawBase64: raw.toString('base64'),
    sha256: createHash('sha256').update(raw).digest('hex'),
    byteLength: raw.length,
  });
  const seal = (result: object): ParsedRow => {
    issued.add(result);
    return Object.freeze(result) as ParsedRow;
  };
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: profile?.utf8 !== 'replace', ignoreBOM: true }).decode(
      raw
    );
  } catch {
    return seal({ source, disposition: 'invalid_utf8' });
  }
  let value: JsonValue;
  try {
    value = parsePythonJson(
      profile?.stripOuterWhitespace === false ? text : pythonStrip(text),
      profile === undefined
        ? undefined
        : {
            admitNumberToken(token) {
              try {
                profile.admitNumberToken(token);
              } catch (cause) {
                throw new TokenAdmissionFailure(cause);
              }
            },
          }
    );
  } catch (error) {
    if (error instanceof TokenAdmissionFailure) throw error.cause;
    if (profile !== undefined && !(error instanceof SyntaxError)) throw error;
    return seal({ source, disposition: 'invalid_json' });
  }
  freezeJson(value);
  return isJsonObject(value)
    ? seal({ source, disposition: 'parsed', row: value })
    : seal({ source, disposition: 'non_object', value });
}
