import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { TextDecoder } from 'node:util';

/** Runtime-owned plumbing only. The adapter must execute Git directly, bound output,
 * reject nonzero exits, and retain the invocation's Git environment (including a
 * commit's temporary GIT_INDEX_FILE). No hook-supplied argv or environment enters it.
 * The authority callback also attests the no-executable-filter closure and that
 * invocationRoot is Native-owned and unavailable to USER writes, including children.
 */
export interface GitPlumbingRequest {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly input?: Buffer;
}
export type GitPlumbingRunner = (request: GitPlumbingRequest) => Buffer;
export interface GitHookTransactionOptions {
  readonly projectRoot: string;
  readonly invocationRoot: string;
  readonly authorizedPaths: readonly string[];
  /** Actual Git callback index; required when the adapter cannot retain Git's env. */
  readonly gitIndexPath?: string;
  readonly git: GitPlumbingRunner;
  readonly assertCanonicalAuthority: () => void;
}
export interface GitHookTransaction {
  readonly indexPath: string;
  readonly objectDirectory: string;
  readonly objectFormat: 'sha1' | 'sha256';
  readonly baselineHash: string;
  readonly authorizedPaths: readonly string[];
  /** A fresh copy for the sealed launcher, AFTER empty-root admission. */
  seedIndex(): Buffer;
}
export interface ValidatedGitHookTransaction {
  readonly rawSnapshotPath: string;
  readonly snapshotPath: string;
  readonly snapshotHash: string;
}
export type GitHookPublicationDisposition =
  | 'not-published'
  | 'objects-may-exist'
  | 'index-published';
