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
  WORKTREE_NAME_REGEX,
} from '../kernel';

import { applyRegistryPatch } from './apply-patch';
import { autoCommit, isPathDirty, isGovernedStatePath, type AutoCommitOutcome } from './git-autocommit';
import { configureWorktreeSparseCheckout } from './git-sparse-checkout';
import {
  linkWorktreeArtifacts,
  listVerifiedArtifactLinks,
  removeWorktreeArtifactLinks,
} from './worktree-artifacts';
import { closeSpec, type SpecWriterOutcome } from './specs-writer';
import { loadSpecs } from './specs-store';
import { loadWorktrees } from './worktrees-store';
import { runLifecycleTransaction } from './lifecycle-transaction';
import { withLifecycleLock } from './lifecycle-lock';
import {
  admitsOwner,
  describeCandidateTrace,
} from '../shell/session/resolve-session';
import type { SessionCandidates } from '../shell/session/types';
import { repoRootFromCawsDir, runGit, storeDiagnostic, validateSpecId } from './repo-root';
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
  /**
   * The caller process's current working directory, captured once at CLI
   * invocation. When set, destroyWorktree refuses if it is the target
   * worktree path or a descendant of it — destroying a worktree you are
   * sitting inside removes the ground under the caller's shell, leaving
   * every subsequent process spawn failing ENOENT.
   * (CAWS-FIX-WORKTREE-MERGE-CWD-SELF-DESTRUCT-GUARD-001.)
   */
  readonly callerCwd?: string;
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
  /**
   * Optional closure notes authored by the operator and supplied at merge
   * time (CAWS-FEAT-WORKTREE-MERGE-CLOSURE-NOTES-FLAG-01). When present,
   * this replaces the machine stub as the `reason` passed to closeSpec on
   * the auto-close path. `preserveExistingNotes` stays true, so pre-written
   * YAML closure_notes still win; this field wins only over an ABSENT field.
   * Not consumed on --dry-run (the writer returns before closeSpec) and not
   * applied on the already-closed fast path (closeSpec is skipped — the
   * shell layer warns).
   */
  readonly closureNotes?: string;
  /**
   * The caller process's current working directory, captured once at CLI
   * invocation. When set and this is NOT a dry run, mergeWorktree refuses
   * if the cwd is the target worktree path or a descendant of it — the
   * merge's destroy step removes that directory, which would delete the
   * ground under the caller's shell. See DestroyWorktreeInput.callerCwd.
   * (CAWS-FIX-WORKTREE-MERGE-CWD-SELF-DESTRUCT-GUARD-001.)
   */
  readonly callerCwd?: string;
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
      readonly data?: Record<string, unknown>;
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

/**
 * Resolve a path through realpath when possible, resolving the longest
 * existing ancestor and appending the (possibly non-existent) remainder
 * when the full path does not exist. realpath collapses symlinks and
 * relative segments, so a cwd reached via a symlink or `.`/`..` still
 * trips the self-destruct guard.
 *
 * The longest-ancestor fallback is load-bearing on platforms whose tmp
 * root is a symlink (macOS: /var → /private/var): a non-existent
 * descendant (e.g. a cwd nested under a freshly-created worktree whose
 * deeper dirs are sparse) would otherwise fall back to the literal
 * /var/... form while an existing worktree path resolves to
 * /private/var/..., and the prefix-containment check would silently
 * miss the match. Resolving through the longest existing ancestor keeps
 * both sides in the same (realpath) namespace.
 * (CAWS-FIX-WORKTREE-MERGE-CWD-SELF-DESTRUCT-GUARD-001.)
 */
function realpathOrLiteral(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    // Walk up to the longest existing ancestor, realpath THAT, then
    // re-append the non-existent tail. If nothing exists (absurd for a
    // caller cwd), fall back to the literal path.
    let dir = p;
    const tail: string[] = [];
    while (dir !== path.dirname(dir)) {
      try {
        const real = fs.realpathSync(dir);
        return tail.length === 0 ? real : path.join(real, ...tail.reverse());
      } catch {
        tail.push(path.basename(dir));
        dir = path.dirname(dir);
      }
    }
    return p;
  }
}

