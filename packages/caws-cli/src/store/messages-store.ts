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
// Five operational record kinds share the file (see messages.v1.json):
//   - { record: 'message', id, actor, to, channel, text, ts, reply_to? } — a directed send
//   - { record: 'delivery', deliver_id, ts, mode? }               — marks consumed
//   - { record: 'offer', offer_id, recipient, deliver_ids, ... }   — expiring reservation
//   - { record: 'offer_settlement', offer_id, outcome, ... }       — deliver or release offer
//   - { record: 'refusal', id, class, to, reason, ts }            — a refused send/reply
//
// Delivery semantics: an explicit poll consumes a message by appending a
// delivery record. Automatic delivery first appends an expiring offer, then an
// exact settlement records adapter handoff or releases the offer for retry.
// Adapter handoff does not prove recipient visibility; an interrupted settlement
// remains uncertain and may retry (bounded at-least-once behavior). Messages are
// retained in channel history, and replay rebuilds recipient mailboxes — O(n).
// Refusal records are telemetry only: best-effort, never read back for
// delivery state, and invisible to poll/inbox/history.

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { type Diagnostic, type Result, ok, err } from '../kernel';

import { writeFileAtomic } from './atomic-write';
import { loadLeases } from './leases-store';
import { withLifecycleLock } from './lifecycle-lock';
import { sleepSyncMs, storeDiagnostic } from './repo-root';
import { STORE_RULES } from './rules';

const MESSAGES_FILENAME = 'messages.jsonl';
const MESSAGES_ARCHIVE_FILENAME = 'messages.jsonl.archive';
// The lock filename is a compatibility boundary shared by installed CLI versions.
const MESSAGES_LOCK_FILENAME = 'messages.jsonl.lock';
/** A recipient lease older than this (no heartbeat) is not considered live. */
const LIVENESS_TTL_MS = 30 * 60 * 1000; // 30m, matching the leases-store stale default

/**
 * CAWS-DEFECT-MESSAGE-PRUNE-DEAD-RECIPIENT-01: default retention floor for the
 * undelivered-to-dead-session prune selector. A recipient whose lease is gone
 * may still resume and renew it (observed live: sessions a081c2bf/66766069 did
 * exactly that), so an undelivered message is only retention-eligible once it
 * is older than this floor. 7 days, matching the specs prune-drafts default.
 */
const DEFAULT_DEAD_RECIPIENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

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
  /** The message id this message replies to (thread linkage). Written by
   *  `caws message reply` and by `send --reply-to`. Absent on plain sends and
   *  on all pre-existing records — optional and read-backward-compatible. */
  readonly reply_to?: string;
  /** Delivery-ordering signal, not authority (CAWS-MESSAGE-DELIVERY-ECONOMICS-001):
   *  'critical' messages are polled before 'normal' ones regardless of age.
   *  Absent means normal; all pre-existing records remain valid. */
  readonly urgency?: 'critical' | 'normal';
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
  /** How the message was consumed: 'auto' (heartbeat hook auto-delivery) or
   *  'poll' (explicit poll). Absent on pre-existing records (unknown). */
  readonly mode?: 'auto' | 'poll';
}

interface MessageOfferRecord {
  readonly record: 'offer';
  readonly offer_id: string;
  readonly recipient: string;
  readonly deliver_ids: readonly string[];
  readonly ts: string;
  readonly expires_at: string;
  readonly mode: 'auto';
}

interface MessageOfferSettlementRecord {
  readonly record: 'offer_settlement';
  readonly offer_id: string;
  readonly recipient: string;
  readonly outcome: 'delivered' | 'released';
  readonly ts: string;
  /** The strongest receipt this record claims. It does not claim recipient visibility. */
  readonly boundary?: 'adapter_handoff';
}

type MessageLedgerRecord =
  | MessageRecord
  | DeliveryRecord
  | MessageOfferRecord
  | MessageOfferSettlementRecord
  | RefusalRecord;

/** Refusal classes recorded on a refusal record (CAWS-MESSAGE-LEDGER-COMPLETENESS-001). */
export type RefusalClass =
  | 'recipient_not_live'
  | 'recipient_invalid'
  | 'alias_unresolved'
  | 'reply_to_self'
  | 'message_not_found'
  | 'reply_target_invalid'
  | 'identity_ambiguous'
  | 'urgency_invalid';

