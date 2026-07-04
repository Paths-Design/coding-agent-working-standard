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
//   - untrackWorktree: safe control-plane release that preserves the physical
//     git worktree directory for inspection.
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
import { autoCommit, isPathDirty, type AutoCommitOutcome } from './git-autocommit';
import { configureWorktreeSparseCheckout } from './git-sparse-checkout';
import {
  linkWorktreeArtifacts,
  listVerifiedArtifactLinks,
  removeWorktreeArtifactLinks,
} from './worktree-artifacts';
import { closeSpec } from './specs-writer';
import { loadSpecs } from './specs-store';
import { loadWorktrees } from './worktrees-store';
import { runLifecycleTransaction } from './lifecycle-transaction';
import { withLifecycleLock } from './lifecycle-lock';
import {
  admitsOwner,
  describeCandidateTrace,
} from '../shell/session/resolve-session';
import type { SessionCandidates } from '../shell/session/types';
import { storeDiagnostic } from './repo-root';
import { STORE_RULES } from './rules';
import {
  insertTopLevelScalarAfter,
  removeTopLevelScalar,
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
  /**
   * The exhaustive set of session identities the invoking process can speak
   * for, used for the foreign-owner admission check (WORKTREE-ISOLATION-
   * HARDENING-001 Fix 4). Same semantic as DestroyWorktreeInput.sessionCandidates
   * — admission is set membership against entry.owner.session_id, not cwd-keyed
   * equality. Construct via the shell layer's resolveSessionCandidates().
   */
  readonly sessionCandidates: SessionCandidates;
  readonly actor: EventBody['actor'];
  readonly now?: () => Date;
  /**
   * Forced ownership steal. When the target worktree is owned by a session NOT
   * admitted by sessionCandidates, the bind refuses UNLESS steal is true AND a
   * non-empty stealReason is supplied. A successful steal appends a
   * worktree_ownership_seized audit event. This is decoupled from owner
   * liveness (the PID/liveness split is a separate campaign): the guard keys
   * only on "owner exists and does not admit the caller".
   */
  readonly steal?: boolean;
  readonly stealReason?: string;
}

export interface DestroyWorktreeInput {
  readonly name: string;
  /**
   * The session identity to record as the actor of the destroy event.
   * Single identity by design — an event has exactly one author. This
   * is the field minted-or-resolved by the caller's
   * resolveSession({ allowMint: true }) call.
   */
  readonly session: SessionIdentity;
  /**
   * The exhaustive set of session identities the invoking process can
   * speak for, used for the ownership-comparison admission check.
   *
   * The split between `session` (actor) and `sessionCandidates`
   * (comparison) addresses the destroy-side failure mode of
   * CAWS-WORKTREE-DESTROY-SESSION-RESOLUTION-001: a single cwd-keyed
   * `session` cannot distinguish "I am the registered owner via a
   * sibling-cwd capsule" from "I am a genuinely-foreign session", so
   * a destroy issued from canonical after a `claim --takeover` from
   * inside the worktree would refuse its own owner. The comparison
   * now admits the destroy iff ANY candidate matches `entry.owner`,
   * which is the honest semantic — comparison is set membership, not
   * cwd-keyed equality.
   *
   * Construct via the shell layer's `resolveSessionCandidates()`.
   */
  readonly sessionCandidates: SessionCandidates;
  readonly actor: EventBody['actor'];
  readonly now?: () => Date;
  /** Allow destruction even when the branch is not merged into base.
   *  Default false. There is intentionally NO --force; this is the
   *  one explicit override and it does not bypass ownership. */
  readonly abandonUnmerged?: boolean;
}

export interface UntrackWorktreeInput {
  readonly name: string;
  readonly session: SessionIdentity;
  readonly sessionCandidates: SessionCandidates;
  readonly actor: EventBody['actor'];
  /** Human-readable operator reason recorded on worktree_untracked. */
  readonly reason: string;
  readonly now?: () => Date;
  readonly dryRun?: boolean;
}

