// Spec lifecycle writer.
//
// CLI-SPECS-001: store-layer mutations for spec lifecycle. Composes
// lifecycle-transaction + yaml-patch + appendEvent into typed lifecycle
// operations:
//
//   createSpec  — write a new .caws/specs/<id>.yaml (active) + spec_created
//   activateSpec — raw-byte patch lifecycle_state draft→active + spec_activated
//   closeSpec   — raw-byte patch lifecycle_state/resolution/closure_notes
//                  /updated_at on existing spec + spec_closed
//   archiveSpec — move .caws/specs/<id>.yaml → .caws/specs/.archive/<id>.yaml,
//                  patch lifecycle_state → archived + spec_archived
//
// Every operation:
//   - acquires the lifecycle lock
//   - validates plan via kernel (parseAndValidateSpec on planned bytes)
//   - performs writes through atomicWrite with preserveMode
//   - appends events through appendEvent (the SOLE v11 events writer)
//   - rolls back on failure with typed partial-failure outcomes
//
// What this module does NOT do:
//   - CLI argument parsing (that's in shell/commands/specs.ts)
//   - Rendering (shell layer)
//   - Concurrent worktree mutations (Slice 6 surface)

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import {
  type EventBody,
  err,
  isOk,
  ok,
  parseAndValidateSpec,
  type Result,
  type Spec,
  type Diagnostic,
} from '@paths.design/caws-kernel';

import { appendEvent, loadEvents } from './events-store';
import { loadSpecs } from './specs-store';
import {
  autoCommit,
  isPathDirty,
  type AutoCommitOutcome,
} from './git-autocommit';
import {
  runLifecycleTransaction,
  type LifecycleTransactionResult,
} from './lifecycle-transaction';
import { withLifecycleLock } from './lifecycle-lock';
import { storeDiagnostic } from './repo-root';
import { STORE_RULES } from './rules';
import {
  insertTopLevelScalarAfter,
  removeTopLevelScalar,
  setTopLevelScalar,
} from './yaml-patch';
import { readYamlSource } from './yaml-store';

// ─── Common types ────────────────────────────────────────────────────────

export interface CreateSpecInput {
  readonly id: string;
  readonly title: string;
  readonly mode: 'feature' | 'refactor' | 'fix' | 'doc' | 'chore';
  readonly riskTier: 1 | 2 | 3;
  /** Initial state. v11.1 defaults to active. */
  readonly initialState?: 'active' | 'draft';
  /**
   * scope.in paths to populate at creation time (CAWS-SPECS-CREATE-SCOPE-IN-001).
   * When non-empty, the rendered spec's scope.in lists exactly these paths
   * (first-seen order, de-duplicated) instead of the unfilled scaffold line —
   * set in the same createSpec write, so no hand-edit or follow-on amend is
   * needed. When undefined/empty, the scaffold line is rendered (prior behavior).
   */
  readonly scopeIn?: readonly string[];
  /**
   * Contracts to populate at creation time (FIX-SPECS-CONTRACT-ORIENTATION-001).
   * Tier-1/2 specs require at least one contract; supplying them here lets a
   * tier-1/2 spec be created in one command instead of create-at-tier-3-then-
   * hand-edit. When non-empty, the rendered spec's `contracts:` lists exactly
   * these entries; when undefined/empty, `contracts: []` is rendered (prior
   * behavior — valid for tier-3 / mode: chore).
   */
  readonly contracts?: readonly {
    readonly name: string;
    readonly type: 'api' | 'schema' | 'contract-test' | 'behavior';
    readonly path?: string;
  }[];
  /** Override the timestamp used for created_at + the event ts. Tests inject. */
  readonly now?: () => Date;
  /** The EventBody actor envelope (built by the shell layer). */
  readonly actor: EventBody['actor'];
}

export interface CloseSpecInput {
  readonly id: string;
  readonly resolution: 'completed' | 'superseded' | 'abandoned';
  readonly reason?: string;
  readonly mergeCommit?: string;
  readonly supersededBy?: string;
  readonly now?: () => Date;
  readonly actor: EventBody['actor'];
  /**
   * Insert-only mode for closure_notes. When true, `reason` is written to
   * closure_notes ONLY if the field is absent (or empty); an existing
   * non-empty value is preserved verbatim. Set by the worktree-merge
   * auto-close path (mergeWorktree → closeSpec), whose `reason` is a
   * machine-generated stub that must never clobber author-written notes.
   * The explicit `caws specs close --reason` path leaves this unset, so a
   * user-supplied reason still updates existing notes (user intent wins).
   * See CAWS-CLI-MERGE-AUTOCLOSE-PRESERVE-CLOSURE-NOTES-001.
   */
  readonly preserveExistingNotes?: boolean;
}

export interface ActivateSpecInput {
  readonly id: string;
  readonly now?: () => Date;
  readonly actor: EventBody['actor'];
}

export interface AmendScopeSpecInput {
  readonly id: string;
  /** scope.in paths to add (idempotent on already-present). */
  readonly addIn?: readonly string[];
  /** scope.in paths to remove (idempotent on absent). */
  readonly removeIn?: readonly string[];
  /** scope.out paths to add. */
  readonly addOut?: readonly string[];
  /** scope.out paths to remove. */
  readonly removeOut?: readonly string[];
  /** scope.support paths to add (admitted for edits, NOT worktree-claimed). */
  readonly addSupport?: readonly string[];
  /** scope.support paths to remove. */
  readonly removeSupport?: readonly string[];
  readonly now?: () => Date;
  readonly actor: EventBody['actor'];
}

export interface ArchiveSpecInput {
  readonly id: string;
  readonly reason?: string;
  readonly now?: () => Date;
  readonly actor: EventBody['actor'];
}

export interface RetireDraftSpecInput {
  readonly id: string;
  readonly reason?: string;
  readonly now?: () => Date;
  readonly actor: EventBody['actor'];
}

export type SpecWriterOutcome =
  | {
      readonly kind: 'success';
      readonly id: string;
      readonly path: string;
      /**
       * Audit-commit outcome for the spec yaml write
       * (CAWS-SPECS-WRITER-AUTOCOMMIT-001). Always present on success.
       * Callers that want the sha can read `data.audit_commit.sha` when
       * `data.audit_commit.kind === 'committed'`. Refused or skipped
       * outcomes are non-fatal: the writer's transaction still
       * succeeded; only the audit-trail commit was deferred.
       */
      readonly data?: { readonly audit_commit: AutoCommitOutcome };
      /**
       * Optional non-blocking advisories about the operation that succeeded
       * (WORKTREE-CLAIM-COMPOSE-WARN-001). Absent when there is nothing to warn
       * about. Callers print these to stderr; they never affect the exit code.
       * Additive: callers reading only id/path/data are unaffected.
       */
      readonly warnings?: readonly string[];
    }
  | {
      readonly kind: 'partial_failure_recovered';
      readonly cause: readonly Diagnostic[];
    };

// ─── Path helpers ────────────────────────────────────────────────────────

function specPath(cawsDir: string, id: string): string {
  return path.join(cawsDir, 'specs', `${id}.yaml`);
}
function repoRootFromCawsDir(cawsDir: string): string {
  return path.dirname(cawsDir);
}
function specRelPath(
  cawsDir: string,
  id: string,
  repoRoot: string
): string {
  return path.relative(repoRoot, specPath(cawsDir, id));
}
function hasComplexTopLevelValue(source: string, key: string): boolean {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`^${escapedKey}:(.*)$`, 'm'));
  if (match === null) return false;
  const rest = (match[1] ?? '').trim();
  return (
    rest === '' ||
    rest.startsWith('#') ||
    rest.startsWith('|') ||
    rest.startsWith('>') ||
    rest.startsWith('{') ||
    rest.startsWith('[')
  );
}
function archivedSpecPath(cawsDir: string, id: string): string {
  return path.join(cawsDir, 'specs', '.archive', `${id}.yaml`);
}

/** Find a spec on disk under either active or archived locations. */
function findSpecPath(cawsDir: string, id: string): string | null {
  const active = specPath(cawsDir, id);
  if (fs.existsSync(active)) return active;
  const archived = archivedSpecPath(cawsDir, id);
  if (fs.existsSync(archived)) return archived;
  return null;
}

/**
 * TOMBSTONE-SHELL-TEST-RECONCILIATION-001: detect whether a spec id
 * has been archived via the tombstone path (spec_archived event in
 * the event log). CAWS-ARCHIVE-AS-TOMBSTONE-001 removed the
 * `.caws/specs/.archive/<id>.yaml` body write; the spec_archived
 * event is now the authoritative archive signal.
 *
 * Cold-path predicate used only when both `specs/<id>.yaml` AND
 * `specs/.archive/<id>.yaml` are absent. Scans the event log
 * sequentially for a matching `spec_archived` event. Returns true on
 * any match. Returns false if the event log is unreadable or empty
 * (no events means no archive can have happened in this repo).
 *
 * CAWS-SPECS-ARCHIVE-COLLISION-REFUSAL-001: this predicate is now
 * enforcement-grade, not diagnostic-only. createSpec consults it to
 * refuse re-creation of an archived id (tombstone identity). closeSpec
 * still uses it to choose between "archived; cannot close" vs
 * "not found" diagnostics. recover/show/list continue to depend on
 * the event log directly for archived-body retrieval.
 */
function isArchivedViaTombstone(cawsDir: string, id: string): boolean {
  const result = loadEvents(cawsDir);
  if (!result.ok) return false;
  for (const event of result.value.events) {
    const body = event as { event?: string; spec_id?: string };
    if (body.event === 'spec_archived' && body.spec_id === id) {
      return true;
    }
  }
  return false;
}

// ─── Git query helpers (CAWS-ARCHIVE-AS-TOMBSTONE-001) ─────────────────
//
// archiveSpec needs to capture the spec yaml's blob_sha + optional
// source_commit_sha BEFORE removing the file. These helpers wrap
// execFileSync with the CAWS shell discipline (array args, never raw
// shell strings) and return null on failure rather than throwing.
// Failure-tolerant by design: a missing blob means "not in HEAD," not
// "system is broken."

