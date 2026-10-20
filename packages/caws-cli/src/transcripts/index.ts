/**
 * Standalone transcript normalization foundation; stock renderer/cache consumers
 * are integrated separately. Raw occurrence custody, historical projection and
 * optional source-syntax indexing are separate contracts.
 *
 * Source labels and member paths describe caller-supplied occurrences. They do
 * not authorize actions, establish filesystem freshness, or prove that indexed
 * tool calls executed. Adapter-owned cloneState must isolate every mutable
 * state member; the framework provides transactional clone isolation, not
 * generic deep immutability of Sets and Maps.
 *
 * Historical interpretation uses the pinned Python3.11.13/Unicode14 profile.
 * Interpreted Python literals retain explicit codepoints separately from JSON
 * ingress: adjacent surrogate codepoints must not silently become one scalar. Integer
 * custody intentionally exceeds CPython's configurable decimal digit cap.
 * No cache, aggregation, rewind or cross-surface parity is claimed here.
 */
export * from './lossless-json';
export * from './harness-common';
export { decodeOccurrence, isParsedRow } from './source-occurrence';
export type { OccurrenceCoordinates } from './source-occurrence';
export * from './harness-codex';
export * from './codepoint-text';
export * from './python-unicode-profile';
