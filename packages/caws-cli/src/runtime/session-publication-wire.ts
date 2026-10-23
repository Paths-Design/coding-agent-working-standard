/** Framing limits and correlation carry observations, never publication rights. */
import { createHash } from 'node:crypto';

export const SESSION_PUBLICATION_MARKER_NAME = '.session-publication.json';
export const SESSION_PUBLICATION_MARKER_SCHEMA = 'caws.session.publication.v1';
export const MAX_PUBLICATION_MARKER_BYTES = 2 * 1024 * 1024;
export const SESSION_SEAL_REQUEST_SCHEMA = 'caws.runtime.session-seal.request.v1';
export const SESSION_PUBLICATION_PREPARE_SCHEMA = 'caws.runtime.session-publication.prepare.v1';
export const SESSION_PUBLICATION_INPUTS_SCHEMA = 'caws.runtime.session-publication.inputs.v1';
export const SESSION_PUBLICATION_PREPARED_SCHEMA = 'caws.runtime.session-publication.prepared.v1';
export const SESSION_PUBLICATION_CHUNK_SCHEMA = 'caws.runtime.session-publication.chunk.v1';
export const SESSION_PUBLICATION_READY_SCHEMA = 'caws.runtime.session-publication.ready.v1';
export const SESSION_PUBLICATION_RESULT_SCHEMA = 'caws.runtime.session-publication.result.v1';
export const SESSION_PUBLICATION_CONSUMED_SCHEMA = 'caws.runtime.session-publication.consumed.v1';

// These bound this exchange profile. Exhaustion is unavailable, not truncation
// or a claim of unbounded legacy parity. Existing SQL row controls stay narrow.
export const MAX_PUBLICATION_CHUNK_BYTES = 64 * 1024;
export const MAX_PUBLICATION_ARTIFACT_BYTES = 64 * 1024 * 1024;
export const MAX_PUBLICATION_TOTAL_BYTES = 128 * 1024 * 1024;
export const MAX_PUBLICATION_ARTIFACTS = 4096;
export const MAX_PUBLICATION_SNAPSHOT_BYTES = 128 * 1024 * 1024;

export interface SessionOperationCorrelation {
  readonly id: string;
  readonly runtimeDigest: string;
  readonly token: string;
  /** Issued by the native owner for this live operation; not a reusable permit. */
  readonly attempt: string;
}
export type SessionPublicationKind = 'projection' | 'render' | 'seal';
export interface SessionPublicationDescriptor {
  /** A bounded relative alias. Only the native owner resolves its destination. */
  readonly name: string;
  readonly role: string;
  readonly byteLength: number;
  readonly sha256: string;
}
export interface SessionPublicationSnapshot {
  readonly observationId: string;
  readonly inputDigest: string;
  readonly sessionId: string;
  readonly reason: string;
  readonly endedAt: string;
  readonly files: readonly SessionPublicationDescriptor[];
  readonly priorInventory: readonly SessionPublicationDescriptor[];
}

export interface CommittedSessionSelection {
  readonly canonicalRoot: string;
  readonly sessionId: string;
  readonly correlation: SessionOperationCorrelation;
  readonly terminalDigest: string;
  readonly artifacts: readonly SessionPublicationDescriptor[];
}

/** The native owner's finite known-output namespace. Other session files are not outputs. */
export function sessionPublicationRole(name: string): string | undefined {
  if (name === '.meta.json') return 'metadata';
  if (name === 'store-projection.jsonl') return 'projection';
  if (name === 'session-index.json') return 'index';
  if (/^turn-[0-9]+\.payloads\.json$/.test(name)) return 'spill';
  if (/^turn-[0-9]+\.json$/.test(name)) return 'turn';
  return undefined;
}

function orderedCorrelation(value: SessionOperationCorrelation): SessionOperationCorrelation {
  return {
    id: value.id,
    runtimeDigest: value.runtimeDigest,
    token: value.token,
    attempt: value.attempt,
  };
}
function orderedArtifacts(
  values: readonly SessionPublicationDescriptor[]
): readonly SessionPublicationDescriptor[] {
  return values.map((value) => ({
    name: value.name,
    role: value.role,
    byteLength: value.byteLength,
    sha256: value.sha256,
  }));
}
export function sessionPublicationTerminalDigest(
  correlation: SessionOperationCorrelation,
  status: 'published' | 'not_published',
  artifacts: readonly SessionPublicationDescriptor[] = []
): string {
  const value =
    status === 'published'
      ? [orderedCorrelation(correlation), status, orderedArtifacts(artifacts)]
      : [orderedCorrelation(correlation), status];
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
/** Canonical native struct field order; neither paths nor authority come from marker bytes. */
export function sessionPublicationMarkerBytes(selection: CommittedSessionSelection): Buffer {
  return Buffer.from(
    JSON.stringify({
      schema: SESSION_PUBLICATION_MARKER_SCHEMA,
      canonicalRoot: selection.canonicalRoot,
      sessionId: selection.sessionId,
      correlation: orderedCorrelation(selection.correlation),
      terminalDigest: selection.terminalDigest,
      artifacts: orderedArtifacts(selection.artifacts),
    })
  );
}
