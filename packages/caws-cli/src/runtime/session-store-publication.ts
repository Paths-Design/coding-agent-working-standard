/** SQL projection to publication adapter. No engine selection or native activation. */
import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { parseJsonSource } from './json-custody';
import type { HandlerResult } from './composer';
import { createDefaultTranscriptRegistry } from '../transcripts/registry';
import { snapshotTranscriptJsonProfile } from '../transcripts/transcript-json-profile';
import {
  resolveRendererCalendar,
  RENDERER_CALENDAR_PROFILE,
} from '../transcripts/renderer-calendar';
import type { RenderNumericProfile, ObservedRendererFile } from '../transcripts/render-reader';
import {
  prepareSessionArtifactsWithCalendar,
  type PrepareSessionArtifactsCalendarInput,
  type RendererPreparationContext,
  type RendererPreparationLimits,
} from '../transcripts/render-prepare';
import {
  encodeStoreProjectionEvents,
  type StoreProjectionLimits,
} from '../transcripts/store-projection';
import {
  reconstructNativeTranscriptStore,
  type NativeTranscriptStorePublicationPort,
} from './transcript-store-client';
import {
  type SessionPublicationInput,
  type SessionPublicationPreparation,
  type SessionPublicationReceipt,
} from './session-publication-client';
import { createSessionLogPublicationConsumer } from './session-log';
import {
  MAX_PUBLICATION_ARTIFACT_BYTES,
  type SessionPublicationDescriptor,
} from './session-publication-wire';
import { RuntimeProtocolError } from './protocol';
import { snapshotStoreJsonProfile, type StoreJsonProfile } from '../transcripts/store-json';

export interface SessionStorePublicationOptions {
  readonly port: NativeTranscriptStorePublicationPort;
  readonly canonicalRoot: string;
  readonly sessionId: string;
  readonly limits: StoreProjectionLimits;
  /** Caller must explicitly select a supported SQL profile. Selection alone
   * does not establish production qualification; renderer selection is separate. */
  readonly sqlProfile: StoreJsonProfile;
  readonly maximumProjectionBytes: number;
  /** Explicit lease for the selected Render continuation; not profile authority. */
  readonly renderObservations?: true;
  /** Caller must supply admitted renderer context/calendar; no fixture defaults. */
  readonly prepareRender: (
    input: SessionPublicationInput
  ) => Promise<SessionPublicationPreparation>;
  readonly consumer: Parameters<typeof createSessionLogPublicationConsumer>[0];
}

/** Complete one acquisition and use the ordinary current-generation reader.
 * Exceptions never grant compatibility fallback, SQL replay or a second attempt.
 */
export async function publishNativeTranscriptStore(
  options: SessionStorePublicationOptions
): Promise<SessionPublicationReceipt> {
  // Refuse absent or unsupported selectors before observing the port or consumer.
  const sqlProfile = snapshotStoreJsonProfile(options.sqlProfile);
  if (
    !Number.isSafeInteger(options.maximumProjectionBytes) ||
    options.maximumProjectionBytes < 0 ||
    options.maximumProjectionBytes > MAX_PUBLICATION_ARTIFACT_BYTES ||
    typeof options.prepareRender !== 'function' ||
    !['opencode', 'zcode'].includes(options.port.surface)
  )
    throw new RuntimeProtocolError('Invalid native store publication adapter input');
  const consume = createSessionLogPublicationConsumer(options.consumer);
  const projection = await reconstructNativeTranscriptStore(
    options.port,
    options.canonicalRoot,
    options.port.surface,
    options.limits,
    sqlProfile
  );
  // Serialization follows actual exhausted acquisition; assertClosed alone
  // cannot authorize the handoff, which the same port independently enforces.
  const bytes = encodeStoreProjectionEvents(projection, options.maximumProjectionBytes);
  return options.port.continuePublication({
    canonicalRoot: options.canonicalRoot,
    sessionId: options.sessionId,
    consume,
    ...(options.renderObservations === true ? { renderObservations: true as const } : {}),
    async prepare(input) {
      if (input.kind === 'projection')
        return {
          disposition: 'ready',
          artifacts: [
            { name: 'store-projection.jsonl', role: 'projection', bytes: Uint8Array.from(bytes) },
          ],
          removals: [],
        };
      if (
        input.kind !== 'render' ||
        input.files.filter(
          (item) => item.name === 'store-projection.jsonl' && item.role === 'projection'
        ).length !== 1 ||
        !Buffer.from(input.bytes('store-projection.jsonl')).equals(Buffer.from(bytes))
      )
        throw new RuntimeProtocolError(
          'Native render input differs from the exhausted store projection'
        );
      return options.prepareRender(input);
    },
  });
}

/** Data supplied by the native-owned source observation. In particular, absence
 * is an observation; the adapter never infers it from an omitted optional input.
 * These values confer no generation, profile or publication authority. */
