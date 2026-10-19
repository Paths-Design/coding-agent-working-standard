export type Decision = 'allow' | 'ask' | 'deny';
export type Enforcement = 'pass' | 'advisory' | 'confirm' | 'block';
export type Source =
  | 'unknown'
  | 'regex'
  | 'legacy_family'
  | 'rm_classifier'
  | 'find_delete'
  | 'commit_deletions'
  | 'capability'
  | 'classifier_error'
  | 'sidecar_error';
export interface Classification {
  decision: Decision;
  reason: string;
  source: Source;
  enforcement: Enforcement;
}
export type Finding = readonly [Decision, string];
export interface GitObservation {
  status: number;
  stdout: string;
}
/** Bounded effects are explicit so daemon requests cannot inherit another project's context. */
export interface ClassifierPorts {
  git(args: readonly string[], cwd: string): GitObservation;
  read(path: string): string | null;
  isFile(path: string): boolean;
  realpath(path: string): string;
  consumeFile(path: string): boolean;
}
export interface ClassifierContext {
  repoRoot: string;
  home: string;
  cwd: string;
  environment?: Readonly<Record<string, string>>;
  deadlineUnixMs?: number;
  ownerIdentities?: readonly string[];
  temporaryDirectory?: string;
  trustedInit?: { enabled: boolean; nonce: string; vendorDirectory: string };
  ports?: ClassifierPorts;
  traceFact?: (fact: Readonly<CommandFact>, segment: string) => void;
}
export interface CommandFact {
  executable: string;
  executablePath: string;
  argv: string[];
  wrappers: string[];
  subcommandPath: string[];
  flags: Set<string>;
  targets: string[];
  payload: string;
  parseConfidence: 'high' | 'partial' | 'low';
  kind: 'READ' | 'MUTATE' | 'DESTROY' | 'EXEC' | 'PRIV_ESC' | 'SECRETS_READ' | 'NONE';
  domain:
    | 'local'
    | 'remote_orchestrator'
    | 'cloud'
    | 'container'
    | 'iac'
    | 'http'
    | 'process'
    | 'filesystem'
    | 'unknown';
  scope: 'narrow' | 'broad' | 'prod' | 'unknown';
  reversibility: 'reversible' | 'partial' | 'irreversible' | 'unknown';
  opacity: 'literal' | 'opaque' | 'none';
  blastRadius: 'single' | 'multi' | 'host' | 'cluster' | 'unknown';
  traceLabel: string;
}
