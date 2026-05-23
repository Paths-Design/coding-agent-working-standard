// Agent-lease store — the SOLE I/O surface for .caws/leases/.
//
// MULTI-AGENT-ACTIVITY-REGISTRY-001 acceptance A5–A8, A12.
//
// Architectural separation (load-bearing — see spec invariant 2):
//
//   - This module owns ALL lease I/O. apply-patch.ts is NOT extended to
//     handle LeasePatch. Lease writes never flow through applyRegistryPatch.
//     Routing lease writes through the governance apply path would re-merge
//     the operational-cache / governance-state boundary this slice exists
//     to preserve.
//
//   - Lease writes are NEVER inside lifecycle-transaction. They never block
//     work, never corrupt governance state, and a write failure is warn-
//     and-continue (per doctrine §6 invariant 11).
//
//   - Lease writes NEVER append events.jsonl (per doctrine §6 invariant 10).
//     Events are durable governance facts; leases are operational cache.
//
//   - loadLeases is LENIENT per file. A single malformed lease file
//     produces a diagnostic and is excluded from the returned registry;
//     the call still returns ok. Only an unreadable lease directory
//     causes the call to fail.
//
//   - safeLeaseFilename enforces a strict character allowlist
//     (^[A-Za-z0-9._:-]+$) at the I/O boundary. The kernel constructs
//     records; the store decides what is filesystem-safe. The literal
//     'unknown' is REFUSED (would collide across all anonymous sessions).
//
//   - mark_stopped against a missing lease is a warn no-op, NOT a
//     fabricated record. Stopping a session we never registered is
//     evidence of a lifecycle mismatch, not a write opportunity.

import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  diagnostic,
  err,
  ok,
  type AgentLease,
  type Diagnostic,
  type LeasePatch,
  type LeaseRegistry,
  type Result,
} from '@paths.design/caws-kernel';

import { writeFileAtomic } from './atomic-write';
import { storeDiagnostic } from './repo-root';
import { STORE_RULES } from './rules';

const LEASES_DIRNAME = 'leases';

/**
 * Strict-allowlist regex for lease filenames.
 *
 * Allowed characters: ASCII letters, digits, dot, underscore, colon,
 * hyphen. This intentionally rejects:
 *   - empty string
 *   - 'unknown' (parse-input.sh's fallback when hook payload has no
 *     session_id; writing 'unknown.json' would collide across every
 *     anonymous session)
 *   - whitespace
 *   - path separators ('/', '\')
 *   - parent-directory references ('..')
 *   - shell-meta characters
 *
 * UUIDs (8-4-4-4-12 with hyphens) and `caws-<hex>` (resolveSession's mint
 * format) both pass. The regex is the single source of truth; both the
 * kernel and shell layers MUST route filename derivation through
 * safeLeaseFilename, never direct path joins on raw session_id.
 */
const LEASE_FILENAME_RE = /^[A-Za-z0-9._:-]+$/;

// ─── public surface ───────────────────────────────────────────────────────

export interface LoadLeasesResult {
  readonly leases: LeaseRegistry;
  readonly diagnostics: ReadonlyArray<Diagnostic>;
}

/**
 * Validate a session_id for filesystem safety, returning the filename
 * to use (with .json suffix) on success.
 */
export function safeLeaseFilename(sessionId: unknown): Result<string> {
  if (typeof sessionId !== 'string') {
    return err(
      storeDiagnostic(
        STORE_RULES.LEASE_SESSION_ID_INVALID,
        'Lease session_id must be a string.',
        { data: { actual_type: typeof sessionId } }
      )
    );
  }
  if (sessionId.length === 0) {
    return err(
      storeDiagnostic(
        STORE_RULES.LEASE_SESSION_ID_INVALID,
        'Lease session_id must be a non-empty string.'
      )
    );
  }
  if (sessionId === 'unknown') {
    return err(
      storeDiagnostic(
        STORE_RULES.LEASE_SESSION_ID_INVALID,
        "Lease session_id 'unknown' is refused — it would collide across anonymous sessions. " +
          'Hook scripts MUST guard [ -z "$HOOK_SESSION_ID" ] || [ "$HOOK_SESSION_ID" = "unknown" ] before invoking the CLI.',
        { data: { session_id: sessionId } }
      )
    );
  }
  if (!LEASE_FILENAME_RE.test(sessionId)) {
    return err(
      storeDiagnostic(
        STORE_RULES.LEASE_SESSION_ID_UNSAFE,
        `Lease session_id "${sessionId}" contains characters outside the strict allowlist ` +
          '^[A-Za-z0-9._:-]+$. Path separators, whitespace, and shell metacharacters are forbidden.',
        { data: { session_id: sessionId } }
      )
    );
  }
  return ok(`${sessionId}.json`);
}

