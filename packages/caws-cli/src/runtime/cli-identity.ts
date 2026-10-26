/** Fixed stock OpenCode agents-stop content observation. The native owner must
 * supply the reviewed domain-file pin; this helper cannot approve generated
 * request tables, establish semantic parity, or grant runtime admission.
 */
import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import * as fs from 'node:fs/promises';
import { builtinModules, createRequire } from 'node:module';
import { basename, delimiter, dirname, isAbsolute, join, posix, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { RuntimeRequest } from './protocol';
import { cliClosureDigest } from './cli-identity-format';
export { cliClosureDigest } from './cli-identity-format';

export const CLI_IDENTITY_LIMITS = Object.freeze({
  files: 4096,
  directories: 1024,
  fileBytes: 4 * 1024 * 1024,
  nodeBytes: 160 * 1024 * 1024,
  totalBytes: 256 * 1024 * 1024,
  chunkBytes: 64 * 1024,
  pathBytes: 4096,
  requests: 8192,
});
export interface CliIdentityFile {
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly mode: 0o644 | 0o755;
}
export interface CliIdentitySource extends CliIdentityFile {
  readonly path: string;
}
export interface ReviewedCliIdentity {
  readonly prefixRoot: string;
  /** Complete native-reviewed package-file inventory, excluding npm provenance. */
  readonly files: Readonly<Record<string, CliIdentityFile>>;
  readonly packages: Readonly<Record<string, { readonly name: string; readonly version: string }>>;
  readonly omissions: Readonly<Record<string, string>>;
  readonly node: CliIdentitySource;
  /** A separately reviewed generation member, never a selected-CLI self-report. */
  readonly domain: CliIdentitySource;
}
export interface CliIdentityInput {
  readonly reviewed: ReviewedCliIdentity;
  readonly request: RuntimeRequest;
  readonly signal: AbortSignal;
}
declare const matchedCliIdentity: unique symbol;
export interface MatchedCliIdentityReceipt {
  readonly [matchedCliIdentity]: true;
  readonly selectedEntry: string;
  readonly selectedNode: string;
  assertOwner(request: RuntimeRequest, originalSignal: AbortSignal): void;
  revalidate(): Promise<void>;
}
interface Original {
  readonly request: RuntimeRequest;
  readonly requestSnapshot: string;
  readonly signal: AbortSignal;
  readonly reviewed: ReviewedCliIdentity;
  readonly reviewedSnapshot: string;
  readonly expiresMonotonicMs: number;
  readonly deadlineEpochMs: number;
}
interface OwnedInput extends CliIdentityInput {
  readonly environment: Readonly<Record<string, string>>;
  readonly cwd: string;
  readonly deadlineEpochMs: number;
  readonly original: Original;
}
interface ReceiptState {
  readonly input: OwnedInput;
  readonly observed: string;
}
export interface AgentsStopDomain {
  readonly schema: 'caws.cli.agents-stop-domain.v1';
  readonly operation: 'agents-stop-explicit-session-opencode';
  readonly closureSha256: string;
  readonly importers: ReadonlyArray<{
    readonly path: string;
    readonly sha256: string;
    readonly requests: ReadonlyArray<{
      readonly line: number;
      readonly request: string;
      readonly target: string;
    }>;
  }>;
  /** Reviewed dormant sites, not runtime-discovered exceptions. Reachable
   * dynamic/member/aliased loaders or code generation are outside this profile.
   */
  readonly dormantSites: ReadonlyArray<{
    readonly path: string;
    readonly line: number;
    readonly kind:
      | 'legacy-provenance'
      | 'legacy-language-support'
      | 'adapter-yaml-resolution'
      | 'ajv-code-generation';
    readonly sourceLineSha256: string;
    readonly proof: ReadonlyArray<{
      readonly path: string;
      readonly sha256: string;
      readonly line: number;
    }>;
  }>;
}
export type CliIdentityResult =
  | { readonly status: 'declined'; readonly reason: string }
  | { readonly status: 'matched'; readonly receipt: MatchedCliIdentityReceipt };
const CLI = 'node_modules/@paths.design/caws-cli',
  ENTRY = `${CLI}/dist/index.js`;
const builtins = new Set([...builtinModules, ...builtinModules.map((s) => `node:${s}`)]);
const receipts = new WeakMap<object, ReceiptState>();
const originals = new WeakMap<RuntimeRequest, Original>();
const hash = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex');
function fail(reason: string): never {
  throw new Error(reason);
}
const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
const relative = (p: string): boolean =>
  typeof p === 'string' &&
  p.length > 0 &&
  Buffer.byteLength(p) <= CLI_IDENTITY_LIMITS.pathBytes &&
  !isAbsolute(p) &&
  !p.includes('\\') &&
  !p.includes('\0') &&
  p.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
const packageRoot = (p: string): boolean =>
  /^(?:node_modules\/(?:@[^/]+\/)?[^/]+\/)*node_modules\/(?:@[^/]+\/)?[^/]+$/.test(p);
const signature = (s: Stats): string =>
  [s.dev, s.ino, s.mode, s.nlink, s.size, s.mtimeMs, s.ctimeMs].join(':');

function checkOriginal(
  original: Original,
  request = original.request,
  signal = original.signal,
  full = false
): void {
  if (
    request !== original.request ||
    signal !== original.signal ||
    originals.get(request) !== original
  )
    fail('CLI identity receipt belongs to another original request');
  if (signal.aborted) fail('CLI identity cancelled');
  if (Date.now() >= original.deadlineEpochMs || performance.now() >= original.expiresMonotonicMs)
    fail('CLI identity deadline expired');
  if (
    full &&
    (JSON.stringify(request) !== original.requestSnapshot ||
      JSON.stringify(original.reviewed) !== original.reviewedSnapshot)
  )
    fail('CLI identity original request or reviewed generation changed');
}

/** Consumers must call this module-owned assertion, rather than trust methods on
 * a structurally compatible object. This proves comparator provenance only;
 * native generation admission and source-review authority remain separate.
 */
export function assertMatchedCliIdentityReceipt(
  value: unknown,
  request: RuntimeRequest,
  originalSignal: AbortSignal
): asserts value is MatchedCliIdentityReceipt {
  const state = object(value) ? receipts.get(value) : undefined;
  if (!state) fail('CLI identity receipt lacks comparator provenance');
  checkOriginal(state.input.original, request, originalSignal, true);
}

function original(input: CliIdentityInput): Original {
  const prior = originals.get(input.request);
  if (prior) {
    if (input.reviewed !== prior.reviewed) fail('CLI identity reviewed generation replaced');
    checkOriginal(prior, input.request, input.signal, true);
    return prior;
  }
  const request = input.request;
  if (
    !object(request) ||
    request.schema !== 'caws.runtime.request.v1' ||
    request.surface !== 'opencode' ||
    request.event !== 'stop' ||
    request.configuration !== 'system' ||
    !request.id ||
    !/^[a-f0-9]{64}$/.test(request.runtimeDigest) ||
    !object(request.caller) ||
    typeof request.inputJson !== 'string' ||
    !Number.isSafeInteger(request.deadlineEpochMs)
  )
    fail('Unsupported CLI identity original request');
  const monotonic = performance.now(),
    remaining = request.deadlineEpochMs - Date.now();
  if (remaining <= 0 || remaining > 120_000) fail('CLI identity deadline expired or unsupported');
  const state: Original = {
    request,
    signal: input.signal,
    reviewed: input.reviewed,
    requestSnapshot: JSON.stringify(request),
    reviewedSnapshot: JSON.stringify(input.reviewed),
    deadlineEpochMs: request.deadlineEpochMs,
    expiresMonotonicMs: monotonic + remaining,
  };
  originals.set(request, state);
  checkOriginal(state);
  return state;
}

class Capture {
  readonly rows = new Map<string, string>();
  readonly texts = new Map<string, string>();
  private bytes = 0;
  constructor(readonly input: OwnedInput) {}
  check(): void {
    checkOriginal(this.input.original);
  }
  async io<T>(op: () => Promise<T>): Promise<T> {
    this.check();
    const result = await op();
    this.check();
    return result;
  }
  async stat(path: string): Promise<Stats> {
    if (!isAbsolute(path) || Buffer.byteLength(path) > CLI_IDENTITY_LIMITS.pathBytes)
      fail('Unsupported CLI identity path');
    const stat = await this.io(() => fs.lstat(path)),
      key = `stat:${path}`,
      before = this.rows.get(key);
    if (before !== undefined && before !== signature(stat)) fail('CLI identity source changed');
    this.rows.set(key, signature(stat));
    return stat;
  }
  async canonical(path: string): Promise<void> {
    if ((await this.io(() => fs.realpath(path))) !== path) fail('Redirected CLI identity source');
  }
  async file(
    path: string,
    pin?: CliIdentityFile,
    binary = false,
    keep = false
  ): Promise<string | undefined> {
    await this.canonical(path);
    const before = await this.stat(path);
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size > (binary ? CLI_IDENTITY_LIMITS.nodeBytes : CLI_IDENTITY_LIMITS.fileBytes) ||
      (before.mode & 0o7022) !== 0
    )
      fail('Unsafe or oversized CLI identity file');
    if (pin && (before.size !== pin.sizeBytes || (before.mode & 0o777) !== pin.mode))
      fail('CLI identity size or mode mismatch');
    this.bytes += before.size;
    if (this.bytes > CLI_IDENTITY_LIMITS.totalBytes * 3)
      fail('CLI identity capture byte budget exceeded');
    this.check();
    const handle = await fs.open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    try {
      this.check();
      if (signature(await this.io(() => handle.stat())) !== signature(before))
        fail('CLI identity replaced before read');
      const digest = createHash('sha256'),
        buffer = Buffer.alloc(Math.min(CLI_IDENTITY_LIMITS.chunkBytes, before.size + 1)),
        chunks: Buffer[] = [];
      let offset = 0;
      while (offset < before.size) {
        const read = await this.io(() =>
          handle.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset)
        );
        if (!read.bytesRead) fail('CLI identity truncated source');
        digest.update(buffer.subarray(0, read.bytesRead));
        if (keep) chunks.push(Buffer.from(buffer.subarray(0, read.bytesRead)));
        offset += read.bytesRead;
      }
      const extra = await this.io(() => handle.read(buffer, 0, 1, offset));
      if (
        extra.bytesRead ||
        signature(await this.io(() => handle.stat())) !== signature(before) ||
        signature(await this.stat(path)) !== signature(before)
      )
        fail('CLI identity changed while read');
      await this.canonical(path);
      if (pin && digest.digest('hex') !== pin.sha256) fail('CLI identity content mismatch');
      const text = keep ? Buffer.concat(chunks).toString('utf8') : undefined;
      if (text !== undefined) this.texts.set(path, text);
      return text;
    } finally {
      await handle.close();
    }
  }
  async unchanged(): Promise<void> {
    for (const [key, value] of this.rows) {
      this.check();
      if (
        key.startsWith('stat:') &&
        signature(await this.io(() => fs.lstat(key.slice(5)))) !== value
      )
        fail('CLI identity changed after capture');
      if (key.startsWith('absent:')) await this.absent(key.slice(7));
    }
  }
  async absent(path: string): Promise<void> {
    this.check();
    try {
      await this.io(() => fs.lstat(path));
    } catch (error) {
      this.check();
      if (object(error) && error.code === 'ENOENT') {
        this.rows.set(`absent:${path}`, 'absent');
        return;
      }
      throw error;
    }
    fail('Previously absent CLI lookup path appeared');
  }
  async lookupDirectory(path: string): Promise<void> {
    try {
      await this.stat(path);
    } catch (error) {
      if (object(error) && error.code === 'ENOENT') {
        await this.absent(path);
        return;
      }
      throw error;
    }
    await this.canonical(path);
  }
}
function own(source: CliIdentityInput): OwnedInput {
  const owner = original(source);
  const input = {
    ...source,
    environment: source.request.caller.environment,
    cwd: source.request.caller.cwd,
    deadlineEpochMs: source.request.deadlineEpochMs,
  };
  if (
    !Number.isSafeInteger(input.deadlineEpochMs) ||
    process.platform === 'win32' ||
    !isAbsolute(input.cwd)
  )
    fail('Unsupported CLI identity profile');
  const pin = (v: CliIdentityFile, maximum: number): void => {
    if (
      !/^[a-f0-9]{64}$/.test(v.sha256) ||
      !Number.isSafeInteger(v.sizeBytes) ||
      v.sizeBytes < 0 ||
      v.sizeBytes > maximum ||
      ![0o644, 0o755].includes(v.mode)
    )
      fail('Invalid CLI identity pin');
  };
  for (const path of [
    input.cwd,
    input.reviewed.prefixRoot,
    input.reviewed.node.path,
    input.reviewed.domain.path,
  ])
    if (!isAbsolute(path) || Buffer.byteLength(path) > CLI_IDENTITY_LIMITS.pathBytes)
      fail('Unsupported identity source path');
  if (
    Object.keys(input.environment).length > 512 ||
    Buffer.byteLength(JSON.stringify(input.environment)) > 128 * 1024
  )
    fail('CLI identity environment bound exceeded');
  const files = Object.entries(input.reviewed.files),
    packages = Object.entries(input.reviewed.packages),
    omissions = Object.entries(input.reviewed.omissions);
  if (
    !files.length ||
    files.length > CLI_IDENTITY_LIMITS.files ||
    !packages.length ||
    packages.length > CLI_IDENTITY_LIMITS.files ||
    omissions.length > CLI_IDENTITY_LIMITS.files
  )
    fail('CLI identity inventory bound exceeded');
  pin(input.reviewed.node, CLI_IDENTITY_LIMITS.nodeBytes);
  pin(input.reviewed.domain, CLI_IDENTITY_LIMITS.fileBytes);
  let bytes = input.reviewed.node.sizeBytes;
  for (const [path, value] of files) {
    if (!relative(path) || !path.startsWith('node_modules/') || path.split('/').includes('.bin'))
      fail('Invalid reviewed CLI member');
    pin(value, CLI_IDENTITY_LIMITS.fileBytes);
    bytes += value.sizeBytes;
  }
  if (bytes > CLI_IDENTITY_LIMITS.totalBytes || input.reviewed.files[ENTRY]?.mode !== 0o755)
    fail('CLI identity closure bound or entry mismatch');
  for (const [path, pkg] of packages)
    if (
      !relative(path) ||
      !packageRoot(path) ||
      !input.reviewed.files[`${path}/package.json`] ||
      !pkg.name ||
      pkg.name.length > 256 ||
      !pkg.version ||
      pkg.version.length > 256
    )
      fail('Invalid CLI package boundary');
  if (
    omissions.some(
      ([key, value]) => key.length > 8192 || typeof value !== 'string' || value.length > 1024
    )
  )
    fail('Invalid CLI omission');
  return {
    ...input,
    original: owner,
    environment: Object.freeze({ ...input.environment }),
    reviewed: JSON.parse(owner.reviewedSnapshot) as ReviewedCliIdentity,
  };
}
function environment(input: OwnedInput): string[] {
  const paths = input.environment.PATH?.split(delimiter);
  if (
    !paths?.length ||
    paths.length > 128 ||
    paths.some((p) => !isAbsolute(p) || Buffer.byteLength(p) > CLI_IDENTITY_LIMITS.pathBytes)
  )
    fail('Missing or unsupported CLI PATH');
  if (
    (input.environment.CAWS_BIN && input.environment.CAWS_BIN !== 'caws') ||
    Object.entries(input.environment).some(
      ([key, value]) =>
        value &&
        (/^(?:NODE_OPTIONS|NODE_PATH|BASH_ENV|CAWS_PRIOR_BASH_ENV|ENV|CDPATH|SHELLOPTS|BASHOPTS|BASH_XTRACEFD|PS4)$/.test(
          key
        ) ||
          /^(?:LD_|DYLD_|BASH_FUNC_|_(?:CAWS|HOOK).*LOADED)/.test(key))
    )
  )
    fail('Custom CLI routing or startup');
  if (input.environment.HOME && !isAbsolute(input.environment.HOME)) fail('Unsupported Node HOME');
  return paths!;
}
async function selected(c: Capture, paths: readonly string[], name: string): Promise<string> {
  for (const dir of paths) {
    await c.lookupDirectory(dir);
    const path = join(dir, name);
    let stat: Stats;
    try {
      stat = await c.io(() => fs.stat(path));
    } catch (error) {
      if (object(error) && ['ENOENT', 'ENOTDIR'].includes(String(error.code))) {
        await c.absent(path);
        continue;
      }
      throw error;
    }
    if (!stat.isFile() || (stat.mode & 0o111) === 0) {
      await c.stat(path);
      continue;
    }
    await c.io(() => fs.access(path, constants.X_OK));
    await c.stat(path);
    return c.io(() => fs.realpath(path));
  }
  return fail('Selected CLI executable unavailable');
}
function dependency(
  importer: string,
  name: string,
  packages: ReviewedCliIdentity['packages']
): string | undefined {
  if (
    !/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i.test(name) ||
    name.split('/').some((p) => p === '.' || p === '..')
  )
    fail('Unsupported dependency name');
  let cursor = importer;
  for (;;) {
    const target = posix.join(cursor, 'node_modules', name);
    if (posix.basename(cursor) !== 'node_modules' && Object.hasOwn(packages, target)) return target;
    if (cursor === '.') return undefined;
    cursor = posix.dirname(cursor);
  }
}
function graph(
  r: ReviewedCliIdentity,
  manifests: Map<string, Record<string, unknown>>
): Map<string, string> {
  const bins = new Map<string, string>(),
    edges = new Map<string, Set<string>>(),
    omissions = new Set<string>();
  for (const [root, expected] of Object.entries(r.packages)) {
    const pkg = manifests.get(root);
    if (!pkg || pkg.name !== expected.name || pkg.version !== expected.version)
      fail('CLI package identity mismatch');
    const targets = new Set<string>();
    edges.set(root, targets);
    for (const kind of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      const declarations = pkg[kind] ?? {};
      if (!object(declarations)) fail('Invalid dependency declarations');
      for (const [name, range] of Object.entries(declarations)) {
        if (typeof range !== 'string' || !/^[0-9~^<>=*][0-9a-zA-Z*~^<>=|.+ -]*$/.test(range))
          fail('Unsupported dependency declaration');
        const target = dependency(root, name, r.packages);
        if (target) {
          if (r.packages[target]?.name !== name) fail('Dependency identity mismatch');
          targets.add(target);
        } else {
          const optional =
            kind === 'optionalDependencies' ||
            (kind === 'dependencies' &&
              object(pkg.optionalDependencies) &&
              Object.hasOwn(pkg.optionalDependencies, name)) ||
            (kind === 'peerDependencies' &&
              object(pkg.peerDependenciesMeta) &&
              object(pkg.peerDependenciesMeta[name]) &&
              pkg.peerDependenciesMeta[name].optional === true);
          const key = `${root}:${kind}:${name}`;
          if (!optional || !r.omissions[key]?.trim()) fail('Unclosed dependency resolution');
          omissions.add(key);
        }
      }
    }
    const bin =
      typeof pkg.bin === 'string'
        ? { [expected.name.split('/').at(-1)!]: pkg.bin }
        : (pkg.bin ?? {});
    if (!object(bin)) fail('Invalid bin declaration');
    for (const [name, target] of Object.entries(bin)) {
      const clean = typeof target === 'string' ? target.replace(/^\.\//, '') : '';
      if (!relative(name) || name.includes('/') || !relative(clean) || !r.files[`${root}/${clean}`])
        fail('Unreviewed bin target');
      const link = `${root.slice(0, root.lastIndexOf('node_modules/') + 'node_modules'.length)}/.bin/${name}`;
      if (bins.has(link) && bins.get(link) !== `${root}/${clean}`) fail('Ambiguous bin target');
      bins.set(link, `${root}/${clean}`);
    }
  }
  if (Object.keys(r.omissions).some((key) => !omissions.has(key)))
    fail('Unused dependency omission');
  const pending = [CLI],
    reached = new Set<string>();
  while (pending.length) {
    const root = pending.pop()!;
    if (reached.has(root)) continue;
    reached.add(root);
    pending.push(...(edges.get(root) ?? []));
  }
  if (reached.size !== manifests.size || r.packages[CLI]?.name !== '@paths.design/caws-cli')
    fail('Extraneous or missing CLI package');
  return bins;
}
async function prefix(c: Capture, root: string, r: ReviewedCliIdentity): Promise<void> {
  await c.canonical(root);
  const dirs = new Set(['', 'node_modules']),
    found = new Set<string>(),
    manifests = new Map<string, Record<string, unknown>>(),
    links = new Map<string, string>();
  for (const file of Object.keys(r.files)) {
    let dir = posix.dirname(file);
    while (dir !== '.') {
      dirs.add(dir);
      dir = posix.dirname(dir);
    }
  }
  if (dirs.size > CLI_IDENTITY_LIMITS.directories) fail('CLI directory inventory bound exceeded');
  let entries = 0;
  const visit = async (rel: string): Promise<void> => {
    const path = join(root, rel),
      stat = await c.stat(path);
    if (stat.isDirectory()) {
      if (!dirs.has(rel) && rel !== 'node_modules/.bin' && !rel.endsWith('/node_modules/.bin'))
        fail('Unexpected module directory');
      await c.canonical(path);
      c.check();
      const handle = await fs.opendir(path);
      try {
        c.check();
        for (;;) {
          const child = await c.io(() => handle.read());
          if (!child) break;
          if (++entries > CLI_IDENTITY_LIMITS.files + CLI_IDENTITY_LIMITS.directories + 256)
            fail('CLI directory entry bound exceeded');
          await visit(rel ? `${rel}/${child.name}` : child.name);
        }
      } finally {
        await handle.close();
      }
      await c.stat(path);
    } else if (rel.split('/').at(-2) === '.bin') {
      if (!stat.isSymbolicLink()) fail('Unsupported bin artifact');
      links.set(rel, await c.io(() => fs.realpath(path)));
    } else if (
      rel === 'package.json' ||
      rel === 'package-lock.json' ||
      (basename(rel) === '.package-lock.json' && basename(dirname(rel)) === 'node_modules')
    ) {
      const text = await c.file(path, undefined, false, rel === 'package.json');
      if (rel === 'package.json') {
        const pkg: unknown = JSON.parse(text!);
        if (
          !object(pkg) ||
          !object(pkg.dependencies) ||
          Object.keys(pkg.dependencies).join(',') !== '@paths.design/caws-cli'
        )
          fail('Unsupported standalone provenance');
      }
    } else {
      const pin = r.files[rel];
      if (!pin) fail('Unexpected module file');
      const manifest = basename(rel) === 'package.json' && packageRoot(posix.dirname(rel));
      const text = await c.file(path, pin, false, manifest || /\.(?:js|cjs|mjs)$/.test(rel));
      found.add(rel);
      if (manifest) {
        const pkg: unknown = JSON.parse(text!);
        if (!object(pkg)) fail('Malformed package manifest');
        manifests.set(posix.dirname(rel), pkg);
      }
    }
  };
  await visit('');
  if (
    found.size !== Object.keys(r.files).length ||
    manifests.size !== Object.keys(r.packages).length
  )
    fail('Incomplete CLI inventory');
  const bins = graph(r, manifests);
  for (const [link, target] of links)
    if (!bins.has(link) || join(root, bins.get(link)!) !== target) fail('Redirected bin link');
}
function parseDomain(text: string, r: ReviewedCliIdentity, c: Capture): AgentsStopDomain {
  const d = JSON.parse(text) as AgentsStopDomain;
  if (
    !object(d) ||
    d.schema !== 'caws.cli.agents-stop-domain.v1' ||
    d.operation !== 'agents-stop-explicit-session-opencode' ||
    d.closureSha256 !== cliClosureDigest(r) ||
    !Array.isArray(d.importers) ||
    !d.importers.length ||
    d.importers.length > CLI_IDENTITY_LIMITS.files ||
    !Array.isArray(d.dormantSites) ||
    d.dormantSites.length > 16
  )
    fail('Unreviewed agents-stop domain');
  const importers = new Map<string, AgentsStopDomain['importers'][number]>();
  let requests = 0;
  for (const row of d.importers) {
    if (
      !relative(row.path) ||
      r.files[row.path]?.sha256 !== row.sha256 ||
      importers.has(row.path) ||
      !Array.isArray(row.requests)
    )
      fail('Domain importer pin mismatch');
    importers.set(row.path, row);
    const calls = new Set<string>();
    for (const call of row.requests) {
      c.check();
      if (
        ++requests > CLI_IDENTITY_LIMITS.requests ||
        !Number.isSafeInteger(call.line) ||
        call.line < 1 ||
        typeof call.request !== 'string' ||
        !call.request ||
        call.request.length > 4096
      )
        fail('Domain request bound exceeded');
      const key = `${call.line}:${call.request}`;
      if (calls.has(key)) fail('Duplicate domain request');
      calls.add(key);
      if (
        call.target === 'builtin'
          ? !builtins.has(call.request)
          : !relative(call.target) || !r.files[call.target]
      )
        fail('Unreviewed domain target');
    }
  }
  const reached = new Set<string>(),
    pending = [ENTRY];
  while (pending.length) {
    const path = pending.pop()!;
    if (reached.has(path)) continue;
    reached.add(path);
    const row = importers.get(path);
    if (!row) fail('Incomplete reviewed importer graph');
    for (const call of row.requests)
      if (call.target !== 'builtin' && /\.(?:js|cjs|mjs)$/.test(call.target))
        pending.push(call.target);
  }
  if (reached.size !== importers.size) fail('Extraneous domain importer');
  const kinds: Record<AgentsStopDomain['dormantSites'][number]['kind'], string> = {
    'legacy-provenance': `${CLI}/dist/config/index.js`,
    'legacy-language-support': `${CLI}/dist/config/index.js`,
    'adapter-yaml-resolution': `${CLI}/dist/init/machine-adapters.js`,
    'ajv-code-generation': 'node_modules/ajv/dist/compile/index.js',
  };
  const seen = new Set<string>();
  for (const site of d.dormantSites) {
    const expected =
      typeof site.kind === 'string' && Object.hasOwn(kinds, site.kind)
        ? kinds[site.kind as keyof typeof kinds]
        : undefined;
    if (
      expected !== site.path ||
      !importers.has(site.path) ||
      !Number.isSafeInteger(site.line) ||
      site.line < 1 ||
      seen.has(site.kind) ||
      !Array.isArray(site.proof) ||
      !site.proof.length ||
      site.proof.length > 16
    )
      fail('Unsupported dynamic loader disposition');
    seen.add(site.kind);
    const line = c.texts.get(join(r.prefixRoot, site.path))?.split('\n')[site.line - 1];
    if (line === undefined || hash(Buffer.from(line)) !== site.sourceLineSha256)
      fail('Dormant loader coordinate changed');
    for (const proof of site.proof)
      if (
        !importers.has(proof.path) ||
        r.files[proof.path]?.sha256 !== proof.sha256 ||
        !Number.isSafeInteger(proof.line) ||
        proof.line < 1 ||
        c.texts.get(join(r.prefixRoot, proof.path))?.split('\n')[proof.line - 1] === undefined
      )
        fail('Dormant loader proof pin mismatch');
  }
  // All currently reviewed loader mechanisms must have an explicit disposition;
  // source changes invalidate the aggregate closure and require a fresh review.
  for (const [kind, path] of Object.entries(kinds))
    if (importers.has(path) && !seen.has(kind)) fail('Missing dormant loader review');
  return d;
}
async function resolveDomain(c: Capture, root: string, domain: AgentsStopDomain): Promise<void> {
  for (const row of domain.importers) {
    const req = createRequire(join(root, row.path));
    for (const call of row.requests) {
      c.check();
      if (call.target === 'builtin') continue;
      const result = req.resolve(call.request);
      c.check();
      if (
        !isAbsolute(result) ||
        (await c.io(() => fs.realpath(result))) !== join(root, call.target)
      )
        fail('CLI import resolution diverged');
    }
  }
}
async function lookupDomain(c: Capture, root: string, node: string): Promise<void> {
  let cursor = dirname(root);
  for (;;) {
    await c.lookupDirectory(join(cursor, 'node_modules'));
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  const home = c.input.environment.HOME;
  for (const path of [
    ...(home ? [join(home, '.node_modules'), join(home, '.node_libraries')] : []),
    resolve(node, '..', '..', 'lib', 'node'),
  ])
    await c.lookupDirectory(path);
}
/** Cooperative bounded file observations, not a hard OS-I/O deadline. */
async function observe(
  owned: OwnedInput
): Promise<{ entry: string; node: string; observed: string }> {
  checkOriginal(owned.original, owned.request, owned.signal, true);
  const paths = environment(owned),
    c = new Capture(owned);
  c.check();
  await c.stat(owned.cwd);
  await c.canonical(owned.cwd);
  const entry = await selected(c, paths, 'caws'),
    node = await selected(c, paths, 'node');
  if (!entry.endsWith(`/${ENTRY}`)) fail('Unsupported selected CLI layout');
  const root = entry.slice(0, -ENTRY.length - 1);
  await prefix(c, owned.reviewed.prefixRoot, owned.reviewed);
  await prefix(c, root, owned.reviewed);
  await c.file(owned.reviewed.node.path, owned.reviewed.node, true);
  await c.file(node, owned.reviewed.node, true);
  // The resolver itself must run under the identical reviewed Node implementation.
  if (process.execPath !== node && process.execPath !== owned.reviewed.node.path)
    await c.file(process.execPath, owned.reviewed.node, true);
  const domain = parseDomain(
    (await c.file(owned.reviewed.domain.path, owned.reviewed.domain, false, true))!,
    owned.reviewed,
    c
  );
  await lookupDomain(c, owned.reviewed.prefixRoot, owned.reviewed.node.path);
  await lookupDomain(c, root, node);
  await resolveDomain(c, owned.reviewed.prefixRoot, domain);
  await resolveDomain(c, root, domain);
  if ((await selected(c, paths, 'caws')) !== entry || (await selected(c, paths, 'node')) !== node)
    fail('CLI executable selection changed');
  await c.unchanged();
  c.check();
  const observed = hash(
    Buffer.from(JSON.stringify([...c.rows].sort(([a], [b]) => a.localeCompare(b))))
  );
  checkOriginal(owned.original, owned.request, owned.signal, true);
  return { entry, node, observed };
}
export async function compareCliIdentity(input: CliIdentityInput): Promise<CliIdentityResult> {
  try {
    const owned = own(input),
      result = await observe(owned);
    const receipt = Object.freeze({
      selectedEntry: result.entry,
      selectedNode: result.node,
      assertOwner(
        this: MatchedCliIdentityReceipt,
        request: RuntimeRequest,
        originalSignal: AbortSignal
      ): void {
        assertMatchedCliIdentityReceipt(this, request, originalSignal);
      },
      async revalidate(this: MatchedCliIdentityReceipt): Promise<void> {
        const state = receipts.get(this);
        if (!state) fail('CLI identity receipt lacks comparator provenance');
        checkOriginal(state.input.original);
        const again = await observe(state.input);
        if (again.observed !== state.observed) fail('CLI identity observation changed');
        checkOriginal(state.input.original);
      },
    }) as MatchedCliIdentityReceipt;
    receipts.set(receipt, { input: owned, observed: result.observed });
    checkOriginal(owned.original);
    return { status: 'matched', receipt };
  } catch (error) {
    return {
      status: 'declined',
      reason: error instanceof Error ? error.message : 'CLI identity unavailable',
    };
  }
}
