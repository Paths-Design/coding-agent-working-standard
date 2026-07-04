// `caws specs` command group — v11 spec lifecycle commands.
//
// CLI-SPECS-001: the canonical replacement for manual lifecycle YAML
// edits. Five subcommands:
//   - caws specs create <id> --title <title> --mode <mode> --risk-tier <n>
//   - caws specs list [--archived]
//   - caws specs show <id>
//   - caws specs close <id> --resolution <r> [--reason <text>] [--merge-commit <sha>] [--superseded-by <id>]
//   - caws specs archive <id> [--reason <text>]
//
// Discipline:
//   - All mutation paths go through specs-writer (which uses the
//     lifecycle-transaction substrate from Slice 4).
//   - The shell never appends events directly. Event append happens
//     inside the writer, which routes through appendEvent.
//   - The shell never patches YAML directly. yaml-patch lives in the
//     store layer.
//   - The shell parses CLI args, builds an actor envelope, calls the
//     writer, and renders the outcome.

import * as path from 'node:path';

import {
  isOk,
  parseAndValidateSpec,
  type Actor,
  type ActorKind,
  type Diagnostic,
} from '@paths.design/caws-kernel';

import { resolveRepoRoot, runSpecsMigrateApply } from '../../store';
import type {
  MigrationReport,
  SpecsMigrateApplyResult,
} from '../../store';
import {
  activateSpec,
  amendScopeSpec,
  archiveClosedSpecs,
  archiveSpec,
  closeSpec,
  createSpec,
  listSpecs,
  planCreateSpec,
  recoverArchivedSpec,
  restoreArchivedSpec,
  retireDraftSpec,
  retireDraftSpecs,
  selectDraftSpecsForPrune,
  selectClosedSpecsForArchive,
  showSpec,
  SPECS_LIST_STATUSES,
  type SpecsListStatus,
} from '../../store/specs-writer';
import type { LifecycleMapping } from '@paths.design/caws-kernel';
import { SPEC_MODES, SPEC_RESOLUTIONS } from '@paths.design/caws-kernel';
import * as fs from 'node:fs';
import { buildActor } from '../session/actor';
import { resolveSession } from '../session/resolve-session';
import { renderDiagnostics } from '../render/diagnostic';

// --mode / --resolution validation reads the kernel's single enum source
// (SPEC_MODES / SPEC_RESOLUTIONS) rather than re-declaring the values here.
// This eliminated the prior local VALID_MODES / VALID_RESOLUTIONS duplicate
// (CAWS-CLI-HELP-METADATA-AUTHORITY-001). The kernel arrays mirror
// spec.v1.json, which remains the validation authority.
const VALID_MODES = SPEC_MODES;
type ValidMode = (typeof VALID_MODES)[number];

const VALID_RESOLUTIONS = SPEC_RESOLUTIONS;
type ValidResolution = (typeof VALID_RESOLUTIONS)[number];

interface BaseCommandOptions {
  readonly cwd?: string;
  readonly now?: () => Date;
  readonly env?: NodeJS.ProcessEnv;
  readonly out?: (line: string) => void;
  readonly err?: (line: string) => void;
  readonly showData?: boolean;
  readonly actorKind?: ActorKind;
}

function setupIO(opts: BaseCommandOptions) {
  const cwd = opts.cwd ?? process.cwd();
  const nowFn = opts.now ?? (() => new Date());
  const env = opts.env ?? process.env;
  const out = opts.out ?? ((s: string) => process.stdout.write(s + '\n'));
  const errFn = opts.err ?? ((s: string) => process.stderr.write(s + '\n'));
  const showData = opts.showData === true;
  return { cwd, nowFn, env, out, err: errFn, showData };
}

function emitJson(out: (line: string) => void, payload: unknown): void {
  out(JSON.stringify(payload, null, 2));
}

/**
 * Surface a non-landed audit commit. The lifecycle YAML change has been
 * applied to the working tree (the transaction succeeded), but the
 * automatic audit commit did NOT land — typically because the target was
 * dirty before the write, or a consumer pre-commit hook refused. A
 * lifecycle command MUST NOT print a bare success line while leaving the
 * change uncommitted: the user has to know to commit it manually, or the
 * spec sits dirty and the next session inherits ambiguous state.
 *
 * Emits the warning on stderr only; does NOT change the command's exit
 * code. The lifecycle OPERATION succeeded (the YAML change is on disk);
 * whether the audit COMMIT landed is a separate fact, surfaced loudly but
 * never turned into a command failure. Flipping the exit code conflates
 * the two and breaks callers that legitimately run where the repo cannot
 * auto-commit. (CAWS-AUTOCOMMIT-INTEGRITY-001 surfaced it;
 * CAWS-AUTOCOMMIT-INTEGRITY-002 corrected the exit-code policy.)
 */
function surfaceAuditCommit(
  auditCommit: { readonly kind: string; readonly reason?: string } | undefined,
  err: (s: string) => void
): void {
  if (auditCommit !== undefined && auditCommit.kind === 'refused_dirty') {
    err('caws specs: the lifecycle change was applied but NOT committed.');
    if (auditCommit.reason !== undefined && auditCommit.reason.length > 0) {
      err(`  reason: ${auditCommit.reason}`);
    }
    err(
      '  The spec YAML is changed in your working tree but the audit commit ' +
        'did not land. Commit it manually (git add <spec> && git commit), ' +
        'then verify with git log.'
    );
  }
}

function resolveCawsCtx(
  cwd: string,
  errFn: (line: string) => void,
  showData: boolean,
  cmd: string
): { repoRoot: string; cawsDir: string } | null {
  const r = resolveRepoRoot(cwd);
  if (!r.ok) {
    errFn(`caws specs ${cmd}: failed to resolve repo root.`);
    errFn(renderDiagnostics(r.errors, { showData }));
    return null;
  }
  return { repoRoot: r.value.repoRoot, cawsDir: r.value.cawsDir };
}

function buildActorOrError(
  cawsDir: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  nowFn: () => Date,
  actorKind: ActorKind | undefined,
  errFn: (line: string) => void,
  showData: boolean,
  cmd: string
): Actor | null {
  const sessionResult = resolveSession({
    cawsDir,
    worktreeRoot: cwd,
    env,
    now: nowFn,
    allowMint: true,
  });
  if (!sessionResult.ok) {
    errFn(`caws specs ${cmd}: failed to resolve session identity.`);
    errFn(renderDiagnostics(sessionResult.errors, { showData }));
    return null;
  }
  return buildActor({
    session: sessionResult.value,
    kind: actorKind ?? 'agent',
  });
}

// ─── caws specs create ────────────────────────────────────────────────────

export interface SpecsCreateOptions extends BaseCommandOptions {
  readonly id?: string;
  /** Alias for the positional id; useful when agents build command options uniformly. */
  readonly idOption?: string;
  readonly title?: string;
  readonly mode?: string;
  readonly riskTier?: number | string;
  /** Alias for --risk-tier; writes the canonical risk_tier YAML field. */
  readonly tier?: number | string;
  readonly legacyType?: string;
  /**
   * Repeatable --scope-in <path>. When supplied, scope.in is written with the
   * given paths at creation time, so the spec ships ready to enforce
   * (CAWS-SPECS-CREATE-SCOPE-IN-001).
   */
  readonly scopeIn?: readonly string[];
  /** Alias for --scope-in using the YAML field spelling. */
  readonly scopeInDot?: readonly string[];
  /**
   * Repeatable --acceptance <text>. Free text becomes the `then` clause; a
   * "given: ...; when: ...; then: ..." value seeds all v11 fields.
   */
  readonly acceptance?: readonly string[];
  /**
   * Repeatable --contract "name:type[:path]". Tier-1/2 specs require at least
   * one contract; supplying it here creates the spec valid in one command
   * (FIX-SPECS-CONTRACT-ORIENTATION-001).
   */
  readonly contract?: readonly string[];
  /** Read-only preflight: render and validate the candidate without writing. */
  readonly plan?: boolean;
  /** Emit machine-readable plan output. */
  readonly json?: boolean;
}

/** The closed contract.type enum (mirrors spec.v1.json). */
const CONTRACT_TYPES = ['api', 'schema', 'contract-test', 'behavior'] as const;
type ContractType = (typeof CONTRACT_TYPES)[number];

interface AcceptanceEntry {
  readonly given: string;
  readonly when: string;
  readonly then: string;
}

/** The inline contract shape, shown wherever the operator needs orientation. */
const CONTRACT_SHAPE_HINT =
  'Contract shape: {name, type: api|schema|contract-test|behavior, path?, description?}. ' +
  'Author via repeatable --contract "name:type[:path]".';
const CONTRACT_EXAMPLE_HINT = 'Example: --contract "core-api:behavior"';

function contractTypeError(entry: string, name: string, typeRaw: string): string {
  const base =
    `invalid --contract "${entry}": type "${typeRaw}" is not one of ${CONTRACT_TYPES.join(', ')}. ` +
    `${CONTRACT_SHAPE_HINT} ${CONTRACT_EXAMPLE_HINT}.`;
  if (CONTRACT_TYPES.includes(name as ContractType) && typeRaw.length > 0) {
    return `${base} Did you mean --contract "${typeRaw}:${name}"?`;
  }
  return base;
}

/**
 * Parse a repeatable --contract "name:type[:path]" into structured entries.
 * Returns {contracts} on success or {error} with an operator-facing message
 * (naming the valid type enum) on a malformed entry.
 */
