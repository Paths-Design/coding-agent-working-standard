// Domain-separated event hashing.
//
// `computeEventHash(event)` returns the canonical hash for an event.
// The hash is computed over:
//
//   sha256(DOMAIN_SEPARATOR + canonicalJson(event minus event_hash))
//
// where DOMAIN_SEPARATOR is `'caws.events.v1' + 0x00` (versioned, NUL-
// terminated). The NUL prevents user-controlled JSON from colliding with
// the prefix; the version lets a future v2 chain co-exist with v1.
//
// `event_hash` is excluded from the hashed material because it's the field
// being computed — including it would require two-pass fixed-point hashing
// or a placeholder convention. Excluding it keeps `prepareAppend` a single
// pass and `verifyChain`'s re-hash deterministic.
//
// The hash format is `sha256:<64 lowercase hex>`. The prefix is part of the
// stored value (not just a comment) so a future migration to a different
// algorithm can dispatch on prefix without ambiguity.

import { createHash } from 'crypto';
import { canonicalJson } from './canonical-json';
import { DOMAIN_SEPARATOR, type ChainedEvent, type EventBody, type Hash } from './types';

/**
 * Compute the canonical event_hash for a fully-formed event.
 *
 * Accepts either:
 *  - An EventBody-shaped value augmented with `seq` and `prev_hash`
 *    (i.e. everything `prepareAppend` builds before hashing).
 *  - A complete ChainedEvent (the `event_hash` field is stripped before
 *    hashing, so re-hashing a stored event is idempotent).
 *
 * The function is pure: same input → same hash, every time.
 */
export function computeEventHash(
  event: HashableEvent
): Hash {
  // Strip event_hash if present so the result is the same whether the
  // caller passed a not-yet-hashed event or a fully-chained event.
  const { event_hash: _ignored, ...rest } = event as ChainedEvent;
  void _ignored;

  // Strip undefined fields so canonical JSON treats absent and null
  // distinctly (canonicalJson already does this for object properties,
  // but we do it explicitly here so the input shape passed to the
  // serializer is what callers see in the chain).
  const canon = canonicalJson(rest);

  const h = createHash('sha256');
  h.update(DOMAIN_SEPARATOR, 'utf8');
  h.update(canon, 'utf8');
  return `sha256:${h.digest('hex')}` as Hash;
}

/**
 * Anything that has at minimum the EventBody fields plus seq + prev_hash.
 * `event_hash` is allowed but stripped.
 */
export type HashableEvent =
  | (EventBody & { readonly seq: number; readonly prev_hash: Hash | null })
  | ChainedEvent;