/**
 * Load all lease files under .caws/leases/.
 *
 * LENIENT per file: a malformed individual lease produces a diagnostic
 * in the returned diagnostics array and is excluded from the registry;
 * the call returns ok with the parseable subset.
 *
 * STRICT on directory: an unreadable .caws/leases/ directory returns
 * err with LEASE_DIR_UNREADABLE. A missing directory returns
 * ok({ leases: {}, diagnostics: [] }) — leases are operational cache;
 * absence is normal.
 *
 * Per-file failure classes (each emits one diagnostic, excludes the file):
 *   - filename does not match the lease pattern (skipped silently —
 *     these are not lease files, just other content in the dir)
 *   - JSON parse failure → LEASE_FILE_MALFORMED
 *   - JSON parses but is not an object → LEASE_FILE_MALFORMED
 *   - session_id mismatch between filename and content → LEASE_FILE_MALFORMED
 */
export function loadLeases(cawsDir: string): Result<LoadLeasesResult> {
  const leasesDir = path.join(cawsDir, LEASES_DIRNAME);

  if (!fs.existsSync(leasesDir)) {
    return ok({ leases: {}, diagnostics: [] });
  }

  let entries: string[];
  try {
    entries = fs.readdirSync(leasesDir);
  } catch (e) {
    return err(
      storeDiagnostic(
        STORE_RULES.LEASE_DIR_UNREADABLE,
        `Lease directory unreadable: ${(e as Error).message}`,
        { subject: leasesDir }
      )
    );
  }

  const leases: Record<string, AgentLease> = {};
  const diagnostics: Diagnostic[] = [];

  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const sessionId = entry.slice(0, -'.json'.length);
    if (!LEASE_FILENAME_RE.test(sessionId)) {
      // Not a lease file by our naming convention; ignore silently
      // rather than fabricate a malformed diagnostic for unrelated
      // files an operator may have dropped here.
      continue;
    }

    const filePath = path.join(leasesDir, entry);
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (e) {
      diagnostics.push(
        storeDiagnostic(
          STORE_RULES.LEASE_FILE_MALFORMED,
          `Lease file unreadable: ${(e as Error).message}`,
          { subject: filePath, data: { session_id: sessionId } }
        )
      );
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      diagnostics.push(
        storeDiagnostic(
          STORE_RULES.LEASE_FILE_MALFORMED,
          `Lease file is not valid JSON: ${(e as Error).message}`,
          { subject: filePath, data: { session_id: sessionId } }
        )
      );
      continue;
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      diagnostics.push(
        storeDiagnostic(
          STORE_RULES.LEASE_FILE_MALFORMED,
          'Lease file root is not a JSON object.',
          { subject: filePath, data: { session_id: sessionId } }
        )
      );
      continue;
    }

    const obj = parsed as Record<string, unknown>;
    if (typeof obj['session_id'] !== 'string' || obj['session_id'] !== sessionId) {
      diagnostics.push(
        storeDiagnostic(
          STORE_RULES.LEASE_FILE_MALFORMED,
          `Lease file session_id "${obj['session_id'] as string}" does not match filename "${sessionId}".`,
          { subject: filePath, data: { filename_session_id: sessionId, payload_session_id: obj['session_id'] } }
        )
      );
      continue;
    }

    // Treat the parsed object as an AgentLease. Field-level shape
    // validation is deferred to a future kernel-side validateAgentLease
    // function; for now, the kernel's TypeScript shape is the structural
    // contract, and ill-typed-but-parseable files load successfully.
    leases[sessionId] = obj as unknown as AgentLease;
  }

  return ok({ leases, diagnostics });
}

