/** Source-to-artifact computation. Native admission, publication and current-use are separate. */
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import {
  isJsonNumber,
  isJsonObject,
  getMember,
  jsonNumber,
  type JsonNumber,
} from './lossless-json';
import { parseTimestamp } from './harness-common';
import {
  parseTranscriptJson,
  snapshotTranscriptJsonProfile,
  TranscriptJsonNumericConversionError,
} from './transcript-json-profile';
import { type TranscriptRegistry } from './registry';
import {
  accumulateRendererEvents,
  rendererTurnIsSubstantive,
  type RendererDurationPort,
} from './render-accumulator';
import { prepareRendererArtifacts, type PreparedSessionArtifact } from './render-artifacts';
import {
  readRendererSource,
  snapshotRendererSource,
  parseRendererAuxiliary,
  parseRendererSubagents,
  type ObservedRendererFile,
  type ObservedRendererDirectory,
  type PreparedRendererEvent,
  type RenderNumericProfile,
  type RenderReaderCheckpoint,
} from './render-reader';
import {
  isRenderObject,
  isRenderText,
  renderInteger,
  renderJsonBytes,
  renderObject,
  renderTextEqual,
  renderTextLength,
  renderGet,
  renderTruthy,
  type RenderObject,
  type RenderValue,
} from './render-values';

/** The selected calendar port owns datetime parsing, local TZ and Python rounding semantics. */
export interface RendererCalendarPort extends RendererDurationPort {
  readonly timezone: string;
  /** Python datetime.fromisoformat(...).timestamp(); null denotes its ValueError case. */
  epochSeconds(timestamp: string | null): number | null;
}
export interface RendererPreparationContext {
  readonly sessionId: string;
  readonly cwd: string;
  readonly startedAt: string;
  readonly model: string;
  readonly branch: string;
  readonly headSha: string;
  readonly startSha: string;
  readonly dirtyFiles: JsonNumber;
}
export interface ObservedPriorSessionArtifact {
  readonly name: string;
  readonly sha256: string;
  readonly byteLength: number;
}
export interface RendererPreparationLimits {
  readonly maximumInputBytes: number;
  readonly maximumArtifactBytes: number;
  readonly maximumTotalArtifactBytes: number;
  readonly maximumArtifacts: number;
}
export interface PrepareSessionArtifactsInput {
  readonly transcript: ObservedRendererFile;
  readonly audit: ObservedRendererFile;
  readonly hookOutcomes: ObservedRendererFile;
  readonly subagents: {
    readonly claudeCandidate: ObservedRendererDirectory;
    readonly qwenCandidate: ObservedRendererDirectory;
  };
  readonly registry: TranscriptRegistry;
  readonly numericProfile: RenderNumericProfile;
  readonly selectedAdapterOverride?: string;
  readonly calendar: RendererCalendarPort;
  readonly context: RendererPreparationContext;
  readonly priorInventory: {
    readonly observationId: string;
    readonly artifacts: readonly ObservedPriorSessionArtifact[];
  };
  readonly limits: RendererPreparationLimits;
  readonly priorCheckpoint?: RenderReaderCheckpoint;
}
export interface RendererCalendarCatalog {
  readonly timestamps: readonly (string | null)[];
  /** Only actual auxiliary events cause the renderer to evaluate epoch sort keys. */
  readonly sortEpochs: boolean;
}
export type PrepareSessionArtifactsCalendarInput = Omit<PrepareSessionArtifactsInput, 'calendar'>;
export interface PreparedSessionGeneration {
  readonly schema: 'caws.prepared-session-artifacts.v1';
  /** Content identity, never a native publication or invocation token. */
  readonly identity: string;
  readonly context: RenderObject;
  readonly artifacts: readonly PreparedSessionArtifact[];
  readonly proposedRemovals: readonly ObservedPriorSessionArtifact[];
  readonly observations: RenderObject;
}
interface PreparationBase {
  readonly checkpoint: RenderReaderCheckpoint | null;
  readonly publication: 'not_attempted';
  readonly diagnostics: readonly {
    readonly sourcePath: string;
    readonly malformedRecords: number;
  }[];
}
export type SessionArtifactPreparation =
  | (PreparationBase & {
      readonly disposition: 'ready';
      readonly generation: PreparedSessionGeneration;
    })
  | (PreparationBase & {
      readonly disposition: 'retain';
      readonly reason: 'missing_source' | 'empty_source';
      readonly currentness: 'noncurrent';
    })
  | (PreparationBase & { readonly disposition: 'empty' })
  | (PreparationBase & {
      readonly disposition: 'failed';
      readonly failure: { readonly phase: string; readonly cause: unknown };
    });

