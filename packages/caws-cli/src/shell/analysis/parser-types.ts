// Type-only bridge for the pinned ESM parser and the CLI's legacy Node module
// resolution. Keep this internal layout dependency confined to one adapter.
export type {
  Assignment,
  Command,
  ParsedScript,
  PipelineNode,
  AndOr,
  Redirection,
  Statement,
  Word,
  WordPart,
} from 'unbash/dist/types';
