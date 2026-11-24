import type { GitContextRequest, GitContextResolver } from './git-context';
import type { Command, PipelineNode, Redirection } from './parser-types';

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
  subcommand: string;
  input: GitContextRequest | null;
}
/**
 * Selects the write projection. Admission asks whether a program is proven safe
 * and holds whatever it has no profile for. Projection asks which writes the
 * source performs: every reachable command is visited, values and directories
 * that are not established stay unknown, and only a recognized write that
 * depends on one of them is held.
 */
export interface ProjectionMode {
  /** The enclosing shell's directory was not established. */
  cwdUnknown?: boolean;
  /** The enclosing shell's logical directory, when it is known. */
  logical?: string;
}
/** Trusted in-process instrumentation; never populated from submitted JSON. */
export interface AnalysisDependencies {
  /** Proven inherited scalar values for trusted nested-source consumers. */
  inheritedBindings?: ReadonlyMap<string, Value>;
  gitContext?: GitContextResolver;
  context?: { canonical: string; worktree: string };
  projection?: ProjectionMode;
  observers?: {
    gitMetadata?: (observation: GitMetadataObservation) => void;
    /** A program or option without an admission profile; projection mode only. */
    unprofiled?: (observation: { node: Location; code: string }) => void;
    /** An effect that can replace a repository mapping; projection mode only. */
    mapping?: (node: Location) => void;
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
  /** Projection only: the directory at this point is not established. */
  cwdUnknown?: boolean;
  /** Projection only: logical directory, which `cd ..` resolves against. */
  logical?: string;
  /** Projection only: an earlier effect can have replaced a Git mapping. */
  mappingChanged?: boolean;
  /** Projection only: known exit status, selecting the following && or || branch. */
  outcome?: 'success' | 'failure';
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
  projection?: ProjectionMode;
  /** Function bodies by name; a call visits every body defined under its name. */
  functions?: Map<string, PipelineNode[]>;
  /** The source's meaning is not established. Both modes consume this. */
  reason: (node: Location, code: string, message: string, deny?: boolean) => void;
  /** No admission profile covers this program or option. Projection ignores it. */
  admission: (node: Location, code: string, message: string, deny?: boolean) => void;
  mapping?: (node: Location) => void;
  trace: (node: Location, kind: string, detail: string) => void;
}
