import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { createRequire } from 'node:module';
import { TextDecoder } from 'node:util';
import { evaluatePath, parseAndValidateSpec, type EventBody } from '../kernel';
import { parseJsonSource } from '../runtime/json-custody';
import { inside } from '../shell/analysis/policies';
import { acquireBridge } from '../store/bridge-store';
import { loadEvents } from '../store/events-store';
import { autoCommit } from '../store/git-autocommit';
import { executionGitOptions, withExecutionGitRuntime } from '../store/git-runtime';
import { borrowExecutionLifecycleFence } from '../store/lifecycle-lock';
import { closeSpec } from '../store/specs-writer';
import { mergeWorktree } from '../store/worktrees-writer';
import {
  ExecutionAuthorityUnavailable,
  readExecutionAuthority,
  type ExecutionAuthorityContext,
} from './authority';
import { verifyInheritedFence } from './fence';
import type { FenceObservation } from './prepared';
import { bridgeRequest, type GitBridgeRoot } from './git-hook-client-main';

// Keep fixed command loading after original environment and fence validation.
const loadFixedApplication = createRequire(__filename);

export type ExecutionLifecycleArguments =
  | { readonly operation: 'status' }
  | { readonly operation: 'agents-list' }
  | { readonly operation: 'worktree-review'; readonly worktree: string; readonly specId: string }
  | { readonly operation: 'doctor' }
  | { readonly operation: 'gates-run'; readonly specId: string }
  | { readonly operation: 'git-status' }
  | { readonly operation: 'git-head' }
  | { readonly operation: 'git-branch' }
  | { readonly operation: 'git-stage'; readonly paths: readonly string[] }
  | { readonly operation: 'git-diff'; readonly paths: readonly string[] }
  | {
      readonly operation: 'git-commit';
      readonly message: string;
      readonly paths: readonly string[];
    }
  | { readonly operation: 'spec-commit'; readonly specId: string }
  | { readonly operation: 'worktree-merge'; readonly worktree: string; readonly specId: string }
  | { readonly operation: 'bridge-claim'; readonly specId: string; readonly mergeCommit: string }
  | {
      readonly operation: 'spec-close';
      readonly specId: string;
      readonly mergeCommit: string;
      readonly reason: string;
    };

export interface ExecutionLifecycleRuntimeHomes {
  readonly home: string;
  readonly cawsHome: string;
  readonly codexHome: string;
}
export interface ExecutionLifecycleContext extends ExecutionAuthorityContext {
  readonly execution: ExecutionAuthorityContext['execution'] & {
    readonly environment?: readonly { readonly name: string; readonly value: string }[];
  };
}

export const EXECUTION_GIT_HOOK_POLICY_ENV = [
  'CAWS_EXECUTION_GIT_HOOK_POLICY',
  'CAWS_EXECUTION_GIT_HOOK_POLICY_SHA256',
] as const;
const GIT_HOOK_NAMES = [
  'applypatch-msg',
  'pre-applypatch',
  'post-applypatch',
  'pre-commit',
  'pre-auto-gc',
  'pre-merge-commit',
  'prepare-commit-msg',
  'commit-msg',
  'post-commit',
  'post-checkout',
  'post-merge',
  'pre-push',
  'pre-rebase',
  'post-rewrite',
  'reference-transaction',
  'post-index-change',
  'push-to-checkout',
  'proc-receive',
  'update',
  'pre-receive',
  'post-receive',
  'post-update',
] as const;
interface ExecutionGitHookImage {
  readonly path: string;
  readonly sha256: string;
  readonly dev: string;
  readonly ino: string;
  readonly mode: string;
}
interface ExecutionGitHookRoot {
  readonly cwd: string;
  readonly hooksDirectory: string;
  readonly hooks: Readonly<Record<string, ExecutionGitHookImage | null>>;
  readonly formatters?: {
    readonly eslint: { readonly path: string; readonly sha256: string } | null;
    readonly prettier: { readonly path: string; readonly sha256: string } | null;
  };
  readonly readOnlyPaths?: readonly string[];
}
export interface ExecutionGitHookPolicy {
  readonly version: 1 | 2;
  readonly path: string;
  readonly sha256: string;
  readonly roots: readonly ExecutionGitHookRoot[];
}
function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

/** Native supplies this startup catalog through its authenticated record.
 * Hooks execute only through the private bridge and the Host ceiling; a pinned
 * entrypoint alone does not protect mutable dependent project commands. */
export function readExecutionLifecycleHookPolicy(
  environment: readonly { readonly name: string; readonly value: string }[]
): ExecutionGitHookPolicy | undefined {
  const selected = environment.filter((row) =>
    EXECUTION_GIT_HOOK_POLICY_ENV.includes(
      row.name as (typeof EXECUTION_GIT_HOOK_POLICY_ENV)[number]
    )
  );
  if (selected.length === 0) return undefined;
  requireValue(
    selected.length === 2 && new Set(selected.map((row) => row.name)).size === 2,
    'unsupported_profile'
  );
  const values = new Map(selected.map((row) => [row.name, row.value]));
  const path = values.get(EXECUTION_GIT_HOOK_POLICY_ENV[0])!;
  const sha256 = values.get(EXECUTION_GIT_HOOK_POLICY_ENV[1])!;
  requireValue(isAbsolute(path) && /^[0-9a-f]{64}$/.test(sha256), 'unsupported_profile');
  const bytes = physicalFile(path)!;
  requireValue(createHash('sha256').update(bytes).digest('hex') === sha256, 'authority_changed');
  const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  parseJsonSource(source, 16, 50000, true);
  const policy: unknown = JSON.parse(source);
  requireValue(
    exactObject(policy, ['schema', 'roots']) &&
      ['caws.execution.git-hook-policy.v1', 'caws.execution.git-hook-policy.v2'].includes(
        String(policy.schema)
      ) &&
      Array.isArray(policy.roots) &&
      policy.roots.length > 0 &&
      policy.roots.length <= 4096,
    'unsupported_profile'
  );
  const roots = new Set<string>();
  const extended = policy.schema === 'caws.execution.git-hook-policy.v2';
  for (const root of policy.roots) {
    requireValue(
      exactObject(
        root,
        extended
          ? ['cwd', 'hooksDirectory', 'hooks', 'formatters', 'readOnlyPaths']
          : ['cwd', 'hooksDirectory', 'hooks']
      ) &&
        typeof root.cwd === 'string' &&
        isAbsolute(root.cwd) &&
        !roots.has(root.cwd) &&
        typeof root.hooksDirectory === 'string' &&
        isAbsolute(root.hooksDirectory) &&
        exactObject(root.hooks, GIT_HOOK_NAMES),
      'unsupported_profile'
    );
    roots.add(root.cwd);
    if (extended) {
      requireValue(
        exactObject(root.formatters, ['eslint', 'prettier']) &&
          Array.isArray(root.readOnlyPaths) &&
          root.readOnlyPaths.length <= 4096 &&
          root.readOnlyPaths.every((item) => typeof item === 'string' && isAbsolute(item)) &&
          new Set(root.readOnlyPaths).size === root.readOnlyPaths.length,
        'unsupported_profile'
      );
      for (const entry of Object.values(root.formatters)) {
        if (entry === null) continue;
        requireValue(
          exactObject(entry, ['path', 'sha256']) &&
            typeof entry.path === 'string' &&
            isAbsolute(entry.path) &&
            typeof entry.sha256 === 'string' &&
            /^[0-9a-f]{64}$/.test(entry.sha256),
          'unsupported_profile'
        );
      }
    }
    for (const name of GIT_HOOK_NAMES) {
      const hook = root.hooks[name];
      if (hook === null) continue;
      requireValue(
        exactObject(hook, ['path', 'sha256', 'dev', 'ino', 'mode']) &&
          hook.path === join(root.hooksDirectory, name) &&
          typeof hook.sha256 === 'string' &&
          /^[0-9a-f]{64}$/.test(hook.sha256) &&
          ['dev', 'ino', 'mode'].every(
            (key) =>
              typeof hook[key] === 'string' && /^(?:0|[1-9][0-9]*)$/.test(hook[key] as string)
          ),
        'unsupported_profile'
      );
    }
  }
  // Legacy catalogs did not provide the private hook execution boundary.
  // They remain usable only where Git has no executable callback to run.
  if (!extended)
    requireValue(
      (policy.roots as unknown as ExecutionGitHookRoot[]).every((root) =>
        Object.values(root.hooks).every(
          (hook) => hook === null || (BigInt(hook.mode) & 0o111n) === 0n
        )
      ),
      'unsupported_profile'
    );
  return {
    version: extended ? 2 : 1,
    path,
    sha256,
    roots: policy.roots as unknown as readonly ExecutionGitHookRoot[],
  };
}

