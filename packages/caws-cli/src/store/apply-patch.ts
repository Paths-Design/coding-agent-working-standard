// Apply kernel-emitted RegistryPatch envelopes to on-disk registries.
//
// The kernel never reads or writes files — it returns typed patches
// describing exactly what the shell should do. This module is the SINGLE
// place those patches turn into atomic writes:
//
//   bind_worktree     → worktrees.json[name] = { specId, owner, ... }
//   rebind_worktree   → worktrees.json[name].specId = newSpecId
//   takeover_claim    → worktrees.json[name].owner = newOwner;
//                       worktrees.json[name].prior_owners.push(audit)
//   refresh_agent     → agents.json[session_id] = { last_active, ... }
//
// All writes use the existing atomic-write helper (temp + fsync + rename).
// We do NOT touch agents.json from worktree-patch paths and vice versa.
//
// Authority discipline preserved:
//   - worktrees.json[name].owner is the SOLE authority for ownership.
//   - agents.json updates are display/freshness only.
//   - prior_owners is append-only; takeover_claim never truncates.

import * as path from 'node:path';
import * as fs from 'node:fs';

import type {
  AgentRegistry,
  RegistryPatch,
  WorktreeRecord,
} from '@paths.design/caws-kernel';
import { err, ok, type Diagnostic, type Result } from '@paths.design/caws-kernel';

import { writeFileAtomic } from './atomic-write';
import { STORE_RULES } from './rules';

const WORKTREES_FILENAME = 'worktrees.json';
const AGENTS_FILENAME = 'agents.json';

function storeErr(rule: string, message: string, data?: Record<string, unknown>): Diagnostic {
  const base: Diagnostic = {
    rule,
    authority: 'kernel/diagnostics',
    severity: 'error',
    message,
  };
  return data !== undefined ? { ...base, data } : base;
}

function readRegistryJson<T>(filePath: string, defaultValue: T): Result<T> {
  if (!fs.existsSync(filePath)) {
    return ok(defaultValue);
  }
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    return err(
      storeErr(
        STORE_RULES.READ_IO_FAILED,
        `Failed to read ${path.basename(filePath)}: ${(e as Error).message}`,
        { filePath }
      )
    );
  }
  if (raw.trim().length === 0) return ok(defaultValue);
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return err(
        storeErr(STORE_RULES.REGISTRY_NOT_OBJECT, `${path.basename(filePath)} is not a JSON object.`)
      );
    }
    return ok(parsed as T);
  } catch (e) {
    return err(
      storeErr(
        STORE_RULES.READ_JSON_INVALID,
        `Invalid JSON in ${path.basename(filePath)}: ${(e as Error).message}`,
        { filePath }
      )
    );
  }
}

function writeRegistryJson(filePath: string, value: unknown): Result<true> {
  return writeFileAtomic(filePath, JSON.stringify(value, null, 2) + '\n');
}

/**
 * Apply a single RegistryPatch to the on-disk registries.
 *
 * Returns Ok(true) on successful write. The patch envelope itself is the
 * proof-of-intent — this function never invents fields. It only translates
 * the patch into the corresponding registry mutation and persists it.
 *
 * Reads the existing registry from disk, applies the patch, and writes
 * back atomically. If the read fails (e.g., malformed JSON on disk), the
 * function returns Err and refuses to overwrite the file — silent recovery
 * would erase potentially-recoverable user state.
 */
export function applyRegistryPatch(cawsDir: string, patch: RegistryPatch): Result<true> {
  switch (patch.kind) {
    case 'bind_worktree':
      return applyBindWorktree(cawsDir, patch);
    case 'rebind_worktree':
      return applyRebindWorktree(cawsDir, patch);
    case 'takeover_claim':
      return applyTakeoverClaim(cawsDir, patch);
    case 'refresh_agent':
      return applyRefreshAgent(cawsDir, patch);
  }
}

