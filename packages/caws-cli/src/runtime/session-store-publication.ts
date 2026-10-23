/** SQL projection to publication adapter. No engine selection or native activation. */
import {
  encodeStoreProjectionEvents,
  type StoreProjectionLimits,
} from '../transcripts/store-projection';
import {
  reconstructNativeTranscriptStore,
  type NativeTranscriptStorePublicationPort,
} from './transcript-store-client';
import {
  type SessionPublicationInput,
  type SessionPublicationPreparation,
  type SessionPublicationReceipt,
} from './session-publication-client';
import { createSessionLogPublicationConsumer } from './session-log';
import { MAX_PUBLICATION_ARTIFACT_BYTES } from './session-publication-wire';
import { RuntimeProtocolError } from './protocol';
import {
  STORE_JSON_PROFILE,
  snapshotStoreJsonProfile,
  type StoreJsonProfile,
} from '../transcripts/store-json';

export interface SessionStorePublicationOptions {
  readonly port: NativeTranscriptStorePublicationPort;
  readonly canonicalRoot: string;
  readonly sessionId: string;
  readonly limits: StoreProjectionLimits;
  /** Existing callers default to 4300. Ordinary activation must supply an earned
   * SQL profile explicitly; this is separate from prepareRender's profile. */
  readonly sqlProfile?: StoreJsonProfile;
  readonly maximumProjectionBytes: number;
  /** Caller must supply admitted renderer context/calendar; no fixture defaults. */
  readonly prepareRender: (
    input: SessionPublicationInput
  ) => Promise<SessionPublicationPreparation>;
  readonly consumer: Parameters<typeof createSessionLogPublicationConsumer>[0];
}

/** Complete one acquisition and use the ordinary current-generation reader.
 * Exceptions never grant compatibility fallback, SQL replay or a second attempt.
 */
export async function publishNativeTranscriptStore(
  options: SessionStorePublicationOptions
): Promise<SessionPublicationReceipt> {
  if (
    !Number.isSafeInteger(options.maximumProjectionBytes) ||
    options.maximumProjectionBytes < 0 ||
    options.maximumProjectionBytes > MAX_PUBLICATION_ARTIFACT_BYTES ||
    typeof options.prepareRender !== 'function' ||
    !['opencode', 'zcode'].includes(options.port.surface)
  )
    throw new RuntimeProtocolError('Invalid native store publication adapter input');
  const suppliedProfile = options.sqlProfile;
  const sqlProfile = snapshotStoreJsonProfile(
    suppliedProfile === undefined ? STORE_JSON_PROFILE : suppliedProfile
  );
  const consume = createSessionLogPublicationConsumer(options.consumer);
  const projection = await reconstructNativeTranscriptStore(
    options.port,
    options.canonicalRoot,
    options.port.surface,
    options.limits,
    sqlProfile
  );
  // Serialization follows actual exhausted acquisition; assertClosed alone
  // cannot authorize the handoff, which the same port independently enforces.
  const bytes = encodeStoreProjectionEvents(projection, options.maximumProjectionBytes);
  return options.port.continuePublication({
    canonicalRoot: options.canonicalRoot,
    sessionId: options.sessionId,
    consume,
    async prepare(input) {
      if (input.kind === 'projection')
        return {
          disposition: 'ready',
          artifacts: [
            { name: 'store-projection.jsonl', role: 'projection', bytes: Uint8Array.from(bytes) },
          ],
          removals: [],
        };
      if (
        input.kind !== 'render' ||
        input.files.filter(
          (item) => item.name === 'store-projection.jsonl' && item.role === 'projection'
        ).length !== 1 ||
        !Buffer.from(input.bytes('store-projection.jsonl')).equals(Buffer.from(bytes))
      )
        throw new RuntimeProtocolError(
          'Native render input differs from the exhausted store projection'
        );
      return options.prepareRender(input);
    },
  });
}
