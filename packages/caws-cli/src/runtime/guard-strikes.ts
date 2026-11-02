import { randomBytes } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { objectMemberSource, parseJsonSource } from './json-custody';
import { GUARD_STRIKES_CAPABILITY, RuntimeProtocolError, type RuntimeRequest } from './protocol';

export const GUARD_STRIKES_REQUEST = 'caws.runtime.guard-strikes.request.v1';
export const GUARD_STRIKES_RESULT = 'caws.runtime.guard-strikes.result.v1';
export const MAX_GUARD_STRIKES_RESULT_BYTES = 4096;
export interface GuardStrikeCommit {
  readonly count: number;
  /** Digest of the committed bytes, not a claim that a later writer cannot change them. */
  readonly stateSha256: string;
}
export interface NativeGuardStrikesPort {
  incrementScopeGuard(): Promise<GuardStrikeCommit>;
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
/** One fixed scope_guard increment. Native owns identity, paths, locking and publication.
 * Failed/uncertain operations are consumed; cancellation does not establish publication state.
 */
export function createNativeGuardStrikesPort(
  request: RuntimeRequest,
  transport: GuardStrikesTransport,
  signal: AbortSignal
): NativeGuardStrikesPort {
  if (
    request.guardStrikes !== GUARD_STRIKES_CAPABILITY ||
    request.surface !== 'codex' ||
    request.event !== 'pre_tool_use' ||
    request.configuration !== 'system' ||
    !['apply_patch', 'Write', 'Edit'].includes(String(request.payload.tool_name)) ||
    !request.id ||
    request.id.length > 128 ||
    !digest(request.runtimeDigest) ||
    !Number.isSafeInteger(request.deadlineEpochMs) ||
    request.deadlineEpochMs <= 0
  )
    throw fail('capability unavailable');
  const id = request.id,
    runtimeDigest = request.runtimeDigest,
    deadline = request.deadlineEpochMs;
  const token = randomBytes(32).toString('hex');
  let used = false,
    poisoned = false;
  let active: AbortController | null = null;
  const checkpoint = (): void => {
    if (poisoned) throw fail('operation invalidated; no retry');
    if (signal.aborted) throw signal.reason;
    if (Date.now() >= deadline)
      throw fail('original deadline expired; commit may be uncertain; no retry');
  };
  return Object.freeze({
    async incrementScopeGuard(): Promise<GuardStrikeCommit> {
      if (used || poisoned) {
        poisoned = true;
        const error = fail('operation already consumed; no retry');
        active?.abort(error);
        throw error;
      }
      used = true;
      const controller = new AbortController();
      active = controller;
      const abort = (): void => controller.abort(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        checkpoint();
        timer = setTimeout(
          () =>
            controller.abort(fail('original deadline expired; commit may be uncertain; no retry')),
          Math.max(1, deadline - Date.now())
        );
        await abortable(
          transport.write(
            { schema: GUARD_STRIKES_REQUEST, id, runtimeDigest, token },
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
        const keys = ['schema', 'id', 'runtimeDigest', 'token', 'count', 'stateSha256'];
        if (
          Object.keys(row).length !== keys.length ||
          keys.some((key) => !Object.hasOwn(row, key)) ||
          row.schema !== GUARD_STRIKES_RESULT ||
          row.id !== id ||
          row.runtimeDigest !== runtimeDigest ||
          row.token !== token ||
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
    },
  });
}