function observationValue(value: unknown): RenderValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return renderInteger(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value))
      throw new TypeError('Observation numbers must be exact integers');
    return renderInteger(value);
  }
  if (isJsonNumber(value) || isRenderObject(value) || isJsonObject(value)) return value;
  if (Array.isArray(value)) return value.map(observationValue);
  if (value && typeof value === 'object')
    return renderObject(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, observationValue(item)] as const)
    );
  throw new TypeError('Unsupported preparation observation');
}
function snapshotFile(file: ObservedRendererFile): ObservedRendererFile {
  return file.disposition === 'read'
    ? Object.freeze({
        path: file.path,
        disposition: 'read',
        source: snapshotRendererSource(file.source),
      })
    : Object.freeze({ ...file });
}
function snapshotDirectory(directory: ObservedRendererDirectory): ObservedRendererDirectory {
  if (directory.kind !== 'directory') return Object.freeze({ ...directory });
  return Object.freeze({
    ...directory,
    listing:
      directory.listing.disposition === 'failed'
        ? Object.freeze({ ...directory.listing })
        : Object.freeze({
            disposition: 'listed' as const,
            entries: Object.freeze(
              directory.listing.entries.map((entry) =>
                Object.freeze({ name: entry.name, file: snapshotFile(entry.file) })
              )
            ),
          }),
  });
}
function snapshotCalendar(calendar: RendererCalendarPort): RendererCalendarPort {
  const { profileId, timezone, epochSeconds, secondsBetween } = calendar;
  return Object.freeze({
    profileId,
    timezone,
    epochSeconds: epochSeconds.bind(calendar),
    secondsBetween: secondsBetween.bind(calendar),
  });
}
function requireCalendar(calendar: RendererCalendarPort): void {
  if (!calendar.profileId || typeof calendar.timezone !== 'string' || !calendar.timezone)
    throw new TypeError('An explicit calendar/timezone profile is required');
}
function calendarCatalog(
  transcript: readonly PreparedRendererEvent[],
  auxiliary: readonly PreparedRendererEvent[]
): RendererCalendarCatalog {
  const sortEpochs = auxiliary.length > 0;
  const timestamps = new Set<string | null>();
  for (const prepared of [...transcript, ...auxiliary]) {
    const ts = prepared.envelope.event.ts;
    if (sortEpochs) {
      // Keep merge's exact raw sort keys, including an empty string if a
      // selected registry emits it; duration normalization can map it to null.
      if (ts !== undefined && ts !== null && typeof ts !== 'string')
        throw new TypeError('Merged timestamp must be normalized text');
      timestamps.add(ts ?? null);
    }
    // The accumulator normalizes every event through this same function.
    // Tool-use/result duration endpoints therefore remain catalogued even
    // when no auxiliary source causes sorting.
    timestamps.add(parseTimestamp(ts));
  }
  return Object.freeze({ timestamps: Object.freeze([...timestamps]), sortEpochs });
}
/** Auxiliary presence controls sorting; an absent auxiliary never reorders transcript events. */
export function mergeRendererChronologicalEvents(
  transcript: readonly PreparedRendererEvent[],
  auxiliary: readonly PreparedRendererEvent[],
  calendar: RendererCalendarPort
): readonly PreparedRendererEvent[] {
  if (!auxiliary.length) return transcript;
  const priorities: Readonly<Record<string, number>> = {
    turn_boundary: 0,
    user_text: 1,
    assistant_text: 2,
    tool_use: 3,
    hook_context: 4,
    audit_action: 5,
    tool_result: 6,
  };
  const decorated = [...transcript, ...auxiliary].map((event, index) => {
    const ts = event.envelope.event.ts;
    if (ts !== undefined && ts !== null && typeof ts !== 'string')
      throw new TypeError('Merged timestamp must be normalized text');
    const epoch = calendar.epochSeconds(ts ?? null);
    if (epoch !== null && !Number.isFinite(epoch))
      throw new TypeError('Calendar returned a nonfinite epoch');
    return {
      event,
      index,
      epoch: epoch ?? Infinity,
      priority: priorities[event.envelope.event.ev] ?? 4,
    };
  });
  decorated.sort(
    (a, b) =>
      (a.epoch < b.epoch ? -1 : a.epoch > b.epoch ? 1 : 0) ||
      a.priority - b.priority ||
      a.index - b.index
  );
  return Object.freeze(decorated.map((item) => item.event));
}
function lineage(file: ObservedRendererFile, numericProfile: RenderNumericProfile): RenderValue {
  if (file.disposition !== 'read') return null;
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(file.source.bytes);
  for (const line of text.replace(/\r\n?/g, '\n').split('\n').slice(0, 32)) {
    let value;
    try {
      value = parseTranscriptJson(line, numericProfile);
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof TranscriptJsonNumericConversionError)
        continue;
      throw error;
    }
    if (!isJsonObject(value) || getMember(value, 'type') !== 'session_meta') continue;
    const payload = getMember(value, 'payload');
    if (!isJsonObject(payload)) continue;
    const first = getMember(payload, 'forked_from'),
      fallback = getMember(payload, 'parent_session_id');
    const parent = renderTruthy(first) ? first : fallback;
    if (typeof parent === 'string' && parent)
      return renderObject([
        ['parent_session_id', parent],
        ['source', 'transcript_metadata'],
        ['authority', 'none'],
        ['source_path', file.path],
      ]);
  }
  return null;
}

