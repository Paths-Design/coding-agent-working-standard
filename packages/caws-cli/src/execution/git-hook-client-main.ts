/** Trusted Git callback client. fd4 is a Native capability; it is never passed
 * to Git plumbing or USER hooks. This entry exposes no caller-selected command.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { parseJsonSource } from '../runtime/json-custody';
import {
  captureGitHookTransaction,
  validateGitHookTransaction,
  publishGitHookTransaction,
  GitHookTransactionError,
} from './git-hook-transaction';
import type { GitHookPublicationDisposition, GitPlumbingRequest } from './git-hook-transaction';

const PROTOCOL = 'caws.execution.git-bridge.v1';
const FRAME_LIMIT = 1024 * 1024;
const STDIN_LIMIT = 512 * 1024;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const PUBLIC_ENVIRONMENT = new Set([
  'PATH',
  'LC_ALL',
  'PWD',
  'HOME',
  'TMPDIR',
  'CAWS_HOME',
  'CODEX_HOME',
  'CODEX_THREAD_ID',
  'CAWS_AGENT_SURFACE',
  'CAWS_PROJECT_DIR',
]);
const GIT_ENVIRONMENT = new Set([
  'GIT_DIR',
  'GIT_COMMON_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_PREFIX',
  'GIT_INTERNAL_SUPER_PREFIX',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_SHALLOW_FILE',
  'GIT_GRAFT_FILE',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_REPLACE_REF_BASE',
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_AUTHOR_DATE',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
  'GIT_COMMITTER_DATE',
  'GIT_EDITOR',
  'GIT_REFLOG_ACTION',
  'GIT_EXEC_PATH',
  'GIT_OPTIONAL_LOCKS',
  'GIT_LITERAL_PATHSPECS',
]);
interface HookImage {
  readonly path: string;
  readonly sha256: string;
  readonly dev: string;
  readonly ino: string;
  readonly mode: string;
}
interface FormatterImage {
  readonly path: string;
  readonly sha256: string;
}
export interface GitBridgeRoot {
  readonly cwd: string;
  readonly authorizedPaths: readonly string[];
  readonly hooksDirectory: string;
  readonly hooks: Readonly<Record<string, HookImage | null>>;
  readonly formatters: {
    readonly eslint: FormatterImage | null;
    readonly prettier: FormatterImage | null;
  };
  readonly readOnlyPaths: readonly string[];
}
export type GitBridgeRequest =
  | { readonly operation: 'configure'; readonly roots: readonly GitBridgeRoot[] }
  | {
      readonly operation: 'open';
      readonly cwd: string;
      readonly hook: string;
      readonly args: readonly string[];
      readonly gitEnvironment: Readonly<Record<string, string>>;
      readonly stdinBase64: string;
    }
  | {
      readonly operation: 'execute';
      readonly contextId: string;
      readonly seedIndexPath: string;
      readonly seedIndexSha256: string;
      readonly objectDirectory: string;
    }
  | { readonly operation: 'assert'; readonly contextId: string }
  | {
      readonly operation: 'finish';
      readonly contextId: string;
      readonly exitCode: number;
      readonly publication: GitHookPublicationDisposition;
    }
  | { readonly operation: 'verdict' };
export class GitHookBridgeRefused extends Error {
  constructor(
    readonly reason: string,
    readonly userSpawnMayHaveOccurred: boolean
  ) {
    super(
      `Native Git bridge refused: ${reason}; userSpawnMayHaveOccurred=${userSpawnMayHaveOccurred}`
    );
    this.name = 'GitHookBridgeRefused';
  }
}
function insist(value: unknown, message = 'Invalid Git bridge protocol'): asserts value {
  if (!value) throw new Error(message);
}
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function text(value: unknown, limit = 32768): value is string {
  return (
    typeof value === 'string' &&
    value.length <= limit &&
    !value.includes('\0') &&
    Buffer.from(value).toString('utf8') === value
  );
}
function absolute(value: unknown): value is string {
  return (
    text(value) &&
    path.isAbsolute(value) &&
    !/[\x00-\x1f\x7f]/.test(value) &&
    path.resolve(value) === value
  );
}
function hash(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}
function hookName(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value);
}
function strings(value: unknown, limit: number): value is string[] {
  return Array.isArray(value) && value.length <= limit && value.every((item) => text(item));
}
function code(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 255;
}
function base64(value: unknown, limit = FRAME_LIMIT): Buffer {
  insist(typeof value === 'string' && value.length <= Math.ceil(limit / 3) * 4);
  const bytes = Buffer.from(value, 'base64');
  insist(bytes.length <= limit && bytes.toString('base64') === value, 'Invalid Git bridge base64');
  return bytes;
}
function environmentKey(name: string): boolean {
  return (
    PUBLIC_ENVIRONMENT.has(name) ||
    GIT_ENVIRONMENT.has(name) ||
    name === 'GIT_CONFIG_COUNT' ||
    /^GIT_CONFIG_(?:KEY|VALUE)_(?:0|[1-9][0-9]*)$/.test(name)
  );
}
function validateEnvironment(value: unknown): asserts value is Record<string, string> {
  insist(object(value) && Object.keys(value).length <= 192);
  insist(Object.entries(value).every(([name, item]) => environmentKey(name) && text(item, 65536)));
  insist(Buffer.byteLength(JSON.stringify(value)) <= 262144, 'Git callback environment limit');
  const countText = value.GIT_CONFIG_COUNT;
  insist(
    countText === undefined ||
      (typeof countText === 'string' && /^(?:0|[1-9][0-9]*)$/.test(countText))
  );
  const count = countText === undefined ? 0 : Number(countText);
  insist(count <= 64, 'Git indexed configuration limit');
  for (let i = 0; i < count; i++)
    insist(
      Object.hasOwn(value, `GIT_CONFIG_KEY_${i}`) && Object.hasOwn(value, `GIT_CONFIG_VALUE_${i}`),
      'Incomplete Git indexed configuration'
    );
  for (const name of Object.keys(value)) {
    const match = /^GIT_CONFIG_(?:KEY|VALUE)_([0-9]+)$/.exec(name);
    if (match) insist(Number(match[1]) < count, 'Unexpected Git indexed configuration');
  }
}
function collectEnvironment(value: NodeJS.ProcessEnv): Record<string, string> {
  insist(value.GIT_CONFIG_PARAMETERS === undefined, 'GIT_CONFIG_PARAMETERS is unsupported');
  const result: Record<string, string> = {};
  for (const [name, item] of Object.entries(value)) {
    if (/^GIT_CONFIG_(?:KEY|VALUE)_/.test(name))
      insist(environmentKey(name), 'Invalid Git indexed configuration key');
    if (environmentKey(name) && item !== undefined) result[name] = item;
  }
  validateEnvironment(result);
  return result;
}
function validateRoot(value: unknown): void {
  insist(
    exact(value, [
      'cwd',
      'authorizedPaths',
      'hooksDirectory',
      'hooks',
      'formatters',
      'readOnlyPaths',
    ])
  );
  insist(
    absolute(value.cwd) &&
      absolute(value.hooksDirectory) &&
      strings(value.authorizedPaths, 10000) &&
      strings(value.readOnlyPaths, 10000)
  );
  insist(object(value.hooks) && Object.keys(value.hooks).length <= 64);
  for (const [name, image] of Object.entries(value.hooks)) {
    insist(hookName(name));
    if (image === null) continue;
    insist(
      exact(image, ['path', 'sha256', 'dev', 'ino', 'mode']) &&
        absolute(image.path) &&
        hash(image.sha256)
    );
    insist(
      ['dev', 'ino', 'mode'].every(
        (key) => typeof image[key] === 'string' && /^(?:0|[1-9][0-9]*)$/.test(image[key] as string)
      )
    );
  }
  insist(exact(value.formatters, ['eslint', 'prettier']));
  for (const image of Object.values(value.formatters))
    insist(
      image === null ||
        (exact(image, ['path', 'sha256']) && absolute(image.path) && hash(image.sha256))
    );
}
function validateRequest(value: unknown): asserts value is GitBridgeRequest {
  insist(object(value));
  switch (value.operation) {
    case 'configure':
      insist(
        exact(value, ['operation', 'roots']) &&
          Array.isArray(value.roots) &&
          value.roots.length > 0 &&
          value.roots.length <= 32
      );
      value.roots.forEach(validateRoot);
      break;
    case 'open':
      insist(
        exact(value, ['operation', 'cwd', 'hook', 'args', 'gitEnvironment', 'stdinBase64']) &&
          absolute(value.cwd) &&
          hookName(value.hook) &&
          strings(value.args, 256)
      );
      insist(Buffer.byteLength(JSON.stringify(value.args)) <= 65536);
      validateEnvironment(value.gitEnvironment);
      base64(value.stdinBase64, STDIN_LIMIT);
      break;
    case 'execute':
      insist(
        exact(value, [
          'operation',
          'contextId',
          'seedIndexPath',
          'seedIndexSha256',
          'objectDirectory',
        ]) &&
          hash(value.contextId) &&
          absolute(value.seedIndexPath) &&
          hash(value.seedIndexSha256) &&
          absolute(value.objectDirectory)
      );
      break;
    case 'assert':
      insist(exact(value, ['operation', 'contextId']) && hash(value.contextId));
      break;
    case 'finish':
      insist(
        exact(value, ['operation', 'contextId', 'exitCode', 'publication']) &&
          hash(value.contextId) &&
          code(value.exitCode) &&
          ['not-published', 'objects-may-exist', 'index-published'].includes(
            String(value.publication)
          )
      );
      break;
    case 'verdict':
      insist(exact(value, ['operation']));
      break;
    default:
      insist(false);
  }
}
function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    let count: number;
    try {
      count = fs.writeSync(fd, bytes, offset, bytes.length - offset);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EINTR') continue;
      throw error;
    }
    insist(count > 0, 'Git bridge closed while writing');
    offset += count;
  }
}
function readExact(fd: number, size: number): Buffer {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    let count: number;
    try {
      count = fs.readSync(fd, bytes, offset, size - offset, null);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EINTR') continue;
      throw error;
    }
    insist(count > 0, 'Git bridge closed before complete reply');
    offset += count;
  }
  return bytes;
}
function validateData(request: GitBridgeRequest, data: Record<string, unknown>): void {
  if (request.operation === 'assert' || request.operation === 'finish') insist(exact(data, []));
  else if (request.operation === 'verdict')
    insist(exact(data, ['failed']) && typeof data.failed === 'boolean');
  else if (request.operation === 'configure') {
    insist(
      exact(data, ['shimDirectories']) &&
        Array.isArray(data.shimDirectories) &&
        data.shimDirectories.length === request.roots.length
    );
    const seen = new Set<string>();
    data.shimDirectories.forEach((row, index) => {
      insist(
        exact(row, ['cwd', 'shimDirectory']) &&
          row.cwd === request.roots[index]!.cwd &&
          absolute(row.shimDirectory)
      );
      insist(!seen.has(row.shimDirectory), 'Shared Git shim directory');
      seen.add(row.shimDirectory);
    });
  } else if (request.operation === 'open') {
    insist(
      exact(data, [
        'contextId',
        'projectRoot',
        'transactionRoot',
        'authorizedPaths',
        'gitEnvironment',
      ]) &&
        hash(data.contextId) &&
        data.projectRoot === request.cwd &&
        absolute(data.transactionRoot) &&
        strings(data.authorizedPaths, 10000)
    );
    validateEnvironment(data.gitEnvironment);
  } else {
    insist(
      exact(data, [
        'exitCode',
        'stdoutBase64',
        'stderrBase64',
        'privateIndexPath',
        'privateObjectDirectory',
      ]) &&
        code(data.exitCode) &&
        absolute(data.privateIndexPath) &&
        absolute(data.privateObjectDirectory)
    );
    base64(data.stdoutBase64);
    base64(data.stderrBase64);
  }
}
/** A blocking, strictly framed capability exchange. EOF, unknown fields,
 * duplicate JSON members and identity mismatch terminate the exchange. */
