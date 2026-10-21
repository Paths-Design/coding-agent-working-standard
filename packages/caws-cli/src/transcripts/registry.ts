/**
 * Ordered occurrence dispatch, independent of transcript reading and publication.
 *
 * A match owns its row even when it emits nothing. Independent typed state slots
 * model the built-in Python adapters' disjoint namespaces; arbitrary Python
 * adapters communicating through one shared dictionary are not this contract.
 * Partial projections expose tentative events but retain the prior checkpoint.
 * No decoder, attribution label or checkpoint supplies execution authority.
 */
import {
  createAdapterState,
  makeNormalizationContext,
  normalizeOccurrence,
  type AdapterIdentity,
  type AdapterState,
  type NormalizationContext,
  type NormalizationDisposition,
  type NormalizationResult,
  type TranscriptAdapter,
} from './harness-common';
import { isParsedRow, type ParsedRow } from './source-occurrence';
import { KIMI_ADAPTER } from './harness-kimi';
import { createDshAdapter, type DshEmbeddedJsonProfile } from './harness-dsh';
import { CODEX_ADAPTER } from './harness-codex';
import { QWEN_ADAPTER } from './harness-qwen';
import { CLAUDE_ADAPTER, CLAUDE_NOISE_PREFIXES } from './harness-claude';
import { ZCODE_ADAPTER, ZCODE_NOISE_PREFIXES } from './harness-zcode';
import { OPENCODE_SURFACE_REVISION, OPENCODE_NOISE_PREFIXES } from './harness-opencode';

export const TRANSCRIPT_REGISTRY_REVISION = 'native-transcript-registry/1';
const REGISTRATION = Symbol('transcript adapter registration');
const CHECKPOINT = Symbol('transcript registry checkpoint');

export interface RegisteredTranscriptAdapter {
  readonly [REGISTRATION]: true;
  readonly identity: AdapterIdentity;
}
export interface TranscriptHarnessModule {
  readonly id: string;
  readonly revision: string;
  readonly adapters: readonly RegisteredTranscriptAdapter[];
  readonly noisePrefixes: readonly string[];
}
export interface RegistryCheckpoint {
  readonly [CHECKPOINT]: true;
  readonly sourceId: string;
  readonly sourceGeneration: string;
  readonly context: NormalizationContext;
}
export interface RegistryResult extends Omit<NormalizationResult<unknown>, 'nextState'> {
  readonly selectedAdapter: AdapterIdentity | null;
  readonly nextState: RegistryCheckpoint;
}
export interface TranscriptRegistry {
  readonly revision: string;
  readonly modules: readonly TranscriptHarnessModule[];
  readonly adapters: readonly AdapterIdentity[];
  /** Aggregate declarations only. Filtering belongs to the consuming renderer. */
  readonly noisePrefixes: readonly string[];
  readonly context: NormalizationContext;
  createCheckpoint(sourceId: string, sourceGeneration: string): RegistryCheckpoint;
  normalize(parsed: ParsedRow, checkpoint: RegistryCheckpoint): RegistryResult;
}
export interface RegistryContextOptions {
  readonly surface?: string;
  readonly cacheGeneration?: string;
}

interface Slot {
  attempt(
    parsed: ParsedRow,
    context: NormalizationContext
  ): {
    readonly result: NormalizationResult<unknown>;
    readonly nextSlot: Slot;
  };
}
interface Registration {
  create(sourceId: string, generation: string, context: NormalizationContext): Slot;
}
const registrations = new WeakMap<RegisteredTranscriptAdapter, Registration>();
const checkpoints = new WeakMap<
  RegistryCheckpoint,
  {
    readonly owner: object;
    readonly slots: readonly Slot[];
  }
>();

/** Capture method references; the caller owns the supplied callbacks' behavior. */
export function registerTranscriptAdapter<S>(
  adapter: TranscriptAdapter<S>
): RegisteredTranscriptAdapter {
  if (
    !adapter ||
    typeof adapter.id !== 'string' ||
    !adapter.id ||
    typeof adapter.revision !== 'string' ||
    !adapter.revision
  )
    throw new TypeError('adapter identity and revision must be nonempty strings');
  for (const key of ['matches', 'createState', 'cloneState', 'normalize'] as const)
    if (typeof adapter[key] !== 'function') throw new TypeError(`adapter lacks ${key}`);
  const snapshot: TranscriptAdapter<S> = Object.freeze({
    id: adapter.id,
    revision: adapter.revision,
    matches: adapter.matches.bind(adapter),
    createState: adapter.createState.bind(adapter),
    cloneState: adapter.cloneState.bind(adapter),
    normalize: adapter.normalize.bind(adapter),
  });
  const registration: RegisteredTranscriptAdapter = Object.freeze({
    [REGISTRATION]: true as const,
    identity: Object.freeze({ id: snapshot.id, revision: snapshot.revision }),
  });
  const slot = (state: AdapterState<S>): Slot =>
    Object.freeze({
      attempt(parsed: ParsedRow, context: NormalizationContext) {
        const result = normalizeOccurrence(parsed, state, context, snapshot);
        return Object.freeze({ result, nextSlot: slot(result.nextState) });
      },
    });
  registrations.set(registration, {
    create: (sourceId, generation, context) =>
      slot(createAdapterState(snapshot, sourceId, generation, context)),
  });
  return registration;
}

