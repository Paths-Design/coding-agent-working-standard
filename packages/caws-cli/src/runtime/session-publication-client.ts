/** One framed preparation exchange. Native capture and custody own every effect. */
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, normalize } from 'node:path';
import { TextDecoder } from 'node:util';
import { parseJsonSource } from './json-custody';
import { openNativeRenderObservations } from './render-observation-client';
import {
  STOP_PUBLICATION_PREPARE,
  snapshotStopSourceCatalog,
  stopSourceInputDigest,
  type NativeRenderObservations,
} from './render-observation-wire';
import {
  awaitSessionPublicationCallback,
  consumeCommittedSession,
  type CommittedSession,
} from './committed-session-reader';
import {
  RuntimeProtocolError,
  SESSION_PUBLICATION_CAPABILITY,
  type RuntimeRequest,
} from './protocol';
import {
  SESSION_SEAL_REQUEST_SCHEMA,
  SESSION_PUBLICATION_PREPARE_SCHEMA,
  SESSION_PUBLICATION_INPUTS_SCHEMA,
  SESSION_PUBLICATION_PREPARED_SCHEMA,
  SESSION_PUBLICATION_CHUNK_SCHEMA,
  SESSION_PUBLICATION_READY_SCHEMA,
  SESSION_PUBLICATION_RESULT_SCHEMA,
  SESSION_PUBLICATION_CONSUMED_SCHEMA,
  MAX_PUBLICATION_CHUNK_BYTES,
  MAX_PUBLICATION_ARTIFACT_BYTES,
  MAX_PUBLICATION_TOTAL_BYTES,
  MAX_PUBLICATION_ARTIFACTS,
  MAX_PUBLICATION_SNAPSHOT_BYTES,
  sessionPublicationTerminalDigest,
  type SessionOperationCorrelation,
  type SessionPublicationKind,
  type SessionPublicationDescriptor,
} from './session-publication-wire';

export type {
  SessionPublicationKind,
  SessionPublicationDescriptor,
} from './session-publication-wire';
export interface SessionPublicationInput {
  readonly kind: SessionPublicationKind;
  readonly observationId: string;
  readonly inputDigest: string;
  readonly sessionId: string;
  readonly reason: string;
  readonly endedAt: string;
  readonly files: readonly SessionPublicationDescriptor[];
  readonly priorInventory: readonly SessionPublicationDescriptor[];
  /** Present only for an explicitly enabled, complete native Render input phase. */
  readonly observations?: NativeRenderObservations;
  /** Owned copies; mutating one cannot alter another observation. */
  bytes(name: string): Uint8Array;
}
export type SessionPublicationPreparation =
  | {
      readonly disposition: 'ready';
      readonly artifacts: readonly {
        readonly name: string;
        readonly role: string;
        readonly bytes: Uint8Array;
      }[];
      readonly removals: readonly string[];
      readonly summaryMode?: 'recomputed' | 'preserved';
    }
  | { readonly disposition: 'aborted'; readonly diagnostic: string };
