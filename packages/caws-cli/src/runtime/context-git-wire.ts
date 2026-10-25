import { TextDecoder } from 'node:util';
import { isAbsolute } from 'node:path';
import { objectMemberSource, parseJsonSource, type JsonSource } from './json-custody';

export const CONTEXT_GIT_CAPABILITY = 'caws.runtime.context-git.v1';
export const EXECUTION_WORKDIR_CONTEXT_GIT_CAPABILITY =
  'caws.runtime.context-git.execution-workdir.v1';
export const CONTEXT_GIT_REQUEST_SCHEMA = 'caws.runtime.context-git.request.v1';
export const CONTEXT_GIT_RESULT_SCHEMA = 'caws.runtime.context-git.result.v1';
export const MAX_CONTEXT_GIT_REQUEST_BYTES = 32 * 1024;
export const MAX_CONTEXT_GIT_RESULT_BYTES = 2 * 1024 * 1024;
export const MAX_CONTEXT_GIT_OUTPUT_BYTES = 1024 * 1024;
export type ContextGitOperation = 'checkout' | 'commonDir';
export type ContextGitOrdinal = 1 | 2 | 3 | 4;
export interface ContextGitCleanup {
  readonly groupSettled: boolean;
  readonly stdoutEof: boolean;
  readonly stderrEof: boolean;
  readonly reaped: boolean;
}
export type ContextGitErrorCategory =
  | 'git_exit'
  | 'spawn_failed'
  | 'cancelled'
  | 'deadline'
  | 'protocol'
  | 'cleanup'
  | 'identity'
  | 'output_limit'
  | 'signal'
  | 'utf8'
  | 'unavailable';

/** A missing cleanup observation is not evidence that native cleanup completed. */
export class ContextGitError extends Error {
  constructor(
    readonly category: ContextGitErrorCategory,
    message: string,
    readonly cleanup: ContextGitCleanup | null = null
  ) {
    super(message);
    this.name = 'ContextGitError';
  }
}

export function isFatalContextGitError(error: unknown): error is ContextGitError {
  return error instanceof ContextGitError && error.category !== 'git_exit';
}

export interface ContextGitRequest {
  readonly schema: typeof CONTEXT_GIT_REQUEST_SCHEMA;
  readonly id: string;
  readonly runtimeDigest: string;
  readonly token: string;
  readonly ordinal: ContextGitOrdinal;
  readonly operation: ContextGitOperation;
  readonly executable: string;
  readonly cwd: string;
}
export type ContextGitStatus =
  | 'exited'
  | 'spawn_failed'
  | 'cancelled'
  | 'deadline'
  | 'output_limit'
  | 'cleanup_unsettled'
  | 'identity_changed';
export interface ContextGitResult {
  readonly status: ContextGitStatus;
  readonly exitCode: number | null;
  readonly signal: number | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly cleanup: ContextGitCleanup;
  readonly diagnostic: string;
}

function fail(message: string): never {
  throw new ContextGitError('protocol', message);
}
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const digest = (value: string): boolean => /^[a-f0-9]{64}$/.test(value);
const nativeText = (value: string): boolean =>
  !value.includes('\0') && Buffer.from(value, 'utf8').toString('utf8') === value;

export function createContextGitRequest(
  identity: Pick<ContextGitRequest, 'id' | 'runtimeDigest'>,
  token: string,
  ordinal: ContextGitOrdinal,
  operation: ContextGitOperation,
  executable: string,
  cwd: string
): ContextGitRequest {
  if (
    !identity.id ||
    Buffer.byteLength(identity.id) > 128 ||
    !nativeText(identity.id) ||
    !digest(identity.runtimeDigest) ||
    !digest(token) ||
    !(
      ([1, 3].includes(ordinal) && operation === 'checkout') ||
      ([2, 4].includes(ordinal) && operation === 'commonDir')
    ) ||
    !isAbsolute(executable) ||
    !nativeText(executable) ||
    !isAbsolute(cwd) ||
    !nativeText(cwd)
  )
    fail('Invalid native context Git request');
  const frame: ContextGitRequest = Object.freeze({
    schema: CONTEXT_GIT_REQUEST_SCHEMA,
    id: identity.id,
    runtimeDigest: identity.runtimeDigest,
    token,
    ordinal,
    operation,
    executable,
    cwd,
  });
  if (Buffer.byteLength(JSON.stringify(frame)) > MAX_CONTEXT_GIT_REQUEST_BYTES)
    fail('Native context Git request exceeds byte limit');
  return frame;
}

