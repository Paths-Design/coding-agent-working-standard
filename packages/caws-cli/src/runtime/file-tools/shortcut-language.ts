/**
 * Pure PreToolUse language evaluation for the original Claude tool.
 * The caller supplies authenticated, stable images and a canonical relative path.
 * A null preimage means witnessed absence; this module does not establish custody,
 * ownership, path permission, strike state, or permission to publish a result.
 */
export type NativeShortcutInput =
  | {
      readonly originalTool: 'Write';
      readonly relativePath: string;
      readonly content: string;
      readonly preimage: string | null;
    }
  | {
      readonly originalTool: 'Edit';
      readonly relativePath: string;
    };

export type NativeShortcutRule =
  | 'explicit-not-implemented'
  | 'incomplete-work'
  | 'deferred-work'
  | 'placeholder-stub';

export interface NativeShortcutHit {
  readonly kind: 'hit';
  readonly rule: NativeShortcutRule;
  /** One-based line in the complete proposed Write content. */
  readonly line: number;
  readonly excerpt: string;
}

export type NativeShortcutResult =
  | Readonly<{ kind: 'inactive'; reason: 'edit' | 'exempt' }>
  | Readonly<{ kind: 'clean' }>
  | NativeShortcutHit;

export const MAX_SHORTCUT_IMAGE_BYTES = 16 * 1024 * 1024;
export const MAX_SHORTCUT_IMAGE_LINES = 200_000;

export class NativeShortcutLanguageError extends Error {
  constructor(message: string) {
    super('Native shortcut language: ' + message);
    this.name = 'NativeShortcutLanguageError';
  }
}

function text(value: unknown, label: string, limit: number): asserts value is string {
  if (
    typeof value !== 'string' ||
    Buffer.byteLength(value, 'utf8') > limit ||
    value.includes('\0') ||
    Buffer.from(value, 'utf8').toString('utf8') !== value
  )
    throw new NativeShortcutLanguageError('invalid ' + label);
}

function imageLines(value: string, checkpoint: () => void): string[] {
  let count = 1;
  for (let at = value.indexOf('\n'); at !== -1; at = value.indexOf('\n', at + 1)) {
    if (++count > MAX_SHORTCUT_IMAGE_LINES)
      throw new NativeShortcutLanguageError('image line limit exceeded');
    if ((count & 1023) === 0) checkpoint();
  }
  checkpoint();
  return value.split('\n');
}

function exempt(file: string): boolean {
  const name = file.slice(file.lastIndexOf('/') + 1);
  return (
    /(?:^|\/)(?:node_modules|dist|build|coverage|\.next|out|vendor|tests|__tests__|test|fixtures)\//.test(
      file
    ) ||
    /\.(?:md|markdown|txt|lock|map)$/.test(name) ||
    /-lock\.json$/.test(name) ||
    name === 'package-lock.json' ||
    /\.(?:min|bundle)\.js$/.test(name) ||
    /\.(?:test|spec)\./.test(name)
  );
}

function quoteEnd(value: string, start: number, step: () => void): number {
  for (let at = start + 1; at < value.length; at++) {
    step();
    if (value[at] === '\\') at++;
    else if (value[at] === value[start]) return at + 1;
  }
  return -1;
}

