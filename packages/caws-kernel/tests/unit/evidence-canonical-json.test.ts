/**
 * Unit tests for canonicalJson (A4 — audit-integrity property, lineage E9).
 *
 * CAWS-TEST-KERNEL-PURE-001. The hash chain is computed over canonical JSON,
 * so "two events that are the same event serialize to the same bytes" is a
 * HARD invariant. These tests assert the actual byte output and the actual
 * throw rules, so a mutation that drops key-sorting, stops omitting undefined,
 * or silently emits null for NaN is killed.
 */

import { canonicalJson, EvidenceCanonicalError } from '../../src/evidence/canonical-json';
import { EVIDENCE_RULES } from '../../src/evidence/rules';

describe('canonicalJson: primitives', () => {
  test('null/booleans/strings/finite numbers', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(true)).toBe('true');
    expect(canonicalJson(false)).toBe('false');
    expect(canonicalJson('hi')).toBe('"hi"');
    expect(canonicalJson(42)).toBe('42');
    expect(canonicalJson(-1.5)).toBe('-1.5');
  });

  test('strings are JSON-escaped', () => {
    expect(canonicalJson('a"b')).toBe('"a\\"b"');
    expect(canonicalJson('tab\tnl\n')).toBe('"tab\\tnl\\n"');
  });
});

describe('canonicalJson: determinism (the load-bearing audit property)', () => {
  test('object keys are sorted lexicographically regardless of insertion order', () => {
    const a = canonicalJson({ b: 1, a: 2, c: 3 });
    const b = canonicalJson({ c: 3, a: 2, b: 1 });
    expect(a).toBe('{"a":2,"b":1,"c":3}');
    expect(a).toBe(b); // same event -> same bytes
  });

  test('nested objects are sorted at every level', () => {
    expect(canonicalJson({ z: { y: 1, x: 2 }, a: 1 })).toBe('{"a":1,"z":{"x":2,"y":1}}');
  });

  test('arrays preserve element order (NOT sorted) and length', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
    expect(canonicalJson([])).toBe('[]');
  });

  test('no whitespace in output', () => {
    expect(canonicalJson({ a: 1, b: [2, 3] })).toBe('{"a":1,"b":[2,3]}');
  });
});

describe('canonicalJson: absent vs null distinction (spec_id semantics)', () => {
  test('undefined object properties are OMITTED, null is KEPT', () => {
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
    // "spec_id absent" and "spec_id: null" are different claims.
    expect(canonicalJson({ spec_id: undefined })).toBe('{}');
    expect(canonicalJson({ spec_id: null })).toBe('{"spec_id":null}');
  });

  test('undefined ARRAY slots become null (length must be preserved)', () => {
    // JSON.stringify semantics for array holes is load-bearing.
    expect(canonicalJson([1, undefined, 3])).toBe('[1,null,3]');
  });
});

describe('canonicalJson: throws on programmer errors (no silent corruption)', () => {
  test('non-finite numbers THROW (JSON.stringify would emit null, corrupting hash material)', () => {
    expect(() => canonicalJson(NaN)).toThrow(EvidenceCanonicalError);
    expect(() => canonicalJson(Infinity)).toThrow(EvidenceCanonicalError);
    expect(() => canonicalJson(-Infinity)).toThrow(EvidenceCanonicalError);
    try {
      canonicalJson({ n: NaN });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(EvidenceCanonicalError);
      expect((e as EvidenceCanonicalError).rule).toBe(EVIDENCE_RULES.CANONICAL_NON_FINITE_NUMBER);
    }
  });

  test('functions/symbols/bigint THROW with unsupported-type rule', () => {
    expect(() => canonicalJson(() => 1)).toThrow(EvidenceCanonicalError);
    expect(() => canonicalJson(Symbol('s'))).toThrow(EvidenceCanonicalError);
    expect(() => canonicalJson(10n)).toThrow(EvidenceCanonicalError);
    try {
      canonicalJson({ fn: () => 1 });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as EvidenceCanonicalError).rule).toBe(EVIDENCE_RULES.CANONICAL_UNSUPPORTED_TYPE);
    }
  });

  test('top-level undefined THROWS (footgun in JSON.stringify)', () => {
    expect(() => canonicalJson(undefined)).toThrow(EvidenceCanonicalError);
  });

  test('circular references THROW with a stable rule (not a stack blow)', () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj;
    try {
      canonicalJson(obj);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as EvidenceCanonicalError).rule).toBe(EVIDENCE_RULES.CANONICAL_CIRCULAR_REFERENCE);
    }
  });

  test('the EvidenceCanonicalError carries the path of the offending value', () => {
    try {
      canonicalJson({ outer: { inner: NaN } });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as EvidenceCanonicalError).path).toBe('outer.inner');
    }
  });

  test('a NON-circular shared reference is fine (seen-set is cleaned up after each branch)', () => {
    const shared = { x: 1 };
    // Same object referenced twice in siblings is NOT circular.
    expect(canonicalJson({ a: shared, b: shared })).toBe('{"a":{"x":1},"b":{"x":1}}');
  });
});

