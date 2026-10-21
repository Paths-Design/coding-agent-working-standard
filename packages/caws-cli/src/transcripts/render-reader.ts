/** Observed-byte acquisition. Observations and checkpoints confer no native path authority. */
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import {
  parseTimestamp,
  parseContextAuthorityBlock,
  type CanonicalEvent,
  type EventEnvelope,
  type NormalizationContext,
} from './harness-common';
import { extractCodexSourceIndex, type CodexSourceIndex } from './harness-codex';
import {
  getMember,
  isJsonObject,
  isJsonNumber,
  jsonObject,
  jsonNumber,
  parsePythonJson,
  pythonTruthy,
  pythonEqual,
  type JsonValue,
  type JsonObject,
} from './lossless-json';
import { pythonStrip, codepointSlice, codepointOrder } from './source-occurrence';
import { renderObject, type RenderValue } from './render-values';
import type { PreparedSubagentLink } from './render-artifacts';
import { type TranscriptRegistry, type RegistryCheckpoint } from './registry';
import { decodeProfiledOccurrence } from './source-occurrence';

export interface RenderNumericProfile {
  readonly id: string;
  /** CPython int_max_str_digits: zero disables the cap; positive values are at least 640. */
  readonly integerMaxDigits: number;
}
export const RENDER_JSON_4300: RenderNumericProfile = Object.freeze({
  id: 'cpython3.11-json/int-max-str-digits:4300',
  integerMaxDigits: 4300,
});
export const RENDER_JSON_UNLIMITED: RenderNumericProfile = Object.freeze({
  id: 'cpython3.11-json/int-max-str-digits:0',
  integerMaxDigits: 0,
});
export interface RendererSourceObservation {
  readonly sourceId: string;
  readonly sourceGeneration: string;
  readonly inode: string;
  readonly size: bigint;
  readonly bytes: Uint8Array;
}
export interface RendererInterpretationContext {
  readonly profileId: 'renderer-reader/1';
  readonly numericProfile: RenderNumericProfile;
  readonly utf8: 'strict';
  readonly normalization: NormalizationContext;
  readonly registryRevision: string;
  readonly modules: readonly {
    readonly id: string;
    readonly revision: string;
    readonly noisePrefixes: readonly string[];
  }[];
  readonly selectedAdapterOverride: { readonly presence: 'absent' };
}
export interface PreparedRendererEvent {
  readonly envelope: EventEnvelope;
  readonly derived: null | {
    readonly kind: 'codex-source-index';
    readonly sourceField: readonly ['input', 'raw'];
    readonly index: CodexSourceIndex;
  };
}
declare const checkpointBrand: unique symbol;
export interface RenderReaderCheckpoint {
  readonly [checkpointBrand]: true;
  readonly sourceId: string;
  readonly sourceGeneration: string;
  readonly inode: string;
  readonly offset: bigint;
  readonly lineOrdinal: bigint;
  readonly prefixSha256: string;
  readonly observedSize: bigint;
  readonly context: RendererInterpretationContext;
  readonly events: readonly PreparedRendererEvent[];
}
export interface RenderReaderInput {
  readonly source: RendererSourceObservation;
  readonly registry: TranscriptRegistry;
  readonly numericProfile: RenderNumericProfile;
  readonly priorCheckpoint?: RenderReaderCheckpoint | null;
  /** External adapters are not admitted by this bounded reader. */
  readonly selectedAdapterOverride?: string;
}
export interface RenderReaderFailure {
  readonly phase: 'input' | 'profile' | 'decode' | 'utf8' | 'numeric' | 'normalization';
  readonly message: string;
  readonly byteOffset: bigint;
}
export type RenderReaderResult =
  | {
      readonly disposition: 'ready';
      readonly context: RendererInterpretationContext;
      readonly checkpoint: RenderReaderCheckpoint;
      readonly events: readonly PreparedRendererEvent[];
      readonly tentative: boolean;
      readonly reusedPrefix: boolean;
    }
  | {
      readonly disposition: 'failed';
      readonly context: RendererInterpretationContext | null;
      readonly checkpoint: RenderReaderCheckpoint | null;
      readonly events: readonly PreparedRendererEvent[];
      readonly tentative: boolean;
      readonly reusedPrefix: boolean;
      readonly failure: RenderReaderFailure;
    };
