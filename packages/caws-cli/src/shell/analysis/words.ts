import type {
  ArithmeticExpression,
  ParameterExpansionPart,
  ParsedScript,
  Word,
  WordPart,
} from './parser-types';
import { projectionSensitiveBinding } from './policies';
import type { AnalysisContext, Argument, State } from './types';

interface Piece {
  text: string | null;
  split: boolean;
  descriptor?: true;
}
type Pieces = Piece[];
export type InspectSubstitution = (script: ParsedScript, state: State, depth: number) => void;
const LIMIT = 32;
const BRACE_LIMIT = 64;

/** A name an expansion assigns, rather than an assignment word or a builtin. */
function expansionAssigns(
  name: string,
  state: State,
  ctx: AnalysisContext,
  node: { pos: number; end: number }
): void {
  if (projectionSensitiveBinding(name))
    ctx.reason(node, 'environment-change', `Unmodeled shell environment change ${name}.`);
  state.bindings.set(name, null);
}
/** A value Bash would evaluate again, as an arithmetic or indirect reference. */
function reevaluates(values: readonly string[] | null | undefined): boolean {
  return values?.some((value) => /[$`[]/.test(value)) === true;
}

/** The words of a literal brace expansion, or null when it is not all literal. */
export function expandBraces(text: string): string[] | null {
  if (!/^\{[\w./,@%+:=^{}-]*\}$/.test(text)) return null;
  const body = text.slice(1, -1);
  const sequence =
    /^(?:(-?\d{1,9})\.\.(-?\d{1,9})|([a-zA-Z])\.\.([a-zA-Z]))(?:\.\.(-?\d{1,9}))?$/.exec(body);
  if (sequence) {
    const letters = sequence[3] !== undefined;
    // Bash pads every member to the width of a zero-padded edge.
    if (!letters && [sequence[1]!, sequence[2]!].some((edge) => /^-?0\d/.test(edge))) return null;
    const from = letters ? sequence[3]!.charCodeAt(0) : Number(sequence[1]);
    const to = letters ? sequence[4]!.charCodeAt(0) : Number(sequence[2]);
    const step = Math.abs(Number(sequence[5] ?? 1)) || 1;
    const count = Math.floor(Math.abs(to - from) / step) + 1;
    if (count > BRACE_LIMIT) return null;
    return Array.from({ length: count }, (_, index) => {
      const value = from + (to < from ? -1 : 1) * step * index;
      return letters ? String.fromCharCode(value) : String(value);
    });
  }
  const options: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index <= body.length; index++) {
    const character = body[index];
    if (character === '{') depth++;
    else if (character === '}') depth--;
    if (depth < 0) return null;
    if (character !== undefined && (character !== ',' || depth > 0)) continue;
    const option = body.slice(start, index);
    start = index + 1;
    const open = option.indexOf('{');
    if (open < 0) {
      options.push(option);
      continue;
    }
    let level = 0;
    let close = open;
    for (; close < option.length; close++) {
      if (option[close] === '{') level++;
      else if (option[close] === '}' && --level === 0) break;
    }
    const nested = close < option.length ? expandBraces(option.slice(open, close + 1)) : null;
    const rest = option.slice(close + 1);
    if (!nested || rest.includes('{')) return null;
    options.push(...nested.map((value) => option.slice(0, open) + value + rest));
  }
  return depth === 0 && options.length > 1 && options.length <= BRACE_LIMIT ? options : null;
}

/**
 * Visit the commands nested in an arithmetic expression. Arithmetic can assign,
 * so every name an assigning operator touches loses its value.
 */
export function inspectArithmetic(
  expression: ArithmeticExpression,
  state: State,
  ctx: AnalysisContext,
  inspect: InspectSubstitution,
  depth: number
): void {
  function forget(node: ArithmeticExpression): void {
    if (node.type !== 'ArithmeticWord') return;
    for (const [name] of node.value.matchAll(/[A-Za-z_][A-Za-z_0-9]*/g))
      expansionAssigns(name, state, ctx, node);
  }
  function visit(node: ArithmeticExpression): void {
    switch (node.type) {
      case 'ArithmeticBinary':
        // Plain assignment reads only its right side; the others read both.
        if (node.operator === '=') forget(node.left);
        visit(node.left);
        visit(node.right);
        if (/^(?:[-+*/%&|^]|<<|>>)=$/.test(node.operator)) forget(node.left);
        return;
      case 'ArithmeticUnary':
        visit(node.operand);
        if (node.operator === '++' || node.operator === '--') forget(node.operand);
        return;
      case 'ArithmeticTernary':
        visit(node.test);
        visit(node.consequent);
        visit(node.alternate);
        return;
      case 'ArithmeticGroup':
        visit(node.expression);
        return;
      case 'ArithmeticCommandExpansion':
        if (!node.script || node.script.source !== undefined)
          ctx.reason(
            node,
            'substitution-source',
            'Missing or decoded backtick source cannot preserve source coordinates.'
          );
        else inspect(node.script, state, depth + 1);
        return;
      case 'ArithmeticWord':
        // A name's value is itself an arithmetic expression, subscripts included.
        for (const [name] of node.value.matchAll(/[A-Za-z_][A-Za-z_0-9]*/g))
          if (reevaluates(state.bindings.get(name)))
            ctx.reason(
              node,
              'arithmetic-source',
              'Arithmetic evaluates source held in a variable, which is not read here.'
            );
        if (node.parts?.length)
          expandWord(
            {
              type: 'Word',
              text: node.value,
              value: node.value,
              pos: node.pos,
              end: node.end,
              parts: node.parts,
            },
            state,
            ctx,
            inspect,
            depth,
            true
          );
    }
  }
  visit(expression);
}

/** Abstract expansion only. Never call a shell or enumerate filesystem globs. */
export function expandWord(
  word: Word,
  state: State,
  ctx: AnalysisContext,
  inspect: InspectSubstitution,
  depth: number,
  assignment = false
): Argument[][] {
  const projection = ctx.projection !== undefined;
  // Brace expansion happens first and makes each alternative a word of its own.
  const brace =
    projection && !assignment
      ? (word.parts ?? []).findIndex((part) => part.type === 'BraceExpansion')
      : -1;
  if (brace >= 0) {
    const part = word.parts![brace]!;
    const options = expandBraces(part.text);
    if (options) {
      let combined: Argument[][] = [[]];
      for (const option of options) {
        const offset = part.pos - word.pos;
        const variants = expandWord(
          {
            ...word,
            text: word.text.slice(0, offset) + option + word.text.slice(offset + part.text.length),
            parts: word.parts!.map((item, index) =>
              index === brace
                ? { type: 'Literal', pos: part.pos, end: part.end, value: option, text: option }
                : item
            ),
          },
          state,
          ctx,
          inspect,
          depth
        );
        if (combined.length * variants.length > LIMIT) {
          ctx.reason(
            word,
            'pathname-expansion',
            'Expanded glob requires filesystem-dependent shell expansion.'
          );
          return [[{ value: null }]];
        }
        combined = combined.flatMap((left) => variants.map((right) => [...left, ...right]));
      }
      return combined;
    }
  }
  // Bash expands literal tilde prefixes before parameter expansion, including
  // assignment-shaped command arguments and colon-separated assignment values.
  // Inspect only unquoted literal source; quoted/escaped tildes remain data.
  const assignmentShape = assignment || /^[A-Za-z_][A-Za-z_0-9]*=/.test(word.text);
  const firstEquals = assignment ? -1 : word.text.indexOf('=');
  const literals = word.parts?.filter((part) => part.type === 'Literal') ?? [word];
  const tildeStart = word.text.startsWith('~');
  const tildeInside =
    assignmentShape &&
    literals.some((part) => {
      for (
        let index = part.text.indexOf('~');
        index >= 0;
        index = part.text.indexOf('~', index + 1)
      ) {
        const offset = part.pos - word.pos + index;
        if (offset === 0 && tildeStart) continue;
        if (offset === firstEquals + 1 || word.text[offset - 1] === ':') return true;
      }
      return false;
    });
  let home: string | null = null;
  if (tildeStart || tildeInside) {
    const values = state.bindings.get('HOME');
    if (
      projection &&
      !tildeInside &&
      /^~(?:\/|$)/.test(word.text) &&
      values?.length === 1 &&
      values[0]!.startsWith('/')
    )
      home = values[0]!;
    else if (!projection)
      ctx.reason(word, 'tilde-expansion', 'Home-directory expansion is not modeled.');
  }
  /** Expand for nested commands only; the resulting value is not used. */
  function visit(nested: Word | undefined): void {
    if (nested) expandWord(nested, state, ctx, inspect, depth, true);
  }
  /** A parameter operation's nested words are visited; most values stay unknown. */
  function parameter(part: ParameterExpansionPart, split: boolean): readonly (string | null)[] {
    const operation = part.operation;
    visit(part.index);
    // Every element or positional becomes a field of its own.
    const spread = [part.parameter, part.index?.value ?? ''];
    if (part.prefix !== '#' && (spread.includes('@') || (split && spread.includes('*'))))
      ctx.reason(
        part,
        'positional-spread',
        'Quoted positional spread does not have a proven argument count.'
      );
    if (part.prefix === '!' && reevaluates(state.bindings.get(part.parameter)))
      ctx.reason(
        part,
        'parameter-operation',
        'This parameter operation can run commands the projection cannot read.'
      );
    if (!operation) return [null];
    switch (operation.type) {
      case 'Default': {
        visit(operation.operand);
        const simple = !part.prefix && !part.index;
        const values = simple ? state.bindings.get(part.parameter) : null;
        if (operation.operator === '=' || operation.operator === ':=')
          expansionAssigns(part.parameter, state, ctx, part);
        // A value known to be present is the result of every default operator
        // except the alternate form, which selects the operand instead.
        if (
          values &&
          (operation.operator === ':-' || operation.operator === ':?') &&
          values.every((value) => value !== '')
        )
          return values;
        return [null];
      }
      case 'Remove':
        visit(operation.operand);
        return [null];
      case 'Replace':
        visit(operation.pattern);
        visit(operation.replacement);
        return [null];
      case 'Slice':
        visit(operation.offset);
        visit(operation.length);
        return [null];
      case 'CaseModification':
        visit(operation.operand);
        return [null];
      case 'Names':
        return [null];
      case 'Transform':
        visit(operation.operand);
        // Prompt transformation runs the substitutions held in the value.
        if (operation.operand.value !== 'P') return [null];
    }
    ctx.reason(
      part,
      'parameter-operation',
      'This parameter operation can run commands the projection cannot read.'
    );
    return [null];
  }
  function decoded(part: WordPart): void {
    ctx.reason(
      part,
      'substitution-source',
      'Missing or decoded backtick source cannot preserve source coordinates.'
    );
  }
  function parts(nodes: readonly WordPart[], quoted: boolean): Pieces[] {
    let acc: Pieces[] = [[]];
    for (const part of nodes) {
      let choices: Pieces[];
      const split = !quoted && !assignment;
      const opaque: Pieces[] = [[{ text: null, split }]];
      switch (part.type) {
        case 'Literal':
        case 'SingleQuoted':
          choices = [[{ text: part.value, split: false }]];
          break;
        case 'DoubleQuoted':
          choices = parts(part.parts, true);
          if (!part.parts.length) choices = [[{ text: '', split: false }]];
          break;
        case 'SimpleExpansion': {
          const name = part.text.slice(1);
          if (name === '@' || (projection && split && name === '*'))
            ctx.reason(
              part,
              'positional-spread',
              'Quoted positional spread does not have a proven argument count.'
            );
          const values = state.bindings.get(name) ?? null;
          choices = (values ?? [null]).map((text) => [{ text, split }]);
          break;
        }
        case 'ParameterExpansion': {
          if (
            part.prefix ||
            part.index ||
            part.operation ||
            !/^[A-Za-z_][A-Za-z_0-9]*$/.test(part.parameter)
          ) {
            if (projection) {
              choices = parameter(part, split).map((text) => [{ text, split }]);
              break;
            }
            ctx.reason(
              part,
              'parameter-operation',
              'Parameter operations are outside the admitted subset.'
            );
            choices = opaque;
          } else {
            const values = state.bindings.get(part.parameter) ?? null;
            choices = (values ?? [null]).map((text) => [{ text, split }]);
          }
          break;
        }
        case 'CommandExpansion':
          // ${ …; } runs in this shell, not in a subshell.
          if (projection && part.text.startsWith('${')) decoded(part);
          if (!part.script || part.script.source !== undefined) decoded(part);
          else inspect(part.script, state, depth + 1);
          // A proved reader's output remains opaque. In particular, it is not
          // executable source, an option, a script, or a path proof.
          choices = opaque;
          break;
        default:
          if (projection) {
            choices = [[{ text: null, split: false }]];
            if (part.type === 'ProcessSubstitution') {
              // The word names a descriptor, which like /dev/null is no file.
              choices = [[{ text: '/dev/null', split: false, descriptor: true }]];
              const nested = part.script;
              if (!nested || nested.source !== undefined) decoded(part);
              else inspect(nested, state, depth + 1);
            } else if (part.type === 'ArithmeticExpansion') {
              if (part.expression) inspectArithmetic(part.expression, state, ctx, inspect, depth);
              else
                ctx.reason(part, 'word-syntax', 'Arithmetic source could not be read completely.');
            } else if (part.type === 'LocaleString') {
              // Untranslated in the declared locale, this is a double-quoted string.
              choices = parts(part.parts, true);
              if (!part.parts.length) choices = [[{ text: '', split: false }]];
            } else if (part.type === 'AnsiCQuoted')
              choices = [[{ text: part.value, split: false }]];
            else {
              // Pathname and brace expansion change how many arguments exist.
              parts(part.parts ?? [], quoted);
              if (split)
                ctx.reason(
                  part,
                  'pathname-expansion',
                  'Expanded glob requires filesystem-dependent shell expansion.'
                );
            }
            break;
          }
          ctx.reason(part, 'word-syntax', `Unsupported expansion: ${part.type}.`);
          choices = opaque;
      }
      if (acc.length * choices.length > LIMIT) {
        if (!projection) {
          ctx.reason(word, 'value-budget', 'Word alternatives exceed the analysis budget.');
          return [[{ text: null, split: true }]];
        }
        // Later parts are still visited; only the combined value is forgotten.
        acc = [[]];
        choices = opaque;
      }
      acc = acc.flatMap((left) => choices.map((right) => [...left, ...right]));
    }
    return acc;
  }
  const variants = word.parts?.length
    ? parts(word.parts, false)
    : [[{ text: word.value, split: false }]];
  if (projection && (tildeStart || tildeInside)) {
    if (home === null) return [[{ value: null }]];
    for (const pieces of variants) {
      const first = pieces[0]!;
      pieces[0] = {
        ...first,
        text: first.text?.startsWith('~') ? home + first.text.slice(1) : null,
      };
    }
  }
  return variants.map((pieces) => {
    const fields: Argument[] = [];
    let current = '';
    let opaque = false;
    let present = false;
    const descriptor = pieces.some((piece) => piece.descriptor)
      ? { descriptor: true as const }
      : {};
    for (const piece of pieces) {
      if (piece.text === null) {
        opaque = true;
        present = true;
        if (piece.split)
          ctx.reason(
            word,
            'unknown-splitting',
            'Unquoted unknown expansion can change argument count and options.'
          );
        continue;
      }
      for (const ch of piece.text) {
        if (piece.split && /[ \t\n]/.test(ch)) {
          if (present) fields.push({ value: opaque ? null : current });
          current = '';
          opaque = false;
          present = false;
        } else {
          if (piece.split && /[*?\[]/.test(ch)) {
            ctx.reason(
              word,
              'pathname-expansion',
              'Expanded glob requires filesystem-dependent shell expansion.'
            );
            if (projection) opaque = true;
          }
          current += ch;
          present = true;
        }
      }
      if (!piece.split) present = true;
    }
    if (present) fields.push({ value: opaque ? null : current, ...descriptor });
    return fields;
  });
}
