import * as fs from 'node:fs';
import * as path from 'node:path';
import { assertMachinePath } from '../init/machine-paths';
import { sha, verifyRuntime, readManifest } from '../init/machine-runtime-state';
import {
  isCawsNativeCommand,
  machineCommand,
  universalEventMatcher,
  unconditionalCommandHook,
  qualifiedHookTimeout,
  MACHINE_EVENTS,
} from '../init/native-hook-identification';
import {
  effectiveRepoSurfacePolicy,
  parseRepoHookPolicy,
  resolveChain,
} from '../init/repo-hook-policy';
import { validateSystemPolicy, type SystemSurfacePolicy } from '../init/system-project-policy';
import { readSystemSurfaceSettings } from '../init/system-surface-settings';
import type { AgentSurface } from '../init/hook-packs/types';
import type { HookEvent } from './types';

export interface SelectionOptions {
  readonly checkout: string;
  readonly canonical: string;
  readonly home: string;
  readonly runtimeDigest: string;
  readonly surface: AgentSurface;
  readonly event: HookEvent;
  readonly system: boolean;
}
type Tier = 'stock' | 'repo-policy' | 'machine-policy';
export interface SelectedSource {
  readonly path: string;
  readonly sha256: string;
}
export interface SelectedHandler extends SelectedSource {
  readonly entry: string;
  readonly name: string;
  readonly args: readonly string[];
  readonly tier: Tier;
  readonly kind: 'stock' | 'project-policy' | 'project-override';
}
export interface SelectedLibrary extends SelectedSource {
  readonly kind: 'project' | 'user' | 'surface' | 'shared';
}
export interface ActiveInvocationSelection {
  readonly status: 'active';
  readonly runtimeDigest: string;
  readonly checkout: string;
  readonly canonical: string;
  readonly surface: AgentSurface;
  readonly event: HookEvent;
  readonly configuration: 'system' | 'project-policy';
  readonly runtimeDirectory: string;
  readonly hooksDirectory: string;
  readonly handlers: readonly SelectedHandler[];
  readonly libraries: Readonly<Record<string, SelectedLibrary>>;
  readonly overrides: Readonly<Record<string, string>>;
  readonly libraryOverrides: Readonly<Record<string, string>>;
  readonly transcriptAdapter: SelectedSource | null;
}
export type InvocationSelection =
  | ActiveInvocationSelection
  | {
      readonly status: 'inactive';
      readonly reason: string;
    };

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function confined(root: string, relative: string): string {
  if (path.isAbsolute(relative) || relative.split('/').includes('..')) {
    throw new Error(`Path escapes root: ${relative}`);
  }
  const target = path.join(root, relative);
  assertMachinePath(root, target);
  return target;
}
function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function source(file: string): SelectedSource {
  return Object.freeze({ path: file, sha256: sha(fs.readFileSync(file)) });
}
function inactive(reason: string): InvocationSelection {
  return Object.freeze({ status: 'inactive', reason });
}
function emptyMachinePolicy(): SystemSurfacePolicy {
  return { disabled: {}, extensions: {}, handlers: {}, libraries: {} };
}

function verifiedProjectMachineEntry(command: string, options: SelectionOptions): void {
  const legacy = path.join(options.home, 'bin/caws-hook');
  const native = path.join(options.home, 'bin/caws-hook-native');
  // Coverage requires the producer's exact command. Decoding shell words loses
  // assignment syntax: a quoted CAWS_HOME word is a command, not an assignment.
  // Missing assignments, wrappers, --system and --describe establish no coverage.
  const interpreter = command === machineCommand(options.home, options.surface, options.event);
  if (
    !interpreter &&
    command !== machineCommand(options.home, options.surface, options.event, 'native')
  )
    throw new Error('Project CAWS invocation requires native-harness reconciliation');
  const entry = interpreter ? legacy : native;
  assertMachinePath(options.home, entry);
  if (!isFile(entry) || (!interpreter && (fs.statSync(entry).mode & 0o111) === 0))
    throw new Error('Project CAWS entry is missing or nonexecutable; requires reconciliation');
  const identity = sha(fs.readFileSync(entry));
  const member = entry === native ? 'native/caws-hook-native' : 'bootstrap.py';
  const runtimes = confined(options.home, 'lib/runtimes');
  const known = fs.readdirSync(runtimes).some((digest) => {
    try {
      const manifest = readManifest(options.home, digest);
      return (
        manifest[member] === identity ||
        (entry === legacy && manifest['launcher.py'] === identity && !manifest['bootstrap.py'])
      );
    } catch {
      return false;
    }
  });
  if (!known)
    throw new Error('Project CAWS entry identity is not retained; requires reconciliation');
}