function runGitQuery(
  args: ReadonlyArray<string>,
  repoRoot: string,
  opts: { trim?: boolean } = {}
): string | null {
  const trim = opts.trim !== false; // default true
  try {
    const output = execFileSync('git', [...args], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString();
    return trim ? output.trim() : output;
  } catch {
    return null;
  }
}

/**
 * Return the git blob_sha of a path at HEAD, or null if the path is
 * not tracked at HEAD. Output is a 40-hex string when present.
 *
 * The blob_sha is content-addressed and topology-independent: once
 * recorded in a spec_archived event, `git show <blob_sha>` recovers
 * the body regardless of subsequent commit graph rewrites.
 */
function gitBlobShaAtHead(
  repoRoot: string,
  relPath: string
): string | null {
  const output = runGitQuery(['ls-tree', 'HEAD', '--', relPath], repoRoot);
  if (output === null || output.length === 0) return null;
  // Output shape: "<mode> <type> <sha>\t<path>"
  const parts = output.split(/\s+/);
  if (parts.length < 3) return null;
  const sha = parts[2];
  return /^[0-9a-f]{40}$/.test(sha ?? '') ? (sha as string) : null;
}

/**
 * Return the sha of the commit that last modified the given path, or
 * null if no such commit exists (file never tracked). Recorded for
 * human audit on spec_archived events; NOT used by recover.
 */
function gitLastCommitForPath(
  repoRoot: string,
  relPath: string
): string | null {
  const output = runGitQuery(
    ['log', '-1', '--format=%H', '--', relPath],
    repoRoot
  );
  if (output === null || output.length === 0) return null;
  return /^[0-9a-f]{40}$/.test(output) ? output : null;
}

// ─── Auto-commit helper (CAWS-SPECS-WRITER-AUTOCOMMIT-001) ──────────────
//
// Every successful spec-writer lifecycle transaction commits its yaml
// change as the final step. Parity with worktrees-writer's
// autoCommitTransition (worktrees-writer.ts:209). The shared
// git-autocommit utility handles the three observable states
// (committed / refused_dirty / skipped_no_git); this helper computes
// the right inputs and never throws.
//
// Pre-write dirty state must be captured by the CALLER, before any
// writer mutation lands. The utility cannot rederive it after the
// fact.
//
// Root cause this addresses (observed 2026-05-27 during
// CAWS-WORKTREE-DESTROY-SESSION-RESOLUTION-001 close): without this
// autocommit, `caws specs close` leaves the spec yaml dirty in the
// working tree, which then causes a subsequent
// `caws worktree destroy` to refuse its own audit commit because
// the dirty spec yaml fails its capturePreWriteState check.

function autoCommitSpecWrite(
  cawsDir: string,
  specId: string,
  action: 'create' | 'activate' | 'close' | 'archive' | 'amend-scope',
  wasDirtyBeforeWrite: boolean,
  extraPaths: ReadonlyArray<string> = []
): AutoCommitOutcome {
  const repoRoot = repoRootFromCawsDir(cawsDir);
  const primaryPath = specRelPath(cawsDir, specId, repoRoot);
  const paths = [primaryPath, ...extraPaths];
  const message = `chore(caws): ${action} ${specId}`;
  return autoCommit({
    repoRoot,
    paths,
    message,
    wasDirtyBeforeWrite,
  });
}

/**
 * Wrap a Result<SpecWriterOutcome> with an autoCommit attempt, mirroring
 * the worktrees-writer post-transaction commit pattern. Only attaches
 * data.audit_commit when the inner outcome is `kind: 'success'`.
 * Partial failure or err results pass through unchanged — there is
 * nothing valid to commit when the transaction rolled back.
 */
function attachAutoCommit(
  outcome: Result<SpecWriterOutcome>,
  cawsDir: string,
  specId: string,
  action: 'create' | 'activate' | 'close' | 'archive' | 'amend-scope',
  wasDirtyBeforeWrite: boolean,
  extraPaths: ReadonlyArray<string> = []
): Result<SpecWriterOutcome> {
  if (!isOk(outcome)) return outcome;
  if (outcome.value.kind !== 'success') return outcome;
  const audit = autoCommitSpecWrite(
    cawsDir,
    specId,
    action,
    wasDirtyBeforeWrite,
    extraPaths
  );
  return ok({
    ...outcome.value,
    data: { audit_commit: audit },
  });
}

// ─── ID validation (mirrors kernel regex) ────────────────────────────────

const SPEC_ID_PATTERN = /^[A-Z][A-Z0-9]*(-[A-Z0-9]+)*-\d+[a-z]*$/;

function validateSpecId(id: string): Result<true> {
  if (typeof id !== 'string' || id.length === 0) {
    return err(
      storeDiagnostic(
        STORE_RULES.LIFECYCLE_PLAN_REJECTED,
        'Spec id is required.',
        { subject: 'id' }
      )
    );
  }
  if (!SPEC_ID_PATTERN.test(id)) {
    return err(
      storeDiagnostic(
        STORE_RULES.LIFECYCLE_PLAN_REJECTED,
        `Spec id "${id}" does not match the v11 pattern (e.g., FEAT-001, CLI-SPECS-001).`,
        { subject: id, data: { pattern: SPEC_ID_PATTERN.source } }
      )
    );
  }
  return ok(true as const);
}

// ─── Spec rendering for create ───────────────────────────────────────────

function renderInitialSpecYaml(input: CreateSpecInput): string {
  const now = (input.now ?? (() => new Date()))().toISOString();
  const state = input.initialState ?? 'active';
  // CAWS-SPECS-CREATE-SCOPE-IN-001: when --scope-in paths were supplied,
  // render them as the scope.in sequence (first-seen order, de-duplicated)
  // in this same write — so a first-timer never has to hand-edit the YAML
  // (the silent-failure surface that cornered the friction-probe). When no
  // paths are supplied, fall back to the single scaffold line that
  // preserves prior behavior.
  const dedupedScopeIn =
    input.scopeIn !== undefined && input.scopeIn.length > 0
      ? [...new Set(input.scopeIn)]
      : null;
  const scopeInLines =
    dedupedScopeIn !== null
      ? dedupedScopeIn.map((p) => `    - '${p.replace(/'/g, "''")}'`)
      : [`    - 'TODO: list the file(s) or directories this spec authorizes.'`];
  // FIX-SPECS-CONTRACT-ORIENTATION-001: when --contract entries were supplied,
  // render them so a tier-1/2 spec is created valid in one command. Each entry
  // is {name, type[, path]}; single-quote string scalars defensively. When none
  // are supplied, render the empty sequence (prior behavior; valid for tier-3 /
  // mode: chore).
  const sq = (s: string): string => `'${s.replace(/'/g, "''")}'`;
  const contractsLines =
    input.contracts !== undefined && input.contracts.length > 0
      ? [
          `contracts:`,
          ...input.contracts.flatMap((c) => [
            `  - name: ${sq(c.name)}`,
            `    type: ${c.type}`,
            ...(c.path !== undefined && c.path.length > 0
              ? [`    path: ${sq(c.path)}`]
              : []),
          ]),
        ]
      : [`contracts: []`];
  // Render a minimum-viable v11 spec. Plain-string fields are
  // single-quoted to be defensive against embedded colons. The body
  // is intentionally minimal but satisfies the kernel's structural
  // requirements (non-empty arrays where the schema demands them).
  // The user fills in concrete values before iteration.
  return [
    `id: ${input.id}`,
    `title: '${input.title.replace(/'/g, "''")}'`,
    `risk_tier: ${input.riskTier}`,
    `mode: ${input.mode}`,
    `lifecycle_state: ${state}`,
    `created_at: '${now}'`,
    `updated_at: '${now}'`,
    `blast_radius:`,
    `  modules:`,
    `    - 'TODO: list one or more modules this spec touches.'`,
    `  data_migration: false`,
    `operational_rollback_slo: 5m`,
    `scope:`,
    `  in:`,
    ...scopeInLines,
    `  out: []`,
    `invariants:`,
    `  - 'TODO: describe one invariant this spec guarantees.'`,
    `acceptance:`,
    `  - id: A1`,
    `    given: 'TODO'`,
    `    when: 'TODO'`,
    `    then: 'TODO'`,
    `non_functional: {}`,
    ...contractsLines,
    ``,
  ].join('\n');
}

// ─── createSpec ──────────────────────────────────────────────────────────

export function createSpec(
  cawsDir: string,
  input: CreateSpecInput
): Result<SpecWriterOutcome> {
  const idValidation = validateSpecId(input.id);
  if (!idValidation.ok) return idValidation;

  // Refuse duplicate ids (in either active or archived location).
  const existing = findSpecPath(cawsDir, input.id);
  if (existing !== null) {
    return err(
      storeDiagnostic(
        STORE_RULES.LIFECYCLE_PLAN_REJECTED,
        `Spec "${input.id}" already exists at ${existing}.`,
        { subject: input.id, data: { existing_path: existing } }
      )
    );
  }

  // CAWS-SPECS-ARCHIVE-COLLISION-REFUSAL-001: tombstone identity.
  // findSpecPath above checks both active and pre-tombstone archive
  // locations on disk. Post-CAWS-ARCHIVE-AS-TOMBSTONE-001 the active
  // file is deleted and no archive body is written, so an
  // archived-then-erased spec leaves no on-disk trace; only the
  // spec_archived event remains. Without this second check, a
  // re-created spec would silently reuse a tombstoned id, breaking
  // the audit narrative on .caws/events.jsonl (recover/show by id
  // would become ambiguous between archived and current bodies).
  if (isArchivedViaTombstone(cawsDir, input.id)) {
    return err(
      storeDiagnostic(
        STORE_RULES.LIFECYCLE_PLAN_REJECTED,
        `Spec "${input.id}" has a prior spec_archived event in .caws/events.jsonl; archived spec ids are tombstoned identities and cannot be re-created. Use \`caws specs recover ${input.id}\` to retrieve the archived body, or choose a different id.`,
        { subject: input.id, data: { reason: 'archived_tombstone' } }
      )
    );
  }

  const targetPath = specPath(cawsDir, input.id);
  const newBytes = renderInitialSpecYaml(input);

  // Validate the planned YAML through the kernel BEFORE we write or
  // append events.
  const parsed = parseAndValidateSpec(newBytes);
  if (!isOk(parsed)) {
    return err(
      parsed.errors.map((d) =>
        storeDiagnostic(STORE_RULES.LIFECYCLE_PLAN_REJECTED, d.message, {
          subject: d.subject ?? input.id,
          // Thread the kernel diagnostic's narrowRepair through so the shell's
          // renderDiagnostics prints the `repair:` line. The kernel already
          // names the escape for the tier-contract gate ("Add at least one
          // contract or change risk_tier to 3 or mode to chore."); copying
          // only d.message silently discarded it, leaving a first-timer with a
          // bare "requires a contract" and no way forward.
          // (CAWS-SPEC-CREATE-FIRSTTIMER-UX-001 A1/A2)
          ...(d.narrowRepair !== undefined
            ? { narrowRepair: d.narrowRepair }
            : {}),
          data: { source_rule: d.rule },
        })
      )
    );
  }

  const now = (input.now ?? (() => new Date()))().toISOString();
  const event: EventBody = {
    event: 'spec_created',
    ts: now,
    actor: input.actor,
    spec_id: input.id,
    data: {
      title: input.title,
      risk_tier: input.riskTier,
      mode: input.mode,
      lifecycle_state: input.initialState ?? 'active',
    },
  } as unknown as EventBody;

  // CAWS-SPECS-WRITER-AUTOCOMMIT-001: capture pre-write dirty state
  // BEFORE the transaction runs. For createSpec on a fresh id, the
  // target path does not yet exist, so isPathDirty returns false —
  // the autocommit will succeed cleanly. We still call it because
  // (a) a stale conflict marker or hand-authored draft at the target
  // path could exist (we already refused that case above via
  // findSpecPath, but defense-in-depth), and (b) the contract is
  // that callers always observe data.audit_commit on success.
  const repoRoot = repoRootFromCawsDir(cawsDir);
  const wasDirtyBeforeWrite = isPathDirty(
    repoRoot,
    specRelPath(cawsDir, input.id, repoRoot)
  );

  const txnResult = withLifecycleLock(cawsDir, () =>
    runLifecycleTransaction({
      cawsDir,
      plannedWrites: [{ path: targetPath, contents: newBytes }],
      events: [event],
    })
  );
  if (!txnResult.ok) {
    return err(txnResult.errors);
  }
  const outcome = mapTxnToOutcome(txnResult.value, input.id, targetPath);
  return attachAutoCommit(outcome, cawsDir, input.id, 'create', wasDirtyBeforeWrite);
}

// ─── activateSpec ────────────────────────────────────────────────────────

export function activateSpec(
  cawsDir: string,
  input: ActivateSpecInput
): Result<SpecWriterOutcome> {
  const idValidation = validateSpecId(input.id);
  if (!idValidation.ok) return idValidation;

  const targetPath = specPath(cawsDir, input.id);
  if (!fs.existsSync(targetPath)) {
    return err(
      storeDiagnostic(
        STORE_RULES.LIFECYCLE_PLAN_REJECTED,
        `Spec "${input.id}" not found at ${targetPath}.`,
        { subject: input.id }
      )
    );
  }

  const sourceResult = readYamlSource(targetPath);
  if (!isOk(sourceResult)) return err(sourceResult.errors);
  const originalBytes = sourceResult.value;
  const parsed = parseAndValidateSpec(originalBytes);
  if (!isOk(parsed)) {
    return err(
      parsed.errors.map((d) =>
        storeDiagnostic(STORE_RULES.LIFECYCLE_PLAN_REJECTED, d.message, {
          subject: d.subject ?? input.id,
          // Thread the kernel diagnostic's narrowRepair through so the shell's
          // renderDiagnostics prints the `repair:` line. The kernel already
          // names the escape for the tier-contract gate ("Add at least one
          // contract or change risk_tier to 3 or mode to chore."); copying
          // only d.message silently discarded it, leaving a first-timer with a
          // bare "requires a contract" and no way forward.
          // (CAWS-SPEC-CREATE-FIRSTTIMER-UX-001 A1/A2)
          ...(d.narrowRepair !== undefined
            ? { narrowRepair: d.narrowRepair }
            : {}),
          data: { source_rule: d.rule },
        })
      )
    );
  }
  const spec = parsed.value;
  if (spec.lifecycle_state !== 'draft') {
    const alternative =
      spec.lifecycle_state === 'active'
        ? `Spec "${input.id}" is already active.`
        : spec.lifecycle_state === 'closed'
          ? `Use \`caws specs archive ${input.id}\` to archive a closed spec.`
          : `Archived specs cannot be activated. Use \`caws specs recover ${input.id}\` to inspect the archived body.`;
    return err(
      storeDiagnostic(
        STORE_RULES.LIFECYCLE_PLAN_REJECTED,
        `Spec "${input.id}" is in lifecycle_state "${spec.lifecycle_state}"; activate only activates drafts. ${alternative}`,
        { subject: input.id, data: { current_state: spec.lifecycle_state } }
      )
    );
  }

  const now = (input.now ?? (() => new Date()))().toISOString();
  let patched = originalBytes;
  const step1 = setTopLevelScalar(patched, 'lifecycle_state', 'active');
  if (!step1.ok) return err(step1.errors);
  patched = step1.value;

  const hasUpdatedAt = /^updated_at:/m.test(patched);
  if (hasUpdatedAt) {
    const step2 = setTopLevelScalar(patched, 'updated_at', `'${now}'`);
    if (!step2.ok) return err(step2.errors);
    patched = step2.value;
  } else {
    const anchor = /^created_at:/m.test(patched) ? 'created_at' : 'lifecycle_state';
    const step2 = insertTopLevelScalarAfter(patched, anchor, 'updated_at', `'${now}'`);
    if (!step2.ok) return err(step2.errors);
    patched = step2.value;
  }

  const reparsed = parseAndValidateSpec(patched);
  if (!isOk(reparsed)) {
    return err(
      reparsed.errors.map((d) =>
        storeDiagnostic(STORE_RULES.LIFECYCLE_PLAN_REJECTED, d.message, {
          subject: d.subject ?? input.id,
          data: { source_rule: d.rule, hint: 'planned-bytes validation failed' },
        })
      )
    );
  }

  const event: EventBody = {
    event: 'spec_activated',
    ts: now,
    actor: input.actor,
    spec_id: input.id,
    data: {
      previous_lifecycle_state: 'draft',
      lifecycle_state: 'active',
    },
  } as unknown as EventBody;

  const repoRoot = repoRootFromCawsDir(cawsDir);
  const wasDirtyBeforeWrite = isPathDirty(
    repoRoot,
    specRelPath(cawsDir, input.id, repoRoot)
  );

  const txnResult = withLifecycleLock(cawsDir, () =>
    runLifecycleTransaction({
      cawsDir,
      plannedWrites: [{ path: targetPath, contents: patched }],
      events: [event],
    })
  );
  if (!txnResult.ok) {
    return err(txnResult.errors);
  }
  const outcome = mapTxnToOutcome(txnResult.value, input.id, targetPath);
  return attachAutoCommit(outcome, cawsDir, input.id, 'activate', wasDirtyBeforeWrite);
}

// ─── closeSpec ───────────────────────────────────────────────────────────

export function closeSpec(
  cawsDir: string,
  input: CloseSpecInput
): Result<SpecWriterOutcome> {
  const idValidation = validateSpecId(input.id);
  if (!idValidation.ok) return idValidation;

  const targetPath = specPath(cawsDir, input.id);
  if (!fs.existsSync(targetPath)) {
    // TOMBSTONE-SHELL-TEST-RECONCILIATION-001: archived-id detection
    // moved from `.caws/specs/.archive/<id>.yaml` file existence to
    // the event log. CAWS-ARCHIVE-AS-TOMBSTONE-001 made archive a
    // deletion + spec_archived event (no body written under .archive/),
    // so the legacy file check always returned false post-tombstone
    // and the diagnostic fell through to generic "not found at <path>".
    //
    // The legacy check is preserved as a first pass (pre-tombstone
    // archives may still exist as on-disk bodies; legitimate
    // backward-compat). If the legacy file is absent, scan the event
    // log for a `spec_archived` event matching this id — the
    // authoritative tombstone signal. The scan is O(events) and only
    // happens on the cold path (active file absent), not on every
    // close.
    const archived = archivedSpecPath(cawsDir, input.id);
    if (fs.existsSync(archived) || isArchivedViaTombstone(cawsDir, input.id)) {
      return err(
        storeDiagnostic(
          STORE_RULES.LIFECYCLE_PLAN_REJECTED,
          `Spec "${input.id}" is archived; cannot close (legal transitions: active → closed → archived).`,
          { subject: input.id }
        )
      );
    }
    return err(
      storeDiagnostic(
        STORE_RULES.LIFECYCLE_PLAN_REJECTED,
        `Spec "${input.id}" not found at ${targetPath}.`,
        { subject: input.id }
      )
    );
  }

  // Load and verify the current state.
  const sourceResult = readYamlSource(targetPath);
  if (!isOk(sourceResult)) return err(sourceResult.errors);
  const originalBytes = sourceResult.value;
  const parsed = parseAndValidateSpec(originalBytes);
  if (!isOk(parsed)) {
    return err(
      parsed.errors.map((d) =>
        storeDiagnostic(STORE_RULES.LIFECYCLE_PLAN_REJECTED, d.message, {
          subject: d.subject ?? input.id,
          // Thread the kernel diagnostic's narrowRepair through so the shell's
          // renderDiagnostics prints the `repair:` line. The kernel already
          // names the escape for the tier-contract gate ("Add at least one
          // contract or change risk_tier to 3 or mode to chore."); copying
          // only d.message silently discarded it, leaving a first-timer with a
          // bare "requires a contract" and no way forward.
          // (CAWS-SPEC-CREATE-FIRSTTIMER-UX-001 A1/A2)
          ...(d.narrowRepair !== undefined
            ? { narrowRepair: d.narrowRepair }
            : {}),
          data: { source_rule: d.rule },
        })
      )
    );
  }
  const spec = parsed.value;
  if (spec.lifecycle_state !== 'active') {
    return err(
      storeDiagnostic(
        STORE_RULES.LIFECYCLE_PLAN_REJECTED,
        `Spec "${input.id}" is in lifecycle_state "${spec.lifecycle_state}"; only active specs can be closed.`,
        { subject: input.id, data: { current_state: spec.lifecycle_state } }
      )
    );
  }

  // Raw-byte patch sequence:
  //   1. lifecycle_state → closed
  //   2. insert resolution after lifecycle_state
  //   3. if reason: insert closure_notes after resolution
  //   4. updated_at → now
  const now = (input.now ?? (() => new Date()))().toISOString();
  let patched = originalBytes;

  const step1 = setTopLevelScalar(patched, 'lifecycle_state', 'closed');
  if (!step1.ok) return err(step1.errors);
  patched = step1.value;

  // Insert resolution after lifecycle_state. If resolution already
  // exists (e.g., from a prior failed transaction), update it instead.
  const hasResolution = /^resolution:/m.test(patched);
  if (hasResolution) {
    const step2 = setTopLevelScalar(patched, 'resolution', input.resolution);
    if (!step2.ok) return err(step2.errors);
    patched = step2.value;
  } else {
    const step2 = insertTopLevelScalarAfter(
      patched,
      'lifecycle_state',
      'resolution',
      input.resolution
    );
    if (!step2.ok) return err(step2.errors);
    patched = step2.value;
  }

  if (input.reason !== undefined && input.reason.length > 0) {
    const escaped = `'${input.reason.replace(/'/g, "''")}'`;
    const hasNotes = /^closure_notes:/m.test(patched);
    if (hasNotes) {
      // CAWS-CLI-MERGE-AUTOCLOSE-PRESERVE-CLOSURE-NOTES-001:
      // `hasComplexTopLevelValue` is true for empty / block-scalar / flow
      // values and false for an inline single-line scalar. The historical
      // behavior overwrote inline scalars (preserving block scalars only by
      // accident of that carve-out). Under preserveExistingNotes (the merge
      // auto-close path), any closure_notes that already carries author
      // content is left untouched regardless of inline-vs-block shape — the
      // machine stub must never replace author-written notes.
      //
      // `isEmptyNotes` (key present, no content after it) gates the
      // preserve so we don't widen the guard to a degenerate empty field;
      // its overwrite disposition is then unchanged from the historical
      // path (hasComplexTopLevelValue treats empty as complex → not
      // overwritten either way). The fillable case for a stub is *absent*
      // notes, handled by the `else` insert branch below.
      const isEmptyNotes = /^closure_notes:[ \t]*(#.*)?$/m.test(patched);
      const preserve =
        input.preserveExistingNotes === true && !isEmptyNotes;
      if (!preserve && !hasComplexTopLevelValue(patched, 'closure_notes')) {
        const step3 = setTopLevelScalar(patched, 'closure_notes', escaped);
        if (!step3.ok) return err(step3.errors);
        patched = step3.value;
      }
    } else {
      const step3 = insertTopLevelScalarAfter(
        patched,
        'resolution',
        'closure_notes',
        escaped
      );
      if (!step3.ok) return err(step3.errors);
      patched = step3.value;
    }
  }

  // CAWS-MERGE-CLOSE-MISSING-UPDATED-AT-001: insert-or-update fallback
  // for updated_at. Legacy / v10-migrated / hand-authored specs may lack
  // this optional field (it's not in spec.v1.json required[]). Without
  // the fallback, setTopLevelScalar returns YAML_PATCH_KEY_NOT_FOUND
  // here and the close transaction rolls back; the composed
  // mergeWorktree → closeSpec path then reports
  // partial_failure_unrecovered with the underlying patch-key error
  // buried in close_errors. Mirror the has*-check +
  // insertTopLevelScalarAfter pattern used for resolution and
  // closure_notes above. Inline rather than extracted to a helper per
  // the spec's out-of-scope note (the parallel pattern is intentional;
  // helper extraction is a hygiene concern, not a closure blocker).
  const hasUpdatedAt = /^updated_at:/m.test(patched);
  if (hasUpdatedAt) {
    const step4 = setTopLevelScalar(patched, 'updated_at', `'${now}'`);
    if (!step4.ok) return err(step4.errors);
    patched = step4.value;
  } else {
    // Anchor preference: after created_at (natural timestamp pairing)
    // when present, otherwise after lifecycle_state. createSpec always
    // writes created_at so this fallback fires only for legacy specs.
    const anchor = /^created_at:/m.test(patched) ? 'created_at' : 'lifecycle_state';
    const step4 = insertTopLevelScalarAfter(patched, anchor, 'updated_at', `'${now}'`);
    if (!step4.ok) return err(step4.errors);
    patched = step4.value;
  }

  // Step 5 (WORKTREE-MERGE-CLEARS-SPEC-BINDING-001):
  // Clear any top-level `worktree:` binding. A closed spec cannot have
  // a live worktree binding by definition; leaving the field is what
  // produces doctor.binding.spec_missing_registry drift after merge or
  // independent destroy. Byte-level invariant: after this step,
  // `grep '^worktree:' <spec>.yaml` MUST return no match.
  //
  // `spec.worktree` was captured from the pre-patch parsed YAML; if it
  // was set, we record it in the spec_closed event as `prior_worktree`
  // for audit-trail continuity. If the field was absent, this is a
  // no-op (per removeTopLevelScalar's contract) and no prior_worktree
  // is recorded.
  const priorWorktree =
    typeof spec.worktree === 'string' && spec.worktree.length > 0
      ? spec.worktree
      : undefined;
  const step5 = removeTopLevelScalar(patched, 'worktree');
  if (!step5.ok) return err(step5.errors);
  patched = step5.value;

  // Validate the patched bytes through the kernel before write.
  const reparsed = parseAndValidateSpec(patched);
  if (!isOk(reparsed)) {
    return err(
      reparsed.errors.map((d) =>
        storeDiagnostic(STORE_RULES.LIFECYCLE_PLAN_REJECTED, d.message, {
          subject: d.subject ?? input.id,
          data: { source_rule: d.rule, hint: 'planned-bytes validation failed' },
        })
      )
    );
  }

  const eventData: Record<string, unknown> = { resolution: input.resolution };
  if (input.reason !== undefined && input.reason.length > 0) {
    eventData.closure_notes = input.reason;
  }
  if (input.mergeCommit !== undefined) eventData.merge_commit = input.mergeCommit;
  if (input.supersededBy !== undefined) eventData.superseded_by = input.supersededBy;
  if (priorWorktree !== undefined) eventData.prior_worktree = priorWorktree;

  const event: EventBody = {
    event: 'spec_closed',
    ts: now,
    actor: input.actor,
    spec_id: input.id,
    data: eventData,
  } as unknown as EventBody;

  // CAWS-SPECS-WRITER-AUTOCOMMIT-001: capture pre-write dirty state
  // BEFORE the transaction. closeSpec patches an existing yaml, so
  // the path almost always pre-exists; dirty means the user
  // hand-edited it before the close call. autoCommit refuses to
  // overwrite uncommitted user work (data.audit_commit.kind ===
  // 'refused_dirty'); the close itself still applies to the working
  // tree.
  const repoRoot = repoRootFromCawsDir(cawsDir);
  const wasDirtyBeforeWrite = isPathDirty(
    repoRoot,
    specRelPath(cawsDir, input.id, repoRoot)
  );

  const txnResult = withLifecycleLock(cawsDir, () =>
    runLifecycleTransaction({
      cawsDir,
      plannedWrites: [{ path: targetPath, contents: patched }],
      events: [event],
    })
  );
  if (!txnResult.ok) {
    return err(txnResult.errors);
  }
  const outcome = mapTxnToOutcome(txnResult.value, input.id, targetPath);
  return attachAutoCommit(outcome, cawsDir, input.id, 'close', wasDirtyBeforeWrite);
}

// ─── archiveSpec ─────────────────────────────────────────────────────────

export function archiveSpec(
  cawsDir: string,
  input: ArchiveSpecInput
): Result<SpecWriterOutcome> {
  const idValidation = validateSpecId(input.id);
  if (!idValidation.ok) return idValidation;

  const fromPath = specPath(cawsDir, input.id);
  if (!fs.existsSync(fromPath)) {
    const archived = archivedSpecPath(cawsDir, input.id);
    if (fs.existsSync(archived)) {
      return err(
        storeDiagnostic(
          STORE_RULES.LIFECYCLE_PLAN_REJECTED,
          `Spec "${input.id}" is already archived at ${archived}.`,
          { subject: input.id }
        )
      );
    }
    return err(
      storeDiagnostic(
        STORE_RULES.LIFECYCLE_PLAN_REJECTED,
        `Spec "${input.id}" not found at ${fromPath}.`,
        { subject: input.id }
      )
    );
  }

  // Validate current state: must be closed.
  const sourceResult = readYamlSource(fromPath);
  if (!isOk(sourceResult)) return err(sourceResult.errors);
  const originalBytes = sourceResult.value;
  const parsed = parseAndValidateSpec(originalBytes);
  if (!isOk(parsed)) {
    return err(
      parsed.errors.map((d) =>
        storeDiagnostic(STORE_RULES.LIFECYCLE_PLAN_REJECTED, d.message, {
          subject: d.subject ?? input.id,
          // Thread the kernel diagnostic's narrowRepair through so the shell's
          // renderDiagnostics prints the `repair:` line. The kernel already
          // names the escape for the tier-contract gate ("Add at least one
          // contract or change risk_tier to 3 or mode to chore."); copying
          // only d.message silently discarded it, leaving a first-timer with a
          // bare "requires a contract" and no way forward.
          // (CAWS-SPEC-CREATE-FIRSTTIMER-UX-001 A1/A2)
          ...(d.narrowRepair !== undefined
            ? { narrowRepair: d.narrowRepair }
            : {}),
          data: { source_rule: d.rule },
        })
      )
    );
  }
  const spec = parsed.value;
  if (spec.lifecycle_state !== 'closed') {
    return err(
      storeDiagnostic(
        STORE_RULES.LIFECYCLE_PLAN_REJECTED,
        `Spec "${input.id}" is in lifecycle_state "${spec.lifecycle_state}"; only closed specs can be archived.`,
        { subject: input.id, data: { current_state: spec.lifecycle_state } }
      )
    );
  }

  const now = (input.now ?? (() => new Date()))().toISOString();

  // CAWS-ARCHIVE-AS-TOMBSTONE-001 invariant: archive does NOT write
  // a body to .caws/specs/.archive/<id>.yaml. The body is recoverable
  // via git history; the only on-disk mutation is the deletion of the
  // active path.
  //
  // Step ordering (locked inside the lifecycle txn):
  //   1. Capture blob_sha + source_commit_sha BEFORE any mutation
  //      (so even if the txn fails, no state has been written).
  //   2. unlink fromPath inside the txn's plannedWrites (modelled as
  //      a delete via the new lifecycle-transaction shape, OR
  //      executed inside the txn callback for v1).
  //   3. Append the spec_archived event carrying blob_sha (new
  //      tombstone shape) — NOT to_path.
  //   4. Post-txn, autoCommit stages the deletion via `git add` (which
  //      stages deletions when the file is gone).
  //
  // v1 ordering note: lifecycle-transaction.plannedWrites expects
  // {path, contents} pairs (creates/overwrites). It does not model
  // deletions natively. For v1 we execute the unlink inside the
  // txn callback AFTER the event write succeeds; if the unlink
  // fails post-event, we surface partial_failure_unrecovered
  // (same shape as the legacy code did).
  //
  // void input.reason: archive accepts --reason for parity with
  // close but the spec_archived schema does not carry it.
  //
  // CAWS-MERGE-CLOSE-MISSING-UPDATED-AT-001 reconciliation: the
  // archiveSpec absent-`updated_at` patch from this slice was
  // superseded by CAWS-ARCHIVE-AS-TOMBSTONE-001 (merge 2a4cc30).
  // Tombstone eliminates archiveSpec's YAML patch step entirely —
  // there is no `updated_at` to insert into a body that no longer
  // gets written. The closeSpec absent-`updated_at` fix at line ~540
  // remains in force; the archiveSpec branch is now dead code in
  // tombstone-world and has been removed from this slice on merge.

  const repoRoot = repoRootFromCawsDir(cawsDir);
  const fromRel = path.relative(repoRoot, fromPath);

  // Capture BEFORE any mutation. blob_sha is the authoritative
  // recovery target. source_commit_sha is optional human audit.
  const blobSha = gitBlobShaAtHead(repoRoot, fromRel);
  if (blobSha === null) {
    return err(
      storeDiagnostic(
        STORE_RULES.LIFECYCLE_PLAN_REJECTED,
        `Spec "${input.id}" is not tracked at HEAD. Cannot archive: blob_sha is the authoritative recovery target, and without it the archive event would have no recovery path. Commit the spec first (or run \`caws specs close <id>\` which auto-commits per CAWS-SPECS-WRITER-AUTOCOMMIT-001), then re-run archive.`,
        { subject: input.id, data: { from_path: fromRel } }
      )
    );
  }
  const sourceCommitSha = gitLastCommitForPath(repoRoot, fromRel);

  // Build the event payload in tombstone shape.
  const eventData: Record<string, unknown> = {
    from_path: fromRel,
    blob_sha: blobSha,
  };
  if (sourceCommitSha !== null) {
    eventData.source_commit_sha = sourceCommitSha;
  }
  const event: EventBody = {
    event: 'spec_archived',
    ts: now,
    actor: input.actor,
    spec_id: input.id,
    data: eventData,
  } as unknown as EventBody;

  // Pre-write dirty state on the path being deleted.
  const wasDirtyBeforeWrite = isPathDirty(repoRoot, fromRel);

  // The "fake plannedWrite" pattern: lifecycle-transaction's contract
  // is "write these files atomically and append these events." We have
  // no file to write, so we feed it an empty plannedWrites and append
  // the event only. The unlink happens AFTER txn success but BEFORE
  // autocommit, so the autocommit's `git add` stages the deletion.
  let unlinkOk = false;
  let unlinkError: string | null = null;

  const txnResult = withLifecycleLock(cawsDir, () => {
    const r = runLifecycleTransaction({
      cawsDir,
      plannedWrites: [],
      events: [event],
    });
    if (!r.ok) return r;
    if (r.value.kind !== 'success') return r;
    // Event appended. Now unlink the active path.
    try {
      fs.unlinkSync(fromPath);
      unlinkOk = true;
    } catch (e) {
      const cause = e as { message?: string };
      unlinkError = cause.message ?? 'unknown unlink error';
    }
    return r;
  });

  void input.reason;

  if (!txnResult.ok) {
    return err(txnResult.errors);
  }
  if (txnResult.value.kind !== 'success') {
    return ok({
      kind: 'partial_failure_recovered',
      cause: txnResult.value.cause,
    });
  }
  if (!unlinkOk) {
    return err(
      storeDiagnostic(
        STORE_RULES.LIFECYCLE_PARTIAL_FAILURE_UNRECOVERED,
        `spec_archived event appended (blob_sha=${blobSha}) but unlink of ${fromPath} failed (${unlinkError}). The body is recoverable via \`git show ${blobSha}\` but the active file still exists on disk.`,
        {
          subject: input.id,
          data: {
            from_path: fromPath,
            blob_sha: blobSha,
            recovery_instruction: `Manually remove ${fromPath}; the body is in git history at blob ${blobSha}.`,
          },
        }
      )
    );
  }

  // CAWS-SPECS-WRITER-AUTOCOMMIT-001: autoCommit the deletion. `git
  // add -- <fromRel>` stages a deletion when the file is gone, so the
  // resulting commit records the removal.
  const audit = autoCommit({
    repoRoot,
    paths: [fromRel],
    message: `chore(caws): archive ${input.id}`,
    wasDirtyBeforeWrite,
  });

  return ok({
    kind: 'success',
    id: input.id,
    path: fromPath,
    data: { audit_commit: audit },
  });
}

// ─── retireDraftSpec ─────────────────────────────────────────────────────
//
// CAWS-SPECS-RETIRE-DRAFT-001. Governed retirement of a never-activated
// DRAFT spec. Mirrors archiveSpec's tombstone flow exactly, with two
// differences: the precondition is lifecycle_state === 'draft' (not
// 'closed'), and the event is spec_retired (which DOES carry an optional
// reason, unlike spec_archived). No new lifecycle_state value — the
// spec_retired event is the durable signal, and the body is deleted +
// recoverable via `git show <blob_sha>`.

export function retireDraftSpec(
  cawsDir: string,
  input: RetireDraftSpecInput
): Result<SpecWriterOutcome> {
  const idValidation = validateSpecId(input.id);
  if (!idValidation.ok) return idValidation;

  const fromPath = specPath(cawsDir, input.id);
  if (!fs.existsSync(fromPath)) {
    return err(
      storeDiagnostic(
        STORE_RULES.LIFECYCLE_PLAN_REJECTED,
        `Spec "${input.id}" not found at ${fromPath}.`,
        { subject: input.id }
      )
    );
  }

  // Validate current state: must be draft. Active → close; closed → archive.
  const sourceResult = readYamlSource(fromPath);
  if (!isOk(sourceResult)) return err(sourceResult.errors);
  const parsed = parseAndValidateSpec(sourceResult.value);
  if (!isOk(parsed)) {
    return err(
      parsed.errors.map((d) =>
        storeDiagnostic(STORE_RULES.LIFECYCLE_PLAN_REJECTED, d.message, {
          subject: d.subject ?? input.id,
          // Thread the kernel diagnostic's narrowRepair through so the shell's
          // renderDiagnostics prints the `repair:` line. The kernel already
          // names the escape for the tier-contract gate ("Add at least one
          // contract or change risk_tier to 3 or mode to chore."); copying
          // only d.message silently discarded it, leaving a first-timer with a
          // bare "requires a contract" and no way forward.
          // (CAWS-SPEC-CREATE-FIRSTTIMER-UX-001 A1/A2)
          ...(d.narrowRepair !== undefined
            ? { narrowRepair: d.narrowRepair }
            : {}),
          data: { source_rule: d.rule },
        })
      )
    );
  }
  const spec = parsed.value;
  if (spec.lifecycle_state !== 'draft') {
    const alternative =
      spec.lifecycle_state === 'active'
        ? `Use \`caws specs close ${input.id}\` to close an active spec.`
        : spec.lifecycle_state === 'closed'
          ? `Use \`caws specs archive ${input.id}\` to archive a closed spec.`
          : `Only draft specs can be retired.`;
    return err(
      storeDiagnostic(
        STORE_RULES.LIFECYCLE_PLAN_REJECTED,
        `Spec "${input.id}" is in lifecycle_state "${spec.lifecycle_state}"; retire-draft only retires drafts. ${alternative}`,
        { subject: input.id, data: { current_state: spec.lifecycle_state } }
      )
    );
  }

  const now = (input.now ?? (() => new Date()))().toISOString();
  const repoRoot = repoRootFromCawsDir(cawsDir);
  const fromRel = path.relative(repoRoot, fromPath);

  // Capture blob_sha BEFORE any mutation — the authoritative recovery
  // target. Refuse if the draft is not tracked at HEAD (no recovery path),
  // mirroring archiveSpec's null-blob refusal.
  const blobSha = gitBlobShaAtHead(repoRoot, fromRel);
  if (blobSha === null) {
    return err(
      storeDiagnostic(
        STORE_RULES.LIFECYCLE_PLAN_REJECTED,
        `Spec "${input.id}" is not tracked at HEAD. Cannot retire: blob_sha is the authoritative recovery target, and without it the retirement event would have no recovery path. Commit the draft first, then re-run retire-draft.`,
        { subject: input.id, data: { from_path: fromRel } }
      )
    );
  }
  const sourceCommitSha = gitLastCommitForPath(repoRoot, fromRel);

  const eventData: Record<string, unknown> = {
    from_path: fromRel,
    blob_sha: blobSha,
  };
  if (sourceCommitSha !== null) {
    eventData.source_commit_sha = sourceCommitSha;
  }
  if (input.reason !== undefined && input.reason.length > 0) {
    eventData.reason = input.reason;
  }
  const event: EventBody = {
    event: 'spec_retired',
    ts: now,
    actor: input.actor,
    spec_id: input.id,
    data: eventData,
  } as unknown as EventBody;

  const wasDirtyBeforeWrite = isPathDirty(repoRoot, fromRel);

  let unlinkOk = false;
  let unlinkError: string | null = null;

  const txnResult = withLifecycleLock(cawsDir, () => {
    const r = runLifecycleTransaction({
      cawsDir,
      plannedWrites: [],
      events: [event],
    });
    if (!r.ok) return r;
    if (r.value.kind !== 'success') return r;
    try {
      fs.unlinkSync(fromPath);
      unlinkOk = true;
    } catch (e) {
      const cause = e as { message?: string };
      unlinkError = cause.message ?? 'unknown unlink error';
    }
    return r;
  });

  if (!txnResult.ok) {
    return err(txnResult.errors);
  }
  if (txnResult.value.kind !== 'success') {
    return ok({
      kind: 'partial_failure_recovered',
      cause: txnResult.value.cause,
    });
  }
  if (!unlinkOk) {
    return err(
      storeDiagnostic(
        STORE_RULES.LIFECYCLE_PARTIAL_FAILURE_UNRECOVERED,
        `spec_retired event appended (blob_sha=${blobSha}) but unlink of ${fromPath} failed (${unlinkError}). The body is recoverable via \`git show ${blobSha}\` but the draft file still exists on disk.`,
        {
          subject: input.id,
          data: {
            from_path: fromPath,
            blob_sha: blobSha,
            recovery_instruction: `Manually remove ${fromPath}; the body is in git history at blob ${blobSha}.`,
          },
        }
      )
    );
  }

  const audit = autoCommit({
    repoRoot,
    paths: [fromRel],
    message: `chore(caws): retire-draft ${input.id}`,
    wasDirtyBeforeWrite,
  });

  return ok({
    kind: 'success',
    id: input.id,
    path: fromPath,
    data: { audit_commit: audit },
  });
}

// ─── clearSpecBinding (PRUNE-REPAIR-WORKTREE-001) ────────────────────────
//
// H4 ghost-spec-binding / H3 dormant-spec-binding repair: clear a stale
// `worktree:` field from the canonical spec when the §1.4 matrix has decided the
// binding is dead (registry + git agree no live worktree, OR the spec is
// closed/archived). The h_class is supplied by the caller (doctor-determined);
// this writer does not re-classify — it executes the decided clear and appends
// one honest spec_binding_cleared audit event. It NEVER touches a git worktree.

export interface ClearSpecBindingInput {
  readonly id: string;
  /** The worktree name the stale worktree: field referenced (for the audit). */
  readonly clearedWorktreeName: string;
  /** Doctor-decided class. Closed enum on the event schema bars unauthorized classes. */
  readonly hClass: 'ghost_spec_binding' | 'dormant_spec_binding';
  readonly reason: string;
  readonly actor: EventBody['actor'];
  readonly now?: () => Date;
  readonly dryRun?: boolean;
}

export function clearSpecBinding(
  cawsDir: string,
  input: ClearSpecBindingInput
): Result<SpecWriterOutcome> {
  const idValidation = validateSpecId(input.id);
  if (!idValidation.ok) return idValidation;

  const targetPath = specPath(cawsDir, input.id);
  if (!fs.existsSync(targetPath)) {
    return err(
      storeDiagnostic(STORE_RULES.LIFECYCLE_PLAN_REJECTED, `Spec "${input.id}" not found at ${targetPath}.`, {
        subject: input.id,
      })
    );
  }
  const sourceResult = readYamlSource(targetPath);
  if (!isOk(sourceResult)) return err(sourceResult.errors);
  const originalBytes = sourceResult.value;

  // The clear is a no-op if there is no worktree: field — refuse rather than
  // append a misleading event for a spec that has nothing to clear.
  const cleared = removeTopLevelScalar(originalBytes, 'worktree');
  if (!isOk(cleared)) return err(cleared.errors);
  if (cleared.value === originalBytes) {
    return err(
      storeDiagnostic(
        STORE_RULES.LIFECYCLE_PLAN_REJECTED,
        `Spec "${input.id}" has no worktree: field to clear (nothing to repair).`,
        { subject: input.id }
      )
    );
  }

  const now = (input.now ?? (() => new Date()))().toISOString();
  const withUpdatedAt = setTopLevelScalar(cleared.value, 'updated_at', `'${now}'`);
  const newBytes = isOk(withUpdatedAt) ? withUpdatedAt.value : cleared.value;

  if (input.dryRun === true) {
    return ok({
      kind: 'success',
      id: input.id,
      path: targetPath,
      data: { audit_commit: { kind: 'skipped', reason: 'dry_run' } as unknown as AutoCommitOutcome },
    });
  }

  const event: EventBody = {
    event: 'spec_binding_cleared',
    ts: now,
    actor: input.actor,
    spec_id: input.id,
    data: {
      spec_id: input.id,
      cleared_worktree_name: input.clearedWorktreeName,
      h_class: input.hClass,
      reason: input.reason,
    },
  } as unknown as EventBody;

  const txnOutcome = withLifecycleLock(cawsDir, () =>
    runLifecycleTransaction({
      cawsDir,
      plannedWrites: [{ path: targetPath, contents: newBytes }],
      events: [event],
    })
  );

  if (!txnOutcome.ok) return err(txnOutcome.errors);
  if (txnOutcome.value.kind !== 'success') {
    return err(txnOutcome.value.cause);
  }
  // The lifecycle transaction (spec write + event) is the authoritative result.
  // The git audit-commit is a non-fatal nicety; defer it like the skipped path
  // rather than replicate autoCommit's repoRoot/dirty-capture machinery here —
  // the spec_binding_cleared event already records the repair in the audit chain.
  const audit = { kind: 'skipped', reason: 'deferred' } as unknown as AutoCommitOutcome;
  return ok({ kind: 'success', id: input.id, path: targetPath, data: { audit_commit: audit } });
}

// ─── amendScopeSpec (CAWS-SCOPE-AMEND-COMMAND-001) ───────────────────────
//
// Governed scope.in/scope.out amendment without an agent-issued cherry-pick.
// Mirrors activateSpec: load → parse+validate → lifecycle guard → patch →
// reparse-validate (validate-before-write) → spec_scope_amended event →
// lifecycle transaction → autoCommit. Writes ONLY canonical .caws/specs/<id>;
// scope reads resolve through canonical so a linked worktree sees the change
// immediately with no worktree-local copy.

/**
 * Ensure a `  <key>:` block header exists under the top-level `scope:` block,
 * inserting an empty one after the scope block's existing content if absent.
 * Used for `support`, which (unlike `in`/`out`) is never written by the spec
 * scaffold — so a first `--add-support` on a spec with no support key would
 * otherwise hit patchScopeSequence's null (key-not-found) path. Comment- and
 * formatting-preserving: only one header line is inserted. Returns the source
 * unchanged when the key already exists; null when `scope:` cannot be located.
 */
function ensureScopeKeyBlock(source: string, key: 'support'): string | null {
  const lines = source.split('\n');
  const scopeIdx = lines.findIndex((l) => /^scope:\s*$/.test(l));
  if (scopeIdx === -1) return null;

  // Already present? (2-space key under scope:, block or inline-empty form.)
  const keyRe = new RegExp(`^  ${key}:\\s*(\\[\\s*\\])?\\s*$`);
  let insertAt = scopeIdx + 1;
  for (let i = scopeIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) break;
    if (/^\S/.test(line)) break; // next top-level key ends the scope block
    if (keyRe.test(line)) return source; // already present
    insertAt = i + 1; // track the end of the scope block
  }

  const next = [...lines.slice(0, insertAt), `  ${key}:`, ...lines.slice(insertAt)];
  return next.join('\n');
}

/**
 * Line-surgical edit of a `scope.in:` / `scope.out:` / `scope.support:` YAML
 * sequence. Operates on the raw bytes so comments and unrelated formatting are
 * preserved — only list-item lines are inserted (append after the last existing
 * item under the key) or removed (drop the exact matching `- <path>` line).
 * `scope.out: []` inline-empty form is expanded to a block sequence on first add.
 *
 * Returns the new bytes, or null when the key block cannot be located.
 */
/**
 * Strip a single matching pair of surrounding YAML quotes from a scalar so
 * scope-sequence entries compare by logical value regardless of how they were
 * serialized. `'a/b.ts'` and `"a/b.ts"` both normalize to `a/b.ts`; a bare
 * `a/b.ts` is returned unchanged. Only an outermost matching pair is removed
 * (single XOR double) — interior quotes are left intact. This is the matcher
 * fix for CAWS-CLI-AMEND-SCOPE-REMOVE-OUT-QUOTED-NOOP-001: the scope kernel and
 * the parsed spec both see the unquoted value, so the line-surgical patcher
 * must too, or --remove/--remove-out/--remove-support silently no-op on a
 * quoted-on-disk entry while reporting success.
 */
function unquoteScalar(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === "'" && last === "'") || (first === '"' && last === '"')) {
      return value.slice(1, -1);
    }
  }
  return value;
}

