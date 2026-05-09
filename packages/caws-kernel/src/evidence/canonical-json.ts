// Deterministic, side-effect-free JSON serializer.
//
// The output of `canonicalJson(x)` is the SAME byte string for any two
// inputs that compare structurally equal (modulo the JSON value model:
// objects with the same own-enumerable string keys mapping to canonically-
// equal values are equal). This is a hard invariant: the hash chain is
// computed over canonical JSON, so any two events that are "the same event"
// must serialize to the same bytes.
//
// Differences vs `JSON.stringify`:
//   - object keys are sorted lexicographically (UTF-16 code unit order, the
//     same order Array#sort() uses by default).
//   - non-finite numbers (NaN, Infinity, -Infinity) throw. JSON.stringify
//     would emit `null`, silently corrupting hash material.
//   - object properties with `undefined` values are omitted (same as
//     JSON.stringify), preserving the "absent vs null" distinction the
//     evidence schema relies on (e.g. spec_id omitted means "no spec_id",
//     spec_id: null would be a different claim).
//   - functions and symbols throw, even at the top level. JSON.stringify
//     would emit `undefined` (i.e. omit) for those at the top level, which
//     is a footgun.
//   - circular references throw with a stable rule id rather than blowing
//     the stack with a generic recursion error.
//
// This function intentionally throws on programmer errors (non-finite,
// function, symbol, circular). Callers that want a Result<string> shape
// should wrap with try/catch and convert.

import { EVIDENCE_RULES } from './rules';

/** Error subclass so callers can dispatch on `EvidenceCanonicalError` instead of stringly-typed message matches. */
export class EvidenceCanonicalError extends Error {
  readonly rule: string;
  readonly path: string;
  constructor(rule: string, message: string, path: string) {
    super(`${message} at ${path || '<root>'}`);
    this.name = 'EvidenceCanonicalError';
    this.rule = rule;
    this.path = path;
  }
}

/**
 * Serialize a value to canonical JSON.
 *
 * Throws `EvidenceCanonicalError` (with `.rule` from EVIDENCE_RULES) when:
 *  - a number is non-finite (NaN, ±Infinity)
 *  - any value is a function, symbol, bigint, or other unsupported type
 *  - the input contains a circular reference
 *
 * Returns:
 *  - `'null'` for null
 *  - `'true'` / `'false'` for booleans
 *  - quoted string (via JSON.stringify) for strings
 *  - JSON.stringify(num) for finite numbers (preserves -0 etc. consistently)
 *  - `[a,b,c]` (no whitespace) for arrays — array elements that would
 *    serialize to undefined are emitted as `null` (matching JSON.stringify
 *    array semantics, which IS load-bearing: the array length must be
 *    preserved).
 *  - `{"k1":v1,"k2":v2}` (no whitespace, keys sorted) for objects — own
 *    enumerable string-keyed properties whose value is `undefined` are
 *    omitted entirely.
 */
export function canonicalJson(value: unknown): string {
  return canonicalEncode(value, '', new Set());
}

function canonicalEncode(value: unknown, path: string, seen: Set<object>): string {
  if (value === null) return 'null';

  const t = typeof value;

  if (t === 'string') return JSON.stringify(value);
  if (t === 'boolean') return value ? 'true' : 'false';

  if (t === 'number') {
    if (!Number.isFinite(value as number)) {
      throw new EvidenceCanonicalError(
        EVIDENCE_RULES.CANONICAL_NON_FINITE_NUMBER,
        `non-finite number ${String(value)}`,
        path
      );
    }
    return JSON.stringify(value);
  }

  if (t === 'undefined' || t === 'function' || t === 'symbol' || t === 'bigint') {
    throw new EvidenceCanonicalError(
      EVIDENCE_RULES.CANONICAL_UNSUPPORTED_TYPE,
      `unsupported type ${t}`,
      path
    );
  }

  // From here on, value is a non-null object (array, plain object, etc.).
  if (typeof value !== 'object') {
    // Defensive — typeof returns one of the strings above; nothing else is reachable.
    throw new EvidenceCanonicalError(
      EVIDENCE_RULES.CANONICAL_UNSUPPORTED_TYPE,
      `unsupported type ${t}`,
      path
    );
  }

  if (seen.has(value)) {
    throw new EvidenceCanonicalError(
      EVIDENCE_RULES.CANONICAL_CIRCULAR_REFERENCE,
      'circular reference',
      path
    );
  }
  seen.add(value);

  try {
    if (Array.isArray(value)) {
      const parts: string[] = [];
      for (let i = 0; i < value.length; i++) {
        const item = value[i];
        const childPath = `${path}[${i}]`;
        // JSON.stringify emits `null` for array slots that are undefined,
        // functions, or symbols. We preserve that semantics for ABSENT
        // (undefined) so array length is preserved; for function/symbol
        // we still throw because those are programmer errors.
        if (item === undefined) {
          parts.push('null');
          continue;
        }
        if (typeof item === 'function' || typeof item === 'symbol' || typeof item === 'bigint') {
          throw new EvidenceCanonicalError(
            EVIDENCE_RULES.CANONICAL_UNSUPPORTED_TYPE,
            `unsupported type ${typeof item} in array element`,
            childPath
          );
        }
        parts.push(canonicalEncode(item, childPath, seen));
      }
      return '[' + parts.join(',') + ']';
    }

    // Plain object. Use Object.keys for own enumerable string keys, sorted.
    // This matches JSON.stringify's iteration set (excluding symbols, which
    // we've already rejected at top-level — symbols as object keys aren't
    // returned by Object.keys, so they can't appear here).
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const parts: string[] = [];
    for (const k of keys) {
      const v = (value as Record<string, unknown>)[k];
      const childPath = path === '' ? k : `${path}.${k}`;
      // Omit undefined values (same as JSON.stringify object semantics).
      // This is load-bearing for "spec_id absent" vs "spec_id: null".
      if (v === undefined) continue;
      // Functions and symbols as object values are programmer errors.
      if (typeof v === 'function' || typeof v === 'symbol' || typeof v === 'bigint') {
        throw new EvidenceCanonicalError(
          EVIDENCE_RULES.CANONICAL_UNSUPPORTED_TYPE,
          `unsupported type ${typeof v} for property ${JSON.stringify(k)}`,
          childPath
        );
      }
      parts.push(JSON.stringify(k) + ':' + canonicalEncode(v, childPath, seen));
    }
    return '{' + parts.join(',') + '}';
  } finally {
    seen.delete(value);
  }
}
