import {
  GIT_EXECUTION_OPTIONS,
  GIT_READ_COMMANDS,
  GIT_LITERAL_GLOBAL_FLAGS,
  READER_SHORT,
  NODE_STARTUP_CONTROLS,
  inspectGitOptions,
  inspectReaderArguments,
  inspectSedArguments,
} from './inspection-profiles';
import {
  SSH_CONNECTION,
  gitHazard,
  gitLeavesWorkingTree,
  gitWriteOperands,
  isGitDataConfiguration,
  isGitInspection,
  readerHazard,
  sedScriptHazard,
} from './write-hazards';
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { AnalysisContext, Argument, Location, State, Value } from './types';

export function inside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}
export function resolveDirectory(path: string, cwd: string): string | null {
  try {
    // Do not normalize '..' before realpath: symlink/../ has physical semantics.
    return realpathSync.native(isAbsolute(path) ? path : `${cwd}/${path}`);
  } catch {
    return null;
  }
}
const SENSITIVE =
  /^(?:IFS|PATH|CDPATH|ENV|BASH_ENV|SHELLOPTS|BASHOPTS|GLOBIGNORE|POSIXLY_CORRECT|LANG|LC_.*|RIPGREP_CONFIG_PATH|GIT_CONFIG.*|PYTHONPATH|PYTHONHOME|PYTHONSTARTUP|PYTHONINSPECT|LD_.*|DYLD_.*)$/;
/** Exact startup controls; similarly named application data is not a control. */
export function nodeStartupBinding(name: string): boolean {
  return NODE_STARTUP_CONTROLS.includes(name);
}
export function sensitiveBinding(name: string): boolean {
  return SENSITIVE.test(name) || nodeStartupBinding(name);
}
/**
 * Bindings that change how this shell reads source or moves between directories.
 * Other sensitive settings change the program a command runs, which projection
 * does not model for any command.
 */
export function projectionSensitiveBinding(name: string): boolean {
  return /^(?:IFS|CDPATH|ENV|SHELLOPTS|GLOBIGNORE|POSIXLY_CORRECT|BASH.*)$/.test(name);
}
/** Whether a child process sees a variable, when every alternative agrees. */
export function exported(state: State, name: string): boolean | null {
  const known = state.exports?.get(name);
  return known === undefined ? process.env[name] !== undefined : known;
}
/** A path with a component Git reads as repository metadata. */
export function namesGitMetadata(path: string): boolean {
  return /(?:^|\/)\.git(?:\/|$)/i.test(path);
}
const TARGET_UTILITIES = ['tee', 'truncate', 'touch', 'rm', 'mv', 'cp', 'dd'];
const WRAPPERS = ['command', 'builtin', 'env', 'exec'];
/** The executable an argument vector runs, past its wrappers and their options. */
function invoked(argv: readonly Argument[]): { name: string | null; args: readonly Argument[] } {
  let index = 0;
  while (index < argv.length) {
    const value = argv[index]!.value;
    if (value === null) return { name: null, args: [] };
    if (index > 0 && (value.startsWith('-') || /^[A-Za-z_][A-Za-z_0-9]*=/.test(value))) {
      index++;
      continue;
    }
    const name = basename(value);
    if (!WRAPPERS.includes(name)) return { name, args: argv.slice(index + 1) };
    index++;
  }
  return { name: '', args: [] };
}
/** An option that makes sed or perl edit its operands; perl's -0 and -l take digits. */
function editsInPlace(name: string | null, args: readonly Argument[]): boolean {
  const option =
    name === 'sed'
      ? /^(?:-[A-Za-z]*[iI]|--in-place)/
      : name === 'perl'
        ? /^(?:-(?:[acdfnpsStTuUvwWX]|0[0-9xXa-fA-F]*|l[0-7]*)*i|--in-place)/
        : null;
  return option !== null && args.some((arg) => arg.value !== null && option.test(arg.value));
}
/** Whether a recognized utility writes through a path its directory decides. */
export function writesRelativeTarget(name: string, args: readonly Argument[]): boolean {
  const separator = args.findIndex((arg) => arg.value === '--');
  const relative = (arg: Argument, index: number): boolean =>
    arg.value === null ||
    (!isAbsolute(arg.value) &&
      (!arg.value.startsWith('-') || (separator >= 0 && index > separator)));
  if (name === 'dd')
    return args.some(
      ({ value }) =>
        value === null || (value.startsWith('of=') && !isAbsolute(value.slice('of='.length)))
    );
  return (TARGET_UTILITIES.includes(name) || editsInPlace(name, args)) && args.some(relative);
}
/** Arguments whose number of fields decides which files an invocation writes. */
export function exactOperands(argv: readonly Argument[]): readonly Argument[] {
  const { name, args } = invoked(argv);
  if (name !== null && TARGET_UTILITIES.includes(name)) return args;
  if (name !== 'sed' && name !== 'perl') return [];
  if (editsInPlace(name, args)) return args;
  // Up to its script, an unknown argument may be the in-place option.
  const script = args.findIndex((arg) => arg.value === null || !arg.value.startsWith('-'));
  return args.slice(0, script + 1);
}
/** Arguments that can carry an option whose effect is a write or a program. */
export function optionOperands(argv: readonly Argument[]): readonly Argument[] {
  const { name, args } = invoked(argv);
  if (name !== 'git' && !['sort', 'uniq', 'rg'].includes(name ?? '')) return [];
  // git add takes paths and no option of that kind.
  if (name === 'git' && args[0]?.value === 'add') return [];
  const separator = args.findIndex((arg) => arg.value === '--');
  return separator < 0 ? args : args.slice(0, separator);
}

