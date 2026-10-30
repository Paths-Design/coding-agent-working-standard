import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, parse, sep } from 'node:path';
import { TextDecoder } from 'node:util';
import { ExecutionAuthorityUnavailable } from './authority';
import type { ProgramImage } from './prepared';

export interface CargoProjectSnapshot {
  readonly manifest: ProgramImage;
  readonly lock: ProgramImage;
  readonly entry: ProgramImage;
  readonly packageName: string;
  readonly version: string;
  readonly edition: '2015' | '2018' | '2021' | '2024';
  readonly configurationSha256: string;
}

const MAX_ANCESTORS = 64;
const MAX_METADATA_BYTES = 65536;
const MAX_ENTRY_BYTES = 1048576;
const MAX_TOTAL_BYTES = 3 * 1048576;
const NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const VERSION = /^(?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8})$/;

function refuse(): never {
  throw new ExecutionAuthorityUnavailable('unsupported_profile');
}
function live(deadline: number): void {
  if (!Number.isSafeInteger(deadline) || Date.now() >= deadline)
    throw new ExecutionAuthorityUnavailable('deadline_expired');
}
function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
function identity(stat: fs.BigIntStats, directory = false): readonly string[] {
  const values = [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid];
  // Unrelated sibling writes must not change an ancestor's identity.
  return (directory ? values : [...values, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs]).map(
    String
  );
}
function nativePath(path: string): void {
  if (
    typeof path !== 'string' ||
    !isAbsolute(path) ||
    Buffer.byteLength(path) > 4096 ||
    /\p{Cc}/u.test(path) ||
    Buffer.from(path).toString('utf8') !== path
  )
    refuse();
}

/** Deliberately a minimal admission grammar, not a general TOML parser:
 * blank/comment lines, [package], and exactly name/version/edition as plain
 * double-quoted ASCII scalars. Escapes, alternate tables, keys and values
 * outside the declared scalar alphabets are unsupported.
 */
function lines(bytes: Buffer): string[] {
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  if (
    /\r(?!\n)/.test(text) ||
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(text) ||
    text.includes('\uFEFF')
  )
    refuse();
  return text
    .split(/\r?\n/)
    .map((line) => line.split('#', 1)[0]!.replace(/^[ \t]+|[ \t]+$/g, ''))
    .filter((line) => line.length > 0);
}
function scalar(line: string): [string, string] {
  const match = /^(name|version|edition)[ \t]*=[ \t]*"([A-Za-z0-9_.-]+)"$/.exec(line);
  if (!match) refuse();
  return [match[1]!, match[2]!];
}
function packageMetadata(
  bytes: Buffer
): Pick<CargoProjectSnapshot, 'packageName' | 'version' | 'edition'> {
  const source = lines(bytes);
  if (source.shift() !== '[package]' || source.length !== 3) refuse();
  const fields = new Map<string, string>();
  for (const line of source) {
    const [key, value] = scalar(line);
    if (fields.has(key)) refuse();
    fields.set(key, value);
  }
  const packageName = fields.get('name');
  const version = fields.get('version');
  const edition = fields.get('edition');
  if (
    packageName === undefined ||
    !NAME.test(packageName) ||
    version === undefined ||
    !VERSION.test(version) ||
    (edition !== '2015' && edition !== '2018' && edition !== '2021' && edition !== '2024')
  )
    refuse();
  return { packageName, version, edition };
}
function lockMatches(bytes: Buffer, metadata: ReturnType<typeof packageMetadata>): void {
  const source = lines(bytes);
  if (
    !/^version[ \t]*=[ \t]*[34]$/.test(source.shift() ?? '') ||
    source.shift() !== '[[package]]' ||
    source.length !== 2
  )
    refuse();
  const fields = new Map<string, string>();
  for (const line of source) {
    const [key, value] = scalar(line);
    if ((key !== 'name' && key !== 'version') || fields.has(key)) refuse();
    fields.set(key, value);
  }
  if (fields.get('name') !== metadata.packageName || fields.get('version') !== metadata.version)
    refuse();
}

function readImage(path: string, maximum: number, budget: { bytes: number }, deadline: number) {
  live(deadline);
  if (fs.realpathSync.native(path) !== path) refuse();
  const fd = fs.openSync(
    path,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
  );
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(maximum)) refuse();
    const hash = createHash('sha256');
    const chunks: Buffer[] = [];
    const buffer = Buffer.alloc(65536);
    let offset = 0;
    for (;;) {
      live(deadline);
      const count = fs.readSync(fd, buffer, 0, buffer.length, offset);
      if (count === 0) break;
      offset += count;
      budget.bytes += count;
      if (offset > maximum || budget.bytes > MAX_TOTAL_BYTES) refuse();
      hash.update(buffer.subarray(0, count));
      if (maximum === MAX_METADATA_BYTES) chunks.push(Buffer.from(buffer.subarray(0, count)));
    }
    if (
      BigInt(offset) !== before.size ||
      !same(identity(before), identity(fs.fstatSync(fd, { bigint: true }))) ||
      !same(identity(before), identity(fs.lstatSync(path, { bigint: true })))
    )
      refuse();
    return {
      image: Object.freeze({ path, sha256: hash.digest('hex') }),
      identity: identity(before),
      bytes: Buffer.concat(chunks),
    };
  } finally {
    fs.closeSync(fd);
  }
}