export interface StopRendererSources {
  readonly transcriptPath: string;
  readonly audit: { readonly path: string; readonly presence: 'present' | 'absent' };
  readonly hookOutcomes: { readonly path: string; readonly presence: 'present' | 'absent' };
  readonly subagents: PrepareSessionArtifactsCalendarInput['subagents'];
}
export interface NativeStopPublicationOptions {
  readonly port: NativeTranscriptStorePublicationPort;
  readonly canonicalRoot: string;
  readonly sessionId: string;
  readonly signal: AbortSignal;
  readonly deadlineEpochMs: number;
  readonly sqlProfile: StoreJsonProfile;
  readonly rendererProfile: RenderNumericProfile;
  readonly storeLimits: StoreProjectionLimits;
  readonly rendererLimits: RendererPreparationLimits;
  readonly maximumProjectionBytes: number;
  readonly calendarLimits: {
    readonly maximumTimestampBytes: number;
    readonly maximumQueries: number;
  };
  readonly sources: StopRendererSources;
  readonly observe: (fields: Readonly<Record<string, unknown>>) => void | Promise<void>;
}

function sameInputDescriptor(
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

/** The stock writer's string-valued metadata profile. Nonstring jq output,
 * multiple JSON documents and invalid UTF-8 are outside this adapter's admitted
 * input domain and fail explicitly, rather than being coerced or defaulted. */
function stopMetadata(
  input: SessionPublicationInput
): Pick<RendererPreparationContext, 'startedAt' | 'model' | 'startSha'> {
  const prior = input.priorInventory.filter((item) => item.name === '.meta.json');
  const current = input.files.filter((item) => item.name === '.meta.json');
  if (
    prior.length > 1 ||
    current.length !== prior.length ||
    prior.some(
      (item, index) => item.role !== 'metadata' || !sameInputDescriptor(item, current[index]!)
    )
  )
    throw new RuntimeProtocolError('Stop metadata differs from original inventory');
  if (!prior.length)
    return Object.freeze({ startedAt: '(resumed session)', model: 'unknown', startSha: '' });
  const raw = input.bytes('.meta.json');
  if (
    raw.byteLength !== prior[0]!.byteLength ||
    createHash('sha256').update(raw).digest('hex') !== prior[0]!.sha256
  )
    throw new RuntimeProtocolError('Stop metadata differs from original captured bytes');
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw);
  parseJsonSource(text, 128, 100_000);
  const value: unknown = JSON.parse(text);
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new RuntimeProtocolError('Stop metadata is outside the stock object profile');
  const row = value as Record<string, unknown>;
  const field = (name: string, fallback: string): string => {
    const selected = row[name];
    if (selected === undefined || selected === null || selected === false) return fallback;
    if (
      typeof selected !== 'string' ||
      selected.includes('\0') ||
      /[\ud800-\udfff]/u.test(selected)
    )
      throw new RuntimeProtocolError('Stop metadata is outside the stock string profile: ' + name);
    // Bash command substitution removes every trailing LF from jq -r output.
    return selected.replace(/\n+$/, '');
  };
  return Object.freeze({
    startedAt: field('local_time', 'unknown'),
    model: field('model', 'unknown'),
    startSha: field('head_sha', ''),
  });
}

/** Actual SQL -> captured Render -> ordinary current-generation reader. The
 * caller must already hold native admission; selectors are data, never a grant.
 * Every thrown acquisition/cleanup/lease/consumer failure propagates unchanged. */
