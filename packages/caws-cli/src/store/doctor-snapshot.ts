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
import * as os from 'os';
import * as path from 'path';
import { resolveGitBinary } from './git-binary';

import {
  isOk,
  type Diagnostic,
  type DoctorInput,
  type GitWorktreeEntry,
  type RepoHookPolicyObservation,
  type SharedPackDriftRow,
  type TemplateCheck,
} from '../kernel';
import { loadAgents } from './agents-store';
import { loadEvents } from './events-store';
import { loadLeases } from './leases-store';
import { loadPolicy } from './policy-store';
import { loadSpecs } from './specs-store';
import type { StoreSnapshot } from './types';
import { loadWaivers } from './waivers-store';
// CAWS-TELEMETRY-REPAIR-RESILIENCE-001: import the parser from the leaf
// module — snapshot composition must not depend on the install machinery.
// HOOKPACK-COPIED-PACK-LAG-VISIBILITY-001 narrows that to PARSING: the pack
// body-drift observer is imported from the install module on purpose, because
// it is the only caller of the shared evaluateFileState classifier and
// re-deriving the comparison here would create a second source of truth for
// what "drift" means (the exact defect class of
// HOOKPACK-STALENESS-VISIBILITY-001, which reported 51/51 files as drift).
// hook-install.ts imports nothing from store/ (no cycle), and this module
// already spawns processes, so no new failure mode is introduced. The call
// site below is additionally guarded so a throw can never wedge doctor.
import { parseManagedHeader } from '../init/hook-packs/managed-header';
import { SHARED_PACK_VERSION, TELEMETRY_ROW_DEST_PATHS } from '../init/hook-packs/manifest-shared';
import {
  observeLegacyAdapterPolicy,
  observeRepoHookPolicy,
  observeSharedPackBodyDrift,
  observeTelemetryRowClaimants,
} from '../init/hook-install';
import { listStrandedTmpSiblings } from './atomic-write';
import { ADAPTER_COVERED_SURFACES } from '../init/hook-packs/types';
import { observeSystemRuntime } from './system-runtime-observation';
import { observeGlobalHome } from './global-home-observation';
import { observeGatedSurfaceWiring } from '../init/hook-packs/user-scope-wiring';
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
  // AGENT-LIVENESS-DOCTOR-001 (D10): load .caws/leases/ so doctor can
  // cross-reference worktrees.json owners against live leases. Leases are
  // operational cache; on load failure we pass {} (doctor's lease checks
  // simply find nothing). The store is the only layer that reads the dir.
  const leasesResult = loadLeases(cawsDir);
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
  const filesystem = observeFilesystem(repoRoot, cawsDir, worktrees, specsResult.specs);
  // CAWS-DEFECT-DOCTOR-NO-DISCHARGE-WARNINGS-01: created-event path presence
  // is keyed by worktree_created event data (latest event per name wins) —
  // the store reports the filesystem fact; the kernel alone decides that a
  // name is an orphan or a tombstone.
  const createdWorktreePathExistsByName = observeCreatedWorktreePaths(
    isOk(eventsResult) ? eventsResult.value.events : []
  );
  const filesystemWithCreatedPaths = {
    ...filesystem,
    ...(Object.keys(createdWorktreePathExistsByName).length > 0
      ? { createdWorktreePathExistsByName }
      : {}),
  };
  const registryDiagnostics = collectRegistryDiagnostics(worktreesResult, agentsResult);

  // WORKTREE-DOCTOR-HALF-STATE-001 — observe git worktree state.
  // Non-fatal: on failure, gitWorktrees is undefined and
  // gitObservationFailure carries the reason. The kernel emits
  // doctor.worktree.git_observation_unavailable and silently skips
  // H1/H6 rules. The rest of the report still runs.
  const gitObservation = observeGitWorktrees(repoRoot);

  // CAWS-DEFECT-DOCTOR-NO-DISCHARGE-WARNINGS-01 — local branch refs, for the
  // same slice's tombstone proof. Non-fatal and independent of the worktree
  // listing: undefined on failure (unobserved, never absent).
  const localBranchRefs = observeLocalBranchRefs(repoRoot);

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
    leases: isOk(leasesResult) ? leasesResult.value.leases : {},
    events: isOk(eventsResult) ? eventsResult.value.events : [],
    eventWarnings: isOk(eventsResult) ? eventsResult.value.warnings : eventsResult.errors,
    waivers: waiversResult.waivers,
    waiverDiagnostics: waiversResult.diagnostics,
    initResidue,
    filesystem: filesystemWithCreatedPaths,
    registryDiagnostics,
    ...(gitObservation.kind === 'ok'
      ? { gitWorktrees: gitObservation.entries }
      : { gitObservationFailure: gitObservation.reason }),
    ...(localBranchRefs !== undefined ? { localBranchRefs } : {}),
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
    workingSpecSchemaJson: isFile(path.join(cawsDir, 'working-spec.schema.json')),
    // CAWS-SPEC-SCHEMA-AUTHORITY-UNSTATED-001: the legacy project-local spec
    // schema is dead wherever it sits, so observe every location it is
    // plausibly placed, not just the canonical one. Tidying the root copy
    // into a schemas/ subdirectory is the most likely way an operator
    // produces the variant, and detecting only the root path silently
    // blesses it. Reported as repo-relative posix paths so the finding can
    // name the file that actually exists.
    legacySpecSchemaPaths: LEGACY_SPEC_SCHEMA_RELPATHS.filter((rel) =>
      isFile(path.join(cawsDir, ...rel))
    ).map((rel) => ['.caws', ...rel].join('/')),
  };
}

