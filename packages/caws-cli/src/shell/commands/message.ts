// `caws message send | poll` — the inter-agent message channel command surface
// (AGENT-MESSAGE-CHANNEL-001). Sessions exchange directed messages addressed by
// session id, over .caws/messages.jsonl (a separate log from the events audit
// chain). The sender is attributed via the resolved session actor; a send to a
// session that is not live in the lease registry is refused.
//
//   message send --to <sid> --text <t>   directed send (refuses non-live recipient)
//   message poll [--me <sid>]            pull next message addressed to me (default
//                                        me = resolved session id)

import {
  pollMessage,
  resolveRepoRoot,
  sendMessage,
  inboxCount,
  inboxMessages,
  channelHistory,
  type MessageActor,
  type MessageRecord,
} from '../../store';
import { buildActor } from '../session/actor';
import { resolveSession } from '../session/resolve-session';
import { renderDiagnostics } from '../render/diagnostic';

interface BaseCommandOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly out?: (line: string) => void;
  readonly err?: (line: string) => void;
  readonly showData?: boolean;
}
function defaults(opts: BaseCommandOptions) {
  return {
    cwd: opts.cwd ?? process.cwd(),
    env: opts.env ?? process.env,
    out: opts.out ?? ((s: string) => process.stdout.write(s + '\n')),
    err: opts.err ?? ((s: string) => process.stderr.write(s + '\n')),
    showData: opts.showData === true,
  };
}

export interface MessageSendCommandOptions extends BaseCommandOptions {
  readonly to: string;
  readonly text: string;
  /** Skip the recipient-liveness check (escape hatch; default false). */
  readonly allowDead?: boolean;
}

/**
 * `caws message send` — send `text` to recipient session `to`.
 * Exit codes: 0 sent, 1 refused (bad recipient / not live / no session), 2 repo error.
 */
export function runMessageSendCommand(opts: MessageSendCommandOptions): number {
  const { cwd, env, out, err, showData } = defaults(opts);

  if (typeof opts.to !== 'string' || opts.to.length === 0) {
    err('caws message send: --to <session_id> is required.');
    return 1;
  }
  if (typeof opts.text !== 'string' || opts.text.length === 0) {
    err('caws message send: --text "<message>" is required and must be non-empty.');
    return 1;
  }

  const rootResult = resolveRepoRoot(cwd);
  if (!rootResult.ok) {
    err('caws message send: failed to resolve repo root.');
    err(renderDiagnostics(rootResult.errors, { showData }));
    return 2;
  }
  const { cawsDir } = rootResult.value;

  const sessionResult = resolveSession({ cawsDir, worktreeRoot: cwd, env, allowMint: true });
  if (!sessionResult.ok) {
    err('caws message send: could not resolve your session identity (who is sending).');
    err(renderDiagnostics(sessionResult.errors, { showData }));
    return 1;
  }
  const actor = buildActor({ session: sessionResult.value, kind: 'agent' }) as MessageActor;

  const sent = sendMessage(cawsDir, {
    actor,
    to: opts.to,
    text: opts.text,
    ...(opts.allowDead === true ? { requireLive: false } : {}),
  });
  if (!sent.ok) {
    err('caws message send: not sent.');
    err(renderDiagnostics(sent.errors, { showData }));
    return 1;
  }
  out(`sent to ${sent.value.to} (id ${sent.value.id}, channel ${sent.value.channel})`);
  return 0;
}

export interface MessagePollCommandOptions extends BaseCommandOptions {
  /** Endpoint to poll for. Defaults to the resolved session id. */
  readonly me?: string;
  /** Emit JSON instead of human text. */
  readonly json?: boolean;
  /** Block up to this many ms for a message before returning (long-poll). */
  readonly waitMs?: number;
  /** Show the next message without consuming it (no delivery record). */
  readonly peek?: boolean;
}

/**
 * `caws message poll` — pull the next undelivered message addressed to me.
 *   --wait <ms>  block up to ms for a message (long-poll)
 *   --peek       show the next message without consuming it
 *   --json       emit JSON ({message, waiting})
 * Exit codes: 0 (message printed OR mailbox empty), 1 no session, 2 repo error.
 */
export function runMessagePollCommand(opts: MessagePollCommandOptions): number {
  const { cwd, env, out, err, showData } = defaults(opts);

  const rootResult = resolveRepoRoot(cwd);
  if (!rootResult.ok) {
    err('caws message poll: failed to resolve repo root.');
    err(renderDiagnostics(rootResult.errors, { showData }));
    return 2;
  }
  const { cawsDir } = rootResult.value;

  let me = opts.me;
  if (typeof me !== 'string' || me.length === 0) {
    const sessionResult = resolveSession({ cawsDir, worktreeRoot: cwd, env, allowMint: true });
    if (!sessionResult.ok) {
      err('caws message poll: no --me given and could not resolve your session id.');
      err(renderDiagnostics(sessionResult.errors, { showData }));
      return 1;
    }
    me = buildActor({ session: sessionResult.value, kind: 'agent' }).session_id ?? '';
    if (me.length === 0) {
      err('caws message poll: resolved session has no session_id; pass --me <id>.');
      return 1;
    }
  }

  const pollOpts: { waitMs?: number; peek?: boolean } = {};
  if (typeof opts.waitMs === 'number' && opts.waitMs > 0) pollOpts.waitMs = opts.waitMs;
  if (opts.peek === true) pollOpts.peek = true;

  const polled = pollMessage(cawsDir, me, pollOpts);
  if (!polled.ok) {
    err('caws message poll: failed to read the message log.');
    err(renderDiagnostics(polled.errors, { showData }));
    return 2;
  }
  const { message } = polled.value;

  // Mailbox depth for triage. On a peek/empty result this tells the agent how
  // many more are waiting; best-effort (a count failure does not fail the poll).
  const countResult = inboxCount(cawsDir, me);
  const waiting = countResult.ok ? countResult.value : null;

  if (opts.json === true) {
    out(JSON.stringify({ message, waiting }));
    return 0;
  }
  if (!message) {
    out('(no messages)');
    return 0;
  }
  const peekTag = opts.peek === true ? ' (peek — not consumed)' : '';
  out(`from ${message.actor.session_id ?? message.actor.id}${peekTag}:`);
  out(message.text);
  // `waiting` is computed AFTER this poll: on a consume it's the post-delivery
  // remainder; on a peek it still includes the message just shown. Report how many
  // others remain, so the threshold differs by one between the two modes.
  if (typeof waiting === 'number') {
    const others = opts.peek === true ? waiting - 1 : waiting;
    if (others > 0) out(`(${others} more message(s) waiting)`);
  }
  return 0;
}

