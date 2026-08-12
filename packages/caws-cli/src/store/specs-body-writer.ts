// specs-body-writer — governed amendment of a spec's blast_radius.modules and
// invariants (`caws specs amend`).
//
// WHY THIS EXISTS
//
// Both fields are REQUIRED non-empty by spec.v1.json, so `caws specs create`
// has to emit a value for them. Until the create flags landed there was no
// flag to supply one, so the renderer emitted a scaffolded default — and no
// command could replace it afterwards. The create flags fix that going
// forward and do nothing for the specs that already exist; measured in this
// repo at the time of writing, 12 spec files carried the scaffolded default,
// 7 of them closed. Their only discharge route was a hand edit of the YAML,
// which bypasses the audit trail the spec files exist to provide.
//
// WHY IT LIVES IN ITS OWN MODULE
//
// specs-writer.ts is already past the god-object threshold. A new lifecycle
// writer belongs beside it, not inside it.
//
// THE CLOSED-SPEC RULE
//
// A closed spec is an audit record of concluded work. Allowing free edits to
// it would turn this command into a retroactive-rewrite tool, which is worse
// than the defect it fixes. So the permission is asymmetric and narrow:
// filling an entry that is still the scaffolded default is admitted; removing
// or rewriting a substantive entry is refused. You may fill a blank; you may
// never rewrite a claim.

import * as fs from 'fs';
import * as path from 'path';

import {
  err,
  isOk,
  ok,
  parseAndValidateSpec,
  type EventBody,
  type Result,
} from '../kernel';
import { autoCommit, isPathDirty } from './git-autocommit';
import { runLifecycleTransaction, type LifecycleTransactionResult } from './lifecycle-transaction';
import { withLifecycleLock } from './lifecycle-lock';
import { repoRootFromCawsDir, storeDiagnostic, validateSpecId } from './repo-root';
import { STORE_RULES } from './rules';
import {
  INVARIANTS_PLACEHOLDER,
  MODULES_PLACEHOLDER,
  isScaffoldPlaceholder,
  type SpecWriterOutcome,
} from './specs-writer';
import { readYamlSource } from './yaml-store';

export interface AmendSpecBodyInput {
  readonly id: string;
  readonly addModules?: readonly string[];
  readonly removeModules?: readonly string[];
  readonly addInvariants?: readonly string[];
  readonly removeInvariants?: readonly string[];
  readonly now?: () => Date;
  readonly actor: EventBody['actor'];
}

/** Field descriptors: where each amendable sequence lives in the YAML. */
interface SequenceSite {
  /** Parent mapping key, or null for a top-level sequence. */
  readonly parent: string | null;
  readonly key: string;
  /** Indent of the `- item` lines. */
  readonly itemIndent: number;
  /** Dotted name used in diagnostics and the event. */
  readonly label: 'blast_radius.modules' | 'invariants';
  readonly scaffold: string;
}

const MODULES_SITE: SequenceSite = {
  parent: 'blast_radius',
  key: 'modules',
  itemIndent: 4,
  label: 'blast_radius.modules',
  scaffold: MODULES_PLACEHOLDER,
};

const INVARIANTS_SITE: SequenceSite = {
  parent: null,
  key: 'invariants',
  itemIndent: 2,
  label: 'invariants',
  scaffold: INVARIANTS_PLACEHOLDER,
};

function specPath(cawsDir: string, id: string): string {
  return path.join(cawsDir, 'specs', `${id}.yaml`);
}

function archivedSpecPath(cawsDir: string, id: string): string {
  return path.join(cawsDir, 'specs', '.archive', `${id}.yaml`);
}

/**
 * Strip surrounding quotes so an on-disk entry authored as 'a/b' matches a
 * bare --remove argument. Mirrors the fix behind
 * CAWS-CLI-AMEND-SCOPE-REMOVE-OUT-QUOTED-NOOP-001, where a raw-text comparison
 * kept the quote characters, never matched, and reported success while the
 * entry persisted.
 */
function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === "'" && last === "'") || (first === '"' && last === '"')) {
      return trimmed.slice(1, -1).replace(/''/g, "'");
    }
  }
  return trimmed;
}

function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

interface SequenceBlock {
  readonly keyIdx: number;
  readonly endIdx: number;
  readonly items: string[];
}

/**
 * Locate the contiguous item run for a sequence, returning null when the block
 * cannot be found. Returning null rather than guessing matters: a silent
 * mislocation would write items into the wrong field.
 */
