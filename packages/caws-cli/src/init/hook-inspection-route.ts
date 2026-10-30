/** Observe supported registration as inert data. Image installation is not registration. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { TextDecoder } from 'node:util';
import { parse as parseToml } from 'smol-toml';
import { parseJsonSource } from '../runtime/json-custody';
import { assertMachinePath } from './machine-paths';
import { readSystemSurfaceSettings, nativeConfigPath } from './system-surface-settings';
import {
  MACHINE_EVENTS,
  classifyCawsProducerHook,
  isCawsProducerHookCandidate,
  isCawsNativeCommand,
  machineCommand,
  systemCommand,
  universalEventMatcher,
  unconditionalCommandHook,
  qualifiedHookTimeout,
} from './native-hook-identification';
import {
  OPENCODE_PROJECT_TRANSPORT,
  validateObservedOpenCodeNativeRegistration,
} from './opencode-project-registration';
import { readPointer } from './machine-runtime-state';

export interface HookInspectionRoute {
  readonly entry: 'native' | 'legacy';
  readonly system: boolean;
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null &&
  typeof value === 'object' &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));

const CODEX_JSON_EVENTS = new Set([
  'PreModelRequest',
  'PostModelRequest',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PreCompact',
  'PostCompact',
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'SubagentStart',
  'SubagentStop',
  'Stop',
  'Interrupt',
]);

/** Observe a finite command-only subset of Codex HooksFile as inert data.
 * Codex parses the whole file before discovering any event. Unknown fields,
 * other handler forms and precision-losing numerals require reconciliation.
 * This validation establishes neither persisted trust nor a native callback.
 */
function readCodexJson(file: string): unknown {
  function unsupported(): never {
    throw new Error('Unsupported Codex JSON registration at ' + file);
  }
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > 1024 * 1024) unsupported();
  let config: unknown;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file));
    parseJsonSource(text, 16, 100_000, true);
    config = JSON.parse(text);
  } catch {
    // Parser diagnostics can expose configuration values.
    throw new Error('Malformed UTF-8 or invalid Codex JSON registration at ' + file);
  }
  if (!object(config) || Object.keys(config).some((key) => !['description', 'hooks'].includes(key)))
    unsupported();
  if (Object.hasOwn(config, 'description') && typeof config.description !== 'string') unsupported();
  if (!Object.hasOwn(config, 'hooks')) return config;
  if (!object(config.hooks)) unsupported();
  for (const [event, groups] of Object.entries(config.hooks)) {
    if (!CODEX_JSON_EVENTS.has(event) || !Array.isArray(groups)) unsupported();
    for (const group of groups) {
      if (
        !object(group) ||
        Object.keys(group).some((key) => !['matcher', 'hooks'].includes(key)) ||
        (Object.hasOwn(group, 'matcher') && typeof group.matcher !== 'string') ||
        !Array.isArray(group.hooks)
      )
        unsupported();
      for (const hook of group.hooks) {
        if (
          !object(hook) ||
          Object.keys(hook).some(
            (key) => !['type', 'command', 'timeout', 'statusMessage'].includes(key)
          ) ||
          hook.type !== 'command' ||
          typeof hook.command !== 'string' ||
          hook.command.trim() === '' ||
          (Object.hasOwn(hook, 'timeout') &&
            (typeof hook.timeout !== 'number' ||
              !Number.isSafeInteger(hook.timeout) ||
              hook.timeout <= 0)) ||
          (Object.hasOwn(hook, 'statusMessage') && typeof hook.statusMessage !== 'string')
        )
          unsupported();
      }
    }
  }
  return config;
}

/** Parsing establishes decoded keys, not native feature enablement or trust.
 * Codex hook declarations/state and feature layers require native qualification;
 * ordinary model/project configuration does not establish a competing route.
 */
function inspectCodexToml(file: string): void {
  if (!fs.existsSync(file)) return;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > 1024 * 1024)
    throw new Error('Unsupported TOML registration configuration at ' + file);
  let document: Record<string, unknown>;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file));
    document = parseToml(text, {
      integersAsBigInt: true,
      unsafeKeyBehaviour: 'throw',
      useLegacyDate: true,
    });
  } catch {
    // Parser diagnostics can include source values. Report the file, not secrets.
    throw new Error('Malformed UTF-8 or TOML registration configuration at ' + file);
  }
  function unsupported(): never {
    throw new Error('TOML hooks/features/state require native-harness qualification at ' + file);
  }
  const inspectLayer = (layer: Record<string, unknown>): void => {
    if (Object.hasOwn(layer, 'hooks') || Object.hasOwn(layer, 'features')) unsupported();
  };
  inspectLayer(document);
  if (Object.hasOwn(document, 'profiles')) {
    if (!object(document.profiles)) unsupported();
    for (const profile of Object.values(document.profiles)) {
      if (!object(profile)) unsupported();
      inspectLayer(profile);
    }
  }
}