export function createTranscriptRegistry(
  contributions: readonly TranscriptHarnessModule[],
  options: RegistryContextOptions = {}
): TranscriptRegistry {
  const modules = Object.freeze(
    contributions.map((module) => {
      if (
        !module.id ||
        typeof module.id !== 'string' ||
        !module.revision ||
        typeof module.revision !== 'string'
      )
        throw new TypeError('module identity and revision must be nonempty strings');
      if (!module.noisePrefixes.every((prefix) => typeof prefix === 'string'))
        throw new TypeError('noise prefixes must be strings');
      const adapters = Object.freeze([...module.adapters]);
      for (const adapter of adapters)
        if (!registrations.has(adapter)) throw new TypeError('unregistered transcript adapter');
      return Object.freeze({
        id: module.id,
        revision: module.revision,
        adapters,
        noisePrefixes: Object.freeze([...module.noisePrefixes]),
      });
    })
  );
  const ordered = modules.flatMap((module) => module.adapters);
  const identities = Object.freeze(ordered.map((adapter) => adapter.identity));
  const context = makeNormalizationContext(options, identities);
  const owner = Object.freeze({});
  const checkpoint = (
    sourceId: string,
    sourceGeneration: string,
    slots: readonly Slot[]
  ): RegistryCheckpoint => {
    const value: RegistryCheckpoint = Object.freeze({
      [CHECKPOINT]: true as const,
      sourceId,
      sourceGeneration,
      context,
    });
    checkpoints.set(value, { owner, slots: Object.freeze([...slots]) });
    return value;
  };
  const registry: TranscriptRegistry = {
    revision: TRANSCRIPT_REGISTRY_REVISION,
    modules,
    adapters: identities,
    noisePrefixes: Object.freeze(modules.flatMap((module) => module.noisePrefixes)),
    context,
    createCheckpoint(sourceId, sourceGeneration) {
      if (
        typeof sourceId !== 'string' ||
        !sourceId ||
        typeof sourceGeneration !== 'string' ||
        !sourceGeneration
      )
        throw new TypeError('checkpoint requires nonempty source identity and generation');
      const slots = ordered.map((adapter) =>
        registrations.get(adapter)!.create(sourceId, sourceGeneration, context)
      );
      return checkpoint(sourceId, sourceGeneration, slots);
    },
    normalize(parsed, previous) {
      if (!isParsedRow(parsed)) throw new TypeError('registry requires a decoded raw occurrence');
      const prior = checkpoints.get(previous);
      if (!prior) throw new TypeError('registry requires an original checkpoint');
      const refusal = (disposition: NormalizationDisposition): RegistryResult =>
        Object.freeze({
          disposition,
          original: parsed,
          source: parsed.source,
          events: Object.freeze([]),
          selectedAdapter: null,
          nextState: previous,
          tentative: parsed.source.framing === 'partial',
          commitAllowed: false,
        });
      if (JSON.stringify(previous.context) !== JSON.stringify(context))
        return refusal('context_mismatch');
      if (
        previous.sourceId !== parsed.source.sourceId ||
        previous.sourceGeneration !== parsed.source.sourceGeneration
      )
        return refusal('source_mismatch');
      // Equal labels do not make another registry's callback/state slots ours.
      if (prior.owner !== owner) return refusal('adapter_mismatch');
      if (parsed.disposition !== 'parsed') return refusal(parsed.disposition);
      for (let index = 0; index < prior.slots.length; index++) {
        const attempt = prior.slots[index]!.attempt(parsed, context);
        const result = attempt.result;
        if (result.disposition === 'unmatched') continue;
        let nextState = previous;
        if (result.commitAllowed) {
          const slots = [...prior.slots];
          slots[index] = attempt.nextSlot;
          nextState = checkpoint(previous.sourceId, previous.sourceGeneration, slots);
        }
        return Object.freeze({
          disposition: result.disposition,
          original: result.original,
          source: result.source,
          events: result.events,
          nextState,
          selectedAdapter: result.disposition === 'normalized' ? identities[index]! : null,
          tentative: result.tentative,
          commitAllowed: result.commitAllowed,
        });
      }
      return refusal('unmatched');
    },
  };
  return Object.freeze(registry);
}

/** DSH interpretation is supplied explicitly; no global production decoder is chosen. */
export function createDefaultTranscriptRegistry(
  options: RegistryContextOptions & { readonly dshProfile: DshEmbeddedJsonProfile }
): TranscriptRegistry {
  const { dshProfile, ...contextOptions } = options;
  const dsh = createDshAdapter(Object.freeze({ id: dshProfile.id, decode: dshProfile.decode }));
  const module = <S>(
    adapter: TranscriptAdapter<S>,
    noisePrefixes: readonly string[] = []
  ): TranscriptHarnessModule => ({
    id: adapter.id,
    revision: adapter.revision,
    adapters: [registerTranscriptAdapter(adapter)],
    noisePrefixes,
  });
  return createTranscriptRegistry(
    [
      module(KIMI_ADAPTER),
      module(dsh),
      module(CODEX_ADAPTER),
      module(QWEN_ADAPTER),
      module(CLAUDE_ADAPTER, CLAUDE_NOISE_PREFIXES),
      module(ZCODE_ADAPTER, ZCODE_NOISE_PREFIXES),
      {
        id: 'opencode',
        revision: OPENCODE_SURFACE_REVISION,
        adapters: [],
        noisePrefixes: OPENCODE_NOISE_PREFIXES,
      },
    ],
    contextOptions
  );
}
