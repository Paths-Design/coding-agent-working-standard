// specs-body-writer — governed amendment of a spec's body via
// `caws specs amend`: blast_radius.modules, invariants, and (since
// CAWS-SPEC-AMEND-ACCEPTANCE-001) acceptance criteria.
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
// never rewrite a claim. Acceptance criteria are the sharpest case — they are
// the claims the close gate adjudicates — so an AC amendment on a closed spec
// admits only the full scaffold discharge, and only when the criterion carries
// no evidence entry (a closed spec's evidence is frozen).
//
// THE EVIDENCE COUPLING (why AC amendment is not just another field edit)
//
// The spec's `evidence:` block is the close gate's closure authority, keyed by
// criterion id. A recorded pass proves the TEXT THAT EXISTED when it was
// recorded. Rewriting a criterion's text therefore invalidates that proof by
// construction: this writer resets the criterion's evidence entry to
// `unchecked` in the same transaction and records the discarded status on the
// event, so closure can never proceed over evidence that proved text which no
// longer exists. Removing a criterion deletes its evidence entry outright (an
// evidence entry whose criterion_id matches no declared AC is rejected by
// semantic validation, so removal and evidence deletion are one write).

import * as fs from 'fs';
import * as path from 'path';

import {
  err,
  isOk,
  ok,
  parseAndValidateSpec,
  type EventBody,
  type EvidenceStatus,
  type Result,
} from '../kernel';
import { autoCommit, isPathDirty } from './git-autocommit';
import { runLifecycleTransaction, type LifecycleTransactionResult } from './lifecycle-transaction';
import { withLifecycleLock } from './lifecycle-lock';
import { repoRootFromCawsDir, storeDiagnostic, validateSpecId } from './repo-root';
import { STORE_RULES } from './rules';
import {
  ACCEPTANCE_PLACEHOLDER,
  INVARIANTS_PLACEHOLDER,
  MODULES_PLACEHOLDER,
  deleteEvidenceEntry,
  isScaffoldPlaceholder,
  patchEvidenceBlock,
  type SpecWriterOutcome,
} from './specs-writer';
import { readYamlSource } from './yaml-store';

