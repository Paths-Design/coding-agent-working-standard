// Stable evidence-kernel rule ids.
//
// These are the public diagnostic contract. Each rule id appears in
// `Diagnostic.rule` and is documented for callers to switch on. Renaming
// any of these is a breaking change.
//
// Namespacing convention:
//   evidence.canonical.* — canonical JSON serialization issues
//   evidence.event.*     — envelope shape / vocabulary / spec_id class issues
//   evidence.actor.*     — actor shape issues (kind, id, optional fields)
//   evidence.chain.*     — hash chain integrity issues (verifyChain only)

export const EVIDENCE_RULES = {
  // canonical JSON
  CANONICAL_NON_FINITE_NUMBER: 'evidence.canonical.non_finite_number',
  CANONICAL_UNSUPPORTED_TYPE: 'evidence.canonical.unsupported_type',
  CANONICAL_CIRCULAR_REFERENCE: 'evidence.canonical.circular_reference',

  // envelope shape (validateEventBody / validateChainedEvent)
  EVENT_UNKNOWN_TYPE: 'evidence.event.unknown_type',
  EVENT_PAYLOAD_INVALID: 'evidence.event.payload_invalid',
  EVENT_ENVELOPE_INVALID: 'evidence.event.envelope_invalid',
  EVENT_TIMESTAMP_INVALID: 'evidence.event.timestamp_invalid',
  EVENT_DATA_MISSING: 'evidence.event.data_missing',

  // spec_id class enforcement
  EVENT_SPEC_ID_REQUIRED: 'evidence.event.spec_id_required',
  EVENT_SPEC_ID_FORBIDDEN: 'evidence.event.spec_id_forbidden',
  EVENT_SPEC_ID_INVALID: 'evidence.event.spec_id_invalid',

  // actor shape
  ACTOR_KIND_INVALID: 'evidence.actor.kind_invalid',
  ACTOR_ID_EMPTY: 'evidence.actor.id_empty',
  ACTOR_SESSION_ID_EMPTY: 'evidence.actor.session_id_empty',
  ACTOR_PLATFORM_EMPTY: 'evidence.actor.platform_empty',
  ACTOR_MISSING: 'evidence.actor.missing',

  // hash chain (verifyChain + validateChainedEvent)
  CHAIN_SEQ_NOT_INTEGER: 'evidence.chain.seq_not_integer',
  CHAIN_SEQ_NOT_POSITIVE: 'evidence.chain.seq_not_positive',
  CHAIN_SEQ_GAP: 'evidence.chain.seq_gap',
  CHAIN_SEQ_DUPLICATE: 'evidence.chain.seq_duplicate',
  CHAIN_PREV_HASH_MISMATCH: 'evidence.chain.prev_hash_mismatch',
  CHAIN_PREV_HASH_MALFORMED: 'evidence.chain.prev_hash_malformed',
  CHAIN_EVENT_HASH_MISMATCH: 'evidence.chain.event_hash_mismatch',
  CHAIN_EVENT_HASH_MALFORMED: 'evidence.chain.event_hash_malformed',
  CHAIN_GENESIS_PREV_HASH_NOT_NULL: 'evidence.chain.genesis_prev_hash_not_null',
  CHAIN_NON_GENESIS_PREV_HASH_NULL: 'evidence.chain.non_genesis_prev_hash_null',
} as const;

/** Stable rule id type. Switch on these to react to specific failures. */
export type EvidenceRule = (typeof EVIDENCE_RULES)[keyof typeof EVIDENCE_RULES];

/** Public namespace prefixes for assertion in tests / cross-module checks. */
export const EVIDENCE_RULE_PREFIXES = [
  'evidence.canonical.',
  'evidence.event.',
  'evidence.actor.',
  'evidence.chain.',
] as const;
