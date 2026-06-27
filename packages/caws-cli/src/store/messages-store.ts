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

/**
 * Pull the next undelivered message addressed to `me`. Replays the log to find
 * the earliest 'message' record with to===me whose id has no 'delivery' record,
 * appends a delivery record for it, and returns it. Returns {message:null} when
 * the mailbox is empty.
 *
 * Lenient per line: a malformed line is skipped with a diagnostic, not fatal.
 * Strict on directory: an unreadable .caws dir returns err.
 *
 * CONCURRENCY: the read→pick→append-delivery sequence is a TOCTOU — two processes
 * polling the SAME recipient at once could otherwise both pick the same message
 * and deliver it twice (verified reproducible across processes). We serialize the
 * whole critical section under a DEDICATED message-log lock (not the global
 * lifecycle lock — chat traffic must not contend with governance ops like spec
 * close / worktree merge). `sendMessage` needs no lock: a single appendFileSync
 * line is atomic, and sends never read-modify-write.
 */
export function pollMessage(cawsDir: string, me: string): Result<PollResult> {
  return withLifecycleLock(cawsDir, () => pollMessageLocked(cawsDir, me), {
    lockPath: path.join(cawsDir, MESSAGES_FILENAME + '.lock'),
  });
}

function pollMessageLocked(cawsDir: string, me: string): Result<PollResult> {
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

  const deliveryAppend = appendLine(cawsDir, {
    record: 'delivery',
    deliver_id: next.id,
    ts: new Date().toISOString(),
  });
  if (!deliveryAppend.ok) return err(deliveryAppend.errors);
  return ok({ message: next, diagnostics });
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