function* preparationStages(
  input: PrepareSessionArtifactsCalendarInput,
  suppliedCalendar?: () => RendererCalendarPort
): Generator<RendererCalendarCatalog, SessionArtifactPreparation, RendererCalendarPort> {
  // Adopt a prior physical transaction only after acquiring an owned source.
  // Admission errors cannot expose a checkpoint selected by a live getter.
  let checkpoint: RenderReaderCheckpoint | null = null;
  let phase = 'input';
  let diagnostics: PreparationBase['diagnostics'] = Object.freeze([]);
  const base = (): PreparationBase => ({ checkpoint, publication: 'not_attempted', diagnostics });
  try {
    const limits = Object.freeze({ ...input.limits });
    for (const limit of Object.values(limits))
      if (!Number.isSafeInteger(limit) || limit < 1)
        throw new RangeError('Preparation limits must be positive exact integers');
    if (Object.keys(limits).length !== 4)
      throw new TypeError('Complete declared preparation limits are required');
    let totalInput = 0;
    const account = (file: ObservedRendererFile): void => {
      if (file.disposition === 'read') {
        if (!(file.source.bytes instanceof Uint8Array))
          throw new TypeError('Observed input must contain owned byte values');
        totalInput += file.source.bytes.byteLength;
      }
      if (totalInput > limits.maximumInputBytes)
        throw new RangeError('Preparation input exceeds the declared byte profile');
    };
    // Refuse the declared input frontier before allocating any owned source copies.
    for (const file of [input.transcript, input.audit, input.hookOutcomes]) account(file);
    for (const directory of [input.subagents.claudeCandidate, input.subagents.qwenCandidate]) {
      if (directory.kind === 'directory' && directory.listing.disposition === 'listed')
        for (const entry of directory.listing.entries) account(entry.file);
    }
    const transcript = snapshotFile(input.transcript),
      audit = snapshotFile(input.audit),
      hookOutcomes = snapshotFile(input.hookOutcomes);
    const subagents = Object.freeze({
      claudeCandidate: snapshotDirectory(input.subagents.claudeCandidate),
      qwenCandidate: snapshotDirectory(input.subagents.qwenCandidate),
    });
    const priorCheckpoint = input.priorCheckpoint;
    if (
      !(transcript.disposition === 'read' && transcript.source.kind === 'publication-buffer') &&
      priorCheckpoint?.kind !== 'publication-buffer'
    )
      checkpoint = priorCheckpoint ?? null;
    const registry = input.registry,
      numericProfile = snapshotTranscriptJsonProfile(input.numericProfile);
    const priorObservationId = input.priorInventory.observationId;
    // Preserve synchronous calendar acquisition/validation ordering. The async
    // path does not consult its resolver until the retained read stage is ready.
    const selectedCalendar = suppliedCalendar ? snapshotCalendar(suppliedCalendar()) : null;
    const observedContext = { ...input.context };
    const observedDirty = observedContext.dirtyFiles;
    const dirtySnapshot =
      observedDirty !== null && typeof observedDirty === 'object' && !Array.isArray(observedDirty)
        ? {
            kind: observedDirty.kind,
            lexeme: observedDirty.lexeme,
            numberKind: observedDirty.numberKind,
          }
        : observedDirty;
    if (
      !observedContext.sessionId ||
      !observedContext.cwd ||
      !isJsonNumber(dirtySnapshot) ||
      dirtySnapshot.numberKind !== 'integer'
    )
      throw new TypeError('Session context is incomplete');
    const contextInput = Object.freeze({
      ...observedContext,
      dirtyFiles: jsonNumber(dirtySnapshot.lexeme),
    });
    if (selectedCalendar) requireCalendar(selectedCalendar);
    if (input.selectedAdapterOverride !== undefined)
      throw new TypeError(
        'Selected adapter override is unsupported by preparation; fallback refused'
      );
    if (
      !numericProfile.id ||
      !Number.isSafeInteger(numericProfile.integerMaxDigits) ||
      (numericProfile.integerMaxDigits !== 0 && numericProfile.integerMaxDigits < 640)
    )
      throw new TypeError('A supported numeric reader profile is required');
    if (
      registry.context.numericProfile?.id !== numericProfile.id ||
      registry.context.numericProfile?.integerMaxDigits !== numericProfile.integerMaxDigits
    )
      throw new TypeError('Registry and preparation numeric profiles must agree exactly');
    const prior = input.priorInventory.artifacts.map((observed) => {
      const item = Object.freeze({ ...observed });
      if (
        !item.name ||
        path.basename(item.name) !== item.name ||
        item.name === '.' ||
        item.name === '..' ||
        !/^[0-9a-f]{64}$/.test(item.sha256) ||
        !Number.isSafeInteger(item.byteLength) ||
        item.byteLength < 0
      )
        throw new TypeError('Invalid observed prior artifact');
      return item;
    });
    if (!priorObservationId || new Set(prior.map((item) => item.name)).size !== prior.length)
      throw new TypeError('Prior inventory observation is missing or ambiguous');
    const history = prior.some((item) => /^turn-\p{Decimal_Number}+\.(json|txt)$/u.test(item.name));
    if (transcript.disposition === 'failed')
      throw new Error(`Transcript read failed: ${transcript.error}`);
    if (transcript.disposition === 'absent' && history)
      return Object.freeze({
        ...base(),
        disposition: 'retain',
        reason: 'missing_source',
        currentness: 'noncurrent',
      });
    let events: readonly PreparedRendererEvent[] = Object.freeze([]);
    phase = 'reader';
    if (transcript.disposition === 'read') {
      const read = readRendererSource({
        source: transcript.source,
        registry,
        numericProfile,
        ...(checkpoint ? { priorCheckpoint: checkpoint } : {}),
      });
      checkpoint = read.checkpoint;
      if (read.disposition === 'failed')
        return Object.freeze({
          ...base(),
          disposition: 'failed',
          failure: Object.freeze({ phase: read.failure.phase, cause: read.failure }),
        });
      events = read.events;
      if (!events.length && history)
        return Object.freeze({
          ...base(),
          disposition: 'retain',
          reason: 'empty_source',
          currentness: 'noncurrent',
        });
    }
    phase = 'auxiliary';
    const auxiliary = parseRendererAuxiliary({
      audit,
      hookOutcomes,
      sessionId: contextInput.sessionId,
      numericProfile,
    });
    diagnostics = auxiliary.diagnostics;
    if (auxiliary.disposition === 'failed')
      return Object.freeze({
        ...base(),
        disposition: 'failed',
        failure: Object.freeze({ phase, cause: auxiliary.failure }),
      });
    if (!selectedCalendar && !events.length && !auxiliary.events.length)
      return Object.freeze({ ...base(), disposition: 'empty' });
    // The asynchronous path owns accumulation inputs before suspension.
    // Synchronous callers retain merge-before-noise observation ordering.
    let noisePrefixes: readonly string[] | undefined;
    if (!selectedCalendar) {
      phase = 'accumulation';
      noisePrefixes = Object.freeze([...registry.noisePrefixes]);
    }
    phase = 'calendar';
    const calendar =
      selectedCalendar ?? snapshotCalendar(yield calendarCatalog(events, auxiliary.events));
    requireCalendar(calendar);
    phase = 'accumulation';
    const merged = mergeRendererChronologicalEvents(events, auxiliary.events, calendar);
    const accumulated = accumulateRendererEvents(merged, contextInput.cwd, {
      noisePrefixes: noisePrefixes ?? Object.freeze([...registry.noisePrefixes]),
      duration: calendar,
      numericProfile,
    });
    const turns = accumulated.turns.filter(rendererTurnIsSubstantive);
    if (!turns.length)
      return history
        ? Object.freeze({
            ...base(),
            disposition: 'retain',
            reason: transcript.disposition === 'read' ? 'empty_source' : 'missing_source',
            currentness: 'noncurrent',
          })
        : Object.freeze({ ...base(), disposition: 'empty' });
    const models: RenderValue[] = [];
    for (const turn of turns) {
      for (const model of [...turn.models, renderGet(turn.env, 'model')]) {
        if (
          isRenderText(model) &&
          renderTextLength(model) &&
          !models.some(
            (priorModel) => isRenderText(priorModel) && renderTextEqual(priorModel, model)
          )
        )
          models.push(model);
      }
    }
    const model =
      (!contextInput.model || contextInput.model === 'unknown') && models.length
        ? models[0]!
        : contextInput.model;
    const context = renderObject([
      ['session_id', contextInput.sessionId],
      ['project', path.basename(contextInput.cwd)],
      ['cwd', contextInput.cwd],
      ['model', model],
      ['session_started_at', contextInput.startedAt],
      ['branch', contextInput.branch],
      ['head_sha', contextInput.headSha],
      ['start_sha', contextInput.startSha],
      ['dirty_files', contextInput.dirtyFiles],
      ['lineage', lineage(transcript, numericProfile)],
    ]);
    phase = 'metadata';
    const metadata = parseRendererSubagents({
      ...subagents,
      transcriptPath: transcript.path,
      sessionId: contextInput.sessionId,
      numericProfile,
    });
    if (metadata.disposition === 'failed')
      return Object.freeze({
        ...base(),
        disposition: 'failed',
        failure: Object.freeze({ phase, cause: metadata.failure }),
      });
    phase = 'encoding';
    const encoded = prepareRendererArtifacts(turns, context, metadata.links, numericProfile);
    let totalArtifacts = 0;
    if (encoded.artifacts.length > limits.maximumArtifacts)
      throw new RangeError('Prepared artifact count exceeds declared profile');
    for (const artifact of encoded.artifacts) {
      totalArtifacts += artifact.byteLength;
      if (
        artifact.byteLength > limits.maximumArtifactBytes ||
        totalArtifacts > limits.maximumTotalArtifactBytes
      )
        throw new RangeError('Prepared artifact bytes exceed declared profile');
    }
    const names = new Set(encoded.artifacts.map((item) => item.name));
    const proposedRemovals = Object.freeze(
      prior.filter(
        (item) =>
          !names.has(item.name) &&
          (/^turn-\p{Decimal_Number}+\.(json|txt)$/u.test(item.name) ||
            /^turn-.*\.payloads\.json$/.test(item.name))
      )
    );
    const observations = renderObject([
      [
        'transcript',
        observationValue(
          transcript.disposition === 'read'
            ? {
                path: transcript.path,
                disposition: transcript.disposition,
                ...(transcript.source.kind === 'publication-buffer'
                  ? {
                      kind: transcript.source.kind,
                      binding: transcript.source.binding,
                      descriptor: transcript.source.descriptor,
                    }
                  : {
                      sourceId: transcript.source.sourceId,
                      sourceGeneration: transcript.source.sourceGeneration,
                      inode: transcript.source.inode,
                    }),
                size: transcript.source.size,
                sha256: createHash('sha256').update(transcript.source.bytes).digest('hex'),
              }
            : transcript
        ),
      ],
      ['reader_context', observationValue(checkpoint?.context ?? null)],
      ['auxiliary', observationValue(auxiliary.observations)],
      ['metadata', observationValue(metadata.observations)],
      [
        'calendar',
        observationValue({ profileId: calendar.profileId, timezone: calendar.timezone }),
      ],
      [
        'prior_inventory',
        observationValue({ observationId: priorObservationId, artifacts: prior }),
      ],
      ['limits', observationValue(limits)],
    ]);
    const identityInput = renderObject([
      ['context', context],
      ['observations', observations],
      [
        'artifacts',
        observationValue(
          encoded.artifacts.map((item) => ({
            name: item.name,
            role: item.role,
            byteLength: item.byteLength,
            sha256: item.sha256,
          }))
        ),
      ],
      ['proposed_removals', observationValue(proposedRemovals)],
    ]);
    const identity = createHash('sha256')
      .update(renderJsonBytes(identityInput, { indent: 2, ensureAscii: true, numericProfile }))
      .digest('hex');
    return Object.freeze({
      ...base(),
      disposition: 'ready',
      generation: Object.freeze({
        schema: 'caws.prepared-session-artifacts.v1',
        identity,
        context,
        artifacts: encoded.artifacts,
        proposedRemovals,
        observations,
      }),
    });
  } catch (cause) {
    return Object.freeze({
      ...base(),
      disposition: 'failed',
      failure: Object.freeze({ phase, cause }),
    });
  }
}

