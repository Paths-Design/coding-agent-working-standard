/** Observed selection computation; no native admission or publication authority. */
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import {
  needSelectionObservation,
  missingSelectionObservation,
  type SelectionFileInfo,
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
    !['lstat', 'stat', 'exists', 'read', 'list', 'executable', 'runtime-file'].includes(
      String(value.kind)
    ) ||
    typeof value.path !== 'string' ||
    !path.isAbsolute(value.path) ||
    value.path.includes('\0') ||
    Buffer.byteLength(value.path) > maximumPathBytes ||
    (Object.hasOwn(value, 'singleLink') &&
      (value.kind !== 'runtime-file' || typeof value.singleLink !== 'boolean'))
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

/** Incremental discovery owns immutable records; seal closes discovery. No freshness authority. */
export class SelectionObservationSnapshot {
  readonly io: SelectionReadIo;
  readonly limits: SelectionObservationLimits;
  readonly #rows = new Map<string, SelectionObservation>();
  readonly #ids = new Set<string>();
  readonly #verified = new Map<
    SelectionRuntimeVerifier,
    Map<string, VerifiedSelectionRuntimeSnapshot>
  >();
  readonly #runtimeDigests = new Map<string, string>();
  #collecting: Set<string> | null = null;
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
      runtimeFileDigest: (file: string): string => {
        const operation = { kind: 'runtime-file' as const, path: file, singleLink: false };
        const result = read(operation, 'runtime-file');
        const key = operationKey(operation),
          existing = this.#runtimeDigests.get(key);
        if (existing !== undefined) return existing;
        const digest = createHash('sha256')
          .update(Buffer.from(result.base64, 'base64'))
          .digest('hex');
        this.#runtimeDigests.set(key, digest);
        return digest;
      },
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
    if (!observation) {
      if (this.#sealed) throw new Error('Uncaptured read in sealed selection snapshot');
      return needSelectionObservation(operation);
    }
    this.#collecting?.add(key);
    return observation.result;
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
        this.#collecting?.add(operation);
      }
      return { ...existing.manifest };
    }
    const previous = this.#collecting,
      dependencies = new Set<string>();
    this.#collecting = dependencies;
    try {
      const files = verify(home, digest, this.io);
      const observations = Object.freeze(
        [...dependencies].map((operation) => this.#rows.get(operation)!)
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
      for (const operation of dependencies) previous?.add(operation);
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