export async function executeNativeStopPublication(
  options: NativeStopPublicationOptions
): Promise<HandlerResult> {
  const rendererProfile = snapshotTranscriptJsonProfile(options.rendererProfile);
  const sqlProfile = snapshotStoreJsonProfile(options.sqlProfile);
  if (options.port.surface !== 'opencode')
    throw new RuntimeProtocolError('Ordinary native Stop publication supports OpenCode only');
  let expected: Extract<SessionPublicationPreparation, { disposition: 'ready' }> | undefined;
  let expectedProjection: Buffer | undefined;
  let preparationDiagnostic: string | undefined;
  await publishNativeTranscriptStore({
    port: options.port,
    canonicalRoot: options.canonicalRoot,
    sessionId: options.sessionId,
    limits: options.storeLimits,
    sqlProfile,
    maximumProjectionBytes: options.maximumProjectionBytes,
    renderObservations: true,
    async prepareRender(input) {
      if (options.signal.aborted) throw options.signal.reason;
      const observations = input.observations;
      if (
        input.kind !== 'render' ||
        input.sessionId !== options.sessionId ||
        !observations ||
        observations.binding.observationId !== input.observationId ||
        observations.binding.inputDigest !== input.inputDigest
      )
        throw new RuntimeProtocolError(
          'Stop Render requires its original native observation lease'
        );
      const metadata = stopMetadata(input);
      const binding = observations.binding;
      const source = (
        name: string,
        role: string,
        path: string,
        presence: 'present' | 'absent'
      ): ObservedRendererFile => {
        const matching = input.files.filter((item) => item.name === name);
        if (presence === 'absent') {
          if (matching.length)
            throw new RuntimeProtocolError('Stop source contradicts native absence: ' + name);
          return { path, disposition: 'absent' };
        }
        if (matching.length !== 1 || matching[0]!.role !== role)
          throw new RuntimeProtocolError('Stop native source is missing or has changed: ' + name);
        const bytes = input.bytes(name),
          descriptor = matching[0]!;
        return {
          path,
          disposition: 'read',
          source: {
            kind: 'publication-buffer',
            binding,
            descriptor,
            size: BigInt(bytes.byteLength),
            bytes,
          },
        };
      };
      const git = await observations.git();
      const transcript = source(
        'store-projection.jsonl',
        'projection',
        options.sources.transcriptPath,
        'present'
      );
      expectedProjection = Buffer.from(input.bytes('store-projection.jsonl'));
      const prepared = await prepareSessionArtifactsWithCalendar(
        {
          transcript,
          audit: source(
            'audit.log',
            'audit',
            options.sources.audit.path,
            options.sources.audit.presence
          ),
          hookOutcomes: source(
            'hook-events.jsonl',
            'hook_outcomes',
            options.sources.hookOutcomes.path,
            options.sources.hookOutcomes.presence
          ),
          subagents: options.sources.subagents,
          registry: createDefaultTranscriptRegistry({
            surface: 'opencode',
            numericProfile: rendererProfile,
          }),
          numericProfile: rendererProfile,
          context: { ...git, ...metadata, sessionId: options.sessionId },
          priorInventory: { observationId: input.observationId, artifacts: input.priorInventory },
          limits: options.rendererLimits,
        },
        (catalog) =>
          resolveRendererCalendar({
            profile: RENDERER_CALENDAR_PROFILE,
            id: binding.id,
            runtimeDigest: binding.runtimeDigest,
            token: binding.token,
            context: observations.calendarContext,
            timestamps: catalog.timestamps,
            sortEpochs: catalog.sortEpochs,
            maximumTimestampBytes: options.calendarLimits.maximumTimestampBytes,
            maximumQueries: options.calendarLimits.maximumQueries,
            port: observations.calendar,
            signal: options.signal,
            deadlineEpochMs: options.deadlineEpochMs,
          })
      );
      if (prepared.disposition === 'failed') throw prepared.failure.cause;
      if (prepared.disposition !== 'ready') {
        preparationDiagnostic =
          'Stop renderer ' +
          prepared.disposition +
          (prepared.disposition === 'retain' ? ': ' + prepared.reason : '');
        return { disposition: 'aborted', diagnostic: preparationDiagnostic };
      }
      expected = Object.freeze({
        disposition: 'ready' as const,
        artifacts: Object.freeze(
          prepared.generation.artifacts.map((item) =>
            Object.freeze({ name: item.name, role: item.role, bytes: item.bytes() })
          )
        ),
        removals: Object.freeze(prepared.generation.proposedRemovals.map((item) => item.name)),
      });
      return expected;
    },
    consumer: {
      async published(log, outcome) {
        if (
          !expected ||
          !expectedProjection ||
          log.projectionJsonl === undefined ||
          !Buffer.from(log.projectionJsonl).equals(expectedProjection)
        )
          throw new RuntimeProtocolError(
            'Committed Stop projection differs from exhausted acquisition'
          );
        for (const artifact of expected.artifacts)
          if (
            !Buffer.from(outcome.session.bytes(artifact.name)).equals(Buffer.from(artifact.bytes))
          )
            throw new RuntimeProtocolError(
              'Committed Stop artifact differs from preparation: ' + artifact.name
            );
        if (
          expected.removals.some((name) =>
            outcome.session.artifacts.some((item) => item.name === name)
          )
        )
          throw new RuntimeProtocolError('Committed Stop retains a removed artifact');
        await options.observe({
          status: 'published',
          terminal_digest: log.terminalDigest,
          session_id: log.sessionId,
          turn_count: log.turns.length,
          spill_count: log.spills.length,
          projection_sha256: createHash('sha256').update(expectedProjection).digest('hex'),
          artifact_sha256: expected.artifacts.map((item) => ({
            name: item.name,
            sha256: createHash('sha256').update(item.bytes).digest('hex'),
          })),
        });
      },
      async notPublished(outcome) {
        await options.observe({
          status: 'not_published',
          terminal_digest: outcome.receipt.terminalDigest,
          diagnostic: preparationDiagnostic ?? outcome.receipt.error ?? null,
        });
      },
    },
  });
  if (options.signal.aborted) throw options.signal.reason;
  return { exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array() };
}
