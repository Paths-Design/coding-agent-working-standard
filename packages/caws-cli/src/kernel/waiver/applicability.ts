// Waiver applicability — pure functions answering "is this waiver
// effective right now for this gate/spec?"
//
// The kernel does not consult the filesystem and does not read
// process time directly. All time inputs are passed by the caller.

import type { Waiver, WaiverEffectiveness } from './types';

/**
 * Classify a single waiver in isolation. Returns:
 *
 *   - 'active'         : usable for filtering
 *   - 'revoked'        : status === 'revoked'
 *   - 'expired'        : status === 'active' but expires_at <= now
 *   - 'not_applicable' : a future shape (max_uses exhausted etc.)
 *
 * "Expired" is purely derived; the stored status remains 'active'.
 */
export function waiverEffectiveness(waiver: Waiver, now: Date): WaiverEffectiveness {
  if (waiver.status === 'revoked') return 'revoked';
  const expiresAt = Date.parse(waiver.expires_at);
  if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) return 'expired';
  return 'active';
}

export interface EffectiveWaiversInput {
  readonly waivers: readonly Waiver[];
  readonly gate: string;
  /**
   * When supplied, narrows applicability to waivers whose `scope.spec_id`
   * is either absent (project-wide) or matches this id. When omitted,
   * scope.spec_id filtering is bypassed.
   */
  readonly specId?: string;
  readonly now: Date;
}

/**
 * Return the subset of waivers that are currently effective for the
 * given gate and (optional) spec id. A waiver is effective iff:
 *
 *   - waiverEffectiveness(w, now) === 'active'
 *   - w.gates includes `gate`
 *   - w.scope.spec_id is absent, OR equals input.specId
 *
 * `scope.paths` is intentionally NOT consulted in this slice. Path-aware
 * waivering belongs to a later slice; doing it half-way here would lead
 * to silent over- or under-application.
 */
export function effectiveWaiversForGate(
  input: EffectiveWaiversInput
): readonly Waiver[] {
  const out: Waiver[] = [];
  for (const w of input.waivers) {
    if (waiverEffectiveness(w, input.now) !== 'active') continue;
    if (!w.gates.includes(input.gate)) continue;
    if (w.scope?.spec_id !== undefined) {
      if (input.specId === undefined) continue;
      if (w.scope.spec_id !== input.specId) continue;
    }
    out.push(w);
  }
  return out;
}
