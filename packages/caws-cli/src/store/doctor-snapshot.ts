// Doctor snapshot composition.
//
// Pulls state from each store adapter and assembles two artifacts:
//   1. StoreSnapshot — the full I/O-derived state, including load
//      diagnostics. The shell uses this for separate display of
//      load failures.
//   2. DoctorInput — the projection of valid state the kernel's
//      `inspectProjectState` accepts.
//
// Discipline:
//   - The composer does NOT invent validation. It loads, calls the
//     existing kernel functions, and forwards.
//   - The composer accepts `now` as input. It never reads Date.now().
//   - Template-check discovery is OUT OF SCOPE in Slice 5b. If the
//     caller wants template diagnostics, they pass `TemplateCheck[]`
//     themselves.
//   - Session capsules (.caws/sessions/<id>.json) are OUT OF SCOPE in
//     Slice 5b — they're tied to identity resolution which is a Slice
//     5c concern.

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import {
  isOk,
  type Diagnostic,
  type DoctorInput,
  type GitWorktreeEntry,
  type TemplateCheck,
} from '@paths.design/caws-kernel';
import { loadAgents } from './agents-store';
import { loadEvents } from './events-store';
import { loadPolicy } from './policy-store';
import { loadSpecs } from './specs-store';
import type { StoreSnapshot } from './types';
import { loadWaivers } from './waivers-store';
import { loadWorktrees } from './worktrees-store';

// ----------------------------------------------------------------------------
// composeStoreSnapshot — fuller snapshot that carries every load diagnostic.
// ----------------------------------------------------------------------------

export interface ComposeOptions {
  readonly repoRoot: string;
  readonly cawsDir: string;
}

export function composeStoreSnapshot(options: ComposeOptions): StoreSnapshot {
  const { repoRoot, cawsDir } = options;
  const specsResult = loadSpecs(cawsDir);
  const policyResult = loadPolicy(cawsDir);
  const worktreesResult = loadWorktrees(cawsDir);
  const agentsResult = loadAgents(cawsDir);
  const eventsResult = loadEvents(cawsDir);
  const waiversResult = loadWaivers(cawsDir);

  // Slice 7c.1 — observe vNext-shape facts the kernel cannot derive.
  // The store is the only place that may stat the filesystem; doctor
  // consumes the booleans below without any I/O of its own.
  const initResidue = observeInitResidue(cawsDir);
  const worktrees = isOk(worktreesResult) ? worktreesResult.value : {};
  // WORKTREE-DOCTOR-HALF-STATE-FOLLOWUP-001: pass the loaded, validated
  // specs so observeFilesystem can populate specClaimedWorktreeDirByName
  // from each spec's worktree: field. The kernel's H4 enrichment uses
  // this spec-claim-keyed map (NOT the registry-keyed worktreeDirByName)
  // so it can distinguish "we observed the canonical path is absent"
  // from "we never observed the canonical path."
  const filesystem = observeFilesystem(cawsDir, worktrees, specsResult.specs);
  const registryDiagnostics = collectRegistryDiagnostics(
    worktreesResult,
    agentsResult
  );

  // WORKTREE-DOCTOR-HALF-STATE-001 — observe git worktree state.
  // Non-fatal: on failure, gitWorktrees is undefined and
  // gitObservationFailure carries the reason. The kernel emits
  // doctor.worktree.git_observation_unavailable and silently skips
  // H1/H6 rules. The rest of the report still runs.
  const gitObservation = observeGitWorktrees(repoRoot);

  return {
    repoRoot,
    cawsDir,
    specs: specsResult.specs,
    specDiagnostics: specsResult.diagnostics,
    ...(policyResult.policy !== undefined ? { policy: policyResult.policy } : {}),
    policyWarnings: policyResult.warnings,
    policyErrors: policyResult.errors,
    worktrees,
    agents: isOk(agentsResult) ? agentsResult.value : {},
    events: isOk(eventsResult) ? eventsResult.value.events : [],
    eventWarnings: isOk(eventsResult) ? eventsResult.value.warnings : eventsResult.errors,
    waivers: waiversResult.waivers,
    waiverDiagnostics: waiversResult.diagnostics,
    initResidue,
    filesystem,
    registryDiagnostics,
    ...(gitObservation.kind === 'ok'
      ? { gitWorktrees: gitObservation.entries }
      : { gitObservationFailure: gitObservation.reason }),
  };
}

// ----------------------------------------------------------------------------
// 7c.1 helpers — file-existence observation
//
// These intentionally do NOT distinguish "not a file vs not a directory" —
// doctor's rules in 7c.2 only need "is this canonical surface present?".
// Distinguishing kind would expand the input shape with information no
// rule yet consumes.
// ----------------------------------------------------------------------------

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function observeInitResidue(cawsDir: string): StoreSnapshot['initResidue'] {
  return {
    workingSpecYaml: isFile(path.join(cawsDir, 'working-spec.yaml')),
    workingSpecSchemaJson: isFile(
      path.join(cawsDir, 'working-spec.schema.json')
    ),
  };
}

