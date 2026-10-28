import { loadParser } from './load-parser';
import type { Word, WordPart } from './parser-types';
import { isInspectionInvocation } from './inspection-profiles';

export const INSPECTION_PREFIX_LIMITS = Object.freeze({
  bytes: 32768,
  commands: 64,
  nodes: 4096,
  depth: 64,
  wallMs: 2000,
});
export type InspectionPrefixStatus = 0 | 1 | 2;
export const INSPECTION_PREFIX_ALLOW = 'caws.inspection-prefix.v1:allow\n';

/** Pure syntax/argument-role predicate; never executes or composes authority.
 * Normal executable lookup and trusted Git configuration are caller assumptions.
 */
export async function classifyInspectionPrefix(source: string): Promise<InspectionPrefixStatus> {
  if (Buffer.byteLength(source, 'utf8') > INSPECTION_PREFIX_LIMITS.bytes || source.includes('\0'))
    return 2;
  if (source.includes(String.fromCharCode(92, 10)) || source.includes('\r')) return 1;
  const tree = (await loadParser()).parse(source);
  if (tree.errors?.length) return 2;
  if (tree.shebang || !tree.commands.length) return 1;
  if (tree.commands.length > INSPECTION_PREFIX_LIMITS.commands) return 2;
  const queue: { value: unknown; depth: number }[] = [{ value: tree, depth: 0 }];
  let visits = 0;
  while (queue.length) {
    const { value, depth } = queue.pop()!;
    if (value === null || typeof value !== 'object') continue;
    if (++visits > INSPECTION_PREFIX_LIMITS.nodes || depth > INSPECTION_PREFIX_LIMITS.depth)
      return 2;
    // unbash Word.parts is a lazy prototype getter, not an enumerable field.
    // Count and bound that syntax too before literal classification uses it.
    const children = Object.values(value);
    if ((value as { type?: string }).type === 'Word') children.push((value as Word).parts);
    for (const child of children) {
      if (child !== null && typeof child === 'object')
        queue.push({ value: child, depth: depth + 1 });
    }
  }
  function part(value: WordPart): boolean {
    switch (value.type) {
      case 'Literal':
      case 'SingleQuoted':
        return true;
      case 'DoubleQuoted':
        return value.parts.every((child) => child.type === 'Literal');
      default:
        return false;
    }
  }
  function literal(word: Word): boolean {
    return (
      !word.text.startsWith('~') && !word.text.includes('\n') && (word.parts?.every(part) ?? true)
    );
  }
  let cursor = 0;
  for (const statement of tree.commands) {
    const command = statement.command;
    if (
      statement.background ||
      command.type !== 'Command' ||
      !command.name ||
      command.prefix.length ||
      command.suffix.some((word) => word.type !== 'Word')
    )
      return 1;
    const gap = source.slice(cursor, command.pos);
    if (
      !/^[ \t\n]*$/.test(gap) ||
      (cursor > 0 && !gap.includes('\n')) ||
      source.slice(command.pos, command.end).includes('\n')
    )
      return 1;
    const words = [command.name, ...(command.suffix as Word[])];
    if (!words.every(literal) || !isInspectionInvocation(words.map((word) => word.value))) return 1;
    cursor = command.end;
  }
  return /^[ \t\n]*$/.test(source.slice(cursor)) ? 0 : 1;
}
