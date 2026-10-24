/** Observed selection computation; no native admission or publication authority. */
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import {
  isCanonicalRuntimeVerifier,
  validateRuntimeGenerationManifest,
} from '../init/machine-runtime-state';
import { parseJsonSource } from './json-custody';
import { awaitSessionPublicationCallback } from './committed-session-reader';
import {
  decodeSelectionObservationAdvertisement,
  RuntimeProtocolError,
  type RuntimeRequest,
} from './protocol';
import {
  needSelectionObservation,
  missingSelectionObservation,
  type SelectionFileInfo,
  type SelectionPathIdentity,
  type SelectionReadIo,
  type SelectionReadOperation,
  type SelectionReadResult,
  type SelectionRuntimeVerifier,
} from '../init/selection-read-io';
import {
  resolveInvocationSelection,
  type InvocationSelection,
  type SelectionOptions,
} from './selection';

export interface SelectionObservationLimits {
  readonly maximumObservations: number;
  readonly maximumBytes: number;
  readonly maximumPathBytes: number;
}
export interface SelectionObservation {
  readonly snapshotId: string;
  readonly sequence: number;
  readonly observationId: string;
  readonly operation: SelectionReadOperation;
  readonly result: SelectionReadResult;
}
export interface SelectionObservationRequest {
  readonly snapshotId: string;
  readonly sequence: number;
  readonly operation: SelectionReadOperation;
}
export interface VerifiedSelectionRuntimeSnapshot {
  readonly snapshotId: string;
  readonly home: string;
  readonly digest: string;
  readonly observations: readonly SelectionObservation[];
  readonly manifest: Readonly<Record<string, string>>;
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}
function identity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}
function operationKey(operation: SelectionReadOperation): string {
  return JSON.stringify([operation.kind, operation.path, operation.singleLink ?? false]);
}
function requireOperation(
  value: unknown,
  maximumPathBytes: number
): asserts value is SelectionReadOperation {
  if (
    !object(value) ||
    !exact(value, [
      'kind',
      'path',
      ...(Object.hasOwn(value, 'singleLink') ? ['singleLink'] : []),
    ]) ||
    ![
      'lstat',
      'path-identity',
      'stat',
      'exists',
      'read',
      'list',
      'executable',
      'runtime-file',
      'runtime-digest',
      'runtime-generation',
    ].includes(String(value.kind)) ||
    typeof value.path !== 'string' ||
    !path.isAbsolute(value.path) ||
    value.path.includes('\0') ||
    Buffer.byteLength(value.path) > maximumPathBytes ||
    (Object.hasOwn(value, 'singleLink') &&
      (!['runtime-file', 'runtime-digest'].includes(String(value.kind)) ||
        typeof value.singleLink !== 'boolean'))
  )
    throw new TypeError('Invalid selection read operation');
}
function requireInfo(value: unknown): asserts value is SelectionFileInfo {
  if (
    !object(value) ||
    !exact(value, ['kind', 'dev', 'ino', 'size', 'mode', 'nlink', 'mtimeMs', 'ctimeMs']) ||
    !['file', 'directory', 'symlink', 'other'].includes(String(value.kind)) ||
    typeof value.dev !== 'string' ||
    !/^[0-9]+$/.test(value.dev) ||
    typeof value.ino !== 'string' ||
    !/^[0-9]+$/.test(value.ino) ||
    ![value.size, value.mode, value.nlink].every(
      (item) => typeof item === 'number' && Number.isSafeInteger(item) && item >= 0
    ) ||
    ![value.mtimeMs, value.ctimeMs].every(
      (item) => typeof item === 'number' && Number.isFinite(item)
    )
  )
    throw new TypeError('Invalid selection file information');
}
function requirePathIdentity(value: unknown): asserts value is SelectionPathIdentity {
  if (
    !object(value) ||
    !exact(value, ['kind', 'dev', 'ino', 'mode']) ||
    !['file', 'directory', 'symlink', 'other'].includes(String(value.kind)) ||
    typeof value.dev !== 'string' ||
    !/^[0-9]+$/.test(value.dev) ||
    typeof value.ino !== 'string' ||
    !/^[0-9]+$/.test(value.ino) ||
    typeof value.mode !== 'number' ||
    !Number.isSafeInteger(value.mode) ||
    value.mode < 0
  )
    throw new TypeError('Invalid selection path identity');
}
function requireBase64(value: unknown): asserts value is string {
  if (typeof value !== 'string' || Buffer.from(value, 'base64').toString('base64') !== value)
    throw new TypeError('Invalid selection byte encoding');
}
function requireResult(
  value: unknown,
  operation: SelectionReadOperation
): asserts value is SelectionReadResult {
  if (!object(value)) throw new TypeError('Invalid selection observation result');
  if (value.kind === 'error') {
    if (
      !exact(value, [
        'kind',
        'name',
        'message',
        ...(Object.hasOwn(value, 'code') ? ['code'] : []),
      ]) ||
      typeof value.name !== 'string' ||
      typeof value.message !== 'string' ||
      (Object.hasOwn(value, 'code') && typeof value.code !== 'string')
    )
      throw new TypeError('Invalid selection observed error');
    return;
  }
  switch (operation.kind) {
    case 'path-identity':
      if (value.kind !== 'path-identity' || !exact(value, ['kind', 'value'])) break;
      requirePathIdentity(value.value);
      return;
    case 'lstat':
    case 'stat':
      if (value.kind !== 'info' || !exact(value, ['kind', 'value'])) break;
      requireInfo(value.value);
      return;
    case 'exists':
      if (
        value.kind === 'exists' &&
        exact(value, ['kind', 'value']) &&
        typeof value.value === 'boolean'
      )
        return;
      break;
    case 'read':
      if (value.kind !== 'bytes' || !exact(value, ['kind', 'base64'])) break;
      requireBase64(value.base64);
      return;
    case 'list':
      if (
        value.kind === 'listing' &&
        exact(value, ['kind', 'entries']) &&
        Array.isArray(value.entries) &&
        value.entries.every(
          (item) =>
            typeof item === 'string' &&
            item.length > 0 &&
            !item.includes('/') &&
            !item.includes('\0') &&
            item !== '.' &&
            item !== '..'
        ) &&
        new Set(value.entries).size === value.entries.length
      )
        return;
      break;
    case 'executable':
      if (value.kind === 'executable' && exact(value, ['kind'])) return;
      break;
    case 'runtime-generation':
      if (value.kind !== 'runtime-generation' || !exact(value, ['kind', 'digest', 'manifest']))
        break;
      validateRuntimeGenerationManifest(
        value.digest as string,
        value.digest,
        operation.path,
        value.manifest
      );
      return;
    case 'runtime-digest':
      if (
        value.kind !== 'runtime-digest' ||
        !exact(value, ['kind', 'sha256', 'stat']) ||
        typeof value.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(value.sha256)
      )
        break;
      requireInfo(value.stat);
      if (value.stat.kind !== 'file' || (operation.singleLink && value.stat.nlink !== 1)) break;
      return;
    case 'runtime-file':
      if (value.kind !== 'runtime-file' || !exact(value, ['kind', 'base64', 'stat'])) break;
      requireBase64(value.base64);
      requireInfo(value.stat);
      if (
        value.stat.kind !== 'file' ||
        (operation.singleLink && value.stat.nlink !== 1) ||
        Buffer.from(value.base64, 'base64').length !== value.stat.size
      )
        break;
      return;
  }
  throw new TypeError('Selection observation result does not match its operation');
}
function freezeData(value: unknown): void {
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) freezeData(item);
    Object.freeze(value);
  }
}
function observedError(result: Extract<SelectionReadResult, { kind: 'error' }>): Error {
  const constructors: Record<string, new (message: string) => Error> = {
    Error,
    TypeError,
    RangeError,
    SyntaxError,
  };
  const Constructor = Object.hasOwn(constructors, result.name) ? constructors[result.name]! : Error;
  const error = new Constructor(result.message);
  error.name = result.name;
  if (result.code !== undefined) (error as NodeJS.ErrnoException).code = result.code;
  return error;
}

