// `caws init` — store-side bootstrap of the canonical vNext .caws/ shape.
//
// What this adapter creates (when absent):
//
//   .caws/
//   .caws/specs/                  empty dir, multi-spec lives here
//   .caws/waivers/                empty dir, slice-7a authority surface
//   .caws/policy.yaml             kernel-validated default policy
//   .caws/worktrees.json          {}
//   .caws/agents.json             {}
//
// What this adapter intentionally does NOT create:
//
//   .caws/working-spec.yaml       legacy single-spec entry point — the
//                                 vNext model is multi-spec under
//                                 .caws/specs/<id>.yaml. Seeding
//                                 working-spec.yaml would silently
//                                 reintroduce the legacy authority.
//   .caws/working-spec.schema.json  same reason.
//   .caws/events.jsonl            evidence is append-only and
//                                 created by the first event under
//                                 lock. Manufacturing an empty file
//                                 would either be a zero-event chain
//                                 (no genesis) or require a synthetic
//                                 init event that doesn't represent
//                                 any real state transition. The
//                                 store treats a missing file as
//                                 `events: []`, so doctor / status /
//                                 waiver list all work without it.
//
// Idempotence and refusal:
//   - missing .caws            → create canonical state.
//   - all canonical files exist → no-op, return AlreadyInitialized.
//   - any LEGACY residue       → refuse with INIT_LEGACY_RESIDUE
//                                naming each offending path. Do NOT
//                                touch anything. Repair belongs to a
//                                later doctor/repair surface.
//
// Authority discipline:
//   - The seeded policy MUST pass `parseAndValidatePolicy` before
//     hitting disk. If it doesn't, init refuses (this is a programmer
//     error in our default, not a user-recoverable condition).
//   - All writes go through `writeFileAtomic`. Concurrent invocations
//     either both see "already initialized" or one wins and the other
//     observes the same canonical state.

import * as fs from 'fs';
import * as path from 'path';

import {
  isOk,
  parseAndValidatePolicy,
  type Diagnostic,
  type Policy,
  type Result,
} from '@paths.design/caws-kernel';
import { err, ok } from '@paths.design/caws-kernel';

import { writeFileAtomic } from './atomic-write';
import { storeDiagnostic } from './repo-root';
import { STORE_RULES } from './rules';

// ---------------------------------------------------------------------------
// Canonical layout
// ---------------------------------------------------------------------------

/** Canonical files/dirs init creates (or expects to be present already). */
const CANONICAL_PATHS = {
  cawsDir: '.caws',
  specsDir: '.caws/specs',
  waiversDir: '.caws/waivers',
  policyFile: '.caws/policy.yaml',
  worktreesFile: '.caws/worktrees.json',
  agentsFile: '.caws/agents.json',
} as const;

/**
 * Files whose presence inside `.caws/` indicates legacy single-spec /
 * pre-vNext state. init refuses to touch these — repair belongs to a
 * later doctor/repair surface. Adding more entries here is the
 * sanctioned way to extend the legacy-residue check.
 */
const LEGACY_PATHS = [
  '.caws/working-spec.yaml',
  '.caws/working-spec.schema.json',
] as const;

// ---------------------------------------------------------------------------
// Default policy
//
// The seed below mirrors the gate set the vNext gates command knows
// about. Block-mode for the structural gates (budget_limit,
// spec_completeness, scope_boundary), warn for the heuristic gates
// (god_object, todo_detection). edit_rules is set to the conservative
// "policy and code may live in the same PR" default; teams can tighten.
// ---------------------------------------------------------------------------

export const DEFAULT_POLICY_YAML = `version: 1
risk_tiers:
  '1':
    max_files: 5
    max_loc: 200
  '2':
    max_files: 15
    max_loc: 600
  '3':
    max_files: 30
    max_loc: 1500
gates:
  budget_limit:
    enabled: true
    mode: block
  spec_completeness:
    enabled: true
    mode: block
  scope_boundary:
    enabled: true
    mode: block
  god_object:
    enabled: true
    mode: warn
  todo_detection:
    enabled: true
    mode: warn
edit_rules:
  policy_and_code_same_pr: true
  require_signed_commits: false
  require_dual_control_for_governance: false
`;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type InitOutcome = 'created' | 'already_initialized';