function observeFilesystem(
  cawsDir: string,
  worktrees: Readonly<Record<string, unknown>>,
  specs: readonly { readonly worktree?: string }[]
): StoreSnapshot['filesystem'] {
  // WORKTREE-DOCTOR-HALF-STATE-001: per-registry-entry canonical
  // worktree directory presence. Used by kernel H1. Canonical path
  // matches worktrees-writer.ts:worktreePathFor (cawsDir/worktrees/<name>).
  // We use canonical-path-from-name (not entry.path) because entry.path
  // can be undefined on legacy entries.
  const worktreeDirByName: Record<string, boolean> = {};
  for (const name of Object.keys(worktrees)) {
    worktreeDirByName[name] = isDir(path.join(cawsDir, 'worktrees', name));
  }
  // WORKTREE-DOCTOR-HALF-STATE-FOLLOWUP-001: per-spec-claim canonical
  // worktree directory presence. Used by kernel H4 enrichment on
  // BINDING_SPEC_MISSING_REGISTRY. Distinct from worktreeDirByName
  // because the H4 case is precisely "spec claims X, registry has no
  // X" — X is by construction NOT a registry key. Stat each unique
  // spec-claimed name exactly once (multiple specs claiming the same
  // name share one observation; the value is identical regardless).
  const specClaimedWorktreeDirByName: Record<string, boolean> = {};
  for (const spec of specs) {
    const name = spec.worktree;
    if (typeof name !== 'string' || name.length === 0) continue;
    if (Object.prototype.hasOwnProperty.call(specClaimedWorktreeDirByName, name)) {
      continue;
    }
    specClaimedWorktreeDirByName[name] = isDir(
      path.join(cawsDir, 'worktrees', name)
    );
  }
  return {
    cawsDirExists: isDir(cawsDir),
    specsDirExists: isDir(path.join(cawsDir, 'specs')),
    waiversDirExists: isDir(path.join(cawsDir, 'waivers')),
    policyYamlExists: isFile(path.join(cawsDir, 'policy.yaml')),
    worktreesJsonExists: isFile(path.join(cawsDir, 'worktrees.json')),
    agentsJsonExists: isFile(path.join(cawsDir, 'agents.json')),
    eventsJsonlExists: isFile(path.join(cawsDir, 'events.jsonl')),
    worktreeDirByName,
    specClaimedWorktreeDirByName,
    legacyArchiveBodyCount: countLegacyArchiveBodies(cawsDir),
  };
}

/**
 * CAWS-ARCHIVE-AS-TOMBSTONE-001: count .yaml files at the TOP of
 * .caws/specs/.archive/. Excludes the .unrecoverable/ subdirectory
 * (that's the quarantine destination, not a source). Returns 0 when
 * the directory doesn't exist (which is the post-tombstone steady
 * state).
 */
function countLegacyArchiveBodies(cawsDir: string): number {
  const archiveDir = path.join(cawsDir, 'specs', '.archive');
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(archiveDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let count = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml')) count++;
  }
  return count;
}

// ----------------------------------------------------------------------------
// WORKTREE-DOCTOR-HALF-STATE-001 — git worktree observation
//
// Local porcelain parser. DO NOT import parseWorktreePorcelain from
// packages/caws-cli/src/shell/binding/resolve-binding.ts: store must not
// depend on shell. Parser/type deduplication to a shared kernel-owned
// location is deferred follow-up debt (see WORKTREE-DOCTOR-HALF-STATE-001
// closure notes).
//
// The porcelain format is stable per `git help worktree`:
//
//   worktree /absolute/path
//   HEAD <sha>
//   branch refs/heads/<name>
//   <blank line>
//
// Fields we care about: `worktree <path>` and `branch <ref>`. HEAD SHA
// ignored. Detached worktrees lack the branch line (we leave `branch`
// undefined).
//
// Main worktree filtered out before delivery: its path === repoRoot.
// ----------------------------------------------------------------------------

type GitObservationResult =
  | { readonly kind: 'ok'; readonly entries: readonly GitWorktreeEntry[] }
  | { readonly kind: 'fail'; readonly reason: string };

