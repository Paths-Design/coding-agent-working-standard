import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { constants as osConstants } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { TextDecoder } from 'node:util';
import { parseJsonSource } from '../runtime/json-custody';

function insist(value: unknown): asserts value {
  if (!value) throw new Error('Git hook launch context unavailable');
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
function physical(value: unknown, directory: boolean): string {
  insist(typeof value === 'string' && isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value));
  insist(fs.realpathSync.native(value) === value);
  const stat = fs.lstatSync(value);
  insist(!stat.isSymbolicLink() && (directory ? stat.isDirectory() : stat.isFile()));
  return value;
}
function image(filename: string, expected: unknown, limit: number): Buffer {
  insist(typeof expected === 'string' && /^[0-9a-f]{64}$/.test(expected));
  physical(filename, false);
  const fd = fs.openSync(
    filename,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
  );
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    insist(
      before.isFile() && before.nlink === 1n && before.size >= 0n && before.size <= BigInt(limit)
    );
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd, { bigint: true });
    const named = fs.lstatSync(filename, { bigint: true });
    insist(
      BigInt(bytes.length) === before.size &&
        createHash('sha256').update(bytes).digest('hex') === expected
    );
    insist(
      ['dev', 'ino', 'size', 'mode', 'nlink', 'mtimeNs', 'ctimeNs'].every(
        (key) => before[key as keyof typeof before] === after[key as keyof typeof after]
      )
    );
    insist(named.dev === before.dev && named.ino === before.ino && named.nlink === 1n);
    return bytes;
  } finally {
    fs.closeSync(fd);
  }
}
function base64(value: unknown): Buffer {
  insist(typeof value === 'string' && value.length <= 699052);
  const bytes = Buffer.from(value, 'base64');
  insist(bytes.toString('base64') === value && bytes.length <= 524288);
  return bytes;
}
function overlaps(left: string, right: string): boolean {
  const within = (parent: string, child: string): boolean => {
    const path = relative(parent, child);
    return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
  };
  return within(left, right) || within(right, left);
}
function admittedGitConfig(env: NodeJS.ProcessEnv): boolean {
  const actual = Object.keys(env)
    .filter((name) => name.startsWith('GIT_CONFIG_'))
    .sort();
  const expected = [
    'GIT_CONFIG_COUNT',
    'GIT_CONFIG_KEY_0',
    'GIT_CONFIG_KEY_1',
    'GIT_CONFIG_VALUE_0',
    'GIT_CONFIG_VALUE_1',
  ].sort();
  return (
    actual.length === expected.length &&
    actual.every((name, index) => name === expected[index]) &&
    env.GIT_CONFIG_COUNT === '2' &&
    env.GIT_CONFIG_KEY_0 === 'maintenance.auto' &&
    env.GIT_CONFIG_VALUE_0 === 'false' &&
    env.GIT_CONFIG_KEY_1 === 'gc.auto' &&
    env.GIT_CONFIG_VALUE_1 === '0'
  );
}

/** This entry runs inside the empty-source Host role. Its inherited public Git
 * context points at real read-only metadata until this launcher substitutes the
 * private index and object quarantine. No private control descriptor is inherited. */
