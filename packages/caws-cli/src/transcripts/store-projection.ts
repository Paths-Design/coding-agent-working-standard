/** Ordered store-row projection only; acquisition and publication remain caller-owned. */
import { isSharedArrayBuffer, isUint8Array } from 'node:util/types';
import {
  codepointText,
  codepointTextFromString,
  isCodepointText,
  encodeUtf8Strict,
  type CodepointText,
} from './codepoint-text';
import { isJsonNumber, pythonJsonDumps } from './lossless-json';
import { OPENCODE_TOOL_NAME_MAP } from './harness-opencode';
import {
  parseStoreJson,
  STORE_JSON_PROFILE,
  type StoreJsonLimits,
  type StoreJsonObject,
  type StoreJsonValue,
} from './store-json';
import {
  prepareStoreTimestamp,
  finishStoreTimestamp,
  STORE_TIMESTAMP_PROFILE,
  type StoreUtcCalendarResult,
} from './store-timestamp';

export type StoreSqlCell =
  | Readonly<{ storageClass: 'null' }>
  | Readonly<{ storageClass: 'integer'; value: bigint }>
  | Readonly<{ storageClass: 'real'; value: number }>
  | Readonly<{ storageClass: 'text' | 'blob'; bytes: Uint8Array }>;
export interface StoreAcquiredRow {
  readonly ordinal: number;
  /** message_id, message_data, part_id, part_data, part_time; admitted by provider. */
  readonly cells: readonly [StoreSqlCell, StoreSqlCell, StoreSqlCell, StoreSqlCell, StoreSqlCell];
}
export interface StoreProjectionLimits {
  readonly json: StoreJsonLimits;
  readonly maxRows: number;
  readonly maxEvents: number;
  /** Retained occurrences, including object keys, nested payloads and timestamps. */
  readonly maxCodepoints: number;
}
export interface StoreProjection {
  readonly events: readonly StoreJsonObject[];
  readonly sourceRows: readonly Readonly<{ messageId: StoreSqlCell; partId: StoreSqlCell }>[];
}
const projections = new WeakSet<object>();
export class StoreProjectionEncodingError extends Error {
  constructor(
    readonly index: number,
    readonly codepoint: number
  ) {
    super('Store event JSON contains an unencodable surrogate');
    this.name = 'StoreProjectionEncodingError';
  }
}
export class StoreProjectionReferenceError extends Error {
  constructor(
    readonly referenceType: 'ValueError' | 'TypeError',
    message: string
  ) {
    super(message);
    this.name = 'StoreProjectionReferenceError';
  }
}
export class StoreProjectionContractError extends Error {
  constructor(
    readonly category: 'request' | 'resource',
    readonly code: string
  ) {
    super(`${category}:${code}`);
    this.name = 'StoreProjectionContractError';
  }
}
const contract = (code: string): never => {
  throw new StoreProjectionContractError('request', code);
};
const resource = (code: string): never => {
  throw new StoreProjectionContractError('resource', code);
};
const reference = (type: 'ValueError' | 'TypeError', message: string): never => {
  throw new StoreProjectionReferenceError(type, message);
};
function fields(value: unknown): Record<string, PropertyDescriptor> {
  if (value === null || typeof value !== 'object') return contract('invalid_record');
  try {
    if (Array.isArray(value)) return contract('invalid_record');
    return Object.getOwnPropertyDescriptors(value);
  } catch (error) {
    if (error instanceof StoreProjectionContractError) throw error;
    return contract('unreadable_record');
  }
}
function own(data: Record<string, PropertyDescriptor>, key: string): unknown {
  const item = Object.prototype.hasOwnProperty.call(data, key) ? data[key] : undefined;
  if (!item || !Object.prototype.hasOwnProperty.call(item, 'value'))
    return contract('missing_or_accessor_' + key);
  return item.value;
}
const typedArray = Object.getPrototypeOf(Uint8Array.prototype);
const bufferOf = Object.getOwnPropertyDescriptor(typedArray, 'buffer')!.get!;
const offsetOf = Object.getOwnPropertyDescriptor(typedArray, 'byteOffset')!.get!;
const lengthOf = Object.getOwnPropertyDescriptor(typedArray, 'byteLength')!.get!;
function snapshotCell(value: unknown): StoreSqlCell {
  const data = fields(value);
  const storageClass = own(data, 'storageClass');
  if (storageClass === 'null') return Object.freeze({ storageClass });
  if (storageClass === 'integer') {
    const number = own(data, 'value');
    if (typeof number !== 'bigint' || number < -(1n << 63n) || number >= 1n << 63n)
      return contract('invalid_i64');
    return Object.freeze({ storageClass, value: number });
  }
  if (storageClass === 'real') {
    const number = own(data, 'value');
    if (typeof number !== 'number') return contract('invalid_real');
    return Object.freeze({ storageClass, value: number });
  }
  if (storageClass !== 'text' && storageClass !== 'blob') return contract('storage_class');
  const bytes = own(data, 'bytes');
  if (!isUint8Array(bytes)) return contract('invalid_bytes');
  let privateBytes: Uint8Array;
  try {
    const buffer = bufferOf.call(bytes) as ArrayBuffer;
    if (isSharedArrayBuffer(buffer)) return contract('shared_bytes');
    const length = lengthOf.call(bytes) as number;
    privateBytes = new Uint8Array(length);
    privateBytes.set(new Uint8Array(buffer, offsetOf.call(bytes) as number, length));
  } catch (error) {
    if (error instanceof StoreProjectionContractError) throw error;
    return contract('unavailable_bytes');
  }
  // Neither the original view nor this private backing escapes. Returned views are disposable.
  return Object.freeze({
    storageClass,
    get bytes(): Uint8Array {
      return privateBytes.slice();
    },
  });
}
function snapshotRow(value: StoreAcquiredRow, ordinal: number): StoreAcquiredRow {
  const data = fields(value);
  if (own(data, 'ordinal') !== ordinal) return contract('ordinal_sequence');
  const cells = own(data, 'cells');
  let descriptors: Record<string, PropertyDescriptor>;
  try {
    if (!Array.isArray(cells)) return contract('five_cells_required');
    descriptors = Object.getOwnPropertyDescriptors(cells);
  } catch (error) {
    if (error instanceof StoreProjectionContractError) throw error;
    return contract('unreadable_cells');
  }
  if (own(descriptors, 'length') !== 5) return contract('five_cells_required');
  return Object.freeze({
    ordinal,
    cells: Object.freeze([
      snapshotCell(own(descriptors, '0')),
      snapshotCell(own(descriptors, '1')),
      snapshotCell(own(descriptors, '2')),
      snapshotCell(own(descriptors, '3')),
      snapshotCell(own(descriptors, '4')),
    ] as const),
  });
}
function limitsSnapshot(value: StoreProjectionLimits): StoreProjectionLimits {
  const data = fields(value);
  const limit = (object: Record<string, PropertyDescriptor>, key: string): number => {
    const number = own(object, key);
    if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 0)
      return contract('invalid_limit_' + key);
    return number;
  };
  const json = fields(own(data, 'json'));
  return Object.freeze({
    json: Object.freeze({
      maxInputBytes: limit(json, 'maxInputBytes'),
      maxDecodedCodepoints: limit(json, 'maxDecodedCodepoints'),
      maxNodes: limit(json, 'maxNodes'),
      maxDepth: limit(json, 'maxDepth'),
      maxStringCodepoints: limit(json, 'maxStringCodepoints'),
      maxNumberChars: limit(json, 'maxNumberChars'),
    }),
    maxRows: limit(data, 'maxRows'),
    maxEvents: limit(data, 'maxEvents'),
    maxCodepoints: limit(data, 'maxCodepoints'),
  });
}
const text = (value: string): CodepointText => codepointTextFromString(value, STORE_JSON_PROFILE);
function object(entries: readonly (readonly [string, StoreJsonValue])[]): StoreJsonObject {
  return Object.freeze({
    kind: 'object',
    entries: Object.freeze(
      entries.map(([key, value]) => Object.freeze([text(key), value] as const))
    ),
  });
}
function isObject(value: StoreJsonValue | undefined): value is StoreJsonObject {
  return (
    value !== null &&
    value !== undefined &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    'kind' in value &&
    value.kind === 'object'
  );
}
function equalAscii(value: StoreJsonValue | undefined, ascii: string): boolean {
  return (
    isCodepointText(value) &&
    value.codepoints.length === ascii.length &&
    value.codepoints.every((point, i) => point === ascii.charCodeAt(i))
  );
}
function member(value: StoreJsonObject, key: string): StoreJsonValue | undefined {
  return value.entries.find(([name]) => equalAscii(name, key))?.[1];
}
const defaulted = (
  value: StoreJsonObject,
  key: string,
  fallback: StoreJsonValue
): StoreJsonValue => {
  const result = member(value, key);
  return result === undefined ? fallback : result;
};
function parse(cell: StoreSqlCell, limits: StoreJsonLimits): StoreJsonValue {
  if (cell.storageClass !== 'text' && cell.storageClass !== 'blob') {
    const kind =
      cell.storageClass === 'null' ? 'NoneType' : cell.storageClass === 'integer' ? 'int' : 'float';
    return reference('TypeError', 'the JSON object must be str, bytes or bytearray, not ' + kind);
  }
  return parseStoreJson({
    storageClass: cell.storageClass,
    bytes: cell.bytes,
    profile: STORE_JSON_PROFILE,
    limits,
  });
}
function equalCell(a: StoreSqlCell, b: StoreSqlCell): boolean {
  if (a.storageClass === 'integer' && b.storageClass === 'real')
    return Number.isFinite(b.value) && Number.isInteger(b.value) && a.value === BigInt(b.value);
  if (a.storageClass === 'real' && b.storageClass === 'integer') return equalCell(b, a);
  if (a.storageClass !== b.storageClass) return false;
  if (a.storageClass === 'null') return true;
  if (a.storageClass === 'integer' && b.storageClass === 'integer') return a.value === b.value;
  if (a.storageClass === 'real' && b.storageClass === 'real') return a.value === b.value;
  if (
    (a.storageClass === 'text' || a.storageClass === 'blob') &&
    (b.storageClass === 'text' || b.storageClass === 'blob')
  ) {
    const left = a.bytes,
      right = b.bytes;
    return left.length === right.length && left.every((byte, i) => byte === right[i]);
  }
  return false;
}
const INPUT_FIELDS: Readonly<Record<string, readonly (readonly [string, string])[]>> =
  Object.freeze({
    edit: [
      ['filePath', 'file_path'],
      ['oldString', 'old_string'],
      ['newString', 'new_string'],
    ],
    write: [
      ['filePath', 'file_path'],
      ['content', 'content'],
    ],
    read: [['filePath', 'file_path']],
    bash: [
      ['command', 'command'],
      ['description', 'description'],
    ],
    grep: [
      ['pattern', 'pattern'],
      ['path', 'path'],
    ],
    glob: [
      ['pattern', 'pattern'],
      ['path', 'path'],
    ],
    task: [
      ['prompt', 'prompt'],
      ['subagent_type', 'subagent_type'],
      ['description', 'description'],
    ],
    skill: [
      ['name', 'skill'],
      ['args', 'args'],
    ],
  });
