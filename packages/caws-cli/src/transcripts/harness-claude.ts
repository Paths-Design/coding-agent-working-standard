/** Historical Claude projection. Raw occurrence custody belongs to the caller. */
import {
  getMember,
  isJsonNumber,
  isJsonObject,
  jsonNumber,
  jsonObject,
  pythonJsonDumps,
  pythonTruthy,
  type JsonObject,
  type JsonValue,
} from './lossless-json';
import {
  asBool,
  codepointOrder,
  parseHookStdout,
  parseTimestamp,
  pythonStrip,
  type CanonicalEvent,
  type LocatedEvent,
  type NormalizationContext,
  type TranscriptAdapter,
} from './harness-common';
import { PYTHON_WHITESPACE_PATTERN } from './source-occurrence';
import { pythonHtmlUnescape, PYTHON_HTML_PROFILE_ID } from './python-html';
import type { TranscriptJsonNumericProfile } from './transcript-json-profile';

export const CLAUDE_ADAPTER_REVISION = `native-claude/2;html-reference:${PYTHON_HTML_PROFILE_ID};html-decimal-policy:transcript-numeric-profile/1;python-sha256:c6d94da874c7af48c9dcb90e5f6fa53671bf04154f8a1b8e3c945e71c853026d`;
export const CLAUDE_NOISE_PREFIXES = Object.freeze([
  '<local-command',
  '<command-name',
  '<command-message',
  '<local-command-stdout',
  '<local-command-caveat',
  'This session is being continued',
  '<!-- copy-turn:',
  "This slash command's behavior is handled entirely by",
  'Operation stopped by hook:',
]);
export const STRINGIFIED_BOOL_INPUT_KEYS = Object.freeze(['run_in_background']);
export class ClaudeProjectionError extends Error {
  constructor(
    readonly pythonType: 'AttributeError' | 'TypeError' | 'ValueError' | 'OverflowError',
    message: string
  ) {
    super(message);
    this.name = 'ClaudeProjectionError';
  }
}
const member = (row: JsonObject, key: string, fallback: JsonValue = null): JsonValue =>
  getMember(row, key) ?? (getMember(row, key) === null ? null : fallback);
