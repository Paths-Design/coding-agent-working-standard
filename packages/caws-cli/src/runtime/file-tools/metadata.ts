import type { JsonSource } from '../json-custody';
import { originalNativeFileOperation, readQwenOriginalWrite } from './original-operation';

export const FILE_TOOL_CONTEXT_CAPABILITY = 'caws.runtime.file-tool-context.v1';
export const GUARD_STRIKES_CAPABILITY = 'caws.runtime.guard-strikes.v1';
export const FILE_TOOL_CONTEXT_V2_CAPABILITY = 'caws.runtime.file-tool-context.v2';
export const GUARD_STRIKES_V2_CAPABILITY = 'caws.runtime.guard-strikes.v2';

export interface FileToolBackendAdvertisements {
  readonly fileToolContext?:
    | typeof FILE_TOOL_CONTEXT_CAPABILITY
    | typeof FILE_TOOL_CONTEXT_V2_CAPABILITY;
  readonly guardStrikes?: typeof GUARD_STRIKES_CAPABILITY | typeof GUARD_STRIKES_V2_CAPABILITY;
}
type Refuse = (reason: string) => never;

export function requestsNativeFileBackend(capabilities: FileToolBackendAdvertisements): boolean {
  return (
    capabilities.fileToolContext === FILE_TOOL_CONTEXT_V2_CAPABILITY ||
    capabilities.guardStrikes === GUARD_STRIKES_V2_CAPABILITY
  );
}

/** These are transport offers, not admission of a compiled stock guard profile. */
export function readFileToolBackendAdvertisements(
  value: Record<string, unknown>,
  refuse: Refuse
): FileToolBackendAdvertisements {
  if (
    Object.hasOwn(value, 'fileToolContext') &&
    value.fileToolContext !== FILE_TOOL_CONTEXT_CAPABILITY &&
    value.fileToolContext !== FILE_TOOL_CONTEXT_V2_CAPABILITY
  )
    refuse('Unsupported file-tool context capability');
  if (
    Object.hasOwn(value, 'guardStrikes') &&
    value.guardStrikes !== GUARD_STRIKES_CAPABILITY &&
    value.guardStrikes !== GUARD_STRIKES_V2_CAPABILITY
  )
    refuse('Unsupported guard-strikes capability');
  return Object.freeze({
    ...(value.fileToolContext === FILE_TOOL_CONTEXT_CAPABILITY ||
    value.fileToolContext === FILE_TOOL_CONTEXT_V2_CAPABILITY
      ? { fileToolContext: value.fileToolContext }
      : {}),
    ...(value.guardStrikes === GUARD_STRIKES_CAPABILITY ||
    value.guardStrikes === GUARD_STRIKES_V2_CAPABILITY
      ? { guardStrikes: value.guardStrikes }
      : {}),
  });
}

/** Input grammar and structural bounds are checked before this root-selector scan. */
function assertUniqueOriginalToolSelector(source: JsonSource, refuse: Refuse): void {
  let depth = 0;
  let seen = false;
  for (let cursor = source.root.start; cursor < source.root.end; cursor++) {
    const char = source.text[cursor];
    if (char === '"') {
      const start = cursor++;
      for (; cursor < source.root.end; cursor++) {
        if (source.text[cursor] === '\\') cursor++;
        else if (source.text[cursor] === '"') break;
      }
      if (depth === 1) {
        let next = cursor + 1;
        while (/[ \t\r\n]/.test(source.text[next] ?? '')) next++;
        if (
          source.text[next] === ':' &&
          JSON.parse(source.text.slice(start, cursor + 1)) === 'tool_name'
        ) {
          if (seen) refuse('Duplicate original tool_name selector');
          seen = true;
        }
      }
    } else if (char === '{' || char === '[') depth++;
    else if (char === '}' || char === ']') depth--;
  }
}

export function assertFileToolBackendSelection(
  capabilities: FileToolBackendAdvertisements,
  envelope: Record<string, unknown>,
  payload: Record<string, unknown>,
  source: JsonSource,
  refuse: Refuse
): void {
  if (!requestsNativeFileBackend(capabilities)) return;
  if (
    capabilities.fileToolContext !== FILE_TOOL_CONTEXT_V2_CAPABILITY ||
    capabilities.guardStrikes !== GUARD_STRIKES_V2_CAPABILITY ||
    envelope.event !== 'pre_tool_use' ||
    envelope.configuration !== 'system' ||
    typeof payload.tool_name !== 'string' ||
    originalNativeFileOperation(envelope.surface, payload.tool_name) === null
  )
    refuse(
      'Unpaired or ineligible ' +
        (envelope.surface === 'qwen-code' ? 'Qwen' : 'Claude') +
        ' file backend capabilities'
    );
  assertUniqueOriginalToolSelector(source, refuse);
  if (envelope.surface === 'qwen-code') {
    try {
      readQwenOriginalWrite(source.text.slice(source.root.start, source.root.end), payload);
    } catch (error) {
      refuse(String(error));
    }
  }
}