/** Only one understood universal project registration can suppress the system
 * chain. Restricted matchers and additive local/checkout layers require explicit
 * harness reconciliation; treating their mere presence as coverage skips guards.
 */
function legacyRegistered(options: SelectionOptions): boolean {
  const vendors: Partial<Record<AgentSurface, string>> = {
    codex: '.codex',
    'claude-code': '.claude',
    'qwen-code': '.qwen',
  };
  const vendor = vendors[options.surface];
  if (!vendor)
    throw new Error('Native system registration requires a qualified JSON harness adapter');
  const primary = vendor + (options.surface === 'codex' ? '/hooks.json' : '/settings.json');
  let selected = 0;
  for (const root of new Set([options.canonical, options.checkout])) {
    const toml = confined(root, vendor + '/config.toml');
    if (isFile(toml) && isCawsNativeCommand(fs.readFileSync(toml, 'utf8')))
      throw new Error('Inline project CAWS hooks require native-harness reconciliation');
    for (const relative of [primary, vendor + '/settings.local.json']) {
      const file = confined(root, relative);
      if (!isFile(file)) continue;
      const config = readJson(file);
      if (!object(config) || (config.hooks !== undefined && !object(config.hooks)))
        throw new Error('Malformed legacy native registration');
      if (config.disableAllHooks === true)
        throw new Error('Disabled project hooks require native-harness reconciliation');
      const groups = object(config.hooks)
        ? (config.hooks[MACHINE_EVENTS[options.event]] ?? [])
        : [];
      if (!Array.isArray(groups)) throw new Error('Malformed legacy native registration');
      for (const group of groups) {
        if (!object(group) || !Array.isArray(group.hooks))
          throw new Error('Malformed legacy native hook group');
        if (group.enabled === false) continue;
        for (const hook of group.hooks) {
          if (!object(hook) || hook.enabled === false || !isCawsNativeCommand(hook.command))
            continue;
          if (
            root !== options.canonical ||
            relative !== primary ||
            !universalEventMatcher(options.surface, options.event, group.matcher) ||
            !unconditionalCommandHook(group, hook) ||
            !qualifiedHookTimeout(options.surface, options.event, hook.timeout)
          )
            throw new Error(
              'Restricted or additive project CAWS registration requires native-harness reconciliation'
            );
          // Only the exact producer command establishes understood event coverage.
          verifiedProjectMachineEntry(hook.command, options);
          selected++;
        }
      }
    }
  }
  if (selected > 1)
    throw new Error('Duplicate project CAWS registrations require native-harness reconciliation');
  return selected === 1;
}

function legacyPolicy(
  options: SelectionOptions
): { hooks: string; entries: string[]; libraries: Record<string, string> } | null {
  const file = confined(options.canonical, '.caws/hooks/adapter-policy.json');
  if (!isFile(file))
    throw new Error(
      'Project requires adapter adoption: caws init adapters adopt --agent-surface ' +
        options.surface
    );
  const policy = readJson(file);
  if (
    !object(policy) ||
    policy.version !== 1 ||
    Object.keys(policy).sort().join(',') !== 'surfaces,version' ||
    !object(policy.surfaces)
  ) {
    throw new Error('Malformed project adapter policy');
  }
  const config = policy.surfaces[options.surface];
  if (config === undefined) throw new Error('Project requires adoption for ' + options.surface);
  if (
    !object(config) ||
    Object.keys(config).sort().join(',') !== 'events,libraries' ||
    !object(config.events) ||
    !object(config.libraries)
  ) {
    throw new Error('Unknown adapter policy fields');
  }
  const entry = config.events[options.event];
  if (entry === undefined || entry === null) return null;
  if (
    !object(entry) ||
    Object.keys(entry).sort().join(',') !== 'handlers,hooks_dir' ||
    typeof entry.hooks_dir !== 'string' ||
    !Array.isArray(entry.handlers)
  ) {
    throw new Error('Unknown event policy fields');
  }
  return {
    hooks: confined(options.canonical, entry.hooks_dir),
    entries: entry.handlers,
    libraries: config.libraries as Record<string, string>,
  };
}

