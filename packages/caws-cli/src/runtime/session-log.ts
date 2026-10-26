/** Ordinary lossless log consumer for an independently validated committed generation. */
import { TextDecoder } from 'node:util';
import {
  getMember,
  isJsonObject,
  parsePythonJson,
  type JsonObject,
} from '../transcripts/lossless-json';
import { isCommittedSession, type CommittedSession } from './committed-session-reader';
import { RuntimeProtocolError } from './protocol';
import type {
  SessionPublicationConsumer,
  SessionPublicationConsumption,
} from './session-publication-client';

export interface CommittedSessionLogJson {
  readonly name: string;
  readonly json: string;
  readonly value: JsonObject;
}
export interface CommittedSessionLog {
  readonly canonicalRoot: string;
  readonly sessionId: string;
  readonly terminalDigest: string;
  readonly metadata: CommittedSessionLogJson | undefined;
  readonly index: CommittedSessionLogJson | undefined;
  readonly turns: readonly CommittedSessionLogJson[];
  readonly spills: readonly CommittedSessionLogJson[];
  readonly projectionJsonl: string | undefined;
}

// Bound recursive parsing before the lossless Python-compatible JSON decoder.
// Number lexemes, including the sealed 4300-digit count, are never JS numbers.
function objectJson(
  name: string,
  json: string,
  budget: { remaining: number }
): CommittedSessionLogJson {
  let depth = 0,
    quoted = false,
    escaped = false,
    bare = false,
    tokens = 0;
  for (const char of json) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') {
      quoted = true;
      bare = false;
      tokens++;
    } else if (char === '{' || char === '[') {
      if (++depth > 128) throw new RuntimeProtocolError('Session log JSON depth bound');
      bare = false;
      tokens++;
    } else if (char === '}' || char === ']') {
      depth--;
      bare = false;
    } else if (/[: ,\t\r\n]/.test(char)) bare = false;
    else if (!bare) {
      bare = true;
      tokens++;
    }
    if (tokens > budget.remaining) throw new RuntimeProtocolError('Session log JSON token bound');
  }
  budget.remaining -= tokens;
  const value = parsePythonJson(json);
  if (!isJsonObject(value))
    throw new RuntimeProtocolError('Session log artifact must be an object');
  return Object.freeze({ name, json, value });
}

/** Consume exact log semantics without rounding counts, rewriting unrelated
 * metadata, sorting model arrays, or pretending a refusal published a log. */
export function readCommittedSessionLog(session: CommittedSession): CommittedSessionLog {
  if (!isCommittedSession(session)) throw new RuntimeProtocolError('Unvalidated committed session');
  let metadata: CommittedSessionLogJson | undefined, index: CommittedSessionLogJson | undefined;
  let projectionJsonl: string | undefined;
  const turns: CommittedSessionLogJson[] = [],
    spills: CommittedSessionLogJson[] = [];
  const budget = { remaining: 200_000 };
  for (const artifact of session.artifacts) {
    const json = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      session.bytes(artifact.name)
    );
    if (artifact.role === 'projection') {
      projectionJsonl = json;
      continue;
    }
    const parsed = objectJson(artifact.name, json, budget);
    if (artifact.role === 'metadata') metadata = parsed;
    else if (artifact.role === 'index') {
      const selected = getMember(parsed.value, 'session_id');
      if (selected !== undefined && selected !== session.sessionId)
        throw new RuntimeProtocolError('Session log index belongs to another session');
      index = parsed;
    } else if (artifact.role === 'turn') turns.push(parsed);
    else if (artifact.role === 'spill') spills.push(parsed);
  }
  return Object.freeze({
    canonicalRoot: session.canonicalRoot,
    sessionId: session.sessionId,
    terminalDigest: session.terminalDigest,
    metadata,
    index,
    turns: Object.freeze(turns),
    spills: Object.freeze(spills),
    projectionJsonl,
  });
}

/** Root's stock-handler route supplies the actual selected consumer. Both
 * callbacks are explicit; non-publication cannot flow through published success. */
export function createSessionLogPublicationConsumer(options: {
  readonly published: (
    log: CommittedSessionLog,
    outcome: Extract<SessionPublicationConsumption, { status: 'published' }>
  ) => void | Promise<void>;
  readonly notPublished: (
    outcome: Extract<SessionPublicationConsumption, { status: 'not_published' }>
  ) => void | Promise<void>;
}): SessionPublicationConsumer {
  if (typeof options.published !== 'function' || typeof options.notPublished !== 'function')
    throw new RuntimeProtocolError('Session log requires explicit outcome consumers');
  return async (outcome) => {
    if (outcome.status === 'not_published') await options.notPublished(outcome);
    else await options.published(readCommittedSessionLog(outcome.session), outcome);
  };
}