function locateSequence(lines: readonly string[], site: SequenceSite): SequenceBlock | null {
  let searchStart = 0;
  if (site.parent !== null) {
    const parentIdx = lines.findIndex((l) => new RegExp(`^${site.parent}:\\s*$`).test(l));
    if (parentIdx === -1) return null;
    searchStart = parentIdx + 1;
  }

  const keyIndent = site.itemIndent - 2;
  const keyRe = new RegExp(`^ {${keyIndent}}${site.key}:\\s*$`);
  let keyIdx = -1;
  for (let i = searchStart; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined) break;
    // A top-level key ends a nested parent's block.
    if (site.parent !== null && /^\S/.test(line)) break;
    if (keyRe.test(line)) {
      keyIdx = i;
      break;
    }
  }
  if (keyIdx === -1) return null;

  const itemRe = new RegExp(`^ {${site.itemIndent}}- (.*)$`);
  const items: string[] = [];
  let endIdx = keyIdx + 1;
  for (let i = keyIdx + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined) break;
    if (/^\S/.test(line)) break;
    // A shallower key ends this sequence.
    if (new RegExp(`^ {0,${keyIndent}}\\S`).test(line)) break;
    const m = itemRe.exec(line);
    if (m === null) break;
    if (m[1] !== undefined) items.push(unquote(m[1]));
    endIdx = i + 1;
  }
  return { keyIdx, endIdx, items };
}

interface SequencePatch {
  readonly lines: string[];
  readonly added: string[];
  readonly removed: string[];
  readonly dischargedScaffold: boolean;
  readonly resulting: string[];
}

/**
 * Rewrite one sequence block. Adds append; removes match on the parsed scalar.
 * Adding to a field whose only entry is the scaffolded default REPLACES that
 * entry rather than appending beside it — an operator filling in a blank does
 * not want to keep the blank, and leaving it would defeat the whole purpose.
 */
function patchSequence(
  lines: readonly string[],
  site: SequenceSite,
  add: readonly string[],
  remove: readonly string[]
): SequencePatch | null {
  const block = locateSequence(lines, site);
  if (block === null) return null;

  const removeSet = new Set(remove.map(unquote));
  const onlyScaffold =
    block.items.length === 1 && block.items[0] !== undefined && block.items[0] === site.scaffold;
  const dischargedScaffold = onlyScaffold && add.length > 0;

  const kept = block.items.filter((item) => {
    if (removeSet.has(item)) return false;
    // The scaffolded default is displaced by real content, never kept beside it.
    if (dischargedScaffold && item === site.scaffold) return false;
    return true;
  });
  const removed = block.items.filter((item) => removeSet.has(item));

  const existing = new Set(kept);
  const added = add.map(unquote).filter((v) => !existing.has(v));
  const resulting = [...kept, ...added];

  const pad = ' '.repeat(site.itemIndent);
  const rendered = resulting.map((v) => `${pad}- ${quote(v)}`);
  const next = [
    ...lines.slice(0, block.keyIdx + 1),
    ...rendered,
    ...lines.slice(block.endIdx),
  ];
  return { lines: next, added, removed, dischargedScaffold, resulting };
}

function mapTxnToOutcome(
  result: LifecycleTransactionResult,
  id: string,
  targetPath: string
): Result<SpecWriterOutcome> {
  if (result.kind === 'success') return ok({ kind: 'success', id, path: targetPath });
  if (result.kind === 'partial_failure_recovered') {
    return ok({ kind: 'partial_failure_recovered', cause: result.cause });
  }
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
        },
      }
    )
  );
}