function parseContractFlags(
  raw: readonly string[]
): { contracts: { name: string; type: ContractType; path?: string }[] } | { error: string } {
  const contracts: { name: string; type: ContractType; path?: string }[] = [];
  for (const entry of raw) {
    // Split into at most 3 fields: name : type : path (path may contain colons
    // only if quoted by the shell; we take the remainder as the path).
    const firstColon = entry.indexOf(':');
    if (firstColon === -1) {
      return {
        error: `invalid --contract "${entry}": expected "name:type[:path]". ${CONTRACT_SHAPE_HINT}`,
      };
    }
    const name = entry.slice(0, firstColon).trim();
    const rest = entry.slice(firstColon + 1);
    const secondColon = rest.indexOf(':');
    const typeRaw = (secondColon === -1 ? rest : rest.slice(0, secondColon)).trim();
    const path = secondColon === -1 ? undefined : rest.slice(secondColon + 1).trim();
    if (name.length === 0) {
      return { error: `invalid --contract "${entry}": contract name is empty. ${CONTRACT_SHAPE_HINT}` };
    }
    if (!CONTRACT_TYPES.includes(typeRaw as ContractType)) {
      return {
        error: contractTypeError(entry, name, typeRaw),
      };
    }
    contracts.push({
      name,
      type: typeRaw as ContractType,
      ...(path !== undefined && path.length > 0 ? { path } : {}),
    });
  }
  return { contracts };
}

function parseAcceptanceFlags(
  raw: readonly string[]
): { acceptance: AcceptanceEntry[] } | { error: string } {
  const acceptance: AcceptanceEntry[] = [];
  for (const entry of raw) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) {
      return { error: 'invalid --acceptance: value must not be empty.' };
    }
    const structured = parseStructuredAcceptance(trimmed);
    if ('error' in structured) return structured;
    acceptance.push(structured.acceptance);
  }
  return { acceptance };
}

function parseStructuredAcceptance(
  value: string
): { acceptance: AcceptanceEntry } | { error: string } {
  const parts = value.split(';').map((p) => p.trim()).filter((p) => p.length > 0);
  const labeled: Partial<Record<'given' | 'when' | 'then', string>> = {};
  let sawLabel = false;
  for (const part of parts) {
    const match = /^(given|when|then)\s*:\s*(.+)$/i.exec(part);
    if (match === null) continue;
    sawLabel = true;
    const key = match[1]!.toLowerCase() as 'given' | 'when' | 'then';
    labeled[key] = match[2]!.trim();
  }
  if (sawLabel) {
    const missing = (['given', 'when', 'then'] as const).filter((key) => {
      const field = labeled[key];
      return field === undefined || field.length === 0;
    });
    if (missing.length > 0 || Object.keys(labeled).length !== parts.length) {
      return {
        error:
          'invalid --acceptance: structured values must use all fields as ' +
          '"given: ...; when: ...; then: ...", or pass plain free text.',
      };
    }
    return {
      acceptance: {
        given: labeled.given as string,
        when: labeled.when as string,
        then: labeled.then as string,
      },
    };
  }
  return {
    acceptance: {
      given: 'The spec implementation is complete.',
      when: 'The acceptance statement is evaluated.',
      then: value,
    },
  };
}

const SPECS_CREATE_USAGE = [
  'Usage:',
  '  caws specs create <id> --title "<short title>" --mode <feature|refactor|fix|doc|chore> --risk-tier <1|2|3> [--tier <1|2|3>] [--scope-in <path>]... [--scope.in <path>]... [--acceptance <text>]... [--contract "name:type[:path]"]... [--plan] [--json]',
  '',
  'Example:',
  '  caws specs create FEAT-001 --title "Trivial first slice" --mode chore --risk-tier 3',
  '  caws specs create FEAT-002 --title "Render slice" --mode feature --risk-tier 3 --scope-in src/render.js --scope-in tests/render.test.js',
  '  caws specs create FEAT-003 --title "Tier-2 cross-package" --mode feature --risk-tier 2 --contract "core-api:behavior"',
  '',
  'Notes:',
  '  --type is not supported in v11. Use --mode instead.',
  '  --tier is an alias for --risk-tier; both write the canonical risk_tier field.',
  '  Risk tier 3 is appropriate for docs, tests, harnesses, and low-blast-radius slices.',
  '  Tier 1/2 specs require at least one contract: pass --contract "name:type[:path]"',
  '    (repeatable); type is one of api|schema|contract-test|behavior. Or use --risk-tier 3 / --mode chore.',
  '  --scope-in (repeatable) writes scope.in at creation time, so you never hand-edit it.',
  '  --scope.in is an alias for --scope-in; both write the canonical scope.in field.',
  '  --acceptance is repeatable; free text becomes then, or pass "given: ...; when: ...; then: ...".',
  '  --plan validates and prints the candidate without writing .caws/specs or events.',
  '  To widen scope later, use `caws specs amend-scope <id> --add <path>` (governed; no hand-edit).',
  '  Invariants still need filling in via the spec YAML before iteration; acceptance does too unless --acceptance seeded it.',
].join('\n');

function createCommandPreview(opts: {
  readonly id: string;
  readonly title: string;
  readonly mode: ValidMode;
  readonly riskTier: 1 | 2 | 3;
  readonly scopeIn?: readonly string[];
  readonly acceptance?: readonly string[];
  readonly contract?: readonly string[];
}): string {
  const parts = [
    'caws',
    'specs',
    'create',
    shellQuote(opts.id),
    '--title',
    shellQuote(opts.title),
    '--mode',
    shellQuote(opts.mode),
    '--risk-tier',
    String(opts.riskTier),
  ];
  for (const p of opts.scopeIn ?? []) {
    parts.push('--scope-in', shellQuote(p));
  }
  for (const a of opts.acceptance ?? []) {
    parts.push('--acceptance', shellQuote(a));
  }
  for (const c of opts.contract ?? []) {
    parts.push('--contract', shellQuote(c));
  }
  return parts.join(' ');
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const SPEC_PARSE_RULE_PREFIXES = [
  'spec.yaml.',
  'spec.schema.',
] as const;

function hasSpecParseOrSchemaDiagnostics(
  diagnostics: readonly Diagnostic[]
): boolean {
  return diagnostics.some((d) =>
    SPEC_PARSE_RULE_PREFIXES.some((prefix) => d.rule.startsWith(prefix))
  );
}

function renderSpecParseGuidance(filePath: string): string {
  return [
    'repair:',
    `  Validate this file: caws specs validate ${shellQuote(filePath)}`,
    '  Common v11 YAML array shapes:',
    '    invariants:',
    "      - 'State the invariant as a quoted string.'",
    '    acceptance:',
    '      - id: A1',
    "        given: 'Precondition.'",
    "        when: 'Action.'",
    "        then: 'Expected result.'",
    '    contracts:',
    '      - name: example-contract',
    '        type: behavior',
    '        path: path/to/test-or-contract',
  ].join('\n');
}

function semanticFieldsFromPlanDiagnostics(
  diagnostics: readonly { readonly data?: Readonly<Record<string, unknown>>; readonly message: string }[]
): string[] {
  const fields = diagnostics
    .map((d) => d.data?.['source_pointer'])
    .filter((p): p is string => typeof p === 'string' && p.length > 0);
  return [...new Set(fields)];
}

const SEMANTIC_FIELD_EXAMPLES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  '/contracts': [
    'contracts:',
    "  - name: 'core-api'",
    '    type: behavior',
  ],
  '/observability': [
    'observability:',
    "  - 'Log the decision path and refusal reason for each governed operation.'",
  ],
  '/rollback': [
    'rollback:',
    "  - 'Revert the implementation commit and rerun caws doctor plus focused tests.'",
  ],
  '/non_functional/security': [
    'non_functional:',
    '  security:',
    "    - 'No new secret material is logged, persisted, or exposed in diagnostics.'",
  ],
});

function semanticFieldExamples(missingFields: readonly string[]): Record<string, readonly string[]> {
  const examples: Record<string, readonly string[]> = {};
  for (const field of missingFields) {
    const example = SEMANTIC_FIELD_EXAMPLES[field];
    if (example !== undefined) examples[field] = example;
  }
  return examples;
}

function diagnosticJson(
  diagnostics: readonly {
    readonly rule: string;
    readonly message: string;
    readonly subject?: string;
    readonly narrowRepair?: string;
    readonly data?: Readonly<Record<string, unknown>>;
  }[]
): Record<string, unknown>[] {
  return diagnostics.map((d) => ({
    rule: d.rule,
    message: d.message,
    ...(d.subject !== undefined ? { subject: d.subject } : {}),
    ...(typeof d.data?.['source_pointer'] === 'string'
      ? { pointer: d.data['source_pointer'] }
      : {}),
    ...(d.narrowRepair !== undefined ? { repair: d.narrowRepair } : {}),
  }));
}