export function runGitHookLauncher(argv: readonly string[]): number {
  insist(argv.length === 4 && argv[0] === '--descriptor' && argv[2] === '--sha256');
  const descriptorPath = physical(argv[1], false);
  const bytes = image(descriptorPath, argv[3], 1048576);
  const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  parseJsonSource(source, 12, 8192, true);
  const value: unknown = JSON.parse(source);
  insist(
    exact(value, [
      'schema',
      'hook',
      'args',
      'cwd',
      'seedIndex',
      'objectDirectory',
      'outputRoot',
      'tmpRoot',
      'cacheRoot',
      'channel',
      'stdinBase64',
    ])
  );
  insist(value.schema === 'caws.execution.git-hook-launcher.v1');
  const cwd = physical(value.cwd, true);
  insist(fs.realpathSync.native(process.cwd()) === cwd);
  insist(exact(value.hook, ['path', 'sha256']) && typeof value.hook.path === 'string');
  const hook = physical(value.hook.path, false);
  image(hook, value.hook.sha256, 1048576);
  insist((fs.lstatSync(hook).mode & 0o111) !== 0);
  insist(
    Array.isArray(value.args) &&
      value.args.length <= 256 &&
      value.args.every(
        (arg) => typeof arg === 'string' && arg.length <= 32768 && !arg.includes('\0')
      )
  );
  insist(Buffer.byteLength(JSON.stringify(value.args)) <= 131072);
  insist(exact(value.seedIndex, ['path', 'sha256']) && typeof value.seedIndex.path === 'string');
  const seed = image(value.seedIndex.path, value.seedIndex.sha256, 33554432);
  const objectDirectory = physical(value.objectDirectory, true);
  // Git's alternate environment uses ':' as a delimiter. This bounded role
  // refuses ambiguous paths instead of interpreting another object directory.
  insist(!objectDirectory.includes(':'));
  const roles = [value.outputRoot, value.tmpRoot, value.cacheRoot].map((item) =>
    physical(item, true)
  );
  const invocationRoot = physical(dirname(roles[0]!), true);
  const parentStat = fs.lstatSync(invocationRoot);
  insist(parentStat.uid === process.getuid?.() && (parentStat.mode & 0o7777) === 0o700);
  insist(
    roles.every(
      (role, index) =>
        dirname(role) === invocationRoot && basename(role) === ['output', 'tmp', 'cache'][index]
    )
  );
  for (const role of roles) {
    const stat = fs.lstatSync(role);
    insist(
      stat.uid === process.getuid?.() &&
        (stat.mode & 0o7777) === 0o700 &&
        fs.readdirSync(role).length === 0
    );
  }
  insist(
    exact(value.channel, ['schema', 'nonce', 'replyRoot', 'timeoutMs']) &&
      value.channel.schema === 'caws.git-hook.format-channel.v1' &&
      typeof value.channel.nonce === 'string' &&
      /^[0-9a-f]{64}$/.test(value.channel.nonce) &&
      Number.isSafeInteger(value.channel.timeoutMs) &&
      Number(value.channel.timeoutMs) > 0 &&
      Number(value.channel.timeoutMs) <= 30000
  );
  const replyRoot = physical(value.channel.replyRoot, true);
  const producerStat = fs.lstatSync(replyRoot);
  insist(producerStat.uid === process.getuid?.() && (producerStat.mode & 0o7777) === 0o700);
  insist(dirname(descriptorPath) === replyRoot && dirname(value.seedIndex.path) === replyRoot);
  for (const filename of [descriptorPath, value.seedIndex.path]) {
    const stat = fs.lstatSync(filename);
    insist(stat.uid === process.getuid?.() && stat.nlink === 1 && (stat.mode & 0o222) === 0);
  }
  // The producer namespace and all project/metadata images stay outside the
  // one invocation root that grants the hook writable roles.
  for (const other of [
    cwd,
    objectDirectory,
    replyRoot,
    descriptorPath,
    value.seedIndex.path,
    hook,
  ]) {
    insist(!overlaps(invocationRoot, other));
  }
  const stdin = base64(value.stdinBase64);
  insist(
    admittedGitConfig(process.env) &&
      !Object.keys(process.env).some(
        (name) => name.startsWith('CAWS_EXECUTION_') || name.startsWith('NODE_')
      )
  );
  const transactionRoot = join(roles[0]!, 'transaction');
  fs.mkdirSync(transactionRoot, { mode: 0o700 });
  const privateIndexPath = join(transactionRoot, 'index');
  const privateObjectDirectory = join(transactionRoot, 'objects');
  fs.mkdirSync(privateObjectDirectory, { mode: 0o700 });
  fs.writeFileSync(privateIndexPath, seed, { flag: 'wx', mode: 0o600 });
  const env = {
    ...process.env,
    PWD: cwd,
    TMPDIR: roles[1],
    GIT_INDEX_FILE: privateIndexPath,
    GIT_OBJECT_DIRECTORY: privateObjectDirectory,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: objectDirectory,
    CAWS_HOOK_FORMAT_CHANNEL: JSON.stringify(value.channel),
  };
  // Inherit only stdio. Real hooks may execute ordinary descendants, but the
  // Host's empty-source ceiling confines every descendant to private roles.
  const result = spawnSync(hook, value.args as string[], {
    cwd,
    env,
    input: stdin,
    stdio: ['pipe', 'inherit', 'inherit'],
    shell: false,
  });
  if (result.error) return 1;
  if (result.status === null) {
    const signal = result.signal ? osConstants.signals[result.signal] : undefined;
    return typeof signal === 'number' && signal > 0 && signal <= 127 ? 128 + signal : 1;
  }
  insist(result.status >= 0 && result.status <= 255);
  return result.status;
}

if (require.main === module) {
  try {
    process.exitCode = runGitHookLauncher(process.argv.slice(2));
  } catch {
    process.stderr.write('caws Git hook launcher refused\n');
    process.exitCode = 1;
  }
}