/** Closed JS expression literals are data; division and comments remain code. */
function regularExpressionEnd(value: string, start: number, step: () => void): number {
  if (value[start] !== '/' || value[start + 1] === '/' || value[start + 1] === '*') return -1;
  const prefix = value.slice(0, start).trimEnd();
  if (
    prefix &&
    !/[=([{,:;!?&|+*%~^<>-]$/.test(prefix) &&
    !/\b(?:return|case|throw|yield|typeof|void|delete|instanceof|in|of|await)$/.test(prefix)
  )
    return -1;
  let characterClass = false;
  for (let at = start + 1; at < value.length; at++) {
    step();
    if (value[at] === '\\') at++;
    else if (value[at] === '[') characterClass = true;
    else if (value[at] === ']') characterClass = false;
    else if (value[at] === '/' && !characterClass) {
      let end = at + 1;
      while (end < value.length && /[A-Za-z0-9_$]/.test(value.charAt(end))) {
        step();
        end++;
      }
      const flags = value.slice(at + 1, end);
      if (
        !/^[dgimsuvy]*$/.test(flags) ||
        new Set(flags).size !== flags.length ||
        (flags.includes('u') && flags.includes('v'))
      )
        return -1;
      return end;
    }
  }
  return -1;
}

function stripLiterals(value: string, step: () => void, regexLanguage: boolean): string {
  const parts: string[] = [];
  let from = 0;
  for (let at = 0; at < value.length; at++) {
    step();
    const end = /['"`]/.test(value.charAt(at))
      ? quoteEnd(value, at, step)
      : regexLanguage
        ? regularExpressionEnd(value, at, step)
        : -1;
    if (end === -1) continue;
    parts.push(value.slice(from, at), value.charAt(at).repeat(2));
    from = end;
    at = end - 1;
  }
  parts.push(value.slice(from));
  return parts.join('');
}

type CommentKind = 'note' | 'doc';
interface CommentState {
  close: '*/' | '-->' | null;
  kind: CommentKind;
}

/** Lexer-lite: complete new-side context, including unchanged lines. */
function comments(
  value: string,
  state: CommentState,
  visit: (kind: CommentKind, body: string) => void,
  step: () => void,
  regexLanguage: boolean
): void {
  if (state.close === null) {
    const leading = /^[ \t]*(--(?=[ \t])|\*(?=[ \t]|$))/.exec(value);
    if (leading) {
      visit(leading[1] === '*' ? 'doc' : 'note', value.slice(leading[0].length));
      return;
    }
  }
  let at = 0;
  while (at < value.length) {
    step();
    if (state.close !== null) {
      const end = value.indexOf(state.close, at);
      visit(state.kind, value.slice(at, end === -1 ? value.length : end));
      if (end === -1) return;
      at = end + state.close.length;
      state.close = null;
      continue;
    }
    if (/['"`]/.test(value.charAt(at))) {
      const end = quoteEnd(value, at, step);
      if (end !== -1) {
        at = end;
        continue;
      }
    }
    if (regexLanguage && value[at] === '/') {
      const end = regularExpressionEnd(value, at, step);
      if (end !== -1) {
        at = end;
        continue;
      }
    }
    if (at !== 0 && !/[ \t{}();,]/.test(value.charAt(at - 1))) {
      at++;
      continue;
    }
    if (
      value.startsWith('//', at) ||
      (value[at] === '#' && (at + 1 === value.length || /[ \t]/.test(value.charAt(at + 1))))
    ) {
      visit('note', value.slice(at + (value[at] === '#' ? 1 : 2)));
      return;
    }
    if (value.startsWith('<!--', at)) {
      state.close = '-->';
      state.kind = 'note';
      at += 4;
    } else if (value.startsWith('/*', at)) {
      state.close = '*/';
      state.kind = value[at + 2] === '*' && value[at + 3] !== '/' ? 'doc' : 'note';
      at += 2;
    } else at++;
  }
}

function stripIds(value: string, includeTripleX: boolean): string {
  const markers = includeTripleX ? 'TODO|FIXME|XXX|HACK|TBD' : 'TODO|FIXME|HACK|TBD';
  return value
    .replace(new RegExp('[A-Z0-9][-_](' + markers + ')', 'g'), 'ID')
    .replace(new RegExp('(' + markers + ')[-_][A-Z0-9]', 'g'), 'ID');
}

const reference =
  /\b(?:the|a|an|this|that|these|those|its|our|their|your|my|no|any|some|each|avoid|instead of|without|of|todo|fixme|xxx|hack|tbd)$/i;

/** Suppress referenced nouns individually, never every match on their line. */
function active(value: string, pattern: RegExp, step: () => void): boolean {
  for (let match = pattern.exec(value); match; match = pattern.exec(value)) {
    let before = match.index;
    while (before > 0 && /\s/.test(value.charAt(before - 1))) {
      step();
      before--;
    }
    if (before === match.index || !reference.test(value.slice(Math.max(0, before - 16), before)))
      return true;
  }
  return false;
}

function placeholder(kind: CommentKind, value: string): boolean {
  return (
    (kind === 'note' && /^[^A-Za-z0-9]*placeholder[^A-Za-z0-9]*$/i.test(value)) ||
    /\b(?:(?:this|it|that|which)(?:'s|’s|\s+is)|just|temporary|temp|tmp|stub|dummy|fake)\s+(?:(?:just|only|merely)\s+)?(?:an?\s+)?placeholder(?:[^A-Za-z0-9_-]|$)/i.test(
      value
    ) ||
    /(?:^|[^A-Za-z0-9_:-])placeholder\s+(?:implementation|impl|logic|code|function|method|handler|body|stub|until|for now|pending)\b/i.test(
      value
    ) ||
    (/(?:^|[^A-Za-z0-9_:-])placeholder(?:[^A-Za-z0-9_-]|$)/i.test(value) &&
      /\b(?:for now|later|fill (?:it |this )?in|replace (?:this|it|me)|real implementation)\b/i.test(
        value
      ))
  );
}

function excerpt(value: string): string {
  let out = '';
  let count = 0;
  for (const character of value.trimStart()) {
    out += character;
    if (++count === 120) break;
  }
  return out;
}

export function evaluateNativeShortcutLanguage(
  input: NativeShortcutInput,
  checkpoint: () => void
): NativeShortcutResult {
  if (typeof checkpoint !== 'function')
    throw new NativeShortcutLanguageError('checkpoint required');
  checkpoint();
  if (!input || (input.originalTool !== 'Write' && input.originalTool !== 'Edit'))
    throw new NativeShortcutLanguageError('unsupported original tool');
  text(input.relativePath, 'relative path', 4096);
  if (
    input.relativePath.includes('\\') ||
    input.relativePath.split('/').some((part) => part === '' || part === '.' || part === '..')
  )
    throw new NativeShortcutLanguageError('noncanonical relative path');
  const done = (result: NativeShortcutResult): NativeShortcutResult => {
    checkpoint();
    return Object.freeze(result);
  };
  if (input.originalTool === 'Edit') return done({ kind: 'inactive', reason: 'edit' });
  text(input.content, 'content', MAX_SHORTCUT_IMAGE_BYTES);
  if (input.preimage !== null) text(input.preimage, 'preimage', MAX_SHORTCUT_IMAGE_BYTES);
  checkpoint();
  if (exempt(input.relativePath)) return done({ kind: 'inactive', reason: 'exempt' });
  const next = imageLines(input.content, checkpoint);
  const previous = input.preimage === null ? [] : imageLines(input.preimage, checkpoint);
  const retained = new Map<string, number>();
  for (const line of previous) {
    checkpoint();
    retained.set(line, (retained.get(line) ?? 0) + 1);
  }
  const winners: (NativeShortcutHit | undefined)[] = new Array(5);
  const rules = [
    'explicit-not-implemented',
    'incomplete-work',
    'incomplete-work',
    'deferred-work',
    'placeholder-stub',
  ] as const satisfies readonly NativeShortcutRule[];
  const state: CommentState = { close: null, kind: 'note' };
  const regexLanguage = /\.(?:[cm]?[jt]sx?)$/.test(input.relativePath);
  let ticks = 0;
  const step = (): void => {
    if (++ticks === 2048) {
      checkpoint();
      ticks = 0;
    }
  };
  for (let index = 0; index < next.length; index++) {
    checkpoint();
    const line = next[index]!;
    const count = retained.get(line) ?? 0;
    const authored = count === 0;
    if (count > 0) retained.set(line, count - 1);
    const save = (rank: 0 | 1 | 2 | 3 | 4): void => {
      if (!winners[rank])
        winners[rank] = Object.freeze({
          kind: 'hit',
          rule: rules[rank],
          line: index + 1,
          excerpt: excerpt(line),
        });
    };
    if (authored && /throw new Error\(["'`]not implemented/i.test(line)) save(0);
    comments(
      line,
      state,
      (kind, body) => {
        if (!authored) return;
        if (active(stripIds(body, true), /\b(?:TODO|FIXME|XXX|HACK|TBD)\b/gi, step)) save(1);
        if (placeholder(kind, body)) save(4);
      },
      step,
      regexLanguage
    );
    if (authored) {
      checkpoint();
      const code = stripIds(stripLiterals(line, step, regexLanguage), false);
      if (active(code, /\b(?:TODO|FIXME|HACK|TBD)\b/g, step)) save(2);
      if (active(line, /not implemented|implement later|coming soon/gi, step)) save(3);
    }
  }
  return done(winners.find((winner) => winner !== undefined) ?? { kind: 'clean' });
}
