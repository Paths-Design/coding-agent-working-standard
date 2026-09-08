import { validateSystemPolicy, type SystemSurfacePolicy } from './system-project-policy';
import { systemCommand } from './native-hook-identification';
import { readSystemSurfaceSettings, nativeConfigPath } from './system-surface-settings';
export type { SystemSurfacePolicy } from './system-project-policy';
import type {
  NativeConfiguration,
  NativeHook,
  NativeHookGroup,
} from './native-hook-identification';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  assertMachinePath,
  atomicMachineWrite,
  machineHome,
  verifyRuntime,
} from './machine-adapters';
import {
  MACHINE_EVENTS,
  configHasCawsHooks,
  isCawsNativeCommand,
  migrateNativeCommand,
} from './machine-adapter-policy';
import { extractMachineHandlers } from './machine-handler-policy';
import { SHARED_PACK } from './hook-packs/manifest-shared';
import {
  CANONICAL_HOOK_ENTRIES,
  CANONICAL_QWEN_HOOK_ENTRIES,
  readPristineBaseline,
} from './hook-install';
import { isKnownSurface, resolveHookPack } from './hook-packs/register';

type Event = keyof typeof MACHINE_EVENTS;
interface Change {
  root: string;
  path: string;
  before: string | null;
  after: string;
}
export interface SystemProjectSettings {
  version: 1;
  root: string;
  surfaces: Record<string, SystemSurfacePolicy>;
}
export interface SystemOptions {
  surface: string;
  home?: string;
  userHome?: string;
  plan?: boolean;
  templatesRoot?: string;
  repo?: string;
  fromFile?: string;
  nativeConfigTarget?: string;
}
const encode = (value: unknown): string => JSON.stringify(value, null, 2) + '\n';
const empty = (): SystemSurfacePolicy => ({
  disabled: {},
  extensions: {},
  handlers: {},
  libraries: {},
});
const vendorFor = (surface: string): string => {
  if (!['codex', 'claude-code', 'qwen-code'].includes(surface))
    throw new Error(
      `System registration for ${surface} requires an adapter authored and verified in that harness; supported JSON registrations: codex, claude-code, qwen-code`
    );
  return surface === 'claude-code' ? '.claude' : surface === 'codex' ? '.codex' : '.qwen';
};
export const systemProjectPath = (home: string, repo: string): string =>
  path.join(
    home,
    'state/projects',
    createHash('sha256').update(fs.realpathSync(repo)).digest('hex') + '.json'
  );
function before(root: string, file: string): string | null {
  assertMachinePath(root, file);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}
