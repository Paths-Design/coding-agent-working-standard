import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { runMain } from 'node:module';
import { TextDecoder } from 'node:util';
import { parseJsonSource } from '../runtime/json-custody';

const READY = 'CAWS_FORMATTER_READY_V1 ';
const ENVIRONMENT = new Set([
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
  'CODEX_SANDBOX',
  'CODEX_SANDBOX_NETWORK_DISABLED',
]);
interface Launch {
  readonly schema: 'caws.execution.formatter-bootstrap.v1';
  readonly launchId: string;
  readonly invocationRoot: string;
  readonly cwd: string;
  readonly entry: { readonly path: string; readonly sha256: string };
  readonly args: readonly string[];
  readonly timeoutMs: number;
}
function insist(value: unknown): asserts value {
  if (!value) throw new Error('formatter bootstrap context unavailable');
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
function physical(path: string, directory: boolean): void {
  insist(isAbsolute(path) && !/[\0-\x1f\x7f]/.test(path) && fs.realpathSync.native(path) === path);
  const stat = fs.lstatSync(path);
  insist(!stat.isSymbolicLink() && (directory ? stat.isDirectory() : stat.isFile()));
}
function json(bytes: Buffer): unknown {
  const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  parseJsonSource(source, 12, 2048, true);
  return JSON.parse(source) as unknown;
}
function entryImage(path: string, expected: string): void {
  physical(path, false);
  const fd = fs.openSync(
    path,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
  );
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    insist(before.isFile() && before.nlink === 1n && before.size > 0n && before.size <= 268435456n);
    const hash = createHash('sha256');
    const block = Buffer.alloc(65536);
    let offset = 0;
    for (;;) {
      const count = fs.readSync(fd, block, 0, block.length, offset);
      if (!count) break;
      insist(offset + count <= Number(before.size));
      hash.update(block.subarray(0, count));
      offset += count;
    }
    const after = fs.fstatSync(fd, { bigint: true });
    const named = fs.lstatSync(path, { bigint: true });
    insist(offset === Number(before.size) && hash.digest('hex') === expected);
    insist(
      ['dev', 'ino', 'size', 'mode', 'nlink', 'mtimeNs', 'ctimeNs'].every(
        (key) => before[key as keyof typeof before] === after[key as keyof typeof after]
      )
    );
    insist(named.dev === before.dev && named.ino === before.ino && named.nlink === 1n);
  } finally {
    fs.closeSync(fd);
  }
}
export function parseFormatterBootstrap(argv: readonly string[]): Launch {
  insist(argv.length === 2 && argv[0] === '--launch' && argv[1]!.length <= 131072);
  const bytes = Buffer.from(argv[1]!, 'base64');
  insist(bytes.toString('base64') === argv[1]);
  const value = json(bytes);
  insist(
    exact(value, ['schema', 'launchId', 'invocationRoot', 'cwd', 'entry', 'args', 'timeoutMs'])
  );
  insist(value.schema === 'caws.execution.formatter-bootstrap.v1');
  insist(typeof value.launchId === 'string' && /^[0-9a-f]{64}$/.test(value.launchId));
  insist(typeof value.invocationRoot === 'string' && typeof value.cwd === 'string');
  physical(value.invocationRoot, true);
  physical(value.cwd, true);
  insist(fs.realpathSync.native(process.cwd()) === value.cwd);
  const root = fs.lstatSync(value.invocationRoot);
  insist(root.uid === process.getuid?.() && (root.mode & 0o7777) === 0o700);
  insist(exact(value.entry, ['path', 'sha256']));
  insist(typeof value.entry.path === 'string' && typeof value.entry.sha256 === 'string');
  insist(/^[0-9a-f]{64}$/.test(value.entry.sha256));
  entryImage(value.entry.path, value.entry.sha256);
  insist(
    Array.isArray(value.args) &&
      value.args.length <= 260 &&
      value.args.every(
        (arg) => typeof arg === 'string' && arg.length <= 32768 && !arg.includes('\0')
      )
  );
  insist(Buffer.byteLength(JSON.stringify(value.args)) <= 65536);
  insist(
    Number.isSafeInteger(value.timeoutMs) &&
      Number(value.timeoutMs) > 0 &&
      Number(value.timeoutMs) <= 30000
  );
  // Native must reject startup influences BEFORE spawning this process. This
  // independent check cannot undo a preload that has already executed.
  insist(process.execArgv.length === 0);
  insist(
    Object.entries(process.env).every(([name, item]) => {
      if (name === '__CF_USER_TEXT_ENCODING')
        return (
          process.platform === 'darwin' &&
          typeof item === 'string' &&
          /^(?:0x[0-9a-f]+|[0-9]+):(?:0x[0-9a-f]+|[0-9]+):(?:0x[0-9a-f]+|[0-9]+)$/i.test(item) &&
          Number(item.split(':')[0]) === process.getuid?.()
        );
      return ENVIRONMENT.has(name) && typeof item === 'string' && !item.includes('\0');
    })
  );
  insist(process.env.PATH && process.env.LC_ALL === 'C');
  insist(
    process.env.CODEX_SANDBOX === 'seatbelt' && process.env.CODEX_SANDBOX_NETWORK_DISABLED === '1'
  );
  insist(process.env.PWD === undefined || process.env.PWD === value.cwd);
  return value as unknown as Launch;
}

