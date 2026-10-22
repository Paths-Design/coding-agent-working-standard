import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { assertMachinePath } from './machine-paths';

export interface RuntimePointer {
  version: 1;
  digest: string;
  previous_digest: string | null;
}

export const sha = (bytes: Buffer | string): string =>
  createHash('sha256').update(bytes).digest('hex');
const validDigest = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const pointerPath = (home: string): string => path.join(home, 'state/adapter-runtime.json');

/** Never block on a special file substituted into a selected generation. */
function readRuntimeFile(file: string): Buffer {
  const before = fs.lstatSync(file);
  if (!before.isFile()) throw new Error(`Runtime member is not a regular file: ${file}`);
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
  );
  try {
    const same = (a: fs.Stats, b: fs.Stats): boolean =>
      a.isFile() &&
      b.isFile() &&
      a.dev === b.dev &&
      a.ino === b.ino &&
      a.size === b.size &&
      a.mode === b.mode &&
      a.mtimeMs === b.mtimeMs &&
      a.ctimeMs === b.ctimeMs;
    const opened = fs.fstatSync(fd);
    if (!same(before, opened)) throw new Error(`Runtime member replaced: ${file}`);
    const bytes = fs.readFileSync(fd);
    if (
      !same(opened, fs.fstatSync(fd)) ||
      !same(opened, fs.lstatSync(file)) ||
      bytes.length !== opened.size
    )
      throw new Error(`Runtime member changed: ${file}`);
    return bytes;
  } finally {
    fs.closeSync(fd);
  }
}

export function readPointer(home: string): RuntimePointer | null {
  const file = pointerPath(home);
  assertMachinePath(home, file);
  if (!fs.existsSync(file)) return null;
  const value = JSON.parse(readRuntimeFile(file).toString('utf8')) as RuntimePointer;
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

export function readManifest(home: string, digest: string): Record<string, string> {
  if (!validDigest(digest)) throw new Error('Invalid runtime digest');
  const root = path.join(home, 'lib/runtimes', digest);
  assertMachinePath(home, path.join(root, 'manifest.json'));
  const manifest = readRuntimeFile(path.join(root, 'manifest.json')).toString('utf8');
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
    if (
      !relative ||
      /[\\\0]/.test(relative) ||
      path.isAbsolute(relative) ||
      relative.split('/').some((part) => !part || part === '.' || part === '..')
    )
      throw new Error(`Invalid machine runtime path: ${relative}`);
    const file = path.join(root, relative);
    assertMachinePath(root, file);
    if (!validDigest(expected) || sha(readRuntimeFile(file)) !== expected) {
      throw new Error(
        `Machine runtime file modified: ${relative}; preserve and reconcile local growth before updating`
      );
    }
  }
  if (files['native-entry.json']) verifyNativeLayout(root, files);
  else if (fs.existsSync(path.join(root, 'native-entry.json')))
    throw new Error('Untracked native metadata cannot select legacy compatibility');
  return files;
}

/** Native generations add full inventory and mode closure to the v1 raw manifest. */
function verifyNativeLayout(root: string, files: Record<string, string>): void {
  if (!files['native-modes.json'] || !files['native/caws-hook-native'])
    throw new Error('Native generation lacks mode/entry identity');
  const modes: unknown = JSON.parse(
    readRuntimeFile(path.join(root, 'native-modes.json')).toString('utf8')
  );
  if (!modes || typeof modes !== 'object' || Array.isArray(modes))
    throw new Error('Malformed native mode inventory');
  const expected = Object.keys(files).sort();
  if (Object.keys(modes).sort().join('\n') !== expected.join('\n'))
    throw new Error('Native mode inventory differs from manifest');
  const actual: string[] = [];
  const visit = (directory: string, prefix: string): void => {
    for (const entry of fs.readdirSync(directory).sort()) {
      const relative = prefix + entry;
      const file = path.join(directory, entry);
      const stat = fs.lstatSync(file);
      if (stat.isDirectory()) visit(file, relative + '/');
      else {
        if (!stat.isFile() || stat.nlink !== 1)
          throw new Error(`Unsupported native runtime member: ${relative}`);
        if (relative === 'manifest.json') {
          if ((stat.mode & 0o7777) !== 0o644) throw new Error('Native manifest mode mismatch');
          continue;
        }
        const mode = (modes as Record<string, unknown>)[relative];
        if (![0o644, 0o755].includes(mode as number) || (stat.mode & 0o7777) !== mode)
          throw new Error(`Native runtime member mode mismatch: ${relative}`);
        actual.push(relative);
      }
    }
  };
  visit(root, '');
  if (actual.sort().join('\n') !== expected.join('\n'))
    throw new Error('Native runtime inventory differs from manifest');
  const metadata: unknown = JSON.parse(
    readRuntimeFile(path.join(root, 'native-entry.json')).toString('utf8')
  );
  if (
    !metadata ||
    typeof metadata !== 'object' ||
    Array.isArray(metadata) ||
    Object.keys(metadata).sort().join(',') !==
      'describeEntry,engineEntry,nativeExecutable,nodeExecutable,schema,timeoutMs'
  )
    throw new Error('Malformed native entry metadata');
  const entry = metadata as Record<string, unknown>;
  if (
    entry.schema !== 'caws.runtime.native-entry.v1' ||
    !Number.isSafeInteger(entry.timeoutMs) ||
    (entry.timeoutMs as number) < 1 ||
    (entry.timeoutMs as number) > 120000
  )
    throw new Error('Unsupported native entry schema or timeout');
  for (const key of ['nativeExecutable', 'nodeExecutable', 'engineEntry', 'describeEntry']) {
    const relative = entry[key];
    if (typeof relative !== 'string' || !Object.hasOwn(files, relative))
      throw new Error(`Native entry asset absent: ${key}`);
    if (
      (key === 'nativeExecutable' || key === 'nodeExecutable') &&
      (modes as Record<string, unknown>)[relative] !== 0o755
    )
      throw new Error(`Native entry asset is not executable: ${key}`);
  }
}
