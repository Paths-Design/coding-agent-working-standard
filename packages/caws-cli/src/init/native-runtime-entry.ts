/** Prepare an explicit local native image. Publication belongs to the runtime transaction.
 * The input inventory pins reviewed bytes; deriving it is a separate build/review operation.
 * No npm command, input program, or network request is executed here.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { sha } from './machine-runtime-state';

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
  readonly timeoutMs: number;
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
/** Ancestors, descriptor identity, and the final path must name the same regular input. */
function capture(file: string): { bytes: Buffer; stat: fs.Stats } {
  if (!path.isAbsolute(file) || path.resolve(file) !== file || fs.realpathSync(file) !== file)
    throw new Error(`Native image input must be canonical and contain no symlink: ${file}`);
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o7022) !== 0)
    throw new Error(`Unsafe native image file or permissions: ${file}`);
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
  );
  try {
    const opened = fs.fstatSync(fd);
    if (!same(before, opened)) throw new Error(`Replaced native image input: ${file}`);
    const bytes = fs.readFileSync(fd);
    if (
      !same(opened, fs.fstatSync(fd)) ||
      !same(opened, fs.lstatSync(file)) ||
      bytes.length !== opened.size
    )
      throw new Error(`Changed native image input: ${file}`);
    return { bytes, stat: opened };
  } finally {
    fs.closeSync(fd);
  }
}
function executable(value: Pin): Buffer {
  keys(value, ['source', 'sha256'], 'executable pin');
  if (typeof value.source !== 'string' || !digest(value.sha256))
    throw new Error('Invalid executable pin');
  const captured = capture(value.source);
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
    return executable({ source: pin.source, sha256: pin.sha256 });
  };
  files.set(metadata.nativeExecutable, binary(input.native, 'native'));
  files.set(metadata.nodeExecutable, binary(input.node, 'node'));
  executablePaths.add(metadata.nativeExecutable);
  executablePaths.add(metadata.nodeExecutable);
  const stableEntry = executable(input.stableEntry);
  files.set('native/caws-hook-native', Buffer.from(stableEntry));
  executablePaths.add('native/caws-hook-native');
  files.set('native-entry.json', Buffer.from(JSON.stringify(metadata)));
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

export function readNativeImage(file: string): PreparedNativeEntry {
  return prepareNativeRuntimeEntry(
    JSON.parse(capture(path.resolve(file)).bytes.toString('utf8')) as NativeImageInput
  );
}
