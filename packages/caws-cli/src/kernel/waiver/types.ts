// Waiver types.
//
// A waiver is a bounded exception record. It does NOT override policy
// (policy still owns block/warn/skip). It only marks specific gate
// violations as authorized exceptions so they do not contribute to the
// command's final blocking decision.
//
// Stored status: 'active' | 'revoked'.
//
// "Expired" is NOT a stored status. Expiry is DERIVED from
// `expires_at` + the current time. Storing 'expired' would create a
// lifecycle race where a waiver must be rewritten just because time
// passed; instead, applicability is evaluated at consult time.
//
// `scope.paths` is intentionally absent from this slice. Path-aware
// waivering is deferred to a future slice rather than half-implemented
// here.

export type WaiverStatus = 'active' | 'revoked';

export interface WaiverScope {
  /**
   * Limit the waiver to a specific spec id. When omitted, the waiver
   * applies to all specs. The gates command checks `--spec` against
   * this field as part of effectiveWaiversForGate.
   */
  readonly spec_id?: string;
}

export interface WaiverConstraints {
  /**
   * Optional max-uses constraint. The kernel does NOT enforce this —
   * usage counting requires runtime state. The field is preserved on
   * load/write for future runtime evaluation; doctor may flag waivers
   * that have hit their cap once usage tracking exists.
   */
  readonly max_uses?: number;
}

export interface WaiverRevocation {
  readonly revoked_at: string;
  readonly revoked_by?: string;
  readonly reason?: string;
}

export interface Waiver {
  readonly id: string;
  readonly title: string;
  readonly status: WaiverStatus;
  /** Gate ids this waiver covers. Non-empty. */
  readonly gates: readonly string[];
  readonly reason: string;
  readonly approved_by: string;
  readonly created_at: string;
  readonly expires_at: string;
  readonly scope?: WaiverScope;
  readonly constraints?: WaiverConstraints;
  /** Present iff status === 'revoked'. Append-only audit. */
  readonly revocation?: WaiverRevocation;
}

/** Derived classification used by renderers and doctor. */
export type WaiverEffectiveness =
  | 'active'
  | 'revoked'
  | 'expired'
  | 'not_applicable';
