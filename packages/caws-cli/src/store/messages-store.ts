// messages-store — the read/write surface for .caws/messages.jsonl, the
// inter-agent message channel (AGENT-MESSAGE-CHANNEL-001).
//
// DESIGN: this is deliberately a SEPARATE append-only log from events.jsonl.
// events.jsonl is the integrity-critical, hash-chained audit trail with a single
// sanctioned writer (invariant 14); chat-rate inter-agent traffic must never be
// interleaved into it. messages.jsonl borrows the same structured-actor envelope
// (so a message's PROVENANCE is recorded, not self-claimed) but is intentionally
// lighter: line order is authoritative, no hash chain — losing or reordering a
// chat message is not an audit-integrity failure.
//
// Two record kinds share the file (see messages.v1.json):
//   - { record: 'message', id, actor, to, channel, text, ts }  — a directed send
//   - { record: 'delivery', deliver_id, ts }                    — marks consumed
//
// Delivery semantics: a message is delivered at most once (a delivery record is
// appended when a recipient polls it) but retained in channel history forever.
// Replay rebuilds per-recipient mailboxes excluding delivered ids — O(n).

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { type Diagnostic, type Result, ok, err } from '@paths.design/caws-kernel';

import { writeFileAtomic } from './atomic-write';
import { loadLeases } from './leases-store';
import { withLifecycleLock } from './lifecycle-lock';
import { storeDiagnostic } from './repo-root';
import { STORE_RULES } from './rules';

const MESSAGES_FILENAME = 'messages.jsonl';
/** A recipient lease older than this (no heartbeat) is not considered live. */
const LIVENESS_TTL_MS = 30 * 60 * 1000; // 30m, matching the leases-store stale default

/** Endpoint id strict allowlist — same shape leases enforce for session ids. */
const ENDPOINT_RE = /^[A-Za-z0-9._:-]+$/;

export interface MessageRecord {
  readonly record: 'message';
  readonly id: string;
  readonly actor: MessageActor;
  readonly to: string;
  readonly channel: string;
  readonly text: string;
  readonly ts: string;
}
export interface MessageActor {
  readonly kind: 'human' | 'agent' | 'system' | 'automation';
  readonly id: string;
  readonly session_id?: string;
  readonly platform?: string;
}
interface DeliveryRecord {
  readonly record: 'delivery';
  readonly deliver_id: string;
  readonly ts: string;
}

/** Normalized unordered channel id for a pair of endpoints. A->B == B->A. */
export function channelId(a: string, b: string): string {
  return [a, b].sort().join('::');
}

function messagesPath(cawsDir: string): string {
  return path.join(cawsDir, MESSAGES_FILENAME);
}

/**
 * Is `sessionId` a live recipient per the lease registry?
 *
 * Live := a lease exists with status 'active' or 'stopping' AND last_active
 * within the TTL. A 'stopped' lease, a stale heartbeat, or no lease at all is
 * NOT live — a send to such a recipient must fail loudly so "no reply" can never
 * be confused with "the send was dropped into a void."
 */
export function isRecipientLive(cawsDir: string, sessionId: string): Result<boolean> {
  const leasesResult = loadLeases(cawsDir);
  if (!leasesResult.ok) return err(leasesResult.errors);
  const lease = leasesResult.value.leases[sessionId];
  if (!lease) return ok(false);
  const status = (lease as { status?: string }).status;
  if (status !== 'active' && status !== 'stopping') return ok(false);
  const lastActive = (lease as { last_active?: string }).last_active;
  if (typeof lastActive === 'string') {
    const ageMs = Date.now() - Date.parse(lastActive);
    if (Number.isFinite(ageMs) && ageMs > LIVENESS_TTL_MS) return ok(false);
  }
  return ok(true);
}

function appendLine(cawsDir: string, record: MessageRecord | DeliveryRecord): Result<void> {
  try {
    fs.mkdirSync(cawsDir, { recursive: true });
    fs.appendFileSync(messagesPath(cawsDir), JSON.stringify(record) + '\n');
    return ok(undefined);
  } catch (e) {
    return err(
      storeDiagnostic(
        STORE_RULES.MESSAGES_APPEND_FAILED,
        `Failed to append to ${MESSAGES_FILENAME}: ${(e as Error).message}`
      )
    );
  }
}

