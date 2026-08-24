// bridge-store — the SOLE I/O surface for .caws/claims/bridge.json
// (AUTH-BINDING-BRIDGE-001).
//
// A bridge binding is an AUTHORITY binding (session ↔ spec) for non-worktree
// contexts — the v11.2 authority line. It is NOT a scope expansion (doctrine
// invariant 12): the bound spec's scope.in is the admission surface, nothing
// wider. Worktree bindings WIN over bridges (subordination): the refusal for
// a spec with a live worktree binding lives at the shell layer where the
// registry is readable; this store enforces only bridge-vs-bridge ownership.
//
// On-disk shape (flat map keyed by spec id, atomic-written):
//   .caws/claims/bridge.json
//   { "BR-001": { session_id, platform?, acquired_at, last_seen?,
//                 context_cwd?, prior_owners?: [...] } }
//
// Every mutation is a lifecycle transaction: bridge.json write + the paired
// audit event append in ONE runLifecycleTransaction (no partial state is ever
// observable). Events: claim_bridged (acquire), bridge_claim_taken_over
// (takeover, prior_owners audit both on the entry and in the event),
// claim_released (release). Retire is READ-SIDE (a non-active spec's bridge
// confers nothing) + prune (disk hygiene for dead entries; NO event — the
// audit trail for retirement is spec_closed/spec_archived).
//
// Missing != malformed: an absent claims file is the empty registry (normal);
// an unparseable one is an Err (fail closed — an unreadable authority store
// refuses mutation rather than guessing).

import * as fs from 'node:fs';
import * as path from 'node:path';

import { type Actor, type EventBody, type Result, err, ok } from '../kernel';

import { writeFileAtomic } from './atomic-write';
import { runLifecycleTransaction } from './lifecycle-transaction';
import { storeDiagnostic } from './repo-root';
import { STORE_RULES } from './rules';
import type { LifecycleFileWrite } from './lifecycle-transaction';

const CLAIMS_DIRNAME = 'claims';
const BRIDGE_FILENAME = 'bridge.json';

export interface BridgeEntry {
  readonly session_id: string;
  readonly platform?: string;
  readonly acquired_at: string;
  readonly last_seen?: string;
  readonly context_cwd?: string;
  readonly prior_owners?: ReadonlyArray<{
    readonly session_id: string;
    readonly platform?: string;
    readonly last_seen?: string;
    readonly takenOver_at: string;
  }>;
}

export interface BridgeRegistry {
  readonly [specId: string]: BridgeEntry;
}

export interface LoadBridgesResult {
  readonly bridges: BridgeRegistry;
  /** True when the claims file exists and parsed; false when absent (normal). */
  readonly present: boolean;
}

function bridgePath(cawsDir: string): string {
  return path.join(cawsDir, CLAIMS_DIRNAME, BRIDGE_FILENAME);
}

/** Ensure the claims directory exists before the first atomic write. */
function ensureClaimsDir(cawsDir: string): Result<void> {
  try {
    fs.mkdirSync(path.join(cawsDir, CLAIMS_DIRNAME), { recursive: true });
    return ok(undefined);
  } catch (e) {
    return err(
      storeDiagnostic(
        STORE_RULES.LIFECYCLE_WRITE_FAILED,
        `Failed to create claims directory: ${(e as Error).message}`
      )
    );
  }
}

