// Spec lifecycle writer.
//
// CLI-SPECS-001: store-layer mutations for spec lifecycle. Composes
// lifecycle-transaction + yaml-patch + appendEvent into typed lifecycle
// operations:
//
//   createSpec  — write a new .caws/specs/<id>.yaml (active) + spec_created
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

import { appendEvent } from './events-store';
import {
  runLifecycleTransaction,
  type LifecycleTransactionResult,
} from './lifecycle-transaction';
import { withLifecycleLock } from './lifecycle-lock';
import { storeDiagnostic } from './repo-root';
import { STORE_RULES } from './rules';
import { loadSpecs } from './specs-store';
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
}

export interface ArchiveSpecInput {
  readonly id: string;
  readonly reason?: string;
  readonly now?: () => Date;
  readonly actor: EventBody['actor'];
}

export type SpecWriterOutcome =
  | { readonly kind: 'success'; readonly id: string; readonly path: string }
  | {
      readonly kind: 'partial_failure_recovered';
      readonly cause: readonly Diagnostic[];
    };

// ─── Path helpers ────────────────────────────────────────────────────────

function specPath(cawsDir: string, id: string): string {
  return path.join(cawsDir, 'specs', `${id}.yaml`);
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
    `    - 'TODO: list the file(s) or directories this spec authorizes.'`,
    `  out: []`,
    `invariants:`,
    `  - 'TODO: describe one invariant this spec guarantees.'`,
    `acceptance:`,
    `  - id: A1`,
    `    given: 'TODO'`,
    `    when: 'TODO'`,
    `    then: 'TODO'`,
    `non_functional: {}`,
    `contracts: []`,
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
  return mapTxnToOutcome(txnResult.value, input.id, targetPath);
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
    // Check archive too — if it's already archived, this is a different
    // kind of error than "not found."
    const archived = archivedSpecPath(cawsDir, input.id);
    if (fs.existsSync(archived)) {
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
      const step3 = setTopLevelScalar(patched, 'closure_notes', escaped);
      if (!step3.ok) return err(step3.errors);
      patched = step3.value;
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

  const step4 = setTopLevelScalar(patched, 'updated_at', `'${now}'`);
  if (!step4.ok) return err(step4.errors);
  patched = step4.value;

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
  return mapTxnToOutcome(txnResult.value, input.id, targetPath);
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
  const toPath = archivedSpecPath(cawsDir, input.id);

  // Patch lifecycle_state → archived and bump updated_at on a copy.
  let patched = originalBytes;
  const s1 = setTopLevelScalar(patched, 'lifecycle_state', 'archived');
  if (!s1.ok) return err(s1.errors);
  patched = s1.value;
  const s2 = setTopLevelScalar(patched, 'updated_at', `'${now}'`);
  if (!s2.ok) return err(s2.errors);
  patched = s2.value;

  // Validate.
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

  // Ensure the archive dir exists. fs.renameSync requires it.
  try {
    fs.mkdirSync(path.dirname(toPath), { recursive: true });
  } catch (e) {
    const cause = e as { message?: string };
    return err(
      storeDiagnostic(
        STORE_RULES.LIFECYCLE_WRITE_FAILED,
        `Failed to create archive directory: ${cause.message ?? 'unknown'}.`,
        { subject: path.dirname(toPath) }
      )
    );
  }

  // Filesystem-move pattern: we write the patched bytes to the new
  // path via the transaction, then delete the source. The transaction
  // doesn't model moves natively, so we do this in two phases inside
  // the same lock:
  //   1. lifecycle-transaction: write toPath + append spec_archived
  //   2. AFTER transaction success: unlink fromPath
  //
  // If step 2 fails, we surface the partial-failure but the audit log
  // already records the move intent. The next doctor pass will see
  // the spec in BOTH locations and surface that as a doctor finding.

  const fromRel = path.relative(path.join(cawsDir, '..'), fromPath);
  const toRel = path.relative(path.join(cawsDir, '..'), toPath);
  const event: EventBody = {
    event: 'spec_archived',
    ts: now,
    actor: input.actor,
    spec_id: input.id,
    data: { from_path: fromRel, to_path: toRel },
  } as unknown as EventBody;

  // Capture original bytes so we can roll back the unlink in
  // emergencies (rare but worth tracking).
  let unlinkOk = false;
  let unlinkError: string | null = null;

  const txnResult = withLifecycleLock(cawsDir, () => {
    const r = runLifecycleTransaction({
      cawsDir,
      plannedWrites: [{ path: toPath, contents: patched }],
      events: [event],
    });
    if (!r.ok) return r;
    if (r.value.kind !== 'success') return r;
    // Transaction wrote toPath + appended event. Now remove fromPath.
    try {
      fs.unlinkSync(fromPath);
      unlinkOk = true;
    } catch (e) {
      const cause = e as { message?: string };
      unlinkError = cause.message ?? 'unknown unlink error';
    }
    return r;
  });

  // Reason flows into closure_notes ONLY if the user passed one; archive
  // event schema does NOT take closure_notes, but we attach the reason
  // to a follow-up evidence record path in future versions. For v11.1
  // archive, we accept the --reason for parity with close but the
  // schema does not carry it.
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
        `Archive write succeeded and spec_archived event appended, but original file unlink failed (${unlinkError}). Spec now exists in BOTH active and archived locations.`,
        {
          subject: input.id,
          data: {
            from_path: fromPath,
            to_path: toPath,
            recovery_instruction: `Manually remove ${fromPath} once you've confirmed ${toPath} is intact.`,
          },
        }
      )
    );
  }

  return ok({ kind: 'success', id: input.id, path: toPath });
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

