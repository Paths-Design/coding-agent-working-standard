import { basename } from 'node:path';
import { SURFACE_PIN_VARS, type AgentSurface } from '../init/hook-packs/surfaces.generated';
import type { RuntimeRequest } from './protocol';

export interface ObservedAgentProcess {
  readonly pid: number;
  readonly startEpoch: number | null;
}
export interface InvocationIdentity {
  readonly sessionId: string | null;
  readonly diagnostic: string;
}

/** Latest hook precedence, distinct from the interactive CLI's broader resolver. */
export function environmentHookIdentity(
  payload: Readonly<Record<string, unknown>>,
  environment: Readonly<Record<string, string>>,
  surface: AgentSurface
): string | null {
  const valid = (value: unknown): value is string =>
    typeof value === 'string' && value.length > 0 && value !== 'unknown';
  if (valid(payload.session_id)) return payload.session_id;
  const pin = SURFACE_PIN_VARS[surface];
  if (pin && valid(environment[pin])) return environment[pin] as string;
  if (valid(environment.CAWS_SESSION_ID)) return environment.CAWS_SESSION_ID;
  for (const name of [
    'CLAUDE_SESSION_ID',
    'CLAUDE_CODE_SESSION_ID',
    'CODEX_THREAD_ID',
    'QWEN_CODE_SESSION_ID',
    'DSH_SESSION_ID',
    'CURSOR_TRACE_ID',
  ]) {
    if (valid(environment[name])) return environment[name] as string;
  }
  return null;
}

/** Parse only observations from the request client's ancestor chain. */
export function locateRequestAgent(
  snapshot: string,
  processId: number,
  names: readonly string[]
): ObservedAgentProcess | null {
  const rows = new Map<number, { parent: number; name: string; startEpoch: number | null }>();
  for (const line of snapshot.split('\n')) {
    const match =
      /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+?)\s*$/.exec(
        line
      );
    if (!match) continue;
    const stamp = Date.parse(match[3] + ' UTC');
    rows.set(Number(match[1]), {
      parent: Number(match[2]),
      name: basename(match[4] ?? ''),
      startEpoch: Number.isFinite(stamp) ? Math.floor(stamp / 1000) : null,
    });
  }
  let pid = processId;
  const visited = new Set<number>();
  for (let hop = 0; hop < 16 && pid > 1 && !visited.has(pid); hop++) {
    visited.add(pid);
    const row = rows.get(pid);
    if (!row) return null;
    if (names.includes(row.name)) return { pid, startEpoch: row.startEpoch };
    pid = row.parent;
  }
  return null;
}

/** A shared backend process cannot select or refute a logical request identity.
 * PID caches are deliberately excluded from this adapter, including recovery
 * when the request has no identity. The broader CLI resolver is unchanged.
 */
export function resolveInvocationIdentity(
  request: RuntimeRequest,
  signal: AbortSignal
): InvocationIdentity {
  if (signal.aborted) throw signal.reason;
  const candidate = environmentHookIdentity(
    request.payload,
    request.caller.environment,
    request.surface
  );
  return Object.freeze({
    sessionId: candidate,
    diagnostic: '',
  });
}