/**
 * Apply a single LeasePatch via atomic per-file write.
 *
 * Creates the leases directory if missing. No lock acquired (per spec
 * invariant 11). No event emitted (per spec invariant 10 and doctrine
 * §6 invariant 10).
 *
 * Patch semantics:
 *   - write_lease: serialize patch.lease as JSON, atomic-write to
 *     <cawsDir>/leases/<safe-session-id>.json.
 *   - mark_stopped: read existing lease file; if absent, return ok with
 *     a warning diagnostic (NOT a fabricated record); if present,
 *     update status='stopped', stopped_at=patch.transitioned_at,
 *     last_seen_reason='session_stop'; atomic-write back.
 *   - delete_lease: fs.unlinkSync the lease file; idempotent on absence.
 */
export function applyLeasePatch(
  cawsDir: string,
  patch: LeasePatch
): Result<{ readonly wrote: boolean; readonly diagnostics: ReadonlyArray<Diagnostic> }> {
  const filenameRes = safeLeaseFilename(patch.session_id);
  if (filenameRes.ok === false) return filenameRes;
  const filename = filenameRes.value;

  const leasesDir = path.join(cawsDir, LEASES_DIRNAME);
  const filePath = path.join(leasesDir, filename);

  try {
    fs.mkdirSync(leasesDir, { recursive: true });
  } catch (e) {
    return err(
      storeDiagnostic(
        STORE_RULES.LEASE_WRITE_FAILED,
        `Failed to create lease directory: ${(e as Error).message}`,
        { subject: leasesDir }
      )
    );
  }

  if (patch.kind === 'write_lease') {
    const contents = JSON.stringify(patch.lease, null, 2) + '\n';
    const w = writeFileAtomic(filePath, contents);
    if (w.ok === false) return err(w.errors);
    return ok({ wrote: true, diagnostics: [] });
  }

  if (patch.kind === 'mark_stopped') {
    if (!fs.existsSync(filePath)) {
      // Stopping a session we never registered is a lifecycle mismatch,
      // not a write opportunity. Surface as a warning diagnostic; do
      // NOT fabricate a historical record.
      const warn = diagnostic({
        rule: STORE_RULES.LEASE_STOP_NO_PRIOR_LEASE,
        authority: 'kernel/diagnostics',
        severity: 'warning',
        message: `mark_stopped: no existing lease for session "${patch.session_id}" — nothing to update.`,
        subject: filePath,
        data: { session_id: patch.session_id },
      });
      return ok({ wrote: false, diagnostics: [warn] });
    }

    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (e) {
      return err(
        storeDiagnostic(
          STORE_RULES.LEASE_WRITE_FAILED,
          `Failed to read existing lease for mark_stopped: ${(e as Error).message}`,
          { subject: filePath }
        )
      );
    }

    let prior: AgentLease;
    try {
      prior = JSON.parse(raw) as AgentLease;
    } catch (e) {
      return err(
        storeDiagnostic(
          STORE_RULES.LEASE_FILE_MALFORMED,
          `Existing lease file is not valid JSON: ${(e as Error).message}`,
          { subject: filePath }
        )
      );
    }

    const updated: AgentLease = {
      ...prior,
      status: 'stopped',
      stopped_at: patch.transitioned_at,
      last_seen_reason: 'session_stop',
    };

    const contents = JSON.stringify(updated, null, 2) + '\n';
    const w = writeFileAtomic(filePath, contents);
    if (w.ok === false) return err(w.errors);
    return ok({ wrote: true, diagnostics: [] });
  }

  // delete_lease
  if (!fs.existsSync(filePath)) {
    // Idempotent: deleting an absent lease is a no-op success.
    return ok({ wrote: false, diagnostics: [] });
  }
  try {
    fs.unlinkSync(filePath);
  } catch (e) {
    return err(
      storeDiagnostic(
        STORE_RULES.LEASE_WRITE_FAILED,
        `Failed to delete lease file: ${(e as Error).message}`,
        { subject: filePath }
      )
    );
  }
  return ok({ wrote: true, diagnostics: [] });
}

