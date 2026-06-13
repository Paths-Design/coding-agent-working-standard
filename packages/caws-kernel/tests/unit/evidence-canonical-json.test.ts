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
