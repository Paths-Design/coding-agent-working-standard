/** Framing limits and correlation carry observations, never publication rights. */
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
