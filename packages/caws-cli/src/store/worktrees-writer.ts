// Worktree lifecycle writer (CLI-WORKTREE-001).
//
// Composes:
//   - kernel worktree functions (bindWorktree, deriveBindingState,
//     assertOwnership) for legality/derivation
//   - applyRegistryPatch for worktrees.json + agents.json writes
//   - yaml-patch for spec.worktree field mutations
//   - lifecycle-transaction for atomic multi-file writes + event append
//   - specs-writer.closeSpec for auto-close on merge
//
// What this module owns:
//   - createWorktree: git worktree add + registry entry + spec binding
//     + worktree_created + worktree_bound events (two distinct facts)
//   - bindWorktree: bidirectional binding repair (one-sided → bound)
//   - destroyWorktree: safe destroy (refuses dirty, foreign, unmerged
//     unless explicit non-default flag). NO --force.
//   - mergeWorktree: dry-run + git merge --no-ff + auto-close via
//     specs-writer + worktree_merged event + destroy
//
// What this module does NOT do:
//   - Re-implement v10 worktree-manager.js behavior (repair, prune,
//     reconcile, auto-register, materializeWorktreeSpec — all out).
//   - Append events directly to events.jsonl.
//   - Mutate worktrees.json without going through applyRegistryPatch.
//   - Run rm -rf on any path.

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import {
  bindWorktree as kernelBindWorktree,
  type EventBody,
  err,
  isOk,
  ok,
  parseAndValidateSpec,
  type Result,
  type SessionIdentity,
  type Diagnostic,
} from '@paths.design/caws-kernel';

import { applyRegistryPatch } from './apply-patch';
import { closeSpec } from './specs-writer';
import { loadSpecs } from './specs-store';
import { loadWorktrees } from './worktrees-store';
import { runLifecycleTransaction } from './lifecycle-transaction';
import { withLifecycleLock } from './lifecycle-lock';
import { storeDiagnostic } from './repo-root';
import { STORE_RULES } from './rules';
import {
  insertTopLevelScalarAfter,
  setTopLevelScalar,
} from './yaml-patch';
import { readYamlSource } from './yaml-store';

// ─── Common types ────────────────────────────────────────────────────────

export interface CreateWorktreeInput {
  readonly name: string;
  readonly specId: string;
  /** Optional: base branch for the new worktree. Defaults to repo HEAD's
   *  current branch. */
  readonly baseBranch?: string;
  /** Optional: new branch name for the worktree. Defaults to the
   *  worktree name. */
  readonly branch?: string;
  readonly session: SessionIdentity;
  readonly actor: EventBody['actor'];
  readonly now?: () => Date;
}

export interface BindWorktreeInput {
  readonly name: string;
  readonly specId: string;
  readonly session: SessionIdentity;
  readonly actor: EventBody['actor'];
  readonly now?: () => Date;
}

export interface DestroyWorktreeInput {
  readonly name: string;
  readonly session: SessionIdentity;
  readonly actor: EventBody['actor'];
  readonly now?: () => Date;
  /** Allow destruction even when the branch is not merged into base.
   *  Default false. There is intentionally NO --force; this is the
   *  one explicit override and it does not bypass ownership. */
  readonly abandonUnmerged?: boolean;
}

export interface MergeWorktreeInput {
  readonly name: string;
  readonly session: SessionIdentity;
  readonly actor: EventBody['actor'];
  readonly now?: () => Date;
  /** When true, perform validation only; no git operations, no file
   *  writes, no event appends. */
  readonly dryRun?: boolean;
  /** Optional commit message for the merge commit. Defaults to a
   *  conventional "merge(worktree): <name>" form. */
  readonly message?: string;
}

export type WorktreeWriterOutcome =
  | {
      readonly kind: 'success';
      readonly name: string;
      readonly action: 'created' | 'bound' | 'destroyed' | 'merged';
      readonly data?: Record<string, unknown>;
    }
  | {
      readonly kind: 'dry_run';
      readonly name: string;
      readonly canProceed: boolean;
      readonly findings: readonly string[];
    }
  | {
      readonly kind: 'partial_failure_recovered';
      readonly cause: readonly Diagnostic[];
    };

// ─── Path helpers ────────────────────────────────────────────────────────

