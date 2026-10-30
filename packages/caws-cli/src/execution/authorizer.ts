import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { analyzeCommand } from '../shell/analysis/analyze';
import { classifyInterpreterEffects } from '../shell/analysis/interpreter-effects';
import { loadParser } from '../shell/analysis/load-parser';
import type { SyntaxNode, Word, WordPart } from '../shell/analysis/parser-types';
import type { Argument } from '../shell/analysis/types';
import { inside, sensitiveBinding } from '../shell/analysis/policies';
import { evaluatePath } from '../kernel';
import { normalizeRelativePosixPath } from '../kernel/scope/normalize';
import { snapshotNpmProject } from './npm-project';
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
export function isExecutionProfileBuiltin(command: string): boolean {
  return BUILTINS.has(command);
}
export function executionProfileArguments(argv: readonly Argument[]): readonly Argument[] {
  let args = argv;
  for (let depth = 0; args[0]?.value === 'command'; depth++) {
    if (depth >= 8) refuse('unsupported_profile');
    args = args.slice(args[1]?.value === '--' ? 2 : 1);
  }
  return args;
}
const SPECIAL_BINDING =
  /^(?:BASH.*|COMP_.*|PWD|OLDPWD|SHLVL|UID|EUID|PPID|BASHPID|RANDOM|SRANDOM|SECONDS|LINENO|DIRSTACK|FUNCNAME|GROUPS|PIPESTATUS|OPTIND|OPTERR|HISTCMD|EPOCHSECONDS|EPOCHREALTIME|_)$/;
// These controls can change executable lookup, shell semantics, or write a
// history file without a modeled write operand. Opaque values alone are not
// enough: the actual child environment and every assignment route must refuse.
const PROFILE_CONTROL = /^(?:EXECIGNORE|BASH_COMPAT|POSIX_PEDANTIC|HISTFILESIZE)$/;
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

export interface ExecutionEvidenceArguments {
  readonly id: string;
  readonly criterionId: string;
  readonly status: 'pass' | 'fail' | 'unchecked';
  readonly evidenceRef: string;
  readonly command?: string;
  readonly exitCode?: number;
  readonly artifactPath?: string;
  readonly commitSha?: string;
  readonly verify: boolean;
}

/** A closed operation grammar. Narrative fields remain data, regardless of their contents. */
export function parseExecutionEvidenceArguments(
  argv: readonly string[],
  specId: string
): ExecutionEvidenceArguments {
  if (argv[0] !== 'specs' || argv[1] !== 'evidence' || argv[2] !== specId) refuse('scope_refused');
  const values = new Map<string, string>();
  let verify = false;
  const flags = new Set([
    '--ac',
    '--status',
    '--evidence-ref',
    '--command',
    '--exit-code',
    '--artifact-path',
    '--commit-sha',
  ]);
  for (let i = 3; i < argv.length; i++) {
    const flag = argv[i]!;
    if (flag === '--verify') {
      if (verify) refuse('unsupported_profile');
      verify = true;
      continue;
    }
    const value = argv[++i];
    if (!flags.has(flag) || values.has(flag) || value === undefined || value.includes('\0'))
      refuse('unsupported_profile');
    values.set(flag, value);
  }
  const criterionId = values.get('--ac');
  const status = values.get('--status');
  const evidenceRef = values.get('--evidence-ref');
  if (
    !criterionId ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(criterionId) ||
    !['pass', 'fail', 'unchecked'].includes(status ?? '') ||
    !evidenceRef?.trim()
  )
    refuse('unsupported_profile');
  const artifactPath = values.get('--artifact-path');
  if (artifactPath !== undefined) {
    const normalized = normalizeRelativePosixPath(artifactPath);
    if (
      !normalized.ok ||
      normalized.normalized !== artifactPath ||
      /[\x00-\x1f\x7f]/.test(artifactPath)
    )
      refuse('unsupported_profile');
  }
  const commitSha = values.get('--commit-sha');
  if (commitSha !== undefined && !/^[0-9a-f]{40}$/.test(commitSha)) refuse('unsupported_profile');
  if (verify && (artifactPath === undefined || commitSha === undefined))
    refuse('unsupported_profile');
  const exit = values.get('--exit-code');
  if (
    exit !== undefined &&
    (!/^-?(?:0|[1-9][0-9]*)$/.test(exit) || !Number.isSafeInteger(Number(exit)))
  )
    refuse('unsupported_profile');
  return {
    id: specId,
    criterionId,
    status: status as ExecutionEvidenceArguments['status'],
    evidenceRef,
    verify,
    ...(values.has('--command') ? { command: values.get('--command')! } : {}),
    ...(exit !== undefined ? { exitCode: Number(exit) } : {}),
    ...(artifactPath !== undefined ? { artifactPath } : {}),
    ...(commitSha !== undefined ? { commitSha } : {}),
  };
}

