// Harness-plugin wiring observation (CAWS-DSH-HARNESS-PLUGIN-PARITY-001).
//
// Some harnesses do not read hooks from a repo-local file or a user-level
// settings key. Their guard chain exists only when a harness-managed plugin
// bundle is composed into the active profile, and the bundle's own patch layer
// carries the plugin rows that invoke `.caws/hooks/dispatch/*.sh`. DSH is the
// first such surface (`hookMechanism: 'harness-plugin'`).
//
// For those surfaces `caws init --agent-surface dsh` installs the shared core
// and the doctrine but cannot install the transport: the bundle lives in the
// harness profile, outside the repo. This module is the observation that tells
// init, status and doctor whether the transport is actually there.
//
// Discipline:
//   - READ ONLY. Parse package.json and the bundle's declared patch YAML; never
//     import or execute profile/plugin code.
//   - "Unobserved" is not "unwired". No DSH profile environment means nothing
//     can be said about this machine's wiring, and guessing would train agents
//     to ignore the finding.
//   - Never throw. A malformed profile must degrade to a classified observation,
//     not take init/doctor down.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

import type { HarnessPluginWiringObservation } from '../../kernel/doctor/types';
import type { AgentSurface } from './types';
import { SURFACE_HARNESS_PLUGINS, type HarnessPluginFacts } from './surfaces.generated';

export interface ObserveHarnessPluginOptions {
  /** Environment to read the profile from; defaults to process.env. */
  readonly env?: NodeJS.ProcessEnv;
  /** DSH home used when only DSH_PROFILE is set; defaults to $DSH_HOME/~/.dsh. */
  readonly dshHome?: string;
}

/** The per-surface plugin-bundle facts, when the surface has any. */
export function harnessPluginFactsFor(surface: AgentSurface): HarnessPluginFacts | undefined {
  return SURFACE_HARNESS_PLUGINS[surface];
}

/** Every surface with a harness-plugin transport (today: just dsh). */
export function harnessPluginSurfaces(): readonly AgentSurface[] {
  return (Object.keys(SURFACE_HARNESS_PLUGINS) as AgentSurface[]).sort();
}

/**
 * Observe whether the active harness profile composes the surface's CAWS
 * plugin bundle. Returns undefined for surfaces without a harness-plugin
 * transport (there is nothing to observe).
 */