/**
 * Send a directed message from `actor` to recipient `to`.
 *
 * Refuses (err) when:
 *   - `to` is empty or contains characters outside the endpoint allowlist
 *   - `requireLive` is set and the recipient is not live in the registry
 * On success, persists a 'message' record and returns it.
 */
export function sendMessage(
  cawsDir: string,
  params: { actor: MessageActor; to: string; text: string; requireLive?: boolean }
): Result<MessageRecord> {
  const { actor, to, text } = params;
  if (typeof to !== 'string' || to.length === 0 || !ENDPOINT_RE.test(to)) {
    return err(
      storeDiagnostic(
        STORE_RULES.MESSAGES_RECIPIENT_INVALID,
        `Recipient "${to}" is empty or contains characters outside ${ENDPOINT_RE}.`
      )
    );
  }
  if (params.requireLive !== false) {
    const live = isRecipientLive(cawsDir, to);
    if (!live.ok) return err(live.errors);
    if (!live.value) {
      return err(
        storeDiagnostic(
          STORE_RULES.MESSAGES_RECIPIENT_NOT_LIVE,
          `Recipient session "${to}" is not live (no active lease within the heartbeat TTL). ` +
            `The message was NOT sent — a send to a dead session would queue into a void and ` +
            `look identical to silence. Confirm the recipient session is running.`
        )
      );
    }
  }
  const from = actor.session_id ?? actor.id;
  const record: MessageRecord = {
    record: 'message',
    id: crypto.randomUUID(),
    actor,
    to,
    channel: channelId(from, to),
    text,
    ts: new Date().toISOString(),
  };
  const appended = appendLine(cawsDir, record);
  if (!appended.ok) return err(appended.errors);
  return ok(record);
}

export interface PollResult {
  /** The next undelivered message addressed to `me`, or null if none. */
  readonly message: MessageRecord | null;
  readonly diagnostics: ReadonlyArray<Diagnostic>;
}

export interface MessageInboxListResult {
  readonly messages: readonly MessageRecord[];
  readonly waiting: number;
  readonly diagnostics: ReadonlyArray<Diagnostic>;
}

export interface MessagePruneEntry {
  readonly id: string;
  readonly ts: string;
  readonly from: string;
  readonly to: string;
  readonly channel: string;
  readonly text: string;
  readonly delivered: boolean;
  readonly state: 'candidate' | 'skipped';
  readonly reason: string;
}

export interface MessagePrunePlan {
  readonly status: 'delivered';
  readonly apply: boolean;
  readonly candidates: readonly MessagePruneEntry[];
  readonly skipped: readonly MessagePruneEntry[];
  readonly diagnostics: ReadonlyArray<Diagnostic>;
  readonly delivery_records_to_remove: number;
  readonly selector_required_for_apply: boolean;
}

export interface MessagePruneResult extends MessagePrunePlan {
  readonly applied: boolean;
  readonly pruned_messages: number;
  readonly pruned_delivery_records: number;
}

export interface PollOptions {
  /** Block up to this many ms for a message before giving up (long-poll). 0/undefined = return immediately. */
  readonly waitMs?: number;
  /** Read the next message WITHOUT consuming it (no delivery record appended). */
  readonly peek?: boolean;
}

/** Server-side cap on --wait so a caller can't hold a poll open indefinitely. */
const MAX_WAIT_MS = 60_000;
/** Sleep between poll attempts while waiting. Lock is RELEASED during the sleep. */
const POLL_RETRY_MS = 150;

function sleepSync(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* busy-wait; matches the lifecycle-lock idiom. Short interval, lock not held. */
  }
}

interface ParsedMessageLine {
  readonly raw: string;
  readonly parsed: MessageRecord | DeliveryRecord | null;
}

function readMessageLines(cawsDir: string): Result<{ readonly lines: ParsedMessageLine[]; readonly diagnostics: Diagnostic[] }> {
  const file = messagesPath(cawsDir);
  if (!fs.existsSync(file)) return ok({ lines: [], diagnostics: [] });

  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return err(
      storeDiagnostic(
        STORE_RULES.MESSAGES_LOG_UNREADABLE,
        `Failed to read ${MESSAGES_FILENAME}: ${(e as Error).message}`
      )
    );
  }

  const diagnostics: Diagnostic[] = [];
  const lines: ParsedMessageLine[] = [];
  let lineNo = 0;
  for (const line of raw.split('\n')) {
    lineNo++;
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      diagnostics.push(
        storeDiagnostic(
          STORE_RULES.MESSAGES_LINE_MALFORMED,
          `${MESSAGES_FILENAME}:${lineNo} is not valid JSON — skipped.`
        )
      );
      lines.push({ raw: line, parsed: null });
      continue;
    }
    const rec = parsed as { record?: string };
    if (rec.record === 'message' || rec.record === 'delivery') {
      lines.push({ raw: line, parsed: parsed as MessageRecord | DeliveryRecord });
    } else {
      lines.push({ raw: line, parsed: null });
    }
  }
  return ok({ lines, diagnostics });
}

