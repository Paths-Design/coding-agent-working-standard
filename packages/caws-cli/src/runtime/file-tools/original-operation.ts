import { isAbsolute } from 'node:path';
import { parseJsonSource } from '../json-custody';

/** Original producer selection only; this discriminator grants no path permission. */
export type NativeFileSurface = 'claude-code' | 'qwen-code';
export type NativeFileOperation = 'write' | 'edit';

export function originalNativeFileOperation(
  surface: unknown,
  rawTool: unknown
): NativeFileOperation | null {
  if (surface === 'claude-code') {
    if (rawTool === 'Write') return 'write';
    if (rawTool === 'Edit') return 'edit';
  }
  if (surface === 'qwen-code' && rawTool === 'write_file') return 'write';
  return null;
}

export interface QwenOriginalWrite {
  readonly surface: 'qwen-code';
  readonly operation: 'write';
  readonly sessionId: string;
  readonly payload: Readonly<Record<string, unknown>>;
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const validText = (value: unknown): value is string =>
  typeof value === 'string' &&
  !value.includes('\0') &&
  Buffer.from(value, 'utf8').toString('utf8') === value;
function need(value: unknown, reason: string): asserts value {
  if (!value) throw new Error('Original Qwen Write refused: ' + reason);
}

/** Known selectors are unique; opaque extension duplicates/numerals stay raw. */
export function readQwenOriginalWrite(
  inputJson: string,
  projection?: Readonly<Record<string, unknown>>
): QwenOriginalWrite {
  parseJsonSource(inputJson);
  const payload: unknown = JSON.parse(inputJson);
  need(object(payload), 'callback must be an object');
  const rootFields = new Set([
    'session_id',
    'tool_name',
    'cwd',
    'tool_input',
    'permission_mode',
    'tool_use_id',
    'tool_call_id',
    'execution_workdir',
  ]);
  const inputFields = new Set(['file_path', 'content']);
  const rootSeen = new Set<string>();
  const inputSeen = new Set<string>();
  let depth = 0,
    rootKey = '',
    toolInput = false;
  for (let at = 0; at < inputJson.length; at++) {
    const character = inputJson[at];
    if (character === '"') {
      const start = at++;
      for (; at < inputJson.length; at++) {
        if (inputJson[at] === '\\') at++;
        else if (inputJson[at] === '"') break;
      }
      let next = at + 1;
      while (/[ \t\r\n]/.test(inputJson[next] ?? '')) next++;
      if (inputJson[next] !== ':') continue;
      const key = JSON.parse(inputJson.slice(start, at + 1)) as string;
      if (depth === 1) {
        rootKey = key;
        if (rootFields.has(key)) {
          need(!rootSeen.has(key), 'duplicate ' + key);
          rootSeen.add(key);
        }
      } else if (depth === 2 && toolInput && inputFields.has(key)) {
        need(!inputSeen.has(key), 'duplicate tool_input.' + key);
        inputSeen.add(key);
      }
    } else if (character === '{' || character === '[') {
      if (depth === 1) toolInput = rootKey === 'tool_input' && character === '{';
      depth++;
    } else if (character === '}' || character === ']') {
      if (depth === 2) toolInput = false;
      depth--;
    }
  }
  need(payload.tool_name === 'write_file', 'unsupported original tool');
  need(
    validText(payload.session_id) &&
      /^[A-Za-z0-9_.-]{1,128}$/.test(payload.session_id) &&
      !['unknown', '.', '..'].includes(payload.session_id),
    'original session unavailable'
  );
  need(
    !Object.hasOwn(payload, 'cwd') || (validText(payload.cwd) && isAbsolute(payload.cwd)),
    'invalid original cwd'
  );
  const input = payload.tool_input;
  need(
    object(input) &&
      Object.keys(input).length === 2 &&
      Object.hasOwn(input, 'file_path') &&
      Object.hasOwn(input, 'content'),
    'unsupported tool input'
  );
  need(
    validText(input.file_path) &&
      isAbsolute(input.file_path) &&
      input.file_path === input.file_path.trim(),
    'absolute stable original file_path required'
  );
  need(validText(input.content), 'original content must be text');
  if (projection) {
    const selectors = (value: Readonly<Record<string, unknown>>): string =>
      JSON.stringify([
        value.tool_name,
        value.session_id,
        Object.hasOwn(value, 'cwd'),
        value.cwd,
        value.permission_mode,
        value.tool_use_id,
        value.tool_call_id,
        object(value.tool_input)
          ? Object.entries(value.tool_input).sort(([a], [b]) => a.localeCompare(b))
          : null,
      ]);
    need(selectors(payload) === selectors(projection), 'original projection mismatch');
  }
  return Object.freeze({
    surface: 'qwen-code',
    operation: 'write',
    sessionId: payload.session_id,
    payload: Object.freeze({ ...payload, tool_input: Object.freeze({ ...input }) }),
  });
}