function mapping(value: JsonValue): JsonObject {
  if (!isJsonObject(value))
    throw new ClaudeProjectionError('AttributeError', "message has no attribute 'get'");
  return value;
}
function hashable(value: JsonValue | undefined): void {
  if (Array.isArray(value) || isJsonObject(value))
    throw new ClaudeProjectionError('TypeError', 'unhashable transcript type');
}
function numeric(value: JsonValue | undefined): value is JsonValue {
  return typeof value === 'boolean' || isJsonNumber(value);
}
function pythonInt(value: JsonValue): JsonValue {
  if (typeof value === 'boolean') return jsonNumber(value ? '1' : '0');
  if (!isJsonNumber(value)) throw new ClaudeProjectionError('TypeError', 'int requires a number');
  if (value.numberKind === 'integer') return value;
  const number = Number(value.lexeme);
  if (Number.isNaN(number))
    throw new ClaudeProjectionError('ValueError', 'cannot convert float NaN to integer');
  if (!Number.isFinite(number))
    throw new ClaudeProjectionError('OverflowError', 'cannot convert float infinity to integer');
  return jsonNumber(BigInt(Math.trunc(number)).toString());
}
function located(event: CanonicalEvent, ...nativeMemberPath: (string | number)[]): LocatedEvent {
  return { event, nativeMemberPath };
}
function lineage(row: JsonObject): { uuid?: string; parent_uuid?: string } {
  const uuid = getMember(row, 'uuid'),
    parent = getMember(row, 'parentUuid');
  return {
    ...(typeof uuid === 'string' && uuid ? { uuid } : {}),
    ...(typeof parent === 'string' && parent ? { parent_uuid: parent } : {}),
  };
}
export function extractTextFromContentBlocks(content: JsonValue | undefined): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const blocks: string[] = [];
  for (const item of content) {
    if (!isJsonObject(item)) continue;
    const text = getMember(item, 'text');
    if (typeof text === 'string' && pythonStrip(text)) {
      blocks.push(text);
      continue;
    }
    if (getMember(item, 'type') === 'json') {
      const value = getMember(item, 'json');
      if (value !== undefined && value !== null)
        blocks.push(pythonJsonDumps(value, { ensureAscii: false }));
    }
  }
  return blocks.join('\n\n');
}
export function extractToolResultContent(entry: JsonObject): JsonValue {
  const result = getMember(entry, 'tool_use_result');
  if (isJsonObject(result)) {
    const file = getMember(result, 'file');
    const content = getMember(file, 'content');
    if (typeof content === 'string' && pythonStrip(content)) return content;
    const text = getMember(result, 'text');
    if (typeof text === 'string' && pythonStrip(text)) return text;
  }
  const content = getMember(entry, 'content');
  const text = extractTextFromContentBlocks(content);
  if (pythonStrip(text)) return text;
  return pythonTruthy(content) ? content! : '';
}
export function claudeShellEvent(
  text: JsonValue,
  ts: string | null,
  numericProfile?: TranscriptJsonNumericProfile
): CanonicalEvent | null {
  if (typeof text !== 'string')
    throw new ClaudeProjectionError('AttributeError', "text has no attribute 'startswith'");
  if (text.startsWith('<bash-input>')) {
    const match = /<bash-input>([\s\S]*?)<\/bash-input>/u.exec(text);
    return {
      ev: 'user_shell',
      command: match ? pythonHtmlUnescape(match[1]!, numericProfile) : text,
      ts,
    };
  }
  if (text.startsWith('<bash-stdout>') || text.startsWith('<bash-stderr>')) {
    const stdout = /<bash-stdout>([\s\S]*?)<\/bash-stdout>/u.exec(text);
    const stderr = /<bash-stderr>([\s\S]*?)<\/bash-stderr>/u.exec(text);
    return {
      ev: 'user_shell',
      stdout: stdout ? pythonHtmlUnescape(stdout[1]!, numericProfile) : '',
      stderr: stderr ? pythonHtmlUnescape(stderr[1]!, numericProfile) : '',
      ts,
    };
  }
  return null;
}
const USER_WRAP = new RegExp(
  `^${PYTHON_WHITESPACE_PATTERN}*<user>([\\s\\S]*)</user>${PYTHON_WHITESPACE_PATTERN}*(?![\\s\\S])`,
  'u'
);
export function normalizeClaudeInterjection(text: string): string {
  const match = USER_WRAP.exec(text);
  return pythonStrip(match ? match[1]! : text);
}
export function matchesClaude(row: JsonObject): boolean {
  const kind = getMember(row, 'type');
  hashable(kind);
  return (
    typeof kind === 'string' &&
    [
      'user',
      'assistant',
      'attachment',
      'ai-title',
      'cost-state',
      'queue-operation',
      'system',
    ].includes(kind)
  );
}
function control(row: JsonObject, ts: string | null): CanonicalEvent | null {
  const kind = getMember(row, 'type');
  if (kind === 'ai-title') {
    const title = getMember(row, 'aiTitle');
    return typeof title === 'string' && pythonStrip(title)
      ? { ev: 'control', subtype: 'session_title', text: title, ts }
      : null;
  }
  if (kind === 'cost-state') {
    const event: CanonicalEvent = { ev: 'control', subtype: 'cost_state', ts };
    const fields: Record<string, JsonValue> = {};
    for (const [src, dst] of [
      ['totalCostUSD', 'cost_usd'],
      ['totalAPIDuration', 'api_duration_ms'],
      ['totalToolDuration', 'tool_duration_ms'],
      ['totalLinesAdded', 'lines_added'],
      ['totalLinesRemoved', 'lines_removed'],
    ] as const) {
      const value = getMember(row, src);
      if (numeric(value)) fields[dst] = value;
    }
    const models = getMember(row, 'modelUsage');
    if (isJsonObject(models) && models.entries.length)
      fields.models = models.entries.map(([key]) => key).sort(codepointOrder);
    return { ...event, ...fields };
  }
  if (kind === 'queue-operation') {
    const operation = getMember(row, 'operation');
    return typeof operation === 'string' && operation
      ? { ev: 'control', subtype: 'queue_operation', text: operation, ts }
      : null;
  }
  if (kind === 'system') {
    const subtype = getMember(row, 'subtype');
    if (subtype === 'turn_duration') {
      const duration = getMember(row, 'durationMs'),
        count = getMember(row, 'messageCount');
      return {
        ev: 'control',
        subtype: 'turn_duration',
        ts,
        ...(numeric(duration) ? { duration_ms: duration } : {}),
        ...(numeric(count) ? { message_count: pythonInt(count) } : {}),
      };
    }
    if (subtype === 'informational') {
      const text = getMember(row, 'content'),
        level = getMember(row, 'level');
      if (typeof text !== 'string' || !pythonStrip(text)) return null;
      return {
        ev: 'control',
        subtype: 'system_notice',
        text,
        ts,
        ...(typeof level === 'string' && level ? { level } : {}),
      };
    }
  }
  return null;
}
export function normalizeClaude(
  row: JsonObject,
  context?: NormalizationContext
): readonly LocatedEvent[] {
  const events: LocatedEvent[] = [],
    ts = parseTimestamp(getMember(row, 'timestamp')),
    kind = getMember(row, 'type');
  hashable(kind);
  if (
    typeof kind === 'string' &&
    ['ai-title', 'cost-state', 'queue-operation', 'system'].includes(kind)
  ) {
    const event = control(row, ts);
    return event ? [located(event)] : [];
  }
  if (kind === 'user') {
    const message = mapping(member(row, 'message', jsonObject([]))),
      content = getMember(message, 'content');
    if (typeof content === 'string')
      events.push(
        located(
          claudeShellEvent(content, ts, context?.numericProfile) ?? {
            ev: 'user_text',
            text: content,
            ts,
            ...lineage(row),
          },
          'message',
          'content'
        )
      );
    else if (Array.isArray(content))
      content.forEach((item, index) => {
        if (!isJsonObject(item)) return;
        if (getMember(item, 'type') === 'tool_result')
          events.push(
            located(
              {
                ev: 'tool_result',
                id: member(item, 'tool_use_id', ''),
                content: extractToolResultContent(item),
                tool_use_result: member(item, 'tool_use_result'),
                is_error: member(item, 'is_error', false),
                ts,
              },
              'message',
              'content',
              index
            )
          );
        else if (getMember(item, 'type') === 'text') {
          const text = member(item, 'text', '');
          events.push(
            located(
              claudeShellEvent(text, ts, context?.numericProfile) ?? {
                ev: 'user_text',
                text,
                ts,
                ...lineage(row),
              },
              'message',
              'content',
              index
            )
          );
        }
      });
  } else if (kind === 'assistant') {
    const message = mapping(member(row, 'message', jsonObject([]))),
      content = member(message, 'content', []);
    if (Array.isArray(content))
      content.forEach((item, index) => {
        if (!isJsonObject(item)) return;
        const type = getMember(item, 'type'),
          path = ['message', 'content', index] as const;
        if (type === 'text')
          events.push(
            located({ ev: 'assistant_text', text: member(item, 'text', ''), ts }, ...path)
          );
        else if (type === 'thinking') {
          const thinking = getMember(item, 'thinking'),
            fallback = getMember(item, 'text');
          const text = pythonTruthy(thinking) ? thinking : pythonTruthy(fallback) ? fallback : '';
          if (typeof text === 'string' && pythonStrip(text))
            events.push(located({ ev: 'reasoning', text, ts }, ...path));
        } else if (type === 'tool_use') {
          const rawInput = getMember(item, 'input');
          let input = isJsonObject(rawInput) ? rawInput : jsonObject([]);
          if (STRINGIFIED_BOOL_INPUT_KEYS.some((key) => typeof getMember(input, key) === 'string'))
            input = jsonObject(
              input.entries.map(([key, value]) => [
                key,
                STRINGIFIED_BOOL_INPUT_KEYS.includes(key) ? asBool(value)! : value,
              ])
            );
          events.push(
            located(
              {
                ev: 'tool_use',
                name: member(item, 'name', ''),
                id: member(item, 'id', ''),
                input,
                ts,
              },
              ...path
            )
          );
        }
      });
    const rawUsage = getMember(message, 'usage');
    const usage = isJsonObject(rawUsage)
      ? jsonObject(
          [
            'input_tokens',
            'output_tokens',
            'cache_read_input_tokens',
            'cache_creation_input_tokens',
          ].flatMap((key) => {
            const value = getMember(rawUsage, key);
            return numeric(value) ? [[key, value] as const] : [];
          })
        )
      : jsonObject([]);
    const model = getMember(message, 'model'),
      stop = getMember(message, 'stop_reason');
    if (usage.entries.length || pythonTruthy(model) || pythonTruthy(stop)) {
      const messageId = getMember(message, 'id'),
        requestId = getMember(row, 'requestId');
      events.push(
        located(
          {
            ev: 'assistant_meta',
            ts,
            ...(typeof messageId === 'string' && messageId ? { message_id: messageId } : {}),
            ...(typeof requestId === 'string' && requestId ? { request_id: requestId } : {}),
            ...(usage.entries.length ? { usage } : {}),
            ...(pythonTruthy(model) ? { model: model! } : {}),
            ...(pythonTruthy(stop) ? { stop_reason: stop! } : {}),
          },
          'message'
        )
      );
    }
  } else if (kind === 'attachment') {
    const attachment = getMember(row, 'attachment');
    if (typeof attachment === 'string') {
      if (attachment.includes("'queued_command'") && attachment.includes("'human'")) {
        const pattern = new RegExp(
          `'prompt':${PYTHON_WHITESPACE_PATTERN}*'([\\s\\S]*?)',${PYTHON_WHITESPACE_PATTERN}*'commandMode'`,
          'u'
        );
        const match = pattern.exec(attachment);
        if (match)
          events.push(
            located(
              { ev: 'interjection', text: normalizeClaudeInterjection(match[1]!), ts },
              'attachment'
            )
          );
      }
    } else if (isJsonObject(attachment) && getMember(attachment, 'type') === 'queued_command') {
      const origin = getMember(attachment, 'origin');
      if (isJsonObject(origin) && getMember(origin, 'kind') === 'human') {
        const raw = member(attachment, 'prompt', ''),
          prompt = typeof raw === 'string' ? raw : extractTextFromContentBlocks(raw);
        if (prompt && pythonStrip(prompt))
          events.push(
            located(
              { ev: 'interjection', text: normalizeClaudeInterjection(prompt), ts },
              'attachment'
            )
          );
      }
    } else if (isJsonObject(attachment) && getMember(attachment, 'type') === 'hook_success') {
      const hook = parseHookStdout(getMember(attachment, 'stdout'), context?.numericProfile);
      if (hook !== null) {
        const hookEvent = getMember(hook, 'hook_event');
        const fields = Object.fromEntries(hook.entries);
        events.push(
          located(
            {
              ...fields,
              ev: 'hook_context',
              hook_name: member(attachment, 'hookName'),
              hook_event: pythonTruthy(hookEvent) ? hookEvent! : member(attachment, 'hookEvent'),
              tool_use_id: member(attachment, 'toolUseID'),
              exit_code: member(attachment, 'exitCode'),
              duration_ms: member(attachment, 'durationMs'),
              ts,
            },
            'attachment'
          )
        );
      }
    }
  }
  return events;
}
export const CLAUDE_ADAPTER: TranscriptAdapter<null> = Object.freeze({
  id: 'claude',
  revision: CLAUDE_ADAPTER_REVISION,
  matches: matchesClaude,
  createState: () => null,
  cloneState: () => null,
  normalize: (row: JsonObject, _state: null, context?: NormalizationContext) => ({
    state: null,
    events: normalizeClaude(row, context),
  }),
});
