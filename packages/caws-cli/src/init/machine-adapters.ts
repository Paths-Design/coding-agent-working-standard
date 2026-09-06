import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { IMPLEMENTED_SURFACES, resolveHookPack } from './hook-packs/register';
import { SHARED_PACK } from './hook-packs/manifest-shared';

export interface MachineRuntimeOptions {
  readonly home?: string;
  readonly templatesRoot?: string;
  readonly plan?: boolean;
}

export interface MachineRuntimeResult {
  readonly home: string;
  readonly digest: string;
  readonly previousDigest: string | null;
  readonly changed: boolean;
  readonly launcher: string;
  readonly files: readonly string[];
}

interface RuntimePointer {
  version: 1;
  digest: string;
  previous_digest: string | null;
}

export function machineHome(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.CAWS_HOME || path.join(os.homedir(), '.caws');
  if (!path.isAbsolute(home)) throw new Error('CAWS_HOME must be an absolute path');
  return path.resolve(home);
}

/** Refuse redirected installation/read paths. The caller may use a resolved
 * temporary root, but no component below that root may be a symlink. */
export function assertMachinePath(root: string, file: string): void {
  const relative = path.relative(root, file);
  if (relative.startsWith('..') || path.isAbsolute(relative))
    throw new Error(`Path escapes root: ${file}`);
  let cursor = root;
  for (const part of ['', ...relative.split(path.sep).filter(Boolean)]) {
    if (part) cursor = path.join(cursor, part);
    try {
      if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error(`Refusing symlink: ${cursor}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
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
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

const sha = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');
const validDigest = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const pointerPath = (home: string): string => path.join(home, 'state/adapter-runtime.json');

function readPointer(home: string): RuntimePointer | null {
  const file = pointerPath(home);
  assertMachinePath(home, file);
  if (!fs.existsSync(file)) return null;
  const value = JSON.parse(fs.readFileSync(file, 'utf8')) as RuntimePointer;
  if (
    !value ||
    typeof value !== 'object' ||
    value.version !== 1 ||
    !validDigest(value.digest) ||
    (value.previous_digest !== null && !validDigest(value.previous_digest))
  ) {
    throw new Error('Malformed machine adapter runtime pointer');
  }
  return value;
}

function readManifest(home: string, digest: string): Record<string, string> {
  if (!validDigest(digest)) throw new Error('Invalid runtime digest');
  const root = path.join(home, 'lib/runtimes', digest);
  assertMachinePath(home, path.join(root, 'manifest.json'));
  const manifest = fs.readFileSync(path.join(root, 'manifest.json'), 'utf8');
  if (sha(manifest) !== digest) throw new Error(`Runtime manifest integrity failure: ${digest}`);
  const files = JSON.parse(manifest) as Record<string, string>;
  if (
    !files ||
    typeof files !== 'object' ||
    Array.isArray(files) ||
    !validDigest(files['launcher.py'])
  )
    throw new Error('Malformed machine runtime manifest');
  return files;
}

export function verifyRuntime(home: string, digest: string): Record<string, string> {
  const files = readManifest(home, digest);
  const root = path.join(home, 'lib/runtimes', digest);
  for (const [relative, expected] of Object.entries(files)) {
    const file = path.join(root, relative);
    assertMachinePath(root, file);
    if (!validDigest(expected) || sha(fs.readFileSync(file)) !== expected) {
      throw new Error(
        `Machine runtime file modified: ${relative}; preserve and reconcile local growth before updating`
      );
    }
  }
  return files;
}

/** A stable bootstrap survives snapshot updates. Recognize the original
 * standalone layout by its verified manifest, but never replace local growth.
 * A matching bootstrap with no pointer is an interrupted first installation. */
function needsBootstrap(home: string, pointer: RuntimePointer | null, bootstrap: Buffer): boolean {
  const launcher = path.join(home, 'bin/caws-hook');
  assertMachinePath(home, launcher);
  if (!fs.existsSync(launcher)) return true;
  const installed = sha(fs.readFileSync(launcher));
  if (installed === sha(bootstrap)) return false;
  if (pointer) {
    const manifest = readManifest(home, pointer.digest);
    if (!manifest['bootstrap.py'] && installed === manifest['launcher.py']) return true;
    throw new Error(
      'Machine launcher modified; reconcile local growth before updating or rollback'
    );
  }
  throw new Error('Unmanaged machine launcher exists; refusing to overwrite it');
}

function activateRuntime(
  home: string,
  pointer: RuntimePointer,
  bootstrap: Buffer,
  installBootstrap: boolean
): void {
  // During first-install/legacy migration, the bootstrap can run the old
  // snapshot or fail safely until a pointer exists. Retry recognizes these
  // exact bytes. All subsequent updates and rollbacks have ONE commit point.
  if (installBootstrap)
    atomicMachineWrite(home, path.join(home, 'bin/caws-hook'), bootstrap, 0o755);
  atomicMachineWrite(home, pointerPath(home), JSON.stringify(pointer));
}

function runtimeFiles(templatesRoot: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const add = (dest: string, source: string): void => {
    assertMachinePath(templatesRoot, source);
    files.set(dest, fs.readFileSync(source));
  };
  for (const file of SHARED_PACK.installedFiles) {
    if (file.sourcePath.startsWith('lib/') || file.sourcePath === 'runtime-paths.sh') {
      add(file.sourcePath, path.join(templatesRoot, 'shared', file.sourcePath));
    }
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
  add('launcher.py', path.join(templatesRoot, 'runtime/caws-hook.py'));
  add('bootstrap.py', path.join(templatesRoot, 'runtime/bootstrap.py'));
  add('dispatch.sh', path.join(templatesRoot, 'runtime/dispatch.sh'));
  add('handler-env.sh', path.join(templatesRoot, 'runtime/handler-env.sh'));
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
  const files = runtimeFiles(templatesRoot);
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
  const result: MachineRuntimeResult = {
    home,
    digest,
    previousDigest: prior?.digest ?? null,
    changed: prior?.digest !== digest || installBootstrap,
    launcher,
    files: [...files.keys()],
  };
  if (options.plan || !result.changed) return result;

  if (fs.existsSync(snapshot)) {
    verifyRuntime(home, digest);
  } else {
    const temporary = `${snapshot}.pending.${randomUUID()}`;
    assertMachinePath(home, temporary);
    try {
      for (const [relative, bytes] of files)
        atomicMachineWrite(home, path.join(temporary, relative), bytes);
      atomicMachineWrite(home, path.join(temporary, 'manifest.json'), manifest);
      fs.renameSync(temporary, snapshot);
    } finally {
      if (fs.existsSync(temporary)) fs.rmSync(temporary, { recursive: true });
    }
  }
  activateRuntime(
    home,
    { version: 1, digest, previous_digest: prior?.digest ?? null },
    bootstrap,
    installBootstrap
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
  const digest = current.previous_digest;
  const files = verifyRuntime(home, digest);
  const launcher = path.join(home, 'bin/caws-hook');
  const templatesRoot =
    options.templatesRoot ?? path.resolve(__dirname, '../../templates/hook-packs');
  const bootstrapPath = path.join(templatesRoot, 'runtime/bootstrap.py');
  assertMachinePath(templatesRoot, bootstrapPath);
  const bootstrap = fs.readFileSync(bootstrapPath);
  const installBootstrap = needsBootstrap(home, current, bootstrap);
  if (!options.plan) {
    activateRuntime(
      home,
      { version: 1, digest, previous_digest: current.digest },
      bootstrap,
      installBootstrap
    );
  }
  return {
    home,
    digest,
    previousDigest: current.digest,
    changed: true,
    launcher,
    files: Object.keys(files),
  };
}
