import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import type { AgentSurface } from '../init/hook-packs/types';
import { MACHINE_EVENTS } from '../init/native-hook-identification';
import type { HookEvent, NativeResult, NativeTextResult } from './types';
import { invocationCaller, type InvocationCaller } from './context';
import { CONTEXT_GIT_CAPABILITY } from './context-git-wire';
import {
  objectMemberSource,
  parseJsonSource,
  sameJsonSource,
  type JsonSource,
} from './json-custody';

export const REQUEST_SCHEMA = 'caws.runtime.request.v1';
export const RESPONSE_SCHEMA = 'caws.runtime.response.v1';
export const SESSION_CACHE_CAPABILITY = 'caws.runtime.session-cache.v1';
export const SESSION_END_PREFIX_CAPABILITY = 'caws.runtime.session-end-prefix.v1';
export const TRANSCRIPT_STORE_CAPABILITY = 'caws.runtime.transcript-store.v1';
export const SESSION_PUBLICATION_CAPABILITY = 'caws.runtime.session-publication.v1';
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
  readonly configuration: 'system' | 'project';
  /** Native-owned finite project resolution before Ready; absent on older frontends. */
  readonly contextGit?: typeof CONTEXT_GIT_CAPABILITY;
  /** Native-owned one-shot cache exchange; older frontends omit this capability. */
  readonly sessionCache?: typeof SESSION_CACHE_CAPABILITY;
  /** Complete native SessionEnd prefix; the older cache capability is insufficient. */
  readonly sessionEndPrefix?: typeof SESSION_END_PREFIX_CAPABILITY;
  /** Optional finite native query profile; this does not select a stock consumer. */
  readonly sessionStore?: typeof TRANSCRIPT_STORE_CAPABILITY;
  /** Native-owned publication exchange; prepared bytes confer no path authority. */
  readonly sessionPublication?: typeof SESSION_PUBLICATION_CAPABILITY;
  /** Ephemeral native caller snapshot: never include in durable request journals. */
  readonly caller: InvocationCaller & { readonly processId: number };
  readonly deadlineEpochMs: number;
  /** Exact native stdin text: hashing a reserialization would lose custody. */
  readonly inputJson: string;
  /** Convenience projection for audited fields; forward extensions from inputJson source spans. */
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

function protocolSource(
  text: string,
  maxDepth: number,
  maxNodes: number,
  rejectDuplicates: boolean | 'root' = false
): JsonSource {
  try {
    return parseJsonSource(text, maxDepth, maxNodes, rejectDuplicates);
  } catch (error) {
    throw new RuntimeProtocolError(error instanceof Error ? error.message : 'Invalid JSON source');
  }
}

