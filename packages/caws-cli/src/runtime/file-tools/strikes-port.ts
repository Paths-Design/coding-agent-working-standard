import { randomBytes } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { objectMemberSource, parseJsonSource } from '../json-custody';
import type { NativeFileToolContextPort } from './context-port';
import { originalNativeFileOperation, readQwenOriginalWrite } from './original-operation';
import {
  GUARD_STRIKES_CAPABILITY,
  GUARD_STRIKES_V2_CAPABILITY,
  FILE_TOOL_CONTEXT_V2_CAPABILITY,
  RuntimeProtocolError,
  type RuntimeRequest,
} from '../protocol';

export const GUARD_STRIKES_REQUEST = 'caws.runtime.guard-strikes.request.v1';
export const GUARD_STRIKES_RESULT = 'caws.runtime.guard-strikes.result.v1';
export const GUARD_STRIKES_V2_REQUEST = 'caws.runtime.guard-strikes.request.v2';
export const GUARD_STRIKES_V2_RESULT = 'caws.runtime.guard-strikes.result.v2';
export const MAX_GUARD_STRIKES_RESULT_BYTES = 4096;
export interface GuardStrikeCommit {
  readonly count: number;
  /** Digest of the committed bytes, not a claim that a later writer cannot change them. */
  readonly stateSha256: string;
}
export interface NativeGuardStrikesPort {
  incrementScopeGuard(): Promise<GuardStrikeCommit>;
  readonly incrementShortcutLanguage?: () => Promise<GuardStrikeCommit>;
}
export interface GuardStrikesTransport {
  read(signal: AbortSignal): Promise<Uint8Array>;
  write(frame: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<void>;
}
const digest = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const fail = (reason: string): RuntimeProtocolError =>
  new RuntimeProtocolError('Native guard strikes: ' + reason);
function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((accept, reject) => {
    const abort = (): void => {
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        accept(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      }
    );
    if (signal.aborted) abort();
  });
}
/** Fixed one-shot increments. Native owns identity, paths, locking and publication.
 * Failed/uncertain operations are consumed; cancellation does not establish publication state.
 */
export function createNativeGuardStrikesPort(
  request: RuntimeRequest,
  transport: GuardStrikesTransport,
  signal: AbortSignal,
  fileContext?: Pick<NativeFileToolContextPort, 'association'>
): NativeGuardStrikesPort {
  const native = request.guardStrikes === GUARD_STRIKES_V2_CAPABILITY;
  if (
    (native
      ? request.fileToolContext !== FILE_TOOL_CONTEXT_V2_CAPABILITY ||
        typeof fileContext?.association !== 'function' ||
        originalNativeFileOperation(request.surface, request.payload.tool_name) === null
      : request.guardStrikes !== GUARD_STRIKES_CAPABILITY || request.surface !== 'codex') ||
    request.event !== 'pre_tool_use' ||
    request.configuration !== 'system' ||
    (!native && !['apply_patch', 'Write', 'Edit'].includes(String(request.payload.tool_name))) ||
    !request.id ||
    request.id.length > 128 ||
    !digest(request.runtimeDigest) ||
    !Number.isSafeInteger(request.deadlineEpochMs) ||
    request.deadlineEpochMs <= 0
  )
    throw fail('capability unavailable');
  if (native && request.surface === 'qwen-code')
    readQwenOriginalWrite(request.inputJson, request.payload);
  const id = request.id,
    runtimeDigest = request.runtimeDigest,
    deadline = request.deadlineEpochMs;
  const token = randomBytes(32).toString('hex');
  const requestSchema = native ? GUARD_STRIKES_V2_REQUEST : GUARD_STRIKES_REQUEST;
  const resultSchema = native ? GUARD_STRIKES_V2_RESULT : GUARD_STRIKES_RESULT;
  const shortcutAvailable =
    native && originalNativeFileOperation(request.surface, request.payload.tool_name) === 'write';
  type Action = 'increment_scope_guard' | 'increment_shortcut_language';
  const used = new Set<Action>();
  let poisoned = false;
  let active: AbortController | null = null;
  const checkpoint = (): void => {
    if (poisoned) throw fail('operation invalidated; no retry');
    if (signal.aborted) throw signal.reason;
    if (Date.now() >= deadline)
      throw fail('original deadline expired; commit may be uncertain; no retry');
  };
  async function increment(action: Action): Promise<GuardStrikeCommit> {
    if (used.has(action) || poisoned || active !== null) {
      poisoned = true;
      const error = fail('operation already consumed; no retry');
      active?.abort(error);
      throw error;
    }
    used.add(action);
    const controller = new AbortController();
    active = controller;
    const abort = (): void => controller.abort(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      checkpoint();
      const association = native ? fileContext!.association!() : undefined;
      const boundToken = association?.token ?? token;
      timer = setTimeout(
        () =>
          controller.abort(fail('original deadline expired; commit may be uncertain; no retry')),
        Math.max(1, deadline - Date.now())
      );
      await abortable(
        transport.write(
          {
            schema: requestSchema,
            id,
            runtimeDigest,
            token: boundToken,
            ...(association
              ? { operation: action, contextSnapshotToken: association.snapshotToken }
              : {}),
          },
          controller.signal
        ),
        controller.signal
      );
      checkpoint();
      const bytes = await abortable(transport.read(controller.signal), controller.signal);
      checkpoint();
      if (bytes.byteLength > MAX_GUARD_STRIKES_RESULT_BYTES)
        throw fail('result exceeds byte bound');
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      const source = parseJsonSource(text, 8, 64, true);
      const value: unknown = JSON.parse(text);
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw fail('invalid result object');
      const row = value as Record<string, unknown>;
      const keys = [
        'schema',
        'id',
        'runtimeDigest',
        'token',
        'count',
        'stateSha256',
        ...(native ? ['operation', 'contextSnapshotToken'] : []),
      ];
      if (
        Object.keys(row).length !== keys.length ||
        keys.some((key) => !Object.hasOwn(row, key)) ||
        row.schema !== resultSchema ||
        (native &&
          (row.operation !== action || row.contextSnapshotToken !== association!.snapshotToken)) ||
        row.id !== id ||
        row.runtimeDigest !== runtimeDigest ||
        row.token !== boundToken ||
        !digest(row.stateSha256)
      )
        throw fail('result correlation mismatch');
      const countSource = objectMemberSource(source, 'count');
      if (
        !countSource ||
        countSource.root.kind !== 'number' ||
        !/^[1-9][0-9]*$/.test(
          countSource.text.slice(countSource.root.start, countSource.root.end)
        ) ||
        typeof row.count !== 'number' ||
        !Number.isSafeInteger(row.count) ||
        row.count < 1
      )
        throw fail('count is not a positive safe canonical integer');
      checkpoint();
      return Object.freeze({ count: row.count, stateSha256: row.stateSha256 });
    } catch (error) {
      poisoned = true;
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      if (active === controller) active = null;
    }
  }
  return Object.freeze({
    incrementScopeGuard: () => increment('increment_scope_guard'),
    ...(shortcutAvailable
      ? { incrementShortcutLanguage: () => increment('increment_shortcut_language') }
      : {}),
  });
}
