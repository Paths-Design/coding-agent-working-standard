import { assertMachinePath } from './machine-paths';
export { assertMachinePath } from './machine-paths';
import {
  sha,
  pointerPath,
  readPointer,
  readManifest,
  readNativeEntryFileIdentity,
  readRetainedNativeEntryIdentity,
  verifyRuntime,
  type RuntimePointer,
} from './machine-runtime-state';
export { verifyRuntime } from './machine-runtime-state';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import { IMPLEMENTED_SURFACES, resolveHookPack } from './hook-packs/register';
import { extractMachineHandlers } from './machine-handler-policy';
import { SHARED_PACK } from './hook-packs/manifest-shared';
import { readNativeImage } from './native-runtime-entry';
import {
  OPENCODE_NATIVE_PLUGIN_MEMBER,
  renderOpenCodeNativePlugin,
} from './opencode-native-plugin';

export interface MachineRuntimeOptions {
  readonly home?: string;
  readonly templatesRoot?: string;
  readonly plan?: boolean;
  /** Explicit local, pinned production image; installation never opts a harness in. */
  readonly nativeImage?: string;
}

export interface MachineRuntimeResult {
  readonly home: string;
  readonly digest: string;
  readonly previousDigest: string | null;
  readonly changed: boolean;
  readonly launcher: string;
  readonly files: readonly string[];
  readonly nativeLauncher?: string;
}

export function machineHome(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.CAWS_HOME || path.join(os.homedir(), '.caws');
  if (!path.isAbsolute(home)) throw new Error('CAWS_HOME must be an absolute path');
  return path.resolve(home);
}