export function runSpecsCreateCommand(opts: SpecsCreateOptions): number {
  const { cwd, nowFn, env, out, err, showData } = setupIO(opts);

  if (opts.legacyType !== undefined) {
    err('caws specs create: --type is not supported in v11. Use --mode instead.');
    err(SPECS_CREATE_USAGE);
    return 1;
  }

  if (opts.id !== undefined && opts.idOption !== undefined) {
    err('caws specs create: positional <id> and --id both name the spec id; pass only one.');
    return 1;
  }
  const specId = opts.id ?? opts.idOption;

  const missing = [
    specId === undefined ? '<id> or --id' : undefined,
    opts.title === undefined ? '--title' : undefined,
    opts.mode === undefined ? '--mode' : undefined,
    opts.riskTier === undefined && opts.tier === undefined ? '--risk-tier' : undefined,
  ].filter((v): v is string => v !== undefined);
  if (missing.length > 0) {
    err(`caws specs create: missing required options: ${missing.join(', ')}`);
    err(SPECS_CREATE_USAGE);
    return 1;
  }

  const title = opts.title;
  const mode = opts.mode;
  if (opts.riskTier !== undefined && opts.tier !== undefined) {
    err('caws specs create: --risk-tier and --tier both write risk_tier; pass only one.');
    return 1;
  }

  const rawRiskTier = opts.riskTier ?? opts.tier;
  if (specId === undefined || title === undefined || mode === undefined || rawRiskTier === undefined) {
    err('caws specs create: missing required options.');
    err(SPECS_CREATE_USAGE);
    return 1;
  }

  if (opts.scopeIn !== undefined && opts.scopeInDot !== undefined) {
    err('caws specs create: --scope-in and --scope.in both write scope.in; pass only one.');
    return 1;
  }
  const scopeIn = opts.scopeIn ?? opts.scopeInDot;

  if (!VALID_MODES.includes(mode as ValidMode)) {
    err(
      `caws specs create: invalid --mode "${mode}". Expected one of: ${VALID_MODES.join(', ')}.`
    );
    return 1;
  }
  const riskTier = typeof rawRiskTier === 'string'
    ? Number.parseInt(rawRiskTier, 10)
    : rawRiskTier;
  if (riskTier !== 1 && riskTier !== 2 && riskTier !== 3) {
    err(
      `caws specs create: invalid risk tier "${rawRiskTier}". Expected 1, 2, or 3.`
    );
    return 1;
  }

  const ctx = resolveCawsCtx(cwd, err, showData, 'create');
  if (ctx === null) return 2;

  const actor = buildActorOrError(
    ctx.cawsDir, cwd, env, nowFn, opts.actorKind, err, showData, 'create'
  );
  if (actor === null) return 2;

  // FIX-SPECS-CONTRACT-ORIENTATION-001: parse repeatable --contract into
  // structured entries (validating the type enum) BEFORE the writer, so a
  // tier-1/2 spec is created valid in one command.
  let parsedContracts: { name: string; type: ContractType; path?: string }[] | undefined;
  if (opts.contract !== undefined && opts.contract.length > 0) {
    const parsed = parseContractFlags(opts.contract);
    if ('error' in parsed) {
      err(`caws specs create: ${parsed.error}`);
      return 1;
    }
    parsedContracts = parsed.contracts;
  }

  let parsedAcceptance: AcceptanceEntry[] | undefined;
  if (opts.acceptance !== undefined && opts.acceptance.length > 0) {
    const parsed = parseAcceptanceFlags(opts.acceptance);
    if ('error' in parsed) {
      err(`caws specs create: ${parsed.error}`);
      return 1;
    }
    parsedAcceptance = parsed.acceptance;
  }

  const createInput = {
    id: specId,
    title,
    mode: mode as ValidMode,
    riskTier: riskTier as 1 | 2 | 3,
    initialState: 'active',
    now: nowFn,
    actor,
    ...(scopeIn !== undefined && scopeIn.length > 0
      ? { scopeIn }
      : {}),
    ...(parsedAcceptance !== undefined && parsedAcceptance.length > 0
      ? { acceptance: parsedAcceptance }
      : {}),
    ...(parsedContracts !== undefined && parsedContracts.length > 0
      ? { contracts: parsedContracts }
      : {}),
  } as const;

  if (opts.plan === true) {
    const plan = planCreateSpec(ctx.cawsDir, createInput);
    if (!isOk(plan)) {
      err('caws specs create --plan: failed.');
      err(renderDiagnostics(plan.errors, { showData }));
      return 1;
    }
    const relSpecPath = path.relative(ctx.repoRoot, plan.value.path);
    const diagnostics = diagnosticJson(plan.value.diagnostics);
    const missingFields = semanticFieldsFromPlanDiagnostics(plan.value.diagnostics);
    const fieldExamples = semanticFieldExamples(missingFields);
    const command = createCommandPreview({
      id: specId,
      title,
      mode: mode as ValidMode,
      riskTier: riskTier as 1 | 2 | 3,
      ...(scopeIn !== undefined && scopeIn.length > 0
        ? { scopeIn }
        : {}),
      ...(opts.acceptance !== undefined && opts.acceptance.length > 0
        ? { acceptance: opts.acceptance }
        : {}),
      ...(opts.contract !== undefined && opts.contract.length > 0
        ? { contract: opts.contract }
        : {}),
    });
    if (opts.json === true) {
      emitJson(out, {
        ok: true,
        dry_run: true,
        read_only: true,
        id: plan.value.id,
        target_path: relSpecPath,
        valid: plan.value.valid,
        would_write: plan.value.valid,
        missing_fields: missingFields,
        field_examples: fieldExamples,
        diagnostics,
        candidate: {
          title,
          mode,
          risk_tier: riskTier,
          lifecycle_state: 'active',
          scope_in: scopeIn ?? [],
          acceptance: parsedAcceptance ?? [],
          contracts: parsedContracts ?? [],
        },
        command,
      });
    } else {
      out(`caws specs create --plan: ${plan.value.valid ? 'valid' : 'needs changes'} candidate for ${plan.value.id}`);
      out(`  target: ${relSpecPath}`);
      out('  read_only: true');
      out(`  would_write: ${plan.value.valid ? 'yes' : 'no'}`);
      if (missingFields.length > 0) {
        out('  missing semantic fields:');
        for (const field of missingFields) out(`    - ${field}`);
      }
      if (Object.keys(fieldExamples).length > 0) {
        out('  example YAML additions:');
        for (const [field, lines] of Object.entries(fieldExamples)) {
          out(`    ${field}:`);
          for (const line of lines) out(`      ${line}`);
        }
      }
      if (plan.value.diagnostics.length > 0) {
        out('  diagnostics:');
        for (const d of plan.value.diagnostics) {
          out(`    - ${d.rule}: ${d.message}`);
          if (d.narrowRepair !== undefined) out(`      repair: ${d.narrowRepair}`);
        }
      }
      out('  create command:');
      out(`    ${command}`);
      out('  No files, events, or worktree registry entries were written.');
    }
    return 0;
  }

  const result = createSpec(ctx.cawsDir, createInput);
  if (!isOk(result)) {
    err('caws specs create: failed.');
    err(renderDiagnostics(result.errors, { showData }));
    // FIX-SPECS-CONTRACT-ORIENTATION-001 (A2): the kernel's narrowRepair already
    // says "Add at least one contract or change risk_tier to 3 or mode to chore",
    // but does not state the contract SHAPE. When a tier-1/2 create was rejected
    // without any --contract supplied, append the inline shape + the one-command
    // path so the operator never has to look up an (unshipped) external doc.
    if ((riskTier === 1 || riskTier === 2) && parsedContracts === undefined) {
      err('');
      err(`  ${CONTRACT_SHAPE_HINT}`);
      err(
        `  Example: caws specs create ${opts.id} --title "..." --mode ${mode} --risk-tier ${riskTier} --contract "core-api:behavior"`
      );
    }
    return 1;
  }
  const outcome = result.value;
  if (outcome.kind === 'partial_failure_recovered') {
    err('caws specs create: partial failure recovered (no state change).');
    err(renderDiagnostics(outcome.cause, { showData }));
    return 1;
  }
  const relSpecPath = path.relative(ctx.repoRoot, outcome.path);
  out(`created ${outcome.id} at ${relSpecPath} (lifecycle_state: active)`);
  // CAWS-SPECS-CREATE-SCOPE-IN-001: when --scope-in was supplied, scope.in is
  // already populated in the created spec, so the guidance must NOT tell the
  // user to hand-edit the YAML to set it — that instruction is the very
  // silent-failure surface this slice removes. Branch the guidance: confirm
  // the populated scope and point at `caws specs amend-scope` for later
  // widening (the governed mutation), instead of a raw YAML edit.
  //
  // CAWS-SPEC-CREATE-FIRSTTIMER-UX-001 A3: do NOT over-promise enforcement.
  // The previous hint claimed "scope-guard rejects every edit", but a fresh
  // spec on the main checkout is `binding: unbound`, and scope-guard FAILS
  // OPEN when it cannot decide authority (scope.no_authority.unbound) — so
  // edits on main are NOT rejected by scope-guard. scope.in enforcement is
  // authoritative inside the spec's bound worktree; base-branch writes are
  // governed by the worktree-write-guard, not scope-guard. State that truth.
  const scopeInWasPopulated =
    scopeIn !== undefined && scopeIn.length > 0;
  const acceptanceWasPopulated =
    parsedAcceptance !== undefined && parsedAcceptance.length > 0;
  const fillGuidance = acceptanceWasPopulated
    ? 'Fill in invariants and review acceptance'
    : 'Fill in invariants + acceptance';
  out('');
  // CAWS-SPECS-CREATE-COMMIT-BEFORE-WORKTREE-GUIDANCE-001: both branches must
  // tell the first-timer to COMMIT the spec (after filling in the body) BEFORE
  // `caws worktree create`. The body fields (invariants/acceptance) have no CLI
  // setter and are hand-edited, which leaves the spec YAML dirty; walking that
  // dirty tree straight into `worktree create` produces the confusing "the
  // transition was applied but NOT committed" warning. Committing first keeps
  // the audit commit clean. We also name how to inspect the filled-in spec —
  // there is intentionally no `caws specs validate` verb in v11.
  if (scopeInWasPopulated) {
    out(`Next: scope.in is set from create-time scope flags. ${fillGuidance}, then:`);
    out(
      `  1. caws specs show ${outcome.id}   (re-read the spec; or run \`caws doctor\` to check for drift)`
    );
    out(
      `  2. git add .caws/specs/${outcome.id}.yaml && git commit   (commit BEFORE the worktree so its audit commit is clean)`
    );
    out(
      `  3. caws worktree create <name> --spec ${outcome.id}   (binds + enforces scope.in)`
    );
    out(
      '  Later: caws specs amend-scope ' +
        outcome.id +
        ' --add <path>   (the governed way to widen scope — no hand-edit)'
    );
  } else {
    out('Next: set scope.in via the governed mutation, not a raw YAML edit:');
    out(
      '  1. caws specs amend-scope ' +
        outcome.id +
        ' --add <path> --add <path>   (writes canonical, appends an audit event)'
    );
    out(`  2. ${fillGuidance}, then inspect with \`caws specs show ` +
        outcome.id +
        '` (or `caws doctor`).');
    out(
      `  3. git add .caws/specs/${outcome.id}.yaml && git commit   (commit BEFORE the worktree so its audit commit is clean)`
    );
    out(`  4. caws worktree create <name> --spec ${outcome.id}`);
    out(
      '  (scope.in is authoritative inside that worktree; base-branch writes are'
    );
    out('  governed by the worktree-write-guard, not scope.in.)');
  }
  // FIX-SPECS-CONTRACT-ORIENTATION-001 (A3): inline the contract orientation
  // instead of pointing at docs/guides/caws-contracts.md, which is NOT shipped
  // in the published package (files-field ships only dist/README/templates) —
  // a dangling repo-internal pointer in a consumer install. No external lookup.
  out(
    '  Tier 1/2 specs require at least one contract. ' + CONTRACT_SHAPE_HINT
  );
  surfaceAuditCommit(outcome.data?.audit_commit, err);
  return 0;
}

