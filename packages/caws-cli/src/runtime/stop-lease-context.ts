import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { TextDecoder } from 'node:util';
import { parseJsonSource } from './json-custody';
import {
  RuntimeProtocolError,
  STOP_LEASE_CONTEXT_CAPABILITY,
  type RuntimeRequest,
} from './protocol';

export const STOP_LEASE_CONTEXT_REQUEST = 'caws.runtime.stop-lease-context.request.v1';
export const STOP_LEASE_CONTEXT_RESULT = 'caws.runtime.stop-lease-context.result.v1';
export type StopLeaseContextResult =
  | { readonly status: 'resolved'; readonly commonDir: string }
  | { readonly status: 'git_failed'; readonly commonDir: null };
export interface NativeStopLeaseContextPort {
  /** Fixed consumer 3 only; no caller paths, argv, environment, or deadline. */
  observe(): Promise<StopLeaseContextResult>;
}
export interface StopLeaseContextTransport {
  read(signal: AbortSignal): Promise<Uint8Array>;
  write(frame: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<void>;
}

export function createNativeStopLeaseContextPort(
  request: RuntimeRequest,
  transport: StopLeaseContextTransport,
  signal: AbortSignal
): NativeStopLeaseContextPort {
  if (
    request.stopLeaseContext !== STOP_LEASE_CONTEXT_CAPABILITY ||
    request.configuration !== 'system' ||
    request.surface !== 'opencode' ||
    request.event !== 'stop'
  )
    throw new RuntimeProtocolError('Native Stop lease context unavailable');
  const token = randomUUID();
  const id = request.id,
    runtimeDigest = request.runtimeDigest,
    deadline = request.deadlineEpochMs;
  let used = false;
  const checkpoint = (): void => {
    if (signal.aborted) throw signal.reason;
    if (Date.now() >= deadline) throw new Error('Original Stop lease context deadline expired');
  };
  return Object.freeze({
    async observe(): Promise<StopLeaseContextResult> {
      if (used) throw new RuntimeProtocolError('Stop lease context port already consumed');
      used = true;
      checkpoint();
      // Transport advertisements and this request carry no operation arguments.
      await transport.write(
        { schema: STOP_LEASE_CONTEXT_REQUEST, id, runtimeDigest, token, consumerIndex: 3 },
        signal
      );
      checkpoint();
      const bytes = await transport.read(signal);
      checkpoint();
      if (bytes.byteLength > 8192)
        throw new RuntimeProtocolError('Stop lease context result oversized');
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      parseJsonSource(text, 8, 64, true);
      const value: unknown = JSON.parse(text);
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new RuntimeProtocolError('Invalid Stop lease context result');
      const row = value as Record<string, unknown>;
      const keys = [
        'schema',
        'id',
        'runtimeDigest',
        'token',
        'consumerIndex',
        'status',
        'commonDir',
      ];
      if (
        Object.keys(row).length !== keys.length ||
        keys.some((key) => !Object.hasOwn(row, key)) ||
        row.schema !== STOP_LEASE_CONTEXT_RESULT ||
        row.id !== id ||
        row.runtimeDigest !== runtimeDigest ||
        row.token !== token ||
        row.consumerIndex !== 3
      )
        throw new RuntimeProtocolError('Stop lease context result correlation mismatch');
      if (row.status === 'git_failed' && row.commonDir === null)
        return Object.freeze({ status: 'git_failed', commonDir: null });
      if (
        row.status !== 'resolved' ||
        typeof row.commonDir !== 'string' ||
        !isAbsolute(row.commonDir) ||
        row.commonDir.includes('\0') ||
        Buffer.byteLength(row.commonDir) > 4096
      )
        throw new RuntimeProtocolError('Invalid native Stop common directory');
      return Object.freeze({ status: 'resolved', commonDir: row.commonDir });
    },
  });
}
