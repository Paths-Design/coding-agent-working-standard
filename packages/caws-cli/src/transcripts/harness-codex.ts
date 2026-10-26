/** Codex projection of the identified Python adapter. Source syntax is never execution evidence. */
import {
  PYTHON_DECIMAL_PATTERN,
  PYTHON_WORD_PATTERN,
  UNICODE_PROFILE_ID,
  lookupPythonLiteralName,
} from './python-unicode-profile';
import {
  codepointText,
  codepointTextFromString,
  isCodepointText,
  textLength,
  textSlice,
  textEqual,
  quoteCodepointJson,
  type CodepointText,
} from './codepoint-text';
import { PYTHON_WHITESPACE_PATTERN } from './source-occurrence';
import { parseTranscriptJson, type TranscriptJsonNumericProfile } from './transcript-json-profile';
import {
  getMember,
  hasMember,
  isJsonNumber,
  isJsonObject,
  jsonObject,
  parsePythonJson,
  pythonEqual,
  pythonJsonDumps,
  pythonStr,
  pythonTruthy,
  type JsonObject,
  type JsonValue,
} from './lossless-json';
import {
  decodeStructuredTextPayload,
  parseContextAuthorityBlock,
  parseTimestamp,
  pythonStrip,
  type CanonicalEvent,
  type LocatedEvent,
  type NormalizationContext,
  type TranscriptAdapter,
} from './harness-common';

// Bump the native revision when projection semantics change; the hash identifies the reference only.
export const CODEX_ADAPTER_REVISION = `native-codex/3;interpretation-profile:${UNICODE_PROFILE_ID};python-sha256:fca73c2b632122bc471322b38452db3ea41cf3eab693d02be757fd9217b31ee0`;
export const AGENTS_MD_PREFIX = '# AGENTS.md instructions for ';
export type CodexState = Readonly<{ turnSeen: boolean; pendingToolId?: JsonValue }>;
export function createCodexState(): CodexState {
  return { turnSeen: false };
}
export function cloneCodexState(state: CodexState): CodexState {
  return { ...state };
}

const PY_SPACE =
  '[\\u0009-\\u000d\\u001c-\\u0020\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';
const JS_STRING_TOKEN = '("(?:\\\\.|[^"\\\\])*"|\'(?:\\\\.|[^\'\\\\])*\'|`(?:\\\\.|[^`\\\\])*`)';
const PY_BOUNDARY = `(?<!${PYTHON_WORD_PATTERN})`;
const identifier = `[A-Za-z_$](?:${PYTHON_WORD_PATTERN}|\\$)*`;

/** Decode the Python literal subset used by the reference's ast.literal_eval branch; never evaluate code. */
function singleQuotedLiteral(token: string): CodepointText | null {
  if (token.length < 2 || !token.endsWith("'")) return null;
  // Python's AST parser rejects raw NUL and lone source surrogates before literal decoding.
  if (
    token.includes('\0') ||
    Array.from(token).some((char) => {
      const point = char.codePointAt(0)!;
      return point >= 0xd800 && point <= 0xdfff;
    })
  )
    return null;
  const result: number[] = [];
  const appendPoint = (point: number): void => {
    result.push(point);
  };
  const appendText = (text: string): void => {
    for (const character of text) appendPoint(character.codePointAt(0)!);
  };
  const simple: Readonly<Record<string, string>> = {
    a: '\x07',
    b: '\b',
    f: '\f',
    n: '\n',
    r: '\r',
    t: '\t',
    v: '\v',
    '\\': '\\',
    "'": "'",
    '"': '"',
  };
  for (let index = 1; index < token.length - 1; index++) {
    const char = token[index]!;
    if (char === "'" || char === '\n' || char === '\r' || char === '\0') return null;
    if (char !== '\\') {
      const point = token.codePointAt(index)!;
      appendPoint(point);
      if (point > 0xffff) index++;
      continue;
    }
    const escape = token[++index];
    if (escape === undefined || index >= token.length - 1) return null;
    if (escape === '\n') continue;
    if (escape === '\r') {
      if (token[index + 1] === '\n') index++;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(simple, escape)) {
      appendText(simple[escape]!);
      continue;
    }
    if (/[0-7]/.test(escape)) {
      let octal = escape;
      while (octal.length < 3 && index + 1 < token.length - 1 && /[0-7]/.test(token[index + 1]!))
        octal += token[++index]!;
      appendPoint(parseInt(octal, 8));
      continue;
    }
    if (escape === 'N') {
      if (token[index + 1] !== '{') return null;
      const close = token.indexOf('}', index + 2);
      if (close < 0) return null;
      const point = lookupPythonLiteralName(token.slice(index + 2, close));
      if (point === null) return null;
      appendPoint(point);
      index = close;
      continue;
    }
    if (escape === 'x' || escape === 'u' || escape === 'U') {
      const count = escape === 'x' ? 2 : escape === 'u' ? 4 : 8;
      const digits = token.slice(index + 1, index + 1 + count);
      if (digits.length !== count || !/^[0-9a-f]+$/i.test(digits)) return null;
      const point = parseInt(digits, 16);
      if (point > 0x10ffff) return null;
      appendPoint(point);
      index += count;
      continue;
    }
    appendPoint(0x5c);
    const point = token.codePointAt(index)!;
    appendPoint(point);
    if (point > 0xffff) index++;
  }
  return codepointText(result, UNICODE_PROFILE_ID);
}