export interface AmendSpecBodyInput {
  readonly id: string;
  readonly addModules?: readonly string[];
  readonly removeModules?: readonly string[];
  readonly addInvariants?: readonly string[];
  readonly removeInvariants?: readonly string[];
  /** Rewrite given/when/then of this EXISTING criterion (typo-guarded). */
  readonly setAc?: string;
  /** Append a new criterion with this id (refuses an existing id). */
  readonly addAc?: string;
  /** Remove this criterion and its evidence entry. */
  readonly removeAc?: string;
  /** Criterion field values; with --set-ac at least one is required, with
   * --add-ac all three. Fields not supplied to --set-ac keep their text. */
  readonly acGiven?: string;
  readonly acWhen?: string;
  readonly acThen?: string;
  /** Optional operator rationale, recorded verbatim on spec_body_amended. */
  readonly reason?: string;
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

/**
 * One sequence entry as it lives on disk. Scalars round-trip through
 * quote()/unquote(); folded entries (`- >-` + deeper-indented continuation
 * lines) are preserved VERBATIM — the writer never re-flows prose it did
 * not author. `entryLogical()` is the whitespace-collapsed text used for
 * --remove matching and event payloads.
 */
interface SequenceEntry {
  readonly scalar?: string;
  readonly foldedLines?: readonly string[];
}

function foldedLogical(lines: readonly string[]): string {
  // lines[0] is the `- >-` marker item line; the logical text is the
  // continuation lines only, whitespace-collapsed.
  return lines
    .slice(1)
    .map((l) => l.trim())
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function entryLogical(e: SequenceEntry): string {
  if (e.scalar !== undefined) return e.scalar;
  if (e.foldedLines !== undefined) return foldedLogical(e.foldedLines);
  return '';
}

interface SequenceBlock {
  readonly keyIdx: number;
  readonly endIdx: number;
  readonly entries: readonly SequenceEntry[];
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
  // A folded item's continuation lines are indented MORE than itemIndent.
  const contRe = new RegExp(`^ {${site.itemIndent + 2},}\\S`);
  // CANONICAL-DRIFT-GUARDS-001: `- >-` (and `>`, `|`, `|-`) opens a folded
  // block whose continuation lines are part of the entry. The prior scanner
  // treated the marker as a scalar item and stopped before the
  // continuations, so any rewrite spliced rendered items mid-fold —
  // "bad indentation of a sequence entry" — and silently DROPPED the folded
  // prose. Folded entries are now captured verbatim and re-emitted
  // unchanged; --remove matches their whitespace-collapsed logical text.
  const foldedMarkerRe = /^(>-|>|\|-|\|)$/;
  const entries: SequenceEntry[] = [];
  let endIdx = keyIdx + 1;
  let i = keyIdx + 1;
  while (i < lines.length) {
    const line = lines[i];
    if (line === undefined) break;
    if (/^\S/.test(line)) break;
    // A shallower key ends this sequence.
    if (new RegExp(`^ {0,${keyIndent}}\\S`).test(line)) break;
    const m = itemRe.exec(line);
    if (m === null) break;
    const captured = (m[1] ?? '').trim();
    if (foldedMarkerRe.test(captured)) {
      const foldedLines: string[] = [line];
      let j = i + 1;
      while (j < lines.length) {
        const cont = lines[j];
        if (cont === undefined || !contRe.test(cont)) break;
        foldedLines.push(cont);
        j += 1;
      }
      entries.push({ foldedLines });
      endIdx = j;
      i = j;
      continue;
    }
    entries.push({ scalar: unquote(m[1] ?? '') });
    endIdx = i + 1;
    i += 1;
  }
  return { keyIdx, endIdx, entries };
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
  const firstLogical =
    block.entries[0] !== undefined ? entryLogical(block.entries[0]) : undefined;
  const onlyScaffold =
    block.entries.length === 1 && firstLogical !== undefined && firstLogical === site.scaffold;
  const dischargedScaffold = onlyScaffold && add.length > 0;

  const kept: SequenceEntry[] = [];
  const removed: string[] = [];
  for (const e of block.entries) {
    const logical = entryLogical(e);
    if (removeSet.has(logical)) {
      removed.push(logical);
      continue;
    }
    // The scaffolded default is displaced by real content, never kept beside it.
    if (dischargedScaffold && logical === site.scaffold) continue;
    kept.push(e);
  }

  const existing = new Set(kept.map(entryLogical));
  const added = add.map(unquote).filter((v) => !existing.has(v));
  const resulting = [...kept.map(entryLogical), ...added];

  const pad = ' '.repeat(site.itemIndent);
  const rendered: string[] = [];
  for (const e of kept) {
    if (e.foldedLines !== undefined) {
      rendered.push(...e.foldedLines); // verbatim — never re-flowed
    } else if (e.scalar !== undefined) {
      rendered.push(`${pad}- ${quote(e.scalar)}`);
    }
  }
  for (const v of added) {
    rendered.push(`${pad}- ${quote(v)}`);
  }
  const next = [
    ...lines.slice(0, block.keyIdx + 1),
    ...rendered,
    ...lines.slice(block.endIdx),
  ];
  return { lines: next, added, removed, dischargedScaffold, resulting };
}

// --- Acceptance criteria (CAWS-SPEC-AMEND-ACCEPTANCE-001) -------------------

type AcField = 'given' | 'when' | 'then';
const AC_FIELDS: readonly AcField[] = ['given', 'when', 'then'];
const AC_ID_PATTERN = /^A\d+$/;
// Single-quoted inline scalars stay readable; longer claims fold.
const AC_INLINE_MAX = 100;
const AC_WRAP_WIDTH = 78;

/**
 * The resolved acceptance amendment, decided against the PARSED spec before
 * any byte is patched, so every semantic refusal writes nothing.
 */
interface AcAmendmentPlan {
  readonly op: 'set' | 'add' | 'remove';
  readonly id: string;
  /** For 'set': only the fields whose collapsed text actually differs. */
  readonly setFields?: Partial<Record<AcField, string>>;
  /** For 'add': the full new criterion. */
  readonly added?: {
    readonly id: string;
    readonly given: string;
    readonly when: string;
    readonly then: string;
  };
  /** For 'remove': the criterion as it stands before removal (event payload). */
  readonly removedBefore?: {
    readonly id: string;
    readonly given: string;
    readonly when: string;
    readonly then: string;
  };
  /** True when a closed spec's full scaffold discharge is being performed. */
  readonly scaffoldDischarge: boolean;
}

function collapseAcText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Flag-shape validation only — no file access, no lifecycle knowledge.
 * Returns the refusal message, or null when the shape is coherent.
 */
function validateAcFlagShape(
  input: AmendSpecBodyInput,
  acTargets: readonly string[],
  acFieldCount: number
): string | null {
  if (acTargets.length > 1) {
    return (
      '--set-ac/--add-ac/--remove-ac are mutually exclusive — exactly one acceptance op per ' +
      `invocation (got set=${input.setAc ?? '—'}, add=${input.addAc ?? '—'}, remove=${input.removeAc ?? '—'}).`
    );
  }
  const target = acTargets[0];
  if (target === undefined) {
    if (acFieldCount > 0) {
      return (
        '--given/--when/--then require an acceptance target: pass --set-ac <id> to rewrite an ' +
        'existing criterion, or --add-ac <id> to declare a new one.'
      );
    }
    return null;
  }
  if (!AC_ID_PATTERN.test(target)) {
    return (
      `Acceptance criterion id "${target}" must match A<digits> (e.g. A1, A12) — the spec schema ` +
      'constrains acceptance[].id to ^A\\d+$.'
    );
  }
  if (input.setAc !== undefined && acFieldCount === 0) {
    return (
      `--set-ac ${target} needs at least one of --given/--when/--then to state the new text; ` +
      'fields not supplied keep their current wording.'
    );
  }
  if (input.addAc !== undefined && acFieldCount !== 3) {
    return (
      `--add-ac ${target} needs all three of --given/--when/--then — a new criterion must state ` +
      'its whole claim (the schema requires given/when/then, minLength 1).'
    );
  }
  for (const [flag, value] of [
    ['--given', input.acGiven],
    ['--when', input.acWhen],
    ['--then', input.acThen],
  ] as const) {
    if (value !== undefined && collapseAcText(value) === '') {
      return `${flag} was supplied but is empty; a criterion field must be non-empty (schema minLength 1).`;
    }
  }
  return null;
}

interface AcceptanceBlock {
  readonly keyIdx: number;
  readonly blockEnd: number;
  /** Entry id → [start, end) line span (end exclusive). */
  readonly entries: ReadonlyArray<{ id: string; start: number; end: number }>;
}

/**
 * Locate the top-level `acceptance:` block and each `  - id:` entry's line
 * span. Entries end at the next entry, the next top-level key, or EOF.
 * Returns null when the block cannot be found — fail closed, never guess
 * (mirrors locateSequence).
 */
function locateAcceptanceBlock(lines: readonly string[]): AcceptanceBlock | null {
  const keyIdx = lines.findIndex((l) => /^acceptance:\s*(\[\s*\])?\s*$/.test(l));
  if (keyIdx === -1) return null;
  let blockEnd = lines.length;
  for (let i = keyIdx + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i] ?? '')) {
      blockEnd = i;
      break;
    }
  }
  const starts: Array<{ id: string; line: number }> = [];
  for (let i = keyIdx + 1; i < blockEnd; i++) {
    const m = /^  - id:\s*(.+?)\s*$/.exec(lines[i] ?? '');
    if (m && m[1] !== undefined) starts.push({ id: unquote(m[1]), line: i });
  }
  const entries = starts.map((s, k) => ({
    id: s.id,
    start: s.line,
    end: k + 1 < starts.length ? starts[k + 1]!.line : blockEnd,
  }));
  return { keyIdx, blockEnd, entries };
}