export interface SpecsListResult {
  readonly active: readonly SpecsListEntry[];
  readonly archived: readonly SpecsListEntry[];
}

/** List specs by lifecycle state, optionally including archived ones. */
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

  const archived: SpecsListEntry[] = [];
  if (options.includeArchived === true) {
    const archiveDir = path.join(cawsDir, 'specs', '.archive');
    if (fs.existsSync(archiveDir)) {
      try {
        const entries = fs.readdirSync(archiveDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isFile()) continue;
          if (!entry.name.endsWith('.yaml') && !entry.name.endsWith('.yml')) continue;
          const fullPath = path.join(archiveDir, entry.name);
          const src = readYamlSource(fullPath);
          if (!isOk(src)) continue;
          const parsed = parseAndValidateSpec(src.value);
          if (!isOk(parsed)) continue;
          const spec = parsed.value as Spec;
          archived.push({
            id: spec.id,
            title: spec.title,
            lifecycle_state: spec.lifecycle_state,
            path: fullPath,
          });
        }
      } catch {
        // Best-effort archive listing.
      }
    }
  }
  return ok({ active, archived });
}

/** Find a spec by id under active or archive locations. */
export function showSpec(
  cawsDir: string,
  id: string
): Result<{ readonly spec: Spec; readonly path: string; readonly source: string }> {
  const idValidation = validateSpecId(id);
  if (!idValidation.ok) return idValidation;

  const fullPath = findSpecPath(cawsDir, id);
  if (fullPath === null) {
    return err(
      storeDiagnostic(
        STORE_RULES.LIFECYCLE_PLAN_REJECTED,
        `Spec "${id}" not found in .caws/specs/ or .caws/specs/.archive/.`,
        { subject: id }
      )
    );
  }
  const sourceResult = readYamlSource(fullPath);
  if (!isOk(sourceResult)) return err(sourceResult.errors);
  const parsed = parseAndValidateSpec(sourceResult.value);
  if (!isOk(parsed)) return err(parsed.errors);
  return ok({ spec: parsed.value, path: fullPath, source: sourceResult.value });
}

// Re-export appendEvent type for downstream tests that want to inject.
export type { EventBody };
// Unused import elimination: surface appendEvent so future direct-event
// flows (if any) compile against the same surface as evidence/waiver.
void appendEvent;