/**
 * CAWS-DOCTOR-HOOKS-NO-CAWS-DRIFT-001: marker hooks that, when present
 * under `<repoRoot>/.claude/hooks/`, identify the installed pack as the
 * CAWS hook pack (as opposed to an unrelated project's `.claude/hooks/`).
 * These two are load-bearing CAWS governance guards that no non-CAWS
 * project ships; presence of EITHER is sufficient evidence the pack is
 * installed. Kept narrow on purpose — a bare `.claude/hooks/` directory
 * is NOT evidence of CAWS.
 */
const CAWS_HOOK_PACK_MARKERS = ['scope-guard.sh', 'worktree-write-guard.sh'] as const;

function observeHookPackInstalled(repoRoot: string): boolean {
  const hooksDir = path.join(repoRoot, '.claude', 'hooks');
  for (const marker of CAWS_HOOK_PACK_MARKERS) {
    if (isFile(path.join(hooksDir, marker))) return true;
  }
  return false;
}

/**
 * CAWS-HARNESS-TELEMETRY-ADAPTER-001: the vendored telemetry rows this CLI
 * installs for NON-covered surfaces. Imported from the manifest so the
 * doctor observation and the init install set can never drift apart.
 */
const OBSERVED_TELEMETRY_ROWS = TELEMETRY_ROW_DEST_PATHS;

/** Marker file name per adapter-covered surface that identifies that
 *  surface's harness pack as installed (`.dsh/AGENTS.md` for dsh — the
 *  marker contract the bundle-side adapter spec pins). */
/**
 * CAWS-SPEC-SCHEMA-AUTHORITY-UNSTATED-001: every location a legacy
 * project-local spec schema is found, relative to `.caws/`. vNext validates
 * specs through the kernel, so a file at ANY of these paths is dead
 * authority that can still mislead a reader into reconciling spec shapes
 * against it. Path segments, joined per-platform for the stat and with `/`
 * for reporting.
 */
const LEGACY_SPEC_SCHEMA_RELPATHS: readonly (readonly string[])[] = [
  ['working-spec.schema.json'],
  ['schemas', 'working-spec.schema.json'],
];

const ADAPTER_SURFACE_MARKER_FILE: Record<string, string> = {
  dsh: 'AGENTS.md',
};

/**
 * CAWS-HARNESS-TELEMETRY-ADAPTER-001: which of the vendored telemetry rows
 * are present on disk as SHARED-PACK-MANAGED files (parsed with the same
 * parseManagedHeader the installer writes). Absent files and unmanaged
 * files are both omitted — doctor treats "no rows reported" as either
 * absent or not-ours, and neither is staleness.
 */
/** CAWS-DEFECT-STALE-INSTALLED-GUARD-PLANE-01: the INSTALLED shared pack
 *  version, read from a load-bearing installed row's managed header.
 *  Absent/unparseable = unobserved (undefined), never an error. */
function observeInstalledSharedPackVersion(repoRoot: string): number | undefined {
  for (const marker of ['scope-guard.sh', 'worktree-write-guard.sh', 'audit.sh']) {
    let content: string;
    try {
      content = fs.readFileSync(path.join(repoRoot, '.caws', 'hooks', marker), 'utf8');
    } catch {
      continue;
    }
    const header = parseManagedHeader(content);
    if (header && header.hookPack === 'shared' && header.hookPackVersion > 0) {
      return header.hookPackVersion;
    }
  }
  return undefined;
}

