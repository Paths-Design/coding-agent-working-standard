import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, parse, sep } from 'node:path';
import { TextDecoder } from 'node:util';
import { parseJsonSource } from '../runtime/json-custody';
import { ExecutionAuthorityUnavailable } from './authority';
import type { PreparedExecutionV1 } from './prepared';

export type NpmProjectSnapshot = NonNullable<PreparedExecutionV1['profile']['npm']>['project'];
const MAX_ENTRIES = 1024;
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const RESERVED = new Set(['node', 'npm', 'npx', 'sh']);

function refuse(): never {
  throw new ExecutionAuthorityUnavailable('unsupported_profile');
}
function live(deadline: number): void {
  if (Date.now() >= deadline) throw new ExecutionAuthorityUnavailable('deadline_expired');
}
function identity(stat: fs.BigIntStats, directory = false): readonly string[] {
  const stable = [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid].map(String);
  return directory
    ? stable
    : [...stable, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].map(String);
}
function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Observe path components without hashing unrelated ancestor-directory times. */
function trace(path: string): unknown[] {
  if (!isAbsolute(path)) refuse();
  const root = parse(path).root;
  const result: unknown[] = [];
  let current = root;
  for (const part of [root, ...path.slice(root.length).split(sep).filter(Boolean)]) {
    if (part !== root) current = join(current, part);
    let stat: fs.BigIntStats;
    try {
      stat = fs.lstatSync(current, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        result.push(['absent', current]);
        return result;
      }
      throw error;
    }
    if (stat.isSymbolicLink()) {
      result.push([
        'link',
        current,
        identity(stat),
        fs.readlinkSync(current),
        fs.realpathSync.native(current),
      ]);
      if (!fs.statSync(current).isDirectory()) refuse();
    } else {
      if (!stat.isDirectory()) refuse();
      result.push(['directory', current, identity(stat, true)]);
    }
  }
  return result;
}

function readImage(
  path: string,
  maximum: number,
  budget: { bytes: number },
  deadline: number,
  capture = false
) {
  live(deadline);
  const fd = fs.openSync(
    path,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
  );
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(maximum)) refuse();
    const chunks: Buffer[] = [];
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(65536);
    let offset = 0;
    for (;;) {
      live(deadline);
      const count = fs.readSync(fd, buffer, 0, buffer.length, offset);
      if (count === 0) break;
      offset += count;
      budget.bytes += count;
      if (offset > maximum || budget.bytes > MAX_TOTAL_BYTES) refuse();
      const bytes = Buffer.from(buffer.subarray(0, count));
      if (capture) chunks.push(bytes);
      hash.update(bytes);
    }
    if (
      BigInt(offset) !== before.size ||
      !same(identity(before), identity(fs.fstatSync(fd, { bigint: true }))) ||
      !same(identity(before), identity(fs.lstatSync(path, { bigint: true })))
    )
      refuse();
    return {
      image: { path, sha256: hash.digest('hex') },
      identity: identity(before),
      bytes: Buffer.concat(chunks),
    };
  } finally {
    fs.closeSync(fd);
  }
}

function names(path: string): string[] {
  const directory = fs.opendirSync(path, { bufferSize: 32 });
  const values: string[] = [];
  try {
    for (let entry = directory.readSync(); entry !== null; entry = directory.readSync()) {
      const value = entry.name;
      if (!value || /[^\x20-\x7e]/u.test(value) || Buffer.byteLength(value) > 4096) refuse();
      values.push(value);
      if (values.length > MAX_ENTRIES) refuse();
    }
  } finally {
    directory.closeSync();
  }
  return values.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
}