// ---------------------------------------------------------------------------
// EvidenceCanonicalError field assertions (kills StringLiteral survivors in
// the constructor and the error-construction sites).
// Existing tests check instanceof and .rule but never .path, .name, or
// .message content. The constructor at L36 has StringLiteral survivors on the
// `name` field ('EvidenceCanonicalError'), the message format string, and the
// path fallback ('<root>').
// ---------------------------------------------------------------------------

describe('canonicalJson: EvidenceCanonicalError fields (StringLiteral killers)', () => {
  test('error name is exactly "EvidenceCanonicalError" (not the base "Error")', () => {
    // Mutant that blanks the name assignment would leave name as "Error".
    try {
      canonicalJson(NaN);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as EvidenceCanonicalError).name).toBe('EvidenceCanonicalError');
    }
  });

  test('non-finite number: .path is "<root>" for top-level values', () => {
    // L36 has a ConditionalExpression mutant [path && "<root>"] and a StringLiteral
    // mutant for the empty-string fallback ("<root>"). Assert the actual path.
    try {
      canonicalJson(NaN);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as EvidenceCanonicalError).path).toBe('');
      // But the message ends with "at <root>" because path is '' and the
      // constructor formats `${message} at ${path || '<root>'}`.
      expect((e as EvidenceCanonicalError).message).toContain('<root>');
    }
  });

  test('non-finite number: .message contains the number value', () => {
    // L80 StringLiteral survivor (the template literal for the error message).
    try {
      canonicalJson(Infinity);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as EvidenceCanonicalError).message).toContain('Infinity');
    }
    try {
      canonicalJson(-Infinity);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as EvidenceCanonicalError).message).toContain('-Infinity');
    }
  });

  test('non-finite nested: .path is the dotted property path (not empty)', () => {
    // Assertion on L90 path construction for object values.
    try {
      canonicalJson({ outer: { inner: NaN } });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as EvidenceCanonicalError).path).toBe('outer.inner');
      expect((e as EvidenceCanonicalError).message).toContain('outer.inner');
    }
  });

  test('circular reference: .path is the path where the cycle was detected', () => {
    // L108 StringLiteral: the 'circular reference' message text.
    const obj: Record<string, unknown> = { level1: {} };
    (obj['level1'] as Record<string, unknown>)['back'] = obj;
    try {
      canonicalJson(obj);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as EvidenceCanonicalError).rule).toBe(EVIDENCE_RULES.CANONICAL_CIRCULAR_REFERENCE);
      expect((e as EvidenceCanonicalError).message).toContain('circular');
      // Path points to where the cycle was detected (level1.back)
      expect((e as EvidenceCanonicalError).path).toContain('level1');
    }
  });

  test('unsupported type undefined: .message contains "undefined"', () => {
    // L90 StringLiteral: the template `unsupported type ${t}`.
    try {
      canonicalJson(undefined);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as EvidenceCanonicalError).message).toContain('undefined');
      expect((e as EvidenceCanonicalError).rule).toBe(EVIDENCE_RULES.CANONICAL_UNSUPPORTED_TYPE);
    }
  });

  test('unsupported type function: .message contains "function"', () => {
    try {
      canonicalJson(() => 1);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as EvidenceCanonicalError).message).toContain('function');
    }
  });

  test('unsupported type symbol: .message contains "symbol"', () => {
    try {
      canonicalJson(Symbol('s'));
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as EvidenceCanonicalError).message).toContain('symbol');
    }
  });

  test('unsupported type bigint: .message contains "bigint"', () => {
    try {
      canonicalJson(10n);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as EvidenceCanonicalError).message).toContain('bigint');
    }
  });
});

// ---------------------------------------------------------------------------
// ConditionalExpression / LogicalOperator killers for the OR chains
// at L87 (top-level type check), L128 (array element check), L153 (object
// value check). Each sub-check is exercised independently so mutants that
// eliminate one branch of the OR are detected.
// ---------------------------------------------------------------------------