export interface MergeWorktreeInput {
  readonly name: string;
  /** See DestroyWorktreeInput.session — same actor/event-author role. */
  readonly session: SessionIdentity;
  /** See DestroyWorktreeInput.sessionCandidates — same comparison semantic. */
  readonly sessionCandidates: SessionCandidates;
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
      readonly action: 'created' | 'bound' | 'destroyed' | 'merged' | 'pruned' | 'untracked';
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
function registryRelPath(cawsDir: string, repoRoot: string): string {
  return path.relative(repoRoot, path.join(cawsDir, 'worktrees.json'));
}
function specRelPath(
  cawsDir: string,
  specId: string,
  repoRoot: string
): string {
  return path.relative(repoRoot, specPath(cawsDir, specId));
}

// ─── Auto-commit helper ──────────────────────────────────────────────────
//
// CAWS-FIRST-CONTACT-UX-001 Fix 5: every successful worktrees-writer
// lifecycle transaction commits its file changes as the final step.
// The shared git-autocommit utility handles the three observable
// states (committed / refused_dirty / skipped_no_git); this helper
// computes the right inputs and never throws.
//
// Pre-write dirty state must be captured by the CALLER, before any
// writer mutation lands. The utility cannot rederive it after the
// fact.

interface PreWriteState {
  readonly registryWasDirty: boolean;
  readonly specWasDirty: boolean;
}

function capturePreWriteState(
  cawsDir: string,
  specId: string | null
): PreWriteState {
  const repoRoot = repoRootFromCawsDir(cawsDir);
  const registryPath = registryRelPath(cawsDir, repoRoot);
  return {
    registryWasDirty: isPathDirty(repoRoot, registryPath),
    specWasDirty:
      specId === null
        ? false
        : isPathDirty(repoRoot, specRelPath(cawsDir, specId, repoRoot)),
  };
}

function autoCommitTransition(
  cawsDir: string,
  specId: string | null,
  name: string,
  action: 'created' | 'bound' | 'destroyed' | 'merged' | 'untracked',
  preState: PreWriteState
): AutoCommitOutcome {
  const repoRoot = repoRootFromCawsDir(cawsDir);
  const registryPath = registryRelPath(cawsDir, repoRoot);
  const paths: string[] = [registryPath];
  if (specId !== null) {
    paths.push(specRelPath(cawsDir, specId, repoRoot));
  }
  const verbForAction: Record<typeof action, string> = {
    created: 'bind',
    bound: 'bind',
    destroyed: 'destroy',
    merged: 'close',
    untracked: 'untrack',
  };
  const verb = verbForAction[action];
  const specSuffix =
    specId !== null && (action === 'created' || action === 'bound')
      ? ` to ${specId}`
      : '';
  const message =
    action === 'merged' && specId !== null
      ? `chore(caws): close ${specId} post-merge of ${name}`
      : `chore(caws): ${verb} ${name}${specSuffix}`;
  return autoCommit({
    repoRoot,
    paths,
    message,
    wasDirtyBeforeWrite: preState.registryWasDirty || preState.specWasDirty,
  });
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

// Clean-tree gate for destroy/merge. Verified CAWS artifact links —
// untracked symlinks back to the canonical counterpart (see
// worktree-artifacts.ts) — are CAWS-created conveniences, not work
// product: a legacy link created before the live-symlink ignore
// verification shows up as `?? <path>` even though no agent work is at
// risk, and must not refuse the governed exit paths
// (CAWS-WORKTREE-ARTIFACT-LINK-SYMLINK-IGNORE-001). Anything staged,
// modified, or untracked-but-unverified is real dirt and still refuses.
// Porcelain quotes paths with special characters; a quoted path never
// matches a candidate relPath and therefore stays treated as dirt —
// fail closed.
function isWorkingTreeCleanExceptArtifactLinks(
  repoRoot: string,
  worktreePath: string
): boolean {
  const r = runGit(['status', '--porcelain'], worktreePath);
  if (!r.ok) return false;
  const lines = r.stdout.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) return true;
  if (!lines.every((l) => l.startsWith('?? '))) return false;
  const links = new Set(
    listVerifiedArtifactLinks(repoRoot, worktreePath).map((p) =>
      p.split(path.sep).join('/')
    )
  );
  return lines.every((l) => links.has(l.slice(3)));
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

/** Remove `worktree:` from a spec by deleting the entire top-level
 *  line. For destroy and other terminal-binding clearances.
 *
 *  Per WORKTREE-MERGE-CLEARS-SPEC-BINDING-001 invariant 1 (byte-level):
 *    After this patch, `grep '^worktree:' <spec>.yaml` MUST return no
 *    match. An empty-scalar `worktree: ''` end state was the legacy
 *    behavior and is no longer acceptable — it preserved the same
 *    drift surface that this slice closes.
 *
 *  No-op when the field is absent (backward-compat with specs that
 *  never had a binding). */
function patchSpecClearWorktree(source: string): Result<string> {
  return removeTopLevelScalar(source, 'worktree');
}

function nonActiveSpecBindingError(specId: string, lifecycleState: string): Result<never> {
  const isDraft = lifecycleState === 'draft';
  const nextCommand = `caws specs activate ${specId}`;
  const handoff = isDraft
    ? `\n\nNext: ${nextCommand}\n` +
      'Activation runs the draft spec preflight and only proceeds when the spec is complete. ' +
      'After activation succeeds, re-run the worktree create/bind command.'
    : '';
  return err(
    storeDiagnostic(
      STORE_RULES.LIFECYCLE_PLAN_REJECTED,
      `Spec "${specId}" is in lifecycle_state "${lifecycleState}"; only active specs can be bound to a worktree.` +
        handoff,
      {
        subject: specId,
        data: {
          lifecycle_state: lifecycleState,
          ...(isDraft ? { next_command: nextCommand } : {}),
        },
      }
    )
  );
}

// ─── createWorktree ──────────────────────────────────────────────────────

export function createWorktree(
  cawsDir: string,
  input: CreateWorktreeInput
): Result<WorktreeWriterOutcome> {
  // ─ Pre-flight validation (no git, no file writes) ─

  // CAWS-FIRST-CONTACT-UX-001 Fix 5: capture dirty state BEFORE any
  // writer mutation lands, so the auto-commit step can distinguish
  // "writer made the only change" from "writer's change on top of
  // someone else's uncommitted change".
  const preState = capturePreWriteState(cawsDir, input.specId);

  const nameValidation = validateWorktreeName(input.name);
  if (!nameValidation.ok) return nameValidation;
  const specValidation = validateSpecId(input.specId);
  if (!specValidation.ok) return specValidation;

  const specInfo = loadSpecOrError(cawsDir, input.specId);
  if (!isOk(specInfo)) return err(specInfo.errors);
  if (specInfo.value.lifecycleState !== 'active') {
    return nonActiveSpecBindingError(input.specId, specInfo.value.lifecycleState);
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
  //
  // Three-step sequence enforcing the control-plane-state-authority
  // contract (WORKTREE-SPEC-AUTHORITY-CONTROL-PLANE-001 A1):
  //
  //   1. `git worktree add --no-checkout` — register the linked
  //      worktree without materializing any tracked files.
  //   2. `configureWorktreeSparseCheckout(wtPath)` — install non-cone
  //      sparse-checkout patterns that include everything EXCEPT
  //      `.caws/specs/` so the .caws/specs/ tree is never written
  //      to the worktree filesystem.
  //   3. `git checkout` (inside the helper) — materialize the
  //      included files.
  //
  // Net effect: the worktree carries the full source tree (so
  // cross-module imports work) but does NOT carry an editable
  // .caws/specs/<id>.yaml — preventing the v10.2 split-brain
  // authority class where authority decisions could read divergent
  // worktree-local copies.

  const gitResult = runGit(
    ['worktree', 'add', '--no-checkout', '-b', branch, wtPath, baseBranch],
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

  // Configure sparse-checkout to exclude .caws/specs/ from the worktree.
  // Failure here triggers compensation: `git worktree remove --force`
  // tears down the linked worktree (registered by the previous step)
  // and its associated sparse-checkout state under
  // `.git/worktrees/<name>/info/sparse-checkout`. The control-plane
  // .caws/ directory is unchanged.
  const sparseResult = configureWorktreeSparseCheckout(wtPath);
  if (!sparseResult.ok) {
    rollbackGitWorktree(repoRoot, wtPath);
    return err(
      storeDiagnostic(
        STORE_RULES.LIFECYCLE_PLAN_REJECTED,
        `git sparse-checkout configuration failed (step: ${sparseResult.step}): ${sparseResult.reason}`,
        {
          subject: input.name,
          data: {
            git_stderr: sparseResult.reason,
            sparse_checkout_step: sparseResult.step,
          },
        }
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
  const artifactLinks = linkWorktreeArtifacts(repoRoot, wtPath);
  const autoCommitOutcome = autoCommitTransition(
    cawsDir,
    input.specId,
    input.name,
    'created',
    preState
  );
  return ok({
    kind: 'success',
    name: input.name,
    action: 'created',
    data: {
      branch,
      base_branch: baseBranch,
      path: wtPath,
      spec_id: input.specId,
      artifact_links: artifactLinks,
      audit_commit: autoCommitOutcome,
    },
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
  // CAWS-FIRST-CONTACT-UX-001 Fix 5: capture dirty state for autocommit.
  const preState = capturePreWriteState(cawsDir, input.specId);

  const nameValidation = validateWorktreeName(input.name);
  if (!nameValidation.ok) return nameValidation;
  const specValidation = validateSpecId(input.specId);
  if (!specValidation.ok) return specValidation;

  const specInfo = loadSpecOrError(cawsDir, input.specId);
  if (!isOk(specInfo)) return err(specInfo.errors);
  if (specInfo.value.lifecycleState !== 'active') {
    return nonActiveSpecBindingError(input.specId, specInfo.value.lifecycleState);
  }

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

  // WORKTREE-ISOLATION-HARDENING-001 Fix 4: foreign-owner guard (decoupled from
  // liveness). bind previously stamped owner unconditionally — D2: a foreign
  // session could silently steal a worktree by re-binding it. Now, if the entry
  // has an owner that does NOT admit the caller (admitsOwner over
  // sessionCandidates, exactly as destroy/merge do), the bind REFUSES unless an
  // explicit --steal --reason "<non-empty>" is supplied. This keys ONLY on
  // "owner exists and does not admit the caller" — it does NOT consult owner
  // freshness/liveness (the PID/liveness split is a separate campaign).
  let didSteal = false;
  const priorOwner = existingEntry.owner;
  if (priorOwner !== undefined) {
    const matched = admitsOwner(input.sessionCandidates, priorOwner.session_id);
    if (matched === null) {
      // Foreign owner. Only an explicit, reasoned steal proceeds.
      const reason = (input.stealReason ?? '').trim();
      if (input.steal !== true || reason.length === 0) {
        return err(
          storeDiagnostic(
            STORE_RULES.LIFECYCLE_PLAN_REJECTED,
            `Worktree "${input.name}" is owned by a different session (${priorOwner.session_id}). ` +
              `bind refuses to silently re-own it. To take ownership deliberately, re-run with ` +
              `--steal --reason "<why>" (a non-empty reason is required and is recorded in the audit log).\n\n` +
              `Session-resolution trace (no candidate matched the registered owner):\n${describeCandidateTrace(input.sessionCandidates)}`,
            { subject: input.name }
          )
        );
      }
      didSteal = true;
    }
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

    const events: EventBody[] = [event];

    // WORKTREE-ISOLATION-HARDENING-001 Fix 4: a forced steal appends a
    // first-class, queryable audit event recording the forced ownership
    // transfer (prior owner, new owner, reason). This is the auditability the
    // functional requirement asks for — distinct from claim --takeover's
    // prior_owners registry array.
    if (didSteal && priorOwner !== undefined) {
      const seizeData: Record<string, unknown> = {
        worktree_name: input.name,
        prior_owner_session_id: priorOwner.session_id,
        new_owner_session_id: input.session.session_id,
        reason: (input.stealReason ?? '').trim(),
      };
      if (priorOwner.platform !== undefined) {
        seizeData.prior_owner_platform = priorOwner.platform;
      }
      events.push({
        event: 'worktree_ownership_seized',
        ts: now,
        actor: input.actor,
        spec_id: input.specId,
        data: seizeData,
      } as unknown as EventBody);
    }

    return runLifecycleTransaction({
      cawsDir,
      plannedWrites: [{ path: specInfo.value.path, contents: newSpecBytes.value }],
      events,
    });
  });

  if (!txnOutcome.ok) return err(txnOutcome.errors);
  if (txnOutcome.value.kind !== 'success') {
    return ok({ kind: 'partial_failure_recovered', cause: txnOutcome.value.cause });
  }
  const autoCommitOutcome = autoCommitTransition(
    cawsDir,
    input.specId,
    input.name,
    'bound',
    preState
  );
  return ok({
    kind: 'success',
    name: input.name,
    action: 'bound',
    data: { audit_commit: autoCommitOutcome },
  });
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
  // CAWS-FIRST-CONTACT-UX-001 Fix 5: capture pre-write state once we
  // know the bound spec (entry may have no specId for legacy entries).
  const preStateSpecId: string | null =
    entry !== undefined && entry.specId !== undefined ? entry.specId : null;
  const preState = capturePreWriteState(cawsDir, preStateSpecId);

  if (entry === undefined) {
    return err(
      storeDiagnostic(
        STORE_RULES.LIFECYCLE_PLAN_REJECTED,
        `Worktree "${input.name}" not found in registry.`,
        { subject: input.name }
      )
    );
  }

  // Ownership check: admit if ANY identity the invoker can speak for
  // matches the registered owner (CAWS-WORKTREE-DESTROY-SESSION-
  // RESOLUTION-001). The candidate set is built by the caller via
  // resolveSessionCandidates() and is INSENSITIVE to cwd, so a destroy
  // issued from canonical after a `claim --takeover` from inside the
  // worktree finds the worktree-keyed capsule among the candidates and
  // succeeds. A genuinely-foreign session has no candidate that matches
  // entry.owner.session_id, so the refusal still fires.
  if (entry.owner !== undefined) {
    const matched = admitsOwner(input.sessionCandidates, entry.owner.session_id);
    if (matched === null) {
      return err(
        storeDiagnostic(
          STORE_RULES.LIFECYCLE_PLAN_REJECTED,
          `Worktree "${input.name}" is owned by a different session (${entry.owner.session_id}). Run 'caws claim ${input.name} --takeover' first if you need to take ownership.\n\nSession-resolution trace (no candidate matched the registered owner):\n${describeCandidateTrace(input.sessionCandidates)}`,
          { subject: input.name }
        )
      );
    }
  }

  // Dirty-tree check. Verified artifact links are exempt — destroy
  // removes them itself just before `git worktree remove`.
  const repoRoot = repoRootFromCawsDir(cawsDir);
  const wtPath = entry.path ?? worktreePathFor(cawsDir, input.name);
  if (fs.existsSync(wtPath) && !isWorkingTreeCleanExceptArtifactLinks(repoRoot, wtPath)) {
    return err(
      storeDiagnostic(
        STORE_RULES.LIFECYCLE_PLAN_REJECTED,
        `Worktree "${input.name}" has uncommitted changes. Commit or stash before destroying.`,
        { subject: input.name }
      )
    );
  }

  // Unmerged-branch check (skipped when --abandon-unmerged is passed).
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

  // Run git worktree remove. Never rm -rf. Verified artifact links are
  // unlinked first: a legacy link that is not git-ignored would make
  // `git worktree remove` refuse on an untracked file CAWS itself created.
  let removedGitWorktree = false;
  if (fs.existsSync(wtPath)) {
    removeWorktreeArtifactLinks(repoRoot, wtPath);
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
  const autoCommitOutcome = autoCommitTransition(
    cawsDir,
    preStateSpecId,
    input.name,
    'destroyed',
    preState
  );
  return ok({
    kind: 'success',
    name: input.name,
    action: 'destroyed',
    data: {
      removed_git_worktree: removedGitWorktree,
      audit_commit: autoCommitOutcome,
    },
  });
}

// ─── pruneWorktree (PRUNE-REPAIR-WORKTREE-001) ───────────────────────────
//
// H1 ghost-registry repair: remove a stale worktrees.json entry whose backing
// git/canonical worktree dir is ALREADY absent. Unlike destroyWorktree, this
// performs NO git operation — the dir being gone is the H1 precondition the
// caller (the repair command) confirmed via doctor evidence. The writer trusts
// that classification; it does not re-derive it (the §1.4 matrix is authority).
// Mutation surface: the registry entry (+ a bound spec's worktree: field if one
// is present) and one honest worktree_pruned audit event, all transactional.

export interface PruneWorktreeInput {
  readonly name: string;
  readonly session: SessionIdentity;
  readonly sessionCandidates: SessionCandidates;
  readonly actor: EventBody['actor'];
  /** Human-readable authority reason recorded on the worktree_pruned event. */
  readonly reason: string;
  readonly now?: () => Date;
  readonly dryRun?: boolean;
}

export function pruneWorktree(
  cawsDir: string,
  input: PruneWorktreeInput
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
        `Worktree "${input.name}" not found in registry; nothing to prune.`,
        { subject: input.name }
      )
    );
  }

  // Foreign-ownership refusal (same semantic as destroy): admit only if a
  // candidate matches the registered owner, else require --takeover.
  if (entry.owner !== undefined) {
    const matched = admitsOwner(input.sessionCandidates, entry.owner.session_id);
    if (matched === null) {
      return err(
        storeDiagnostic(
          STORE_RULES.LIFECYCLE_PLAN_REJECTED,
          `Worktree "${input.name}" is owned by a different session (${entry.owner.session_id}). Run 'caws claim ${input.name} --takeover' first if you need to take ownership.`,
          { subject: input.name }
        )
      );
    }
  }

  // Plan: clear the bound spec's worktree: field (if any) so the prune does not
  // leave a one-sided spec->registry binding behind.
  const plannedWrites: { path: string; contents: string }[] = [];
  if (entry.specId !== undefined) {
    const specInfo = loadSpecOrError(cawsDir, entry.specId);
    if (isOk(specInfo)) {
      const newSpecBytes = patchSpecClearWorktree(specInfo.value.source);
      if (isOk(newSpecBytes) && newSpecBytes.value !== specInfo.value.source) {
        plannedWrites.push({ path: specInfo.value.path, contents: newSpecBytes.value });
      }
    }
  }

  if (input.dryRun === true) {
    const findings = [
      `H1 ghost_registry: remove registry entry "${input.name}"`,
      ...(plannedWrites.length > 0 ? [`clear worktree: field on spec ${entry.specId}`] : []),
      `append worktree_pruned (h_class: ghost_registry)`,
    ];
    return ok({ kind: 'dry_run', name: input.name, canProceed: true, findings });
  }

  const now = (input.now ?? (() => new Date()))().toISOString();
  const eventData: Record<string, unknown> = {
    worktree_name: input.name,
    h_class: 'ghost_registry',
    reason: input.reason,
  };
  if (entry.specId !== undefined) eventData.spec_id = entry.specId;

  const event: EventBody = {
    event: 'worktree_pruned',
    ts: now,
    actor: input.actor,
    ...(entry.specId !== undefined ? { spec_id: entry.specId } : {}),
    data: eventData,
  } as unknown as EventBody;

  const txnOutcome = withLifecycleLock(cawsDir, () => {
    // Remove the stale registry entry (no git touch — the dir is already gone).
    rollbackRegistryEntry(cawsDir, input.name);
    return runLifecycleTransaction({ cawsDir, plannedWrites, events: [event] });
  });

  if (!txnOutcome.ok) return err(txnOutcome.errors);
  if (txnOutcome.value.kind !== 'success') {
    return ok({ kind: 'partial_failure_recovered', cause: txnOutcome.value.cause });
  }
  return ok({
    kind: 'success',
    name: input.name,
    action: 'pruned',
    data: { h_class: 'ghost_registry', cleared_spec_binding: plannedWrites.length > 0 },
  });
}

// ─── untrackWorktree (UX-WORKTREE-UNTRACK-001) ───────────────────────────
//
// Operator-requested control-plane release for the job "remove this CAWS
// registry binding but keep the physical git worktree directory available for
// inspection." This is deliberately NOT destroy: it never invokes git
// worktree remove and never deletes files. It is also not prune: the physical
// directory must exist and be clean so the operator can inspect it after CAWS
// stops tracking it.

export function untrackWorktree(
  cawsDir: string,
  input: UntrackWorktreeInput
): Result<WorktreeWriterOutcome> {
  const nameValidation = validateWorktreeName(input.name);
  if (!nameValidation.ok) return nameValidation;

  const reason = input.reason.trim();
  if (reason.length === 0) {
    return err(
      storeDiagnostic(
        STORE_RULES.LIFECYCLE_PLAN_REJECTED,
        `caws worktree untrack requires a non-empty --reason.`,
        { subject: input.name }
      )
    );
  }

  const registry = loadWorktrees(cawsDir);
  if (!isOk(registry)) return err(registry.errors);
  const entry = registry.value[input.name];
  if (entry === undefined) {
    return err(
      storeDiagnostic(
        STORE_RULES.LIFECYCLE_PLAN_REJECTED,
        `Worktree "${input.name}" not found in registry; nothing to untrack.`,
        { subject: input.name }
      )
    );
  }

  if (entry.owner !== undefined) {
    const matched = admitsOwner(input.sessionCandidates, entry.owner.session_id);
    if (matched === null) {
      return err(
        storeDiagnostic(
          STORE_RULES.LIFECYCLE_PLAN_REJECTED,
          `Worktree "${input.name}" is owned by a different session (${entry.owner.session_id}); untrack refuses to release another agent's binding.\n\n` +
            `Session-resolution trace (no candidate matched the registered owner):\n${describeCandidateTrace(input.sessionCandidates)}`,
          { subject: input.name }
        )
      );
    }
  }

  const repoRoot = repoRootFromCawsDir(cawsDir);
  const wtPath = worktreePathFor(cawsDir, input.name);
  if (!fs.existsSync(wtPath) || !fs.statSync(wtPath).isDirectory()) {
    return err(
      storeDiagnostic(
        STORE_RULES.LIFECYCLE_PLAN_REJECTED,
        `Worktree "${input.name}" has no physical directory at ${wtPath}; use caws worktree prune/repair for control-plane residue instead.`,
        { subject: input.name, data: { path: wtPath } }
      )
    );
  }

  if (!isWorkingTreeCleanExceptArtifactLinks(repoRoot, wtPath)) {
    return err(
      storeDiagnostic(
        STORE_RULES.LIFECYCLE_PLAN_REJECTED,
        `Worktree "${input.name}" is not clean; untrack preserves files and refuses dirty checkouts.`,
        { subject: input.name, data: { path: wtPath } }
      )
    );
  }

  const specId = entry.specId;
  const preState = capturePreWriteState(cawsDir, specId ?? null);
  const plannedWrites: { path: string; contents: string }[] = [];
  let clearsSpecBinding = false;

  if (specId !== undefined) {
    const specInfo = loadSpecOrError(cawsDir, specId);
    if (!isOk(specInfo)) return err(specInfo.errors);
    const currentWorktree = specInfo.value.currentWorktree;
    if (
      currentWorktree !== undefined &&
      currentWorktree.length > 0 &&
      currentWorktree !== input.name
    ) {
      return err(
        storeDiagnostic(
          STORE_RULES.LIFECYCLE_PLAN_REJECTED,
          `Spec "${specId}" is bound to worktree "${currentWorktree}", not "${input.name}"; refusing to clear unrelated spec state.`,
          { subject: specId, data: { worktree_name: input.name, current_worktree: currentWorktree } }
        )
      );
    }
    if (currentWorktree === input.name) {
      const newSpecBytes = patchSpecClearWorktree(specInfo.value.source);
      if (!isOk(newSpecBytes)) return err(newSpecBytes.errors);
      if (newSpecBytes.value !== specInfo.value.source) {
        plannedWrites.push({ path: specInfo.value.path, contents: newSpecBytes.value });
        clearsSpecBinding = true;
      }
    }
  }

  if (input.dryRun === true) {
    return ok({
      kind: 'dry_run',
      name: input.name,
      canProceed: true,
      findings: [
        `remove registry entry "${input.name}"`,
        ...(clearsSpecBinding && specId !== undefined
          ? [`clear worktree: field on spec ${specId}`]
          : []),
        `append worktree_untracked`,
        `preserve physical directory ${wtPath}`,
      ],
    });
  }

  const now = (input.now ?? (() => new Date()))().toISOString();
  const eventData: Record<string, unknown> = {
    worktree_name: input.name,
    reason,
    path: wtPath,
    cleared_spec_binding: clearsSpecBinding,
  };
  if (specId !== undefined) eventData.spec_id = specId;
  if (entry.owner !== undefined) eventData.owner_session_id = entry.owner.session_id;

  const event: EventBody = {
    event: 'worktree_untracked',
    ts: now,
    actor: input.actor,
    ...(specId !== undefined ? { spec_id: specId } : {}),
    data: eventData,
  } as unknown as EventBody;

  const txnOutcome = withLifecycleLock(cawsDir, () => {
    rollbackRegistryEntry(cawsDir, input.name);
    return runLifecycleTransaction({ cawsDir, plannedWrites, events: [event] });
  });

  if (!txnOutcome.ok) return err(txnOutcome.errors);
  if (txnOutcome.value.kind !== 'success') {
    return ok({ kind: 'partial_failure_recovered', cause: txnOutcome.value.cause });
  }

  const autoCommitOutcome = autoCommitTransition(
    cawsDir,
    specId ?? null,
    input.name,
    'untracked',
    preState
  );
  return ok({
    kind: 'success',
    name: input.name,
    action: 'untracked',
    data: {
      path: wtPath,
      spec_id: specId,
      cleared_spec_binding: clearsSpecBinding,
      preserved_physical_directory: true,
      audit_commit: autoCommitOutcome,
    },
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
  // CAWS-FIRST-CONTACT-UX-001 Fix 5: capture pre-write state for the
  // post-merge auto-commit step.
  const preStateSpecId: string | null =
    entry !== undefined && entry.specId !== undefined ? entry.specId : null;
  const preState = capturePreWriteState(cawsDir, preStateSpecId);

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
  // Ownership: same multi-candidate admission semantic as destroyWorktree.
  // Merge is structurally an ownership-comparison surface — the invoker
  // must be the registered owner. See CAWS-WORKTREE-DESTROY-SESSION-
  // RESOLUTION-001 closure_notes Option E for the why.
  if (entry.owner !== undefined) {
    const matched = admitsOwner(input.sessionCandidates, entry.owner.session_id);
    if (matched === null) {
      findings.push(
        `worktree is owned by a different session (${entry.owner.session_id})`
      );
    }
  }
  const wtPath = entry.path ?? worktreePathFor(cawsDir, input.name);
  // Verified artifact links are exempt from the dirty finding. Merge
  // never removes them — the worktree keeps working links until destroy
  // — so this holds for --dry-run too (no mutation).
  if (
    fs.existsSync(wtPath) &&
    !isWorkingTreeCleanExceptArtifactLinks(repoRootFromCawsDir(cawsDir), wtPath)
  ) {
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
    // CAWS-CLI-MERGE-AUTOCLOSE-PRESERVE-CLOSURE-NOTES-001: the `reason`
    // above is a machine-generated stub. Insert-only mode keeps it from
    // clobbering closure_notes an author wrote on the bound spec — the
    // stub fills closure_notes only when the spec carried none.
    preserveExistingNotes: true,
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

  // WORKTREE-MERGE-CLEARS-SPEC-BINDING-001 invariant 2 (honest completion):
  // isOk(closeResult) is not enough — closeSpec wraps both `success` and
  // `partial_failure_recovered` in `ok()`. Only `success` means the closed
  // bytes actually landed on disk. If close transaction rolled back, the
  // spec remains active and mergeWorktree must NOT continue to append
  // worktree_merged or destroy the worktree.
  if (closeResult.value.kind !== 'success') {
    return err(
      storeDiagnostic(
        STORE_RULES.LIFECYCLE_PARTIAL_FAILURE_UNRECOVERED,
        `Merge succeeded (commit ${mergeCommit}) but spec close transaction rolled back; the bound spec remains active. Worktree has NOT been destroyed.`,
        {
          subject: input.name,
          data: {
            merge_commit: mergeCommit,
            spec_id: specId,
            close_outcome_kind: closeResult.value.kind,
            close_cause: closeResult.value.kind === 'partial_failure_recovered' ? closeResult.value.cause : undefined,
            recovery_instruction: `Manually run: caws specs close ${specId} --resolution completed --merge-commit ${mergeCommit}; then: caws worktree destroy ${input.name}`,
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
    sessionCandidates: input.sessionCandidates,
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

  const autoCommitOutcome = autoCommitTransition(
    cawsDir,
    preStateSpecId,
    input.name,
    'merged',
    preState
  );
  return ok({
    kind: 'success',
    name: input.name,
    action: 'merged',
    data: {
      merge_commit: mergeCommit,
      spec_id: specId,
      auto_closed_spec: true,
      audit_commit: autoCommitOutcome,
    },
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