/** Startup-pinned runtime context, never the authorizer process's HOME.
 * Partial tuples and physical aliases have no fallback. */
export function readExecutionLifecycleRuntimeHomes(
  environment: readonly { readonly name: string; readonly value: string }[]
): ExecutionLifecycleRuntimeHomes | undefined {
  const names = new Set(['HOME', 'CAWS_HOME', 'CODEX_HOME']);
  const selected = environment.filter((entry) => names.has(entry.name));
  if (selected.length === 0) return undefined;
  requireValue(
    selected.length === 3 && new Set(selected.map((entry) => entry.name)).size === 3,
    'unsupported_profile'
  );
  const values = new Map(selected.map(({ name, value }) => [name, value]));
  for (const name of names) {
    const value = values.get(name);
    requireValue(
      typeof value === 'string' && value.length > 0 && !value.includes('\0') && isAbsolute(value),
      'unsupported_profile'
    );
    directory(value);
  }
  const home = values.get('HOME')!;
  const cawsHome = values.get('CAWS_HOME')!;
  const codexHome = values.get('CODEX_HOME')!;
  requireValue(codexHome === join(home, '.codex'), 'unsupported_profile');
  return { home, cawsHome, codexHome };
}

function requireValue(
  value: unknown,
  reason: ConstructorParameters<typeof ExecutionAuthorityUnavailable>[0] = 'context_unresolved'
): asserts value {
  if (!value) throw new ExecutionAuthorityUnavailable(reason);
}
// Resolve only producer-owned system roots; caller PATH remains physical-only.
export function fixedSystemExecutionPath(): string {
  const directories = ['/usr/bin', '/bin'].map((directory) => {
    const physical = fs.realpathSync.native(directory);
    requireValue(
      isAbsolute(physical) && !physical.includes(':') && fs.statSync(physical).isDirectory(),
      'unsupported_profile'
    );
    return physical;
  });
  return [...new Set(directories)].join(':');
}
function literal(value: string): boolean {
  return value.length > 0 && value.length <= 8192 && !/[\0\r\n]/.test(value);
}
function pathArgument(value: string): boolean {
  return (
    literal(value) &&
    /^[\x20-\x7e]+$/.test(value) &&
    !isAbsolute(value) &&
    !value.includes('\\') &&
    !value.includes(':') &&
    value.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
  );
}

/** Private typed protocol, not CLI argv passthrough. No option aliases or
 * optional switches exist; the merge operation always leaves its spec open. */
export function parseExecutionLifecycleArguments(
  argv: readonly string[]
): ExecutionLifecycleArguments {
  const operation = argv[0];
  requireValue(
    argv.length > 0 &&
      argv.length <= 260 &&
      argv.every((value, index) =>
        operation === 'git-commit' && index === 2
          ? value.length > 0 && value.length <= 8192 && !/[\0\r]/.test(value)
          : literal(value)
      ),
    'unsupported_profile'
  );
  if (
    operation === 'status' ||
    operation === 'agents-list' ||
    operation === 'doctor' ||
    operation === 'git-status' ||
    operation === 'git-head' ||
    operation === 'git-branch'
  ) {
    requireValue(argv.length === 1, 'unsupported_profile');
    return { operation };
  }
  if (operation === 'git-stage' || operation === 'git-diff' || operation === 'git-commit') {
    const offset = operation === 'git-commit' ? 3 : 1;
    requireValue(operation !== 'git-commit' || argv[1] === '--message', 'unsupported_profile');
    requireValue(argv[offset] === '--', 'unsupported_profile');
    const paths = argv.slice(offset + 1);
    requireValue(
      paths.length > 0 &&
        paths.length <= 256 &&
        paths.every(pathArgument) &&
        new Set(paths).size === paths.length,
      'unsupported_profile'
    );
    return operation === 'git-commit'
      ? { operation, message: argv[2]!, paths }
      : operation === 'git-stage'
        ? { operation, paths }
        : { operation, paths };
  }
  const id = (value: string | undefined): value is string =>
    value !== undefined && /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*$/.test(value) && value.length <= 128;
  if (operation === 'spec-commit' || operation === 'gates-run') {
    requireValue(argv.length === 3 && argv[1] === '--spec' && id(argv[2]), 'unsupported_profile');
    return { operation, specId: argv[2] };
  }
  if (operation === 'worktree-merge' || operation === 'worktree-review') {
    requireValue(
      argv.length === 5 &&
        argv[1] === '--worktree' &&
        /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(argv[2]!) &&
        argv[3] === '--spec' &&
        id(argv[4]),
      'unsupported_profile'
    );
    return { operation, worktree: argv[2]!, specId: argv[4] };
  }
  requireValue(operation === 'bridge-claim' || operation === 'spec-close', 'unsupported_profile');
  requireValue(
    argv.length === (operation === 'bridge-claim' ? 5 : 7) &&
      argv[1] === '--spec' &&
      id(argv[2]) &&
      argv[3] === '--merge-commit' &&
      /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(argv[4]!),
    'unsupported_profile'
  );
  if (operation === 'bridge-claim') return { operation, specId: argv[2], mergeCommit: argv[4]! };
  requireValue(argv[5] === '--reason' && argv[6]!.trim().length > 0, 'unsupported_profile');
  return { operation, specId: argv[2], mergeCommit: argv[4]!, reason: argv[6]! };
}

