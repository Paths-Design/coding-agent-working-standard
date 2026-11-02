/** Resolve externally reviewed CLI pins from the running engine's exact
 * generation. This loader grants no native admission or effect permission.
 */
import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { builtinModules } from 'node:module';
import {
  cliClosureDigest,
  CLI_IDENTITY_LIMITS,
  type CliIdentityFile,
  type ReviewedCliIdentity,
} from './cli-identity';
import type { RuntimeRequest } from './protocol';

const ENGINE = 'native-prefix/node_modules/@paths.design/caws-cli/dist/runtime/engine-entry.js';
const SOURCE = 'native-cli-identity.json',
  DOMAIN = 'native-cli-domain.json';
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
const digest = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const relative = (v: string): boolean =>
  !!v &&
  !path.isAbsolute(v) &&
  !v.includes('\\') &&
  !v.includes('\0') &&
  v.split('/').every((p) => !!p && p !== '.' && p !== '..');
function exact(v: unknown, keys: string[]): asserts v is Record<string, unknown> {
  if (!object(v) || Object.keys(v).sort().join('\0') !== keys.sort().join('\0'))
    throw new Error('Malformed generation CLI identity fields');
}
function pin(v: unknown, maximum: number): asserts v is CliIdentityFile {
  exact(v, ['sha256', 'sizeBytes', 'mode']);
  if (
    !digest(v.sha256) ||
    !Number.isSafeInteger(v.sizeBytes) ||
    (v.sizeBytes as number) < 0 ||
    (v.sizeBytes as number) > maximum ||
    ![0o644, 0o755].includes(v.mode as number)
  )
    throw new Error('Malformed generation CLI identity pin');
}
const signature = (s: Stats): string =>
  [s.dev, s.ino, s.mode, s.nlink, s.size, s.mtimeMs, s.ctimeMs].join(':');
interface Original {
  signal: AbortSignal;
  snapshot: string;
  deadline: number;
  expires: number;
}
const originals = new WeakMap<RuntimeRequest, Original>();

/** engineFilename is supplied by engine-entry's lexical __filename, never by
 * caller JSON, environment, active pointer or the selected PATH installation.
 * The native owner independently admits that engine and all these members.
 */