/** Reuse invocation selection's producer ownership and coverage predicates.
 * Unsupported/additive routes are unavailable, never guessed from installed files.
 * This filesystem observation attests no native trust or execution.
 */
export function observeHookInspectionRoute(options: {
  home: string;
  surface: string;
  event: string;
  canonical: string;
  checkout: string;
  caller: { cwd: string; environment: Readonly<Record<string, string>> };
}): HookInspectionRoute {
  const { home, surface, event } = options;
  if (!Object.hasOwn(MACHINE_EVENTS, event)) throw new Error('Unknown hook event');
  const settings = readSystemSurfaceSettings(home, surface);
  if (surface === 'opencode') {
    if (event !== 'stop' || !settings?.enabled || settings.transport !== OPENCODE_PROJECT_TRANSPORT)
      throw new Error('OpenCode native Stop registration is not explicitly configured');
    const pointer = readPointer(home);
    if (!pointer) throw new Error('No selected machine runtime');
    validateObservedOpenCodeNativeRegistration({
      checkout: options.checkout,
      caller: options.caller,
      home,
      runtimeDigest: pointer.digest,
    });
    return { entry: 'native', system: true };
  }
  const vendor =
    surface === 'codex'
      ? '.codex'
      : surface === 'claude-code'
        ? '.claude'
        : surface === 'qwen-code'
          ? '.qwen'
          : null;
  if (!vendor) throw new Error('No qualified registration observer for ' + surface);
  const user = options.caller.environment.HOME || os.homedir();
  if (!path.isAbsolute(user)) throw new Error('Registration requires an absolute caller HOME');
  const primary = surface === 'codex' ? 'hooks.json' : 'settings.json';
  const selected: HookInspectionRoute[] = [];
  for (const root of new Set([user, options.canonical, options.checkout])) {
    const userLayer = root === user;
    const toml = path.join(root, vendor, 'config.toml');
    assertMachinePath(root, toml);
    if (surface === 'codex') inspectCodexToml(toml);
    else if (fs.existsSync(toml) && isCawsNativeCommand(fs.readFileSync(toml, 'utf8')))
      throw new Error('Inline CAWS registration requires native-harness reconciliation');
    for (const name of [primary, 'settings.local.json']) {
      const file =
        userLayer && name === primary
          ? nativeConfigPath(user, vendor, name, settings?.native_config_target)
          : path.join(root, vendor, name);
      if (!(userLayer && name === primary && settings?.native_config_target))
        assertMachinePath(root, file);
      if (!fs.existsSync(file)) continue;
      const config: unknown =
        surface === 'codex' ? readCodexJson(file) : JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!object(config) || (config.hooks !== undefined && !object(config.hooks)))
        throw new Error('Malformed native registration');
      if (config.disableAllHooks === true) throw new Error('Native hooks are disabled');
      const groups = object(config.hooks)
        ? (config.hooks[MACHINE_EVENTS[event as keyof typeof MACHINE_EVENTS]] ?? [])
        : [];
      if (!Array.isArray(groups)) throw new Error('Malformed native hook groups');
      for (const group of groups) {
        if (!object(group) || !Array.isArray(group.hooks))
          throw new Error('Malformed native hook group');
        if (group.enabled === false) continue;
        for (const hook of group.hooks) {
          if (!object(hook) || hook.enabled === false || !isCawsProducerHookCandidate(hook))
            continue;
          const ownership = classifyCawsProducerHook(hook, surface, event);
          if (ownership.kind === 'foreign') continue;
          if (
            ownership.kind !== 'owned' ||
            name !== primary ||
            !universalEventMatcher(surface, event, group.matcher) ||
            !unconditionalCommandHook(group, hook, surface, event) ||
            !qualifiedHookTimeout(surface, event, hook.timeout)
          )
            throw new Error('Restricted or unresolved CAWS registration requires reconciliation');
          const system = userLayer;
          const expected = system
            ? systemCommand(home, surface, event, ownership.entry)
            : machineCommand(home, surface, event, ownership.entry);
          if (
            hook.command !== expected ||
            (!userLayer && root !== options.canonical) ||
            (system && !settings?.enabled)
          )
            throw new Error('CAWS registration and selected machine configuration disagree');
          selected.push({ entry: ownership.entry, system });
        }
      }
    }
  }
  if (selected.length !== 1)
    throw new Error(
      selected.length
        ? 'Additive CAWS registrations require reconciliation'
        : 'No effective CAWS registration observed'
    );
  return selected[0]!;
}
