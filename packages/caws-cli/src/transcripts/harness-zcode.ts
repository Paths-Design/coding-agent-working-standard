/** Historical native model_io projection; durable-store reconstruction remains caller-owned. */
import {
  getMember,
  isJsonObject,
  jsonObject,
  pythonTruthy,
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

export const ZCODE_ADAPTER_REVISION = `native-zcode/1;interpretation-profile:${UNICODE_PROFILE_ID};python-sha256:3c8cd2b60bc9011f81f56176ace3ea524c334b938e3ba561fac84e6466e021b4`;
/** Declaration parity only; the caller owns application of injected-text filtering. */
export const ZCODE_NOISE_PREFIXES: readonly string[] = Object.freeze([
  "The TodoWrite tool hasn't been used recently",
]);

/** Absence differs from an explicit null; immutable JSON also permits explicit seeded controls. */
export interface ZcodeState {
  zcode_turn_id?: JsonValue;
}
export function createZcodeState(): ZcodeState {
  return {};
}
export function cloneZcodeState(state: ZcodeState): ZcodeState {
  return { ...state }; // JSON members are immutable; the mutable state bag is transaction-local.
}
export function matchesZcode(row: JsonObject): boolean {
  return getMember(row, 'type') === 'model_io';
}
function coalesce(...values: readonly (JsonValue | undefined)[]): JsonValue | undefined {
  // Python `or` returns the final operand even when every operand is falsey.
  return values.find(pythonTruthy) ?? values[values.length - 1];
}
function member(row: JsonObject, key: string): JsonValue {
  const value = getMember(row, key);
  return value === undefined ? '' : value;
}

/** Paths identify emitting native objects, not the provenance of every projected field. */
export function normalizeZcode(row: JsonObject, state: ZcodeState): readonly LocatedEvent[] {
  const rawTurnId = getMember(row, 'turnId');
  const turnId = typeof rawTurnId === 'string' && rawTurnId ? rawTurnId : null;
  let lastTurnId = state.zcode_turn_id ?? null;
  const started = getMember(row, 'startedAt'),
    timestamp = getMember(row, 'timestamp');
  const startedTs = parseTimestamp(coalesce(started, timestamp)),
    completedTs = parseTimestamp(coalesce(getMember(row, 'completedAt'), timestamp, started));
  const events: LocatedEvent[] = [];
  if (turnId && turnId !== lastTurnId) {
    events.push({
      event: { ev: 'turn_boundary', turn_id: turnId, ts: startedTs },
      nativeMemberPath: [],
    });
    lastTurnId = turnId;
  }

  const response = getMember(row, 'response');
  if (isJsonObject(response)) {
    const text = getMember(response, 'text');
    if (typeof text === 'string' && pythonStrip(text))
      events.push({
        event: { ev: 'assistant_text', text, ts: completedTs },
        nativeMemberPath: ['response'],
      });
    const calls = getMember(response, 'toolCalls');
    if (Array.isArray(calls))
      calls.forEach((call, index) => {
        if (!isJsonObject(call)) return;
        const input = getMember(call, 'input');
        events.push({
          event: {
            ev: 'tool_use',
            name: member(call, 'name'),
            id: member(call, 'id'),
            input: isJsonObject(input) ? input : jsonObject([]),
            ts: completedTs,
          },
          nativeMemberPath: ['response', 'toolCalls', index],
        });
      });
  }
  // The Python wrapper assigns only after the projection returns. Missing or
  // invalid current IDs preserve a prior ID, including an explicitly seeded value.
  state.zcode_turn_id = lastTurnId;
  return events;
}

export const ZCODE_ADAPTER: TranscriptAdapter<ZcodeState> = Object.freeze({
  id: 'zcode',
  revision: ZCODE_ADAPTER_REVISION,
  matches: matchesZcode,
  createState: createZcodeState,
  cloneState: cloneZcodeState,
  normalize: (row: JsonObject, state: ZcodeState) => ({
    state,
    events: normalizeZcode(row, state),
  }),
});