export async function loadGenerationCliIdentity(
  request: RuntimeRequest,
  signal: AbortSignal,
  engineFilename: string
): Promise<ReviewedCliIdentity | undefined> {
  let owner = originals.get(request);
  if (!owner) {
    const remaining = request.deadlineEpochMs - Date.now();
    if (!Number.isSafeInteger(request.deadlineEpochMs) || remaining <= 0 || remaining > 120_000)
      throw new Error('Generation CLI identity deadline expired or unsupported');
    owner = {
      signal,
      snapshot: JSON.stringify(request),
      deadline: request.deadlineEpochMs,
      expires: performance.now() + remaining,
    };
    originals.set(request, owner);
  }
  const original = owner;
  const check = (): void => {
    if (signal !== original.signal || JSON.stringify(request) !== original.snapshot)
      throw new Error('Generation CLI identity original replaced');
    if (signal.aborted) throw new Error('Generation CLI identity cancelled');
    if (Date.now() >= original.deadline || performance.now() >= original.expires)
      throw new Error('Generation CLI identity deadline expired');
  };
  const io = async <T>(operation: () => Promise<T>): Promise<T> => {
    check();
    const value = await operation();
    check();
    return value;
  };
  check();
  if (!path.isAbsolute(engineFilename) || !engineFilename.endsWith('/' + ENGINE)) return undefined;
  const root = engineFilename.slice(0, -ENGINE.length - 1);
  if (
    !digest(request.runtimeDigest) ||
    path.basename(root) !== request.runtimeDigest ||
    path.resolve(root) !== root ||
    (await io(() => fs.realpath(root))) !== root
  )
    throw new Error('Generation CLI identity location mismatch');
  const rows = new Map<string, string>();
  const remember = (name: string, stat: Stats): void => {
    const now = signature(stat),
      before = rows.get(name);
    if (before !== undefined && before !== now) throw new Error('Generation CLI identity changed');
    rows.set(name, now);
  };
  const anchors = async (name: string): Promise<void> => {
    if (!relative(name)) throw new Error('Generation CLI identity path escaped');
    let current = path.dirname(path.join(root, name));
    while (current.startsWith(root + path.sep) || current === root) {
      const stat = await io(() => fs.lstat(current));
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        (stat.mode & 0o7022) !== 0 ||
        (await io(() => fs.realpath(current))) !== current
      )
        throw new Error('Unsafe generation CLI identity directory');
      remember(current, stat);
      if (current === root) break;
      current = path.dirname(current);
    }
  };
  const read = async (
    name: string,
    expected: string | undefined,
    maximum: number,
    mode = 0o644
  ): Promise<Buffer> => {
    await anchors(name);
    const file = path.join(root, name),
      before = await io(() => fs.lstat(file));
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      (before.mode & 0o7777) !== mode ||
      before.size < 1 ||
      before.size > maximum
    )
      throw new Error('Unsafe generation CLI identity file');
    remember(file, before);
    // Opening owns the descriptor before a post-open cancellation can throw.
    check();
    const handle = await fs.open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    try {
      check();
      if (signature(await io(() => handle.stat())) !== signature(before))
        throw new Error('Generation CLI identity replaced before read');
      const bytes = Buffer.alloc(before.size),
        extra = Buffer.alloc(1);
      let offset = 0;
      while (offset < bytes.length) {
        const next = await io(() =>
          handle.read(bytes, offset, Math.min(64 * 1024, bytes.length - offset), offset)
        );
        if (!next.bytesRead) throw new Error('Generation CLI identity truncated');
        offset += next.bytesRead;
      }
      if (
        (await io(() => handle.read(extra, 0, 1, offset))).bytesRead ||
        signature(await io(() => handle.stat())) !== signature(before) ||
        signature(await io(() => fs.lstat(file))) !== signature(before) ||
        (await io(() => fs.realpath(file))) !== file ||
        (expected && hash(bytes) !== expected)
      )
        throw new Error('Generation CLI identity content changed');
      return bytes;
    } finally {
      await handle.close();
    }
  };
  const manifestBytes = await read('manifest.json', request.runtimeDigest, 8 * 1024 * 1024);
  const manifest: unknown = JSON.parse(manifestBytes.toString('utf8'));
  if (
    !object(manifest) ||
    Object.keys(manifest).length > 8192 ||
    Object.entries(manifest).some(([name, value]) => !relative(name) || !digest(value))
  )
    throw new Error('Malformed generation CLI identity manifest');
  const member = async (name: string, maximum: number, mode = 0o644): Promise<Buffer> => {
    const expected = manifest[name];
    if (!digest(expected)) throw new Error('Generation CLI identity member was not admitted');
    return read(name, expected, maximum, mode);
  };
  if (!Object.hasOwn(manifest, SOURCE) && !Object.hasOwn(manifest, DOMAIN)) {
    // Undeclared planted policy is not the absence/compatibility case.
    for (const name of [SOURCE, DOMAIN]) {
      try {
        await io(() => fs.lstat(path.join(root, name)));
      } catch (error) {
        check();
        if (object(error) && error.code === 'ENOENT') continue;
        throw error;
      }
      throw new Error('Untracked generation CLI identity member');
    }
    check();
    return undefined;
  }
  const modes: unknown = JSON.parse(
    (await member('native-modes.json', 8 * 1024 * 1024)).toString('utf8')
  );
  if (
    !object(modes) ||
    Object.keys(modes).sort().join('\0') !== Object.keys(manifest).sort().join('\0') ||
    Object.values(modes).some((mode) => mode !== 0o644 && mode !== 0o755)
  )
    throw new Error('Generation CLI identity mode inventory mismatch');
  const entry: unknown = JSON.parse(
    (await member('native-entry.json', 64 * 1024)).toString('utf8')
  );
  if (
    !object(entry) ||
    entry.schema !== 'caws.runtime.native-entry.v1' ||
    entry.engineEntry !== ENGINE ||
    entry.nodeExecutable !== 'native/node' ||
    path.join(root, ENGINE) !== engineFilename ||
    process.execPath !== path.join(root, 'native/node')
  )
    throw new Error('Generation CLI identity running entry mismatch');
  await member(ENGINE, CLI_IDENTITY_LIMITS.fileBytes, modes[ENGINE] as number);
  const value: unknown = JSON.parse(
    (await member(SOURCE, CLI_IDENTITY_LIMITS.fileBytes)).toString('utf8')
  );
  exact(value, ['schema', 'prefixRoot', 'files', 'packages', 'omissions', 'node', 'domain']);
  if (
    value.schema !== 'caws.runtime.cli-identity-source.v1' ||
    value.prefixRoot !== 'native-prefix' ||
    !object(value.files) ||
    !object(value.packages) ||
    !object(value.omissions)
  )
    throw new Error('Malformed generation CLI identity source');
  const sourcePin = (v: unknown, name: string, maximum: number): CliIdentityFile => {
    exact(v, ['path', 'sha256', 'sizeBytes', 'mode']);
    if (v.path !== name) throw new Error('Generation CLI identity source path mismatch');
    const filePin = { sha256: v.sha256, sizeBytes: v.sizeBytes, mode: v.mode };
    pin(filePin, maximum);
    if (manifest[name] !== filePin.sha256 || modes[name] !== filePin.mode)
      throw new Error('Generation CLI identity source pin mismatch');
    return filePin;
  };
  const node = sourcePin(value.node, 'native/node', CLI_IDENTITY_LIMITS.nodeBytes);
  const domain = sourcePin(value.domain, DOMAIN, CLI_IDENTITY_LIMITS.fileBytes);
  if (node.mode !== 0o755 || domain.mode !== 0o644 || modes[SOURCE] !== 0o644)
    throw new Error('Generation CLI identity source mode mismatch');
  const expected = Object.keys(manifest)
    .filter(
      (name) =>
        name.startsWith('native-prefix/node_modules/') &&
        !(
          path.posix.basename(name) === '.package-lock.json' &&
          path.posix.basename(path.posix.dirname(name)) === 'node_modules'
        )
    )
    .map((name) => name.slice('native-prefix/'.length))
    .sort();
  if (
    expected.length < 1 ||
    expected.length > CLI_IDENTITY_LIMITS.files ||
    expected.join('\0') !== Object.keys(value.files).sort().join('\0')
  )
    throw new Error('Generation CLI identity closure inventory mismatch');
  let closureBytes = node.sizeBytes;
  for (const [name, filePin] of Object.entries(value.files)) {
    pin(filePin, CLI_IDENTITY_LIMITS.fileBytes);
    closureBytes += filePin.sizeBytes;
    if (closureBytes > CLI_IDENTITY_LIMITS.totalBytes)
      throw new Error('Generation CLI identity closure byte bound exceeded');
    if (
      manifest['native-prefix/' + name] !== filePin.sha256 ||
      modes['native-prefix/' + name] !== filePin.mode
    )
      throw new Error('Generation CLI identity closure pin mismatch');
  }
  if (
    !Object.keys(value.packages).length ||
    Object.keys(value.packages).length > CLI_IDENTITY_LIMITS.files ||
    Object.keys(value.omissions).length > CLI_IDENTITY_LIMITS.files
  )
    throw new Error('Generation CLI identity package bound exceeded');
  for (const [name, pkg] of Object.entries(value.packages)) {
    exact(pkg, ['name', 'version']);
    if (
      !relative(name) ||
      !Object.hasOwn(value.files, name + '/package.json') ||
      typeof pkg.name !== 'string' ||
      !pkg.name ||
      pkg.name.length > 256 ||
      typeof pkg.version !== 'string' ||
      !pkg.version ||
      pkg.version.length > 256
    )
      throw new Error('Malformed generation CLI package review');
  }
  if (
    Object.entries(value.omissions).some(
      ([key, reason]) =>
        key.length > 8192 || typeof reason !== 'string' || !reason.trim() || reason.length > 1024
    )
  )
    throw new Error('Malformed generation CLI omission');
  const reviewed: ReviewedCliIdentity = {
    prefixRoot: path.join(root, 'native-prefix'),
    files: value.files as unknown as ReviewedCliIdentity['files'],
    packages: value.packages as unknown as ReviewedCliIdentity['packages'],
    omissions: value.omissions as unknown as ReviewedCliIdentity['omissions'],
    node: { ...node, path: path.join(root, 'native/node') },
    domain: { ...domain, path: path.join(root, DOMAIN) },
  };
  const domainBytes = await member(DOMAIN, CLI_IDENTITY_LIMITS.fileBytes);
  if (domainBytes.length !== domain.sizeBytes)
    throw new Error('Generation CLI identity domain size mismatch');
  const parsed: unknown = JSON.parse(domainBytes.toString('utf8'));
  if (
    !object(parsed) ||
    parsed.schema !== 'caws.cli.agents-stop-domain.v1' ||
    parsed.operation !== 'agents-stop-explicit-session-opencode' ||
    parsed.closureSha256 !== cliClosureDigest(reviewed)
  )
    throw new Error('Generation CLI identity domain closure mismatch');
  exact(parsed, ['schema', 'operation', 'closureSha256', 'importers', 'dormantSites']);
  if (
    !Array.isArray(parsed.importers) ||
    !parsed.importers.length ||
    parsed.importers.length > CLI_IDENTITY_LIMITS.files ||
    !Array.isArray(parsed.dormantSites) ||
    parsed.dormantSites.length > 16
  )
    throw new Error('Malformed generation CLI import domain');
  const builtins = new Set([...builtinModules, ...builtinModules.map((name) => 'node:' + name)]);
  const importers = new Map<string, string[]>();
  let calls = 0;
  for (const row of parsed.importers as unknown[]) {
    exact(row, ['path', 'sha256', 'requests']);
    if (
      typeof row.path !== 'string' ||
      !Object.hasOwn(reviewed.files, row.path) ||
      reviewed.files[row.path]!.sha256 !== row.sha256 ||
      importers.has(row.path) ||
      !Array.isArray(row.requests)
    )
      throw new Error('Malformed generation CLI importer');
    const targets: string[] = [],
      seen = new Set<string>();
    for (const call of row.requests as unknown[]) {
      exact(call, ['line', 'request', 'target']);
      if (
        ++calls > CLI_IDENTITY_LIMITS.requests ||
        !Number.isSafeInteger(call.line) ||
        (call.line as number) < 1 ||
        typeof call.request !== 'string' ||
        !call.request ||
        call.request.length > 4096 ||
        typeof call.target !== 'string' ||
        (call.target === 'builtin'
          ? !builtins.has(call.request)
          : !Object.hasOwn(reviewed.files, call.target))
      )
        throw new Error('Malformed generation CLI import request');
      const key = String(call.line) + ':' + call.request;
      if (seen.has(key)) throw new Error('Duplicate generation CLI import request');
      seen.add(key);
      targets.push(call.target);
    }
    importers.set(row.path, targets);
  }
  const reached = new Set<string>(),
    pending = ['node_modules/@paths.design/caws-cli/dist/index.js'];
  while (pending.length) {
    const importer = pending.pop()!;
    if (reached.has(importer)) continue;
    reached.add(importer);
    const edges = importers.get(importer);
    if (!edges) throw new Error('Incomplete generation CLI importer graph');
    for (const target of edges)
      if (target !== 'builtin' && /\.(?:js|cjs|mjs)$/.test(target)) pending.push(target);
  }
  if (reached.size !== importers.size) throw new Error('Extraneous generation CLI importer');
  const kinds: Record<string, string> = {
    'legacy-provenance': 'node_modules/@paths.design/caws-cli/dist/config/index.js',
    'legacy-language-support': 'node_modules/@paths.design/caws-cli/dist/config/index.js',
    'adapter-yaml-resolution': 'node_modules/@paths.design/caws-cli/dist/init/machine-adapters.js',
    'ajv-code-generation': 'node_modules/ajv/dist/compile/index.js',
  };
  const texts = new Map<string, string[]>(),
    dispositions = new Set<string>();
  const lines = async (name: string): Promise<string[]> => {
    const saved = texts.get(name);
    if (saved) return saved;
    const filePin = reviewed.files[name]!;
    const data = await member('native-prefix/' + name, CLI_IDENTITY_LIMITS.fileBytes, filePin.mode);
    if (data.length !== filePin.sizeBytes) throw new Error('Generation CLI proof size mismatch');
    const captured = data.toString('utf8').split('\n');
    texts.set(name, captured);
    return captured;
  };
  for (const site of parsed.dormantSites as unknown[]) {
    exact(site, ['path', 'line', 'kind', 'sourceLineSha256', 'proof']);
    if (
      typeof site.kind !== 'string' ||
      !Object.hasOwn(kinds, site.kind) ||
      site.path !== kinds[site.kind] ||
      dispositions.has(site.kind) ||
      !importers.has(site.path as string) ||
      !Number.isSafeInteger(site.line) ||
      (site.line as number) < 1 ||
      !digest(site.sourceLineSha256) ||
      !Array.isArray(site.proof) ||
      !site.proof.length ||
      site.proof.length > 16
    )
      throw new Error('Malformed generation CLI dormant review');
    const line = (await lines(site.path as string))[(site.line as number) - 1];
    if (line === undefined || hash(Buffer.from(line)) !== site.sourceLineSha256)
      throw new Error('Generation CLI dormant coordinate changed');
    dispositions.add(site.kind);
    for (const proof of site.proof as unknown[]) {
      exact(proof, ['path', 'sha256', 'line']);
      if (
        typeof proof.path !== 'string' ||
        !importers.has(proof.path) ||
        reviewed.files[proof.path]!.sha256 !== proof.sha256 ||
        !Number.isSafeInteger(proof.line) ||
        (proof.line as number) < 1 ||
        (await lines(proof.path))[(proof.line as number) - 1] === undefined
      )
        throw new Error('Malformed generation CLI dormant proof');
    }
  }
  for (const [kind, importer] of Object.entries(kinds))
    if (importers.has(importer) && !dispositions.has(kind))
      throw new Error('Missing generation CLI dormant review');
  // Close every observed path/directory bracket before returning the fixed pins.
  for (const [file, before] of rows)
    if (
      signature(await io(() => fs.lstat(file))) !== before ||
      (await io(() => fs.realpath(file))) !== file
    )
      throw new Error('Generation CLI identity changed after capture');
  check();
  return reviewed;
}
