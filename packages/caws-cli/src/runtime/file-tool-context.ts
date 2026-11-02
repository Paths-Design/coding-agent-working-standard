import { randomBytes } from 'node:crypto';
import type { GuardStrikeCommit } from './guard-strikes';
import { isAbsolute } from 'node:path';
import { TextDecoder } from 'node:util';
import { objectMemberSource, parseJsonSource } from './json-custody';
import {
  FILE_TOOL_CONTEXT_CAPABILITY,
  RuntimeProtocolError,
  type RuntimeRequest,
} from './protocol';

export const FILE_TOOL_CONTEXT_REQUEST = 'caws.runtime.file-tool-context.request.v1';
export const FILE_TOOL_CONTEXT_RESULT = 'caws.runtime.file-tool-context.result.v1';
export const MAX_FILE_TOOL_CONTEXT_RESULT = 2 * 1024 * 1024;

export interface FileToolWorktree {
  readonly path: string;
  /** Exact porcelain spelling, including refs/heads/. */
  readonly branch: string | null;
  readonly detached: boolean;
  readonly prunable: boolean;
  readonly bare: boolean;
}
export interface FileToolContextSnapshot {
  readonly checkout: string;
  readonly canonical: string;
  readonly gitDir: string;
  readonly commonDir: string;
  /** Abbreviated checkout branch; null records a settled unsuccessful query. */
  readonly branch: string | null;
  readonly mergeInProgress: boolean;
  readonly worktrees: readonly FileToolWorktree[];
}
export interface NativeFileToolContextPort {
  capture(): Promise<FileToolContextSnapshot>;
  revalidate(): Promise<FileToolContextSnapshot>;
}
export interface FileToolContextTransport {
  read(signal: AbortSignal): Promise<Uint8Array>;
  write(frame: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<void>;
}
export interface FileToolContextBinding {
  readonly captured: FileToolContextSnapshot;
  revalidate(): Promise<FileToolContextSnapshot>;
  incrementScopeGuard(): Promise<GuardStrikeCommit>;
}
function failure(message: string): RuntimeProtocolError {
  return new RuntimeProtocolError('Native file-tool context: ' + message);
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
function fields(
  value: unknown,
  expected: readonly string[]
): asserts value is Record<string, unknown> {
  if (
    !object(value) ||
    Object.keys(value).length !== expected.length ||
    expected.some((key) => !Object.hasOwn(value, key))
  )
    throw failure('invalid object fields');
}
const nativeText = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  Buffer.byteLength(value) <= 4096 &&
  !value.includes('\0') &&
  Buffer.from(value, 'utf8').toString('utf8') === value;
function nativePath(value: unknown): asserts value is string {
  if (!nativeText(value) || !isAbsolute(value)) throw failure('invalid absolute UTF-8 path');
}
function decodeSnapshot(value: unknown): FileToolContextSnapshot {
  fields(value, [
    'checkout',
    'canonical',
    'gitDir',
    'commonDir',
    'branch',
    'mergeInProgress',
    'worktrees',
  ]);
  nativePath(value.checkout);
  nativePath(value.canonical);
  nativePath(value.gitDir);
  nativePath(value.commonDir);
  if (
    (value.branch !== null && !nativeText(value.branch)) ||
    typeof value.mergeInProgress !== 'boolean' ||
    !Array.isArray(value.worktrees) ||
    value.worktrees.length > 4096
  )
    throw failure('invalid context facts');
  const seen = new Set<string>();
  const worktrees: FileToolWorktree[] = value.worktrees.map((entry: unknown) => {
    fields(entry, ['path', 'branch', 'detached', 'prunable', 'bare']);
    nativePath(entry.path);
    if (
      (entry.branch !== null && !nativeText(entry.branch)) ||
      typeof entry.detached !== 'boolean' ||
      typeof entry.prunable !== 'boolean' ||
      typeof entry.bare !== 'boolean' ||
      (entry.detached && entry.branch !== null) ||
      (entry.bare && (entry.branch !== null || entry.detached)) ||
      seen.has(entry.path)
    )
      throw failure('invalid or duplicate worktree fact');
    seen.add(entry.path);
    return Object.freeze({
      path: entry.path,
      branch: entry.branch as string | null,
      detached: entry.detached,
      prunable: entry.prunable,
      bare: entry.bare,
    });
  });
  return Object.freeze({
    checkout: value.checkout,
    canonical: value.canonical,
    gitDir: value.gitDir,
    commonDir: value.commonDir,
    branch: value.branch as string | null,
    mergeInProgress: value.mergeInProgress,
    worktrees: Object.freeze(worktrees),
  });
}
export function assertFileToolContextRoots(
  snapshot: FileToolContextSnapshot,
  checkout: string,
  canonical: string
): void {
  if (snapshot.checkout !== checkout || snapshot.canonical !== canonical)
    throw failure('native original roots differ from selected roots');
}
function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((accept, reject) => {
    const abort = (): void => {
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        accept(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      }
    );
    if (signal.aborted) abort();
  });
}
/** Two fixed observations; failure or overlap permanently consumes this port.
 * Aborting the frontend wait does not establish native query cleanup.
 */
export function createNativeFileToolContextPort(
  request: RuntimeRequest,
  transport: FileToolContextTransport,
  signal: AbortSignal
): NativeFileToolContextPort {
  if (
    request.fileToolContext !== FILE_TOOL_CONTEXT_CAPABILITY ||
    request.surface !== 'codex' ||
    request.event !== 'pre_tool_use' ||
    request.configuration !== 'system' ||
    !['Write', 'Edit', 'apply_patch'].includes(String(request.payload.tool_name)) ||
    !Number.isSafeInteger(request.deadlineEpochMs)
  )
    throw failure('capability unavailable');
  const identity = Object.freeze({ id: request.id, runtimeDigest: request.runtimeDigest });
  const token = randomBytes(32).toString('hex');
  const deadline = request.deadlineEpochMs;
  let next = 1;
  let poisoned = false;
  let active: AbortController | null = null;
  let snapshotToken: string | null = null;
  let original: FileToolContextSnapshot | null = null;
  const checkpoint = (): void => {
    if (poisoned) throw failure('port invalidated');
    if (signal.aborted) throw signal.reason;
    if (Date.now() >= deadline)
      throw failure('original deadline expired; native cleanup unconfirmed');
  };
  async function observe(ordinal: 1 | 2): Promise<FileToolContextSnapshot> {
    if (poisoned || active !== null || next !== ordinal) {
      poisoned = true;
      const error = failure('overlap, replay or order mismatch');
      active?.abort(error);
      throw error;
    }
    next++;
    const controller = new AbortController();
    active = controller;
    const cancel = (): void => controller.abort(signal.reason);
    signal.addEventListener('abort', cancel, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      checkpoint();
      timer = setTimeout(
        () => controller.abort(failure('original deadline expired; native cleanup unconfirmed')),
        Math.max(1, deadline - Date.now())
      );
      await abortable(
        transport.write(
          {
            schema: FILE_TOOL_CONTEXT_REQUEST,
            ...identity,
            token,
            ordinal,
            snapshotToken,
          },
          controller.signal
        ),
        controller.signal
      );
      checkpoint();
      const bytes = await abortable(transport.read(controller.signal), controller.signal);
      checkpoint();
      if (bytes.byteLength > MAX_FILE_TOOL_CONTEXT_RESULT)
        throw failure('result exceeds byte bound');
      const sourceText = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      const source = parseJsonSource(sourceText, 16, 65536, true);
      const value: unknown = JSON.parse(sourceText);
      fields(value, [
        'schema',
        'id',
        'runtimeDigest',
        'token',
        'ordinal',
        'snapshotToken',
        'context',
      ]);
      const ordinalSource = objectMemberSource(source, 'ordinal');
      if (
        !ordinalSource ||
        ordinalSource.root.kind !== 'number' ||
        ordinalSource.text.slice(ordinalSource.root.start, ordinalSource.root.end) !==
          String(ordinal) ||
        value.schema !== FILE_TOOL_CONTEXT_RESULT ||
        value.id !== identity.id ||
        value.runtimeDigest !== identity.runtimeDigest ||
        value.token !== token ||
        value.ordinal !== ordinal ||
        typeof value.snapshotToken !== 'string' ||
        !/^[a-f0-9]{64}$/.test(value.snapshotToken) ||
        (snapshotToken !== null && value.snapshotToken !== snapshotToken)
      )
        throw failure('result correlation mismatch');
      const observed = decodeSnapshot(value.context);
      if (
        original &&
        (['checkout', 'canonical', 'gitDir', 'commonDir'] as const).some(
          (key) => original![key] !== observed[key]
        )
      )
        throw failure('original roots replaced');
      snapshotToken = value.snapshotToken;
      original ??= observed;
      checkpoint();
      return observed;
    } catch (error) {
      poisoned = true;
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      if (active === controller) active = null;
    }
  }
  return Object.freeze({ capture: () => observe(1), revalidate: () => observe(2) });
}
