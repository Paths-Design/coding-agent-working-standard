import type { Diagnostic } from '../kernel';
import {
  inboxCount,
  mineQueued,
  pollMessage,
  type PollOptions,
  type PollResult,
} from '../store/messages-store';

export interface MessagePollApplicationInput {
  readonly cawsDir: string;
  readonly recipient: string;
  readonly options?: PollOptions;
  /** Measures the primary poll only; store ordering/expiry remain canonical. */
  readonly nowMs: () => number;
}
export interface MessagePollApplicationPayload {
  readonly message: PollResult['message'];
  readonly sender?: NonNullable<PollResult['sender']>;
  readonly messages: PollResult['messages'];
  readonly offer?: NonNullable<PollResult['offer']>;
  readonly waiting: number | null;
  readonly poll_ms: number;
  readonly mine_queued_1h: {
    readonly count: number;
    readonly oldest_age_ms: number | null;
  };
}
export type MessagePollApplicationResult =
  | { readonly ok: true; readonly value: MessagePollApplicationPayload }
  | { readonly ok: false; readonly stage: 'poll'; readonly errors: ReadonlyArray<Diagnostic> };
export interface MessagePollApplicationPorts {
  readonly pollMessage: typeof pollMessage;
  readonly inboxCount: typeof inboxCount;
  readonly mineQueued: typeof mineQueued;
}
const productionPorts: MessagePollApplicationPorts = { pollMessage, inboxCount, mineQueued };

/** Preserve command option admission before invoking the canonical queue owner. */
function admittedOptions(input: PollOptions): PollOptions {
  return {
    ...(typeof input.waitMs === 'number' && input.waitMs > 0 ? { waitMs: input.waitMs } : {}),
    ...(input.peek === true ? { peek: true } : {}),
    ...(input.receipt === 'auto' ? { receipt: 'auto' } : {}),
    ...(typeof input.drain === 'number' && Number.isFinite(input.drain) && input.drain > 0
      ? { drain: Math.floor(input.drain) }
      : {}),
    ...(input.offer === true ? { offer: true } : {}),
    ...(typeof input.offerTtlMs === 'number' && Number.isFinite(input.offerTtlMs)
      ? { offerTtlMs: input.offerTtlMs }
      : {}),
  };
}

/** Queue ordering, locks, delivery and offer identity belong to messages-store.
 * This operation adds the same supplementary observations for every adapter.
 */
export function pollAgentMessages(
  input: MessagePollApplicationInput,
  ports: MessagePollApplicationPorts = productionPorts
): MessagePollApplicationResult {
  const start = input.nowMs();
  const polled = ports.pollMessage(
    input.cawsDir,
    input.recipient,
    admittedOptions(input.options ?? {})
  );
  const pollMs = input.nowMs() - start;
  if (!polled.ok) return { ok: false, stage: 'poll', errors: polled.errors };
  const { message, sender, messages, offer } = polled.value;
  const count = ports.inboxCount(input.cawsDir, input.recipient);
  const mine = ports.mineQueued(input.cawsDir, input.recipient, 3_600_000);
  return {
    ok: true,
    value: {
      message,
      ...(sender !== undefined ? { sender } : {}),
      messages: messages.map((entry) => ({
        message: entry.message,
        ...(entry.sender !== undefined ? { sender: entry.sender } : {}),
      })),
      ...(offer !== undefined ? { offer } : {}),
      waiting: count.ok ? count.value : null,
      poll_ms: pollMs,
      mine_queued_1h: mine.ok
        ? { count: mine.value.count, oldest_age_ms: mine.value.oldestAgeMs }
        : { count: 0, oldest_age_ms: null },
    },
  };
}