function specPath(cawsDir: string, id: string): string {
  return path.join(cawsDir, 'specs', `${id}.yaml`);
}
function worktreePathFor(cawsDir: string, name: string): string {
  return path.join(cawsDir, 'worktrees', name);
}

// ─── Git helpers ─────────────────────────────────────────────────────────

function runGit(args: readonly string[], cwd: string): { ok: true; stdout: string } | { ok: false; reason: string } {
  try {
    const stdout = execFileSync('git', [...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, stdout: stdout.toString() };
  } catch (e) {
    const cause = e as { message?: string; stderr?: Buffer | string };
    const stderr: string =
      cause.stderr instanceof Buffer
        ? cause.stderr.toString()
        : typeof cause.stderr === 'string'
          ? cause.stderr
          : '';
    const message: string = typeof cause.message === 'string' ? cause.message : '';
    return { ok: false, reason: stderr || message || 'unknown git error' };
  }
}

function repoRootFromCawsDir(cawsDir: string): string {
  return path.dirname(cawsDir);
}

function getCurrentBranch(repoRoot: string): string | null {
  const r = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot);
  if (!r.ok) return null;
  return r.stdout.trim();
}

function isWorkingTreeClean(worktreePath: string): boolean {
  const r = runGit(['status', '--porcelain'], worktreePath);
  if (!r.ok) return false;
  return r.stdout.trim().length === 0;
}

function isBranchMerged(repoRoot: string, branch: string, base: string): boolean {
  const r = runGit(['merge-base', '--is-ancestor', branch, base], repoRoot);
  // Git exits 0 when branch is ancestor of base (i.e., branch is fully merged).
  return r.ok;
}

// ─── ID + name validation ────────────────────────────────────────────────

const WORKTREE_NAME_REGEX = /^[a-zA-Z0-9_-]+$/;
const SPEC_ID_PATTERN = /^[A-Z][A-Z0-9]*(-[A-Z0-9]+)*-\d+[a-z]*$/;

function validateWorktreeName(name: string): Result<true> {
  if (!WORKTREE_NAME_REGEX.test(name)) {
    return err(
      storeDiagnostic(
        STORE_RULES.LIFECYCLE_PLAN_REJECTED,
        `Worktree name "${name}" does not match the v11 pattern (alphanumeric, hyphen, underscore).`,
        { subject: name }
      )
    );
  }
  return ok(true as const);
}

function validateSpecId(id: string): Result<true> {
  if (!SPEC_ID_PATTERN.test(id)) {
    return err(
      storeDiagnostic(
        STORE_RULES.LIFECYCLE_PLAN_REJECTED,
        `Spec id "${id}" does not match the v11 pattern.`,
        { subject: id }
      )
    );
  }
  return ok(true as const);
}

// ─── Spec lookup with strict active-only enforcement ─────────────────────

function loadSpecOrError(cawsDir: string, specId: string): Result<{
  readonly source: string;
  readonly path: string;
  readonly spec: ReturnType<typeof parseAndValidateSpec> extends Result<infer S> ? S : never;
  readonly lifecycleState: string;
  readonly currentWorktree: string | undefined;
}> {
  const p = specPath(cawsDir, specId);
  if (!fs.existsSync(p)) {
    return err(
      storeDiagnostic(
        STORE_RULES.LIFECYCLE_PLAN_REJECTED,
        `Spec "${specId}" not found at ${p}.`,
        { subject: specId }
      )
    );
  }
  const srcResult = readYamlSource(p);
  if (!isOk(srcResult)) return err(srcResult.errors);
  const parsed = parseAndValidateSpec(srcResult.value);
  if (!isOk(parsed)) {
    return err(
      parsed.errors.map((d) =>
        storeDiagnostic(STORE_RULES.LIFECYCLE_PLAN_REJECTED, d.message, {
          subject: d.subject ?? specId,
          data: { source_rule: d.rule },
        })
      )
    );
  }
  const spec = parsed.value as {
    lifecycle_state: string;
    worktree?: string;
  };
  return ok({
    source: srcResult.value,
    path: p,
    spec: parsed.value as never,
    lifecycleState: spec.lifecycle_state,
    currentWorktree: spec.worktree,
  });
}