export function decodeJsString(token: string): CodepointText | null {
  if (token.startsWith("'")) return singleQuotedLiteral(token);
  if (token.startsWith('"')) {
    try {
      const value = parsePythonJson(token);
      return typeof value === 'string' ? codepointTextFromString(value, UNICODE_PROFILE_ID) : null;
    } catch {
      return null;
    }
  }
  if (token.startsWith('`')) {
    if (token.includes('${')) return null;
    return codepointTextFromString(
      token
        .slice(1, -1)
        .replace(/\\([`\\])/g, '$1')
        .replaceAll('\\n', '\n')
        .replaceAll('\\r', '\r')
        .replaceAll('\\t', '\t'),
      UNICODE_PROFILE_ID
    );
  }
  return null;
}

/** Deliberately mirrors the limited reference scanner; comments/regex/interpolation are not fully parsed. */
export function balancedCallArgument(source: string, openParen: number): readonly [string, number] {
  let depth = 1,
    index = openParen + 1,
    quote = '',
    escaped = false;
  while (index < source.length) {
    const char = source[index]!;
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
    } else if (char === '"' || char === "'" || char === '`') quote = char;
    else if (char === '(') depth++;
    else if (char === ')' && --depth === 0) return [source.slice(openParen + 1, index), index + 1];
    index++;
  }
  return [source.slice(openParen + 1), source.length];
}
function stringField(source: string, field: string): CodepointText | null {
  const match = new RegExp(
    `(?:["']?${field}["']?)${PY_SPACE}*:${PY_SPACE}*${JS_STRING_TOKEN}`,
    'su'
  ).exec(source);
  return match ? decodeJsString(match[1]!) : null;
}
export function decodeMapping(
  value: JsonValue | undefined,
  profile?: TranscriptJsonNumericProfile
): JsonObject {
  if (isJsonObject(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = parseTranscriptJson(value, profile);
      if (isJsonObject(parsed)) return parsed;
    } catch (error) {
      if (profile !== undefined && !(error instanceof SyntaxError)) throw error;
      /* Invalid JSON remains the original string, as in the reference. */
    }
    return jsonObject([['raw', value]]);
  }
  return jsonObject([]);
}
function jsCodePositions(source: string): boolean[] {
  const code = Array<boolean>(source.length).fill(true);
  let index = 0;
  while (index < source.length) {
    const start = index;
    if (source.startsWith('//', index)) {
      const end = source.indexOf('\n', index);
      index = end < 0 ? source.length : end;
    } else if (source.startsWith('/*', index)) {
      const end = source.indexOf('*/', index + 2);
      index = end < 0 ? source.length : end + 2;
    } else if (['"', "'", '`'].includes(source[index]!)) {
      const quote = source[index++]!;
      while (index < source.length) {
        if (source[index] === '\\') index += 2;
        else if (source[index] === quote) {
          index++;
          break;
        } else index++;
      }
    } else {
      index++;
      continue;
    }
    code.fill(false, start, Math.min(index, source.length));
  }
  return code;
}
export function truncateCodexText(
  text: CodepointText | null | undefined,
  limit: number
): CodepointText {
  if (!Number.isSafeInteger(limit) || limit < 0)
    throw new RangeError('Preview limit must be a nonnegative safe integer');
  const value = text ?? codepointText([], UNICODE_PROFILE_ID);
  return textLength(value) <= limit
    ? value
    : codepointText([...textSlice(value, 0, limit).codepoints, 46, 46, 46], value.profileId);
}

function nonempty(value: CodepointText | null | undefined): value is CodepointText {
  return value !== undefined && value !== null && textLength(value) !== 0;
}

/** Match the historical LF/whitespace regex while retaining original codepoint slices. */
function codepointPatchPaths(patch: CodepointText): readonly CodepointText[] {
  // Astral codepoints become a non-whitespace BMP placeholder; every regex
  // offset then indexes one original codepoint. Surrogate codepoints stay separate.
  const mapped = patch.codepoints
    .map((point) => String.fromCharCode(point > 0xffff ? 0xe000 : point))
    .join('');
  const pattern = new RegExp(
    `(?:^|\n)\\*\\*\\* (?:Add|Update|Delete) File:${PYTHON_WHITESPACE_PATTERN}*([^\n]+?)${PYTHON_WHITESPACE_PATTERN}*(?=\n|(?![\\s\\S]))`,
    'gd'
  );
  const whitespace = new RegExp(`^${PYTHON_WHITESPACE_PATTERN}$`, 'u');
  const paths: CodepointText[] = [];
  for (const match of mapped.matchAll(pattern)) {
    const [captureStart, captureEnd] = match.indices![1]!;
    let start = captureStart,
      end = captureEnd;
    while (start < end && whitespace.test(mapped[start]!)) start++;
    while (end > start && whitespace.test(mapped[end - 1]!)) end--;
    const value = textSlice(patch, start, end);
    if (textLength(value) && !paths.some((path) => textEqual(path, value))) paths.push(value);
  }
  return Object.freeze(paths);
}

export type CodexInnerAction = Readonly<{
  tool: string;
  observation_boundary: 'source_syntax';
  execution: 'not_observed';
  command?: CodepointText;
  workdir?: CodepointText;
  path?: CodepointText;
  files?: readonly CodepointText[];
  patch_preview?: CodepointText;
  patch_length?: number;
  args_preview?: CodepointText;
  batch_commands?: readonly CodepointText[];
}>;
type MutableAction = { -readonly [Key in keyof CodexInnerAction]: CodexInnerAction[Key] };

/** Optional static index; retained functions.exec input remains the primary source. */
export function extractCodexInnerActions(source: string): readonly CodexInnerAction[] {
  const code = jsCodePositions(source),
    assignments = new Map<string, CodepointText>();
  const assignment = new RegExp(
    `${PY_BOUNDARY}const${PY_SPACE}+(${identifier})${PY_SPACE}*=${PY_SPACE}*${JS_STRING_TOKEN}${PY_SPACE}*;`,
    'gsu'
  );
  for (const match of source.matchAll(assignment)) {
    const decoded = decodeJsString(match[2]!);
    if (decoded !== null) assignments.set(match[1]!, decoded);
  }
  const actions: MutableAction[] = [];
  const calls = new RegExp(`${PY_BOUNDARY}tools\\.(${identifier})${PY_SPACE}*\\(`, 'gu');
  for (;;) {
    const match = calls.exec(source);
    if (!match) break;
    if (!code[match.index]) continue;
    const tool = match[1]!,
      [args, next] = balancedCallArgument(source, calls.lastIndex - 1);
    calls.lastIndex = next;
    const action: MutableAction = {
      tool,
      observation_boundary: 'source_syntax',
      execution: 'not_observed',
    };
    if (tool === 'exec_command') {
      const cmd = stringField(args, 'cmd');
      const command = nonempty(cmd) ? cmd : stringField(args, 'command');
      if (nonempty(command)) action.command = command;
      const workdir = stringField(args, 'workdir');
      if (nonempty(workdir)) action.workdir = workdir;
    } else if (tool === 'apply_patch') {
      const token = pythonStrip(args);
      let patch = assignments.get(token) ?? null;
      if (patch === null && new RegExp(`^${JS_STRING_TOKEN}$`, 'su').test(token))
        patch = decodeJsString(token);
      if (patch !== null) {
        action.files = codepointPatchPaths(patch);
        action.patch_preview = truncateCodexText(patch, 3000);
        action.patch_length = textLength(patch);
      }
    } else if (tool === 'view_image') {
      const imagePath = stringField(args, 'path');
      if (nonempty(imagePath)) action.path = imagePath;
    } else
      action.args_preview = truncateCodexText(
        codepointTextFromString(pythonStrip(args), UNICODE_PROFILE_ID),
        3000
      );
    actions.push(action);
  }
  if (source.includes('exec_command({cmd') && source.includes('Promise.all')) {
    const commands: CodepointText[] = [];
    const tuples = new RegExp(
      `\\[${PY_SPACE}*${JS_STRING_TOKEN}${PY_SPACE}*,${PY_SPACE}*${JS_STRING_TOKEN}${PY_SPACE}*\\]`,
      'gsu'
    );
    for (const match of source.matchAll(tuples)) {
      const command = decodeJsString(match[2]!);
      if (nonempty(command)) commands.push(command);
    }
    const unresolved = actions.find(
      (action) => action.tool === 'exec_command' && !nonempty(action.command)
    );
    if (unresolved && commands.length) unresolved.batch_commands = Object.freeze(commands);
  }
  return Object.freeze(actions.map((action) => Object.freeze(action)));
}

export type CodexSourceIndex = Readonly<{
  disposition: 'indexed';
  rawSource: string;
  interpretationProfileId: string;
  actions: readonly CodexInnerAction[];
  observationBoundary: 'source_syntax';
  execution: 'not_observed';
}>;

export function extractCodexSourceIndex(rawSource: string): CodexSourceIndex {
  return Object.freeze({
    disposition: 'indexed',
    rawSource,
    interpretationProfileId: UNICODE_PROFILE_ID,
    actions: extractCodexInnerActions(rawSource),
    observationBoundary: 'source_syntax',
    execution: 'not_observed',
  });
}

/** Historical JSON projection. Retain action vectors before decoding this non-injective output. */
export function serializeCodexInnerActions(
  actions: readonly CodexInnerAction[],
  options: { ensureAscii?: boolean } = {}
): string {
  const ascii = options.ensureAscii ?? true;
  const string = (value: string): string =>
    quoteCodepointJson(codepointTextFromString(value, UNICODE_PROFILE_ID), ascii);
  const text = (value: CodepointText): string => {
    if (!isCodepointText(value))
      throw new TypeError('Expected constructed CodepointText for Codex action text');
    if (value.profileId !== UNICODE_PROFILE_ID)
      throw new RangeError('Codex action text requires the selected interpretation profile');
    return quoteCodepointJson(value, ascii);
  };
  const encode = (value: CodexInnerAction[keyof CodexInnerAction]): string => {
    if (typeof value === 'string') return string(value);
    if (typeof value === 'number') {
      if (!Number.isSafeInteger(value) || value < 0)
        throw new RangeError('Patch length must be a nonnegative safe integer');
      return String(value);
    }
    if (Array.isArray(value)) return '[' + value.map((item) => text(item)).join(', ') + ']';
    if (value === undefined) throw new TypeError('Undefined action field cannot be serialized');
    return text(value as CodepointText);
  };
  return (
    '[' +
    actions
      .map(
        (action) =>
          '{' +
          Object.entries(action)
            .map(([key, value]) => string(key) + ': ' + encode(value))
            .join(', ') +
          '}'
      )
      .join(', ') +
    ']'
  );
}

export function codexOutputIsError(
  raw: string,
  decoded: string,
  profile?: TranscriptJsonNumericProfile
): boolean {
  const status = new RegExp('Process exited with code (' + PYTHON_DECIMAL_PATTERN + '+)', 'u').exec(
    raw
  );
  if (status && status[1] !== '0') return true;
  const lowered = pythonStrip(decoded || raw).toLowerCase();
  if (lowered.startsWith('script failed') || lowered.startsWith('tool failed')) return true;
  try {
    const value = parseTranscriptJson(raw, profile),
      items: readonly JsonValue[] = Array.isArray(value) ? value : [value];
    return items.some(
      (item) =>
        isJsonObject(item) &&
        (getMember(item, 'is_error') === true || getMember(item, 'success') === false)
    );
  } catch {
    return false;
  }
}

export function matchesCodex(row: JsonObject): boolean {
  return ['turn_context', 'response_item', 'token_usage_record', 'event_msg'].some(
    (type) => getMember(row, 'type') === type
  );
}
const member = (value: JsonValue | undefined, key: string, fallback: JsonValue): JsonValue =>
  hasMember(value, key) ? getMember(value, key)! : fallback;
const isPythonNumber = (value: JsonValue | undefined): value is JsonValue =>
  typeof value === 'boolean' || isJsonNumber(value);
const numericUsage = [
  'input_tokens',
  'output_tokens',
  'cached_input_tokens',
  'cache_read_input_tokens',
  'cache_creation_input_tokens',
  'reasoning_output_tokens',
  'total_tokens',
];
function callId(payload: JsonObject): JsonValue {
  const call = getMember(payload, 'call_id');
  return pythonTruthy(call) ? call! : member(payload, 'id', '');
}
function located(
  event: CanonicalEvent,
  ...nativeMemberPath: readonly (string | number)[]
): LocatedEvent {
  return { event, nativeMemberPath };
}

/** Pure transaction: the caller's state and lossless row are never mutated. */
export function normalizeCodexRow(
  row: JsonObject,
  previous: CodexState,
  context?: NormalizationContext
): { state: CodexState; events: readonly LocatedEvent[] } {
  let state = cloneCodexState(previous);
  const events: LocatedEvent[] = [],
    ts = parseTimestamp(getMember(row, 'timestamp'));
  const type = getMember(row, 'type'),
    payload = getMember(row, 'payload');
  if (type === 'token_usage_record') {
    const raw = getMember(payload, 'usage');
    if (isJsonObject(raw)) {
      const entries: Array<readonly [string, JsonValue]> = [];
      for (const key of numericUsage) {
        const value = getMember(raw, key);
        if (isPythonNumber(value)) entries.push([key, value]);
      }
      events.push(
        located(
          { ev: 'assistant_meta', usage: entries.length ? jsonObject(entries) : null, ts },
          'payload',
          'usage'
        )
      );
    }
  } else if (type === 'event_msg') {
    if (isJsonObject(payload) && getMember(payload, 'type') === 'turn_aborted') {
      const event: CanonicalEvent = { ev: 'control', subtype: 'turn_aborted', ts };
      const reason = getMember(payload, 'reason'),
        duration = getMember(payload, 'duration_ms');
      events.push(
        located(
          {
            ...event,
            ...(pythonTruthy(reason) ? { text: pythonStr(reason!) } : {}),
            ...(isPythonNumber(duration) ? { duration_ms: duration } : {}),
          },
          'payload'
        )
      );
    }
  } else if (isJsonObject(payload) && type === 'turn_context') {
    state = { ...state, turnSeen: true };
    const event: Record<string, JsonValue> & { ev: 'turn_boundary' } = {
      ev: 'turn_boundary',
      turn_id: member(payload, 'turn_id', null),
      ts,
    };
    for (const key of ['model', 'effort', 'cwd', 'approval_policy', 'sandbox_policy']) {
      const value = getMember(payload, key);
      if ((typeof value === 'string' || isPythonNumber(value)) && pythonStrip(pythonStr(value!)))
        event[key] = value!;
    }
    events.push(located(event, 'payload'));
  } else if (isJsonObject(payload) && type === 'response_item') {
    const itemType = getMember(payload, 'type');
    if (itemType === 'reasoning') {
      const summary = getMember(payload, 'summary');
      if (Array.isArray(summary))
        for (const [index, item] of summary.entries()) {
          const text = getMember(item, 'text');
          if (isJsonObject(item) && typeof text === 'string' && pythonStrip(text))
            events.push(located({ ev: 'reasoning', text, ts }, 'payload', 'summary', index));
        }
    } else if (itemType === 'message') {
      const role = getMember(payload, 'role'),
        content = getMember(payload, 'content');
      if (
        ['user', 'assistant', 'developer'].some((value) => value === role) &&
        getMember(payload, 'channel') !== 'analysis' &&
        Array.isArray(content)
      ) {
        const kinds = getMember(
          getMember(payload, 'internal_chat_message_metadata_passthrough'),
          'content_item_kinds'
        );
        const texts: Array<{ text: string; index: number }> = [];
        for (const [index, item] of content.entries()) {
          if (
            role === 'user' &&
            Array.isArray(kinds) &&
            !(
              index < kinds.length &&
              typeof kinds[index] === 'string' &&
              kinds[index].startsWith('user.')
            )
          )
            continue;
          const text = getMember(item, 'text');
          if (
            isJsonObject(item) &&
            ['input_text', 'output_text', 'text'].some(
              (value) => value === getMember(item, 'type')
            ) &&
            typeof text === 'string'
          )
            texts.push({ text, index });
        }
        if (!(role === 'user' && texts[0]?.text.startsWith(AGENTS_MD_PREFIX))) {
          for (const { text, index } of texts) {
            if (!pythonStrip(text)) continue;
            if (role === 'developer') {
              if (!state.turnSeen) continue;
              const hook = /^\[([^\]]+)\]/.exec(pythonStrip(text)),
                authority = parseContextAuthorityBlock(text);
              events.push(
                located(
                  {
                    ev: 'hook_context',
                    kind: authority ? 'context_authority' : 'developer_context',
                    hook_name: hook?.[1] ?? (authority ? 'casr-context.sh' : 'codex'),
                    hook_event: pythonTruthy(state.pendingToolId) ? 'PreToolUse' : 'Context',
                    tool_use_id: state.pendingToolId ?? null,
                    additional_context: text,
                    context_authority: authority,
                    provenance: 'codex_developer_message',
                    ts,
                  },
                  'payload',
                  'content',
                  index
                )
              );
            } else
              events.push(
                located(
                  { ev: role === 'user' ? 'user_text' : 'assistant_text', text, ts },
                  'payload',
                  'content',
                  index
                )
              );
          }
        }
      }
    } else if (itemType === 'custom_tool_call' || itemType === 'function_call') {
      const id = callId(payload);
      state = { ...state, pendingToolId: id };
      let name = member(payload, 'name', ''),
        input = decodeMapping(
          hasMember(payload, 'arguments')
            ? getMember(payload, 'arguments')
            : getMember(payload, 'input'),
          context?.numericProfile
        );
      if (
        ['exec_command', 'functions.exec_command', 'shell_command'].some((value) => value === name)
      ) {
        name = 'Bash';
        input = jsonObject([
          ...input.entries,
          [
            'command',
            hasMember(input, 'cmd') ? getMember(input, 'cmd')! : member(input, 'command', ''),
          ],
        ]);
      }
      events.push(located({ ev: 'tool_use', name, id, input, ts }, 'payload'));
    } else if (itemType === 'custom_tool_call_output' || itemType === 'function_call_output') {
      const value = member(payload, 'output', ''),
        output =
          typeof value === 'string'
            ? value
            : pythonJsonDumps(value, { sortKeys: true, ensureAscii: false });
      const id = callId(payload);
      if (pythonEqual(state.pendingToolId, id)) state = { turnSeen: state.turnSeen };
      events.push(
        located(
          {
            ev: 'tool_result',
            id,
            content: output,
            is_error: codexOutputIsError(
              output,
              decodeStructuredTextPayload(output, context?.numericProfile),
              context?.numericProfile
            ),
            ts,
          },
          'payload'
        )
      );
    }
  }
  return { state, events };
}

export const CODEX_ADAPTER: TranscriptAdapter<CodexState> = {
  id: 'codex',
  revision: CODEX_ADAPTER_REVISION,
  matches: matchesCodex,
  createState: createCodexState,
  cloneState: cloneCodexState,
  normalize: normalizeCodexRow,
};