function messageEntry(message: MessageRecord, delivered: boolean, state: 'candidate' | 'skipped', reason: string): MessagePruneEntry {
  return {
    id: message.id,
    ts: message.ts,
    from: message.actor.session_id ?? message.actor.id,
    to: message.to,
    channel: message.channel,
    text: message.text,
    delivered,
    state,
    reason,
  };
}

export interface MessagePruneOptions {
  readonly status: 'delivered';
  readonly olderThanMs?: number;
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  readonly apply?: boolean;
}

function buildMessagePrunePlan(cawsDir: string, opts: MessagePruneOptions): Result<MessagePrunePlan & { readonly lines: readonly ParsedMessageLine[] }> {
  const loaded = readMessageLines(cawsDir);
  if (!loaded.ok) return err(loaded.errors);

  const delivered = new Set<string>();
  for (const entry of loaded.value.lines) {
    if (entry.parsed?.record === 'delivery' && typeof entry.parsed.deliver_id === 'string') {
      delivered.add(entry.parsed.deliver_id);
    }
  }

  const include = new Set(opts.include ?? []);
  const exclude = new Set(opts.exclude ?? []);
  const hasInclude = include.size > 0;
  const hasAge = typeof opts.olderThanMs === 'number' && Number.isFinite(opts.olderThanMs);
  const now = Date.now();
  const candidates: MessagePruneEntry[] = [];
  const skipped: MessagePruneEntry[] = [];

  for (const entry of loaded.value.lines) {
    if (entry.parsed?.record !== 'message') continue;
    const message = entry.parsed;
    const isDelivered = delivered.has(message.id);
    if (!isDelivered) {
      skipped.push(messageEntry(message, false, 'skipped', 'undelivered'));
      continue;
    }
    if (hasInclude && !include.has(message.id)) {
      skipped.push(messageEntry(message, true, 'skipped', 'not-included'));
      continue;
    }
    if (exclude.has(message.id)) {
      skipped.push(messageEntry(message, true, 'skipped', 'excluded'));
      continue;
    }
    if (hasAge) {
      const ts = Date.parse(message.ts);
      const ageMs = Number.isFinite(ts) ? now - ts : 0;
      if (ageMs < (opts.olderThanMs ?? 0)) {
        skipped.push(messageEntry(message, true, 'skipped', 'newer-than-retention'));
        continue;
      }
    }
    candidates.push(messageEntry(message, true, 'candidate', 'delivered'));
  }

  const candidateIds = new Set(candidates.map((candidate) => candidate.id));
  const deliveryRecordsToRemove = loaded.value.lines.filter(
    (entry) => entry.parsed?.record === 'delivery' && candidateIds.has(entry.parsed.deliver_id)
  ).length;

  return ok({
    status: opts.status,
    apply: opts.apply === true,
    candidates,
    skipped,
    diagnostics: loaded.value.diagnostics,
    delivery_records_to_remove: deliveryRecordsToRemove,
    selector_required_for_apply: opts.apply === true && !hasInclude && !hasAge,
    lines: loaded.value.lines,
  });
}

