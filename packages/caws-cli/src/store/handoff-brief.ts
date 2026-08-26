// Handoff brief store (HANDOFF-EXPORT-IMPORT-001).
//
// Builds the portable, METADATA-ONLY handoff brief for a session: identity,
// claim, lease work_state, claimed_paths, and the handoff events already in
// the audit chain. NO file contents, NO turn transcripts, NO command history
// are ever read or exported (failure-lineage Entry 24: secret-bearing paths
// appear by NAME ONLY; content leakage is impossible by construction because
// content is never read).
//
// Briefs live under .caws/handoffs/<id>.json (Entry 33: provenance-adjacent,
// gitignored, never user tmp/, never package-shipped).

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { isOk } from '../kernel';
import { loadEvents } from './events-store';
import { loadLeases } from './leases-store';
import { loadWorktrees } from './worktrees-store';

export const HANDOFFS_DIRNAME = 'handoffs';

/** The scan-secrets pattern class (Entry 24): redact these paths to NAME ONLY. */
const SECRET_PATH_PATTERNS: readonly RegExp[] = [
  /^\.env($|[./])/i,
  /\.pem$/i,
  /\.key$/i,
  /(^|\/)id_rsa/i,
  /(^|\/)\.ssh\//i,
  /(^|\/)\.aws\//i,
  /(^|\/)\.gcloud\//i,
  /(^|\/)\.gnupg\//i,
  /\.p12$/i,
  /\.pfx$/i,
  /(^|\/)credentials(\.|$)/i,
  /(^|\/)secrets?(\.|$)/i,
];

