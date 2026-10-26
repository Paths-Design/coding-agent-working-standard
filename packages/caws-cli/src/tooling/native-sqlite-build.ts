import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { runSqliteBuildStep, type ReviewedFile, type StepReceipt } from './sqlite-static-build';
import { inspectBsdAr, type ArMember } from './ar-archive';

export interface ReviewedTreeFile {
  relativePath: string;
  sizeBytes: number;
  sha256: string;
  executable: boolean;
}
export interface ReviewedTree {
  root: string;
  files: ReviewedTreeFile[];
}
export interface NativeSqliteBuildRequest {
  schema: 'caws.native_sqlite_build_request.v1' | 'caws.native_sqlite_build_request.v2';
  source: ReviewedTree;
  embedded: { serviceClient: ReviewedFile; serviceImage: ReviewedTree };
  vendors: { directory: string; tree: ReviewedTree }[];
  prefix: {
    archive: ReviewedFile;
    header: ReviewedFile;
    object: ReviewedFile;
  };
  binding: {
    directory: 'libsqlite3-sys-0.38.2';
    relativePath: 'bindgen-bindings/bindgen_3.34.1.rs';
    sha256: string;
  };
  tools: {
    cargo: ReviewedFile;
    rustc: ReviewedFile;
    clang: ReviewedFile;
    ar: ReviewedFile;
    nm: ReviewedFile;
    otool: ReviewedFile;
  };
  sdk: { root: string; settings: ReviewedFile };
  outputRoot: string;
  profile: 'debug' | 'release';
  timeoutMs: number;
  maxOutputBytes: number;
}
export interface SqlitePrefixManifest {
  schema: 'caws.sqlite_prefix.v1';
  target: 'aarch64-apple-darwin';
  sourceId: string;
  archive: ReviewedFile;
  header: ReviewedFile;
  object: ReviewedFile;
  bindings: ReviewedFile;
}
export interface InstalledInvocationCapability {
  readonly protocol: 'invoke-installed-v1';
  readonly maxOriginalTimeoutMs: 30000;
}
export interface SqliteBuildIdentityV1 {
  schema: 'caws.sqlite_build_identity.v1';
  version: string;
  sourceId: string;
  threadSafe: number;
  compileOptions: string[];
  compiledPrefixSha256: string;
}
export interface SqliteBuildIdentityV2 extends Omit<SqliteBuildIdentityV1, 'schema'> {
  schema: 'caws.sqlite_build_identity.v2';
  installedInvocation: InstalledInvocationCapability;
}
export type SqliteBuildIdentity = SqliteBuildIdentityV1 | SqliteBuildIdentityV2;
export interface NativeBuildArtifacts {
  native: ReviewedFile;
  observer: ReviewedFile;
  custodyObserver: ReviewedFile;
  sysRlib: ReviewedFile;
  generatedBinding: ReviewedFile;
  runtimeIdentity: ReviewedFile;
  cargoMessages: ReviewedFile;
}
interface ReceiptBase {
  schema: 'caws.native_sqlite_build_receipt.v1' | 'caws.native_sqlite_build_receipt.v2';
  adoption: 'NOT_ADOPTED';
  outputRoot: string | null;
  requestDigest: string | null;
  steps: StepReceipt[];
  limits: string[];
}
interface CompletedNativeSqliteBuildBase extends ReceiptBase {
  status: 'completed';
  outputRoot: string;
  requestDigest: string;
  profile: 'debug' | 'release';
  markerPath: string;
  requestSnapshot: ReviewedFile;
  sourceTreeDigest: string;
  prefixManifest: ReviewedFile;
  artifacts: NativeBuildArtifacts;
  observedIdentity: SqliteBuildIdentity;
  sysRlibInventory: readonly ArMember[];
  extraMembers: {
    admission: 'UNADMITTED';
    members: readonly ArMember[];
  };
}
export interface CompletedNativeSqliteBuildV1 extends CompletedNativeSqliteBuildBase {
  schema: 'caws.native_sqlite_build_receipt.v1';
}
/** V2 requires the source-bound stable hook entry; V1 does not grant it. */
export interface CompletedNativeSqliteBuildV2 extends CompletedNativeSqliteBuildBase {
  schema: 'caws.native_sqlite_build_receipt.v2';
  artifacts: NativeBuildArtifacts & { stableEntry: ReviewedFile };
}
export type CompletedNativeSqliteBuild =
  | CompletedNativeSqliteBuildV1
  | CompletedNativeSqliteBuildV2;
export interface FailedNativeSqliteBuild extends ReceiptBase {
  status: 'failed';
  phase: string;
  reason: string;
  writerState: 'NOT_STARTED' | 'RETAINED_UNCERTAIN';
  failureReceiptPath: string | null;
}
export interface LoadedNativeSqliteBuild {
  /** Raw request-file identity is distinct from canonical requestDigest. */
  requestFile: ReviewedFile;
  completionReceipt: ReviewedFile;
  build: CompletedNativeSqliteBuild;
}

const TARGET = 'aarch64-apple-darwin';
const SOURCE_ID =
  '2026-07-24 19:02:57 bf7c7f30031888f4e796e429ab3978879485813aaca6f641c7b33e4e09459bcc';
const HEADER_SHA = '919e7f2e8ed1d8f56ac17b412b8971c76aa5d1a879752cc6058f75e7d5910e1d';
const REQUIRED_OPTIONS = ['THREADSAFE=1', 'OMIT_LOAD_EXTENSION', 'ENABLE_API_ARMOR'];
const TOOL_NAMES = ['cargo', 'rustc', 'clang', 'ar', 'nm', 'otool'] as const;
const SERVICE_FILES = [
  'caws.sh',
  'codex-parser-runtime.sh',
  'dispatch.sh',
  'execute-handler.sh',
  'git.sh',
  'handler-env.sh',
  'handler-routes.sh',
  'libraries.sh',
  'parse-input.sh',
  'plan-transcript-finalize.sh',
  'tool.sh',
] as const;
const MAX_FILE = 256 * 1024 * 1024;
const MAX_TOTAL = 512 * 1024 * 1024;
const MAX_FILES = 50000;
const MAX_JSON = 16 * 1024 * 1024;
const MAX_RETAINED_OUTPUT = 4 * 1024 * 1024;
const LIMITATIONS = [
  'NOT_ADOPTED: completion grants no prefix, package, runtime, native profile or release authority.',
  'Caller-supplied pins are trusted reviewed inputs, not an authentication sandbox.',
  'Pre/post file observations do not establish immutable executable images or full toolchain, dyld or SDK closure.',
  'Deadlines and byte/count budgets are cooperative; stalled OS I/O and descendant lifetimes are not hard-bounded.',
  'The combined retained child output budget is 4 MiB; persisted receipts are limited to 16 MiB.',
  'Only direct-child custody is observed. Failed roots remain uncertain and have no cleanup or reuse guarantee.',
  'Current-host arm64 macOS execution does not qualify other hosts, targets or older deployment systems.',
  'Extra rlib members are retained as UNADMITTED; names, suffixes and object magic confer no Rust or native provenance.',
  'Loading a receipt verifies point-in-time paths and hashes, not publication authenticity or execution authority.',
];

