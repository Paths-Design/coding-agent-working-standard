/** Historical DSH row projection. Acquisition, persistence and execution remain caller-owned. */
import {
  getMember,
  isJsonNumber,
  isJsonObject,
  jsonNumber,
  jsonObject,
  pythonTruthy,
  type JsonNumber,
  type JsonObject,
  type JsonValue,
} from './lossless-json';
import {
  codepointSlice,
  parseTimestamp,
  pythonStrip,
  type CanonicalEvent,
  type LocatedEvent,
  type TranscriptAdapter,
} from './harness-common';
import { UNICODE_PROFILE_ID } from './python-unicode-profile';

export const DSH_ADAPTER_REVISION = `native-dsh/1;interpretation-profile:${UNICODE_PROFILE_ID};python-sha256:328305c956708a3413e5e8e9a4101681da53d30b972b41b3be3ec14b5125f1ab`;
export const DSH_EVENT_TYPES: readonly string[] = Object.freeze([
  'turn/start',
  'user/message',
  'assistant/message',
  'tool/call',
  'tool/result',
  'step/start',
  'step/end',
  'session/title',
  'approval/policy',
  'permission/preset',
  'sandbox/mode',
  'subagent/descriptor',
  'agent/inbox/spliced',
]);
const GOVERNANCE = [
  'session/title',
  'approval/policy',
  'permission/preset',
  'sandbox/mode',
  'subagent/descriptor',
  'agent/inbox/spliced',
];
export type DshTuple = readonly [JsonValue, JsonValue];
export interface DshEntry {
  readonly tuple: DshTuple;
  readonly value: JsonValue;
  readonly ordinal: bigint;
}
export interface DshNode {
  readonly key: string;
  readonly entry: DshEntry;
  readonly left: DshNode | null;
  readonly right: DshNode | null;
  readonly height: number;
}
export interface DshIndex {
  readonly root: DshNode | null;
  readonly size: number;
  readonly nextOrdinal: bigint;
}
/** Optional fields preserve Python setdefault's observable creation order and presence. */
export interface DshState {
  dsh_control_seen?: DshIndex;
  dsh_step_start_ms?: DshIndex;
}
export function createDshState(): DshState {
  return {};
}
export function cloneDshState(state: DshState): DshState {
  return { ...state }; // Immutable roots permit a constant-size transaction draft.
}
export class DshProjectionError extends Error {
  constructor(
    readonly pythonType:
      | 'TypeError'
      | 'ValueError'
      | 'OverflowError'
      | 'OSError'
      | 'RecursionError',
    message: string
  ) {
    super(message);
    this.name = 'DshProjectionError';
  }
}
function hashable(value: JsonValue | undefined): void {
  if (Array.isArray(value)) throw new DshProjectionError('TypeError', "unhashable type: 'list'");
  if (isJsonObject(value)) throw new DshProjectionError('TypeError', "unhashable type: 'dict'");
}
const nanIdentities = new WeakMap<JsonNumber, bigint>();
let nextNanIdentity = 0n;
function scalarKey(value: JsonValue): string {
  hashable(value);
  if (value === null) return 'null';
  if (typeof value === 'string') return 'string:' + value;
  if (typeof value === 'boolean') return value ? 'integer:1' : 'integer:0';
  if (!isJsonNumber(value)) throw new TypeError('DSH index key must be a JSON scalar');
  if (value.numberKind === 'integer') return 'integer:' + BigInt(value.lexeme);
  const number = Number(value.lexeme);
  if (Number.isNaN(number)) {
    let identity = nanIdentities.get(value);
    if (identity === undefined) {
      identity = nextNanIdentity++;
      nanIdentities.set(value, identity);
    }
    return 'nan-identity:' + identity;
  }
  // BigInt(number) recovers the represented integral float exactly, including
  // values beyond 2**53. Integer syntax and float rounding remain distinct.
  if (Number.isInteger(number)) return 'integer:' + BigInt(number);
  return 'float:' + String(number);
}
function tupleKey(tuple: DshTuple): string {
  // An array of tagged strings is injective even for embedded separators/NULs.
  return JSON.stringify([scalarKey(tuple[0]), scalarKey(tuple[1])]);
}
function height(node: DshNode | null): number {
  return node?.height ?? 0;
}
function node(key: string, entry: DshEntry, left: DshNode | null, right: DshNode | null): DshNode {
  return Object.freeze({
    key,
    entry,
    left,
    right,
    height: 1 + Math.max(height(left), height(right)),
  });
}
function rotateLeft(root: DshNode): DshNode {
  const right = root.right!;
  return node(
    right.key,
    right.entry,
    node(root.key, root.entry, root.left, right.left),
    right.right
  );
}
function rotateRight(root: DshNode): DshNode {
  const left = root.left!;
  return node(left.key, left.entry, left.left, node(root.key, root.entry, left.right, root.right));
}
function balance(root: DshNode): DshNode {
  const delta = height(root.left) - height(root.right);
  if (delta > 1) {
    if (height(root.left!.left) < height(root.left!.right))
      root = node(root.key, root.entry, rotateLeft(root.left!), root.right);
    return rotateRight(root);
  }
  if (delta < -1) {
    if (height(root.right!.right) < height(root.right!.left))
      root = node(root.key, root.entry, root.left, rotateRight(root.right!));
    return rotateLeft(root);
  }
  return root;
}
function lookup(root: DshNode | null, key: string): DshEntry | undefined {
  while (root !== null) {
    if (key === root.key) return root.entry;
    root = key < root.key ? root.left : root.right;
  }
  return undefined;
}
function insert(root: DshNode | null, key: string, entry: DshEntry): DshNode {
  if (root === null) return node(key, entry, null, null);
  if (key === root.key) return node(key, entry, root.left, root.right);
  return balance(
    key < root.key
      ? node(root.key, root.entry, insert(root.left, key, entry), root.right)
      : node(root.key, root.entry, root.left, insert(root.right, key, entry))
  );
}
function remove(root: DshNode | null, key: string): DshNode | null {
  if (root === null) return null;
  if (key < root.key)
    return balance(node(root.key, root.entry, remove(root.left, key), root.right));
  if (key > root.key)
    return balance(node(root.key, root.entry, root.left, remove(root.right, key)));
  if (root.left === null) return root.right;
  if (root.right === null) return root.left;
  let successor = root.right;
  while (successor.left !== null) successor = successor.left;
  return balance(
    node(successor.key, successor.entry, root.left, remove(root.right, successor.key))
  );
}
function put(index: DshIndex, tuple: DshTuple, value: JsonValue): DshIndex {
  const key = tupleKey(tuple),
    old = lookup(index.root, key);
  const entry: DshEntry = Object.freeze({
    tuple: old?.tuple ?? Object.freeze([tuple[0], tuple[1]] as const),
    value,
    ordinal: old?.ordinal ?? index.nextOrdinal,
  });
  return Object.freeze({
    root: insert(index.root, key, entry),
    size: index.size + (old ? 0 : 1),
    nextOrdinal: index.nextOrdinal + (old ? 0n : 1n),
  });
}
/** Explicit seeded-state factory; it confers no timestamp or runtime admissibility. */
export function createDshIndex(
  entries: readonly (readonly [DshTuple, JsonValue])[] = []
): DshIndex {
  let index: DshIndex = Object.freeze({ root: null, size: 0, nextOrdinal: 0n });
  for (const [tuple, value] of entries) index = put(index, tuple, value);
  return index;
}
function entriesInOrder(index: DshIndex): readonly DshEntry[] {
  const entries: DshEntry[] = [];
  const visit = (root: DshNode | null): void => {
    if (root === null) return;
    visit(root.left);
    entries.push(root.entry);
    visit(root.right);
  };
  visit(index.root);
  return entries.sort((a, b) => (a.ordinal < b.ordinal ? -1 : a.ordinal > b.ordinal ? 1 : 0));
}
export interface DshStateView {
  dsh_control_seen?: readonly DshTuple[];
  dsh_step_start_ms?: readonly (readonly [DshTuple, JsonValue])[];
}
/** Diagnostic projection costs O(N log N); normalization never enumerates state. */
export function inspectDshState(state: DshState): Readonly<DshStateView> {
  const view: DshStateView = {};
  for (const field of Object.keys(state)) {
    if (field === 'dsh_control_seen')
      view.dsh_control_seen = Object.freeze(
        entriesInOrder(state.dsh_control_seen!).map((entry) => entry.tuple)
      );
    if (field === 'dsh_step_start_ms')
      view.dsh_step_start_ms = Object.freeze(
        entriesInOrder(state.dsh_step_start_ms!).map((entry) =>
          Object.freeze([entry.tuple, entry.value] as const)
        )
      );
  }
  return Object.freeze(view);
}
function inSet(value: JsonValue | undefined, members: readonly string[]): boolean {
  hashable(value);
  return typeof value === 'string' && members.includes(value);
}
export function matchesDsh(row: JsonObject): boolean {
  return inSet(getMember(row, 'type'), DSH_EVENT_TYPES);
}
function member(value: JsonValue | undefined, key: string, fallback: JsonValue = ''): JsonValue {
  const found = getMember(value, key);
  return found === undefined ? fallback : found;
}
function numeric(value: JsonValue | undefined): value is boolean | JsonNumber {
  return typeof value === 'boolean' || isJsonNumber(value);
}
function integer(value: JsonValue | undefined): value is boolean | JsonNumber {
  return typeof value === 'boolean' || (isJsonNumber(value) && value.numberKind === 'integer');
}
function intValue(value: boolean | JsonNumber): bigint {
  return typeof value === 'boolean' ? (value ? 1n : 0n) : BigInt(value.lexeme);
}
function floatValue(value: boolean | JsonNumber): number {
  const number = typeof value === 'boolean' ? Number(value) : Number(value.lexeme);
  if (integer(value) && !Number.isFinite(number))
    throw new DshProjectionError('OverflowError', 'int too large to convert to float');
  return number;
}
function roundEven(value: number): number {
  const absolute = Math.abs(value),
    base = Math.floor(absolute),
    rest = absolute - base;
  const rounded = rest > 0.5 || (rest === 0.5 && base % 2 !== 0) ? base + 1 : base;
  return value < 0 ? -rounded : rounded;
}
/** Proleptic Gregorian civil year, including values beyond JavaScript Date's range. */
function civilYear(days: number): number {
  const z = days + 719468,
    era = Math.floor(z / 146097),
    doe = z - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365
  );
  const y = yoe + era * 400,
    doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  return y + (mp >= 10 ? 1 : 0);
}
function timestamp(raw: JsonValue | undefined): string | null {
  if (!numeric(raw)) return parseTimestamp(raw);
  const seconds = floatValue(raw) / 1000.0;
  if (Number.isNaN(seconds))
    throw new DshProjectionError('ValueError', 'Invalid value NaN (not a number)');
  if (!Number.isFinite(seconds) || seconds < -(2 ** 63) || seconds >= 2 ** 63)
    throw new DshProjectionError('OverflowError', 'timestamp out of range for platform time_t');
  let whole = Math.trunc(seconds),
    micros = roundEven((seconds - whole) * 1_000_000);
  if (micros >= 1_000_000) {
    whole++;
    micros -= 1_000_000;
  }
  if (micros < 0) {
    whole--;
    micros += 1_000_000;
  }
  const year = civilYear(Math.floor(whole / 86400));
  if (year - 1900 < -2147483648 || year - 1900 > 2147483647)
    throw new DshProjectionError('OSError', '[Errno 84] Value too large to be stored in data type');
  if (year < 1 || year > 9999)
    throw new DshProjectionError('ValueError', `year ${year} is out of range`);
  const date = new Date(whole * 1000),
    pad = (n: number) => String(n).padStart(2, '0');
  return `${String(year).padStart(4, '0')}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}.${String(Math.floor(micros / 1000)).padStart(3, '0')}Z`;
}
function duration(end: boolean | JsonNumber, start: boolean | JsonNumber): JsonNumber {
  if (integer(end) && integer(start)) return jsonNumber(String(intValue(end) - intValue(start)));
  const difference = floatValue(end) - floatValue(start);
  if (Number.isNaN(difference))
    throw new DshProjectionError('ValueError', 'cannot convert float NaN to integer');
  if (!Number.isFinite(difference))
    throw new DshProjectionError('OverflowError', 'cannot convert float infinity to integer');
  return jsonNumber(String(BigInt(roundEven(difference))));
}
function iterable(value: JsonValue | undefined): readonly JsonValue[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return Array.from(value);
  if (isJsonObject(value)) return value.entries.map(([key]) => key);
  const type =
    value === undefined || value === null
      ? 'NoneType'
      : typeof value === 'boolean'
        ? 'bool'
        : isJsonNumber(value) && value.numberKind === 'float'
          ? 'float'
          : 'int';
  throw new DshProjectionError('TypeError', `'${type}' object is not iterable`);
}
function textBlocks(
  blocks: JsonValue | undefined,
  want: string
): Array<{ text: string; index: number }> {
  if (!Array.isArray(blocks)) return [];
  const result: Array<{ text: string; index: number }> = [];
  blocks.forEach((block, index) => {
    if (!isJsonObject(block) || !inSet(getMember(block, 'type'), [want])) return;
    const text = getMember(block, 'text');
    if (typeof text === 'string' && pythonStrip(text)) result.push({ text, index });
  });
  return result;
}
function located(
  event: CanonicalEvent,
  path: readonly (string | number)[] = ['data']
): LocatedEvent {
  return { event, nativeMemberPath: path };
}
function control(kind: string, data: JsonObject, ts: string | null): CanonicalEvent | null {
  const fields: Record<string, readonly [string, string, boolean]> = {
    'session/title': ['title', 'session_title', true],
    'approval/policy': ['policy', 'approval_policy', false],
    'permission/preset': ['preset', 'permission_preset', false],
    'sandbox/mode': ['mode', 'sandbox_mode', false],
    'subagent/descriptor': ['label', 'subagent_descriptor', true],
  };
  if (kind === 'agent/inbox/spliced') {
    const inserted = getMember(data, 'inserted'),
      texts: string[] = [];
    if (Array.isArray(inserted))
      for (const item of inserted) {
        if (!isJsonObject(item)) continue;
        const content = getMember(item, 'content');
        for (const block of iterable(pythonTruthy(content) ? content : [])) {
          const text = getMember(block, 'text');
          if (typeof text === 'string' && pythonStrip(text)) texts.push(text);
        }
      }
    return texts.length
      ? {
          ev: 'control',
          subtype: 'agent_inbox_spliced',
          text: codepointSlice(texts.join('\n\n'), 0, 400),
          ts,
        }
      : null;
  }
  const [field, subtype, strip] = fields[kind]!;
  const text = getMember(data, field);
  if (typeof text !== 'string' || !(strip ? pythonStrip(text) : text)) return null;
  const event: CanonicalEvent = { ev: 'control', subtype, text, ts };
  const extra =
    kind === 'subagent/descriptor'
      ? getMember(data, 'agentModel')
      : kind === 'approval/policy' || kind === 'sandbox/mode'
        ? getMember(data, 'source')
        : undefined;
  return typeof extra === 'string' && extra
    ? { ...event, [kind === 'subagent/descriptor' ? 'model' : 'source']: extra }
    : event;
}
/** Paths identify emitting native objects, not provenance of every projected field. */
export function normalizeDsh(
  row: JsonObject,
  state: DshState,
  decodeEmbeddedArguments: (source: string) => JsonValue
): readonly LocatedEvent[] {
  const ts = timestamp(getMember(row, 'time')),
    data = getMember(row, 'data');
  if (!isJsonObject(data)) return [];
  const kind = getMember(row, 'type');
  if (inSet(kind, GOVERNANCE)) {
    const event = control(kind as string, data, ts);
    if (event === null) return [];
    if (event.subtype === 'subagent_descriptor') {
      const seen = (state.dsh_control_seen ??= createDshIndex());
      const key: DshTuple = [event.subtype, event.text ?? null];
      if (lookup(seen.root, tupleKey(key)) !== undefined) return [];
      state.dsh_control_seen = put(seen, key, null);
    }
    return [located(event)];
  }
  if (inSet(kind, ['step/start', 'step/end'])) {
    const key: DshTuple = [member(data, 'turn', null), member(data, 'step', null)];
    const starts = (state.dsh_step_start_ms ??= createDshIndex());
    if (kind === 'step/start') {
      state.dsh_step_start_ms = put(starts, key, member(row, 'time', null));
      return [];
    }
    // CPython's empty dict.pop(key, default) skips hashing an invalid key.
    const hash = starts.size ? tupleKey(key) : undefined;
    const existing = hash === undefined ? undefined : lookup(starts.root, hash);
    const started = existing?.value;
    if (existing !== undefined)
      state.dsh_step_start_ms = Object.freeze({
        root: remove(starts.root, hash!),
        size: starts.size - 1,
        nextOrdinal: starts.nextOrdinal,
      });
    const step = getMember(data, 'step'),
      turn = getMember(data, 'turn'),
      time = getMember(row, 'time');
    return [
      located({
        ev: 'control',
        subtype: 'step',
        ts,
        ...(integer(step) ? { step } : {}),
        ...(integer(turn) ? { turn } : {}),
        ...(numeric(started) && numeric(time) ? { duration_ms: duration(time, started) } : {}),
      }),
    ];
  }
  if (kind === 'turn/start')
    return [located({ ev: 'turn_boundary', turn_id: member(data, 'turn', null), ts })];
  if (kind === 'user/message') {
    const source = getMember(data, 'source');
    if (!isJsonObject(source) || getMember(source, 'kind') !== 'user') return [];
    return textBlocks(getMember(data, 'content'), 'text').map(({ text, index }) =>
      located({ ev: 'user_text', text, ts }, ['data', 'content', index])
    );
  }
  if (kind === 'assistant/message') {
    const message = getMember(data, 'message');
    if (!isJsonObject(message)) return [];
    const content = getMember(message, 'content'),
      events: LocatedEvent[] = [];
    for (const [want, ev] of [
      ['reasoning', 'reasoning'],
      ['text', 'assistant_text'],
    ] as const)
      for (const { text, index } of textBlocks(content, want))
        events.push(located({ ev, text, ts }, ['data', 'message', 'content', index]));
    const usageRaw = getMember(data, 'usage'),
      entries: Array<readonly [string, JsonValue]> = [];
    for (const [src, dst] of [
      ['inputTokens', 'input_tokens'],
      ['outputTokens', 'output_tokens'],
      ['cacheReadTokens', 'cache_read_input_tokens'],
      ['reasoningTokens', 'reasoning_output_tokens'],
    ]) {
      const value = getMember(usageRaw, src!);
      if (numeric(value)) entries.push([dst!, value]);
    }
    const model = getMember(getMember(message, 'source'), 'model');
    if (entries.length || (typeof model === 'string' && model))
      events.push(
        located(
          {
            ev: 'assistant_meta',
            ts,
            ...(entries.length ? { usage: jsonObject(entries) } : {}),
            ...(typeof model === 'string' && model ? { model } : {}),
          },
          ['data', 'message']
        )
      );
    return events;
  }
  if (kind === 'tool/call') {
    let args = getMember(data, 'arguments');
    if (typeof args === 'string')
      try {
        args = decodeEmbeddedArguments(args);
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        args = jsonObject([['raw', args]]);
      }
    return [
      located({
        ev: 'tool_use',
        name: member(data, 'name'),
        id: member(data, 'callId'),
        input: isJsonObject(args) ? args : jsonObject([]),
        ts,
      }),
    ];
  }
  if (kind === 'tool/result') {
    const message = getMember(data, 'message');
    if (!isJsonObject(message)) return [];
    const blocks = iterable(member(message, 'content', [])),
      events: LocatedEvent[] = [];
    blocks.forEach((block, index) => {
      if (!isJsonObject(block) || getMember(block, 'type') !== 'tool-result') return;
      const text = textBlocks(getMember(block, 'content'), 'text')
        .map(({ text }) => text)
        .join('\n\n');
      events.push(
        located(
          {
            ev: 'tool_result',
            id: member(block, 'toolCallId'),
            content: text,
            is_error: member(block, 'isError', false),
            ts,
          },
          ['data', 'message', 'content', index]
        )
      );
    });
    return events;
  }
  return [];
}
export interface DshEmbeddedJsonProfile {
  readonly id: string;
  /** SyntaxError denotes malformed JSON; every other decoder failure propagates unchanged. */
  readonly decode: (source: string) => JsonValue;
}
/** The caller selects decoder admission. A profile label alone proves no production parity. */
export function createDshAdapter(profile: DshEmbeddedJsonProfile): TranscriptAdapter<DshState> {
  const { id, decode } = profile;
  if (typeof id !== 'string' || !id.trim() || typeof decode !== 'function')
    throw new TypeError('DSH embedded JSON profile requires an identity and decoder');
  return Object.freeze({
    id: 'dsh',
    revision: `${DSH_ADAPTER_REVISION};embedded-json:${id}`,
    matches: matchesDsh,
    createState: createDshState,
    cloneState: cloneDshState,
    normalize: (row: JsonObject, state: DshState) => ({
      state,
      events: normalizeDsh(row, state, decode),
    }),
  });
}