/** Validate wire spelling before the decoded-number checks enforce each field's bounds. */
function canonicalInteger(source: JsonSource | undefined): boolean {
  if (!source) return false;
  return /^(0|[1-9][0-9]*)$/.test(source.text.slice(source.root.start, source.root.end));
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
      'configuration',
      'caller',
      'deadlineEpochMs',
      'inputJson',
      'payload',
      ...(Object.hasOwn(value, 'contextGit') ? ['contextGit'] : []),
      ...(Object.hasOwn(value, 'sessionCache') ? ['sessionCache'] : []),
      ...(Object.hasOwn(value, 'sessionEndPrefix') ? ['sessionEndPrefix'] : []),
      ...(Object.hasOwn(value, 'sessionStore') ? ['sessionStore'] : []),
      ...(Object.hasOwn(value, 'sessionPublication') ? ['sessionPublication'] : []),
    ]) ||
    value.schema !== REQUEST_SCHEMA
  ) {
    throw new RuntimeProtocolError('Unsupported runtime request envelope');
  }
  if (!identifier(value.id) || !digest(value.runtimeDigest)) {
    throw new RuntimeProtocolError('Invalid runtime request identity');
  }
  if (Object.hasOwn(value, 'contextGit') && value.contextGit !== CONTEXT_GIT_CAPABILITY)
    throw new RuntimeProtocolError('Unsupported context Git capability');
  if (Object.hasOwn(value, 'sessionCache') && value.sessionCache !== SESSION_CACHE_CAPABILITY)
    throw new RuntimeProtocolError('Unsupported session cache capability');
  if (
    Object.hasOwn(value, 'sessionEndPrefix') &&
    value.sessionEndPrefix !== SESSION_END_PREFIX_CAPABILITY
  )
    throw new RuntimeProtocolError('Unsupported SessionEnd prefix capability');
  if (Object.hasOwn(value, 'sessionStore') && value.sessionStore !== TRANSCRIPT_STORE_CAPABILITY)
    throw new RuntimeProtocolError('Unsupported transcript store capability');
  if (
    Object.hasOwn(value, 'sessionPublication') &&
    value.sessionPublication !== SESSION_PUBLICATION_CAPABILITY
  )
    throw new RuntimeProtocolError('Unsupported session publication capability');
  const wireText = new TextDecoder('utf-8', { fatal: true }).decode(
    typeof frame === 'string' ? Buffer.from(frame, 'utf8') : frame
  );
  // Control envelope identity/capabilities cannot be hidden by last-key wins.
  // Opaque hook payloads retain their independent nested duplicate-key profile.
  const wireSource = protocolSource(wireText, MAX_JSON_DEPTH + 2, MAX_JSON_NODES * 2, 'root');
  const callerSource = objectMemberSource(wireSource, 'caller');
  const processSource = callerSource ? objectMemberSource(callerSource, 'processId') : undefined;
  if (
    typeof value.surface !== 'string' ||
    !RUNTIME_SURFACES.includes(value.surface as AgentSurface)
  ) {
    throw new RuntimeProtocolError('Unsupported runtime hook surface');
  }
  if (typeof value.event !== 'string' || !Object.hasOwn(MACHINE_EVENTS, value.event)) {
    throw new RuntimeProtocolError('Unsupported runtime hook event');
  }
  if (!['system', 'project'].includes(value.configuration as string))
    throw new RuntimeProtocolError('Unsupported runtime entry configuration');
  if (
    !record(value.caller) ||
    !exactKeys(value.caller, ['cwd', 'environment', 'processId']) ||
    !canonicalInteger(processSource) ||
    !Number.isSafeInteger(value.caller.processId) ||
    (value.caller.processId as number) <= 0 ||
    (value.caller.processId as number) > 2_147_483_647 ||
    typeof value.caller.cwd !== 'string' ||
    !record(value.caller.environment) ||
    Object.values(value.caller.environment).some((entry) => typeof entry !== 'string')
  )
    throw new RuntimeProtocolError('Invalid native caller snapshot');
  let caller: InvocationCaller;
  try {
    caller = invocationCaller(value.caller.cwd, value.caller.environment as Record<string, string>);
  } catch {
    throw new RuntimeProtocolError('Invalid native caller snapshot');
  }
  if (
    !Number.isSafeInteger(nowEpochMs) ||
    !canonicalInteger(objectMemberSource(wireSource, 'deadlineEpochMs')) ||
    typeof value.deadlineEpochMs !== 'number' ||
    !Number.isSafeInteger(value.deadlineEpochMs) ||
    value.deadlineEpochMs <= 0 ||
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
  const payload = value.inputJson === '' ? {} : decode(value.inputJson, MAX_INPUT_BYTES);
  if (!record(payload) || !record(value.payload)) {
    throw new RuntimeProtocolError('Hook payload does not match original native input');
  }
  const source = protocolSource(value.inputJson || '{}', MAX_JSON_DEPTH, MAX_JSON_NODES);
  const wire = objectMemberSource(wireSource, 'payload');
  if (!wire || !sameJsonSource(source, wire))
    throw new RuntimeProtocolError('Hook payload does not match original native input');
  return Object.freeze({
    schema: REQUEST_SCHEMA,
    id: value.id,
    runtimeDigest: value.runtimeDigest,
    surface: value.surface as AgentSurface,
    event: value.event as HookEvent,
    configuration: value.configuration as 'system' | 'project',
    ...(value.contextGit === CONTEXT_GIT_CAPABILITY ? { contextGit: CONTEXT_GIT_CAPABILITY } : {}),
    ...(value.sessionCache === SESSION_CACHE_CAPABILITY
      ? { sessionCache: SESSION_CACHE_CAPABILITY }
      : {}),
    ...(value.sessionEndPrefix === SESSION_END_PREFIX_CAPABILITY
      ? { sessionEndPrefix: SESSION_END_PREFIX_CAPABILITY }
      : {}),
    ...(value.sessionStore === TRANSCRIPT_STORE_CAPABILITY
      ? { sessionStore: TRANSCRIPT_STORE_CAPABILITY }
      : {}),
    ...(value.sessionPublication === SESSION_PUBLICATION_CAPABILITY
      ? { sessionPublication: SESSION_PUBLICATION_CAPABILITY }
      : {}),
    caller: Object.freeze({ ...caller, processId: value.caller.processId as number }),
    deadlineEpochMs: value.deadlineEpochMs,
    inputJson: value.inputJson,
    payload: freezeJson(payload),
  });
}

export function nativeInputDigest(request: RuntimeRequest): string {
  return createHash('sha256').update(request.inputJson, 'utf8').digest('hex');
}

function decodeNativeBytes(value: unknown): Buffer | null {
  if (typeof value !== 'string' || value.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(value))
    return null;
  const bytes = Buffer.from(value, 'base64');
  return bytes.toString('base64') === value ? bytes : null;
}

function nativeResult(value: unknown): NativeResult | null {
  if (
    !record(value) ||
    !exactKeys(value, ['exitCode', 'stdoutBase64', 'stderrBase64']) ||
    typeof value.exitCode !== 'number' ||
    !Number.isInteger(value.exitCode) ||
    value.exitCode < 0 ||
    value.exitCode > 255
  )
    return null;
  const stdout = decodeNativeBytes(value.stdoutBase64);
  const stderr = decodeNativeBytes(value.stderrBase64);
  return stdout !== null && stderr !== null ? { exitCode: value.exitCode, stdout, stderr } : null;
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
    value.runtimeDigest !== expected.runtimeDigest
  ) {
    throw new RuntimeProtocolError('Invalid or mismatched runtime response');
  }
  const result = nativeResult(value.result);
  if (result === null)
    throw new RuntimeProtocolError('Invalid or mismatched binary runtime result');
  return Object.freeze({
    schema: RESPONSE_SCHEMA,
    id: value.id as string,
    runtimeDigest: value.runtimeDigest as string,
    result: Object.freeze(result),
  });
}

export function encodeRuntimeResponse(
  request: Pick<RuntimeRequest, 'id' | 'runtimeDigest'>,
  result: NativeResult | NativeTextResult
): string {
  const bytes = (value: Uint8Array | string): Buffer =>
    typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value);
  const frame =
    JSON.stringify({
      schema: RESPONSE_SCHEMA,
      id: request.id,
      runtimeDigest: request.runtimeDigest,
      result: {
        exitCode: result.exitCode,
        stdoutBase64: bytes(result.stdout).toString('base64'),
        stderrBase64: bytes(result.stderr).toString('base64'),
      },
    }) + '\n';
  decodeRuntimeResponse(frame, request);
  return frame;
}