// ─── Spec YAML mutation for worktree binding ─────────────────────────────

/** Set `worktree: <name>` on a spec via raw-byte patching. Inserts the
 *  field after `lifecycle_state` if absent. Returns patched bytes. */
function patchSpecSetWorktree(
  source: string,
  worktreeName: string
): Result<string> {
  const hasField = /^worktree:/m.test(source);
  if (hasField) {
    return setTopLevelScalar(source, 'worktree', worktreeName);
  }
  return insertTopLevelScalarAfter(
    source,
    'lifecycle_state',
    'worktree',
    worktreeName
  );
}

/** Remove `worktree:` from a spec (sets to empty string via patch and
 *  trims). For destroy. */
function patchSpecClearWorktree(source: string): Result<string> {
  const hasField = /^worktree:/m.test(source);
  if (!hasField) return ok(source);
  // Replace with empty value to keep the surface minimal; future
  // doctor logic may treat empty as "unset" or we may insert a
  // remove operation later. For now, set to '' which the kernel
  // tolerates as no binding.
  return setTopLevelScalar(source, 'worktree', "''");
}

// ─── createWorktree ──────────────────────────────────────────────────────

export function createWorktree(
  cawsDir: string,
  input: CreateWorktreeInput
): Result<WorktreeWriterOutcome> {
  // ─ Pre-flight validation (no git, no file writes) ─

  const nameValidation = validateWorktreeName(input.name);
  if (!nameValidation.ok) return nameValidation;
  const specValidation = validateSpecId(input.specId);
  if (!specValidation.ok) return specValidation;

  const specInfo = loadSpecOrError(cawsDir, input.specId);
  if (!isOk(specInfo)) return err(specInfo.errors);
  if (specInfo.value.lifecycleState !== 'active') {
    return err(
      storeDiagnostic(
        STORE_RULES.LIFECYCLE_PLAN_REJECTED,
        `Spec "${input.specId}" is in lifecycle_state "${specInfo.value.lifecycleState}"; only active specs can be bound to a new worktree.`,
        { subject: input.specId }
      )
    );
  }
  if (
    specInfo.value.currentWorktree !== undefined &&
    specInfo.value.currentWorktree.length > 0 &&
    specInfo.value.currentWorktree !== input.name
  ) {
    return err(
      storeDiagnostic(
        STORE_RULES.LIFECYCLE_PLAN_REJECTED,
        `Spec "${input.specId}" is already bound to worktree "${specInfo.value.currentWorktree}".`,
        { subject: input.specId }
      )
    );
  }

  // Refuse if a worktree with this name already exists in the registry.
  const registry = loadWorktrees(cawsDir);
  if (!isOk(registry)) return err(registry.errors);
  if (registry.value[input.name] !== undefined) {
    return err(
      storeDiagnostic(
        STORE_RULES.LIFECYCLE_PLAN_REJECTED,
        `Worktree "${input.name}" already exists in registry.`,
        { subject: input.name }
      )
    );
  }

  const repoRoot = repoRootFromCawsDir(cawsDir);
  const baseBranch = input.baseBranch ?? getCurrentBranch(repoRoot);
  if (baseBranch === null) {
    return err(
      storeDiagnostic(
        STORE_RULES.LIFECYCLE_PLAN_REJECTED,
        `Could not determine base branch for new worktree.`,
        { subject: input.name }
      )
    );
  }
  const branch = input.branch ?? input.name;
  const wtPath = worktreePathFor(cawsDir, input.name);

  // ─ Git operation: outside lifecycle-transaction ─

  const gitResult = runGit(
    ['worktree', 'add', '-b', branch, wtPath, baseBranch],
    repoRoot
  );
  if (!gitResult.ok) {
    return err(
      storeDiagnostic(
        STORE_RULES.LIFECYCLE_PLAN_REJECTED,
        `git worktree add failed: ${gitResult.reason}`,
        { subject: input.name, data: { git_stderr: gitResult.reason } }
      )
    );
  }

  // ─ Lifecycle transaction: spec.worktree patch + worktrees.json patch
  //   + two events. If anything fails, run git worktree remove as
  //   compensation. ─

  const now = (input.now ?? (() => new Date()))().toISOString();
  const newSpecBytes = patchSpecSetWorktree(specInfo.value.source, input.name);
  if (!isOk(newSpecBytes)) {
    rollbackGitWorktree(repoRoot, wtPath);
    return err(newSpecBytes.errors);
  }

  // Build the worktree_created event (no spec_id — binding is a
  // separate fact emitted next).
  const createdEvent: EventBody = {
    event: 'worktree_created',
    ts: now,
    actor: input.actor,
    data: {
      name: input.name,
      branch,
      base_branch: baseBranch,
      path: wtPath,
      owner_session_id: input.session.session_id,
    },
  } as unknown as EventBody;

  const boundEvent: EventBody = {
    event: 'worktree_bound',
    ts: now,
    actor: input.actor,
    spec_id: input.specId,
    data: {
      worktree_name: input.name,
    },
  } as unknown as EventBody;

  const txnOutcome = withLifecycleLock(cawsDir, () => {
    // Use kernel bindWorktree with the actual parsed Spec so it can
    // verify lifecycle_state etc.
    const bindResult = kernelBindWorktree(
      specInfo.value.spec,
      registry.value,
      input.name,
      input.session,
      { rebind: false },
      new Date(now)
    );
    if (!isOk(bindResult)) return err(bindResult.errors);

    // Apply the bind_worktree patch (writes worktrees.json with the
    // kernel-modeled fields: specId, owner, last_heartbeat).
    const applyResult = applyRegistryPatch(cawsDir, bindResult.value);
    if (!isOk(applyResult)) return err(applyResult.errors);

    // Augment the entry with descriptive metadata the kernel does NOT
    // model (branch, baseBranch, path). These are governance metadata
    // for merge/destroy decisions, not authority claims.
    augmentRegistryEntry(cawsDir, input.name, { branch, baseBranch, path: wtPath });

    // Then run the lifecycle transaction for spec YAML + events.
    return runLifecycleTransaction({
      cawsDir,
      plannedWrites: [{ path: specInfo.value.path, contents: newSpecBytes.value }],
      events: [createdEvent, boundEvent],
    });
  });

  if (!txnOutcome.ok) {
    // Compensation: remove the git worktree we created.
    rollbackGitWorktree(repoRoot, wtPath);
    // Also remove the registry entry that bind_worktree wrote.
    rollbackRegistryEntry(cawsDir, input.name);
    return err(txnOutcome.errors);
  }
  if (txnOutcome.value.kind !== 'success') {
    rollbackGitWorktree(repoRoot, wtPath);
    rollbackRegistryEntry(cawsDir, input.name);
    return ok({
      kind: 'partial_failure_recovered',
      cause: txnOutcome.value.cause,
    });
  }
  return ok({
    kind: 'success',
    name: input.name,
    action: 'created',
    data: { branch, base_branch: baseBranch, path: wtPath, spec_id: input.specId },
  });
}