function observeManagedTelemetryRows(repoRoot: string): string[] {
  const observed: string[] = [];
  for (const relPath of OBSERVED_TELEMETRY_ROWS) {
    let content: string;
    try {
      content = fs.readFileSync(path.join(repoRoot, relPath), 'utf8');
    } catch {
      continue; // absent — never staleness
    }
    const header = parseManagedHeader(content);
    if (header && header.hookPack === 'shared') observed.push(relPath);
  }
  return observed;
}

/**
 * CAWS-HARNESS-TELEMETRY-ADAPTER-001: which adapter-covered surfaces have
 * their harness pack installed in this project. There is no persisted
 * surface receipt, so doctor infers adapter coverage from the surface's
 * marker file carrying that surface's managed header (e.g. `.dsh/AGENTS.md`
 * with `hook_pack: dsh`).
 */
function observeAdapterPackSurfaceMarkers(repoRoot: string): string[] {
  const observed: string[] = [];
  for (const surface of ADAPTER_COVERED_SURFACES) {
    const markerFile = ADAPTER_SURFACE_MARKER_FILE[surface];
    if (markerFile === undefined) continue;
    let content: string;
    try {
      content = fs.readFileSync(path.join(repoRoot, `.${surface}`, markerFile), 'utf8');
    } catch {
      continue; // marker absent — surface pack not installed here
    }
    const header = parseManagedHeader(content);
    if (header && header.hookPack === surface) observed.push(surface);
  }
  return observed;
}

function observeFilesystem(
  repoRoot: string,
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
    specClaimedWorktreeDirByName[name] = isDir(path.join(cawsDir, 'worktrees', name));
  }
  return {
    cawsDirExists: isDir(cawsDir),
    specsDirExists: isDir(path.join(cawsDir, 'specs')),
    waiversDirExists: isDir(path.join(cawsDir, 'waivers')),
    policyYamlExists: isFile(path.join(cawsDir, 'policy.yaml')),
    worktreesJsonExists: isFile(path.join(cawsDir, 'worktrees.json')),
    agentsJsonExists: isFile(path.join(cawsDir, 'agents.json')),
    eventsJsonlExists: isFile(path.join(cawsDir, 'events.jsonl')),
    // CAWS-DOCTOR-HOOKS-NO-CAWS-DRIFT-001: observe the hook pack so doctor
    // can flag the hooks-present/substrate-absent split-brain.
    hookPackInstalled: observeHookPackInstalled(repoRoot),
    ...(() => {
      const systemRuntime = observeSystemRuntime(repoRoot);
      return systemRuntime ? { systemRuntime } : {};
    })(),
    // CAWS-HARNESS-TELEMETRY-ADAPTER-001: observe managed telemetry rows and
    // installed adapter-pack surfaces so doctor can flag stale dual-writers.
    managedTelemetryRowPaths: observeManagedTelemetryRows(repoRoot),
    globalHomeObservation: observeGlobalHome(
      process.env.CAWS_HOME || path.join(os.homedir(), '.caws')
    ),
    adapterPackSurfaceMarkers: observeAdapterPackSurfaceMarkers(repoRoot),
    // CAWS-INIT-TELEMETRY-RETIRE-SURFACE-BLIND-001: which installed surfaces
    // still CLAIM those rows. Delegated to the install module for the same
    // reason as observeSharedPackBodyDrift above: the installer's own notion
    // of "whose install set contains this row" is the only correct answer,
    // and re-deriving it here would let doctor prescribe a repair init
    // would not perform.
    telemetryRowClaimantSurfaces: observeTelemetryRowClaimants(repoRoot),
    // CAWS-DEFECT-LEASE-TMP-STRANDING-01: stranded atomic-write tmps in the
    // leases dir, observed through the atomic-write lister itself (the same
    // pattern the sweep uses — one source of truth for what counts as ours).
    ...((): { strandedLeaseTmpFiles?: readonly { name: string; ageMs: number }[] } => {
      const stranded = listStrandedTmpSiblings(path.join(cawsDir, 'leases', 'lease.json'));
      if (stranded.length === 0) return {};
      return {
        strandedLeaseTmpFiles: stranded.map((f) => ({
          name: path.basename(f.path),
          ageMs: Math.round(f.ageMs),
        })),
      };
    })(),
    // CAWS-DEFECT-STALE-INSTALLED-GUARD-PLANE-01: installed vs shipping pack
    // versions, observed from the installed rows' managed headers.
    // HOOKPACK-COPIED-PACK-LAG-VISIBILITY-001: also observe per-file BODY
    // drift, because the version stamp does not track content.
    // CAWS-DEFECT-HOOK-DRIFT-NO-NONDESTRUCTIVE-DISCHARGE-01: drift rows are
    // baseline-classified (growth / upstream / unobserved) by the observer.
    ...((): {
      installedSharedPackVersion?: number;
      shippingSharedPackVersion: number;
      installedSharedPackBodyDrift?: readonly SharedPackDriftRow[];
    } => {
      const installed = observeInstalledSharedPackVersion(repoRoot);
      let bodyDrift: readonly SharedPackDriftRow[] = [];
      try {
        bodyDrift = observeSharedPackBodyDrift(repoRoot);
      } catch {
        // Fail-open: an unreadable copied pack is never a doctor failure.
        bodyDrift = [];
      }
      return {
        ...(installed !== undefined ? { installedSharedPackVersion: installed } : {}),
        shippingSharedPackVersion: SHARED_PACK_VERSION,
        ...(bodyDrift.length > 0 ? { installedSharedPackBodyDrift: bodyDrift } : {}),
      };
    })(),
    // CAWS-HOOKS-POLICY-DOCTOR-RULES-01: the repo-local hook policy. Every
    // comparison that needs the filesystem or a shipped template — the fork's
    // upstream sha256, the compiled chain bytes — is resolved HERE, and the
    // kernel receives plain rows. Absent policy yields undefined, which is
    // silent; only an unreadable or invalid one becomes an observation.
    ...((): {
      repoHookPolicy?: RepoHookPolicyObservation;
      legacyAdapterPolicyPresent?: boolean;
    } => {
      let observed: RepoHookPolicyObservation | undefined;
      try {
        observed = observeRepoHookPolicy(repoRoot);
      } catch {
        // Fail-open: a collection failure degrades THIS observation only and
        // must never take the rest of doctor down with it.
        observed = undefined;
      }
      let legacy = false;
      try {
        legacy = observeLegacyAdapterPolicy(repoRoot);
      } catch {
        legacy = false;
      }
      return {
        ...(observed !== undefined ? { repoHookPolicy: observed } : {}),
        ...(legacy ? { legacyAdapterPolicyPresent: true } : {}),
      };
    })(),
    // CAWS-GATED-SURFACE-SCOPE-GUARD-001: both sides of the dual-wiring
    // hazard, observed read-only (user home + project configs).
    ...((): {
      userScopeCawsWiringBySurface: readonly string[];
      gatedProjectHookEntriesBySurface: readonly string[];
    } => {
      const observed = observeGatedSurfaceWiring(repoRoot);
      return {
        userScopeCawsWiringBySurface: observed.userScope,
        gatedProjectHookEntriesBySurface: observed.projectScope,
      };
    })(),
    worktreeDirByName,
    specClaimedWorktreeDirByName,
    legacyArchiveBodyCount: countArchiveBodies(cawsDir),
  };
}