function mapTool(
  name: StoreJsonValue,
  args: StoreJsonObject
): readonly [StoreJsonValue, StoreJsonObject] {
  if (Array.isArray(name) || isObject(name))
    return reference('TypeError', `unhashable type: '${Array.isArray(name) ? 'list' : 'dict'}'`);
  const declared = Object.entries(INPUT_FIELDS).find(([key]) => equalAscii(name, key));
  const mapped = declared
    ? object(
        declared[1].map(([source, target]) => [target, defaulted(args, source, text(''))] as const)
      )
    : args;
  const renamed = Object.entries(OPENCODE_TOOL_NAME_MAP).find(([key]) => equalAscii(name, key));
  return [renamed ? text(renamed[1]) : name, mapped];
}
function event(role: string, timestamp: StoreJsonValue, content: StoreJsonObject): StoreJsonObject {
  return object([
    ['type', text(role)],
    ['timestamp', timestamp],
    ['message', object([['content', Object.freeze([content])]])],
  ]);
}
function countCodepoints(value: StoreJsonValue): number {
  const pending: StoreJsonValue[] = [value];
  let count = 0;
  while (pending.length) {
    const item = pending.pop()!;
    if (isCodepointText(item)) count += item.codepoints.length;
    else if (Array.isArray(item)) {
      for (const child of item) pending.push(child);
    } else if (isObject(item)) {
      for (const [key, child] of item.entries) {
        count += key.codepoints.length;
        pending.push(child);
      }
    }
  }
  return count;
}
/**
 * Provider owns one read connection, whole-row TEXT admission and next-step precedence,
 * and closes before iterator completion. No SQL, publication or reference-error wrapping.
 */