export interface RefusalRecord {
  readonly record: 'refusal';
  readonly id: string;
  readonly class: RefusalClass;
  /** The attempted addressing target: recipient id when known, else the
   *  message id being replied to (message_not_found / reply_to_self). */
  readonly to: string;
  readonly reason: string;
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
 * Liveness is decided by HEARTBEAT AGE, not by lease status alone
 * (CAWS-MESSAGE-DELIVERY-UX-001). A lease whose last_active is within the TTL
 * is a deliverable recipient regardless of status: an agent that ended its
 * turn while background work runs is written "stopped" by the Stop hook but
 * is idle, not dead — auto-delivery surfaces the message at its next tool
 * call, so there is no void. Hard refusals are exactly two: no lease at all
 * (typo/foreign-id protection) and a stale heartbeat older than the TTL
 * (genuinely unreachable).
 */
export function isRecipientLive(cawsDir: string, sessionId: string): Result<boolean> {
  const described = describeRecipientLiveness(cawsDir, sessionId);
  if (!described.ok) return err(described.errors);
  return ok(described.value.live);
}

/** Why a recipient is (or is not) live. `reason`/`ageMs` are set only when not live; `idle` only when live-but-stopped. */
export interface RecipientLiveness {
  readonly live: boolean;
  readonly reason?: 'no_lease' | 'stale_heartbeat';
  /** True when the recipient is deliverable but its lease is stopped (idle between turns, fresh heartbeat). */
  readonly idle?: boolean;
  readonly status?: string;
  readonly ageMs?: number;
}

/**
 * Same gate as {@link isRecipientLive}, but returns the discriminating detail
 * (no lease / stale heartbeat + age / idle-but-deliverable) so the rejection
 * message can tell the sender *why* the recipient is unreachable, and a
 * successful send can note an idle recipient. See CAWS-DEFECT-MSG-ENRICHMENT-01
 * and CAWS-MESSAGE-DELIVERY-UX-001.
 */
export function describeRecipientLiveness(
  cawsDir: string,
  sessionId: string
): Result<RecipientLiveness> {
  const leasesResult = loadLeases(cawsDir);
  if (!leasesResult.ok) return err(leasesResult.errors);
  const lease = leasesResult.value.leases[sessionId] as
    | { status?: string; last_active?: string }
    | undefined;
  if (!lease) return ok({ live: false, reason: 'no_lease' });
  const status = lease.status;
  const ageMs =
    typeof lease.last_active === 'string' ? Date.now() - Date.parse(lease.last_active) : NaN;
  const ageKnown = Number.isFinite(ageMs);
  if (ageKnown && ageMs > LIVENESS_TTL_MS) {
    // Stale heartbeat dominates every status — even an 'active' lease older
    // than the TTL is not a deliverable recipient.
    return ok({
      live: false,
      reason: 'stale_heartbeat',
      ...(status !== undefined ? { status } : {}),
      ageMs,
    });
  }
  if (status === 'stopped') {
    if (!ageKnown) {
      // A stopped lease with no usable heartbeat age carries no evidence of
      // life; conservatively not live (folded into the stale-heartbeat class
      // so the hard-refusal classes stay exactly two).
      return ok({ live: false, reason: 'stale_heartbeat', status });
    }
    // Stopped + fresh heartbeat: the session ended a turn (Stop hook) but its
    // heart is minutes fresh — idle between turns, deliverable.
    return ok({ live: true, idle: true, status });
  }
  return ok({ live: true, ...(status !== undefined ? { status } : {}) });
}

/** Humanized "Nd ago" / "Nm ago" for a millisecond age, rounded down. */
export function formatAge(ageMs: number): string {
  const secs = Math.floor(ageMs / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

const LIVENESS_TTL_HUMAN = '30m';

/** Builds the enriched "not live" reason clause, e.g. "stale heartbeat — last active 47 min ago; TTL is 30m". */
function describeNotLiveReason(liveness: RecipientLiveness): string {
  switch (liveness.reason) {
    case 'no_lease':
      return 'no lease found for this session id';
    case 'stale_heartbeat':
      return `stale heartbeat — last active ${
        liveness.ageMs !== undefined ? formatAge(liveness.ageMs) : 'unknown'
      }; TTL is ${LIVENESS_TTL_HUMAN}`;
    default:
      return 'no lease with a fresh heartbeat within the TTL';
  }
}

function appendLine(cawsDir: string, record: MessageLedgerRecord): Result<void> {
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
 * Best-effort refusal telemetry (CAWS-MESSAGE-LEDGER-COMPLETENESS-001): append
 * a refusal record so attempt-level success is measurable from the ledger.
 * NEVER fails the caller and NEVER changes a verdict — a failed append is
 * silently dropped (the refusal itself is still reported on stdout/stderr).
 */
export function recordRefusal(
  cawsDir: string,
  params: { class: RefusalClass; to: string; reason: string }
): void {
  try {
    appendLine(cawsDir, {
      record: 'refusal',
      id: crypto.randomUUID(),
      class: params.class,
      to: params.to,
      reason: params.reason,
      ts: new Date().toISOString(),
    });
  } catch {
    /* best-effort telemetry — refusal recording never fails the command */
  }
}

/** A successful send: the persisted record plus delivery-relevant detail. */
export interface MessageSendOutcome {
  /** The persisted message record (identical to what was appended). */
  readonly message: MessageRecord;
  /**
   * True when the recipient's lease is stopped but its heartbeat is fresh —
   * idle between turns. The send is deliverable (auto-delivery surfaces it at
   * the recipient's next tool call); surfaces carry an informational note.
   */
  readonly recipientIdle: boolean;
}

/**
 * Send a directed message from `actor` to recipient `to`.
 *
 * Refuses (err) when:
 *   - `to` is empty or contains characters outside the endpoint allowlist
 *   - `requireLive` is set and the recipient has no lease, or its heartbeat
 *     is older than the TTL (a stopped lease with a FRESH heartbeat is
 *     deliverable — see {@link describeRecipientLiveness})
 * On success, persists a 'message' record (with reply_to when `replyTo` is
 * given) and returns it. Every refusal is mirrored by a best-effort refusal
 * record (CAWS-MESSAGE-LEDGER-COMPLETENESS-001).
 */
export function sendMessage(
  cawsDir: string,
  params: {
    actor: MessageActor;
    to: string;
    text: string;
    requireLive?: boolean;
    /** Message id this send replies to (thread linkage). Written verbatim. */
    replyTo?: string;
    /** Delivery-ordering signal (CAWS-MESSAGE-DELIVERY-ECONOMICS-001);
     *  'critical' is written verbatim, anything else is omitted (normal). */
    urgency?: 'critical' | 'normal';
  }
): Result<MessageSendOutcome> {
  const { actor, to, text } = params;
  if (typeof to !== 'string' || to.length === 0 || !ENDPOINT_RE.test(to)) {
    recordRefusal(cawsDir, {
      class: 'recipient_invalid',
      to: String(to),
      reason: `Recipient "${to}" is empty or contains characters outside ${ENDPOINT_RE}.`,
    });
    return err(
      storeDiagnostic(
        STORE_RULES.MESSAGES_RECIPIENT_INVALID,
        `Recipient "${to}" is empty or contains characters outside ${ENDPOINT_RE}.`
      )
    );
  }
  let recipientIdle = false;
  if (params.requireLive !== false) {
    const liveness = describeRecipientLiveness(cawsDir, to);
    if (!liveness.ok) return err(liveness.errors);
    if (!liveness.value.live) {
      const reason = describeNotLiveReason(liveness.value);
      recordRefusal(cawsDir, { class: 'recipient_not_live', to, reason });
      return err(
        storeDiagnostic(
          STORE_RULES.MESSAGES_RECIPIENT_NOT_LIVE,
          `Recipient session "${to}" is not live (reason: ${reason}). ` +
            `The message was NOT sent — a send to a dead session would queue into a void and ` +
            `look identical to silence. Run \`caws agents list\` to confirm the recipient's status, ` +
            `or re-send with \`caws message send --allow-dead\` to deliver anyway.`
        )
      );
    }
    recipientIdle = liveness.value.idle === true;
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
    ...(params.replyTo !== undefined && params.replyTo.length > 0
      ? { reply_to: params.replyTo }
      : {}),
    ...(params.urgency === 'critical' ? { urgency: 'critical' as const } : {}),
  };
  const appended = appendLine(cawsDir, record);
  if (!appended.ok) return err(appended.errors);
  return ok({ message: record, recipientIdle });
}

// ─── recipient aliases (CAWS-MESSAGE-DELIVERY-UX-001) ─────────────────────

const WT_ALIAS_PREFIX = 'wt:';
const SPEC_ALIAS_PREFIX = 'spec:';

/** A resolved `--to` value: the raw endpoint id plus how it was obtained. */
export interface ResolvedRecipient {
  /** The endpoint id to address (a session id). */
  readonly sessionId: string;
  /** The original `--to` value when it was an alias (wt:…/spec:…); absent for raw ids. */
  readonly alias?: string;
}

/**
 * Resolve a `--to` value into a session id. Raw session ids pass through
 * unchanged. `wt:<worktree-name>` and `spec:<spec-id>` aliases resolve to the
 * FRESHEST lease (max last_active within the TTL) bound to that worktree or
 * spec — ties prefer a non-stopped status. An alias with no fresh bound lease
 * is refused with MESSAGES_ALIAS_UNRESOLVED rather than guessed.
 */
export function resolveRecipient(cawsDir: string, to: string): Result<ResolvedRecipient> {
  if (typeof to !== 'string' || to.length === 0) {
    return err(
      storeDiagnostic(
        STORE_RULES.MESSAGES_RECIPIENT_INVALID,
        `Recipient "${to}" is empty or contains characters outside ${ENDPOINT_RE}.`
      )
    );
  }
  if (!to.startsWith(WT_ALIAS_PREFIX) && !to.startsWith(SPEC_ALIAS_PREFIX)) {
    if (!ENDPOINT_RE.test(to)) {
      return err(
        storeDiagnostic(
          STORE_RULES.MESSAGES_RECIPIENT_INVALID,
          `Recipient "${to}" is empty or contains characters outside ${ENDPOINT_RE}. ` +
            `(Aliases take the form wt:<worktree-name> or spec:<spec-id>.)`
        )
      );
    }
    return ok({ sessionId: to });
  }
  const isWorktreeAlias = to.startsWith(WT_ALIAS_PREFIX);
  const aliasValue = to.slice(isWorktreeAlias ? WT_ALIAS_PREFIX.length : SPEC_ALIAS_PREFIX.length);
  if (aliasValue.length === 0) {
    return err(
      storeDiagnostic(
        STORE_RULES.MESSAGES_ALIAS_UNRESOLVED,
        `Alias "${to}" is empty after its prefix — supply the ${
          isWorktreeAlias ? 'worktree name' : 'spec id'
        } (e.g. ${isWorktreeAlias ? 'wt:wt-auth' : 'spec:FEAT-1'}).`
      )
    );
  }
  const leasesResult = loadLeases(cawsDir);
  if (!leasesResult.ok) return err(leasesResult.errors);
  const field = isWorktreeAlias ? 'bound_worktree' : 'bound_spec_id';
  let best: { sessionId: string; ageMs: number; stopped: boolean } | null = null;
  for (const [sessionId, lease] of Object.entries(leasesResult.value.leases)) {
    const bound = field === 'bound_worktree' ? lease.bound_worktree : lease.bound_spec_id;
    if (bound !== aliasValue) continue;
    const ts = Date.parse(lease.last_active);
    if (!Number.isFinite(ts)) continue;
    const ageMs = Date.now() - ts;
    if (ageMs > LIVENESS_TTL_MS) continue;
    const stopped = lease.status === 'stopped';
    // Freshest heartbeat wins; on a tie prefer a non-stopped lease (a live
    // turn beats an idle one at identical age).
    if (best === null || ageMs < best.ageMs || (ageMs === best.ageMs && best.stopped && !stopped)) {
      best = { sessionId, ageMs, stopped };
    }
  }
  if (best === null) {
    return err(
      storeDiagnostic(
        STORE_RULES.MESSAGES_ALIAS_UNRESOLVED,
        `Alias "${to}" resolves to no session with a fresh heartbeat (no lease bound to this ${
          isWorktreeAlias ? 'worktree' : 'spec'
        } within the ${LIVENESS_TTL_HUMAN} TTL). The alias names a binding, not an address — ` +
          `run \`caws agents list\` to see live sessions and their worktrees/specs, ` +
          `or address the session id directly.`
      )
    );
  }
  return ok({ sessionId: best.sessionId, alias: to });
}

/** One polled message plus its registry-derived sender context. */
export interface PolledMessage {
  readonly message: MessageRecord;
  /** Present only when the sender's lease resolves. */
  readonly sender?: MessageSenderContext;
}

export interface PollResult {
  /** The next undelivered message addressed to `me`, or null if none.
   *  Backward-compatible alias for messages[0].message (CAWS-MESSAGE-DELIVERY-ECONOMICS-001). */
  readonly message: MessageRecord | null;
  /**
   * Sender context joined from the lease registry at read time (worktree /
   * spec / branch — each present only when the sender's lease records it), so
   * a recipient never depends on the sender self-identifying in the body.
   * Absent when the message is null or the sender has no lease.
   * Backward-compatible alias for messages[0].sender.
   */
  readonly sender?: MessageSenderContext;
  /** All messages returned by this poll (1..drain), critical-first then oldest-first.
   * They are consumed immediately unless this is a peek or automatic offer. */
  readonly messages: readonly PolledMessage[];
  /** Present only for an automatic offer poll. The messages remain queued until
   * this exact, live offer is settled at the adapter-handoff boundary. */
  readonly offer?: MessageOffer;
  readonly diagnostics: ReadonlyArray<Diagnostic>;
}

export interface MessageOffer {
  readonly id: string;
  readonly recipient: string;
  readonly messageIds: readonly string[];
  readonly expiresAt: string;
}

export interface MessageOfferSettlement {
  readonly offerId: string;
  readonly recipient: string;
  readonly outcome: 'delivered' | 'released';
  readonly settledAt: string;
  readonly boundary?: 'adapter_handoff';
}

/** Registry-derived context about a message's sender (CAWS-MESSAGE-DELIVERY-UX-001). */
export interface MessageSenderContext {
  readonly worktree?: string;
  readonly specId?: string;
  readonly branch?: string;
  /** Visibility-only work-state annotation (LEASE-WORK-STATE-001), when the sender's lease records it. */
  readonly workState?: string;
}

/**
 * Best-effort join of a sender endpoint id against the lease registry.
 * Returns undefined when the sender has no lease or the registry fails to
 * load — enrichment must never fail a poll (fail-open, like the hook).
 */
function senderContextFor(cawsDir: string, senderId: string): MessageSenderContext | undefined {
  const leasesResult = loadLeases(cawsDir);
  if (!leasesResult.ok) return undefined;
  const lease = leasesResult.value.leases[senderId] as
    | { bound_worktree?: unknown; bound_spec_id?: unknown; branch?: unknown; work_state?: unknown }
    | undefined;
  if (!lease) return undefined;
  const ctx: { worktree?: string; specId?: string; branch?: string; workState?: string } = {};
  if (typeof lease.bound_worktree === 'string' && lease.bound_worktree.length > 0) {
    ctx.worktree = lease.bound_worktree;
  }
  if (typeof lease.bound_spec_id === 'string' && lease.bound_spec_id.length > 0) {
    ctx.specId = lease.bound_spec_id;
  }
  if (typeof lease.branch === 'string' && lease.branch.length > 0) {
    ctx.branch = lease.branch;
  }
  if (typeof lease.work_state === 'string' && lease.work_state.length > 0) {
    ctx.workState = lease.work_state;
  }
  return Object.keys(ctx).length > 0 ? ctx : undefined;
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

/**
 * Prune selector. `delivered` is the original retention path (unchanged).
 * `undelivered-to-dead-session` (CAWS-DEFECT-MESSAGE-PRUNE-DEAD-RECIPIENT-01)
 * selects UNDELIVERED messages whose recipient is verifiably not live (no
 * lease, or a heartbeat older than the TTL) and which are older than a
 * retention floor — the monotonically-growing dead-letter class no other
 * command could clear. Deliver-once is preserved for every recipient that
 * could still consume: live and idle (stopped + fresh heartbeat) recipients
 * are never selected.
 */
export type MessagePruneStatus = 'delivered' | 'undelivered-to-dead-session';

export interface MessagePrunePlan {
  readonly status: MessagePruneStatus;
  readonly apply: boolean;
  readonly candidates: readonly MessagePruneEntry[];
  readonly skipped: readonly MessagePruneEntry[];
  readonly diagnostics: ReadonlyArray<Diagnostic>;
  readonly delivery_records_to_remove: number;
  readonly selector_required_for_apply: boolean;
  /** Present only for `undelivered-to-dead-session`: the effective retention
   * floor applied (default DEFAULT_DEAD_RECIPIENT_RETENTION_MS unless
   * --older-than-ms overrode it), reported so a dry-run shows what apply
   * would use. */
  readonly dead_recipient_floor_ms?: number;
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
  /** Receipt mode recorded on the delivery record: 'auto' when this poll is
   *  the heartbeat hook's auto-delivery path, 'poll' for an explicit poll.
   *  Defaults to 'poll' (CAWS-MESSAGE-LEDGER-COMPLETENESS-001). */
  readonly receipt?: 'auto' | 'poll';
  /** Consume up to this many undelivered messages in one lock hold
   *  (critical-first, then oldest-first), 1..10, default 1
   *  (CAWS-MESSAGE-DELIVERY-ECONOMICS-001). */
  readonly drain?: number;
  /** Reserve selected messages for later settlement instead of consuming
   * them. Intended for automatic hook delivery; incompatible with peek. */
  readonly offer?: boolean;
  /** Reservation lifetime. Bounded to 1ms..5m; defaults to 30s. */
  readonly offerTtlMs?: number;
}

/** Server-side cap on --wait so a caller can't hold a poll open indefinitely. */
const MAX_WAIT_MS = 60_000;
/** Server-side cap on --drain so one poll can't consume the whole ledger into context. */
const MAX_DRAIN = 10;
const DEFAULT_OFFER_TTL_MS = 30_000;
const MAX_OFFER_TTL_MS = 5 * 60_000;
/** Sleep between poll attempts while waiting. Lock is RELEASED during the sleep. */
const POLL_RETRY_MS = 150;

interface ParsedMessageLine {
  readonly raw: string;
  readonly parsed: MessageLedgerRecord | null;
}

function readMessageLines(
  cawsDir: string
): Result<{ readonly lines: ParsedMessageLine[]; readonly diagnostics: Diagnostic[] }> {
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
    if (
      rec.record === 'message' ||
      rec.record === 'delivery' ||
      rec.record === 'offer' ||
      rec.record === 'offer_settlement' ||
      rec.record === 'refusal'
    ) {
      lines.push({ raw: line, parsed: parsed as MessageLedgerRecord });
    } else {
      lines.push({ raw: line, parsed: null });
    }
  }
  return ok({ lines, diagnostics });
}

interface MessageLedgerState {
  readonly messages: readonly MessageRecord[];
  readonly deliveredAt: ReadonlyMap<string, string>;
  readonly latestDeliveredAt: ReadonlyMap<string, string>;
  readonly offers: ReadonlyMap<string, MessageOfferRecord>;
  readonly settlements: ReadonlyMap<string, MessageOfferSettlementRecord>;
  readonly reserved: ReadonlySet<string>;
}

function isMessageOfferRecord(record: MessageLedgerRecord): record is MessageOfferRecord {
  return (
    record.record === 'offer' &&
    typeof record.offer_id === 'string' &&
    typeof record.recipient === 'string' &&
    Array.isArray(record.deliver_ids) &&
    record.deliver_ids.length > 0 &&
    record.deliver_ids.every((id) => typeof id === 'string') &&
    typeof record.ts === 'string' &&
    typeof record.expires_at === 'string' &&
    record.mode === 'auto'
  );
}

function isMessageOfferSettlementRecord(
  record: MessageLedgerRecord
): record is MessageOfferSettlementRecord {
  return (
    record.record === 'offer_settlement' &&
    typeof record.offer_id === 'string' &&
    typeof record.recipient === 'string' &&
    typeof record.ts === 'string' &&
    (record.outcome === 'released' ||
      (record.outcome === 'delivered' && record.boundary === 'adapter_handoff'))
  );
}

/** Replay append-only message state. Invalid cross-offer settlements are
 * ignored here; the writer rejects them before append. */
function replayMessageLedger(
  lines: readonly ParsedMessageLine[],
  nowMs = Date.now()
): MessageLedgerState {
  const messages: MessageRecord[] = [];
  const deliveredAt = new Map<string, string>();
  const latestDeliveredAt = new Map<string, string>();
  const offers = new Map<string, MessageOfferRecord>();
  const settlements = new Map<string, MessageOfferSettlementRecord>();
  for (const entry of lines) {
    const record = entry.parsed;
    if (record?.record === 'message') messages.push(record);
    else if (record?.record === 'delivery') {
      if (!deliveredAt.has(record.deliver_id)) deliveredAt.set(record.deliver_id, record.ts);
      latestDeliveredAt.set(record.deliver_id, record.ts);
    } else if (record && isMessageOfferRecord(record) && !offers.has(record.offer_id)) {
      offers.set(record.offer_id, record);
    } else if (
      record &&
      isMessageOfferSettlementRecord(record) &&
      !settlements.has(record.offer_id)
    ) {
      const offer = offers.get(record.offer_id);
      if (offer?.recipient === record.recipient) settlements.set(record.offer_id, record);
    }
  }
  const messagesById = new Map(messages.map((message) => [message.id, message]));
  for (const [offerId, settlement] of settlements) {
    if (settlement.outcome !== 'delivered') continue;
    const offer = offers.get(offerId);
    if (!offer) continue;
    const settledAt = Date.parse(settlement.ts);
    const offeredAt = Date.parse(offer.ts);
    const expiresAt = Date.parse(offer.expires_at);
    if (
      !Number.isFinite(settledAt) ||
      !Number.isFinite(offeredAt) ||
      !Number.isFinite(expiresAt) ||
      settledAt < offeredAt ||
      settledAt > expiresAt
    )
      continue;
    for (const messageId of offer.deliver_ids) {
      const message = messagesById.get(messageId);
      if (message?.to === offer.recipient && !deliveredAt.has(messageId)) {
        deliveredAt.set(messageId, settlement.ts);
      }
      if (message?.to === offer.recipient) latestDeliveredAt.set(messageId, settlement.ts);
    }
  }
  const reserved = new Set<string>();
  for (const offer of offers.values()) {
    const expiresAt = Date.parse(offer.expires_at);
    if (settlements.has(offer.offer_id) || !Number.isFinite(expiresAt) || expiresAt <= nowMs)
      continue;
    for (const messageId of offer.deliver_ids) {
      const message = messagesById.get(messageId);
      if (message?.to === offer.recipient) reserved.add(messageId);
    }
  }
  return { messages, deliveredAt, latestDeliveredAt, offers, settlements, reserved };
}

function messageEntry(
  message: MessageRecord,
  delivered: boolean,
  state: 'candidate' | 'skipped',
  reason: string
): MessagePruneEntry {
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
  readonly status: MessagePruneStatus;
  readonly olderThanMs?: number;
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  readonly apply?: boolean;
}

function buildMessagePrunePlan(
  cawsDir: string,
  opts: MessagePruneOptions
): Result<MessagePrunePlan & { readonly lines: readonly ParsedMessageLine[] }> {
  const loaded = readMessageLines(cawsDir);
  if (!loaded.ok) return err(loaded.errors);
  const state = replayMessageLedger(loaded.value.lines);

  const include = new Set(opts.include ?? []);
  const exclude = new Set(opts.exclude ?? []);
  const hasInclude = include.size > 0;
  const hasAge = typeof opts.olderThanMs === 'number' && Number.isFinite(opts.olderThanMs);
  const now = Date.now();
  const candidates: MessagePruneEntry[] = [];
  const skipped: MessagePruneEntry[] = [];

  if (opts.status === 'undelivered-to-dead-session') {
    // CAWS-DEFECT-MESSAGE-PRUNE-DEAD-RECIPIENT-01 — see MessagePruneStatus.
    // The floor always applies (default 7d); an explicit --older-than-ms (0
    // allowed) overrides it. Liveness is resolved once per unique recipient,
    // lazily, and a registry load failure fails the whole plan closed — a
    // recipient is never guessed dead.
    const floorMs = hasAge ? (opts.olderThanMs as number) : DEFAULT_DEAD_RECIPIENT_RETENTION_MS;
    const livenessByRecipient = new Map<string, { live: boolean; idle: boolean }>();
    const livenessFor = (recipient: string): Result<{ live: boolean; idle: boolean }> => {
      const cached = livenessByRecipient.get(recipient);
      if (cached !== undefined) return ok(cached);
      const liveness = describeRecipientLiveness(cawsDir, recipient);
      if (!liveness.ok) return err(liveness.errors);
      const verdict = {
        live: liveness.value.live,
        idle: liveness.value.idle === true,
      };
      livenessByRecipient.set(recipient, verdict);
      return ok(verdict);
    };

    for (const entry of loaded.value.lines) {
      if (entry.parsed?.record !== 'message') continue;
      const message = entry.parsed;
      if (state.deliveredAt.has(message.id)) {
        // Delivered messages belong to the delivered selector; this mode
        // never selects them.
        skipped.push(messageEntry(message, true, 'skipped', 'delivered'));
        continue;
      }
      if (hasInclude && !include.has(message.id)) {
        skipped.push(messageEntry(message, false, 'skipped', 'not-included'));
        continue;
      }
      if (exclude.has(message.id)) {
        skipped.push(messageEntry(message, false, 'skipped', 'excluded'));
        continue;
      }
      if (state.reserved.has(message.id)) {
        // An unexpired offer holds this message for adapter settlement —
        // let the settlement conclude before retention touches it.
        skipped.push(messageEntry(message, false, 'skipped', 'offer-pending'));
        continue;
      }
      const ts = Date.parse(message.ts);
      const ageMs = Number.isFinite(ts) ? now - ts : 0;
      if (ageMs < floorMs) {
        skipped.push(messageEntry(message, false, 'skipped', 'newer-than-floor'));
        continue;
      }
      const liveness = livenessFor(message.to);
      if (!liveness.ok) return err(liveness.errors);
      if (liveness.value.live && !liveness.value.idle) {
        skipped.push(messageEntry(message, false, 'skipped', 'recipient-live'));
        continue;
      }
      if (liveness.value.live && liveness.value.idle) {
        // Stopped lease + fresh heartbeat: idle between turns, deliverable.
        skipped.push(messageEntry(message, false, 'skipped', 'recipient-idle'));
        continue;
      }
      candidates.push(messageEntry(message, false, 'candidate', 'recipient-dead'));
    }

    const candidateIds = new Set(candidates.map((candidate) => candidate.id));
    const fullyPrunedOffers = new Set(
      [...state.offers.values()]
        .filter((offer) => offer.deliver_ids.every((id) => candidateIds.has(id)))
        .map((offer) => offer.offer_id)
    );
    const deliveryRecordsToRemove = loaded.value.lines.filter(
      (entry) =>
        (entry.parsed?.record === 'delivery' && candidateIds.has(entry.parsed.deliver_id)) ||
        (entry.parsed?.record === 'offer_settlement' &&
          entry.parsed.outcome === 'delivered' &&
          fullyPrunedOffers.has(entry.parsed.offer_id))
    ).length;

    return ok({
      status: opts.status,
      apply: opts.apply === true,
      candidates,
      skipped,
      diagnostics: loaded.value.diagnostics,
      delivery_records_to_remove: deliveryRecordsToRemove,
      // The selector IS the narrowness here: dead-recipient + floor. Apply
      // does not additionally demand --older-than-ms/--include.
      selector_required_for_apply: false,
      dead_recipient_floor_ms: floorMs,
      lines: loaded.value.lines,
    });
  }

  for (const entry of loaded.value.lines) {
    if (entry.parsed?.record !== 'message') continue;
    const message = entry.parsed;
    const isDelivered = state.deliveredAt.has(message.id);
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
  const fullyPrunedOffers = new Set(
    [...state.offers.values()]
      .filter((offer) => offer.deliver_ids.every((id) => candidateIds.has(id)))
      .map((offer) => offer.offer_id)
  );
  const deliveryRecordsToRemove = loaded.value.lines.filter(
    (entry) =>
      (entry.parsed?.record === 'delivery' && candidateIds.has(entry.parsed.deliver_id)) ||
      (entry.parsed?.record === 'offer_settlement' &&
        entry.parsed.outcome === 'delivered' &&
        fullyPrunedOffers.has(entry.parsed.offer_id))
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

export function pruneMessages(
  cawsDir: string,
  opts: MessagePruneOptions
): Result<MessagePruneResult> {
  return withLifecycleLock(
    cawsDir,
    () => {
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
      const state = replayMessageLedger(lines);
      const fullyPrunedOffers = new Set(
        [...state.offers.values()]
          .filter((offer) => offer.deliver_ids.every((id) => candidateIds.has(id)))
          .map((offer) => offer.offer_id)
      );
      let prunedDeliveryRecords = 0;
      const keptLines: string[] = [];
      const archivedLines: string[] = [];
      for (const entry of lines) {
        if (entry.parsed?.record === 'message' && candidateIds.has(entry.parsed.id)) {
          archivedLines.push(entry.raw);
          continue;
        }
        if (entry.parsed?.record === 'delivery' && candidateIds.has(entry.parsed.deliver_id)) {
          prunedDeliveryRecords++;
          archivedLines.push(entry.raw);
          continue;
        }
        if (entry.parsed?.record === 'offer' && fullyPrunedOffers.has(entry.parsed.offer_id)) {
          archivedLines.push(entry.raw);
          continue;
        }
        if (
          entry.parsed?.record === 'offer_settlement' &&
          fullyPrunedOffers.has(entry.parsed.offer_id)
        ) {
          if (entry.parsed.outcome === 'delivered') prunedDeliveryRecords++;
          archivedLines.push(entry.raw);
          continue;
        }
        keptLines.push(entry.raw);
      }

      // Archive-first (CAWS-MESSAGE-LEDGER-COMPLETENESS-001): append the pruned
      // records plus one {record: 'prune', ids, ts} marker to the archive BEFORE
      // rewriting the live ledger, so pruned history is never silently dropped.
      // The archive is telemetry, not authority — no command reads it for
      // delivery state. A retried prune re-appends (append-only log semantics).
      // CAWS-DEFECT-MESSAGE-PRUNE-DEAD-RECIPIENT-01: the dead-recipient marker
      // names its selector so archived dead letters are distinguishable from
      // delivered-retention prunes; the delivered marker is byte-unchanged.
      const marker = JSON.stringify({
        record: 'prune',
        ...(plan.status === 'undelivered-to-dead-session' ? { selector: plan.status } : {}),
        ids: plan.candidates.map((candidate) => candidate.id),
        ts: new Date().toISOString(),
      });
      try {
        fs.appendFileSync(
          path.join(cawsDir, MESSAGES_ARCHIVE_FILENAME),
          [marker, ...archivedLines].join('\n') + '\n'
        );
      } catch (e) {
        return err(
          storeDiagnostic(
            STORE_RULES.MESSAGES_ARCHIVE_APPEND_FAILED,
            `Failed to append pruned records to ${MESSAGES_ARCHIVE_FILENAME}: ${(e as Error).message}. ` +
              `The live ledger was NOT modified.`
          )
        );
      }

      const file = messagesPath(cawsDir);
      const written = writeFileAtomic(
        file,
        keptLines.length > 0 ? keptLines.join('\n') + '\n' : ''
      );
      if (!written.ok) return err(written.errors);

      return ok({
        ...plan,
        applied: true,
        pruned_messages: plan.candidates.length,
        pruned_delivery_records: prunedDeliveryRecords,
      });
    },
    {
      lockPath: path.join(cawsDir, MESSAGES_LOCK_FILENAME),
    }
  );
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
export function pollMessage(
  cawsDir: string,
  me: string,
  options: PollOptions = {}
): Result<PollResult> {
  const waitMs = Math.min(Math.max(0, options.waitMs ?? 0), MAX_WAIT_MS);
  const deadline = Date.now() + waitMs;
  const receipt = options.receipt === 'auto' ? 'auto' : 'poll';
  const drain = Math.min(Math.max(1, Math.floor(options.drain ?? 1)), MAX_DRAIN);
  const offer = options.offer === true && options.peek !== true;
  const offerTtlMs = Math.min(
    Math.max(1, Math.floor(options.offerTtlMs ?? DEFAULT_OFFER_TTL_MS)),
    MAX_OFFER_TTL_MS
  );
  const attempt = () =>
    withLifecycleLock(
      cawsDir,
      () =>
        pollMessageLocked(cawsDir, me, options.peek === true, receipt, drain, offer, offerTtlMs),
      {
        lockPath: path.join(cawsDir, MESSAGES_LOCK_FILENAME),
      }
    );

  // First attempt is always made. If waiting and empty, retry until the deadline,
  // releasing the lock between tries (the lock is scoped to each attempt() call).
  for (;;) {
    const r = attempt();
    if (!r.ok) return r;
    if (r.value.message || waitMs === 0 || Date.now() >= deadline) return r;
    sleepSyncMs(POLL_RETRY_MS);
  }
}

function pollMessageLocked(
  cawsDir: string,
  me: string,
  peek: boolean,
  receipt: 'auto' | 'poll',
  drain: number,
  createOffer: boolean,
  offerTtlMs: number
): Result<PollResult> {
  const loaded = readMessageLines(cawsDir);
  if (!loaded.ok) return err(loaded.errors);
  const state = replayMessageLedger(loaded.value.lines);
  const diagnostics = loaded.value.diagnostics;

  const undelivered = state.messages
    .filter((m) => m.to === me && !state.deliveredAt.has(m.id) && !state.reserved.has(m.id))
    .sort((a, b) => {
      // Critical-first, then oldest-first (CAWS-MESSAGE-DELIVERY-ECONOMICS-001).
      const aCrit = a.urgency === 'critical' ? 0 : 1;
      const bCrit = b.urgency === 'critical' ? 0 : 1;
      if (aCrit !== bCrit) return aCrit - bCrit;
      return a.ts.localeCompare(b.ts);
    });
  const picked = undelivered.slice(0, drain);
  if (picked.length === 0) return ok({ message: null, messages: [], diagnostics });

  const polled: PolledMessage[] = picked.map((m) => {
    const sender = senderContextFor(cawsDir, m.actor.session_id ?? m.actor.id);
    return { message: m, ...(sender !== undefined ? { sender } : {}) };
  });
  const head = polled[0] as PolledMessage;

  // Peek: return the picked messages but do NOT consume them — no delivery
  // records, so a subsequent normal poll still delivers them.
  if (peek) {
    return ok({
      message: head.message,
      ...(head.sender !== undefined ? { sender: head.sender } : {}),
      messages: polled,
      diagnostics,
    });
  }

  if (createOffer) {
    const nowMs = Date.now();
    const offerRecord: MessageOfferRecord = {
      record: 'offer',
      offer_id: crypto.randomUUID(),
      recipient: me,
      deliver_ids: polled.map((entry) => entry.message.id),
      ts: new Date(nowMs).toISOString(),
      expires_at: new Date(nowMs + offerTtlMs).toISOString(),
      mode: 'auto',
    };
    const offerAppend = appendLine(cawsDir, offerRecord);
    if (!offerAppend.ok) return err(offerAppend.errors);
    return ok({
      message: head.message,
      ...(head.sender !== undefined ? { sender: head.sender } : {}),
      messages: polled,
      offer: {
        id: offerRecord.offer_id,
        recipient: offerRecord.recipient,
        messageIds: offerRecord.deliver_ids,
        expiresAt: offerRecord.expires_at,
      },
      diagnostics,
    });
  }

  for (const entry of polled) {
    const deliveryAppend = appendLine(cawsDir, {
      record: 'delivery',
      deliver_id: entry.message.id,
      ts: new Date().toISOString(),
      mode: receipt,
    });
    if (!deliveryAppend.ok) return err(deliveryAppend.errors);
  }
  return ok({
    message: head.message,
    ...(head.sender !== undefined ? { sender: head.sender } : {}),
    messages: polled,
    diagnostics,
  });
}

/** Settle one exact live offer. A delivered settlement records successful
 * adapter handoff, not recipient-context visibility. Released offers retry. */
export function settleMessageOffer(
  cawsDir: string,
  offerId: string,
  recipient: string,
  outcome: 'delivered' | 'released'
): Result<MessageOfferSettlement> {
  return withLifecycleLock(
    cawsDir,
    () => {
      const loaded = readMessageLines(cawsDir);
      if (!loaded.ok) return err(loaded.errors);
      const state = replayMessageLedger(loaded.value.lines);
      const offer = state.offers.get(offerId);
      if (!offer) {
        return err(
          storeDiagnostic(
            STORE_RULES.MESSAGES_OFFER_NOT_FOUND,
            `Message offer "${offerId}" does not exist.`
          )
        );
      }
      if (offer.recipient !== recipient) {
        return err(
          storeDiagnostic(
            STORE_RULES.MESSAGES_OFFER_RECIPIENT_MISMATCH,
            `Message offer "${offerId}" belongs to recipient "${offer.recipient}", not "${recipient}".`
          )
        );
      }
      if (state.settlements.has(offerId)) {
        return err(
          storeDiagnostic(
            STORE_RULES.MESSAGES_OFFER_NOT_ACTIVE,
            `Message offer "${offerId}" is already settled; replay is refused.`
          )
        );
      }
      const expiresAt = Date.parse(offer.expires_at);
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
        return err(
          storeDiagnostic(
            STORE_RULES.MESSAGES_OFFER_NOT_ACTIVE,
            `Message offer "${offerId}" expired and is no longer eligible for settlement.`
          )
        );
      }
      if (offer.deliver_ids.some((messageId) => state.deliveredAt.has(messageId))) {
        return err(
          storeDiagnostic(
            STORE_RULES.MESSAGES_OFFER_NOT_ACTIVE,
            `Message offer "${offerId}" contains a message already delivered by another consumer.`
          )
        );
      }
      const now = new Date().toISOString();
      const settlement: MessageOfferSettlementRecord = {
        record: 'offer_settlement',
        offer_id: offerId,
        recipient,
        outcome,
        ts: now,
        ...(outcome === 'delivered' ? { boundary: 'adapter_handoff' as const } : {}),
      };
      const appended = appendLine(cawsDir, settlement);
      if (!appended.ok) return err(appended.errors);
      return ok({
        offerId,
        recipient,
        outcome,
        settledAt: now,
        ...(settlement.boundary !== undefined ? { boundary: settlement.boundary } : {}),
      });
    },
    { lockPath: path.join(cawsDir, MESSAGES_LOCK_FILENAME) }
  );
}

/**
 * Count undelivered messages addressed to `me` (mailbox depth) — read-only triage,
 * no consumption. Used by `caws message poll --peek` / inbox display.
 */
export function inboxCount(cawsDir: string, me: string): Result<number> {
  const loaded = readMessageLines(cawsDir);
  if (!loaded.ok) return err(loaded.errors);
  const state = replayMessageLedger(loaded.value.lines);
  return ok(state.messages.filter((m) => m.to === me && !state.deliveredAt.has(m.id)).length);
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
  const loaded = readMessageLines(cawsDir);
  if (!loaded.ok) return err(loaded.errors);
  const state = replayMessageLedger(loaded.value.lines);
  const waitingMessages = state.messages.filter((m) => m.to === me && !state.deliveredAt.has(m.id));
  const limit =
    typeof opts.limit === 'number' && Number.isFinite(opts.limit) && opts.limit >= 0
      ? Math.floor(opts.limit)
      : waitingMessages.length;
  return ok({
    messages: waitingMessages.slice(0, limit),
    waiting: waitingMessages.length,
    diagnostics: loaded.value.diagnostics,
  });
}

/** One undelivered message anywhere in the repo, with its recipient and age. */
export interface InboxAllEntry {
  readonly message: MessageRecord;
  readonly recipient: string;
  readonly ageMs: number;
}

export interface MessageInboxAllResult {
  readonly messages: readonly InboxAllEntry[];
  readonly count: number;
  readonly oldestAgeMs: number | null;
  readonly diagnostics: ReadonlyArray<Diagnostic>;
}

/**
 * Repo-wide undelivered view (CAWS-MESSAGE-LEDGER-COMPLETENESS-001): every
 * message with no delivery record, oldest-first, annotated with recipient and
 * age. Read-only — consumes nothing. Lets a sender or operator see queued
 * mail without polling a specific mailbox.
 */
/** One of the caller's sent-but-undelivered messages with its age. */
export interface MineQueuedEntry {
  readonly message: MessageRecord;
  readonly ageMs: number;
}

export interface MineQueuedResult {
  readonly messages: readonly MineQueuedEntry[];
  readonly count: number;
  readonly oldestAgeMs: number | null;
  readonly diagnostics: ReadonlyArray<Diagnostic>;
}

/**
 * The caller's dead letters (CAWS-MESSAGE-BEHAVIOR-001): messages SENT by
 * `me` that still have no delivery record and are older than `olderThanMs`,
 * oldest-first. Read-only — consumes nothing. Lets a sender see its own
 * queued mail without polling each recipient.
 */
export function mineQueued(
  cawsDir: string,
  me: string,
  olderThanMs: number
): Result<MineQueuedResult> {
  const loaded = readMessageLines(cawsDir);
  if (!loaded.ok) return err(loaded.errors);
  const state = replayMessageLedger(loaded.value.lines);
  const mine: MessageRecord[] = [];
  for (const entry of loaded.value.lines) {
    if (entry.parsed?.record === 'message') {
      const from = entry.parsed.actor.session_id ?? entry.parsed.actor.id;
      if (from === me) mine.push(entry.parsed);
    }
  }
  const now = Date.now();
  const aged = mine
    .filter((m) => !state.deliveredAt.has(m.id))
    .map((message) => {
      const ts = Date.parse(message.ts);
      return { message, ageMs: Number.isFinite(ts) ? Math.max(0, now - ts) : 0 };
    })
    .filter((entry) => entry.ageMs >= Math.max(0, olderThanMs))
    .sort((a, b) => a.message.ts.localeCompare(b.message.ts));
  return ok({
    messages: aged,
    count: aged.length,
    oldestAgeMs: aged.length > 0 ? (aged[0]?.ageMs ?? null) : null,
    diagnostics: loaded.value.diagnostics,
  });
}

/** Per-platform engagement derived from the ledger and leases (display-only). */
export interface PlatformEngagement {
  readonly to: number;
  readonly from: number;
  readonly ratio: number | null;
}

/**
 * Platform engagement (CAWS-MESSAGE-BEHAVIOR-001): for every platform,
 * inbound message count (sent TO its sessions) and outbound count (sent BY
 * its sessions). Recipient platforms come from leases; senders without a
 * lease fall back to the record's actor.platform, then 'unknown'. Derived,
 * display-only — never authority.
 */
export function platformEngagement(cawsDir: string): Result<Record<string, PlatformEngagement>> {
  const loaded = readMessageLines(cawsDir);
  if (!loaded.ok) return err(loaded.errors);
  const leasesResult = loadLeases(cawsDir);
  const leases = leasesResult.ok ? leasesResult.value.leases : {};
  const buckets: Record<string, { to: number; from: number }> = {};
  const bump = (platform: string, key: 'to' | 'from') => {
    const b = (buckets[platform] ??= { to: 0, from: 0 });
    b[key] += 1;
  };
  for (const entry of loaded.value.lines) {
    if (entry.parsed?.record !== 'message') continue;
    const m = entry.parsed;
    const toLease = leases[m.to] as { platform?: string } | undefined;
    const toPlatform = toLease?.platform ?? 'unknown';
    bump(toPlatform, 'to');
    const fromId = m.actor.session_id ?? m.actor.id;
    const fromLease = leases[fromId] as { platform?: string } | undefined;
    const fromPlatform = fromLease?.platform ?? m.actor.platform ?? 'unknown';
    bump(fromPlatform, 'from');
  }
  const out: Record<string, PlatformEngagement> = {};
  for (const [platform, b] of Object.entries(buckets)) {
    out[platform] = { to: b.to, from: b.from, ratio: b.to > 0 ? b.from / b.to : null };
  }
  return ok(out);
}

export function inboxAllMessages(cawsDir: string): Result<MessageInboxAllResult> {
  const loaded = readMessageLines(cawsDir);
  if (!loaded.ok) return err(loaded.errors);
  const state = replayMessageLedger(loaded.value.lines);
  const now = Date.now();
  const undelivered = state.messages
    .filter((m) => !state.deliveredAt.has(m.id))
    .sort((a, b) => a.ts.localeCompare(b.ts))
    .map((message) => {
      const ts = Date.parse(message.ts);
      return {
        message,
        recipient: message.to,
        ageMs: Number.isFinite(ts) ? Math.max(0, now - ts) : 0,
      };
    });
  return ok({
    messages: undelivered,
    count: undelivered.length,
    oldestAgeMs: undelivered[0]?.ageMs ?? null,
    diagnostics: loaded.value.diagnostics,
  });
}

/** A message record plus its read-time derived delivery state. */
export interface MessageDeliveryState {
  readonly message: MessageRecord;
  /** True when a delivery record for this message id exists (the recipient consumed it). */
  readonly delivered: boolean;
  /** Delivery-record timestamp; present only when delivered. */
  readonly deliveredAt?: string;
}

/**
 * Find a message by id, with its derived delivery state (CAWS-MESSAGE-DELIVERY-
 * UX-001). Read-only: appends nothing. Returns ok(null) when the id is absent —
 * absence is a not-found answer, not a load error.
 */
export function getMessageDeliveryState(
  cawsDir: string,
  messageId: string
): Result<MessageDeliveryState | null> {
  const loaded = readMessageLines(cawsDir);
  if (!loaded.ok) return err(loaded.errors);
  const state = replayMessageLedger(loaded.value.lines);
  const target = state.messages.find((message) => message.id === messageId) ?? null;
  const deliveredAt = state.latestDeliveredAt.get(messageId);
  if (target === null) return ok(null);
  return ok({
    message: target,
    delivered: deliveredAt !== undefined,
    ...(deliveredAt !== undefined ? { deliveredAt } : {}),
  });
}

/** A channel-history entry: the message plus its derived delivery state. */
export interface HistoryEntry extends MessageRecord {
  readonly delivered: boolean;
  readonly deliveredAt?: string;
}

/**
 * Full, non-lossy history between two endpoints (both directions, in order),
 * each entry annotated with its derived delivery state so a SENDER can observe
 * whether a message was consumed (queued vs seen) without polling the
 * recipient's mailbox.
 */
export function channelHistory(cawsDir: string, a: string, b: string): Result<HistoryEntry[]> {
  const loaded = readMessageLines(cawsDir);
  if (!loaded.ok) return err(loaded.errors);
  const ch = channelId(a, b);
  const state = replayMessageLedger(loaded.value.lines);
  const channelMessages = state.messages.filter((message) => message.channel === ch);
  return ok(
    channelMessages.map((message) => {
      const at = state.deliveredAt.get(message.id);
      return {
        ...message,
        delivered: at !== undefined,
        ...(at !== undefined ? { deliveredAt: at } : {}),
      };
    })
  );
}