export class GitHookTransactionError extends Error {
  constructor(
    message: string,
    readonly disposition: GitHookPublicationDisposition = 'not-published'
  ) {
    super(message);
    this.name = 'GitHookTransactionError';
  }
}
interface FileImage {
  bytes: Buffer;
  mode: string;
}
interface Entry {
  name: string;
  mode: string;
  oid: string;
  stage: number;
  flags: number;
}
interface State {
  options: GitHookTransactionOptions;
  transaction: GitHookTransaction;
  baseline: Buffer;
  baselineIdentity: fs.BigIntStats;
  entries: Entry[];
  initialSources: Map<string, FileImage | null>;
}
interface Candidate {
  state: State;
  bytes: Buffer;
  sources: Map<string, FileImage | null>;
  oids: Map<string, string>;
}
const transactions = new WeakMap<GitHookTransaction, State>();
const candidates = new WeakMap<ValidatedGitHookTransaction, Candidate>();
const MAX_INDEX = 32 * 1024 * 1024;
const MAX_SOURCE = 32 * 1024 * 1024;
const MAX_SOURCE_TOTAL = 64 * 1024 * 1024;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
function refuse(message: string): never {
  throw new GitHookTransactionError(message);
}
function assertAuthority(options: GitHookTransactionOptions): void {
  // TypeScript's void callbacks admit async functions. A pending assertion
  // cannot authorize a synchronous publication transaction.
  const result: unknown = options.assertCanonicalAuthority();
  if (result !== undefined) refuse('Native authority assertion must complete synchronously');
}
function digest(bytes: Buffer, algorithm = 'sha256'): string {
  return createHash(algorithm).update(bytes).digest('hex');
}
function normalized(name: string): string {
  if (
    !name ||
    name.includes('\\') ||
    name.includes('\0') ||
    path.posix.isAbsolute(name) ||
    name
      .split('/')
      .some((part) => !part || part === '.' || part === '..' || /^\.git$/i.test(part)) ||
    name.includes('\r') ||
    name.includes('\n')
  )
    refuse(`Unsupported Git path: ${JSON.stringify(name)}`);
  return name;
}
function parentWithoutAliases(filename: string): void {
  const parent = path.dirname(filename);
  if (fs.realpathSync(parent) !== parent) refuse(`Aliased parent directory: ${parent}`);
}
/** One bounded descriptor read. No follow, no hardlinks, identity and mutation checks. */
function readImage(
  filename: string,
  limit: number
): { bytes: Buffer; mode: number; identity: fs.BigIntStats } {
  parentWithoutAliases(filename);
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    const named = fs.lstatSync(filename, { bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.size > BigInt(limit) ||
      before.dev !== named.dev ||
      before.ino !== named.ino
    )
      refuse(`Unsafe file identity: ${filename}`);
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let count = 0;
    while (count < bytes.length) {
      const n = fs.readSync(fd, bytes, count, bytes.length - count, count);
      if (n === 0) break;
      count += n;
    }
    const after = fs.fstatSync(fd, { bigint: true });
    const finalName = fs.lstatSync(filename, { bigint: true });
    if (
      BigInt(count) !== before.size ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs ||
      after.nlink !== 1n ||
      finalName.dev !== before.dev ||
      finalName.ino !== before.ino
    )
      refuse(`File changed during capture: ${filename}`);
    return { bytes: bytes.subarray(0, count), mode: Number(before.mode), identity: before };
  } finally {
    fs.closeSync(fd);
  }
}
function source(root: string, name: string): FileImage | null {
  const filename = path.join(root, name);
  try {
    const image = readImage(filename, MAX_SOURCE);
    return { bytes: image.bytes, mode: image.mode & 0o111 ? '100755' : '100644' };
  } catch (error) {
    // A missing leaf is an authorized deletion; missing/aliased ancestors are not.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && fs.existsSync(path.dirname(filename)))
      return null;
    throw error;
  }
}
function git(
  state: State,
  argv: readonly string[],
  indexPath = state.transaction.indexPath,
  input?: Buffer
): Buffer {
  return state.options.git({
    argv,
    cwd: state.options.projectRoot,
    env: {
      GIT_INDEX_FILE: indexPath,
      GIT_OBJECT_DIRECTORY: state.transaction.objectDirectory,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: '',
      GIT_OPTIONAL_LOCKS: '0',
    },
    ...(input === undefined ? {} : { input }),
  });
}
function oidOutput(value: Buffer, hashLength: number): string {
  const oid = value.toString('ascii').trim();
  if (!new RegExp(`^[0-9a-f]{${hashLength * 2}}$`).test(oid))
    refuse('Invalid Git object identifier');
  return oid;
}
/** Decode only the index envelope/semantic bits and extension dependencies here;
 * Git itself must independently decode and agree with every entry below.
 * TREE is removed as derived cache; v4 pathname compression, split/sparse
 * indexes, meaningful/unknown extensions refuse rather than lose their state.
 */
