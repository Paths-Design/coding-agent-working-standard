/** Prepare an explicit local native image. Publication belongs to the runtime transaction.
 * The input inventory pins reviewed bytes; deriving it is a separate build/review operation.
 * No npm command, input program, or network request is executed here.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { sha } from './machine-runtime-state';
import { loadNativeSqliteBuildWithStableEntry } from '../tooling/native-sqlite-build';
import type { ReviewedFile } from '../tooling/sqlite-static-build';

export const NATIVE_ENTRY_SCHEMA = 'caws.runtime.native-entry.v1' as const;
export interface NativeEntryMetadata {
  readonly schema: typeof NATIVE_ENTRY_SCHEMA;
  readonly nativeExecutable: string;
  readonly nodeExecutable: string;
  readonly engineEntry: string;
  readonly describeEntry: string;
  readonly timeoutMs: number;
}
interface Pin {
  readonly source: string;
  readonly sha256: string;
}
interface BinaryPin extends Pin {
  readonly notices: Readonly<Record<string, Pin>>;
}
interface Member {
  readonly sha256: string;
  readonly mode: 0o644 | 0o755;
}
interface PackageReview {
  readonly name: string;
  readonly version: string;
  readonly licenses: readonly string[];
}
export interface NativeImageInput {
  readonly schema: 'caws.runtime.native-image-input.v1';
  readonly prefixRoot: string;
  readonly files: Readonly<Record<string, Member>>;
  readonly packages: Readonly<Record<string, PackageReview>>;
  /** Missing optional/optional-peer dependencies require a concrete build decision. */
  readonly omissions: Readonly<Record<string, string>>;
  readonly native: BinaryPin;
  readonly node: BinaryPin;
  readonly stableEntry: Pin;
  /** Offline executed semantic evidence, not native selection/publication authority. */
  readonly stopProfile?: Pin;
  readonly timeoutMs: number;
}
/** Select a reviewed build, never independent native/stable executable pins. */
export interface NativeBuildImageInput
  extends Omit<NativeImageInput, 'schema' | 'native' | 'stableEntry'> {
  readonly schema: 'caws.runtime.native-image-input.v2';
  readonly requestFile: ReviewedFile;
  readonly completionReceipt: ReviewedFile;
  readonly nativeNotices: Readonly<Record<string, Pin>>;
}
export interface PreparedNativeEntry {
  readonly files: ReadonlyMap<string, Buffer>;
  readonly executablePaths: ReadonlySet<string>;
  readonly stableEntry: Buffer;
  readonly metadata: NativeEntryMetadata;
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const digest = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function keys(
  value: unknown,
  expected: string[],
  label: string
): asserts value is Record<string, unknown> {
  if (!object(value) || Object.keys(value).sort().join(',') !== expected.sort().join(','))
    throw new Error(`Invalid ${label} fields`);
}
export function nativeRelative(value: string): string {
  if (
    typeof value !== 'string' ||
    !value ||
    /[\\\0]/.test(value) ||
    path.isAbsolute(value) ||
    value.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new Error(`Invalid native image path: ${String(value)}`);
  return value;
}
function same(a: fs.Stats, b: fs.Stats): boolean {
  return (
    a.isFile() &&
    b.isFile() &&
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mode === b.mode &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs
  );
}
/** Capture regular bytes; receipt-bound artifacts repeat canonical-path observation. */
function capture(file: string, expected?: ReviewedFile): { bytes: Buffer; stat: fs.Stats } {
  if (!path.isAbsolute(file) || path.resolve(file) !== file || fs.realpathSync(file) !== file)
    throw new Error(`Native image input must be canonical and contain no symlink: ${file}`);
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o7022) !== 0)
    throw new Error(`Unsafe native image file or permissions: ${file}`);
  if (expected && before.size !== expected.sizeBytes)
    throw new Error(`Native build artifact size mismatch: ${file}`);
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
  );
  try {
    const opened = fs.fstatSync(fd);
    if (!same(before, opened)) throw new Error(`Replaced native image input: ${file}`);
    // A receipt-bound artifact is read only up to its reviewed size. A growing
    // file must not turn a later hash refusal into an unbounded allocation.
    const bytes = expected ? Buffer.alloc(expected.sizeBytes) : fs.readFileSync(fd);
    if (expected) {
      let offset = 0;
      while (offset < bytes.length) {
        const count = fs.readSync(fd, bytes, offset, bytes.length - offset, null);
        if (count === 0) throw new Error(`Truncated native build artifact: ${file}`);
        offset += count;
      }
    }
    const afterDescriptor = fs.fstatSync(fd);
    const afterPath = fs.lstatSync(file);
    if (
      !same(opened, afterDescriptor) ||
      !same(opened, afterPath) ||
      bytes.length !== opened.size ||
      (expected &&
        (opened.nlink !== 1 ||
          afterDescriptor.nlink !== 1 ||
          afterPath.nlink !== 1 ||
          fs.realpathSync(file) !== file))
    )
      throw new Error(`Changed native image input: ${file}`);
    return { bytes, stat: opened };
  } finally {
    fs.closeSync(fd);
  }
}
function executable(value: Pin, expected?: ReviewedFile): Buffer {
  keys(value, ['source', 'sha256'], 'executable pin');
  if (typeof value.source !== 'string' || !digest(value.sha256))
    throw new Error('Invalid executable pin');
  if (expected && (value.source !== expected.path || value.sha256 !== expected.sha256))
    throw new Error('Native build artifact pin mismatch');
  const captured = capture(value.source, expected);
  if (!(captured.stat.mode & 0o111) || sha(captured.bytes) !== value.sha256)
    throw new Error(`Native executable identity mismatch: ${value.source}`);
  return captured.bytes;
}
function packageRoot(relative: string): boolean {
  return /(?:^|\/)node_modules\/(?:@[^/]+\/)?[^/]+\/package\.json$/.test(relative);
}
function dependencyTarget(
  importer: string,
  name: string,
  packages: Readonly<Record<string, PackageReview>>
): string | null {
  if (
    !/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i.test(name) ||
    name.split('/').some((part) => part === '.' || part === '..')
  )
    throw new Error(`Unsupported dependency name: ${name}`);
  let cursor = importer;
  for (;;) {
    if (path.posix.basename(cursor) !== 'node_modules') {
      const candidate = path.posix.join(cursor, 'node_modules', name);
      if (Object.hasOwn(packages, candidate)) return candidate;
    }
    if (cursor === '.') return null;
    cursor = path.posix.dirname(cursor);
  }
}
export function prepareNativeRuntimeEntry(input: NativeImageInput): PreparedNativeEntry {
  return prepareNativeImage(input);
}

