/** Shared historical projections and occurrence normalization; no environment or filesystem authority. */
import { UNICODE_PROFILE_ID } from './python-unicode-profile';
import {
  getMember,
  isJsonNumber,
  isJsonObject,
  jsonObject,
  pythonStr,
  pythonTruthy,
  type JsonObject,
  type JsonValue,
} from './lossless-json';
import {
  parseTranscriptJson,
  snapshotTranscriptJsonProfile,
  type TranscriptJsonNumericProfile,
} from './transcript-json-profile';
import {
  isParsedRow,
  pythonStrip,
  PYTHON_WHITESPACE_PATTERN,
  type ParsedRow,
  type SourceOccurrence,
} from './source-occurrence';
export { pythonStrip, codepointLength, codepointSlice, codepointOrder } from './source-occurrence';
export type { ParsedRow, SourceOccurrence } from './source-occurrence';

export function asBool(value: JsonValue | undefined): JsonValue | undefined {
  return value === 'true' ? true : value === 'false' ? false : value;
}
/** Numeric interpretation is confined to the supported datetime calendar; original numeric AST is retained. */
export function parseTimestamp(value: JsonValue | undefined): string | null {
  if (value === undefined || !pythonTruthy(value)) return null;
  if (typeof value === 'string') return value;
  let seconds: number;
  if (value === true)
    seconds = 1; // Python bool is an int subclass.
  else if (isJsonNumber(value)) {
    if (value.numberKind === 'integer') {
      const integer = BigInt(value.lexeme);
      if (integer < -62135596800n || integer > 253402300799n) return pythonStr(value);
      seconds = Number(integer); // Range checked above; exactly representable whole seconds.
    } else seconds = Number(value.lexeme);
  } else return pythonStr(value);
  if (!Number.isFinite(seconds)) return pythonStr(value);
  // Retain the signed fraction as CPython's modf-based conversion does.
  // Adding one before rounding a tiny negative fraction can lose the bit that
  // distinguishes a value just below a half-microsecond from the exact tie.
  let whole = Math.trunc(seconds);
  const fraction = Math.abs((seconds - whole) * 1_000_000);
  const base = Math.floor(fraction),
    rest = fraction - base;
  const rounded = rest > 0.5 || (rest === 0.5 && base % 2 !== 0) ? base + 1 : base;
  const micros = seconds < 0 ? -rounded : rounded;
  if (micros === 1_000_000) whole++;
  else if (micros < 0) whole--;
  if (whole < -62135596800 || whole > 253402300799) return pythonStr(value);
  const date = new Date(whole * 1000);
  if (!Number.isFinite(date.getTime())) return pythonStr(value);
  const part = (n: number): string => String(n).padStart(2, '0');
  return `${String(date.getUTCFullYear()).padStart(4, '0')}-${part(date.getUTCMonth() + 1)}-${part(date.getUTCDate())}T${part(date.getUTCHours())}:${part(date.getUTCMinutes())}:${part(date.getUTCSeconds())}Z`;
}
export function decodeStructuredTextPayload(
  raw: string,
  profile?: TranscriptJsonNumericProfile
): string;
export function decodeStructuredTextPayload(
  raw: JsonValue | undefined,
  profile?: TranscriptJsonNumericProfile
): JsonValue;
export function decodeStructuredTextPayload(
  raw: JsonValue | undefined,
  profile?: TranscriptJsonNumericProfile
): JsonValue {
  if (typeof raw !== 'string') return raw !== undefined && pythonTruthy(raw) ? raw : '';
  const payload = pythonStrip(raw);
  if (!payload || !['[', '{'].includes(payload[0]!)) return raw;
  let parsed: JsonValue;
  try {
    parsed = parseTranscriptJson(payload, profile);
  } catch {
    return raw;
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  const blocks: string[] = [];
  for (const item of items) {
    if (!isJsonObject(item)) continue;
    const text = getMember(item, 'text');
    if (typeof text === 'string' && pythonStrip(text)) blocks.push(text);
  }
  return blocks.length ? blocks.join('\n\n') : raw;
}
function pythonLines(value: string): string[] {
  if (!value.length) return [];
  const lines = value.split(/\r\n|[\n\r\v\f\u001c-\u001e\u0085\u2028\u2029]/u);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}
export function parseContextAuthorityBlock(text: string): JsonObject | null {
  const rstrip = new RegExp(`${PYTHON_WHITESPACE_PATTERN}+$`, 'u');
  const lines = pythonLines(text).map((line) => line.replace(rstrip, ''));
  if (!lines.length || !lines[0]!.startsWith('context-authority:')) return null;
  const sections = new Map<string, string[]>();
  const values = new Map<string, JsonValue>([
    ['target', pythonStrip(lines[0]!.slice(lines[0]!.indexOf(':') + 1))],
  ]);
  let current: string | null = null;
  for (const line of lines.slice(1)) {
    const stripped = pythonStrip(line);
    if (!stripped) continue;
    if (!line.startsWith(' ') && !line.startsWith('\t') && stripped.includes(':')) {
      const colon = stripped.indexOf(':');
      const key = pythonStrip(stripped.slice(0, colon)).replace(/-/g, '_');
      const value = pythonStrip(stripped.slice(colon + 1));
      current = null;
      if (key === 'attachment') {
        values.set('attachment', value);
        continue;
      }
      if (value) {
        sections.set(key, value === '(none)' ? [] : [value]);
        continue;
      }
      if (!sections.has(key)) sections.set(key, []);
      current = key;
    } else if (current !== null && current !== '') {
      sections
        .get(current)!
        .push(stripped.startsWith('- ') ? pythonStrip(stripped.slice(2)) : stripped);
    }
  }
  values.set('sections', jsonObject([...sections].map(([key, value]) => [key, value] as const)));
  // Historical insertion order is target, sections, then optional attachment.
  return jsonObject([
    ['target', values.get('target')!],
    ['sections', values.get('sections')!],
    ...(values.has('attachment') ? [['attachment', values.get('attachment')!] as const] : []),
  ]);
}
export function parseHookStdout(
  stdout: JsonValue | undefined,
  profile?: TranscriptJsonNumericProfile
): JsonObject | null {
  if (typeof stdout !== 'string' || !pythonStrip(stdout)) return null;
  let payload: JsonValue;
  try {
    payload = parseTranscriptJson(stdout, profile);
  } catch (error) {
    if (profile !== undefined && !(error instanceof SyntaxError)) throw error;
    return null;
  }
  const hook = isJsonObject(payload) ? getMember(payload, 'hookSpecificOutput') : undefined;
  if (!isJsonObject(hook)) return null;
  const context = getMember(hook, 'additionalContext');
  if (typeof context !== 'string' || !pythonStrip(context)) return null;
  const authority = parseContextAuthorityBlock(context);
  return jsonObject([
    ['hook_event', getMember(hook, 'hookEventName') ?? null],
    ['additional_context', context],
    ['kind', authority === null ? 'additional_context' : 'context_authority'],
    ...(authority === null ? [] : [['context_authority', authority] as const]),
  ]);
}
export function patchPaths(patch: string): string[] {
  // Python MULTILINE anchors split at LF only; JS multiline also recognizes CR/Unicode separators.
  const pattern = new RegExp(
    `(?:^|\n)\\*\\*\\* (?:Add|Update|Delete) File:${PYTHON_WHITESPACE_PATTERN}*([^\n]+?)${PYTHON_WHITESPACE_PATTERN}*(?=\n|(?![\\s\\S]))`,
    'gu'
  );
  const paths: string[] = [];
  for (const match of patch.matchAll(pattern)) {
    const value = pythonStrip(match[1]!);
    if (value && !paths.includes(value)) paths.push(value);
  }
  return paths;
}

/** Values are codec JSON; this native record is a known historical projection, never row ingress. */
interface Projection {
  readonly [field: string]: JsonValue | undefined;
  readonly ts?: string | null;
}
export type CanonicalEvent = Projection &
  (
    | {
        readonly ev: 'user_text';
        readonly text?: JsonValue;
        readonly uuid?: JsonValue;
        readonly parent_uuid?: JsonValue;
      }
    | { readonly ev: 'assistant_text'; readonly text?: JsonValue; readonly thought?: JsonValue }
    | { readonly ev: 'reasoning'; readonly text?: JsonValue }
    | { readonly ev: 'interjection'; readonly text?: JsonValue }
    | {
        readonly ev: 'user_shell';
        readonly command?: JsonValue;
        readonly stdout?: JsonValue;
        readonly stderr?: JsonValue;
      }
    | { readonly ev: 'control'; readonly subtype?: JsonValue; readonly text?: JsonValue }
    | {
        readonly ev: 'assistant_meta';
        readonly usage?: JsonValue;
        readonly message_id?: JsonValue;
        readonly request_id?: JsonValue;
      }
    | { readonly ev: 'turn_boundary'; readonly turn_id?: JsonValue }
    | {
        readonly ev: 'tool_use';
        readonly id?: JsonValue;
        readonly name?: JsonValue;
        readonly input?: JsonValue;
        readonly source_harness?: JsonValue;
      }
    | {
        readonly ev: 'tool_result';
        readonly id?: JsonValue;
        readonly content?: JsonValue;
        readonly is_error?: JsonValue;
      }
    | {
        readonly ev: 'hook_context';
        readonly context_authority?: JsonValue;
        readonly tool_use_id?: JsonValue;
      }
    | { readonly ev: 'audit_action' }
  );
export interface LocatedEvent {
  readonly event: CanonicalEvent;
  readonly nativeMemberPath: readonly (string | number)[];
}
export interface TranscriptAdapter<S> {
  readonly id: string;
  readonly revision: string;
  matches(row: JsonObject): boolean;
  createState(): S;
  /** Isolate every adapter-owned mutable member, including nested Set/Map keys and values. */
  cloneState(state: S): S;
  normalize(
    row: JsonObject,
    state: S,
    context?: NormalizationContext
  ): { readonly state: S; readonly events: readonly LocatedEvent[] };
}
export type OptionalContext =
  | { readonly presence: 'absent' }
  | { readonly presence: 'present'; readonly value: string };
export interface AdapterIdentity {
  readonly id: string;
  readonly revision: string;
}
export interface NormalizationContext {
  readonly interpretationProfileId: string;
  readonly surface: OptionalContext;
  readonly cacheGeneration: OptionalContext;
  readonly orderedAdapters: readonly AdapterIdentity[];
  readonly numericProfile?: TranscriptJsonNumericProfile;
}
const contexts = new WeakSet<object>();
function optional(value: string | undefined): OptionalContext {
  if (value !== undefined && typeof value !== 'string')
    throw new TypeError('normalization context must be a string or absent');
  return Object.freeze(
    value === undefined ? { presence: 'absent' } : { presence: 'present', value }
  );
}
export function makeNormalizationContext(
  options: {
    readonly surface?: string;
    readonly cacheGeneration?: string;
    readonly numericProfile?: TranscriptJsonNumericProfile;
  },
  orderedAdapters: readonly AdapterIdentity[]
): NormalizationContext {
  const ids = new Set<string>();
  const ordered = orderedAdapters.map(({ id, revision }) => {
    if (!id || !revision || ids.has(id))
      throw new TypeError('ordered adapter identities must be unique and nonempty');
    ids.add(id);
    return Object.freeze({ id, revision });
  });
  const context = Object.freeze({
    interpretationProfileId: UNICODE_PROFILE_ID,
    surface: optional(options.surface),
    cacheGeneration: optional(options.cacheGeneration),
    orderedAdapters: Object.freeze(ordered),
    ...(options.numericProfile === undefined
      ? {}
      : { numericProfile: snapshotTranscriptJsonProfile(options.numericProfile) }),
  });
  contexts.add(context);
  return context;
}
function sameContext(a: NormalizationContext, b: NormalizationContext): boolean {
  return contexts.has(a) && contexts.has(b) && JSON.stringify(a) === JSON.stringify(b);
}
export interface AdapterState<S> {
  readonly adapter: AdapterIdentity;
  readonly sourceId: string;
  readonly sourceGeneration: string;
  readonly context: NormalizationContext;
  /** Adapter-owned state. The wrapper is frozen; generic Set/Map mutation is isolated by cloneState. */
  readonly value: S;
}
export function createAdapterState<S>(
  adapter: TranscriptAdapter<S>,
  sourceId: string,
  sourceGeneration: string,
  context: NormalizationContext
): AdapterState<S> {
  if (
    !sourceId ||
    !sourceGeneration ||
    !contexts.has(context) ||
    !context.orderedAdapters.some(
      (identity) => identity.id === adapter.id && identity.revision === adapter.revision
    )
  )
    throw new TypeError('adapter state requires a matching context and source identity');
  return Object.freeze({
    adapter: Object.freeze({ id: adapter.id, revision: adapter.revision }),
    sourceId,
    sourceGeneration,
    context,
    value: adapter.createState(),
  });
}
export interface EventEnvelope extends LocatedEvent {
  readonly source: SourceOccurrence;
  readonly adapter: AdapterIdentity;
  readonly emissionIndex: number;
}
export type NormalizationDisposition =
  | 'normalized'
  | 'unmatched'
  | 'invalid_utf8'
  | 'invalid_json'
  | 'non_object'
  | 'context_mismatch'
  | 'source_mismatch'
  | 'adapter_mismatch';
export interface NormalizationResult<S> {
  readonly disposition: NormalizationDisposition;
  readonly original: ParsedRow;
  readonly source: SourceOccurrence;
  readonly events: readonly EventEnvelope[];
  readonly nextState: AdapterState<S>;
  readonly tentative: boolean;
  readonly commitAllowed: boolean;
}
function freezeProjection(value: JsonValue | undefined): void {
  if (Array.isArray(value)) {
    value.forEach(freezeProjection);
    Object.freeze(value);
  } else if (value !== null && typeof value === 'object') {
    if (isJsonObject(value)) {
      for (const entry of value.entries) {
        freezeProjection(entry[1]);
        Object.freeze(entry);
      }
      Object.freeze(value.entries);
    }
    Object.freeze(value);
  }
}
const SURFACES: Readonly<Record<string, string>> = Object.freeze({
  'claude-code': 'claude',
  codex: 'codex',
  dsh: 'dsh',
  'qwen-code': 'qwen-code',
  opencode: 'opencode',
  zcode: 'zcode',
});
export function normalizeOccurrence<S>(
  parsed: ParsedRow,
  state: AdapterState<S>,
  context: NormalizationContext,
  adapter: TranscriptAdapter<S>
): NormalizationResult<S> {
  if (!isParsedRow(parsed)) throw new TypeError('normalization requires a decoded raw occurrence');
  const result = (
    disposition: NormalizationDisposition,
    events: readonly EventEnvelope[] = [],
    nextState = state
  ): NormalizationResult<S> =>
    Object.freeze({
      disposition,
      original: parsed,
      source: parsed.source,
      events: Object.freeze([...events]),
      nextState,
      tentative: parsed.source.framing === 'partial',
      commitAllowed: disposition === 'normalized' && parsed.source.framing === 'complete',
    });
  if (!sameContext(state.context, context)) return result('context_mismatch');
  if (
    state.sourceId !== parsed.source.sourceId ||
    state.sourceGeneration !== parsed.source.sourceGeneration
  )
    return result('source_mismatch');
  if (
    state.adapter.id !== adapter.id ||
    state.adapter.revision !== adapter.revision ||
    !context.orderedAdapters.some(
      (identity) => identity.id === adapter.id && identity.revision === adapter.revision
    )
  )
    return result('adapter_mismatch');
  if (parsed.disposition !== 'parsed') return result(parsed.disposition);
  if (!adapter.matches(parsed.row)) return result('unmatched');
  // Adapter state is intentionally not restricted to JSON: cloneState may preserve Sets and tuple maps.
  const normalized = adapter.normalize(parsed.row, adapter.cloneState(state.value), context);
  const surface = context.surface.presence === 'present' ? context.surface.value : undefined;
  const attribution =
    (surface !== undefined && Object.prototype.hasOwnProperty.call(SURFACES, surface)
      ? SURFACES[surface]
      : undefined) ?? adapter.id;
  const events = normalized.events.map(({ event, nativeMemberPath }, emissionIndex) => {
    if (
      !nativeMemberPath.every(
        (component) =>
          typeof component === 'string' || (Number.isSafeInteger(component) && component >= 0)
      )
    )
      throw new TypeError('invalid native member path');
    const projection: CanonicalEvent =
      event.ev === 'tool_use' ? { ...event, source_harness: attribution } : { ...event };
    Object.values(projection).forEach(freezeProjection);
    Object.freeze(projection);
    return Object.freeze({
      event: projection,
      nativeMemberPath: Object.freeze([...nativeMemberPath]),
      source: parsed.source,
      adapter: state.adapter,
      emissionIndex,
    });
  });
  const nextState = Object.freeze({ ...state, value: normalized.state });
  return result('normalized', events, nextState);
}
