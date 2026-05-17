// verifyChain — pure chain integrity check over a sequence of ChainedEvents.
//
// Detects, with stable rule ids:
//
//   evidence.chain.seq_not_integer        — seq is not an integer
//   evidence.chain.seq_not_positive       — seq < 1
//   evidence.chain.seq_gap                — seq jumps (e.g. 1, 2, 4)
//   evidence.chain.seq_duplicate          — same seq appears twice
//   evidence.chain.genesis_prev_hash_not_null — first event has prev_hash != null
//   evidence.chain.non_genesis_prev_hash_null — non-first event has prev_hash === null
//   evidence.chain.prev_hash_malformed    — prev_hash present but not sha256:<hex>
//   evidence.chain.prev_hash_mismatch     — prev_hash != preceding event_hash
//   evidence.chain.event_hash_malformed   — event_hash not sha256:<hex>
//   evidence.chain.event_hash_mismatch    — re-hashing event minus event_hash
//                                            yields a different value (bodies/seq/
//                                            ts/actor/data/spec_id tampered with)
//
// The function returns Result<ChainedEvent[]>: Ok with the input on success,
// Err with the full list of violations on failure (allErrors-style — we
// don't stop at the first bad event, because tampering somewhere midchain
// shouldn't hide tampering further down).
//
// verifyChain does NOT call validateChainedEvent — it assumes the events
// are already structurally valid. If callers need both, they should call
// validateChainedEvent on each event first, or use the higher-level helper
// that composes both (not provided in Slice 3 — store/shell layer's job).
//
// The function is pure: same input → same Result, every time.

import { diagnostic } from '../diagnostics';
import { err, ok } from '../result';
import type { Result } from '../result/types';

import { computeEventHash } from './hash';
import { EVIDENCE_RULES } from './rules';
import { HASH_REGEX, type ChainedEvent, type Hash } from './types';

/**
 * Verify the integrity of an array of ChainedEvents.
 *
 * The array must be in chain order (i.e. the order events were appended).
 * verifyChain does NOT sort — sequence ordering is exactly the order of
 * the input array.
 *
 * Empty input is Ok by definition (empty chain is consistent).
 */
export function verifyChain(events: readonly ChainedEvent[]): Result<readonly ChainedEvent[]> {
  const errors = collectChainErrors(events);
  if (errors.length > 0) return err(errors);
  return ok(events);
}