function entries(
  state: State,
  bytes: Buffer
): { rows: Entry[]; canonicalBytes: Buffer; snapshotPath: string } {
  const hashLength = state.transaction.objectFormat === 'sha1' ? 20 : 32;
  const end = bytes.length - hashLength;
  if (
    end < 12 ||
    bytes.toString('ascii', 0, 4) !== 'DIRC' ||
    !bytes
      .subarray(end)
      .equals(createHash(state.transaction.objectFormat).update(bytes.subarray(0, end)).digest())
  )
    refuse('Invalid Git index checksum or header');
  const version = bytes.readUInt32BE(4);
  if (version !== 2 && version !== 3) refuse(`Unsupported Git index version: ${version}`);
  const count = bytes.readUInt32BE(8);
  if (count > 250000) refuse('Oversized Git index entry count');
  const result: Entry[] = [];
  const seen = new Set<string>();
  let offset = 12;
  for (let i = 0; i < count; i++) {
    const start = offset;
    if (offset + 42 + hashLength > end) refuse('Truncated Git index entry');
    const mode = bytes.readUInt32BE(offset + 24).toString(8);
    if (!['100644', '100755', '120000', '160000'].includes(mode))
      refuse(`Unsupported Git index mode: ${mode}`);
    const oid = bytes.toString('hex', offset + 40, offset + 40 + hashLength);
    const bits = bytes.readUInt16BE(offset + 40 + hashLength);
    offset += 42 + hashLength;
    let extended = 0;
    if (bits & 0x4000) {
      if (version !== 3 || offset + 2 > end) refuse('Invalid extended index flags');
      extended = bytes.readUInt16BE(offset);
      if (extended & ~0x6000) refuse('Unsupported extended index flags');
      offset += 2;
    }
    const nul = bytes.indexOf(0, offset);
    if (nul < offset || nul >= end) refuse('Unterminated Git index path');
    const name = normalized(utf8.decode(bytes.subarray(offset, nul)));
    const stage = (bits >> 12) & 3;
    const key = `${name}\0${stage}`;
    if (seen.has(key)) refuse(`Duplicate Git index entry: ${name}`);
    seen.add(key);
    const previous = result[result.length - 1];
    if (
      previous &&
      (Buffer.compare(Buffer.from(previous.name), Buffer.from(name)) > 0 ||
        (previous.name === name && previous.stage >= stage))
    )
      refuse('Unsorted Git index entries');
    const length = bytes.subarray(offset, nul).length;
    if ((bits & 0xfff) !== Math.min(length, 0xfff)) refuse('Invalid Git index path length');
    offset = start + Math.ceil((nul + 1 - start) / 8) * 8;
    if (offset > end || bytes.subarray(nul, offset).some((byte) => byte !== 0))
      refuse('Invalid Git index padding');
    result.push({ name, mode, oid, stage, flags: (bits & 0x8000) | (extended << 16) });
  }
  const entriesEnd = offset;
  while (offset < end) {
    if (offset + 8 > end) refuse('Truncated Git index extension');
    const kind = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32BE(offset + 4);
    offset += 8;
    if (offset + size > end) refuse('Truncated Git index extension data');
    if (kind !== 'TREE') refuse(`Unsupported Git index extension: ${kind}`);
    // TREE is a derived cache. Its object may exist yet describe unrelated
    // entries; discard the entire bounded cache rather than trust its claims.
    // No entry bytes/flags or meaningful extensions are normalized away.
    offset += size;
  }
  const body = bytes.subarray(0, entriesEnd);
  const canonicalBytes = Buffer.concat([
    body,
    createHash(state.transaction.objectFormat).update(body).digest(),
  ]);
  const snapshotPath = snapshot(state, canonicalBytes);
  const decoded = git(state, ['ls-files', '--stage', '-z'], snapshotPath);
  const expected = result
    .map((row) => `${row.mode} ${row.oid} ${row.stage}\t${row.name}\0`)
    .join('');
  if (!decoded.equals(Buffer.from(expected)))
    refuse('Git index decoding disagrees with captured entries');
  return { rows: result, canonicalBytes, snapshotPath };
}
function snapshot(state: State, bytes: Buffer): string {
  const filename = path.join(state.options.invocationRoot, `git-index-${randomUUID()}`);
  parentWithoutAliases(filename);
  const fd = fs.openSync(
    filename,
    fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW,
    0o400
  );
  try {
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return filename;
}
export function captureGitHookTransaction(options: GitHookTransactionOptions): GitHookTransaction {
  assertAuthority(options);
  if (
    !path.isAbsolute(options.projectRoot) ||
    fs.realpathSync(options.projectRoot) !== options.projectRoot ||
    !path.isAbsolute(options.invocationRoot) ||
    fs.realpathSync(options.invocationRoot) !== options.invocationRoot
  )
    refuse('Transaction roots must be absolute and unaliased');
  const names = options.authorizedPaths.map(normalized);
  if (names.length > 10000 || new Set(names).size !== names.length)
    refuse('Oversized or duplicate authorized paths');
  if (names.some((name) => name.split('/')[0] === '.caws'))
    refuse('Git transaction cannot select governance metadata');
  const query = (argv: string[]): string =>
    options.git({ argv, cwd: options.projectRoot, env: {} }).toString('utf8').trim();
  const indexPath =
    options.gitIndexPath ?? query(['rev-parse', '--path-format=absolute', '--git-path', 'index']);
  const objectDirectory = query(['rev-parse', '--path-format=absolute', '--git-path', 'objects']);
  const objectFormat = query(['rev-parse', '--show-object-format']);
  if (
    !path.isAbsolute(indexPath) ||
    !path.isAbsolute(objectDirectory) ||
    fs.realpathSync(objectDirectory) !== objectDirectory ||
    (objectFormat !== 'sha1' && objectFormat !== 'sha256')
  )
    refuse('Unsupported Git metadata location or object format');
  const baselineImage = readImage(indexPath, MAX_INDEX);
  const baseline = baselineImage.bytes;
  const transaction: GitHookTransaction = Object.freeze({
    indexPath,
    objectDirectory,
    objectFormat,
    baselineHash: digest(baseline),
    authorizedPaths: Object.freeze([...names]),
    seedIndex: () => Buffer.from(baseline),
  });
  const state: State = {
    options: { ...options, authorizedPaths: names },
    transaction,
    baseline,
    baselineIdentity: baselineImage.identity,
    entries: [],
    initialSources: new Map(),
  };
  snapshot(state, baseline);
  state.entries = entries(state, baseline).rows;
  let sourceBytes = 0;
  for (const name of names) {
    const image = source(options.projectRoot, name);
    sourceBytes += image?.bytes.length ?? 0;
    if (sourceBytes > MAX_SOURCE_TOTAL) refuse('Oversized Source capture');
    state.initialSources.set(name, image);
  }
  transactions.set(transaction, state);
  return transaction;
}
export function validateGitHookTransaction(
  transaction: GitHookTransaction,
  privateIndexPath: string
): ValidatedGitHookTransaction {
  const state = transactions.get(transaction);
  if (!state) refuse('Unknown Git hook transaction');
  assertAuthority(state.options);
  // A detached hook can mutate quarantine indefinitely. Read it exactly once;
  // all decoding and later publication use the sealed copy/in-memory bytes.
  const rawBytes = readImage(path.resolve(privateIndexPath), MAX_INDEX).bytes;
  const rawSnapshotPath = snapshot(state, rawBytes);
  const { rows: selected, canonicalBytes: bytes, snapshotPath } = entries(state, rawBytes);
  const allowed = new Set(transaction.authorizedPaths);
  const outside = (rows: Entry[]): string =>
    JSON.stringify(rows.filter((row) => !allowed.has(row.name)));
  if (outside(selected) !== outside(state.entries))
    refuse('Hook changed staging outside authorized paths');
  const sources = new Map<string, FileImage | null>();
  const oids = new Map<string, string>();
  let sourceBytes = 0;
  for (const name of allowed) {
    const image = source(state.options.projectRoot, name);
    sourceBytes += image?.bytes.length ?? 0;
    if (sourceBytes > MAX_SOURCE_TOTAL) refuse('Oversized Source capture');
    sources.set(name, image);
    const rows = selected.filter((row) => row.name === name);
    if (image === null) {
      if (rows.length) refuse(`Deleted Source remains staged: ${name}`);
      continue;
    }
    if (
      rows.length !== 1 ||
      rows[0]!.stage !== 0 ||
      rows[0]!.flags !== 0 ||
      rows[0]!.mode !== image.mode
    )
      refuse(`Unsupported or mismatched selected staging: ${name}`);
    const oid = oidOutput(
      git(state, ['hash-object', `--path=${name}`, '--stdin'], snapshotPath, image.bytes),
      transaction.objectFormat === 'sha1' ? 20 : 32
    );
    if (rows[0]!.oid !== oid) refuse(`Private staged bytes differ from Source: ${name}`);
    oids.set(name, oid);
  }
  const candidate = Object.freeze({ rawSnapshotPath, snapshotPath, snapshotHash: digest(bytes) });
  candidates.set(candidate, { state, bytes, sources, oids });
  return candidate;
}
export function publishGitHookTransaction(candidate: ValidatedGitHookTransaction): {
  disposition: 'index-published';
  snapshotHash: string;
} {
  const value = candidates.get(candidate);
  if (!value) refuse('Unknown validated Git hook transaction');
  candidates.delete(candidate); // Settlement is single-use, including failed attempts.
  const { state, bytes, sources, oids } = value;
  let disposition: GitHookPublicationDisposition = 'not-published';
  let failure: GitHookTransactionError | undefined;
  let fd: number | undefined;
  const lockPath = `${state.transaction.indexPath}.lock`;
  const unchangedIndex = (): void => {
    const current = readImage(state.transaction.indexPath, MAX_INDEX);
    if (
      current.identity.dev !== state.baselineIdentity.dev ||
      current.identity.ino !== state.baselineIdentity.ino ||
      current.identity.ctimeNs !== state.baselineIdentity.ctimeNs ||
      !current.bytes.equals(state.baseline)
    )
      refuse('Real Git index drifted after capture');
  };
  let identity: fs.BigIntStats | undefined;
  const ownLock = (): boolean => {
    try {
      const named = fs.lstatSync(lockPath, { bigint: true });
      const held = fs.fstatSync(fd!, { bigint: true });
      return (
        named.isFile() &&
        named.nlink === 1n &&
        held.nlink === 1n &&
        named.dev === identity!.dev &&
        named.ino === identity!.ino &&
        held.dev === identity!.dev &&
        held.ino === identity!.ino
      );
    } catch {
      return false;
    }
  };
  try {
    assertAuthority(state.options);
    parentWithoutAliases(lockPath);
    fd = fs.openSync(
      lockPath,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW,
      0o600
    );
    identity = fs.fstatSync(fd, { bigint: true });
    unchangedIndex();
    for (const [name, expected] of sources) {
      const actual = source(state.options.projectRoot, name);
      if (
        (actual === null) !== (expected === null) ||
        (actual &&
          expected &&
          (actual.mode !== expected.mode || !actual.bytes.equals(expected.bytes)))
      )
        refuse(`Source drifted after validation: ${name}`);
    }
    assertAuthority(state.options);
    for (const [name, image] of sources) {
      if (!image) continue;
      if (!ownLock()) refuse('Lost Git index lock ownership');
      disposition = 'objects-may-exist';
      const oid = oidOutput(
        git(
          state,
          ['hash-object', '-w', `--path=${name}`, '--stdin'],
          state.transaction.indexPath,
          image.bytes
        ),
        state.transaction.objectFormat === 'sha1' ? 20 : 32
      );
      if (oid !== oids.get(name))
        refuse(`Published Source object differs from validated object: ${name}`);
    }
    assertAuthority(state.options);
    if (!ownLock()) refuse('Lost Git index lock ownership');
    unchangedIndex();
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    if (!ownLock()) refuse('Lost Git index lock ownership');
    fs.renameSync(lockPath, state.transaction.indexPath);
    disposition = 'index-published';
    const directory = fs.openSync(path.dirname(lockPath), fs.constants.O_RDONLY);
    try {
      fs.fsyncSync(directory);
    } catch (error) {
      failure = new GitHookTransactionError(
        error instanceof Error ? error.message : String(error),
        disposition
      );
    }
    try {
      fs.closeSync(directory);
    } catch (error) {
      failure = new GitHookTransactionError(
        [failure?.message, `Git index directory descriptor close failed: ${String(error)}`]
          .filter((message) => message !== undefined)
          .join('; '),
        disposition
      );
    }
  } catch (error) {
    failure = new GitHookTransactionError(
      error instanceof Error ? error.message : String(error),
      disposition
    );
  } finally {
    if (fd !== undefined) {
      const cleanup: string[] = [];
      try {
        if (ownLock()) fs.unlinkSync(lockPath);
      } catch (error) {
        cleanup.push(`Git index lock cleanup failed: ${String(error)}`);
      }
      try {
        fs.closeSync(fd);
      } catch (error) {
        cleanup.push(`Git index descriptor close failed: ${String(error)}`);
      }
      if (cleanup.length)
        failure = new GitHookTransactionError(
          [failure?.message, ...cleanup].filter((message) => message !== undefined).join('; '),
          disposition
        );
    }
  }
  if (failure) throw failure;
  return { disposition: 'index-published', snapshotHash: candidate.snapshotHash };
}