export function bridgeRequest(request: GitBridgeRequest, fd = 4): Record<string, unknown> {
  insist(Number.isInteger(fd) && fd >= 4, 'Git bridge fd unavailable');
  validateRequest(request);
  const requestId = randomBytes(16).toString('hex');
  const body = Buffer.from(JSON.stringify({ protocol: PROTOCOL, requestId, request }));
  insist(body.length > 0 && body.length <= FRAME_LIMIT, 'Git bridge request frame limit');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  writeAll(fd, Buffer.concat([header, body]));
  const size = readExact(fd, 4).readUInt32BE();
  insist(size > 0 && size <= FRAME_LIMIT, 'Git bridge reply frame limit');
  const source = utf8.decode(readExact(fd, size));
  parseJsonSource(source, 24, 50000, true);
  const reply: unknown = JSON.parse(source);
  insist(
    exact(reply, ['protocol', 'requestId', 'response']) &&
      reply.protocol === PROTOCOL &&
      reply.requestId === requestId
  );
  const response = reply.response;
  insist(object(response));
  if (response.status === 'refused') {
    insist(
      exact(response, ['status', 'reason', 'userSpawnMayHaveOccurred']) &&
        typeof response.reason === 'string' &&
        /^[a-z][a-z0-9_]{0,127}$/.test(response.reason) &&
        typeof response.userSpawnMayHaveOccurred === 'boolean'
    );
    throw new GitHookBridgeRefused(response.reason, response.userSpawnMayHaveOccurred);
  }
  insist(exact(response, ['status', 'data']) && response.status === 'ok' && object(response.data));
  validateData(request, response.data);
  return response.data;
}
function readStdin(fd: number): Buffer {
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const block = Buffer.alloc(16384);
    let count: number;
    try {
      count = fs.readSync(fd, block, 0, block.length, null);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EINTR') continue;
      throw error;
    }
    if (count === 0) return Buffer.concat(chunks, total);
    total += count;
    insist(total <= STDIN_LIMIT, 'Git hook stdin limit');
    chunks.push(block.subarray(0, count));
  }
}
function plumbing(
  request: GitPlumbingRequest,
  environment: Record<string, string>,
  root: string,
  authorizedPaths: readonly string[]
): Buffer {
  insist(request.cwd === root);
  const argv = [...request.argv];
  const joined = argv.join('\0');
  const query = [
    'rev-parse\0--path-format=absolute\0--git-path\0index',
    'rev-parse\0--path-format=absolute\0--git-path\0objects',
    'rev-parse\0--show-object-format',
    'ls-files\0--stage\0-z',
  ].includes(joined);
  const blob =
    argv[0] === 'hash-object' &&
    (argv.length === 3 || (argv.length === 4 && argv[1] === '-w')) &&
    argv[argv.length - 1] === '--stdin' &&
    argv[argv.length - 2]!.startsWith('--path=') &&
    authorizedPaths.includes(argv[argv.length - 2]!.slice('--path='.length));
  insist(query || blob, 'Unsupported trusted Git plumbing');
  insist(
    Object.entries(request.env).every(
      ([name, item]) =>
        [
          'GIT_INDEX_FILE',
          'GIT_OBJECT_DIRECTORY',
          'GIT_ALTERNATE_OBJECT_DIRECTORIES',
          'GIT_OPTIONAL_LOCKS',
        ].includes(name) && text(item)
    )
  );
  return execFileSync(
    '/usr/bin/git',
    ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', ...argv],
    {
      cwd: root,
      env: { ...environment, ...request.env },
      stdio: [request.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      ...(request.input === undefined ? {} : { input: request.input }),
      timeout: 10000,
      maxBuffer: 40 * 1024 * 1024,
    }
  );
}
export interface GitHookClientOptions {
  readonly bridgeFd?: number;
  readonly stdinFd?: number;
  readonly environment?: NodeJS.ProcessEnv;
}
/** Returns the actual hook status, or 1 on failed protocol/publication. Native
 * always receives a finish attempt after a context has been opened. */
export function runGitHookClient(
  argv: readonly string[],
  options: GitHookClientOptions = {}
): number {
  const fd = options.bridgeFd ?? 4;
  let contextId: string | undefined;
  let exitCode = 1;
  let publication: GitHookPublicationDisposition = 'not-published';
  let failed = false;
  try {
    insist(
      argv.length >= 3 &&
        argv[0] === '--hook' &&
        hookName(argv[1]) &&
        argv[2] === '--' &&
        strings(argv.slice(3), 256),
      'Unsupported Git hook arguments'
    );
    const cwd = fs.realpathSync.native(process.cwd());
    const environment = collectEnvironment(options.environment ?? process.env);
    const stdinFd = options.stdinFd ?? 0;
    insist(stdinFd !== fd && stdinFd !== 3, 'Git hook stdin fd unavailable');
    const stdin = readStdin(stdinFd);
    const opened = bridgeRequest(
      {
        operation: 'open',
        cwd,
        hook: argv[1],
        args: argv.slice(3),
        gitEnvironment: environment,
        stdinBase64: stdin.toString('base64'),
      },
      fd
    );
    contextId = opened.contextId as string;
    const transactionRoot = opened.transactionRoot as string;
    const cleanEnvironment = opened.gitEnvironment as Record<string, string>;
    insist(
      cleanEnvironment.PATH &&
        cleanEnvironment.LC_ALL === 'C' &&
        (cleanEnvironment.PWD === undefined || cleanEnvironment.PWD === cwd),
      'Native clean Git environment unavailable'
    );
    const actualIndex = environment.GIT_INDEX_FILE;
    const cleanIndex = cleanEnvironment.GIT_INDEX_FILE;
    if (actualIndex !== undefined)
      insist(
        actualIndex &&
          cleanIndex &&
          path.resolve(cwd, actualIndex) === path.resolve(cwd, cleanIndex),
        'Native Git callback index mismatch'
      );
    const assertCanonicalAuthority = (): void => {
      bridgeRequest({ operation: 'assert', contextId: contextId! }, fd);
    };
    const authorizedPaths = opened.authorizedPaths as string[];
    const transaction = captureGitHookTransaction({
      projectRoot: cwd,
      invocationRoot: transactionRoot,
      authorizedPaths,
      ...(cleanIndex === undefined ? {} : { gitIndexPath: path.resolve(cwd, cleanIndex) }),
      git: (request) => plumbing(request, cleanEnvironment, cwd, authorizedPaths),
      assertCanonicalAuthority,
    });
    const seed = transaction.seedIndex();
    const seedIndexPath = path.join(transactionRoot, `git-seed-${randomUUID()}`);
    const seedFd = fs.openSync(
      seedIndexPath,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW,
      0o600
    );
    try {
      writeAll(seedFd, seed);
      fs.fchmodSync(seedFd, 0o400);
      fs.fsyncSync(seedFd);
    } finally {
      fs.closeSync(seedFd);
    }
    const executed = bridgeRequest(
      {
        operation: 'execute',
        contextId,
        seedIndexPath,
        seedIndexSha256: createHash('sha256').update(seed).digest('hex'),
        objectDirectory: transaction.objectDirectory,
      },
      fd
    );
    writeAll(1, base64(executed.stdoutBase64));
    writeAll(2, base64(executed.stderrBase64));
    exitCode = executed.exitCode as number;
    if (exitCode === 0) {
      insist(
        executed.privateIndexPath !== transaction.indexPath &&
          executed.privateObjectDirectory !== transaction.objectDirectory &&
          executed.privateIndexPath !== seedIndexPath &&
          path.dirname(executed.privateIndexPath as string) !== transactionRoot &&
          path.dirname(executed.privateIndexPath as string) ===
            path.dirname(executed.privateObjectDirectory as string),
        'Native quarantine roles overlap'
      );
      const candidate = validateGitHookTransaction(
        transaction,
        executed.privateIndexPath as string
      );
      publication = publishGitHookTransaction(candidate).disposition;
    }
  } catch (error) {
    failed = true;
    exitCode = 1;
    if (error instanceof GitHookTransactionError) publication = error.disposition;
    writeAll(
      2,
      Buffer.from(
        `caws Git hook client failed: ${error instanceof Error ? error.message : 'infrastructure unavailable'}\n`
      )
    );
  } finally {
    if (contextId !== undefined) {
      try {
        bridgeRequest({ operation: 'finish', contextId, exitCode, publication }, fd);
      } catch (error) {
        failed = true;
        writeAll(
          2,
          Buffer.from(
            `caws Git hook finish failed: ${error instanceof Error ? error.message : 'infrastructure unavailable'}\n`
          )
        );
      }
    }
  }
  return failed ? 1 : exitCode;
}

if (require.main === module) {
  try {
    process.exitCode = runGitHookClient(process.argv.slice(2));
  } catch {
    process.stderr.write('caws Git hook client infrastructure unavailable\n');
    process.exitCode = 1;
  }
}
