import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import { TextDecoder } from 'node:util';
import {
  assertOwnership,
  deriveBindingState,
  parseAndValidatePolicy,
  parseAndValidateSpec,
  validateWorktreeName,
  type BindingState,
  type Policy,
  type Spec,
  type WorktreeRegistry,
} from '../../kernel';
import { parseJsonSource } from '../json-custody';
import type { FileToolContextSnapshot } from './context-port';

const MAX_FILE = 1024 * 1024;
const MAX_TOTAL = 16 * 1024 * 1024;
const MAX_SPECS = 1024;
const MAX_ROWS = 4096;
type Binding = Extract<BindingState, { kind: 'bound' | 'bridged' }>;

export class NativeFileAuthorityError extends Error {
  constructor(reason: string) {
    super('Native file authority refused: ' + reason);
    this.name = 'NativeFileAuthorityError';
  }
}

export interface NativeFileAuthorityInput {
  readonly context: FileToolContextSnapshot;
  /** Original native callback identity. No environment/capsule fallback. */
  readonly originalSessionId: string;
  readonly surface: 'claude-code';
  /** Original invocation budget/cancellation check; supplies no authority. */
  readonly checkpoint: () => void;
}

export interface NativeFileBridge {
  readonly session_id: string;
  readonly platform?: string;
  readonly acquired_at: string;
}

export interface NativeFileAuthority {
  readonly checkout: string;
  readonly canonical: string;
  readonly originalSessionId: string;
  readonly surface: 'claude-code';
  /** Actual bound checkout, or canonical root for an existing bridge. */
  readonly ownedRoot: string;
  readonly policy: Policy;
  readonly binding: Binding;
  readonly registry: WorktreeRegistry;
  readonly specs: readonly Spec[];
  readonly bridges: Readonly<Record<string, NativeFileBridge>>;
  readonly revision: string;
  /**
   * Call synchronously after delivered context observation 3 and immediately
   * before proposal egress. This performs no effects and repeats no strikes.
   */
  assertCurrent(freshNativeSnapshot: FileToolContextSnapshot): void;
}

function need(value: unknown, reason: string): asserts value {
  if (!value) throw new NativeFileAuthorityError(reason);
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function text(value: unknown, maximum = 4096): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value) <= maximum &&
    !value.includes('\0') &&
    Buffer.from(value, 'utf8').toString('utf8') === value
  );
}
function originalSession(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[A-Za-z0-9_.-]{1,128}$/.test(value) &&
    value !== 'unknown' &&
    value !== '.' &&
    value !== '..'
  );
}
function recordedSession(value: unknown): value is string {
  // Other authority owners remain opaque identities. Never sanitize them.
  return text(value) && value.trim().length > 0;
}
function checked<T>(checkpoint: () => void, operation: () => T): T {
  checkpoint();
  const result = operation();
  checkpoint();
  return result;
}
function absolute(value: unknown): asserts value is string {
  need(text(value) && isAbsolute(value) && normalize(value) === value, 'invalid physical path');
}
function inside(root: string, file: string): boolean {
  return file === root || file.startsWith(root.endsWith('/') ? root : root + '/');
}
function sha(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function utf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
}
function json(bytes: Uint8Array): Record<string, unknown> {
  const source = utf8(bytes);
  parseJsonSource(source, 32, 100_000, true);
  const value: unknown = JSON.parse(source);
  need(object(value), 'authority JSON is not an object');
  return value;
}
function absent(error: unknown): boolean {
  return object(error) && error.code === 'ENOENT';
}
function directoryIdentity(stat: fs.BigIntStats): string {
  // Operational children may change .caws timestamps, size and link count.
  return [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid].join(':');
}
function fileIdentity(stat: fs.BigIntStats): string {
  return [
    stat.dev,
    stat.ino,
    stat.mode,
    stat.uid,
    stat.gid,
    stat.nlink,
    stat.size,
    stat.mtimeNs,
    stat.ctimeNs,
  ].join(':');
}
function physicalDirectory(file: string): string {
  absolute(file);
  const before = fs.lstatSync(file, { bigint: true });
  need(before.isDirectory(), 'directory is missing, redirected or nonregular');
  need(fs.realpathSync.native(file) === file, 'aliased authority directory');
  const after = fs.lstatSync(file, { bigint: true });
  need(
    after.isDirectory() && directoryIdentity(before) === directoryIdentity(after),
    'directory identity changed during capture'
  );
  return directoryIdentity(after);
}