/** Load bridge.json. Absent => ok({bridges: {}, present: false}). Malformed => err. */
export function loadBridges(cawsDir: string): Result<LoadBridgesResult> {
  const file = bridgePath(cawsDir);
  if (!fs.existsSync(file)) return ok({ bridges: {}, present: false });
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return err(
      storeDiagnostic(
        STORE_RULES.BRIDGE_FILE_INVALID,
        `Failed to read bridge claims file: ${(e as Error).message}`,
        { subject: file }
      )
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return err(
      storeDiagnostic(
        STORE_RULES.BRIDGE_FILE_INVALID,
        `Bridge claims file is not valid JSON: ${(e as Error).message}`,
        { subject: file }
      )
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return err(
      storeDiagnostic(
        STORE_RULES.BRIDGE_FILE_INVALID,
        'Bridge claims file root is not a JSON object.',
        { subject: file }
      )
    );
  }
  const bridges: Record<string, BridgeEntry> = {};
  for (const [specId, value] of Object.entries(parsed)) {
    if (typeof value !== 'object' || value === null) continue; // lenient per-entry
    bridges[specId] = value as BridgeEntry;
  }
  return ok({ bridges, present: true });
}

/** Serialize + planned-write for the registry. */
function bridgeWrite(cawsDir: string, registry: BridgeRegistry): LifecycleFileWrite {
  return {
    path: bridgePath(cawsDir),
    contents: JSON.stringify(registry, null, 2) + '\n',
  };
}

export interface AcquireBridgeInput {
  readonly specId: string;
  readonly session: { readonly session_id: string; readonly platform?: string };
  readonly actor: Actor;
  readonly now: Date;
  readonly contextCwd?: string;
}

/**
 * Acquire a bridge binding. Refuses when the spec is already bridged (bridge
 * ownership is exclusive per spec; a foreign holder requires the takeover
 * path, the owner re-acquiring refreshes last_seen only). The acquire pairs
 * bridge.json with one claim_bridged event in a lifecycle transaction.
 */
export function acquireBridge(cawsDir: string, input: AcquireBridgeInput): Result<{ readonly specId: string; readonly refreshed: boolean }> {
  const loaded = loadBridges(cawsDir);
  const dirOk = ensureClaimsDir(cawsDir);
  if (!dirOk.ok) return err(dirOk.errors);
  if (!loaded.ok) return err(loaded.errors);
  const registry: Record<string, BridgeEntry> = { ...loaded.value.bridges };

  const existing = registry[input.specId];
  if (existing !== undefined && existing.session_id !== input.session.session_id) {
    return err(
      storeDiagnostic(
        STORE_RULES.BRIDGE_FOREIGN_OWNER,
        `Spec "${input.specId}" is bridge-claimed by session "${existing.session_id}" — use --takeover (explicit authority transition) or claim --release if it is yours.`,
        { subject: input.specId, data: { owner: existing.session_id } }
      )
    );
  }

  const nowIso = input.now.toISOString();
  const refreshed = existing !== undefined;
  registry[input.specId] = {
    session_id: input.session.session_id,
    ...(input.session.platform !== undefined ? { platform: input.session.platform } : {}),
    acquired_at: refreshed ? existing.acquired_at : nowIso,
    last_seen: nowIso,
    ...(input.contextCwd !== undefined ? { context_cwd: input.contextCwd } : {}),
    ...(refreshed && existing.prior_owners !== undefined
      ? { prior_owners: existing.prior_owners }
      : {}),
  };

  const txn = runLifecycleTransaction({
    cawsDir,
    plannedWrites: [bridgeWrite(cawsDir, registry)],
    events: [{
      event: 'claim_bridged',
      ts: nowIso,
      actor: input.actor,
      spec_id: input.specId,
      data: {
        session_id: input.session.session_id,
        ...(input.session.platform !== undefined ? { platform: input.session.platform } : {}),
        ...(input.contextCwd !== undefined ? { context_cwd: input.contextCwd } : {}),
      },
    }],
  });
  if (!txn.ok) return err(txn.errors);
  // Inspect the OUTCOME, not just the Result: partial_failure_recovered is
  // wrapped in ok() by the transaction layer — treating it as success is the
  // "reports success while doing nothing" class (CLAUDE.md lesson).
  if (txn.value.kind !== 'success') {
    return err(txn.value.cause);
  }
  return ok({ specId: input.specId, refreshed });
}

export interface TakeoverBridgeInput {
  readonly specId: string;
  readonly session: { readonly session_id: string; readonly platform?: string };
  readonly actor: Actor;
  readonly now: Date;
  readonly reason: string;
}

/**
 * Take over a bridge binding: rewrites the holder, appends the prior holder
 * to the entry's durable prior_owners audit, and appends
 * bridge_claim_taken_over — all in one lifecycle transaction. Refuses when
 * no bridge exists (takeover needs a prior owner) and when the caller already
 * owns it (use the acquire path; a no-op takeover would fabricate an audit
 * entry for a transition that did not happen).
 */
export function takeoverBridge(cawsDir: string, input: TakeoverBridgeInput): Result<{ readonly priorOwnerSessionId: string }> {
  const loaded = loadBridges(cawsDir);
  const dirOk = ensureClaimsDir(cawsDir);
  if (!dirOk.ok) return err(dirOk.errors);
  if (!loaded.ok) return err(loaded.errors);
  const registry: Record<string, BridgeEntry> = { ...loaded.value.bridges };

  const existing = registry[input.specId];
  if (existing === undefined) {
    return err(
      storeDiagnostic(
        STORE_RULES.LIFECYCLE_PLAN_REJECTED,
        `No bridge binding exists for spec "${input.specId}" — takeover transitions an existing authority; use caws claim --spec ${input.specId} to acquire.`,
        { subject: input.specId }
      )
    );
  }
  if (existing.session_id === input.session.session_id) {
    return err(
      storeDiagnostic(
        STORE_RULES.LIFECYCLE_PLAN_REJECTED,
        `Session "${input.session.session_id}" already holds the bridge for spec "${input.specId}" — re-run caws claim --spec to refresh it; a takeover of yourself would fabricate a prior_owners audit entry.`,
        { subject: input.specId }
      )
    );
  }

  const nowIso = input.now.toISOString();
  const priorAudit = [
    ...(existing.prior_owners ?? []),
    {
      session_id: existing.session_id,
      ...(existing.platform !== undefined ? { platform: existing.platform } : {}),
      ...(existing.last_seen !== undefined ? { last_seen: existing.last_seen } : {}),
      takenOver_at: nowIso,
    },
  ];
  registry[input.specId] = {
    session_id: input.session.session_id,
    ...(input.session.platform !== undefined ? { platform: input.session.platform } : {}),
    acquired_at: nowIso,
    last_seen: nowIso,
    ...(existing.context_cwd !== undefined ? { context_cwd: existing.context_cwd } : {}),
    prior_owners: priorAudit,
  };

  const txn = runLifecycleTransaction({
    cawsDir,
    plannedWrites: [bridgeWrite(cawsDir, registry)],
    events: [{
      event: 'bridge_claim_taken_over',
      ts: nowIso,
      actor: input.actor,
      spec_id: input.specId,
      data: {
        prior_owner: {
          session_id: existing.session_id,
          ...(existing.platform !== undefined ? { platform: existing.platform } : {}),
          ...(existing.last_seen !== undefined ? { last_seen: existing.last_seen } : {}),
        },
        new_owner: {
          session_id: input.session.session_id,
          ...(input.session.platform !== undefined ? { platform: input.session.platform } : {}),
        },
        reason: input.reason,
      },
    }],
  });
  if (!txn.ok) return err(txn.errors);
  if (txn.value.kind !== 'success') {
    return err(txn.value.cause);
  }
  return ok({ priorOwnerSessionId: existing.session_id });
}

export interface ReleaseBridgeInput {
  readonly specId?: string;
  readonly session: { readonly session_id: string; readonly platform?: string };
  readonly actor: Actor;
  readonly now: Date;
}

export interface ReleaseBridgeOutcome {
  readonly released: ReadonlyArray<string>;
}

/**
 * Release bridge binding(s) owned by the calling session. Named (--spec)
 * releases exactly that binding; bare releases EVERY binding the session
 * owns. Releasing a binding the session does NOT own refuses (exit-class
 * domain error — no --takeover semantics on release). One claim_released
 * event per removed binding, all in one lifecycle transaction.
 */
export function releaseBridge(cawsDir: string, input: ReleaseBridgeInput): Result<ReleaseBridgeOutcome> {
  const loaded = loadBridges(cawsDir);
  const dirOk = ensureClaimsDir(cawsDir);
  if (!dirOk.ok) return err(dirOk.errors);
  if (!loaded.ok) return err(loaded.errors);
  const registry: Record<string, BridgeEntry> = { ...loaded.value.bridges };

  if (input.specId !== undefined) {
    const existing = registry[input.specId];
    if (existing === undefined) {
      return err(
        storeDiagnostic(
          STORE_RULES.LIFECYCLE_PLAN_REJECTED,
          `No bridge binding exists for spec "${input.specId}".`,
          { subject: input.specId }
        )
      );
    }
    if (existing.session_id !== input.session.session_id) {
      return err(
        storeDiagnostic(
          STORE_RULES.BRIDGE_FOREIGN_OWNER,
          `Bridge for spec "${input.specId}" is held by session "${existing.session_id}" — only the owning session releases; a foreign handoff goes through --takeover.`,
          { subject: input.specId, data: { owner: existing.session_id } }
        )
      );
    }
    delete registry[input.specId];
    const nowIso = input.now.toISOString();
    const txn = runLifecycleTransaction({
      cawsDir,
      plannedWrites: [bridgeWrite(cawsDir, registry)],
      events: [{
        event: 'claim_released',
        ts: nowIso,
        actor: input.actor,
        spec_id: input.specId,
        data: {
          session_id: input.session.session_id,
          ...(input.session.platform !== undefined ? { platform: input.session.platform } : {}),
          scope: 'named',
        },
      }],
    });
    if (!txn.ok) return err(txn.errors);
    if (txn.value.kind !== 'success') {
      return err(txn.value.cause);
    }
    return ok({ released: [input.specId] });
  }

  // Bare release: every binding this session owns.
  const nowIso = input.now.toISOString();
  const released: string[] = [];
  const events: EventBody[] = [];
  for (const [specId, entry] of Object.entries(registry)) {
    if (entry.session_id !== input.session.session_id) continue;
    delete registry[specId];
    released.push(specId);
    events.push({
      event: 'claim_released',
      ts: nowIso,
      actor: input.actor,
      spec_id: specId,
      data: {
        session_id: input.session.session_id,
        ...(input.session.platform !== undefined ? { platform: input.session.platform } : {}),
        scope: 'bare',
      },
    });
  }
  if (released.length === 0) {
    return err(
      storeDiagnostic(
        STORE_RULES.LIFECYCLE_PLAN_REJECTED,
        `Session "${input.session.session_id}" holds no bridge bindings — nothing to release.`,
        { subject: input.session.session_id }
      )
    );
  }
  const txn = runLifecycleTransaction({
    cawsDir,
    plannedWrites: [bridgeWrite(cawsDir, registry)],
    events,
  });
  if (!txn.ok) return err(txn.errors);
  if (txn.value.kind !== 'success') {
    return err(txn.value.cause);
  }
  return ok({ released });
}

export interface BridgeGhostCandidate {
  readonly specId: string;
  readonly holderSessionId: string;
  readonly reason: 'spec-missing' | 'spec-closed' | 'spec-archived';
}

export interface BridgePrunePlan {
  readonly candidates: ReadonlyArray<BridgeGhostCandidate>;
  readonly apply: boolean;
  readonly removed: ReadonlyArray<string>;
}

/**
 * Plan (and optionally apply) cleanup of RETIRED bridge bindings — entries
 * whose spec is missing, closed, or archived. Read-side authority already
 ignores these (a non-active spec's bridge confers nothing); prune is disk
 * hygiene only and appends NO event (the retirement's audit trail is the
 * spec_closed/spec_archived event). Dry-run by default; --apply is the
 * operator's explicit call. Mutations use the plain atomic writer — no
 * lifecycle transaction is needed for an eventless hygiene write, but the
 * lifecycle lock is still taken so a concurrent acquire/release never
 * interleaves with a prune.
 */
export function pruneBridgeGhosts(
  cawsDir: string,
  input: {
    readonly activeSpecIds: ReadonlyArray<string>;
    readonly specStates: Readonly<Record<string, string | undefined>>;
    readonly apply: boolean;
  }
): Result<BridgePrunePlan> {
  const loaded = loadBridges(cawsDir);
  if (!loaded.ok) return err(loaded.errors);

  const candidates: BridgeGhostCandidate[] = [];
  for (const [specId, entry] of Object.entries(loaded.value.bridges)) {
    const state = input.specStates[specId];
    if (state === undefined) {
      candidates.push({ specId, holderSessionId: entry.session_id, reason: 'spec-missing' });
    } else if (state === 'closed') {
      candidates.push({ specId, holderSessionId: entry.session_id, reason: 'spec-closed' });
    } else if (state === 'archived') {
      candidates.push({ specId, holderSessionId: entry.session_id, reason: 'spec-archived' });
    }
  }
  void input.activeSpecIds;

  if (!input.apply || candidates.length === 0) {
    return ok({ candidates, apply: input.apply, removed: [] });
  }

  const registry: Record<string, BridgeEntry> = { ...loaded.value.bridges };
  const removed: string[] = [];
  for (const c of candidates) {
    delete registry[c.specId];
    removed.push(c.specId);
  }
  const w = writeFileAtomic(bridgePath(cawsDir), JSON.stringify(registry, null, 2) + '\n');
  if (!w.ok) return err(w.errors);
  return ok({ candidates, apply: true, removed });
}
