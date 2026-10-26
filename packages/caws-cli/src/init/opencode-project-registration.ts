import * as path from 'node:path';
import { assertMachinePath } from './machine-paths';
import { liveSelectionReadIo, type SelectionReadIo } from './selection-read-io';
import { OPENCODE_NATIVE_PLUGIN_MEMBER } from './opencode-native-plugin';
import { readManifest, sha } from './machine-runtime-state';

export const OPENCODE_PROJECT_PLUGIN = '.opencode/plugins/caws.ts';
export const OPENCODE_PROJECT_TRANSPORT = 'project-native-stop' as const;

export interface OpenCodeRegistrationCaller {
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
}
interface LocalRegistrationOptions {
  readonly checkout: string;
  readonly caller: OpenCodeRegistrationCaller;
  readonly io?: SelectionReadIo;
  readonly allowMissing?: boolean;
}

function absolute(value: string | undefined, name: string): string {
  if (
    !value ||
    !path.isAbsolute(value) ||
    value.includes('\0') ||
    Buffer.from(value).toString('utf8') !== value
  )
    throw new Error(`OpenCode registration requires absolute original ${name}`);
  return path.normalize(value);
}

/** Original caller roots only. An OPENCODE_CONFIG_DIR adds a discovery root;
 * it does not replace XDG or HOME/.opencode discovery in the supported loader.
 * This is local registration observation, not a loaded-module attestation.
 */
export function openCodeRegistrationRoots(options: LocalRegistrationOptions): {
  readonly projectDirectories: readonly string[];
  readonly directories: readonly string[];
  readonly configFiles: readonly string[];
} {
  const { environment } = options.caller;
  const user = absolute(environment.HOME, 'HOME');
  const directory = absolute(options.caller.cwd, 'cwd');
  const checkout = absolute(options.checkout, 'checkout');
  const relative = path.relative(checkout, directory);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative))
    throw new Error('OpenCode caller directory is outside its native checkout');
  // These modes alter project discovery or permit opaque/in-memory sources.
  // Refusal is deliberate; a spelling in the environment grants no profile.
  for (const name of [
    'OPENCODE_CONFIG',
    'OPENCODE_CONFIG_CONTENT',
    'OPENCODE_AUTH_CONTENT',
    'OPENCODE_DISABLE_PROJECT_CONFIG',
    'OPENCODE_TEST_HOME',
    'OPENCODE_PURE',
    'OPENCODE_TEST_MANAGED_CONFIG_DIR',
    'OPENCODE_PLUGIN_META_FILE',
    'OPENCODE_WORKSPACE_ID',
    'OPENCODE_EXPERIMENTAL_WORKSPACES',
  ]) {
    if (environment[name] !== undefined && environment[name] !== '')
      throw new Error(`Unsupported OpenCode registration environment: ${name}`);
  }
  const configBase = environment.XDG_CONFIG_HOME
    ? absolute(environment.XDG_CONFIG_HOME, 'XDG_CONFIG_HOME')
    : path.join(user, '.config');
  const global = path.join(configBase, 'opencode');
  const projectDirectories: string[] = [];
  for (let cursor = directory; ; cursor = path.dirname(cursor)) {
    projectDirectories.push(cursor);
    if (cursor === checkout) break;
  }
  const directories = [
    ...new Set([
      global,
      ...projectDirectories.map((dir) => path.join(dir, '.opencode')),
      path.join(user, '.opencode'),
      ...(environment.OPENCODE_CONFIG_DIR
        ? [absolute(environment.OPENCODE_CONFIG_DIR, 'OPENCODE_CONFIG_DIR')]
        : []),
    ]),
  ];
  const configFiles = [
    ...new Set([
      ...['config.json', 'opencode.json', 'opencode.jsonc'].map((name) => path.join(global, name)),
      ...projectDirectories.flatMap((dir) =>
        ['opencode.json', 'opencode.jsonc'].map((name) => path.join(dir, name))
      ),
      ...directories.flatMap((dir) =>
        ['opencode.json', 'opencode.jsonc'].map((name) => path.join(dir, name))
      ),
    ]),
  ];
  return { projectDirectories, directories, configFiles };
}

function checked(io: SelectionReadIo, file: string): void {
  // Walk all ancestors: an absolute XDG root is not permission to follow a link.
  assertMachinePath(path.parse(file).root, file, io);
}

/** Enumerate the supported local loader surface. Unclassified plugins are
 * refused without evaluating their code. This deliberately does not certify
 * cached modules, authenticated org/well-known config, or managed preferences;
 * native harness qualification must independently cover those sources.
 */