type LifecycleGitQuery = (cwd: string, args: readonly string[], input?: Buffer) => string;
function lifecycleChildEnvironment(
  environment: readonly { readonly name: string; readonly value: string }[] = []
): NodeJS.ProcessEnv {
  const homes = readExecutionLifecycleRuntimeHomes(environment);
  const thread = environment.find((entry) => entry.name === 'CAWS_EXECUTION_THREAD')?.value;
  const project = environment.find((entry) => entry.name === 'CAWS_EXECUTION_PROJECT')?.value;
  requireValue((thread === undefined) === (project === undefined), 'unsupported_profile');
  return {
    PATH: [
      ...new Set([
        dirname(fs.realpathSync.native(process.execPath)),
        ...fixedSystemExecutionPath().split(':'),
      ]),
    ].join(':'),
    LC_ALL: 'C',
    GIT_OPTIONAL_LOCKS: '0',
    ...(homes ? { HOME: homes.home, CAWS_HOME: homes.cawsHome, CODEX_HOME: homes.codexHome } : {}),
    ...(thread !== undefined
      ? { CODEX_THREAD_ID: thread, CAWS_AGENT_SURFACE: 'codex', CAWS_PROJECT_DIR: project }
      : {}),
  };
}
function executionGit(
  environment: readonly { readonly name: string; readonly value: string }[] = [],
  callbacks = false
): LifecycleGitQuery {
  const gitEnvironment = lifecycleChildEnvironment(environment);
  return (cwd, args, input) =>
    execFileSync('/usr/bin/git', [...args], {
      cwd,
      ...(callbacks ? executionGitOptions(cwd) : {}),
      env: { ...gitEnvironment, ...(callbacks ? executionGitOptions(cwd).env : {}) },
      encoding: 'utf8',
      stdio:
        callbacks && input === undefined
          ? executionGitOptions(cwd).stdio
          : [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      ...(input === undefined ? {} : { input }),
      timeout: 10000,
      maxBuffer: 1048576,
    });
}
function physicalFile(path: string, optional = false): Buffer | undefined {
  try {
    const before = fs.lstatSync(path, { bigint: true });
    requireValue(
      before.isFile() &&
        before.nlink === 1n &&
        before.size <= 1048576n &&
        fs.realpathSync.native(path) === path
    );
    const fd = fs.openSync(
      path,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
    );
    try {
      const bytes = fs.readFileSync(fd);
      const after = fs.fstatSync(fd, { bigint: true });
      const named = fs.lstatSync(path, { bigint: true });
      requireValue(
        before.dev === after.dev &&
          before.ino === after.ino &&
          before.size === after.size &&
          before.mtimeNs === after.mtimeNs &&
          before.ctimeNs === after.ctimeNs &&
          named.dev === after.dev &&
          named.ino === after.ino &&
          BigInt(bytes.length) === after.size
      );
      return bytes;
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Hash the entire ledger with bounded memory. Native invocation deadlines bound
 * the enclosing operation; this read-only helper has no independent deadline. */
function hashEventLedger(hash: ReturnType<typeof createHash>, path: string): void {
  let before: fs.BigIntStats;
  try {
    before = fs.lstatSync(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      hash.update('absent');
      return;
    }
    throw error;
  }
  const same = (actual: fs.BigIntStats): boolean =>
    actual.isFile() &&
    actual.nlink === 1n &&
    actual.dev === before.dev &&
    actual.ino === before.ino &&
    actual.size === before.size &&
    actual.mtimeNs === before.mtimeNs &&
    actual.ctimeNs === before.ctimeNs;
  requireValue(same(before) && fs.realpathSync.native(path) === path);
  const fd = fs.openSync(
    path,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
  );
  try {
    requireValue(same(fs.fstatSync(fd, { bigint: true })));
    const block = Buffer.allocUnsafe(65536);
    let total = 0n;
    for (;;) {
      const count = fs.readSync(fd, block, 0, block.length, null);
      if (count === 0) break;
      total += BigInt(count);
      requireValue(total <= before.size);
      hash.update(block.subarray(0, count));
    }
    requireValue(
      total === before.size &&
        same(fs.fstatSync(fd, { bigint: true })) &&
        same(fs.lstatSync(path, { bigint: true })) &&
        fs.realpathSync.native(path) === path
    );
  } finally {
    fs.closeSync(fd);
  }
}
function jsonFile(path: string): Record<string, unknown> {
  const source = new TextDecoder('utf-8', { fatal: true }).decode(physicalFile(path)!);
  parseJsonSource(source, 32, 50000, true);
  const parsed: unknown = JSON.parse(source);
  requireValue(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed));
  return parsed as Record<string, unknown>;
}
function directory(path: string): void {
  requireValue(fs.lstatSync(path).isDirectory() && fs.realpathSync.native(path) === path);
}
function framed(value: string): string {
  requireValue(value.endsWith('\n') && value.length > 1);
  return value.slice(0, -1);
}
function canonicalContext(context: ExecutionLifecycleContext, git: LifecycleGitQuery): void {
  directory(context.projectRoot);
  directory(join(context.projectRoot, '.caws'));
  directory(join(context.projectRoot, '.git'));
  requireValue(fs.realpathSync.native(context.execution.cwd) === context.execution.cwd);
  requireValue(
    fs.realpathSync.native(context.association.callerAnchor) === context.association.callerAnchor
  );
  for (const cwd of [context.association.callerAnchor, context.execution.cwd]) {
    requireValue(
      framed(git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])) ===
        join(context.projectRoot, '.git')
    );
  }
}

/** Git opens these exact pathnames. Probe them through the filesystem rather
 * than comparing enumerated spelling, so case/normalization aliases refuse. */
function refuseObjectRedirectionFiles(root: string): void {
  for (const name of ['alternates', 'http-alternates']) {
    let present = false;
    try {
      fs.lstatSync(join(root, 'objects', 'info', name));
      present = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    requireValue(!present, 'unsupported_profile');
  }
}

function gitMetadataTree(root: string): void {
  refuseObjectRedirectionFiles(root);
  const pending = [root];
  let count = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    requireValue(++count <= 4096, 'unsupported_profile');
    const stat = fs.lstatSync(current);
    requireValue(
      !stat.isSymbolicLink() && fs.realpathSync.native(current) === current,
      'scope_refused'
    );
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(current)) pending.push(join(current, name));
    } else requireValue(stat.isFile() && stat.nlink === 1, 'scope_refused');
    requireValue(
      !(dirname(current) === join(root, 'objects', 'pack') && current.endsWith('.promisor')),
      'unsupported_profile'
    );
  }
}