/**
 * Count .yaml files at the TOP of .caws/specs/.archive/. Excludes
 * the .unrecoverable/ subdirectory. This remains in the snapshot for
 * compatibility with older kernel callers; current doctor rules do
 * not warn merely because archive bodies exist.
 */
function countArchiveBodies(cawsDir: string): number {
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
    result = spawnSync(resolveGitBinary(), ['-C', repoRoot, 'worktree', 'list', '--porcelain'], {
      encoding: 'utf8',
    });
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

// ----------------------------------------------------------------------------
// CAWS-DEFECT-DOCTOR-NO-DISCHARGE-WARNINGS-01 — tombstone observations.
//
// Two read-only facts the kernel needs to prove a worktree event-orphan is
// verifiably dead: which local branch refs exist, and whether the path each
// worktree_created event recorded still exists. Both follow the established
// keying discipline (registry-keyed / spec-claim-keyed / event-data-keyed
// maps over pure data): the store reports facts, the kernel decides policy.
// Both are non-fatal — undefined/absent observations never crash doctor and
// never authorize a downgrade.
// ----------------------------------------------------------------------------

/**
 * Local branch refs as full ref names (`refs/heads/<branch>`), observed via
 * one `git for-each-ref` call. Undefined on any failure (unobserved).
 */
function observeLocalBranchRefs(repoRoot: string): readonly string[] | undefined {
  let result;
  try {
    result = spawnSync(
      resolveGitBinary(),
      ['-C', repoRoot, 'for-each-ref', '--format=%(refname)', 'refs/heads'],
      { encoding: 'utf8' }
    );
  } catch {
    return undefined;
  }
  if (result.error || typeof result.status !== 'number' || result.status !== 0) {
    return undefined;
  }
  const stdout = (result.stdout ?? '').toString();
  const refs = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('refs/heads/'));
  return refs;
}