interface PrivateCheckpoint {
  readonly registry: TranscriptRegistry;
  readonly state: RegistryCheckpoint;
}
const checkpoints = new WeakMap<RenderReaderCheckpoint, PrivateCheckpoint>();
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
class NumericConversionFailure extends RangeError {}
function prepareEvent(envelope: EventEnvelope): PreparedRendererEvent {
  const event = envelope.event;
  const raw = event.ev === 'tool_use' ? getMember(event.input, 'raw') : undefined;
  const name =
    event.ev === 'tool_use' && typeof event.name === 'string'
      ? event.source_harness === 'codex'
        ? event.name.split('.').at(-1)
        : event.name
      : undefined;
  const derived =
    event.ev === 'tool_use' && name === 'exec' && typeof raw === 'string'
      ? Object.freeze({
          kind: 'codex-source-index' as const,
          sourceField: Object.freeze(['input', 'raw'] as const),
          index: extractCodexSourceIndex(raw),
        })
      : null;
  return Object.freeze({ envelope, derived });
}
/** Complete chunks transact together; a tentative tail never advances registry state. */
export function readRendererSource(input: RenderReaderInput): RenderReaderResult {
  const failAdmission = (phase: 'input' | 'profile', message: string): RenderReaderResult =>
    Object.freeze({
      disposition: 'failed',
      context: null,
      checkpoint: null,
      events: Object.freeze([]),
      tentative: false,
      reusedPrefix: false,
      failure: Object.freeze({ phase, message, byteOffset: 0n }),
    });
  const profile = input.numericProfile;
  if (
    !profile ||
    typeof profile.id !== 'string' ||
    !profile.id ||
    !Number.isSafeInteger(profile.integerMaxDigits) ||
    (profile.integerMaxDigits !== 0 && profile.integerMaxDigits < 640)
  )
    return failAdmission('profile', 'Explicit supported numeric profile required');
  if (input.selectedAdapterOverride !== undefined)
    return failAdmission('profile', 'Selected transcript adapter override is unsupported');
  const observed = input.source;
  if (
    !observed ||
    [observed.sourceId, observed.sourceGeneration, observed.inode].some(
      (value) => typeof value !== 'string' || !value
    ) ||
    !(observed.bytes instanceof Uint8Array) ||
    typeof observed.size !== 'bigint' ||
    observed.size !== BigInt(observed.bytes.byteLength)
  )
    return failAdmission(
      'input',
      'Source observation requires exact owned bytes, size and identity'
    );
  // Own the entire read before hashing or issuing occurrences.
  const source = Object.freeze({
    sourceId: observed.sourceId,
    sourceGeneration: observed.sourceGeneration,
    inode: observed.inode,
    size: observed.size,
  });
  const bytes = Buffer.from(observed.bytes);
  const context: RendererInterpretationContext = Object.freeze({
    profileId: 'renderer-reader/1',
    numericProfile: Object.freeze({ ...profile }),
    utf8: 'strict',
    normalization: input.registry.context,
    registryRevision: input.registry.revision,
    modules: Object.freeze(
      input.registry.modules.map((module) =>
        Object.freeze({
          id: module.id,
          revision: module.revision,
          noisePrefixes: Object.freeze([...module.noisePrefixes]),
        })
      )
    ),
    selectedAdapterOverride: Object.freeze({ presence: 'absent' }),
  });
  const prior = input.priorCheckpoint;
  const privatePrior = prior ? checkpoints.get(prior) : undefined;
  const reusedPrefix = !!(
    prior &&
    privatePrior &&
    privatePrior.registry === input.registry &&
    prior.sourceId === source.sourceId &&
    prior.sourceGeneration === source.sourceGeneration &&
    prior.inode === source.inode &&
    prior.offset <= source.size &&
    JSON.stringify(prior.context) === JSON.stringify(context) &&
    hash(bytes.subarray(0, Number(prior.offset))) === prior.prefixSha256
  );
  let state = reusedPrefix
    ? privatePrior!.state
    : input.registry.createCheckpoint(source.sourceId, source.sourceGeneration);
  const start = reusedPrefix ? Number(prior!.offset) : 0;
  let lineOrdinal = reusedPrefix ? prior!.lineOrdinal : 0n;
  const committedEvents = reusedPrefix ? [...prior!.events] : [];
  function issueCheckpoint(offset: number): RenderReaderCheckpoint {
    const checkpoint = Object.freeze({
      sourceId: source.sourceId,
      sourceGeneration: source.sourceGeneration,
      inode: source.inode,
      offset: BigInt(offset),
      lineOrdinal,
      prefixSha256: hash(bytes.subarray(0, offset)),
      observedSize: source.size,
      context,
      events: Object.freeze([...committedEvents]),
    }) as RenderReaderCheckpoint;
    checkpoints.set(checkpoint, { registry: input.registry, state });
    return checkpoint;
  }
  // On failed complete acquisition keep the prior transaction, even if some rows succeeded locally.
  let checkpoint = reusedPrefix ? prior! : issueCheckpoint(0);
  let phase: RenderReaderFailure['phase'] = 'normalization';
  let byteOffset = BigInt(start);
  const parseLine = (
    begin: number,
    end: number,
    partial: boolean
  ): readonly PreparedRendererEvent[] => {
    byteOffset = BigInt(begin);
    phase = 'decode';
    const parsed = decodeProfiledOccurrence(
      bytes.subarray(begin, end),
      {
        sourceId: source.sourceId,
        sourceGeneration: source.sourceGeneration,
        occurrenceId: `${lineOrdinal}:${begin}:${partial ? 'partial' : 'complete'}`,
        byteOffset,
        lineOrdinal,
        framing: partial ? 'partial' : 'complete',
      },
      {
        admitNumberToken(token) {
          if (
            token.numberKind === 'integer' &&
            context.numericProfile.integerMaxDigits !== 0 &&
            token.lexeme.length - (token.lexeme[0] === '-' ? 1 : 0) >
              context.numericProfile.integerMaxDigits
          )
            throw new NumericConversionFailure(
              `Integer exceeds selected ${context.numericProfile.integerMaxDigits}-digit limit`
            );
        },
      }
    );
    if (parsed.disposition === 'invalid_utf8') {
      phase = 'utf8';
      throw new TypeError('Invalid UTF-8 transcript occurrence');
    }
    if (parsed.disposition !== 'parsed') return [];
    phase = 'normalization';
    const normalized = input.registry.normalize(parsed, state);
    if (
      ['context_mismatch', 'source_mismatch', 'adapter_mismatch'].includes(normalized.disposition)
    )
      throw new TypeError(`Registry refused occurrence: ${normalized.disposition}`);
    if (!partial) state = normalized.nextState;
    return normalized.events.map(prepareEvent);
  };
  const cut = bytes.lastIndexOf(0x0a) + 1;
  let begin = start;
  try {
    while (begin < cut) {
      const end = bytes.indexOf(0x0a, begin);
      committedEvents.push(...parseLine(begin, end, false));
      lineOrdinal++;
      begin = end + 1;
    }
    checkpoint = issueCheckpoint(cut);
    const tentativeEvents = cut < bytes.length ? parseLine(cut, bytes.length, true) : [];
    return Object.freeze({
      disposition: 'ready',
      context,
      checkpoint,
      events: Object.freeze([...committedEvents, ...tentativeEvents]),
      tentative: cut < bytes.length,
      reusedPrefix,
    });
  } catch (error) {
    if (error instanceof NumericConversionFailure) phase = 'numeric';
    return Object.freeze({
      disposition: 'failed',
      context,
      checkpoint,
      events: checkpoint.events,
      tentative: byteOffset >= BigInt(cut) && cut < bytes.length,
      reusedPrefix,
      failure: Object.freeze({
        phase,
        message: error instanceof Error ? error.message : String(error),
        byteOffset,
      }),
    });
  }
}

