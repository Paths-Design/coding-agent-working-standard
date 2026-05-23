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

/**
 * Maximum number of entries the writer will store in `last_modified_paths`.
 *
 * Storage-bound invariant from SESSION-OWNERSHIP-METADATA-001 Q6 (C1 framing).
 * If the caller passes more than this many, the writer preserves caller order
 * and drops the lowest-index overflow until the count equals the cap. This is
 * distinct from TTL — TTL needs per-path timestamps the substrate does not
 * carry; the FIFO cap needs only ordered input and a max length.
 */
export const LAST_MODIFIED_PATHS_MAX = 1000;

/**
 * Structural validation for a path array carried by a refresh_agent patch.
 *
 * Returns Ok with the (possibly-truncated) array on success; Err with a
 * WRITE_AGENT_PATH_INVALID diagnostic on the first invalid entry. The writer
 * MUST NOT perform a partial write on validation failure — callers fail closed.
 *
 * Validation rules:
 *   - input is an array (already typed at the patch envelope, but defended)
 *   - every entry is a string
 *   - no entry is the empty string
 *   - no entry contains a NUL byte (U+0000)
 *
 * FIFO truncation (when `cap` is provided): if the array length exceeds the
 * cap, drop the lowest-index entries until length === cap. Caller order is
 * preserved among the kept entries.
 *
 * SESSION-OWNERSHIP-METADATA-001 A3, A10.
 */
function validateAndCapAgentPaths(
  field: 'claimed_paths' | 'last_modified_paths',
  value: readonly string[],
  cap: number | undefined
): Result<readonly string[]> {
  if (!Array.isArray(value)) {
    return err(
      storeErr(
        STORE_RULES.WRITE_AGENT_PATH_INVALID,
        `${field} must be an array`,
        { field }
      )
    );
  }
  for (let i = 0; i < value.length; i++) {
    const entry = value[i];
    if (typeof entry !== 'string') {
      return err(
        storeErr(
          STORE_RULES.WRITE_AGENT_PATH_INVALID,
          `${field}[${i}] is not a string`,
          { field, index: i, valueType: typeof entry }
        )
      );
    }
    if (entry.length === 0) {
      return err(
        storeErr(
          STORE_RULES.WRITE_AGENT_PATH_INVALID,
          `${field}[${i}] is empty`,
          { field, index: i }
        )
      );
    }
    if (entry.indexOf(' ') !== -1) {
      return err(
        storeErr(
          STORE_RULES.WRITE_AGENT_PATH_INVALID,
          `${field}[${i}] contains a null byte`,
          { field, index: i }
        )
      );
    }
  }
  if (cap !== undefined && value.length > cap) {
    return ok(value.slice(value.length - cap));
  }
  return ok(value);
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

  // Validate path arrays BEFORE any write. Fail closed — no partial write.
  let claimedPaths: readonly string[] | undefined;
  if (patch.claimed_paths !== undefined) {
    const vr = validateAndCapAgentPaths('claimed_paths', patch.claimed_paths, undefined);
    if (!vr.ok) return vr;
    claimedPaths = vr.value;
  }
  let lastModifiedPaths: readonly string[] | undefined;
  if (patch.last_modified_paths !== undefined) {
    const vr = validateAndCapAgentPaths(
      'last_modified_paths',
      patch.last_modified_paths,
      LAST_MODIFIED_PATHS_MAX
    );
    if (!vr.ok) return vr;
    lastModifiedPaths = vr.value;
  }

  const registry: Record<string, AgentRegistry[string]> = { ...readResult.value };
  const prev = registry[patch.session.session_id] ?? { session_id: patch.session.session_id, last_active: patch.last_active };
  registry[patch.session.session_id] = {
    ...prev,
    session_id: patch.session.session_id,
    ...(patch.session.platform !== undefined ? { platform: patch.session.platform } : {}),
    last_active: patch.last_active,
    ...(patch.bound_worktree !== undefined ? { bound_worktree: patch.bound_worktree } : {}),
    ...(patch.bound_spec_id !== undefined ? { bound_spec_id: patch.bound_spec_id } : {}),
    ...(claimedPaths !== undefined ? { claimed_paths: claimedPaths } : {}),
    ...(lastModifiedPaths !== undefined ? { last_modified_paths: lastModifiedPaths } : {}),
  };
  return writeRegistryJson(filePath, registry);
}