function binDirectory(
  path: string,
  budget: { bytes: number; entries: number },
  deadline: number
): unknown {
  const beforeTrace = trace(path);
  if ((beforeTrace.at(-1) as unknown[])[0] === 'absent') {
    if (!same(beforeTrace, trace(path))) refuse();
    return [path, beforeTrace];
  }
  const physical = fs.realpathSync.native(path);
  const before = fs.statSync(physical, { bigint: true });
  if (!before.isDirectory()) refuse();
  const entries = names(path);
  budget.entries += entries.length;
  if (budget.entries > MAX_ENTRIES) refuse();
  const captured = entries.map((name) => {
    live(deadline);
    if (RESERVED.has(name.toLowerCase())) refuse();
    const logical = join(path, name);
    const entry = fs.lstatSync(logical, { bigint: true });
    if (!entry.isFile() && !entry.isSymbolicLink()) refuse();
    const link = entry.isSymbolicLink() ? fs.readlinkSync(logical) : null;
    const target = fs.realpathSync.native(logical);
    const image = readImage(target, MAX_IMAGE_BYTES, budget, deadline);
    if (
      !same(identity(entry), identity(fs.lstatSync(logical, { bigint: true }))) ||
      (link !== null && link !== fs.readlinkSync(logical)) ||
      fs.realpathSync.native(logical) !== target
    )
      refuse();
    return [name, identity(entry), link, image.image.path, image.identity, image.image.sha256];
  });
  if (
    !same(entries, names(path)) ||
    fs.realpathSync.native(path) !== physical ||
    !same(identity(before), identity(fs.statSync(physical, { bigint: true }))) ||
    !same(beforeTrace, trace(path))
  )
    refuse();
  return [path, beforeTrace, physical, identity(before), captured];
}

/** The producer uses an explicit npm --prefix and absolute /bin/sh profile.
 * This observes npm's additional lifecycle search directories; it executes no
 * package code and confers neither authority nor immutable-file custody.
 */
export function snapshotNpmProject(
  cwd: string,
  safePath: string,
  deadline: number
): NpmProjectSnapshot {
  try {
    live(deadline);
    if (cwd.includes(':') || fs.realpathSync.native(cwd) !== cwd || !fs.statSync(cwd).isDirectory())
      refuse();
    const safeDirectories = safePath.split(':');
    if (
      !safeDirectories.length ||
      safeDirectories.some((path) => !isAbsolute(path) || fs.realpathSync.native(path) !== path)
    )
      refuse();
    try {
      fs.lstatSync(join(cwd, '.npmrc'));
      refuse();
    } catch (error) {
      if (error instanceof ExecutionAuthorityUnavailable) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const budget = { bytes: 0, entries: 0 };
    const packageJson = readImage(join(cwd, 'package.json'), 1048576, budget, deadline, true);
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      packageJson.bytes
    );
    parseJsonSource(text, 32, 50_000, true);
    const value: unknown = JSON.parse(text);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) refuse();
    const scripts = (value as Record<string, unknown>).scripts;
    if (scripts === null || typeof scripts !== 'object' || Array.isArray(scripts)) refuse();
    const script = scripts as Record<string, unknown>;
    if (
      typeof script.test !== 'string' ||
      !script.test ||
      script.test.includes('\0') ||
      Buffer.byteLength(script.test) > 65536 ||
      Object.hasOwn(script, 'pretest') ||
      Object.hasOwn(script, 'posttest')
    )
      refuse();
    const directories: string[] = [];
    for (let current = cwd; ; current = dirname(current)) {
      directories.push(join(current, 'node_modules', '.bin'));
      if (directories.length > 64) refuse();
      if (dirname(current) === current) break;
    }
    const transcript = directories.map((path) => binDirectory(path, budget, deadline));
    live(deadline);
    return {
      packageJson: packageJson.image,
      npmrc: null,
      testScript: script.test,
      pathShadowSha256: createHash('sha256')
        .update(JSON.stringify(['caws.npm-lifecycle-path.v1', cwd, safePath, transcript]))
        .digest('hex'),
    };
  } catch (error) {
    if (error instanceof ExecutionAuthorityUnavailable) throw error;
    return refuse();
  }
}