export type ObservedRendererFile =
  | { readonly path: string; readonly disposition: 'absent' }
  | { readonly path: string; readonly disposition: 'failed'; readonly error: string }
  | {
      readonly path: string;
      readonly disposition: 'read';
      readonly source: RendererSourceObservation;
    };
export type RendererFileIdentity =
  | { readonly path: string; readonly disposition: 'absent' }
  | { readonly path: string; readonly disposition: 'failed'; readonly error: string }
  | {
      readonly path: string;
      readonly disposition: 'read';
      readonly sourceId: string;
      readonly sourceGeneration: string;
      readonly inode: string;
      readonly size: bigint;
      readonly sha256: string;
      readonly rawBase64: string;
    };
export type ObservedRendererDirectory =
  | { readonly path: string; readonly kind: 'absent' | 'not-directory' }
  | {
      readonly path: string;
      readonly kind: 'directory';
      readonly listing:
        | { readonly disposition: 'failed'; readonly error: string }
        | {
            readonly disposition: 'listed';
            readonly entries: readonly {
              readonly name: string;
              readonly file: ObservedRendererFile;
            }[];
          };
    };
export type RendererDirectoryIdentity =
  | { readonly path: string; readonly kind: 'absent' | 'not-directory' }
  | {
      readonly path: string;
      readonly kind: 'directory';
      readonly listing:
        | { readonly disposition: 'failed'; readonly error: string }
        | {
            readonly disposition: 'listed';
            readonly entries: readonly {
              readonly name: string;
              readonly file: RendererFileIdentity;
            }[];
          };
    };