/**
 * For each name carried by a `worktree_created` event (latest event per name
 * wins — the most recent lifecycle is what "remains now" means), whether the
 * path the event recorded exists on disk (any entry type). Events without a
 * usable name+path are skipped; a skipped name is simply absent from the map
 * (unobserved). Empty when the log carries no usable created events.
 */
function observeCreatedWorktreePaths(
  events: readonly {
    readonly event: string;
    readonly data?: unknown;
  }[]
): Record<string, boolean> {
  const pathsByName: Record<string, string> = {};
  for (const ev of events) {
    if (ev.event !== 'worktree_created') continue;
    const d = ev.data as Record<string, unknown> | undefined;
    const name = typeof d?.name === 'string' ? d.name : undefined;
    const p = typeof d?.path === 'string' ? d.path : undefined;
    if (name === undefined || name.length === 0 || p === undefined || p.length === 0) {
      continue;
    }
    pathsByName[name] = p;
  }
  const existsByName: Record<string, boolean> = {};
  for (const [name, p] of Object.entries(pathsByName)) {
    existsByName[name] = fs.existsSync(p);
  }
  return existsByName;
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

  // CANONICAL-DRIFT-GUARDS-001: canonical branch observation. The porcelain
  // listing the snapshot collects deliberately EXCLUDES the canonical entry
  // (the H6 foreign-physical filter), so the current branch comes from one
  // direct rev-parse here (store layer — the kernel stays pure). The base
  // branch comes from the registry (a unique baseBranch). Absent on git
  // failure or base ambiguity — the kernel finding silently skips
  // (missing != malformed).
  let canonicalBranchObservation: { currentBranch: string; baseBranch: string } | undefined;
  {
    const baseBranches = new Set<string>();
    for (const record of Object.values(snapshot.worktrees ?? {})) {
      if (record && typeof record.baseBranch === 'string') {
        baseBranches.add(record.baseBranch);
      }
    }
    if (baseBranches.size === 1) {
      try {
        const head = spawnSync(
          resolveGitBinary(),
          ['-C', options.repoRoot, 'rev-parse', '--abbrev-ref', 'HEAD'],
          { encoding: 'utf8' }
        );
        if (!head.error && head.status === 0) {
          const currentBranch = String(head.stdout).trim();
          if (currentBranch.length > 0 && currentBranch !== 'HEAD') {
            canonicalBranchObservation = {
              currentBranch,
              baseBranch: Array.from(baseBranches)[0]!,
            };
          }
        }
      } catch {
        // observation failure -> undefined -> kernel skips
      }
    }
  }

  const doctorInput: DoctorInput = {
    specs: snapshot.specs,
    ...(snapshot.policy !== undefined ? { policy: snapshot.policy } : {}),
    policyWarnings: snapshot.policyWarnings,
    worktrees: snapshot.worktrees,
    agents: snapshot.agents,
    leases: snapshot.leases,
    events: snapshot.events,
    ...(options.templates !== undefined ? { templates: options.templates } : {}),
    waivers: snapshot.waivers,
    waiverDiagnostics: snapshot.waiverDiagnostics,
    initResidue: snapshot.initResidue,
    filesystem: snapshot.filesystem,
    registryDiagnostics: snapshot.registryDiagnostics,
    ...(snapshot.gitWorktrees !== undefined ? { gitWorktrees: snapshot.gitWorktrees } : {}),
    ...(canonicalBranchObservation !== undefined ? { canonicalBranchObservation } : {}),
    // CAWS-DEFECT-DOCTOR-NO-DISCHARGE-WARNINGS-01: tombstone observation for
    // §2e — undefined stays undefined (unobserved, no downgrade).
    ...(snapshot.localBranchRefs !== undefined
      ? { localBranchRefs: snapshot.localBranchRefs }
      : {}),
    ...(snapshot.gitObservationFailure !== undefined
      ? { gitObservationFailure: snapshot.gitObservationFailure }
      : {}),
    now: options.now,
    ...(options.staleAgentTtlMs !== undefined ? { staleAgentTtlMs: options.staleAgentTtlMs } : {}),
    ...(options.unboundActiveThresholdMs !== undefined
      ? { unboundActiveThresholdMs: options.unboundActiveThresholdMs }
      : {}),
    ...(options.priorOwnersGrowthThreshold !== undefined
      ? { priorOwnersGrowthThreshold: options.priorOwnersGrowthThreshold }
      : {}),
  };

  return { snapshot, doctorInput };
}
