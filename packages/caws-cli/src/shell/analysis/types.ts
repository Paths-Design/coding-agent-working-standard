import type { GitContextResolver } from './git-context';

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
  gitContext: GitContextResolver;
  reason: (node: Location, code: string, message: string, deny?: boolean) => void;
  trace: (node: Location, kind: string, detail: string) => void;
}