export function observeHarnessPluginWiring(
  surface: AgentSurface,
  options: ObserveHarnessPluginOptions = {}
): HarnessPluginWiringObservation | undefined {
  const facts = harnessPluginFactsFor(surface);
  if (facts === undefined) return undefined;
  try {
    return observe(surface, facts, options);
  } catch (error) {
    return {
      surface,
      kind: 'unobserved',
      reason: 'observation-failed',
      profileBundle: facts.profileBundle,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Observe every harness-plugin surface. Used by the doctor snapshot. */
export function observeAllHarnessPluginWiring(
  options: ObserveHarnessPluginOptions = {}
): readonly HarnessPluginWiringObservation[] {
  const observations: HarnessPluginWiringObservation[] = [];
  for (const surface of harnessPluginSurfaces()) {
    const observation = observeHarnessPluginWiring(surface, options);
    if (observation !== undefined) observations.push(observation);
  }
  return observations;
}

/** Render the wiring verdict as display lines (no section header). */
export function renderHarnessPluginWiring(
  observation: HarnessPluginWiringObservation
): readonly string[] {
  const bundle = observation.profileBundle ?? 'the CAWS bundle';
  if (observation.kind === 'wired') {
    const lines = [
      `  Hook plane: WIRED — profile '${observation.profileName ?? '(unnamed)'}' composes ${bundle}`,
    ];
    if (observation.observedPluginIds !== undefined && observation.observedPluginIds.length > 0) {
      lines.push(`    plugin ids: ${observation.observedPluginIds.join(', ')}`);
    }
    if (observation.profileDir !== undefined) lines.push(`    profile: ${observation.profileDir}`);
    lines.push('  Hooks are active only in sessions started after the profile loaded the bundle;');
    lines.push("  the guards themselves run from this repository's .caws/hooks/dispatch/ copy.");
    return lines;
  }
  if (observation.kind === 'unwired') {
    const lines = [
      `  Hook plane: NOT WIRED — profile '${observation.profileName ?? '(unnamed)'}' does not compose ${bundle}.`,
    ];
    lines.push('  CAWS guards will NOT run in sessions using this profile until it is repaired.');
    if (observation.profileDir !== undefined) lines.push(`    profile: ${observation.profileDir}`);
    lines.push(`    reason: ${observation.reason ?? 'unknown'}`);
    if (observation.missingPluginIds !== undefined && observation.missingPluginIds.length > 0) {
      lines.push(`    missing plugin ids: ${observation.missingPluginIds.join(', ')}`);
    }
    if (observation.detail !== undefined) lines.push(`    detail: ${observation.detail}`);
    if (observation.repair !== undefined) {
      lines.push(`  Repair: ${observation.repair}`);
      lines.push('  Then restart the harness profile so it loads the bundle.');
    }
    return lines;
  }
  const lines = [
    '  Hook plane: UNOBSERVED — no DSH profile environment was readable, so profile',
    '  composition cannot be judged. This is not a claim that hooks are missing.',
  ];
  lines.push(`    reason: ${observation.reason ?? 'unknown'}`);
  if (observation.detail !== undefined) lines.push(`    detail: ${observation.detail}`);
  lines.push('  Verify from the harness: read the profile dsh.profile.bundles list and the bundle');
  lines.push('  patch, or run `dsh --profile <name> --dump-config` (the Electron-managed desktop');
  lines.push('  profile refuses that dump and must be checked through its plugin manager).');
  return lines;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function observe(
  surface: AgentSurface,
  facts: HarnessPluginFacts,
  options: ObserveHarnessPluginOptions
): HarnessPluginWiringObservation {
  const env = options.env ?? process.env;
  const profile = resolveProfile(env, options.dshHome, facts.profileEnvVar ?? 'DSH_PROFILE_DIR');
  if (profile.kind === 'unobserved') {
    return {
      surface,
      kind: 'unobserved',
      reason: profile.reason,
      profileBundle: facts.profileBundle,
      ...(profile.detail !== undefined ? { detail: profile.detail } : {}),
    };
  }
  const { profileName, profileDir } = profile;
  const base = { surface, profileName, profileDir, profileBundle: facts.profileBundle };

  const profileJson = readJson(path.join(profileDir, 'package.json'));
  if (profileJson.kind === 'missing') {
    return {
      ...base,
      kind: 'unobserved',
      reason: 'profile-package-missing',
      detail: path.join(profileDir, 'package.json'),
    };
  }
  if (profileJson.kind === 'invalid') {
    return {
      ...base,
      kind: 'unobserved',
      reason: 'profile-package-invalid',
      detail: profileJson.detail,
    };
  }
  const manifest = profileJson.value as Record<string, unknown>;
  const dsh = asRecord(manifest['dsh']);
  const profileSection = asRecord(dsh?.['profile']);
  const bundles = profileSection?.['bundles'];
  if (!Array.isArray(bundles)) {
    return {
      ...base,
      kind: 'unobserved',
      reason: 'profile-manifest-invalid',
      detail: 'package.json has no dsh.profile.bundles array',
    };
  }
  const dependencies = asRecord(manifest['dependencies']);
  const dependencySpec =
    dependencies !== undefined && typeof dependencies[facts.profileBundle] === 'string'
      ? (dependencies[facts.profileBundle] as string)
      : undefined;

  if (!bundles.includes(facts.profileBundle)) {
    const reason = dependencySpec !== undefined ? 'bundle-not-selected' : 'bundle-not-installed';
    return {
      ...base,
      kind: 'unwired',
      reason,
      expectedPluginIds: facts.pluginIds,
      repair: repairCommand(profileName, facts.profileBundle, reason),
      detail:
        dependencySpec !== undefined
          ? `dependency is declared (${dependencySpec}) but the bundle is absent from dsh.profile.bundles`
          : 'the bundle is neither a profile dependency nor a selected bundle',
    };
  }

  const bundleRoot = resolveBundleRoot(profileDir, facts.profileBundle, dependencySpec, options);
  if (bundleRoot.kind === 'unresolved') {
    return {
      ...base,
      kind: 'unwired',
      reason: 'bundle-unresolved',
      expectedPluginIds: facts.pluginIds,
      repair: repairCommand(profileName, facts.profileBundle, 'bundle-unresolved'),
      detail: bundleRoot.detail,
    };
  }
  const bundleJson = readJson(path.join(bundleRoot.dir, 'package.json'));
  if (bundleJson.kind !== 'found') {
    return {
      ...base,
      kind: 'unobserved',
      reason: bundleJson.kind === 'missing' ? 'bundle-package-missing' : 'bundle-package-invalid',
      detail:
        bundleJson.kind === 'missing'
          ? path.join(bundleRoot.dir, 'package.json')
          : path.join(bundleRoot.dir, 'package.json') + ': ' + bundleJson.detail,
    };
  }
  const bundleManifest = bundleJson.value as Record<string, unknown>;
  const bundleSection = asRecord(asRecord(bundleManifest['dsh'])?.['bundle']);
  const patchDecl = bundleSection?.['patch'];
  const patchPaths = normalizePatchPaths(patchDecl);
  if (patchPaths.length === 0) {
    return {
      ...base,
      kind: 'unwired',
      reason: 'patch-missing',
      expectedPluginIds: facts.pluginIds,
      repair: repairCommand(profileName, facts.profileBundle, 'patch-missing'),
      detail: `bundle ${bundleRoot.dir} declares no dsh.bundle.patch`,
    };
  }

  const ids = new Set<string>();
  const names = new Set<string>();
  for (const patchRel of patchPaths) {
    const patchPath = path.resolve(bundleRoot.dir, patchRel);
    let loaded: unknown;
    try {
      loaded = yaml.load(fs.readFileSync(patchPath, 'utf8'));
    } catch (error) {
      return {
        ...base,
        kind: 'unobserved',
        reason: 'patch-invalid',
        detail: `${patchPath}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (!Array.isArray(loaded)) {
      return {
        ...base,
        kind: 'unobserved',
        reason: 'patch-invalid',
        detail: `${patchPath}: expected a YAML list of patch rows`,
      };
    }
    for (const entry of loaded) collectRowIdentifiers(entry, ids, names);
  }

  const expected = [...facts.pluginIds];
  const observed = expected.filter((id) => ids.has(id));
  const missing = expected.filter((id) => !ids.has(id));
  const observedNames = [...names].filter((name) => name.includes(facts.profileBundle));
  if (missing.length === 0) {
    return {
      ...base,
      kind: 'wired',
      expectedPluginIds: expected,
      observedPluginIds: observed,
      detail: observedNames.length > 0 ? `rows: ${observedNames.join(', ')}` : `${bundleRoot.dir}`,
    };
  }
  return {
    ...base,
    kind: 'unwired',
    reason: 'plugin-ids-missing',
    expectedPluginIds: expected,
    observedPluginIds: observed,
    missingPluginIds: missing,
    repair: repairCommand(profileName, facts.profileBundle, 'plugin-ids-missing'),
    detail:
      observedNames.length > 0
        ? `composed rows: ${observedNames.join(', ')}`
        : `bundle patch ${patchPaths.join(', ')} declares no CAWS plugin rows`,
  };
}

type ProfileResolution =
  | { readonly kind: 'resolved'; readonly profileName: string; readonly profileDir: string }
  | { readonly kind: 'unobserved'; readonly reason: string; readonly detail?: string };

function resolveProfile(
  env: NodeJS.ProcessEnv,
  dshHomeOption: string | undefined,
  profileEnvVar: string
): ProfileResolution {
  const dshHome =
    dshHomeOption ??
    (typeof env['DSH_HOME'] === 'string' && env['DSH_HOME'].length > 0
      ? env['DSH_HOME']
      : path.join(os.homedir(), '.dsh'));
  const profileEnvVarCandidates = [profileEnvVar];
  for (const varName of profileEnvVarCandidates) {
    const value = env[varName];
    if (typeof value === 'string' && value.trim().length > 0) {
      const profileDir = path.resolve(value.trim());
      const profileName =
        typeof env['DSH_PROFILE'] === 'string' && env['DSH_PROFILE'].length > 0
          ? env['DSH_PROFILE']
          : path.basename(profileDir);
      if (!isDirectory(profileDir)) {
        return { kind: 'unobserved', reason: 'profile-dir-missing', detail: profileDir };
      }
      return { kind: 'resolved', profileName, profileDir };
    }
  }
  if (typeof env['DSH_PROFILE'] === 'string' && env['DSH_PROFILE'].length > 0) {
    const profileName = env['DSH_PROFILE'];
    const profileDir = path.join(dshHome, 'profiles', profileName);
    if (!isDirectory(profileDir)) {
      return { kind: 'unobserved', reason: 'profile-dir-missing', detail: profileDir };
    }
    return { kind: 'resolved', profileName, profileDir };
  }
  return {
    kind: 'unobserved',
    reason: 'no-profile-environment',
    detail: 'DSH_PROFILE_DIR and DSH_PROFILE are both unset',
  };
}

type BundleResolution =
  | { readonly kind: 'resolved'; readonly dir: string }
  | { readonly kind: 'unresolved'; readonly detail: string };

function resolveBundleRoot(
  profileDir: string,
  bundleName: string,
  dependencySpec: string | undefined,
  options: ObserveHarnessPluginOptions
): BundleResolution {
  const candidates: string[] = [];
  candidates.push(path.join(profileDir, 'node_modules', ...bundleName.split('/')));
  if (dependencySpec !== undefined) {
    const match = /^(?:link|file):(.+)$/.exec(dependencySpec);
    if (match !== null && match[1] !== undefined) {
      const raw = match[1];
      candidates.push(path.isAbsolute(raw) ? raw : path.resolve(profileDir, raw));
    }
  }
  const dshHome =
    options.dshHome ??
    (typeof process.env['DSH_HOME'] === 'string' && process.env['DSH_HOME'].length > 0
      ? process.env['DSH_HOME']
      : path.join(os.homedir(), '.dsh'));
  candidates.push(path.join(dshHome, 'profiles', 'node_modules', ...bundleName.split('/')));

  for (const candidate of candidates) {
    try {
      if (fs.statSync(path.join(candidate, 'package.json')).isFile()) {
        return { kind: 'resolved', dir: fs.realpathSync(candidate) };
      }
    } catch {
      // Next candidate.
    }
  }
  return {
    kind: 'unresolved',
    detail: `no bundle package.json found at ${candidates.join(', ')}`,
  };
}

function repairCommand(profileName: string, bundleName: string, reason: string): string {
  if (reason === 'bundle-not-selected') {
    return `re-enable ${bundleName} in dsh.profile.bundles for profile '${profileName}' (the profile editor or \`dsh plugin --profile ${profileName} add ${bundleName}\` restores it and re-selects it)`;
  }
  if (reason === 'plugin-ids-missing' || reason === 'patch-missing') {
    return `reinstall the CAWS DSH bundle for profile '${profileName}' (\`dsh plugin --profile ${profileName} add ${bundleName}\`); its patch layer must carry the CAWS plugin rows`;
  }
  return `install the CAWS DSH bundle into profile '${profileName}': \`dsh plugin --profile ${profileName} add ${bundleName}\``;
}

function normalizePatchPaths(value: unknown): string[] {
  if (typeof value === 'string' && value.trim().length > 0) return [value.trim()];
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      .map((entry) => entry.trim());
  }
  return [];
}

function collectRowIdentifiers(entry: unknown, ids: Set<string>, names: Set<string>): void {
  const record = asRecord(entry);
  if (record === undefined) return;
  const insert = record['insert'];
  const rows = Array.isArray(insert) ? insert : [record];
  for (const row of rows) {
    const rowRecord = asRecord(row);
    if (rowRecord === undefined) continue;
    if (typeof rowRecord['id'] === 'string') ids.add(rowRecord['id']);
    if (typeof rowRecord['name'] === 'string') names.add(rowRecord['name']);
  }
}

type JsonRead =
  | { readonly kind: 'found'; readonly value: unknown }
  | { readonly kind: 'missing' }
  | { readonly kind: 'invalid'; readonly detail: string };

function readJson(filePath: string): JsonRead {
  let source: string;
  try {
    source = fs.readFileSync(filePath, 'utf8');
  } catch {
    return { kind: 'missing' };
  }
  try {
    return { kind: 'found', value: JSON.parse(source) };
  } catch (error) {
    return { kind: 'invalid', detail: error instanceof Error ? error.message : String(error) };
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}
