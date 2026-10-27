import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, relative } from 'node:path';
import { analyzeCommand } from '../shell/analysis/analyze';
import { classifyInterpreterEffects } from '../shell/analysis/interpreter-effects';
import { loadParser } from '../shell/analysis/load-parser';
import { inside, sensitiveBinding } from '../shell/analysis/policies';
import { evaluatePath } from '../kernel';
import {
  ExecutionAuthorityUnavailable,
  readExecutionAuthority,
  type ExecutionAuthority,
} from './authority';
import { verifyInheritedFence } from './fence';
import type {
  AuthorizerReply,
  AuthorizerRequest,
  ExecutionReasonCode,
  PreparedExecutionV1,
  ProgramImage,
} from './prepared';

const BUILTINS = new Set([
  ':',
  'cd',
  'printf',
  'echo',
  'pwd',
  'true',
  'false',
  'test',
  '[',
  'read',
]);
const SPECIAL_BINDING =
  /^(?:BASH.*|COMP_.*|PWD|OLDPWD|SHLVL|UID|EUID|PPID|BASHPID|RANDOM|SRANDOM|SECONDS|LINENO|DIRSTACK|FUNCNAME|GROUPS|PIPESTATUS|_)$/;
// sort can spill implicit temporary files and has no native v1 write profile.
const UTILITIES = new Set([
  'sed',
  'rg',
  'grep',
  'cat',
  'head',
  'tail',
  'wc',
  'ls',
  'cut',
  'tr',
  'uniq',
  'printf',
  'echo',
  'pwd',
  'true',
  'false',
  'test',
  '[',
]);
function refuse(code: ExecutionReasonCode): never {
  throw new ExecutionAuthorityUnavailable(code);
}
function protectedSystemImage(path: string): boolean {
  const stat = fs.statSync(path);
  return (
    ['/bin', '/usr/bin'].includes(dirname(path)) &&
    stat.isFile() &&
    stat.uid === 0 &&
    (stat.mode & 0o022) === 0
  );
}
function verifyImage(image: ProgramImage): void {
  if (fs.realpathSync.native(image.path) !== image.path) refuse('unsupported_profile');
  const fd = fs.openSync(
    image.path,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
  );
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size > 268435456n) refuse('unsupported_profile');
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(65536);
    let offset = 0;
    for (;;) {
      const count = fs.readSync(fd, buffer, 0, buffer.length, offset);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
      offset += count;
      if (offset > 268435456) refuse('unsupported_profile');
    }
    const after = fs.fstatSync(fd, { bigint: true });
    const name = fs.lstatSync(image.path, { bigint: true });
    if (
      BigInt(offset) !== before.size ||
      hash.digest('hex') !== image.sha256 ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.ctimeNs !== before.ctimeNs ||
      after.mtimeNs !== before.mtimeNs ||
      name.dev !== before.dev ||
      name.ino !== before.ino
    )
      refuse('unsupported_profile');
  } finally {
    fs.closeSync(fd);
  }
}
function environment(record: PreparedExecutionV1): Map<string, readonly string[]> {
  const values = new Map(
    record.execution.environment.map(({ name, value }) => [name, [value] as readonly string[]])
  );
  for (const [name, [value]] of values) {
    if (['PWD', 'OLDPWD'].includes(name)) refuse('unsupported_profile');
    if (
      name.startsWith('BASH_FUNC_') ||
      (sensitiveBinding(name) && !['PATH', 'LANG', 'LC_ALL'].includes(name))
    )
      refuse('unsupported_profile');
    if (['LANG', 'LC_ALL'].includes(name) && value !== 'C') refuse('unsupported_profile');
  }
  const path = values.get('PATH');
  if (!path || path.length !== 1 || !path[0]) refuse('unsupported_profile');
  for (const directory of path[0].split(':'))
    if (
      !isAbsolute(directory) ||
      fs.realpathSync.native(directory) !== directory ||
      !fs.statSync(directory).isDirectory()
    )
      refuse('unsupported_profile');
  const ordinary = new Map([...values].filter(([name]) => !SPECIAL_BINDING.test(name)));
  ordinary.set('PWD', [record.execution.cwd]);
  return ordinary;
}
function utilityPath(command: string, path: string): string {
  if (isAbsolute(command)) return fs.realpathSync.native(command);
  if (command.includes('/')) refuse('unsupported_profile');
  for (const directory of path.split(':')) {
    const candidate = `${directory}/${command}`;
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return fs.realpathSync.native(candidate);
    } catch (error) {
      if (
        !(
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          ['ENOENT', 'ENOTDIR'].includes(String(error.code))
        )
      )
        refuse('unsupported_profile');
    }
  }
  return refuse('unsupported_profile');
}
function writeAllowed(target: string, cwd: string, authority: ExecutionAuthority): void {
  const spelling = isAbsolute(target) ? target : `${cwd}/${target}`;
  const leaf = basename(spelling);
  if (!leaf || ['.', '..'].includes(leaf)) refuse('source_unresolved');
  const parent = fs.realpathSync.native(dirname(spelling));
  const physical = `${parent}/${leaf}`;
  if (!inside(physical, authority.pin)) refuse('scope_refused');
  const path = relative(authority.pin, physical);
  // Ordinary execution never borrows the kernel's infrastructure exemption to
  // edit its own authority, native registration, Git state, or secret controls.
  if (
    path
      .split('/')
      .some(
        (part) =>
          ['.caws', '.git', '.codex', '.claude', '.env'].includes(part) || part.startsWith('.env.')
      )
  )
    refuse('scope_refused');
  try {
    const stat = fs.lstatSync(physical);
    if (!stat.isFile() || stat.nlink !== 1) refuse('scope_refused');
  } catch (error) {
    if (
      !(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')
    )
      throw error;
  }
  if (evaluatePath(path, authority.binding, authority.policy).kind !== 'admit')
    refuse('scope_refused');
}

/** Analyze actual source and finite effects without running submitted expansion.
 * This v1 admits clean Bash builtins, the bounded utility-role profiles and the
 * existing literal Node effect grammar on this same trusted Node runtime.
 * No extracted writes never admits an unknown executable or interpreter file.
 */
async function inspectSource(
  record: PreparedExecutionV1,
  authority: ExecutionAuthority
): Promise<void> {
  const bindings = environment(record);
  // Bash's special variables have startup/read/assignment semantics outside
  // ordinary scalar tracking. A syntax scan only narrows admission; the bounded
  // analyzer below must independently accept every other part of the source.
  const tree: unknown = (await loadParser()).parse(record.profile.source);
  const pending: unknown[] = [tree];
  let nodes = 0;
  while (pending.length) {
    if (++nodes > 16384) refuse('source_unresolved');
    const value = pending.pop();
    if (value === null || typeof value !== 'object') continue;
    const row = value as Record<string, unknown>;
    if (row.type === 'Assignment' && typeof row.name === 'string' && SPECIAL_BINDING.test(row.name))
      refuse('unsupported_profile');
    if (
      row.type === 'For' &&
      row.name !== null &&
      typeof row.name === 'object' &&
      'value' in row.name &&
      typeof row.name.value === 'string' &&
      SPECIAL_BINDING.test(row.name.value)
    )
      refuse('unsupported_profile');
    for (const child of Object.values(row)) {
      if (Array.isArray(child)) pending.push(...child);
      else if (child !== null && typeof child === 'object') pending.push(child);
    }
  }
  if (
    basename(record.execution.executable.path) !== 'bash' ||
    !protectedSystemImage(record.execution.executable.path)
  )
    refuse('unsupported_profile');
  verifyImage(record.execution.executable);
  const path = bindings.get('PATH')![0]!;
  const used = new Set<string>();
  const nodeProfiles = new Set<string>();
  const writes: { path: string; cwd: string }[] = [];
  const observerErrors: unknown[] = [];
  const observe = (body: () => void): void => {
    try {
      body();
    } catch (error) {
      // The analyzer deliberately catches traversal failures. Preserve the
      // independent execution-profile refusal instead of relabeling it as a
      // parser failure or allowing a later successful observation to erase it.
      observerErrors.push(error);
      throw error;
    }
  };
  const verifyUtility = (command: string): void => {
    const resolved = utilityPath(command, path);
    const image = record.profile.utilities.find((candidate) => candidate.path === resolved);
    if (!image) refuse('unsupported_profile');
    if (basename(command) === 'node') {
      if (resolved !== fs.realpathSync.native(process.execPath)) refuse('unsupported_profile');
    } else if (basename(resolved) !== basename(command) || !protectedSystemImage(resolved)) {
      // A root-owned image/hash does not establish which utility it implements.
      // The v1 system profiles admit only their named system executable; PATH
      // aliases to other utilities, shells or multicall images need a profile.
      refuse('unsupported_profile');
    }
    if (!used.has(resolved)) verifyImage(image);
    used.add(resolved);
  };
  const analysis = await analyzeCommand(
    {
      command: record.profile.source,
      cwd: record.execution.cwd,
      worktree: authority.pin,
      shell: 'bash',
    },
    {
      context: { canonical: authority.canonical, worktree: authority.pin },
      inheritedBindings: bindings,
      // Git has no v1 native execution profile; never run discovery from submitted data.
      gitContext: () => null,
      observers: {
        invocation({ node, argv, state }) {
          observe(() => {
            let args = argv;
            for (let depth = 0; args[0]?.value === 'command'; depth++) {
              if (depth >= 8) refuse('unsupported_profile');
              args = args.slice(args[1]?.value === '--' ? 2 : 1);
            }
            const command = args[0]?.value;
            if (!command) refuse('source_unresolved');
            if (BUILTINS.has(command)) {
              if (
                command === 'read' &&
                args.slice(1).some((arg) => arg.value !== null && SPECIAL_BINDING.test(arg.value))
              )
                refuse('unsupported_profile');
              return;
            }
            const name = basename(command);
            if (name === 'node') {
              if (
                args.length !== 3 ||
                args[1]?.value !== '-e' ||
                args[2]?.value === null ||
                args[2]?.value === undefined
              )
                refuse('unsupported_profile');
              const effects = classifyInterpreterEffects('node', args[2].value);
              if (effects.kind === 'unresolved') refuse('source_unresolved');
              verifyUtility(command);
              nodeProfiles.add(`${node.pos}:${node.end}`);
              for (const write of effects.writes)
                writes.push({ path: write.target, cwd: state.cwd });
              return;
            }
            if (!UTILITIES.has(name)) refuse('unsupported_profile');
            verifyUtility(command);
          });
        },
        redirection({ node, targets, state }) {
          observe(() => {
            if (
              node.descriptor !== undefined &&
              (node.descriptor.type !== 'FileDescriptor' ||
                ![0, 1, 2].includes(node.descriptor.value))
            )
              refuse('unsupported_profile');
            if (['<&', '>&'].includes(node.operator)) {
              if (
                !targets.every(
                  (fields) => fields.length === 1 && /^(?:[012]|-)$/.test(fields[0]?.value ?? '')
                )
              )
                refuse('unsupported_profile');
              return;
            }
            if (node.type === 'HereString' || node.operator === '<') return;
            for (const fields of targets) {
              if (
                fields.length !== 1 ||
                fields[0]?.value === null ||
                fields[0]?.value === undefined
              )
                refuse('source_unresolved');
              writes.push({ path: fields[0].value, cwd: state.cwd });
            }
          });
        },
      },
    }
  );
  if (observerErrors.length > 0) throw observerErrors[0];
  const reasons = analysis.reasons.filter(
    (reason) =>
      !(
        nodeProfiles.has(`${reason.start}:${reason.end}`) &&
        ['utility-unsupported', 'executable-path'].includes(reason.code)
      )
  );
  if (analysis.decision === 'deny') refuse('source_denied');
  if (reasons.length) refuse('source_unresolved');
  if (record.profile.utilities.length !== used.size) refuse('unsupported_profile');
  for (const write of writes) writeAllowed(write.path, write.cwd, authority);
}

/** Called only by the private framed child. This is an observation, never a
 * permit or USER spawn. Final validation neither acquires nor releases fd3.
 * Rust independently owns monotonic expiry, cancellation and one-use launch.
 */
export async function evaluatePreparedExecution(
  record: PreparedExecutionV1,
  request: AuthorizerRequest
): Promise<AuthorizerReply> {
  const base = {
    protocol: 'caws.execution.authorizer.v1' as const,
    phase: request.phase,
    invocationId: request.invocationId,
    executionDigest: request.executionDigest,
  };
  try {
    if (record.invocationId !== request.invocationId) refuse('invalid_record');
    if (Date.now() >= record.limits.preparationDeadlineUnixMs) refuse('deadline_expired');
    if (
      request.phase === 'final_validate' &&
      (!request.fence || !verifyInheritedFence(`${record.projectRoot}/.caws`, request.fence))
    )
      refuse('fence_unverified');
    const authority = readExecutionAuthority(record);
    if (
      request.phase === 'final_validate' &&
      request.expectedAuthorityRevision !== authority.revision
    )
      refuse('authority_changed');
    await inspectSource(record, authority);
    if (readExecutionAuthority(record).revision !== authority.revision) refuse('authority_changed');
    if (Date.now() >= record.limits.preparationDeadlineUnixMs) refuse('deadline_expired');
    if (
      request.phase === 'final_validate' &&
      (!request.fence || !verifyInheritedFence(authority.cawsDir, request.fence))
    )
      refuse('fence_unverified');
    return { ...base, decision: 'allow', authorityRevision: authority.revision, reasonCodes: [] };
  } catch (error) {
    const code =
      error instanceof ExecutionAuthorityUnavailable ? error.reason : 'infrastructure_unavailable';
    return {
      ...base,
      decision: ['source_denied', 'foreign_owner', 'scope_refused'].includes(code)
        ? 'deny'
        : 'unresolved',
      authorityRevision: null,
      reasonCodes: [code],
    };
  }
}
