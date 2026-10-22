/** Which agent context issued a hook invocation, read from its original ingress payload.
 * Claude Code fires a subagent's tool hooks with the parent's session_id plus a
 * top-level agent_id, so the session id alone cannot say whose context a hook
 * result reaches. Only a well-formed object payload without that key is main;
 * a present but invalid agent_id is uncertain, never a fallback to main.
 * agent-heartbeat.sh mirrors this classification for the shell route.
 */
export type ActorContext = 'main' | 'subagent' | 'uncertain';

const AGENT_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

export function actorContext(payload: unknown): ActorContext {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return 'uncertain';
  if (!Object.prototype.hasOwnProperty.call(payload, 'agent_id')) return 'main';
  const id = (payload as Readonly<Record<string, unknown>>).agent_id;
  return typeof id === 'string' && AGENT_ID.test(id) ? 'subagent' : 'uncertain';
}

/** Classifies the original hook input text rather than its normalized payload: the
 * runtime admits empty input as payload {}, which must not read as a main-thread object.
 */
export function ingressActorContext(inputJson: unknown): ActorContext {
  if (typeof inputJson !== 'string' || inputJson === '') return 'uncertain';
  try {
    return actorContext(JSON.parse(inputJson));
  } catch {
    return 'uncertain';
  }
}