function patchScopeSequence(
  source: string,
  key: 'in' | 'out' | 'support',
  add: readonly string[],
  remove: readonly string[]
): string | null {
  const lines = source.split('\n');
  // Find the `scope:` top-level line.
  const scopeIdx = lines.findIndex((l) => /^scope:\s*$/.test(l));
  if (scopeIdx === -1) return null;

  // Find the `  in:` / `  out:` line within the scope block (2-space indent).
  const keyRe = new RegExp(`^  ${key}:\\s*(\\[\\s*\\])?\\s*$`);
  let keyIdx = -1;
  for (let i = scopeIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) break;
    // Stop at the next top-level key (column 0, non-space).
    if (/^\S/.test(line)) break;
    if (keyRe.test(line)) {
      keyIdx = i;
      break;
    }
  }
  if (keyIdx === -1) return null;

  // Determine the item indent (4 spaces under a 2-space key) and collect the
  // contiguous run of item lines (`    - <path>`), allowing interleaved
  // comment lines at the same indent.
  const itemRe = /^ {4}- (.*)$/;
  let endIdx = keyIdx + 1;
  const presentPaths = new Set<string>();
  for (let i = keyIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) break;
    if (/^\S/.test(line)) break; // next top-level key
    // A 2-space key (e.g. `  out:`) ends the current key's block.
    if (/^ {2}\S/.test(line) && !/^ {4}/.test(line)) break;
    const m = itemRe.exec(line);
    // CAWS-CLI-AMEND-SCOPE-REMOVE-OUT-QUOTED-NOOP-001: compare the PARSED scalar
    // value, not the raw line text. Entries authored with surrounding quotes
    // ('a/b.ts' or "a/b.ts") must match an unquoted --add/--remove argument; a
    // raw-text comparison kept the quote characters and silently never matched,
    // so --remove-out reported success while the entry persisted.
    if (m && m[1] !== undefined) presentPaths.add(unquoteScalar(m[1].trim()));
    endIdx = i + 1;
  }

  // Remove matching item lines (quote-insensitive: the on-disk entry may be
  // bare or quoted, the caller supplies the bare logical path).
  const removeSet = new Set(remove.map((p) => unquoteScalar(p.trim())));
  let working = lines.filter((line, i) => {
    if (i < keyIdx + 1 || i >= endIdx) return true;
    const m = itemRe.exec(line);
    if (m && m[1] !== undefined && removeSet.has(unquoteScalar(m[1].trim()))) return false;
    return true;
  });

  // Recompute the key index + insertion point after removals.
  const newScopeIdx = working.findIndex((l) => /^scope:\s*$/.test(l));
  let newKeyIdx = -1;
  for (let i = newScopeIdx + 1; i < working.length; i++) {
    const line = working[i];
    if (line === undefined) break;
    if (/^\S/.test(line)) break;
    if (keyRe.test(line)) {
      newKeyIdx = i;
      break;
    }
  }
  if (newKeyIdx === -1) return null;

  // If the key was inline-empty (`out: []`), normalize to a block header.
  const keyLine = working[newKeyIdx];
  if (keyLine !== undefined && /\[\s*\]/.test(keyLine)) {
    working[newKeyIdx] = `  ${key}:`;
  }

  // Find the insertion point: after the last item line in the block.
  let insertAt = newKeyIdx + 1;
  for (let i = newKeyIdx + 1; i < working.length; i++) {
    const line = working[i];
    if (line === undefined) break;
    if (/^\S/.test(line)) break;
    if (/^ {2}\S/.test(line) && !/^ {4}/.test(line)) break;
    insertAt = i + 1;
  }

  // Append additions that are not already present (idempotent). Presence is
  // compared on the unquoted scalar so a path already stored in quoted form
  // ('a/b.ts') is not re-added as a bare duplicate
  // (CAWS-CLI-AMEND-SCOPE-REMOVE-OUT-QUOTED-NOOP-001).
  const toAdd = add
    .map((p) => p.trim())
    .filter((p) => p && !presentPaths.has(unquoteScalar(p)));
  if (toAdd.length > 0) {
    const newItems = toAdd.map((p) => `    - ${p}`);
    working = [...working.slice(0, insertAt), ...newItems, ...working.slice(insertAt)];
  }

  return working.join('\n');
}