interface OwnedFile {
  readonly identity: RendererFileIdentity;
  readonly bytes: Uint8Array | null;
}
function ownFile(observed: ObservedRendererFile): OwnedFile {
  const path = observed.path;
  if (typeof path !== 'string') throw new TypeError('Observed file path must be a string');
  if (observed.disposition === 'absent')
    return Object.freeze({ identity: Object.freeze({ path, disposition: 'absent' }), bytes: null });
  if (observed.disposition === 'failed')
    return Object.freeze({
      identity: Object.freeze({ path, disposition: 'failed', error: observed.error }),
      bytes: null,
    });
  const source = observed.source;
  if (
    !(source.bytes instanceof Uint8Array) ||
    typeof source.size !== 'bigint' ||
    source.size !== BigInt(source.bytes.byteLength) ||
    [source.sourceId, source.sourceGeneration, source.inode].some(
      (value) => typeof value !== 'string' || !value
    )
  )
    throw new TypeError('Read observation requires exact bytes, size and source identity');
  const labels = {
    sourceId: source.sourceId,
    sourceGeneration: source.sourceGeneration,
    inode: source.inode,
    size: source.size,
  };
  const bytes = Buffer.from(source.bytes);
  return Object.freeze({
    identity: Object.freeze({
      path,
      disposition: 'read',
      ...labels,
      sha256: hash(bytes),
      rawBase64: bytes.toString('base64'),
    }),
    bytes,
  });
}
interface OwnedDirectory {
  readonly identity: RendererDirectoryIdentity;
  readonly entries: readonly { readonly name: string; readonly file: OwnedFile }[];
}
function ownDirectory(observed: ObservedRendererDirectory): OwnedDirectory {
  const path = observed.path;
  if (observed.kind !== 'directory')
    return Object.freeze({
      identity: Object.freeze({ path, kind: observed.kind }),
      entries: Object.freeze([]),
    });
  if (observed.listing.disposition === 'failed')
    return Object.freeze({
      identity: Object.freeze({
        path,
        kind: 'directory',
        listing: Object.freeze({ disposition: 'failed', error: observed.listing.error }),
      }),
      entries: Object.freeze([]),
    });
  const entries = Object.freeze(
    observed.listing.entries.map((entry) =>
      Object.freeze({ name: entry.name, file: ownFile(entry.file) })
    )
  );
  return Object.freeze({
    identity: Object.freeze({
      path,
      kind: 'directory',
      listing: Object.freeze({
        disposition: 'listed',
        entries: Object.freeze(
          entries.map((entry) => Object.freeze({ name: entry.name, file: entry.file.identity }))
        ),
      }),
    }),
    entries,
  });
}
function selectNumericProfile(profile: RenderNumericProfile): RenderNumericProfile {
  if (
    !profile ||
    typeof profile.id !== 'string' ||
    !profile.id ||
    !Number.isSafeInteger(profile.integerMaxDigits) ||
    (profile.integerMaxDigits !== 0 && profile.integerMaxDigits < 640)
  )
    throw new TypeError('Explicit supported numeric profile required');
  return Object.freeze({ id: profile.id, integerMaxDigits: profile.integerMaxDigits });
}
function numberAdmission(profile: RenderNumericProfile) {
  return (token: import('./lossless-json').JsonNumber): void => {
    if (
      token.numberKind === 'integer' &&
      profile.integerMaxDigits !== 0 &&
      token.lexeme.length - (token.lexeme[0] === '-' ? 1 : 0) > profile.integerMaxDigits
    )
      throw new NumericConversionFailure(
        `Integer exceeds selected ${profile.integerMaxDigits}-digit limit`
      );
  };
}
const member = (
  value: JsonValue | undefined,
  key: string,
  fallback: JsonValue = null
): JsonValue => {
  const item = getMember(value, key);
  return item === undefined ? fallback : item;
};
/** Python splitlines delimiters located in the original UTF8 bytes, including CRLF as one separator. */
function rawLines(bytes: Uint8Array): readonly { readonly start: number; readonly end: number }[] {
  const lines: { start: number; end: number }[] = [];
  let start = 0;
  for (let index = 0; index < bytes.length; ) {
    const value = bytes[index]!;
    const width =
      value === 13
        ? bytes[index + 1] === 10
          ? 2
          : 1
        : [10, 11, 12, 28, 29, 30].includes(value)
          ? 1
          : value === 0xc2 && bytes[index + 1] === 0x85
            ? 2
            : value === 0xe2 &&
                bytes[index + 1] === 0x80 &&
                [0xa8, 0xa9].includes(bytes[index + 2] ?? -1)
              ? 3
              : 0;
    if (width) {
      lines.push({ start, end: index });
      index += width;
      start = index;
    } else index++;
  }
  if (start < bytes.length) lines.push({ start, end: bytes.length });
  return lines;
}
function auxiliaryEnvelope(
  event: CanonicalEvent,
  parsed: import('./source-occurrence').ParsedRow,
  kind: string
): PreparedRendererEvent {
  return Object.freeze({
    envelope: Object.freeze({
      event: Object.freeze(event),
      source: parsed.source,
      adapter: Object.freeze({ id: `renderer-aux-${kind}`, revision: 'renderer-aux/1' }),
      nativeMemberPath: Object.freeze([]),
      emissionIndex: 0,
    }),
    derived: null,
  });
}
export interface RendererAuxiliaryInput {
  readonly audit: ObservedRendererFile;
  readonly hookOutcomes: ObservedRendererFile;
  readonly sessionId: string;
  readonly numericProfile: RenderNumericProfile;
}
export interface RendererAuxiliaryDiagnostic {
  readonly sourcePath: string;
  readonly malformedRecords: number;
}
type AuxiliaryCommon = {
  readonly events: readonly PreparedRendererEvent[];
  readonly observations: {
    readonly audit: RendererFileIdentity;
    readonly hookOutcomes: RendererFileIdentity;
  };
  readonly diagnostics: readonly RendererAuxiliaryDiagnostic[];
};
export type RendererAuxiliaryResult = AuxiliaryCommon &
  (
    | { readonly disposition: 'ready' }
    | { readonly disposition: 'failed'; readonly failure: RenderReaderFailure }
  );
