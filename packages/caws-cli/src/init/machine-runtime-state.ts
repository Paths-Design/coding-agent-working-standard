import {
  liveSelectionReadIo,
  type SelectionReadIo,
  type SelectionRuntimeFile,
} from './selection-read-io';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { assertMachinePath } from './machine-paths';

export interface RuntimePointer {
  version: 1;
  digest: string;
  previous_digest: string | null;
}

export interface NativeEntryFileIdentity {
  readonly sha256: string;
  readonly bytes: Buffer;
  readonly mode: number;
}

export interface RetainedNativeEntryIdentity {
  readonly digest: string;
  readonly sha256: string;
  readonly bytes: Buffer;
}

export const sha = (bytes: Buffer | string): string =>
  createHash('sha256').update(bytes).digest('hex');
const validDigest = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const pointerPath = (home: string): string => path.join(home, 'state/adapter-runtime.json');

/** Never block on a special file substituted into a selected generation. */
function captureRuntimeFile(file: string, singleLink = false): SelectionRuntimeFile {
  return liveSelectionReadIo.readRuntimeFile(file, singleLink);
}
function readRuntimeFile(file: string, io: SelectionReadIo = liveSelectionReadIo): Buffer {
  return io.readRuntimeFile(file).bytes;
}

/** Capture an entry under machine-home custody. Mode repair belongs only to
 * the explicit installer after it recognizes these captured bytes. */
export function readNativeEntryFileIdentity(home: string, file: string): NativeEntryFileIdentity {
  if (!path.isAbsolute(home) || !path.isAbsolute(file))
    throw new Error('Native entry capture requires absolute machine paths');
  assertMachinePath(home, file);
  const { bytes, stat } = captureRuntimeFile(file, true);
  assertMachinePath(home, file);
  return { sha256: sha(bytes), bytes, mode: stat.mode & 0o7777 };
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

export function readManifest(
  home: string,
  digest: string,
  io: SelectionReadIo = liveSelectionReadIo
): Record<string, string> {
  if (!validDigest(digest)) throw new Error('Invalid runtime digest');
  const root = path.join(home, 'lib/runtimes', digest);
  assertMachinePath(home, path.join(root, 'manifest.json'), io);
  const manifest = readRuntimeFile(path.join(root, 'manifest.json'), io).toString('utf8');
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

function validateRuntimeRelative(relative: unknown): asserts relative is string {
  if (
    typeof relative !== 'string' ||
    !relative ||
    /[\\\0]/.test(relative) ||
    path.isAbsolute(relative) ||
    relative.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new Error(`Invalid machine runtime path: ${String(relative)}`);
}

function parseNativeEntryMetadata(
  bytes: Buffer,
  files: Record<string, string>
): Record<string, unknown> {
  const metadata: unknown = JSON.parse(bytes.toString('utf8'));
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
    validateRuntimeRelative(relative);
    if (!Object.hasOwn(files, relative) || !validDigest(files[relative]))
      throw new Error(`Native entry asset absent: ${key}`);
  }
  return entry;
}

/** Manifest-bound entry identity under machine-home custody, not authenticated
 * publication history. Unselected generation payload is not consumed here. */
export function readRetainedNativeEntryIdentity(
  home: string,
  digest: string
): RetainedNativeEntryIdentity {
  const files = readManifest(home, digest);
  const root = path.join(home, 'lib/runtimes', digest);
  assertMachinePath(home, path.join(root, 'manifest.json'));
  for (const [relative, expected] of Object.entries(files)) {
    validateRuntimeRelative(relative);
    if (!validDigest(expected))
      throw new Error(`Invalid retained runtime member hash: ${relative}`);
  }
  if (!files['native-entry.json'] || !files['native/caws-hook-native'])
    throw new Error('Retained generation lacks native entry identity');
  const metadataFile = path.join(root, 'native-entry.json');
  assertMachinePath(home, metadataFile);
  const metadataBytes = readRuntimeFile(metadataFile);
  assertMachinePath(home, metadataFile);
  if (sha(metadataBytes) !== files['native-entry.json'])
    throw new Error('Retained native entry metadata integrity failure');
  parseNativeEntryMetadata(metadataBytes, files);
  const entry = readNativeEntryFileIdentity(home, path.join(root, 'native/caws-hook-native'));
  if (entry.mode !== 0o755) throw new Error('Retained native entry mode mismatch');
  if (entry.sha256 !== files['native/caws-hook-native'])
    throw new Error('Retained native entry integrity failure');
  return { digest, sha256: entry.sha256, bytes: entry.bytes };
}

export function verifyRuntime(
  home: string,
  digest: string,
  io: SelectionReadIo = liveSelectionReadIo
): Record<string, string> {
  return io.verifyRuntime
    ? io.verifyRuntime(home, digest, verifyRuntimeUncached)
    : verifyRuntimeUncached(home, digest, io);
}
function verifyRuntimeUncached(
  home: string,
  digest: string,
  io: SelectionReadIo
): Record<string, string> {
  const files = readManifest(home, digest, io);
  const root = path.join(home, 'lib/runtimes', digest);
  for (const [relative, expected] of Object.entries(files)) {
    validateRuntimeRelative(relative);
    const file = path.join(root, relative);
    assertMachinePath(root, file, io);
    if (
      !validDigest(expected) ||
      (io.runtimeFileDigest ? io.runtimeFileDigest(file) : sha(readRuntimeFile(file, io))) !==
        expected
    ) {
      throw new Error(
        `Machine runtime file modified: ${relative}; preserve and reconcile local growth before updating`
      );
    }
  }
  if (files['native-entry.json']) verifyNativeLayout(root, files, io);
  else {
    try {
      io.lstat(path.join(root, 'native-entry.json'));
      throw new Error('Untracked native metadata cannot select legacy compatibility');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return files;
}

/** Native generations add full inventory and mode closure to the v1 raw manifest. */
function verifyNativeLayout(
  root: string,
  files: Record<string, string>,
  io: SelectionReadIo
): void {
  if (!files['native-modes.json'] || !files['native/caws-hook-native'])
    throw new Error('Native generation lacks mode/entry identity');
  const modes: unknown = JSON.parse(
    readRuntimeFile(path.join(root, 'native-modes.json'), io).toString('utf8')
  );
  if (!modes || typeof modes !== 'object' || Array.isArray(modes))
    throw new Error('Malformed native mode inventory');
  const expected = Object.keys(files).sort();
  if (Object.keys(modes).sort().join('\n') !== expected.join('\n'))
    throw new Error('Native mode inventory differs from manifest');
  const actual: string[] = [];
  const visit = (directory: string, prefix: string): void => {
    for (const entry of [...io.readDirectory(directory)].sort()) {
      const relative = prefix + entry;
      const file = path.join(directory, entry);
      const stat = io.lstat(file);
      if (stat.kind === 'directory') visit(file, relative + '/');
      else {
        if (stat.kind !== 'file' || stat.nlink !== 1)
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
  const entry = parseNativeEntryMetadata(
    readRuntimeFile(path.join(root, 'native-entry.json'), io),
    files
  );
  for (const key of ['nativeExecutable', 'nodeExecutable', 'engineEntry', 'describeEntry']) {
    const relative = entry[key] as string;
    if (
      (key === 'nativeExecutable' || key === 'nodeExecutable') &&
      (modes as Record<string, unknown>)[relative] !== 0o755
    )
      throw new Error(`Native entry asset is not executable: ${key}`);
  }
}
