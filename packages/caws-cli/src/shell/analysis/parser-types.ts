// Type-only bridge for the pinned ESM parser. The types come from the package's
// exported root entry; runtime loading stays in load-parser.js.
export type {
  ArithmeticExpression,
  Assignment,
  Command,
  ParameterExpansionPart,
  ParsedScript,
  PipelineNode,
  AndOr,
  Redirection,
  Statement,
  TestExpression,
  Word,
  WordPart,
} from 'unbash';
