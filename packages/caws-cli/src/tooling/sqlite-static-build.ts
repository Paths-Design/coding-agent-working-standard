import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

/** This tooling receipt grants no package, prefix, release or runtime adoption. */
export interface ReviewedFile {
  path: string;
  sizeBytes: number;
  sha256: string;
}
export interface SqliteStaticBuildRequest {
  sourceC: string;
  sourceHeader: string;
  tools: { clang: ReviewedFile; ar: ReviewedFile; nm: ReviewedFile; otool: ReviewedFile };
  sdk: { root: string; settings: ReviewedFile };
  outputRoot: string;
  /** Cooperative deadline, checked between bounded I/O and by child timers; 1..600000 ms. */
  timeoutMs: number;
  reviewedArchiveSha256?: string;
  /** Combined stdout/stderr bytes per child, 1..16777216; default 1048576. */
  maxOutputBytes?: number;
}
export interface StepReceipt {
  label: string;
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  startedAt: string;
  durationMs: number;
  stdoutPath: string;
  stderrPath: string;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutRetainedBytes: number;
  stderrRetainedBytes: number;
  stdoutSha256: string;
  stderrSha256: string;
  /** Bounded raw bytes remain available when receipt-file persistence fails. */
  stdoutBase64: string;
  stderrBase64: string;
  persistenceError: string | null;
  exitCode: number | null;
  signal: string | null;
  directChildReaped: boolean;
  stopReason: 'abort' | 'timeout' | 'overflow' | 'spawn-error' | null;
  error: string | null;
}
interface BuildBase {
  adoption: 'NOT_ADOPTED';
  outputRoot: string;
  steps: StepReceipt[];
  limits: string[];
}
export interface CompletedBuild extends BuildBase {
  status: 'completed';
  markerPath: string;
  archive: ReviewedFile;
  archiveReview: 'UNREVIEWED_CANDIDATE' | 'REVIEWED_PIN_MATCH';
  artifacts: ReviewedFile[];
}
export interface BuildFailure extends BuildBase {
  status: 'failed';
  phase: string;
  reason: string;
  writerState: 'NOT_STARTED' | 'RETAINED_UNCERTAIN';
  failureReceiptPath: string | null;
}
const SOURCE_ID =
  '2026-07-24 19:02:57 bf7c7f30031888f4e796e429ab3978879485813aaca6f641c7b33e4e09459bcc';
const C_SIZE = 9515341;
const C_SHA3 = '67f423e9ebbbdc473cbc4772c872ee6b89f31fde4ed0279a5c25d5f65c043a16';
const HEADER_SIZE = 690838;
const HEADER_SHA256 = '919e7f2e8ed1d8f56ac17b412b8971c76aa5d1a879752cc6058f75e7d5910e1d';
const LIMITS = [
  'NOT_ADOPTED: recipe completion grants no consumable prefix, CLI, Cargo, runtime or native release authority.',
  'Tool path and pre/post hashes are observations, not immutable executable-image custody.',
  'SDKSettings.json identity does not authenticate the complete SDK or transitive toolchain inputs; the depfile is retained.',
  'Direct-child kill/reap does not establish descendant quiescence. Failed roots retain uncertain writer state and have no cleanup or reuse guarantee.',
  'arm64 macOS current-host execution does not qualify another host, target or older deployment system.',
  'The deadline is cooperative between bounded operations; it does not bound stalled OS I/O, hashing or descendant lifetimes. Direct-child reap observation allows an additional two seconds.',
];
const IDENTITY = `#include <stdio.h>\n#include "sqlite3.h"\nint main(void) {\n printf("version=%s\\nsourceid=%s\\nthreadsafe=%d\\n", sqlite3_libversion(), sqlite3_sourceid(), sqlite3_threadsafe());\n printf("THREADSAFE=%d\\nOMIT_LOAD_EXTENSION=%d\\nENABLE_API_ARMOR=%d\\n", sqlite3_compileoption_used("THREADSAFE=1"), sqlite3_compileoption_used("OMIT_LOAD_EXTENSION"), sqlite3_compileoption_used("ENABLE_API_ARMOR"));\n return 0;\n}\n`;
const sha = (bytes: Buffer, algorithm = 'sha256'): string =>
  createHash(algorithm).update(bytes).digest('hex');