interface FileImage {
  readonly bytes: Buffer;
  readonly identity: string;
  readonly sha256: string;
}
function fileImage(file: string, limit: number, checkpoint: () => void): FileImage {
  checkpoint();
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
  );
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    const named = fs.lstatSync(file, { bigint: true });
    need(
      before.isFile() &&
        named.isFile() &&
        before.nlink === 1n &&
        before.size <= BigInt(limit) &&
        fileIdentity(before) === fileIdentity(named),
      'unsafe or oversized authority file'
    );
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    while (length < buffer.length) {
      checkpoint();
      const count = fs.readSync(fd, buffer, length, buffer.length - length, length);
      checkpoint();
      if (count === 0) break;
      length += count;
    }
    const after = fs.fstatSync(fd, { bigint: true });
    const finalName = fs.lstatSync(file, { bigint: true });
    need(
      BigInt(length) === before.size &&
        fileIdentity(before) === fileIdentity(after) &&
        fileIdentity(before) === fileIdentity(finalName),
      'authority file changed during capture'
    );
    const bytes = buffer.subarray(0, length);
    return checked(checkpoint, () => ({
      bytes,
      identity: fileIdentity(before),
      sha256: sha(bytes),
    }));
  } finally {
    fs.closeSync(fd);
  }
}

class ReadSet {
  private readonly directories = new Map<string, string>();
  private readonly files = new Map<string, FileImage>();
  private readonly missing = new Set<string>();
  private readonly inventories = new Map<string, readonly string[]>();
  private total = 0;
  constructor(private readonly checkpoint: () => void) {}

  directory(file: string): void {
    const identity = checked(this.checkpoint, () => physicalDirectory(file));
    const previous = this.directories.get(file);
    need(previous === undefined || previous === identity, 'directory replaced during capture');
    this.directories.set(file, identity);
  }
  private absence(file: string): void {
    this.checkpoint();
    try {
      fs.lstatSync(file);
    } catch (error) {
      if (absent(error)) {
        this.missing.add(file);
        this.checkpoint();
        return;
      }
      throw error;
    }
    throw new NativeFileAuthorityError('optional authority path is present but unreadable');
  }
  optionalDirectory(file: string): boolean {
    try {
      this.directory(file);
      return true;
    } catch (error) {
      if (!absent(error)) throw error;
      this.absence(file);
      return false;
    }
  }
  read(file: string): Buffer {
    this.checkpoint();
    this.directory(dirname(file));
    const previous = this.files.get(file);
    if (previous) return previous.bytes;
    const image = fileImage(file, Math.min(MAX_FILE, MAX_TOTAL - this.total), this.checkpoint);
    this.total += image.bytes.length;
    need(this.total <= MAX_TOTAL, 'authority read set exceeds byte bound');
    this.files.set(file, image);
    return image.bytes;
  }
  optional(file: string): Buffer | null {
    try {
      return this.read(file);
    } catch (error) {
      if (!absent(error)) throw error;
      this.absence(file);
      return null;
    }
  }
  inventory(directory: string): readonly string[] {
    this.directory(directory);
    const names = checked(this.checkpoint, () => fs.readdirSync(directory).sort());
    need(names.length <= MAX_ROWS, 'authority inventory exceeds entry bound');
    this.inventories.set(directory, names);
    return names;
  }
  finish(nativeKey: string): string {
    const verifyNamespaces = (): void => {
      this.checkpoint();
      for (const [file, identity] of this.directories)
        need(
          checked(this.checkpoint, () => physicalDirectory(file)) === identity,
          'authority directory replaced'
        );
      for (const file of this.missing) this.absence(file);
      for (const [directory, names] of this.inventories)
        need(
          checked(this.checkpoint, () => JSON.stringify(fs.readdirSync(directory).sort())) ===
            JSON.stringify(names),
          'authority inventory changed'
        );
      this.checkpoint();
    };
    verifyNamespaces();
    for (const [file, image] of this.files) {
      const fresh = fileImage(file, image.bytes.length, this.checkpoint);
      need(
        fresh.identity === image.identity && fresh.sha256 === image.sha256,
        'consumed authority file changed'
      );
    }
    // File verification can span substantial reads. Recheck the consumed
    // namespace after those reads; this remains a checked capture window,
    // not an atomic filesystem operation.
    verifyNamespaces();
    const rows: unknown[] = [['native-context', nativeKey]];
    for (const [file, identity] of [...this.directories].sort())
      rows.push(['directory', file, identity]);
    for (const file of [...this.missing].sort()) rows.push(['absent', file]);
    for (const [directory, names] of [...this.inventories].sort())
      rows.push(['inventory', directory, names]);
    for (const [file, image] of [...this.files].sort())
      rows.push(['file', file, image.identity, image.sha256]);
    return checked(this.checkpoint, () => sha(Buffer.from(JSON.stringify(rows))));
  }
}

