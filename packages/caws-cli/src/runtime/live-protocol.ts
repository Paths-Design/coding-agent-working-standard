import { TextDecoder, isDeepStrictEqual } from 'node:util';
import * as path from 'node:path';
import { decodeServiceGrant } from './service-client';
import { type NativeRenderAdmission, SERVICE_IMAGE_ADMISSION_SCHEMA } from './service-image';
import type { NativeRenderOffer } from './service-offer';
import type { Readable, Writable } from 'node:stream';
import {
  MAX_REQUEST_BYTES,
  RuntimeProtocolError,
  STOP_PREFIX_CAPABILITY,
  TRANSCRIPT_STORE_CAPABILITY,
  SESSION_PUBLICATION_CAPABILITY,
  type RuntimeRequest,
} from './protocol';
import {
  STORE_JSON_PROFILE,
  STORE_JSON_UNLIMITED_PROFILE,
  type StoreJsonProfile,
} from '../transcripts/store-json';
import { parseJsonSource, objectMemberSource } from './json-custody';
import {
  decodeContainmentReceipt,
  type ContainmentIntent,
  type ContainmentReceipt,
} from './containment';

export const READY_SCHEMA = 'caws.runtime.ready.v1';
export const SERVICE_READY_SCHEMA = 'caws.runtime.ready.v2';
export const DISPATCH_SCHEMA = 'caws.runtime.dispatch.v1';
export const SERVICE_DISPATCH_SCHEMA = 'caws.runtime.dispatch.v2';
export const STOP_DISPATCH_SCHEMA = 'caws.runtime.dispatch.v3';
export const STOP_ADMISSION_SCHEMA = 'caws.runtime.stop-admission.v1';
/** Routing selectors received from the native owner; not a stand-alone authority token. */
export interface NativeStopAdmission {
  readonly schema: typeof STOP_ADMISSION_SCHEMA;
  readonly loggerIndex: 2;
  readonly sqlProfile: StoreJsonProfile;
  readonly rendererProfile:
    | 'cpython3.11-json/int-max-str-digits:4300'
    | 'cpython3.11-json/int-max-str-digits:0';
  readonly rendererIntegerMaxDigits: 4300 | 0;
}
export function isNativeStopAdmission(
  value: NativeRenderAdmission | NativeStopAdmission
): value is NativeStopAdmission {
  return value.schema === STOP_ADMISSION_SCHEMA;
}
export const PROPOSAL_SCHEMA = 'caws.runtime.proposal.v2';
export const HANDOFF_SCHEMA = 'caws.runtime.handoff.v2';
export const FAILURE_SCHEMA = 'caws.runtime.failure.v1';
type Identity = Pick<RuntimeRequest, 'id' | 'runtimeDigest'>;