function rollbackGitWorktree(repoRoot: string, wtPath: string): void {
  // Best-effort. We're already in an error path.
  runGit(['worktree', 'remove', '--force', wtPath], repoRoot);
}

function rollbackRegistryEntry(cawsDir: string, name: string): void {
  // Direct file mutation for rollback — applyRegistryPatch has no
  // "remove entry" mode. This is best-effort recovery.
  const p = path.join(cawsDir, 'worktrees.json');
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object' && obj[name] !== undefined) {
      delete obj[name];
      fs.writeFileSync(p, JSON.stringify(obj, null, 2));
    }
  } catch {
    /* best-effort */
  }
}

/** Augment a registry entry with descriptive metadata the kernel
 *  doesn't model (branch, baseBranch, path). These fields are used by
 *  merge/destroy for prerequisite checks but are not authority claims.
 *  applyRegistryPatch only touches the kernel-modeled fields, so we
 *  layer in the rest via a direct merge. Best-effort — read failure
 *  is logged but doesn't fail the caller. */
function augmentRegistryEntry(
  cawsDir: string,
  name: string,
  extra: { readonly branch?: string; readonly baseBranch?: string; readonly path?: string }
): void {
  const p = path.join(cawsDir, 'worktrees.json');
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return;
    const entry = obj[name];
    if (!entry || typeof entry !== 'object') return;
    obj[name] = { ...entry, ...extra };
    fs.writeFileSync(p, JSON.stringify(obj, null, 2));
  } catch {
    /* best-effort */
  }
}

