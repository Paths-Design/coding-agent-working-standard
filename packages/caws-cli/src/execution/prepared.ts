/** Private producer record. Its shape alone establishes neither provenance nor permission. */
export interface ProgramImage {
  readonly path: string;
  readonly sha256: string;
}

export interface PreparedExecutionV1 {
  readonly schema: 'caws.execution.prepared.v1';
  readonly invocationId: string;
  readonly association: {
    readonly kind: 'codex-mcp-v1';
    /** Native lineage, current thread and call remain distinct identities. */
    readonly sessionId: string;
    readonly threadId: string;
    readonly callId: string;
    /** Negotiated native caller-context local.cwd; never the model or server cwd. */
    readonly callerAnchor: string;
    readonly serverEnvironmentId: string;
  };
  /** Independently re-derived from callerAnchor before authority evaluation. */
  readonly projectRoot: string;
  readonly execution: {
    readonly executable: ProgramImage;
    /** Full effective argv, including argv[0]. */
    readonly argv: readonly string[];
    readonly cwd: string;
    /** Complete final environment, sorted by UTF-8 name bytes, without duplicates. */
    readonly environment: readonly { readonly name: string; readonly value: string }[];
    readonly stdinBase64: string;
  };
  readonly profile: {
    readonly kind: 'bash-clean-v1' | 'caws-evidence-v1' | 'caws-lifecycle-v1' | 'npm-test-v1';
    readonly source: string;
    /** Captured utility images; a manifest entry does not admit arbitrary programs. */
    readonly utilities: readonly ProgramImage[];
    /** Exact npm route; present only for npm-test-v1. */
    readonly npm?: {
      readonly runtime: {
        readonly node: ProgramImage;
        readonly entry: ProgramImage;
        readonly root: string;
        readonly generationManifestSha256: string;
      };
      readonly project: {
        readonly packageJson: ProgramImage;
        readonly npmrc: ProgramImage | null;
        readonly testScript: string;
        readonly pathShadowSha256: string;
      };
    };
  };
  readonly sandbox: {
    /** Original opaque state bytes, including unknown policy fields. */
    readonly stateBase64: string;
    readonly stateSha256: string;
    readonly launcher: ProgramImage;
    /** Actual sandbox/server anchor, independent of callerAnchor and execution.cwd. */
    readonly environmentAnchor: string;
    /** Producer-created private roots bound to the host manifest; npm only. */
    readonly writeCeiling?: {
      readonly schema: 'caws.execution.write-ceiling.v1';
      readonly launchId: string;
      readonly invocationRoot: string;
      readonly outputRoot: string;
      readonly tmpRoot: string;
      readonly cacheRoot: string;
      readonly manifestSha256: string;
    };
  };
  readonly limits: {
    /** Correlation only. The Rust owner retains the original monotonic preparation deadline. */
    readonly preparationDeadlineUnixMs: number;
    readonly jobTimeoutMs: number;
    readonly terminationGraceMs: number;
    readonly maxOutputBytes: number;
  };
}

export const EXECUTION_REASON_CODES = [
  'invalid_frame',
  'invalid_record',
  'identity_unverified',
  'context_unresolved',
  'unsupported_profile',
  'source_unresolved',
  'source_denied',
  'binding_unavailable',
  'foreign_owner',
  'scope_refused',
  'authority_changed',
  'fence_unverified',
  'deadline_expired',
  'cancelled',
  'infrastructure_unavailable',
] as const;
export type ExecutionReasonCode = (typeof EXECUTION_REASON_CODES)[number];
export type AuthorizerPhase = 'analyze' | 'final_validate';
export interface FenceObservation {
  readonly dev: string;
  readonly ino: string;
  readonly nonce: string;
}
export interface AuthorizerRequest {
  readonly protocol: 'caws.execution.authorizer.v1';
  readonly phase: AuthorizerPhase;
  readonly invocationId: string;
  readonly recordBase64: string;
  readonly executionDigest: string;
  readonly expectedAuthorityRevision: string | null;
  readonly fence: FenceObservation | null;
}
/** Observation only; the private Rust final-launch owner consumes no public permit. */
export interface AuthorizerReply {
  readonly protocol: 'caws.execution.authorizer.v1';
  readonly phase: AuthorizerPhase;
  readonly invocationId: string;
  readonly executionDigest: string;
  readonly decision: 'allow' | 'deny' | 'unresolved';
  readonly authorityRevision: string | null;
  readonly reasonCodes: readonly ExecutionReasonCode[];
}
