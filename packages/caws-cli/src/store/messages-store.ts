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

import { type Diagnostic, type Result, ok, err } from '../kernel';

import { writeFileAtomic } from './atomic-write';
import { loadLeases } from './leases-store';
import { withLifecycleLock } from './lifecycle-lock';
import { sleepSyncMs, storeDiagnostic } from './repo-root';
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
export function describeRecipientLiveness(cawsDir: string, sessionId: string): Result<RecipientLiveness> {
  const leasesResult = loadLeases(cawsDir);
  if (!leasesResult.ok) return err(leasesResult.errors);
  const lease = leasesResult.value.leases[sessionId] as
    | { status?: string; last_active?: string }
    | undefined;
  if (!lease) return ok({ live: false, reason: 'no_lease' });
  const status = lease.status;
  const ageMs = typeof lease.last_active === 'string' ? Date.now() - Date.parse(lease.last_active) : NaN;
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
 * On success, persists a 'message' record and returns it.
 */
export function sendMessage(
  cawsDir: string,
  params: { actor: MessageActor; to: string; text: string; requireLive?: boolean }
): Result<MessageSendOutcome> {
  const { actor, to, text } = params;
  if (typeof to !== 'string' || to.length === 0 || !ENDPOINT_RE.test(to)) {
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
      return err(
        storeDiagnostic(
          STORE_RULES.MESSAGES_RECIPIENT_NOT_LIVE,
          `Recipient session "${to}" is not live (reason: ${describeNotLiveReason(liveness.value)}). ` +
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
    if (
      best === null ||
      ageMs < best.ageMs ||
      (ageMs === best.ageMs && best.stopped && !stopped)
    ) {
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

export interface PollResult {
  /** The next undelivered message addressed to `me`, or null if none. */
  readonly message: MessageRecord | null;
  /**
   * Sender context joined from the lease registry at read time (worktree /
   * spec / branch — each present only when the sender's lease records it), so
   * a recipient never depends on the sender self-identifying in the body.
   * Absent when the message is null or the sender has no lease.
   */
  readonly sender?: MessageSenderContext;
  readonly diagnostics: ReadonlyArray<Diagnostic>;
}

/** Registry-derived context about a message's sender (CAWS-MESSAGE-DELIVERY-UX-001). */
export interface MessageSenderContext {
  readonly worktree?: string;
  readonly specId?: string;
  readonly branch?: string;
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
    | { bound_worktree?: unknown; bound_spec_id?: unknown; branch?: unknown }
    | undefined;
  if (!lease) return undefined;
  const ctx: { worktree?: string; specId?: string; branch?: string } = {};
  if (typeof lease.bound_worktree === 'string' && lease.bound_worktree.length > 0) {
    ctx.worktree = lease.bound_worktree;
  }
  if (typeof lease.bound_spec_id === 'string' && lease.bound_spec_id.length > 0) {
    ctx.specId = lease.bound_spec_id;
  }
  if (typeof lease.branch === 'string' && lease.branch.length > 0) {
    ctx.branch = lease.branch;
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
    sleepSyncMs(POLL_RETRY_MS);
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
  const sender = senderContextFor(cawsDir, next.actor.session_id ?? next.actor.id);
  const withSender = { ...(sender !== undefined ? { sender } : {}) };

  // Peek: return the message but do NOT consume it — no delivery record, so a
  // subsequent normal poll still delivers it.
  if (peek) {
    return ok({ message: next, ...withSender, diagnostics });
  }

  const deliveryAppend = appendLine(cawsDir, {
    record: 'delivery',
    deliver_id: next.id,
    ts: new Date().toISOString(),
  });
  if (!deliveryAppend.ok) return err(deliveryAppend.errors);
  return ok({ message: next, ...withSender, diagnostics });
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
export function getMessageDeliveryState(cawsDir: string, messageId: string): Result<MessageDeliveryState | null> {
  const loaded = readMessageLines(cawsDir);
  if (!loaded.ok) return err(loaded.errors);
  let target: MessageRecord | null = null;
  let deliveredAt: string | undefined;
  for (const entry of loaded.value.lines) {
    if (entry.parsed?.record === 'message' && entry.parsed.id === messageId) {
      target = entry.parsed;
    } else if (entry.parsed?.record === 'delivery' && entry.parsed.deliver_id === messageId) {
      deliveredAt = entry.parsed.ts;
    }
  }
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
  // Two passes: a message's delivery record ALWAYS trails the message in line
  // order (delivery happens after the send), so a single interleaved pass
  // would annotate every entry undelivered.
  const deliveredAt = new Map<string, string>();
  const channelMessages: MessageRecord[] = [];
  for (const entry of loaded.value.lines) {
    if (entry.parsed?.record === 'delivery' && typeof entry.parsed.deliver_id === 'string') {
      // First delivery record wins for the timestamp (deliver-once; a second
      // record for the same id would be a replay artifact, not a re-delivery).
      if (!deliveredAt.has(entry.parsed.deliver_id)) deliveredAt.set(entry.parsed.deliver_id, entry.parsed.ts);
    } else if (entry.parsed?.record === 'message' && entry.parsed.channel === ch) {
      channelMessages.push(entry.parsed);
    }
  }
  return ok(
    channelMessages.map((message) => {
      const at = deliveredAt.get(message.id);
      return {
        ...message,
        delivered: at !== undefined,
        ...(at !== undefined ? { deliveredAt: at } : {}),
      };
    })
  );
}
