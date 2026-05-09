import {
  EVIDENCE_RULES,
  EvidenceCanonicalError,
  canonicalJson,
} from '../../src/evidence';

describe('canonicalJson — primitives', () => {
  it('serializes null', () => {
    expect(canonicalJson(null)).toBe('null');
  });

  it('serializes booleans', () => {
    expect(canonicalJson(true)).toBe('true');
    expect(canonicalJson(false)).toBe('false');
  });

  it('serializes finite numbers', () => {
    expect(canonicalJson(0)).toBe('0');
    expect(canonicalJson(1)).toBe('1');
    expect(canonicalJson(-1)).toBe('-1');
    expect(canonicalJson(1.5)).toBe('1.5');
    expect(canonicalJson(-0)).toBe('0'); // JSON.stringify normalizes -0 to 0
  });

  it('serializes strings with proper JSON escaping', () => {
    expect(canonicalJson('hello')).toBe('"hello"');
    expect(canonicalJson('a\nb')).toBe('"a\\nb"');
    expect(canonicalJson('"quoted"')).toBe('"\\"quoted\\""');
    expect(canonicalJson('')).toBe('""');
  });

  it('escapes control characters per JSON.stringify rules', () => {
    const ctl = String.fromCharCode(1);
    expect(canonicalJson(ctl)).toBe('"\\u0001"');
  });

  it('rejects NaN with non_finite_number rule', () => {
    expect.assertions(2);
    try {
      canonicalJson(NaN);
    } catch (e) {
      expect(e).toBeInstanceOf(EvidenceCanonicalError);
      expect((e as EvidenceCanonicalError).rule).toBe(EVIDENCE_RULES.CANONICAL_NON_FINITE_NUMBER);
    }
  });

  it('rejects Infinity', () => {
    expect(() => canonicalJson(Infinity)).toThrow(EvidenceCanonicalError);
  });

  it('rejects -Infinity', () => {
    expect(() => canonicalJson(-Infinity)).toThrow(EvidenceCanonicalError);
  });

  it('rejects functions at top level', () => {
    expect.assertions(2);
    try {
      canonicalJson(() => 1);
    } catch (e) {
      expect(e).toBeInstanceOf(EvidenceCanonicalError);
      expect((e as EvidenceCanonicalError).rule).toBe(EVIDENCE_RULES.CANONICAL_UNSUPPORTED_TYPE);
    }
  });

  it('rejects symbols at top level', () => {
    expect(() => canonicalJson(Symbol('x'))).toThrow(EvidenceCanonicalError);
  });

  it('rejects undefined at top level', () => {
    expect(() => canonicalJson(undefined)).toThrow(EvidenceCanonicalError);
  });

  it('rejects bigint at top level', () => {
    expect(() => canonicalJson(BigInt(1))).toThrow(EvidenceCanonicalError);
  });
});

describe('canonicalJson — arrays', () => {
  it('serializes empty array', () => {
    expect(canonicalJson([])).toBe('[]');
  });

  it('serializes nested array', () => {
    expect(canonicalJson([1, [2, 3], 4])).toBe('[1,[2,3],4]');
  });

  it('preserves array length by emitting null for undefined elements', () => {
    // Same semantics as JSON.stringify for arrays.
    expect(canonicalJson([1, undefined, 3])).toBe('[1,null,3]');
  });

  it('rejects functions in array elements', () => {
    expect(() => canonicalJson([1, () => 2, 3])).toThrow(EvidenceCanonicalError);
  });

  it('rejects symbols in array elements', () => {
    expect(() => canonicalJson([Symbol('x')])).toThrow(EvidenceCanonicalError);
  });
});

describe('canonicalJson — objects (key sorting + omitting undefined)', () => {
  it('serializes empty object', () => {
    expect(canonicalJson({})).toBe('{}');
  });

  it('sorts keys lexicographically', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ z: 1, m: 2, a: 3 })).toBe('{"a":3,"m":2,"z":1}');
  });

  it('produces identical output for differently-ordered equal objects', () => {
    const a = { x: 1, y: 2, z: 3 };
    const b = { z: 3, x: 1, y: 2 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it('omits properties whose value is undefined', () => {
    // Critical for spec_id absence vs spec_id: null distinction.
    expect(canonicalJson({ a: 1, b: undefined, c: 2 })).toBe('{"a":1,"c":2}');
  });

  it('preserves null vs undefined distinction', () => {
    expect(canonicalJson({ a: null })).toBe('{"a":null}');
    expect(canonicalJson({ a: undefined })).toBe('{}');
  });

  it('handles nested objects with key sorting', () => {
    expect(canonicalJson({ outer: { z: 1, a: 2 } })).toBe('{"outer":{"a":2,"z":1}}');
  });

  it('rejects function-valued object properties', () => {
    expect(() => canonicalJson({ a: 1, b: () => 2 })).toThrow(EvidenceCanonicalError);
  });
});

describe('canonicalJson — circular references', () => {
  it('throws with circular_reference rule on direct self-reference', () => {
    const a: { self?: unknown } = {};
    a.self = a;
    expect.assertions(2);
    try {
      canonicalJson(a);
    } catch (e) {
      expect(e).toBeInstanceOf(EvidenceCanonicalError);
      expect((e as EvidenceCanonicalError).rule).toBe(EVIDENCE_RULES.CANONICAL_CIRCULAR_REFERENCE);
    }
  });

  it('throws on indirect cycle (a → b → a)', () => {
    const a: { b?: unknown } = {};
    const b: { a?: unknown } = { a };
    a.b = b;
    expect(() => canonicalJson(a)).toThrow(EvidenceCanonicalError);
  });

  it('handles diamond reference (same object referenced twice without cycle)', () => {
    const shared = { value: 1 };
    const top = { left: shared, right: shared };
    expect(canonicalJson(top)).toBe('{"left":{"value":1},"right":{"value":1}}');
  });
});

describe('canonicalJson — determinism (golden fixtures)', () => {
  it('hashes the same regardless of key insertion order', () => {
    const a = { event: 'spec_created', ts: '2026-05-08T00:00:00Z', data: { x: 1 } };
    const b = { data: { x: 1 }, ts: '2026-05-08T00:00:00Z', event: 'spec_created' };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it('produces no whitespace', () => {
    const out = canonicalJson({ a: 1, b: 2 });
    expect(out).not.toMatch(/\s/);
  });
});