function prepareNativeImage(
  input: NativeImageInput,
  build?: { native: ReviewedFile; stableEntry: ReviewedFile; provenance: Buffer }
): PreparedNativeEntry {
  keys(
    input,
    [
      'schema',
      'prefixRoot',
      'files',
      'packages',
      'omissions',
      'native',
      'node',
      'stableEntry',
      'timeoutMs',
      ...(Object.hasOwn(input, 'stopProfile') ? ['stopProfile'] : []),
    ],
    'native image'
  );
  if (
    input.schema !== 'caws.runtime.native-image-input.v1' ||
    !Number.isSafeInteger(input.timeoutMs) ||
    input.timeoutMs < 1 ||
    input.timeoutMs > 120000 ||
    typeof input.prefixRoot !== 'string' ||
    !path.isAbsolute(input.prefixRoot) ||
    fs.realpathSync(input.prefixRoot) !== input.prefixRoot ||
    !object(input.files) ||
    !object(input.packages) ||
    !object(input.omissions)
  )
    throw new Error('Invalid native image input');
  const captured = new Map<string, Buffer>();
  const modes = new Map<string, number>();
  const visit = (relative: string): void => {
    const source = path.join(input.prefixRoot, relative);
    const stat = fs.lstatSync(source);
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(source).sort())
        visit(relative ? `${relative}/${child}` : child);
    } else {
      nativeRelative(relative);
      const pin = input.files[relative];
      keys(pin, ['sha256', 'mode'], 'native image member');
      if (!digest(pin.sha256) || ![0o644, 0o755].includes(pin.mode as number))
        throw new Error(`Invalid member pin: ${relative}`);
      const { bytes, stat: current } = capture(source); // Reject every link, including .bin; build with npm --bin-links=false.
      if (sha(bytes) !== pin.sha256 || (current.mode & 0o777) !== pin.mode)
        throw new Error(`Native image member mismatch: ${relative}`);
      captured.set(relative, bytes);
      modes.set(relative, pin.mode);
    }
  };
  visit('');
  if (
    Object.keys(input.files).length !== captured.size ||
    Object.keys(input.files).some((p) => !captured.has(nativeRelative(p)))
  )
    throw new Error('Native image inventory is incomplete');
  if (!captured.has('package-lock.json') || !captured.has('package.json'))
    throw new Error('Native production prefix requires its npm lock provenance');
  const lock: unknown = JSON.parse(captured.get('package-lock.json')!.toString('utf8'));
  if (
    !object(lock) ||
    lock.lockfileVersion !== 3 ||
    !object(lock.packages) ||
    !object(lock.packages[''])
  )
    throw new Error('Native production prefix requires an npm v3 package lock');
  const lockedPackages = lock.packages;
  const lockedRoot = lockedPackages[''];
  if (!object(lockedRoot)) throw new Error('Native npm lock root is absent');
  const actualPackages = [...captured.keys()]
    .filter(packageRoot)
    .map((p) => path.posix.dirname(p))
    .sort();
  if (
    actualPackages.join('\n') !== Object.keys(input.packages).map(nativeRelative).sort().join('\n')
  )
    throw new Error('Native image package inventory mismatch');
  if (
    Object.keys(lockedPackages)
      .filter((p) => p !== '')
      .sort()
      .join('\n') !== actualPackages.join('\n')
  )
    throw new Error('Native npm lock package inventory mismatch');
  const equalDeclarations = (a: unknown, b: unknown): boolean => {
    if (!object(a ?? {}) || !object(b ?? {})) return false;
    const sorted = (v: unknown): string =>
      JSON.stringify(
        Object.entries((v ?? {}) as Record<string, unknown>).sort(([x], [y]) => x.localeCompare(y))
      );
    return sorted(a) === sorted(b);
  };
  const prefixPackage: unknown = JSON.parse(captured.get('package.json')!.toString('utf8'));
  if (!object(prefixPackage)) throw new Error('Malformed native prefix package');
  if (
    !object(prefixPackage.dependencies) ||
    Object.keys(prefixPackage.dependencies).join(',') !== '@paths.design/caws-cli' ||
    Object.keys((prefixPackage.optionalDependencies ?? {}) as object).length ||
    Object.keys((prefixPackage.peerDependencies ?? {}) as object).length
  )
    throw new Error('Native prefix must be a standalone CLI production installation');
  for (const kind of ['dependencies', 'optionalDependencies', 'peerDependencies'] as const)
    if (!equalDeclarations(prefixPackage[kind], lockedRoot[kind]))
      throw new Error(`Native npm lock root ${kind} differs`);
  const usedOmissions = new Set<string>();
  const edges = new Map<string, Set<string>>();
  for (const root of actualPackages) {
    const review = input.packages[root]!;
    edges.set(root, new Set());
    keys(review, ['name', 'version', 'licenses'], 'package review');
    const pkg: unknown = JSON.parse(captured.get(`${root}/package.json`)!.toString('utf8'));
    if (
      !object(pkg) ||
      pkg.name !== review.name ||
      pkg.version !== review.version ||
      !Array.isArray(review.licenses) ||
      !review.licenses.length
    )
      throw new Error(`Native package identity/license mismatch: ${root}`);
    const locked = lockedPackages[root];
    if (
      !object(locked) ||
      locked.link !== undefined ||
      locked.version !== pkg.version ||
      (locked.name !== undefined && locked.name !== pkg.name)
    )
      throw new Error(`Native npm lock identity mismatch: ${root}`);
    for (const license of review.licenses)
      if (!captured.has(`${root}/${nativeRelative(license)}`))
        throw new Error(`Native package license is absent: ${root}/${license}`);
    for (const kind of ['dependencies', 'optionalDependencies', 'peerDependencies'] as const) {
      const declarations = pkg[kind] ?? {};
      if (!object(declarations)) throw new Error(`Malformed ${kind}: ${root}`);
      if (!equalDeclarations(declarations, locked[kind]))
        throw new Error(`Native npm lock ${kind} differs: ${root}`);
      for (const [name, declaration] of Object.entries(declarations)) {
        // npm's reviewed production resolution supplies range satisfaction. This
        // reader checks its exact lock/payload agreement, not a substitute semver solver.
        if (
          typeof declaration !== 'string' ||
          !/^[0-9~^<>=*][0-9a-zA-Z*~^<>=|.+ -]*$/.test(declaration)
        )
          throw new Error(`Unsupported dependency declaration: ${root}/${name}`);
        const target = dependencyTarget(root, name, input.packages);
        if (target) {
          if (input.packages[target]?.name !== name)
            throw new Error(`Native dependency identity mismatch: ${root}/${name}`);
          edges.get(root)!.add(target);
          continue;
        }
        const peerMeta =
          object(pkg.peerDependenciesMeta) && object(pkg.peerDependenciesMeta[name])
            ? pkg.peerDependenciesMeta[name]
            : {};
        // npm permits an optionalDependencies entry to override dependencies.
        const optional =
          kind === 'optionalDependencies' ||
          (kind === 'dependencies' &&
            object(pkg.optionalDependencies) &&
            Object.hasOwn(pkg.optionalDependencies, name)) ||
          (kind === 'peerDependencies' && peerMeta.optional === true);
        const key = `${root}:${kind}:${name}`;
        if (!optional || typeof input.omissions[key] !== 'string' || !input.omissions[key]?.trim())
          throw new Error(`Unresolved native runtime dependency: ${key}`);
        usedOmissions.add(key);
      }
    }
  }
  if (Object.keys(input.omissions).some((key) => !usedOmissions.has(key)))
    throw new Error('Unused native dependency omission');
  const cli = 'node_modules/@paths.design/caws-cli';
  if (input.packages[cli]?.name !== '@paths.design/caws-cli')
    throw new Error('Native image must retain the CLI package layout');
  const reachable = new Set<string>();
  const pending = [cli];
  while (pending.length) {
    const member = pending.pop()!;
    if (reachable.has(member)) continue;
    reachable.add(member);
    pending.push(...(edges.get(member) ?? []));
  }
  if (reachable.size !== actualPackages.length)
    throw new Error('Extraneous package in native production prefix');
  for (const relative of [
    'dist/index.js',
    'dist/runtime/engine-entry.js',
    'dist/runtime/describe-entry.js',
    'templates/hook-packs/runtime/bootstrap.py',
  ])
    if (!captured.has(`${cli}/${relative}`))
      throw new Error(`Native CLI entry/asset missing: ${relative}`);
  const files = new Map<string, Buffer>();
  const executablePaths = new Set<string>();
  for (const [relative, bytes] of captured) {
    files.set(`native-prefix/${relative}`, Buffer.from(bytes));
    if (modes.get(relative) === 0o755) executablePaths.add(`native-prefix/${relative}`);
  }
  const metadata: NativeEntryMetadata = {
    schema: NATIVE_ENTRY_SCHEMA,
    nativeExecutable: 'native/caws-native',
    nodeExecutable: 'native/node',
    engineEntry: `native-prefix/${cli}/dist/runtime/engine-entry.js`,
    describeEntry: `native-prefix/${cli}/dist/runtime/describe-entry.js`,
    timeoutMs: input.timeoutMs,
  };
  const binary = (pin: BinaryPin, kind: 'native' | 'node'): Buffer => {
    keys(pin, ['source', 'sha256', 'notices'], `${kind} artifact`);
    if (!object(pin.notices) || !Object.keys(pin.notices).length)
      throw new Error(`Reviewed ${kind} notices are required`);
    for (const [name, notice] of Object.entries(pin.notices)) {
      keys(notice, ['source', 'sha256'], `${kind} notice`);
      if (typeof notice.source !== 'string' || !digest(notice.sha256))
        throw new Error(`Invalid ${kind} notice pin`);
      const bytes = capture(notice.source).bytes;
      if (!bytes.length || sha(bytes) !== notice.sha256)
        throw new Error(`Changed ${kind} notice: ${name}`);
      files.set(`native/licenses/${kind}/${nativeRelative(name)}`, bytes);
    }
    // Notice preservation is mechanical; provenance and coverage are reviewed
    // with the build input. A nonempty notice set is not a legal conclusion.
    return executable(
      { source: pin.source, sha256: pin.sha256 },
      kind === 'native' ? build?.native : undefined
    );
  };
  files.set(metadata.nativeExecutable, binary(input.native, 'native'));
  files.set(metadata.nodeExecutable, binary(input.node, 'node'));
  executablePaths.add(metadata.nativeExecutable);
  executablePaths.add(metadata.nodeExecutable);
  const stableEntry = executable(input.stableEntry, build?.stableEntry);
  files.set('native/caws-hook-native', Buffer.from(stableEntry));
  executablePaths.add('native/caws-hook-native');
  files.set('native-entry.json', Buffer.from(JSON.stringify(metadata)));
  if (build) files.set('native-build-provenance.json', Buffer.from(build.provenance));
  if (Object.hasOwn(input, 'stopProfile')) {
    if (!build) throw new Error('Semantic profile requires reviewed v2 build image');
    files.set('native-stop-profile.json', captureStopProfile(input.stopProfile!, files));
  }
  // Mode closure is ordinary hashed metadata; the writer checks actual published modes.
  files.set('native-modes.json', Buffer.alloc(0));
  files.set(
    'native-modes.json',
    Buffer.from(
      JSON.stringify(
        Object.fromEntries(
          [...files.keys()].sort().map((p) => [p, executablePaths.has(p) ? 0o755 : 0o644])
        )
      )
    )
  );
  return { files, executablePaths, stableEntry, metadata };
}

