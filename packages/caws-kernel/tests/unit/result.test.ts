import { ok, err, isOk, isErr, map, flatMap, all } from '../../src/result';
import { diagnostic } from '../../src/diagnostics';

const dx = diagnostic({
  rule: 'test/rule',
  authority: 'kernel/diagnostics',
  message: 'test diagnostic',
});

describe('Result', () => {
  describe('ok / err / type guards', () => {
    it('ok wraps a value', () => {
      const r = ok(42);
      expect(r.ok).toBe(true);
      if (isOk(r)) {
        expect(r.value).toBe(42);
        expect(r.warnings).toBeUndefined();
      }
    });

    it('ok preserves warnings when provided', () => {
      const r = ok(42, [dx]);
      if (isOk(r)) {
        expect(r.warnings).toEqual([dx]);
      }
    });

    it('ok omits warnings when array is empty', () => {
      const r = ok(42, []);
      if (isOk(r)) {
        expect(r.warnings).toBeUndefined();
      }
    });

    it('err wraps a single diagnostic', () => {
      const r = err(dx);
      expect(r.ok).toBe(false);
      if (isErr(r)) {
        expect(r.errors).toEqual([dx]);
      }
    });

    it('err wraps an array of diagnostics', () => {
      const r = err([dx, dx]);
      if (isErr(r)) {
        expect(r.errors.length).toBe(2);
      }
    });

    it('err refuses an empty diagnostic array', () => {
      expect(() => err([])).toThrow();
    });
  });

  describe('combinators', () => {
    it('map transforms Ok values', () => {
      const r = map(ok(2), (n) => n * 3);
      if (isOk(r)) expect(r.value).toBe(6);
    });

    it('map passes Err through unchanged', () => {
      const r = map(err(dx) as ReturnType<typeof ok<number>>, (n) => n * 3);
      expect(r.ok).toBe(false);
    });

    it('flatMap chains Result-returning functions', () => {
      const r = flatMap(ok(2), (n) => ok(n + 1));
      if (isOk(r)) expect(r.value).toBe(3);
    });

    it('flatMap forwards warnings from the first stage to a successful second stage', () => {
      const r = flatMap(ok(2, [dx]), (n) => ok(n + 1));
      if (isOk(r)) {
        expect(r.warnings?.length).toBe(1);
      }
    });

    it('flatMap concatenates first-stage warnings into Err errors when the second stage fails', () => {
      const r = flatMap(ok(2, [dx]), () => err(dx));
      if (isErr(r)) {
        expect(r.errors.length).toBe(2);
      }
    });

    it('all returns Ok of array when every input is Ok', () => {
      const r = all([ok(1), ok(2), ok(3)]);
      if (isOk(r)) expect(r.value).toEqual([1, 2, 3]);
    });

    it('all collects errors from every Err input', () => {
      const r = all([ok(1), err(dx), err(dx)]);
      if (isErr(r)) expect(r.errors.length).toBe(2);
    });

    it('all aggregates warnings across Ok inputs', () => {
      const r = all([ok(1, [dx]), ok(2), ok(3, [dx])]);
      if (isOk(r)) expect(r.warnings?.length).toBe(2);
    });
  });
});

describe('Diagnostic', () => {
  it('diagnostic() defaults severity to "error"', () => {
    const d = diagnostic({
      rule: 'r',
      authority: 'kernel/diagnostics',
      message: 'm',
    });
    expect(d.severity).toBe('error');
  });

  it('diagnostic() preserves an explicit severity', () => {
    const d = diagnostic({
      rule: 'r',
      authority: 'kernel/diagnostics',
      message: 'm',
      severity: 'warning',
    });
    expect(d.severity).toBe('warning');
  });
});
