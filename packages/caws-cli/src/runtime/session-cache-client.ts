import { randomUUID } from 'node:crypto';
import { isAbsolute, normalize } from 'node:path';
import { TextDecoder } from 'node:util';
import { parseJsonSource } from './json-custody';
import { parsePythonJson } from '../transcripts/lossless-json';
import { RuntimeProtocolError, SESSION_CACHE_CAPABILITY, type RuntimeRequest } from './protocol';

export { SESSION_CACHE_CAPABILITY } from './protocol';
const REQUEST = 'caws.runtime.session-cache.request.v1';
const PREVIOUS = 'caws.runtime.session-cache.previous.v1';
const DECISION = 'caws.runtime.session-cache.decision.v1';
const RESULT = 'caws.runtime.session-cache.result.v1';
const MAX_PREVIOUS_FRAME = 90_112;
const MAX_RESULT_FRAME = 32_768;
const MAX_EXISTING_BYTES = 65_536;
const MAX_DIAGNOSTIC_BYTES = 4_096;

export interface SessionCacheResult {
  readonly status: 'captured' | 'skipped' | 'declined' | 'unavailable';
  readonly envelopePublished: boolean;
  readonly diagnostic: string | null;
}
export interface NativeSessionCachePort {
  /** Declined alone permits full compatibility; a lost response must never replay. */
  capture(canonicalRoot: string): Promise<SessionCacheResult>;
}
export interface SessionCacheTransport {
  read(signal: AbortSignal): Promise<Uint8Array>;
  write(frame: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<void>;
}

/** Numeric tokens in the original parser input can change even unused-field
 * admission across Python profiles. Decline before effects instead of choosing
 * a global digit cap; the callback also sees overwritten occurrences.
 */
export function sessionCacheInputSupported(inputJson: string): boolean {
  try {
    parsePythonJson(inputJson || '{}', {
      admitNumberToken() {
        throw new Error('Original parser numeric profile requires compatibility');
      },
    });
    return true;
  } catch {
    return false;
  }
}

/** A deliberately finite old-envelope profile. Unsupported data is left to the
 * complete compatibility dispatcher before either cache target is published.
 * This does not select a production Python numeric, recursion or Unicode profile.
 */
export function decideSessionCacheCreation(
  bytes: Uint8Array | null,
  suppliedSessionId: string
): { readonly action: 'capture' | 'decline'; readonly createdUnits: readonly number[] | null } {
  if (bytes === null) return { action: 'capture', createdUnits: null };
  try {
    if (bytes.byteLength > MAX_EXISTING_BYTES) throw new Error('Unsupported old envelope size');
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    const { root } = parseJsonSource(text, 16, 1_024, true);
    if (root.kind !== 'object') throw new Error('Unsupported old envelope shape');
    // Reject even unused containers/numbers and duplicate keys. Do not let
    // last-key projection hide an unsupported earlier value.
    for (const value of root.entries.values())
      if (value.kind !== 'scalar' || typeof value.value !== 'string')
        throw new Error('Unsupported old envelope value');
    const sid = root.entries.get('session_id');
    const created = root.entries.get('created_at');
    const retained =
      sid?.kind === 'scalar' &&
      sid.value === suppliedSessionId &&
      created?.kind === 'scalar' &&
      typeof created.value === 'string' &&
      created.value.length > 0
        ? created.value
        : null;
    return {
      action: 'capture',
      createdUnits:
        retained === null
          ? null
          : Array.from({ length: retained.length }, (_, index) => retained.charCodeAt(index)),
    };
  } catch {
    return { action: 'decline', createdUnits: null };
  }
}

function decodeControl(
  bytes: Uint8Array,
  request: Pick<RuntimeRequest, 'id' | 'runtimeDigest'>,
  token: string
): Record<string, unknown> {
  if (bytes.byteLength > MAX_PREVIOUS_FRAME)
    throw new RuntimeProtocolError('Session cache frame exceeds byte limit');
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  parseJsonSource(text, 8, 32, true);
  const row: unknown = JSON.parse(text);
  if (
    !row ||
    typeof row !== 'object' ||
    Array.isArray(row) ||
    (row as Record<string, unknown>).id !== request.id ||
    (row as Record<string, unknown>).runtimeDigest !== request.runtimeDigest ||
    (row as Record<string, unknown>).token !== token
  )
    throw new RuntimeProtocolError('Mismatched session cache frame');
  return row as Record<string, unknown>;
}

function keys(row: Record<string, unknown>, expected: readonly string[]): boolean {
  return (
    Object.keys(row).length === expected.length && expected.every((key) => Object.hasOwn(row, key))
  );
}
function terminal(row: Record<string, unknown>, bytes: number): SessionCacheResult {
  if (
    bytes > MAX_RESULT_FRAME ||
    !keys(row, [
      'schema',
      'id',
      'runtimeDigest',
      'token',
      'status',
      'envelopePublished',
      'diagnostic',
    ]) ||
    row.schema !== RESULT ||
    !['captured', 'skipped', 'declined', 'unavailable'].includes(row.status as string) ||
    typeof row.envelopePublished !== 'boolean'
  )
    throw new RuntimeProtocolError('Invalid session cache result');
  const { status, envelopePublished, diagnostic } = row;
  if (
    (status === 'captured' && (!envelopePublished || diagnostic !== null)) ||
    (status === 'skipped' && (envelopePublished || diagnostic !== null)) ||
    (status === 'declined' && envelopePublished) ||
    ((status === 'declined' || status === 'unavailable') &&
      (typeof diagnostic !== 'string' ||
        !diagnostic ||
        Buffer.byteLength(diagnostic) > MAX_DIAGNOSTIC_BYTES))
  )
    throw new RuntimeProtocolError('Inconsistent session cache result');
  return Object.freeze({ status, envelopePublished, diagnostic }) as SessionCacheResult;
}

/** Shares the engine entry's sole framed reader and deadline. No separate FD,
 * process, identity lookup, retry or filesystem operation is introduced here.
 */
export function createNativeSessionCachePort(
  request: RuntimeRequest,
  transport: SessionCacheTransport,
  signal: AbortSignal
): NativeSessionCachePort {
  let used = false;
  return Object.freeze({
    async capture(canonicalRoot: string): Promise<SessionCacheResult> {
      if (used) throw new RuntimeProtocolError('Session cache operation is single-use');
      used = true;
      if (signal.aborted) throw signal.reason;
      if (
        !isAbsolute(canonicalRoot) ||
        normalize(canonicalRoot) !== canonicalRoot ||
        (canonicalRoot !== '/' && canonicalRoot.endsWith('/')) ||
        Buffer.byteLength(canonicalRoot) > 4096 ||
        /[\x00-\x1f\x7f-\x9f]/.test(canonicalRoot)
      )
        throw new RuntimeProtocolError('Invalid session cache root');
      if (
        request.surface !== 'codex' ||
        request.event !== 'pre_tool_use' ||
        request.configuration !== 'system' ||
        request.sessionCache !== SESSION_CACHE_CAPABILITY
      )
        throw new RuntimeProtocolError('Unsupported session cache invocation');
      const token = randomUUID();
      const identity = { id: request.id, runtimeDigest: request.runtimeDigest, token };
      await transport.write({ schema: REQUEST, ...identity, canonicalRoot }, signal);
      const first = await transport.read(signal);
      const row = decodeControl(first, request, token);
      if (row.schema === RESULT) {
        const result = terminal(row, first.byteLength);
        if (result.status === 'captured' || result.envelopePublished)
          throw new RuntimeProtocolError('Session cache publication preceded interpretation');
        return result;
      }
      if (
        row.schema !== PREVIOUS ||
        !keys(row, ['schema', 'id', 'runtimeDigest', 'token', 'existingBase64']) ||
        (row.existingBase64 !== null && typeof row.existingBase64 !== 'string')
      )
        throw new RuntimeProtocolError('Invalid previous session cache frame');
      let previous: Buffer | null = null;
      if (typeof row.existingBase64 === 'string') {
        previous = Buffer.from(row.existingBase64, 'base64');
        if (
          previous.byteLength > MAX_EXISTING_BYTES ||
          previous.toString('base64') !== row.existingBase64
        )
          throw new RuntimeProtocolError('Invalid previous session cache encoding');
      }
      const supplied = request.payload.session_id;
      if (typeof supplied !== 'string')
        throw new RuntimeProtocolError('Previous session cache lacks supplied identity');
      const decision = decideSessionCacheCreation(previous, supplied);
      await transport.write({ schema: DECISION, ...identity, ...decision }, signal);
      const last = await transport.read(signal);
      const result = terminal(decodeControl(last, request, token), last.byteLength);
      if (decision.action === 'decline' && result.status !== 'declined')
        throw new RuntimeProtocolError('Session cache decline was not confirmed');
      if (
        decision.action === 'capture' &&
        (result.status === 'skipped' || result.status === 'declined')
      )
        throw new RuntimeProtocolError('Unexpected session cache decision result');
      return result;
    },
  });
}