function validateStopGitDistribution(value: unknown, nativeSha256: string): void {
  keys(
    value,
    [
      'schema',
      'platform',
      'os',
      'inspectorNativeSha256',
      'callerGit',
      'resolver',
      'developerSelector',
      'developerDirectory',
      'developerIdentity',
      'implementation',
      'provenance',
    ],
    'observed Git distribution'
  );
  if (
    value.schema !== 'caws.runtime.stop-git-distribution.v1' ||
    value.platform !== 'macos' ||
    value.inspectorNativeSha256 !== nativeSha256 ||
    !digest(nativeSha256)
  )
    throw new Error('Unsupported observed Git distribution/image');
  const absolute = (p: unknown): p is string =>
    typeof p === 'string' &&
    path.isAbsolute(p) &&
    Buffer.byteLength(p) <= 4096 &&
    !p.includes('\0');
  const integerKeys = [
    'device',
    'inode',
    'bytes',
    'mode',
    'modifiedSeconds',
    'modifiedNanoseconds',
    'changedSeconds',
    'changedNanoseconds',
  ];
  const numeric = (p: Record<string, unknown>, names: string[]): void => {
    for (const k of names) {
      if (k === 'device' || k === 'inode') {
        const text = p[k];
        if (
          typeof text !== 'string' ||
          !/^(0|[1-9][0-9]{0,19})$/.test(text) ||
          BigInt(text) > 18446744073709551615n
        )
          throw new Error('Git filesystem identity must be canonical u64 decimal');
      } else if (!Number.isSafeInteger(p[k]))
        throw new Error('Git observation identity outside finite integer domain');
    }
  };
  for (const label of ['callerGit', 'resolver', 'developerSelector', 'implementation']) {
    const p = value[label];
    keys(p, ['path', 'physicalPath', 'sha256', ...integerKeys], 'Git executable observation');
    if (!absolute(p.path) || !absolute(p.physicalPath) || !digest(p.sha256))
      throw new Error('Invalid Git executable observation');
    numeric(p, integerKeys);
    if (
      (p.bytes as number) <= 0 ||
      (p.mode as number) < 0 ||
      (p.modifiedNanoseconds as number) < 0 ||
      (p.modifiedNanoseconds as number) >= 1e9 ||
      (p.changedNanoseconds as number) < 0 ||
      (p.changedNanoseconds as number) >= 1e9
    )
      throw new Error('Invalid Git executable metadata');
  }
  const resolver = value.resolver as Record<string, unknown>,
    selector = value.developerSelector as Record<string, unknown>;
  if (
    resolver.path !== '/usr/bin/xcrun' ||
    selector.path !== '/usr/bin/xcode-select' ||
    !absolute(value.developerDirectory)
  )
    throw new Error('Invalid fixed Git resolver route');
  const directoryKeys = integerKeys.filter((k) => k !== 'bytes');
  keys(
    value.developerIdentity,
    ['physicalPath', ...directoryKeys],
    'Git developer directory identity'
  );
  if (!absolute(value.developerIdentity.physicalPath))
    throw new Error('Invalid Git developer directory');
  numeric(value.developerIdentity, directoryKeys);
  keys(value.os, ['kernelRelease', 'kernelVersion', 'machine'], 'Git observed OS');
  if (
    Object.values(value.os).some(
      (v) => typeof v !== 'string' || !v || v.length > 4096 || v.includes('\0')
    )
  )
    throw new Error('Invalid Git observed OS');
  keys(
    value.provenance,
    ['authenticator', 'requirements', 'loaderTcb'],
    'Git authentication provenance'
  );
  if (
    value.provenance.authenticator !==
      'Security.framework/SecStaticCodeCheckValidity/all-architectures+strict/no-network' ||
    JSON.stringify(value.provenance.requirements) !==
      JSON.stringify([
        'identifier "com.apple.git" and anchor apple',
        'identifier "com.apple.dt.xcode_select.tool-shim-public" and anchor apple',
        'identifier "com.apple.xcrun" and anchor apple',
        'identifier "com.apple.xcode-select" and anchor apple',
      ]) ||
    JSON.stringify(value.provenance.loaderTcb) !==
      JSON.stringify([
        'macos-platform-loader',
        'apple-code-signing-trust-store',
        'Security.framework',
        'CoreFoundation.framework',
        'CoreServices.framework',
        'libSystem',
        'libz',
        'libiconv',
      ])
  )
    throw new Error('Unsupported Git authentication provenance');
}