export function amendSpecBody(
  cawsDir: string,
  input: AmendSpecBodyInput
): Result<SpecWriterOutcome> {
  const idValidation = validateSpecId(input.id);
  if (!idValidation.ok) return idValidation;

  const addModules = input.addModules ?? [];
  const removeModules = input.removeModules ?? [];
  const addInvariants = input.addInvariants ?? [];
  const removeInvariants = input.removeInvariants ?? [];
  if (
    addModules.length === 0 &&
    removeModules.length === 0 &&
    addInvariants.length === 0 &&
    removeInvariants.length === 0
  ) {
    return err(
      storeDiagnostic(
        STORE_RULES.LIFECYCLE_PLAN_REJECTED,
        `caws specs amend requires at least one of --add-module/--remove-module/--add-invariant/--remove-invariant for spec "${input.id}".`,
        { subject: input.id }
      )
    );
  }

  const targetPath = specPath(cawsDir, input.id);
  if (!fs.existsSync(targetPath)) {
    if (fs.existsSync(archivedSpecPath(cawsDir, input.id))) {
      return err(
        storeDiagnostic(
          STORE_RULES.LIFECYCLE_PLAN_REJECTED,
          `Spec "${input.id}" is archived; an archived body is a tombstone and amend will not rewrite it.`,
          {
            subject: input.id,
            narrowRepair: `If it must change, bring it back first: \`caws specs restore ${input.id} --apply\`, then \`caws specs amend ${input.id}\`.`,
          }
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
  const state = spec.lifecycle_state;

  if (state !== 'draft' && state !== 'active' && state !== 'closed') {
    return err(
      storeDiagnostic(
        STORE_RULES.LIFECYCLE_PLAN_REJECTED,
        `Spec "${input.id}" is ${state}; amend operates on draft, active, or closed specs.`,
        { subject: input.id, data: { lifecycle_state: state } }
      )
    );
  }

  let lines = originalBytes.split('\n');

  const modulesResult = patchSequence(lines, MODULES_SITE, addModules, removeModules);
  if (modulesResult === null) {
    return err(
      storeDiagnostic(
        STORE_RULES.LIFECYCLE_PLAN_REJECTED,
        `Could not locate the blast_radius.modules block in spec "${input.id}".`,
        { subject: input.id }
      )
    );
  }
  lines = modulesResult.lines;

  const invariantsResult = patchSequence(lines, INVARIANTS_SITE, addInvariants, removeInvariants);
  if (invariantsResult === null) {
    return err(
      storeDiagnostic(
        STORE_RULES.LIFECYCLE_PLAN_REJECTED,
        `Could not locate the invariants block in spec "${input.id}".`,
        { subject: input.id }
      )
    );
  }
  lines = invariantsResult.lines;

  // The closed-spec rule. Everything this amendment did to a closed spec must
  // be a scaffold discharge; anything else is a retroactive rewrite of a
  // concluded record and is refused with nothing written.
  if (state === 'closed') {
    const rewrote: string[] = [];
    for (const [result, site] of [
      [modulesResult, MODULES_SITE],
      [invariantsResult, INVARIANTS_SITE],
    ] as const) {
      const removedSubstantive = result.removed.some((v) => !isScaffoldPlaceholder(v));
      const addedWithoutDischarge = result.added.length > 0 && !result.dischargedScaffold;
      if (removedSubstantive || addedWithoutDischarge) rewrote.push(site.label);
    }
    if (rewrote.length > 0) {
      return err(
        storeDiagnostic(
          STORE_RULES.LIFECYCLE_PLAN_REJECTED,
          `Spec "${input.id}" is closed, so amend may only fill a field still holding its scaffolded default. Refusing to rewrite: ${rewrote.join(', ')}.`,
          {
            subject: input.id,
            narrowRepair:
              `A closed spec is the audit record of concluded work — filling a blank is a correction, rewriting a claim is not. ` +
              `If the spec's content genuinely must change, reopen it first: \`caws specs reopen ${input.id}\`.`,
            data: { lifecycle_state: state, refused_fields: rewrote },
          }
        )
      );
    }
  }

  const patched = lines.join('\n');
  if (patched === originalBytes) {
    return err(
      storeDiagnostic(
        STORE_RULES.LIFECYCLE_PLAN_REJECTED,
        `No change: spec "${input.id}" already matches the requested amendment.`,
        { subject: input.id }
      )
    );
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

  const discharged = [
    ...(modulesResult.dischargedScaffold ? [MODULES_SITE.label] : []),
    ...(invariantsResult.dischargedScaffold ? [INVARIANTS_SITE.label] : []),
  ];
  const now = (input.now ?? (() => new Date()))().toISOString();
  const event: EventBody = {
    event: 'spec_body_amended',
    ts: now,
    actor: input.actor,
    spec_id: input.id,
    data: {
      ...(modulesResult.added.length > 0 ? { added_modules: modulesResult.added } : {}),
      ...(modulesResult.removed.length > 0 ? { removed_modules: modulesResult.removed } : {}),
      ...(invariantsResult.added.length > 0 ? { added_invariants: invariantsResult.added } : {}),
      ...(invariantsResult.removed.length > 0
        ? { removed_invariants: invariantsResult.removed }
        : {}),
      ...(discharged.length > 0 ? { discharged_scaffold_fields: discharged } : {}),
      previous_lifecycle_state: state,
      resulting_modules: modulesResult.resulting,
      resulting_invariants: invariantsResult.resulting,
    },
  } as unknown as EventBody;

  const repoRoot = repoRootFromCawsDir(cawsDir);
  const relPath = path.relative(repoRoot, targetPath);
  const wasDirtyBeforeWrite = isPathDirty(repoRoot, relPath);

  const txnResult = withLifecycleLock(cawsDir, () =>
    runLifecycleTransaction({
      cawsDir,
      plannedWrites: [{ path: targetPath, contents: patched }],
      events: [event],
    })
  );
  if (!txnResult.ok) return err(txnResult.errors);

  const outcome = mapTxnToOutcome(txnResult.value, input.id, targetPath);
  if (!isOk(outcome) || outcome.value.kind !== 'success') return outcome;

  const audit = autoCommit({
    repoRoot,
    paths: [relPath],
    message: `chore(caws): amend ${input.id}`,
    wasDirtyBeforeWrite,
  });
  return ok({
    ...outcome.value,
    data: { ...(outcome.value.data ?? {}), audit_commit: audit },
  });
}
