/** Explicit opt-in preparation. Native admission/publication still precedes dispatch. */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { assertMachinePath } from '../init/machine-paths';
import type { RuntimeRequest } from './protocol';
import type { ActiveInvocationSelection } from './selection';
import {
  prepareSessionRenderImage,
  SERVICE_IMAGE_PROFILE,
  SERVICE_IMAGE_TOOLS,
  SERVICE_IMAGE_PLAN_TOOL,
  type PreparedServiceImage,
  type ServiceImageManifest,
  type ServiceToolPin,
} from './service-image';
import { SERVICE_ADAPTER } from './service-client';

const sha = (bytes: Uint8Array | string): string =>
  createHash('sha256').update(bytes).digest('hex');
export interface NativeRenderOffer {
  readonly schema: 'caws.render.owner.offer.v1';
  readonly prepared: PreparedServiceImage;
  readonly expectedSelection: ServiceImageManifest['selection'];
  readonly policySha256: string;
  readonly checkout: string;
  readonly sessionId: string;
  readonly invocationId: string;
  readonly callerEnvironment: Readonly<Record<string, string>>;
  readonly remainingBudgetMs: number;
}

function regular(file: string, maximum: number, requireSingleLink = true): Buffer {
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
  );
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size > maximum || (requireSingleLink && before.nlink !== 1))
      throw new Error('Render service source is outside its regular-file envelope');
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) throw new Error('Short render service source read');
      offset += count;
    }
    const after = fs.fstatSync(fd),
      named = fs.lstatSync(file);
    if (
      [after, named].some(
        (stat) =>
          stat.dev !== before.dev ||
          stat.ino !== before.ino ||
          stat.size !== before.size ||
          stat.mtimeMs !== before.mtimeMs ||
          stat.ctimeMs !== before.ctimeMs
      )
    )
      throw new Error('Render service source changed during preparation');
    return bytes;
  } finally {
    fs.closeSync(fd);
  }
}

export function resolveRenderTools(
  environment: Readonly<Record<string, string>>,
  clientDirectory = __dirname,
  nativeExecutable?: string
): readonly ServiceToolPin[] {
  const names: readonly string[] = nativeExecutable
    ? [...SERVICE_IMAGE_TOOLS, SERVICE_IMAGE_PLAN_TOOL].sort()
    : SERVICE_IMAGE_TOOLS;
  return Object.freeze(
    names.map((name): ServiceToolPin => {
      let file: string | undefined;
      if (name === 'node') file = process.execPath;
      else if (name === 'caws') file = path.resolve(clientDirectory, '../index.js');
      else if (name === SERVICE_IMAGE_PLAN_TOOL) {
        if (!nativeExecutable || !path.isAbsolute(nativeExecutable))
          throw new Error('Native plan helper requires explicit owner configuration');
        file = nativeExecutable;
      } else {
        for (const directory of (environment.PATH ?? '').split(path.delimiter)) {
          if (!path.isAbsolute(directory)) continue;
          const candidate = path.join(directory, name);
          try {
            fs.accessSync(candidate, fs.constants.X_OK);
            file = candidate;
            break;
          } catch (error) {
            if (
              !['ENOENT', 'ENOTDIR', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')
            )
              throw error;
          }
        }
      }
      if (!file) throw new Error('Required render service tool unavailable: ' + name);
      file = fs.realpathSync(file);
      // System tools such as macOS grep/stat have legitimate hard-link aliases.
      // Pin their observed bytes and identity; private policy retains nlink=1.
      return Object.freeze({
        name,
        path: file,
        sha256: sha(regular(file, 256 * 1024 * 1024, false)),
      });
    })
  );
}

function privateDirectory(home: string, directory: string): void {
  assertMachinePath(home, directory);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o7777) !== 0o700)
    throw new Error('Render service directory is not private');
}