export interface MessageInboxCommandOptions extends BaseCommandOptions {
  /** Endpoint to list. Defaults to the resolved session id. */
  readonly me?: string;
  readonly limit?: number;
  readonly json?: boolean;
}

export interface MessageHistoryCommandOptions extends BaseCommandOptions {
  /** One side of the channel. Defaults to the resolved session id. */
  readonly me?: string;
  /** Other endpoint in the channel. */
  readonly with: string;
  readonly limit?: number;
  readonly json?: boolean;
}

function resolveMe(
  commandName: string,
  cawsDir: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  explicit: string | undefined,
  err: (line: string) => void,
  showData: boolean
): string | null {
  if (typeof explicit === 'string' && explicit.length > 0) return explicit;
  const sessionResult = resolveSession({ cawsDir, worktreeRoot: cwd, env, allowMint: false });
  if (!sessionResult.ok) {
    err(`caws message ${commandName}: no --me given and could not resolve your session id.`);
    err(renderDiagnostics(sessionResult.errors, { showData }));
    return null;
  }
  const me = buildActor({ session: sessionResult.value, kind: 'agent' }).session_id ?? '';
  if (me.length === 0) {
    err(`caws message ${commandName}: resolved session has no session_id; pass --me <id>.`);
    return null;
  }
  return me;
}

function sanitizeLimit(limit: number | undefined): number | undefined {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return undefined;
  return Math.max(0, Math.floor(limit));
}

function renderMessageLine(message: MessageRecord): string {
  return `${message.ts} ${message.actor.session_id ?? message.actor.id} -> ${message.to}: ${message.text}`;
}

export function runMessageInboxCommand(opts: MessageInboxCommandOptions = {}): number {
  const { cwd, env, out, err, showData } = defaults(opts);
  const rootResult = resolveRepoRoot(cwd);
  if (!rootResult.ok) {
    err('caws message inbox: failed to resolve repo root.');
    err(renderDiagnostics(rootResult.errors, { showData }));
    return 2;
  }
  const { cawsDir } = rootResult.value;
  const me = resolveMe('inbox', cawsDir, cwd, env, opts.me, err, showData);
  if (me === null) return 1;

  const limit = sanitizeLimit(opts.limit);
  const result = inboxMessages(cawsDir, me, limit !== undefined ? { limit } : {});
  if (!result.ok) {
    err('caws message inbox: failed to read the message log.');
    err(renderDiagnostics(result.errors, { showData }));
    return 2;
  }

  if (opts.json === true) {
    out(JSON.stringify({
      ok: true,
      read_only: true,
      me,
      waiting: result.value.waiting,
      messages: result.value.messages,
      diagnostics: result.value.diagnostics,
    }));
    return 0;
  }

  out(`Inbox for ${me}: ${result.value.waiting} waiting`);
  if (result.value.messages.length === 0) {
    out('(no messages)');
    return 0;
  }
  for (const message of result.value.messages) out(renderMessageLine(message));
  if (result.value.messages.length < result.value.waiting) {
    out(`(${result.value.waiting - result.value.messages.length} more not shown)`);
  }
  return 0;
}

export function runMessageHistoryCommand(opts: MessageHistoryCommandOptions): number {
  const { cwd, env, out, err, showData } = defaults(opts);
  if (typeof opts.with !== 'string' || opts.with.length === 0) {
    err('caws message history: --with <session_id> is required.');
    return 1;
  }

  const rootResult = resolveRepoRoot(cwd);
  if (!rootResult.ok) {
    err('caws message history: failed to resolve repo root.');
    err(renderDiagnostics(rootResult.errors, { showData }));
    return 2;
  }
  const { cawsDir } = rootResult.value;
  const me = resolveMe('history', cawsDir, cwd, env, opts.me, err, showData);
  if (me === null) return 1;

  const result = channelHistory(cawsDir, me, opts.with);
  if (!result.ok) {
    err('caws message history: failed to read the message log.');
    err(renderDiagnostics(result.errors, { showData }));
    return 2;
  }
  const limit = sanitizeLimit(opts.limit);
  const messages =
    limit !== undefined ? result.value.slice(Math.max(0, result.value.length - limit)) : result.value;
  const channel = [me, opts.with].sort().join('::');

  if (opts.json === true) {
    out(JSON.stringify({
      ok: true,
      read_only: true,
      me,
      with: opts.with,
      channel,
      total: result.value.length,
      messages,
    }));
    return 0;
  }

  out(`History ${channel}: ${result.value.length} message(s)`);
  if (messages.length === 0) {
    out('(no messages)');
    return 0;
  }
  for (const message of messages) out(renderMessageLine(message));
  if (messages.length < result.value.length) {
    out(`(${result.value.length - messages.length} earlier not shown)`);
  }
  return 0;
}
