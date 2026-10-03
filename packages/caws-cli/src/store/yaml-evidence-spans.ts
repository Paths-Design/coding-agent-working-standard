// Locate evidence by parsed structure while retaining the original source.
// Never interpret physical lines inside a scalar as keys or sequence items.
import { load } from 'js-yaml';

interface NodeSpan {
  start: number;
  end: number;
  kind: string | null;
  value: unknown;
  children: NodeSpan[];
}

export interface EvidenceSpans {
  /** Undefined only when the parsed top-level mapping has no evidence key. */
  key?: { start: number; end: number };
  empty?: { start: number; end: number };
  entries: Array<{ id: string; start: number; end: number }>;
  indent: number;
  newline: string;
  append: number;
}

function lineStart(source: string, at: number): number {
  return source.lastIndexOf('\n', at - 1) + 1;
}

function lineEnd(source: string, at: number): number {
  const end = source.indexOf('\n', at);
  return end < 0 ? source.length : end + 1;
}

/** null means unsupported/ambiguous structure; callers must not guess spans.
 * Supports ordinary block evidence sequences, any consistent indentation,
 * quoted keys and scalars, block scalars and inline-empty sequences. Flow
 * mappings/sequences and aliases for evidence are refused without rewriting.
 */
export function evidenceSpans(source: string): EvidenceSpans | null {
  const stack: NodeSpan[] = [];
  let root: NodeSpan | undefined;
  try {
    load(source, {
      listener(event, state) {
        if (event === 'open') {
          const node: NodeSpan = {
            start: state.position,
            end: state.position,
            kind: null,
            value: undefined,
            children: [],
          };
          const parent = stack[stack.length - 1];
          if (parent) parent.children.push(node);
          else root = node;
          stack.push(node);
        } else {
          const node = stack.pop();
          if (!node) throw new Error('Unbalanced YAML parse events');
          node.end = Math.min(state.position, source.length);
          node.kind = state.kind;
          node.value = state.result;
          // The parser probes for another mapping key at a document end;
          // an empty, zero-width probe is not a key/value pair.
          if (node.kind === null && node.value === null && node.start === node.end) {
            const parent = stack[stack.length - 1];
            if (parent) parent.children.pop();
          }
        }
      },
    });
  } catch {
    return null;
  }
  if (!root || root.kind !== 'mapping' || root.children.length % 2 !== 0) return null;
  const result: EvidenceSpans = {
    entries: [],
    indent: 2,
    newline: source.includes('\r\n') ? '\r\n' : '\n',
    append: source.length,
  };
  let evidence: NodeSpan | undefined;
  let key: NodeSpan | undefined;
  for (let i = 0; i < root.children.length; i += 2) {
    const candidate = root.children[i]!;
    // Merged or aliased mappings can affect values outside the edited span.
    if (candidate.value === '<<') return null;
    if (candidate.value === 'evidence') {
      if (evidence) return null;
      key = candidate;
      evidence = root.children[i + 1];
    }
  }
  if (!key || !evidence) {
    // Append before an explicit document terminator, never after it.
    const rootEnd = Math.min(root.end, source.length);
    const endLine = lineStart(source, rootEnd);
    if (/^\.\.\.(?:\s|$)/.test(source.slice(endLine))) result.append = endLine;
    return result;
  }
  const keyStart = lineStart(source, key.start);
  if (!/^[ \t]*$/.test(source.slice(keyStart, key.start))) return null;
  if (keyStart !== key.start) return null; // top-level keys only
  result.key = { start: key.start, end: key.end };
  if (evidence.kind !== 'sequence' || !Array.isArray(evidence.value)) return null;
  const header = source.slice(key.end, lineEnd(source, key.end));
  if (evidence.value.length === 0) {
    // Preserve inline comments and the key's spelling when normalizing [].
    const match = /^:[ \t]*(\[[ \t]*\])(?=[ \t]*(?:#|\r?\n|$))/.exec(header);
    if (!match) return null;
    const start = key.end + header.indexOf('[');
    result.empty = { start, end: start + match[1]!.length };
    result.append = lineEnd(source, key.end);
    return result;
  }
  if (!/^:[ \t]*(?:#[^\r\n]*)?\r?\n$/.test(header)) return null;
  if (evidence.children.length !== evidence.value.length) return null;
  const ids = new Set<string>();
  for (const item of evidence.children) {
    if (item.kind !== 'mapping' || item.children.length === 0) return null;
    const value = item.value as Record<string, unknown>;
    if (typeof value.criterion_id !== 'string' || ids.has(value.criterion_id)) return null;
    ids.add(value.criterion_id);
    const start = lineStart(source, item.start);
    const prefix = source.slice(start, item.start);
    const dash = /^( *)- +$/.exec(prefix);
    if (!dash || source[item.start] === '{') return null;
    const indent = dash[1]!.length;
    if (result.entries.length && result.indent !== indent) return null;
    result.indent = indent;
    // Mapping close events may include separators/comments before the next
    // item. The last value's event bounds the owned content more narrowly.
    const last = item.children[item.children.length - 1]!;
    if (item.children.some((child, i) => i % 2 === 0 && child.value === '<<')) return null;
    // A block scalar can own trailing blank lines (|+). Keep those; only
    // exclude indentation on the next line that the parser has looked into.
    const lastLine = lineStart(source, last.end);
    const end = /^[ \t]*$/.test(source.slice(lastLine, last.end))
      ? lastLine
      : lineEnd(source, last.end);
    result.entries.push({ id: value.criterion_id, start, end });
  }
  result.append = result.entries[result.entries.length - 1]!.end;
  return result;
}