function observeGitWorktrees(repoRoot: string): GitObservationResult {
  let result;
  try {
    result = spawnSync(
      'git',
      ['-C', repoRoot, 'worktree', 'list', '--porcelain'],
      { encoding: 'utf8' }
    );
  } catch (e) {
    // spawnSync throws for some platform errors (e.g. ENOENT on git)
    // depending on Node version / option flags. Treat all throws as
    // observation failures rather than crashing doctor.
    const msg = (e as { message?: string }).message ?? 'unknown spawn error';
    return { kind: 'fail', reason: `git spawn failed: ${msg}` };
  }
  if (result.error) {
    return {
      kind: 'fail',
      reason: `git spawn error: ${result.error.message}`,
    };
  }
  if (typeof result.status !== 'number' || result.status !== 0) {
    const stderr = (result.stderr ?? '').toString().trim();
    return {
      kind: 'fail',
      reason: `git worktree list exited ${result.status ?? '<null>'}: ${stderr || 'no stderr'}`,
    };
  }
  const stdout = (result.stdout ?? '').toString();
  const allEntries = parseWorktreePorcelainLocal(stdout);
  // Filter out the main worktree (path === repoRoot).
  // Use realpath comparison defensively against symlinks; if realpath
  // throws, fall back to string equality.
  let canonicalRepoRoot: string;
  try {
    canonicalRepoRoot = fs.realpathSync(repoRoot);
  } catch {
    canonicalRepoRoot = repoRoot;
  }
  const linked = allEntries.filter((entry) => {
    let canonicalEntryPath: string;
    try {
      canonicalEntryPath = fs.realpathSync(entry.path);
    } catch {
      canonicalEntryPath = entry.path;
    }
    return canonicalEntryPath !== canonicalRepoRoot;
  });
  return { kind: 'ok', entries: linked };
}

function parseWorktreePorcelainLocal(text: string): GitWorktreeEntry[] {
  const entries: GitWorktreeEntry[] = [];
  // Stanzas are separated by blank lines. Split on \n and walk; a stanza
  // ends on an empty line or end-of-text.
  let currentPath: string | undefined;
  let currentBranch: string | undefined;
  const flush = () => {
    if (currentPath !== undefined) {
      const entry: GitWorktreeEntry =
        currentBranch !== undefined
          ? { path: currentPath, branch: currentBranch }
          : { path: currentPath };
      entries.push(entry);
    }
    currentPath = undefined;
    currentBranch = undefined;
  };
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trimEnd();
    if (line.length === 0) {
      flush();
      continue;
    }
    if (line.startsWith('worktree ')) {
      // New stanza; if a path was already set without an intervening
      // blank line (shouldn't happen in valid porcelain, but defensive),
      // flush it first.
      if (currentPath !== undefined) flush();
      currentPath = line.slice('worktree '.length);
    } else if (line.startsWith('branch ')) {
      currentBranch = line.slice('branch '.length);
    }
    // Ignore HEAD <sha>, bare, detached, locked, prunable — not consumed
    // by the doctor rules.
  }
  // Flush the trailing stanza (porcelain may or may not end with blank).
  flush();
  return entries;
}

function collectRegistryDiagnostics(
  worktreesResult: ReturnType<typeof loadWorktrees>,
  agentsResult: ReturnType<typeof loadAgents>
): readonly Diagnostic[] {
  const out: Diagnostic[] = [];
  if (!isOk(worktreesResult)) out.push(...worktreesResult.errors);
  if (!isOk(agentsResult)) out.push(...agentsResult.errors);
  return out;
}

// ----------------------------------------------------------------------------
// composeDoctorSnapshot — project StoreSnapshot onto DoctorInput.
// ----------------------------------------------------------------------------

export interface ComposeDoctorOptions extends ComposeOptions {
  readonly now: Date;
  readonly templates?: readonly TemplateCheck[];
  readonly staleAgentTtlMs?: number;
  readonly unboundActiveThresholdMs?: number;
  readonly priorOwnersGrowthThreshold?: number;
}

export interface ComposeDoctorResult {
  readonly snapshot: StoreSnapshot;
  readonly doctorInput: DoctorInput;
}

export function composeDoctorSnapshot(options: ComposeDoctorOptions): ComposeDoctorResult {
  const snapshot = composeStoreSnapshot(options);

  const doctorInput: DoctorInput = {
    specs: snapshot.specs,
    ...(snapshot.policy !== undefined ? { policy: snapshot.policy } : {}),
    policyWarnings: snapshot.policyWarnings,
    worktrees: snapshot.worktrees,
    agents: snapshot.agents,
    events: snapshot.events,
    ...(options.templates !== undefined ? { templates: options.templates } : {}),
    waivers: snapshot.waivers,
    waiverDiagnostics: snapshot.waiverDiagnostics,
    initResidue: snapshot.initResidue,
    filesystem: snapshot.filesystem,
    registryDiagnostics: snapshot.registryDiagnostics,
    ...(snapshot.gitWorktrees !== undefined
      ? { gitWorktrees: snapshot.gitWorktrees }
      : {}),
    ...(snapshot.gitObservationFailure !== undefined
      ? { gitObservationFailure: snapshot.gitObservationFailure }
      : {}),
    now: options.now,
    ...(options.staleAgentTtlMs !== undefined
      ? { staleAgentTtlMs: options.staleAgentTtlMs }
      : {}),
    ...(options.unboundActiveThresholdMs !== undefined
      ? { unboundActiveThresholdMs: options.unboundActiveThresholdMs }
      : {}),
    ...(options.priorOwnersGrowthThreshold !== undefined
      ? { priorOwnersGrowthThreshold: options.priorOwnersGrowthThreshold }
      : {}),
  };

  return { snapshot, doctorInput };
}