export async function reconstructStoreProjection(
  rows: AsyncIterable<StoreAcquiredRow>,
  surface: 'opencode' | 'zcode',
  calendar: (seconds: bigint) => Promise<StoreUtcCalendarResult>,
  requestedLimits: StoreProjectionLimits
): Promise<StoreProjection> {
  const limits = limitsSnapshot(requestedLimits);
  if (surface !== 'opencode' && surface !== 'zcode') return contract('surface');
  if (typeof calendar !== 'function') return contract('calendar');
  if (rows === null || rows === undefined || typeof rows[Symbol.asyncIterator] !== 'function')
    return contract('rows');
  const events: StoreJsonObject[] = [],
    sourceRows: Array<Readonly<{ messageId: StoreSqlCell; partId: StoreSqlCell }>> = [];
  let ordinal = 0,
    codepoints = 0;
  let userMessage: StoreSqlCell = Object.freeze({ storageClass: 'null' });
  let previousText: CodepointText | undefined;
  const append = (build: () => StoreJsonObject): void => {
    if (events.length >= limits.maxEvents) return resource('events');
    const next = build();
    const count = countCodepoints(next);
    if (count > limits.maxCodepoints - codepoints) return resource('codepoints');
    events.push(next);
    codepoints += count;
  };
  for await (const acquired of rows) {
    if (ordinal >= limits.maxRows) return resource('rows');
    const row = snapshotRow(acquired, ++ordinal);
    const [messageId, messageCell, partId, partCell, timeCell] = row.cells;
    if (messageId.storageClass === 'null') return contract('null_message_id');
    const message = parse(messageCell, limits.json),
      part = parse(partCell, limits.json);
    if (!isObject(message) || !isObject(part))
      return reference('ValueError', 'message and part data must be objects');
    sourceRows.push(Object.freeze({ messageId, partId }));
    const prepared = prepareStoreTimestamp(STORE_TIMESTAMP_PROFILE, timeCell);
    const stamp = finishStoreTimestamp(
      prepared,
      prepared === null ? null : await calendar(prepared.seconds)
    );
    const timestamp = stamp === null ? null : text(stamp);
    const role = member(message, 'role'),
      kind = member(part, 'type');
    if (equalAscii(kind, 'text') && (equalAscii(role, 'user') || equalAscii(role, 'assistant'))) {
      const prose = member(part, 'text');
      if (!isCodepointText(prose)) return reference('ValueError', 'text part is not a string');
      const user = equalAscii(role, 'user');
      if (user && equalCell(userMessage, messageId)) {
        if (previousText === undefined) return contract('missing_merge_text');
        const added = 2 + prose.codepoints.length;
        if (added > limits.maxCodepoints - codepoints) return resource('codepoints');
        previousText = codepointText(
          [...previousText.codepoints, 10, 10, ...prose.codepoints],
          STORE_JSON_PROFILE
        );
        const previous = events[events.length - 1]!;
        events[events.length - 1] = event(
          'user',
          member(previous, 'timestamp')!,
          object([
            ['type', text('text')],
            ['text', previousText],
          ])
        );
        codepoints += added;
      } else {
        append(() =>
          event(
            user ? 'user' : 'assistant',
            timestamp,
            object([
              ['type', text('text')],
              ['text', prose],
            ])
          )
        );
        previousText = user ? prose : undefined;
      }
      userMessage = user ? messageId : Object.freeze({ storageClass: 'null' });
    } else if (equalAscii(kind, 'tool')) {
      userMessage = Object.freeze({ storageClass: 'null' });
      previousText = undefined;
      const state = member(part, 'state');
      if (!isObject(state)) return reference('ValueError', 'tool state is not an object');
      let name = defaulted(part, 'tool', text(''));
      const id = defaulted(part, 'callID', text(''));
      const supplied = defaulted(state, 'input', object([]));
      if (!isObject(supplied)) return reference('ValueError', 'tool input is not an object');
      let args = supplied;
      if (surface === 'opencode') [name, args] = mapTool(name, args);
      append(() =>
        event(
          'assistant',
          timestamp,
          object([
            ['type', text('tool_use')],
            ['name', name],
            ['id', id],
            ['input', args],
          ])
        )
      );
      const status = member(state, 'status');
      if (equalAscii(status, 'completed') || equalAscii(status, 'error'))
        append(() =>
          event(
            'user',
            timestamp,
            object([
              ['type', text('tool_result')],
              ['tool_use_id', id],
              ['is_error', equalAscii(status, 'error')],
              ['content', defaulted(state, 'output', text(''))],
            ])
          )
        );
    }
  }
  const result = Object.freeze({
    events: Object.freeze(events),
    sourceRows: Object.freeze(sourceRows),
  });
  projections.add(result);
  return result;
}