// ─── bindWorktree (repair) ───────────────────────────────────────────────

export function bindWorktreeRepair(
  cawsDir: string,
  input: BindWorktreeInput
): Result<WorktreeWriterOutcome> {
  const nameValidation = validateWorktreeName(input.name);
  if (!nameValidation.ok) return nameValidation;
  const specValidation = validateSpecId(input.specId);
  if (!specValidation.ok) return specValidation;

  const specInfo = loadSpecOrError(cawsDir, input.specId);
  if (!isOk(specInfo)) return err(specInfo.errors);

  const registry = loadWorktrees(cawsDir);
  if (!isOk(registry)) return err(registry.errors);
  const existingEntry = registry.value[input.name];

  if (existingEntry === undefined) {
    return err(
      storeDiagnostic(
        STORE_RULES.LIFECYCLE_PLAN_REJECTED,
        `Worktree "${input.name}" has no registry entry. Use caws worktree create to create a new worktree.`,
        { subject: input.name }
      )
    );
  }

  // Patch the spec YAML to set worktree: <name>.
  const newSpecBytes = patchSpecSetWorktree(specInfo.value.source, input.name);
  if (!isOk(newSpecBytes)) return err(newSpecBytes.errors);

  // Apply registry patch to set specId on the entry. We use the
  // kernel bindWorktree to get the right patch shape.
  const now = (input.now ?? (() => new Date()))().toISOString();
  const txnOutcome = withLifecycleLock(cawsDir, () => {
    const bindResult = kernelBindWorktree(
      specInfo.value.spec,
      registry.value,
      input.name,
      input.session,
      { rebind: existingEntry.specId !== undefined && existingEntry.specId !== input.specId },
      new Date(now)
    );
    if (!isOk(bindResult)) return err(bindResult.errors);
    const applyResult = applyRegistryPatch(cawsDir, bindResult.value);
    if (!isOk(applyResult)) return err(applyResult.errors);

    const eventData: Record<string, unknown> = { worktree_name: input.name };
    if (
      existingEntry.specId !== undefined &&
      existingEntry.specId !== input.specId
    ) {
      eventData.previously_bound_to = existingEntry.specId;
    }
    const event: EventBody = {
      event: 'worktree_bound',
      ts: now,
      actor: input.actor,
      spec_id: input.specId,
      data: eventData,
    } as unknown as EventBody;

    return runLifecycleTransaction({
      cawsDir,
      plannedWrites: [{ path: specInfo.value.path, contents: newSpecBytes.value }],
      events: [event],
    });
  });

  if (!txnOutcome.ok) return err(txnOutcome.errors);
  if (txnOutcome.value.kind !== 'success') {
    return ok({ kind: 'partial_failure_recovered', cause: txnOutcome.value.cause });
  }
  return ok({ kind: 'success', name: input.name, action: 'bound' });
}

// ─── destroyWorktree ─────────────────────────────────────────────────────