function config(root: string, file: string): { bytes: string | null; value: NativeConfiguration } {
  const bytes = before(root, file);
  const value = bytes === null ? {} : JSON.parse(bytes);
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (value.hooks !== undefined &&
      (!value.hooks || typeof value.hooks !== 'object' || Array.isArray(value.hooks)))
  )
    throw new Error(`Malformed native configuration: ${file}`);
  return { bytes, value };
}
function applyChanges(home: string, changes: Change[], plan: boolean): void {
  if (plan || changes.length === 0) return;
  const lock = path.join(home, 'state/system-configuration.lock');
  assertMachinePath(home, lock);
  fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
  try {
    fs.mkdirSync(lock, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new Error(
        `System configuration is locked: ${lock}; inspect interrupted changes and adoption backups before retrying`
      );
    throw error;
  }
  try {
    applyLockedChanges(home, changes);
  } finally {
    fs.rmdirSync(lock);
  }
}

function applyLockedChanges(home: string, changes: Change[]): void {
  // A manifest is durable before the first mutation. Byte checks preserve a
  // concurrent edit; rollback never overwrites bytes another writer installed.
  const id = createHash('sha256').update(encode(changes)).digest('hex');
  atomicMachineWrite(
    home,
    path.join(home, 'state/adoption-backups', `${id}.json`),
    encode({ changes })
  );
  const applied: Change[] = [];
  try {
    for (const change of changes) {
      if (before(change.root, change.path) !== change.before)
        throw new Error(`Configuration changed after planning: ${change.path}`);
      atomicMachineWrite(change.root, change.path, change.after);
      applied.push(change);
    }
  } catch (error) {
    for (const change of applied.reverse()) {
      if (before(change.root, change.path) !== change.after)
        throw new Error(
          `Rollback refused concurrent edit at ${change.path}; recover using backup ${id}`,
          { cause: error }
        );
      if (change.before === null) fs.unlinkSync(change.path);
      else atomicMachineWrite(change.root, change.path, change.before);
    }
    throw error;
  }
}
function requireRuntime(home: string): { files: string[]; defaults: Record<Event, string[]> } {
  const pointer = JSON.parse(before(home, path.join(home, 'state/adapter-runtime.json')) ?? 'null');
  if (pointer?.version !== 1)
    throw new Error('Install the system runtime first: caws init adapters install');
  const files = verifyRuntime(home, pointer.digest);
  if (!files['system-policy.json'] || !files['session_log_renderer.py'])
    throw new Error('Installed runtime predates system hooks; run caws init adapters install');
  const policy = JSON.parse(
    fs.readFileSync(path.join(home, 'lib/runtimes', pointer.digest, 'system-policy.json'), 'utf8')
  );
  return { files: Object.keys(files), defaults: policy.events };
}

/** Register one stable transport at the harness user layer. No project writes. */
export function configureSystemRuntime(options: SystemOptions): {
  changed: boolean;
  changes: Change[];
  restartRequired: boolean;
} {
  const home = options.home ?? machineHome();
  requireRuntime(home);
  const user = options.userHome ?? os.homedir();
  const vendor = vendorFor(options.surface);
  const priorSettings = readSystemSurfaceSettings(home, options.surface);
  const target = options.nativeConfigTarget ?? priorSettings?.native_config_target;
  const file = nativeConfigPath(
    user,
    vendor,
    options.surface === 'codex' ? 'hooks.json' : 'settings.json',
    target
  );
  const native = config(user, file);
  const toml = before(user, path.join(user, vendor, 'config.toml'));
  if (toml && /\[hooks[.\[\]]/.test(toml) && isCawsNativeCommand(toml))
    throw new Error(
      'Inline CAWS hooks require native-harness reconciliation before system registration'
    );
  native.value.hooks ??= {};
  for (const [name, groups] of Object.entries(native.value.hooks)) {
    if (
      !Object.values(MACHINE_EVENTS).includes(name as (typeof MACHINE_EVENTS)[Event]) &&
      configHasCawsHooks({ hooks: { [name]: groups } })
    )
      throw new Error(`Unrecognized CAWS lifecycle registration: ${name}`);
  }
  for (const [event, name] of Object.entries(MACHINE_EVENTS)) {
    const groups = native.value.hooks[name] ?? [];
    if (!Array.isArray(groups)) throw new Error(`Malformed native hook groups: ${name}`);
    let replacements = 0;
    const retained = groups.map((group: NativeHookGroup) => {
      if (!group || !Array.isArray(group.hooks))
        throw new Error(`Malformed native hook group: ${name}`);
      return {
        ...group,
        hooks: group.hooks.map((hook: NativeHook) => {
          if (!isCawsNativeCommand(hook?.command)) return hook;
          if (group.enabled === false || hook.enabled === false)
            throw new Error(`Disabled CAWS registration requires native-harness review: ${name}`);
          if (
            options.surface === 'codex' &&
            ['pre_tool_use', 'post_tool_use'].includes(event) &&
            group.matcher !== '.*'
          )
            throw new Error(
              `Restricted CAWS matcher requires native-harness review: ${name}; system hooks must cover all tools`
            );
          replacements++;
          return {
            ...hook,
            command:
              hook.command === systemCommand(home, options.surface, event)
                ? hook.command
                : migrateNativeCommand(hook.command, user, home, options.surface, event as Event) +
                  ' --system',
          };
        }),
      };
    });
    if (replacements > 1)
      throw new Error(
        `Duplicate native CAWS registrations for ${name}; reconcile before configuring`
      );
    if (replacements === 0) {
      const defaults =
        options.surface === 'qwen-code'
          ? CANONICAL_QWEN_HOOK_ENTRIES[name]
          : CANONICAL_HOOK_ENTRIES[name];
      const group = {
        ...defaults,
        hooks: [
          {
            type: 'command',
            command: systemCommand(home, options.surface, event),
            timeout: event === 'post_tool_use' ? 60 : 45,
          },
        ],
      };
      // Native Codex tools include apply_patch and exec_command. The parser and
      // individual guards decide which inputs they govern.
      if (options.surface === 'codex' && ['pre_tool_use', 'post_tool_use'].includes(event))
        (group as NativeHookGroup).matcher = '.*';
      retained.push(group);
    }
    native.value.hooks[name] = retained;
  }
  const settings = path.join(home, 'surfaces', options.surface, 'settings.json');
  const changes: Change[] = [
    {
      root: home,
      path: settings,
      before: before(home, settings),
      after: encode({
        version: 1,
        enabled: true,
        ...(target ? { native_config_target: target } : {}),
      }),
    },
    { root: user, path: file, before: native.bytes, after: encode(native.value) },
  ].filter((c) => c.before !== c.after);
  applyChanges(home, changes, options.plan === true);
  return { changed: changes.length > 0, changes, restartRequired: changes.length > 0 };
}

const comparable = (text: string): string =>
  text.replace(/hook_pack_version:\s*\d+/g, 'hook_pack_version: N');
function inferPolicy(
  repo: string,
  surface: string,
  native: NativeConfiguration,
  templates: string
): SystemSurfacePolicy {
  const result = empty();
  const vendor = vendorFor(surface);
  const stock = new Map(SHARED_PACK.installedFiles.map((f) => [path.basename(f.sourcePath), f]));
  const oldPolicyPath = path.join(repo, '.caws/hooks/adapter-policy.json');
  const oldPolicy = fs.existsSync(oldPolicyPath)
    ? JSON.parse(fs.readFileSync(oldPolicyPath, 'utf8')).surfaces?.[surface]
    : undefined;
  if (oldPolicy?.libraries) result.libraries = { ...oldPolicy.libraries };
  let hadTransport = false;
  for (const [event, nativeName] of Object.entries(MACHINE_EVENTS) as [Event, string][]) {
    const template = fs.readFileSync(
      path.join(templates, 'shared/dispatch', `${event}.sh`),
      'utf8'
    );
    let hooksDir = oldPolicy?.events?.[event]?.hooks_dir;
    let handlers: string[] | undefined = oldPolicy?.events?.[event]?.handlers;
    let dispatchPath: string | undefined;
    const commands = (native.hooks?.[nativeName] ?? [])
      .flatMap((g: NativeHookGroup) => g.hooks ?? [])
      .map((h: NativeHook) => h.command)
      .filter(isCawsNativeCommand);
    if (!handlers && commands.length === 0) continue;
    hadTransport = true;
    if (!handlers) {
      const candidates = ['.caws/hooks', `${vendor}/hooks`]
        .flatMap((dir) => ['dispatch', 'caws_dispatch'].map((sub) => `${dir}/${sub}/${event}.sh`))
        .filter((rel) => fs.existsSync(path.join(repo, rel)));
      const wired = candidates.filter((rel) => commands.some((cmd: string) => cmd.includes(rel)));
      dispatchPath =
        wired.length === 1 ? wired[0] : candidates.length === 1 ? candidates[0] : undefined;
      if (!dispatchPath && candidates.length > 0)
        throw new Error(`Ambiguous ${event} dispatcher; provide reviewed --from system policy`);
      if (!dispatchPath) continue;
      hooksDir = path.dirname(path.dirname(dispatchPath));
      handlers = extractMachineHandlers(
        fs.readFileSync(path.join(repo, dispatchPath), 'utf8'),
        template
      );
    }
    const current = extractMachineHandlers(template, template).map(
      (h) => h.split(' ')[0] as string
    );
    const baseline = dispatchPath ? readPristineBaseline(repo, 'shared', dispatchPath) : null;
    const declared = handlers.map((h) => h.split(' ')[0] as string);
    if (new Set(declared).size !== declared.length)
      throw new Error(`Repeated ${event} handler requires explicit reconciliation`);
    const comparableStock = (entries: string[]): string[] =>
      entries.filter((h) => current.includes(h.split(' ')[0] as string));
    if (baseline) {
      const installedStock = comparableStock(handlers);
      const priorStock = comparableStock(extractMachineHandlers(baseline, baseline)).filter((h) =>
        declared.includes(h.split(' ')[0] as string)
      );
      if (JSON.stringify(installedStock) !== JSON.stringify(priorStock))
        throw new Error(
          `Custom stock order or arguments in ${event}; provide reviewed --from system policy`
        );
    } else if (
      !oldPolicy &&
      JSON.stringify(comparableStock(handlers)) !==
        JSON.stringify(extractMachineHandlers(template, template))
    ) {
      throw new Error(
        `Dispatcher without a pristine baseline differs in ${event}; provide reviewed --from system policy`
      );
    }
    if (baseline) {
      const old = extractMachineHandlers(baseline, baseline).map((h) => h.split(' ')[0] as string);
      const disabled = old.filter(
        (h) => current.includes(h) && !handlers!.some((v) => v.split(' ')[0] === h)
      );
      if (disabled.length) result.disabled[event] = disabled;
    }
    handlers.forEach((handler, index) => {
      const name = handler.split(' ')[0] as string;
      const rel = `${hooksDir}/${name}`;
      assertMachinePath(repo, path.join(repo, rel));
      const file = stock.get(name);
      if (!file) {
        if (result.handlers[name] && result.handlers[name] !== rel)
          throw new Error(`Conflicting extension paths for ${name}`);
        result.handlers[name] = rel;
      }
      if (!current.includes(name)) {
        const anchor =
          handlers!
            .slice(index + 1)
            .map((h) => h.split(' ')[0] as string)
            .find((h) => current.includes(h)) ?? null;
        (result.extensions[event] ??= []).push({ handler, before: anchor });
      }
      if (file) {
        const bytes = fs.readFileSync(path.join(repo, rel), 'utf8');
        const pristine = readPristineBaseline(repo, 'shared', rel);
        const upstream = fs.readFileSync(path.join(templates, 'shared', file.sourcePath), 'utf8');
        if (bytes !== pristine && comparable(bytes) !== comparable(upstream)) {
          if (!pristine)
            throw new Error(
              `Unclassified legacy handler ${rel}; review it and provide --from system policy`
            );
          result.handlers[name] = rel;
        }
      }
    });
  }
  // Adapter and helper growth can change every guard. Never silently replace a
  // custom renderer, parser, oracle or bootstrap merely because it is old.
  if (!hadTransport) return result;
  if (!isKnownSurface(surface)) throw new Error(`Unknown surface: ${surface}`);
  const pack = resolveHookPack(surface);
  const candidates = [
    ...SHARED_PACK.installedFiles.map((f) => ({ ...f, pack: 'shared' })),
    ...(pack.kind === 'pack'
      ? pack.pack.installedFiles
          .filter((f) => f.sourcePath.startsWith('hooks/lib/'))
          .map((f) => ({ ...f, pack: surface }))
      : []),
  ];
  for (const file of candidates) {
    if (
      file.sourcePath.startsWith('dispatch/') ||
      (!file.sourcePath.includes('/lib/') &&
        !file.sourcePath.startsWith('lib/') &&
        file.sourcePath.endsWith('.sh'))
    )
      continue;
    const local = path.join(repo, file.destPath);
    if (!fs.existsSync(local)) continue;
    assertMachinePath(repo, local);
    const bytes = fs.readFileSync(local, 'utf8');
    const baseline = readPristineBaseline(repo, file.pack, file.destPath);
    const upstream = fs.readFileSync(path.join(templates, file.pack, file.sourcePath), 'utf8');
    if (
      bytes !== baseline &&
      comparable(bytes) !== comparable(upstream) &&
      !Object.values(result.libraries).includes(file.destPath)
    )
      throw new Error(
        `Custom helper requires explicit reconciliation: ${file.destPath}; use --from system policy after review`
      );
  }
  return result;
}

/** One-time retirement of native project transport. Executable copies remain
 * preserved, but stock code is thereafter selected from the machine snapshot. */
export function migrateSystemProject(options: SystemOptions): {
  changed: boolean;
  root: string;
  policy: SystemSurfacePolicy;
  changes: Change[];
} {
  const home = options.home ?? machineHome();
  const runtime = requireRuntime(home);
  if (!options.plan && configureSystemRuntime({ ...options, plan: true }).changed)
    throw new Error(
      'Configure system registration first: caws init adapters configure --agent-surface ' +
        options.surface
    );
  const vendor = vendorFor(options.surface);
  const repo = fs.realpathSync(options.repo ?? process.cwd());
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))
  );
  const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd: repo,
    env,
    encoding: 'utf8',
  }).trim();
  if (path.dirname(common) !== repo)
    throw new Error('System migration requires the canonical project root');
  if (
    !fs.existsSync(path.join(repo, '.caws/policy.yaml')) ||
    !fs.existsSync(path.join(repo, '.caws/specs')) ||
    fs.existsSync(path.join(repo, '.caws/working-spec.yaml'))
  )
    throw new Error('Legacy governance requires a separate migration; no hook files changed');
  const nativePath = path.join(
    repo,
    vendor,
    options.surface === 'codex' ? 'hooks.json' : 'settings.json'
  );
  const native = config(repo, nativePath);
  const inline = before(repo, path.join(repo, vendor, 'config.toml'));
  if (inline && /\[hooks[.\[\]]/.test(inline) && isCawsNativeCommand(inline))
    throw new Error('Inline project CAWS hooks require native-harness reconciliation');
  const projectPath = systemProjectPath(home, repo);
  const prior = before(home, projectPath);
  const project = prior === null ? { version: 1, root: repo, surfaces: {} } : JSON.parse(prior);
  if (
    project?.version !== 1 ||
    project.root !== repo ||
    !project.surfaces ||
    typeof project.surfaces !== 'object' ||
    Array.isArray(project.surfaces) ||
    Object.keys(project).sort().join(',') !== 'root,surfaces,version'
  )
    throw new Error('Malformed system project settings');
  const selected = options.fromFile
    ? JSON.parse(fs.readFileSync(options.fromFile, 'utf8'))
    : (project.surfaces[options.surface] ??
      inferPolicy(
        repo,
        options.surface,
        native.value,
        options.templatesRoot ?? path.resolve(__dirname, '../../templates/hook-packs')
      ));
  validateSystemPolicy(repo, selected, runtime);
  project.surfaces[options.surface] = selected;
  const nativeHooks = native.value.hooks;
  for (const [event, name] of Object.entries(MACHINE_EVENTS)) {
    const groups = nativeHooks?.[name];
    if (!nativeHooks || groups === undefined) continue;
    if (!Array.isArray(groups)) throw new Error(`Malformed project hook groups: ${name}`);
    const retained = groups
      .map((group: NativeHookGroup) => {
        if (!Array.isArray(group?.hooks)) throw new Error(`Malformed project hook group: ${name}`);
        return {
          ...group,
          hooks: group.hooks.filter((hook: NativeHook) => {
            if (!isCawsNativeCommand(hook?.command)) return true;
            if (!options.fromFile)
              migrateNativeCommand(hook.command, repo, home, options.surface, event as Event);
            return false;
          }),
        };
      })
      .filter((group: NativeHookGroup) => group.hooks.length > 0);
    if (retained.length === 0) delete nativeHooks[name];
    else nativeHooks[name] = retained;
  }
  if (configHasCawsHooks(native.value))
    throw new Error('Unrecognized lifecycle CAWS wiring remains; review native adapter');
  const changes: Change[] = [
    { root: home, path: projectPath, before: prior, after: encode(project) },
  ];
  if (native.bytes !== null)
    changes.push({
      root: repo,
      path: nativePath,
      before: native.bytes,
      after: encode(native.value),
    });
  const changed = changes.filter((c) => c.before !== c.after);
  applyChanges(home, changed, options.plan === true);
  return { changed: changed.length > 0, root: repo, policy: selected, changes: changed };
}

/** Filesystem configuration only; native trust and execution need native proof. */
export function systemSurfaceEnabled(
  surface: string | null | undefined,
  home: string = machineHome()
): boolean {
  if (!surface || surface === 'none') return false;
  const settings = readSystemSurfaceSettings(home, surface);
  if (!settings) return false;
  if (!settings.enabled) return false;
  requireRuntime(home);
  if (configureSystemRuntime({ surface, home, plan: true }).changed)
    throw new Error(
      'System surface settings and native registration disagree; run caws init adapters configure --agent-surface ' +
        surface
    );
  return true;
}
