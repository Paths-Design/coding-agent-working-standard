import * as fs from 'node:fs';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  prepareFrozenProductionSource,
  type FrozenSourcePreparationContext,
  type FrozenSourcePreparationRequest,
  type FrozenSourcePreparationResult,
} from './native-qualification-prepare';

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_OBJECT_BATCH_BYTES = 512 * 1024 * 1024;
const MAX_CHUNK_BYTES = 256 * 1024;
const MAX_METADATA_BYTES = 1024 * 1024;

export interface PreparationParentChannel {
  read(): unknown;
  write(frame: unknown): void;
}

function record(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')
  )
    throw new Error('Unexpected preparation channel fields');
}

function decoded(value: unknown, maximum: number): Buffer {
  if (typeof value !== 'string' || value.length > Math.ceil(maximum / 3) * 4)
    throw new Error('Preparation channel byte bound exceeded');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > maximum) throw new Error('Preparation channel byte bound exceeded');
  if (bytes.toString('base64') !== value)
    throw new Error('Invalid preparation channel byte encoding');
  return bytes;
}

function absolute(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length > 4096 ||
    value.includes('\0') ||
    !path.isAbsolute(value) ||
    path.resolve(value) !== value
  )
    throw new Error('Invalid preparation channel directory');
}

/**
 * Consume the private channel created by the independently selected Rust parent.
 * Framing/type/descriptor checks preserve that transport; they do not authenticate
 * an arbitrary process that fabricates a socket or a context-shaped JSON object.
 * The normal parent fixes startup and captures ordinary CLI context before spawn.
 * No context field is accepted from the preparation request itself.
 */
