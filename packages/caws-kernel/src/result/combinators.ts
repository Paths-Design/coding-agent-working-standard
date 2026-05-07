import type { Diagnostic } from '../diagnostics/types';
import { err, ok } from './construct';
import type { Result } from './types';

/** Map an Ok value through a pure function; pass Err through unchanged. */
export function map<T, U>(r: Result<T>, fn: (value: T) => U): Result<U> {
  if (r.ok) return ok(fn(r.value), r.warnings);
  return r;
}

/**
 * Chain a Result-returning function. Warnings from the first stage are
 * forwarded into the second stage's result.
 */
export function flatMap<T, U>(r: Result<T>, fn: (value: T) => Result<U>): Result<U> {
  if (!r.ok) return r;
  const next = fn(r.value);
  if (!next.ok) {
    if (r.warnings && r.warnings.length > 0) {
      return { ok: false, errors: [...r.warnings, ...next.errors] };
    }
    return next;
  }
  const mergedWarnings = mergeWarnings(r.warnings, next.warnings);
  return ok(next.value, mergedWarnings);
}

/**
 * Combine independent Results. If any fails, returns Err with all errors
 * concatenated. If all succeed, returns Ok with array of values.
 */
export function all<T>(results: readonly Result<T>[]): Result<readonly T[]> {
  const errors: Diagnostic[] = [];
  const warnings: Diagnostic[] = [];
  const values: T[] = [];
  for (const r of results) {
    if (r.ok) {
      values.push(r.value);
      if (r.warnings) warnings.push(...r.warnings);
    } else {
      errors.push(...r.errors);
    }
  }
  if (errors.length > 0) return err(errors);
  return ok(values, warnings.length > 0 ? warnings : undefined);
}

function mergeWarnings(
  a: readonly Diagnostic[] | undefined,
  b: readonly Diagnostic[] | undefined,
): readonly Diagnostic[] | undefined {
  if (!a || a.length === 0) return b;
  if (!b || b.length === 0) return a;
  return [...a, ...b];
}