const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

function insist(condition: unknown, detail: string): asserts condition {
  if (!condition) throw new Error(detail);
}
function shape(value: unknown, keys: readonly string[]): void {
  insist(
    value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).sort().join('\0') === [...keys].sort().join('\0'),
    `Unexpected object shape; expected ${keys.join(', ')}`
  );
}
function absolute(value: string): void {
  insist(
    typeof value === 'string' &&
      value.length <= 4096 &&
      !value.includes('\0') &&
      path.isAbsolute(value) &&
      path.resolve(value) === value,
    'Expected normalized absolute path'
  );
}
function relative(value: string): void {
  insist(
    typeof value === 'string' &&
      value.length > 0 &&
      value.length <= 4096 &&
      !value.includes('\0') &&
      !value.includes('\\') &&
      !path.posix.isAbsolute(value) &&
      path.posix.normalize(value) === value &&
      value.split('/').every((part) => part !== '' && part !== '.' && part !== '..'),
    'Expected normalized relative file path'
  );
}
function digest(value: string): void {
  insist(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), 'Invalid SHA256');
}
function size(value: number): void {
  insist(
    Number.isSafeInteger(value) && value >= 0 && value <= MAX_FILE,
    'Invalid bounded file size'
  );
}
function reviewed(file: ReviewedFile): void {
  shape(file, ['path', 'sizeBytes', 'sha256']);
  absolute(file.path);
  size(file.sizeBytes);
  digest(file.sha256);
}
function inside(root: string, file: string): boolean {
  const rel = path.relative(root, file);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}
function related(a: string, b: string): boolean {
  return a === b || inside(a, b) || inside(b, a);
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
      .join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  insist(encoded !== undefined, 'Unsupported canonical value');
  return encoded;
}
function requestDigest(request: NativeSqliteBuildRequest): string {
  return sha(Buffer.from(canonical(request)));
}
function trees(request: NativeSqliteBuildRequest): ReviewedTree[] {
  return [
    request.source,
    request.embedded.serviceImage,
    ...request.vendors.map((vendor) => vendor.tree),
  ];
}
function individualPins(request: NativeSqliteBuildRequest): ReviewedFile[] {
  return [
    request.embedded.serviceClient,
    request.prefix.archive,
    request.prefix.header,
    request.prefix.object,
    ...TOOL_NAMES.map((name) => request.tools[name]),
    request.sdk.settings,
  ];
}
function validateRequest(request: NativeSqliteBuildRequest): void {
  shape(request, [
    'schema',
    'source',
    'embedded',
    'vendors',
    'prefix',
    'binding',
    'tools',
    'sdk',
    'outputRoot',
    'profile',
    'timeoutMs',
    'maxOutputBytes',
  ]);
  insist(
    request.schema === 'caws.native_sqlite_build_request.v1' ||
      request.schema === 'caws.native_sqlite_build_request.v2',
    'Request schema mismatch'
  );
  insist(process.platform === 'darwin' && process.arch === 'arm64', 'Requires arm64 macOS host');
  absolute(request.outputRoot);
  insist(request.profile === 'debug' || request.profile === 'release', 'Invalid profile');
  insist(
    Number.isSafeInteger(request.timeoutMs) &&
      request.timeoutMs >= 1 &&
      request.timeoutMs <= 600000,
    'timeoutMs must be 1..600000'
  );
  insist(
    Number.isSafeInteger(request.maxOutputBytes) &&
      request.maxOutputBytes >= 1 &&
      request.maxOutputBytes <= MAX_JSON,
    'Invalid output bound'
  );
  insist(
    Array.isArray(request.vendors) && request.vendors.length >= 1 && request.vendors.length <= 128,
    'Expected 1..128 reviewed vendor crates'
  );
  const vendorNames = new Set<string>();
  for (const vendor of request.vendors) {
    shape(vendor, ['directory', 'tree']);
    insist(
      typeof vendor.directory === 'string' &&
        /^[A-Za-z0-9_][A-Za-z0-9_.+-]*-[0-9][A-Za-z0-9_.+-]*$/.test(vendor.directory) &&
        !vendor.directory.includes('..') &&
        !vendorNames.has(vendor.directory),
      'Invalid or duplicate vendor directory'
    );
    vendorNames.add(vendor.directory);
  }
  shape(request.embedded, ['serviceClient', 'serviceImage']);
  shape(request.prefix, ['archive', 'header', 'object']);
  shape(request.tools, TOOL_NAMES);
  shape(request.sdk, ['root', 'settings']);
  absolute(request.sdk.root);
  insist(
    request.sdk.settings.path === path.join(request.sdk.root, 'SDKSettings.json'),
    'Expected SDKSettings.json under SDK root'
  );
  shape(request.binding, ['directory', 'relativePath', 'sha256']);
  insist(
    request.binding.directory === 'libsqlite3-sys-0.38.2' &&
      request.binding.relativePath === 'bindgen-bindings/bindgen_3.34.1.rs',
    'Binding selection mismatch'
  );
  digest(request.binding.sha256);

  let totalBytes = 0;
  let totalFiles = 0;
  const absoluteFiles = new Set<string>();
  const add = (file: ReviewedFile): void => {
    reviewed(file);
    insist(!absoluteFiles.has(file.path), 'Duplicate absolute input file');
    absoluteFiles.add(file.path);
    totalBytes += file.sizeBytes;
    totalFiles++;
    insist(totalBytes <= MAX_TOTAL && totalFiles <= MAX_FILES, 'Input inventory budget exceeded');
  };
  const allTrees = trees(request);
  for (const tree of allTrees) {
    shape(tree, ['root', 'files']);
    absolute(tree.root);
    insist(Array.isArray(tree.files) && tree.files.length <= MAX_FILES, 'Invalid tree inventory');
    const files = new Set<string>();
    for (const file of tree.files) {
      shape(file, ['relativePath', 'sizeBytes', 'sha256', 'executable']);
      relative(file.relativePath);
      insist(typeof file.executable === 'boolean', 'Executable flag must be boolean');
      insist(!files.has(file.relativePath), 'Duplicate relative input path');
      files.add(file.relativePath);
      add({
        path: path.join(tree.root, file.relativePath),
        sizeBytes: file.sizeBytes,
        sha256: file.sha256,
      });
    }
    for (const name of files) {
      let parent = path.posix.dirname(name);
      while (parent !== '.') {
        insist(!files.has(parent), 'File/directory inventory collision');
        parent = path.posix.dirname(parent);
      }
    }
  }
  for (let i = 0; i < allTrees.length; i++)
    for (let j = i + 1; j < allTrees.length; j++)
      insist(!related(allTrees[i]!.root, allTrees[j]!.root), 'Overlapping input trees');
  for (const pin of individualPins(request)) add(pin);
  for (const tree of allTrees)
    insist(!related(request.outputRoot, tree.root), 'Output/input tree collision');
  for (const pin of individualPins(request))
    insist(!related(request.outputRoot, pin.path), 'Output/input file collision');
  insist(!related(request.outputRoot, request.sdk.root), 'Output/SDK collision');

  insist(
    request.embedded.serviceImage.files
      .map((file) => file.relativePath)
      .sort()
      .join('\0') === [...SERVICE_FILES].sort().join('\0'),
    'Embedded service-image inventory mismatch'
  );
  const sourceNames = new Set(request.source.files.map((file) => file.relativePath));
  insist(
    sourceNames.has('Cargo.toml') && sourceNames.has('Cargo.lock'),
    'Source needs Cargo manifest and lock'
  );
  insist(
    [...sourceNames].every((name) => name !== 'target' && !name.startsWith('target/')),
    'Top-level source target must not be inventoried'
  );
  insist(
    !sourceNames.has('.cargo/config') && !sourceNames.has('.cargo/config.toml'),
    'Source Cargo configuration refused'
  );
  for (const vendor of request.vendors)
    insist(
      vendor.tree.files.some((file) => file.relativePath === 'Cargo.toml'),
      'Vendor manifest missing'
    );
  const bindingVendor = request.vendors.find(
    (vendor) => vendor.directory === request.binding.directory
  );
  insist(bindingVendor, 'Binding vendor missing');
  const bindingFile = bindingVendor.tree.files.find(
    (file) => file.relativePath === request.binding.relativePath
  );
  insist(bindingFile?.sha256 === request.binding.sha256, 'Reviewed binding identity mismatch');
  insist(request.prefix.header.sha256 === HEADER_SHA, 'SQLite header pin mismatch');
  if (request.schema === 'caws.native_sqlite_build_request.v2')
    insist(
      request.source.files.some((file) => file.relativePath === 'src/installed_entry_main.rs'),
      'Stable hook entry source missing from reviewed tree'
    );
  insist(Buffer.byteLength(canonical(request)) <= MAX_JSON, 'Request metadata exceeds bound');
}

