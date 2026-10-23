/** Consume a native observation; no Git execution, calendar, defaults or publication. */
import { TextDecoder } from 'node:util';
import { isAbsolute } from 'node:path';
import { parseJsonSource } from './json-custody';
import { jsonNumber } from '../transcripts/lossless-json';
import type { RendererPreparationContext } from '../transcripts/render-prepare';

export const RENDER_CONTEXT_SCHEMA = 'caws.render.context.observation.v1';
export const MAX_RENDER_CONTEXT_BYTES = 6 * 1024 * 1024;
const MAX_QUERY_BYTES = 1024 * 1024;
export class RenderContextError extends Error {
  constructor(
    readonly category: 'protocol' | 'identity' | 'cleanup' | 'utf8' | 'git_exit',
    message: string
  ) {
    super(message);
    this.name = 'RenderContextError';
  }
}
export interface ExpectedRenderContext {
  readonly id: string;
  readonly runtimeDigest: string;
  readonly token: string;
  readonly cwd: string;
  readonly executable: {
    readonly path: string;
    readonly physicalPath: string;
    readonly sha256: string;
  };
}
export type RenderGitContext = Pick<
  RendererPreparationContext,
  'cwd' | 'branch' | 'headSha' | 'dirtyFiles'
>;
type Row = Record<string, unknown>;
const object = (value: unknown): value is Row =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Row, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const nativePath = (value: unknown): value is string =>
  typeof value === 'string' &&
  isAbsolute(value) &&
  Buffer.byteLength(value) <= 4096 &&
  !/[\0\r\n]/.test(value) &&
  Buffer.from(value).toString('utf8') === value;
const digest = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
// Match native proposal admission; tokens are opaque identities, usually UUIDs.
const token = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  Buffer.byteLength(value) <= 128 &&
  !/[^A-Za-z0-9._:-]/.test(value);
function requireValue(
  value: unknown,
  category: RenderContextError['category'],
  message: string
): asserts value {
  if (!value) throw new RenderContextError(category, message);
}
function bytes(value: unknown): Buffer {
  requireValue(
    typeof value === 'string' && value.length <= 4 * Math.ceil(MAX_QUERY_BYTES / 3),
    'protocol',
    'Invalid Render Git byte encoding'
  );
  const decoded = Buffer.from(value, 'base64');
  requireValue(
    decoded.length <= MAX_QUERY_BYTES && decoded.toString('base64') === value,
    'protocol',
    'Invalid Render Git byte encoding'
  );
  return decoded;
}
function utf8(value: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(value);
  } catch {
    throw new RenderContextError('utf8', 'Render Git output is outside the UTF-8 consumer profile');
  }
}
interface Query {
  readonly code: number;
  readonly stdout: Buffer;
}

/** `expected` must originate from the native-admitted original, not this record.
 * Raw bytes remain with the caller; this projection never substitutes Number
 * for dirty count, strips whitespace, or treats cleanup failure as Git absence.
 */