/**
 * True when `callerCwd` is `wtPath` itself or a descendant of it. Both
 * paths are realpath-resolved first so symlinks and relative segments
 * cannot hide the containment. A trailing separator is added to `wtPath`
 * for the descendant test so `/foo/wt-bar` does not match `/foo/wt-barbaz`.
 * (CAWS-FIX-WORKTREE-MERGE-CWD-SELF-DESTRUCT-GUARD-001.)
 */
function isCwdInsideWorktree(callerCwd: string, wtPath: string): boolean {
  const cwdReal = realpathOrLiteral(callerCwd);
  const wtReal = realpathOrLiteral(wtPath);
  if (cwdReal === wtReal) return true;
  const wtRealWithSep = wtReal.endsWith(path.sep) ? wtReal : wtReal + path.sep;
  return cwdReal.startsWith(wtRealWithSep);
}

/**
 * Build the LIFECYCLE_PLAN_REJECTED diagnostic for the self-destruct guard.
 * Names the worktree and the cd-out remediation. Shared by destroy and merge
 * since both run a teardown that deletes the worktree directory.
 */
function cwdSelfDestructRefusal(name: string, wtPath: string): Diagnostic {
  return storeDiagnostic(
    STORE_RULES.LIFECYCLE_PLAN_REJECTED,
    `Refusing to destroy worktree "${name}" while the current directory is inside it (${wtPath}). ` +
      `The teardown deletes that directory, which would invalidate the shell's cwd and leave every subsequent command unable to spawn. ` +
      `Change directory out of the worktree first, then retry from the repository root: ` +
      `cd <repo-root> && caws worktree merge ${name} (or caws worktree destroy ${name}).`,
    { subject: name }
  );
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
// (CAWS-REFACTOR-SHARED-UTILS-001) runGit consolidated into store/repo-root.ts.

function getCurrentBranch(repoRoot: string): string | null {
  const r = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot);
  if (!r.ok) return null;
  return r.stdout.trim();
}

function mergeRecoveryNextCommands(
  name: string,
  entry:
    | {
        readonly branch?: string;
        readonly baseBranch?: string;
        readonly path?: string;
      }
    | undefined
): string[] {
  const commands = [
    `caws worktree merge ${name} --dry-run --data`,
    'caws worktree list --data',
    `caws worktree cleanup-plan --include ${name} --json`,
  ];
  if (entry?.branch !== undefined && entry.baseBranch !== undefined) {
    commands.push(`git rev-list --left-right --count ${entry.baseBranch}...${entry.branch}`);
    commands.push(`git merge-tree --write-tree ${entry.baseBranch} ${entry.branch}`);
  }
  if (entry?.path !== undefined) {
    commands.push(`git -C ${entry.path} status --short`);
  }
  return commands;
}