/** The installer verifies exact selected implementation bytes. This file is
 * evidence for a later native owner, never permission to enable a Stop route. */
function captureStopProfile(pin: Pin, files: ReadonlyMap<string, Buffer>): Buffer {
  keys(pin, ['source', 'sha256'], 'semantic profile pin');
  if (!digest(pin.sha256)) throw new Error('Invalid semantic profile hash');
  const size = fs.lstatSync(pin.source).size;
  if (!Number.isSafeInteger(size) || size < 1 || size > 8 * 1024 * 1024)
    throw new Error('Semantic profile size bound');
  const observed = capture(pin.source, { path: pin.source, sha256: pin.sha256, sizeBytes: size });
  if (observed.bytes.length > 8 * 1024 * 1024 || sha(observed.bytes) !== pin.sha256)
    throw new Error('Semantic profile size or hash mismatch');
  const profile: unknown = JSON.parse(observed.bytes.toString('utf8'));
  keys(
    profile,
    [
      'schema',
      'surface',
      'event',
      'scope',
      'implementation',
      'selectors',
      'sqliteIdentity',
      'environment',
      'comparison',
      'provenance',
      'remainingJoins',
      ...(object(profile) && profile.schema === 'caws.runtime.stop-semantic-profile.v2'
        ? ['gitDistribution']
        : []),
    ],
    'semantic profile'
  );
  if (
    !['caws.runtime.stop-semantic-profile.v1', 'caws.runtime.stop-semantic-profile.v2'].includes(
      profile.schema as string
    ) ||
    profile.surface !== 'opencode' ||
    profile.event !== 'stop' ||
    profile.scope !== 'controlled-components' ||
    !object(profile.implementation)
  )
    throw new Error('Unsupported semantic profile domain');
  keys(profile.selectors, ['sql', 'renderer'], 'independent semantic selectors');
  for (const category of ['sql', 'renderer'] as const) {
    const selectors = profile.selectors[category];
    if (!Array.isArray(selectors) || selectors.length !== 2)
      throw new Error('Independent semantic selectors required');
    for (const [index, limit] of [4300, 0].entries()) {
      const selector: unknown = selectors[index];
      keys(selector, ['id', 'integerMaxDigits'], 'semantic selector');
      if (
        selector.integerMaxDigits !== limit ||
        selector.id !==
          (category === 'sql'
            ? `cpython-3.11.13-unicode14-int${limit}`
            : `cpython3.11-json/int-max-str-digits:${limit}`)
      )
        throw new Error('Unsupported semantic selector');
    }
  }
  keys(profile.environment, ['tz', 'tzdir', 'integerMaxDigits'], 'semantic environment');
  if (
    profile.environment.tz !== 'UTC0' ||
    profile.environment.tzdir !== 'absent' ||
    JSON.stringify(profile.environment.integerMaxDigits) !== '[4300,0]'
  )
    throw new Error('Unsupported semantic environment');
  keys(profile.comparison, ['receiptSha256', 'driverSha256', 'comparisons'], 'semantic comparison');
  if (
    !digest(profile.comparison.receiptSha256) ||
    !digest(profile.comparison.driverSha256) ||
    !Array.isArray(profile.comparison.comparisons)
  )
    throw new Error('Invalid semantic comparison');
  const sqlCases = [
    'message-int4300',
    'message-int4301',
    'message-negative4300',
    'message-negative4301',
    'part-int4301',
    'message-string4301',
    'message-float4301',
  ];
  const rendererCases = [
    'plain',
    'integer4300',
    'integer4301',
    'negative4301',
    'string4301',
    'float4301',
    'html-literal4301',
    'html-decimal4301',
  ];
  const expectedCases = [4300, 0]
    .flatMap((limit) => [
      ...sqlCases.map((name) => `sql/${limit}/${name}`),
      ...rendererCases.map((name) => `renderer/${limit}/${name}`),
    ])
    .sort();
  const observedCases = profile.comparison.comparisons
    .map((row: unknown) => {
      keys(row, ['id', 'result', 'referenceSha256', 'candidateSha256'], 'semantic comparison row');
      if (
        typeof row.id !== 'string' ||
        row.result !== 'equal' ||
        !digest(row.referenceSha256) ||
        row.candidateSha256 !== row.referenceSha256
      )
        throw new Error('Failed semantic comparison');
      return row.id;
    })
    .sort();
  if (JSON.stringify(observedCases) !== JSON.stringify(expectedCases))
    throw new Error('Incomplete semantic comparison coverage');
  keys(
    profile.sqliteIdentity,
    ['schema', 'version', 'sourceId', 'threadSafe', 'compileOptions', 'compiledPrefixSha256'],
    'semantic SQLite identity'
  );
  if (
    profile.sqliteIdentity.schema !== 'caws.sqlite_build_identity.v1' ||
    typeof profile.sqliteIdentity.version !== 'string' ||
    !profile.sqliteIdentity.version ||
    typeof profile.sqliteIdentity.sourceId !== 'string' ||
    !profile.sqliteIdentity.sourceId ||
    ![0, 1, 2].includes(profile.sqliteIdentity.threadSafe as number) ||
    !digest(profile.sqliteIdentity.compiledPrefixSha256) ||
    !Array.isArray(profile.sqliteIdentity.compileOptions) ||
    !profile.sqliteIdentity.compileOptions.length ||
    profile.sqliteIdentity.compileOptions.some(
      (v: unknown) => typeof v !== 'string' || !v || v.includes('\0')
    )
  )
    throw new Error('Invalid semantic SQLite identity');
  keys(
    profile.provenance,
    ['referenceMode', 'referenceAdapterSha256', 'referenceSharedInventorySha256', 'corpusSha256'],
    'semantic provenance'
  );
  if (
    profile.provenance.referenceMode !== 'controlled-no-site-explicit-X' ||
    profile.provenance.referenceAdapterSha256 !==
      '074dcc4c9880758ea9bfc092612034bff7f78b7d07bed2b4331e02d5916171a9' ||
    profile.provenance.referenceSharedInventorySha256 !==
      '9976411f31abc0c6249433c79a45e6e556901ebcc9ae948218416fc9a92eaad8' ||
    profile.provenance.corpusSha256 !==
      'e9d9303ec7ce77dc15260aceadfa8392c7b2dbd5b3c70803354cedec6e097d19'
  )
    throw new Error('Unsupported semantic provenance');
  const remaining = [
    'native-calendar-original-environment',
    'bundled-engine-dispatch-equivalence',
    'native-selection-prefix-and-queued-peer-admission',
    'ordinary-publication-reopened-consumer-and-release',
    'ambient-legacy-startup-equivalence',
    'other-supported-surfaces',
  ];
  if (JSON.stringify(profile.remainingJoins) !== JSON.stringify(remaining))
    throw new Error('Semantic evidence must preserve remaining joins');
  const implementation = (relative: string): boolean =>
    relative.startsWith('native-prefix/') ||
    relative.startsWith('native/') ||
    ['native-entry.json', 'native-build-provenance.json'].includes(relative);
  const expected = Object.fromEntries(
    [...files]
      .filter(([name]) => implementation(name))
      .map(([name, bytes]) => [name, sha(bytes)])
      .sort(([a], [b]) => (a! < b! ? -1 : a! > b! ? 1 : 0))
  );
  const actual = Object.fromEntries(
    Object.entries(profile.implementation)
      .map(([name, hash]) => {
        nativeRelative(name);
        if (!digest(hash) || !implementation(name))
          throw new Error('Invalid semantic implementation member');
        return [name, hash];
      })
      .sort(([a], [b]) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0))
  );
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error('Semantic profile implementation differs from selected image');
  if (profile.schema === 'caws.runtime.stop-semantic-profile.v2') {
    const nativeDigest = expected['native/caws-native'];
    if (typeof nativeDigest !== 'string')
      throw new Error('Git observation requires native implementation identity');
    validateStopGitDistribution(profile.gitDistribution, nativeDigest);
  }
  // The native loader validates fixed coverage/selectors/SQLite/environment on
  // the authenticated bytes. Installation never treats successful inclusion as
  // earned end-to-end qualification, and never follows provenance paths.
  return Buffer.from(observed.bytes);
}