export function amendScopeSpec(
  cawsDir: string,
  input: AmendScopeSpecInput
): Result<SpecWriterOutcome> {
  const idValidation = validateSpecId(input.id);
  if (!idValidation.ok) return idValidation;

  const targetPath = specPath(cawsDir, input.id);
  if (!fs.existsSync(targetPath)) {
    return err(
      storeDiagnostic(
        STORE_RULES.LIFECYCLE_PLAN_REJECTED,
        `Spec "${input.id}" not found at ${targetPath}.`,
        { subject: input.id }
      )
    );
  }

  const sourceResult = readYamlSource(targetPath);
  if (!isOk(sourceResult)) return err(sourceResult.errors);
  const originalBytes = sourceResult.value;
  const parsed = parseAndValidateSpec(originalBytes);
  if (!isOk(parsed)) {
    return err(
      parsed.errors.map((d) =>
        storeDiagnostic(STORE_RULES.LIFECYCLE_PLAN_REJECTED, d.message, {
          subject: d.subject ?? input.id,
          data: { source_rule: d.rule },
        })
      )
    );
  }
  const spec = parsed.value;

  // Lifecycle guard: amend only an active or draft spec. A closed/archived
  // spec's scope is frozen.
  if (spec.lifecycle_state !== 'active' && spec.lifecycle_state !== 'draft') {
    return err(
      storeDiagnostic(
        STORE_RULES.LIFECYCLE_PLAN_REJECTED,
        `Spec "${input.id}" is in lifecycle_state "${spec.lifecycle_state}"; amend-scope only amends active or draft specs (a closed/archived spec's scope is frozen).`,
        { subject: input.id, data: { current_state: spec.lifecycle_state } }
      )
    );
  }

  const beforeIn = Array.isArray(spec.scope?.in) ? [...spec.scope.in] : [];
  const beforeOut = Array.isArray(spec.scope?.out) ? [...spec.scope.out] : [];
  const beforeSupport = Array.isArray(spec.scope?.support) ? [...spec.scope.support] : [];

  const addIn = input.addIn ?? [];
  const removeIn = input.removeIn ?? [];
  const addOut = input.addOut ?? [];
  const removeOut = input.removeOut ?? [];
  const addSupport = input.addSupport ?? [];
  const removeSupport = input.removeSupport ?? [];

  if (
    addIn.length === 0 &&
    removeIn.length === 0 &&
    addOut.length === 0 &&
    removeOut.length === 0 &&
    addSupport.length === 0 &&
    removeSupport.length === 0
  ) {
    return err(
      storeDiagnostic(
        STORE_RULES.LIFECYCLE_PLAN_REJECTED,
        `amend-scope requires at least one of --add/--remove (in, out, or support) for spec "${input.id}".`,
        { subject: input.id }
      )
    );
  }

  // Patch scope.in then scope.out on the raw bytes (comment-preserving).
  let patched = originalBytes;
  if (addIn.length > 0 || removeIn.length > 0) {
    const r = patchScopeSequence(patched, 'in', addIn, removeIn);
    if (r === null) {
      return err(
        storeDiagnostic(
          STORE_RULES.LIFECYCLE_PLAN_REJECTED,
          `Could not locate the scope.in block in spec "${input.id}".`,
          { subject: input.id }
        )
      );
    }
    patched = r;
  }
  if (addOut.length > 0 || removeOut.length > 0) {
    const r = patchScopeSequence(patched, 'out', addOut, removeOut);
    if (r === null) {
      return err(
        storeDiagnostic(
          STORE_RULES.LIFECYCLE_PLAN_REJECTED,
          `Could not locate the scope.out block in spec "${input.id}".`,
          { subject: input.id }
        )
      );
    }
    patched = r;
  }
  if (addSupport.length > 0 || removeSupport.length > 0) {
    // support is never written by the scaffold; ensure the block exists before
    // patching so a first --add-support on a spec without it does not hit the
    // key-not-found null path (WORKTREE-SUPPORT-SCOPE-001).
    const ensured = ensureScopeKeyBlock(patched, 'support');
    if (ensured === null) {
      return err(
        storeDiagnostic(
          STORE_RULES.LIFECYCLE_PLAN_REJECTED,
          `Could not locate the scope block to add scope.support in spec "${input.id}".`,
          { subject: input.id }
        )
      );
    }
    const r = patchScopeSequence(ensured, 'support', addSupport, removeSupport);
    if (r === null) {
      return err(
        storeDiagnostic(
          STORE_RULES.LIFECYCLE_PLAN_REJECTED,
          `Could not locate the scope.support block in spec "${input.id}".`,
          { subject: input.id }
        )
      );
    }
    patched = r;
  }

  const now = (input.now ?? (() => new Date()))().toISOString();
  // Bump updated_at (present on every CLI-created spec; insert if absent).
  if (/^updated_at:/m.test(patched)) {
    const stepU = setTopLevelScalar(patched, 'updated_at', `'${now}'`);
    if (!stepU.ok) return err(stepU.errors);
    patched = stepU.value;
  } else {
    const anchor = /^created_at:/m.test(patched) ? 'created_at' : 'lifecycle_state';
    const stepU = insertTopLevelScalarAfter(patched, anchor, 'updated_at', `'${now}'`);
    if (!stepU.ok) return err(stepU.errors);
    patched = stepU.value;
  }

  // VALIDATE BEFORE WRITE: the amended spec must still satisfy the schema
  // (scope.in non-empty, scope.out no globs, etc.). Refuse with no write/event
  // if the result would be invalid.
  const reparsed = parseAndValidateSpec(patched);
  if (!isOk(reparsed)) {
    return err(
      reparsed.errors.map((d) =>
        storeDiagnostic(STORE_RULES.LIFECYCLE_PLAN_REJECTED, d.message, {
          subject: d.subject ?? input.id,
          data: { source_rule: d.rule, hint: 'amended-scope validation failed' },
        })
      )
    );
  }
  const after = reparsed.value;
  const afterIn = Array.isArray(after.scope?.in) ? [...after.scope.in] : [];
  const afterOut = Array.isArray(after.scope?.out) ? [...after.scope.out] : [];
  const afterSupport = Array.isArray(after.scope?.support) ? [...after.scope.support] : [];

  // Compute the actual deltas (idempotent ops produce empty deltas).
  const addedIn = afterIn.filter((p) => !beforeIn.includes(p));
  const removedIn = beforeIn.filter((p) => !afterIn.includes(p));
  const addedOut = afterOut.filter((p) => !beforeOut.includes(p));
  const removedOut = beforeOut.filter((p) => !afterOut.includes(p));
  const addedSupport = afterSupport.filter((p) => !beforeSupport.includes(p));
  const removedSupport = beforeSupport.filter((p) => !afterSupport.includes(p));

  const event: EventBody = {
    event: 'spec_scope_amended',
    ts: now,
    actor: input.actor,
    spec_id: input.id,
    data: {
      added_in: addedIn,
      removed_in: removedIn,
      added_out: addedOut,
      removed_out: removedOut,
      added_support: addedSupport,
      removed_support: removedSupport,
      resulting_scope_in: afterIn,
      resulting_scope_out: afterOut,
      resulting_scope_support: afterSupport,
    },
  } as unknown as EventBody;

  // WORKTREE-CLAIM-COMPOSE-WARN-001: warn (do not block) when a scope.in add
  // on a worktree-bound spec pulls in a repo-root-level deliverable — the
  // compose-trap shape (the path becomes worktree-claimed, so a main-checkout
  // edit then hard-blocks). Keyed off the ACTUAL added_in delta (idempotent
  // re-adds produce no delta → no warning) AND the spec's worktree binding.
  // A repo-root-level path is a bare filename with no "/" separator. Edits to
  // scope.support / scope.out / non-root scope.in paths do not trip it.
  const composeWarnings: string[] = [];
  const isWorktreeBound = typeof after.worktree === 'string' && after.worktree.length > 0;
  if (isWorktreeBound) {
    const rootDeliverables = addedIn.filter((p) => !p.includes('/'));
    for (const p of rootDeliverables) {
      composeWarnings.push(
        `'${p}' was added to scope.in of worktree-bound spec '${input.id}'. ` +
          `Because this spec is bound to a worktree, this repo-root path is now WORKTREE-CLAIMED — ` +
          `editing it from the main checkout will be HARD-BLOCKED by worktree-write-guard. ` +
          `If this is a deliverable you need to edit but NOT claim for the worktree (e.g. a friction log, ` +
          `a root README), prefer: caws specs amend-scope ${input.id} --remove ${p} --add-support ${p} ` +
          `(scope.support is editable but never worktree-claimed).`
      );
    }
  }

  const repoRoot = repoRootFromCawsDir(cawsDir);
  const wasDirtyBeforeWrite = isPathDirty(
    repoRoot,
    specRelPath(cawsDir, input.id, repoRoot)
  );

  const txnResult = withLifecycleLock(cawsDir, () =>
    runLifecycleTransaction({
      cawsDir,
      plannedWrites: [{ path: targetPath, contents: patched }],
      events: [event],
    })
  );
  if (!txnResult.ok) {
    return err(txnResult.errors);
  }
  const outcome = mapTxnToOutcome(txnResult.value, input.id, targetPath);
  const committed = attachAutoCommit(outcome, cawsDir, input.id, 'amend-scope', wasDirtyBeforeWrite);
  // Fold the advisory warnings into the success outcome (additive, non-blocking).
  if (composeWarnings.length > 0 && isOk(committed) && committed.value.kind === 'success') {
    return ok({ ...committed.value, warnings: composeWarnings });
  }
  return committed;
}

