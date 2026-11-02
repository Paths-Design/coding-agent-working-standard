/** Historical Qwen row projection. Acquisition and first-match dispatch remain caller-owned. */
import {
  getMember,
  hasMember,
  isJsonObject,
  jsonObject,
  pythonJsonDumps,
  pythonTruthy,
  type JsonObject,
  type JsonValue,
} from './lossless-json';
import {
  parseTimestamp,
  pythonStrip,
  type CanonicalEvent,
  type LocatedEvent,
  type TranscriptAdapter,
} from './harness-common';
import { PYTHON_WHITESPACE_PATTERN } from './source-occurrence';
import { PYTHON_DECIMAL_PATTERN, UNICODE_PROFILE_ID } from './python-unicode-profile';

export const QWEN_ADAPTER_REVISION = `native-qwen/1;interpretation-profile:${UNICODE_PROFILE_ID};python-sha256:6d204c98df6a3dcfc5625f98f11a0645513987cc535e19b6368af4334e53b605`;
export const QWEN_TOOL_NAME_MAP: Readonly<Record<string, string>> = Object.freeze({
  write_file: 'Write',
  edit: 'Edit',
  read_file: 'Read',
  run_shell_command: 'Bash',
  glob: 'Glob',
  grep_search: 'Grep',
  notebook_edit: 'NotebookEdit',
  web_fetch: 'WebFetch',
  agent: 'Agent',
  skill: 'Skill',
  exit_plan_mode: 'ExitPlanMode',
});
const SYSTEM_NOISE_SUBTYPES: readonly string[] = Object.freeze([
  'ui_telemetry',
  'attribution_snapshot',
  'file_history_snapshot',
  'slash_command',
  'at_command',
]);

export class QwenProjectionError extends Error {
  readonly pythonType = 'TypeError';
  constructor(message: string) {
    super(message);
    this.name = 'QwenProjectionError';
  }
}
function hashable(value: JsonValue | undefined): void {
  if (Array.isArray(value)) throw new QwenProjectionError("unhashable type: 'list'");
  if (isJsonObject(value)) throw new QwenProjectionError("unhashable type: 'dict'");
}
function member(object: JsonValue | undefined, key: string, fallback: JsonValue = ''): JsonValue {
  const value = getMember(object, key);
  return value === undefined ? fallback : value;
}
function messageParts(row: JsonObject): readonly JsonValue[] {
  const parts = getMember(getMember(row, 'message'), 'parts');
  return Array.isArray(parts) ? parts : [];
}

/** Preserve the broad historical overlap: nonempty parts claims even an empty projection. */
export function matchesQwen(row: JsonObject): boolean {
  const kind = getMember(row, 'type');
  if (kind === 'tool_result') return true;
  // Python uses tuple membership here; unlike subtype set membership, a list
  // or dictionary type does not itself produce an unhashable-value failure.
  if (kind === 'user' || kind === 'assistant') return messageParts(row).length > 0;
  if (kind === 'system') {
    if (hasMember(row, 'systemPayload')) return true;
    const subtype = getMember(row, 'subtype');
    hashable(subtype);
    return typeof subtype === 'string' && SYSTEM_NOISE_SUBTYPES.includes(subtype);
  }
  return false;
}

const REFERENCED_CONTENT = new RegExp(
  '^Content from /[^' + PYTHON_WHITESPACE_PATTERN.slice(1, -1) + ']+',
  'u'
);
const SHOWING_LINES = new RegExp('^Showing lines ' + PYTHON_DECIMAL_PATTERN + '+', 'u');
function injectedContext(text: string): boolean {
  return (
    text.startsWith('--- Content from referenced files ---') ||
    text.startsWith('--- End of content ---') ||
    REFERENCED_CONTENT.test(text) ||
    SHOWING_LINES.test(text)
  );
}
/** The path identifies the emitting native part/child, not exclusive provenance
 * for fields also read from row-level timestamps, status or fallback call IDs.
 */
function located(event: CanonicalEvent, index: number, child?: string): LocatedEvent {
  return {
    event,
    nativeMemberPath: ['message', 'parts', index, ...(child === undefined ? [] : [child])],
  };
}

export function normalizeQwen(row: JsonObject): readonly LocatedEvent[] {
  const ts = parseTimestamp(getMember(row, 'timestamp'));
  const kind = getMember(row, 'type');
  const events: LocatedEvent[] = [];
  if (kind !== 'user' && kind !== 'assistant' && kind !== 'tool_result') return events;
  const parts = messageParts(row);
  const callResult = getMember(row, 'toolCallResult');
  const status = getMember(callResult, 'status');
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    if (!isJsonObject(part)) continue;
    if (kind === 'user') {
      const text = getMember(part, 'text');
      if (typeof text !== 'string' || !pythonStrip(text)) continue;
      if (injectedContext(pythonStrip(text))) continue;
      events.push(
        located(
          {
            ev:
              getMember(row, 'subtype') === 'mid_turn_user_message' ? 'interjection' : 'user_text',
            text,
            ts,
          },
          index
        )
      );
    } else if (kind === 'assistant') {
      const text = getMember(part, 'text');
      if (typeof text === 'string' && pythonStrip(text)) {
        events.push(
          located(
            {
              ev: 'assistant_text',
              text,
              ts,
              ...(getMember(part, 'thought') === true ? { thought: true } : {}),
            },
            index
          )
        );
        continue;
      }
      const call = getMember(part, 'functionCall');
      if (!isJsonObject(call)) continue;
      const suppliedName = getMember(call, 'name');
      const rawName = pythonTruthy(suppliedName) ? suppliedName! : '';
      hashable(rawName);
      const name =
        typeof rawName === 'string' && Object.hasOwn(QWEN_TOOL_NAME_MAP, rawName)
          ? QWEN_TOOL_NAME_MAP[rawName]!
          : rawName;
      const args = getMember(call, 'args');
      events.push(
        located(
          {
            ev: 'tool_use',
            name,
            id: member(call, 'id'),
            input: isJsonObject(args) ? args : jsonObject([]),
            ts,
          },
          index,
          'functionCall'
        )
      );
    } else {
      const response = getMember(part, 'functionResponse');
      if (!isJsonObject(response)) continue;
      const payload = getMember(response, 'response');
      const output = isJsonObject(payload) ? member(payload, 'output') : '';
      const id = member(response, 'id');
      events.push(
        located(
          {
            ev: 'tool_result',
            id: pythonTruthy(id) ? id : member(callResult, 'callId'),
            content:
              typeof output === 'string' ? output : pythonJsonDumps(output, { ensureAscii: false }),
            is_error: typeof status === 'string' && status !== 'success',
            ts,
          },
          index,
          'functionResponse'
        )
      );
    }
  }
  return events;
}

export const QWEN_ADAPTER: TranscriptAdapter<null> = Object.freeze({
  id: 'qwen-code',
  revision: QWEN_ADAPTER_REVISION,
  matches: matchesQwen,
  createState: () => null,
  cloneState: () => null,
  normalize: (row: JsonObject) => ({ state: null, events: normalizeQwen(row) }),
});
