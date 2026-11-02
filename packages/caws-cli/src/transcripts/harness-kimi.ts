/** Historical Kimi wire projection. Acquisition and first-match dispatch remain caller-owned. */
import {
  getMember,
  hasMember,
  isJsonNumber,
  isJsonObject,
  jsonNumber,
  pythonJsonDumps,
  pythonTruthy,
  type JsonNumber,
  type JsonObject,
  type JsonValue,
} from './lossless-json';
import {
  parseTimestamp,
  pythonStrip,
  type LocatedEvent,
  type TranscriptAdapter,
} from './harness-common';
import { UNICODE_PROFILE_ID } from './python-unicode-profile';

export const KIMI_ADAPTER_REVISION = `native-kimi/1;interpretation-profile:${UNICODE_PROFILE_ID};python-sha256:da87e0bcc13af003c144b17b03b41487d76b0004b9ac496bd689678bfb726b5f`;

export class KimiProjectionError extends Error {
  constructor(
    readonly pythonType: 'TypeError' | 'OverflowError',
    message: string
  ) {
    super(message);
    this.name = 'KimiProjectionError';
  }
}

function numeric(value: JsonValue | undefined): value is boolean | JsonNumber {
  return typeof value === 'boolean' || isJsonNumber(value);
}

export function matchesKimi(row: JsonObject): boolean {
  // Python's numeric test short-circuits before the set-membership operation.
  if (!numeric(getMember(row, 'time'))) return false;
  const kind = getMember(row, 'type');
  if (Array.isArray(kind)) throw new KimiProjectionError('TypeError', "unhashable type: 'list'");
  if (isJsonObject(kind)) throw new KimiProjectionError('TypeError', "unhashable type: 'dict'");
  return kind === 'turn.prompt' || kind === 'context.append_loop_event';
}

function timestamp(raw: JsonValue | undefined): string | null {
  if (!numeric(raw)) return null;
  let seconds: number;
  if (typeof raw === 'boolean') seconds = raw ? 0.001 : 0;
  else if (raw.numberKind === 'integer') {
    // CPython integer true division rounds the quotient once. Converting the
    // integer to Number first double-rounds some values and overflows too early.
    seconds = Number(BigInt(raw.lexeme).toString() + 'e-3');
    if (!Number.isFinite(seconds))
      throw new KimiProjectionError(
        'OverflowError',
        'integer division result too large for a float'
      );
  } else seconds = Number(raw.lexeme) / 1000;

  // Division yields a Python float even for integral seconds; its type matters
  // to parse_timestamp's string fallback outside the supported calendar.
  const token = Number.isNaN(seconds) ? 'NaN' : Object.is(seconds, -0) ? '-0.0' : String(seconds);
  return parseTimestamp(
    jsonNumber(Number.isFinite(seconds) && !/[.eE]/.test(token) ? token + '.0' : token)
  );
}

function member(object: JsonValue | undefined, key: string): JsonValue {
  const value = getMember(object, key);
  return value === undefined ? '' : value;
}

/** Python dict(args) copies the dictionary while retaining its nested values. */
function toolInput(args: JsonValue | undefined): JsonObject {
  const entries: Array<readonly [string, JsonValue]> = isJsonObject(args) ? [...args.entries] : [];
  const path = getMember(args, 'path');
  if (!hasMember(args, 'file_path') && typeof path === 'string')
    entries.push(Object.freeze(['file_path', path] as const));
  return Object.freeze({ kind: 'object', entries: Object.freeze(entries) });
}

/** Paths identify emitting native objects, not every source field used by an event. */
export function normalizeKimi(row: JsonObject): readonly LocatedEvent[] {
  const ts = timestamp(getMember(row, 'time'));
  const kind = getMember(row, 'type');
  if (kind === 'turn.prompt') {
    const input = getMember(row, 'input');
    if (!pythonTruthy(input)) return [];
    if (!Array.isArray(input)) {
      // Iterating Python strings or dictionaries yields strings, which cannot
      // be text blocks. Truthy booleans and numbers are not iterable.
      if (typeof input === 'string' || isJsonObject(input)) return [];
      const type =
        typeof input === 'boolean'
          ? 'bool'
          : isJsonNumber(input) && input.numberKind === 'float'
            ? 'float'
            : 'int';
      throw new KimiProjectionError('TypeError', `'${type}' object is not iterable`);
    }
    const events: LocatedEvent[] = [];
    for (let index = 0; index < input.length; index++) {
      const block = input[index];
      if (!isJsonObject(block)) continue;
      const text = getMember(block, 'text');
      if (typeof text === 'string' && pythonStrip(text))
        events.push({ event: { ev: 'user_text', text, ts }, nativeMemberPath: ['input', index] });
    }
    return events;
  }
  if (kind !== 'context.append_loop_event') return [];
  const event = getMember(row, 'event');
  if (!isJsonObject(event)) return [];
  const subtype = getMember(event, 'type');
  if (subtype === 'content.part') {
    const part = getMember(event, 'part');
    if (!isJsonObject(part)) return [];
    const partType = getMember(part, 'type');
    const text =
      partType === 'text'
        ? getMember(part, 'text')
        : partType === 'think'
          ? getMember(part, 'think')
          : undefined;
    return typeof text === 'string' && pythonStrip(text)
      ? [{ event: { ev: 'assistant_text', text, ts }, nativeMemberPath: ['event', 'part'] }]
      : [];
  }
  if (subtype === 'tool.call')
    return [
      {
        event: {
          ev: 'tool_use',
          name: member(event, 'name'),
          id: member(event, 'toolCallId'),
          input: toolInput(getMember(event, 'args')),
          ts,
        },
        nativeMemberPath: ['event'],
      },
    ];
  if (subtype === 'tool.result') {
    const result = getMember(event, 'result');
    const output = member(result, 'output');
    return [
      {
        event: {
          ev: 'tool_result',
          id: member(event, 'toolCallId'),
          content:
            typeof output === 'string' ? output : pythonJsonDumps(output, { ensureAscii: false }),
          is_error: pythonTruthy(getMember(result, 'isError')),
          ts,
        },
        nativeMemberPath: ['event'],
      },
    ];
  }
  return [];
}

export const KIMI_ADAPTER: TranscriptAdapter<null> = Object.freeze({
  id: 'kimi-code',
  revision: KIMI_ADAPTER_REVISION,
  matches: matchesKimi,
  createState: () => null,
  cloneState: () => null,
  normalize: (row: JsonObject) => ({ state: null, events: normalizeKimi(row) }),
});
