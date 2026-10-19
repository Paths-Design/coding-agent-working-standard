import { TextDecoder } from 'node:util';
import type { Readable, Writable } from 'node:stream';
import { MAX_REQUEST_BYTES, RuntimeProtocolError, type RuntimeRequest } from './protocol';

export const READY_SCHEMA = 'caws.runtime.ready.v1';
export const DISPATCH_SCHEMA = 'caws.runtime.dispatch.v1';
export const PROPOSAL_SCHEMA = 'caws.runtime.proposal.v1';
export const HANDOFF_SCHEMA = 'caws.runtime.handoff.v1';
export const FAILURE_SCHEMA = 'caws.runtime.failure.v1';
type Identity = Pick<RuntimeRequest, 'id' | 'runtimeDigest'>;

function control(
  frame: Uint8Array,
  identity: Identity,
  schema: string,
  keys: string[]
): Record<string, unknown> {
  if (frame.byteLength > 4096) throw new RuntimeProtocolError('Control frame exceeds byte limit');
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(frame));
  } catch {
    throw new RuntimeProtocolError('Invalid control frame JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new RuntimeProtocolError('Control frame must be an object');
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(row, key)) ||
    row.schema !== schema ||
    row.id !== identity.id ||
    row.runtimeDigest !== identity.runtimeDigest
  )
    throw new RuntimeProtocolError('Mismatched control frame');
  return row;
}

export function decodeDispatchGrant(frame: Uint8Array, identity: Identity): void {
  control(frame, identity, DISPATCH_SCHEMA, ['schema', 'id', 'runtimeDigest']);
}

export function decodeHandoff(frame: Uint8Array, identity: Identity, token: string): boolean {
  const row = control(frame, identity, HANDOFF_SCHEMA, [
    'schema',
    'id',
    'runtimeDigest',
    'token',
    'success',
  ]);
  if (row.token !== token || typeof row.success !== 'boolean')
    throw new RuntimeProtocolError('Mismatched native handoff');
  return row.success;
}

/** One outstanding read, with bounded per-frame storage; never waits for engine exit. */
export class RuntimeFrameReader {
  private readonly iterator: AsyncIterator<unknown>;
  private pending = Buffer.alloc(0);
  private next: Promise<IteratorResult<unknown>> | null = null;
  constructor(
    stream: Readable,
    private readonly maxBytes = MAX_REQUEST_BYTES
  ) {
    this.iterator = stream[Symbol.asyncIterator]();
  }
  async read(signal?: AbortSignal): Promise<Buffer> {
    for (;;) {
      if (signal?.aborted) throw signal.reason;
      const delimiter = this.pending.indexOf(10);
      if (delimiter >= 0) {
        if (delimiter > this.maxBytes)
          throw new RuntimeProtocolError('Runtime frame exceeds byte limit');
        const result = Buffer.from(this.pending.subarray(0, delimiter));
        this.pending = Buffer.from(this.pending.subarray(delimiter + 1));
        if (!result.length) throw new RuntimeProtocolError('Empty runtime frame');
        return result;
      }
      if (this.pending.length > this.maxBytes)
        throw new RuntimeProtocolError('Runtime frame exceeds byte limit');
      // Preserve an outstanding iterator read on cancellation. A later wire-phase
      // read must consume it rather than starting a second competing stdin read.
      this.next ??= this.iterator.next();
      const next = await abortable(this.next, signal);
      this.next = null;
      if (next.done)
        throw new RuntimeProtocolError('Native protocol ended before a complete frame');
      if (!(next.value instanceof Uint8Array))
        throw new RuntimeProtocolError('Runtime stream must contain bytes');
      const chunk = Buffer.from(next.value);
      // A bounded pipe chunk may contain several frames. Bound queued data as well.
      if (this.pending.length + chunk.length > this.maxBytes + 65_536)
        throw new RuntimeProtocolError('Runtime frame queue exceeds byte limit');
      this.pending = Buffer.concat([this.pending, chunk]);
    }
  }
}

function abortable<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((accept, reject) => {
    const abort = (): void => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    pending.then(accept, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}

/** Completion means local protocol-pipe flush, never native stdout or harness receipt. */
export async function writeRuntimeFrame(
  stream: Writable,
  value: unknown,
  signal: AbortSignal
): Promise<void> {
  if (signal.aborted) throw signal.reason;
  const frame = Buffer.from(JSON.stringify(value) + '\n');
  await new Promise<void>((accept, reject) => {
    let completed = false;
    const fail = (error: unknown): void => {
      if (!completed) {
        completed = true;
        signal.removeEventListener('abort', abort);
        reject(error);
      }
    };
    const abort = (): void => {
      // Keep the stream error listener until its in-flight write settles.
      fail(signal.reason);
    };
    const cleanup = (): void => {
      signal.removeEventListener('abort', abort);
      stream.removeListener('error', fail);
      stream.removeListener('close', closed);
    };
    const closed = (): void => {
      fail(new RuntimeProtocolError('Native protocol output closed'));
      cleanup();
    };
    stream.once('error', fail);
    stream.once('close', closed);
    signal.addEventListener('abort', abort, { once: true });
    stream.write(frame, (error) => {
      if (error) {
        fail(error);
        // Writable emits its error after the write callback.
        setImmediate(cleanup);
      } else {
        cleanup();
        if (!completed) {
          completed = true;
          accept();
        }
      }
    });
    if (signal.aborted) abort();
  });
}
