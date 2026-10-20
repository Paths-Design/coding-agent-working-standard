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
 * Python profile boundaries are explicit: container repr outside Latin-1/lone
 * surrogates and selected Unicode source syntax can be unsupported. Python
 * single-quoted adjacent surrogate codepoints are declined separately from JSON ingress. Integer
 * custody intentionally exceeds CPython's configurable decimal digit cap.
 * No cache, aggregation, rewind or cross-surface parity is claimed here.
 */
export * from './lossless-json';
export * from './harness-common';
export { decodeOccurrence, isParsedRow } from './source-occurrence';
export type { OccurrenceCoordinates } from './source-occurrence';
export * from './harness-codex';
