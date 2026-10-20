/** Codex projection of the identified Python adapter. Source syntax is never execution evidence. */
import { PYTHON_DECIMAL_PATTERN } from './python-unicode';
import {
  getMember,
  hasMember,
  isJsonNumber,
  isJsonObject,
  jsonNumber,
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
  codepointLength,
  codepointSlice,
  decodeStructuredTextPayload,
  parseContextAuthorityBlock,
  parseTimestamp,
  patchPaths,
  pythonStrip,
  type CanonicalEvent,
  type LocatedEvent,
  type TranscriptAdapter,
} from './harness-common';

// Bump the native revision when projection semantics change; the hash identifies the reference only.
export const CODEX_ADAPTER_REVISION =
  'native-codex/2;unicode:14.0.0;python-sha256:fca73c2b632122bc471322b38452db3ea41cf3eab693d02be757fd9217b31ee0';
export const AGENTS_MD_PREFIX = '# AGENTS.md instructions for ';
export type CodexState = Readonly<{ turnSeen: boolean; pendingToolId?: JsonValue }>;
export function createCodexState(): CodexState {
  return { turnSeen: false };
}
export function cloneCodexState(state: CodexState): CodexState {
  return { ...state };
}

/** Python's named Unicode lookup has no built-in Node equivalent. Do not approximate it. */
export class UnsupportedCodexStringEscape extends Error {
  constructor() {
    super('Named Unicode escapes in Python single-quoted source literals are unsupported');
    this.name = 'UnsupportedCodexStringEscape';
  }
}
/** Python literal escapes can retain surrogate codepoints that JS strings combine. */
export class UnsupportedCodexSurrogateLiteral extends Error {
  constructor() {
    super(
      'Adjacent surrogate codepoints in Python single-quoted literals require distinct custody'
    );
    this.name = 'UnsupportedCodexSurrogateLiteral';
  }
}
export class UnsupportedCodexIdentifierProfile extends Error {
  constructor() {
    super(
      'Non-ASCII letter/number code positions require an unqualified Unicode identifier profile'
    );
    this.name = 'UnsupportedCodexIdentifierProfile';
  }
}
const PY_SPACE =
  '[\\u0009-\\u000d\\u001c-\\u0020\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';
const JS_STRING_TOKEN = '("(?:\\\\.|[^"\\\\])*"|\'(?:\\\\.|[^\'\\\\])*\'|`(?:\\\\.|[^`\\\\])*`)';
const PY_BOUNDARY = '(?<![\\p{L}\\p{N}_])';
const identifier = '[A-Za-z_$][\\p{L}\\p{N}_$]*';