/** Python's default JSON separators and ensure_ascii=False, followed by strict
 * UTF-8 encoding of the complete event stream. Acquisition must have settled
 * before the native consumer calls this; receipt metadata is serialized later. */
export function encodeStoreProjectionEvents(
  projection: StoreProjection,
  maxOutputBytes: number
): Uint8Array {
  if (!projections.has(projection)) return contract('unconstructed_projection');
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 0)
    return contract('invalid_output_limit');
  const points: number[] = [];
  let bytes = 0;
  const emit = (point: number): void => {
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    if (bytes > maxOutputBytes) return resource('output_bytes');
    points.push(point);
  };
  const ascii = (value: string): void => {
    for (const character of value) emit(character.charCodeAt(0));
  };
  const short = new Map([
    [8, '\\b'],
    [9, '\\t'],
    [10, '\\n'],
    [12, '\\f'],
    [13, '\\r'],
    [34, '\\"'],
    [92, '\\\\'],
  ]);
  const quote = (value: CodepointText): void => {
    emit(34);
    for (const point of value.codepoints) {
      const escaped = short.get(point);
      if (escaped !== undefined) ascii(escaped);
      else if (point < 0x20) ascii('\\u' + point.toString(16).padStart(4, '0'));
      else emit(point); // retain surrogate codepoints until whole-stream encode
    }
    emit(34);
  };
  type Task = { kind: 'value'; value: StoreJsonValue } | { kind: 'ascii'; value: string };
  for (const event of projection.events) {
    const pending: Task[] = [{ kind: 'value', value: event }];
    while (pending.length) {
      const next = pending.pop()!;
      if (next.kind === 'ascii') {
        ascii(next.value);
        continue;
      }
      const value = next.value;
      if (value === null) ascii('null');
      else if (typeof value === 'boolean') ascii(value ? 'true' : 'false');
      else if (isCodepointText(value)) quote(value);
      else if (isJsonNumber(value)) ascii(pythonJsonDumps(value));
      else if (Array.isArray(value)) {
        emit(91);
        pending.push({ kind: 'ascii', value: ']' });
        for (let index = value.length - 1; index >= 0; index--) {
          pending.push({ kind: 'value', value: value[index]! });
          if (index > 0) pending.push({ kind: 'ascii', value: ', ' });
        }
      } else if (isObject(value)) {
        emit(123);
        pending.push({ kind: 'ascii', value: '}' });
        for (let index = value.entries.length - 1; index >= 0; index--) {
          const [key, child] = value.entries[index]!;
          pending.push(
            { kind: 'value', value: child },
            { kind: 'ascii', value: ': ' },
            { kind: 'value', value: key }
          );
          if (index > 0) pending.push({ kind: 'ascii', value: ', ' });
        }
      } else return contract('invalid_projected_value');
    }
    emit(10);
  }
  const encoded = encodeUtf8Strict(codepointText(points, STORE_JSON_PROFILE));
  if (!encoded.ok) throw new StoreProjectionEncodingError(encoded.index, encoded.codepoint);
  return encoded.value;
}