// ─── Outcome mapper ──────────────────────────────────────────────────────

function mapTxnToOutcome(
  result: LifecycleTransactionResult,
  id: string,
  targetPath: string
): Result<SpecWriterOutcome> {
  if (result.kind === 'success') {
    return ok({ kind: 'success', id, path: targetPath });
  }
  if (result.kind === 'partial_failure_recovered') {
    return ok({ kind: 'partial_failure_recovered', cause: result.cause });
  }
  // partial_failure_unrecovered: this should already have surfaced as
  // an Err from runLifecycleTransaction, but we map defensively.
  return err(
    storeDiagnostic(
      STORE_RULES.LIFECYCLE_PARTIAL_FAILURE_UNRECOVERED,
      `Spec "${id}" lifecycle transaction left partial state.`,
      {
        subject: id,
        data: {
          writes_completed: result.writesCompleted,
          rolled_back: result.rolledBack,
          rollback_failed: result.rollbackFailed,
          recovery_instruction: result.recoveryInstruction,
        },
      }
    )
  );
}

// ─── list / show helpers ────────────────────────────────────────────────

export interface SpecsListEntry {
  readonly id: string;
  readonly title: string;
  readonly lifecycle_state: string;
  readonly path: string;
}

/**
 * CAWS-ARCHIVE-AS-TOMBSTONE-001: archived entries do NOT have an
 * on-disk path post-tombstone. They are reconstructed from the event
 * log's spec_archived events. `blob_sha` is the recovery target;
 * `path` carries the from_path (where the spec was BEFORE archiving)
 * for human-readable identification.
 */
