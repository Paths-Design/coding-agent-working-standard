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
import * as os from 'node:os';
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

  if (patch.kind === 'update_lease_paths') {
    // SESSION-OWNERSHIP-METADATA-001 commit 2 — partial update of
    // working-tree ownership metadata. The kernel has already
    // validated and truncated; the store reads the prior lease,
    // overlays only the named keys (claimed_paths/last_modified_paths),
    // and atomic-writes back. last_active, status, last_seen_reason,
    // and all context fields are preserved byte-semantically from the
    // prior lease.
    //
    // Defensive refusal: if the target lease file is absent, this is
    // a lifecycle mismatch (the kernel's existence check is on the
    // in-memory LeaseRegistry; the on-disk file MAY have been deleted
    // between load and apply). Surface as LEASE_STOP_NO_PRIOR_LEASE-
    // class (the same diagnostic shape mark_stopped uses for the
    // missing-lease case). No partial write.
    if (!fs.existsSync(filePath)) {
      const warn = diagnostic({
        rule: STORE_RULES.LEASE_STOP_NO_PRIOR_LEASE,
        authority: 'kernel/diagnostics',
        severity: 'warning',
        message: `update_lease_paths: no existing lease file for session "${patch.session_id}" — nothing to update.`,
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
          `Failed to read existing lease for update_lease_paths: ${(e as Error).message}`,
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

    // Build the merged lease. Spread the prior first, then overlay
    // only the keys explicitly present in the patch (per the
    // documented per-field undefined = leave-alone semantic). This
    // means a patch with claimed_paths absent does NOT delete the
    // prior claimed_paths; an explicit empty array DOES set it to [].
    const updated: AgentLease = {
      ...prior,
      ...(patch.claimed_paths !== undefined ? { claimed_paths: patch.claimed_paths } : {}),
      ...(patch.last_modified_paths !== undefined
        ? { last_modified_paths: patch.last_modified_paths }
        : {}),
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

// ─── prune --dead (PID-liveness) ───────────────────────────────────────────

/**
 * Default PID-liveness probe: process.kill(pid, 0) sends no signal but
 * performs the existence + permission check. Returns true when the process
 * exists (or exists but we lack permission — ESRCH means gone, EPERM means
 * alive-but-not-ours). A non-positive/NaN pid is treated as not-alive.
 */
export function defaultIsPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM → the process exists but is owned by another user: still alive.
    // ESRCH → no such process: dead.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface PruneDeadOptions {
  readonly now: Date;
  readonly dryRun?: boolean;
  /**
   * Hostname of the machine running the prune. A lease whose recorded
   * `hostname` differs is on another machine — its pid is NOT checkable
   * here, so it is NEVER treated as dead (skipped). Defaults to os.hostname().
   */
  readonly currentHostname?: string;
  /** Liveness probe (injectable for tests). Defaults to defaultIsPidAlive. */
  readonly isPidAlive?: (pid: number) => boolean;
}

export interface PruneDeadResult {
  /** session_ids selected (active/stopping lease, same host, dead pid). */
  readonly candidates: ReadonlyArray<string>;
  /** Actually deleted (empty when dryRun). */
  readonly deleted: ReadonlyArray<string>;
  /** session_ids skipped because their hostname differs (unverifiable). */
  readonly skippedForeignHost: ReadonlyArray<string>;
  readonly diagnostics: ReadonlyArray<Diagnostic>;
}

/**
 * Prune leases whose owning process is dead. Collapses the prior 3-step
 * verify-PID → stop → prune --status stale --older-than 0 dance into one
 * operation: an `active`/`stopping` lease on THIS host whose recorded pid is
 * not alive is selected and (on apply) deleted directly — a dead process
 * cannot cleanly self-stop, so deletion is the correct tombstone.
 *
 * Safety: a lease whose `hostname` differs from the current host is skipped
 * (its pid is not checkable here) — never assumed dead. A lease with no pid
 * recorded is treated as dead (it cannot be liveness-verified and an active
 * lease that never recorded a pid predates the pid-stamping writer).
 *
 * `stopped` leases are out of scope for --dead (they are already terminal;
 * use `prune --status stopped --older-than <ms>` for retention cleanup).
 */
export function pruneDeadLeases(
  cawsDir: string,
  opts: PruneDeadOptions
): Result<PruneDeadResult> {
  const dryRun = opts.dryRun ?? true;
  const currentHostname = opts.currentHostname ?? os.hostname();
  const isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;

  const loadRes = loadLeases(cawsDir);
  if (loadRes.ok === false) return err(loadRes.errors);
  const { leases, diagnostics: loadDiags } = loadRes.value;

  const candidates: string[] = [];
  const skippedForeignHost: string[] = [];
  const diagnostics: Diagnostic[] = [...loadDiags];

  for (const lease of Object.values(leases) as AgentLease[]) {
    // Only running leases are candidates; stopped is terminal (retention
    // cleanup is the status='stopped' path, not --dead).
    if (lease.status !== 'active' && lease.status !== 'stopping') continue;

    // Foreign host → pid not checkable here. NEVER assume dead.
    if (
      typeof lease.hostname === 'string' &&
      lease.hostname.length > 0 &&
      lease.hostname !== currentHostname
    ) {
      skippedForeignHost.push(lease.session_id);
      continue;
    }

    // No pid recorded → cannot verify liveness; treat as dead (a running
    // session stamps its pid via the registration/heartbeat writer).
    const pid = typeof lease.pid === 'number' ? lease.pid : NaN;
    if (!Number.isInteger(pid) || pid <= 0) {
      candidates.push(lease.session_id);
      continue;
    }

    if (!isPidAlive(pid)) {
      candidates.push(lease.session_id);
    }
  }

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

  return ok({ candidates, deleted, skippedForeignHost, diagnostics });
}