function evidenceLiteral(word: Word): string {
  let scheduled = 0;
  const pieces = (parts: readonly WordPart[], depth: number): string => {
    if (depth > 16) refuse('source_unresolved');
    return parts
      .map((part) => {
        if (++scheduled > 8192) refuse('source_unresolved');
        if (part.type === 'Literal' || part.type === 'SingleQuoted') return part.value;
        if (part.type === 'DoubleQuoted') return pieces(part.parts, depth + 1);
        return refuse('unsupported_profile');
      })
      .join('');
  };
  const parts = word.parts;
  const value = parts === undefined ? word.value : pieces(parts, 0);
  // Tilde is performed before word expansion. The dedicated consumer accepts
  // literal argv only, and never obtains a home directory by evaluating source.
  if (word.text.startsWith('~') || value.includes('\0')) refuse('unsupported_profile');
  return value;
}

export interface EvidenceExecutionPlan {
  readonly kind: 'caws-evidence-v1';
  readonly argv: readonly string[];
}

/** Recognize one literal trusted consumer call without executing shell expansion.
 * The native owner must independently pin this same package and retain the fence
 * through this consumer; this observation cannot promote generic USER code.
 */
export async function discoverEvidenceExecution(
  record: PreparedExecutionV1,
  authority: ExecutionAuthority
): Promise<EvidenceExecutionPlan | null> {
  const { parse } = await loadParser();
  const script = parse(record.profile.source);
  if (script.errors?.length || script.shebang || script.commands.length !== 1) return null;
  const statement = script.commands[0]!;
  const command = statement.command;
  if (
    statement.background ||
    command.type !== 'Command' ||
    !command.name ||
    command.prefix.length ||
    command.redirects.length ||
    command.args.some((arg) => arg.type !== 'Word')
  )
    return null;
  const args = [command.name, ...command.args] as readonly Word[];
  let argv: string[];
  try {
    argv = args.map(evidenceLiteral);
  } catch {
    return null;
  }
  const entry = join(__dirname, 'writer-main.js');
  if (argv[1] !== entry) return null;
  const node = fs.realpathSync.native(process.execPath);
  if (argv[0] !== node) refuse('unsupported_profile');
  parseExecutionEvidenceArguments(argv.slice(2), authority.binding.spec.id);
  const environment = new Map(record.execution.environment.map(({ name, value }) => [name, value]));
  const expected = new Map([
    ['CAWS_EXECUTION_PROJECT', record.projectRoot],
    ['CAWS_EXECUTION_CALLER', record.association.callerAnchor],
    ['CAWS_EXECUTION_SESSION', record.association.sessionId],
    ['CAWS_EXECUTION_THREAD', record.association.threadId],
    ['CAWS_EXECUTION_CALL', record.association.callId],
    ['LC_ALL', 'C'],
  ]);
  if (
    environment.size !== expected.size + 1 ||
    !environment.has('PATH') ||
    [...expected].some(([name, value]) => environment.get(name) !== value)
  )
    refuse('unsupported_profile');
  if (record.profile.kind === 'caws-evidence-v1' && environment.get('PATH') !== '/usr/bin:/bin')
    refuse('unsupported_profile');
  executionProfileBindings(record);
  if (record.execution.stdinBase64 !== '') refuse('unsupported_profile');
  return { kind: 'caws-evidence-v1', argv };
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
function inspectNpmTest(record: PreparedExecutionV1, authority: ExecutionAuthority): void {
  const npm = record.profile.npm;
  const ceiling = record.sandbox.writeCeiling;
  if (!npm || !ceiling || record.profile.source !== 'npm test' || record.profile.utilities.length)
    refuse('unsupported_profile');
  const { runtime, project } = npm;
  if (
    project.packageJson.path !== join(record.execution.cwd, 'package.json') ||
    project.npmrc !== null ||
    runtime.node.path !== fs.realpathSync.native(process.execPath) ||
    runtime.entry.path !== join(runtime.root, 'bin', 'npm-cli.js') ||
    fs.realpathSync.native(runtime.root) !== runtime.root ||
    inside(runtime.root, authority.canonical) ||
    inside(ceiling.invocationRoot, authority.canonical)
  )
    refuse('unsupported_profile');
  verifyImage(runtime.node);
  verifyImage(runtime.entry);
  const safePath = [
    ...new Set(
      [dirname(runtime.node.path), '/usr/bin', '/bin'].map((name) => fs.realpathSync.native(name))
    ),
  ].join(':');
  const expected = new Map([
    ['CAWS_EXECUTION_CALL', record.association.callId],
    ['CAWS_EXECUTION_CALLER', record.association.callerAnchor],
    ['CAWS_EXECUTION_PROJECT', record.projectRoot],
    ['CAWS_EXECUTION_SESSION', record.association.sessionId],
    ['CAWS_EXECUTION_THREAD', record.association.threadId],
    ['CODEX_SANDBOX', 'seatbelt'],
    ['CODEX_SANDBOX_NETWORK_DISABLED', '1'],
    ['HOME', ceiling.invocationRoot],
    ['LC_ALL', 'C'],
    ['NPM_CONFIG_CACHE', ceiling.cacheRoot],
    ['NPM_CONFIG_GLOBALCONFIG', '/dev/null'],
    ['NPM_CONFIG_SCRIPT_SHELL', '/bin/sh'],
    ['NPM_CONFIG_USERCONFIG', '/dev/null'],
    ['PATH', safePath],
    ['TMPDIR', ceiling.tmpRoot],
  ]);
  const actual = new Map(record.execution.environment.map(({ name, value }) => [name, value]));
  if (
    actual.size !== expected.size ||
    [...expected].some(([name, value]) => actual.get(name) !== value)
  )
    refuse('unsupported_profile');
  const observed = snapshotNpmProject(
    record.execution.cwd,
    safePath,
    record.limits.preparationDeadlineUnixMs
  );
  if (
    observed.packageJson.path !== project.packageJson.path ||
    observed.packageJson.sha256 !== project.packageJson.sha256 ||
    observed.testScript !== project.testScript ||
    observed.pathShadowSha256 !== project.pathShadowSha256
  )
    refuse('unsupported_profile');
  for (const root of [
    ceiling.invocationRoot,
    ceiling.outputRoot,
    ceiling.tmpRoot,
    ceiling.cacheRoot,
  ]) {
    if (fs.realpathSync.native(root) !== root) refuse('unsupported_profile');
    const stat = fs.lstatSync(root);
    if (
      !stat.isDirectory() ||
      typeof process.getuid !== 'function' ||
      stat.uid !== process.getuid() ||
      (stat.mode & 0o7777) !== 0o700
    )
      refuse('unsupported_profile');
  }
  for (const root of [ceiling.outputRoot, ceiling.tmpRoot, ceiling.cacheRoot])
    if (fs.readdirSync(root).length !== 0) refuse('unsupported_profile');
}
export function executionProfileBindings(
  record: PreparedExecutionV1
): Map<string, readonly string[]> {
  const values = new Map(
    record.execution.environment.map(({ name, value }) => [name, [value] as readonly string[]])
  );
  for (const [name, [value]] of values) {
    if (['PWD', 'OLDPWD'].includes(name)) refuse('unsupported_profile');
    if (
      name.startsWith('BASH_FUNC_') ||
      PROFILE_CONTROL.test(name) ||
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
function excludedEntryAliases(
  physical: string,
  exists: boolean,
  authority: ExecutionAuthority
): void {
  for (const prefix of authority.binding.spec.scope.out ?? []) {
    const normalized = normalizeRelativePosixPath(prefix);
    if (!normalized.ok) refuse('binding_unavailable');
    const excluded = `${authority.pin}/${normalized.normalized.replace(/\/$/, '')}`;
    try {
      if (inside(physical, fs.realpathSync.native(excluded))) refuse('scope_refused');
      continue;
    } catch (error) {
      if (error instanceof ExecutionAuthorityUnavailable) throw error;
      if (!['ENOENT', 'ENOTDIR'].includes(String((error as NodeJS.ErrnoException).code)))
        refuse('source_unresolved');
    }
    // An existing destination cannot alias an absent exclusion. A dangling
    // excluded link has unresolved referent identity and cannot erase scope.
    try {
      if (fs.lstatSync(excluded).isSymbolicLink()) refuse('source_unresolved');
    } catch (error) {
      if (error instanceof ExecutionAuthorityUnavailable) throw error;
      if (!['ENOENT', 'ENOTDIR'].includes(String((error as NodeJS.ErrnoException).code)))
        refuse('source_unresolved');
    }
    if (exists) continue;
    let excludedParent: string;
    try {
      excludedParent = fs.realpathSync.native(dirname(excluded));
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes(String((error as NodeJS.ErrnoException).code))) continue;
      refuse('source_unresolved');
    }
    if (excludedParent !== dirname(physical)) continue;
    const excludedLeaf = basename(excluded);
    const leaf = basename(physical);
    // No creation probe or guessed Unicode/filesystem case-fold algorithm.
    // Where both entries are absent, an unresolved alias comparison stays held.
    if (
      /[^\x00-\x7f]/.test(excludedLeaf + leaf) ||
      excludedLeaf.toLowerCase() === leaf.toLowerCase()
    )
      refuse('source_unresolved');
  }
}
function writeAllowed(target: string, cwd: string, authority: ExecutionAuthority): void {
  const spelling = isAbsolute(target) ? target : `${cwd}/${target}`;
  const leaf = basename(spelling);
  if (!leaf || ['.', '..'].includes(leaf)) refuse('source_unresolved');
  const parent = fs.realpathSync.native(dirname(spelling));
  let physical = `${parent}/${leaf}`;
  if (!inside(physical, authority.pin)) refuse('scope_refused');
  let exists = false;
  let observedExisting = false;
  try {
    const stat = fs.lstatSync(physical, { bigint: true });
    observedExisting = true;
    if (!stat.isFile() || stat.nlink !== 1n) refuse('scope_refused');
    const canonical = fs.realpathSync.native(physical);
    const observed = fs.lstatSync(canonical, { bigint: true });
    if (
      !observed.isFile() ||
      observed.nlink !== 1n ||
      observed.dev !== stat.dev ||
      observed.ino !== stat.ino
    )
      refuse('scope_refused');
    physical = canonical;
    exists = true;
  } catch (error) {
    if (error instanceof ExecutionAuthorityUnavailable) throw error;
    if (observedExisting) refuse('source_unresolved');
    if (
      !(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')
    )
      throw error;
  }
  if (!inside(physical, authority.pin)) refuse('scope_refused');
  const path = relative(authority.pin, physical);
  // Unicode equivalence varies by filesystem, including ignorable characters
  // in reserved prefix families. Native v1 does not guess that algorithm.
  // Root coordinates, source and read data may remain UTF-8.
  if (/[^\x00-\x7f]/.test(path)) refuse('source_unresolved');
  // Ordinary execution never borrows the kernel's infrastructure exemption to
  // edit its own authority, native registration, Git state, or secret controls.
  if (
    path
      .split('/')
      .some(
        (part) =>
          ['.caws', '.git', '.codex', '.claude', '.env'].includes(part.toLowerCase()) ||
          part.toLowerCase().startsWith('.env.')
      )
  )
    refuse('scope_refused');
  if (inside(physical, fs.realpathSync.native(authority.cawsDir))) refuse('scope_refused');
  if (evaluatePath(path, authority.binding, authority.policy).kind !== 'admit')
    refuse('scope_refused');
  // Preserve the kernel's policy exemption before scope.out. This secondary
  // check may narrow an admission; it never grants one by folding a scope.in.
  const excludedBinding = {
    ...authority.binding,
    spec: { ...authority.binding.spec, scope: { ...authority.binding.spec.scope, out: [path] } },
  };
  if (evaluatePath(path, excludedBinding, authority.policy).kind !== 'admit')
    excludedEntryAliases(physical, exists, authority);
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
  if (record.profile.kind === 'npm-test-v1') {
    inspectNpmTest(record, authority);
    return;
  }
  if (record.profile.kind === 'caws-evidence-v1') {
    const plan = await discoverEvidenceExecution(record, authority);
    if (
      !plan ||
      plan.argv.length !== record.execution.argv.length ||
      plan.argv.some((arg, index) => arg !== record.execution.argv[index]) ||
      record.execution.executable.path !== plan.argv[0]
    )
      refuse('unsupported_profile');
    const expected = [plan.argv[0]!, plan.argv[1]!, '/usr/bin/git'];
    if (
      record.profile.utilities.length !== expected.length ||
      !protectedSystemImage('/usr/bin/git')
    )
      refuse('unsupported_profile');
    for (const path of expected) {
      const image = record.profile.utilities.find((candidate) => candidate.path === path);
      if (!image) refuse('unsupported_profile');
      verifyImage(image);
    }
    verifyImage(record.execution.executable);
    return;
  }
  const bindings = executionProfileBindings(record);
  // Bash's special variables have startup/read/assignment semantics outside
  // ordinary scalar tracking. A syntax scan only narrows admission; the bounded
  // analyzer below must independently accept every other part of the source.
  const { parse, forEachChild } = await loadParser();
  const pending: { node: SyntaxNode; depth: number }[] = [
    { node: parse(record.profile.source), depth: 0 },
  ];
  let nodes = 1;
  while (pending.length) {
    const { node, depth } = pending.pop()!;
    // Decoded backtick scripts use reconstructed source coordinates. They
    // cannot be joined to the submitted bytes, even if their syntax is valid.
    if (node.type === 'Script' && (node.source !== undefined || node.errors?.length))
      refuse('source_unresolved');
    // Bash can materialize either form in a temporary file. The core analyzer
    // also handles HereDoc before its redirection observer, so this profile
    // check must inspect the syntax tree rather than depend on that observer.
    if (node.type === 'HereDoc' || node.type === 'HereString') refuse('unsupported_profile');
    if (
      node.type === 'Assignment' &&
      (SPECIAL_BINDING.test(node.name) || PROFILE_CONTROL.test(node.name))
    )
      refuse('unsupported_profile');
    if (
      node.type === 'For' &&
      (SPECIAL_BINDING.test(node.name.value) || PROFILE_CONTROL.test(node.name.value))
    )
      refuse('unsupported_profile');
    // Word.parts and substitution.script are lazy prototype getters, omitted
    // by Object.values. The parser's semantic traversal materializes these
    // children without executing source. Bound scheduling as well as depth.
    forEachChild(node, (child) => {
      if (++nodes > 16384 || depth >= 64) refuse('source_unresolved');
      pending.push({ node: child, depth: depth + 1 });
    });
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
            const args = executionProfileArguments(argv);
            const command = args[0]?.value;
            if (!command) refuse('source_unresolved');
            if (isExecutionProfileBuiltin(command)) {
              if (
                command === 'read' &&
                args
                  .slice(1)
                  .some(
                    (arg) =>
                      arg.value !== null &&
                      (SPECIAL_BINDING.test(arg.value) || PROFILE_CONTROL.test(arg.value))
                  )
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
            if (node.operator === '<') return;
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