/** Git's reciprocal linked-worktree files bind metadata to this exact pin. */
function pinnedMetadata(worktree: string, canonical: string): string | null {
  const readMetadata = (path: string): string | null => {
    const file = lstatSync(path);
    if (!file.isFile() || file.nlink !== 1 || file.size > 16384) return null;
    return readFileSync(path, 'utf8').trim();
  };
  try {
    const common = resolveDirectory(`${canonical}/.git`, '/');
    if (!common || !statSync(common).isDirectory()) return null;
    const pointer = readMetadata(`${worktree}/.git`);
    if (!pointer?.startsWith('gitdir: ')) return null;
    const metadata = resolveDirectory(pointer.slice(8), worktree);
    const registry = resolveDirectory(`${common}/worktrees`, '/');
    if (!metadata || !registry || dirname(metadata) !== registry) return null;
    const backlink = readMetadata(`${metadata}/gitdir`);
    if (!backlink) return null;
    const location = isAbsolute(backlink) ? backlink : `${metadata}/${backlink}`;
    if (basename(location) !== '.git' || resolveDirectory(dirname(location), '/') !== worktree)
      return null;
    const commonPointer = readMetadata(`${metadata}/commondir`);
    if (!commonPointer || resolveDirectory(commonPointer, metadata) !== common) return null;
    return metadata;
  } catch {
    return null;
  }
}

function gitPolicy(
  args: Argument[],
  state: State,
  env: Map<string, Value>,
  ctx: AnalysisContext,
  node: Location,
  reader: boolean
): void {
  ctx.gitInvocations.push(node);
  const ownMetadata = pinnedMetadata(ctx.worktree, ctx.canonical);
  if (!ownMetadata)
    ctx.reason(
      node,
      'git-mapping-unresolved',
      'The pin must have reciprocal linked-worktree metadata; cwd containment alone cannot prove Git ownership.'
    );
  if (args.some((arg) => arg.value === null)) {
    ctx.reason(node, 'git-unknown-argument', 'Git routing and options must be statically known.');
    return;
  }
  const words = args.map((arg) => arg.value!);
  let cwd: string | null = state.cwd;
  let subcommand = '';
  let commandOffset = words.length;
  const targets: { name: string; value: string }[] = [];
  let metadataRoutingKnown = true;
  for (const [name, values] of env) {
    // Git falls back to PAGER and interprets its value through a shell on a
    // terminal. Only source-tracked bindings reach this contextual check.
    if (name === 'PAGER') {
      if (values && values.length > 0 && values.every((value) => value === '' || value === 'cat')) {
        ctx.trace(node, 'git-environment', 'Known disabled source-selected Git pager.');
      } else {
        metadataRoutingKnown = false;
        ctx.reason(node, 'git-environment', 'Unmodeled source-selected Git pager PAGER.');
      }
      continue;
    }
    if (!name.startsWith('GIT_')) continue;
    if (name === 'GIT_PAGER' && values?.every((value) => value === '' || value === 'cat')) {
      ctx.trace(node, 'git-environment', 'Known disabled or data-only Git pager.');
      continue;
    }
    if (!['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR'].includes(name)) {
      metadataRoutingKnown = false;
      ctx.reason(node, 'git-environment', `Unmodeled Git environment override ${name}.`);
      continue;
    }
    if (!values) {
      metadataRoutingKnown = false;
      ctx.reason(node, 'git-environment', `Unknown Git environment override ${name}.`);
    } else for (const value of values) targets.push({ name, value });
  }
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    if (word === '-C' || (word.startsWith('-C') && word.length > 2)) {
      const target = word === '-C' ? words[++i] : word.slice(2);
      if (target === undefined) {
        ctx.reason(node, 'git-option', 'Missing Git -C directory.');
        return;
      }
      if (target !== '')
        cwd =
          cwd === null
            ? isAbsolute(target)
              ? resolveDirectory(target, '/')
              : null
            : resolveDirectory(target, cwd);
      continue;
    }
    if (
      word === '--git-dir' ||
      word === '--work-tree' ||
      word.startsWith('--git-dir=') ||
      word.startsWith('--work-tree=')
    ) {
      const equal = word.indexOf('=');
      const value = equal < 0 ? words[++i] : word.slice(equal + 1);
      if (value === undefined) {
        metadataRoutingKnown = false;
        ctx.reason(node, 'git-option', 'Missing Git metadata target.');
      } else
        targets.push({ name: word.startsWith('--git-dir') ? 'GIT_DIR' : 'GIT_WORK_TREE', value });
      continue;
    }
    if (GIT_LITERAL_GLOBAL_FLAGS.includes(word)) continue;
    if (word === '--paginate') {
      ctx.reason(
        node,
        'git-execution',
        'An explicit Git pager needs a separate execution profile.',
        true
      );
      return;
    }
    if (word.startsWith('-')) {
      ctx.reason(node, 'git-global-option', `Unmodeled Git global option ${word}.`);
      return;
    }
    subcommand = word;
    commandOffset = i + 1;
    break;
  }
  const commandArgs = words.slice(commandOffset);
  const executionOptions = GIT_EXECUTION_OPTIONS;
  const optionArgs = inspectGitOptions(subcommand, commandArgs, (code, message, deny) =>
    ctx.reason(node, code, message, deny)
  );

  if (
    optionArgs.some((value) => executionOptions[subcommand]?.test(value)) ||
    (['fetch', 'pull', 'push', 'clone', 'ls-remote'].includes(subcommand) &&
      commandArgs.some((value) => value.startsWith('ext::'))) ||
    (subcommand === 'bisect' && commandArgs[0] === 'run') ||
    (subcommand === 'submodule' && commandArgs[0] === 'foreach') ||
    ['filter-branch', 'difftool', 'mergetool'].includes(subcommand)
  ) {
    ctx.reason(
      node,
      'git-execution',
      'Git has an explicit execution-bearing argument outside the admitted routing profile.',
      true
    );
  }
  if (!cwd)
    ctx.reason(node, 'git-target-unresolved', 'Git effective directory cannot be resolved.');
  else {
    ctx.trace(node, 'git-target', cwd);
    if (inside(cwd, ctx.canonical) && !inside(cwd, ctx.worktree)) {
      ctx.reason(
        node,
        'foreign-git-target',
        `Git targets ${cwd}, outside the pinned worktree.`,
        true
      );
    }
  }
  // Configuration, repository creation and worktree management can replace the
  // mapping used by later commands. Their effects need a separate profile.
  if (
    ![
      'status',
      'diff',
      'log',
      'show',
      'rev-parse',
      'ls-files',
      'ls-tree',
      'diff-tree',
      'diff-index',
      'diff-files',
      'rev-list',
      'cat-file',
      'show-ref',
      'for-each-ref',
      'check-ignore',
      'check-attr',
      'grep',
      'add',
      'commit',
    ].includes(subcommand)
  )
    ctx.reason(
      node,
      'git-effects-unresolved',
      'This Git subcommand has no admitted effect profile.'
    );
  const metadata: {
    subcommand: 'add' | 'commit';
    overrides: Record<string, string>;
    known: boolean;
  } | null =
    ctx.gitMetadata && (subcommand === 'add' || subcommand === 'commit')
      ? {
          subcommand,
          overrides: {},
          known: metadataRoutingKnown && cwd !== null && !state.filesystemChanged,
        }
      : null;
  for (const target of targets) {
    if (metadata && target.name === 'GIT_INDEX_FILE') metadata.known = false;
    if (target.name === 'GIT_COMMON_DIR' && !isAbsolute(target.value)) {
      if (metadata) metadata.known = false;
      ctx.reason(
        node,
        'git-target-unresolved',
        'Relative common metadata paths need a proven Git-directory base.'
      );
      continue;
    }
    const resolved = resolveDirectory(target.value, cwd ?? state.cwd);
    if (!resolved) {
      if (metadata) metadata.known = false;
      ctx.reason(node, 'git-target-unresolved', `${target.name} cannot be resolved.`);
      continue;
    }
    if (metadata) metadata.overrides[target.name] = resolved;
    const own =
      inside(resolved, ctx.worktree) ||
      (target.name !== 'GIT_WORK_TREE' && ownMetadata !== null && inside(resolved, ownMetadata));
    if (!own && inside(resolved, ctx.canonical))
      ctx.reason(
        node,
        'foreign-git-target',
        `${target.name} targets foreign repository state.`,
        true
      );
  }
  if (metadata)
    ctx.gitMetadata?.({
      node,
      subcommand: metadata.subcommand,
      input: metadata.known && cwd ? { cwd, overrides: metadata.overrides } : null,
    });
  if (state.filesystemChanged)
    ctx.reason(
      node,
      'git-context-changed',
      'Earlier submitted effects invalidate the filesystem context used for Git admission.'
    );
  else if (cwd && ownMetadata && ctx.result.decision !== 'deny') {
    const overrides: Record<string, string> = {};
    for (const target of targets) {
      const resolved = resolveDirectory(target.value, cwd);
      if (resolved) overrides[target.name] = resolved;
    }
    const discovered = ctx.gitContext({ cwd, overrides });
    if (!discovered)
      ctx.reason(
        node,
        'git-discovery-unresolved',
        'Read-only Git discovery did not establish an effective repository context.'
      );
    else {
      const own = discovered.directory === ownMetadata;
      for (const target of [discovered.directory, discovered.common, discovered.worktree]) {
        if (
          target &&
          inside(target, ctx.canonical) &&
          !inside(target, ctx.worktree) &&
          !(own && (target === discovered.common || inside(target, ownMetadata)))
        )
          ctx.reason(
            node,
            'foreign-git-target',
            'Git discovery reaches foreign repository state.',
            true
          );
      }
      ctx.trace(node, 'git-discovery', `Verified metadata ${discovered.directory}.`);
    }
  }
  if (reader && !GIT_READ_COMMANDS.includes(subcommand)) {
    ctx.reason(node, 'substitution-effects', 'This Git command is not an admitted read producer.');
  }
}

