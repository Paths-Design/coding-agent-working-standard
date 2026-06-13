/**
 * Unit tests for the kernel Result type + combinators (A6).
 *
 * CAWS-TEST-KERNEL-PURE-001. These assert the ACTUAL discrimination and the
 * ACTUAL warning-propagation contract documented in combinators.ts, so a
 * mutation that inverts ok/err or drops warning propagation is killed — not
 * structure checks, not mocks.
 */

import { ok, err, isOk, isErr } from '../../src/result/construct';
import { map, flatMap, all } from '../../src/result/combinators';
import type { Diagnostic } from '../../src/diagnostics/types';

const warn = (rule: string): Diagnostic => ({
  severity: 'warning',
  rule,
  message: `w:${rule}`,
  authority: 'kernel/diagnostics',
});
const fail = (rule: string): Diagnostic => ({
  severity: 'error',
  rule,
  message: `e:${rule}`,
  authority: 'kernel/diagnostics',
});

describe('result/construct', () => {
  test('ok wraps a value and discriminates as ok', () => {
    const r = ok(42);
    expect(r.ok).toBe(true);
    expect(isOk(r)).toBe(true);
    expect(isErr(r)).toBe(false);
    if (isOk(r)) expect(r.value).toBe(42);
  });

  test('ok omits warnings when none/empty (absent vs empty distinction)', () => {
    expect(ok(1)).not.toHaveProperty('warnings');
    expect(ok(1, [])).not.toHaveProperty('warnings');
    const r = ok(1, [warn('a')]);
    expect(r.warnings).toHaveLength(1);
  });

  test('err wraps diagnostics and discriminates as err', () => {
    const r = err(fail('x'));
    expect(r.ok).toBe(false);
    expect(isErr(r)).toBe(true);
    expect(isOk(r)).toBe(false);
    if (isErr(r)) {
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0]!.rule).toBe('x');
    }
  });

  test('err accepts a single diagnostic OR an array, both normalized to array', () => {
    const single = err(fail('one'));
    const arr = err([fail('one'), fail('two')]);
    if (isErr(single)) expect(single.errors.map((e) => e.rule)).toEqual(['one']);
    if (isErr(arr)) expect(arr.errors.map((e) => e.rule)).toEqual(['one', 'two']);
  });

  test('err THROWS on empty diagnostics (cannot represent failure with no reason)', () => {
    expect(() => err([])).toThrow(/at least one diagnostic/);
  });
});

describe('result/combinators: map', () => {
  test('maps an Ok value through the function', () => {
    const r = map(ok(2), (n) => n * 10);
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value).toBe(20);
  });

  test('passes Err through WITHOUT invoking the mapper', () => {
    const mapper = jest.fn((n: number) => n + 1);
    const r = map(err(fail('boom')), mapper);
    expect(isErr(r)).toBe(true);
    expect(mapper).not.toHaveBeenCalled();
  });

  test('preserves warnings across map', () => {
    const r = map(ok(1, [warn('keep')]), (n) => n + 1);
    if (isOk(r)) expect(r.warnings?.map((w) => w.rule)).toEqual(['keep']);
  });
});

describe('result/combinators: flatMap', () => {
  test('Ok -> Ok concatenates warnings from both stages', () => {
    const r = flatMap(ok(1, [warn('a')]), (n) => ok(n + 1, [warn('b')]));
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value).toBe(2);
      expect(r.warnings?.map((w) => w.rule)).toEqual(['a', 'b']);
    }
  });

  test('Ok -> Err carries upstream warnings into errors WITH original severity', () => {
    const r = flatMap(ok(1, [warn('upstream')]), () => err(fail('downstream')));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      // The contract: upstream warning is preserved, NOT promoted to error.
      expect(r.errors.map((e) => `${e.severity}:${e.rule}`)).toEqual([
        'warning:upstream',
        'error:downstream',
      ]);
    }
  });

  test('Err short-circuits: second stage is never invoked', () => {
    const second = jest.fn(() => ok(99));
    const r = flatMap(err(fail('stop')), second);
    expect(isErr(r)).toBe(true);
    expect(second).not.toHaveBeenCalled();
    if (isErr(r)) expect(r.errors[0]!.rule).toBe('stop');
  });

  test('Ok (no warnings) -> Err returns the downstream Err unchanged', () => {
    const r = flatMap(ok(1), () => err(fail('only')));
    if (isErr(r)) expect(r.errors.map((e) => e.rule)).toEqual(['only']);
  });
});

describe('result/combinators: all', () => {
  test('all Ok -> Ok with array of values in order', () => {
    const r = all([ok(1), ok(2), ok(3)]);
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value).toEqual([1, 2, 3]);
  });

  test('any Err -> Err with ALL errors concatenated (not just the first)', () => {
    const r = all([ok(1), err(fail('e1')), ok(3), err(fail('e2'))]);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.errors.map((e) => e.rule)).toEqual(['e1', 'e2']);
  });

  test('all Ok collects warnings from every element', () => {
    const r = all([ok(1, [warn('w1')]), ok(2, [warn('w2')])]);
    if (isOk(r)) expect(r.warnings?.map((w) => w.rule)).toEqual(['w1', 'w2']);
  });

  test('empty input -> Ok with empty value array', () => {
    const r = all([]);
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value).toEqual([]);
  });
});
