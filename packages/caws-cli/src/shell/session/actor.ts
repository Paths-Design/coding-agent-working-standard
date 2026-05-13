// buildActor — assemble a kernel `Actor` envelope from the shell's resolved
// session identity and a caller-supplied (`kind`, `id`).
//
// The shell does NOT decide actor kind on its own. The caller (a command
// handler) supplies the kind matching the command's intent:
//
//   - `agent`:      a CAWS-driving AI agent (default for shell commands)
//   - `human`:      a person at a terminal
//   - `automation`: a CI runner, scheduled task, or git hook
//   - `system`:     emitted by CAWS itself with no external actor (rare;
//                   reserved for self-initiated bookkeeping events)
//
// Identity precedence:
//   - `actor.id` defaults to the resolved `session.identity.session_id`.
//     A caller may pass an override for `kind: 'human'` invocations
//     (e.g., a real username from $USER), but the default is the session id.
//   - `actor.session_id` always mirrors the resolved session.
//   - `actor.platform` always mirrors the resolved session.

import type { Actor, ActorKind } from '@paths.design/caws-kernel';
import type { ResolvedSession } from './types';

export interface BuildActorOptions {
  readonly session: ResolvedSession;
  readonly kind: ActorKind;
  /**
   * Override `actor.id`. Defaults to `session.identity.session_id`.
   * Useful when `kind` is `'human'` and the caller has a meaningful
   * username to attribute work to.
   */
  readonly id?: string;
}

export function buildActor(opts: BuildActorOptions): Actor {
  const id = opts.id ?? opts.session.identity.session_id;
  const actor: Actor = {
    kind: opts.kind,
    id,
    session_id: opts.session.identity.session_id,
  };
  if (opts.session.identity.platform !== undefined) {
    return { ...actor, platform: opts.session.identity.platform };
  }
  return actor;
}