function control(
  frame: Uint8Array,
  identity: Identity,
  schema: string,
  keys: string[],
  maximum = 4096
): Record<string, unknown> {
  if (frame.byteLength > maximum)
    throw new RuntimeProtocolError('Control frame exceeds byte limit');
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

export function decodeDispatchGrant(
  frame: Uint8Array,
  identity: Identity &
    Partial<
      Pick<
        RuntimeRequest,
        'surface' | 'event' | 'configuration' | 'stopPrefix' | 'sessionStore' | 'sessionPublication'
      >
    >,
  offer?: NativeRenderOffer
): NativeRenderAdmission | NativeStopAdmission | null {
  // Existing v1/v2 validation stays unchanged. Strict Stop control parsing is
  // local to v3 and cannot reinterpret a SessionEnd or renderer grant.
  if (frame.byteLength > (offer ? 2 * 1024 * 1024 : 4096))
    throw new RuntimeProtocolError('Control frame exceeds byte limit');
  let text: string;
  let header: unknown;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(frame);
    header = JSON.parse(text);
  } catch {
    throw new RuntimeProtocolError('Invalid control frame JSON');
  }
  if (
    header &&
    typeof header === 'object' &&
    !Array.isArray(header) &&
    (header as Record<string, unknown>).schema === STOP_DISPATCH_SCHEMA
  ) {
    parseJsonSource(text, 8, 64, true);
    if (
      offer ||
      identity.configuration !== 'system' ||
      identity.surface !== 'opencode' ||
      identity.event !== 'stop' ||
      identity.stopPrefix !== STOP_PREFIX_CAPABILITY ||
      identity.sessionStore !== TRANSCRIPT_STORE_CAPABILITY ||
      identity.sessionPublication !== SESSION_PUBLICATION_CAPABILITY
    )
      throw new RuntimeProtocolError('Native Stop grant disagrees with invocation');
    const row = control(frame, identity, STOP_DISPATCH_SCHEMA, [
      'schema',
      'id',
      'runtimeDigest',
      'nativeStop',
    ]);
    const value = row.nativeStop;
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new RuntimeProtocolError('Missing native Stop selectors');
    const raw = value as Record<string, unknown>;
    if (
      Object.keys(raw).sort().join(',') !==
        'loggerIndex,rendererIntegerMaxDigits,rendererProfile,schema,sqlProfile' ||
      raw.schema !== STOP_ADMISSION_SCHEMA ||
      raw.loggerIndex !== 2 ||
      !(
        (raw.sqlProfile === STORE_JSON_PROFILE &&
          raw.rendererIntegerMaxDigits === 4300 &&
          raw.rendererProfile === 'cpython3.11-json/int-max-str-digits:4300') ||
        (raw.sqlProfile === STORE_JSON_UNLIMITED_PROFILE &&
          raw.rendererIntegerMaxDigits === 0 &&
          raw.rendererProfile === 'cpython3.11-json/int-max-str-digits:0')
      )
    )
      throw new RuntimeProtocolError('Invalid or mismatched native Stop selectors');
    return Object.freeze({ ...raw }) as unknown as NativeStopAdmission;
  }
  if (!offer) {
    control(frame, identity, DISPATCH_SCHEMA, ['schema', 'id', 'runtimeDigest']);
    return null;
  }
  // Reject duplicate object members before native input can name descriptor rights.
  parseJsonSource(new TextDecoder('utf-8', { fatal: true }).decode(frame), 32, 65_536, true);
  const row = control(
    frame,
    identity,
    SERVICE_DISPATCH_SCHEMA,
    ['schema', 'id', 'runtimeDigest', 'renderAdmission'],
    2 * 1024 * 1024
  );
  const raw = row.renderAdmission;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new RuntimeProtocolError('Missing native render admission');
  const admission = raw as Record<string, unknown>;
  if (
    Object.keys(admission).sort().join(',') !==
      'descriptors,gitCommonDirectory,gitDirectory,gitOriginalDirectory,gitWorkTree,grant,image,schema' ||
    admission.schema !== SERVICE_IMAGE_ADMISSION_SCHEMA ||
    !isDeepStrictEqual(admission.descriptors, { transport: 3, grant: 4, receipt: 5 }) ||
    !isDeepStrictEqual(admission.image, {
      imageKey: offer.prepared.imageKey,
      imageDigest: offer.prepared.imageDigest,
      manifest: offer.prepared.manifest,
    })
  )
    throw new RuntimeProtocolError(
      'Native admission differs from prepared image or descriptor contract'
    );
  for (const key of ['gitDirectory', 'gitWorkTree', 'gitOriginalDirectory', 'gitCommonDirectory']) {
    const value = admission[key];
    if (
      typeof value !== 'string' ||
      !path.isAbsolute(value) ||
      path.normalize(value) !== value ||
      Buffer.byteLength(value) > 4096 ||
      /[\0\r\n]/.test(value)
    )
      throw new RuntimeProtocolError('Invalid native Git view path');
  }
  if (admission.gitWorkTree !== offer.checkout)
    throw new RuntimeProtocolError('Native Git view differs from selected checkout');
  const grant = decodeServiceGrant(JSON.stringify(admission.grant));
  if (
    grant.invocationId !== identity.id ||
    grant.canonicalProject !== offer.expectedSelection.canonicalProject ||
    grant.selectedIndex !== offer.expectedSelection.selectedIndex ||
    grant.sourceGeneration !== offer.prepared.manifest.sourceGeneration ||
    grant.executionImage.imageDigest !== offer.prepared.imageDigest
  )
    throw new RuntimeProtocolError('Native grant differs from service offer');
  return Object.freeze({
    ...admission,
    grant,
    descriptors: Object.freeze({ transport: 3, grant: 4, receipt: 5 }),
  }) as unknown as NativeRenderAdmission;
}

export interface NativeHandoff {
  readonly success: boolean;
  readonly containment: ContainmentReceipt | null;
}
export function decodeHandoff(
  frame: Uint8Array,
  identity: Identity,
  token: string,
  expectedContainment: ContainmentIntent | null = null
): NativeHandoff {
  const row = control(
    frame,
    identity,
    HANDOFF_SCHEMA,
    ['schema', 'id', 'runtimeDigest', 'token', 'success', 'containment'],
    64 * 1024
  );
  if (row.token !== token || typeof row.success !== 'boolean')
    throw new RuntimeProtocolError('Mismatched native handoff');
  try {
    const source = parseJsonSource(
      new TextDecoder('utf-8', { fatal: true }).decode(frame),
      16,
      256
    );
    const containment = decodeContainmentReceipt(
      row.containment,
      expectedContainment,
      objectMemberSource(source, 'containment')
    );
    return Object.freeze({ success: row.success, containment });
  } catch (error) {
    throw new RuntimeProtocolError(String(error));
  }
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