export interface ArchivedSpecsListEntry {
  readonly id: string;
  /**
   * Pre-archive from_path. For new-shape events, taken verbatim from
   * the event's from_path. For legacy events, the same field
   * (legacy events also carry from_path).
   */
  readonly path: string;
  readonly archived_at: string;
  /**
   * Blob sha of the spec body at archive time. `null` for legacy
   * events (pre-tombstone shape with no blob_sha); recovery in that
   * case uses git log --follow fallback.
   */
  readonly blob_sha: string | null;
}

export interface SpecsListResult {
  readonly active: readonly SpecsListEntry[];
  readonly archived: readonly ArchivedSpecsListEntry[];
}

/**
 * List specs by lifecycle state, optionally including archived ones.
 *
 * CAWS-ARCHIVE-AS-TOMBSTONE-001: the `--include-archived` path now
 * reads from `.caws/events.jsonl` (most recent spec_archived event
 * per spec_id), NOT from `.caws/specs/.archive/`. Post-tombstone the
 * .archive/ directory is not populated; reading it would either
 * surface nothing (steady state) or surface legacy bodies the
 * doctor warning already flags for migration.
 *
 * Includes legacy events (with only from_path + to_path, no
 * blob_sha) → blob_sha is reported as null; recover falls back to
 * git log --follow.
 *
 * Latest-write-wins per spec_id: if a spec was archived, recovered,
 * recreated, and re-archived, only the most recent spec_archived
 * event surfaces.
 */