export function deriveRenderGitContext(
  input: Uint8Array,
  expected: ExpectedRenderContext
): RenderGitContext {
  requireValue(
    input instanceof Uint8Array && input.byteLength <= MAX_RENDER_CONTEXT_BYTES,
    'protocol',
    'Render context exceeds byte bound'
  );
  let value: unknown;
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input);
    parseJsonSource(text, 8, 1024, true);
    value = JSON.parse(text);
    // Native serializes fixed-order structs without LF. This also refuses
    // extension numeric spellings and silently normalized Unicode escapes.
    requireValue(
      JSON.stringify(value) === text,
      'protocol',
      'Render context is not canonical native JSON'
    );
  } catch (error) {
    if (error instanceof RenderContextError) throw error;
    throw new RenderContextError('protocol', 'Invalid Render context JSON or duplicate member');
  }
  requireValue(
    object(value) &&
      exact(value, ['schema', 'id', 'runtimeDigest', 'token', 'cwd', 'executable', 'queries']) &&
      value.schema === RENDER_CONTEXT_SCHEMA,
    'protocol',
    'Invalid Render context fields'
  );
  requireValue(
    typeof expected.id === 'string' &&
      expected.id.length > 0 &&
      Buffer.byteLength(expected.id) <= 128 &&
      !expected.id.includes('\0') &&
      digest(expected.runtimeDigest) &&
      token(expected.token) &&
      nativePath(expected.cwd) &&
      value.id === expected.id &&
      value.runtimeDigest === expected.runtimeDigest &&
      value.token === expected.token &&
      value.cwd === expected.cwd,
    'identity',
    'Render context differs from original identity or CWD'
  );
  requireValue(
    object(value.executable) &&
      exact(value.executable, ['path', 'physicalPath', 'sha256']) &&
      nativePath(expected.executable.path) &&
      nativePath(expected.executable.physicalPath) &&
      digest(expected.executable.sha256) &&
      value.executable.path === expected.executable.path &&
      value.executable.physicalPath === expected.executable.physicalPath &&
      value.executable.sha256 === expected.executable.sha256,
    'identity',
    'Render Git executable differs from original selection'
  );
  requireValue(
    Array.isArray(value.queries) && (value.queries.length === 1 || value.queries.length === 4),
    'protocol',
    'Invalid Render Git query count'
  );
  const operations = ['inside', 'branch', 'head', 'status'];
  const queries: Query[] = value.queries.map((entry: unknown, index: number) => {
    requireValue(
      object(entry) &&
        exact(entry, [
          'ordinal',
          'operation',
          'exitCode',
          'signal',
          'stdout',
          'stderr',
          'cleanup',
        ]) &&
        entry.ordinal === index + 1 &&
        entry.operation === operations[index],
      'protocol',
      'Invalid Render Git query sequence'
    );
    requireValue(
      object(entry.cleanup) &&
        exact(entry.cleanup, [
          'exitObserved',
          'groupSettled',
          'stdoutEof',
          'stderrEof',
          'reaped',
          'ownershipRetained',
        ]) &&
        entry.cleanup.exitObserved === true &&
        entry.cleanup.groupSettled === true &&
        entry.cleanup.stdoutEof === true &&
        entry.cleanup.stderrEof === true &&
        entry.cleanup.reaped === true &&
        entry.cleanup.ownershipRetained === false,
      'cleanup',
      'Render Git query cleanup is unconfirmed'
    );
    requireValue(
      typeof entry.exitCode === 'number' &&
        Number.isSafeInteger(entry.exitCode) &&
        entry.exitCode >= 0 &&
        entry.exitCode <= 255 &&
        entry.signal === null,
      'git_exit',
      'Render Git query has no normal exit status'
    );
    const stdout = bytes(entry.stdout),
      stderr = bytes(entry.stderr);
    requireValue(
      stdout.length + stderr.length <= MAX_QUERY_BYTES,
      'protocol',
      'Render Git combined output exceeds byte bound'
    );
    // The shell redirects every stderr and the probe stdout to /dev/null.
    // Porcelain output only reaches wc -l; it is not a text projection.
    return { code: entry.exitCode, stdout };
  });
  const inside = queries[0]!;
  if (inside.code !== 0) {
    requireValue(
      queries.length === 1,
      'protocol',
      'Render Git continued after failed repository probe'
    );
    return Object.freeze({
      cwd: expected.cwd,
      branch: 'unknown',
      headSha: 'unknown',
      dirtyFiles: jsonNumber('0'),
    });
  }
  requireValue(
    queries.length === 4,
    'protocol',
    'Render Git queries ended before context completion'
  );
  const branch = queries[1]!,
    head = queries[2]!,
    status = queries[3]!;
  requireValue(status.code === 0, 'git_exit', 'Render Git porcelain query failed');
  // Shell command substitution removes every trailing LF, and nothing else.
  const stripLf = (text: string): string => text.replace(/\n+$/, '');
  const projectedText = (output: Buffer): string => {
    const text = utf8(output);
    requireValue(!text.includes('\0'), 'utf8', 'Render Git output contains unsupported NUL bytes');
    return text;
  };
  const branchValue = branch.code === 0 ? stripLf(projectedText(branch.stdout)) : 'detached';
  // `git ... || echo unknown` preserves partial failing stdout. It does not
  // insert a separator before echo; command substitution then strips final LF.
  const headValue = stripLf(projectedText(head.stdout) + (head.code === 0 ? '' : 'unknown\n'));
  const dirty = status.stdout.reduce((count, byte) => count + (byte === 10 ? 1 : 0), 0);
  return Object.freeze({
    cwd: expected.cwd,
    branch: branchValue,
    headSha: headValue,
    dirtyFiles: jsonNumber(String(dirty)),
  });
}