const AC_FIELD_RE = /^    (given|when|then):(.*)$/;
// `>-`, `>`, `|-`, `|` plus chomping/indent indicators.
const AC_FOLDED_MARKER_RE = /^[|>][+-0-9]*$/;

/**
 * Render one criterion field value: short text becomes a single-quoted inline
 * scalar; longer claims fold (`>-`, continuation indent 6) word-wrapped.
 * Text is collapsed first — a criterion claim is prose, not layout.
 */
function renderAcFieldValue(field: AcField, value: string): string[] {
  const text = collapseAcText(value);
  if (text.length <= AC_INLINE_MAX) {
    return [`    ${field}: ${quote(text)}`];
  }
  const words = text.split(' ');
  const wrapped: string[] = [];
  let current = '';
  for (const w of words) {
    if (current !== '' && current.length + 1 + w.length > AC_WRAP_WIDTH) {
      wrapped.push(current);
      current = w;
    } else {
      current = current === '' ? w : `${current} ${w}`;
    }
  }
  if (current !== '') wrapped.push(current);
  return [`    ${field}: >-`, ...wrapped.map((w) => `      ${w}`)];
}

function renderAcEntry(ac: {
  id: string;
  given: string;
  when: string;
  then: string;
}): string[] {
  return [
    `  - id: ${ac.id}`,
    ...renderAcFieldValue('given', ac.given),
    ...renderAcFieldValue('when', ac.when),
    ...renderAcFieldValue('then', ac.then),
  ];
}