export function atomicMachineWrite(
  root: string,
  file: string,
  bytes: string | Buffer,
  mode = 0o600
): void {
  assertMachinePath(root, file);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp.${randomUUID()}`;
  try {
    fs.writeFileSync(temporary, bytes, { flag: 'wx', mode });
    // Creation modes are filtered by umask. Apply the declared final mode
    // before publication, including exact executable-mode repairs.
    fs.chmodSync(temporary, mode);
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

/** Did CAWS itself publish these launcher bytes at some point? Every runtime
 * snapshot records the bootstrap it shipped with, and snapshots are retained
 * for rollback, so the set of bootstraps this machine has ever been given is
 * already on disk. Membership is what separates the two cases that a simple
 * inequality conflates: upstream moved (replace it) versus the operator edited
 * it (refuse). Without the distinction, the bootstrap is effectively frozen —
 * shipping any fix to it refuses on every machine that already has the prior
 * one, and blames the operator for local growth that does not exist.
 *
 * readManifest refuses a manifest whose bytes do not hash to its own directory
 * name, so this reads only snapshots that are internally consistent. That is an
 * integrity check, not an authorization boundary: anyone able to write under
 * lib/runtimes/ could mint a self-consistent snapshot, but they could equally
 * overwrite bin/caws-hook directly. Write access to the machine home was never
 * what this refusal defends against. */
function everShippedBootstrap(home: string, installed: string): boolean {
  let digests: string[];
  try {
    digests = fs.readdirSync(path.join(home, 'lib/runtimes'));
  } catch {
    return false;
  }
  return digests.some((digest) => {
    try {
      return readManifest(home, digest)['bootstrap.py'] === installed;
    } catch {
      // A corrupt or partial snapshot vouches for nothing; it must not make
      // the scan throw, or one bad directory would freeze the upgrade path.
      return false;
    }
  });
}

/** A stable bootstrap survives snapshot updates. Recognize any bootstrap this
 * machine was previously given, and the original standalone layout by its
 * verified manifest, but never replace local growth. A matching bootstrap with
 * no pointer is an interrupted first installation. */
function needsBootstrap(home: string, pointer: RuntimePointer | null, bootstrap: Buffer): boolean {
  const launcher = path.join(home, 'bin/caws-hook');
  assertMachinePath(home, launcher);
  if (!fs.existsSync(launcher)) return true;
  const installed = sha(fs.readFileSync(launcher));
  if (installed === sha(bootstrap)) return false;
  // Checked before the pointer branch on purpose: a bootstrap we shipped is
  // ours to replace whether or not a pointer currently resolves, which is also
  // the state an interrupted install or a rollback leaves behind.
  if (everShippedBootstrap(home, installed)) return true;
  if (pointer) {
    const manifest = readManifest(home, pointer.digest);
    if (!manifest['bootstrap.py'] && installed === manifest['launcher.py']) return true;
    throw new Error(
      'Machine launcher modified: bin/caws-hook matches no bootstrap CAWS has shipped, so it' +
        ' carries local growth. Reconcile or remove it before updating, or rollback.'
    );
  }
  throw new Error('Unmanaged machine launcher exists; refusing to overwrite it');
}

function needsNativeEntry(home: string, bytes: Buffer): boolean {
  const target = path.join(home, 'bin/caws-hook-native');
  assertMachinePath(home, target);
  if (!fs.existsSync(target)) return true;
  const installed = readNativeEntryFileIdentity(home, target);
  if (installed.sha256 === sha(bytes)) return installed.mode !== 0o755;
  const runtimes = path.join(home, 'lib/runtimes');
  assertMachinePath(home, runtimes);
  const recognized =
    fs.existsSync(runtimes) &&
    fs.readdirSync(runtimes).some((digest) => {
      try {
        return readRetainedNativeEntryIdentity(home, digest).sha256 === installed.sha256;
      } catch {
        return false;
      }
    });
  if (!recognized)
    throw new Error(
      'Native machine entry matches no verified retained entry identity; preserve and reconcile local growth'
    );
  return true;
}

/** Cached native registrations outlive a rollback to a legacy generation.
 * Repair only a manifest-bound retained entry identity under machine-home
 * custody; never invent a fallback or overwrite unrecognized operator bytes.
 */
function legacyCompatibilityEntry(
  home: string,
  preferred: string | undefined
): { bytes: Buffer; install: boolean } | undefined {
  const runtimes = path.join(home, 'lib/runtimes');
  assertMachinePath(home, runtimes);
  const stable = path.join(home, 'bin/caws-hook-native');
  assertMachinePath(home, stable);
  const candidates = [
    ...new Set([
      ...(preferred ? [preferred] : []),
      ...(fs.existsSync(runtimes) ? fs.readdirSync(runtimes).sort() : []),
    ]),
  ];
  const retained = candidates.flatMap((digest) => {
    try {
      return [readRetainedNativeEntryIdentity(home, digest)];
    } catch {
      // A corrupt candidate cannot vouch for entry bytes. Other retained
      // identities may still provide the existing catalogue fallback.
      return [];
    }
  });
  if (!retained.length) {
    const unverifiedNative =
      fs.existsSync(stable) ||
      candidates.some((digest) => {
        if (!/^[a-f0-9]{64}$/.test(digest)) return false;
        if (
          fs.lstatSync(path.join(runtimes, digest, 'native-entry.json'), {
            throwIfNoEntry: false,
          }) ||
          fs.lstatSync(path.join(runtimes, digest, 'native/caws-hook-native'), {
            throwIfNoEntry: false,
          })
        )
          return true;
        try {
          const manifest = readManifest(home, digest);
          return (
            Object.hasOwn(manifest, 'native-entry.json') ||
            Object.hasOwn(manifest, 'native/caws-hook-native')
          );
        } catch {
          return false;
        }
      });
    if (unverifiedNative)
      throw new Error(
        'Native compatibility identity cannot be verified; preserve runtime state and reconcile before legacy selection'
      );
    return undefined; // Legacy-only homes have no native obligation.
  }
  if (fs.existsSync(stable)) {
    const installed = readNativeEntryFileIdentity(home, stable);
    if (!retained.some(({ sha256 }) => installed.sha256 === sha256))
      throw new Error('Native compatibility entry has local growth; refusing legacy selection');
    return { bytes: installed.bytes, install: installed.mode !== 0o755 };
  }
  return { bytes: retained[0]!.bytes, install: true };
}

function activateRuntime(
  home: string,
  pointer: RuntimePointer | null,
  bootstrap: Buffer,
  installBootstrap: boolean,
  nativeEntry?: { readonly bytes: Buffer; readonly install: boolean }
): void {
  // During first-install/legacy migration, the bootstrap can run the old
  // snapshot or fail safely until a pointer exists. Retry recognizes these
  // exact bytes. All subsequent updates and rollbacks have ONE commit point.
  // A null pointer means the generation is already selected and only the
  // stable entry is repaired: the pointer's previous_digest is the rollback
  // target, so it is left untouched rather than rewritten to point at itself.
  // Publish the parallel entry before the pointer. Every supported entry must
  // understand native-entry.v1 and positively recognized legacy compatibility.
  // Legacy bootstrap selection occurs later and is never attested by this write.
  if (nativeEntry?.install)
    atomicMachineWrite(home, path.join(home, 'bin/caws-hook-native'), nativeEntry.bytes, 0o755);
  if (installBootstrap)
    atomicMachineWrite(home, path.join(home, 'bin/caws-hook'), bootstrap, 0o755);
  if (pointer) atomicMachineWrite(home, pointerPath(home), JSON.stringify(pointer));
}

function runtimeFiles(templatesRoot: string, home: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const add = (dest: string, source: string): void => {
    assertMachinePath(templatesRoot, source);
    files.set(dest, fs.readFileSync(source));
  };
  for (const file of SHARED_PACK.installedFiles) {
    add(file.sourcePath, path.join(templatesRoot, 'shared', file.sourcePath));
  }
  for (const surface of IMPLEMENTED_SURFACES) {
    const resolved = resolveHookPack(surface);
    if (resolved.kind !== 'pack') continue;
    for (const file of resolved.pack.installedFiles) {
      if (file.sourcePath.startsWith('hooks/lib/')) {
        add(
          `surfaces/${surface}/lib/${path.basename(file.sourcePath)}`,
          path.join(templatesRoot, surface, file.sourcePath)
        );
      }
    }
  }
  const opencodePlugin = path.join(templatesRoot, 'opencode/plugin.ts');
  assertMachinePath(templatesRoot, opencodePlugin);
  files.set(
    OPENCODE_NATIVE_PLUGIN_MEMBER,
    renderOpenCodeNativePlugin(fs.readFileSync(opencodePlugin), home)
  );
  const defaults: Record<string, string[]> = {};
  for (const event of [
    'pre_tool_use',
    'post_tool_use',
    'session_start',
    'stop',
    'pre_compact',
    'session_end',
  ]) {
    const dispatcher = fs.readFileSync(
      path.join(templatesRoot, 'shared/dispatch', `${event}.sh`),
      'utf8'
    );
    defaults[event] = extractMachineHandlers(dispatcher, dispatcher);
  }
  files.set('system-policy.json', Buffer.from(JSON.stringify({ version: 1, events: defaults })));
  add('launcher.py', path.join(templatesRoot, 'runtime/caws-hook.py'));
  add('bootstrap.py', path.join(templatesRoot, 'runtime/bootstrap.py'));
  add('dispatch.sh', path.join(templatesRoot, 'runtime/dispatch.sh'));
  add('handler-env.sh', path.join(templatesRoot, 'runtime/handler-env.sh'));
  // The ownership oracle runs outside the CLI installation and must not depend
  // on a governed project's node_modules. Copy the dependency's CommonJS API
  // into the immutable snapshot (including its license), never into the repo.
  const yamlRoot = fs.realpathSync(path.dirname(require.resolve('js-yaml/package.json')));
  const addYaml = (relative: string): void => {
    const source = path.join(yamlRoot, relative);
    assertMachinePath(yamlRoot, source);
    const stat = fs.lstatSync(source);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(source).sort()) addYaml(path.join(relative, entry));
    } else if (stat.isFile()) {
      files.set(`node_modules/js-yaml/${relative}`, fs.readFileSync(source));
    } else {
      throw new Error(`Unsupported YAML runtime dependency entry: ${source}`);
    }
  };
  for (const relative of ['package.json', 'index.js', 'LICENSE', 'lib']) addYaml(relative);
  return files;
}

function withRuntimeLock(home: string, run: () => MachineRuntimeResult): MachineRuntimeResult {
  const lock = path.join(home, 'state/adapter-install.lock');
  assertMachinePath(home, lock);
  fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
  try {
    fs.mkdirSync(lock, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new Error(
        `Machine runtime installation is locked: ${lock}; inspect an interrupted install before retrying`
      );
    throw error;
  }
  try {
    return run();
  } finally {
    fs.rmdirSync(lock);
  }
}

export function installMachineRuntime(options: MachineRuntimeOptions = {}): MachineRuntimeResult {
  if (options.plan) return installRuntime(options);
  return withRuntimeLock(path.resolve(options.home ?? machineHome()), () =>
    installRuntime(options)
  );
}

function installRuntime(options: MachineRuntimeOptions): MachineRuntimeResult {
  const home = path.resolve(options.home ?? machineHome());
  const templatesRoot =
    options.templatesRoot ?? path.resolve(__dirname, '../../templates/hook-packs');
  const files = runtimeFiles(templatesRoot, home);
  const executablePaths = new Set([...files.keys()].filter((relative) => relative.endsWith('.sh')));
  const native = options.nativeImage ? readNativeImage(options.nativeImage) : undefined;
  if (native) {
    for (const relative of native.executablePaths) executablePaths.add(relative);
    for (const [relative, bytes] of native.files) {
      if (files.has(relative)) throw new Error(`Native runtime destination collision: ${relative}`);
      files.set(relative, bytes);
    }
    // Bind the complete generation's executable membership, including legacy
    // compatibility assets, using ordinary manifest-hashed metadata.
    files.set(
      'native-modes.json',
      Buffer.from(
        JSON.stringify(
          Object.fromEntries(
            [...files.keys()]
              .sort()
              .map((relative) => [relative, executablePaths.has(relative) ? 0o755 : 0o644])
          )
        )
      )
    );
  }
  const manifest = JSON.stringify(
    Object.fromEntries(
      [...files].sort(([a], [b]) => a.localeCompare(b)).map(([p, b]) => [p, sha(b)])
    )
  );
  const digest = sha(manifest);
  const prior = readPointer(home);
  if (prior) verifyRuntime(home, prior.digest);
  const launcher = path.join(home, 'bin/caws-hook');
  const snapshot = path.join(home, 'lib/runtimes', digest);
  for (const file of [launcher, snapshot, pointerPath(home)]) assertMachinePath(home, file);
  const bootstrap = files.get('bootstrap.py') as Buffer;
  const installBootstrap = needsBootstrap(home, prior, bootstrap);
  const nativeEntry = native
    ? { bytes: native.stableEntry, install: needsNativeEntry(home, native.stableEntry) }
    : legacyCompatibilityEntry(home, prior?.digest);
  // Selecting the generation that is already current only repairs the entry;
  // its rollback history is whatever the pointer already records.
  const reselect = prior?.digest !== digest;
  const result: MachineRuntimeResult = {
    home,
    digest,
    previousDigest: reselect ? (prior?.digest ?? null) : (prior?.previous_digest ?? null),
    changed: reselect || installBootstrap || nativeEntry?.install === true,
    launcher,
    files: [...files.keys()],
    ...(nativeEntry ? { nativeLauncher: path.join(home, 'bin/caws-hook-native') } : {}),
  };
  if (options.plan || !result.changed) return result;

  if (fs.existsSync(snapshot)) {
    verifyRuntime(home, digest);
  } else {
    const temporary = `${snapshot}.pending.${randomUUID()}`;
    assertMachinePath(home, temporary);
    try {
      for (const [relative, bytes] of files)
        atomicMachineWrite(
          home,
          path.join(temporary, relative),
          bytes,
          executablePaths.has(relative) ? 0o755 : native ? 0o644 : 0o600
        );
      atomicMachineWrite(
        home,
        path.join(temporary, 'manifest.json'),
        manifest,
        native ? 0o644 : 0o600
      );
      fs.renameSync(temporary, snapshot);
    } finally {
      if (fs.existsSync(temporary)) fs.rmSync(temporary, { recursive: true });
    }
  }
  verifyRuntime(home, digest);
  activateRuntime(
    home,
    reselect ? { version: 1, digest, previous_digest: prior?.digest ?? null } : null,
    bootstrap,
    installBootstrap,
    nativeEntry
  );
  return result;
}

export function rollbackMachineRuntime(options: MachineRuntimeOptions = {}): MachineRuntimeResult {
  if (options.plan) return rollbackRuntime(options);
  return withRuntimeLock(path.resolve(options.home ?? machineHome()), () =>
    rollbackRuntime(options)
  );
}

function rollbackRuntime(options: MachineRuntimeOptions): MachineRuntimeResult {
  const home = path.resolve(options.home ?? machineHome());
  const current = readPointer(home);
  if (!current?.previous_digest) throw new Error('No previous machine runtime to restore');
  // A pointer that names its own generation as the predecessor has no rollback
  // target; reselecting it would report a rollback that changed nothing.
  if (current.previous_digest === current.digest)
    throw new Error(
      `No previous machine runtime to restore: the recorded previous runtime is the current one (${current.digest}). ` +
        'Select the intended runtime by running caws init adapters install from its CLI package.'
    );
  const digest = current.previous_digest;
  const files = verifyRuntime(home, digest);
  const launcher = path.join(home, 'bin/caws-hook');
  const templatesRoot =
    options.templatesRoot ?? path.resolve(__dirname, '../../templates/hook-packs');
  const bootstrapPath = path.join(templatesRoot, 'runtime/bootstrap.py');
  assertMachinePath(templatesRoot, bootstrapPath);
  const bootstrap = fs.readFileSync(bootstrapPath);
  const installBootstrap = needsBootstrap(home, current, bootstrap);
  const nativeBytes = files['native-entry.json']
    ? readRetainedNativeEntryIdentity(home, digest).bytes
    : undefined;
  const nativeEntry = nativeBytes
    ? { bytes: nativeBytes, install: needsNativeEntry(home, nativeBytes) }
    : legacyCompatibilityEntry(home, current.digest);
  if (!options.plan) {
    activateRuntime(
      home,
      { version: 1, digest, previous_digest: current.digest },
      bootstrap,
      installBootstrap,
      nativeEntry
    );
  }
  return {
    home,
    digest,
    previousDigest: current.digest,
    changed: true,
    launcher,
    files: Object.keys(files),
    ...(nativeEntry ? { nativeLauncher: path.join(home, 'bin/caws-hook-native') } : {}),
  };
}