// ─── caws specs list ──────────────────────────────────────────────────────

export interface SpecsListOptions extends BaseCommandOptions {
  /** Include archived specs in the listing. */
  readonly includeArchived?: boolean;
  /** Filter specs by lifecycle status. */
  readonly status?: string;
  /** Alias for --status; filter specs by lifecycle state. */
  readonly lifecycle?: string;
  /** Alias for --status; filter specs by lifecycle state. */
  readonly state?: string;
  /** Alias for --status active. */
  readonly active?: boolean;
  /** Alias for --status draft. */
  readonly draft?: boolean;
  /** Alias for --status closed. */
  readonly closed?: boolean;
}

function parseSpecsListStatus(raw: string | undefined): SpecsListStatus | undefined | null {
  if (raw === undefined) return undefined;
  return (SPECS_LIST_STATUSES as readonly string[]).includes(raw)
    ? (raw as SpecsListStatus)
    : null;
}

function renderSpecsStatusError(status: string, err: (line: string) => void): void {
  err(
    `caws specs list: invalid --status ${JSON.stringify(status)}. ` +
      `Expected one of: ${SPECS_LIST_STATUSES.join(', ')}.`
  );
  err('Use: caws specs list --status <active|draft|closed|archived>');
  err('For batch archival, use: caws specs archive --status closed');
}

function resolveSpecsListStatus(opts: SpecsListOptions): string | undefined | { error: string } {
  const selectors: { flag: string; status: string }[] = [];
  if (opts.status !== undefined) selectors.push({ flag: '--status', status: opts.status });
  if (opts.lifecycle !== undefined) selectors.push({ flag: '--lifecycle', status: opts.lifecycle });
  if (opts.state !== undefined) selectors.push({ flag: '--state', status: opts.state });
  if (opts.active === true) selectors.push({ flag: '--active', status: 'active' });
  if (opts.draft === true) selectors.push({ flag: '--draft', status: 'draft' });
  if (opts.closed === true) selectors.push({ flag: '--closed', status: 'closed' });
  if (selectors.length > 1) {
    return {
      error:
        `caws specs list: lifecycle selectors ${selectors.map((s) => s.flag).join(', ')} conflict; ` +
        'pass only one of --status, --lifecycle, --state, --active, --draft, or --closed.',
    };
  }
  return selectors[0]?.status;
}

export function runSpecsListCommand(opts: SpecsListOptions = {}): number {
  const { cwd, out, err, showData } = setupIO(opts);
  const rawStatus = resolveSpecsListStatus(opts);
  if (typeof rawStatus === 'object') {
    err(rawStatus.error);
    return 1;
  }
  const status = parseSpecsListStatus(rawStatus);
  if (status === null) {
    renderSpecsStatusError(String(opts.status), err);
    return 1;
  }
  const ctx = resolveCawsCtx(cwd, err, showData, 'list');
  if (ctx === null) return 2;

  const result = listSpecs(ctx.cawsDir, {
    includeArchived: opts.includeArchived === true,
    ...(status !== undefined ? { status } : {}),
  });
  if (!isOk(result)) {
    err('caws specs list: failed.');
    err(renderDiagnostics(result.errors, { showData }));
    return 1;
  }
  const { active, archived } = result.value;
  if (active.length === 0 && archived.length === 0) {
    if (status !== undefined) {
      out(`(no specs with status ${status})`);
    } else {
      out('(no specs)');
    }
    return 0;
  }

  for (const entry of active) {
    const rel = path.relative(ctx.repoRoot, entry.path);
    out(`${entry.id.padEnd(28)} ${entry.lifecycle_state.padEnd(8)} ${entry.title}`);
    void rel;
  }
  if ((opts.includeArchived === true || status === 'archived') && archived.length > 0) {
    out('');
    out('-- archived (recoverable from history) --');
    for (const entry of archived) {
      const blobDisplay = entry.blob_sha !== null
        ? `blob ${entry.blob_sha.slice(0, 8)}`
        : 'legacy (no blob_sha; use git log --follow)';
      out(`${entry.id.padEnd(28)} archived ${entry.archived_at}  ${blobDisplay}`);
      out(`  recover: caws specs recover ${entry.id}`);
    }
  }
  return 0;
}

// ─── caws specs show ──────────────────────────────────────────────────────

export interface SpecsShowOptions extends BaseCommandOptions {
  readonly id: string;
  /**
   * CAWS-ARCHIVE-AS-TOMBSTONE-001: when true, look up the spec body
   * via the event log + git blob_sha (recoverArchivedSpec). Default
   * false → showSpec walks only the active path. This split makes the
   * archive surface explicit, eliminating the v11.1.x transparent
   * fallback that surfaced archived specs as if they were current.
   */
  readonly archived?: boolean;
}

export function runSpecsShowCommand(opts: SpecsShowOptions): number {
  const { cwd, out, err, showData } = setupIO(opts);
  const ctx = resolveCawsCtx(cwd, err, showData, 'show');
  if (ctx === null) return 2;

  if (opts.archived === true) {
    const result = recoverArchivedSpec(ctx.cawsDir, opts.id);
    if (!isOk(result)) {
      err('caws specs show: failed.');
      err(renderDiagnostics(result.errors, { showData }));
      return 1;
    }
    out(result.value.source);
    return 0;
  }

  const result = showSpec(ctx.cawsDir, opts.id);
  if (!isOk(result)) {
    err('caws specs show: failed.');
    err(renderDiagnostics(result.errors, { showData }));
    if (hasSpecParseOrSchemaDiagnostics(result.errors)) {
      err(renderSpecParseGuidance(path.join(ctx.cawsDir, 'specs', `${opts.id}.yaml`)));
    }
    return 1;
  }
  out(result.value.source);
  return 0;
}

// ─── caws specs recover ──────────────────────────────────────────────────
//
// CAWS-ARCHIVE-AS-TOMBSTONE-001: dedicated command for recovering an
// archived spec body via the event log's blob_sha + git show. Distinct
// from `show --archived` for callers who think of recovery as a
// first-class operation (e.g. piping into an editor, writing to a
// specific path). Either surface returns the same bytes; both delegate
// to recoverArchivedSpec.

export interface SpecsRecoverOptions extends BaseCommandOptions {
  readonly id: string;
  /**
   * When set, write the recovered body to this path instead of stdout.
   * Named `outPath` (not `out`) to avoid shadowing
   * BaseCommandOptions.out, which is the stdout-writer callback.
   */
  readonly outPath?: string;
}

export function runSpecsRecoverCommand(opts: SpecsRecoverOptions): number {
  const { cwd, out: stdoutFn, err, showData } = setupIO(opts);
  const ctx = resolveCawsCtx(cwd, err, showData, 'recover');
  if (ctx === null) return 2;

  const result = recoverArchivedSpec(ctx.cawsDir, opts.id);
  if (!isOk(result)) {
    err('caws specs recover: failed.');
    err(renderDiagnostics(result.errors, { showData }));
    return 1;
  }

  if (typeof opts.outPath === 'string' && opts.outPath.length > 0) {
    try {
      fs.writeFileSync(opts.outPath, result.value.source);
      stdoutFn(`recovered ${opts.id} to ${opts.outPath}`);
    } catch (e) {
      err(`caws specs recover: failed to write to ${opts.outPath}: ${(e as Error).message}`);
      return 1;
    }
  } else {
    stdoutFn(result.value.source);
  }
  return 0;
}

// ─── caws specs restore ──────────────────────────────────────────────────

export interface SpecsRestoreOptions extends BaseCommandOptions {
  readonly id: string;
  readonly targetState?: string;
  readonly apply?: boolean;
  readonly json?: boolean;
}