export function observeOpenCodeLocalProducer(options: LocalRegistrationOptions): string {
  const io = options.io ?? liveSelectionReadIo;
  const roots = openCodeRegistrationRoots(options);
  for (const directory of roots.directories) {
    const legacy = path.join(directory, 'config');
    checked(io, legacy);
    if (io.exists(legacy))
      throw new Error(`Legacy OpenCode config requires reconciliation: ${legacy}`);
  }
  for (const file of roots.configFiles) {
    checked(io, file);
    if (!io.exists(file)) continue;
    if (io.stat(file).kind !== 'file') throw new Error(`OpenCode config is not a file: ${file}`);
    const bytes = io.readFile(file);
    const text = bytes.toString('utf8');
    if (!Buffer.from(text).equals(bytes) || /\{(?:env|file):/.test(text))
      throw new Error(`OpenCode config substitutions require reconciliation: ${file}`);
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new Error(`OpenCode local registration supports literal JSON only: ${file}`);
    }
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error(`Malformed OpenCode config: ${file}`);
    const plugins = (value as Record<string, unknown>).plugin;
    if (
      Object.hasOwn(value, 'plugins') ||
      (plugins !== undefined && (!Array.isArray(plugins) || plugins.length !== 0))
    )
      throw new Error(`OpenCode config plugin imports require reconciliation: ${file}`);
  }
  const producers = new Set<string>();
  for (const directory of roots.directories) {
    for (const name of ['plugin', 'plugins']) {
      const folder = path.join(directory, name);
      checked(io, folder);
      if (!io.exists(folder)) continue;
      if (io.stat(folder).kind !== 'directory')
        throw new Error(`OpenCode plugin discovery path is not a directory: ${folder}`);
      for (const entry of io.readDirectory(folder)) {
        if (entry !== path.basename(entry) || entry === '.' || entry === '..')
          throw new Error('Malformed OpenCode plugin directory observation');
        if (!/\.(?:ts|js)$/.test(entry)) continue;
        const file = path.join(folder, entry);
        checked(io, file);
        if (io.stat(file).kind !== 'file')
          throw new Error(`OpenCode plugin is not a regular file: ${file}`);
        producers.add(file);
      }
    }
  }
  const expected = path.join(options.checkout, OPENCODE_PROJECT_PLUGIN);
  if (
    !(options.allowMissing === true && producers.size === 0) &&
    (producers.size !== 1 || !producers.has(expected))
  )
    throw new Error(
      'OpenCode requires exactly one understood project plugin; reconcile missing, duplicate or unknown producers'
    );
  return expected;
}

export function readSelectedOpenCodeProducer(
  home: string,
  runtimeDigest: string,
  io: SelectionReadIo = liveSelectionReadIo
): Buffer {
  const manifest = readManifest(home, runtimeDigest, io);
  const member = path.join(home, 'lib/runtimes', runtimeDigest, OPENCODE_NATIVE_PLUGIN_MEMBER);
  checked(io, member);
  if (!manifest[OPENCODE_NATIVE_PLUGIN_MEMBER] || !manifest['native-entry.json'])
    throw new Error('Selected runtime has no OpenCode native project transport');
  const producer = io.readRuntimeFile(member).bytes;
  const binding = 'const NATIVE_STOP_HOME: string | null = ' + JSON.stringify(home) + ';';
  if (
    sha(producer) !== manifest[OPENCODE_NATIVE_PLUGIN_MEMBER] ||
    producer.toString('utf8').split(binding).length !== 2
  )
    throw new Error('OpenCode producer has a different machine-home binding');
  return producer;
}

/** Selected-generation equality is an observation. Native owner still admits
 * the sealed readset and actual harness/SQL/render qualification separately.
 */
export function validateObservedOpenCodeNativeRegistration(
  options: LocalRegistrationOptions & { readonly home: string; readonly runtimeDigest: string }
): void {
  const io = options.io ?? liveSelectionReadIo;
  const file = observeOpenCodeLocalProducer(options);
  const manifest = readManifest(options.home, options.runtimeDigest, io);
  const producer = readSelectedOpenCodeProducer(options.home, options.runtimeDigest, io);
  if (!io.readRuntimeFile(file).bytes.equals(producer))
    throw new Error('OpenCode project plugin differs from selected generation');
  const stable = path.join(options.home, 'bin/caws-hook-native');
  checked(io, stable);
  const captured = io.readRuntimeFile(stable, true);
  if (
    (captured.stat.mode & 0o7777) !== 0o755 ||
    sha(captured.bytes) !== manifest['native/caws-hook-native']
  )
    throw new Error('OpenCode stable entry differs from selected native generation');
}