export function pruneMessages(cawsDir: string, opts: MessagePruneOptions): Result<MessagePruneResult> {
  return withLifecycleLock(cawsDir, () => {
    const planned = buildMessagePrunePlan(cawsDir, opts);
    if (!planned.ok) return err(planned.errors);

    const { lines, ...plan } = planned.value;
    if (plan.selector_required_for_apply) {
      return err(
        storeDiagnostic(
          STORE_RULES.LIFECYCLE_PLAN_REJECTED,
          'message prune --apply requires --older-than-ms or --include so broad chat-log cleanup is explicit.'
        )
      );
    }

    if (opts.apply !== true || plan.candidates.length === 0) {
      return ok({
        ...plan,
        applied: opts.apply === true,
        pruned_messages: 0,
        pruned_delivery_records: 0,
      });
    }

    const candidateIds = new Set(plan.candidates.map((candidate) => candidate.id));
    let prunedDeliveryRecords = 0;
    const keptLines: string[] = [];
    for (const entry of lines) {
      if (entry.parsed?.record === 'message' && candidateIds.has(entry.parsed.id)) {
        continue;
      }
      if (entry.parsed?.record === 'delivery' && candidateIds.has(entry.parsed.deliver_id)) {
        prunedDeliveryRecords++;
        continue;
      }
      keptLines.push(entry.raw);
    }

    const file = messagesPath(cawsDir);
    const written = writeFileAtomic(file, keptLines.length > 0 ? keptLines.join('\n') + '\n' : '');
    if (!written.ok) return err(written.errors);

    return ok({
      ...plan,
      applied: true,
      pruned_messages: plan.candidates.length,
      pruned_delivery_records: prunedDeliveryRecords,
    });
  }, {
    lockPath: path.join(cawsDir, MESSAGES_FILENAME + '.lock'),
  });
}

/**
 * Pull the next undelivered message addressed to `me`.
 *
 * Options:
 *   - waitMs: long-poll. Re-attempts every POLL_RETRY_MS until a message arrives
 *     or the window elapses. The message-log lock is acquired PER ATTEMPT and
 *     RELEASED during the sleep, so a waiting poller never starves senders (which
 *     are lock-free anyway) or other pollers.
 *   - peek: return the next message without consuming it (no delivery record).
 *
 * CONCURRENCY: the read→pick→append-delivery sequence is a TOCTOU — two processes
 * polling the SAME recipient at once could otherwise both pick the same message and
 * deliver it twice (verified reproducible). We serialize each attempt under a
 * DEDICATED message-log lock (not the global lifecycle lock — chat traffic must not
 * contend with governance ops). `sendMessage` needs no lock: a single appendFileSync
 * line is atomic, and sends never read-modify-write. Peek takes the lock too (a
 * consistent read), but appends nothing.
 */
export function pollMessage(cawsDir: string, me: string, options: PollOptions = {}): Result<PollResult> {
  const waitMs = Math.min(Math.max(0, options.waitMs ?? 0), MAX_WAIT_MS);
  const deadline = Date.now() + waitMs;
  const attempt = () =>
    withLifecycleLock(cawsDir, () => pollMessageLocked(cawsDir, me, options.peek === true), {
      lockPath: path.join(cawsDir, MESSAGES_FILENAME + '.lock'),
    });

  // First attempt is always made. If waiting and empty, retry until the deadline,
  // releasing the lock between tries (the lock is scoped to each attempt() call).
  for (;;) {
    const r = attempt();
    if (!r.ok) return r;
    if (r.value.message || waitMs === 0 || Date.now() >= deadline) return r;
    sleepSync(POLL_RETRY_MS);
  }
}

function pollMessageLocked(cawsDir: string, me: string, peek: boolean): Result<PollResult> {
  const file = messagesPath(cawsDir);
  if (!fs.existsSync(file)) return ok({ message: null, diagnostics: [] });

  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return err(
      storeDiagnostic(
        STORE_RULES.MESSAGES_LOG_UNREADABLE,
        `Failed to read ${MESSAGES_FILENAME}: ${(e as Error).message}`
      )
    );
  }

  const diagnostics: Diagnostic[] = [];
  const messages: MessageRecord[] = [];
  const delivered = new Set<string>();
  let lineNo = 0;
  for (const line of raw.split('\n')) {
    lineNo++;
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      diagnostics.push(
        storeDiagnostic(
          STORE_RULES.MESSAGES_LINE_MALFORMED,
          `${MESSAGES_FILENAME}:${lineNo} is not valid JSON — skipped.`
        )
      );
      continue;
    }
    const rec = parsed as { record?: string };
    if (rec.record === 'message') {
      messages.push(parsed as MessageRecord);
    } else if (rec.record === 'delivery') {
      const d = parsed as DeliveryRecord;
      if (typeof d.deliver_id === 'string') delivered.add(d.deliver_id);
    }
  }

  const next = messages.find((m) => m.to === me && !delivered.has(m.id));
  if (!next) return ok({ message: null, diagnostics });

  // Peek: return the message but do NOT consume it — no delivery record, so a
  // subsequent normal poll still delivers it.
  if (peek) return ok({ message: next, diagnostics });

  const deliveryAppend = appendLine(cawsDir, {
    record: 'delivery',
    deliver_id: next.id,
    ts: new Date().toISOString(),
  });
  if (!deliveryAppend.ok) return err(deliveryAppend.errors);
  return ok({ message: next, diagnostics });
}

