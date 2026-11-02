/** Original Codex file-tool inventory. This projection never replaces the raw request. */
export interface CodexFileTool {
  readonly originalTool: 'apply_patch' | 'Write' | 'Edit';
  readonly normalizedTool: 'Write' | 'Edit';
  readonly targets: readonly string[];
  readonly patch?: string;
  readonly authoredContent?: string;
}

export class InvalidFileToolInventory extends Error {
  constructor(reason: string) {
    super('Invalid original file-tool inventory: ' + reason);
    this.name = 'InvalidFileToolInventory';
  }
}

function invalid(reason: string): never {
  throw new InvalidFileToolInventory(reason);
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function target(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.trim() !== value ||
    [...value].some((character) => character !== ' ' && /[\p{C}\p{Z}]/u.test(character))
  )
    invalid('empty or unrepresentable target path');
  return value;
}

/** Follow the original scope guard's complete grammar, including both move operands.
 * Diff-prefixed metadata-looking text is authored content, never a target header.
 */
function patchTargets(patch: string): { targets: readonly string[]; tool: 'Write' | 'Edit' } {
  const lines = patch
    .trim()
    .split('\n')
    .map((line) => line.replace(/\r$/, ''));
  if (lines.length < 3 || lines[0] !== '*** Begin Patch' || lines.at(-1) !== '*** End Patch')
    invalid('missing patch boundaries or empty inventory');
  const headers = ['*** Add File: ', '*** Update File: ', '*** Delete File: '] as const;
  const paths: string[] = [];
  let tool: 'Write' | 'Edit' | undefined;
  let index = 1;
  const end = lines.length - 1;
  while (index < end) {
    const line = lines[index]!;
    const header = headers.find((prefix) => line.startsWith(prefix));
    if (!header) invalid('unsupported or misplaced patch metadata');
    paths.push(target(line.slice(header.length)));
    tool ??= header === headers[0] ? 'Write' : 'Edit';
    index++;
    if (header === headers[2]) continue;
    if (header === headers[0]) {
      while (index < end && !lines[index]!.startsWith('*** ')) {
        if (!lines[index]!.startsWith('+')) invalid('invalid Add content');
        index++;
      }
      continue;
    }
    if (index < end && lines[index]!.startsWith('*** Move to: ')) {
      paths.push(target(lines[index]!.slice('*** Move to: '.length)));
      index++;
    }
    let body = 0;
    let context = false;
    while (index < end && !headers.some((prefix) => lines[index]!.startsWith(prefix))) {
      const content = lines[index]!;
      if (content === '@@' || content.startsWith('@@ ')) {
        if (context && body === 0) invalid('empty update chunk');
        body = 0;
        context = true;
      } else if (content === '*** End of File') {
        if (body === 0) invalid('empty end-of-file chunk');
        index++;
        while (index < end && lines[index] === '') index++;
        break;
      } else if (content === '' || /^[ +-]/.test(content)) {
        body++;
      } else {
        invalid('invalid Update content or misplaced Move');
      }
      index++;
    }
    if (body === 0) invalid('empty Update section');
  }
  if (!paths.length || !tool) invalid('empty target inventory');
  return { targets: Object.freeze([...new Set(paths)]), tool };
}

/** Null identifies a different tool; a malformed recognized mutation throws. */
export function normalizeCodexFileTool(
  payload: Readonly<Record<string, unknown>>
): CodexFileTool | null {
  const originalTool = payload.tool_name;
  if (originalTool !== 'apply_patch' && originalTool !== 'Write' && originalTool !== 'Edit')
    return null;
  if (!object(payload.tool_input)) invalid('missing original tool input');
  const input = payload.tool_input;
  if (originalTool === 'apply_patch') {
    if (typeof input.command !== 'string') invalid('patch command must be text');
    const inventory = patchTargets(input.command);
    return Object.freeze({
      originalTool,
      normalizedTool: inventory.tool,
      targets: inventory.targets,
      patch: input.command,
    });
  }
  const path = target(input.file_path);
  const content = input.content ?? input.new_string;
  return Object.freeze({
    originalTool,
    normalizedTool: originalTool,
    targets: Object.freeze([path]),
    ...(typeof content === 'string' ? { authoredContent: content } : {}),
  });
}