function nativeSnapshot(
  value: FileToolContextSnapshot,
  checkpoint: () => void
): FileToolContextSnapshot {
  checkpoint();
  need(object(value), 'missing native context');
  for (const file of [value.checkout, value.canonical, value.gitDir, value.commonDir])
    absolute(file);
  need(
    text(value.branch) &&
      typeof value.mergeInProgress === 'boolean' &&
      Array.isArray(value.worktrees) &&
      value.worktrees.length > 0 &&
      value.worktrees.length <= MAX_ROWS,
    'unresolved native branch or worktree inventory'
  );
  const seen = new Set<string>();
  const worktrees = value.worktrees
    .map((entry) => {
      checkpoint();
      need(object(entry), 'malformed native worktree');
      absolute(entry.path);
      need(
        !seen.has(entry.path) &&
          (entry.branch === null || text(entry.branch)) &&
          typeof entry.detached === 'boolean' &&
          typeof entry.prunable === 'boolean' &&
          typeof entry.bare === 'boolean' &&
          (!entry.detached || entry.branch === null) &&
          (!entry.bare || (entry.branch === null && !entry.detached)),
        'ambiguous native worktree inventory'
      );
      seen.add(entry.path);
      return {
        path: entry.path,
        branch: entry.branch,
        detached: entry.detached,
        prunable: entry.prunable,
        bare: entry.bare,
      };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const canonical = worktrees.find((entry) => entry.path === value.canonical);
  need(canonical && !canonical.bare, 'bare canonical context is unsupported');
  const checkout = worktrees.find((entry) => entry.path === value.checkout);
  need(
    checkout &&
      !checkout.detached &&
      !checkout.prunable &&
      !checkout.bare &&
      checkout.branch === 'refs/heads/' + value.branch &&
      worktrees.some((entry) => entry.path === value.canonical && !entry.bare && !entry.prunable),
    'native checkout, branch and inventory disagree'
  );
  return freeze({
    checkout: value.checkout,
    canonical: value.canonical,
    gitDir: value.gitDir,
    commonDir: value.commonDir,
    branch: value.branch,
    mergeInProgress: value.mergeInProgress,
    worktrees,
  });
}

function bridges(bytes: Buffer | null, checkpoint: () => void): Record<string, NativeFileBridge> {
  const value = bytes === null ? {} : checked(checkpoint, () => json(bytes));
  need(Object.keys(value).length <= MAX_ROWS, 'bridge inventory exceeds entry bound');
  for (const entry of Object.values(value)) {
    checkpoint();
    need(
      object(entry) &&
        recordedSession(entry.session_id) &&
        text(entry.acquired_at, 128) &&
        (entry.platform === undefined || text(entry.platform, 128)),
      'malformed bridge authority'
    );
  }
  return value as unknown as Record<string, NativeFileBridge>;
}

interface Captured {
  readonly ownedRoot: string;
  readonly policy: Policy;
  readonly binding: Binding;
  readonly registry: WorktreeRegistry;
  readonly specs: readonly Spec[];
  readonly bridges: Readonly<Record<string, NativeFileBridge>>;
  readonly revision: string;
}

function capture(
  native: FileToolContextSnapshot,
  originalSessionId: string,
  surface: 'claude-code',
  checkpoint: () => void
): Captured {
  checkpoint();
  const reads = new ReadSet(checkpoint);
  for (const file of [native.checkout, native.canonical, native.gitDir, native.commonDir])
    reads.directory(file);
  const caws = join(native.canonical, '.caws');
  reads.directory(caws);
  const parsedPolicy = checked(checkpoint, () =>
    parseAndValidatePolicy(utf8(reads.read(join(caws, 'policy.yaml'))))
  );
  need(parsedPolicy.ok, 'invalid canonical policy');
  const registryObject = checked(checkpoint, () => json(reads.read(join(caws, 'worktrees.json'))));
  need(Object.keys(registryObject).length <= MAX_ROWS, 'registry exceeds entry bound');
  const specsDirectory = join(caws, 'specs');
  const names = reads.inventory(specsDirectory).filter((name) => /\.ya?ml$/.test(name));
  need(names.length > 0 && names.length <= MAX_SPECS, 'missing or oversized spec inventory');
  const specs: Spec[] = [];
  const ids = new Set<string>();
  for (const name of names) {
    const parsed = checked(checkpoint, () =>
      parseAndValidateSpec(utf8(reads.read(join(specsDirectory, name))))
    );
    need(parsed.ok, 'invalid canonical spec');
    need(!ids.has(parsed.value.id), 'duplicate canonical spec identity');
    ids.add(parsed.value.id);
    specs.push(parsed.value);
  }
  const claims = join(caws, 'claims');
  const bridgeRegistry = bridges(
    reads.optionalDirectory(claims) ? reads.optional(join(claims, 'bridge.json')) : null,
    checkpoint
  );
  const roots: { name: string; path: string; specId?: string }[] = [];
  const occupied = new Set<string>();
  for (const [name, value] of Object.entries(registryObject)) {
    checkpoint();
    need(validateWorktreeName(name).ok && object(value), 'malformed worktree authority row');
    for (const field of ['specId', 'branch', 'path', 'baseBranch'])
      need(value[field] === undefined || text(value[field]), 'malformed worktree authority field');
    if (value.owner !== undefined)
      need(
        object(value.owner) &&
          recordedSession(value.owner.session_id) &&
          (value.owner.platform === undefined || text(value.owner.platform, 128)),
        'malformed worktree owner'
      );
    need(
      value.status === undefined ||
        (typeof value.status === 'string' &&
          ['active', 'destroyed', 'missing'].includes(value.status)),
      'unknown worktree authority state'
    );
    if (value.status === 'destroyed' || value.status === 'missing') continue;
    absolute(value.path);
    need(text(value.branch), 'missing registered branch');
    reads.directory(value.path);
    need(value.path !== native.canonical, 'registered worktree equals canonical root');
    need(
      !roots.some(
        (entry) =>
          inside(entry.path, value.path as string) || inside(value.path as string, entry.path)
      ),
      'overlapping registered worktree roots'
    );
    const observation = native.worktrees.find((entry) => entry.path === value.path);
    need(
      observation &&
        !observation.detached &&
        !observation.prunable &&
        !observation.bare &&
        observation.branch === 'refs/heads/' + value.branch,
      'registered root or branch differs from native inventory'
    );
    if (value.specId !== undefined) {
      need(typeof value.specId === 'string', 'invalid registered spec');
      need(!occupied.has(value.specId), 'spec has multiple worktree bindings');
      occupied.add(value.specId);
      const spec = specs.find((entry) => entry.id === value.specId);
      need(
        spec?.lifecycle_state === 'active' && spec.worktree === name,
        'inactive, missing or one-sided registered binding'
      );
    }
    roots.push({
      name,
      path: value.path,
      ...(typeof value.specId === 'string' ? { specId: value.specId } : {}),
    });
  }
  const registry = registryObject as unknown as WorktreeRegistry;
  for (const spec of specs) {
    checkpoint();
    if (spec.lifecycle_state !== 'active' || !spec.worktree) continue;
    need(
      roots.some((entry) => entry.name === spec.worktree && entry.specId === spec.id),
      'one-sided active spec binding'
    );
  }
  const ownedBridges: Spec[] = [];
  for (const [id, entry] of Object.entries(bridgeRegistry)) {
    checkpoint();
    const spec = specs.find((candidate) => candidate.id === id);
    // Retired records are retained history and confer no present standing.
    if (!spec || spec.lifecycle_state !== 'active') continue;
    need(!spec.worktree && !occupied.has(id), 'bridge competes with a worktree binding');
    if (entry.session_id === originalSessionId) ownedBridges.push(spec);
  }
  const matches = roots.filter((entry) => inside(entry.path, native.checkout));
  need(matches.length <= 1, 'ambiguous original checkout authority');
  const match = matches[0];
  let binding: Binding;
  let ownedRoot: string;
  if (match) {
    need(match.path === native.checkout && ownedBridges.length === 0, 'competing caller authority');
    need(match.specId, 'original checkout has no bound spec');
    const spec = specs.find((entry) => entry.id === match.specId);
    need(spec?.lifecycle_state === 'active', 'original checkout spec is inactive');
    const derived = deriveBindingState(spec, registry, match.name);
    need(derived.kind === 'bound', 'original checkout binding is one-sided');
    const ownership = assertOwnership(
      registry,
      match.name,
      { session_id: originalSessionId, platform: surface },
      {},
      new Date(0)
    );
    need(ownership.ok && ownership.value === null, 'original session does not own checkout');
    binding = derived;
    ownedRoot = match.path;
  } else {
    need(
      native.checkout === native.canonical && ownedBridges.length === 1,
      'missing or ambiguous original bridge authority'
    );
    binding = { kind: 'bridged', spec: ownedBridges[0]!, session_id: originalSessionId };
    ownedRoot = native.canonical;
  }
  return checked(checkpoint, () =>
    freeze({
      ownedRoot,
      policy: parsedPolicy.value,
      binding,
      registry,
      specs,
      bridges: bridgeRegistry,
      revision: reads.finish(JSON.stringify(native)),
    })
  );
}

/**
 * Establish caller standing from native observations and canonical bytes only.
 * This record does not admit a target. GuardPlan must enforce the owned-root
 * boundary, foreign claims, protected paths and evaluatePath(...).kind === admit.
 */
export function readNativeFileAuthority(input: NativeFileAuthorityInput): NativeFileAuthority {
  try {
    need(typeof input.checkpoint === 'function', 'original invocation checkpoint unavailable');
    const callerCheckpoint = input.checkpoint;
    const checkpoint = (): void => {
      try {
        callerCheckpoint();
      } catch {
        throw new NativeFileAuthorityError('original invocation checkpoint failed');
      }
    };
    checkpoint();
    need(input.surface === 'claude-code', 'unsupported original surface');
    need(originalSession(input.originalSessionId), 'invalid original session identity');
    const sessionId = input.originalSessionId;
    const surface = input.surface;
    const original = nativeSnapshot(input.context, checkpoint);
    checkpoint();
    const originalKey = JSON.stringify(original);
    const captured = capture(original, sessionId, surface, checkpoint);
    const repeat = capture(original, sessionId, surface, checkpoint);
    need(repeat.revision === captured.revision, 'authority changed during preparation');
    checkpoint();
    return Object.freeze({
      checkout: original.checkout,
      canonical: original.canonical,
      originalSessionId: sessionId,
      surface,
      ...captured,
      assertCurrent(freshNativeSnapshot: FileToolContextSnapshot): void {
        try {
          checkpoint();
          const fresh = nativeSnapshot(freshNativeSnapshot, checkpoint);
          need(JSON.stringify(fresh) === originalKey, 'original native context changed');
          const current = capture(fresh, sessionId, surface, checkpoint);
          need(current.revision === captured.revision, 'consumed authority changed');
          checkpoint();
        } catch (error) {
          if (error instanceof NativeFileAuthorityError) throw error;
          throw new NativeFileAuthorityError('authority revalidation unavailable');
        }
      },
    });
  } catch (error) {
    if (error instanceof NativeFileAuthorityError) throw error;
    throw new NativeFileAuthorityError('authority capture unavailable');
  }
}