export function listSpecs(
  cawsDir: string,
  options: { readonly includeArchived?: boolean } = {}
): Result<SpecsListResult> {
  const activeResult = loadSpecs(cawsDir);
  const active: SpecsListEntry[] = activeResult.specs.map((spec) => ({
    id: spec.id,
    title: spec.title,
    lifecycle_state: spec.lifecycle_state,
    path: specPath(cawsDir, spec.id),
  }));
  const activeIds = new Set(active.map((s) => s.id));

  let archived: ArchivedSpecsListEntry[] = [];
  if (options.includeArchived === true) {
    archived = readArchivedFromEventLog(cawsDir, activeIds);
  }
  return ok({ active, archived });
}

/**
 * Walk events.jsonl for spec_archived events; collect the most recent
 * one per spec_id; emit entries. Excludes any spec_id that has been
 * re-created since (presence in activeIds wins — that means the
 * archive was undone by a subsequent createSpec).
 */
function readArchivedFromEventLog(
  cawsDir: string,
  activeIds: ReadonlySet<string>
): ArchivedSpecsListEntry[] {
  const eventsPath = path.join(cawsDir, 'events.jsonl');
  if (!fs.existsSync(eventsPath)) return [];
  let raw: string;
  try {
    raw = fs.readFileSync(eventsPath, 'utf8');
  } catch {
    return [];
  }
  // Map: spec_id → most recent spec_archived event payload+ts.
  const latest = new Map<
    string,
    { ts: string; from_path: string; blob_sha: string | null }
  >();
  for (const line of raw.split('\n')) {
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      (parsed as { event?: unknown }).event !== 'spec_archived'
    ) {
      continue;
    }
    const evt = parsed as {
      ts?: string;
      spec_id?: string;
      data?: { from_path?: string; blob_sha?: string };
    };
    if (
      typeof evt.ts !== 'string' ||
      typeof evt.spec_id !== 'string' ||
      typeof evt.data !== 'object' ||
      evt.data === null ||
      typeof evt.data.from_path !== 'string'
    ) {
      continue;
    }
    latest.set(evt.spec_id, {
      ts: evt.ts,
      from_path: evt.data.from_path,
      blob_sha: typeof evt.data.blob_sha === 'string' ? evt.data.blob_sha : null,
    });
  }
  const out: ArchivedSpecsListEntry[] = [];
  for (const [specId, info] of latest) {
    if (activeIds.has(specId)) continue; // re-created after archive — active wins
    out.push({
      id: specId,
      path: info.from_path,
      archived_at: info.ts,
      blob_sha: info.blob_sha,
    });
  }
  // Stable sort: by id ascending.
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

/**
 * Find a spec by id in the ACTIVE location only
 * (.caws/specs/<id>.yaml). CAWS-ARCHIVE-AS-TOMBSTONE-001 invariant:
 * `caws specs show` defaults to active specs only. Archived specs
 * require explicit opt-in via `--archived` (which routes through
 * `recoverArchivedSpec` below).
 *
 * Pre-tombstone: showSpec searched both active AND .caws/specs/.archive/
 * transparently. That transparent fallback was a context-rot vector
 * (agents grep'd and cited stale specs as authority); it is removed
 * by design.
 */
export function showSpec(
  cawsDir: string,
  id: string
): Result<{ readonly spec: Spec; readonly path: string; readonly source: string }> {
  const idValidation = validateSpecId(id);
  if (!idValidation.ok) return idValidation;

  const activePath = specPath(cawsDir, id);
  if (!fs.existsSync(activePath)) {
    // Distinguish "never existed" from "exists but archived". The
    // event log tells us if there's a spec_archived event; if yes,
    // surface a typed diagnostic pointing the user at --archived /
    // recover. If no, the spec is genuinely unknown.
    const archived = findArchivedSpecEvent(cawsDir, id);
    if (archived !== null) {
      return err(
        storeDiagnostic(
          STORE_RULES.LIFECYCLE_PLAN_REJECTED,
          `Spec "${id}" is not in active specs. It was archived; to view its body, use \`caws specs show ${id} --archived\` or \`caws specs recover ${id}\`.`,
          {
            subject: id,
            data: {
              archived_at: archived.ts,
              blob_sha: archived.blob_sha,
              from_path: archived.from_path,
            },
          }
        )
      );
    }
    return err(
      storeDiagnostic(
        STORE_RULES.LIFECYCLE_PLAN_REJECTED,
        `Spec "${id}" not found in .caws/specs/.`,
        { subject: id }
      )
    );
  }
  const sourceResult = readYamlSource(activePath);
  if (!isOk(sourceResult)) return err(sourceResult.errors);
  const parsed = parseAndValidateSpec(sourceResult.value);
  if (!isOk(parsed)) return err(parsed.errors);
  return ok({ spec: parsed.value, path: activePath, source: sourceResult.value });
}

// ─── recoverArchivedSpec (CAWS-ARCHIVE-AS-TOMBSTONE-001 A2/A5) ──────────
//
// Resolves an archived spec's body via the event log + git blob_sha.
// Topology-independent: works on rebased histories, cherry-picks,
// shallow clones that have fetched the blob. NEVER mutates
// .caws/specs/. Returns the raw yaml bytes.

interface ArchivedSpecEvent {
  readonly ts: string;
  readonly from_path: string;
  readonly blob_sha: string | null; // null for legacy events with only to_path
  readonly to_path?: string; // present on legacy events only
}

/**
 * Walk .caws/events.jsonl, return the most recent spec_archived
 * event for the given spec_id, or null if none exists. Handles both
 * legacy (from_path + to_path) and tombstone (from_path + blob_sha)
 * shapes.
 *
 * "Most recent" semantics: events.jsonl is append-only; the LAST
 * matching event wins. If a spec was archived, recovered, recreated,
 * and re-archived, only the latest spec_archived is relevant for
 * recovery.
 */
function findArchivedSpecEvent(
  cawsDir: string,
  specId: string
): ArchivedSpecEvent | null {
  const eventsPath = path.join(cawsDir, 'events.jsonl');
  if (!fs.existsSync(eventsPath)) return null;
  let raw: string;
  try {
    raw = fs.readFileSync(eventsPath, 'utf8');
  } catch {
    return null;
  }
  let latest: ArchivedSpecEvent | null = null;
  for (const line of raw.split('\n')) {
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    // CAWS-SPECS-RETIRE-DRAFT-001 A5: recovery also resolves a retired
    // draft. spec_retired shares the identical {from_path, blob_sha}
    // tombstone shape as spec_archived, so the same git-show recovery
    // path reconstructs it. Accept either event type.
    const evtType = (parsed as { event?: unknown }).event;
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      (evtType !== 'spec_archived' && evtType !== 'spec_retired') ||
      (parsed as { spec_id?: unknown }).spec_id !== specId
    ) {
      continue;
    }
    const evt = parsed as {
      ts?: string;
      data?: { from_path?: string; blob_sha?: string; to_path?: string };
    };
    if (
      typeof evt.ts !== 'string' ||
      typeof evt.data !== 'object' ||
      evt.data === null ||
      typeof evt.data.from_path !== 'string'
    ) {
      continue;
    }
    latest = {
      ts: evt.ts,
      from_path: evt.data.from_path,
      blob_sha: typeof evt.data.blob_sha === 'string' ? evt.data.blob_sha : null,
      ...(typeof evt.data.to_path === 'string' ? { to_path: evt.data.to_path } : {}),
    };
  }
  return latest;
}

/**
 * Recover an archived spec's body from git history.
 *
 * Resolution order:
 *   1. New-shape event with blob_sha → `git show <blob_sha>`.
 *   2. Legacy event with to_path only → `git log --all --follow --
 *      <from_path>` to find a containing commit, then
 *      `git show <commit>:<from_path>`. If zero commits, Err.
 *
 * NEVER mutates .caws/specs/. Returns the raw yaml bytes.
 */
