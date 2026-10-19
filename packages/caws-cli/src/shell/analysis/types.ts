import type { GitContextRequest, GitContextResolver } from './git-context';
import type { Command, Redirection } from './parser-types';

export interface AnalysisRequest {
  command: string;
  cwd: string;
  worktree: string;
  shell?: string;
}
export interface Span {
  start: number;
  end: number;
}
export interface AnalysisReason extends Span {
  code: string;
  message: string;
}
export interface AnalysisTrace extends Span {
  kind: string;
  detail: string;
}
export interface AnalysisResult {
  decision: 'allow' | 'deny' | 'unresolved';
  reasons: AnalysisReason[];
  trace: AnalysisTrace[];
}
export interface Argument {
  value: string | null;
  source?: Location;
}
export interface GitMetadataObservation {
  node: Location;
  subcommand: 'add' | 'commit';
  input: GitContextRequest | null;
}
/** Trusted in-process instrumentation; never populated from submitted JSON. */
export interface AnalysisDependencies {
  gitContext?: GitContextResolver;
  context?: { canonical: string; worktree: string };
  observers?: {
    gitMetadata?: (observation: GitMetadataObservation) => void;
    invocation?: (observation: {
      node: Command;
      argv: Argument[];
      state: State;
      environment: Map<string, Value>;
      reader: boolean;
    }) => void;
    redirection?: (observation: {
      node: Redirection;
      targets: Argument[][];
      state: State;
      reader: boolean;
    }) => void;
  };
}
export type Value = readonly string[] | null;
export interface State {
  bindings: Map<string, Value>;
  cwd: string;
  filesystemChanged?: boolean;
}
export interface Location {
  pos: number;
  end: number;
}
export interface AnalysisContext {
  result: AnalysisResult;
  worktree: string;
  canonical: string;
  outside: boolean;
  visits: number;
  gitInvocations: Location[];
  gitContext: GitContextResolver;
  gitMetadata?: (observation: GitMetadataObservation) => void;
  reason: (node: Location, code: string, message: string, deny?: boolean) => void;
  trace: (node: Location, kind: string, detail: string) => void;
}