function restoreCommandPreview(id: string, targetState: 'draft' | 'active'): string {
  return [
    'caws',
    'specs',
    'restore',
    shellQuote(id),
    '--as',
    targetState,
    '--apply',
  ].join(' ');
}

export function runSpecsRestoreCommand(opts: SpecsRestoreOptions): number {
  const { cwd, nowFn, env, out, err, showData } = setupIO(opts);

  if (opts.targetState !== 'draft' && opts.targetState !== 'active') {
    err('caws specs restore: --as is required and must be one of: draft, active.');
    return 1;
  }

  const ctx = resolveCawsCtx(cwd, err, showData, 'restore');
  if (ctx === null) return 2;

  const actor = buildActorOrError(
    ctx.cawsDir, cwd, env, nowFn, opts.actorKind, err, showData, 'restore'
  );
  if (actor === null) return 2;

  const result = restoreArchivedSpec(ctx.cawsDir, {
    id: opts.id,
    targetState: opts.targetState,
    apply: opts.apply === true,
    now: nowFn,
    actor,
  });
  if (!isOk(result)) {
    err('caws specs restore: failed.');
    err(renderDiagnostics(result.errors, { showData }));
    return 1;
  }

  const plan = result.value.plan;
  const diagnostics = diagnosticJson(plan.diagnostics);
  const command = restoreCommandPreview(opts.id, plan.targetLifecycleState);
  const payload = {
    ok: plan.valid,
    dry_run: result.value.kind === 'plan',
    read_only: result.value.kind === 'plan',
    id: plan.id,
    target_path: plan.restoredPath,
    target_lifecycle_state: plan.targetLifecycleState,
    source: {
      event: plan.sourceEvent,
      from_path: plan.sourcePath,
      blob_sha: plan.blobSha,
    },
    worktree_binding_cleared: plan.worktreeBindingCleared,
    valid: plan.valid,
    would_write: plan.valid && result.value.kind === 'applied',
    diagnostics,
    command,
  };

  if (opts.json === true) {
    emitJson(out, payload);
  } else if (result.value.kind === 'plan') {
    out(`caws specs restore: ${plan.valid ? 'valid' : 'needs changes'} plan for ${plan.id}`);
    out(`  target: ${plan.restoredPath}`);
    out(`  lifecycle_state: ${plan.targetLifecycleState}`);
    out(`  source: ${plan.sourceEvent} ${plan.sourcePath}`);
    if (plan.blobSha !== null) out(`  blob_sha: ${plan.blobSha}`);
    out(`  worktree_binding_cleared: ${plan.worktreeBindingCleared ? 'yes' : 'no'}`);
    out('  read_only: true');
    out(`  would_write: ${plan.valid ? 'yes, with --apply' : 'no'}`);
    if (plan.diagnostics.length > 0) {
      out('  diagnostics:');
      for (const d of plan.diagnostics) {
        out(`    - ${d.rule}: ${d.message}`);
        if (d.narrowRepair !== undefined) out(`      repair: ${d.narrowRepair}`);
      }
    }
    out('  apply command:');
    out(`    ${command}`);
    out('  No files, events, or worktree registry entries were written.');
  } else {
    out(`restored ${plan.id} to ${plan.restoredPath} (lifecycle_state: ${plan.targetLifecycleState})`);
  }

  if (result.value.kind === 'applied') {
    const outcome = result.value.outcome;
    if (outcome.kind === 'partial_failure_recovered') {
      err('caws specs restore: partial failure recovered (no state change).');
      err(renderDiagnostics(outcome.cause, { showData }));
      return 1;
    }
    surfaceAuditCommit(outcome.data?.audit_commit, err);
  }
  return plan.valid ? 0 : 1;
}

// ─── caws specs prune-drafts ──────────────────────────────────────────────

export interface SpecsPruneDraftsOptions extends BaseCommandOptions {
  readonly olderThanMs?: number | string;
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  readonly includeBound?: boolean;
  readonly apply?: boolean;
  readonly reason?: string;
  readonly json?: boolean;
}

function parseNonNegativeIntegerOption(
  value: number | string | undefined,
  optionName: string
): number | { readonly error: string } | undefined {
  if (value === undefined) return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return { error: `${optionName} must be a non-negative integer.` };
  }
  return parsed;
}

export function runSpecsPruneDraftsCommand(opts: SpecsPruneDraftsOptions = {}): number {
  const { cwd, nowFn, env, out, err, showData } = setupIO(opts);

  const olderThanMs = parseNonNegativeIntegerOption(opts.olderThanMs, '--older-than-ms');
  if (typeof olderThanMs === 'object') {
    err(`caws specs prune-drafts: ${olderThanMs.error}`);
    return 1;
  }

  const ctx = resolveCawsCtx(cwd, err, showData, 'prune-drafts');
  if (ctx === null) return 2;

  const selectionInput = {
    ...(olderThanMs !== undefined ? { olderThanMs } : {}),
    ...(opts.include !== undefined ? { include: opts.include } : {}),
    ...(opts.exclude !== undefined ? { exclude: opts.exclude } : {}),
    ...(opts.includeBound === true ? { includeBound: true } : {}),
    now: nowFn,
  };

  if (opts.apply === true) {
    const actor = buildActorOrError(
      ctx.cawsDir, cwd, env, nowFn, opts.actorKind, err, showData, 'prune-drafts'
    );
    if (actor === null) return 2;

    const result = retireDraftSpecs(ctx.cawsDir, {
      ...selectionInput,
      actor,
      ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
      explicitSelector: (opts.include?.length ?? 0) > 0 || olderThanMs !== undefined,
    });
    if (!isOk(result)) {
      err('caws specs prune-drafts: failed.');
      err(renderDiagnostics(result.errors, { showData }));
      return 1;
    }
    const outcome = result.value;
    const ok = outcome.refused.length === 0 && outcome.failed.length === 0;
    if (opts.json === true) {
      emitJson(out, {
        ok,
        dry_run: false,
        read_only: false,
        selector: outcome.selector,
        counts: {
          retired: outcome.retired.length,
          skipped: outcome.skipped.length,
          refused: outcome.refused.length,
          failed: outcome.failed.length,
        },
        retired: outcome.retired.map((entry) => ({
          id: entry.id,
          path: path.relative(ctx.repoRoot, entry.path),
        })),
        skipped: outcome.skipped,
        refused: outcome.refused,
        failed: outcome.failed,
      });
    } else {
      out(
        `caws specs prune-drafts (apply): retired ${outcome.retired.length}; skipped ${outcome.skipped.length}; refused ${outcome.refused.length}; failed ${outcome.failed.length}`
      );
      for (const entry of outcome.retired) {
        out(`  retired ${entry.id} (${path.relative(ctx.repoRoot, entry.path)})`);
      }
      for (const entry of outcome.skipped) {
        out(`  skipped ${entry.id}: ${entry.state} (${entry.reason})`);
      }
      for (const entry of outcome.refused) {
        out(`  refused ${entry.id}: ${entry.state} (${entry.reason})`);
        if (entry.next_command !== undefined) out(`    next: ${entry.next_command}`);
      }
      for (const entry of outcome.failed) {
        out(`  failed ${entry.id}: ${entry.reason}`);
      }
    }
    surfaceAuditCommit(outcome.data?.audit_commit, err);
    return ok ? 0 : 1;
  }

  const result = selectDraftSpecsForPrune(ctx.cawsDir, selectionInput);
  if (!isOk(result)) {
    err('caws specs prune-drafts: failed.');
    err(renderDiagnostics(result.errors, { showData }));
    return 1;
  }

  const plan = result.value;
  const payload = {
    ok: true,
    dry_run: true,
    read_only: true,
    selector: plan.selector,
    counts: {
      candidates: plan.candidates.length,
      skipped: plan.skipped.length,
      refused: plan.refused.length,
    },
    candidates: plan.candidates,
    skipped: plan.skipped,
    refused: plan.refused,
  };
  if (opts.json === true) {
    emitJson(out, payload);
    return 0;
  }

  out(
    `caws specs prune-drafts: ${plan.candidates.length} candidate(s), ${plan.skipped.length} skipped, ${plan.refused.length} refused (read-only)`
  );
  out(`  older_than_ms: ${plan.selector.older_than_ms}`);
  if (plan.selector.include.length > 0) out(`  include: ${plan.selector.include.join(',')}`);
  if (plan.selector.exclude.length > 0) out(`  exclude: ${plan.selector.exclude.join(',')}`);
  out(`  include_bound: ${plan.selector.include_bound ? 'yes' : 'no'}`);
  if (plan.candidates.length > 0) {
    out('  candidates:');
    for (const entry of plan.candidates) {
      out(`    - ${entry.id}: ${entry.state} (${entry.reason})`);
      if (entry.next_command !== undefined) out(`      next: ${entry.next_command}`);
    }
  }
  if (plan.skipped.length > 0) {
    out('  skipped:');
    for (const entry of plan.skipped) {
      out(`    - ${entry.id}: ${entry.state} (${entry.reason})`);
    }
  }
  if (plan.refused.length > 0) {
    out('  refused:');
    for (const entry of plan.refused) {
      out(`    - ${entry.id}: ${entry.state} (${entry.reason})`);
      if (entry.next_command !== undefined) out(`      next: ${entry.next_command}`);
    }
  }
  out('  No files, events, or worktree registry entries were written.');
  return 0;
}

// ─── caws specs activate ──────────────────────────────────────────────────

export interface SpecsActivateOptions extends BaseCommandOptions {
  readonly id: string;
}

