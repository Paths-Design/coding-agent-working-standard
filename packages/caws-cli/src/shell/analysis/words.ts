import type { ParsedScript, Word, WordPart } from './parser-types';
import type { AnalysisContext, Argument, State } from './types';

interface Piece {
  text: string | null;
  split: boolean;
}
type Pieces = Piece[];
export type InspectSubstitution = (script: ParsedScript, state: State, depth: number) => void;
const LIMIT = 32;

/** Abstract expansion only. Never call a shell or enumerate filesystem globs. */
export function expandWord(
  word: Word,
  state: State,
  ctx: AnalysisContext,
  inspect: InspectSubstitution,
  depth: number,
  assignment = false
): Argument[][] {
  function parts(nodes: readonly WordPart[], quoted: boolean): Pieces[] {
    let acc: Pieces[] = [[]];
    for (const part of nodes) {
      let choices: Pieces[];
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
          choices = (values ?? [null]).map((text) => [{ text, split: !quoted && !assignment }]);
          break;
        }
        case 'ParameterExpansion': {
          if (
            part.prefix ||
            part.index ||
            part.operation ||
            !/^[A-Za-z_][A-Za-z_0-9]*$/.test(part.parameter)
          ) {
            ctx.reason(
              part,
              'parameter-operation',
              'Parameter operations are outside the admitted subset.'
            );
            choices = [[{ text: null, split: !quoted && !assignment }]];
          } else {
            const values = state.bindings.get(part.parameter) ?? null;
            choices = (values ?? [null]).map((text) => [{ text, split: !quoted && !assignment }]);
          }
          break;
        }
        case 'CommandExpansion':
          if (!part.script || part.script.source !== undefined) {
            ctx.reason(
              part,
              'substitution-source',
              'Missing or decoded backtick source cannot preserve source coordinates.'
            );
          } else inspect(part.script, state, depth + 1);
          // A proved reader's output remains opaque. In particular, it is not
          // executable source, an option, a script, or a path proof.
          choices = [[{ text: null, split: !quoted && !assignment }]];
          break;
        default:
          ctx.reason(part, 'word-syntax', `Unsupported expansion: ${part.type}.`);
          choices = [[{ text: null, split: !quoted && !assignment }]];
      }
      if (acc.length * choices.length > LIMIT) {
        ctx.reason(word, 'value-budget', 'Word alternatives exceed the analysis budget.');
        return [[{ text: null, split: true }]];
      }
      acc = acc.flatMap((left) => choices.map((right) => [...left, ...right]));
    }
    return acc;
  }
  const variants = word.parts?.length
    ? parts(word.parts, false)
    : [[{ text: word.value, split: false }]];
  if (!word.parts?.length && word.text.startsWith('~')) {
    ctx.reason(word, 'tilde-expansion', 'Home-directory expansion is not modeled.');
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
          if (piece.split && /[*?\[]/.test(ch))
            ctx.reason(
              word,
              'pathname-expansion',
              'Expanded glob requires filesystem-dependent shell expansion.'
            );
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