export function prepareNativeRenderOffer(
  request: RuntimeRequest,
  selection: ActiveInvocationSelection,
  environment: Readonly<Record<string, string>>,
  sessionId: string | null,
  home: string
): NativeRenderOffer | null {
  if (
    selection.configuration !== 'system' ||
    selection.surface !== 'codex' ||
    selection.event !== 'stop'
  )
    return null;
  const selectedIndex = selection.handlers.findIndex(
    (handler) => handler.entry === 'session-log.sh' && handler.kind === 'project-override'
  );
  const selected = selection.handlers[selectedIndex];
  if (!selected) return null;
  const projectState = path.join(home, 'state/projects', sha(selection.canonical));
  const policyFile = path.join(projectState, 'render-service.json');
  try {
    fs.lstatSync(policyFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  assertMachinePath(home, policyFile);
  const policyStat = fs.lstatSync(policyFile);
  if (policyStat.uid !== process.getuid?.() || (policyStat.mode & 0o7777) !== 0o600)
    throw new Error('Render service policy is not private');
  const policyBytes = regular(policyFile, 16 * 1024);
  const policy: unknown = JSON.parse(policyBytes.toString('utf8'));
  if (!sessionId || sessionId === 'unknown')
    throw new Error('Declared render service does not match this supported invocation');
  if (!policy || typeof policy !== 'object' || Array.isArray(policy))
    throw new Error('Invalid render service policy');
  const row = policy as Record<string, unknown>;
  if (
    Object.keys(row).sort().join(',') !==
      'adapter,handler,profile,root,sourceProfileDigest,version' ||
    row.version !== 1 ||
    row.adapter !== SERVICE_ADAPTER ||
    row.profile !== SERVICE_IMAGE_PROFILE ||
    row.root !== selection.canonical ||
    !row.handler ||
    typeof row.handler !== 'object' ||
    Array.isArray(row.handler)
  )
    throw new Error('Invalid render service policy');
  const handler = row.handler as Record<string, unknown>;
  if (
    Object.keys(handler).sort().join(',') !== 'entry,path,sha256' ||
    handler.entry !== selected.entry ||
    handler.path !== selected.path ||
    handler.sha256 !== selected.sha256
  )
    throw new Error('Render service policy does not bind the original handler');
  const imageParent = path.join(projectState, 'service-images');
  privateDirectory(home, imageParent);
  const clientDirectory = fs.realpathSync(__dirname);
  const packageRoot = path.resolve(clientDirectory, '../..');
  // This private config is subsequently checked by the native client against
  // its own executable. A caller PATH entry cannot select the helper.
  const ownerFile = path.join(home, 'state/render-service/config.json');
  assertMachinePath(home, ownerFile);
  const ownerStat = fs.lstatSync(ownerFile);
  if (ownerStat.uid !== process.getuid?.() || (ownerStat.mode & 0o7777) !== 0o600)
    throw new Error('Render owner configuration is not private');
  const owner: unknown = JSON.parse(regular(ownerFile, 65536).toString('utf8'));
  if (!owner || typeof owner !== 'object' || Array.isArray(owner))
    throw new Error('Invalid render owner configuration');
  const nativeExecutable = (owner as Record<string, unknown>).nativeExecutable;
  if (typeof nativeExecutable !== 'string' || !path.isAbsolute(nativeExecutable))
    throw new Error('Render owner has no explicit native executable');
  const prepared = prepareSessionRenderImage({
    selection,
    selectedIndex,
    imageParent,
    environment: request.caller.environment,
    toolchain: resolveRenderTools(environment, clientDirectory, nativeExecutable),
    clientDirectory,
    templateDirectory: path.join(packageRoot, 'templates/hook-packs/runtime/service-image'),
    clientShellPath: path.join(
      packageRoot,
      'templates/hook-packs/shared/lib/session-render-service-client.sh'
    ),
  });
  if (
    row.sourceProfileDigest !== prepared.manifest.originalClosureDigest ||
    sha(regular(policyFile, 16 * 1024)) !== sha(policyBytes)
  )
    throw new Error('Render service source declaration changed or requires explicit renewal');
  // Independently derive the expected selection from the actual selected sources.
  // The native peer receives this separately from the image it must validate.
  const expectedSelection: ServiceImageManifest['selection'] = Object.freeze({
    canonicalProject: selection.canonical,
    surface: 'codex',
    event: 'stop',
    configuration: 'system',
    runtimeDigest: selection.runtimeDigest,
    selectedIndex,
    handlers: Object.freeze(
      selection.handlers.map((item) =>
        Object.freeze({ ...item, args: Object.freeze([...item.args]) })
      )
    ),
    libraries: Object.freeze(
      Object.entries(selection.libraries)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([name, item]) => {
          if (item.kind !== 'shared' && item.kind !== 'surface')
            throw new Error('Unsupported render library tier');
          return Object.freeze({ name, path: item.path, sha256: item.sha256, kind: item.kind });
        })
    ),
  });
  const remainingBudgetMs = request.deadlineEpochMs - Date.now();
  if (
    !Number.isSafeInteger(remainingBudgetMs) ||
    remainingBudgetMs <= 0 ||
    remainingBudgetMs > 120000
  )
    throw new Error('Render service preparation exceeded invocation budget');
  return Object.freeze({
    schema: 'caws.render.owner.offer.v1',
    prepared,
    expectedSelection,
    policySha256: sha(policyBytes),
    checkout: selection.checkout,
    sessionId,
    invocationId: request.id,
    callerEnvironment: request.caller.environment,
    remainingBudgetMs,
  });
}