export interface InitProjectResult {
  readonly outcome: InitOutcome;
  /** Absolute paths of files/dirs newly created. Empty when already initialized. */
  readonly created: readonly string[];
  /** Validated policy (whether freshly seeded or already on disk). */
  readonly policy: Policy;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

function abs(repoRoot: string, rel: string): string {
  return path.join(repoRoot, rel);
}

function existsCanonical(repoRoot: string): {
  readonly cawsDir: boolean;
  readonly specsDir: boolean;
  readonly waiversDir: boolean;
  readonly policyFile: boolean;
  readonly worktreesFile: boolean;
  readonly agentsFile: boolean;
} {
  const isFile = (p: string) => fs.existsSync(p) && fs.statSync(p).isFile();
  const isDir = (p: string) => fs.existsSync(p) && fs.statSync(p).isDirectory();
  return {
    cawsDir: isDir(abs(repoRoot, CANONICAL_PATHS.cawsDir)),
    specsDir: isDir(abs(repoRoot, CANONICAL_PATHS.specsDir)),
    waiversDir: isDir(abs(repoRoot, CANONICAL_PATHS.waiversDir)),
    policyFile: isFile(abs(repoRoot, CANONICAL_PATHS.policyFile)),
    worktreesFile: isFile(abs(repoRoot, CANONICAL_PATHS.worktreesFile)),
    agentsFile: isFile(abs(repoRoot, CANONICAL_PATHS.agentsFile)),
  };
}

function findLegacyResidue(repoRoot: string): string[] {
  const found: string[] = [];
  for (const rel of LEGACY_PATHS) {
    if (fs.existsSync(abs(repoRoot, rel))) found.push(abs(repoRoot, rel));
  }
  return found;
}

function legacyDiag(found: readonly string[]): Diagnostic {
  return storeDiagnostic(
    STORE_RULES.INIT_LEGACY_RESIDUE,
    `caws init refuses to overwrite legacy state: ${found.join(', ')}.`,
    {
      narrowRepair:
        'Move or remove the listed files manually, then re-run `caws init`. Repair tooling belongs to a later doctor/repair surface; init is intentionally non-destructive.',
      data: { legacy_paths: found.slice() },
    }
  );
}

function mkdirRecursive(target: string): Result<true> {
  try {
    fs.mkdirSync(target, { recursive: true });
    return ok(true as const);
  } catch (e) {
    return err(
      storeDiagnostic(
        STORE_RULES.WRITE_IO_FAILED,
        `Failed to create ${target}: ${(e as Error).message}.`,
        { subject: target }
      )
    );
  }
}

/**
 * Idempotent vNext init. Returns:
 *
 *   Ok({ outcome: 'created', created: [...], policy })
 *   Ok({ outcome: 'already_initialized', created: [], policy })
 *   Err  on legacy residue (INIT_LEGACY_RESIDUE) or write failure
 *        (WRITE_IO_FAILED) or a default-policy that fails kernel
 *        validation (INIT_DEFAULT_POLICY_INVALID).
 */
export function initProject(
  repoRoot: string
): Result<InitProjectResult> {
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) {
    throw new TypeError('initProject: repoRoot must be a non-empty string.');
  }

  // 1. Refuse if any legacy residue exists. Do this BEFORE any write so
  //    the caller's repo is not mutated when we say "no".
  const residue = findLegacyResidue(repoRoot);
  if (residue.length > 0) {
    return err(legacyDiag(residue));
  }

  // 2. Validate the default policy through the kernel. If our seed is
  //    bad, surface that as INIT_DEFAULT_POLICY_INVALID — do NOT write
  //    a known-invalid policy to disk just to keep init succeeding.
  const validatedPolicy = parseAndValidatePolicy(DEFAULT_POLICY_YAML);
  if (!isOk(validatedPolicy)) {
    return err(
      storeDiagnostic(
        STORE_RULES.INIT_DEFAULT_POLICY_INVALID,
        `Default policy failed kernel validation: ${validatedPolicy.errors.map((d) => d.rule).join(', ')}.`,
        { data: { kernel_diagnostics: validatedPolicy.errors.slice() } }
      )
    );
  }
  const policy = validatedPolicy.value;

  // 3. Decide outcome. If every canonical file/dir is present, do nothing.
  const present = existsCanonical(repoRoot);
  const allPresent =
    present.cawsDir &&
    present.specsDir &&
    present.waiversDir &&
    present.policyFile &&
    present.worktreesFile &&
    present.agentsFile;
  if (allPresent) {
    return ok({
      outcome: 'already_initialized',
      created: [],
      policy,
    });
  }

  // 4. Create the missing pieces. We track what we actually wrote so the
  //    shell can report "what changed" precisely. Each step is its own
  //    Ok-or-Err — we abort on the first error rather than continue and
  //    partially populate.
  const created: string[] = [];

  if (!present.cawsDir) {
    const r = mkdirRecursive(abs(repoRoot, CANONICAL_PATHS.cawsDir));
    if (!isOk(r)) return r;
    created.push(abs(repoRoot, CANONICAL_PATHS.cawsDir));
  }
  if (!present.specsDir) {
    const r = mkdirRecursive(abs(repoRoot, CANONICAL_PATHS.specsDir));
    if (!isOk(r)) return r;
    created.push(abs(repoRoot, CANONICAL_PATHS.specsDir));
  }
  if (!present.waiversDir) {
    const r = mkdirRecursive(abs(repoRoot, CANONICAL_PATHS.waiversDir));
    if (!isOk(r)) return r;
    created.push(abs(repoRoot, CANONICAL_PATHS.waiversDir));
  }
  if (!present.policyFile) {
    const r = writeFileAtomic(
      abs(repoRoot, CANONICAL_PATHS.policyFile),
      DEFAULT_POLICY_YAML
    );
    if (!isOk(r)) return r;
    created.push(abs(repoRoot, CANONICAL_PATHS.policyFile));
  }
  if (!present.worktreesFile) {
    const r = writeFileAtomic(
      abs(repoRoot, CANONICAL_PATHS.worktreesFile),
      '{}\n'
    );
    if (!isOk(r)) return r;
    created.push(abs(repoRoot, CANONICAL_PATHS.worktreesFile));
  }
  if (!present.agentsFile) {
    const r = writeFileAtomic(
      abs(repoRoot, CANONICAL_PATHS.agentsFile),
      '{}\n'
    );
    if (!isOk(r)) return r;
    created.push(abs(repoRoot, CANONICAL_PATHS.agentsFile));
  }

  return ok({
    outcome: 'created',
    created,
    policy,
  });
}
