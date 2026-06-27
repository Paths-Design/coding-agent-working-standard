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
  type MessageActor,
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