function lifecycleGitConfiguration(
  cwd: string,
  git: LifecycleGitQuery
): { source: string; hooksPath?: string } {
  const source = git(cwd, ['config', '--null', '--list', '--no-includes']);
  const entries = source.split('\0');
  requireValue(entries.pop() === '');
  let hooksPath: string | undefined;
  for (const entry of entries) {
    const separator = entry.indexOf('\n');
    requireValue(separator > 0, 'unsupported_profile');
    const key = entry.slice(0, separator).toLowerCase();
    const value = entry.slice(separator + 1);
    if (key === 'core.hookspath') {
      requireValue(hooksPath === undefined, 'unsupported_profile');
      hooksPath = value;
      continue;
    }
    // Git's administrator-controlled repository ownership selectors select no
    // callback. Preserve their exact values/order in the authority snapshot;
    // CAWS binding, session and path authority remain independently required.
    if (key === 'safe.directory') {
      requireValue(
        value === '' ||
          value === '*' ||
          isAbsolute(value) ||
          value.startsWith('~/') ||
          value.startsWith('%(prefix)/'),
        'unsupported_profile'
      );
      continue;
    }
    const boolean = /^(?:true|false|yes|no|on|off|0|1)$/i.test(value);
    if (
      /^(?:extensions\.worktreeconfig|core\.sparsecheckout|core\.sparsecheckoutcone|index\.sparse)$/.test(
        key
      )
    ) {
      requireValue(boolean, 'unsupported_profile');
      continue;
    }
    // Driver command strings remain opaque configuration data. Attribute
    // observation below must prove no candidate can select any filter driver.
    if (/^filter\.[a-z0-9_-]+\.(?:clean|smudge|process|required)$/.test(key)) {
      // check-attr renders these sentinel words identically to string values.
      // Never admit a configured driver that could exploit that ambiguity.
      requireValue(!/^filter\.(?:unset|unspecified|set)\./.test(key), 'unsupported_profile');
      requireValue(!key.endsWith('.required') || boolean, 'unsupported_profile');
      continue;
    }
    // pack.window affects built-in local repacking, not a callback. Bound its
    // numeric work factor rather than treating it as inert network metadata.
    if (key === 'pack.window') {
      requireValue(
        /^(?:0|[1-9][0-9]{0,3})$/.test(value) && Number(value) <= 1024,
        'unsupported_profile'
      );
      continue;
    }
    // Fixed operations never fetch/push/pull or start an HTTP transport.
    // Remote URL/fetch and credential/UI/default-branch settings cannot select
    // a program here. Promisor/partialClone, includes and aliases stay refused.
    const harmless =
      /^(?:credential\.helper|user\.(?:name|email)|color\.ui|push\.autosetupremote|http\.postbuffer|pull\.(?:ff|rebase)|core\.(?:repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode)|(?:init|inti)\.defaultbranch|remote\..+\.(?:url|fetch)|branch\..+\.(?:remote|merge|vscode-merge-base))$/.test(
        key
      );
    requireValue(
      harmless || (key === 'commit.gpgsign' && /^(?:false|no|off|0)$/i.test(value)),
      'unsupported_profile'
    );
  }
  const common = framed(git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
  refuseObjectRedirectionFiles(common);
  requireValue(
    !fs.readdirSync(join(common, 'objects', 'pack')).some((name) => name.endsWith('.promisor')),
    'unsupported_profile'
  );
  return { source, ...(hooksPath === undefined ? {} : { hooksPath }) };
}

function nullFields(source: string): string[] {
  requireValue(!source.includes('\ufffd'), 'source_unresolved');
  if (source === '') return [];
  const fields = source.split('\0');
  requireValue(
    fields.pop() === '' && fields.every((field) => field.length > 0),
    'source_unresolved'
  );
  return fields;
}

/** Git itself resolves system/info attributes, macros and the index fallback.
 * Both current views and immutable parent trees are checked without invoking a
 * filter or producing a merge tree. Different parent attribute maps refuse:
 * combining macro definitions could select a driver absent in either parent. */
function inactiveFilterClosure(
  cwd: string,
  trees: readonly string[],
  additionalPaths: readonly string[],
  git: LifecycleGitQuery
): string {
  const candidates = new Set(
    nullFields(
      git(cwd, [
        '--no-optional-locks',
        'ls-files',
        '--cached',
        '--others',
        '--exclude-standard',
        '--full-name',
        '-z',
      ])
    )
  );
  for (const path of additionalPaths) candidates.add(path);
  const sources = [...new Set([framed(git(cwd, ['rev-parse', 'HEAD'])), ...trees])].sort();
  const hash = createHash('sha256');
  let attributes: string | undefined;
  for (const tree of sources) {
    requireValue(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(tree), 'context_unresolved');
    const entries = nullFields(git(cwd, ['ls-tree', '-r', '-z', tree]));
    const currentAttributes: string[] = [];
    for (const entry of entries) {
      const separator = entry.indexOf('\t');
      const metadata = entry.slice(0, separator);
      const path = entry.slice(separator + 1);
      requireValue(
        separator > 0 &&
          /^(?:100644|100755|120000) blob (?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(metadata) &&
          path.length > 0,
        'unsupported_profile'
      );
      candidates.add(path);
      if (path === '.gitattributes' || path.endsWith('/.gitattributes')) {
        requireValue(metadata.startsWith('100'), 'unsupported_profile');
        currentAttributes.push(entry);
      }
    }
    const identity = JSON.stringify(currentAttributes);
    requireValue(attributes === undefined || attributes === identity, 'unsupported_profile');
    attributes = identity;
    hash.update(tree).update(identity);
  }
  const paths = [...candidates].sort();
  requireValue(
    paths.length <= 4096 &&
      paths.every((path) => path.length > 0 && !path.includes('\0') && !path.includes('\ufffd')),
    'source_unresolved'
  );
  const input = Buffer.from(paths.join('\0') + (paths.length ? '\0' : ''));
  requireValue(input.length <= 524288, 'source_unresolved');
  for (const view of [[], ['--cached'], ...sources.map((tree) => [`--source=${tree}`])]) {
    const output = git(cwd, ['check-attr', ...view, '-z', '--stdin', 'filter'], input);
    const fields = nullFields(output);
    requireValue(fields.length === paths.length * 3, 'source_unresolved');
    for (let index = 0; index < paths.length; index++) {
      requireValue(
        fields[index * 3] === paths[index] && fields[index * 3 + 1] === 'filter',
        'source_unresolved'
      );
      requireValue(
        fields[index * 3 + 2] === 'unspecified' || fields[index * 3 + 2] === 'unset',
        'unsupported_profile'
      );
    }
    hash.update(JSON.stringify(view)).update(output);
  }
  return hash.digest('hex');
}

/** Inspect effective normal configuration and attribute reachability. No
 * hooksPath, filter or signing override is installed. The returned digest is
 * private authority observation, never configuration values or a permit. */
export function inspectExecutionLifecycleGit(
  cwd: string,
  trees: readonly string[] = [],
  additionalPaths: readonly string[] = [],
  environment: readonly { readonly name: string; readonly value: string }[] = []
): string {
  const git = executionGit(environment);
  const { source, hooksPath } = lifecycleGitConfiguration(cwd, git);
  const closure = inactiveFilterClosure(cwd, trees, additionalPaths, git);
  const hookPolicy = readExecutionLifecycleHookPolicy(environment);
  const revision = createHash('sha256').update(source).update(closure);
  if (hookPolicy) revision.update(hookPolicy.path).update(hookPolicy.sha256);
  // Status can recursively launch Git in a tracked submodule, whose executable
  // configuration is outside this inspected closure. This profile has no
  // submodule capability; refuse gitlinks rather than spawning that reader.
  requireValue(
    !git(cwd, ['--no-optional-locks', 'ls-files', '--stage', '-z'])
      .split('\0')
      .some((entry) => entry.startsWith('160000 ')),
    'unsupported_profile'
  );
  const hookDirectory =
    hooksPath === undefined
      ? framed(git(cwd, ['rev-parse', '--path-format=absolute', '--git-path', 'hooks']))
      : isAbsolute(hooksPath)
        ? hooksPath
        : join(cwd, hooksPath);
  // A project may already explicitly configure /dev/null. We never set it;
  // ordinary Git has no hook to run in that existing configuration.
  const baseline = hookPolicy?.roots.find((root) => root.cwd === cwd);
  if (hookPolicy) requireValue(baseline?.hooksDirectory === hookDirectory, 'authority_changed');
  if (baseline?.formatters) {
    for (const entry of Object.values(baseline.formatters)) {
      if (entry === null) continue;
      const bytes = physicalFile(entry.path)!;
      requireValue(
        createHash('sha256').update(bytes).digest('hex') === entry.sha256,
        'authority_changed'
      );
    }
    for (const path of baseline.readOnlyPaths!)
      requireValue(
        fs.realpathSync.native(path) === path && !fs.lstatSync(path).isSymbolicLink(),
        'unsupported_profile'
      );
  }
  if (hookDirectory === '/dev/null') {
    if (baseline)
      requireValue(
        Object.values(baseline.hooks).every((hook) => hook === null),
        'authority_changed'
      );
    return revision.digest('hex');
  }
  try {
    directory(hookDirectory);
    for (const name of GIT_HOOK_NAMES) {
      const target = join(hookDirectory, name);
      let stat: fs.BigIntStats;
      try {
        stat = fs.lstatSync(target, { bigint: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          if (baseline) requireValue(baseline.hooks[name] === null, 'authority_changed');
          continue;
        }
        throw error;
      }
      const expected = baseline?.hooks[name];
      if (baseline) {
        requireValue(
          expected &&
            expected.path === target &&
            stat.dev.toString() === expected.dev &&
            stat.ino.toString() === expected.ino &&
            stat.mode.toString() === expected.mode,
          'authority_changed'
        );
        const bytes = physicalFile(target)!;
        requireValue(
          createHash('sha256').update(bytes).digest('hex') === expected.sha256,
          'authority_changed'
        );
        const named = fs.lstatSync(target, { bigint: true });
        requireValue(
          named.dev.toString() === expected.dev &&
            named.ino.toString() === expected.ino &&
            named.mode.toString() === expected.mode,
          'authority_changed'
        );
      }
      requireValue(
        stat.isFile() &&
          !stat.isSymbolicLink() &&
          (baseline !== undefined || (stat.mode & 0o111n) === 0n),
        'unsupported_profile'
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    if (baseline)
      requireValue(
        Object.values(baseline.hooks).every((hook) => hook === null),
        'authority_changed'
      );
  }
  return revision.digest('hex');
}

export interface ExecutionLifecycleAuthority {
  readonly canonical: string;
  readonly cawsDir: string;
  readonly pin: string;
  readonly targetBaseRoot?: string;
  readonly specId: string;
  readonly revision: string;
}

/** A shared branch publication must not stale another checkout of that ref.
 * Unrelated checkouts retain their own indexes and files, including dirt.
 * NUL framing preserves checkout paths containing line breaks without quoting. */
function boundedCheckoutInventory(
  canonical: string,
  pin: string,
  args: ExecutionLifecycleArguments,
  git: LifecycleGitQuery,
  baseRef?: string
): { inventory: string; targetBaseRoot?: string } {
  const inventory = git(canonical, ['worktree', 'list', '--porcelain', '-z']);
  const records = inventory.split('\0\0');
  requireValue(records.pop() === '', 'context_unresolved');
  const required = new Set([canonical, pin]);
  const affected = new Set<string>();
  const publishing =
    args.operation === 'git-commit'
      ? [pin]
      : args.operation === 'spec-commit' || args.operation === 'spec-close'
        ? [canonical]
        : args.operation === 'worktree-merge'
          ? [canonical, pin]
          : [];
  for (const cwd of publishing) {
    const branch = git(cwd, ['rev-parse', '--symbolic-full-name', 'HEAD']).trimEnd();
    if (branch.startsWith('refs/heads/')) affected.add(branch);
  }
  if (baseRef !== undefined) affected.add(baseRef);
  const observed = new Set<string>();
  const affectedCheckouts = new Map<string, string[]>();
  requireValue(records.length >= required.size && records.length <= 4096, 'scope_refused');
  for (const record of records) {
    const fields = record.split('\0');
    requireValue(
      (fields.length === 3 || (fields.length === 4 && /^locked(?: |$)/.test(fields[3]!))) &&
        fields[0]!.startsWith('worktree ') &&
        /^HEAD (?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(fields[1]!) &&
        (fields[2] === 'detached' || /^branch refs\/heads\/[^\0\r\n]+$/.test(fields[2]!)),
      'context_unresolved'
    );
    const checkout = fields[0]!.slice('worktree '.length);
    requireValue(
      isAbsolute(checkout) &&
        fs.realpathSync.native(checkout) === checkout &&
        !observed.has(checkout),
      'scope_refused'
    );
    if (fields[2] !== 'detached') {
      const branch = fields[2]!.slice('branch '.length);
      if (affected.has(branch)) {
        const checkouts = affectedCheckouts.get(branch) ?? [];
        checkouts.push(checkout);
        affectedCheckouts.set(branch, checkouts);
      }
    }
    observed.add(checkout);
  }
  requireValue(
    [...required].every((checkout) => observed.has(checkout)),
    'scope_refused'
  );
  for (const checkouts of affectedCheckouts.values())
    requireValue(checkouts.length === 1, 'scope_refused');
  const bases = baseRef === undefined ? undefined : affectedCheckouts.get(baseRef);
  if (baseRef !== undefined) requireValue(bases?.length === 1, 'scope_refused');
  const targetBaseRoot = bases?.[0];
  if (targetBaseRoot && args.operation === 'worktree-merge')
    requireValue(targetBaseRoot !== pin, 'scope_refused');
  for (const cwd of new Set([canonical, pin, ...(targetBaseRoot ? [targetBaseRoot] : [])])) {
    requireValue(
      framed(git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])) ===
        framed(git(canonical, ['rev-parse', '--path-format=absolute', '--git-common-dir'])),
      'scope_refused'
    );
  }
  return { inventory, ...(targetBaseRoot ? { targetBaseRoot } : {}) };
}

function mergeWitness(
  cawsDir: string,
  specId: string,
  mergeCommit: string,
  threadId: string
): EventBody {
  const events = loadEvents(cawsDir);
  requireValue(events.ok);
  const merged = [...events.value.events]
    .reverse()
    .find((event) => event.event === 'worktree_merged' && event.spec_id === specId);
  requireValue(merged && merged.actor.session_id === threadId && merged.actor.platform === 'codex');
  const data = merged.data as Record<string, unknown>;
  requireValue(
    data.merge_commit === mergeCommit &&
      data.auto_closed_spec === false &&
      typeof data.base_branch === 'string'
  );
  const superseded = events.value.events.some(
    (event) =>
      event.seq > merged.seq &&
      (event.spec_id === specId || (event.data as Record<string, unknown>).spec_id === specId) &&
      [
        'worktree_created',
        'worktree_bound',
        'spec_reopened',
        'spec_closed',
        'spec_activated',
        'claim_taken_over',
        'bridge_claim_taken_over',
      ].includes(event.event)
  );
  requireValue(!superseded, 'authority_changed');
  return merged;
}

/** Operation authority is deliberately separate from ordinary USER authority.
 * In particular the pre-claim result does not pretend a bridge already exists. */
export function readExecutionLifecycleAuthority(
  context: ExecutionLifecycleContext,
  args: ExecutionLifecycleArguments
): ExecutionLifecycleAuthority {
  const homes = readExecutionLifecycleRuntimeHomes(context.execution.environment ?? []);
  const git = executionGit(context.execution.environment);
  canonicalContext(context, git);
  gitMetadataTree(join(context.projectRoot, '.git'));
  // Reject includes/promisor configuration before any ancestry/object query.
  lifecycleGitConfiguration(context.projectRoot, git);
  const cawsDir = join(context.projectRoot, '.caws');
  directory(join(cawsDir, 'specs'));
  try {
    directory(join(cawsDir, 'claims'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  let pin: string;
  let specId: string;
  let baseRef: string | undefined;
  if (
    args.operation === 'git-stage' ||
    args.operation === 'git-diff' ||
    args.operation === 'git-commit' ||
    args.operation === 'git-status' ||
    args.operation === 'git-head' ||
    args.operation === 'git-branch' ||
    args.operation === 'spec-commit' ||
    args.operation === 'status' ||
    args.operation === 'agents-list' ||
    args.operation === 'worktree-review' ||
    args.operation === 'doctor' ||
    args.operation === 'gates-run'
  ) {
    const authority = readExecutionAuthority(context);
    pin = authority.pin;
    specId = authority.binding.spec.id;
    if (
      args.operation === 'spec-commit' ||
      args.operation === 'gates-run' ||
      args.operation === 'worktree-review'
    )
      requireValue(specId === args.specId, 'scope_refused');
    if (args.operation === 'worktree-review') {
      const entry = jsonFile(join(cawsDir, 'worktrees.json'))[args.worktree] as
        | Record<string, unknown>
        | undefined;
      requireValue(
        authority.binding.kind === 'bound' && entry?.specId === specId && entry.path === pin,
        'scope_refused'
      );
    }
  } else if (args.operation === 'worktree-merge') {
    requireValue(context.execution.cwd === context.projectRoot, 'context_unresolved');
    const registry = jsonFile(join(cawsDir, 'worktrees.json'));
    const entry = registry[args.worktree] as Record<string, unknown> | undefined;
    requireValue(entry && typeof entry.path === 'string' && entry.specId === args.specId);
    const authority = readExecutionAuthority({
      ...context,
      association: { ...context.association, callerAnchor: entry.path },
      execution: { cwd: entry.path },
    });
    requireValue(authority.binding.kind === 'bound' && authority.binding.spec.id === args.specId);
    requireValue(typeof entry.branch === 'string' && typeof entry.baseBranch === 'string');
    requireValue(
      framed(git(entry.path, ['symbolic-ref', '--quiet', 'HEAD'])) === `refs/heads/${entry.branch}`
    );
    baseRef = `refs/heads/${entry.baseBranch}`;
    pin = authority.pin;
    specId = args.specId;
  } else {
    requireValue(
      context.execution.cwd === context.projectRoot &&
        context.association.callerAnchor === context.projectRoot
    );
    const source = physicalFile(join(cawsDir, 'specs', `${args.specId}.yaml`))!;
    const parsed = parseAndValidateSpec(source.toString('utf8'));
    requireValue(
      parsed.ok &&
        parsed.value.id === args.specId &&
        parsed.value.lifecycle_state === 'active' &&
        !parsed.value.worktree
    );
    const registry = jsonFile(join(cawsDir, 'worktrees.json'));
    requireValue(
      !Object.values(registry).some(
        (entry) =>
          entry !== null &&
          typeof entry === 'object' &&
          (entry as Record<string, unknown>).specId === args.specId
      )
    );
    const merged = mergeWitness(
      cawsDir,
      args.specId,
      args.mergeCommit,
      context.association.threadId
    );
    baseRef = `refs/heads/${(merged.data as Record<string, unknown>).base_branch}`;
    if (args.operation === 'spec-close')
      requireValue(
        readExecutionAuthority(context).binding.spec.id === args.specId,
        'scope_refused'
      );
    pin = context.projectRoot;
    specId = args.specId;
  }
  const { inventory: checkoutInventory, targetBaseRoot } = boundedCheckoutInventory(
    context.projectRoot,
    pin,
    args,
    git,
    baseRef
  );
  if (pin !== context.projectRoot) lifecycleGitConfiguration(pin, git);
  if (targetBaseRoot && targetBaseRoot !== pin && targetBaseRoot !== context.projectRoot)
    lifecycleGitConfiguration(targetBaseRoot, git);
  const trees = [
    ...new Set([context.projectRoot, pin, ...(targetBaseRoot ? [targetBaseRoot] : [])]),
  ].map((cwd) => framed(git(cwd, ['rev-parse', 'HEAD'])));
  // Native creates its fence between analyze and final_validate. Observe that
  // known path in both phases even if the project does not ignore it, so the
  // fence itself cannot change the inactive-attribute authority observation.
  const candidates = [
    `.caws/specs/${specId}.yaml`,
    '.caws/worktrees.json',
    '.caws/events.jsonl',
    '.caws/state.lock',
    ...(args.operation === 'git-stage' ||
    args.operation === 'git-diff' ||
    args.operation === 'git-commit'
      ? args.paths
      : []),
  ];
  const pinClosure = inspectExecutionLifecycleGit(
    pin,
    trees,
    candidates,
    context.execution.environment
  );
  const canonicalClosure =
    pin === context.projectRoot
      ? pinClosure
      : inspectExecutionLifecycleGit(
          context.projectRoot,
          trees,
          candidates,
          context.execution.environment
        );
  if (args.operation === 'bridge-claim' || args.operation === 'spec-close')
    git(targetBaseRoot!, ['merge-base', '--is-ancestor', args.mergeCommit, 'HEAD']);
  const hash = createHash('sha256');
  hash
    .update(checkoutInventory)
    .update(pinClosure)
    .update(canonicalClosure)
    .update(JSON.stringify(homes ?? null));
  if (targetBaseRoot) {
    hash.update(targetBaseRoot);
    if (targetBaseRoot !== pin && targetBaseRoot !== context.projectRoot)
      hash.update(
        inspectExecutionLifecycleGit(
          targetBaseRoot,
          trees,
          candidates,
          context.execution.environment
        )
      );
    if (targetBaseRoot !== context.projectRoot) {
      hash.update(
        git(targetBaseRoot, [
          '--no-optional-locks',
          'status',
          '--porcelain=v1',
          '-z',
          '--untracked-files=all',
        ])
      );
      const index = framed(
        git(targetBaseRoot, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])
      );
      hashEventLedger(hash, index);
    }
  }
  for (const name of [
    'policy.yaml',
    'worktrees.json',
    `specs/${specId}.yaml`,
    'claims/bridge.json',
    'events.jsonl',
  ]) {
    hash.update(name);
    if (name === 'events.jsonl') hashEventLedger(hash, join(cawsDir, name));
    else hash.update(physicalFile(join(cawsDir, name), name === 'claims/bridge.json') ?? 'absent');
  }
  for (const cwd of new Set([pin, context.projectRoot]))
    hash.update(git(cwd, ['show-ref', '--head']));
  return {
    canonical: context.projectRoot,
    cawsDir,
    pin,
    ...(targetBaseRoot ? { targetBaseRoot } : {}),
    specId,
    revision: hash.digest('hex'),
  };
}

function ownedPaths(context: ExecutionLifecycleContext, paths: readonly string[]): void {
  const git = executionGit(context.execution.environment);
  const authority = readExecutionAuthority(context);
  for (const name of paths) {
    requireValue(pathArgument(name), 'scope_refused');
    requireValue(
      !name
        .split('/')
        .some(
          (part) =>
            ['.git', '.caws', '.codex', '.agents', '.claude', '.env'].includes(
              part.toLowerCase()
            ) || part.toLowerCase().startsWith('.env.')
        ),
      'scope_refused'
    );
    const target = join(authority.pin, name);
    directory(dirname(target));
    const bytes = physicalFile(target, true);
    requireValue(
      bytes !== undefined ||
        git(authority.pin, ['--literal-pathspecs', 'ls-files', '--error-unmatch', '--', name])
          .length > 0,
      'scope_refused'
    );
    requireValue(
      inside(target, authority.pin) &&
        relative(authority.pin, target) === name &&
        evaluatePath(name, authority.binding, authority.policy).kind === 'admit',
      'scope_refused'
    );
  }
}

function configureHookRuntime(
  context: ExecutionLifecycleContext,
  authority: ExecutionLifecycleAuthority,
  args: ExecutionLifecycleArguments,
  policy: ExecutionGitHookPolicy
): {
  readonly shimDirectories: readonly { readonly cwd: string; readonly shimDirectory: string }[];
  readonly bridgeFd: 4;
} {
  const git = executionGit(context.execution.environment);
  const roots: GitBridgeRoot[] = [];
  for (const cwd of new Set([
    authority.canonical,
    authority.pin,
    ...(authority.targetBaseRoot ? [authority.targetBaseRoot] : []),
  ])) {
    const catalog = policy.roots.find((root) => root.cwd === cwd);
    requireValue(
      catalog !== undefined &&
        catalog.formatters !== undefined &&
        catalog.readOnlyPaths !== undefined,
      'unsupported_profile'
    );
    const authorizedPaths =
      cwd === authority.pin && (args.operation === 'git-stage' || args.operation === 'git-commit')
        ? [...args.paths].sort()
        : [];
    const readOnly = new Set<string>([...catalog.readOnlyPaths, __dirname]);
    // A canonical .caws directory can contain the owned linked checkout.
    // Protect every other subtree without placing a deny over that checkout.
    const protect = (target: string): void => {
      const stat = fs.lstatSync(target);
      requireValue(
        !stat.isSymbolicLink() && fs.realpathSync.native(target) === target,
        'unsupported_profile'
      );
      if (target === cwd) return;
      if (cwd.startsWith(target + '/')) {
        requireValue(stat.isDirectory(), 'unsupported_profile');
        for (const entry of fs.readdirSync(target)) protect(join(target, entry));
      } else readOnly.add(target);
      requireValue(readOnly.size <= 4096, 'unsupported_profile');
    };
    protect(authority.cawsDir);
    protect(join(cwd, '.git'));
    protect(framed(git(cwd, ['rev-parse', '--absolute-git-dir'])));
    protect(framed(git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])));
    if (catalog.hooksDirectory !== '/dev/null') protect(catalog.hooksDirectory);
    for (const hook of Object.values(catalog.hooks)) if (hook !== null) protect(hook.path);
    roots.push({
      cwd,
      authorizedPaths,
      hooksDirectory: catalog.hooksDirectory,
      hooks: catalog.hooks,
      formatters: catalog.formatters,
      readOnlyPaths: [...readOnly].sort(),
    });
  }
  const configured = bridgeRequest({ operation: 'configure', roots });
  // The bridge client validates the closed response and its root ordering.
  return {
    shimDirectories: configured.shimDirectories as { cwd: string; shimDirectory: string }[],
    bridgeFd: 4,
  };
}

export interface ExecutionLifecycleResult {
  readonly operation: 'caws-lifecycle-v1';
  readonly action: ExecutionLifecycleArguments['operation'];
  readonly specId: string;
  readonly outcome: 'settled';
  readonly exitCode: number;
  readonly head: string;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly data?: unknown;
}
export class ExecutionLifecyclePublicationFailure extends Error {
  readonly outcome: {
    readonly operation: 'caws-lifecycle-v1';
    readonly action: ExecutionLifecycleArguments['operation'];
    readonly specId: string;
    readonly outcome: 'publication-failure';
    readonly disposition: 'inspect-before-retry';
    readonly instruction: string;
    readonly headBefore?: string;
    readonly headAfter?: string;
    readonly mergeCommit?: string;
    readonly exitCode?: number;
    readonly stdout?: string;
    readonly stderr?: string;
  };
  constructor(
    args: Pick<ExecutionLifecycleArguments, 'operation'>,
    specId: string,
    observation: {
      readonly headBefore?: string;
      readonly headAfter?: string;
      readonly mergeCommit?: string;
      readonly exitCode?: number;
      readonly stdout?: string;
      readonly stderr?: string;
    } = {}
  ) {
    super('Lifecycle operation requires inspection');
    this.outcome = {
      operation: 'caws-lifecycle-v1',
      action: args.operation,
      specId,
      outcome: 'publication-failure',
      disposition: 'inspect-before-retry',
      instruction:
        'Inspect Git refs, index, worktree registry, spec, bridge and event chain before retry. Publication or teardown may have partially landed; do not hand-author audit events.',
      ...observation,
    };
  }
}

/** Only the exact native producer environment and direct inherited fd3 enter
 * this consumer. The capability never releases or replaces the parent fence. */
export function runExecutionLifecycleConsumer(argv: readonly string[]): ExecutionLifecycleResult {
  const policy = readExecutionLifecycleHookPolicy(
    Object.entries(process.env)
      .filter((row): row is [string, string] => row[1] !== undefined)
      .map(([name, value]) => ({ name, value }))
  );
  const bridged = policy?.version === 2;
  let verdictAttempted = false;
  try {
    const result = runExecutionLifecycleConsumerInner(argv, bridged);
    if (bridged) {
      verdictAttempted = true;
      // The operation has already run. A verdict that fails or cannot be read
      // afterwards (Git ignores the exit of post-commit, post-merge and
      // post-checkout hooks, so a hook can fail after the commit exists) does
      // not undo it. Reporting a refusal here would tell the caller nothing
      // happened and invite a retry over an effect that landed.
      let confirmed = false;
      try {
        confirmed = bridgeRequest({ operation: 'verdict' }).failed === false;
      } catch {
        confirmed = false;
      }
      if (!confirmed)
        throw new ExecutionLifecyclePublicationFailure(
          { operation: result.action },
          result.specId,
          {
            headAfter: result.head,
            exitCode: result.exitCode === 0 ? 1 : result.exitCode,
            ...(result.stdout !== undefined ? { stdout: result.stdout } : {}),
            ...(result.stderr !== undefined ? { stderr: result.stderr } : {}),
          }
        );
    }
    return result;
  } catch (error) {
    if (bridged && !verdictAttempted) {
      try {
        bridgeRequest({ operation: 'verdict' });
      } catch {
        /* original failure stays primary */
      }
    }
    throw error;
  }
}

function runExecutionLifecycleConsumerInner(
  argv: readonly string[],
  bridged: boolean
): ExecutionLifecycleResult {
  const keys = [
    'CAWS_EXECUTION_PROJECT',
    'CAWS_EXECUTION_CALLER',
    'CAWS_EXECUTION_SESSION',
    'CAWS_EXECUTION_THREAD',
    'CAWS_EXECUTION_CALL',
    'PATH',
    'LC_ALL',
  ];
  const environment = Object.entries(process.env)
    .filter(([name]) => name !== '__CF_USER_TEXT_ENCODING')
    .map(([name, value]) => ({ name, value: value! }));
  const homes = readExecutionLifecycleRuntimeHomes(environment);
  if (homes) keys.push('HOME', 'CAWS_HOME', 'CODEX_HOME');
  const hookPolicy = readExecutionLifecycleHookPolicy(environment);
  if (hookPolicy) {
    requireValue(homes !== undefined, 'unsupported_profile');
    keys.push(...EXECUTION_GIT_HOOK_POLICY_ENV);
  }
  const cf = process.env.__CF_USER_TEXT_ENCODING;
  requireValue(
    cf === undefined ||
      (process.platform === 'darwin' &&
        /^(?:0x[0-9a-f]+|[0-9]+):(?:0x[0-9a-f]+|[0-9]+):(?:0x[0-9a-f]+|[0-9]+)$/i.test(cf) &&
        Number(cf.split(':')[0]) === process.getuid?.())
  );
  requireValue(
    Object.keys(process.env).filter((key) => key !== '__CF_USER_TEXT_ENCODING').length ===
      keys.length &&
      keys.every(
        (key) =>
          typeof process.env[key] === 'string' &&
          process.env[key]!.length > 0 &&
          !process.env[key]!.includes('\0')
      )
  );
  requireValue(process.env.PATH === fixedSystemExecutionPath() && process.env.LC_ALL === 'C');
  const context: ExecutionLifecycleContext = {
    projectRoot: process.env.CAWS_EXECUTION_PROJECT!,
    association: {
      callerAnchor: process.env.CAWS_EXECUTION_CALLER!,
      threadId: process.env.CAWS_EXECUTION_THREAD!,
    },
    execution: { cwd: process.cwd(), environment },
  };
  const git = executionGit(environment, true);
  const cawsDir = join(context.projectRoot, '.caws');
  const stat = fs.fstatSync(3, { bigint: true });
  requireValue(stat.isFile() && stat.size > 0n && stat.size <= 4096n, 'fence_unverified');
  const bytes = Buffer.alloc(Number(stat.size));
  requireValue(fs.readSync(3, bytes, 0, bytes.length, 0) === bytes.length, 'fence_unverified');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  parseJsonSource(text, 2, 16, true);
  const row = JSON.parse(text) as Record<string, unknown>;
  requireValue(typeof row.nonce === 'string', 'fence_unverified');
  const fence: FenceObservation = {
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    nonce: row.nonce,
  };
  requireValue(verifyInheritedFence(cawsDir, fence), 'fence_unverified');
  // Application/store Git calls inherit only public runtime context. The
  // original private tuple remains in `context` for authority validation;
  // neither it nor fd3 belongs to a project callback.
  const childEnvironment = lifecycleChildEnvironment(environment);
  for (const name of Object.keys(process.env)) delete process.env[name];
  Object.assign(process.env, childEnvironment);
  const args = parseExecutionLifecycleArguments(argv);
  const applicationRead =
    args.operation === 'status' ||
    args.operation === 'agents-list' ||
    args.operation === 'worktree-review';
  if (applicationRead || args.operation === 'doctor' || args.operation === 'gates-run')
    requireValue(homes !== undefined, 'unsupported_profile');
  const authority = readExecutionLifecycleAuthority(context, args);
  const borrowed = borrowExecutionLifecycleFence(cawsDir, fence);
  const validate = (): void => {
    requireValue(verifyInheritedFence(cawsDir, fence), 'fence_unverified');
    requireValue(
      readExecutionLifecycleAuthority(context, args).revision === authority.revision,
      'authority_changed'
    );
  };
  if (
    args.operation === 'git-stage' ||
    args.operation === 'git-diff' ||
    args.operation === 'git-commit'
  )
    ownedPaths(context, args.paths);
  validate();
  const now = new Date();
  const actor = {
    kind: 'agent' as const,
    id: context.association.threadId,
    session_id: context.association.threadId,
    platform: 'codex',
  };
  const session = { session_id: context.association.threadId, platform: 'codex' };
  let data: unknown;
  const resultRoot =
    args.operation.startsWith('git-') ||
    applicationRead ||
    args.operation === 'doctor' ||
    args.operation === 'gates-run'
      ? authority.pin
      : authority.canonical;
  const headBefore = framed(git(resultRoot, ['rev-parse', 'HEAD']));
  let mergeCommit: string | undefined;
  if (
    args.operation === 'git-status' ||
    args.operation === 'git-head' ||
    args.operation === 'git-branch' ||
    args.operation === 'git-diff'
  ) {
    const fixed =
      args.operation === 'git-status'
        ? ['--no-optional-locks', 'status', '--short']
        : args.operation === 'git-head'
          ? ['rev-parse', 'HEAD']
          : args.operation === 'git-branch'
            ? ['branch', '--show-current']
            : [
                '--literal-pathspecs',
                '--no-optional-locks',
                'diff',
                '--cached',
                '--no-ext-diff',
                '--no-textconv',
                '--',
                ...args.paths,
              ];
    const stdout = git(authority.pin, fixed);
    validate();
    return {
      operation: 'caws-lifecycle-v1',
      action: args.operation,
      specId: authority.specId,
      outcome: 'settled',
      exitCode: 0,
      head: headBefore,
      stdout,
    };
  }
  if (applicationRead || args.operation === 'doctor' || args.operation === 'gates-run') {
    const output: string[] = [];
    const errors: string[] = [];
    const out = (line: string): void => {
      output.push(line);
    };
    const err = (line: string): void => {
      errors.push(line);
    };
    const text = (lines: readonly string[]): string =>
      lines.join('\n') + (lines.length ? '\n' : '');
    const beforeEvents = args.operation === 'gates-run' ? loadEvents(cawsDir) : undefined;
    let exitCode: number | undefined;
    try {
      // Fixed application APIs with public runtime identity only; no injected
      // report, base override or runner.
      if (applicationRead) {
        if (args.operation === 'status') {
          const { runStatusCommand } = loadFixedApplication(
            '../shell/commands/status'
          ) as typeof import('../shell/commands/status');
          exitCode = runStatusCommand({
            cwd: authority.pin,
            env: { CAWS_AGENT_SURFACE: 'codex', CODEX_THREAD_ID: context.association.threadId },
            sessionId: context.association.threadId,
            out,
            err,
          });
        } else if (args.operation === 'agents-list') {
          const { runAgentsListCommand } = loadFixedApplication(
            '../shell/commands/agents'
          ) as typeof import('../shell/commands/agents');
          exitCode = runAgentsListCommand({ cwd: authority.pin, out, err });
        } else if (args.operation === 'worktree-review') {
          const { runWorktreeReviewCommand } = loadFixedApplication(
            '../shell/commands/worktree'
          ) as typeof import('../shell/commands/worktree');
          exitCode = runWorktreeReviewCommand({
            cwd: authority.pin,
            name: args.worktree,
            out,
            err,
          });
        }
        requireValue(exitCode !== undefined && [0, 1, 2].includes(exitCode));
        validate();
      } else if (args.operation === 'doctor') {
        const { runDoctorCommand } = loadFixedApplication(
          '../shell/commands/doctor'
        ) as typeof import('../shell/commands/doctor');
        exitCode = runDoctorCommand({ cwd: authority.pin, out, err });
        requireValue([0, 1, 2].includes(exitCode));
        validate();
      } else {
        const { runGatesRunCommand } = loadFixedApplication(
          '../shell/commands/gates'
        ) as typeof import('../shell/commands/gates');
        exitCode = runGatesRunCommand(
          { specId: authority.specId },
          {
            cwd: authority.pin,
            env: { CAWS_AGENT_SURFACE: 'codex', CODEX_THREAD_ID: context.association.threadId },
            out,
            err,
          }
        );
        if (exitCode === 3) throw new Error('Gate evidence requires inspection');
        requireValue([0, 1, 2].includes(exitCode));
        if (exitCode !== 2) {
          const after = loadEvents(cawsDir);
          requireValue(beforeEvents?.ok && after.ok);
          const events = after.value.events.slice(beforeEvents.value.events.length);
          requireValue(
            events.length > 0 &&
              events.every(
                (event) =>
                  event.event === 'gate_evaluated' &&
                  event.spec_id === authority.specId &&
                  event.actor.session_id === context.association.threadId &&
                  event.actor.platform === 'codex'
              )
          );
          data = { gateEventSequences: events.map((event) => event.seq) };
        }
      }
      requireValue(verifyInheritedFence(cawsDir, fence), 'fence_unverified');
      return {
        operation: 'caws-lifecycle-v1',
        action: args.operation,
        specId: authority.specId,
        outcome: 'settled',
        exitCode,
        head: framed(git(authority.pin, ['rev-parse', 'HEAD'])),
        stdout: text(output),
        stderr: text(errors),
        ...(data !== undefined ? { data } : {}),
      };
    } catch {
      throw new ExecutionLifecyclePublicationFailure(args, authority.specId, {
        headBefore,
        exitCode: args.operation === 'gates-run' ? 3 : 1,
        stdout: text(output),
        stderr: text(errors),
      });
    }
  }
  const effect = (): ExecutionLifecycleResult => {
    try {
      if (args.operation === 'git-stage')
        git(authority.pin, ['--literal-pathspecs', 'add', '--', ...args.paths]);
      else if (args.operation === 'git-commit')
        git(authority.pin, [
          '--literal-pathspecs',
          'commit',
          '-m',
          args.message,
          '--',
          ...args.paths,
        ]);
      else if (args.operation === 'spec-commit') {
        data = autoCommit({
          repoRoot: authority.canonical,
          paths: [`.caws/specs/${args.specId}.yaml`],
          message: `chore(caws): commit pending audit state for ${args.specId}`,
          wasDirtyBeforeWrite: false,
        });
        requireValue((data as { kind: string }).kind === 'committed');
      } else if (args.operation === 'worktree-merge') {
        const input = {
          name: args.worktree,
          session,
          sessionCandidates: {
            candidates: [{ identity: session, source: 'codex_thread_env' as const }],
            trace: [],
          },
          actor,
          now: () => now,
          callerCwd: authority.canonical,
          noClose: true,
        };
        const preflight = mergeWorktree(cawsDir, { ...input, dryRun: true }, borrowed);
        requireValue(
          preflight.ok && preflight.value.kind === 'dry_run' && preflight.value.canProceed
        );
        validate();
        const result = mergeWorktree(cawsDir, input, borrowed);
        if (!result.ok) {
          const value = result.errors
            .map((error) => error.data?.merge_commit)
            .find(
              (value) => typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)
            );
          if (typeof value === 'string') mergeCommit = value;
        }
        requireValue(result.ok && result.value.kind === 'success');
        data = result.value.data;
        mergeCommit = (data as Record<string, unknown>).merge_commit as string;
        requireValue((data as Record<string, unknown>).canonical_checkout_state === 'in_sync');
        const baseSync = (data as Record<string, unknown>).base_checkout_sync;
        requireValue(
          Array.isArray(baseSync) &&
            baseSync.some((row) => row.path === authority.targetBaseRoot && row.state === 'in_sync')
        );
        requireValue(
          ((data as Record<string, unknown>).audit_commit as { kind: string })?.kind === 'committed'
        );
      } else if (args.operation === 'bridge-claim') {
        const result = acquireBridge(
          cawsDir,
          { specId: args.specId, session, actor, now, contextCwd: authority.canonical },
          borrowed
        );
        requireValue(result.ok);
        data = result.value;
      } else {
        const result = closeSpec(
          cawsDir,
          {
            id: args.specId,
            resolution: 'completed',
            mergeCommit: args.mergeCommit,
            reason: args.reason,
            actor,
            now: () => now,
          },
          borrowed
        );
        requireValue(result.ok && result.value.kind === 'success');
        data = result.value;
        requireValue((result.value.data?.audit_commit as { kind: string })?.kind === 'committed');
      }
      requireValue(verifyInheritedFence(cawsDir, fence), 'fence_unverified');
      return {
        operation: 'caws-lifecycle-v1',
        action: args.operation,
        specId: authority.specId,
        outcome: 'settled',
        exitCode: 0,
        head: framed(git(resultRoot, ['rev-parse', 'HEAD'])),
        ...(data !== undefined ? { data } : {}),
      };
    } catch (error) {
      let headAfter: string | undefined;
      try {
        headAfter = framed(git(resultRoot, ['rev-parse', 'HEAD']));
      } catch {
        /* retain the observation that is available */
      }
      throw new ExecutionLifecyclePublicationFailure(args, authority.specId, {
        headBefore,
        ...(headAfter !== undefined ? { headAfter } : {}),
        ...(mergeCommit !== undefined ? { mergeCommit } : {}),
        ...(typeof (error as { status?: unknown }).status === 'number'
          ? { exitCode: (error as { status: number }).status }
          : {}),
        ...(typeof (error as { stderr?: unknown }).stderr === 'string'
          ? { stderr: (error as { stderr: string }).stderr }
          : {}),
        ...(typeof (error as { stdout?: unknown }).stdout === 'string'
          ? { stdout: (error as { stdout: string }).stdout }
          : {}),
      });
    }
  };
  if (bridged) {
    requireValue(hookPolicy !== undefined, 'unsupported_profile');
    return withExecutionGitRuntime(
      configureHookRuntime(context, authority, args, hookPolicy),
      effect
    );
  }
  return effect();
}