const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
function absolute(value: string): void {
  if (
    typeof value !== 'string' ||
    !path.isAbsolute(value) ||
    value.includes('\0') ||
    path.normalize(value) !== value
  )
    throw new Error('Expected a normalized absolute path');
}
function reviewed(value: ReviewedFile): void {
  absolute(value.path);
  if (
    !Number.isSafeInteger(value.sizeBytes) ||
    value.sizeBytes <= 0 ||
    value.sizeBytes > 256 * 1024 * 1024 ||
    !/^[a-f0-9]{64}$/.test(value.sha256)
  )
    throw new Error('Invalid reviewed file identity');
}
/** Bounded reads use a single no-follow handle and reject observed in-place changes. */
async function bytesAt(file: string, maxBytes: number): Promise<Buffer> {
  const handle = await fs.open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > maxBytes || before.size <= 0)
      throw new Error(`Not a bounded regular file: ${file}`);
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const chunk = Buffer.alloc(Math.min(65536, maxBytes + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > maxBytes) throw new Error(`File grew beyond bound: ${file}`);
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      total !== before.size
    )
      throw new Error(`File changed during read: ${file}`);
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close();
  }
}
async function verify(file: ReviewedFile): Promise<ReviewedFile> {
  reviewed(file);
  const bytes = await bytesAt(file.path, file.sizeBytes);
  if (bytes.length !== file.sizeBytes || sha(bytes) !== file.sha256)
    throw new Error(`Reviewed identity mismatch: ${file.path}`);
  return { ...file };
}
async function noSymlinkDirectories(directory: string): Promise<void> {
  absolute(directory);
  let cursor = path.parse(directory).root;
  for (const component of directory.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    const stat = await fs.lstat(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error(`Not a real directory: ${cursor}`);
  }
}
async function exclusive(file: string, bytes: string | Buffer): Promise<void> {
  const handle = await fs.open(
    file,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function artifact(file: string): Promise<ReviewedFile> {
  const bytes = await bytesAt(file, 32 * 1024 * 1024);
  return { path: file, sizeBytes: bytes.length, sha256: sha(bytes) };
}
/** Parse the BSD ar container, including its padded extended member names. */
function verifyArchive(bytes: Buffer, object: Buffer): void {
  if (bytes.subarray(0, 8).toString('ascii') !== '!<arch>\n')
    throw new Error('Not a static ar archive');
  let cursor = 8;
  let objects = 0;
  let indexes = 0;
  while (cursor < bytes.length) {
    const header = bytes.subarray(cursor, cursor + 60);
    if (header.length !== 60 || header.subarray(58).toString('ascii') !== '`\n')
      throw new Error('Invalid ar member header');
    const sizeText = header.subarray(48, 58).toString('ascii').trim();
    if (!/^\d+$/.test(sizeText)) throw new Error('Invalid ar member size');
    const size = Number(sizeText);
    cursor += 60;
    if (!Number.isSafeInteger(size) || size <= 0 || cursor + size > bytes.length)
      throw new Error('Invalid ar member bounds');
    let content = bytes.subarray(cursor, cursor + size);
    let name = header.subarray(0, 16).toString('ascii').trim();
    if (name.startsWith('#1/')) {
      const lengthText = name.slice(3);
      if (!/^\d+$/.test(lengthText)) throw new Error('Invalid ar extended name');
      const length = Number(lengthText);
      if (length <= 0 || length > content.length)
        throw new Error('Invalid ar extended name bounds');
      name = content.subarray(0, length).toString('ascii').replace(/\0+$/, '');
      content = content.subarray(length);
    } else {
      name = name.replace(/\/$/, '');
    }
    if (name === 'sqlite3.o') {
      objects++;
      if (!content.equals(object)) throw new Error('Archive object differs from compiled object');
    } else if (name === '__.SYMDEF SORTED' || name === '__.SYMDEF') {
      indexes++;
    } else throw new Error(`Unexpected archive member: ${name}`);
    cursor += size;
    if (size % 2) {
      if (bytes[cursor] !== 10) throw new Error('Invalid ar padding');
      cursor++;
    }
  }
  if (cursor !== bytes.length || objects !== 1 || indexes !== 1)
    throw new Error('Expected one SQLite object and one archive symbol index');
}

export interface StepOptions {
  label: string;
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  deadline: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
}
/**
 * Internal tooling boundary for trusted callers that already reviewed executable
 * identity. It observes process I/O; it authenticates no tool or SQLite source and
 * grants no execution/adoption authority. Reaping covers only the direct child.
 */
export async function runSqliteBuildStep(input: StepOptions): Promise<StepReceipt> {
  const options = { ...input, args: [...input.args], env: { ...input.env } };
  const { label, executable, args, cwd, env, deadline, maxOutputBytes, signal } = options;
  absolute(executable);
  absolute(cwd);
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(label)) throw new Error('Invalid step label');
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 16777216)
    throw new Error('Invalid step output bound');
  if (!Number.isSafeInteger(deadline) || deadline > Date.now() + 600000)
    throw new Error('Invalid step deadline');
  if (!args.every((arg) => typeof arg === 'string' && !arg.includes('\0')))
    throw new Error('Invalid step arguments');
  await noSymlinkDirectories(cwd);
  const cwdIdentity = await fs.lstat(cwd);
  const began = Date.now();
  const stdoutPath = path.join(cwd, `${label}.stdout`);
  const stderrPath = path.join(cwd, `${label}.stderr`);
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let retained = 0;
  let exitCode: number | null = null;
  let childSignal: string | null = null;
  let directChildReaped = false;
  let stopReason: StepReceipt['stopReason'] = null;
  let error: string | null = null;
  await new Promise<void>((resolve) => {
    if (signal?.aborted) {
      stopReason = 'abort';
      resolve();
      return;
    }
    if (Date.now() >= deadline) {
      stopReason = 'timeout';
      resolve();
      return;
    }
    let child: ReturnType<typeof spawn>;
    let timer: ReturnType<typeof setTimeout> | undefined = undefined;
    let reapTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(reapTimer);
      signal?.removeEventListener('abort', abort);
      resolve();
    };
    const stop = (why: NonNullable<StepReceipt['stopReason']>): void => {
      if (stopReason) return;
      stopReason = why;
      child.kill('SIGKILL');
      // Descendants may retain pipe writers. Do not wait for their pipe closure.
      child.stdout?.destroy();
      child.stderr?.destroy();
      reapTimer = setTimeout(finish, 2000);
    };
    const abort = (): void => stop('abort');
    try {
      child = spawn(executable, args, {
        cwd,
        env,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (cause) {
      stopReason = 'spawn-error';
      error = message(cause);
      finish();
      return;
    }
    const collect = (channel: Buffer[], data: Buffer, isOut: boolean): void => {
      if (isOut) stdoutBytes += data.length;
      else stderrBytes += data.length;
      const room = Math.max(0, maxOutputBytes - retained);
      const keep = data.subarray(0, room);
      retained += keep.length;
      if (keep.length) channel.push(keep);
      if (stdoutBytes + stderrBytes > maxOutputBytes) stop('overflow');
    };
    child.stdout?.on('data', (data: Buffer) => collect(stdout, data, true));
    child.stderr?.on('data', (data: Buffer) => collect(stderr, data, false));
    child.on('error', (cause) => {
      error = message(cause);
      stopReason = 'spawn-error';
      finish();
    });
    child.on('exit', (code, sig) => {
      exitCode = code;
      childSignal = sig;
      directChildReaped = true;
      if (stopReason) finish();
    });
    child.on('close', finish);
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => stop('timeout'), Math.max(1, deadline - Date.now()));
    if (signal?.aborted) stop('abort');
  });
  const out = Buffer.concat(stdout);
  const err = Buffer.concat(stderr);
  const receipt: StepReceipt = {
    label,
    argv: [executable, ...args],
    cwd,
    env: { ...env },
    startedAt: new Date(began).toISOString(),
    durationMs: Date.now() - began,
    stdoutPath,
    stderrPath,
    stdoutBytes,
    stderrBytes,
    stdoutRetainedBytes: out.length,
    stderrRetainedBytes: err.length,
    stdoutSha256: sha(out),
    stderrSha256: sha(err),
    stdoutBase64: out.toString('base64'),
    stderrBase64: err.toString('base64'),
    persistenceError: null,
    exitCode,
    signal: childSignal,
    directChildReaped,
    stopReason,
    error,
  };
  // A filesystem failure cannot erase the observed child outcome or raw channels.
  const persistenceErrors: string[] = [];
  try {
    await noSymlinkDirectories(cwd);
    const current = await fs.lstat(cwd);
    if (current.dev !== cwdIdentity.dev || current.ino !== cwdIdentity.ino)
      throw new Error('Step working directory identity changed');
  } catch (cause) {
    receipt.persistenceError = message(cause);
    return receipt;
  }
  for (const [file, data] of [
    [stdoutPath, out],
    [stderrPath, err],
  ] as const) {
    try {
      await exclusive(file, data);
    } catch (cause) {
      persistenceErrors.push(message(cause));
    }
  }
  receipt.persistenceError = persistenceErrors.length ? persistenceErrors.join('; ') : null;
  try {
    await exclusive(path.join(cwd, `${label}.step.json`), JSON.stringify(receipt, null, 2));
  } catch (cause) {
    receipt.persistenceError = [receipt.persistenceError, message(cause)]
      .filter(Boolean)
      .join('; ');
  }
  return receipt;
}

export async function buildPinnedSqliteStatic(
  requestInput: SqliteStaticBuildRequest,
  optionsInput: { signal?: AbortSignal } = {}
): Promise<CompletedBuild | BuildFailure> {
  const options = { signal: optionsInput.signal };
  const steps: StepReceipt[] = [];
  let phase = 'request';
  let rootCreated = false;
  let rootIdentity: { dev: number; ino: number } | undefined;
  const outputRoot = requestInput?.outputRoot;
  const deadline = Date.now() + requestInput?.timeoutMs;
  const check = (): void => {
    if (options.signal?.aborted) throw new Error('Build aborted');
    if (Date.now() >= deadline) throw new Error('Build timeout');
  };
  try {
    // Snapshot the caller's mutable object before the first asynchronous boundary.
    const request: SqliteStaticBuildRequest = {
      ...requestInput,
      tools: {
        clang: { ...requestInput.tools.clang },
        ar: { ...requestInput.tools.ar },
        nm: { ...requestInput.tools.nm },
        otool: { ...requestInput.tools.otool },
      },
      sdk: { root: requestInput.sdk.root, settings: { ...requestInput.sdk.settings } },
    };
    absolute(outputRoot);
    absolute(request.sourceC);
    absolute(request.sourceHeader);
    absolute(request.sdk.root);
    if (
      !Number.isSafeInteger(request.timeoutMs) ||
      request.timeoutMs < 1 ||
      request.timeoutMs > 600000
    )
      throw new Error('timeoutMs must be 1..600000');
    const maxOutputBytes = request.maxOutputBytes ?? 1048576;
    if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 16777216)
      throw new Error('maxOutputBytes must be 1..16777216');
    if (
      request.reviewedArchiveSha256 !== undefined &&
      !/^[a-f0-9]{64}$/.test(request.reviewedArchiveSha256)
    )
      throw new Error('Invalid reviewed archive SHA256');
    check();
    phase = 'output-root';
    await noSymlinkDirectories(path.dirname(outputRoot));
    await fs.mkdir(outputRoot, { mode: 0o700 });
    rootCreated = true;
    const rootStat = await fs.lstat(outputRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (rootStat.mode & 0o777) !== 0o700)
      throw new Error('Output root must be a new private directory');
    rootIdentity = { dev: rootStat.dev, ino: rootStat.ino };
    const checkRoot = async (): Promise<void> => {
      await noSymlinkDirectories(outputRoot);
      const current = await fs.lstat(outputRoot);
      if (
        current.dev !== rootIdentity?.dev ||
        current.ino !== rootIdentity?.ino ||
        (current.mode & 0o777) !== 0o700
      )
        throw new Error('Output root identity changed');
    };
    phase = 'reviewed-inputs';
    const toolEntries = Object.entries(request.tools);
    if (
      toolEntries.length !== 4 ||
      !['clang', 'ar', 'nm', 'otool'].every((name) => toolEntries.some(([key]) => key === name))
    )
      throw new Error('Exactly clang/ar/nm/otool tool identities required');
    await noSymlinkDirectories(request.sdk.root);
    if (request.sdk.settings.path !== path.join(request.sdk.root, 'SDKSettings.json'))
      throw new Error('SDK settings must be SDKSettings.json under SDK root');
    for (const [, tool] of toolEntries) {
      check();
      await verify(tool);
    }
    await verify(request.sdk.settings);
    phase = 'source-authentication';
    check();
    const source = await bytesAt(request.sourceC, C_SIZE);
    const header = await bytesAt(request.sourceHeader, HEADER_SIZE);
    if (source.length !== C_SIZE || sha(source, 'sha3-256') !== C_SHA3)
      throw new Error('SQLite C source pin mismatch');
    if (header.length !== HEADER_SIZE || sha(header) !== HEADER_SHA256)
      throw new Error('SQLite header pin mismatch');
    phase = 'staging';
    check();
    await checkRoot();
    await exclusive(path.join(outputRoot, 'sqlite3.c'), source);
    await exclusive(path.join(outputRoot, 'sqlite3.h'), header);
    await exclusive(path.join(outputRoot, 'identity.c'), IDENTITY);
    await exclusive(
      path.join(outputRoot, 'inputs.json'),
      JSON.stringify(
        {
          sourceC: { path: request.sourceC, sizeBytes: C_SIZE, sha3_256: C_SHA3 },
          sourceHeader: {
            path: request.sourceHeader,
            sizeBytes: HEADER_SIZE,
            sha256: HEADER_SHA256,
          },
          tools: request.tools,
          sdk: request.sdk,
        },
        null,
        2
      )
    );
    const env = {
      PATH: '/usr/bin:/bin',
      LANG: 'C',
      LC_ALL: 'C',
      TZ: 'UTC',
      ZERO_AR_DATE: '1',
      SDKROOT: request.sdk.root,
      TMPDIR: outputRoot,
    };
    const execute = async (
      label: string,
      executable: string,
      args: string[]
    ): Promise<StepReceipt> => {
      phase = label;
      check();
      await checkRoot();
      // Recheck all reviewed path bytes before each spawn and after it.
      await noSymlinkDirectories(request.sdk.root);
      for (const [, tool] of toolEntries) await verify(tool);
      await verify(request.sdk.settings);
      check();
      const result = await runSqliteBuildStep({
        label,
        executable,
        args,
        cwd: outputRoot,
        env,
        deadline,
        maxOutputBytes,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      steps.push(result);
      if (
        result.stopReason ||
        result.persistenceError ||
        result.exitCode !== 0 ||
        !result.directChildReaped
      )
        throw new Error(
          `Step ${label} failed: ${result.stopReason ?? result.persistenceError ?? result.error ?? `exit ${result.exitCode}`}`
        );
      check();
      await checkRoot();
      await noSymlinkDirectories(request.sdk.root);
      for (const [, tool] of toolEntries) await verify(tool);
      await verify(request.sdk.settings);
      return result;
    };
    const flags = [
      '-target',
      'arm64-apple-macos11.0',
      '-isysroot',
      request.sdk.root,
      '-std=c11',
      '-O2',
      '-fPIC',
      '-DSQLITE_THREADSAFE=1',
      '-DSQLITE_OMIT_LOAD_EXTENSION=1',
      '-DSQLITE_ENABLE_API_ARMOR=1',
    ];
    await execute('compile-sqlite', request.tools.clang.path, [
      ...flags,
      '-MD',
      '-MF',
      'sqlite3.d',
      '-c',
      'sqlite3.c',
      '-o',
      'sqlite3.o',
    ]);
    const object = await artifact(path.join(outputRoot, 'sqlite3.o'));
    await artifact(path.join(outputRoot, 'sqlite3.d'));
    await execute('archive-sqlite', request.tools.ar.path, ['crs', 'libsqlite3.a', 'sqlite3.o']);
    const archive = await artifact(path.join(outputRoot, 'libsqlite3.a'));
    const objectBytes = await bytesAt(object.path, object.sizeBytes);
    if (sha(objectBytes) !== object.sha256) throw new Error('Compiled object changed');
    verifyArchive(await bytesAt(archive.path, archive.sizeBytes), objectBytes);
    if (
      request.reviewedArchiveSha256 !== undefined &&
      archive.sha256 !== request.reviewedArchiveSha256
    )
      throw new Error('Reviewed archive pin mismatch');
    await execute('link-identity', request.tools.clang.path, [
      ...flags,
      '-I',
      '.',
      'identity.c',
      'libsqlite3.a',
      '-o',
      'identity',
    ]);
    const executable = await artifact(path.join(outputRoot, 'identity'));
    const identityStep = await execute('runtime-identity', executable.path, []);
    const identity = (await bytesAt(identityStep.stdoutPath, maxOutputBytes)).toString('utf8');
    if (
      identity !==
      `version=3.53.4\nsourceid=${SOURCE_ID}\nthreadsafe=1\nTHREADSAFE=1\nOMIT_LOAD_EXTENSION=1\nENABLE_API_ARMOR=1\n`
    )
      throw new Error('Runtime SQLite identity or compile options mismatch');
    const nmStep = await execute('defined-sqlite-symbol', request.tools.nm.path, [
      '-gU',
      'identity',
    ]);
    const symbols = (await bytesAt(nmStep.stdoutPath, maxOutputBytes)).toString('utf8');
    if (!/^\S+\s+T\s+_sqlite3_libversion$/m.test(symbols))
      throw new Error('Identity executable lacks defined SQLite symbol');
    const importsStep = await execute('dynamic-imports', request.tools.otool.path, [
      '-L',
      'identity',
    ]);
    const imports = (await bytesAt(importsStep.stdoutPath, maxOutputBytes)).toString('utf8');
    if (
      !/^identity:\n\s+\/usr\/lib\/libSystem\.B\.dylib \(compatibility version [\d.]+, current version [\d.]+\)\n$/.test(
        imports
      )
    )
      throw new Error('Unexpected dynamic import or invalid otool imports');
    phase = 'publication';
    check();
    await checkRoot();
    const artifacts: ReviewedFile[] = [];
    for (const name of [
      'sqlite3.c',
      'sqlite3.h',
      'identity.c',
      'sqlite3.o',
      'sqlite3.d',
      'libsqlite3.a',
      'identity',
      'inputs.json',
    ])
      artifacts.push(await artifact(path.join(outputRoot, name)));
    if (
      artifacts.find((file) => file.path === archive.path)?.sha256 !== archive.sha256 ||
      artifacts.find((file) => file.path === executable.path)?.sha256 !== executable.sha256 ||
      artifacts.find((file) => file.path === object.path)?.sha256 !== object.sha256
    )
      throw new Error('Artifact changed before publication');
    if (
      sha(await bytesAt(path.join(outputRoot, 'sqlite3.c'), C_SIZE), 'sha3-256') !== C_SHA3 ||
      sha(await bytesAt(path.join(outputRoot, 'sqlite3.h'), HEADER_SIZE)) !== HEADER_SHA256 ||
      (await bytesAt(path.join(outputRoot, 'identity.c'), 4096)).toString('utf8') !== IDENTITY
    )
      throw new Error('Staged source changed before publication');
    await noSymlinkDirectories(request.sdk.root);
    for (const [, tool] of toolEntries) await verify(tool);
    await verify(request.sdk.settings);
    check();
    await checkRoot();
    const markerPath = path.join(outputRoot, 'recipe-completed.json');
    const result: CompletedBuild = {
      status: 'completed',
      adoption: 'NOT_ADOPTED',
      outputRoot,
      markerPath,
      archive,
      archiveReview:
        request.reviewedArchiveSha256 === undefined ? 'UNREVIEWED_CANDIDATE' : 'REVIEWED_PIN_MATCH',
      artifacts,
      steps,
      limits: [...LIMITS],
    };
    // Publish only fully written JSON, atomically and without overwriting a name.
    const pendingPath = path.join(outputRoot, 'recipe-completed.pending.json');
    await exclusive(pendingPath, JSON.stringify(result, null, 2));
    check();
    await checkRoot();
    check();
    // Dispatching the exclusive link is the completion decision: there is no
    // await between this last cancellation/deadline check and link dispatch.
    // A signal after dispatch cannot cancel or undo the filesystem operation.
    await fs.link(pendingPath, markerPath);
    return result;
  } catch (error) {
    const failure: BuildFailure = {
      status: 'failed',
      adoption: 'NOT_ADOPTED',
      outputRoot,
      phase,
      reason: message(error),
      steps,
      limits: [...LIMITS],
      writerState: rootCreated ? 'RETAINED_UNCERTAIN' : 'NOT_STARTED',
      failureReceiptPath: null,
    };
    if (rootCreated) {
      try {
        await noSymlinkDirectories(outputRoot);
        const current = await fs.lstat(outputRoot);
        if (current.dev !== rootIdentity?.dev || current.ino !== rootIdentity?.ino)
          throw new Error('Output root identity changed');
        const receiptPath = path.join(outputRoot, 'build-failed.json');
        await exclusive(receiptPath, JSON.stringify(failure, null, 2));
        failure.failureReceiptPath = receiptPath;
      } catch {
        /* Preserve the original failure; never clean or reuse a contested root. */
      }
    }
    return failure;
  }
}