function collectChainErrors(events: readonly ChainedEvent[]): ReturnType<typeof diagnostic>[] {
  const out: ReturnType<typeof diagnostic>[] = [];
  const seenSeqs = new Set<number>();

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev === undefined) {
      // Defensive — TS disallows but JS could pass holes in sparse arrays.
      out.push(
        diagnostic({
          rule: EVIDENCE_RULES.EVENT_ENVELOPE_INVALID,
          authority: 'kernel/evidence',
          message: `Chain index ${i} is undefined.`,
          subject: `[${i}]`,
        })
      );
      continue;
    }
    const isGenesis = i === 0;
    const prev = isGenesis ? null : events[i - 1] ?? null;

    // seq shape
    if (typeof ev.seq !== 'number' || !Number.isInteger(ev.seq)) {
      out.push(
        diagnostic({
          rule: EVIDENCE_RULES.CHAIN_SEQ_NOT_INTEGER,
          authority: 'kernel/evidence',
          message: `seq must be an integer at chain index ${i}; got ${String(ev.seq)}.`,
          subject: `[${i}].seq`,
        })
      );
    } else if (ev.seq < 1) {
      out.push(
        diagnostic({
          rule: EVIDENCE_RULES.CHAIN_SEQ_NOT_POSITIVE,
          authority: 'kernel/evidence',
          message: `seq must be ≥ 1 at chain index ${i}; got ${ev.seq}.`,
          subject: `[${i}].seq`,
        })
      );
    } else {
      // duplicate
      if (seenSeqs.has(ev.seq)) {
        out.push(
          diagnostic({
            rule: EVIDENCE_RULES.CHAIN_SEQ_DUPLICATE,
            authority: 'kernel/evidence',
            message: `Duplicate seq ${ev.seq} at chain index ${i}.`,
            subject: `[${i}].seq`,
          })
        );
      }
      seenSeqs.add(ev.seq);

      // monotonic (no gap, no rewind) — only check when prev is well-formed.
      if (
        prev !== null &&
        typeof prev.seq === 'number' &&
        Number.isInteger(prev.seq) &&
        ev.seq !== prev.seq + 1
      ) {
        out.push(
          diagnostic({
            rule: EVIDENCE_RULES.CHAIN_SEQ_GAP,
            authority: 'kernel/evidence',
            message: `Expected seq ${prev.seq + 1} at chain index ${i}; got ${ev.seq}.`,
            subject: `[${i}].seq`,
          })
        );
      }
      if (isGenesis && ev.seq !== 1) {
        out.push(
          diagnostic({
            rule: EVIDENCE_RULES.CHAIN_SEQ_GAP,
            authority: 'kernel/evidence',
            message: `Genesis event must have seq=1; got ${ev.seq}.`,
            subject: `[0].seq`,
          })
        );
      }
    }

    // prev_hash shape + chain-link.
    if (isGenesis) {
      if (ev.prev_hash !== null) {
        out.push(
          diagnostic({
            rule: EVIDENCE_RULES.CHAIN_GENESIS_PREV_HASH_NOT_NULL,
            authority: 'kernel/evidence',
            message: `Genesis event prev_hash must be null; got ${JSON.stringify(ev.prev_hash)}.`,
            subject: `[0].prev_hash`,
            narrowRepair: 'Use null (not empty string) for the genesis event.',
          })
        );
      }
    } else {
      if (ev.prev_hash === null) {
        out.push(
          diagnostic({
            rule: EVIDENCE_RULES.CHAIN_NON_GENESIS_PREV_HASH_NULL,
            authority: 'kernel/evidence',
            message: `Non-genesis event at chain index ${i} has prev_hash=null.`,
            subject: `[${i}].prev_hash`,
          })
        );
      } else if (!isHash(ev.prev_hash)) {
        out.push(
          diagnostic({
            rule: EVIDENCE_RULES.CHAIN_PREV_HASH_MALFORMED,
            authority: 'kernel/evidence',
            message: `prev_hash at chain index ${i} is not a sha256:<hex> string.`,
            subject: `[${i}].prev_hash`,
          })
        );
      } else if (prev !== null && isHash(prev.event_hash) && ev.prev_hash !== prev.event_hash) {
        out.push(
          diagnostic({
            rule: EVIDENCE_RULES.CHAIN_PREV_HASH_MISMATCH,
            authority: 'kernel/evidence',
            message: `prev_hash at chain index ${i} does not match preceding event_hash.`,
            subject: `[${i}].prev_hash`,
            data: {
              expected: prev.event_hash,
              actual: ev.prev_hash,
            },
          })
        );
      }
    }

    // event_hash shape + content match (re-hash and compare).
    if (typeof ev.event_hash !== 'string' || !isHash(ev.event_hash)) {
      out.push(
        diagnostic({
          rule: EVIDENCE_RULES.CHAIN_EVENT_HASH_MALFORMED,
          authority: 'kernel/evidence',
          message: `event_hash at chain index ${i} is not a sha256:<hex> string.`,
          subject: `[${i}].event_hash`,
        })
      );
    } else {
      // Re-hash the event minus event_hash. Any tampering with seq, ts,
      // actor, spec_id, data, prev_hash, or event type changes the result.
      let recomputed: Hash;
      try {
        recomputed = computeEventHash(ev);
      } catch (e) {
        out.push(
          diagnostic({
            rule: EVIDENCE_RULES.CHAIN_EVENT_HASH_MISMATCH,
            authority: 'kernel/evidence',
            message: `event_hash at chain index ${i} could not be recomputed: ${e instanceof Error ? e.message : String(e)}.`,
            subject: `[${i}].event_hash`,
          })
        );
        continue;
      }
      if (recomputed !== ev.event_hash) {
        out.push(
          diagnostic({
            rule: EVIDENCE_RULES.CHAIN_EVENT_HASH_MISMATCH,
            authority: 'kernel/evidence',
            message: `event_hash at chain index ${i} does not match recomputed hash; the event has been tampered with.`,
            subject: `[${i}].event_hash`,
            data: {
              expected: recomputed,
              actual: ev.event_hash,
            },
          })
        );
      }
    }
  }

  return out;
}

function isHash(value: unknown): value is Hash {
  return typeof value === 'string' && HASH_REGEX.test(value);
}