function applyBindWorktree(
  cawsDir: string,
  patch: Extract<RegistryPatch, { kind: 'bind_worktree' }>
): Result<true> {
  const filePath = path.join(cawsDir, WORKTREES_FILENAME);
  const readResult = readRegistryJson<Record<string, WorktreeRecord>>(filePath, {});
  if (!readResult.ok) return readResult;
  const registry: Record<string, WorktreeRecord> = { ...readResult.value };
  const prev = registry[patch.worktree_name] ?? {};
  registry[patch.worktree_name] = {
    ...prev,
    specId: patch.spec_id,
    owner: patch.owner,
    last_heartbeat: patch.when,
  };
  return writeRegistryJson(filePath, registry);
}

function applyRebindWorktree(
  cawsDir: string,
  patch: Extract<RegistryPatch, { kind: 'rebind_worktree' }>
): Result<true> {
  const filePath = path.join(cawsDir, WORKTREES_FILENAME);
  const readResult = readRegistryJson<Record<string, WorktreeRecord>>(filePath, {});
  if (!readResult.ok) return readResult;
  const registry: Record<string, WorktreeRecord> = { ...readResult.value };
  const prev = registry[patch.worktree_name];
  if (prev === undefined) {
    return err(
      storeErr(
        STORE_RULES.WRITE_PATCH_TARGET_MISSING,
        `Cannot rebind worktree "${patch.worktree_name}" — no existing entry.`,
        { worktree_name: patch.worktree_name }
      )
    );
  }
  registry[patch.worktree_name] = {
    ...prev,
    specId: patch.to_spec_id,
  };
  return writeRegistryJson(filePath, registry);
}

function applyTakeoverClaim(
  cawsDir: string,
  patch: Extract<RegistryPatch, { kind: 'takeover_claim' }>
): Result<true> {
  const filePath = path.join(cawsDir, WORKTREES_FILENAME);
  const readResult = readRegistryJson<Record<string, WorktreeRecord>>(filePath, {});
  if (!readResult.ok) return readResult;
  const registry: Record<string, WorktreeRecord> = { ...readResult.value };
  const prev = registry[patch.worktree_name];
  if (prev === undefined) {
    return err(
      storeErr(
        STORE_RULES.WRITE_PATCH_TARGET_MISSING,
        `Cannot take over "${patch.worktree_name}" — no existing entry.`,
        { worktree_name: patch.worktree_name }
      )
    );
  }
  // prior_owners is append-only. Kernel never truncates; we don't either.
  const priorOwners = [...(prev.prior_owners ?? []), patch.prior_owner];
  registry[patch.worktree_name] = {
    ...prev,
    owner: patch.owner,
    last_heartbeat: patch.when,
    prior_owners: priorOwners,
  };
  return writeRegistryJson(filePath, registry);
}

function applyRefreshAgent(
  cawsDir: string,
  patch: Extract<RegistryPatch, { kind: 'refresh_agent' }>
): Result<true> {
  const filePath = path.join(cawsDir, AGENTS_FILENAME);
  const readResult = readRegistryJson<Record<string, AgentRegistry[string]>>(
    filePath,
    {}
  );
  if (!readResult.ok) return readResult;
  const registry: Record<string, AgentRegistry[string]> = { ...readResult.value };
  const prev = registry[patch.session.session_id] ?? { session_id: patch.session.session_id, last_active: patch.last_active };
  registry[patch.session.session_id] = {
    ...prev,
    session_id: patch.session.session_id,
    ...(patch.session.platform !== undefined ? { platform: patch.session.platform } : {}),
    last_active: patch.last_active,
    ...(patch.bound_worktree !== undefined ? { bound_worktree: patch.bound_worktree } : {}),
    ...(patch.bound_spec_id !== undefined ? { bound_spec_id: patch.bound_spec_id } : {}),
  };
  return writeRegistryJson(filePath, registry);
}