function reviewedFile(value: unknown, label: string): asserts value is ReviewedFile {
  keys(value, ['path', 'sizeBytes', 'sha256'], label);
  if (
    typeof value.path !== 'string' ||
    !path.isAbsolute(value.path) ||
    path.resolve(value.path) !== value.path ||
    typeof value.sizeBytes !== 'number' ||
    !Number.isSafeInteger(value.sizeBytes) ||
    value.sizeBytes < 1 ||
    value.sizeBytes > 256 * 1024 * 1024 ||
    !digest(value.sha256)
  )
    throw new Error(`Invalid ${label}`);
}

function sameReviewedFile(a: ReviewedFile, b: ReviewedFile): boolean {
  return a.path === b.path && a.sizeBytes === b.sizeBytes && a.sha256 === b.sha256;
}

/** Capture the selected receipt's artifacts. The installer owns publication. */
export function prepareNativeRuntimeEntryFromBuild(
  input: NativeBuildImageInput
): PreparedNativeEntry {
  keys(
    input,
    [
      'schema',
      'prefixRoot',
      'files',
      'packages',
      'omissions',
      'node',
      'timeoutMs',
      'requestFile',
      'completionReceipt',
      'nativeNotices',
      ...(Object.hasOwn(input, 'stopProfile') ? ['stopProfile'] : []),
    ],
    'native build image'
  );
  if (input.schema !== 'caws.runtime.native-image-input.v2')
    throw new Error('Invalid native build image schema');
  reviewedFile(input.requestFile, 'selected build request');
  reviewedFile(input.completionReceipt, 'selected completion receipt');
  const loaded = loadNativeSqliteBuildWithStableEntry(input.requestFile.path);
  if (
    !sameReviewedFile(input.requestFile, loaded.requestFile) ||
    !sameReviewedFile(input.completionReceipt, loaded.completionReceipt)
  )
    throw new Error('Native build selection identity mismatch');
  const { native, stableEntry } = loaded.build.artifacts;
  reviewedFile(native, 'native build artifact');
  reviewedFile(stableEntry, 'stable entry build artifact');
  const identity = (pin: ReviewedFile) => ({ sizeBytes: pin.sizeBytes, sha256: pin.sha256 });
  const provenance = Buffer.from(
    JSON.stringify({
      schema: 'caws.runtime.native-build-provenance.v1',
      requestFile: identity(loaded.requestFile),
      completionReceipt: identity(loaded.completionReceipt),
      requestDigest: loaded.build.requestDigest,
      sourceTreeDigest: loaded.build.sourceTreeDigest,
      profile: loaded.build.profile,
      artifacts: { native: identity(native), stableEntry: identity(stableEntry) },
    })
  );
  return prepareNativeImage(
    {
      schema: 'caws.runtime.native-image-input.v1',
      prefixRoot: input.prefixRoot,
      files: input.files,
      packages: input.packages,
      omissions: input.omissions,
      native: { source: native.path, sha256: native.sha256, notices: input.nativeNotices },
      node: input.node,
      stableEntry: { source: stableEntry.path, sha256: stableEntry.sha256 },
      timeoutMs: input.timeoutMs,
      ...(Object.hasOwn(input, 'stopProfile') ? { stopProfile: input.stopProfile! } : {}),
    },
    { native, stableEntry, provenance }
  );
}

export function readNativeImage(file: string): PreparedNativeEntry {
  const input: unknown = JSON.parse(capture(path.resolve(file)).bytes.toString('utf8'));
  return object(input) && input.schema === 'caws.runtime.native-image-input.v2'
    ? prepareNativeRuntimeEntryFromBuild(input as unknown as NativeBuildImageInput)
    : prepareNativeRuntimeEntry(input as NativeImageInput);
}
