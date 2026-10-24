/** One phase lease over the publication client's sole reader and controller. */
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { SessionPublicationDescriptor } from './session-publication-wire';
import { awaitSessionPublicationCallback } from './committed-session-reader';
import { deriveRenderGitContext, MAX_RENDER_CONTEXT_BYTES } from './render-context';
import type { SessionPublicationTransport } from './session-publication-client';
import {
  LOCAL_CALENDAR_REQUEST,
  LOCAL_CALENDAR_REPLY,
  RENDERER_CALENDAR_PROFILE,
  MAX_LOCAL_CALENDAR_BATCH,
  MAX_LOCAL_CALENDAR_QUERIES,
  type LocalCalendarRequest,
  type RendererCalendarContext,
} from '../transcripts/renderer-calendar';
import {
  RENDER_OBSERVATION_BINDING,
  RENDER_OBSERVATION_STOP_BINDING,
  snapshotStopSourceCatalog,
  stopSourceInputDigest,
  materializeStopSources,
  type StopSourceCatalog,
  RENDER_OBSERVATION_REQUEST,
  RENDER_OBSERVATION_RESULT,
  RENDER_OBSERVATION_CHUNK,
  RENDER_OBSERVATION_FAILURE,
  RENDER_OBSERVATION_KEYS,
  RENDER_OBSERVATION_CHUNK_BYTES,
  MAX_CALENDAR_OBSERVATION_BYTES,
  decodeObservation,
  observationExact as exact,
  observationObject as object,
  observationRequire as requireValue,
  observationText as text,
  observationDigest as digest,
  type RenderObservationBinding,
  type NativeRenderObservations,
  type ObservationRow,
} from './render-observation-wire';
import { RuntimeProtocolError } from './protocol';

export interface RenderObservationLease {
  readonly observations: NativeRenderObservations;
  assertIdle(): void;
  assertReady(): void;
  close(): void;
}
const integer = (v: unknown, maximum: number): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= maximum;
const nativePath = (v: unknown): v is string => text(v, 4096) && isAbsolute(v) && !/[\r\n]/.test(v);
function context(value: unknown): RendererCalendarContext {
  requireValue(
    object(value) &&
      exact(value, ['originalPid', 'tz', 'tzdir']) &&
      integer(value.originalPid, 0xffffffff) &&
      value.originalPid > 0,
    'Invalid original calendar context'
  );
  const environment = (v: unknown): void => {
    requireValue(
      object(v) &&
        ((v.kind === 'absent' && exact(v, ['kind'])) ||
          (v.kind === 'present' && exact(v, ['kind', 'value']) && text(v.value, 4096))),
      'Invalid original calendar environment'
    );
  };
  environment(value.tz);
  environment(value.tzdir);
  return Object.freeze({
    originalPid: value.originalPid,
    tz: Object.freeze({ ...(value.tz as object) }),
    tzdir: Object.freeze({ ...(value.tzdir as object) }),
  }) as RendererCalendarContext;
}