function configuration(cwd: string, packageRoot: string, deadline: number): unknown[] {
  const observations: unknown[] = [];
  const directories = new Set<string>();
  const directory = (path: string): void => {
    live(deadline);
    if (directories.has(path)) return;
    const stat = fs.lstatSync(path, { bigint: true });
    if (!stat.isDirectory() || fs.realpathSync.native(path) !== path) refuse();
    directories.add(path);
    observations.push(['directory', path, identity(stat, true)]);
  };
  const absent = (path: string): void => {
    live(deadline);
    try {
      fs.lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        observations.push(['absent', path]);
        return;
      }
      throw error;
    }
    refuse();
  };
  const root = parse(packageRoot).root;
  const components = packageRoot.slice(root.length).split(sep).filter(Boolean);
  if (components.length > MAX_ANCESTORS) refuse();
  let physical = root;
  directory(root);
  for (const component of components) {
    physical = join(physical, component);
    directory(physical);
  }
  if (!directories.has(cwd)) refuse();
  directory(join(packageRoot, 'src'));
  let count = 0;
  for (let ancestor = packageRoot; ; ancestor = dirname(ancestor)) {
    if (++count > MAX_ANCESTORS) refuse();
    if (ancestor !== packageRoot) absent(join(ancestor, 'Cargo.toml'));
    const cargo = join(ancestor, '.cargo');
    let present = false;
    try {
      fs.lstatSync(cargo);
      present = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (present) {
      directory(cargo);
      absent(join(cargo, 'config'));
      absent(join(cargo, 'config.toml'));
    } else observations.push(['absent', cargo]);
    if (dirname(ancestor) === ancestor) break;
  }
  for (const path of ['build.rs', 'src/lib.rs', 'src/bin']) absent(join(packageRoot, path));
  live(deadline);
  return observations;
}

/** Observe three default-binary inputs and project/ancestor configuration
 * absence without executing Cargo or writing files. The caller independently
 * pins Cargo/rustc/linker, its environment and sandbox. Rust include!/macros and
 * referenced modules are USER code: this is not attestation of their inputs.
 */
export function snapshotCargoProject(
  cwd: string,
  manifestRelative: string,
  deadlineUnixMs: number
): CargoProjectSnapshot {
  try {
    live(deadlineUnixMs);
    nativePath(cwd);
    if (
      fs.realpathSync.native(cwd) !== cwd ||
      !fs.lstatSync(cwd).isDirectory() ||
      typeof manifestRelative !== 'string' ||
      isAbsolute(manifestRelative) ||
      manifestRelative.includes('\\') ||
      /\p{Cc}/u.test(manifestRelative) ||
      Buffer.byteLength(manifestRelative) > 4096 ||
      Buffer.from(manifestRelative).toString('utf8') !== manifestRelative ||
      manifestRelative.split('/').some((part) => !part || part === '.' || part === '..') ||
      basename(manifestRelative) !== 'Cargo.toml'
    )
      refuse();
    const manifestPath = join(cwd, manifestRelative);
    nativePath(manifestPath);
    if (!manifestPath.startsWith(cwd === parse(cwd).root ? cwd : cwd + sep)) refuse();
    const packageRoot = dirname(manifestPath);
    const before = configuration(cwd, packageRoot, deadlineUnixMs);
    const budget = { bytes: 0 };
    const inputs = [
      readImage(manifestPath, MAX_METADATA_BYTES, budget, deadlineUnixMs),
      readImage(join(packageRoot, 'Cargo.lock'), MAX_METADATA_BYTES, budget, deadlineUnixMs),
      readImage(join(packageRoot, 'src/main.rs'), MAX_ENTRY_BYTES, budget, deadlineUnixMs),
    ] as const;
    const metadata = packageMetadata(inputs[0].bytes);
    lockMatches(inputs[1].bytes, metadata);
    for (const [index, input] of inputs.entries()) {
      const again = readImage(
        input.image.path,
        index === 2 ? MAX_ENTRY_BYTES : MAX_METADATA_BYTES,
        budget,
        deadlineUnixMs
      );
      if (!same(input.image, again.image) || !same(input.identity, again.identity)) refuse();
    }
    if (!same(before, configuration(cwd, packageRoot, deadlineUnixMs))) refuse();
    live(deadlineUnixMs);
    return Object.freeze({
      manifest: inputs[0].image,
      lock: inputs[1].image,
      entry: inputs[2].image,
      ...metadata,
      configurationSha256: createHash('sha256')
        .update(
          JSON.stringify([
            'caws.cargo-project.v1',
            cwd,
            manifestRelative,
            before,
            inputs.map((input) => [input.image, input.identity]),
          ])
        )
        .digest('hex'),
    });
  } catch (error) {
    if (error instanceof ExecutionAuthorityUnavailable) throw error;
    refuse();
  }
}
