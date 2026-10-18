import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import type { AgentSurface } from '../init/hook-packs/types';
import { MACHINE_EVENTS } from '../init/native-hook-identification';
import type { HookEvent, NativeResult } from './types';

export const REQUEST_SCHEMA = 'caws.runtime.request.v1';
export const RESPONSE_SCHEMA = 'caws.runtime.response.v1';
export const MAX_INPUT_BYTES = 1024 * 1024;
export const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
export const MAX_REQUEST_DURATION_MS = 300_000;
const MAX_JSON_DEPTH = 128;
const MAX_JSON_NODES = 100_000;

/** Audited runtime capability subset, not an alternative surface registry. */
const RUNTIME_SURFACES: readonly AgentSurface[] = [
  'codex',
  'claude-code',
  'kimi-code',
  'qwen-code',
  'zcode',
  'opencode',
  'dsh',
];

export interface RuntimeRequest {
  readonly schema: typeof REQUEST_SCHEMA;
  readonly id: string;
  readonly runtimeDigest: string;
  readonly surface: AgentSurface;
  readonly event: HookEvent;
  readonly deadlineEpochMs: number;
  /** Exact native stdin text: hashing a reserialization would lose custody. */
  readonly inputJson: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface RuntimeResponse {
  readonly schema: typeof RESPONSE_SCHEMA;
  readonly id: string;
  readonly runtimeDigest: string;
  readonly result: NativeResult;
}

export class RuntimeProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeProtocolError';
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return (
    Object.keys(value).length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}

function decode(frame: Uint8Array | string, limit: number): unknown {
  const bytes = typeof frame === 'string' ? Buffer.from(frame, 'utf8') : frame;
  if (bytes.byteLength > limit) throw new RuntimeProtocolError('Runtime frame exceeds byte limit');
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new RuntimeProtocolError('Runtime frame must contain valid UTF-8 JSON');
  }
}

/** Compare JSON values without recursive stack growth; reject excessive nesting. */
function sameJson(left: unknown, right: unknown): boolean {
  const pending: [unknown, unknown, number][] = [[left, right, 0]];
  let nodes = 0;
  while (pending.length > 0) {
    const [a, b, depth] = pending.pop() as [unknown, unknown, number];
    if (++nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
      throw new RuntimeProtocolError('Hook input exceeds structural limit');
    }
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
      if (a !== b) return false;
      continue;
    }
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    for (const key of keys) {
      if (!Object.hasOwn(b, key)) return false;
      pending.push([
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key],
        depth + 1,
      ]);
    }
  }
  return true;
}

function freezeJson(value: Record<string, unknown>): Readonly<Record<string, unknown>> {
  const pending: object[] = [value];
  while (pending.length > 0) {
    const next = pending.pop() as object;
    Object.freeze(next);
    for (const child of Object.values(next)) {
      if (child !== null && typeof child === 'object') pending.push(child);
    }
  }
  return value;
}

function identifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 128 &&
    !/[^A-Za-z0-9._:-]/.test(value)
  );
}

function digest(value: unknown): value is string {
  return typeof value === 'string' && value.length === 64 && /^[a-f0-9]{64}$/.test(value);
}

export function decodeRuntimeRequest(
  frame: Uint8Array | string,
  nowEpochMs: number = Date.now()
): RuntimeRequest {
  const value = decode(frame, MAX_REQUEST_BYTES);
  if (
    !record(value) ||
    !exactKeys(value, [
      'schema',
      'id',
      'runtimeDigest',
      'surface',
      'event',
      'deadlineEpochMs',
      'inputJson',
      'payload',
    ]) ||
    value.schema !== REQUEST_SCHEMA
  ) {
    throw new RuntimeProtocolError('Unsupported runtime request envelope');
  }
  if (!identifier(value.id) || !digest(value.runtimeDigest)) {
    throw new RuntimeProtocolError('Invalid runtime request identity');
  }
  if (
    typeof value.surface !== 'string' ||
    !RUNTIME_SURFACES.includes(value.surface as AgentSurface)
  ) {
    throw new RuntimeProtocolError('Unsupported runtime hook surface');
  }
  if (typeof value.event !== 'string' || !Object.hasOwn(MACHINE_EVENTS, value.event)) {
    throw new RuntimeProtocolError('Unsupported runtime hook event');
  }
  if (
    !Number.isSafeInteger(nowEpochMs) ||
    typeof value.deadlineEpochMs !== 'number' ||
    !Number.isSafeInteger(value.deadlineEpochMs) ||
    value.deadlineEpochMs <= nowEpochMs ||
    value.deadlineEpochMs - nowEpochMs > MAX_REQUEST_DURATION_MS
  ) {
    throw new RuntimeProtocolError('Invalid or expired runtime request deadline');
  }
  if (
    typeof value.inputJson !== 'string' ||
    Buffer.byteLength(value.inputJson, 'utf8') > MAX_INPUT_BYTES
  ) {
    throw new RuntimeProtocolError('Hook input exceeds byte limit or is unavailable');
  }
  if (Buffer.from(value.inputJson, 'utf8').toString('utf8') !== value.inputJson) {
    throw new RuntimeProtocolError('Original hook input must represent valid UTF-8 bytes');
  }
  const payload = decode(value.inputJson, MAX_INPUT_BYTES);
  if (!record(payload) || !record(value.payload) || !sameJson(payload, value.payload)) {
    throw new RuntimeProtocolError('Hook payload does not match original native input');
  }
  return Object.freeze({
    schema: REQUEST_SCHEMA,
    id: value.id,
    runtimeDigest: value.runtimeDigest,
    surface: value.surface as AgentSurface,
    event: value.event as HookEvent,
    deadlineEpochMs: value.deadlineEpochMs,
    inputJson: value.inputJson,
    payload: freezeJson(payload),
  });
}

export function nativeInputDigest(request: RuntimeRequest): string {
  return createHash('sha256').update(request.inputJson, 'utf8').digest('hex');
}

function nativeResult(value: unknown): value is NativeResult {
  return (
    record(value) &&
    exactKeys(value, ['exitCode', 'stdout', 'stderr']) &&
    typeof value.exitCode === 'number' &&
    Number.isInteger(value.exitCode) &&
    value.exitCode >= 0 &&
    value.exitCode <= 255 &&
    typeof value.stdout === 'string' &&
    typeof value.stderr === 'string'
  );
}

export function decodeRuntimeResponse(
  frame: Uint8Array | string,
  expected: Pick<RuntimeRequest, 'id' | 'runtimeDigest'>
): RuntimeResponse {
  const value = decode(frame, MAX_RESPONSE_BYTES);
  if (
    !record(value) ||
    !exactKeys(value, ['schema', 'id', 'runtimeDigest', 'result']) ||
    value.schema !== RESPONSE_SCHEMA ||
    value.id !== expected.id ||
    value.runtimeDigest !== expected.runtimeDigest ||
    !nativeResult(value.result)
  ) {
    throw new RuntimeProtocolError('Invalid or mismatched runtime response');
  }
  return Object.freeze({
    schema: RESPONSE_SCHEMA,
    id: value.id as string,
    runtimeDigest: value.runtimeDigest as string,
    result: Object.freeze(value.result),
  });
}

export function encodeRuntimeResponse(
  request: Pick<RuntimeRequest, 'id' | 'runtimeDigest'>,
  result: NativeResult
): string {
  const frame =
    JSON.stringify({
      schema: RESPONSE_SCHEMA,
      id: request.id,
      runtimeDigest: request.runtimeDigest,
      result,
    }) + '\n';
  decodeRuntimeResponse(frame, request);
  return frame;
}