/** Own every nested array/object before any asynchronous boundary. */
function snapshotRequest(input: NativeSqliteBuildRequest): NativeSqliteBuildRequest {
  validateRequest(input);
  const copy = JSON.parse(JSON.stringify(input)) as NativeSqliteBuildRequest;
  validateRequest(copy);
  return copy;
}

function realDirectories(directory: string): void {
  absolute(directory);
  let cursor = path.parse(directory).root;
  for (const part of directory.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    const stat = fs.lstatSync(cursor);
    insist(stat.isDirectory() && !stat.isSymbolicLink(), `Not a real directory: ${cursor}`);
  }
}
function sameFileState(a: fs.Stats, b: fs.Stats): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs &&
    a.mode === b.mode
  );
}
function readBounded(file: string, maximum: number): Buffer {
  absolute(file);
  realDirectories(path.dirname(file));
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
  );
  try {
    const before = fs.fstatSync(fd);
    insist(
      before.isFile() && before.size >= 0 && before.size <= maximum,
      `Not a bounded regular file: ${file}`
    );
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, Math.min(65536, bytes.length - offset), null);
      if (!count) break;
      offset += count;
    }
    const extra = Buffer.alloc(1);
    const grew = fs.readSync(fd, extra, 0, 1, null) !== 0;
    const after = fs.fstatSync(fd);
    insist(
      offset === bytes.length && !grew && sameFileState(before, after),
      `File changed during read: ${file}`
    );
    return bytes;
  } finally {
    fs.closeSync(fd);
  }
}
function verifyFile(file: ReviewedFile): Buffer {
  reviewed(file);
  const bytes = readBounded(file.path, file.sizeBytes);
  insist(
    bytes.length === file.sizeBytes && sha(bytes) === file.sha256,
    `Pin mismatch: ${file.path}`
  );
  return bytes;
}
function fileIdentity(file: string, maximum = MAX_FILE): ReviewedFile {
  const bytes = readBounded(file, maximum);
  return { path: file, sizeBytes: bytes.length, sha256: sha(bytes) };
}
function exclusive(file: string, bytes: Uint8Array | string, executable = false): void {
  realDirectories(path.dirname(file));
  const fd = fs.openSync(
    file,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
    executable ? 0o700 : 0o600
  );
  try {
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
function absent(file: string): boolean {
  try {
    fs.lstatSync(file);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
}
function rejectCargoConfiguration(output: string): void {
  let cursor = output;
  while (true) {
    const cargoDir = path.join(cursor, '.cargo');
    if (!absent(cargoDir)) {
      realDirectories(cargoDir);
      insist(
        absent(path.join(cargoDir, 'config')) && absent(path.join(cargoDir, 'config.toml')),
        `Cargo ancestor configuration refused: ${cargoDir}`
      );
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
}

/**
 * Exact complete-file inventory. Directories must be represented by a listed
 * descendant; empty files are supported. Only the original source's top-level
 * real target directory is excluded.
 */
function inspectTree(
  tree: ReviewedTree,
  skipSourceTarget: boolean,
  tick: () => void,
  copyRoot?: string
): void {
  realDirectories(tree.root);
  const expected = new Map(tree.files.map((file) => [file.relativePath, file]));
  const directories = new Set(['']);
  for (const file of tree.files) {
    let parent = path.posix.dirname(file.relativePath);
    while (parent !== '.') {
      directories.add(parent);
      parent = path.posix.dirname(parent);
    }
  }
  const seen = new Set<string>();
  const visit = (relativeDir: string): void => {
    tick();
    const directory = relativeDir ? path.join(tree.root, relativeDir) : tree.root;
    realDirectories(directory);
    const before = fs.lstatSync(directory);
    const handle = fs.opendirSync(directory);
    try {
      let entry: fs.Dirent | null;
      while ((entry = handle.readSync()) !== null) {
        tick();
        const rel = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
        const full = path.join(tree.root, rel);
        const stat = fs.lstatSync(full);
        insist(!stat.isSymbolicLink(), `Symlink tree entry refused: ${full}`);
        if (skipSourceTarget && rel === 'target') {
          insist(stat.isDirectory(), 'Excluded source target must be a real directory');
          continue;
        }
        if (stat.isDirectory()) {
          insist(directories.has(rel), `Unrepresented directory: ${full}`);
          visit(rel);
          continue;
        }
        const pin = expected.get(rel);
        insist(stat.isFile() && pin, `Unexpected tree entry: ${full}`);
        const bytes = verifyFile({
          path: full,
          sizeBytes: pin.sizeBytes,
          sha256: pin.sha256,
        });
        insist(((stat.mode & 0o111) !== 0) === pin.executable, `Executable mode mismatch: ${full}`);
        seen.add(rel);
        if (copyRoot) {
          const destination = path.join(copyRoot, rel);
          fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
          exclusive(destination, bytes, pin.executable);
        }
      }
    } finally {
      handle.closeSync();
    }
    const after = fs.lstatSync(directory);
    insist(sameFileState(before, after), `Directory changed during inventory: ${directory}`);
  };
  visit('');
  insist(seen.size === expected.size, 'Reviewed tree files missing');
}
function embeddedPaths(root: string): { client: string; image: string } {
  const templates = path.join(root, 'caws-cli', 'templates', 'hook-packs');
  return {
    client: path.join(templates, 'shared', 'lib', 'session-render-service-client.sh'),
    image: path.join(templates, 'runtime', 'service-image'),
  };
}
function verifyEmbedded(request: NativeSqliteBuildRequest, tick: () => void): void {
  const selected = embeddedPaths(request.outputRoot);
  inspectTree(stagedTree(request.embedded.serviceImage, selected.image), false, tick);
  verifyFile({ ...request.embedded.serviceClient, path: selected.client });
}
function stagedTree(tree: ReviewedTree, root: string): ReviewedTree {
  return { root, files: tree.files };
}
function prefixPaths(root: string): {
  archive: string;
  header: string;
  object: string;
  manifest: string;
} {
  return {
    archive: path.join(root, 'prefix', 'lib', 'libsqlite3.a'),
    header: path.join(root, 'prefix', 'include', 'sqlite3.h'),
    object: path.join(root, 'prefix', 'objects', 'sqlite3.o'),
    manifest: path.join(root, 'prefix', 'prefix-manifest.json'),
  };
}
function relocated(pin: ReviewedFile, destination: string): ReviewedFile {
  return { path: destination, sizeBytes: pin.sizeBytes, sha256: pin.sha256 };
}
function expectedPrefix(request: NativeSqliteBuildRequest): SqlitePrefixManifest {
  const locations = prefixPaths(request.outputRoot);
  const vendor = request.vendors.find((item) => item.directory === request.binding.directory)!;
  const binding = vendor.tree.files.find(
    (file) => file.relativePath === request.binding.relativePath
  )!;
  return {
    schema: 'caws.sqlite_prefix.v1',
    target: TARGET,
    sourceId: SOURCE_ID,
    archive: relocated(request.prefix.archive, locations.archive),
    header: relocated(request.prefix.header, locations.header),
    object: relocated(request.prefix.object, locations.object),
    bindings: {
      path: path.join(
        request.outputRoot,
        'vendor',
        request.binding.directory,
        request.binding.relativePath
      ),
      sizeBytes: binding.sizeBytes,
      sha256: binding.sha256,
    },
  };
}
function manifestBytes(manifest: SqlitePrefixManifest): Buffer {
  return Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
}
function verifyPrefixArchive(archive: Buffer, object: Buffer): void {
  const inventory = inspectBsdAr(archive, {
    maxArchiveBytes: MAX_FILE,
    maxMembers: 2,
    maxMemberBytes: MAX_FILE,
    maxNameBytes: 256,
  });
  insist(inventory.members.length === 2, 'Prefix archive needs exactly two members');
  const indexes = inventory.members.filter(
    (member) => member.name === '__.SYMDEF' || member.name === '__.SYMDEF SORTED'
  );
  const objects = inventory.members.filter((member) => member.name === 'sqlite3.o');
  insist(indexes.length === 1 && objects.length === 1, 'Prefix archive member inventory mismatch');
  insist(
    Buffer.from(inventory.copyBytes(objects[0]!.index, 'payload')).equals(object),
    'Prefix SQLite object bytes mismatch'
  );
}
function strictJson(bytes: Buffer): unknown {
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  return JSON.parse(text);
}
interface CargoRecord {
  reason?: string;
  package_id?: string;
  manifest_path?: string;
  target?: { name?: string; kind?: string[]; src_path?: string };
  executable?: string | null;
  filenames?: string[];
  out_dir?: string;
  fresh?: boolean;
}
/** Select source/profile-bound Cargo records, without granting file or build authority. */
export function selectNativeSqliteCargoArtifacts(
  request: NativeSqliteBuildRequest,
  bytes: Buffer
): {
  native: string;
  observer: string;
  custodyObserver: string;
  sysRlib: string;
  generatedBinding: string;
  stableEntry?: string;
} {
  validateRequest(request);
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  const records: CargoRecord[] = text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const value: unknown = JSON.parse(line);
      insist(
        value !== null && typeof value === 'object' && !Array.isArray(value),
        'Invalid Cargo JSON record'
      );
      return value as CargoRecord;
    });
  const targetRoot = path.join(request.outputRoot, 'target');
  const sourceManifest = path.join(request.outputRoot, 'source', 'Cargo.toml');
  const sysManifest = path.join(
    request.outputRoot,
    'vendor',
    request.binding.directory,
    'Cargo.toml'
  );
  const unique = (selected: CargoRecord[], description: string): CargoRecord => {
    insist(selected.length === 1, `Expected unique Cargo record: ${description}`);
    insist(selected[0]!.fresh === false, `Unexpected cached Cargo artifact: ${description}`);
    return selected[0]!;
  };
  const artifactPath = (value: unknown): string => {
    insist(typeof value === 'string', 'Cargo artifact path missing');
    absolute(value);
    insist(inside(targetRoot, value), 'Cargo artifact escaped fresh target');
    return value;
  };
  const executable = (name: string, kind: string): string => {
    const record = unique(
      records.filter(
        (item) =>
          item.reason === 'compiler-artifact' &&
          item.manifest_path === sourceManifest &&
          item.target?.name === name &&
          Array.isArray(item.target.kind) &&
          item.target.kind.includes(kind)
      ),
      name
    );
    const selected = artifactPath(record.executable);
    const directory = path.join(targetRoot, TARGET, request.profile);
    const expected =
      kind === 'example' ? path.join(directory, 'examples', name) : path.join(directory, name);
    insist(selected === expected, `Unexpected executable location: ${name}`);
    return selected;
  };
  const native = executable('caws-native', 'bin');
  const observer = executable('service-observer', 'example');
  const custodyObserver = executable('service-custody-observer', 'example');
  let stableEntry: string | undefined;
  if (request.schema === 'caws.native_sqlite_build_request.v2') {
    // Count before checking provenance: an extra same-name record must not hide
    // behind a wrong manifest, source or kind while another record is accepted.
    const record = unique(
      records.filter(
        (item) => item.reason === 'compiler-artifact' && item.target?.name === 'caws-hook-native'
      ),
      'caws-hook-native'
    );
    insist(
      record.manifest_path === sourceManifest &&
        Array.isArray(record.target?.kind) &&
        record.target.kind.length === 1 &&
        record.target.kind[0] === 'bin' &&
        record.target.src_path ===
          path.join(request.outputRoot, 'source', 'src', 'installed_entry_main.rs'),
      'Stable hook entry Cargo source/target mismatch'
    );
    stableEntry = artifactPath(record.executable);
    insist(
      stableEntry === path.join(targetRoot, TARGET, request.profile, 'caws-hook-native'),
      'Unexpected executable location: caws-hook-native'
    );
  }
  const sys = unique(
    records.filter(
      (item) =>
        item.reason === 'compiler-artifact' &&
        item.manifest_path === sysManifest &&
        item.target?.name === 'libsqlite3_sys' &&
        Array.isArray(item.target.kind) &&
        item.target.kind.includes('lib')
    ),
    'libsqlite3_sys'
  );
  insist(typeof sys.package_id === 'string', 'SQLite package identity missing');
  insist(Array.isArray(sys.filenames), 'SQLite artifact filenames missing');
  const rlibs = sys.filenames.filter((name) => typeof name === 'string' && name.endsWith('.rlib'));
  insist(rlibs.length === 1, 'Expected unique SQLite rlib');
  const sysRlib = artifactPath(rlibs[0]);
  const buildScripts = records.filter(
    (item) => item.reason === 'build-script-executed' && item.package_id === sys.package_id
  );
  insist(buildScripts.length === 1, 'Expected unique SQLite build-script record');
  const outDir = artifactPath(buildScripts[0]!.out_dir);
  return {
    native,
    observer,
    custodyObserver,
    sysRlib,
    generatedBinding: path.join(outDir, 'bindgen.rs'),
    ...(stableEntry === undefined ? {} : { stableEntry }),
  };
}

/** Exact compiler invocation shared by execution and boundary inspection. */
export function nativeSqliteCargoArguments(request: NativeSqliteBuildRequest): string[] {
  validateRequest(request);
  return [
    'build',
    '--manifest-path',
    path.join(request.outputRoot, 'source', 'Cargo.toml'),
    '--locked',
    '--offline',
    '--frozen',
    '--jobs',
    '1',
    '--target',
    TARGET,
    '--features',
    'sqlite-store',
    '--bin',
    'caws-native',
    ...(request.schema === 'caws.native_sqlite_build_request.v2'
      ? ['--bin', 'caws-hook-native']
      : []),
    '--example',
    'service-observer',
    '--example',
    'service-custody-observer',
    '--message-format=json',
    ...(request.profile === 'release' ? ['--release'] : []),
  ];
}

/** Re-derive the versioned artifact inventory and verify current file bytes/modes.
 * This boundary does not authenticate a completion receipt or its SQLite inputs.
 */
export function verifyNativeSqliteBuildArtifacts(
  request: NativeSqliteBuildRequest,
  schema: CompletedNativeSqliteBuild['schema'],
  artifacts: NativeBuildArtifacts | CompletedNativeSqliteBuildV2['artifacts']
): void {
  insist(
    schema ===
      (request.schema === 'caws.native_sqlite_build_request.v2'
        ? 'caws.native_sqlite_build_receipt.v2'
        : 'caws.native_sqlite_build_receipt.v1'),
    'Completion receipt/request mismatch'
  );
  const v2 = schema === 'caws.native_sqlite_build_receipt.v2';
  shape(artifacts, [
    'native',
    'observer',
    'custodyObserver',
    'sysRlib',
    'generatedBinding',
    'runtimeIdentity',
    'cargoMessages',
    ...(v2 ? ['stableEntry'] : []),
  ]);
  const cargoFile = path.join(request.outputRoot, 'cargo-build.stdout');
  insist(artifacts.cargoMessages.path === cargoFile, 'Cargo message location mismatch');
  const selected = selectNativeSqliteCargoArtifacts(request, verifyFile(artifacts.cargoMessages));
  const expectedPaths = {
    ...selected,
    runtimeIdentity: path.join(request.outputRoot, 'observed-sqlite-identity.json'),
    cargoMessages: cargoFile,
  };
  const pins = artifacts as unknown as Record<string, ReviewedFile>;
  for (const [key, expected] of Object.entries(expectedPaths)) {
    const pin = pins[key]!;
    insist(pin.path === expected, `Artifact path mismatch: ${key}`);
    verifyFile(pin);
  }
  for (const key of ['native', 'observer', 'custodyObserver', ...(v2 ? ['stableEntry'] : [])])
    insist((fs.lstatSync(pins[key]!.path).mode & 0o111) !== 0, 'Executable artifact mode changed');
}
function inspectSysRlib(
  pin: ReviewedFile,
  object: Buffer
): { inventory: readonly ArMember[]; extras: readonly ArMember[] } {
  const inventory = inspectBsdAr(verifyFile(pin), {
    maxArchiveBytes: MAX_FILE,
    maxMembers: MAX_FILES,
    maxMemberBytes: MAX_FILE,
    maxNameBytes: 4096,
  });
  const selected = inventory.members.filter((member) => member.name === 'sqlite3.o');
  insist(selected.length === 1, 'Expected exactly one SQLite C member in sys rlib');
  insist(
    Buffer.from(inventory.copyBytes(selected[0]!.index, 'payload')).equals(object),
    'Sys rlib C member differs from reviewed object'
  );
  return {
    inventory: inventory.members,
    extras: inventory.members.filter((member) => member.index !== selected[0]!.index),
  };
}
/** Validate the selected native's retained diagnostic, never infer capability from receipt v2. */
export function validateNativeSqliteBuildIdentity(
  value: unknown,
  prefixSha: string
): SqliteBuildIdentity {
  const v2 =
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).schema === 'caws.sqlite_build_identity.v2';
  shape(value, [
    'schema',
    'version',
    'sourceId',
    'threadSafe',
    'compileOptions',
    'compiledPrefixSha256',
    ...(v2 ? ['installedInvocation'] : []),
  ]);
  const identity = value as SqliteBuildIdentity;
  insist(
    (identity.schema === 'caws.sqlite_build_identity.v1' ||
      identity.schema === 'caws.sqlite_build_identity.v2') &&
      identity.version === '3.53.4' &&
      identity.sourceId === SOURCE_ID &&
      identity.threadSafe === 1 &&
      identity.compiledPrefixSha256 === prefixSha,
    'Observed SQLite runtime identity mismatch'
  );
  insist(
    Array.isArray(identity.compileOptions) &&
      identity.compileOptions.every(
        (option) => typeof option === 'string' && !option.includes('\0')
      ) &&
      REQUIRED_OPTIONS.every((option) => identity.compileOptions.includes(option)),
    'Required observed SQLite compile options missing'
  );
  if (identity.schema === 'caws.sqlite_build_identity.v2') {
    shape(identity.installedInvocation, ['protocol', 'maxOriginalTimeoutMs']);
    insist(
      identity.installedInvocation.protocol === 'invoke-installed-v1' &&
        identity.installedInvocation.maxOriginalTimeoutMs === 30000,
      'Unsupported installed invocation capability'
    );
  }
  return identity;
}

export async function buildNativeSqliteCandidate(
  input: NativeSqliteBuildRequest,
  optionsInput: { signal?: AbortSignal } = {}
): Promise<CompletedNativeSqliteBuild | FailedNativeSqliteBuild> {
  const signal = optionsInput.signal;
  const steps: StepReceipt[] = [];
  let phase = 'request';
  let request: NativeSqliteBuildRequest | undefined;
  let outputRoot: string | null = null;
  let canonicalDigest: string | null = null;
  let created = false;
  let rootIdentity: fs.Stats | undefined;
  let deadline = 0;
  const tick = (): void => {
    insist(!signal?.aborted, 'Native build aborted');
    insist(Date.now() < deadline, 'Native build timeout');
  };
  const rootCheck = (): void => {
    insist(outputRoot && rootIdentity, 'Output root not established');
    realDirectories(outputRoot);
    const current = fs.lstatSync(outputRoot);
    insist(
      current.dev === rootIdentity.dev &&
        current.ino === rootIdentity.ino &&
        (current.mode & 0o777) === 0o700,
      'Output root identity changed'
    );
    rejectCargoConfiguration(outputRoot);
  };
  try {
    request = snapshotRequest(input);
    outputRoot = request.outputRoot;
    canonicalDigest = requestDigest(request);
    deadline = Date.now() + request.timeoutMs;
    tick();
    phase = 'output-root';
    realDirectories(path.dirname(outputRoot));
    rejectCargoConfiguration(path.dirname(outputRoot));
    fs.mkdirSync(outputRoot, { mode: 0o700 });
    created = true;
    rootIdentity = fs.lstatSync(outputRoot);
    rootCheck();

    const sourceRoot = path.join(outputRoot, 'source');
    const vendorRoot = path.join(outputRoot, 'vendor');
    const prefix = expectedPrefix(request);
    const prefixFile = prefixPaths(outputRoot).manifest;
    const privatePaths = [
      sourceRoot,
      vendorRoot,
      path.join(outputRoot, 'home'),
      path.join(outputRoot, 'cargo-home'),
      path.join(outputRoot, 'target'),
      path.join(outputRoot, 'prefix'),
      path.join(outputRoot, 'tmp'),
    ];
    for (const directory of privatePaths) fs.mkdirSync(directory, { mode: 0o700 });

    phase = 'input-staging';
    inspectTree(request.source, true, tick, sourceRoot);
    const embedded = embeddedPaths(outputRoot);
    fs.mkdirSync(embedded.image, { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.dirname(embedded.client), { recursive: true, mode: 0o700 });
    inspectTree(request.embedded.serviceImage, false, tick, embedded.image);
    exclusive(embedded.client, verifyFile(request.embedded.serviceClient));
    for (const vendor of request.vendors) {
      const destination = path.join(vendorRoot, vendor.directory);
      fs.mkdirSync(destination, { mode: 0o700 });
      inspectTree(vendor.tree, false, tick, destination);
    }
    for (const name of ['archive', 'header', 'object'] as const) {
      tick();
      const destination = prefix[name].path;
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      exclusive(destination, verifyFile(request.prefix[name]));
    }
    verifyPrefixArchive(verifyFile(prefix.archive), verifyFile(prefix.object));
    const prefixData = manifestBytes(prefix);
    exclusive(prefixFile, prefixData);
    const prefixPin = fileIdentity(prefixFile, MAX_JSON);
    const requestFile = path.join(outputRoot, 'native-request.json');
    exclusive(requestFile, canonical(request) + '\n');
    const requestSnapshot = fileIdentity(requestFile, MAX_JSON);
    const cargoConfig = path.join(outputRoot, 'cargo-home', 'config.toml');
    const cargoConfigText =
      '[source.crates-io]\nreplace-with = "verified-vendor"\n' +
      '[source.verified-vendor]\ndirectory = ' +
      JSON.stringify(vendorRoot) +
      '\n' +
      '[net]\noffline = true\n';
    exclusive(cargoConfig, cargoConfigText);
    const configPin = fileIdentity(cargoConfig, MAX_JSON);

    const verifyInputs = (): void => {
      tick();
      rootCheck();
      inspectTree(request!.source, true, tick);
      inspectTree(stagedTree(request!.source, sourceRoot), false, tick);
      inspectTree(request!.embedded.serviceImage, false, tick);
      verifyEmbedded(request!, tick);
      for (const vendor of request!.vendors) {
        inspectTree(vendor.tree, false, tick);
        inspectTree(stagedTree(vendor.tree, path.join(vendorRoot, vendor.directory)), false, tick);
      }
      for (const file of individualPins(request!)) {
        tick();
        verifyFile(file);
      }
      for (const name of TOOL_NAMES)
        insist(
          (fs.lstatSync(request!.tools[name].path).mode & 0o111) !== 0,
          'Tool is not executable'
        );
      realDirectories(request!.sdk.root);
      for (const pin of [
        prefix.archive,
        prefix.header,
        prefix.object,
        prefix.bindings,
        prefixPin,
        requestSnapshot,
        configPin,
      ])
        verifyFile(pin);
      tick();
    };
    const env: Record<string, string> = {
      PATH: '/usr/bin:/bin',
      LANG: 'C',
      LC_ALL: 'C',
      TZ: 'UTC',
      HOME: path.join(outputRoot, 'home'),
      CARGO_HOME: path.join(outputRoot, 'cargo-home'),
      CARGO_TARGET_DIR: path.join(outputRoot, 'target'),
      TMPDIR: path.join(outputRoot, 'tmp'),
      SDKROOT: request.sdk.root,
      MACOSX_DEPLOYMENT_TARGET: '11.0',
      RUSTC: request.tools.rustc.path,
      CARGO_TARGET_AARCH64_APPLE_DARWIN_LINKER: request.tools.clang.path,
      CC: request.tools.clang.path,
      AR: request.tools.ar.path,
      SQLITE3_LIB_DIR: path.dirname(prefix.archive.path),
      SQLITE3_INCLUDE_DIR: path.dirname(prefix.header.path),
      SQLITE3_STATIC: '1',
      SQLITE3_NO_PKG_CONFIG: '1',
      CAWS_SQLITE_PREFIX_MANIFEST: prefixFile,
      CAWS_SQLITE_PREFIX_MANIFEST_SHA256: prefixPin.sha256,
    };
    const execute = async (
      label: string,
      executable: string,
      args: string[]
    ): Promise<StepReceipt> => {
      phase = label;
      verifyInputs();
      const remainingOutput =
        MAX_RETAINED_OUTPUT -
        steps.reduce(
          (total, step) => total + step.stdoutRetainedBytes + step.stderrRetainedBytes,
          0
        );
      insist(remainingOutput > 0, 'Combined child output budget exhausted');
      const receipt = await runSqliteBuildStep({
        label,
        executable,
        args,
        cwd: outputRoot!,
        env,
        deadline,
        maxOutputBytes: Math.min(request!.maxOutputBytes, remainingOutput),
        ...(signal ? { signal } : {}),
      });
      steps.push(receipt);
      insist(
        receipt.exitCode === 0 &&
          receipt.stopReason === null &&
          receipt.persistenceError === null &&
          receipt.error === null &&
          receipt.directChildReaped,
        `Step failed: ${label}: ${
          receipt.stopReason ??
          receipt.persistenceError ??
          receipt.error ??
          `exit ${receipt.exitCode}`
        }`
      );
      verifyInputs();
      return receipt;
    };
    const stepBytes = (receipt: StepReceipt): Buffer => {
      const bytes = readBounded(receipt.stdoutPath, request!.maxOutputBytes);
      insist(
        bytes.length === receipt.stdoutBytes &&
          bytes.length === receipt.stdoutRetainedBytes &&
          sha(bytes) === receipt.stdoutSha256 &&
          bytes.equals(Buffer.from(receipt.stdoutBase64, 'base64')),
        'Step stdout custody mismatch'
      );
      return bytes;
    };

    const cargoArgs = nativeSqliteCargoArguments(request);
    const cargoStep = await execute('cargo-build', request.tools.cargo.path, cargoArgs);
    phase = 'cargo-artifacts';
    const selected = selectNativeSqliteCargoArtifacts(request, stepBytes(cargoStep));
    const nativePin = fileIdentity(selected.native);
    const observerPin = fileIdentity(selected.observer);
    const custodyPin = fileIdentity(selected.custodyObserver);
    const stablePin =
      selected.stableEntry === undefined ? undefined : fileIdentity(selected.stableEntry);
    const sysPin = fileIdentity(selected.sysRlib);
    const bindingPin = fileIdentity(selected.generatedBinding);
    insist(
      bindingPin.sha256 === prefix.bindings.sha256 &&
        bindingPin.sizeBytes === prefix.bindings.sizeBytes,
      'Generated SQLite binding differs from reviewed binding'
    );
    for (const pin of [nativePin, observerPin, custodyPin, ...(stablePin ? [stablePin] : [])])
      insist((fs.lstatSync(pin.path).mode & 0o111) !== 0, 'Artifact is not executable');
    const sysInventory = inspectSysRlib(sysPin, verifyFile(prefix.object));

    const identityStep = await execute('sqlite-identity', nativePin.path, [
      '--sqlite-build-identity',
    ]);
    verifyFile(nativePin);
    const identityBytes = stepBytes(identityStep);
    const observedIdentity = validateNativeSqliteBuildIdentity(
      strictJson(identityBytes),
      prefixPin.sha256
    );
    const identityPath = path.join(outputRoot, 'observed-sqlite-identity.json');
    exclusive(identityPath, identityBytes);

    for (const [label, binary] of [
      ['native', nativePin],
      ['observer', observerPin],
      ['custody', custodyPin],
      ...(stablePin ? [['stable-entry', stablePin] as const] : []),
    ] as const) {
      verifyFile(binary);
      // Observers do not call SQLite; only the native identity consumer owes
      // a retained definition. Dead stripping in observers is legitimate.
      if (label === 'native') {
        const nm = await execute(`nm-${label}`, request.tools.nm.path, ['-gU', binary.path]);
        const symbols = new TextDecoder('utf-8', { fatal: true }).decode(stepBytes(nm));
        insist(
          symbols.split(/\r?\n/).filter((line) => /^\S+\s+T\s+_sqlite3_libversion$/.test(line))
            .length === 1,
          'Expected one defined sqlite3_libversion symbol'
        );
      }
      const otool = await execute(`otool-${label}`, request.tools.otool.path, ['-L', binary.path]);
      const imports = new TextDecoder('utf-8', { fatal: true })
        .decode(stepBytes(otool))
        .trimEnd()
        .split(/\r?\n/);
      insist(imports.shift() === `${binary.path}:`, 'Unexpected otool artifact header');
      insist(imports.length > 0, 'Missing otool dynamic imports');
      for (const line of imports) {
        insist(
          /^\s+\S+ \(compatibility version [\d.]+, current version [\d.]+\)$/.test(line),
          'Unexpected otool import record'
        );
        insist(!/sqlite/i.test(line), 'Dynamic SQLite dependency refused');
      }
      verifyFile(binary);
    }

    phase = 'publication';
    verifyInputs();
    const artifacts: NativeBuildArtifacts = {
      native: nativePin,
      observer: observerPin,
      custodyObserver: custodyPin,
      sysRlib: sysPin,
      generatedBinding: bindingPin,
      runtimeIdentity: fileIdentity(identityPath, MAX_JSON),
      cargoMessages: fileIdentity(cargoStep.stdoutPath, request.maxOutputBytes),
    };
    const versionedArtifacts = stablePin ? { ...artifacts, stableEntry: stablePin } : artifacts;
    for (const pin of Object.values(versionedArtifacts)) {
      tick();
      verifyFile(pin);
    }
    const markerPath = path.join(outputRoot, 'native-completed.json');
    const common: Omit<CompletedNativeSqliteBuildBase, 'schema' | 'artifacts'> = {
      status: 'completed',
      adoption: 'NOT_ADOPTED',
      outputRoot,
      requestDigest: canonicalDigest,
      profile: request.profile,
      markerPath,
      requestSnapshot,
      sourceTreeDigest: sha(Buffer.from(canonical(request.source))),
      prefixManifest: prefixPin,
      observedIdentity,
      sysRlibInventory: sysInventory.inventory,
      extraMembers: { admission: 'UNADMITTED', members: sysInventory.extras },
      steps,
      limits: [...LIMITATIONS],
    };
    let result: CompletedNativeSqliteBuild;
    if (request.schema === 'caws.native_sqlite_build_request.v2') {
      insist(stablePin, 'Stable hook entry artifact missing');
      result = {
        ...common,
        schema: 'caws.native_sqlite_build_receipt.v2',
        artifacts: { ...artifacts, stableEntry: stablePin },
      };
    } else {
      result = { ...common, schema: 'caws.native_sqlite_build_receipt.v1', artifacts };
    }
    const pending = path.join(outputRoot, 'native-completed.pending.json');
    const completionBytes = Buffer.from(JSON.stringify(result, null, 2) + '\n');
    insist(completionBytes.length <= MAX_JSON, 'Completion receipt exceeds metadata budget');
    exclusive(pending, completionBytes);
    rootCheck();
    tick();
    // Exclusive publication is dispatched immediately after the last cooperative
    // cancellation check. Cancellation after dispatch cannot undo this operation.
    fs.linkSync(pending, markerPath);
    return result;
  } catch (error) {
    const failure: FailedNativeSqliteBuild = {
      schema:
        request?.schema === 'caws.native_sqlite_build_request.v2'
          ? 'caws.native_sqlite_build_receipt.v2'
          : 'caws.native_sqlite_build_receipt.v1',
      status: 'failed',
      adoption: 'NOT_ADOPTED',
      outputRoot,
      requestDigest: canonicalDigest,
      phase,
      reason: errorText(error),
      writerState: created ? 'RETAINED_UNCERTAIN' : 'NOT_STARTED',
      failureReceiptPath: null,
      steps,
      limits: [...LIMITATIONS],
    };
    if (created && outputRoot && rootIdentity) {
      try {
        realDirectories(outputRoot);
        const current = fs.lstatSync(outputRoot);
        insist(
          current.dev === rootIdentity.dev && current.ino === rootIdentity.ino,
          'Failure root identity changed'
        );
        const receiptPath = path.join(outputRoot, 'native-failed.json');
        failure.failureReceiptPath = receiptPath;
        const failureBytes = Buffer.from(JSON.stringify(failure, null, 2) + '\n');
        insist(failureBytes.length <= MAX_JSON, 'Failure receipt exceeds metadata budget');
        exclusive(receiptPath, failureBytes);
      } catch {
        failure.failureReceiptPath = null;
      }
    }
    return failure;
  }
}

/** Read only the explicitly selected, bounded request file. */
export function readNativeSqliteBuildRequest(requestFilePath: string): {
  requestFile: ReviewedFile;
  request: NativeSqliteBuildRequest;
} {
  absolute(requestFilePath);
  const bytes = readBounded(requestFilePath, MAX_JSON);
  return {
    requestFile: { path: requestFilePath, sizeBytes: bytes.length, sha256: sha(bytes) },
    request: snapshotRequest(strictJson(bytes) as NativeSqliteBuildRequest),
  };
}

/**
 * Explicit, synchronous, point-in-time candidate loading. The qualifier reads
 * CAWS_NATIVE_BUILD_REQUEST and passes its value here. Missing input is an error;
 * no conventional target directory or alternate receipt is discovered.
 */
export function loadNativeSqliteBuild(requestFilePath: string): LoadedNativeSqliteBuild {
  const { requestFile, request } = readNativeSqliteBuildRequest(requestFilePath);
  const root = request.outputRoot;
  realDirectories(root);
  rejectCargoConfiguration(root);
  const marker = path.join(root, 'native-completed.json');
  const markerBytes = readBounded(marker, MAX_JSON);
  const build = strictJson(markerBytes) as CompletedNativeSqliteBuild;
  insist(
    build !== null &&
      typeof build === 'object' &&
      build.schema ===
        (request.schema === 'caws.native_sqlite_build_request.v2'
          ? 'caws.native_sqlite_build_receipt.v2'
          : 'caws.native_sqlite_build_receipt.v1') &&
      build.status === 'completed' &&
      build.adoption === 'NOT_ADOPTED' &&
      build.outputRoot === root &&
      build.markerPath === marker &&
      build.profile === request.profile &&
      build.requestDigest === requestDigest(request),
    'Completion receipt/request mismatch'
  );
  insist(
    build.sourceTreeDigest === sha(Buffer.from(canonical(request.source))),
    'Source tree digest mismatch'
  );
  const sourceRoot = path.join(root, 'source');
  const noop = (): void => {};
  inspectTree(stagedTree(request.source, sourceRoot), false, noop);
  verifyEmbedded(request, noop);
  for (const vendor of request.vendors)
    inspectTree(stagedTree(vendor.tree, path.join(root, 'vendor', vendor.directory)), false, noop);

  const expectedManifest = expectedPrefix(request);
  insist(
    build.prefixManifest.path === prefixPaths(root).manifest,
    'Prefix manifest location mismatch'
  );
  const actualManifest = verifyFile(build.prefixManifest);
  insist(actualManifest.equals(manifestBytes(expectedManifest)), 'Prefix manifest bytes mismatch');
  for (const name of ['archive', 'header', 'object', 'bindings'] as const)
    verifyFile(expectedManifest[name]);
  verifyPrefixArchive(verifyFile(expectedManifest.archive), verifyFile(expectedManifest.object));
  insist(
    build.requestSnapshot.path === path.join(root, 'native-request.json'),
    'Snapshot path mismatch'
  );
  const snapshotBytes = verifyFile(build.requestSnapshot);
  insist(snapshotBytes.equals(Buffer.from(canonical(request) + '\n')), 'Request snapshot mismatch');

  verifyNativeSqliteBuildArtifacts(request, build.schema, build.artifacts);
  insist(
    build.artifacts.generatedBinding.sha256 === expectedManifest.bindings.sha256 &&
      build.artifacts.generatedBinding.sizeBytes === expectedManifest.bindings.sizeBytes,
    'Generated binding pin mismatch'
  );
  const observed = validateNativeSqliteBuildIdentity(
    strictJson(verifyFile(build.artifacts.runtimeIdentity)),
    build.prefixManifest.sha256
  );
  insist(
    canonical(observed) === canonical(build.observedIdentity),
    'Observed identity record mismatch'
  );
  const inventory = inspectSysRlib(build.artifacts.sysRlib, verifyFile(expectedManifest.object));
  insist(
    canonical(inventory.inventory) === canonical(build.sysRlibInventory) &&
      build.extraMembers?.admission === 'UNADMITTED' &&
      canonical(inventory.extras) === canonical(build.extraMembers.members),
    'Sys rlib inventory changed'
  );
  return {
    requestFile,
    completionReceipt: {
      path: marker,
      sizeBytes: markerBytes.length,
      sha256: sha(markerBytes),
    },
    build,
  };
}

/** Require the stable-entry contract before returning any artifact to its consumer. */
export function loadNativeSqliteBuildWithStableEntry(
  requestFilePath: string
): Omit<LoadedNativeSqliteBuild, 'build'> & { build: CompletedNativeSqliteBuildV2 } {
  const selected = readNativeSqliteBuildRequest(requestFilePath);
  insist(
    selected.request.schema === 'caws.native_sqlite_build_request.v2',
    'Stable hook entry requires native build request v2'
  );
  const loaded = loadNativeSqliteBuild(requestFilePath);
  insist(
    loaded.build.schema === 'caws.native_sqlite_build_receipt.v2',
    'Stable hook entry requires receipt v2'
  );
  return { ...loaded, build: loaded.build };
}