export function recoverArchivedSpec(
  cawsDir: string,
  id: string
): Result<{ readonly source: string; readonly blob_sha: string | null; readonly from_path: string }> {
  const idValidation = validateSpecId(id);
  if (!idValidation.ok) return idValidation;

  const evt = findArchivedSpecEvent(cawsDir, id);
  if (evt === null) {
    return err(
      storeDiagnostic(
        STORE_RULES.LIFECYCLE_PLAN_REJECTED,
        `Spec "${id}" was never archived (no spec_archived event in .caws/events.jsonl).`,
        { subject: id }
      )
    );
  }

  const repoRoot = repoRootFromCawsDir(cawsDir);

  // Tombstone shape: recover via blob_sha (topology-independent).
  if (evt.blob_sha !== null) {
    if (!/^[0-9a-f]{40}$/.test(evt.blob_sha)) {
      return err(
        storeDiagnostic(
          STORE_RULES.LIFECYCLE_PLAN_REJECTED,
          `spec_archived event for "${id}" has malformed blob_sha "${evt.blob_sha}" (expected 40-hex).`,
          { subject: id }
        )
      );
    }
    // trim:false preserves the spec yaml's trailing newline so the
    // recovered body is byte-identical to the pre-archive content.
    const body = runGitQuery(['show', evt.blob_sha], repoRoot, { trim: false });
    if (body === null) {
      return err(
        storeDiagnostic(
          STORE_RULES.LIFECYCLE_PLAN_REJECTED,
          `Blob ${evt.blob_sha} for spec "${id}" is not in the local git object store. Try \`git fetch --unshallow\` or \`git fetch --all\` if this is a shallow clone.`,
          { subject: id, data: { blob_sha: evt.blob_sha, from_path: evt.from_path } }
        )
      );
    }
    return ok({ source: body, blob_sha: evt.blob_sha, from_path: evt.from_path });
  }

  // Legacy shape: fall back to git log --follow on from_path. Walk
  // commits in newest-first order and pick the first one where the
  // file exists at from_path (skip deletion commits). The `git log
  // --follow` output includes BOTH commits where the file existed
  // and the commit that removed it; we want the first one before
  // the deletion.
  const commitListing = runGitQuery(
    ['log', '--all', '--follow', '--format=%H', '--', evt.from_path],
    repoRoot
  );
  if (commitListing === null || commitListing.length === 0) {
    return err(
      storeDiagnostic(
        STORE_RULES.LIFECYCLE_PLAN_REJECTED,
        `Spec "${id}" is a legacy archive (event has no blob_sha) and no commit on the current branch contains "${evt.from_path}". The body is unrecoverable from this clone.`,
        { subject: id, data: { from_path: evt.from_path } }
      )
    );
  }
  const commits = commitListing
    .split('\n')
    .map((c) => c.trim())
    .filter((c) => /^[0-9a-f]{40}$/.test(c));
  if (commits.length === 0) {
    return err(
      storeDiagnostic(
        STORE_RULES.LIFECYCLE_PLAN_REJECTED,
        `git log returned no valid commit shas for "${evt.from_path}".`,
        { subject: id }
      )
    );
  }
  // Walk newest-first; pick the first commit where the file blob
  // exists at from_path. trim:false preserves trailing newlines.
  for (const commit of commits) {
    const body = runGitQuery(
      ['show', `${commit}:${evt.from_path}`],
      repoRoot,
      { trim: false }
    );
    if (body !== null) {
      return ok({ source: body, blob_sha: null, from_path: evt.from_path });
    }
  }
  return err(
    storeDiagnostic(
      STORE_RULES.LIFECYCLE_PLAN_REJECTED,
      `Spec "${id}" is a legacy archive; git log --follow returned ${commits.length} commits referencing "${evt.from_path}" but none contained the file body (all were deletion commits or renames). Body unrecoverable from this clone.`,
      { subject: id, data: { from_path: evt.from_path, candidates: commits.length } }
    )
  );
}

// ─── pruneArchive (CAWS-ARCHIVE-AS-TOMBSTONE-001 A8/A9) ─────────────────
//
// Migrates legacy .caws/specs/.archive/<id>.yaml bodies. For each
// legacy archive body:
//   - If git history contains the file at from_path on the current
//     branch → mark recoverable + would remove from working tree.
//   - If git history does NOT contain it → mark unrecoverable + would
//     quarantine to .caws/specs/.archive/.unrecoverable/<id>.yaml.
//
// Dry-run by default; --apply executes. The prove-recovery-or-
// quarantine invariant is absolute: there is NO override flag that
// would let prune delete an unrecoverable body. The only way to lose
// an unrecoverable body is a manual rm outside CAWS.
//
// On --apply, emits one spec_archive_pruned event per id describing
// the action taken (removed or quarantined).

export type PruneArchivePlan =
  | {
      readonly id: string;
      readonly fromPath: string;
      readonly fromRel: string;
      readonly status: 'recoverable';
      readonly blob_sha: string;
      readonly commit_sha: string;
    }
  | {
      readonly id: string;
      readonly fromPath: string;
      readonly fromRel: string;
      readonly status: 'unrecoverable';
      readonly reason: string;
    };

export interface PruneArchiveResult {
  readonly plans: ReadonlyArray<PruneArchivePlan>;
  readonly applied: boolean;
  readonly events_appended: number;
}

export interface PruneArchiveInput {
  readonly apply?: boolean;
  readonly actor: EventBody['actor'];
  readonly now?: () => Date;
}

/**
 * Scan .caws/specs/.archive/ for legacy bodies. Returns per-id status
 * (dry-run) or executes the migration (--apply).
 *
 * Recoverability check: `git log --all --follow -- <fromPath>`. If
 * any commit contains the file, the body is recoverable from git
 * history; we extract the blob_sha + most-recent containing commit
 * and that becomes the recovery target. If zero commits, the body
 * is local-only and gets quarantined.
 */
export function pruneArchive(
  cawsDir: string,
  input: PruneArchiveInput
): Result<PruneArchiveResult> {
  const archiveDir = path.join(cawsDir, 'specs', '.archive');
  if (!fs.existsSync(archiveDir)) {
    // No legacy archive to prune; succeed with empty plan.
    return ok({ plans: [], applied: input.apply === true, events_appended: 0 });
  }

  const repoRoot = repoRootFromCawsDir(cawsDir);
  const apply = input.apply === true;
  const now = (input.now ?? (() => new Date()))().toISOString();

  // Enumerate yaml files at the top of .archive/, excluding the
  // .unrecoverable/ subdir (which is the destination, not a source).
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(archiveDir, { withFileTypes: true });
  } catch (e) {
    return err(
      storeDiagnostic(
        STORE_RULES.LIFECYCLE_PLAN_REJECTED,
        `Failed to read ${archiveDir}: ${(e as Error).message}`,
        { subject: archiveDir }
      )
    );
  }

  const plans: PruneArchivePlan[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.yaml') && !entry.name.endsWith('.yml')) continue;
    const id = entry.name.replace(/\.ya?ml$/, '');
    const fromPath = path.join(archiveDir, entry.name);
    // The legacy archive bodies' from_path (where the spec was BEFORE
    // archiving) is .caws/specs/<id>.yaml — that's what git log
    // --follow searches.
    const activeRel = path.relative(repoRoot, specPath(cawsDir, id));

    // Find any commit that contained the file at activeRel.
    const commitListing = runGitQuery(
      ['log', '--all', '--follow', '--format=%H', '--', activeRel],
      repoRoot
    );
    if (commitListing === null || commitListing.length === 0) {
      plans.push({
        id,
        fromPath,
        fromRel: path.relative(repoRoot, fromPath),
        status: 'unrecoverable',
        reason: `git log --all --follow -- ${activeRel} returned no commits`,
      });
      continue;
    }
    // Walk commits newest-first; pick the first one where the blob
    // actually exists at activeRel (skip deletion commits).
    let recovered: { commit: string; blob: string } | null = null;
    for (const commit of commitListing.split('\n')) {
      const c = commit.trim();
      if (!/^[0-9a-f]{40}$/.test(c)) continue;
      const lsTree = runGitQuery(['ls-tree', c, '--', activeRel], repoRoot);
      if (lsTree === null || lsTree.length === 0) continue;
      const blobParts = lsTree.split(/\s+/);
      if (blobParts.length < 3) continue;
      const sha = blobParts[2];
      if (sha !== undefined && /^[0-9a-f]{40}$/.test(sha)) {
        recovered = { commit: c, blob: sha };
        break;
      }
    }
    if (recovered === null) {
      plans.push({
        id,
        fromPath,
        fromRel: path.relative(repoRoot, fromPath),
        status: 'unrecoverable',
        reason: `git log returned commits but none contained the blob at ${activeRel}`,
      });
    } else {
      plans.push({
        id,
        fromPath,
        fromRel: path.relative(repoRoot, fromPath),
        status: 'recoverable',
        blob_sha: recovered.blob,
        commit_sha: recovered.commit,
      });
    }
  }

  if (!apply) {
    return ok({ plans, applied: false, events_appended: 0 });
  }

  // --apply: execute the migration. For each plan:
  //   recoverable   → fs.unlinkSync(fromPath) + emit removed event
  //   unrecoverable → fs.renameSync to .unrecoverable/<id>.yaml + emit
  //                   quarantined event
  // Quarantine dir is created lazily on first unrecoverable.
  const unrecoverableDir = path.join(archiveDir, '.unrecoverable');
  let eventsAppended = 0;
  for (const plan of plans) {
    if (plan.status === 'recoverable') {
      try {
        fs.unlinkSync(plan.fromPath);
      } catch (e) {
        // Best-effort: surface as Err but allow event-append to skip.
        // The plan reported the intent; the operator can inspect.
        return err(
          storeDiagnostic(
            STORE_RULES.LIFECYCLE_PARTIAL_FAILURE_UNRECOVERED,
            `Failed to unlink ${plan.fromPath}: ${(e as Error).message}`,
            { subject: plan.id }
          )
        );
      }
      const event: EventBody = {
        event: 'spec_archive_pruned',
        ts: now,
        actor: input.actor,
        spec_id: plan.id,
        data: {
          from_path: plan.fromRel,
          action: 'removed',
          blob_sha: plan.blob_sha,
          from_commit_sha: plan.commit_sha,
        },
      } as unknown as EventBody;
      const txn = withLifecycleLock(cawsDir, () =>
        runLifecycleTransaction({
          cawsDir,
          plannedWrites: [],
          events: [event],
        })
      );
      if (!txn.ok) return err(txn.errors);
      if (txn.value.kind !== 'success') {
        return ok({
          plans,
          applied: true,
          events_appended: eventsAppended,
        });
      }
      eventsAppended++;
    } else {
      try {
        fs.mkdirSync(unrecoverableDir, { recursive: true });
      } catch (e) {
        return err(
          storeDiagnostic(
            STORE_RULES.LIFECYCLE_WRITE_FAILED,
            `Failed to create quarantine dir ${unrecoverableDir}: ${(e as Error).message}`,
            { subject: unrecoverableDir }
          )
        );
      }
      const toPath = path.join(unrecoverableDir, path.basename(plan.fromPath));
      const toRel = path.relative(repoRoot, toPath);
      try {
        fs.renameSync(plan.fromPath, toPath);
      } catch (e) {
        return err(
          storeDiagnostic(
            STORE_RULES.LIFECYCLE_PARTIAL_FAILURE_UNRECOVERED,
            `Failed to quarantine ${plan.fromPath} → ${toPath}: ${(e as Error).message}`,
            { subject: plan.id }
          )
        );
      }
      const event: EventBody = {
        event: 'spec_archive_pruned',
        ts: now,
        actor: input.actor,
        spec_id: plan.id,
        data: {
          from_path: plan.fromRel,
          action: 'quarantined',
          to_path: toRel,
        },
      } as unknown as EventBody;
      const txn = withLifecycleLock(cawsDir, () =>
        runLifecycleTransaction({
          cawsDir,
          plannedWrites: [],
          events: [event],
        })
      );
      if (!txn.ok) return err(txn.errors);
      if (txn.value.kind !== 'success') {
        return ok({
          plans,
          applied: true,
          events_appended: eventsAppended,
        });
      }
      eventsAppended++;
    }
  }

  return ok({ plans, applied: true, events_appended: eventsAppended });
}

// Re-export appendEvent type for downstream tests that want to inject.
export type { EventBody };
// Unused import elimination: surface appendEvent so future direct-event
// flows (if any) compile against the same surface as evidence/waiver.
void appendEvent;
