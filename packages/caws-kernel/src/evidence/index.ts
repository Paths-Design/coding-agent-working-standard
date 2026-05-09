// Evidence kernel public surface.
//
// Pure mechanics for the CAWS event log. No I/O lives here.
// The Node-only file store (Slice 5b/5c) wraps these primitives with
// locking, append semantics, and tail recovery.

export type {
  Actor,
  ActorKind,
  ChainedEvent,
  EventBody,
  EventPayload,
  EventType,
  Hash,
  SpecIdClass,
} from './types';

export {
  DOMAIN_SEPARATOR,
  HASH_REGEX,
  NO_SPEC_ID,
  OPTIONAL_SPEC_ID,
  REQUIRES_SPEC_ID,
  specIdClassOf,
} from './types';

export { EVIDENCE_RULES, EVIDENCE_RULE_PREFIXES } from './rules';
export type { EvidenceRule } from './rules';

export { canonicalJson, EvidenceCanonicalError } from './canonical-json';

export { computeEventHash } from './hash';
export type { HashableEvent } from './hash';

export { validateChainedEvent, validateEventBody } from './validate';

export { prepareAppend } from './prepare';

export { verifyChain } from './verify';
