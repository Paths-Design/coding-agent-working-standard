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

// Keep fixed command loading after original environment and fence validation.
const loadFixedApplication = createRequire(__filename);

export type ExecutionLifecycleArguments =
  | { readonly operation: 'doctor' }
  | { readonly operation: 'gates-run'; readonly specId: string }
  | { readonly operation: 'git-status' }
  | { readonly operation: 'git-head' }
  | { readonly operation: 'git-branch' }
  | { readonly operation: 'git-stage'; readonly paths: readonly string[] }
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
  requireValue(argv.length > 0 && argv.length <= 260 && argv.every(literal), 'unsupported_profile');
  const operation = argv[0];
  if (
    operation === 'doctor' ||
    operation === 'git-status' ||
    operation === 'git-head' ||
    operation === 'git-branch'
  ) {
    requireValue(argv.length === 1, 'unsupported_profile');
    return { operation };
  }
  if (operation === 'git-stage' || operation === 'git-commit') {
    const offset = operation === 'git-stage' ? 1 : 3;
    requireValue(operation === 'git-stage' || argv[1] === '--message', 'unsupported_profile');
    requireValue(argv[offset] === '--', 'unsupported_profile');
    const paths = argv.slice(offset + 1);
    requireValue(
      paths.length > 0 &&
        paths.length <= 256 &&
        paths.every(pathArgument) &&
        new Set(paths).size === paths.length,
      'unsupported_profile'
    );
    return operation === 'git-stage'
      ? { operation, paths }
      : { operation, message: argv[2]!, paths };
  }
  const id = (value: string | undefined): value is string =>
    value !== undefined && /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*$/.test(value) && value.length <= 128;
  if (operation === 'spec-commit' || operation === 'gates-run') {
    requireValue(argv.length === 3 && argv[1] === '--spec' && id(argv[2]), 'unsupported_profile');
    return { operation, specId: argv[2] };
  }
  if (operation === 'worktree-merge') {
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
function executionGit(
  environment: readonly { readonly name: string; readonly value: string }[] = []
): LifecycleGitQuery {
  const homes = readExecutionLifecycleRuntimeHomes(environment);
  const gitEnvironment: NodeJS.ProcessEnv = {
    PATH: '/usr/bin:/bin',
    LC_ALL: 'C',
    ...(homes ? { HOME: homes.home } : {}),
  };
  return (cwd, args, input) =>
    execFileSync('/usr/bin/git', [...args], {
      cwd,
      env: gitEnvironment,
      encoding: 'utf8',
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
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
      /^(?:credential\.helper|user\.(?:name|email)|color\.ui|push\.autosetupremote|http\.postbuffer|pull\.(?:ff|rebase)|core\.(?:repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode)|(?:init|inti)\.defaultbranch|remote\..+\.(?:url|fetch)|branch\..+\.(?:remote|merge))$/.test(
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
  const revision = createHash('sha256').update(source).update(closure).digest('hex');
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
  if (hookDirectory === '/dev/null') return revision;
  try {
    directory(hookDirectory);
    const active = new Set([
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
    ]);
    for (const name of active) {
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(join(hookDirectory, name));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      requireValue(
        stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o111) === 0,
        'unsupported_profile'
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return revision;
}

export interface ExecutionLifecycleAuthority {
  readonly canonical: string;
  readonly cawsDir: string;
  readonly pin: string;
  readonly specId: string;
  readonly revision: string;
}

/** Existing merge settlement refreshes every checkout of the base branch.
 * This bounded consumer owns only canonical plus its authenticated pin, so an
 * additional checkout must refuse before any lifecycle publication. NUL
 * framing preserves checkout paths containing line breaks without quoting. */
function boundedCheckoutInventory(canonical: string, pin: string, git: LifecycleGitQuery): string {
  const inventory = git(canonical, ['worktree', 'list', '--porcelain', '-z']);
  const records = inventory.split('\0\0');
  requireValue(records.pop() === '', 'context_unresolved');
  const allowed = new Set([canonical, pin]);
  const observed = new Set<string>();
  requireValue(records.length === allowed.size, 'scope_refused');
  for (const record of records) {
    const fields = record.split('\0');
    requireValue(
      fields.length === 3 &&
        fields[0]!.startsWith('worktree ') &&
        /^HEAD (?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(fields[1]!) &&
        (fields[2] === 'detached' || fields[2]!.startsWith('branch refs/heads/')),
      'context_unresolved'
    );
    const checkout = fields[0]!.slice('worktree '.length);
    requireValue(
      isAbsolute(checkout) &&
        fs.realpathSync.native(checkout) === checkout &&
        allowed.has(checkout) &&
        !observed.has(checkout),
      'scope_refused'
    );
    observed.add(checkout);
  }
  requireValue(observed.size === allowed.size, 'scope_refused');
  return inventory;
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
  if (
    args.operation === 'git-stage' ||
    args.operation === 'git-commit' ||
    args.operation === 'git-status' ||
    args.operation === 'git-head' ||
    args.operation === 'git-branch' ||
    args.operation === 'spec-commit' ||
    args.operation === 'doctor' ||
    args.operation === 'gates-run'
  ) {
    const authority = readExecutionAuthority(context);
    pin = authority.pin;
    specId = authority.binding.spec.id;
    if (args.operation === 'spec-commit' || args.operation === 'gates-run')
      requireValue(specId === args.specId, 'scope_refused');
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
    requireValue(
      framed(git(context.projectRoot, ['symbolic-ref', '--quiet', 'HEAD'])) ===
        `refs/heads/${entry.baseBranch}`
    );
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
    requireValue(
      framed(git(context.projectRoot, ['symbolic-ref', '--quiet', 'HEAD'])) ===
        `refs/heads/${(merged.data as Record<string, unknown>).base_branch}`
    );
    if (args.operation === 'spec-close')
      requireValue(
        readExecutionAuthority(context).binding.spec.id === args.specId,
        'scope_refused'
      );
    pin = context.projectRoot;
    specId = args.specId;
  }
  const checkoutInventory = boundedCheckoutInventory(context.projectRoot, pin, git);
  if (pin !== context.projectRoot) lifecycleGitConfiguration(pin, git);
  const trees = [...new Set([context.projectRoot, pin])].map((cwd) =>
    framed(git(cwd, ['rev-parse', 'HEAD']))
  );
  // Native creates its fence between analyze and final_validate. Observe that
  // known path in both phases even if the project does not ignore it, so the
  // fence itself cannot change the inactive-attribute authority observation.
  const candidates = [
    `.caws/specs/${specId}.yaml`,
    '.caws/worktrees.json',
    '.caws/events.jsonl',
    '.caws/state.lock',
    ...(args.operation === 'git-stage' || args.operation === 'git-commit' ? args.paths : []),
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
    git(context.projectRoot, ['merge-base', '--is-ancestor', args.mergeCommit, 'HEAD']);
  const hash = createHash('sha256');
  hash
    .update(checkoutInventory)
    .update(pinClosure)
    .update(canonicalClosure)
    .update(JSON.stringify(homes ?? null));
  for (const name of [
    'policy.yaml',
    'worktrees.json',
    `specs/${specId}.yaml`,
    'claims/bridge.json',
    'events.jsonl',
  ]) {
    const bytes = physicalFile(
      join(cawsDir, name),
      name === 'claims/bridge.json' || name === 'events.jsonl'
    );
    hash.update(name).update(bytes ?? 'absent');
  }
  for (const cwd of new Set([pin, context.projectRoot]))
    hash.update(git(cwd, ['show-ref', '--head']));
  return { canonical: context.projectRoot, cawsDir, pin, specId, revision: hash.digest('hex') };
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
            ['.git', '.caws', '.codex', '.claude', '.env'].includes(part.toLowerCase()) ||
            part.toLowerCase().startsWith('.env.')
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
  requireValue(process.env.PATH === '/usr/bin:/bin' && process.env.LC_ALL === 'C');
  const context: ExecutionLifecycleContext = {
    projectRoot: process.env.CAWS_EXECUTION_PROJECT!,
    association: {
      callerAnchor: process.env.CAWS_EXECUTION_CALLER!,
      threadId: process.env.CAWS_EXECUTION_THREAD!,
    },
    execution: { cwd: process.cwd(), environment },
  };
  const git = executionGit(environment);
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
  const args = parseExecutionLifecycleArguments(argv);
  if (args.operation === 'doctor' || args.operation === 'gates-run')
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
  if (args.operation === 'git-stage' || args.operation === 'git-commit')
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
    args.operation === 'doctor' ||
    args.operation === 'gates-run'
      ? authority.pin
      : authority.canonical;
  const headBefore = framed(git(resultRoot, ['rev-parse', 'HEAD']));
  let mergeCommit: string | undefined;
  if (
    args.operation === 'git-status' ||
    args.operation === 'git-head' ||
    args.operation === 'git-branch'
  ) {
    const fixed =
      args.operation === 'git-status'
        ? ['--no-optional-locks', 'status', '--short']
        : args.operation === 'git-head'
          ? ['rev-parse', 'HEAD']
          : ['branch', '--show-current'];
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
  if (args.operation === 'doctor' || args.operation === 'gates-run') {
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
      // Fixed application APIs; no injected report, base override, runner or
      // process environment rewrite. Native installed the homes before import.
      if (args.operation === 'doctor') {
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
  } catch {
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
    });
  }
}
