// Pack registry. Maps `--agent-surface <id>` to a `HookPackV1` manifest.
//
// v11.1 ships only the `claude-code` pack. `cursor` and `windsurf` are
// recognized as values but resolution returns a "declared but not
// implemented" diagnostic — the abstraction is in place so adding a
// new pack is purely additive (drop a manifest, register it here).

import type { AgentSurface, HookPackV1 } from './types';
import { CLAUDE_CODE_PACK } from './manifest-claude-code';

export type PackResolution =
  | { readonly kind: 'pack'; readonly pack: HookPackV1 }
  | { readonly kind: 'none' }
  | {
      readonly kind: 'declared_not_implemented';
      readonly surface: Exclude<AgentSurface, 'none'>;
    };

/** Resolve a requested surface to a pack manifest. */
export function resolveHookPack(surface: AgentSurface): PackResolution {
  if (surface === 'none') {
    return { kind: 'none' };
  }
  if (surface === 'claude-code') {
    return { kind: 'pack', pack: CLAUDE_CODE_PACK };
  }
  // cursor / windsurf: recognized but not yet implemented.
  return { kind: 'declared_not_implemented', surface };
}

/** Full list of surfaces this CLI version recognizes (for help text and
 *  validation). */
export const KNOWN_SURFACES: readonly AgentSurface[] = [
  'claude-code',
  'cursor',
  'windsurf',
  'none',
];

/** Surfaces that have a fully-implemented pack in this CLI version. */
export const IMPLEMENTED_SURFACES: readonly AgentSurface[] = ['claude-code'];

export function isKnownSurface(value: string): value is AgentSurface {
  return (KNOWN_SURFACES as readonly string[]).includes(value);
}