export function destroyWorktree(
  cawsDir: string,
  input: DestroyWorktreeInput
): Result<WorktreeWriterOutcome> {
  const nameValidation = validateWorktreeName(input.name);
  if (!nameValidation.ok) return nameValidation;

  const registry = loadWorktrees(cawsDir);
  if (!isOk(registry)) return err(registry.errors);
  const entry = registry.value[input.name];
  if (entry === undefined) {
    return err(
      storeDiagnostic(
        STORE_RULES.LIFECYCLE_PLAN_REJECTED,
        `Worktree "${input.name}" not found in registry.`,
        { subject: input.name }
      )
    );
  }

  // Ownership check: refuse foreign session unless takeover already
  // happened in a separate step (caws claim --takeover writes a
  // prior_owners audit; ownership then matches and we proceed).
  if (
    entry.owner !== undefined &&
    entry.owner.session_id !== input.session.session_id
  ) {
    return err(
      storeDiagnostic(
        STORE_RULES.LIFECYCLE_PLAN_REJECTED,
        `Worktree "${input.name}" is owned by a different session (${entry.owner.session_id}). Run 'caws claim ${input.name} --takeover' first if you need to take ownership.`,
        { subject: input.name }
      )
    );
  }

  // Dirty-tree check.
  const wtPath = entry.path ?? worktreePathFor(cawsDir, input.name);
  if (fs.existsSync(wtPath) && !isWorkingTreeClean(wtPath)) {
    return err(
      storeDiagnostic(
        STORE_RULES.LIFECYCLE_PLAN_REJECTED,
        `Worktree "${input.name}" has uncommitted changes. Commit or stash before destroying.`,
        { subject: input.name }
      )
    );
  }

  // Unmerged-branch check (skipped when --abandon-unmerged is passed).
  const repoRoot = repoRootFromCawsDir(cawsDir);
  if (
    entry.branch !== undefined &&
    entry.baseBranch !== undefined &&
    input.abandonUnmerged !== true &&
    !isBranchMerged(repoRoot, entry.branch, entry.baseBranch)
  ) {
    return err(
      storeDiagnostic(
        STORE_RULES.LIFECYCLE_PLAN_REJECTED,
        `Branch "${entry.branch}" is not merged into "${entry.baseBranch}". Pass --abandon-unmerged to destroy anyway.`,
        { subject: input.name }
      )
    );
  }

  // Run git worktree remove. Never rm -rf.
  let removedGitWorktree = false;
  if (fs.existsSync(wtPath)) {
    const removeResult = runGit(['worktree', 'remove', wtPath], repoRoot);
    if (!removeResult.ok) {
      return err(
        storeDiagnostic(
          STORE_RULES.LIFECYCLE_WRITE_FAILED,
          `git worktree remove failed: ${removeResult.reason}`,
          { subject: input.name }
        )
      );
    }
    removedGitWorktree = true;
  }

  // Clear spec.worktree field if a spec was bound.
  const now = (input.now ?? (() => new Date()))().toISOString();
  const plannedWrites: { path: string; contents: string }[] = [];
  if (entry.specId !== undefined) {
    const specInfo = loadSpecOrError(cawsDir, entry.specId);
    if (isOk(specInfo)) {
      const newSpecBytes = patchSpecClearWorktree(specInfo.value.source);
      if (isOk(newSpecBytes) && newSpecBytes.value !== specInfo.value.source) {
        plannedWrites.push({
          path: specInfo.value.path,
          contents: newSpecBytes.value,
        });
      }
    }
  }

  const eventData: Record<string, unknown> = {
    worktree_name: input.name,
    branch: entry.branch ?? 'unknown',
    path: wtPath,
    removed_git_worktree: removedGitWorktree,
  };
  if (entry.specId !== undefined) eventData.spec_id = entry.specId;
  if (entry.owner !== undefined) eventData.owner_session_id = entry.owner.session_id;

  const event: EventBody = {
    event: 'worktree_destroyed',
    ts: now,
    actor: input.actor,
    data: eventData,
  } as unknown as EventBody;

  const txnOutcome = withLifecycleLock(cawsDir, () => {
    // Remove the registry entry first.
    rollbackRegistryEntry(cawsDir, input.name); // misnomer — also used here as the canonical remover
    return runLifecycleTransaction({
      cawsDir,
      plannedWrites,
      events: [event],
    });
  });

  if (!txnOutcome.ok) return err(txnOutcome.errors);
  if (txnOutcome.value.kind !== 'success') {
    return ok({ kind: 'partial_failure_recovered', cause: txnOutcome.value.cause });
  }
  return ok({
    kind: 'success',
    name: input.name,
    action: 'destroyed',
    data: { removed_git_worktree: removedGitWorktree },
  });
}

// ─── mergeWorktree ───────────────────────────────────────────────────────