export function executePreparationParentChannel(
  channel: PreparationParentChannel
): FrozenSourcePreparationResult {
  const initial = channel.read();
  record(initial, ['kind', 'request', 'cwd', 'parentPid', 'environment', 'remainingMs']);
  if (initial.kind !== 'start') throw new Error('Expected preparation channel start');
  const request = decoded(initial.request, MAX_REQUEST_BYTES);
  absolute(initial.cwd);
  if (!Number.isSafeInteger(initial.parentPid) || initial.parentPid !== process.ppid)
    throw new Error('Preparation parent process correspondence failed');
  if (
    !initial.environment ||
    typeof initial.environment !== 'object' ||
    Array.isArray(initial.environment) ||
    JSON.stringify(initial.environment).length > 128 * 1024
  )
    throw new Error('Invalid preparation caller environment');
  for (const [name, value] of Object.entries(initial.environment)) {
    if (
      !name ||
      name.length > 256 ||
      name.includes('=') ||
      name.includes('\0') ||
      typeof value !== 'string' ||
      value.includes('\0')
    )
      throw new Error('Invalid preparation caller environment member');
  }
  if (
    !Number.isSafeInteger(initial.remainingMs) ||
    (initial.remainingMs as number) <= 0 ||
    (initial.remainingMs as number) > 120_000
  )
    throw new Error('Invalid preparation original remaining interval');
  // This is only a local restriction. The Rust parent retains the authoritative
  // original clock and never grants a new interval in a subsequent reply.
  let expires = performance.now() + (initial.remainingMs as number);
  let sequence = 0;
  const next = (): number => {
    if (performance.now() >= expires) throw new Error('Preparation channel deadline expired');
    if (++sequence > 500_000) throw new Error('Preparation channel request bound exceeded');
    return sequence;
  };
  const checkpoint = (): void => {
    if (process.ppid !== initial.parentPid)
      throw new Error('Preparation parent process correspondence changed');
    const seq = next();
    channel.write({ kind: 'checkpoint', seq });
    const reply = channel.read();
    record(reply, ['kind', 'seq', 'remainingMs']);
    if (
      reply.kind !== 'ok' ||
      reply.seq !== seq ||
      !Number.isSafeInteger(reply.remainingMs) ||
      (reply.remainingMs as number) <= 0 ||
      (reply.remainingMs as number) > 120_000
    )
      throw new Error('Preparation checkpoint correlation or deadline failed');
    expires = Math.min(expires, performance.now() + (reply.remainingMs as number));
    if (performance.now() >= expires) throw new Error('Preparation channel deadline expired');
  };
  const git: FrozenSourcePreparationContext['git'] = (args, options) => {
    absolute(options.cwd);
    const exact = (expected: readonly string[]): boolean =>
      args.length === expected.length && args.every((value, index) => value === expected[index]);
    let operation: string;
    let ignoredPath: string | undefined;
    if (exact(['rev-parse', '--path-format=absolute', '--git-common-dir'])) operation = 'commonDir';
    else if (exact(['rev-parse', '--show-toplevel'])) operation = 'topLevel';
    else if (exact(['rev-parse', '--show-object-format'])) operation = 'objectFormat';
    else if (exact(['rev-parse', '--verify', 'HEAD^{commit}'])) operation = 'headCommit';
    else if (exact(['rev-parse', '--verify', 'HEAD^{tree}'])) operation = 'headTree';
    else if (
      args.length === 5 &&
      args.slice(0, 4).join('\0') === ['check-ignore', '--quiet', '--no-index', '--'].join('\0')
    ) {
      operation = 'ignored';
      ignoredPath = args[4];
      if (
        !ignoredPath ||
        ignoredPath.length > 4096 ||
        ignoredPath.includes('\0') ||
        path.posix.isAbsolute(ignoredPath) ||
        path.posix.normalize(ignoredPath) !== ignoredPath ||
        ignoredPath.split('/').some((part) => !part || part === '.' || part === '..')
      )
        throw new Error('Invalid preparation ignore path');
    } else throw new Error('Unmodeled preparation Git query');
    checkpoint();
    const seq = next();
    channel.write({
      kind: 'metadata',
      seq,
      operation,
      cwd: options.cwd,
      ...(ignoredPath === undefined ? {} : { path: ignoredPath }),
    });
    const reply = channel.read();
    record(reply, ['kind', 'seq', 'exitCode', 'stdout', 'stderr']);
    if (
      reply.kind !== 'gitResult' ||
      reply.seq !== seq ||
      !Number.isInteger(reply.exitCode) ||
      (reply.exitCode as number) < 0 ||
      (reply.exitCode as number) > 255
    )
      throw new Error('Preparation Git reply correlation failed');
    const stdout = decoded(reply.stdout, MAX_METADATA_BYTES);
    const stderr = decoded(reply.stderr, MAX_METADATA_BYTES);
    if (stdout.length + stderr.length > MAX_METADATA_BYTES)
      throw new Error('Preparation metadata reply byte bound exceeded');
    checkpoint();
    if (reply.exitCode !== 0)
      throw Object.assign(new Error('Fixed preparation Git query failed'), {
        status: reply.exitCode,
        stdout,
        stderr,
      });
    const text = stdout.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(stdout))
      throw new Error('Preparation Git output is not UTF-8');
    // Git emits one terminal LF. Other whitespace belongs to the actual path.
    return text.endsWith('\n') ? text.slice(0, -1) : text;
  };
  const readObjects: FrozenSourcePreparationContext['readObjects'] = (selections) => {
    if (
      !Array.isArray(selections) ||
      selections.length === 0 ||
      selections.length > 50_000 ||
      selections.some(
        (value) =>
          !value ||
          Object.keys(value).sort().join('\0') !== 'kind\0oid' ||
          !['commit', 'tree', 'blob'].includes(value.kind) ||
          !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value.oid)
      )
    )
      throw new Error('Invalid preparation object selection');
    checkpoint();
    const seq = next();
    channel.write({ kind: 'objects', seq, selections });
    const chunks: Buffer[] = [];
    let size = 0;
    for (;;) {
      const reply = channel.read();
      if (!reply || typeof reply !== 'object' || Array.isArray(reply))
        throw new Error('Invalid preparation object response');
      if ((reply as Record<string, unknown>).kind === 'objectChunk') {
        record(reply, ['kind', 'seq', 'data']);
        if (reply.seq !== seq) throw new Error('Preparation object chunk correlation failed');
        const chunk = decoded(reply.data, MAX_CHUNK_BYTES);
        size += chunk.length;
        if (chunk.length === 0 || size > MAX_OBJECT_BATCH_BYTES || performance.now() >= expires)
          throw new Error('Preparation object response bound or deadline exceeded');
        chunks.push(chunk);
      } else {
        record(reply, ['kind', 'seq', 'exitCode', 'stderr']);
        if (
          reply.kind !== 'objectEnd' ||
          reply.seq !== seq ||
          !Number.isInteger(reply.exitCode) ||
          (reply.exitCode as number) < 0 ||
          (reply.exitCode as number) > 255
        )
          throw new Error('Preparation object reply correlation failed');
        const stderr = decoded(reply.stderr, MAX_METADATA_BYTES);
        checkpoint();
        if (reply.exitCode !== 0)
          throw Object.assign(new Error('Fixed preparation object query failed'), { stderr });
        return Buffer.concat(chunks, size);
      }
    }
  };
  const result = executeFrozenSourcePreparation(request, {
    cwd: initial.cwd,
    environment: initial.environment as NodeJS.ProcessEnv,
    git,
    readObjects,
    checkpoint,
  });
  channel.write({ kind: 'result', seq: ++sequence, result });
  return result;
}