/** Incremental discovery owns immutable records; seal closes discovery.
 * Reads are ordered observations, not an atomic filesystem snapshot. Capture
 * coherence and admission-time revalidation belong to the native owner; this
 * computation grants no freshness or publication authority.
 */
// Only createNativeSelectionResolver enables this private mode. Public
// snapshots and tooling never acquire the summary shortcut from recorded data,
// constructor options, verifier output, or a matching public field.
const nativeGenerationSnapshots = new WeakSet<SelectionObservationSnapshot>();

export class SelectionObservationSnapshot {
  readonly io: SelectionReadIo;
  readonly limits: SelectionObservationLimits;
  readonly #rows = new Map<string, SelectionObservation>();
  readonly #ids = new Set<string>();
  readonly #verified = new Map<
    SelectionRuntimeVerifier,
    Map<string, VerifiedSelectionRuntimeSnapshot>
  >();
  #collecting: Map<string, SelectionReadOperation> | null = null;
  #bytes = 0;
  #sealed = false;
  constructor(
    readonly snapshotId: string,
    limits: SelectionObservationLimits
  ) {
    if (!identity(snapshotId)) throw new TypeError('Selection snapshot identity required');
    const owned = { ...limits };
    if (
      !exact(owned, ['maximumObservations', 'maximumBytes', 'maximumPathBytes']) ||
      Object.values(owned).some((value) => !Number.isSafeInteger(value) || value < 1)
    )
      throw new TypeError('Positive exact selection observation limits required');
    this.limits = Object.freeze(owned);
    const read = <K extends SelectionReadResult['kind']>(
      operation: SelectionReadOperation,
      kind: K
    ): Extract<SelectionReadResult, { kind: K }> => {
      const result = this.lookup(Object.freeze(operation));
      if (result.kind === 'error') throw observedError(result);
      if (result.kind !== kind) throw new TypeError('Selection read result kind mismatch');
      return result as Extract<SelectionReadResult, { kind: K }>;
    };
    this.io = Object.freeze({
      lstat: (file: string) => read({ kind: 'lstat', path: file }, 'info').value,
      pathIdentity: (file: string) =>
        read({ kind: 'path-identity', path: file }, 'path-identity').value,
      stat: (file: string) => read({ kind: 'stat', path: file }, 'info').value,
      exists: (file: string) => read({ kind: 'exists', path: file }, 'exists').value,
      readFile: (file: string) =>
        Buffer.from(read({ kind: 'read', path: file }, 'bytes').base64, 'base64'),
      readDirectory: (file: string) => read({ kind: 'list', path: file }, 'listing').entries,
      requireExecutable: (file: string) => {
        read({ kind: 'executable', path: file }, 'executable');
      },
      readRuntimeFile: (file: string, singleLink = false) => {
        const result = read({ kind: 'runtime-file', path: file, singleLink }, 'runtime-file');
        return { bytes: Buffer.from(result.base64, 'base64'), stat: result.stat };
      },
      runtimeFileDigest: (file: string): string =>
        read({ kind: 'runtime-digest', path: file, singleLink: false }, 'runtime-digest').sha256,
      verifyRuntime: (home: string, digest: string, verify: SelectionRuntimeVerifier) =>
        this.verifyRuntime(home, digest, verify),
    });
    Object.freeze(this);
  }
  get observations(): readonly SelectionObservation[] {
    return Object.freeze([...this.#rows.values()]);
  }
  get runtimeSnapshots(): readonly VerifiedSelectionRuntimeSnapshot[] {
    return Object.freeze([...this.#verified.values()].flatMap((entries) => [...entries.values()]));
  }
  seal(): void {
    this.#sealed = true;
  }
  record(input: unknown): void {
    if (this.#sealed) throw new Error('Selection observation snapshot is sealed');
    const encoded = JSON.stringify(input);
    if (
      typeof encoded !== 'string' ||
      this.#bytes + Buffer.byteLength(encoded) > this.limits.maximumBytes
    )
      throw new RangeError('Selection observation byte limit exceeded');
    const value: unknown = JSON.parse(encoded);
    if (
      !object(value) ||
      !exact(value, ['snapshotId', 'sequence', 'observationId', 'operation', 'result']) ||
      value.snapshotId !== this.snapshotId ||
      value.sequence !== this.#rows.size + 1 ||
      !identity(value.observationId)
    )
      throw new TypeError('Selection observation correlation mismatch');
    requireOperation(value.operation, this.limits.maximumPathBytes);
    requireResult(value.result, value.operation);
    const key = operationKey(value.operation);
    if (this.#rows.has(key) || this.#ids.has(value.observationId))
      throw new Error('Selection observation replacement or repeated identity refused');
    if (this.#rows.size >= this.limits.maximumObservations)
      throw new RangeError('Selection observation count limit exceeded');
    freezeData(value);
    const observation = value as unknown as SelectionObservation;
    this.#rows.set(key, observation);
    this.#ids.add(observation.observationId);
    this.#bytes += Buffer.byteLength(encoded);
  }
  private lookup(operation: SelectionReadOperation): SelectionReadResult {
    requireOperation(operation, this.limits.maximumPathBytes);
    const key = operationKey(operation),
      observation = this.#rows.get(key);
    this.#collecting?.set(key, operation);
    if (!observation) {
      if (this.#sealed) throw new Error('Uncaptured read in sealed selection snapshot');
      return needSelectionObservation(operation);
    }
    return observation.result;
  }
  private nativeRuntimeGeneration(home: string, digest: string): Record<string, string> {
    const generationRoot = path.join(home, 'lib/runtimes', digest);
    const result = this.lookup(Object.freeze({ kind: 'runtime-generation', path: generationRoot }));
    if (result.kind === 'error') throw observedError(result);
    if (result.kind !== 'runtime-generation')
      throw new TypeError('Native runtime generation result kind mismatch');
    return validateRuntimeGenerationManifest(
      digest,
      result.digest,
      generationRoot,
      result.manifest
    );
  }
  private verifyRuntime(
    home: string,
    digest: string,
    verify: SelectionRuntimeVerifier
  ): Record<string, string> {
    // A caller-supplied verifier cannot seed the canonical owner's cache.
    const key = JSON.stringify([home, digest]),
      existing = this.#verified.get(verify)?.get(key);
    if (existing) {
      for (const observation of existing.observations) {
        const operation = operationKey(observation.operation);
        if (this.#rows.get(operation) !== observation)
          throw new Error('Runtime observation snapshot changed');
        this.#collecting?.set(operation, observation.operation);
      }
      return { ...existing.manifest };
    }
    const previous = this.#collecting,
      dependencies = new Map<string, SelectionReadOperation>();
    this.#collecting = dependencies;
    try {
      const files =
        nativeGenerationSnapshots.has(this) && isCanonicalRuntimeVerifier(verify)
          ? this.nativeRuntimeGeneration(home, digest)
          : verify(home, digest, this.io);
      const observations = Object.freeze(
        [...dependencies].map(([key, operation]) => {
          const observation = this.#rows.get(key);
          if (!observation) return needSelectionObservation(operation);
          return observation;
        })
      );
      const complete = Object.freeze({
        snapshotId: this.snapshotId,
        home,
        digest,
        observations,
        manifest: Object.freeze({ ...files }),
      });
      const entries =
        this.#verified.get(verify) ?? new Map<string, VerifiedSelectionRuntimeSnapshot>();
      entries.set(key, complete);
      this.#verified.set(verify, entries);
      for (const [key, operation] of dependencies) previous?.set(key, operation);
      return { ...complete.manifest };
    } finally {
      this.#collecting = previous;
    }
  }
}

async function captured(
  request: SelectionObservationRequest,
  capture: (request: SelectionObservationRequest) => Promise<unknown>,
  signal?: AbortSignal
): Promise<unknown> {
  if (signal?.aborted) throw signal.reason;
  if (!signal) return capture(request);
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve()
      .then(() => {
        if (signal.aborted) throw signal.reason;
        return capture(request);
      })
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Bounded read discovery. The capture port owns its operation deadlines. */
export async function resolveObservedInvocationSelection(
  options: SelectionOptions,
  dependencies: {
    readonly snapshot: SelectionObservationSnapshot;
    readonly capture: (request: SelectionObservationRequest) => Promise<unknown>;
    readonly maximumRequests: number;
    readonly signal?: AbortSignal;
  }
): Promise<Readonly<{ selection: InvocationSelection; snapshot: SelectionObservationSnapshot }>> {
  const invocation: SelectionOptions = Object.freeze({
    checkout: options.checkout,
    canonical: options.canonical,
    home: options.home,
    runtimeDigest: options.runtimeDigest,
    surface: options.surface,
    event: options.event,
    system: options.system,
    ...(options.caller
      ? {
          caller: Object.freeze({
            cwd: options.caller.cwd,
            environment: Object.freeze({ ...options.caller.environment }),
          }),
        }
      : {}),
  });
  const { snapshot, capture, maximumRequests, signal } = dependencies;
  if (!Number.isSafeInteger(maximumRequests) || maximumRequests < 1)
    throw new TypeError('Positive exact selection request bound required');
  let requests = 0;
  for (;;) {
    if (signal?.aborted) throw signal.reason;
    try {
      const selection = resolveInvocationSelection({ ...invocation, io: snapshot.io });
      snapshot.seal();
      return Object.freeze({ selection, snapshot });
    } catch (error) {
      const operation = missingSelectionObservation(error);
      if (!operation) throw error;
      if (requests >= maximumRequests)
        throw new RangeError('Selection observation request limit exceeded');
      const count = snapshot.observations.length;
      const request = Object.freeze({
        snapshotId: snapshot.snapshotId,
        sequence: count + 1,
        operation,
      });
      requests++;
      const reply = await captured(request, capture, signal);
      if (signal?.aborted) throw signal.reason;
      const encoded = JSON.stringify(reply);
      const value: unknown = encoded === undefined ? undefined : JSON.parse(encoded);
      if (!object(value) || !object(value.operation))
        throw new TypeError('Invalid selection capture reply');
      requireOperation(value.operation, snapshot.limits.maximumPathBytes);
      if (operationKey(value.operation) !== operationKey(operation))
        throw new Error('Selection capture operation mismatch');
      snapshot.record(value);
      if (snapshot.observations.length !== count + 1)
        throw new Error('Selection capture made no progress');
    }
  }
}

export const SELECTION_OBSERVATION_REQUEST_SCHEMA = 'caws.runtime.selection-observation.request.v1';
export const SELECTION_OBSERVATION_RESULT_SCHEMA = 'caws.runtime.selection-observation.result.v1';
export const SELECTION_OBSERVATION_CHUNK_SCHEMA = 'caws.runtime.selection-observation.chunk.v1';
export const SELECTION_OBSERVATION_CHUNK_BYTES = 64 * 1024;
export interface SelectionObservationTransport {
  /** Borrow the entry's sole framed reader; never construct another stdin reader. */
  read(signal: AbortSignal): Promise<Uint8Array>;
  write(frame: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<void>;
}

/** One discovery over the original native snapshot. Errors consume this resolver;
 * no live read, retry, new snapshot or compatibility fallback follows a request.
 * Ready ends discovery on the native side as lifecycle only, not qualification. */
export function createNativeSelectionResolver(
  request: Pick<
    RuntimeRequest,
    'id' | 'runtimeDigest' | 'deadlineEpochMs' | 'selectionObservation'
  >,
  transport: SelectionObservationTransport,
  signal: AbortSignal
): (options: SelectionOptions) => Promise<InvocationSelection> {
  const advertisement = decodeSelectionObservationAdvertisement(request.selectionObservation);
  const { id, runtimeDigest, deadlineEpochMs } = request;
  if (
    typeof id !== 'string' ||
    !id ||
    id.length > 128 ||
    id.includes('\0') ||
    !/^[a-f0-9]{64}$/.test(runtimeDigest) ||
    !Number.isSafeInteger(deadlineEpochMs)
  )
    throw new RuntimeProtocolError('Invalid selection transport original identity');
  const snapshot = new SelectionObservationSnapshot(advertisement.snapshotId, advertisement.limits);
  nativeGenerationSnapshots.add(snapshot);
  const { snapshotId, limits } = advertisement;
  let attempted = false,
    bytesUsed = 0,
    sequence = 0;
  const active = (): void => {
    if (signal.aborted) throw signal.reason;
    if (Date.now() >= deadlineEpochMs)
      throw new RuntimeProtocolError('Native selection original deadline expired');
  };
  const wait = <T>(callback: () => T | PromiseLike<T>): Promise<T> =>
    awaitSessionPublicationCallback({ signal, deadlineEpochMs }, callback);
  const frame = async (maximum: number): Promise<Record<string, unknown>> => {
    active();
    const bytes = await wait(() => transport.read(signal));
    active();
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > maximum)
      throw new RuntimeProtocolError('Selection transport frame exceeds bound');
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    parseJsonSource(text, 16, 1024, true);
    const row: unknown = JSON.parse(text);
    if (!object(row)) throw new RuntimeProtocolError('Invalid selection transport frame');
    return row;
  };
  return async (options) => {
    if (attempted) throw new RuntimeProtocolError('Native selection resolver already attempted');
    attempted = true;
    active();
    if (options.runtimeDigest !== runtimeDigest)
      throw new RuntimeProtocolError(
        'Native selection runtime digest differs from original request'
      );
    const result = await resolveObservedInvocationSelection(options, {
      snapshot,
      signal,
      maximumRequests: limits.maximumObservations,
      async capture(discovery) {
        active();
        if (
          discovery.snapshotId !== snapshotId ||
          discovery.sequence !== ++sequence ||
          sequence > limits.maximumObservations
        )
          throw new RuntimeProtocolError('Selection transport request sequence mismatch');
        const common = { id, runtimeDigest, snapshotId, sequence };
        await wait(() =>
          transport.write(
            {
              schema: SELECTION_OBSERVATION_REQUEST_SCHEMA,
              ...common,
              operation: discovery.operation,
            },
            signal
          )
        );
        active();
        const correlated = (row: Record<string, unknown>): boolean =>
          Object.entries(common).every(([key, value]) => row[key] === value);
        const header = await frame(4096);
        if (
          !exact(header, [
            'schema',
            'id',
            'runtimeDigest',
            'snapshotId',
            'sequence',
            'byteLength',
            'sha256',
          ]) ||
          header.schema !== SELECTION_OBSERVATION_RESULT_SCHEMA ||
          !correlated(header) ||
          typeof header.byteLength !== 'number' ||
          !Number.isSafeInteger(header.byteLength) ||
          header.byteLength < 1 ||
          header.byteLength > limits.maximumBytes - bytesUsed ||
          typeof header.sha256 !== 'string' ||
          !/^[a-f0-9]{64}$/.test(header.sha256)
        )
          throw new RuntimeProtocolError('Invalid selection transport result header');
        const chunks: Buffer[] = [];
        let offset = 0;
        while (offset < header.byteLength) {
          const chunk = await frame(96 * 1024);
          if (
            !exact(chunk, [
              'schema',
              'id',
              'runtimeDigest',
              'snapshotId',
              'sequence',
              'offset',
              'base64',
            ]) ||
            chunk.schema !== SELECTION_OBSERVATION_CHUNK_SCHEMA ||
            !correlated(chunk) ||
            chunk.offset !== offset ||
            typeof chunk.base64 !== 'string' ||
            chunk.base64.length > 4 * Math.ceil(SELECTION_OBSERVATION_CHUNK_BYTES / 3)
          )
            throw new RuntimeProtocolError('Invalid selection transport chunk');
          const bytes = Buffer.from(chunk.base64, 'base64');
          if (
            bytes.toString('base64') !== chunk.base64 ||
            bytes.byteLength !==
              Math.min(SELECTION_OBSERVATION_CHUNK_BYTES, header.byteLength - offset)
          )
            throw new RuntimeProtocolError('Invalid selection transport chunk bytes');
          chunks.push(bytes);
          offset += bytes.byteLength;
        }
        const bytes = Buffer.concat(chunks, header.byteLength);
        if (createHash('sha256').update(bytes).digest('hex') !== header.sha256)
          throw new RuntimeProtocolError('Selection transport content digest mismatch');
        bytesUsed += bytes.byteLength;
        active();
        const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
        parseJsonSource(text, 128, 100_000, true);
        const observation: unknown = JSON.parse(text);
        // The observed resolver validates exact inner schema, original snapshot,
        // sequence, operation equality and result before recording any progress.
        return observation;
      },
    });
    active();
    return result.selection;
  };
}
