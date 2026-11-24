import type {
  ArithmeticExpression,
  ParameterExpansionPart,
  ParsedScript,
  Word,
  WordPart,
} from './parser-types';
import type { AnalysisContext, Argument, State } from './types';

interface Piece {
  text: string | null;
  split: boolean;
}
type Pieces = Piece[];
export type InspectSubstitution = (script: ParsedScript, state: State, depth: number) => void;
const LIMIT = 32;

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
      state.bindings.set(name, null);
  }
  function visit(node: ArithmeticExpression): void {
    switch (node.type) {
      case 'ArithmeticBinary':
        if (/^(?:[-+*/%&|^]|<<|>>)?=$/.test(node.operator)) forget(node.left);
        visit(node.left);
        visit(node.right);
        return;
      case 'ArithmeticUnary':
        if (node.operator === '++' || node.operator === '--') forget(node.operand);
        visit(node.operand);
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
  function parameter(part: ParameterExpansionPart): readonly (string | null)[] {
    const operation = part.operation;
    visit(part.index);
    if (!operation) return [null];
    switch (operation.type) {
      case 'Default': {
        visit(operation.operand);
        const simple = !part.prefix && !part.index;
        const values = simple ? state.bindings.get(part.parameter) : null;
        if (operation.operator === '=' || operation.operator === ':=')
          state.bindings.set(part.parameter, null);
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
          if (name === '@')
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
              choices = parameter(part).map((text) => [{ text, split }]);
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
              choices = [[{ text: '/dev/null', split: false }]];
              const nested = part.script;
              if (!nested || nested.source !== undefined) decoded(part);
              else inspect(nested, state, depth + 1);
            } else if (part.type === 'ArithmeticExpansion') {
              if (part.expression) inspectArithmetic(part.expression, state, ctx, inspect, depth);
              else
                ctx.reason(part, 'word-syntax', 'Arithmetic source could not be read completely.');
            } else if (part.type === 'LocaleString') parts(part.parts, true);
            else if (part.type !== 'AnsiCQuoted') {
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
    if (present) fields.push({ value: opaque ? null : current });
    return fields;
  });
}