/**
 * Replace one given/when/then value inside an acceptance entry, preserving
 * every other byte of the entry (sibling fields, comments, key order).
 * Inline scalars are swapped in place; folded blocks have their continuation
 * lines consumed and re-rendered. Returns null when the field line cannot be
 * found in the entry — fail closed, never guess.
 */
function replaceAcField(
  lines: readonly string[],
  entry: { readonly start: number; readonly end: number },
  field: AcField,
  value: string
): string[] | null {
  for (let i = entry.start + 1; i < entry.end; i++) {
    const line = lines[i] ?? '';
    const m = AC_FIELD_RE.exec(line);
    if (m === null || (m[1] ?? '') !== field) continue;
    const inline = (m[2] ?? '').trim();
    const rendered = renderAcFieldValue(field, value);
    if (AC_FOLDED_MARKER_RE.test(inline)) {
      // Consume the folded continuation lines (indent > 4) up to the next
      // key at indent 4 or the entry's end.
      let j = i + 1;
      while (j < entry.end) {
        const cont = lines[j] ?? '';
        if (/^ {4}\S/.test(cont) || /^ {0,3}\S/.test(cont)) break;
        j++;
      }
      return [...lines.slice(0, i), ...rendered, ...lines.slice(j)];
    }
    return [...lines.slice(0, i), ...rendered, ...lines.slice(i + 1)];
  }
  return null;
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

  // --- Acceptance-criteria flag shape (CAWS-SPEC-AMEND-ACCEPTANCE-001) ----
  // Exactly one AC op per invocation; --set-ac takes >=1 of --given/--when/
  // --then (unspecified fields keep their text); --add-ac requires all three;
  // bare --given/--when/--then without a target is refused.
  const acTargets = [input.setAc, input.addAc, input.removeAc].filter(
    (v): v is string => v !== undefined
  );
  const acFieldCount = [input.acGiven, input.acWhen, input.acThen].filter(
    (v) => v !== undefined
  ).length;
  const hasModuleOps =
    addModules.length > 0 ||
    removeModules.length > 0 ||
    addInvariants.length > 0 ||
    removeInvariants.length > 0;

  const acFlagError = validateAcFlagShape(input, acTargets, acFieldCount);
  if (acFlagError !== null) {
    return err(storeDiagnostic(STORE_RULES.LIFECYCLE_PLAN_REJECTED, acFlagError, { subject: input.id }));
  }
  if (acTargets.length === 0 && !hasModuleOps) {
    return err(
      storeDiagnostic(
        STORE_RULES.LIFECYCLE_PLAN_REJECTED,
        `caws specs amend requires at least one of --add-module/--remove-module/--add-invariant/--remove-invariant, or an acceptance op (--set-ac/--add-ac/--remove-ac), for spec "${input.id}".`,
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

  // --- Acceptance target resolution (against the PARSED spec) -------------
  // Every refusal here happens before any byte is patched: a refused amend
  // writes nothing — no bytes, no event, no commit.
  const acceptance = spec.acceptance;
  let acPlan: AcAmendmentPlan | null = null;
  const acTarget = input.setAc ?? input.addAc ?? input.removeAc;
  if (acTarget !== undefined) {
    const existing = acceptance.find((a) => a.id === acTarget);
    if (input.addAc !== undefined && existing !== undefined) {
      return err(
        storeDiagnostic(
          STORE_RULES.LIFECYCLE_PLAN_REJECTED,
          `Criterion ${acTarget} already exists on spec "${input.id}" — --add-ac never overwrites. Rewrite it with --set-ac ${acTarget}.`,
          { subject: input.id, data: { criterion_id: acTarget } }
        )
      );
    }
    if (input.addAc === undefined && existing === undefined) {
      const declared = acceptance.map((a) => a.id).join(', ');
      return err(
        storeDiagnostic(
          STORE_RULES.LIFECYCLE_PLAN_REJECTED,
          `No criterion ${acTarget} on spec "${input.id}" (declared: ${declared || 'none'}).` +
            (input.setAc !== undefined
              ? ` Declare it first with --add-ac ${acTarget}.`
              : ' Nothing to remove.'),
          { subject: input.id, data: { criterion_id: acTarget } }
        )
      );
    }
    if (input.removeAc !== undefined && acceptance.length === 1) {
      return err(
        storeDiagnostic(
          STORE_RULES.LIFECYCLE_PLAN_REJECTED,
          `Criterion ${acTarget} is the only acceptance criterion on spec "${input.id}" — the schema requires at least one (acceptance minItems 1). Amend its text with --set-ac instead of removing it.`,
          { subject: input.id, data: { criterion_id: acTarget } }
        )
      );
    }
    if (state === 'closed') {
      if (input.addAc !== undefined || input.removeAc !== undefined) {
        return err(
          storeDiagnostic(
            STORE_RULES.LIFECYCLE_PLAN_REJECTED,
            `Spec "${input.id}" is closed: adding or removing an acceptance criterion rewrites the concluded record.`,
            {
              subject: input.id,
              narrowRepair: `Reopen it first: \`caws specs reopen ${input.id}\`.`,
              data: { lifecycle_state: state, criterion_id: acTarget },
            }
          )
        );
      }
      // --set-ac on a closed spec: only the FULL scaffold discharge of a
      // criterion whose given/when/then are all still the create placeholder,
      // and only while the criterion carries no evidence entry (a closed
      // spec's evidence is frozen; repairing a mis-proven criterion means
      // reopening the spec).
      const fullScaffold =
        existing?.given === ACCEPTANCE_PLACEHOLDER &&
        existing?.when === ACCEPTANCE_PLACEHOLDER &&
        existing?.then === ACCEPTANCE_PLACEHOLDER;
      const allThree =
        input.acGiven !== undefined && input.acWhen !== undefined && input.acThen !== undefined;
      const hasEvidence = (spec.evidence ?? []).some((e) => e.criterion_id === acTarget);
      if (!fullScaffold || !allThree || hasEvidence) {
        return err(
          storeDiagnostic(
            STORE_RULES.LIFECYCLE_PLAN_REJECTED,
            `Spec "${input.id}" is closed, so --set-ac may only fill criterion ${acTarget} while it still holds its create scaffold ` +
              `(given/when/then all "${ACCEPTANCE_PLACEHOLDER}", all three supplied, no recorded evidence).` +
              (hasEvidence
                ? ' This criterion carries a recorded evidence entry, which a closed spec freezes.'
                : ''),
            {
              subject: input.id,
              narrowRepair: `Rewriting a concluded claim needs \`caws specs reopen ${input.id}\` first.`,
              data: { lifecycle_state: state, criterion_id: acTarget },
            }
          )
        );
      }
      acPlan = {
        op: 'set',
        id: acTarget,
        setFields: { given: input.acGiven, when: input.acWhen, then: input.acThen },
        scaffoldDischarge: true,
      };
    } else if (input.setAc !== undefined) {
      // Partial update: only fields whose collapsed text actually differs
      // (so an exact re-supply does not reset evidence it did not change).
      const setFields: Partial<Record<AcField, string>> = {};
      if (
        input.acGiven !== undefined &&
        collapseAcText(input.acGiven) !== collapseAcText(existing?.given ?? '')
      ) {
        setFields.given = input.acGiven;
      }
      if (
        input.acWhen !== undefined &&
        collapseAcText(input.acWhen) !== collapseAcText(existing?.when ?? '')
      ) {
        setFields.when = input.acWhen;
      }
      if (
        input.acThen !== undefined &&
        collapseAcText(input.acThen) !== collapseAcText(existing?.then ?? '')
      ) {
        setFields.then = input.acThen;
      }
      if (Object.keys(setFields).length === 0 && !hasModuleOps) {
        return err(
          storeDiagnostic(
            STORE_RULES.LIFECYCLE_PLAN_REJECTED,
            `No change: criterion ${acTarget} on spec "${input.id}" already carries the supplied text.`,
            { subject: input.id, data: { criterion_id: acTarget } }
          )
        );
      }
      acPlan = { op: 'set', id: acTarget, setFields, scaffoldDischarge: false };
    } else if (input.addAc !== undefined) {
      acPlan = {
        op: 'add',
        id: acTarget,
        added: {
          id: acTarget,
          given: input.acGiven ?? '',
          when: input.acWhen ?? '',
          then: input.acThen ?? '',
        },
        scaffoldDischarge: false,
      };
    } else {
      acPlan = {
        op: 'remove',
        id: acTarget,
        removedBefore: {
          id: acTarget,
          given: existing?.given ?? '',
          when: existing?.when ?? '',
          then: existing?.then ?? '',
        },
        scaffoldDischarge: false,
      };
    }
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

  // --- Acceptance-criteria amendment (byte surgery) ------------------------
  let resetEvidence: Array<{ criterion_id: string; previous_status: EvidenceStatus }> = [];
  let removedEvidence: Array<{ criterion_id: string; previous_status: EvidenceStatus }> = [];
  if (acPlan !== null) {
    const block = locateAcceptanceBlock(originalBytes.split('\n'));
    if (block === null) {
      return err(
        storeDiagnostic(
          STORE_RULES.LIFECYCLE_PLAN_REJECTED,
          `Could not locate the acceptance block in spec "${input.id}".`,
          { subject: input.id }
        )
      );
    }
    if (acPlan.op === 'set') {
      const entry = block.entries.find((e) => e.id === acPlan.id);
      if (entry === undefined) {
        return err(
          storeDiagnostic(
            STORE_RULES.LIFECYCLE_PLAN_REJECTED,
            `Could not locate criterion ${acPlan.id} in the acceptance block of spec "${input.id}" although the parsed spec declares it; refusing to guess at the byte level.`,
            { subject: input.id, data: { criterion_id: acPlan.id } }
          )
        );
      }
      for (const field of AC_FIELDS) {
        const value = acPlan.setFields?.[field];
        if (value === undefined) continue;
        const next = replaceAcField(lines, entry, field, value);
        if (next === null) {
          return err(
            storeDiagnostic(
              STORE_RULES.LIFECYCLE_PLAN_REJECTED,
              `Could not locate the ${field} field of criterion ${acPlan.id} in spec "${input.id}".`,
              { subject: input.id, data: { criterion_id: acPlan.id, field } }
            )
          );
        }
        lines = next;
      }
    } else if (acPlan.op === 'add') {
      const rendered = renderAcEntry(acPlan.added!);
      // Normalize an inline-empty `acceptance: []` key before appending.
      const normalized = lines.map((l, i) =>
        i === block.keyIdx && /\[\s*\]/.test(l) ? 'acceptance:' : l
      );
      lines = [
        ...normalized.slice(0, block.blockEnd),
        ...rendered,
        ...normalized.slice(block.blockEnd),
      ];
    } else {
      const entry = block.entries.find((e) => e.id === acPlan.id);
      if (entry === undefined) {
        return err(
          storeDiagnostic(
            STORE_RULES.LIFECYCLE_PLAN_REJECTED,
            `Could not locate criterion ${acPlan.id} in the acceptance block of spec "${input.id}" although the parsed spec declares it; refusing to guess at the byte level.`,
            { subject: input.id, data: { criterion_id: acPlan.id } }
          )
        );
      }
      lines = [...lines.slice(0, entry.start), ...lines.slice(entry.end)];
    }

    // Evidence coupling: a recorded status proved the PREVIOUS text. A
    // rewritten criterion has its entry reset to `unchecked` in the same
    // transaction (evidence_ref, waiver_reason, command, nodeid — all the
    // proof of the old claim — dropped with it); a removed criterion has its
    // entry deleted outright (an orphaned criterion_id is rejected by
    // semantic validation, so removal and evidence deletion are one write).
    const priorEvidence = (spec.evidence ?? []).find((e) => e.criterion_id === acPlan.id);
    if (priorEvidence !== undefined && acPlan.op === 'set') {
      resetEvidence = [{ criterion_id: acPlan.id, previous_status: priorEvidence.status }];
    }
    if (priorEvidence !== undefined && acPlan.op === 'remove') {
      removedEvidence = [{ criterion_id: acPlan.id, previous_status: priorEvidence.status }];
    }
  }

  const now = (input.now ?? (() => new Date()))().toISOString();
  let patched = lines.join('\n');
  if (resetEvidence.length > 0) {
    const reset = resetEvidence[0]!;
    const next = patchEvidenceBlock(patched, {
      criterion_id: reset.criterion_id,
      status: 'unchecked',
      recorded_at: now,
    });
    if (next === null) {
      return err(
        storeDiagnostic(
          STORE_RULES.LIFECYCLE_PLAN_REJECTED,
          `Could not upsert the evidence entry for criterion ${reset.criterion_id} in spec "${input.id}".`,
          { subject: input.id, data: { criterion_id: reset.criterion_id } }
        )
      );
    }
    patched = next;
  }
  if (removedEvidence.length > 0) {
    patched = deleteEvidenceEntry(patched, removedEvidence[0]!.criterion_id).bytes;
  }

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
    ...(acPlan?.scaffoldDischarge === true ? ['acceptance'] : []),
  ];
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
      ...(acPlan?.op === 'set' &&
      acPlan.setFields !== undefined &&
      Object.keys(acPlan.setFields).length > 0
        ? {
            set_acceptance: [
              {
                id: acPlan.id,
                fields: AC_FIELDS.filter((f) => acPlan.setFields?.[f] !== undefined),
              },
            ],
          }
        : {}),
      ...(acPlan?.op === 'add' ? { added_acceptance: [acPlan.added] } : {}),
      ...(acPlan?.op === 'remove' ? { removed_acceptance: [acPlan.removedBefore] } : {}),
      ...(resetEvidence.length > 0 ? { reset_evidence: resetEvidence } : {}),
      ...(removedEvidence.length > 0 ? { removed_evidence: removedEvidence } : {}),
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
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