const GIT_PROJECTED_FLAGS = [
  ...GIT_LITERAL_GLOBAL_FLAGS,
  '-P',
  '--glob-pathspecs',
  '--noglob-pathspecs',
  '--icase-pathspecs',
  '--no-lazy-fetch',
  '--no-advice',
];
const GIT_QUERIES = /^(?:-v|-h|--version|--help|--html-path|--man-path|--info-path|--exec-path)$/;
const GIT_DATA_ENVIRONMENT =
  /^GIT_(?:(?:AUTHOR|COMMITTER)_(?:NAME|EMAIL|DATE)|TERMINAL_PROMPT|OPTIONAL_LOCKS|(?:LITERAL|GLOB|NOGLOB|ICASE)_PATHSPECS|MERGE_AUTOEDIT|ADVICE|NO_LAZY_FETCH|FLUSH|CONFIG_NOSYSTEM|LFS_SKIP_(?:SMUDGE|PUSH))$/;
/** Programs a launcher configures for the whole session, not for one command. */
const GIT_LAUNCHER_ENVIRONMENT =
  /^(?:GIT_(?:ASKPASS|SSH|SSH_COMMAND|SSH_VARIANT|EDITOR|SEQUENCE_EDITOR|PAGER)|PAGER)$/;
const GIT_ROUTING = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR'];
const disabled = (values: Value, pattern: RegExp): boolean =>
  values !== null && values.length > 0 && values.every((value) => pattern.test(value));

/** Git environment that selects a repository, configuration or a program. */
function projectGitEnvironment(
  env: Map<string, Value>,
  ctx: AnalysisContext,
  node: Location
): { known: boolean; targets: { name: string; value: string }[] } {
  let known = true;
  const targets: { name: string; value: string }[] = [];
  for (const [name, values] of env) {
    if (!name.startsWith('GIT_') && name !== 'PAGER') continue;
    if (GIT_ROUTING.includes(name)) {
      if (values) for (const value of values) targets.push({ name, value });
      else {
        known = false;
        ctx.reason(node, 'git-environment', `Unknown Git environment override ${name}.`);
      }
      continue;
    }
    if (
      GIT_DATA_ENVIRONMENT.test(name) ||
      (GIT_LAUNCHER_ENVIRONMENT.test(name) &&
        values?.length === 1 &&
        values[0] === process.env[name]) ||
      (/^(?:GIT_)?PAGER$/.test(name) && disabled(values, /^(?:cat)?$/)) ||
      (/^GIT_(?:TRACE(?:_[A-Z0-9_]+)?|CURL_VERBOSE)$/.test(name) &&
        disabled(values, /^(?:[012]|true|false)?$/i)) ||
      (/^GIT_CONFIG_(?:GLOBAL|SYSTEM)$/.test(name) && disabled(values, /^\/dev\/null$/)) ||
      (/^GIT_(?:SEQUENCE_)?EDITOR$/.test(name) && disabled(values, /^(?:true|:|cat)$/)) ||
      (name === 'GIT_SSH_COMMAND' && disabled(values, SSH_CONNECTION))
    )
      continue;
    known = false;
    ctx.reason(node, 'git-environment', `Unmodeled Git environment override ${name}.`);
  }
  return { known, targets };
}