/**
 * Count undelivered messages addressed to `me` (mailbox depth) — read-only triage,
 * no consumption. Used by `caws message poll --peek` / inbox display.
 */
export function inboxCount(cawsDir: string, me: string): Result<number> {
  const file = messagesPath(cawsDir);
  if (!fs.existsSync(file)) return ok(0);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return err(
      storeDiagnostic(
        STORE_RULES.MESSAGES_LOG_UNREADABLE,
        `Failed to read ${MESSAGES_FILENAME}: ${(e as Error).message}`
      )
    );
  }
  const messages: MessageRecord[] = [];
  const delivered = new Set<string>();
  for (const line of raw.split('\n')) {
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const rec = parsed as { record?: string };
    if (rec.record === 'message') messages.push(parsed as MessageRecord);
    else if (rec.record === 'delivery') {
      const d = parsed as DeliveryRecord;
      if (typeof d.deliver_id === 'string') delivered.add(d.deliver_id);
    }
  }
  return ok(messages.filter((m) => m.to === me && !delivered.has(m.id)).length);
}

/**
 * List undelivered messages addressed to `me` without consuming them.
 * Returns oldest-waiting first so the result mirrors the order poll would
 * deliver. `limit` caps the returned list only; `waiting` is the full mailbox
 * depth.
 */
export function inboxMessages(
  cawsDir: string,
  me: string,
  opts: { readonly limit?: number } = {}
): Result<MessageInboxListResult> {
  const file = messagesPath(cawsDir);
  if (!fs.existsSync(file)) return ok({ messages: [], waiting: 0, diagnostics: [] });
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return err(
      storeDiagnostic(
        STORE_RULES.MESSAGES_LOG_UNREADABLE,
        `Failed to read ${MESSAGES_FILENAME}: ${(e as Error).message}`
      )
    );
  }
  const diagnostics: Diagnostic[] = [];
  const messages: MessageRecord[] = [];
  const delivered = new Set<string>();
  let lineNo = 0;
  for (const line of raw.split('\n')) {
    lineNo++;
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      diagnostics.push(
        storeDiagnostic(
          STORE_RULES.MESSAGES_LINE_MALFORMED,
          `${MESSAGES_FILENAME}:${lineNo} is not valid JSON — skipped.`
        )
      );
      continue;
    }
    const rec = parsed as { record?: string };
    if (rec.record === 'message') messages.push(parsed as MessageRecord);
    else if (rec.record === 'delivery') {
      const d = parsed as DeliveryRecord;
      if (typeof d.deliver_id === 'string') delivered.add(d.deliver_id);
    }
  }
  const waitingMessages = messages.filter((m) => m.to === me && !delivered.has(m.id));
  const limit =
    typeof opts.limit === 'number' && Number.isFinite(opts.limit) && opts.limit >= 0
      ? Math.floor(opts.limit)
      : waitingMessages.length;
  return ok({
    messages: waitingMessages.slice(0, limit),
    waiting: waitingMessages.length,
    diagnostics,
  });
}

/** Full, non-lossy history between two endpoints (both directions, in order). */
export function channelHistory(cawsDir: string, a: string, b: string): Result<MessageRecord[]> {
  const file = messagesPath(cawsDir);
  if (!fs.existsSync(file)) return ok([]);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return err(
      storeDiagnostic(
        STORE_RULES.MESSAGES_LOG_UNREADABLE,
        `Failed to read ${MESSAGES_FILENAME}: ${(e as Error).message}`
      )
    );
  }
  const ch = channelId(a, b);
  const out: MessageRecord[] = [];
  for (const line of raw.split('\n')) {
    if (line.length === 0) continue;
    try {
      const rec = JSON.parse(line) as { record?: string; channel?: string };
      if (rec.record === 'message' && rec.channel === ch) out.push(rec as MessageRecord);
    } catch {
      /* lenient: skip malformed history lines */
    }
  }
  return ok(out);
}