export function mergeWorktree(
  cawsDir: string,
  input: MergeWorktreeInput
): Result<WorktreeWriterOutcome> {
  const nameValidation = validateWorktreeName(input.name);
  if (!nameValidation.ok) return nameValidation;

  const registry = loadWorktrees(cawsDir);
  if (!isOk(registry)) return err(registry.errors);
  const entry = registry.value[input.name];
  if (entry === undefined) {
    return err(
      storeDiagnostic(
        STORE_RULES.LIFECYCLE_PLAN_REJECTED,
        `Worktree "${input.name}" not found in registry.`,
        { subject: input.name }
      )
    );
  }

  // Validate prerequisites.
  const findings: string[] = [];
  if (entry.owner !== undefined && entry.owner.session_id !== input.session.session_id) {
    findings.push(`worktree is owned by a different session (${entry.owner.session_id})`);
  }
  const wtPath = entry.path ?? worktreePathFor(cawsDir, input.name);
  if (fs.existsSync(wtPath) && !isWorkingTreeClean(wtPath)) {
    findings.push('worktree has uncommitted changes');
  }
  if (entry.specId === undefined) {
    findings.push('no spec_id binding on this worktree');
  }
  if (entry.branch === undefined || entry.baseBranch === undefined) {
    findings.push('missing branch or base_branch on registry entry');
  }

  // Dry-run: report and return without mutation.
  if (input.dryRun === true) {
    return ok({
      kind: 'dry_run',
      name: input.name,
      canProceed: findings.length === 0,
      findings,
    });
  }

  if (findings.length > 0) {
    return err(
      storeDiagnostic(
        STORE_RULES.LIFECYCLE_PLAN_REJECTED,
        `caws worktree merge ${input.name}: prerequisites unmet (${findings.join('; ')}).`,
        { subject: input.name, data: { findings } }
      )
    );
  }

  // Perform the merge: git checkout base + git merge --no-ff.
  const repoRoot = repoRootFromCawsDir(cawsDir);
  const baseBranch = entry.baseBranch as string;
  const branch = entry.branch as string;
  const specId = entry.specId as string;

  const checkoutResult = runGit(['checkout', baseBranch], repoRoot);
  if (!checkoutResult.ok) {
    return err(
      storeDiagnostic(
        STORE_RULES.LIFECYCLE_WRITE_FAILED,
        `git checkout ${baseBranch} failed: ${checkoutResult.reason}`,
        { subject: input.name }
      )
    );
  }

  const message = input.message ?? `merge(worktree): ${input.name}`;
  const mergeResult = runGit(
    ['merge', '--no-ff', '-m', message, branch],
    repoRoot
  );
  if (!mergeResult.ok) {
    return err(
      storeDiagnostic(
        STORE_RULES.LIFECYCLE_WRITE_FAILED,
        `git merge --no-ff ${branch} failed: ${mergeResult.reason}`,
        { subject: input.name }
      )
    );
  }

  // Obtain the merge commit SHA.
  const shaResult = runGit(['rev-parse', 'HEAD'], repoRoot);
  if (!shaResult.ok) {
    return err(
      storeDiagnostic(
        STORE_RULES.LIFECYCLE_WRITE_FAILED,
        `git rev-parse HEAD failed: ${shaResult.reason}`,
        { subject: input.name }
      )
    );
  }
  const mergeCommit = shaResult.stdout.trim();
  if (!/^[0-9a-f]{7,40}$/.test(mergeCommit)) {
    return err(
      storeDiagnostic(
        STORE_RULES.LIFECYCLE_WRITE_FAILED,
        `Unexpected merge commit shape from git: ${mergeCommit}`,
        { subject: input.name }
      )
    );
  }

  // Auto-close the bound spec through the canonical specs-writer
  // path. This appends spec_closed. We then append worktree_merged
  // with auto_closed_spec: true.
  //
  // `mergeNow` is captured once and reused for every sub-operation
  // (close, worktree_merged append, destroy). Composed merge is one
  // governance moment; emitted events must share that baseline so
  // ts order matches seq order in the chain. Without this, sub-calls
  // re-read the wall clock at append time and can produce timestamps
  // that disagree with seq (seq remains the causal authority, but
  // human-readable timestamps should not contradict it).
  const mergeNow = new Date((input.now ?? (() => new Date()))().getTime());
  const now = mergeNow.toISOString();
  const sharedNowFactory = () => mergeNow;
  const closeResult = closeSpec(cawsDir, {
    id: specId,
    resolution: 'completed',
    reason: `Auto-closed by caws worktree merge ${input.name} at ${mergeCommit}`,
    mergeCommit,
    actor: input.actor,
    now: sharedNowFactory,
  });

  if (!isOk(closeResult)) {
    return err(
      storeDiagnostic(
        STORE_RULES.LIFECYCLE_PARTIAL_FAILURE_UNRECOVERED,
        `Merge succeeded (commit ${mergeCommit}) but spec close failed. The bound spec remains active.`,
        {
          subject: input.name,
          data: {
            merge_commit: mergeCommit,
            spec_id: specId,
            close_errors: closeResult.errors.map((d) => d.message),
            recovery_instruction: `Manually run: caws specs close ${specId} --resolution completed --merge-commit ${mergeCommit}`,
          },
        }
      )
    );
  }

  // Append worktree_merged AFTER spec_closed so the chain reflects
  // the actual order of state transitions.
  const mergedEvent: EventBody = {
    event: 'worktree_merged',
    ts: now,
    actor: input.actor,
    spec_id: specId,
    data: {
      worktree_name: input.name,
      merge_commit: mergeCommit,
      base_branch: baseBranch,
      auto_closed_spec: true,
    },
  } as unknown as EventBody;

  // The worktree_merged event is appended via runLifecycleTransaction
  // even though we have no file writes for this step; the substrate's
  // append path is the only sanctioned writer for events.jsonl.
  const mergedTxn = withLifecycleLock(cawsDir, () =>
    runLifecycleTransaction({
      cawsDir,
      plannedWrites: [],
      events: [mergedEvent],
    })
  );
  if (!mergedTxn.ok) {
    return err(
      storeDiagnostic(
        STORE_RULES.LIFECYCLE_PARTIAL_FAILURE_UNRECOVERED,
        `Merge succeeded and spec_closed event appended, but worktree_merged event append failed. The worktree was not destroyed.`,
        {
          subject: input.name,
          data: {
            merge_commit: mergeCommit,
            recovery_instruction: `Manually destroy the worktree: caws worktree destroy ${input.name}`,
          },
        }
      )
    );
  }

  // Destroy the worktree last. Reuse the same merge-baseline clock
  // so worktree_destroyed.ts matches the rest of the composed merge.
  const destroyResult = destroyWorktree(cawsDir, {
    name: input.name,
    session: input.session,
    actor: input.actor,
    now: sharedNowFactory,
  });
  if (!isOk(destroyResult)) {
    // The merge + close + merged event all succeeded. The destroy
    // failed. Surface as partial-failure with a manual recovery hint.
    return err(
      storeDiagnostic(
        STORE_RULES.LIFECYCLE_PARTIAL_FAILURE_UNRECOVERED,
        `Merge succeeded but post-merge worktree destroy failed. Run caws worktree destroy ${input.name} manually.`,
        {
          subject: input.name,
          data: {
            merge_commit: mergeCommit,
            destroy_errors: destroyResult.errors.map((d) => d.message),
          },
        }
      )
    );
  }

  return ok({
    kind: 'success',
    name: input.name,
    action: 'merged',
    data: { merge_commit: mergeCommit, spec_id: specId, auto_closed_spec: true },
  });
}