export async function openNativeRenderObservations(options: {
  readonly binding: RenderObservationBinding;
  readonly transport: SessionPublicationTransport;
  readonly signal: AbortSignal;
  readonly deadlineEpochMs: number;
  /** Validated PREPARE.v2 catalog and original owned INPUTS, never ambient IO. */
  readonly stopSourceInput?: {
    readonly catalog: StopSourceCatalog;
    readonly files: readonly SessionPublicationDescriptor[];
    readonly sessionId: string;
    readonly bytes: (name: string) => Uint8Array;
  };
}): Promise<RenderObservationLease> {
  const binding = Object.freeze({ ...options.binding });
  requireValue(
    exact(binding, ['id', 'runtimeDigest', 'token', 'attempt', 'observationId', 'inputDigest']) &&
      text(binding.id, 128) &&
      binding.id.length > 0 &&
      digest(binding.runtimeDigest) &&
      text(binding.token, 128) &&
      binding.token.length > 0 &&
      !/[^A-Za-z0-9._:-]/.test(binding.token) &&
      text(binding.attempt, 128) &&
      binding.attempt.length > 0 &&
      text(binding.observationId, 128) &&
      binding.observationId.length > 0 &&
      digest(binding.inputDigest) &&
      Number.isSafeInteger(options.deadlineEpochMs),
    'Invalid Render observation lease'
  );
  const controller = new AbortController();
  let active = true,
    busy = false,
    sequence = 0,
    queryCount = 0,
    gitComplete = false;
  const close = (
    reason: unknown = new RuntimeProtocolError('Render observation phase closed')
  ): void => {
    active = false;
    options.signal.removeEventListener('abort', aborted);
    if (!controller.signal.aborted) controller.abort(reason);
  };
  const aborted = (): void => close(options.signal.reason);
  options.signal.addEventListener('abort', aborted, { once: true });
  if (options.signal.aborted) aborted();
  const check = (): void => {
    requireValue(active, 'Render observation phase closed');
    if (controller.signal.aborted) throw controller.signal.reason;
    requireValue(Date.now() < options.deadlineEpochMs, 'Render observation deadline expired');
  };
  const correlated = (row: ObservationRow): void => {
    requireValue(
      ['id', 'runtimeDigest', 'token', 'attempt', 'observationId', 'inputDigest'].every(
        (key) => row[key] === binding[key as keyof RenderObservationBinding]
      ),
      'Mismatched Render observation binding'
    );
  };
  const read = async (signal: AbortSignal, deadlineEpochMs: number): Promise<ObservationRow> => {
    check();
    const bytes = await awaitSessionPublicationCallback({ signal, deadlineEpochMs }, () =>
      options.transport.read(signal)
    );
    check();
    const row = decodeObservation(bytes);
    correlated(row);
    return row;
  };
  try {
    const original = await read(controller.signal, options.deadlineEpochMs);
    const stop = original.schema === RENDER_OBSERVATION_STOP_BINDING;
    requireValue(
      (original.schema === RENDER_OBSERVATION_BINDING || stop) &&
        (options.stopSourceInput !== undefined) === stop &&
        exact(original, [
          ...RENDER_OBSERVATION_KEYS,
          'cwd',
          'executable',
          'calendarContext',
          ...(stop ? ['sourceCatalog'] : []),
        ]) &&
        nativePath(original.cwd) &&
        object(original.executable) &&
        exact(original.executable, ['path', 'physicalPath', 'sha256']) &&
        nativePath(original.executable.path) &&
        nativePath(original.executable.physicalPath) &&
        digest(original.executable.sha256),
      'Invalid Render observation original binding'
    );
    const cwd = original.cwd;
    const executable = Object.freeze({
      path: original.executable.path,
      physicalPath: original.executable.physicalPath,
      sha256: original.executable.sha256,
    });
    const calendarContext = context(original.calendarContext);
    const stopSources =
      options.stopSourceInput === undefined
        ? undefined
        : (() => {
            const input = options.stopSourceInput!;
            const catalog = snapshotStopSourceCatalog(
              original.sourceCatalog,
              input.files,
              input.sessionId
            );
            requireValue(
              isDeepStrictEqual(catalog, input.catalog) &&
                stopSourceInputDigest(input.files, catalog) === binding.inputDigest,
              'Stop source catalog differs from original native input observation'
            );
            return materializeStopSources(catalog, binding, input.bytes);
          })();
    const exchange = async <T>(
      operation: 'git' | 'calendar',
      interpret: (bytes: Buffer) => T,
      request?: LocalCalendarRequest,
      callSignal?: AbortSignal,
      callDeadline = options.deadlineEpochMs
    ): Promise<T> => {
      let call: AbortController | undefined;
      const cancel = (): void => {
        if (call && !call.signal.aborted)
          call.abort(callSignal?.aborted ? callSignal.reason : controller.signal.reason);
      };
      try {
        check();
        requireValue(!busy, 'Concurrent Render observations are forbidden');
        requireValue(
          operation === 'git' ? sequence === 0 : gitComplete,
          'Invalid Render observation operation order'
        );
        requireValue(Number.isSafeInteger(callDeadline), 'Invalid Render observation deadline');
        if (operation === 'calendar') {
          requireValue(
            object(request) &&
              exact(request, [
                'schema',
                'profile',
                'id',
                'runtimeDigest',
                'token',
                'sequence',
                'seconds',
              ]) &&
              request.schema === LOCAL_CALENDAR_REQUEST &&
              request.profile === RENDERER_CALENDAR_PROFILE &&
              request.id === binding.id &&
              request.runtimeDigest === binding.runtimeDigest &&
              request.token === binding.token &&
              request.sequence === sequence &&
              Array.isArray(request.seconds) &&
              request.seconds.length > 0 &&
              request.seconds.length <= MAX_LOCAL_CALENDAR_BATCH,
            'Invalid Render calendar request'
          );
          const unique = new Set<string>();
          for (const seconds of request.seconds) {
            requireValue(
              typeof seconds === 'string' &&
                seconds.length <= 20 &&
                /^-?(0|[1-9][0-9]*)$/.test(seconds),
              'Invalid Render calendar seconds'
            );
            const value = BigInt(seconds);
            requireValue(
              value >= -(1n << 63n) &&
                value < 1n << 63n &&
                value.toString() === seconds &&
                !unique.has(seconds),
              'Invalid Render calendar seconds'
            );
            unique.add(seconds);
          }
          requireValue(
            queryCount + request.seconds.length <= MAX_LOCAL_CALENDAR_QUERIES &&
              Buffer.byteLength(JSON.stringify(request)) <= 32 * 1024,
            'Render calendar query bound exceeded'
          );
          queryCount += request.seconds.length;
        }
        busy = true;
        sequence++;
        call = new AbortController();
        controller.signal.addEventListener('abort', cancel, { once: true });
        callSignal?.addEventListener('abort', cancel, { once: true });
        if (controller.signal.aborted || callSignal?.aborted) cancel();
        const deadlineEpochMs = Math.min(callDeadline, options.deadlineEpochMs);
        const outgoing = {
          schema: RENDER_OBSERVATION_REQUEST,
          ...binding,
          sequence,
          operation,
          ...(request ? { request } : {}),
        };
        requireValue(
          Buffer.byteLength(JSON.stringify(outgoing)) <= 32 * 1024,
          'Render observation request exceeds bound'
        );
        await awaitSessionPublicationCallback({ signal: call.signal, deadlineEpochMs }, () =>
          options.transport.write(outgoing, call!.signal)
        );
        const header = await read(call.signal, deadlineEpochMs);
        requireValue(
          header.sequence === sequence && header.operation === operation,
          'Mismatched Render observation sequence'
        );
        if (header.schema === RENDER_OBSERVATION_FAILURE) {
          requireValue(
            exact(header, [
              ...RENDER_OBSERVATION_KEYS,
              'sequence',
              'operation',
              'category',
              'diagnostic',
              'cleanupSettled',
            ]) &&
              text(header.category, 128) &&
              header.category.length > 0 &&
              text(header.diagnostic, 1024) &&
              typeof header.cleanupSettled === 'boolean',
            'Invalid Render observation failure'
          );
          throw new RuntimeProtocolError(
            `Native Render observation failed (${header.category}): ${header.diagnostic}`
          );
        }
        const maximum =
          operation === 'git' ? MAX_RENDER_CONTEXT_BYTES : MAX_CALENDAR_OBSERVATION_BYTES;
        requireValue(
          header.schema === RENDER_OBSERVATION_RESULT &&
            exact(header, [
              ...RENDER_OBSERVATION_KEYS,
              'sequence',
              'operation',
              'byteLength',
              'sha256',
            ]) &&
            integer(header.byteLength, maximum) &&
            header.byteLength > 0 &&
            digest(header.sha256),
          'Invalid Render observation result'
        );
        const parts: Buffer[] = [];
        let offset = 0;
        while (offset < header.byteLength) {
          const chunk = await read(call.signal, deadlineEpochMs);
          requireValue(
            chunk.schema === RENDER_OBSERVATION_CHUNK &&
              exact(chunk, [
                ...RENDER_OBSERVATION_KEYS,
                'sequence',
                'operation',
                'offset',
                'base64',
              ]) &&
              chunk.sequence === sequence &&
              chunk.operation === operation &&
              chunk.offset === offset &&
              typeof chunk.base64 === 'string' &&
              chunk.base64.length <= 4 * Math.ceil(RENDER_OBSERVATION_CHUNK_BYTES / 3),
            'Invalid Render observation chunk'
          );
          const bytes = Buffer.from(chunk.base64, 'base64');
          requireValue(
            bytes.toString('base64') === chunk.base64 &&
              bytes.length === Math.min(RENDER_OBSERVATION_CHUNK_BYTES, header.byteLength - offset),
            'Invalid Render observation chunk bytes'
          );
          parts.push(bytes);
          offset += bytes.length;
        }
        const result = Buffer.concat(parts, header.byteLength);
        requireValue(
          createHash('sha256').update(result).digest('hex') === header.sha256,
          'Render observation hash mismatch'
        );
        return interpret(result);
      } catch (error) {
        close(error);
        throw error;
      } finally {
        busy = false;
        controller.signal.removeEventListener('abort', cancel);
        callSignal?.removeEventListener('abort', cancel);
      }
    };
    const observations: NativeRenderObservations = Object.freeze({
      binding,
      ...(stopSources === undefined ? {} : { stopSources }),
      async git() {
        return exchange('git', (bytes) => {
          const value = deriveRenderGitContext(bytes, {
            id: binding.id,
            runtimeDigest: binding.runtimeDigest,
            token: binding.token,
            cwd,
            executable,
          });
          gitComplete = true;
          return value;
        });
      },
      calendarContext,
      calendar: Object.freeze({
        async observe(
          request: LocalCalendarRequest,
          signal: AbortSignal,
          deadlineEpochMs: number
        ): Promise<unknown> {
          const selected =
            object(request) && Array.isArray(request.seconds)
              ? Object.freeze({ ...request, seconds: Object.freeze([...request.seconds]) })
              : request;
          return exchange(
            'calendar',
            (bytes) => {
              const result = decodeObservation(bytes);
              requireValue(
                exact(result, [
                  'schema',
                  'profile',
                  'id',
                  'runtimeDigest',
                  'token',
                  'sequence',
                  'context',
                  'results',
                ]) &&
                  result.schema === LOCAL_CALENDAR_REPLY &&
                  result.profile === RENDERER_CALENDAR_PROFILE &&
                  result.id === binding.id &&
                  result.runtimeDigest === binding.runtimeDigest &&
                  result.token === binding.token &&
                  result.sequence === selected.sequence &&
                  JSON.stringify(context(result.context)) === JSON.stringify(calendarContext) &&
                  Array.isArray(result.results) &&
                  result.results.length === selected.seconds.length,
                'Mismatched Render calendar reply'
              );
              return result;
            },
            selected,
            signal,
            deadlineEpochMs
          );
        },
      }),
    });
    return Object.freeze({
      observations,
      assertIdle() {
        check();
        requireValue(!busy, 'Render observation operation is still active');
      },
      assertReady() {
        check();
        requireValue(gitComplete && !busy, 'Render preparation lacks a completed Git observation');
      },
      close() {
        close();
      },
    });
  } catch (error) {
    close(error);
    throw error;
  }
}