function completedPreparation(
  step: IteratorResult<RendererCalendarCatalog, SessionArtifactPreparation>
): SessionArtifactPreparation {
  if (!step.done) throw new Error('Preparation requested more than one calendar resolution');
  return step.value;
}

/** Synchronous callers retain their explicit calendar and its validation ordering. */
export function prepareSessionArtifacts(
  input: PrepareSessionArtifactsInput
): SessionArtifactPreparation {
  return completedPreparation(preparationStages(input, () => input.calendar).next());
}

/** Resolve one calendar catalog after owned transcript/auxiliary parsing, then
 * continue that same private stage. The resolver owns its cancellation/deadline
 * contract; this pure computation grants no publication or native custody. */
export async function prepareSessionArtifactsWithCalendar(
  input: PrepareSessionArtifactsCalendarInput,
  resolveCalendar: (catalog: RendererCalendarCatalog) => Promise<RendererCalendarPort>
): Promise<SessionArtifactPreparation> {
  const stages = preparationStages(input);
  const step = stages.next();
  if (step.done) return step.value;
  let calendar: RendererCalendarPort;
  try {
    calendar = await resolveCalendar(step.value);
  } catch (cause) {
    return completedPreparation(stages.throw(cause));
  }
  return completedPreparation(stages.next(calendar));
}