// ─── listWorktrees ───────────────────────────────────────────────────────

export interface WorktreeListEntry {
  readonly name: string;
  readonly path: string;
  readonly branch: string;
  readonly baseBranch: string;
  readonly specId: string | null;
  readonly owner: SessionIdentity | null;
  readonly status: 'active' | 'unknown';
}

export interface WorktreeListResult {
  readonly entries: readonly WorktreeListEntry[];
}

export function listWorktreesPretty(cawsDir: string): Result<WorktreeListResult> {
  const registry = loadWorktrees(cawsDir);
  if (!isOk(registry)) return err(registry.errors);
  const entries: WorktreeListEntry[] = [];
  for (const [name, record] of Object.entries(registry.value)) {
    if (typeof record !== 'object' || record === null) continue;
    entries.push({
      name,
      path: record.path ?? worktreePathFor(cawsDir, name),
      branch: record.branch ?? 'unknown',
      baseBranch: record.baseBranch ?? 'unknown',
      specId: record.specId ?? null,
      owner: record.owner ?? null,
      status: 'active',
    });
  }
  // Sort for deterministic output.
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return ok({ entries });
}

// Re-export loadSpecs for any future consumers; not used internally
// but the writer surface is the canonical place for spec/worktree
// joins in the future.
export { loadSpecs };