/** Runs only in the Native-admitted nonempty-v3/no-fork role. No task code is
 * loaded until Native has bound this PID and opened the producer-owned gate. */
export function runFormatterBootstrap(argv: readonly string[]): void {
  const launch = parseFormatterBootstrap(argv);
  const gate = join(launch.invocationRoot, 'formatter-go.json');
  try {
    fs.lstatSync(gate);
    throw new Error('formatter gate already exists');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const environment = Object.fromEntries(
    Object.entries(process.env)
      .filter(([name]) => name !== '__CF_USER_TEXT_ENCODING')
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  );
  const digest = (value: unknown): string =>
    createHash('sha256').update(JSON.stringify(value)).digest('hex');
  fs.writeSync(
    1,
    READY +
      JSON.stringify({
        schema: 'caws.execution.formatter-ready.v1',
        launchId: launch.launchId,
        pid: process.pid,
        node: fs.realpathSync.native(process.execPath),
        cwd: process.cwd(),
        argvSha256: digest(process.argv),
        environmentSha256: digest(environment),
      }) +
      '\n'
  );
  const expires = process.hrtime.bigint() + BigInt(launch.timeoutMs) * 1000000n;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    insist(process.hrtime.bigint() < expires);
    let fd: number;
    try {
      fd = fs.openSync(
        gate,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      Atomics.wait(sleeper, 0, 0, 5);
      continue;
    }
    try {
      const stat = fs.fstatSync(fd);
      insist(
        stat.isFile() &&
          stat.nlink === 1 &&
          stat.uid === process.getuid?.() &&
          (stat.mode & 0o7777) === 0o600 &&
          stat.size > 0 &&
          stat.size <= 1024
      );
      const value = json(fs.readFileSync(fd));
      insist(
        exact(value, ['schema', 'launchId']) &&
          value.schema === 'caws.execution.formatter-go.v1' &&
          value.launchId === launch.launchId
      );
    } finally {
      fs.closeSync(fd);
    }
    break;
  }
  // Preserve normal CLI main-module and argv behavior after recording the real
  // bootstrap tuple. The formatter receives empty stdin and no private fd.
  entryImage(launch.entry.path, launch.entry.sha256);
  process.argv = [process.execPath, launch.entry.path, ...launch.args];
  runMain(launch.entry.path);
}

if (require.main === module) {
  try {
    runFormatterBootstrap(process.argv.slice(2));
  } catch {
    process.stderr.write('caws formatter bootstrap refused\n');
    process.exitCode = 1;
  }
}
