// prepareAppend — pure function that turns an EventBody into a ChainedEvent.
//
// Given:
//   prev:  the most-recent ChainedEvent in the chain, or null if this is
//          the genesis event.
//   body:  caller-supplied EventBody (no chain fields).
//
// Returns:
//   Result<ChainedEvent>
//
// Sequencing:
//   - prev === null:                seq = 1, prev_hash = null
//   - prev !== null (any seq ≥ 1):  seq = prev.seq + 1, prev_hash = prev.event_hash
//
// The function:
//   1. Validates the body (validateEventBody).
//   2. Constructs the partial event with seq + prev_hash.
//   3. Computes event_hash over the partial event (canonical JSON, domain-
//      separated, sha256:hex).
//   4. Returns the full ChainedEvent.
//
// Determinism: same prev + same body → same ChainedEvent. The kernel reads
// no clocks, no random, no env. Timestamp comes from the body, which is
// the caller's responsibility.

import { diagnostic } from '../diagnostics';
import { err, isErr, ok } from '../result';
import type { Result } from '../result/types';

import { computeEventHash } from './hash';
import { EVIDENCE_RULES } from './rules';
import { validateEventBody } from './validate';
import type { ChainedEvent, EventBody, Hash } from './types';

/**
 * Append a new event to a chain.
 *
 * `prev` is null for the genesis event (seq=1, prev_hash=null).
 * For every other event, pass the most recent ChainedEvent in the chain;
 * the new event's seq becomes prev.seq + 1 and prev_hash becomes
 * prev.event_hash.
 */
export function prepareAppend(
  prev: ChainedEvent | null,
  body: unknown
): Result<ChainedEvent> {
  // Validate the body first. This catches: bad event type, missing data,
  // missing actor, bad spec_id class, etc.
  const bodyResult = validateEventBody(body);
  if (isErr(bodyResult)) return bodyResult;
  const validBody: EventBody = bodyResult.value;

  // Sanity-check prev when supplied: it must be a ChainedEvent shape.
  // We don't re-validate it fully (callers are expected to keep the chain
  // intact between calls), but a defensive shape check catches the obvious
  // "passed an EventBody instead of a ChainedEvent" bug.
  let seq: number;
  let prevHash: Hash | null;
  if (prev === null) {
    seq = 1;
    prevHash = null;
  } else {
    if (typeof prev.seq !== 'number' || !Number.isInteger(prev.seq) || prev.seq < 1) {
      return err(
        diagnostic({
          rule: EVIDENCE_RULES.CHAIN_SEQ_NOT_INTEGER,
          authority: 'kernel/evidence',
          message: `prev.seq must be a positive integer, got ${String(prev.seq)}.`,
          subject: 'prev.seq',
        })
      );
    }
    if (typeof prev.event_hash !== 'string' || !prev.event_hash.startsWith('sha256:')) {
      return err(
        diagnostic({
          rule: EVIDENCE_RULES.CHAIN_EVENT_HASH_MALFORMED,
          authority: 'kernel/evidence',
          message: `prev.event_hash must be a sha256:<hex> string, got ${JSON.stringify(prev.event_hash)}.`,
          subject: 'prev.event_hash',
        })
      );
    }
    seq = prev.seq + 1;
    prevHash = prev.event_hash;
  }

  // Build the canonical-shape pre-hash event. Order of keys does not matter
  // for canonicalJson (it sorts), but we follow envelope schema order for
  // human readability when serialized for storage.
  //
  // exactOptionalPropertyTypes: spec_id is included only when validBody had it.
  const preHash:
    | { seq: number; event: EventBody['event']; ts: string; actor: EventBody['actor']; spec_id: string; data: EventBody['data']; prev_hash: Hash | null }
    | { seq: number; event: EventBody['event']; ts: string; actor: EventBody['actor']; data: EventBody['data']; prev_hash: Hash | null } =
    validBody.spec_id !== undefined
      ? {
          seq,
          event: validBody.event,
          ts: validBody.ts,
          actor: validBody.actor,
          spec_id: validBody.spec_id,
          data: validBody.data,
          prev_hash: prevHash,
        }
      : {
          seq,
          event: validBody.event,
          ts: validBody.ts,
          actor: validBody.actor,
          data: validBody.data,
          prev_hash: prevHash,
        };

  let eventHash: Hash;
  try {
    eventHash = computeEventHash(preHash);
  } catch (e) {
    // computeEventHash throws EvidenceCanonicalError for non-finite
    // numbers / unsupported types / circular references. Surface it as
    // an Err with the original rule preserved.
    const rule =
      e instanceof Error && 'rule' in e && typeof (e as { rule: unknown }).rule === 'string'
        ? (e as { rule: string }).rule
        : EVIDENCE_RULES.CANONICAL_UNSUPPORTED_TYPE;
    return err(
      diagnostic({
        rule,
        authority: 'kernel/evidence',
        message: e instanceof Error ? e.message : 'canonicalJson failed.',
      })
    );
  }

  const chained: ChainedEvent =
    validBody.spec_id !== undefined
      ? {
          seq,
          event: validBody.event,
          ts: validBody.ts,
          actor: validBody.actor,
          spec_id: validBody.spec_id,
          data: validBody.data,
          prev_hash: prevHash,
          event_hash: eventHash,
        }
      : {
          seq,
          event: validBody.event,
          ts: validBody.ts,
          actor: validBody.actor,
          data: validBody.data,
          prev_hash: prevHash,
          event_hash: eventHash,
        };

  return ok(chained);
}