/** Sidecar read failures are observations; uncaught numeric conversion remains fatal. */
export function parseRendererAuxiliary(input: RendererAuxiliaryInput): RendererAuxiliaryResult {
  const audit = ownFile(input.audit),
    hooks = ownFile(input.hookOutcomes);
  const observations = Object.freeze({ audit: audit.identity, hookOutcomes: hooks.identity });
  const diagnostics: RendererAuxiliaryDiagnostic[] = [];
  const events: PreparedRendererEvent[] = [];
  let byteOffset = 0n,
    phase: RenderReaderFailure['phase'] = 'profile';
  try {
    const profile = selectNumericProfile(input.numericProfile),
      sessionId = input.sessionId;
    const admitNumberToken = numberAdmission(profile);
    const stdoutPayload = (stdout: string): JsonValue | undefined => {
      try {
        return parsePythonJson(stdout, { admitNumberToken });
      } catch (error) {
        if (error instanceof SyntaxError) return undefined;
        throw error;
      }
    };
    for (const [kind, file] of [
      ['audit', audit],
      ['hook', hooks],
    ] as const) {
      if (file.bytes === null || file.identity.disposition !== 'read') continue;
      const identity = file.identity;
      let malformed = 0,
        ordinal = 0n;
      try {
        for (const { start, end } of rawLines(file.bytes)) {
          byteOffset = BigInt(start);
          phase = 'decode';
          const bytes = file.bytes.subarray(start, end);
          const blank = !pythonStrip(new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes));
          if (blank) {
            ordinal++;
            continue;
          }
          const parsed = decodeProfiledOccurrence(
            bytes,
            {
              sourceId: identity.sourceId,
              sourceGeneration: identity.sourceGeneration,
              occurrenceId: `${kind}:${ordinal}:${start}`,
              byteOffset,
              lineOrdinal: ordinal++,
              framing: 'complete',
            },
            { utf8: 'replace', stripOuterWhitespace: false, admitNumberToken }
          );
          if (parsed.disposition === 'invalid_json') {
            malformed++;
            continue;
          }
          if (parsed.disposition !== 'parsed') continue;
          const row = parsed.row;
          if (getMember(row, 'session_id') !== sessionId) continue;
          phase = 'normalization';
          if (kind === 'audit') {
            if (getMember(row, 'event') !== 'tool_use') continue;
            const rawInput = getMember(row, 'tool_input');
            let toolInput = isJsonObject(rawInput) ? rawInput : jsonObject([]);
            if (
              pythonTruthy(getMember(row, 'command')) &&
              !pythonTruthy(getMember(toolInput, 'command'))
            )
              toolInput = jsonObject([...toolInput.entries, ['command', member(row, 'command')]]);
            if (
              pythonTruthy(getMember(row, 'file')) &&
              !pythonTruthy(getMember(toolInput, 'file_path'))
            )
              toolInput = jsonObject([...toolInput.entries, ['file_path', member(row, 'file')]]);
            const response = getMember(row, 'tool_response');
            events.push(
              auxiliaryEnvelope(
                {
                  ev: 'audit_action',
                  tool: member(row, 'tool', ''),
                  id: member(row, 'tool_use_id', ''),
                  input: toolInput,
                  response: isJsonObject(response) ? response : jsonObject([]),
                  is_error: pythonTruthy(getMember(row, 'is_error')),
                  cwd: member(row, 'cwd'),
                  permission_mode: member(row, 'permission_mode'),
                  ts: parseTimestamp(getMember(row, 'timestamp')),
                  provenance: 'hook_audit',
                },
                parsed,
                kind
              )
            );
          } else {
            const stdoutValue = getMember(row, 'stdout'),
              stderrValue = getMember(row, 'stderr');
            const stdout = typeof stdoutValue === 'string' ? stdoutValue : '',
              stderr = typeof stderrValue === 'string' ? stderrValue : '';
            phase = 'decode';
            const payload = stdoutPayload(stdout),
              hook = getMember(payload, 'hookSpecificOutput'),
              context = getMember(hook, 'additionalContext');
            let additionalContext: JsonValue = '',
              authority: JsonObject | null = null,
              eventKind = 'hook_outcome';
            if (isJsonObject(hook) && typeof context === 'string' && pythonStrip(context)) {
              additionalContext = context;
              authority = parseContextAuthorityBlock(context);
              eventKind = authority === null ? 'additional_context' : 'context_authority';
            } else if (stdout) {
              const reason = getMember(payload, 'reason');
              additionalContext = typeof reason === 'string' ? reason : stdout;
            } else if (stderr) additionalContext = stderr;
            const decisionValue = getMember(payload, 'decision');
            const decision =
              decisionValue === null || decisionValue === undefined
                ? getMember(hook, 'permissionDecision')
                : decisionValue;
            const status =
              pythonEqual(member(row, 'exit_code'), jsonNumber('2')) ||
              decision === 'block' ||
              decision === 'deny'
                ? 'block'
                : decision === 'ask'
                  ? 'ask'
                  : member(row, 'status');
            const event: CanonicalEvent = {
              ev: 'hook_context',
              kind: eventKind,
              status,
              additional_context: additionalContext,
              context_authority: authority,
              stdout,
              stderr,
              ts: parseTimestamp(getMember(row, 'timestamp')),
              provenance: 'hook_outcome_sidecar',
              observation_boundary: member(row, 'observation_boundary', 'handler_return'),
              delivery: member(row, 'delivery', 'not_observed'),
            };
            const fields: Record<string, JsonValue> = {};
            for (const key of [
              'hook_event',
              'tool_use_id',
              'tool_name',
              'exit_code',
              'duration_ms',
              'invocation_id',
              'source_sha256',
              'runtime_digest',
              'adapter_exit_code',
            ])
              fields[key] = member(row, key);
            events.push(
              auxiliaryEnvelope(
                { ...event, hook_name: member(row, 'handler'), ...fields },
                parsed,
                kind
              )
            );
          }
        }
      } finally {
        if (malformed)
          diagnostics.push(
            Object.freeze({ sourcePath: identity.path, malformedRecords: malformed })
          );
      }
    }
    return Object.freeze({
      disposition: 'ready',
      events: Object.freeze(events),
      observations,
      diagnostics: Object.freeze(diagnostics),
    });
  } catch (error) {
    return Object.freeze({
      disposition: 'failed',
      events: Object.freeze([]),
      observations,
      diagnostics: Object.freeze(diagnostics),
      failure: Object.freeze({
        phase: error instanceof NumericConversionFailure ? 'numeric' : phase,
        message: error instanceof Error ? error.message : String(error),
        byteOffset,
      }),
    });
  }
}
export interface RendererSubagentInput {
  readonly transcriptPath: string;
  readonly sessionId: string;
  readonly claudeCandidate: ObservedRendererDirectory;
  readonly qwenCandidate: ObservedRendererDirectory;
  readonly numericProfile: RenderNumericProfile;
}
type SubagentCommon = {
  readonly links: readonly PreparedSubagentLink[];
  readonly selectedDirectory: string | null;
  readonly observations: {
    readonly claudeCandidate: RendererDirectoryIdentity;
    readonly qwenCandidate: RendererDirectoryIdentity;
  };
};
export type RendererSubagentResult = SubagentCommon &
  (
    | { readonly disposition: 'ready' }
    | { readonly disposition: 'failed'; readonly failure: RenderReaderFailure }
  );