/** Decode the Python literal subset used by the reference's ast.literal_eval branch; never evaluate code. */
function singleQuotedLiteral(token: string): string | null {
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
  let result = '';
  let previousPoint: number | undefined;
  const appendPoint = (point: number): void => {
    if (
      previousPoint !== undefined &&
      previousPoint >= 0xd800 &&
      previousPoint <= 0xdbff &&
      point >= 0xdc00 &&
      point <= 0xdfff
    )
      throw new UnsupportedCodexSurrogateLiteral();
    result += String.fromCodePoint(point);
    previousPoint = point;
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
      if (token[index + 1] !== '{' || token.indexOf('}', index + 2) < 0) return null;
      throw new UnsupportedCodexStringEscape();
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
  return result;
}

export function decodeJsString(token: string): string | null {
  if (token.startsWith("'")) return singleQuotedLiteral(token);
  if (token.startsWith('"')) {
    try {
      const value = parsePythonJson(token);
      return typeof value === 'string' ? value : null;
    } catch {
      return null;
    }
  }
  if (token.startsWith('`')) {
    if (token.includes('${')) return null;
    return token
      .slice(1, -1)
      .replace(/\\([`\\])/g, '$1')
      .replaceAll('\\n', '\n')
      .replaceAll('\\r', '\r')
      .replaceAll('\\t', '\t');
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
function stringField(source: string, field: string): string | null {
  const match = new RegExp(
    `(?:["']?${field}["']?)${PY_SPACE}*:${PY_SPACE}*${JS_STRING_TOKEN}`,
    'su'
  ).exec(source);
  return match ? decodeJsString(match[1]!) : null;
}
export function decodeMapping(value: JsonValue | undefined): JsonObject {
  if (isJsonObject(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = parsePythonJson(value);
      if (isJsonObject(parsed)) return parsed;
    } catch {
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
export function truncateCodexText(text: string | null | undefined, limit: number): string {
  const value = text ?? '';
  return codepointLength(value) <= limit ? value : codepointSlice(value, 0, limit) + '...';
}

/** Optional static index. The original functions.exec input remains the primary retained source.
 * The ASCII code-identifier profile deliberately declines some Python-14-supported
 * inputs as well as newer Unicode identifiers; Unicode literals/comments/paths survive.
 * This avoids claiming Node Unicode tables are the reference's Python Unicode 14 tables.
 */
export function extractCodexInnerActions(source: string): readonly JsonObject[] {
  const code = jsCodePositions(source),
    assignments = new Map<string, string>();
  for (let index = 0; index < source.length; ) {
    const point = source.codePointAt(index)!,
      char = String.fromCodePoint(point);
    if (point > 0x7f && code[index] && /[\p{L}\p{N}]/u.test(char))
      throw new UnsupportedCodexIdentifierProfile();
    index += char.length;
  }
  const assignment = new RegExp(
    `${PY_BOUNDARY}const${PY_SPACE}+(${identifier})${PY_SPACE}*=${PY_SPACE}*${JS_STRING_TOKEN}${PY_SPACE}*;`,
    'gsu'
  );
  for (const match of source.matchAll(assignment)) {
    const decoded = decodeJsString(match[2]!);
    if (decoded !== null) assignments.set(match[1]!, decoded);
  }
  const actions: Array<Record<string, JsonValue>> = [];
  const calls = new RegExp(`${PY_BOUNDARY}tools\\.(${identifier})${PY_SPACE}*\\(`, 'gu');
  for (;;) {
    const match = calls.exec(source);
    if (!match) break;
    if (!code[match.index]) continue;
    const tool = match[1]!,
      [args, next] = balancedCallArgument(source, calls.lastIndex - 1);
    calls.lastIndex = next;
    const action: Record<string, JsonValue> = {
      tool,
      observation_boundary: 'source_syntax',
      execution: 'not_observed',
    };
    if (tool === 'exec_command') {
      const command = stringField(args, 'cmd') || stringField(args, 'command');
      if (command) action.command = command;
      const workdir = stringField(args, 'workdir');
      if (workdir) action.workdir = workdir;
    } else if (tool === 'apply_patch') {
      const token = pythonStrip(args);
      let patch = assignments.get(token) ?? null;
      if (patch === null && new RegExp(`^${JS_STRING_TOKEN}$`, 'su').test(token))
        patch = decodeJsString(token);
      if (patch !== null) {
        action.files = patchPaths(patch);
        action.patch_preview = truncateCodexText(patch, 3000);
        action.patch_length = jsonNumber(String(codepointLength(patch)));
      }
    } else if (tool === 'view_image') {
      const imagePath = stringField(args, 'path');
      if (imagePath) action.path = imagePath;
    } else action.args_preview = truncateCodexText(pythonStrip(args), 3000);
    actions.push(action);
  }
  if (source.includes('exec_command({cmd') && source.includes('Promise.all')) {
    const commands: string[] = [];
    const tuples = new RegExp(
      `\\[${PY_SPACE}*${JS_STRING_TOKEN}${PY_SPACE}*,${PY_SPACE}*${JS_STRING_TOKEN}${PY_SPACE}*\\]`,
      'gsu'
    );
    for (const match of source.matchAll(tuples)) {
      const command = decodeJsString(match[2]!);
      if (command) commands.push(command);
    }
    const unresolved = actions.find(
      (action) => action.tool === 'exec_command' && !pythonTruthy(action.command)
    );
    if (unresolved && commands.length) unresolved.batch_commands = commands;
  }
  return actions.map((action) => jsonObject(Object.entries(action)));
}

export type CodexSourceIndex =
  | Readonly<{
      disposition: 'indexed';
      rawSource: string;
      actions: readonly JsonObject[];
      observationBoundary: 'source_syntax';
      execution: 'not_observed';
    }>
  | Readonly<{
      disposition: 'unsupported';
      rawSource: string;
      reason: 'named_unicode_escape' | 'unicode_identifier_profile' | 'surrogate_literal_profile';
      observationBoundary: 'source_syntax';
      execution: 'not_observed';
    }>;
/** Unsupported interpretation is observable and cannot masquerade as an empty successful index. */
export function extractCodexSourceIndex(rawSource: string): CodexSourceIndex {
  try {
    return {
      disposition: 'indexed',
      rawSource,
      actions: extractCodexInnerActions(rawSource),
      observationBoundary: 'source_syntax',
      execution: 'not_observed',
    };
  } catch (error) {
    if (error instanceof UnsupportedCodexSurrogateLiteral)
      return {
        disposition: 'unsupported',
        rawSource,
        reason: 'surrogate_literal_profile',
        observationBoundary: 'source_syntax',
        execution: 'not_observed',
      };
    if (error instanceof UnsupportedCodexStringEscape)
      return {
        disposition: 'unsupported',
        rawSource,
        reason: 'named_unicode_escape',
        observationBoundary: 'source_syntax',
        execution: 'not_observed',
      };
    if (error instanceof UnsupportedCodexIdentifierProfile)
      return {
        disposition: 'unsupported',
        rawSource,
        reason: 'unicode_identifier_profile',
        observationBoundary: 'source_syntax',
        execution: 'not_observed',
      };
    throw error;
  }
}

export function codexOutputIsError(raw: string, decoded: string): boolean {
  const status = new RegExp('Process exited with code (' + PYTHON_DECIMAL_PATTERN + '+)', 'u').exec(
    raw
  );
  if (status && status[1] !== '0') return true;
  const lowered = pythonStrip(decoded || raw).toLowerCase();
  if (lowered.startsWith('script failed') || lowered.startsWith('tool failed')) return true;
  try {
    const value = parsePythonJson(raw),
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
  previous: CodexState
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
            : getMember(payload, 'input')
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
            is_error: codexOutputIsError(output, decodeStructuredTextPayload(output)),
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