export function runSpecsActivateCommand(opts: SpecsActivateOptions): number {
  const { cwd, nowFn, env, out, err, showData } = setupIO(opts);

  const ctx = resolveCawsCtx(cwd, err, showData, 'activate');
  if (ctx === null) return 2;

  const actor = buildActorOrError(
    ctx.cawsDir, cwd, env, nowFn, opts.actorKind, err, showData, 'activate'
  );
  if (actor === null) return 2;

  const result = activateSpec(ctx.cawsDir, {
    id: opts.id,
    now: nowFn,
    actor,
  });
  if (!isOk(result)) {
    err('caws specs activate: failed.');
    err(renderDiagnostics(result.errors, { showData }));
    return 1;
  }
  const outcome = result.value;
  if (outcome.kind === 'partial_failure_recovered') {
    err('caws specs activate: partial failure recovered (no state change).');
    err(renderDiagnostics(outcome.cause, { showData }));
    return 1;
  }
  out(`activated ${outcome.id}`);
  surfaceAuditCommit(outcome.data?.audit_commit, err);
  return 0;
}

// ─── caws specs amend-scope ──────────────────────────────────────────────

export interface SpecsAmendScopeOptions extends BaseCommandOptions {
  readonly id: string;
  readonly addIn?: readonly string[];
  readonly removeIn?: readonly string[];
  readonly addOut?: readonly string[];
  readonly removeOut?: readonly string[];
  readonly addSupport?: readonly string[];
  readonly removeSupport?: readonly string[];
  readonly reason?: string;
}

export function runSpecsAmendScopeCommand(opts: SpecsAmendScopeOptions): number {
  const { cwd, nowFn, env, out, err, showData } = setupIO(opts);

  const ctx = resolveCawsCtx(cwd, err, showData, 'amend-scope');
  if (ctx === null) return 2;

  const actor = buildActorOrError(
    ctx.cawsDir, cwd, env, nowFn, opts.actorKind, err, showData, 'amend-scope'
  );
  if (actor === null) return 2;

  const result = amendScopeSpec(ctx.cawsDir, {
    id: opts.id,
    ...(opts.addIn !== undefined ? { addIn: opts.addIn } : {}),
    ...(opts.removeIn !== undefined ? { removeIn: opts.removeIn } : {}),
    ...(opts.addOut !== undefined ? { addOut: opts.addOut } : {}),
    ...(opts.removeOut !== undefined ? { removeOut: opts.removeOut } : {}),
    ...(opts.addSupport !== undefined ? { addSupport: opts.addSupport } : {}),
    ...(opts.removeSupport !== undefined ? { removeSupport: opts.removeSupport } : {}),
    ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
    now: nowFn,
    actor,
  });
  if (!isOk(result)) {
    err('caws specs amend-scope: failed.');
    err(renderDiagnostics(result.errors, { showData }));
    return 1;
  }
  const outcome = result.value;
  if (outcome.kind === 'partial_failure_recovered') {
    err('caws specs amend-scope: partial failure recovered (no state change).');
    err(renderDiagnostics(outcome.cause, { showData }));
    return 1;
  }
  out(`amended scope for ${outcome.id}`);
  // WORKTREE-CLAIM-COMPOSE-WARN-001: print any non-blocking compose-trap
  // advisories to stderr. The amendment already succeeded; these never change
  // the exit code.
  for (const w of outcome.warnings ?? []) {
    err(`caws advisory (non-blocking): ${w}`);
  }
  surfaceAuditCommit(outcome.data?.audit_commit, err);
  return 0;
}

// ─── caws specs close ─────────────────────────────────────────────────────

export interface SpecsCloseOptions extends BaseCommandOptions {
  readonly id: string;
  readonly resolution: string;
  readonly reason?: string;
  readonly closureNotes?: string;
  readonly notes?: string;
  readonly mergeCommit?: string;
  readonly supersededBy?: string;
}

export function runSpecsCloseCommand(opts: SpecsCloseOptions): number {
  const { cwd, nowFn, env, out, err, showData } = setupIO(opts);

  if (!VALID_RESOLUTIONS.includes(opts.resolution as ValidResolution)) {
    err(
      `caws specs close: invalid --resolution "${opts.resolution}". Expected one of: ${VALID_RESOLUTIONS.join(', ')}.`
    );
    return 1;
  }

  const suppliedNoteAliases = [
    opts.reason !== undefined ? '--reason' : null,
    opts.closureNotes !== undefined ? '--closure-notes' : null,
    opts.notes !== undefined ? '--notes' : null,
  ].filter((value): value is string => value !== null);

  if (suppliedNoteAliases.length > 1) {
    err(
      `caws specs close: ${suppliedNoteAliases.join(' and ')} all write closure_notes; pass only one.`
    );
    return 1;
  }

  const closureNotes = opts.closureNotes ?? opts.notes ?? opts.reason;

  const ctx = resolveCawsCtx(cwd, err, showData, 'close');
  if (ctx === null) return 2;

  const actor = buildActorOrError(
    ctx.cawsDir, cwd, env, nowFn, opts.actorKind, err, showData, 'close'
  );
  if (actor === null) return 2;

  const input: Parameters<typeof closeSpec>[1] = {
    id: opts.id,
    resolution: opts.resolution as ValidResolution,
    now: nowFn,
    actor,
  };
  if (closureNotes !== undefined) (input as { reason?: string }).reason = closureNotes;
  if (opts.mergeCommit !== undefined) (input as { mergeCommit?: string }).mergeCommit = opts.mergeCommit;
  if (opts.supersededBy !== undefined) (input as { supersededBy?: string }).supersededBy = opts.supersededBy;

  const result = closeSpec(ctx.cawsDir, input);
  if (!isOk(result)) {
    err('caws specs close: failed.');
    err(renderDiagnostics(result.errors, { showData }));
    return 1;
  }
  const outcome = result.value;
  if (outcome.kind === 'partial_failure_recovered') {
    err('caws specs close: partial failure recovered (no state change).');
    err(renderDiagnostics(outcome.cause, { showData }));
    return 1;
  }
  out(`closed ${outcome.id} (resolution: ${opts.resolution})`);
  surfaceAuditCommit(outcome.data?.audit_commit, err);
  return 0;
}

// ─── caws specs archive ───────────────────────────────────────────────────

export interface SpecsArchiveOptions extends BaseCommandOptions {
  readonly id?: string;
  readonly reason?: string;
  readonly status?: 'closed';
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  readonly olderThanMs?: number | string;
  readonly updatedBefore?: string;
  readonly withoutWorktree?: boolean;
  readonly apply?: boolean;
  readonly json?: boolean;
}

