/** SessionEnd preparation consumes only the native owner's captured bytes. */
import { TextDecoder } from 'node:util';
import { createHash } from 'node:crypto';
import {
  prepareSessionSeal,
  SESSION_SEAL_LIMITS,
  SESSION_USAGE_FIELDS,
} from '../transcripts/session-seal-prepare';
import { getMember, type JsonValue } from '../transcripts/lossless-json';
import {
  type SessionPublicationInput,
  type SessionPublicationPreparation,
  type NativeSessionSealPort,
} from './session-publication-client';
import { readCommittedSessionLog, type CommittedSessionLog } from './session-log';
import type { HandlerResult } from './composer';

export function prepareCapturedSessionSeal(
  input: SessionPublicationInput
): SessionPublicationPreparation {
  const abort = (diagnostic: string): SessionPublicationPreparation =>
    Object.freeze({ disposition: 'aborted', diagnostic });
  if (input.kind !== 'seal') return abort('unsupported_phase: SessionEnd only seals metadata');
  const metadata = input.files.filter(
    (item) => item.name === '.meta.json' && item.role === 'metadata'
  );
  if (metadata.length === 0) return abort('missing_metadata: SessionEnd has no metadata to seal');
  if (metadata.length !== 1) return abort('invalid_metadata: repeated native metadata');
  try {
    const decode = (name: string): string =>
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input.bytes(name));
    const turns = input.files
      .filter((item) => item.role === 'turn')
      .map((item) => ({
        name: item.name,
        json: decode(item.name),
      }))
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    const prepared = prepareSessionSeal({
      metadataJson: decode('.meta.json'),
      turns,
      reason: input.reason,
      timestamp: input.endedAt,
      limits: SESSION_SEAL_LIMITS,
    });
    if (prepared.kind !== 'ready') return abort(prepared.code + ': ' + prepared.reason);
    return Object.freeze({
      disposition: 'ready',
      artifacts: Object.freeze([
        Object.freeze({
          name: '.meta.json',
          role: 'metadata',
          bytes: Buffer.from(prepared.metadataJson),
        }),
      ]),
      removals: Object.freeze([]),
      summaryMode: prepared.summaryMode,
    });
  } catch {
    return abort('invalid_snapshot: native SessionEnd metadata or turns are not complete UTF-8');
  }
}

export interface SessionSealObservation {
  readonly reason: JsonValue | undefined;
  readonly endedAt: JsonValue | undefined;
  readonly usage: JsonValue | undefined;
  readonly counts: readonly Readonly<{
    field: (typeof SESSION_USAGE_FIELDS)[number];
    value: JsonValue | undefined;
  }>[];
  readonly models: JsonValue | undefined;
  readonly metadataJson: string;
}

/** Inspect the actual ordinary reader's lossless metadata. Retain the complete
 * object/raw text so counts and unrelated fields are never projected to Number.
 * The selected route must compare this with its captured preparation before ack.
 */
export function inspectCommittedSessionSeal(log: CommittedSessionLog): SessionSealObservation {
  if (!log.metadata) throw new Error('Committed SessionEnd metadata is unavailable');
  const ended = getMember(log.metadata.value, 'ended');
  const usage = getMember(log.metadata.value, 'usage');
  return Object.freeze({
    reason: getMember(ended, 'reason'),
    endedAt: getMember(ended, 'ts'),
    usage,
    counts: Object.freeze(
      SESSION_USAGE_FIELDS.map((field) => Object.freeze({ field, value: getMember(usage, field) }))
    ),
    models: getMember(log.metadata.value, 'models'),
    metadataJson: log.metadata.json,
  });
}

/** The selected logger consumes the reopened committed generation before the
 * publication client sends CONSUMED. The observer records semantic use, including
 * explicit non-publication; it never turns receipt parsing into published success.
 * Prefix custody and source admission must precede calling this one-shot port.
 */
export async function executeNativeSessionSeal(options: {
  readonly port: NativeSessionSealPort;
  readonly canonicalRoot: string;
  readonly sessionId: string;
  readonly signal: AbortSignal;
  readonly observe: (fields: Readonly<Record<string, unknown>>) => void;
}): Promise<HandlerResult> {
  let expected: Extract<SessionPublicationPreparation, { disposition: 'ready' }> | undefined;
  let reason: string | undefined,
    endedAt: string | undefined,
    preparationDiagnostic: string | undefined;
  await options.port.seal(
    options.canonicalRoot,
    options.sessionId,
    async (input) => {
      if (input.sessionId !== options.sessionId)
        throw new Error('SessionEnd captured identity mismatch');
      const preparation = prepareCapturedSessionSeal(input);
      if (preparation.disposition === 'ready') {
        expected = preparation;
        reason = input.reason;
        endedAt = input.endedAt;
      } else preparationDiagnostic = preparation.diagnostic;
      return preparation;
    },
    async (outcome) => {
      if (outcome.status === 'not_published') {
        options.observe({
          status: 'not_published',
          terminal_digest: outcome.receipt.terminalDigest,
          diagnostic: preparationDiagnostic ?? outcome.receipt.error ?? null,
          missing_metadata: preparationDiagnostic?.startsWith('missing_metadata:') ?? false,
        });
        return;
      }
      if (!expected) throw new Error('SessionEnd publication has no accepted preparation');
      const prepared = expected.artifacts.find((item) => item.name === '.meta.json');
      if (
        !prepared ||
        !Buffer.from(outcome.session.bytes('.meta.json')).equals(Buffer.from(prepared.bytes))
      )
        throw new Error('Committed SessionEnd metadata differs from captured preparation');
      const log = readCommittedSessionLog(outcome.session);
      const observed = inspectCommittedSessionSeal(log);
      if (observed.reason !== reason || observed.endedAt !== endedAt)
        throw new Error('Committed SessionEnd reason or timestamp differs from native original');
      options.observe({
        status: 'published',
        terminal_digest: log.terminalDigest,
        metadata_sha256: createHash('sha256').update(observed.metadataJson).digest('hex'),
        counts: observed.counts,
        models: observed.models ?? null,
        reason: observed.reason,
        ended_at: observed.endedAt,
        summary_mode: expected.summaryMode,
        unrelated_metadata_preserved: true,
      });
    }
  );
  if (options.signal.aborted) throw options.signal.reason;
  // SessionEnd is a silent, non-blocking stock logger. Definite non-publication
  // is separately observed; uncertainty and transport failures throw above.
  return { exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array() };
}