/**
 * Project one Git invocation. An inspection needs no ownership answer; anything
 * else names the repository metadata it writes so ownership can be decided.
 */
function projectGit(
  args: readonly Argument[],
  state: State,
  env: Map<string, Value>,
  ctx: AnalysisContext,
  node: Location
): State {
  ctx.gitInvocations.push(node);
  const { known, targets } = projectGitEnvironment(env, ctx, node);
  let routed = known;
  let moved = targets.length > 0;
  let cwd: string | null = state.cwdUnknown === true ? null : state.cwd;
  let index = 0;
  for (; index < args.length; index++) {
    const value = args[index]!.value;
    if (value === null) {
      ctx.reason(node, 'git-unknown-argument', 'The Git subcommand must be statically known.');
      return state;
    }
    if (!value.startsWith('-')) break;
    if (value.startsWith('-C')) {
      moved = true;
      const target = value === '-C' ? (args[++index]?.value ?? null) : value.slice(2);
      if (target === null) cwd = null;
      else if (target !== '') {
        if (isAbsolute(target)) cwd = resolveDirectory(target, '/');
        else cwd = cwd === null ? null : resolveDirectory(target, cwd);
      }
      continue;
    }
    const routing = /^--(git-dir|work-tree)(?:=([\s\S]*))?$/.exec(value);
    if (routing) {
      moved = true;
      const target = routing[2] ?? args[++index]?.value ?? null;
      if (target === null) routed = false;
      else
        targets.push({
          name: routing[1] === 'git-dir' ? 'GIT_DIR' : 'GIT_WORK_TREE',
          value: target,
        });
      continue;
    }
    if (value.startsWith('-c')) {
      const setting = value === '-c' ? (args[++index]?.value ?? null) : value.slice(2);
      if (setting !== null && isGitDataConfiguration(setting)) continue;
      ctx.reason(node, 'git-global-option', 'Git configuration can select a program to run.');
      return state;
    }
    if (GIT_PROJECTED_FLAGS.includes(value)) continue;
    if (GIT_QUERIES.test(value)) return state;
    ctx.reason(node, 'git-global-option', `Unmodeled Git global option ${value}.`);
    return state;
  }
  const subcommand = args[index]?.value;
  if (!subcommand) return state;
  const operands = args.slice(index + 1);
  const rest = operands.map((arg) => arg.value);
  const hazard = gitHazard(subcommand, rest);
  if (hazard === 'execution')
    ctx.reason(node, 'git-execution', 'This Git argument runs another program.', true);
  if (hazard === 'output')
    ctx.reason(node, 'git-option-unmodeled', 'This Git argument writes a file.');
  if (hazard === 'hooks')
    ctx.reason(node, 'git-hooks', "This Git argument skips the repository's own hooks.");
  const writes = gitWriteOperands(subcommand, rest, moved);
  for (const position of writes) {
    const operand = position < 0 ? { value: 'clone' } : operands[position]!;
    const target = operand.value?.replace(/^file:\/\//, '') ?? null;
    ctx.gitWrite?.({
      node,
      target: target === null || isAbsolute(target) || cwd === null ? target : `${cwd}/${target}`,
      ...(operand.source ? { source: operand.source } : {}),
      located: cwd !== null,
    });
  }
  // With a named Git directory, this makes or fills that one.
  const named = (subcommand === 'init' || subcommand === 'clone') && targets.length > 0;
  const inspection = !named && isGitInspection(subcommand, rest);
  const next: State =
    writes.length > 0 || !(inspection || gitLeavesWorkingTree(subcommand))
      ? { ...state, filesystemChanged: true }
      : state;
  if (!ctx.gitMetadata || inspection) return next;
  let located = routed && cwd !== null && state.mappingChanged !== true;
  const overrides: Record<string, string> = {};
  for (const target of targets) {
    const relativeCommon = target.name === 'GIT_COMMON_DIR' && !isAbsolute(target.value);
    const resolved = resolveDirectory(target.value, cwd ?? state.cwd);
    if (target.name === 'GIT_INDEX_FILE' || relativeCommon || !resolved) located = false;
    else overrides[target.name] = resolved;
  }
  ctx.gitMetadata({ node, subcommand, input: located && cwd ? { cwd, overrides } : null });
  return next;
}

/** sed is a reader unless it edits in place or its script writes or executes. */
function projectSed(args: readonly Argument[], ctx: AnalysisContext, node: Location): void {
  const script = (value: string | null): void => {
    const hazard = value === null ? null : sedScriptHazard(value);
    if (hazard === 'execution')
      ctx.reason(node, 'sed-execution', 'This sed script runs another program.', true);
    else if (hazard === 'output')
      ctx.reason(node, 'sed-script-unsupported', 'This sed script writes a file.');
    else if (hazard === 'syntax')
      ctx.reason(node, 'sed-script-unsupported', 'This sed script could not be read completely.');
  };
  let selected = false;
  for (let index = 0; index < args.length; index++) {
    const value = args[index]!.value;
    if (value === '--') {
      if (!selected && index + 1 < args.length) script(args[index + 1]!.value);
      return;
    }
    if (value === null || value === '-' || !value.startsWith('-')) {
      if (!selected) script(value);
      selected = true;
      continue;
    }
    const expression = /^(?:-[nErsuz]*e|--expression)$/.test(value)
      ? (args[++index]?.value ?? null)
      : /^-e[\s\S]/.test(value)
        ? value.slice(2)
        : value.startsWith('--expression=')
          ? value.slice('--expression='.length)
          : undefined;
    if (expression !== undefined) {
      script(expression);
      selected = true;
      continue;
    }
    if (/^(?:-i|--in-place(?:=|$))/.test(value)) {
      // BSD sed takes an explicit empty backup suffix as its own argument.
      if (value === '-i' && args[index + 1]?.value === '') index++;
      continue;
    }
    if (
      /^-[nErsuz]+$/.test(value) ||
      /^--(?:quiet|silent|regexp-extended|posix|separate|unbuffered|null-data|zero-terminated|debug|sandbox)$/.test(
        value
      )
    )
      continue;
    ctx.reason(
      node,
      'sed-option',
      'Sed script files, writes, and unmodeled options require a stronger proof.'
    );
  }
}

/** A program whose own effects are not modeled; the shell it leaves is unchanged. */
function opaque(
  name: string,
  args: readonly Argument[],
  state: State,
  ctx: AnalysisContext,
  node: Location
): State {
  const rewritesMapping = (arg: Argument): boolean => {
    if (arg.value === null) return TARGET_UTILITIES.includes(name) || name === 'ln';
    if (namesGitMetadata(arg.value)) return true;
    // Moving or removing the directory the shell is in replaces its repository.
    return (
      ['mv', 'rm', 'ln'].includes(name) &&
      !arg.value.startsWith('-') &&
      state.cwdUnknown !== true &&
      inside(state.cwd, resolve(state.cwd, arg.value))
    );
  };
  const next: State = { ...state, filesystemChanged: true };
  if (name === 'mkdir') next.made = [...(state.made ?? []), ...directoriesMade(args, state)];
  // A directory that can have become a link is no longer known to be one.
  else if (['ln', 'mv', 'rm', 'cp', 'tar', 'unzip'].includes(name)) delete next.made;
  if (!args.some(rewritesMapping)) return next;
  ctx.mapping?.(node);
  return { ...next, mappingChanged: true };
}
/** A path with every existing component resolved, whether or not all of it exists. */
function physicalPath(path: string): string {
  let missing = '';
  for (let existing = path; ; existing = dirname(existing)) {
    const resolved = resolveDirectory(existing, '/');
    if (resolved !== null || existing === '/') return `${resolved ?? ''}${missing}` || '/';
    missing = `/${basename(existing)}${missing}`;
  }
}
/** Directories mkdir makes, with the parents -p makes on the way. */
function directoriesMade(args: readonly Argument[], state: State): string[] {
  const made: string[] = [];
  for (const { value } of args) {
    if (value === null || value === '' || value.startsWith('-')) continue;
    if (!isAbsolute(value) && state.cwdUnknown === true) continue;
    if (value.split('/').includes('..')) continue;
    for (
      let path = physicalPath(resolve(state.cwd, value));
      resolveDirectory(path, '/') === null && path !== '/';
      path = dirname(path)
    )
      made.push(path);
  }
  return made;
}
function forgetBindings(state: State): State {
  const bindings = new Map(state.bindings);
  for (const name of bindings.keys()) bindings.set(name, null);
  return { ...state, bindings };
}
/** Run an in-shell script: whatever it sets is unknown afterwards. */
function sourced(state: State): State {
  const next: State = { ...forgetBindings(state), cwdUnknown: true, filesystemChanged: true };
  delete next.logical;
  return next;
}
/** A virtual environment generates this script to change which programs are found. */
const ENVIRONMENT_SCRIPT = /(?:^|\/)bin\/activate$/;
function unknownDirectory(state: State): State {
  const next: State = { ...state, bindings: new Map(state.bindings), cwdUnknown: true };
  delete next.logical;
  for (const name of ['PWD', 'OLDPWD']) next.bindings.set(name, null);
  return next;
}
const INERT_BUILTINS = [
  'bg',
  'break',
  'caller',
  'continue',
  'dirs',
  'disown',
  'exit',
  'fg',
  'help',
  'jobs',
  'kill',
  'logout',
  'return',
  'shift',
  'suspend',
  'times',
  'type',
  'ulimit',
  'umask',
  'wait',
];
const SHELL_FLAGS = /^[-+][abefhmuvxBCEHT]+$/;
const SHELL_OPTION_NAMES =
  /^(?:allexport|braceexpand|emacs|errexit|errtrace|functrace|hashall|histexpand|history|ignoreeof|monitor|noclobber|noglob|notify|nounset|onecmd|pipefail|verbose|vi|xtrace)$/;
const identifier = /^[A-Za-z_][A-Za-z_0-9]*$/;
/** An array reference whose subscript Bash expands again when it reads the name. */
const SUBSCRIPT_SOURCE = /^[A-Za-z_][A-Za-z_0-9]*\[[^\]]*[$`]/;
export function holdsSubscriptSource(arg: Argument): boolean {
  return arg.value !== null && SUBSCRIPT_SOURCE.test(arg.value);
}

/** Operands of a flag-style option list, or null when a flag is not modeled. */
/** Whether these `set` options make every later assignment an export. */
function exportOption(
  values: readonly (string | null)[],
  state: State
): Pick<State, 'exports'> | null {
  let every: boolean | undefined;
  for (let index = 0; index < values.length; index++) {
    const value = values[index] ?? '';
    if (!/^[-+][A-Za-z]/.test(value)) break;
    if (value.includes('a') || (value.endsWith('o') && values[++index] === 'allexport'))
      every = value.startsWith('-');
  }
  return every === undefined ? null : { exports: new Map(state.exports).set('*', every) };
}
function shellOptions(args: readonly Argument[]): readonly Argument[] | null {
  let index = 0;
  for (; index < args.length; index++) {
    const value = args[index]!.value;
    if (value === null || !/^[-+]/.test(value) || value === '-') return args.slice(index);
    if (value === '--') return args.slice(index + 1);
    const named = /^[-+][a-zA-Z]*o$/.test(value);
    if (!SHELL_FLAGS.test(named ? value.replace(/o$/, 'e') : value)) return null;
    if (named) {
      const option = args[index + 1]?.value;
      if (option !== undefined && !SHELL_OPTION_NAMES.test(option ?? '')) return null;
      index++;
    }
  }
  return [];
}

/**
 * The shell state after a builtin whose effect on later source is known. Null
 * means the builtin can run or define code this projection cannot read.
 */
export function projectBuiltin(
  name: string,
  args: readonly Argument[],
  state: State
): State | null {
  if (INERT_BUILTINS.includes(name)) return state;
  const values = args.map((arg) => arg.value);
  const unbind = (names: readonly (string | null)[]): State | null => {
    if (!names.every((value) => value !== null && identifier.test(value))) return null;
    if (names.some((value) => projectionSensitiveBinding(value!))) return null;
    const bindings = new Map(state.bindings);
    for (const value of names) bindings.set(value!, null);
    return { ...state, bindings };
  };
  switch (name) {
    case 'set':
      return shellOptions(args) ? { ...state, ...exportOption(values, state) } : null;
    case 'shopt':
      return values.every(
        (value) =>
          value !== null &&
          /^(?:-[sqpu]+|nullglob|failglob|dotglob|globstar|nocaseglob|nocasematch|inherit_errexit)$/.test(
            value
          )
      )
        ? state
        : null;
    case 'trap':
      // Only resetting or ignoring a signal installs no code.
      return values.length === 0 || ['-', '', '-p', '-l'].includes(values[0] ?? 'code')
        ? state
        : null;
    case 'hash':
      return values.every((value) => value === '-r') ? state : null;
    case 'export':
      return values.every((value) => value === '-p' || (value !== null && identifier.test(value)))
        ? state
        : null;
    case 'declare':
    case 'typeset':
    case 'local':
    case 'readonly':
      return unbind(values.filter((value) => value === null || !/^-[xraAp]+$/.test(value)));
    case 'unset': {
      const names = values.filter((value) => value !== '-v');
      const next = unbind(names);
      // Git reads these from the environment, where the name is now absent.
      for (const value of next ? names : [])
        if (/^(?:GIT_|PAGER$)/.test(value!)) next!.bindings.delete(value!);
      return next;
    }
    case 'mapfile':
    case 'readarray': {
      // A callback option would run code for each line.
      const names = values.filter((value) => value !== '-t');
      return unbind(names.length > 0 ? names : ['MAPFILE']);
    }
    case '.':
    case 'source': {
      const path = values[0];
      // A descriptor holds source this command supplies, which is not read here.
      if (typeof path !== 'string' || /^(?:-|\/dev\/|\/proc\/)/.test(path)) return null;
      return ENVIRONMENT_SCRIPT.test(path)
        ? unbind(['PATH', 'VIRTUAL_ENV', 'PS1'])
        : sourced(state);
    }
    case 'pushd':
    case 'popd':
      return unknownDirectory(state);
    default:
      return null;
  }
}
/** A name whose builtin meaning later source depends on, so no function may take it. */
export function changesShellState(name: string): boolean {
  return (
    WRAPPERS.includes(name) ||
    ['break', 'cd', 'continue', 'exit', 'printf', 'read', 'return'].includes(name) ||
    (isShellBuiltin(name) && !INERT_BUILTINS.includes(name))
  );
}
/** Builtins that change this shell rather than run a program in another. */
export function isShellBuiltin(name: string): boolean {
  return (
    INERT_BUILTINS.includes(name) ||
    /^(?:\.|alias|bind|builtin|compgen|complete|compopt|declare|enable|eval|export|fc|getopts|hash|history|let|local|mapfile|popd|pushd|readarray|readonly|set|shopt|source|trap|typeset|unalias|unset)$/.test(
      name
    )
  );
}

function projectDirectory(
  args: readonly Argument[],
  state: State,
  env: ReadonlyMap<string, Value>
): State {
  const unknown = (): State => unknownDirectory(state);
  let physical = false;
  let index = 0;
  for (; index < args.length; index++) {
    const value = args[index]!.value;
    if (value === '-P') physical = true;
    else if (value === '-L') physical = false;
    else if (value !== '--' && value !== '-e') break;
  }
  // A bare cd goes to the HOME its own prefix assigns.
  const home = env.has('HOME') ? env.get('HOME') : state.bindings.get('HOME');
  const target =
    index === args.length
      ? home?.length === 1
        ? home[0]!
        : null
      : index === args.length - 1
        ? args[index]!.value
        : null;
  if (!target || target.startsWith('-')) return unknown();
  if (!isAbsolute(target) && state.cwdUnknown === true) return unknown();
  // `cd ..` removes a component of the logical path, which a symlinked
  // directory does not share with its physical one.
  const base = physical || isAbsolute(target) ? state.cwd : (state.logical ?? null);
  if (base === null && target.split('/').includes('..')) return unknown();
  const nominal = physical ? target : resolve(base ?? state.cwd, target);
  const promised = physicalPath(resolve(state.cwd, nominal));
  const resolved =
    resolveDirectory(nominal, state.cwd) ??
    (state.made?.includes(promised) === true ? promised : null);
  if (!resolved) return unknown();
  const next: State = {
    ...state,
    bindings: new Map(state.bindings),
    cwd: resolved,
    logical: physical ? resolved : nominal,
  };
  if (base === null) delete next.logical;
  delete next.cwdUnknown;
  // PWD holds the logical name, which is what a later "$PWD/.." starts from.
  next.bindings.set('PWD', next.logical === undefined ? null : [next.logical]);
  next.bindings.set('OLDPWD', null);
  return next;
}

/** Projection: name the writes and shell-state changes of one invocation. */
function projectInvocation(
  argv: readonly Argument[],
  state: State,
  env: Map<string, Value>,
  ctx: AnalysisContext,
  node: Location
): State {
  const executable = argv[0]?.value;
  if (!executable) {
    ctx.reason(node, 'executable-unknown', 'Executable identity must be known.');
    return state;
  }
  const name = basename(executable);
  const args = argv.slice(1);
  if (WRAPPERS.includes(name) && name !== 'builtin') {
    let offset = 0;
    const childEnv = new Map(env);
    // `command -v` and a bare `env` report and run nothing.
    if (name === 'command' && /^-[vV]$/.test(args[0]?.value ?? '')) return state;
    if (name === 'env' && args.length === 0) return state;
    if (args[offset]?.value === '--') offset++;
    if (name === 'env')
      for (; /^[A-Za-z_][A-Za-z_0-9]*=/.test(args[offset]?.value ?? ''); offset++) {
        const value = args[offset]!.value!;
        const equal = value.indexOf('=');
        childEnv.set(value.slice(0, equal), [value.slice(equal + 1)]);
      }
    if (
      args[offset]?.value?.startsWith('-') ||
      (name === 'env' && args[offset]?.value?.includes('='))
    ) {
      ctx.reason(node, 'wrapper-option', 'Unmodeled command/env wrapper option or assignment.');
      return state;
    }
    if (offset >= args.length && name === 'exec') return state;
    const next = projectInvocation(args.slice(offset), state, childEnv, ctx, node);
    if (name === 'command') return next;
    // env and exec run a program, so a builtin's name changes nothing here.
    const { filesystemChanged, mappingChanged } = next;
    return {
      ...state,
      ...(filesystemChanged === undefined ? {} : { filesystemChanged }),
      ...(mappingChanged === undefined ? {} : { mappingChanged }),
    };
  }
  if (executable !== name && changesShellState(name)) return opaque(name, args, state, ctx, node);
  switch (name) {
    case 'git':
      return projectGit(args, state, env, ctx, node);
    case 'cd':
      return projectDirectory(args, state, env);
    case 'sed':
      projectSed(args, ctx, node);
      return state;
    case 'caws':
      if (
        args[0]?.value !== 'worktree' ||
        !['merge', 'destroy', 'create', 'ensure'].includes(args[1]?.value ?? 'merge')
      )
        break;
      ctx.mapping?.(node);
      return { ...state, filesystemChanged: true, mappingChanged: true };
    case 'printf': {
      const format = args[0]?.value;
      if (format === '-v') {
        const target = args[1]?.value;
        if (typeof target === 'string' && identifier.test(target)) {
          const bindings = new Map(state.bindings);
          bindings.set(target, null);
          if (!projectionSensitiveBinding(target)) return { ...state, bindings };
        }
      }
      // %n assigns to the variable its argument names; %% is a literal percent.
      if (
        typeof format === 'string' &&
        (format.startsWith('-v') || /%[-+ #'0-9.*]*[hjlLtz]*n/.test(format.replace(/%%/g, '')))
      )
        ctx.reason(
          node,
          'printf-format',
          'printf requires a known data-only format without variable writes.'
        );
      // An unknown first word can be the option that assigns a variable.
      return format === null ? forgetBindings(state) : state;
    }
    case 'read': {
      // An unknown argument can name any variable.
      const known = args.every((arg) => arg.value !== null);
      const bindings = new Map((known ? state : forgetBindings(state)).bindings);
      for (const arg of args) {
        if (holdsSubscriptSource(arg))
          ctx.reason(node, 'read-options', 'read evaluates source held in a subscript.');
        if (arg.value === null || !identifier.test(arg.value)) continue;
        if (projectionSensitiveBinding(arg.value))
          ctx.reason(node, 'read-options', 'read changes how later source is split.');
        bindings.set(arg.value, null);
      }
      bindings.set('REPLY', null);
      return { ...state, bindings };
    }
    case 'test':
    case '[':
      if (args.some((arg, index) => args[index - 1]?.value === '-v' && holdsSubscriptSource(arg)))
        ctx.reason(node, 'test-source', 'A test evaluates source held in a subscript.');
      return state;
    case 'echo':
    case 'pwd':
    case 'true':
    case 'false':
    case ':':
      return state;
  }
  if (isShellBuiltin(name)) return projectBuiltin(name, args, state) ?? state;
  if (Object.prototype.hasOwnProperty.call(READER_SHORT, name)) {
    const hazard = readerHazard(
      name,
      args.map((arg) => arg.value)
    );
    if (!hazard) return state;
    if (hazard === 'execution')
      ctx.reason(node, 'reader-execution', 'This reader option invokes another program.', true);
    else if (name === 'uniq')
      ctx.reason(
        node,
        'reader-output',
        'uniq has a positional output file outside the read-only profile.'
      );
    else ctx.reason(node, 'reader-option', `This ${name} option writes a file.`);
    return { ...state, filesystemChanged: true };
  }
  ctx.admission(node, 'utility-unsupported', `No admitted argument-role profile for ${name}.`);
  return opaque(name, args, state, ctx, node);
}

function sedPolicy(args: Argument[], ctx: AnalysisContext, node: Location): void {
  inspectSedArguments(
    args.map((arg) => arg.value),
    (code, message, deny) => ctx.reason(node, code, message, deny),
    (kind, detail) => ctx.trace(node, kind, detail)
  );
}

/** Utility roles, rather than a command-wide rule that all variables are risky. */
export function inspectInvocation(
  argv: Argument[],
  state: State,
  env: Map<string, Value>,
  ctx: AnalysisContext,
  node: Location,
  reader: boolean,
  wrappers = 0
): State {
  if (ctx.projection) return projectInvocation(argv, state, env, ctx, node);
  if (wrappers > 8) {
    ctx.reason(node, 'wrapper-budget', 'Wrapper nesting exceeds the analysis budget.');
    return state;
  }
  const executable = argv[0]?.value;
  if (!executable) {
    ctx.reason(node, 'executable-unknown', 'Executable identity must be known.');
    return state;
  }
  // Only conventional absolute system locations have the same lexical profile
  // as bare tool names. Arbitrary scripts/binaries are a separate trust boundary.
  const name = executable.replace(/^\/(?:usr\/)?bin\//, '');
  if (name.includes('/')) {
    ctx.reason(
      node,
      'executable-path',
      'Arbitrary executable paths are outside the admitted profiles.'
    );
    return state;
  }
  const args = argv.slice(1);
  if (name === 'command' || name === 'env') {
    let offset = 0;
    const childEnv = new Map(env);
    if (args[offset]?.value === '--') offset++;
    if (name === 'env') {
      while (args[offset]?.value?.match(/^[A-Za-z_][A-Za-z_0-9]*=/)) {
        const value = args[offset++]!.value!;
        const equal = value.indexOf('=');
        const key = value.slice(0, equal);
        if (sensitiveBinding(key))
          ctx.reason(node, 'environment-change', `Unmodeled environment change ${key}.`);
        childEnv.set(key, [value.slice(equal + 1)]);
      }
    }
    // env also accepts names outside Bash's identifier grammar. Do not mistake
    // an unsupported assignment for the child executable and hide that child.
    if (
      args[offset]?.value?.startsWith('-') ||
      (name === 'env' && args[offset]?.value?.includes('='))
    ) {
      ctx.reason(node, 'wrapper-option', 'Unmodeled command/env wrapper option or assignment.');
      return state;
    }
    return inspectInvocation(args.slice(offset), state, childEnv, ctx, node, reader, wrappers + 1);
  }
  const lifecycle =
    name === 'caws' &&
    args[0]?.value === 'worktree' &&
    ['merge', 'destroy', 'create', 'ensure'].includes(args[1]?.value ?? '') &&
    args.every((arg) => arg.value !== null);
  if (ctx.outside && !lifecycle)
    ctx.reason(
      node,
      'outside-cwd',
      'Only independently analyzed worktree lifecycle invocations are admitted from an outside initial cwd.',
      true
    );
  if (lifecycle) {
    if (reader)
      ctx.reason(
        node,
        'substitution-effects',
        'Worktree lifecycle commands are not read producers.'
      );
    else ctx.trace(node, 'lifecycle', 'Independently admitted worktree lifecycle invocation.');
    return { ...state, filesystemChanged: true };
  }
  if (name === 'git') {
    gitPolicy(args, state, env, ctx, node, reader);
    return state;
  }
  if (name === 'cd') {
    if (reader)
      ctx.reason(
        node,
        'substitution-effects',
        'Directory changes are not admitted read producers.'
      );
    const physical = args[0]?.value === '-P';
    const target = args.length === (physical ? 2 : 1) ? args[physical ? 1 : 0]?.value : undefined;
    if (!physical && target?.split('/').includes('..')) {
      ctx.reason(
        node,
        'cd-logical-parent',
        'Logical cd parent traversal requires a separate logical-PWD proof.'
      );
      return state;
    }
    const resolved = target && !target.startsWith('-') ? resolveDirectory(target, state.cwd) : null;
    if (!resolved) {
      ctx.reason(node, 'cwd-unresolved', 'cd requires one known, existing directory.');
      return state;
    }
    ctx.trace(node, 'cwd', resolved);
    const bindings = new Map(state.bindings);
    bindings.set('PWD', null);
    bindings.set('OLDPWD', null);
    return { ...state, bindings, cwd: resolved };
  }
  if (name === 'sed') {
    sedPolicy(args, ctx, node);
    return state;
  }
  if (name === 'printf') {
    const format = args[0]?.value;
    if (
      format === null ||
      format === undefined ||
      format.startsWith('-') ||
      format.replace(/%%|%[-+ #0]*[0-9.*]*[diouxXfFeEgGaAcsbq]/g, '').includes('%')
    ) {
      ctx.reason(
        node,
        'printf-format',
        'printf requires a known data-only format without variable writes.'
      );
    }
    return state;
  }
  if (name === 'test' || name === '[') {
    const values = args.map((arg) => arg.value);
    if (name === '[' && values.pop() !== ']') {
      ctx.reason(
        node,
        'test-expression',
        'The bracket conditional needs a literal closing bracket.'
      );
      return state;
    }
    const unary = /^-(?:b|c|d|e|f|g|h|k|p|r|s|u|w|x|L|O|G|N|S|n|z)$/;
    const binary = /^(?:=|==|!=|<|>|-nt|-ot|-ef)$/;
    const integer = /^(?:-eq|-ne|-lt|-le|-gt|-ge)$/;
    const safe =
      values.length < 2 ||
      (values.length === 2 && unary.test(values[0] ?? '')) ||
      (values.length === 3 &&
        (binary.test(values[1] ?? '') ||
          (integer.test(values[1] ?? '') &&
            values.every(
              (value, index) => index === 1 || (value !== null && /^[+-]?[0-9]+$/.test(value))
            ))));
    if (!safe)
      ctx.reason(
        node,
        'test-expression',
        'Only data-only string/file predicates and literal integer comparisons are modeled; variable references and compound predicates are unresolved.'
      );
    return state;
  }
  if (['echo', 'pwd', 'true', 'false', ':'].includes(name)) return state;
  if (name === 'read') {
    const bindings = new Map(state.bindings);
    for (const arg of args) {
      if (arg.value && /^[A-Za-z_][A-Za-z_0-9]*$/.test(arg.value) && !sensitiveBinding(arg.value))
        bindings.set(arg.value, null);
      else ctx.reason(node, 'read-options', 'Only bare read destination names are modeled.');
    }
    if (!args.length) bindings.set('REPLY', null);
    return { ...state, bindings };
  }
  if (Object.prototype.hasOwnProperty.call(READER_SHORT, name)) {
    const writes = inspectReaderArguments(
      name,
      args.map((arg) => arg.value),
      (code, message, deny) => ctx.reason(node, code, message, deny)
    );
    return writes ? { ...state, filesystemChanged: true } : state;
  }
  ctx.reason(node, 'utility-unsupported', `No admitted argument-role profile for ${name}.`);
  // A consumer may recognize this application's write operands separately.
  // Its unmodeled effects must still invalidate later filesystem observations.
  return { ...state, filesystemChanged: true };
}