/**
 * Apply a batch of lease patches. Per-patch failures do NOT abort the
 * batch — each patch's diagnostics are aggregated into the return.
 *
 * Use for operator commands like prune that emit multiple delete_lease
 * patches. Single-session register/heartbeat/stop go through
 * applyLeasePatch directly.
 */
export function applyLeasePatches(
  cawsDir: string,
  patches: ReadonlyArray<LeasePatch>
): Result<{ readonly applied: number; readonly diagnostics: ReadonlyArray<Diagnostic> }> {
  let applied = 0;
  const diagnostics: Diagnostic[] = [];

  for (const patch of patches) {
    const r = applyLeasePatch(cawsDir, patch);
    if (r.ok === false) {
      diagnostics.push(...r.errors);
      continue;
    }
    if (r.value.wrote) applied++;
    diagnostics.push(...r.value.diagnostics);
  }

  return ok({ applied, diagnostics });
}

/**
 * Operator-invoked prune: delete lease files matching a status + age
 * threshold.
 *
 * Selection: status === target AND (now - reference) > retentionMs, where
 * reference is `stopped_at` for status='stopped' and `last_active` for
 * status='active' (with TTL-based read-side 'stale' bucketing).
 *
 * Default `dryRun: true` (caller must explicitly pass false to delete).
 * Returns count of files that would be / were deleted plus any
 * diagnostics from the delete operations.
 */
export interface PruneOptions {
  readonly status: 'stopped' | 'stale';
  /** Active records whose age exceeds this are bucketed as stale for the prune decision. */
  readonly staleTtlMs?: number;
  readonly retentionMs: number;
  readonly now: Date;
  readonly dryRun?: boolean;
}

export interface PruneResult {
  readonly candidates: ReadonlyArray<string>; // session_ids selected
  readonly deleted: ReadonlyArray<string>; // actually deleted (empty when dryRun)
  readonly diagnostics: ReadonlyArray<Diagnostic>;
}

export function pruneLeasesByStatus(
  cawsDir: string,
  opts: PruneOptions
): Result<PruneResult> {
  const dryRun = opts.dryRun ?? true;
  const staleTtlMs = opts.staleTtlMs ?? 30 * 60 * 1000; // 30m default

  const loadRes = loadLeases(cawsDir);
  if (loadRes.ok === false) return err(loadRes.errors);
  const { leases, diagnostics: loadDiags } = loadRes.value;

  const nowMs = opts.now.getTime();
  const candidates: string[] = [];

  // Object.values widens index-signature types to unknown[] under
  // strict TS; coerce back to the kernel-declared element type so the
  // loop body can read fields without per-line casts.
  for (const lease of Object.values(leases) as AgentLease[]) {
    if (opts.status === 'stopped') {
      if (lease.status !== 'stopped') continue;
      const stoppedAtMs = lease.stopped_at ? Date.parse(lease.stopped_at) : NaN;
      const reference = Number.isFinite(stoppedAtMs)
        ? stoppedAtMs
        : Date.parse(lease.last_active);
      if (!Number.isFinite(reference)) continue;
      if (nowMs - reference > opts.retentionMs) candidates.push(lease.session_id);
    } else {
      // status === 'stale'
      if (lease.status !== 'active' && lease.status !== 'stopping') continue;
      const lastActiveMs = Date.parse(lease.last_active);
      if (!Number.isFinite(lastActiveMs)) {
        // Unparseable → treat as stale for prune purposes.
        candidates.push(lease.session_id);
        continue;
      }
      const age = nowMs - lastActiveMs;
      // Must be stale (age > staleTtl) AND have been stale long enough
      // (age > staleTtl + retention).
      if (age > staleTtlMs && age - staleTtlMs > opts.retentionMs) {
        candidates.push(lease.session_id);
      }
    }
  }

  const diagnostics: Diagnostic[] = [...loadDiags];
  const deleted: string[] = [];

  if (!dryRun) {
    for (const sessionId of candidates) {
      const r = applyLeasePatch(cawsDir, { kind: 'delete_lease', session_id: sessionId });
      if (r.ok === false) {
        diagnostics.push(...r.errors);
        continue;
      }
      deleted.push(sessionId);
      diagnostics.push(...r.value.diagnostics);
    }
  }

  return ok({ candidates, deleted, diagnostics });
}