/** Per-call policy selection. Explicit roots are resolved by the owning Git context port. */
export function resolveInvocationSelection(options: SelectionOptions): InvocationSelection {
  for (const root of [options.home, options.canonical, options.checkout]) {
    if (!path.isAbsolute(root)) throw new Error('Selection roots must be absolute');
    assertMachinePath(root, root);
  }
  // Preserve the current immutable-snapshot integrity contract, including launcher.py.
  verifyRuntime(options.home, options.runtimeDigest);
  const runtime = confined(options.home, 'lib/runtimes/' + options.runtimeDigest);
  const projectFile = confined(options.home, 'state/projects/' + sha(options.canonical) + '.json');
  const known = fs.existsSync(projectFile);
  if (!fs.existsSync(confined(options.canonical, '.caws'))) {
    if (known) throw new Error('Adopted project governance is missing');
    return inactive('project governance is absent');
  }
  if (options.system && legacyRegistered(options))
    return inactive('legacy native registration remains selected');
  const governanceReady =
    isFile(confined(options.canonical, '.caws/policy.yaml')) &&
    fs.existsSync(confined(options.canonical, '.caws/specs')) &&
    fs.statSync(confined(options.canonical, '.caws/specs')).isDirectory() &&
    !fs.existsSync(confined(options.canonical, '.caws/working-spec.yaml'));
  if (options.system && !known && !governanceReady)
    return inactive('project governance requires migration');
  const settings = readSystemSurfaceSettings(options.home, options.surface);
  let machine: SystemSurfacePolicy | null = null;
  if (settings?.enabled) {
    machine = emptyMachinePolicy();
    if (known) {
      const project = readJson(projectFile);
      if (
        !object(project) ||
        Object.keys(project).sort().join(',') !== 'root,surfaces,version' ||
        project.version !== 1 ||
        project.root !== options.canonical ||
        !object(project.surfaces)
      ) {
        throw new Error('Malformed system project settings');
      }
      if (!(options.surface in project.surfaces))
        throw new Error('System project requires migration for ' + options.surface);
      machine = project.surfaces[options.surface] as SystemSurfacePolicy;
    } else if (fs.existsSync(confined(options.canonical, '.caws/hooks'))) {
      if (isFile(confined(options.canonical, '.caws/hooks/adapter-policy.json'))) machine = null;
      else
        throw new Error(
          'Legacy project hooks require one-time system migration: caws init adapters migrate --agent-surface ' +
            options.surface +
            ' (if that refuses, run its prerequisite first: caws init adapters configure --agent-surface ' +
            options.surface +
            ')'
        );
    }
  }
  if (options.system && machine === null)
    return inactive('system surface is disabled or project policy remains selected');
  let hooks = runtime;
  let entries: string[];
  let libraryPaths: Record<string, string>;
  let overridePaths: Record<string, string> = {};
  const tiers: Record<string, Tier> = {};
  if (machine !== null) {
    if (!governanceReady)
      throw new Error('Project governance requires migration before system hooks can run');
    validateSystemPolicy(options.canonical, machine);
    const defaults = readJson(confined(runtime, 'system-policy.json'));
    if (
      !object(defaults) ||
      defaults.version !== 1 ||
      !object(defaults.events) ||
      !Array.isArray(defaults.events[options.event])
    ) {
      throw new Error('Malformed system default policy');
    }
    const stock = defaults.events[options.event];
    if (!Array.isArray(stock) || stock.some((entry) => typeof entry !== 'string')) {
      throw new Error('Malformed system default policy');
    }
    const repoFile = confined(options.canonical, '.caws/hooks/hook-policy.json');
    const parsed = parseRepoHookPolicy(isFile(repoFile) ? fs.readFileSync(repoFile, 'utf8') : null);
    if (!parsed.ok) throw new Error(parsed.error);
    const repo = effectiveRepoSurfacePolicy(parsed.policy, options.surface);
    const resolved = resolveChain({ stock, event: options.event, repo, machine });
    if (!resolved.ok) throw new Error(resolved.error);
    entries = resolved.handlers;
    libraryPaths = resolved.libraries;
    overridePaths = resolved.handlerOverrides;
    for (const extension of repo.extensions[options.event] ?? [])
      tiers[extension.handler] = 'repo-policy';
    for (const extension of machine.extensions[options.event] ?? [])
      tiers[extension.handler] = 'machine-policy';
    for (const name of Object.keys(repo.handlers)) tiers[name] = 'repo-policy';
    for (const name of Object.keys(machine.handlers)) tiers[name] = 'machine-policy';
  } else {
    const legacy = legacyPolicy(options);
    if (!legacy) return inactive('project policy has no handler chain for this event');
    hooks = legacy.hooks;
    entries = legacy.entries;
    libraryPaths = legacy.libraries;
  }
  const overrides: Record<string, string> = {};
  for (const [name, relative] of Object.entries(overridePaths))
    overrides[name] = confined(options.canonical, relative);
  const handlers = entries.map((entry): SelectedHandler => {
    if (typeof entry !== 'string' || !/^[A-Za-z0-9_.-]+\.sh(?: [A-Za-z0-9_.:/-]+)*$/.test(entry))
      throw new Error(`Invalid handler entry: ${String(entry)}`);
    const [name, ...args] = entry.split(' ') as [string, ...string[]];
    const target = overrides[name] ?? confined(hooks, name);
    if (!isFile(target)) throw new Error('Required handler missing or not executable: ' + target);
    fs.accessSync(target, fs.constants.X_OK);
    return Object.freeze({
      ...source(target),
      entry,
      name,
      args: Object.freeze(args),
      tier: tiers[entry] ?? tiers[name] ?? 'stock',
      kind: overrides[name] ? 'project-override' : hooks === runtime ? 'stock' : 'project-policy',
    });
  });
  const libraryOverrides: Record<string, string> = {};
  for (const [name, relative] of Object.entries(libraryPaths)) {
    if (['agent-surface.sh', 'runtime-paths.sh'].includes(name))
      throw new Error('Bootstrap library cannot be overridden: ' + name);
    if (!/^[A-Za-z0-9_.-]+$/.test(name) || typeof relative !== 'string')
      throw new Error('Invalid project library: ' + name);
    const target = confined(options.canonical, relative);
    if (!isFile(target)) throw new Error('Invalid project library: ' + name);
    libraryOverrides[name] = target;
  }
  const user = confined(options.home, 'surfaces/' + options.surface + '/lib');
  const surface = confined(runtime, 'surfaces/' + options.surface + '/lib');
  const shared = confined(runtime, 'lib');
  const names = new Set(Object.keys(libraryPaths));
  for (const directory of [shared, surface, user]) {
    if (!fs.existsSync(directory)) continue;
    for (const name of fs.readdirSync(directory)) {
      const target = confined(directory, name);
      if (isFile(target)) names.add(name);
      else if (directory === user) throw new Error('Invalid user adapter library: ' + target);
    }
  }
  const libraries: Record<string, SelectedLibrary> = {};
  for (const name of [...names].sort()) {
    const candidates: [string, SelectedLibrary['kind']][] = [];
    if (libraryOverrides[name]) candidates.push([libraryOverrides[name], 'project']);
    candidates.push(
      [confined(user, name), 'user'],
      [confined(surface, name), 'surface'],
      [confined(shared, name), 'shared']
    );
    for (const [target, kind] of candidates) {
      if (isFile(target)) {
        libraries[name] = Object.freeze({ ...source(target), kind });
        break;
      }
    }
  }
  const transcriptName = 'session-transcript.py';
  const transcriptPath = [
    libraryOverrides[transcriptName],
    confined(user, transcriptName),
    confined(surface, transcriptName),
  ].find((target): target is string => typeof target === 'string' && isFile(target));
  return Object.freeze({
    status: 'active',
    runtimeDigest: options.runtimeDigest,
    checkout: options.checkout,
    canonical: options.canonical,
    surface: options.surface,
    event: options.event,
    configuration: machine !== null ? 'system' : 'project-policy',
    runtimeDirectory: runtime,
    hooksDirectory: hooks,
    handlers: Object.freeze(handlers),
    libraries: Object.freeze(libraries),
    overrides: Object.freeze(overrides),
    libraryOverrides: Object.freeze(libraryOverrides),
    transcriptAdapter: transcriptPath ? source(transcriptPath) : null,
  });
}