export function runSpecsArchiveCommand(opts: SpecsArchiveOptions): number {
  const { cwd, nowFn, env, out, err, showData } = setupIO(opts);

  const olderThanMs = parseNonNegativeIntegerOption(opts.olderThanMs, '--older-than-ms');
  if (typeof olderThanMs === 'object') {
    err(`caws specs archive: ${olderThanMs.error}`);
    return 1;
  }

  const ctx = resolveCawsCtx(cwd, err, showData, 'archive');
  if (ctx === null) return 2;

  const batchFlagsPresent =
    opts.status !== undefined ||
    opts.include !== undefined ||
    opts.exclude !== undefined ||
    olderThanMs !== undefined ||
    opts.updatedBefore !== undefined ||
    opts.withoutWorktree === true ||
    opts.apply === true ||
    opts.json === true;
  if (opts.id !== undefined && batchFlagsPresent) {
    err('caws specs archive: <id> cannot be combined with batch flags.');
    err('  Use `caws specs archive <id>` for one spec, or `caws specs archive --status closed` for batch dry-run.');
    return 1;
  }

  if (opts.id === undefined) {
    if (opts.status !== 'closed') {
      err('caws specs archive: batch mode requires --status closed.');
      return 1;
    }

    const dryRun = opts.apply !== true;
    const selector = {
      status: opts.status,
      include: opts.include ?? [],
      exclude: opts.exclude ?? [],
      ...(olderThanMs !== undefined ? { older_than_ms: olderThanMs } : {}),
      ...(opts.updatedBefore !== undefined ? { updated_before: opts.updatedBefore } : {}),
      without_worktree: opts.withoutWorktree === true,
    };
    const selectionInput = {
      ...(opts.include !== undefined ? { include: opts.include } : {}),
      ...(opts.exclude !== undefined ? { exclude: opts.exclude } : {}),
      ...(olderThanMs !== undefined ? { olderThanMs } : {}),
      ...(opts.updatedBefore !== undefined ? { updatedBefore: opts.updatedBefore } : {}),
      ...(opts.withoutWorktree === true ? { withoutWorktree: true } : {}),
      now: nowFn,
    };

    if (dryRun) {
      const selected = selectClosedSpecsForArchive(ctx.cawsDir, selectionInput);
      if (!isOk(selected)) {
        err('caws specs archive: failed.');
        err(renderDiagnostics(selected.errors, { showData }));
        return 1;
      }
      const payload = {
        ok: selected.value.skipped.length === 0,
        dry_run: true,
        selector,
        snapshot: { count: selected.value.candidates.length },
        archived: [],
        candidates: selected.value.candidates.map((candidate) => ({
          id: candidate.id,
          path: path.relative(ctx.repoRoot, candidate.path),
          ...(candidate.timestamp !== undefined ? { timestamp: candidate.timestamp } : {}),
          ...(candidate.age_ms !== undefined ? { age_ms: candidate.age_ms } : {}),
          ...(candidate.worktree !== undefined ? { worktree: candidate.worktree } : {}),
        })),
        skipped: selected.value.skipped,
        failed: [],
      };
      if (opts.json === true) {
        emitJson(out, payload);
      } else {
        out(`archive --status closed (dry-run): ${selected.value.candidates.length} candidate(s)`);
        for (const candidate of selected.value.candidates) {
          out(`  would-archive ${candidate.id}`);
        }
        for (const skipped of selected.value.skipped) {
          const state = skipped.lifecycle_state !== undefined ? ` (${skipped.lifecycle_state})` : '';
          out(`  skipped ${skipped.id}: ${skipped.reason}${state}`);
        }
        const includeArg =
          selector.include.length > 0 ? ` --include ${selector.include.join(',')}` : '';
        const excludeArg =
          selector.exclude.length > 0 ? ` --exclude ${selector.exclude.join(',')}` : '';
        const olderArg =
          olderThanMs !== undefined ? ` --older-than-ms ${olderThanMs}` : '';
        const updatedBeforeArg =
          opts.updatedBefore !== undefined ? ` --updated-before ${opts.updatedBefore}` : '';
        const withoutWorktreeArg = opts.withoutWorktree === true ? ' --without-worktree' : '';
        out(`apply: caws specs archive --status closed${includeArg}${excludeArg}${olderArg}${updatedBeforeArg}${withoutWorktreeArg} --apply`);
      }
      return selected.value.skipped.length === 0 ? 0 : 1;
    }

    const actor = buildActorOrError(
      ctx.cawsDir, cwd, env, nowFn, opts.actorKind, err, showData, 'archive'
    );
    if (actor === null) return 2;

    const result = archiveClosedSpecs(ctx.cawsDir, {
      actor,
      ...selectionInput,
    });
    if (!isOk(result)) {
      err('caws specs archive: failed.');
      err(renderDiagnostics(result.errors, { showData }));
      return 1;
    }
    const outcome = result.value;
    const ok = outcome.skipped.length === 0 && outcome.failed.length === 0;
    if (opts.json === true) {
      emitJson(out, {
        ok,
        dry_run: false,
        selector,
        snapshot: {
          count: outcome.archived.length + outcome.skipped.length + outcome.failed.length,
        },
        archived: outcome.archived.map((entry) => ({
          id: entry.id,
          path: path.relative(ctx.repoRoot, entry.path),
        })),
        skipped: outcome.skipped,
        failed: outcome.failed,
      });
    } else {
      out(
        `archive --status closed (apply): archived ${outcome.archived.length}; skipped ${outcome.skipped.length}; failed ${outcome.failed.length}`
      );
      for (const entry of outcome.archived) {
        out(`  archived ${entry.id} → ${path.relative(ctx.repoRoot, entry.path)}`);
      }
      for (const skipped of outcome.skipped) {
        const state = skipped.lifecycle_state !== undefined ? ` (${skipped.lifecycle_state})` : '';
        out(`  skipped ${skipped.id}: ${skipped.reason}${state}`);
      }
      for (const failed of outcome.failed) {
        out(`  failed ${failed.id}: ${failed.reason}`);
      }
    }
    for (const warning of outcome.warnings ?? []) {
      err(`caws advisory (non-blocking): ${warning}`);
    }
    surfaceAuditCommit(outcome.data?.audit_commit, err);
    return ok ? 0 : 1;
  }

  const actor = buildActorOrError(
    ctx.cawsDir, cwd, env, nowFn, opts.actorKind, err, showData, 'archive'
  );
  if (actor === null) return 2;

  const input: Parameters<typeof archiveSpec>[1] = {
    id: opts.id,
    now: nowFn,
    actor,
  };
  if (opts.reason !== undefined) (input as { reason?: string }).reason = opts.reason;

  const result = archiveSpec(ctx.cawsDir, input);
  if (!isOk(result)) {
    err('caws specs archive: failed.');
    err(renderDiagnostics(result.errors, { showData }));
    return 1;
  }
  const outcome = result.value;
  if (outcome.kind === 'partial_failure_recovered') {
    err('caws specs archive: partial failure recovered (no state change).');
    err(renderDiagnostics(outcome.cause, { showData }));
    return 1;
  }
  out(`archived ${outcome.id} → ${path.relative(ctx.repoRoot, outcome.path)}`);
  for (const w of outcome.warnings ?? []) {
    err(`caws advisory (non-blocking): ${w}`);
  }
  surfaceAuditCommit(outcome.data?.audit_commit, err);
  return 0;
}

// ─── caws specs retire-draft (CAWS-SPECS-RETIRE-DRAFT-001) ─────────────────

export interface SpecsRetireDraftOptions extends BaseCommandOptions {
  readonly id: string;
  readonly reason?: string;
}

export function runSpecsRetireDraftCommand(
  opts: SpecsRetireDraftOptions
): number {
  const { cwd, nowFn, env, out, err, showData } = setupIO(opts);

  const ctx = resolveCawsCtx(cwd, err, showData, 'retire-draft');
  if (ctx === null) return 2;

  const actor = buildActorOrError(
    ctx.cawsDir, cwd, env, nowFn, opts.actorKind, err, showData, 'retire-draft'
  );
  if (actor === null) return 2;

  const input: Parameters<typeof retireDraftSpec>[1] = {
    id: opts.id,
    now: nowFn,
    actor,
  };
  if (opts.reason !== undefined) (input as { reason?: string }).reason = opts.reason;

  const result = retireDraftSpec(ctx.cawsDir, input);
  if (!isOk(result)) {
    err('caws specs retire-draft: failed.');
    err(renderDiagnostics(result.errors, { showData }));
    return 1;
  }
  const outcome = result.value;
  if (outcome.kind === 'partial_failure_recovered') {
    err('caws specs retire-draft: partial failure recovered (no state change).');
    err(renderDiagnostics(outcome.cause, { showData }));
    return 1;
  }
  out(`retired draft ${outcome.id} (recoverable via caws specs show ${outcome.id} --archived)`);
  surfaceAuditCommit(outcome.data?.audit_commit, err);
  return 0;
}

// ---------------------------------------------------------------------------
// caws specs migrate — adapter for runSpecsMigrateApply.
//
// Adapter discipline: this command parses flags, loads the optional
// lifecycle-mapping file, delegates to the store, renders. It does NOT
// duplicate transformer or store authority. The substrate assertion
// (cawsDir basename === '.caws') lives in the store; this shell just
// surfaces the diagnostic. Lifecycle-mapping semantics — e.g. that a
// mapped 'archived'/'closed' lifecycle requires the operator to also
// supply 'resolution' — are owned by the kernel/store; the shell does
// not auto-default.
//
// Per the spec (CAWS-MIGRATE-V10-SPECS-001 A12 / Sterling smoke):
//   - --from v10 is the only supported source in v11.2.
//   - default is dry-run (no writes); --apply opts into mutation.
//   - --apply alone refuses on any 'refused' verdict.
//   - --apply --partial writes migratable, skips refused, emits report.
//   - --lifecycle-mapping <path> supplies a JSON file: { <spec_id>: { lifecycle_state, resolution?, closure_notes? } }.
//   - --json emits a single JSON object to stdout instead of human-rendered text.
//
// Exit codes:
//   0 = success (dry-run completed OR --apply succeeded)
//   1 = store-layer refusal (substrate / refusals_present / report_write_failed)
//   2 = composition failure (repo-root, lifecycle-mapping file IO/parse)
// ---------------------------------------------------------------------------

export interface SpecsMigrateOptions extends BaseCommandOptions {
  readonly from: string;
  readonly apply?: boolean;
  readonly partial?: boolean;
  readonly lifecycleMappingPath?: string;
  readonly json?: boolean;
}

export function runSpecsMigrateCommand(opts: SpecsMigrateOptions): number {
  const { cwd, nowFn, out, err, showData } = setupIO(opts);

  // --from must be exactly 'v10' (matches caws events migrate semantics).
  if (opts.from !== 'v10') {
    err(
      `caws specs migrate: only --from v10 is supported in v11.2; got ${JSON.stringify(opts.from)}.`,
    );
    return 1;
  }

  const ctx = resolveCawsCtx(cwd, err, showData, 'migrate');
  if (ctx === null) return 2;

  // Load optional lifecycle mapping file. Composition failure (file
  // missing, unreadable, malformed JSON) is exit 2 — we cannot
  // proceed with an incomplete operator decision.
  let lifecycleMapping: LifecycleMapping | undefined;
  if (opts.lifecycleMappingPath !== undefined) {
    const loadResult = loadLifecycleMappingFile(opts.lifecycleMappingPath);
    if (!loadResult.ok) {
      err(`caws specs migrate: failed to load --lifecycle-mapping file.`);
      err(loadResult.message);
      return 2;
    }
    lifecycleMapping = loadResult.mapping;
  }

  // Delegate to the store.
  const result = runSpecsMigrateApply({
    cawsDir: ctx.cawsDir,
    from: 'v10',
    apply: opts.apply === true,
    partial: opts.partial === true,
    now: nowFn(),
    ...(lifecycleMapping !== undefined ? { lifecycleMapping } : {}),
  });

  if (!result.ok) {
    if (opts.json === true) {
      out(
        JSON.stringify(
          {
            ok: false,
            errors: result.errors.map((d) => ({
              rule: d.rule,
              message: d.message,
              ...(d.data !== undefined ? { data: d.data } : {}),
            })),
          },
          null,
          2,
        ),
      );
    } else {
      err('caws specs migrate: failed.');
      err(renderDiagnostics(result.errors, { showData }));
    }
    return 1;
  }

  if (opts.json === true) {
    renderApplyJson(result.value, out);
  } else {
    renderApplyHuman(result.value, ctx.repoRoot, opts.apply === true, out);
  }

  // CAWS-CLI-EXIT-CODES-001 (D7): an apply run that left specs un-migrated
  // because they FAILED must exit non-zero so shell `&&` chains and CI observe
  // the incomplete migration. The store returns ok() for a --partial --apply
  // even when some specs hit post-write validation failure or were refused; if
  // we returned 0 unconditionally the failure would be invisible to callers.
  //   - apply + post_write_validation_failed > 0: a spec the operator asked to
  //     migrate could not be written (transformer/serialization/IO). Always a
  //     failure exit.
  //   - apply + partial + refused > 0: --partial deliberately skips refused
  //     specs, but the migration is still incomplete — exit non-zero. (Non-
  //     partial apply with refused > 0 never reaches here: the store returns
  //     err earlier via SPECS_MIGRATE_REFUSALS_PRESENT.)
  //   - dry-run (apply=false): nothing was attempted, the report is
  //     informational, and post-write validation cannot occur — stays exit 0.
  if (opts.apply === true) {
    const dist = result.value.report.distribution;
    if (dist.post_write_validation_failed > 0) return 1;
    if (result.value.partial && dist.refused > 0) return 1;
  }

  return 0;
}