describe('canonicalJson: each individual unsupported type is independently rejected (OR-chain killers)', () => {
  // Top-level (L87): t === 'undefined' || t === 'function' || t === 'symbol' || t === 'bigint'
  // Mutants short-circuit the chain:
  //   LogicalOperator [t==='undefined' && t==='function'] would allow symbol top-level
  //   LogicalOperator [(t==='undefined'||t==='function') && t==='symbol'] would allow bigint
  // Each test exercises one arm in isolation.

  test('L87: undefined top-level throws CANONICAL_UNSUPPORTED_TYPE', () => {
    let caught: unknown;
    try { canonicalJson(undefined); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(EvidenceCanonicalError);
    expect((caught as EvidenceCanonicalError).rule).toBe(EVIDENCE_RULES.CANONICAL_UNSUPPORTED_TYPE);
  });

  test('L87: function top-level throws CANONICAL_UNSUPPORTED_TYPE', () => {
    let caught: unknown;
    try { canonicalJson(function noop() {}); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(EvidenceCanonicalError);
    expect((caught as EvidenceCanonicalError).rule).toBe(EVIDENCE_RULES.CANONICAL_UNSUPPORTED_TYPE);
  });

  test('L87: symbol top-level throws CANONICAL_UNSUPPORTED_TYPE', () => {
    let caught: unknown;
    try { canonicalJson(Symbol('x')); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(EvidenceCanonicalError);
    expect((caught as EvidenceCanonicalError).rule).toBe(EVIDENCE_RULES.CANONICAL_UNSUPPORTED_TYPE);
  });

  test('L87: bigint top-level throws CANONICAL_UNSUPPORTED_TYPE', () => {
    let caught: unknown;
    try { canonicalJson(42n); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(EvidenceCanonicalError);
    expect((caught as EvidenceCanonicalError).rule).toBe(EVIDENCE_RULES.CANONICAL_UNSUPPORTED_TYPE);
  });

  // L128: array element checks
  // typeof item === 'function' || typeof item === 'symbol' || typeof item === 'bigint'
  // undefined array slots are ALLOWED (emit null). function/symbol/bigint throw.

  test('L128: function in array element throws with "in array element" message (distinct from top-level L87)', () => {
    // L128 message: `unsupported type ${typeof item} in array element`
    // If L128 check is bypassed, the recursive call falls through to L87 which
    // produces `unsupported type function` WITHOUT "in array element".
    // Asserting the "in array element" text kills both L128 ConditionalExpression
    // and LogicalOperator mutants that short-circuit the OR.
    let caught: unknown;
    try { canonicalJson([1, function noop() {}, 3]); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(EvidenceCanonicalError);
    expect((caught as EvidenceCanonicalError).rule).toBe(EVIDENCE_RULES.CANONICAL_UNSUPPORTED_TYPE);
    expect((caught as EvidenceCanonicalError).path).toBe('[1]');
    expect((caught as EvidenceCanonicalError).message).toContain('function');
    expect((caught as EvidenceCanonicalError).message).toContain('in array element');
  });

  test('L128: symbol in array element throws with "in array element" message', () => {
    let caught: unknown;
    try { canonicalJson([Symbol('s')]); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(EvidenceCanonicalError);
    expect((caught as EvidenceCanonicalError).rule).toBe(EVIDENCE_RULES.CANONICAL_UNSUPPORTED_TYPE);
    expect((caught as EvidenceCanonicalError).path).toBe('[0]');
    expect((caught as EvidenceCanonicalError).message).toContain('in array element');
    expect((caught as EvidenceCanonicalError).message).toContain('symbol');
  });

  test('L128: bigint in array element throws with "in array element" message', () => {
    let caught: unknown;
    try { canonicalJson([1n]); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(EvidenceCanonicalError);
    expect((caught as EvidenceCanonicalError).rule).toBe(EVIDENCE_RULES.CANONICAL_UNSUPPORTED_TYPE);
    expect((caught as EvidenceCanonicalError).path).toBe('[0]');
    expect((caught as EvidenceCanonicalError).message).toContain('bigint');
    expect((caught as EvidenceCanonicalError).message).toContain('in array element');
  });

  test('L128: undefined array element is NOT thrown — emitted as null (branch contrast)', () => {
    // This is NOT the throw branch. Proves the undefined-in-array special case is
    // distinct from function/symbol/bigint.
    expect(canonicalJson([undefined])).toBe('[null]');
  });

  // L153: object value checks
  // typeof v === 'function' || typeof v === 'symbol' || typeof v === 'bigint'

  test('L153: function object value throws with "for property" message (distinct from top-level L87)', () => {
    // L153 message: `unsupported type ${typeof v} for property ${JSON.stringify(k)}`
    // If L153 check is bypassed, recursive call falls through to L87 which
    // produces `unsupported type function` WITHOUT "for property".
    // Asserting "for property" text kills both L153 ConditionalExpression and
    // LogicalOperator mutants.
    let caught: unknown;
    try { canonicalJson({ fn: function noop() {} }); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(EvidenceCanonicalError);
    expect((caught as EvidenceCanonicalError).rule).toBe(EVIDENCE_RULES.CANONICAL_UNSUPPORTED_TYPE);
    expect((caught as EvidenceCanonicalError).path).toBe('fn');
    expect((caught as EvidenceCanonicalError).message).toContain('function');
    expect((caught as EvidenceCanonicalError).message).toContain('for property');
    // The key name is JSON-quoted in the message
    expect((caught as EvidenceCanonicalError).message).toContain('"fn"');
  });

  test('L153: symbol object value throws with "for property" message', () => {
    let caught: unknown;
    try { canonicalJson({ sym: Symbol('s') }); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(EvidenceCanonicalError);
    expect((caught as EvidenceCanonicalError).rule).toBe(EVIDENCE_RULES.CANONICAL_UNSUPPORTED_TYPE);
    expect((caught as EvidenceCanonicalError).path).toBe('sym');
    expect((caught as EvidenceCanonicalError).message).toContain('symbol');
    expect((caught as EvidenceCanonicalError).message).toContain('for property');
    expect((caught as EvidenceCanonicalError).message).toContain('"sym"');
  });

  test('L153: bigint object value throws with "for property" message', () => {
    let caught: unknown;
    try { canonicalJson({ bi: 1n }); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(EvidenceCanonicalError);
    expect((caught as EvidenceCanonicalError).rule).toBe(EVIDENCE_RULES.CANONICAL_UNSUPPORTED_TYPE);
    expect((caught as EvidenceCanonicalError).path).toBe('bi');
    expect((caught as EvidenceCanonicalError).message).toContain('bigint');
    expect((caught as EvidenceCanonicalError).message).toContain('for property');
    expect((caught as EvidenceCanonicalError).message).toContain('"bi"');
  });

  test('L153: undefined object value is OMITTED, not thrown', () => {
    // Proves the undefined-skip path is distinct from the throw path.
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
  });
});

// ---------------------------------------------------------------------------
// Path construction assertions (StringLiteral survivors in path-building
// template literals at L119 and L156).
// ---------------------------------------------------------------------------

describe('canonicalJson: path construction in error messages (StringLiteral killers)', () => {
  test('L119: array child path is `${path}[${i}]` — nested array in object', () => {
    // Path in an array element nested inside an object: "arr[0]"
    try {
      canonicalJson({ arr: [NaN] });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as EvidenceCanonicalError).path).toBe('arr[0]');
    }
  });

  test('L119: top-level array path is `[${i}]` — root-level array', () => {
    try {
      canonicalJson([NaN]);
      throw new Error('should have thrown');
    } catch (e) {
      // path was '' at root, so childPath = '[0]'
      expect((e as EvidenceCanonicalError).path).toBe('[0]');
    }
  });

  test('L156: root-level object key path is just the key name (no leading dot)', () => {
    // When path === '' and we're in an object, childPath = k (not `.k`).
    // Mutant that omits the conditional would produce `.fn` not `fn`.
    try {
      canonicalJson({ fn: function noop() {} });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as EvidenceCanonicalError).path).toBe('fn');
      // No leading dot
      expect((e as EvidenceCanonicalError).path).not.toMatch(/^\./);
    }
  });

  test('L156: nested object key path uses dot separator', () => {
    // When path !== '' and we're in a nested object, childPath = `${path}.${k}`.
    try {
      canonicalJson({ outer: { fn: function noop() {} } });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as EvidenceCanonicalError).path).toBe('outer.fn');
    }
  });

  test('L156: deeply nested path uses multiple dots', () => {
    try {
      canonicalJson({ a: { b: { c: NaN } } });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as EvidenceCanonicalError).path).toBe('a.b.c');
    }
  });
});