/** No descriptor integer is authority: only the admitted fixed parent uses this
 * transport in the supported operation. Direct invocation remains unadmitted. */
export function preparationDescriptorChannel(fd: number): PreparationParentChannel {
  if (!Number.isSafeInteger(fd) || fd < 64 || fd > 1_048_575)
    throw new Error('Invalid preparation parent descriptor');
  const original = fs.fstatSync(fd, { bigint: true });
  if (!original.isSocket() || original.uid !== BigInt(process.geteuid?.() ?? -1))
    throw new Error('Expected an owned preparation parent socket');
  for (const stream of [0, 1, 2]) {
    const other = fs.fstatSync(stream, { bigint: true });
    if (original.dev === other.dev && original.ino === other.ino)
      throw new Error('Preparation parent socket aliases standard I/O');
  }
  const check = (): void => {
    const current = fs.fstatSync(fd, { bigint: true });
    if (
      !current.isSocket() ||
      current.dev !== original.dev ||
      current.ino !== original.ino ||
      current.uid !== original.uid
    )
      throw new Error('Preparation parent socket identity changed');
  };
  const receive = (size: number): Buffer => {
    const bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      check();
      const read = fs.readSync(fd, bytes, offset, size - offset, null);
      if (read === 0) throw new Error('Preparation parent channel closed');
      offset += read;
    }
    return bytes;
  };
  return {
    read() {
      const length = receive(4).readUInt32BE();
      if (length === 0 || length > MAX_FRAME_BYTES)
        throw new Error('Preparation channel frame bound exceeded');
      const bytes = receive(length);
      const text = bytes.toString('utf8');
      if (!Buffer.from(text, 'utf8').equals(bytes))
        throw new Error('Preparation channel frame is not UTF-8');
      return JSON.parse(text);
    },
    write(frame) {
      const bytes = Buffer.from(JSON.stringify(frame), 'utf8');
      if (bytes.length === 0 || bytes.length > MAX_FRAME_BYTES)
        throw new Error('Preparation channel frame bound exceeded');
      const header = Buffer.alloc(4);
      header.writeUInt32BE(bytes.length);
      for (const part of [header, bytes]) {
        let offset = 0;
        while (offset < part.length) {
          check();
          const written = fs.writeSync(fd, part, offset, part.length - offset, null);
          if (written === 0) throw new Error('Preparation parent channel made no progress');
          offset += written;
        }
      }
    },
  };
}

function refused(phase: string, reason: string): FrozenSourcePreparationResult {
  return { status: 'failed', adoption: 'NOT_ADOPTED', writerState: 'NOT_STARTED', phase, reason };
}

/**
 * Bounded request handler for an independently admitted maintained parent.
 * The parent owns Node/Git startup, actual caller context, fixed metadata Git
 * and private object-store access before invoking this handler. Parent context
 * is a separate programmatic dependency and must never come from request JSON.
 * This module supplies no process/env/path fallback or self-attested capability.
 */
export function executeFrozenSourcePreparation(
  bytes: Buffer,
  parent: FrozenSourcePreparationContext
): FrozenSourcePreparationResult {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_REQUEST_BYTES)
    return refused('input', 'Expected bounded UTF-8 JSON request bytes');
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes))
    return refused('input', 'Preparation request must be valid UTF-8');
  let request: unknown;
  try {
    request = JSON.parse(text);
  } catch {
    return refused('input', 'Preparation request is not valid JSON');
  }
  if (
    !parent ||
    typeof parent.git !== 'function' ||
    typeof parent.readObjects !== 'function' ||
    typeof parent.checkpoint !== 'function'
  )
    return refused('parent', 'An independently admitted maintained parent is required');
  // The core validates the closed request shape and re-derives source/output
  // standing; parsing or parent-shaped data alone establishes neither.
  return prepareFrozenProductionSource(request as FrozenSourcePreparationRequest, parent);
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2 || args[0] !== '--parent-fd' || !/^[1-9][0-9]*$/.test(args[1]!))
      throw new Error(
        'Frozen preparation requires its maintained parent; standalone use is not admitted.'
      );
    const fd = Number(args[1]);
    const channel = preparationDescriptorChannel(fd);
    const result = executePreparationParentChannel(channel);
    fs.closeSync(fd);
    process.exitCode = result.status === 'prepared' ? 0 : 2;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