function mergeRepairHint(
  name: string,
  entry:
    | {
        readonly branch?: string;
        readonly baseBranch?: string;
        readonly path?: string;
      }
    | undefined
): string {
  return `Run ${mergeRecoveryNextCommands(name, entry).map((command) => `\`${command}\``).join('; ')}.`;
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
// (CAWS-REFACTOR-SHARED-UTILS-001) SPEC_ID_REGEX + WORKTREE_NAME_REGEX are
// now shared from the kernel; validateSpecId is shared from store/repo-root.

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
        {
          subject: input.name,
          narrowRepair:
            `Confirm registered names with \`caws worktree list\`. ` +
            `If this is closed or ghost residue, run \`caws worktree prune --include ${input.name}\` first. ` +
            `If a physical git worktree may still exist outside the registry, run \`caws worktree cleanup-plan --include ${input.name}\`.`,
        }
      )
    );
  }

  // CAWS-FIX-WORKTREE-MERGE-CWD-SELF-DESTRUCT-GUARD-001: refuse to
  // destroy a worktree the caller's shell is sitting inside. destroy's
  // final step deletes the worktree directory; running it from a cwd
  // under that directory removes the ground under the caller, leaving
  // every subsequent process spawn failing ENOENT. Placed before
  // ownership/teardown checks so the operator's first remediation (cd
  // out) is the one surfaced. Skipped when callerCwd is not provided
  // (e.g. non-CLI callers with no shell cwd to invalidate).
  if (input.callerCwd !== undefined) {
    const wtPathEarly = entry.path ?? worktreePathFor(cawsDir, input.name);
    if (isCwdInsideWorktree(input.callerCwd, wtPathEarly)) {
      return err([cwdSelfDestructRefusal(input.name, wtPathEarly)]);
    }
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
          `Worktree "${input.name}" is owned by a different session (${entry.owner.session_id}). To take ownership, cd into the worktree first — 'caws claim' reads the current directory and takes no worktree-name argument: cd .caws/worktrees/${input.name} && caws claim --takeover\n\nSession-resolution trace (no candidate matched the registered owner):\n${describeCandidateTrace(input.sessionCandidates)}`,
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
        `Branch "${entry.branch}" is not merged into "${entry.baseBranch}". If this is intentional, retry with: caws worktree destroy ${input.name} --abandon-unmerged`,
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
          `Worktree "${input.name}" is owned by a different session (${entry.owner.session_id}). To take ownership, cd into the worktree first — 'caws claim' reads the current directory and takes no worktree-name argument: cd .caws/worktrees/${input.name} && caws claim --takeover`,
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

// ─── Lane provenance (CAWS-PREPUSH-PROVENANCE-REWORK-001) ────────────────
//
// MERGE IS THE SINGLE GOVERNED LANDING DOOR: every commit a lane lands on
// the base branch must belong to the lane. Verified here, BEFORE the CAS
// sequence — a refusal writes nothing (no ref updates, no events, no
// registry/spec mutation; unreferenced objects are GC-able garbage).
//
// Attribution is SCOPE-based, never session-based: the lane is the
// authority unit, so an authorized takeover (prior_owners) does not affect
// the verdict. Governed-state paths (.caws/specs/** etc. — the CLI's own
// bookkeeping commits ride the lane branch) are always in-lane.

// normalizeRel/scopeEntryMatches are an intentional THIRD copy of the
// scope.in admission rule (canonical: shell/binding/resolve-binding.ts,
// module-private; second copy: shell/push-range/scope-match.ts). The store
// layer cannot import from shell, and the codebase precedent (see
// scope-match.ts's header) is a small local copy over a cross-layer
// import. INVARIANT: if the canonical matching rule changes, update ALL
// copies — exact match, directory-prefix on a path boundary, or anchored
// `*`/`?` glob.
function normalizeRel(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

function scopeEntryMatches(entry: string, target: string): boolean {
  const e = normalizeRel(entry);
  const t = normalizeRel(target);
  if (e === t) return true;
  if (!/[*?]/.test(e)) {
    return t.startsWith(e + '/');
  }
  const rx = e
    .split('')
    .map((ch) => {
      if (ch === '*') return '.*';
      if (ch === '?') return '.';
      return ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    })
    .join('');
  return new RegExp(`^${rx}$`).test(t);
}

/** One lane commit touching paths outside the lane's scope. */
interface LaneForeignCommit {
  readonly sha: string;
  readonly outOfScopePaths: readonly string[];
  /** Other ACTIVE specs whose scope.in admits the out-of-scope paths —
   *  the lanes the commit might actually belong to (remediation hint). */
  readonly candidateSpecIds: readonly string[];
}

interface LaneProvenanceResult {
  readonly foreignCommits: readonly LaneForeignCommit[];
  /** Set when the verification itself could not run (git failure). A
   *  merge must not proceed unverified — the caller refuses. */
  readonly verificationFailure?: string;
}

/**
 * Verify every commit on `<baseBranch>..<branch>` belongs to the lane
 * bound to `specId`: each touched path must match the spec's scope.in or
 * be governed operational state (isGovernedStatePath). Merge commits on
 * the lane branch yield an empty diff-tree file set and pass vacuously.
 * Pure reads; never mutates.
 */
function verifyLaneProvenance(
  cawsDir: string,
  repoRoot: string,
  baseBranch: string,
  branch: string,
  specId: string
): LaneProvenanceResult {
  const range = runGit(['rev-list', `${baseBranch}..${branch}`], repoRoot);
  if (!range.ok) {
    return {
      foreignCommits: [],
      verificationFailure: `git rev-list ${baseBranch}..${branch} failed: ${range.reason}`,
    };
  }
  const shas = range.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  if (shas.length === 0) return { foreignCommits: [] };

  const specResult = loadSpecOrError(cawsDir, specId);
  if (!isOk(specResult)) {
    return {
      foreignCommits: [],
      verificationFailure: `bound spec ${specId} could not be loaded: ${specResult.errors.map((d) => d.message).join('; ')}`,
    };
  }
  const scopeRaw = (specResult.value.spec as { scope?: { in?: unknown } })
    .scope?.in;
  const scopeIn: readonly string[] = Array.isArray(scopeRaw)
    ? scopeRaw.filter((e): e is string => typeof e === 'string')
    : [];

  // Candidate lanes for remediation: other ACTIVE specs.
  const allSpecs = loadSpecs(cawsDir);
  const candidateScopes = allSpecs.specs
    .filter((s) => s.lifecycle_state === 'active' && s.id !== specId)
    .map((s) => ({ id: s.id, scopeIn: s.scope.in }));

  const foreignCommits: LaneForeignCommit[] = [];
  for (const sha of shas) {
    const files = runGit(
      ['diff-tree', '--no-commit-id', '--name-only', '-r', sha],
      repoRoot
    );
    if (!files.ok) {
      return {
        foreignCommits: [],
        verificationFailure: `git diff-tree ${sha} failed: ${files.reason}`,
      };
    }
    const touched = files.stdout
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    const outOfScopePaths = touched.filter(
      (f) =>
        !isGovernedStatePath(f) &&
        !scopeIn.some((entry) => scopeEntryMatches(entry, f))
    );
    if (outOfScopePaths.length === 0) continue;
    const candidateSpecIds = candidateScopes
      .filter((c) =>
        outOfScopePaths.some((f) =>
          c.scopeIn.some((entry) => scopeEntryMatches(entry, f))
        )
      )
      .map((c) => c.id)
      .sort();
    foreignCommits.push({ sha, outOfScopePaths, candidateSpecIds });
  }
  return { foreignCommits };
}

// ─── mergeWorktree ───────────────────────────────────────────────────────

/** How many times a lost compare-and-swap is retried before giving up. */
const MERGE_CAS_MAX_ATTEMPTS = 5;

type MergeCasOutcome =
  | { ok: true; mergeCommit: string; baseBefore: string; attempts: number }
  | {
      ok: false;
      message: string;
      /** True when the failure is concurrent contention, not a real conflict. */
      contention: boolean;
      attempts?: number;
      repairSuffix?: string;
    };

/**
 * Merge `branch` into `baseBranch` without checking either one out.
 *
 * The three-step sequence — merge-tree, commit-tree, update-ref with an
 * expected-old SHA — is the whole concurrency story. Steps 1 and 2 write only
 * unreferenced objects, so they are invisible to every other process and safe
 * to abandon. Step 3 is the single atomic instant at which the merge becomes
 * real, and git refuses it outright if the base moved underneath us.
 *
 * Losing that race is NORMAL under multi-agent load, not an error: we re-read
 * the base and recompute. Only exhausting the retry budget, or hitting a real
 * conflict, is reported as a failure — and the two are distinguished in the
 * outcome so the caller can say which happened.
 */
function mergeViaCompareAndSwap(
  repoRoot: string,
  baseBranch: string,
  branch: string,
  message: string
): MergeCasOutcome {
  const ref = `refs/heads/${baseBranch}`;

  for (let attempt = 1; attempt <= MERGE_CAS_MAX_ATTEMPTS; attempt++) {
    // Read the base ref immediately before computing the merge. This value is
    // the CAS witness; it must never come from a cache or from the caller,
    // or a stale witness could overwrite a concurrent merge.
    const baseRead = runGit(['rev-parse', ref], repoRoot);
    if (!baseRead.ok) {
      return {
        ok: false,
        message: `git rev-parse ${ref} failed: ${baseRead.reason}`,
        contention: false,
      };
    }
    const baseBefore = baseRead.stdout.trim();

    // Compute the merged tree in the object database. No working tree, no
    // index, no HEAD — so a dirty canonical checkout cannot corrupt the
    // result and a conflict cannot strand a half-merged tree on disk.
    const treeResult = runGit(
      ['merge-tree', '--write-tree', baseBefore, branch],
      repoRoot
    );
    if (!treeResult.ok) {
      // merge-tree exits non-zero on conflict and prints the conflicted
      // paths. This is a genuine conflict, not contention: retrying cannot
      // help, and the working tree is still clean.
      return {
        ok: false,
        message:
          `Cannot merge ${branch} into ${baseBranch}: conflicting changes.\n` +
          `${treeResult.reason}`,
        contention: false,
        repairSuffix:
          'No merge was started and the working tree is untouched. Resolve by ' +
          `merging ${baseBranch} into ${branch} inside the worktree, then re-run.`,
      };
    }
    const mergedTree = treeResult.stdout.trim().split('\n')[0]?.trim() ?? '';
    if (!/^[0-9a-f]{40}$/.test(mergedTree)) {
      return {
        ok: false,
        message: `Unexpected tree SHA from git merge-tree: ${mergedTree}`,
        contention: false,
      };
    }

    // Build the merge commit. Two parents, base first, matching the shape
    // `git merge --no-ff` would have produced.
    const commitResult = runGit(
      ['commit-tree', mergedTree, '-p', baseBefore, '-p', branch, '-m', message],
      repoRoot
    );
    if (!commitResult.ok) {
      return {
        ok: false,
        message: `git commit-tree failed: ${commitResult.reason}`,
        contention: false,
      };
    }
    const mergeCommit = commitResult.stdout.trim();

    // The atomic instant. Passing baseBefore as the expected-old value makes
    // this a compare-and-swap: if another agent advanced the base since we
    // read it, git refuses and writes nothing.
    const casResult = runGit(
      ['update-ref', ref, mergeCommit, baseBefore],
      repoRoot
    );
    if (casResult.ok) {
      // The ref moved. If the CANONICAL checkout happens to have the base
      // branch checked out, its working tree and index are now stale relative
      // to the new HEAD — every merged file would show as a staged deletion
      // ("D path"), making a successful merge look like it deleted the work.
      //
      // `read-tree -u -m` fast-forwards the tree and index to match. The `-m`
      // (merge) form is deliberate over `reset --hard`: it REFUSES rather
      // than clobbers when local modifications are present, so it cannot
      // destroy uncommitted work. (The merge preconditions already require a
      // clean tree; this is defense in depth.)
      //
      // Worktrees with a different branch checked out are unaffected, which
      // is the entire point of computing the merge in the object database.
      const headRef = runGit(['symbolic-ref', '--quiet', 'HEAD'], repoRoot);
      if (headRef.ok && headRef.stdout.trim() === ref) {
        runGit(['read-tree', '-u', '-m', 'HEAD'], repoRoot);
      }
      return { ok: true, mergeCommit, baseBefore, attempts: attempt };
    }

    // Lost the race. The objects we just wrote are unreferenced and will be
    // collected; nothing was mutated. Recompute against the new base.
    const isCas =
      casResult.reason.includes('but expected') ||
      casResult.reason.includes('cannot lock ref');
    if (!isCas) {
      return {
        ok: false,
        message: `git update-ref ${ref} failed: ${casResult.reason}`,
        contention: false,
      };
    }
  }

  return {
    ok: false,
    message:
      `Could not merge into ${baseBranch}: the base branch was advanced by ` +
      `another agent on all ${MERGE_CAS_MAX_ATTEMPTS} attempts. This is ` +
      `contention, not a conflict — no state was written.`,
    contention: true,
    attempts: MERGE_CAS_MAX_ATTEMPTS,
  };
}

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
        {
          subject: input.name,
          narrowRepair: mergeRepairHint(input.name, undefined),
        }
      )
    );
  }

  // CAWS-FIX-WORKTREE-MERGE-CWD-SELF-DESTRUCT-GUARD-001: the merge's
  // final step is destroyWorktree, which deletes the worktree directory.
  // If the caller's shell cwd is inside it, the teardown removes the
  // ground under the caller and leaves every subsequent process spawn
  // failing ENOENT. Refuse BEFORE the merge commit / spec close / event
  // appends land — once mergeViaCompareAndSwap advances the base, a
  // destroy-time refusal would leave source merged but the worktree
  // alive (a half-completed merge). Exempt --dry-run: it performs no
  // teardown, so there is no directory to invalidate.
  if (input.callerCwd !== undefined && input.dryRun !== true) {
    const wtPathEarly = entry.path ?? worktreePathFor(cawsDir, input.name);
    if (isCwdInsideWorktree(input.callerCwd, wtPathEarly)) {
      return err([cwdSelfDestructRefusal(input.name, wtPathEarly)]);
    }
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

  // CAWS-PREPUSH-PROVENANCE-REWORK-001 (lane provenance teeth): every
  // commit the lane would land must belong to the lane — verified BEFORE
  // the dry-run return so a dry run reports the same verdict the real
  // merge would enforce, and BEFORE the CAS sequence so a refusal writes
  // nothing. Runs only when the binding facts exist (their absence is
  // already a finding above).
  let foreignCommits: readonly LaneForeignCommit[] = [];
  if (
    entry.specId !== undefined &&
    entry.branch !== undefined &&
    entry.baseBranch !== undefined
  ) {
    const provenance = verifyLaneProvenance(
      cawsDir,
      repoRootFromCawsDir(cawsDir),
      entry.baseBranch,
      entry.branch,
      entry.specId
    );
    if (provenance.verificationFailure !== undefined) {
      findings.push(
        `lane provenance could not be verified (${provenance.verificationFailure}) — refusing rather than merging unverified`
      );
    }
    foreignCommits = provenance.foreignCommits;
    for (const fc of foreignCommits) {
      findings.push(
        `lane branch contains commit ${fc.sha.slice(0, 12)} outside spec scope: ${fc.outOfScopePaths.join(', ')}`
      );
    }
  }

  // Dry-run: report and return without mutation.
  if (input.dryRun === true) {
    return ok({
      kind: 'dry_run',
      name: input.name,
      canProceed: findings.length === 0,
      findings,
      data: {
        read_only: true,
        dry_run: true,
        can_proceed: findings.length === 0,
        findings,
        next_commands: mergeRecoveryNextCommands(input.name, entry),
        worktree: {
          name: input.name,
          path: wtPath,
          ...(entry.branch !== undefined ? { branch: entry.branch } : {}),
          ...(entry.baseBranch !== undefined ? { base_branch: entry.baseBranch } : {}),
          ...(entry.specId !== undefined ? { spec_id: entry.specId } : {}),
        },
      },
    });
  }

  if (findings.length > 0) {
    return err(
      storeDiagnostic(
        STORE_RULES.LIFECYCLE_PLAN_REJECTED,
        `caws worktree merge ${input.name}: prerequisites unmet (${findings.join('; ')}).`,
        {
          subject: input.name,
          narrowRepair: mergeRepairHint(input.name, entry),
          data: {
            findings,
            next_commands: mergeRecoveryNextCommands(input.name, entry),
            // A2: name the offending commits, their out-of-scope paths, and
            // the lanes they might belong to (empty for non-provenance
            // refusals).
            ...(foreignCommits.length > 0
              ? {
                  foreign_commits: foreignCommits.map((fc) => ({
                    sha: fc.sha,
                    out_of_scope_paths: fc.outOfScopePaths,
                    candidate_spec_ids: fc.candidateSpecIds,
                  })),
                }
              : {}),
          },
        }
      )
    );
  }

  // Perform the merge WITHOUT checking out the base branch.
  //
  // CAWS-WORKTREE-MERGE-LOCKFREE-CAS-001. The old sequence was
  // `git checkout <base>` + `git merge --no-ff`, which mutates the canonical
  // working tree's HEAD — a resource every concurrent agent shares. Two
  // agents merging at once could interleave checkouts and merges, and
  // `git branch -d` (which evaluates reachability against HEAD) could end up
  // judging against a base it never merged into.
  //
  // Instead we compute the merge entirely in the object database and advance
  // the base ref with an atomic compare-and-swap:
  //
  //   git merge-tree --write-tree <base> <branch>   -> merged tree, no I/O
  //   git commit-tree <tree> -p <base> -p <branch>  -> merge commit object
  //   git update-ref <ref> <new> <expected-old>     -> ATOMIC CAS
  //
  // If a concurrent agent advanced the base in between, git itself refuses
  // the ref update ("is at X but expected Y") and nothing is written — we
  // simply recompute against the new base and retry. This is strictly
  // stronger than a lock: no blocking, no deadlock, no stale-lock recovery,
  // and correct even when a human or CI advances the ref. It is also
  // crash-safe by construction, since the objects written before the CAS are
  // unreferenced (and therefore invisible) until the CAS makes them
  // reachable.
  const repoRoot = repoRootFromCawsDir(cawsDir);
  const baseBranch = entry.baseBranch as string;
  const branch = entry.branch as string;
  const specId = entry.specId as string;
  const message = input.message ?? `merge(worktree): ${input.name}`;

  // A1 (CAWS-PREPUSH-PROVENANCE-REWORK-001): capture the lane tip BEFORE
  // the CAS sequence so the worktree_merged event records the lane's
  // contributed range explicitly (base_before comes from the CAS witness).
  const laneTipResult = runGit(['rev-parse', branch], repoRoot);
  const laneTip = laneTipResult.ok ? laneTipResult.stdout.trim() : undefined;

  const casOutcome = mergeViaCompareAndSwap(
    repoRoot,
    baseBranch,
    branch,
    message
  );
  if (!casOutcome.ok) {
    return err(
      storeDiagnostic(
        STORE_RULES.LIFECYCLE_WRITE_FAILED,
        casOutcome.message,
        {
          subject: input.name,
          narrowRepair: casOutcome.contention
            ? `Another agent is merging into ${baseBranch}. Re-run: caws worktree merge ${input.name}`
            : `${mergeRepairHint(input.name, entry)} ${casOutcome.repairSuffix ?? ''}`.trim(),
          data: {
            base_branch: baseBranch,
            ...(casOutcome.contention ? { contention: true } : {}),
            ...(casOutcome.attempts !== undefined
              ? { attempts: casOutcome.attempts }
              : {}),
          },
        }
      )
    );
  }
  const mergeCommit = casOutcome.mergeCommit;
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

  // CAWS-FIX-N5-MERGE-IDEMPOTENT-CLOSE-001: the close step must be
  // idempotent. If the bound spec was already closed before the merge
  // (e.g. an operator ran `caws specs close` then `caws worktree merge`),
  // closeSpec would return LIFECYCLE_PLAN_REJECTED via
  // nonActiveCloseSpecError — which this composed merge would then turn
  // into a false LIFECYCLE_PARTIAL_FAILURE_UNRECOVERED claiming "the bound
  // spec remains active" (it does not). The pre-close already appended a
  // spec_closed event, so we skip closeSpec entirely and continue to the
  // worktree_merged append + destroy. The already-closed guard in
  // closeSpec runs before any write, so skipping it changes nothing on
  // disk. loadSpecOrError re-reads through the canonical parser.
  const preCloseState = loadSpecOrError(cawsDir, specId);
  if (!isOk(preCloseState)) {
    return err(preCloseState.errors);
  }
  const specWasAlreadyClosed = preCloseState.value.lifecycleState === 'closed';

  let closeResult: Result<SpecWriterOutcome>;
  if (specWasAlreadyClosed) {
    // Synthesize a success outcome so the existing completion-honesty
    // checks below pass without a special case. No spec_closed event is
    // appended here — the prior `caws specs close` already appended one.
    closeResult = ok({ kind: 'success', id: specId, path: preCloseState.value.path });
  } else {
    // CAWS-FEAT-WORKTREE-MERGE-CLOSURE-NOTES-FLAG-01: when the operator
    // supplied --closure-notes at merge time, their notes replace the machine
    // stub as the reason. The stub remains the default for a merge with no
    // --closure-notes (audit provenance when the spec carried no notes).
    const stubReason = `Auto-closed by caws worktree merge ${input.name} at ${mergeCommit}`;
    const reason = input.closureNotes !== undefined ? input.closureNotes : stubReason;
    closeResult = closeSpec(cawsDir, {
      id: specId,
      resolution: 'completed',
      reason,
      mergeCommit,
      actor: input.actor,
      now: sharedNowFactory,
      // CAWS-CLI-MERGE-AUTOCLOSE-PRESERVE-CLOSURE-NOTES-001: the `reason`
      // above is a machine-generated stub (or operator-authored notes).
      // Insert-only mode keeps it from clobbering closure_notes an author
      // wrote on the bound spec — the reason fills closure_notes only when
      // the spec carried none. Operator-authored --closure-notes therefore
      // wins over an ABSENT field but never over pre-written YAML notes.
      preserveExistingNotes: true,
    });
  }

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
  // worktree_merged or destroy the worktree. (The synthesized success for
  // the already-closed fast path also satisfies this — the spec is
  // genuinely closed on disk, just by an earlier close.)
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
      // CAWS-PREPUSH-PROVENANCE-REWORK-001 (A1): the lane's contributed
      // range, recorded explicitly so publish-time provenance never
      // re-derives it from the merge commit's parents for post-extension
      // merges. ADDITIVE — pre-extension consumers are unaffected, and
      // pre-extension events are derived from parents at read time.
      // lane_tip is omitted only when its rev-parse failed (the merge
      // itself already succeeded; the range remains parent-derivable).
      ...(laneTip !== undefined ? { lane_tip: laneTip } : {}),
      base_before: casOutcome.baseBefore,
      auto_closed_spec: true,
      // CAWS-FIX-N5-MERGE-IDEMPOTENT-CLOSE-001: true when the merge skipped
      // closeSpec because the bound spec was already closed. auto_closed_spec
      // stays true (the spec is closed as of this merge); this discriminant
      // records that the close was performed by an earlier `caws specs close`,
      // not by this merge.
      spec_already_closed: specWasAlreadyClosed,
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

  // CAWS-PREPUSH-PROVENANCE-REWORK-001: same honest-completion invariant as
  // the closeResult check above. runLifecycleTransaction wraps
  // `partial_failure_recovered` in `ok()` — and with `plannedWrites: []` and
  // zero prior events, a rolled-back worktree_merged append arrives exactly
  // that way. isOk() alone would let the merge report success while the
  // provenance ledger silently lost the worktree_merged event — precisely
  // the event prepush's inductive delta check depends on. Refuse instead.
  if (mergedTxn.value.kind !== 'success') {
    return err(
      storeDiagnostic(
        STORE_RULES.LIFECYCLE_PARTIAL_FAILURE_UNRECOVERED,
        `Merge succeeded (commit ${mergeCommit}) but worktree_merged event append rolled back; the provenance ledger is missing the merge record. Worktree has NOT been destroyed.`,
        {
          subject: input.name,
          data: {
            merge_commit: mergeCommit,
            merged_outcome_kind: mergedTxn.value.kind,
            merged_cause:
              mergedTxn.value.kind === 'partial_failure_recovered' ? mergedTxn.value.cause : undefined,
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
    // CAWS-FIX-CWD-GUARD-COVERAGE-001: defense-in-depth — thread callerCwd
    // into the merge's own teardown so the guard covers this destroy path
    // too. Unreachable when dry-run (mergeWorktree returns at the dry-run
    // branch before teardown) and preceded by the early guard in real
    // merges, so this cannot change observable behavior today, but it
    // protects any future path that reaches this destroy. Conditionally
    // spread because exactOptionalPropertyTypes forbids assigning
    // `string | undefined` to an optional `string` field.
    ...(input.callerCwd !== undefined ? { callerCwd: input.callerCwd } : {}),
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

  // CAWS-WORKTREE-MERGE-DELETE-BRANCH-001: delete the now-merged branch.
  //
  // LAST step, deliberately. The merge commit, spec close, worktree_merged
  // event, and worktree destroy have all landed by here, so the merge is
  // complete and durable. A failure below therefore never rolls back and
  // never flips the exit code — per CAWS-AUTOCOMMIT-INTEGRITY-002,
  // operation success is not the same as every downstream step landing.
  //
  // `-d`, NEVER `-D`. The entire safety argument is git's own reachability
  // check: after a successful --no-ff merge the branch is by definition
  // reachable from base, so -d cannot lose work. If -d refuses, git is
  // telling us the branch is NOT merged — which after a successful merge
  // means something is genuinely wrong. We surface that loudly and leave
  // the branch intact rather than escalating to -D.
  //
  // Only this path deletes. Standalone `caws worktree destroy` preserves
  // the branch: it has no proof of reachability, and the operator may be
  // parking unmerged work.
  const branchDeleteResult = runGit(['branch', '-d', branch], repoRoot);
  const branchDeleted = branchDeleteResult.ok;

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
      spec_already_closed: specWasAlreadyClosed,
      audit_commit: autoCommitOutcome,
      branch,
      branch_deleted: branchDeleted,
      // Present only on refusal, and carries git's own words so the
      // operator does not need a second investigation to act.
      ...(branchDeleted
        ? {}
        : { branch_delete_error: branchDeleteResult.reason }),
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