export function parseRendererSubagents(input: RendererSubagentInput): RendererSubagentResult {
  const claude = ownDirectory(input.claudeCandidate),
    qwen = ownDirectory(input.qwenCandidate);
  const observations = Object.freeze({
    claudeCandidate: claude.identity,
    qwenCandidate: qwen.identity,
  });
  let selectedDirectory: string | null = null,
    phase: RenderReaderFailure['phase'] = 'profile';
  try {
    const profile = selectNumericProfile(input.numericProfile),
      transcriptPath = input.transcriptPath,
      sessionId = input.sessionId;
    phase = 'input';
    if (
      claude.identity.path !== join(dirname(transcriptPath), sessionId, 'subagents') ||
      qwen.identity.path !== join(dirname(dirname(transcriptPath)), 'subagents', sessionId)
    )
      throw new TypeError(
        'Subagent candidate paths disagree with admitted transcript/session layout'
      );
    const selected = !transcriptPath
      ? null
      : claude.identity.kind === 'directory'
        ? claude
        : qwen.identity.kind === 'directory'
          ? qwen
          : null;
    selectedDirectory = selected?.identity.path ?? null;
    const links = new Map<string, PreparedSubagentLink>();
    if (selected)
      for (const { name, file } of [...selected.entries].sort((a, b) =>
        codepointOrder(a.name, b.name)
      )) {
        if (!(name.startsWith('agent-') && name.endsWith('.meta.json'))) continue;
        if (
          name.includes('/') ||
          name === '.' ||
          name === '..' ||
          file.identity.path !== join(selected.identity.path, name)
        )
          throw new TypeError('Subagent metadata observation disagrees with its directory entry');
        if (file.bytes === null || file.identity.disposition !== 'read') continue;
        phase = 'decode';
        const identity = file.identity;
        let parsed: import('./source-occurrence').ParsedRow;
        try {
          parsed = decodeProfiledOccurrence(
            file.bytes,
            {
              sourceId: identity.sourceId,
              sourceGeneration: identity.sourceGeneration,
              occurrenceId: `subagent:${name}`,
              byteOffset: 0n,
              lineOrdinal: 0n,
              framing: 'complete',
            },
            { stripOuterWhitespace: false, admitNumberToken: numberAdmission(profile) }
          );
        } catch (error) {
          if (error instanceof NumericConversionFailure) continue;
          throw error;
        }
        if (parsed.disposition === 'invalid_utf8' || parsed.disposition === 'invalid_json')
          continue;
        if (parsed.disposition !== 'parsed')
          throw new TypeError('Subagent metadata is not an object');
        phase = 'normalization';
        const row = parsed.row,
          toolUseId = getMember(row, 'toolUseId');
        if (typeof toolUseId !== 'string' || !toolUseId) continue;
        // Fork metadata names agent-X.meta.json; the adjacent transcript is agent-X.jsonl.
        const values: [string, RenderValue][] = [['transcript', name.slice(0, -10) + '.jsonl']];
        for (const [from, to] of [
          ['agentType', 'agent_type'],
          ['model', 'model'],
        ] as const) {
          const value = getMember(row, from);
          if (typeof value === 'string') values.push([to, value]);
        }
        const depth = getMember(row, 'spawnDepth');
        if (typeof depth === 'boolean' || (isJsonNumber(depth) && depth.numberKind === 'integer'))
          values.push(['spawn_depth', depth]);
        const description = getMember(row, 'description');
        if (typeof description === 'string' && description)
          values.push(['description', codepointSlice(description, 0, 200)]);
        links.set(toolUseId, Object.freeze({ toolUseId, value: renderObject(values) }));
      }
    return Object.freeze({
      disposition: 'ready',
      links: Object.freeze([...links.values()]),
      observations,
      selectedDirectory,
    });
  } catch (error) {
    return Object.freeze({
      disposition: 'failed',
      links: Object.freeze([]),
      observations,
      selectedDirectory,
      failure: Object.freeze({
        phase,
        byteOffset: 0n,
        message: error instanceof Error ? error.message : String(error),
      }),
    });
  }
}
