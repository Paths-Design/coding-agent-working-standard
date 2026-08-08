import type { Diagnostic } from '../diagnostics/types';
import { err, ok } from './construct';
import type { Result } from './types';

/** Map an Ok value through a pure function; pass Err through unchanged. */
export function map<T, U>(r: Result<T>, fn: (value: T) => U): Result<U> {
  if (r.ok) return ok(fn(r.value), r.warnings);
  return r;
}

/**
 * Chain a Result-returning function.
 *
 * Warning-propagation contract:
 *  - First stage Ok + second stage Ok  → warnings from both are concatenated
 *    into the returned Ok's `warnings` (severities preserved as-authored).
 *  - First stage Ok + second stage Err → upstream warnings are carried forward
 *    into the returned Err's `errors` array, **with their original severity
 *    intact**. A warning from the first stage stays severity:'warning' even
 *    when it sits next to severity:'error' diagnostics from the failing
 *    second stage. This means an Err's `errors` may contain a mix of
 *    severities; consumers that distinguish errors from warnings should
 *    inspect Diagnostic.severity rather than rely on container shape.
 *  - First stage Err → second stage is not invoked; first-stage Err returned
 *    unchanged.
 */
export function flatMap<T, U>(r: Result<T>, fn: (value: T) => Result<U>): Result<U> {
  if (!r.ok) return r;
  const next = fn(r.value);
  if (!next.ok) {
    if (r.warnings && r.warnings.length > 0) {
      // Severity-preserving: warnings keep their authored severity in the
      // concatenated diagnostic list. We do NOT promote them to 'error'.
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