/** Redact a path to name-only when it matches the secret-bearing class. */
export function redactPath(p: string): string {
  const normalized = p.replace(/\\/g, '/').replace(/^\.\//, '');
  for (const pattern of SECRET_PATH_PATTERNS) {
    if (pattern.test(normalized)) {
      return `${normalized} [REDACTED: secret-bearing path — name only, content never exported]`;
    }
  }
  return normalized;
}

export interface HandoffBrief {
  readonly brief_version: 1;
  readonly exported_at: string;
  /** The session whose context this brief captures. */
  readonly source_session: {
    readonly session_id: string;
    readonly platform?: string;
    readonly work_state?: string;
    readonly work_state_note?: string;
    readonly claimed_paths: readonly string[];
    readonly bound_worktree?: string;
    readonly bound_spec_id?: string;
  };
  /**
   * The operator that exported this brief. Defaults to the source session
   * (self-export); when --session names a PEER, this records the OPERATOR as
   * the exporting authority (consent gating).
   */
  readonly exported_by: string;
  /** Prior handoff events for this session, from the hash-chained audit log. */
  readonly prior_handoffs: readonly {
    readonly event: string;
    readonly ts: string;
    readonly source_session?: string;
    readonly receiving_session?: string;
    readonly paths?: readonly string[];
    readonly seq?: number;
  }[];
  /** sha256 over the canonical JSON of the brief without this field. */
  readonly content_sha256: string;
}

/** The handoff event types from the phase-1 taxonomy. */
const HANDOFF_EVENT_TYPES = new Set(['stash_restore', 'claim_transfer', 'overlap_ack_proceed', 'manual_pickup']);

/** Build the metadata-only brief for a session. Pure over the on-disk snapshot. */
export function buildHandoffBrief(input: {
  readonly cawsDir: string;
  readonly sessionId: string;
  readonly exportedBy: string;
  readonly now: string;
}): HandoffBrief | null {
  // Lease metadata (operational cache read; work_state + claimed_paths).
  let lease:
    | { platform?: string; work_state?: string; work_state_note?: string; claimed_paths?: readonly string[]; bound_worktree?: string; bound_spec_id?: string }
    | undefined;
  const leases = loadLeases(input.cawsDir);
  if (isOk(leases)) {
    lease = leases.value.leases[input.sessionId];
  }

  // Worktree registry: any worktree owned by this session.
  let boundWorktree: string | undefined;
  let boundSpecId: string | undefined;
  const registry = loadWorktrees(input.cawsDir);
  if (isOk(registry)) {
    for (const [name, record] of Object.entries(registry.value)) {
      if (record && typeof record === 'object' && 'owner' in record) {
        const owner = (record as { owner?: { session_id?: string } }).owner;
        if (owner?.session_id === input.sessionId) {
          boundWorktree = name;
          boundSpecId = (record as { specId?: string }).specId ?? undefined;
          break;
        }
      }
    }
  }

  // Prior handoff events involving this session (from the audit chain).
  const prior: {
    event: string;
    ts: string;
    source_session?: string;
    receiving_session?: string;
    paths?: readonly string[];
    seq?: number;
  }[] = [];
  const events = loadEvents(input.cawsDir);
  if (isOk(events)) {
    for (const ev of events.value.events) {
      if (!HANDOFF_EVENT_TYPES.has(ev.event)) continue;
      const data = (ev.data ?? {}) as Record<string, unknown>;
      const src = typeof data['source_session'] === 'string' ? data['source_session'] : undefined;
      const rcv = typeof data['receiving_session'] === 'string' ? data['receiving_session'] : undefined;
      if (src !== input.sessionId && rcv !== input.sessionId) continue;
      prior.push({
        event: ev.event,
        ts: ev.ts,
        ...(src !== undefined ? { source_session: src } : {}),
        ...(rcv !== undefined ? { receiving_session: rcv } : {}),
        ...(Array.isArray(data['paths']) ? { paths: (data['paths'] as unknown[]).filter((p): p is string => typeof p === 'string').map(redactPath) } : {}),
        ...(typeof ev.seq === 'number' ? { seq: ev.seq } : {}),
      });
    }
  }

  const brief: Omit<HandoffBrief, 'content_sha256'> = {
    brief_version: 1,
    exported_at: input.now,
    source_session: {
      session_id: input.sessionId,
      ...(lease?.platform !== undefined ? { platform: lease.platform } : {}),
      ...(lease?.work_state !== undefined ? { work_state: lease.work_state } : {}),
      ...(lease?.work_state_note !== undefined ? { work_state_note: lease.work_state_note } : {}),
      claimed_paths: (lease?.claimed_paths ?? []).map(redactPath),
      ...(boundWorktree !== undefined ? { bound_worktree: boundWorktree } : {}),
      ...(boundSpecId !== undefined ? { bound_spec_id: boundSpecId } : {}),
    },
    exported_by: input.exportedBy,
    prior_handoffs: prior,
  };

  const contentSha256 = crypto
    .createHash('sha256')
    .update(canonicalJson(brief))
    .digest('hex');
  return { ...brief, content_sha256: contentSha256 };
}

/** Deterministic JSON (sorted keys) so the same state yields the same brief. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Write a brief under .caws/handoffs/<id>.json (Entry 33 scoping). */
export function writeHandoffBrief(
  cawsDir: string,
  brief: HandoffBrief
): { ok: true; path: string } | { ok: false; reason: string } {
  const dir = path.join(cawsDir, HANDOFFS_DIRNAME);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    return { ok: false, reason: `failed to create ${dir}: ${(e as Error).message}` };
  }
  const id = `brief-${brief.source_session.session_id}-${brief.exported_at.replace(/[:.]/g, '-')}`;
  const filePath = path.join(dir, `${id}.json`);
  try {
    fs.writeFileSync(filePath, JSON.stringify(brief, null, 2) + '\n');
  } catch (e) {
    return { ok: false, reason: `failed to write ${filePath}: ${(e as Error).message}` };
  }
  return { ok: true, path: filePath };
}

/** Read + shape-validate a brief file. Missing != malformed (null = absent). */
export function readHandoffBrief(
  filePath: string
): HandoffBrief | { malformed: true; reason: string } | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { malformed: true, reason: `not valid JSON: ${(e as Error).message}` };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { malformed: true, reason: 'root is not an object' };
  }
  const obj = parsed as Record<string, unknown>;
  const source = obj['source_session'];
  if (typeof source !== 'object' || source === null || typeof (source as { session_id?: unknown }).session_id !== 'string') {
    return { malformed: true, reason: 'source_session.session_id missing or not a string' };
  }
  return parsed as HandoffBrief;
}
