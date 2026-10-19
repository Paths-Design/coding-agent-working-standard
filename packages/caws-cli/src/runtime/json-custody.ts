/** JSON source spans keep extension numerals out of binary floating-point transport. */
type JsonNode =
  | { kind: 'object'; start: number; end: number; entries: Map<string, JsonNode> }
  | { kind: 'array'; start: number; end: number; items: JsonNode[] }
  | { kind: 'number'; start: number; end: number }
  | { kind: 'scalar'; start: number; end: number; value: string | boolean | null };

export interface JsonSource {
  readonly text: string;
  readonly root: JsonNode;
}

/** Grammar is checked before indexing; indexing adds bounded depth and node counts. */
export function parseJsonSource(text: string, maxDepth = 128, maxNodes = 100_000): JsonSource {
  JSON.parse(text);
  let cursor = 0;
  let nodes = 0;
  const space = (): void => {
    while (/[ \t\r\n]/.test(text[cursor] ?? '') && cursor < text.length) cursor++;
  };
  const stringEnd = (): void => {
    cursor++;
    while (cursor < text.length) {
      const char = text[cursor++]!;
      if (char === '\\') cursor++;
      else if (char === '"') return;
    }
  };
  const read = (depth: number): JsonNode => {
    if (++nodes > maxNodes || depth > maxDepth)
      throw new Error('Hook input exceeds structural limit');
    space();
    const start = cursor;
    const char = text[cursor];
    if (char === '{') {
      cursor++;
      space();
      const entries = new Map<string, JsonNode>();
      while (text[cursor] !== '}') {
        const keyStart = cursor;
        stringEnd();
        const key = JSON.parse(text.slice(keyStart, cursor)) as string;
        space();
        cursor++; // Colon: the complete source has already passed JSON grammar validation.
        entries.set(key, read(depth + 1)); // JSON object readers select the last duplicate key.
        space();
        if (text[cursor] !== ',') break;
        cursor++;
        space();
      }
      cursor++;
      return { kind: 'object', start, end: cursor, entries };
    }
    if (char === '[') {
      cursor++;
      space();
      const items: JsonNode[] = [];
      while (text[cursor] !== ']') {
        items.push(read(depth + 1));
        space();
        if (text[cursor] !== ',') break;
        cursor++;
      }
      cursor++;
      return { kind: 'array', start, end: cursor, items };
    }
    if (char === '"') stringEnd();
    else while (cursor < text.length && !/[ \t\r\n,\]}]/.test(text[cursor]!)) cursor++;
    if (char === '-' || (char !== undefined && /[0-9]/.test(char)))
      return { kind: 'number', start, end: cursor };
    return {
      kind: 'scalar',
      start,
      end: cursor,
      value: JSON.parse(text.slice(start, cursor)) as string | boolean | null,
    };
  };
  return { text, root: read(0) };
}

/** Key order and string escaping may differ; numeric tokens must remain exact. */
export function sameJsonSource(left: JsonSource, right: JsonSource): boolean {
  const pending: [JsonNode, JsonNode][] = [[left.root, right.root]];
  while (pending.length) {
    const [a, b] = pending.pop()!;
    if (a.kind !== b.kind) return false;
    if (a.kind === 'object' && b.kind === 'object') {
      if (a.entries.size !== b.entries.size) return false;
      for (const [key, child] of a.entries) {
        const other = b.entries.get(key);
        if (!other) return false;
        pending.push([child, other]);
      }
    } else if (a.kind === 'array' && b.kind === 'array') {
      if (a.items.length !== b.items.length) return false;
      for (let index = 0; index < a.items.length; index++)
        pending.push([a.items[index]!, b.items[index]!]);
    } else if (a.kind === 'number' && b.kind === 'number') {
      if (left.text.slice(a.start, a.end) !== right.text.slice(b.start, b.end)) return false;
    } else if (a.kind === 'scalar' && b.kind === 'scalar' && a.value !== b.value) return false;
  }
  return true;
}

export function objectMemberSource(source: JsonSource, key: string): JsonSource | undefined {
  const root = source.root.kind === 'object' ? source.root.entries.get(key) : undefined;
  return root ? { text: source.text, root } : undefined;
}

export function objectMemberJson(source: JsonSource, key: string): string {
  const member = objectMemberSource(source, key);
  return member?.root.kind === 'object'
    ? source.text.slice(member.root.start, member.root.end)
    : '{}';
}

/** Replace owned metadata while forwarding the original value tokens of every other field. */
export function enrichObjectJson(source: JsonSource, key: string, value: string): string {
  if (source.root.kind !== 'object') throw new Error('Hook input must be an object');
  const entries: string[] = [];
  for (const [name, node] of source.root.entries)
    if (name !== key)
      entries.push(JSON.stringify(name) + ':' + source.text.slice(node.start, node.end));
  entries.push(JSON.stringify(key) + ':' + JSON.stringify(value));
  return '{' + entries.join(',') + '}';
}
