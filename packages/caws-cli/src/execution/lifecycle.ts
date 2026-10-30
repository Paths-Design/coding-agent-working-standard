import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative } from 'node:path';
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

export type ExecutionLifecycleArguments =
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
  if (operation === 'git-status' || operation === 'git-head' || operation === 'git-branch') {
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
  if (operation === 'spec-commit') {
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

const gitEnv = (): NodeJS.ProcessEnv => ({ PATH: '/usr/bin:/bin', LC_ALL: 'C' });
function git(cwd: string, args: readonly string[]): string {
  return execFileSync('/usr/bin/git', [...args], {
    cwd,
    env: gitEnv(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
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
function canonicalContext(context: ExecutionAuthorityContext): void {
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

function gitMetadataTree(root: string): void {
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
      current !== join(root, 'objects', 'info', 'alternates') &&
        current !== join(root, 'objects', 'info', 'http-alternates'),
      'unsupported_profile'
    );
  }
}

/** Inspect the effective normal Git configuration without evaluating includes.
 * Unknown executable/configuration closures refuse. No hooksPath or signing
 * override is installed by this consumer. */
export function inspectExecutionLifecycleGit(cwd: string): void {
  const entries = git(cwd, ['config', '--null', '--list', '--no-includes']).split('\0');
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
    // The fixed operations perform no network transport. A system credential
    // helper cannot be reached by this command family; promisor/remote config
    // that could introduce a lazy fetch remains unsupported.
    const harmless =
      /^(?:credential\.helper|user\.(?:name|email)|core\.(?:repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode)|init\.defaultbranch|branch\.[^.]+\.(?:remote|merge))$/.test(
        key
      );
    requireValue(
      harmless || (key === 'commit.gpgsign' && /^(?:false|no|off|0)$/i.test(value)),
      'unsupported_profile'
    );
  }
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
  if (hookDirectory === '/dev/null') return;
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
    for (const name of fs.readdirSync(hookDirectory)) {
      if (!active.has(name)) continue;
      const stat = fs.lstatSync(join(hookDirectory, name));
      requireValue(
        stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o111) === 0,
        'unsupported_profile'
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
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
function boundedCheckoutInventory(canonical: string, pin: string): string {
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
  context: ExecutionAuthorityContext,
  args: ExecutionLifecycleArguments
): ExecutionLifecycleAuthority {
  canonicalContext(context);
  gitMetadataTree(join(context.projectRoot, '.git'));
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
    args.operation === 'spec-commit'
  ) {
    const authority = readExecutionAuthority(context);
    pin = authority.pin;
    specId = authority.binding.spec.id;
    if (args.operation === 'spec-commit') requireValue(specId === args.specId, 'scope_refused');
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
    git(context.projectRoot, ['merge-base', '--is-ancestor', args.mergeCommit, 'HEAD']);
    if (args.operation === 'spec-close')
      requireValue(
        readExecutionAuthority(context).binding.spec.id === args.specId,
        'scope_refused'
      );
    pin = context.projectRoot;
    specId = args.specId;
  }
  const checkoutInventory = boundedCheckoutInventory(context.projectRoot, pin);
  inspectExecutionLifecycleGit(pin);
  if (pin !== context.projectRoot) inspectExecutionLifecycleGit(context.projectRoot);
  const hash = createHash('sha256');
  hash.update(checkoutInventory);
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

function ownedPaths(context: ExecutionAuthorityContext, paths: readonly string[]): void {
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
  readonly head: string;
  readonly stdout?: string;
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
  };
  constructor(
    args: Pick<ExecutionLifecycleArguments, 'operation'>,
    specId: string,
    observation: {
      readonly headBefore?: string;
      readonly headAfter?: string;
      readonly mergeCommit?: string;
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
  const context: ExecutionAuthorityContext = {
    projectRoot: process.env.CAWS_EXECUTION_PROJECT!,
    association: {
      callerAnchor: process.env.CAWS_EXECUTION_CALLER!,
      threadId: process.env.CAWS_EXECUTION_THREAD!,
    },
    execution: { cwd: process.cwd() },
  };
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
  const resultRoot = args.operation.startsWith('git-') ? authority.pin : authority.canonical;
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
      head: headBefore,
      stdout,
    };
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