function loadLifecycleMappingFile(
  filePath: string,
): { ok: true; mapping: LifecycleMapping } | { ok: false; message: string } {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    const cause = e as { message?: string; code?: string };
    return {
      ok: false,
      message: `Cannot read ${filePath}: ${cause.message ?? 'unknown error'} (${cause.code ?? 'unknown code'}).`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    const cause = e as { message?: string };
    return {
      ok: false,
      message: renderLifecycleMappingFileFailure(
        `Cannot parse ${filePath} as JSON: ${cause.message ?? 'unknown error'}.`,
      ),
    };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      message: renderLifecycleMappingFileFailure(
        `Lifecycle mapping file ${filePath} must be a JSON object keyed by spec id; got ${typeof parsed === 'object' ? 'array' : typeof parsed}.`,
      ),
    };
  }
  // Lightweight shape check — every value should be an object with a
  // lifecycle_state field. Kernel will do strict validation when
  // applying; this is enough to fail fast on obviously-wrong input.
  for (const [specId, entry] of Object.entries(parsed)) {
    if (typeof entry !== 'object' || entry === null) {
      return {
        ok: false,
        message: renderLifecycleMappingFileFailure(
          `Lifecycle mapping entry "${specId}" is not an object.`,
        ),
      };
    }
    const e = entry as Record<string, unknown>;
    if (typeof e['lifecycle_state'] !== 'string') {
      return {
        ok: false,
        message: renderLifecycleMappingFileFailure(
          `Lifecycle mapping entry "${specId}" is missing required string field "lifecycle_state".`,
        ),
      };
    }
  }
  return { ok: true, mapping: parsed as LifecycleMapping };
}

function renderLifecycleMappingFileFailure(message: string): string {
  return [
    message,
    'Expected --lifecycle-mapping JSON shape:',
    '  {',
    '    "<spec-id>": {',
    '      "lifecycle_state": "active|draft|closed|archived",',
    '      "resolution": "implemented",',
    '      "closure_notes": "optional migrated closure note"',
    '    }',
    '  }',
    'Example mapping file:',
    '  {',
    '    "FEAT-123": {',
    '      "lifecycle_state": "closed",',
    '      "resolution": "implemented",',
    '      "closure_notes": "Migrated from v10 closed spec."',
    '    },',
    '    "FEAT-456": {',
    '      "lifecycle_state": "active"',
    '    }',
    '  }',
    'Tip: write this as a JSON file and pass its path, for example:',
    '  caws specs migrate --from v10 --lifecycle-mapping lifecycle-map.json',
  ].join('\n');
}

function renderApplyHuman(
  result: SpecsMigrateApplyResult,
  repoRoot: string,
  applied: boolean,
  out: (line: string) => void,
): void {
  const tag = applied ? '[apply]' : '[dry-run]';
  const r: MigrationReport = result.report;
  out(`${tag} caws specs migrate --from v10`);
  out(
    `  distribution: migrated=${r.distribution.migrated} migrated_with_warnings=${r.distribution.migrated_with_warnings} refused=${r.distribution.refused} post_write_validation_failed=${r.distribution.post_write_validation_failed} total=${r.distribution.total}`,
  );
  if (r.non_yaml_observations.length > 0) {
    out(`  non_yaml observations:`);
    for (const obs of r.non_yaml_observations) {
      out(`    - ${obs.file} (${obs.kind})`);
    }
  }
  // Per-entry summary. Operator sees what's actionable; full detail is
  // in the durable report (and --json).
  for (const e of r.entries) {
    const tagPrefix = entryTag(e.verdict);
    const idStr = e.spec_id ?? '(no id)';
    out(`  ${tagPrefix} ${e.file} (${idStr}) — ${e.verdict}`);
    if (e.verdict === 'refused' && e.refusal_reasons.length > 0) {
      for (const reason of e.refusal_reasons) {
        out(`      reason: ${reason}`);
      }
    }
    if (e.verdict === 'post_write_validation_failed' && e.post_write_validation_errors.length > 0) {
      for (const v of e.post_write_validation_errors) {
        out(`      validation: ${v.rule}: ${v.message}`);
      }
    }
  }
  if (result.report_path !== null) {
    out(`  report: ${path.relative(repoRoot, result.report_path)}`);
  } else {
    out(`  report: (dry-run; not persisted)`);
  }
}

function entryTag(verdict: string): string {
  switch (verdict) {
    case 'migrated':
      return 'OK   ';
    case 'migrated_with_warnings':
      return 'WARN ';
    case 'refused':
      return 'REF  ';
    case 'post_write_validation_failed':
      return 'PWF  ';
    default:
      return '?    ';
  }
}

function renderApplyJson(
  result: SpecsMigrateApplyResult,
  out: (line: string) => void,
): void {
  // Preserve the store's report shape verbatim (per the contract
  // spec-v10-migration-output). Do not invent a second report shape.
  out(
    JSON.stringify(
      {
        ok: true,
        cawsDir: result.cawsDir,
        partial: result.partial,
        report_path: result.report_path,
        report: result.report,
      },
      null,
      2,
    ),
  );
}

// ─── caws specs prune-archive (CAWS-ARCHIVE-AS-TOMBSTONE-001 A8/A9) ─────
//
// Migrates legacy .caws/specs/.archive/<id>.yaml bodies. Dry-run by
// default; --apply executes. The prove-recovery-or-quarantine
// invariant is absolute — there is NO override flag that would let
// prune delete an unrecoverable body.

export interface SpecsPruneArchiveOptions extends BaseCommandOptions {
  /** Default false → dry-run. Pass true to mutate the filesystem. */
  readonly apply?: boolean;
}

export function runSpecsPruneArchiveCommand(opts: SpecsPruneArchiveOptions): number {
  const { cwd, out, err, showData } = setupIO(opts);
  const ctx = resolveCawsCtx(cwd, err, showData, 'prune-archive');
  if (ctx === null) return 2;

  void opts.apply;
  void ctx;
  out('caws specs prune-archive: no-op. Archived spec bodies under .caws/specs/.archive/ are canonical again and are not pruned by CAWS.');
  out('  To archive closed specs: caws specs archive --status closed');
  out('  To restore an archived spec: caws specs restore <id> --as draft');
  out('  To recover the archived body: caws specs recover <id> --out <path>');
  return 0;
}

// ─── caws specs validate <file> ──────────────────────────────────────────
//
// CAWS-SPECS-VALIDATE-FILE-CMD-001: validate a spec YAML FILE on disk using
// the CLI's own bundled parser + the kernel parse->shape->semantics pipeline.
// The whole point is that the parser lives in CAWS tooling, NOT embedded in
// shell hooks via `node -e require('js-yaml')`: this works for any consumer
// project regardless of language, and regardless of whether js-yaml is
// resolvable from the consumer's own node context. Hooks (validate-spec.sh)
// and CI shell out to this command instead of carrying a parser dependency.
//
// This is path-shaped, NOT id-shaped: it takes the filesystem path to the
// file to validate, does NOT resolve `.caws/`, does NOT read canonical state,
// and does NOT mutate anything. Exit code is the verdict (0 valid / non-zero
// invalid|unreadable). A missing/unreadable file produces an honest error —
// never a false "YAML syntax error" for a file that was never parsed.

export interface SpecsValidateOptions extends BaseCommandOptions {
  readonly file: string;
}

export function runSpecsValidateCommand(opts: SpecsValidateOptions): number {
  const { out, err, showData } = setupIO(opts);
  const filePath = opts.file;

  let source: string;
  try {
    source = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Honest file-access error. NOT a YAML syntax error — the parser never
    // ran (CAWS-SPECS-VALIDATE-FILE-CMD-001 A4). This is the exact conflation
    // the old embedded-js-yaml hook produced and that this command exists to
    // eliminate.
    err(`caws specs validate: cannot read file ${filePath}`);
    err(`  ${msg}`);
    return 1;
  }

  const result = parseAndValidateSpec(source, { sourcePath: filePath });
  if (!isOk(result)) {
    err(`caws specs validate: ${filePath} is invalid.`);
    err(renderDiagnostics(result.errors, { showData }));
    if (hasSpecParseOrSchemaDiagnostics(result.errors)) {
      err(renderSpecParseGuidance(filePath));
    }
    return 1;
  }

  out(`caws specs validate: ${filePath} is valid (${result.value.id}).`);
  return 0;
}
