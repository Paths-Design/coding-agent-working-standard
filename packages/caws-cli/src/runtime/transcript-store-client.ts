/** Fixed-query native port and exhausted-closure continuation. No discovery, retry, or stock selection. */
import { randomUUID } from 'node:crypto';
import { isAbsolute, normalize } from 'node:path';
import { TextDecoder } from 'node:util';
import {
  reconstructStoreProjection,
  type StoreAcquiredRow,
  type StoreSqlCell,
  type StoreProjection,
  type StoreProjectionLimits,
} from '../transcripts/store-projection';
import type { StoreUtcCalendarResult } from '../transcripts/store-timestamp';
import {
  STORE_JSON_PROFILE,
  snapshotStoreJsonProfile,
  type StoreJsonProfile,
} from '../transcripts/store-json';
import { parseJsonSource } from './json-custody';
import { RuntimeProtocolError, TRANSCRIPT_STORE_CAPABILITY, type RuntimeRequest } from './protocol';
import {
  continueNativeSessionPublication,
  type SessionPublicationInput,
  type SessionPublicationPreparation,
  type SessionPublicationConsumer,
  type SessionPublicationReceipt,
} from './session-publication-client';

export const TRANSCRIPT_STORE_PROFILE = 'cpython-3.11.13-sqlite3.53.4-store-development.v1';
const PREFIX = 'caws.runtime.transcript-store.';
const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const MAX_ROWS = 4096;
const MAX_CELL_BYTES = 256 * 1024;
const MAX_TOTAL_CELL_BYTES = 16 * 1024 * 1024;
export interface TranscriptStoreTransport {
  read(signal: AbortSignal): Promise<Uint8Array>;
  write(frame: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<void>;
}
export interface NativeTranscriptStorePort {
  /** One acquisition, bound to original native session/database observations. */
  rows(canonicalRoot: string): AsyncIterable<StoreAcquiredRow>;
  /** At most one request while a yielded row is outstanding. */
  calendar(seconds: bigint): Promise<StoreUtcCalendarResult>;
  /** Independently check cleanup after IteratorClose, including a thrown body. */
  assertClosed(): void;
}
export interface NativeTranscriptStorePublicationPort extends NativeTranscriptStorePort {
  readonly surface: 'opencode' | 'zcode';
  /** Local sequencing only. Native publication selection remains independently required. */
  continuePublication(options: {
    readonly canonicalRoot: string;
    readonly sessionId: string;
    /** Explicit selected-carrier opt-in; absence preserves the existing continuation. */
    readonly renderObservations?: true;
    readonly prepare: (input: SessionPublicationInput) => Promise<SessionPublicationPreparation>;
    readonly consume: SessionPublicationConsumer;
  }): Promise<SessionPublicationReceipt>;
}
export class NativeStoreAcquisitionError extends Error {
  constructor(readonly diagnostic: string) {
    super(diagnostic);
    this.name = 'NativeStoreAcquisitionError';
  }
}
export class NativeStoreCleanupError extends Error {
  constructor(
    readonly observation: Readonly<{
      progressUnregistered: boolean;
      busyUnregistered: string;
      finalized: string;
      rollback: string;
    }>,
    readonly operationFailure: NativeStoreAcquisitionError
  ) {
    super('Native store reported failed cleanup');
    this.name = 'NativeStoreCleanupError';
  }
}
/** Reconstruction and cleanup are separate outcomes. IteratorClose can suppress
 * a return rejection when its body already threw, so check native settlement
 * independently before returning a result or allowing later serialization. */
export async function reconstructNativeTranscriptStore(
  port: NativeTranscriptStorePort,
  canonicalRoot: string,
  surface: 'opencode' | 'zcode',
  limits: StoreProjectionLimits,
  requestedProfile: StoreJsonProfile = STORE_JSON_PROFILE
): Promise<StoreProjection> {
  // Invalid qualification cannot begin an acquisition or pretend cleanup ran.
  const profile = snapshotStoreJsonProfile(requestedProfile);
  let projection: StoreProjection;
  try {
    projection = await reconstructStoreProjection(
      port.rows(canonicalRoot),
      surface,
      (seconds) => port.calendar(seconds),
      limits,
      profile
    );
  } catch (primary) {
    try {
      port.assertClosed();
    } catch (cleanup) {
      throw new AggregateError(
        [primary, cleanup],
        'Store reconstruction and native cleanup both failed'
      );
    }
    throw primary;
  }
  port.assertClosed();
  return projection;
}
type RecordValue = Record<string, unknown>;
function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function keys(value: RecordValue, expected: readonly string[]): boolean {
  return (
    Object.keys(value).length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}
function requireProtocol(condition: unknown, message: string): asserts condition {
  if (!condition) throw new RuntimeProtocolError(message);
}
function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}
function decimal(value: unknown): bigint {
  requireProtocol(
    typeof value === 'string' &&
      /^(?:0|-[1-9][0-9]*|[1-9][0-9]*)$/.test(value) &&
      value.length <= 20,
    'Invalid store integer spelling'
  );
  const result = BigInt(value);
  requireProtocol(result >= -(1n << 63n) && result < 1n << 63n, 'Store integer exceeds i64');
  return result;
}
function sqlCell(value: unknown): StoreSqlCell {
  requireProtocol(record(value), 'Invalid store SQL cell');
  switch (value.storageClass) {
    case 'null':
      requireProtocol(keys(value, ['storageClass']), 'Invalid null SQL cell');
      return Object.freeze({ storageClass: 'null' });
    case 'integer':
      requireProtocol(keys(value, ['storageClass', 'decimal']), 'Invalid integer SQL cell');
      return Object.freeze({ storageClass: 'integer', value: decimal(value.decimal) });
    case 'real': {
      requireProtocol(
        keys(value, ['storageClass', 'binary64Hex']) &&
          typeof value.binary64Hex === 'string' &&
          /^[0-9a-f]{16}$/.test(value.binary64Hex),
        'Invalid real SQL cell'
      );
      const number = Buffer.from(value.binary64Hex, 'hex').readDoubleBE(0);
      requireProtocol(!Number.isNaN(number), 'SQLite NaN must be NULL');
      return Object.freeze({ storageClass: 'real', value: number });
    }
    case 'text':
    case 'blob': {
      requireProtocol(
        keys(value, ['storageClass', 'base64']) &&
          typeof value.base64 === 'string' &&
          value.base64.length <= 4 * Math.ceil(MAX_CELL_BYTES / 3),
        'Invalid byte SQL cell'
      );
      const bytes = Buffer.from(value.base64, 'base64');
      requireProtocol(
        bytes.length <= MAX_CELL_BYTES && bytes.toString('base64') === value.base64,
        'Invalid SQL byte encoding'
      );
      if (value.storageClass === 'text') {
        try {
          new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
        } catch {
          throw new RuntimeProtocolError('Native store yielded unadmitted TEXT');
        }
      }
      // This privately owned view is input to the projector, which snapshots it
      // before awaiting. Keep a data descriptor; arbitrary accessors are refused
      // by that boundary. No transport buffer is shared with this row.
      return Object.freeze({ storageClass: value.storageClass, bytes });
    }
    default:
      throw new RuntimeProtocolError('Unsupported SQL storage class');
  }
}
function byteCharge(cell: StoreSqlCell): number {
  return cell.storageClass === 'text' || cell.storageClass === 'blob'
    ? cell.bytes.length
    : cell.storageClass === 'null'
      ? 0
      : 8;
}
function calendarResult(value: unknown, seconds: bigint): StoreUtcCalendarResult {
  requireProtocol(
    record(value) && decimal(value.seconds) === seconds,
    'Mismatched store UTC seconds'
  );
  if (value.kind === 'utc_calendar') {
    const names = ['tmYear', 'tmMon', 'tmMday', 'tmHour', 'tmMin', 'tmSec'] as const;
    requireProtocol(
      keys(value, ['kind', 'seconds', ...names]) &&
        names.every((name) => integer(value[name], -(2 ** 31), 2 ** 31 - 1)),
      'Invalid native UTC fields'
    );
    return Object.freeze({
      kind: 'utc_calendar',
      seconds,
      tmYear: value.tmYear as number,
      tmMon: value.tmMon as number,
      tmMday: value.tmMday as number,
      tmHour: value.tmHour as number,
      tmMin: value.tmMin as number,
      tmSec: value.tmSec as number,
    });
  }
  requireProtocol(
    value.kind === 'os_error' &&
      keys(value, ['kind', 'seconds', 'errno', 'message']) &&
      integer(value.errno, -(2 ** 31), 2 ** 31 - 1) &&
      value.errno !== 0 &&
      typeof value.message === 'string' &&
      value.message.length > 0 &&
      Buffer.byteLength(value.message) <= 4096,
    'Invalid native UTC error'
  );
  return Object.freeze({ kind: 'os_error', seconds, errno: value.errno, message: value.message });
}

/** Pass the entry's existing reader/writer; acquiring a second stdin reader is invalid. */
export function createNativeTranscriptStorePort(
  request: RuntimeRequest,
  transport: TranscriptStoreTransport,
  signal: AbortSignal
): NativeTranscriptStorePublicationPort {
  requireProtocol(
    request.sessionStore === TRANSCRIPT_STORE_CAPABILITY &&
      request.configuration === 'system' &&
      request.event === 'stop' &&
      (request.surface === 'opencode' || request.surface === 'zcode'),
    'Native transcript store capability unavailable'
  );
  let phase: 'idle' | 'reading' | 'row' | 'calendar' | 'closed' | 'failed' = 'idle';
  let attempted = false,
    ordinal = 0,
    totalBytes = 0,
    calendarUsed = false;
  let pendingCalendar: Promise<StoreUtcCalendarResult> | null = null;
  let terminalFailure: unknown;
  let confirmedClosed = false;
  let cleanupFailure: unknown;
  const invocation = Object.freeze({ ...request });
  const surface = request.surface as 'opencode' | 'zcode';
  let acquisitionRoot: string | undefined;
  let publicationEligible = false,
    publicationAttempted = false;
  const unsettled = (error: unknown): void => {
    if (terminalFailure === undefined) terminalFailure = error;
    publicationEligible = false;
    phase = 'failed';
  };
  const isClosed = (): boolean => phase === 'closed';
  const token = randomUUID();
  const common = (suffix: string): RecordValue => ({
    schema: PREFIX + suffix + '.v1',
    id: invocation.id,
    runtimeDigest: invocation.runtimeDigest,
    token,
  });
  const write = async (frame: RecordValue): Promise<void> => {
    if (signal.aborted) throw signal.reason;
    await transport.write(frame, signal);
  };
  const read = async (): Promise<RecordValue> => {
    if (signal.aborted) throw signal.reason;
    const bytes = await transport.read(signal);
    requireProtocol(bytes.byteLength <= MAX_FRAME_BYTES, 'Store frame exceeds byte bound');
    let value: unknown;
    try {
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      parseJsonSource(text, 16, 128, true);
      value = JSON.parse(text);
    } catch {
      throw new RuntimeProtocolError('Invalid store frame encoding or duplicate field');
    }
    requireProtocol(
      record(value) &&
        value.id === invocation.id &&
        value.runtimeDigest === invocation.runtimeDigest &&
        value.token === token,
      'Store frame binding mismatch'
    );
    return value;
  };
  const close = (frame: RecordValue, expected: 'exhausted' | 'stopped'): void => {
    requireProtocol(
      keys(frame, [
        'schema',
        'id',
        'runtimeDigest',
        'token',
        'closed',
        'end',
        'failure',
        'cleanup',
        'metrics',
      ]) &&
        frame.schema === PREFIX + 'closed.v1' &&
        frame.closed === true,
      'Store cleanup remains unconfirmed'
    );
    requireProtocol(
      record(frame.metrics) &&
        keys(frame.metrics, ['rowsCopied', 'rowsDelivered', 'cellBytes']) &&
        integer(frame.metrics.rowsCopied, ordinal, MAX_ROWS) &&
        frame.metrics.rowsDelivered === ordinal &&
        integer(frame.metrics.cellBytes, totalBytes, MAX_TOTAL_CELL_BYTES),
      'Invalid store completion metrics'
    );
    requireProtocol(
      record(frame.cleanup) &&
        keys(frame.cleanup, [
          'progressUnregistered',
          'busyUnregistered',
          'finalized',
          'rollback',
        ]) &&
        typeof frame.cleanup.progressUnregistered === 'boolean' &&
        [frame.cleanup.busyUnregistered, frame.cleanup.finalized, frame.cleanup.rollback].every(
          (value) => typeof value === 'string'
        ) &&
        ['exhausted', 'stopped', 'failed'].includes(String(frame.end)),
      'Invalid store cleanup observation'
    );
    phase = 'closed';
    confirmedClosed = true;
    if (frame.end === 'failed') {
      requireProtocol(
        typeof frame.failure === 'string' && frame.failure.length > 0,
        'Store failure diagnostic absent'
      );
      const failure = new NativeStoreAcquisitionError(frame.failure);
      if (
        !frame.cleanup.progressUnregistered ||
        frame.cleanup.busyUnregistered !== 'Succeeded' ||
        !['Succeeded', 'NotNeeded'].includes(String(frame.cleanup.finalized)) ||
        !['Succeeded', 'NotNeeded'].includes(String(frame.cleanup.rollback))
      )
        cleanupFailure = new NativeStoreCleanupError(
          Object.freeze({
            progressUnregistered: frame.cleanup.progressUnregistered,
            busyUnregistered: frame.cleanup.busyUnregistered as string,
            finalized: frame.cleanup.finalized as string,
            rollback: frame.cleanup.rollback as string,
          }),
          failure
        );
      throw failure;
    }
    requireProtocol(
      frame.end === expected &&
        frame.failure === null &&
        frame.cleanup.progressUnregistered === true &&
        frame.cleanup.busyUnregistered === 'Succeeded' &&
        frame.cleanup.finalized === 'Succeeded' &&
        frame.cleanup.rollback === 'Succeeded' &&
        frame.metrics.rowsCopied === ordinal &&
        frame.metrics.cellBytes === totalBytes,
      'Inconsistent store completion'
    );
    // phase/confirmedClosed also describe stopped or failed closure. Only the
    // final successful exhaustion predicate permits the publication handoff.
    publicationEligible = expected === 'exhausted';
  };
  const rows = async function* (canonicalRoot: string): AsyncGenerator<StoreAcquiredRow> {
    requireProtocol(!attempted && phase === 'idle', 'Store acquisition already attempted');
    attempted = true;
    requireProtocol(
      isAbsolute(canonicalRoot) &&
        normalize(canonicalRoot) === canonicalRoot &&
        !canonicalRoot.includes('\0'),
      'Invalid store canonical root'
    );
    phase = 'reading';
    acquisitionRoot = canonicalRoot;
    try {
      await write({ ...common('request'), canonicalRoot, profile: TRANSCRIPT_STORE_PROFILE });
      for (;;) {
        const frame = await read();
        if (frame.schema === PREFIX + 'closed.v1') {
          close(frame, 'exhausted');
          return;
        }
        requireProtocol(
          keys(frame, ['schema', 'id', 'runtimeDigest', 'token', 'ordinal', 'cells']) &&
            frame.schema === PREFIX + 'row.v1' &&
            frame.ordinal === ordinal + 1 &&
            integer(frame.ordinal, 1, MAX_ROWS) &&
            Array.isArray(frame.cells) &&
            frame.cells.length === 5,
          'Invalid store row'
        );
        const cells = frame.cells.map(sqlCell) as unknown as StoreAcquiredRow['cells'];
        totalBytes += cells.reduce((sum, cell) => sum + byteCharge(cell), 0);
        requireProtocol(totalBytes <= MAX_TOTAL_CELL_BYTES, 'Store total cell bytes exceeded');
        ordinal = frame.ordinal;
        calendarUsed = false;
        phase = 'row';
        yield Object.freeze({ ordinal, cells: Object.freeze(cells) });
        if (pendingCalendar) await pendingCalendar;
        requireProtocol(phase === 'row', 'Store row operation still active');
        phase = 'reading';
        await write({ ...common('control'), ordinal, action: 'continue' });
      }
    } catch (error) {
      if (!isClosed()) unsettled(error);
      throw error;
    } finally {
      if (pendingCalendar) {
        try {
          await pendingCalendar;
        } catch (error) {
          unsettled(error);
        }
      }
      if (phase === 'row') {
        phase = 'reading';
        try {
          await write({ ...common('control'), ordinal, action: 'stop' });
          close(await read(), 'stopped');
        } catch (error) {
          if (isClosed()) cleanupFailure ??= error;
          else unsettled(error);
          throw error;
        }
      }
    }
  };
  return Object.freeze({
    surface,
    rows,
    async continuePublication(
      options: Parameters<NativeTranscriptStorePublicationPort['continuePublication']>[0]
    ) {
      requireProtocol(
        options.renderObservations === undefined || options.renderObservations === true,
        'Invalid native store render observation option'
      );
      requireProtocol(
        publicationEligible &&
          !publicationAttempted &&
          phase === 'closed' &&
          pendingCalendar === null &&
          terminalFailure === undefined &&
          cleanupFailure === undefined &&
          options.canonicalRoot === acquisitionRoot,
        'Native store publication requires one successful exhausted closure and its original root'
      );
      publicationAttempted = true;
      if (signal.aborted) throw signal.reason;
      // Do not spread caller options: neither a token nor another request,
      // transport, phase sequence or signal can replace the acquired identity.
      return continueNativeSessionPublication(invocation, transport, signal, {
        token,
        expectedKinds: ['projection', 'render'],
        canonicalRoot: options.canonicalRoot,
        sessionId: options.sessionId,
        prepare: options.prepare,
        consume: options.consume,
        ...(options.renderObservations === true ? { renderObservations: true } : {}),
      });
    },
    assertClosed(): void {
      if ((confirmedClosed && cleanupFailure === undefined) || (phase === 'idle' && !attempted))
        return;
      throw Object.assign(
        new RuntimeProtocolError(
          confirmedClosed
            ? 'Native transcript store cleanup failed after confirmed close'
            : 'Native transcript store cleanup remains unsettled'
        ),
        { cause: cleanupFailure ?? terminalFailure, sourceClosed: confirmedClosed }
      );
    },
    calendar(seconds: bigint): Promise<StoreUtcCalendarResult> {
      requireProtocol(
        phase === 'row' &&
          !calendarUsed &&
          pendingCalendar === null &&
          typeof seconds === 'bigint' &&
          seconds >= -(1n << 63n) &&
          seconds < 1n << 63n,
        'Store UTC operation outside outstanding row'
      );
      calendarUsed = true;
      phase = 'calendar';
      const operation = (async (): Promise<StoreUtcCalendarResult> => {
        try {
          await write({
            ...common('control'),
            ordinal,
            action: 'utc',
            seconds: seconds.toString(),
          });
          const frame = await read();
          requireProtocol(
            keys(frame, ['schema', 'id', 'runtimeDigest', 'token', 'ordinal', 'calendar']) &&
              frame.schema === PREFIX + 'utc.v1' &&
              frame.ordinal === ordinal,
            'Invalid store UTC response'
          );
          const result = calendarResult(frame.calendar, seconds);
          phase = 'row';
          return result;
        } catch (error) {
          unsettled(error);
          throw error;
        }
      })();
      pendingCalendar = operation;
      void operation.then(
        () => {
          pendingCalendar = null;
        },
        () => {
          pendingCalendar = null;
        }
      );
      return operation;
    },
  });
}
