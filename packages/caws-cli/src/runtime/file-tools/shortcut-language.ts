import type * as TypeScript from 'typescript';
import { createRequire } from 'node:module';

const parserRequire = createRequire(__filename);

/**
 * Pure PreToolUse language evaluation for a classified original file operation.
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

/** Non-JS profile only; JS-family data ranges come from the actual parser. */
function stripLiterals(value: string, step: () => void): string {
  const parts: string[] = [];
  let from = 0;
  for (let at = 0; at < value.length; at++) {
    step();
    const end = /['"`]/.test(value.charAt(at)) ? quoteEnd(value, at, step) : -1;
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

/** Non-JS lexer-lite, with complete new-side context including unchanged lines. */
function comments(
  value: string,
  state: CommentState,
  visit: (kind: CommentKind, body: string) => void,
  step: () => void
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

type SourceRange = readonly [number, number];
interface CommentRow {
  readonly kind: CommentKind;
  readonly body: string;
}
interface JavaScriptViews {
  readonly code: readonly string[];
  readonly deferred: readonly string[];
  readonly comments: ReadonlyMap<number, readonly CommentRow[]>;
  readonly explicit: ReadonlySet<number>;
}

/** Preserve UTF-16 offsets and every line separator while removing data. */
function maskRanges(value: string, ranges: SourceRange[], checkpoint: () => void): string {
  checkpoint();
  ranges.sort((left, right) => left[0] - right[0]);
  checkpoint();
  const pieces: string[] = [];
  let from = 0;
  for (const [start, end] of ranges) {
    checkpoint();
    if (start < from) throw new NativeShortcutLanguageError('overlapping parser ranges');
    pieces.push(value.slice(from, start));
    for (let at = start; at < end; at += 4096) {
      checkpoint();
      pieces.push(value.slice(at, Math.min(at + 4096, end)).replace(/[^\r\n\u2028\u2029]/g, ' '));
    }
    from = end;
  }
  pieces.push(value.slice(from));
  checkpoint();
  const result = pieces.join('');
  checkpoint();
  return result;
}

function validateRegex(compiler: typeof TypeScript, value: string, checkpoint: () => void): void {
  checkpoint();
  const scanner = compiler.createScanner(
    compiler.ScriptTarget.Latest,
    false,
    compiler.LanguageVariant.Standard,
    value,
    () => {
      throw new NativeShortcutLanguageError('invalid regular-expression data');
    }
  );
  const first = scanner.scan();
  if (first !== compiler.SyntaxKind.SlashToken && first !== compiler.SyntaxKind.SlashEqualsToken)
    throw new NativeShortcutLanguageError('invalid regular-expression range');
  // Pinned 5.9.2 runtime API: true requests pattern and flag diagnostics.
  const rescan = scanner.reScanSlashToken as unknown as (
    reportErrors: boolean
  ) => TypeScript.SyntaxKind;
  if (
    rescan.call(scanner, true) !== compiler.SyntaxKind.RegularExpressionLiteral ||
    scanner.isUnterminated() ||
    scanner.getTokenEnd() !== value.length ||
    scanner.scan() !== compiler.SyntaxKind.EndOfFileToken
  )
    throw new NativeShortcutLanguageError('invalid regular-expression range');
  checkpoint();
}

function javaScriptViews(
  file: string,
  value: string,
  lines: readonly string[],
  checkpoint: () => void
): JavaScriptViews {
  checkpoint();
  // Lazy import keeps non-JS and inactive operations out of this import closure.
  const compiler = parserRequire('typescript') as typeof TypeScript;
  checkpoint();
  if (compiler.version !== '5.9.2')
    throw new NativeShortcutLanguageError('unsupported parser version');
  const kind = /tsx$/.test(file)
    ? compiler.ScriptKind.TSX
    : /jsx$/.test(file)
      ? compiler.ScriptKind.JSX
      : /\.[cm]?ts$/.test(file)
        ? compiler.ScriptKind.TS
        : compiler.ScriptKind.JS;
  let source: TypeScript.SourceFile;
  try {
    source = compiler.createSourceFile(
      file,
      value,
      {
        languageVersion: compiler.ScriptTarget.Latest,
        jsDocParsingMode: compiler.JSDocParsingMode.ParseNone,
      },
      false,
      kind
    );
  } catch {
    throw new NativeShortcutLanguageError('JS-family parse unavailable');
  }
  checkpoint();
  if (
    !source ||
    source.kind !== compiler.SyntaxKind.SourceFile ||
    source.text !== value ||
    source.fileName !== file
  )
    throw new NativeShortcutLanguageError('invalid parser source');
  // Owned runtime property in pinned TypeScript 5.9.2; never infer success from
  // its absence or use the recovery AST after a reported parse error.
  const diagnostics = Object.getOwnPropertyDescriptor(source, 'parseDiagnostics');
  if (!diagnostics || !Object.hasOwn(diagnostics, 'value') || !Array.isArray(diagnostics.value))
    throw new NativeShortcutLanguageError('parser diagnostics unavailable');
  if (diagnostics.value.length !== 0)
    throw new NativeShortcutLanguageError('JS-family parse unavailable');

  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    checkpoint();
    starts.push(offset);
    offset += line.length + 1;
  }
  const checked = (start: number, end: number): SourceRange => {
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end < start ||
      end > value.length
    )
      throw new NativeShortcutLanguageError('invalid parser range');
    return [start, end];
  };
  const lineAt = (position: number): number => {
    checked(position, position);
    let low = 0;
    let high = starts.length;
    while (low + 1 < high) {
      const middle = (low + high) >>> 1;
      if (starts[middle]! <= position) low = middle;
      else high = middle;
    }
    return low;
  };
  const data: SourceRange[] = [];
  const explicit = new Set<number>();
  const unwrap = (input: TypeScript.Expression): TypeScript.Expression => {
    let expression = input;
    for (let depth = 0; depth < 4096; depth++) {
      checkpoint();
      checked(expression.pos, expression.end);
      if (
        compiler.isParenthesizedExpression(expression) ||
        compiler.isAsExpression(expression) ||
        compiler.isTypeAssertionExpression(expression) ||
        compiler.isNonNullExpression(expression) ||
        compiler.isSatisfiesExpression(expression)
      )
        expression = expression.expression;
      else return expression;
    }
    throw new NativeShortcutLanguageError('expression wrapper limit exceeded');
  };
  const pending: TypeScript.Node[] = [source];
  let scheduled = 1;
  while (pending.length) {
    checkpoint();
    const node = pending.pop()!;
    if (!Number.isInteger(node.kind) || node.kind < 0 || node.kind >= compiler.SyntaxKind.Count)
      throw new NativeShortcutLanguageError('invalid parser node');
    checked(node.pos, node.end);
    if (
      compiler.isStringLiteral(node) ||
      compiler.isRegularExpressionLiteral(node) ||
      compiler.isNoSubstitutionTemplateLiteral(node) ||
      compiler.isTemplateHead(node) ||
      compiler.isTemplateMiddle(node) ||
      compiler.isTemplateTail(node) ||
      compiler.isJsxText(node)
    ) {
      const literal = node as unknown as { text?: unknown; isUnterminated?: unknown };
      if (
        typeof literal.text !== 'string' ||
        (literal.isUnterminated !== undefined && literal.isUnterminated !== false)
      )
        throw new NativeShortcutLanguageError('invalid parser literal');
      // JSX text is data from its full start, even when it resembles a comment.
      const start = compiler.isJsxText(node) ? node.pos : node.getStart(source);
      const range = checked(start, node.end);
      if (compiler.isRegularExpressionLiteral(node))
        validateRegex(compiler, value.slice(range[0], range[1]), checkpoint);
      if (range[0] !== range[1]) data.push(range);
    }
    if (compiler.isThrowStatement(node)) {
      const expression = unwrap(node.expression);
      let callee: TypeScript.Expression | undefined;
      let argument: TypeScript.Expression | undefined = expression;
      if (compiler.isNewExpression(expression) || compiler.isCallExpression(expression)) {
        callee = unwrap(expression.expression);
        argument =
          compiler.isIdentifier(callee) && callee.text === 'Error'
            ? expression.arguments?.[0]
            : undefined;
      }
      if (argument) argument = unwrap(argument);
      const message =
        argument && compiler.isTemplateExpression(argument) ? argument.head : argument;
      if (
        message &&
        (compiler.isStringLiteral(message) ||
          compiler.isNoSubstitutionTemplateLiteral(message) ||
          compiler.isTemplateHead(message)) &&
        /^not implemented/i.test(message.text)
      ) {
        // Attribute the trigger, not arbitrary new comments or later arguments.
        for (const trigger of [node, expression, ...(callee ? [callee] : []), message])
          explicit.add(lineAt(trigger.getStart(source)));
      }
    }
    compiler.forEachChild(node, (child) => {
      checkpoint();
      if (++scheduled > 1_000_000)
        throw new NativeShortcutLanguageError('parser node limit exceeded');
      pending.push(child);
    });
  }
  const withoutData = maskRanges(value, data, checkpoint);
  const commentRanges: SourceRange[] = [];
  const rows = new Map<number, CommentRow[]>();
  const scanner = compiler.createScanner(
    compiler.ScriptTarget.Latest,
    false,
    compiler.LanguageVariant.Standard,
    withoutData,
    () => {
      throw new NativeShortcutLanguageError('masked source scan unavailable');
    }
  );
  for (;;) {
    checkpoint();
    const token = scanner.scan();
    const [start, end] = checked(scanner.getTokenStart(), scanner.getTokenEnd());
    if (token === compiler.SyntaxKind.EndOfFileToken) break;
    if (token === compiler.SyntaxKind.Unknown || scanner.isUnterminated())
      throw new NativeShortcutLanguageError('masked source scan unavailable');
    const block = token === compiler.SyntaxKind.MultiLineCommentTrivia;
    if (!block && token !== compiler.SyntaxKind.SingleLineCommentTrivia) continue;
    commentRanges.push([start, end]);
    const commentKind: CommentKind =
      block && value.startsWith('/**', start) && value[start + 3] !== '/' ? 'doc' : 'note';
    let line = lineAt(start + 2);
    for (const body of value.slice(start + 2, block ? end - 2 : end).split('\n')) {
      checkpoint();
      const existing = rows.get(line) ?? [];
      existing.push({ kind: commentKind, body });
      rows.set(line++, existing);
    }
  }
  return {
    code: maskRanges(withoutData, commentRanges, checkpoint).split('\n'),
    deferred: withoutData.split('\n'),
    comments: rows,
    explicit,
  };
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
  const javascript = /\.(?:[cm]?[jt]sx?)$/.test(input.relativePath)
    ? javaScriptViews(input.relativePath, input.content, next, checkpoint)
    : undefined;
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
    if (
      authored &&
      (javascript
        ? javascript.explicit.has(index)
        : /throw new Error\(["'`]not implemented/i.test(line))
    )
      save(0);
    const visit = (kind: CommentKind, body: string): void => {
      if (!authored) return;
      if (active(stripIds(body, true), /\b(?:TODO|FIXME|XXX|HACK|TBD)\b/gi, step)) save(1);
      if (placeholder(kind, body)) save(4);
    };
    if (javascript) {
      for (const row of javascript.comments.get(index) ?? []) visit(row.kind, row.body);
    } else comments(line, state, visit, step);
    if (authored) {
      checkpoint();
      const code = stripIds(
        javascript ? javascript.code[index]! : stripLiterals(line, step),
        false
      );
      if (active(code, /\b(?:TODO|FIXME|HACK|TBD)\b/g, step)) save(2);
      const deferred = javascript ? javascript.deferred[index]! : line;
      if (active(deferred, /not implemented|implement later|coming soon/gi, step)) save(3);
    }
  }
  return done(winners.find((winner) => winner !== undefined) ?? { kind: 'clean' });
}
