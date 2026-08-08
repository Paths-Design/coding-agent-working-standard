// Structured Diagnostic envelope.
//
// Every refusal in the kernel must answer:
//   - what rule was violated?
//   - which authority surface owns the rule?
//   - what subject (file, path, spec id, event seq) caused it?
//   - what is the narrow admissible repair?
//
// This is the contract that makes refusals explainable to agents.

export type Severity = 'error' | 'warning' | 'info';

export type Authority =
  | 'kernel/spec'
  | 'kernel/policy'
  | 'kernel/scope'
  | 'kernel/evidence'
  | 'kernel/worktree'
  | 'kernel/waiver'
  | 'kernel/lifecycle'
  | 'kernel/diagnostics';

export interface Diagnostic {
  /** Stable rule identifier. Used by tests and agent-side handling. */
  rule: string;
  /** The authority surface that owns this rule. */
  authority: Authority;
  /** Human-readable message. Present-tense, declarative. */
  message: string;
  /** What caused the diagnostic. File path, spec id, event seq, etc. */
  subject?: string;
  /** Optional source location. */
  location?: { line?: number; column?: number; pointer?: string };
  /** The narrow admissible repair. Either a CLI command or a precise edit instruction. */
  narrowRepair?: string;
  /** Severity. Defaults to 'error' when omitted at construction. */
  severity?: Severity;
  /** Optional structured cause data for tooling. */
  data?: Record<string, unknown>;
}
