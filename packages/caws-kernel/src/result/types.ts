import type { Diagnostic } from '../diagnostics/types';

/**
 * Result<T> — every kernel public function returns one of these.
 *
 * Validation/contract failures return Err with structured Diagnostic[].
 * Programmer errors (impossible-by-contract inputs) throw.
 */
export type Result<T> = Ok<T> | Err;

export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
  /** Non-fatal diagnostics that did not block the operation. */
  readonly warnings?: readonly Diagnostic[];
}

export interface Err {
  readonly ok: false;
  readonly errors: readonly Diagnostic[];
}