function canonicalInteger(
  source: JsonSource,
  key: string,
  value: unknown,
  maximum: number
): number | null {
  const member = objectMemberSource(source, key);
  if (value === null && member?.root.kind === 'scalar' && member.root.value === null) return null;
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > maximum ||
    member?.root.kind !== 'number' ||
    !/^(0|[1-9][0-9]*)$/.test(member.text.slice(member.root.start, member.root.end))
  )
    fail('Invalid native context Git ' + key);
  return value as number;
}

function decodeBase64(value: unknown): Buffer {
  if (typeof value !== 'string' || value.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(value))
    fail('Invalid native context Git base64');
  const bytes = Buffer.from(value as string, 'base64');
  if (bytes.toString('base64') !== value) fail('Noncanonical native context Git base64');
  return bytes;
}

export function decodeContextGitResult(
  frame: Uint8Array,
  expected: ContextGitRequest
): ContextGitResult {
  if (!(frame instanceof Uint8Array) || frame.byteLength > MAX_CONTEXT_GIT_RESULT_BYTES)
    fail('Native context Git result exceeds byte limit');
  let source: JsonSource, value: unknown;
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(frame);
    source = parseJsonSource(text, 4, 64, true);
    value = JSON.parse(text);
  } catch {
    return fail('Invalid native context Git result JSON');
  }
  if (
    !record(value) ||
    !exactKeys(value, [
      'schema',
      'id',
      'runtimeDigest',
      'token',
      'ordinal',
      'operation',
      'status',
      'exitCode',
      'signal',
      'stdout',
      'stderr',
      'cleanup',
      'diagnostic',
    ])
  )
    fail('Invalid native context Git result fields');
  const row = value as Record<string, unknown>;
  if (
    row.schema !== CONTEXT_GIT_RESULT_SCHEMA ||
    row.id !== expected.id ||
    row.runtimeDigest !== expected.runtimeDigest ||
    row.token !== expected.token ||
    row.ordinal !== expected.ordinal ||
    row.operation !== expected.operation ||
    canonicalInteger(source!, 'ordinal', row.ordinal, 4) !== expected.ordinal
  )
    fail('Mismatched native context Git result identity');
  if (
    ![
      'exited',
      'spawn_failed',
      'cancelled',
      'deadline',
      'output_limit',
      'cleanup_unsettled',
      'identity_changed',
    ].includes(row.status as string)
  )
    fail('Invalid native context Git result status');
  const exitCode = canonicalInteger(source!, 'exitCode', row.exitCode, 255);
  const signal = canonicalInteger(source!, 'signal', row.signal, 2147483647);
  if (
    (exitCode !== null && signal !== null) ||
    signal === 0 ||
    (row.status === 'exited' && exitCode === null && signal === null) ||
    (row.status === 'spawn_failed' && (exitCode !== null || signal !== null))
  )
    fail('Incoherent native context Git process status');
  if (
    !record(row.cleanup) ||
    !exactKeys(row.cleanup, ['groupSettled', 'stdoutEof', 'stderrEof', 'reaped']) ||
    !Object.values(row.cleanup).every((item) => typeof item === 'boolean')
  )
    fail('Invalid native context Git cleanup fields');
  const cleanup = Object.freeze({ ...row.cleanup }) as unknown as ContextGitCleanup;
  const allSettled = Object.values(cleanup).every((item) => item === true);
  if (row.status === 'exited' && !allSettled)
    throw new ContextGitError('cleanup', 'Native context Git exit lacks complete cleanup', cleanup);
  if (row.status === 'cleanup_unsettled' && allSettled)
    fail('Incoherent native context Git cleanup status');
  if (
    typeof row.diagnostic !== 'string' ||
    Buffer.byteLength(row.diagnostic) > 1024 ||
    Buffer.from(row.diagnostic, 'utf8').toString('utf8') !== row.diagnostic
  )
    fail('Invalid native context Git diagnostic');
  const stdout = decodeBase64(row.stdout),
    stderr = decodeBase64(row.stderr);
  if (stdout.length + stderr.length > MAX_CONTEXT_GIT_OUTPUT_BYTES)
    fail('Native context Git output exceeds byte limit');
  return Object.freeze({
    status: row.status as ContextGitStatus,
    exitCode,
    signal,
    stdout,
    stderr,
    cleanup,
    diagnostic: row.diagnostic as string,
  });
}
