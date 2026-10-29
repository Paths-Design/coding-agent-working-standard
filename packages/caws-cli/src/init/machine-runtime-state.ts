import {
  liveSelectionReadIo,
  type SelectionReadIo,
  type SelectionRuntimeFile,
  type SelectionRuntimeVerifier,
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

/** Pure shape/path validation for a native-owned generation summary. The
 * digest is bound to original raw manifest bytes by native verification; parsed
 * object serialization cannot reconstruct that byte identity. No IO occurs.
 * This preserves the ordinary verifier's lexical path policy as well as native
 * traversal rules: assertMachinePath also refuses a first '..fixture' segment.
 */
export function validateRuntimeGenerationManifest(
  expectedDigest: string,
  observedDigest: unknown,
  generationRoot: string,
  manifest: unknown
): Record<string, string> {
  if (!validDigest(expectedDigest) || observedDigest !== expectedDigest)
    throw new Error('Native runtime generation digest mismatch');
  if (!path.isAbsolute(generationRoot) || path.resolve(generationRoot) !== generationRoot)
    throw new Error('Native runtime generation root must be absolute and normalized');
  if (
    manifest === null ||
    typeof manifest !== 'object' ||
    Array.isArray(manifest) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(manifest))
  )
    throw new Error('Malformed native runtime generation manifest');
  const files = manifest as Record<string, unknown>;
  for (const required of ['launcher.py', 'native-entry.json'])
    if (!Object.hasOwn(files, required) || !validDigest(files[required]))
      throw new Error('Native runtime generation manifest lacks ' + required);
  const result: Record<string, string> = {};
  for (const [relative, expected] of Object.entries(files)) {
    validateRuntimeRelative(relative);
    const file = path.join(generationRoot, relative);
    const lexical = path.relative(generationRoot, file);
    if (lexical.startsWith('..') || path.isAbsolute(lexical))
      throw new Error('Path escapes root: ' + file);
    if (!validDigest(expected)) throw new Error('Malformed native runtime generation member hash');
    Object.defineProperty(result, relative, {
      value: expected,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return result;
}

/** Identity only: arbitrary callback results cannot borrow the canonical cache. */
export function isCanonicalRuntimeVerifier(verify: SelectionRuntimeVerifier): boolean {
  return verify === verifyRuntimeUncached;
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
    ![
      'describeEntry,engineEntry,nativeExecutable,nodeExecutable,schema,timeoutMs',
      'describeEntry,engineEntry,installedInvocation,nativeExecutable,nodeExecutable,schema,timeoutMs',
    ].includes(Object.keys(metadata).sort().join(','))
  )
    throw new Error('Malformed native entry metadata');
  const entry = metadata as Record<string, unknown>;
  if (
    !['caws.runtime.native-entry.v1', 'caws.runtime.native-entry.v2'].includes(
      entry.schema as string
    ) ||
    Object.hasOwn(entry, 'installedInvocation') !==
      (entry.schema === 'caws.runtime.native-entry.v2') ||
    !Number.isSafeInteger(entry.timeoutMs) ||
    (entry.timeoutMs as number) < 1 ||
    (entry.timeoutMs as number) > (entry.schema === 'caws.runtime.native-entry.v2' ? 30000 : 120000)
  )
    throw new Error('Unsupported native entry schema or timeout');
  if (entry.schema === 'caws.runtime.native-entry.v2') {
    const capability = entry.installedInvocation;
    if (
      !capability ||
      typeof capability !== 'object' ||
      Array.isArray(capability) ||
      Object.keys(capability).sort().join(',') !== 'maxOriginalTimeoutMs,protocol' ||
      (capability as Record<string, unknown>).protocol !== 'invoke-installed-v1' ||
      (capability as Record<string, unknown>).maxOriginalTimeoutMs !== 30000
    )
      throw new Error('Unsupported installed invocation capability');
  }
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

/** Verification-only callers need no returned manifest. Legacy/custom IO keeps
 * its existing verifier hook; only an explicit verification-only hook avoids
 * requesting the copy. Canonical verifier identity stays the same in both paths.
 */
export function ensureRuntimeVerified(
  home: string,
  digest: string,
  io: SelectionReadIo = liveSelectionReadIo
): void {
  if (io.ensureRuntimeVerified) io.ensureRuntimeVerified(home, digest, verifyRuntimeUncached);
  else verifyRuntime(home, digest, io);
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

/** Parse only the exact captured metadata bytes bound by this manifest.
 * A prior pathname hash or an optional IO digest memo cannot vouch for a later
 * live capture. Snapshot IO still returns its same owned immutable observation.
 */
function readManifestMetadata(
  root: string,
  relative: string,
  files: Record<string, string>,
  io: SelectionReadIo
): Buffer {
  validateRuntimeRelative(relative);
  const file = path.join(root, relative);
  assertMachinePath(root, file, io);
  const bytes = readRuntimeFile(file, io);
  assertMachinePath(root, file, io);
  if (!validDigest(files[relative]) || sha(bytes) !== files[relative])
    throw new Error(
      `Machine runtime file modified: ${relative}; preserve and reconcile local growth before updating`
    );
  return bytes;
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
    readManifestMetadata(root, 'native-modes.json', files, io).toString('utf8')
  );
  if (!modes || typeof modes !== 'object' || Array.isArray(modes))
    throw new Error('Malformed native mode inventory');
  const expected = Object.keys(files).sort();
  if (Object.keys(modes).sort().join('\n') !== expected.join('\n'))
    throw new Error('Native mode inventory differs from manifest');
  // Exact file membership also determines every permissible ancestor.
  // Refuse an undeclared empty tree before descending into it, matching the
  // native verifier and the file-map installer's emitted directory closure.
  const directories = new Set<string>();
  for (const relative of expected) {
    for (
      let parent = path.posix.dirname(relative);
      parent !== '.';
      parent = path.posix.dirname(parent)
    )
      directories.add(parent);
  }
  const actual: string[] = [];
  const visit = (directory: string, prefix: string): void => {
    for (const entry of [...io.readDirectory(directory)].sort()) {
      const relative = prefix + entry;
      const file = path.join(directory, entry);
      const stat = io.lstat(file);
      if (stat.kind === 'directory') {
        if (!directories.has(relative))
          throw new Error(`Undeclared native runtime directory: ${relative}`);
        visit(file, relative + '/');
      } else {
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
    readManifestMetadata(root, 'native-entry.json', files, io),
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