export interface SessionPublicationReceipt {
  readonly status: 'published' | 'not_published' | 'publication_uncertain';
  readonly terminalDigest: string;
  readonly artifacts: readonly SessionPublicationDescriptor[];
  readonly error?: string;
}
export interface SessionPublicationTransport {
  read(signal: AbortSignal): Promise<Uint8Array>;
  write(frame: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<void>;
}
export type SessionPublicationConsumption =
  | Readonly<{
      status: 'published';
      correlation: SessionOperationCorrelation;
      receipt: SessionPublicationReceipt & { readonly status: 'published' };
      session: CommittedSession;
    }>
  | Readonly<{
      status: 'not_published';
      correlation: SessionOperationCorrelation;
      receipt: SessionPublicationReceipt & { readonly status: 'not_published' };
    }>;
/** Complete the selected consumer's use of owned bytes, or record an explicit
 * non-publication outcome. Throwing never sends CONSUMED or enables fallback. */
export type SessionPublicationConsumer = (
  outcome: SessionPublicationConsumption
) => void | Promise<void>;
type Row = Record<string, unknown>;
type Prepare = (input: SessionPublicationInput) => Promise<SessionPublicationPreparation>;
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const object = (value: unknown): value is Row =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
function requireValue(value: unknown, message: string): asserts value {
  if (!value) throw new RuntimeProtocolError(message);
}
const exact = (row: Row, required: readonly string[], optional: readonly string[] = []): boolean =>
  required.every((key) => Object.hasOwn(row, key)) &&
  Object.keys(row).every((key) => required.includes(key) || optional.includes(key));
const integer = (value: unknown, maximum: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
const digest = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const text = (value: unknown, maximum: number): value is string =>
  typeof value === 'string' && !value.includes('\0') && Buffer.byteLength(value) <= maximum;
const name = (value: unknown): value is string =>
  text(value, 255) &&
  /^[A-Za-z0-9_.@:-]+(?:\/[A-Za-z0-9_.@:-]+)*$/.test(value) &&
  !value.split('/').some((part) => part === '.' || part === '..');
const commonKeys = ['schema', 'id', 'runtimeDigest', 'token', 'attempt'] as const;

function descriptors(value: unknown): readonly SessionPublicationDescriptor[] {
  requireValue(
    Array.isArray(value) && value.length <= MAX_PUBLICATION_ARTIFACTS,
    'Invalid publication inventory'
  );
  const names = new Set<string>();
  let total = 0;
  return Object.freeze(
    value.map((entry: unknown) => {
      requireValue(
        object(entry) &&
          exact(entry, ['name', 'role', 'byteLength', 'sha256']) &&
          name(entry.name) &&
          text(entry.role, 32) &&
          /^[a-z][a-z0-9_-]*$/.test(entry.role) &&
          integer(entry.byteLength, MAX_PUBLICATION_ARTIFACT_BYTES) &&
          digest(entry.sha256),
        'Invalid publication descriptor'
      );
      requireValue(!names.has(entry.name), 'Duplicate publication name');
      names.add(entry.name);
      total += entry.byteLength;
      requireValue(
        total <= MAX_PUBLICATION_TOTAL_BYTES,
        'Publication inventory exceeds byte bound'
      );
      return Object.freeze({
        name: entry.name,
        role: entry.role,
        byteLength: entry.byteLength,
        sha256: entry.sha256,
      });
    })
  );
}
function decode(bytes: Uint8Array): Row {
  requireValue(bytes.byteLength <= 4 * 1024 * 1024, 'Publication frame exceeds byte bound');
  try {
    const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    parseJsonSource(source, 32, 100_000, true);
    const value: unknown = JSON.parse(source);
    requireValue(object(value), 'Publication frame is not an object');
    return value;
  } catch (error) {
    if (error instanceof RuntimeProtocolError) throw error;
    throw new RuntimeProtocolError('Invalid publication frame encoding or duplicate field');
  }
}
function sameDescriptor(
  left: SessionPublicationDescriptor,
  right: SessionPublicationDescriptor
): boolean {
  return (
    left.name === right.name &&
    left.role === right.role &&
    left.byteLength === right.byteLength &&
    left.sha256 === right.sha256
  );
}
function preparedName(kind: SessionPublicationKind, item: SessionPublicationDescriptor): boolean {
  if (kind === 'seal') return item.name === '.meta.json' && item.role === 'metadata';
  if (kind === 'projection')
    return item.name === 'store-projection.jsonl' && item.role === 'projection';
  return (
    (item.name === 'session-index.json' && item.role === 'index') ||
    (/^turn-[0-9]+\.json$/.test(item.name) && item.role === 'turn') ||
    (/^turn-[0-9]+\.payloads\.json$/.test(item.name) && item.role === 'spill')
  );
}

/** Continue only from the caller's verified native store closure, using its
 * existing token and reader. This function grants no filesystem authority. */
export async function continueNativeSessionPublication(
  request: RuntimeRequest,
  transport: SessionPublicationTransport,
  signal: AbortSignal,
  options: {
    readonly token: string;
    readonly expectedKinds: readonly SessionPublicationKind[];
    readonly prepare: Prepare;
    /** Caller has selected the original-frontend observation carrier. No activation is inferred. */
    readonly renderObservations?: boolean;
    /** Original admitted context. A snapshot or on-disk marker cannot select these. */
    readonly canonicalRoot: string;
    readonly sessionId: string;
    readonly consume: SessionPublicationConsumer;
  }
): Promise<SessionPublicationReceipt> {
  requireValue(
    request.sessionPublication === SESSION_PUBLICATION_CAPABILITY &&
      text(options.token, 128) &&
      options.token.length > 0 &&
      text(options.canonicalRoot, 4096) &&
      isAbsolute(options.canonicalRoot) &&
      normalize(options.canonicalRoot) === options.canonicalRoot &&
      !options.canonicalRoot.includes('\0') &&
      text(options.sessionId, 128) &&
      /^[A-Za-z0-9_.@:-]+$/.test(options.sessionId) &&
      !['.', '..'].includes(options.sessionId) &&
      typeof options.prepare === 'function' &&
      typeof options.consume === 'function' &&
      (options.renderObservations === undefined ||
        typeof options.renderObservations === 'boolean') &&
      ((options.expectedKinds.length === 1 &&
        ['seal', 'render'].includes(options.expectedKinds[0]!)) ||
        (options.expectedKinds.length === 2 &&
          options.expectedKinds[0] === 'projection' &&
          options.expectedKinds[1] === 'render')),
    'Invalid publication continuation'
  );
  let attempt: string | undefined;
  let preparedCount = 0;
  let aborted = false;
  let initialInventory: readonly SessionPublicationDescriptor[] | undefined;
  const expectedOutputs = new Map<string, SessionPublicationDescriptor>();
  const cancelled = (): void => {
    if (signal.aborted) throw signal.reason;
    requireValue(Date.now() < request.deadlineEpochMs, 'Publication deadline expired');
  };
  const read = async (): Promise<Row> => {
    cancelled();
    const row = decode(await transport.read(signal));
    requireValue(
      row.id === request.id &&
        row.runtimeDigest === request.runtimeDigest &&
        row.token === options.token &&
        text(row.attempt, 128) &&
        row.attempt.length > 0,
      'Mismatched publication correlation'
    );
    attempt ??= row.attempt;
    requireValue(row.attempt === attempt, 'Publication attempt changed');
    return row;
  };
  const write = async (schema: string, fields: Row): Promise<void> => {
    cancelled();
    await transport.write(
      {
        schema,
        id: request.id,
        runtimeDigest: request.runtimeDigest,
        token: options.token,
        attempt,
        ...fields,
      },
      signal
    );
  };
  for (;;) {
    const frame = await read();
    if (frame.schema === SESSION_PUBLICATION_RESULT_SCHEMA) {
      requireValue(
        exact(frame, [...commonKeys, 'status', 'terminalDigest', 'artifacts'], ['error']) &&
          typeof frame.status === 'string' &&
          ['published', 'not_published', 'publication_uncertain'].includes(frame.status) &&
          digest(frame.terminalDigest) &&
          (frame.error === undefined || text(frame.error, 4096)),
        'Invalid publication result'
      );
      const artifacts = descriptors(frame.artifacts);
      requireValue(
        !aborted || frame.status === 'not_published',
        'Contradictory result after aborted preparation'
      );
      if (frame.status === 'published') {
        requireValue(
          preparedCount === options.expectedKinds.length,
          'Publication completed before all preparation phases'
        );
        requireValue(
          artifacts.length === expectedOutputs.size &&
            artifacts.every((item) => {
              const expected = expectedOutputs.get(item.name);
              return expected !== undefined && sameDescriptor(item, expected);
            }),
          'Published inventory differs from prepared bytes and retained artifacts'
        );
      }
      const receipt = Object.freeze({
        status: frame.status as SessionPublicationReceipt['status'],
        terminalDigest: frame.terminalDigest,
        artifacts,
        ...(frame.error === undefined ? {} : { error: frame.error as string }),
      });
      requireValue(
        receipt.status !== 'publication_uncertain',
        'Publication is uncertain; no consumption acknowledgement'
      );
      const correlation = Object.freeze({
        id: request.id,
        runtimeDigest: request.runtimeDigest,
        token: options.token,
        attempt: attempt!,
      });
      requireValue(
        receipt.terminalDigest ===
          sessionPublicationTerminalDigest(correlation, receipt.status, artifacts),
        'Publication terminal digest differs from original correlation and inventory'
      );
      if (receipt.status === 'published') {
        await consumeCommittedSession(
          {
            canonicalRoot: options.canonicalRoot,
            sessionId: options.sessionId,
            correlation,
            terminalDigest: receipt.terminalDigest,
            artifacts,
          },
          { signal, deadlineEpochMs: request.deadlineEpochMs },
          async (session) => {
            await options.consume(
              Object.freeze({
                status: 'published',
                correlation,
                session,
                receipt: receipt as SessionPublicationReceipt & { readonly status: 'published' },
              })
            );
          }
        );
      } else {
        requireValue(artifacts.length === 0, 'Non-publication result contains artifacts');
        await awaitSessionPublicationCallback(
          { signal, deadlineEpochMs: request.deadlineEpochMs },
          () =>
            options.consume(
              Object.freeze({
                status: 'not_published',
                correlation,
                receipt: receipt as SessionPublicationReceipt & {
                  readonly status: 'not_published';
                },
              })
            )
        );
      }
      // Only actual ordinary consumption and current-generation revalidation
      // precede this local flush. Native still independently validates the ack.
      await write(SESSION_PUBLICATION_CONSUMED_SCHEMA, { terminalDigest: receipt.terminalDigest });
      return receipt;
    }
    requireValue(!aborted, 'Unexpected preparation after aborted phase');
    const kind = options.expectedKinds[preparedCount];
    const stopCatalogPhase = frame.schema === STOP_PUBLICATION_PREPARE;
    requireValue(
      kind &&
        (frame.schema === SESSION_PUBLICATION_PREPARE_SCHEMA ||
          (stopCatalogPhase && kind === 'render' && options.renderObservations === true)) &&
        exact(frame, [...commonKeys, 'kind', 'snapshot']) &&
        frame.kind === kind &&
        object(frame.snapshot),
      'Unexpected publication preparation phase'
    );
    const snapshot = frame.snapshot;
    requireValue(
      exact(snapshot, [
        'observationId',
        'inputDigest',
        'sessionId',
        'reason',
        'endedAt',
        'files',
        'priorInventory',
        ...(stopCatalogPhase ? ['sourceCatalog'] : []),
      ]) &&
        text(snapshot.observationId, 128) &&
        snapshot.observationId.length > 0 &&
        digest(snapshot.inputDigest) &&
        text(snapshot.sessionId, 128) &&
        snapshot.sessionId === options.sessionId &&
        text(snapshot.reason, 4096) &&
        text(snapshot.endedAt, 128),
      'Invalid native publication snapshot'
    );
    const files = descriptors(snapshot.files);
    const priorInventory = descriptors(snapshot.priorInventory);
    const stopCatalog = stopCatalogPhase
      ? snapshotStopSourceCatalog(snapshot.sourceCatalog, files, options.sessionId)
      : undefined;
    if (stopCatalog !== undefined)
      requireValue(
        stopSourceInputDigest(files, stopCatalog) === snapshot.inputDigest,
        'Stop source catalog input digest mismatch'
      );
    if (initialInventory === undefined) {
      initialInventory = priorInventory;
      for (const item of priorInventory) expectedOutputs.set(item.name, item);
    } else {
      const originalInventory = initialInventory;
      requireValue(
        priorInventory.length === originalInventory.length &&
          priorInventory.every((item) =>
            originalInventory.some((prior) => sameDescriptor(item, prior))
          ),
        'Prior publication inventory changed between phases'
      );
    }
    requireValue(
      files.reduce((sum, item) => sum + item.byteLength, 0) <= MAX_PUBLICATION_SNAPSHOT_BYTES,
      'Native snapshot exceeds byte bound'
    );
    const contents = new Map<string, Buffer>();
    for (const file of files) {
      const chunks: Buffer[] = [];
      let offset = 0;
      while (offset < file.byteLength) {
        const chunk = await read();
        requireValue(
          chunk.schema === SESSION_PUBLICATION_INPUTS_SCHEMA &&
            exact(chunk, [...commonKeys, 'kind', 'name', 'offset', 'base64']) &&
            chunk.kind === kind &&
            chunk.name === file.name &&
            chunk.offset === offset &&
            typeof chunk.base64 === 'string' &&
            chunk.base64.length <= 4 * Math.ceil(MAX_PUBLICATION_CHUNK_BYTES / 3),
          'Invalid native publication chunk'
        );
        const bytes = Buffer.from(chunk.base64, 'base64');
        requireValue(
          bytes.length > 0 &&
            bytes.length <= MAX_PUBLICATION_CHUNK_BYTES &&
            bytes.toString('base64') === chunk.base64 &&
            bytes.length <= file.byteLength - offset,
          'Invalid native publication byte encoding'
        );
        chunks.push(bytes);
        offset += bytes.length;
      }
      const bytes = Buffer.concat(chunks, file.byteLength);
      requireValue(hash(bytes) === file.sha256, 'Native snapshot content digest differs');
      contents.set(file.name, bytes);
    }
    const ready = await read();
    requireValue(
      ready.schema === SESSION_PUBLICATION_READY_SCHEMA &&
        exact(ready, [...commonKeys, 'kind', 'direction']) &&
        ready.kind === kind &&
        ready.direction === 'inputs',
      'Native snapshot is incomplete'
    );
    const observations =
      kind === 'render' && options.renderObservations === true
        ? await openNativeRenderObservations({
            binding: {
              id: request.id,
              runtimeDigest: request.runtimeDigest,
              token: options.token,
              attempt: attempt!,
              observationId: snapshot.observationId as string,
              inputDigest: snapshot.inputDigest as string,
            },
            transport,
            signal,
            deadlineEpochMs: request.deadlineEpochMs,
            ...(stopCatalog === undefined
              ? {}
              : {
                  stopSourceInput: {
                    catalog: stopCatalog,
                    files,
                    sessionId: options.sessionId,
                    bytes: (name: string) => {
                      const value = contents.get(name);
                      requireValue(value !== undefined, 'Stop source references uncaptured bytes');
                      return Uint8Array.from(value);
                    },
                  },
                }),
          })
        : undefined;
    const input: SessionPublicationInput = Object.freeze({
      kind,
      observationId: snapshot.observationId as string,
      inputDigest: snapshot.inputDigest as string,
      sessionId: snapshot.sessionId as string,
      reason: snapshot.reason as string,
      endedAt: snapshot.endedAt as string,
      files,
      priorInventory,
      ...(observations ? { observations: observations.observations } : {}),
      bytes(fileName: string): Uint8Array {
        const bytes = contents.get(fileName);
        requireValue(bytes !== undefined, 'Unknown native snapshot file');
        return Buffer.from(bytes);
      },
    });
    let preparation: SessionPublicationPreparation;
    try {
      cancelled();
      preparation = await awaitSessionPublicationCallback(
        { signal, deadlineEpochMs: request.deadlineEpochMs },
        () => options.prepare(input)
      );
      cancelled();
      requireValue(
        preparation !== null &&
          typeof preparation === 'object' &&
          (preparation.disposition === 'ready' || preparation.disposition === 'aborted'),
        'Invalid publication preparation disposition'
      );
      observations?.assertIdle();
      if (preparation.disposition === 'ready') observations?.assertReady();
    } finally {
      observations?.close();
    }
    if (preparation.disposition === 'aborted') {
      requireValue(text(preparation.diagnostic, 4096), 'Invalid preparation diagnostic');
      aborted = true;
      await write(SESSION_PUBLICATION_PREPARED_SCHEMA, {
        kind,
        observationId: input.observationId,
        inputDigest: input.inputDigest,
        disposition: 'aborted',
        diagnostic: preparation.diagnostic,
        artifacts: [],
        removals: [],
      });
    } else {
      // Validate the complete metadata and length set before copying or hashing
      // any output. A refused aggregate must not allocate the refused aggregate.
      requireValue(
        Array.isArray(preparation.artifacts) &&
          preparation.artifacts.length <= MAX_PUBLICATION_ARTIFACTS,
        'Invalid publication inventory'
      );
      const sources = preparation.artifacts.map((item) => {
        requireValue(
          item !== null && typeof item === 'object' && item.bytes instanceof Uint8Array,
          'Invalid publication output bytes'
        );
        return { name: item.name, role: item.role, bytes: item.bytes };
      });
      const metadata = descriptors(
        sources.map((item) => ({
          name: item.name,
          role: item.role,
          byteLength: item.bytes.byteLength,
          sha256: '0'.repeat(64),
        }))
      );
      requireValue(
        metadata.length > 0 &&
          metadata.every((item) => preparedName(kind, item)) &&
          (kind === 'render' || metadata.length === 1),
        'Invalid prepared publication targets'
      );
      requireValue(
        Array.isArray(preparation.removals) &&
          preparation.removals.length <= MAX_PUBLICATION_ARTIFACTS &&
          new Set(preparation.removals).size === preparation.removals.length &&
          preparation.removals.every(
            (removed) =>
              name(removed) &&
              kind === 'render' &&
              priorInventory.some(
                (item) => item.name === removed && preparedName('render', item)
              ) &&
              !metadata.some((item) => item.name === removed)
          ),
        'Invalid publication removals'
      );
      requireValue(
        preparation.summaryMode === undefined ||
          (kind === 'seal' && ['recomputed', 'preserved'].includes(preparation.summaryMode)),
        'Invalid summary mode'
      );
      const removals = [...preparation.removals];
      const summaryMode = preparation.summaryMode;
      const owned = sources.map((item) => ({ ...item, bytes: Buffer.from(item.bytes) }));
      const artifacts = descriptors(
        owned.map((item) => ({
          name: item.name,
          role: item.role,
          byteLength: item.bytes.length,
          sha256: hash(item.bytes),
        }))
      );
      await write(SESSION_PUBLICATION_PREPARED_SCHEMA, {
        kind,
        observationId: input.observationId,
        inputDigest: input.inputDigest,
        disposition: 'ready',
        artifacts,
        removals,
        ...(summaryMode ? { summaryMode } : {}),
      });
      for (const item of owned) {
        for (let offset = 0; offset < item.bytes.length; offset += MAX_PUBLICATION_CHUNK_BYTES)
          await write(SESSION_PUBLICATION_CHUNK_SCHEMA, {
            kind,
            name: item.name,
            offset,
            base64: item.bytes
              .subarray(offset, offset + MAX_PUBLICATION_CHUNK_BYTES)
              .toString('base64'),
          });
      }
      for (const removed of removals) expectedOutputs.delete(removed);
      for (const item of artifacts) expectedOutputs.set(item.name, item);
    }
    await write(SESSION_PUBLICATION_READY_SCHEMA, { kind, direction: 'prepared' });
    preparedCount++;
  }
}

export interface NativeSessionSealPort {
  seal(
    canonicalRoot: string,
    sessionId: string,
    prepare: Prepare,
    consume: SessionPublicationConsumer
  ): Promise<SessionPublicationReceipt>;
}

/** Independent original SessionEnd capture is performed by the native frontend. */
export function createNativeSessionSealPort(
  request: RuntimeRequest,
  transport: SessionPublicationTransport,
  signal: AbortSignal
): NativeSessionSealPort {
  requireValue(
    request.sessionPublication === SESSION_PUBLICATION_CAPABILITY &&
      request.configuration === 'system' &&
      request.event === 'session_end',
    'SessionEnd publication is unavailable'
  );
  let attempted = false;
  return Object.freeze({
    async seal(
      canonicalRoot: string,
      sessionId: string,
      prepare: Prepare,
      consume: SessionPublicationConsumer
    ) {
      requireValue(
        !attempted &&
          isAbsolute(canonicalRoot) &&
          normalize(canonicalRoot) === canonicalRoot &&
          !canonicalRoot.includes('\0') &&
          text(sessionId, 128) &&
          /^[A-Za-z0-9_.@:-]+$/.test(sessionId) &&
          !['.', '..'].includes(sessionId) &&
          typeof prepare === 'function' &&
          typeof consume === 'function',
        'Invalid or repeated SessionEnd publication'
      );
      attempted = true;
      if (signal.aborted) throw signal.reason;
      const token = randomUUID();
      await transport.write(
        {
          schema: SESSION_SEAL_REQUEST_SCHEMA,
          id: request.id,
          runtimeDigest: request.runtimeDigest,
          token,
          canonicalRoot,
        },
        signal
      );
      return continueNativeSessionPublication(request, transport, signal, {
        token,
        expectedKinds: ['seal'],
        prepare,
        canonicalRoot,
        sessionId,
        consume,
      });
    },
  });
}
