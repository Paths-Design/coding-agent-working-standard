import type { Diagnostic } from '../diagnostics/types';
import type { Err, Ok, Result } from './types';

/** Wrap a value as Ok. */
export function ok<T>(value: T, warnings?: readonly Diagnostic[]): Ok<T> {
  return warnings && warnings.length > 0 ? { ok: true, value, warnings } : { ok: true, value };
}

/** Wrap one or more diagnostics as Err. */
export function err(errors: Diagnostic | readonly Diagnostic[]): Err {
  const arr = Array.isArray(errors) ? errors : [errors as Diagnostic];
  if (arr.length === 0) {
    throw new Error('err() requires at least one diagnostic; use ok() for success');
  }
  return { ok: false, errors: arr };
}

/** Type guard. */
export function isOk<T>(r: Result<T>): r is Ok<T> {
  return r.ok === true;
}

/** Type guard. */
export function isErr<T>(r: Result<T>): r is Err {
  return r.ok === false;
}
