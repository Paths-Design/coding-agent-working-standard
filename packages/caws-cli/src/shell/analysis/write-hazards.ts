/**
 * Argument forms that make an ordinary command write a file or run a program.
 *
 * The write projection names the targets of the utilities it recognizes. These
 * forms carry an effect that extraction does not see, so the projection holds
 * them. Everything else an ordinary command accepts is data to it: an option
 * missing from this file is not a reason to refuse the command.
 */
export type Hazard = 'execution' | 'output';
type Arguments = readonly (string | null)[];

/** A long option matches a hazard by exact name or unambiguous abbreviation. */
function abbreviates(value: string, names: readonly string[], exact: readonly string[]): boolean {
  if (!value.startsWith('--')) return false;
  const name = value.slice(2).split('=', 1)[0]!;
  return name !== '' && !exact.includes(name) && names.some((hazard) => hazard.startsWith(name));
}

// ── Git ─────────────────────────────────────────────────────────────────────

const GIT_OUTPUT_OPTIONS = ['output', 'output-directory', 'export-marks', 'export-pack-edges'];
const GIT_EXECUTION_OPTION_NAMES = [
  'ext-diff',
  'textconv',
  'open-files-in-pager',
  'upload-pack',
  'receive-pack',
  'exec',
  'extcmd',
];
/** Complete option names that also abbreviate a hazard. */
const GIT_EXACT_OPTIONS = ['text'];
const GIT_OUTPUT_SHORT = ['archive', 'format-patch', 'bugreport', 'diagnose', 'index-pack'];
const GIT_PROGRAM_SUBCOMMANDS = ['filter-branch', 'difftool', 'mergetool', 'send-email'];
/** Short options whose attached text is data, ending a cluster. */
const GIT_GREP_OPERANDS = 'efABCm';
const GIT_COMMIT_OPERANDS = 'mFCctuS';
/** Subcommands whose --no-verify skips the repository's own hooks. */
const GIT_HOOK_SUBCOMMANDS = [
  'commit',
  'merge',
  'push',
  'rebase',
  'am',
  'cherry-pick',
  'revert',
  'pull',
];
/** Whether a short-option cluster sets a flag before any option that takes text. */
function clusterSets(value: string, flag: string, operands: string): boolean {
  if (!/^-[^-]/.test(value)) return false;
  for (const letter of value.slice(1)) {
    if (letter === flag) return true;
    if (operands.includes(letter)) return false;
  }
  return false;
}
/** Options that take the next argument as data, whatever it looks like. */
const GIT_DATA_OPERANDS: Readonly<Record<string, readonly string[]>> = {
  commit: ['-m', '--message', '-F', '--file', '-C', '-c', '--author', '--date', '--trailer'],
  tag: ['-m', '--message', '-F', '--file'],
  log: ['-n', '-S', '-G', '-L', '--grep', '--author', '--committer', '--since', '--until'],
  grep: ['-e', '-f'],
  notes: ['-m', '-F'],
  stash: ['-m', '--message'],
  merge: ['-m', '-F'],
};

/** Configuration that only changes what Git prints or how it names things. */
const GIT_DATA_CONFIGURATION =
  /^(?:(?:advice|blame|color|column|feature|fetch|grep|log|maintenance|rebase|status|tag|versionsort)\.[a-z.]+|user\.(?:name|email)|branch\.sort|core\.(?:quotepath|abbrev|autocrlf|safecrlf|ignorecase|filemode|longpaths|commentchar|untrackedcache|preloadindex)|diff\.(?:algorithm|renames|renamelimit|noprefix|mnemonicprefix|colormoved|colormovedws|wserrorhighlight|context|interhunkcontext|ignoresubmodules|indentheuristic|submodule|statgraphwidth)|commit\.gpgsign|gc\.auto|init\.defaultbranch|(?:push|pull)\.[a-z]+|merge\.(?:conflictstyle|renames|ff|stat)|submodule\.(?:recurse|fetchjobs)|protocol\.version|safe\.directory|http\.(?:lowspeedlimit|lowspeedtime|postbuffer|version))$/i;
const GIT_DISABLED_CONFIGURATION =
  /^(?:core\.(?:pager|editor)=(?:cat|true|:|)|pager\.[a-z-]+=(?:cat|false|0|)|core\.fsmonitor=(?:false|0|)|credential\.helper=)$/i;
/** A command-line configuration value that cannot select a program. */
export function isGitDataConfiguration(assignment: string): boolean {
  const key = assignment.split('=', 1)[0]!;
  return GIT_DATA_CONFIGURATION.test(key) || GIT_DISABLED_CONFIGURATION.test(assignment);
}

/** The effect of one Git invocation's options and operands, when it has one. */
export function gitHazard(subcommand: string, args: Arguments): Hazard | 'hooks' | null {
  if (
    GIT_PROGRAM_SUBCOMMANDS.includes(subcommand) ||
    (subcommand === 'bisect' && action(args) === 'run') ||
    (subcommand === 'submodule' && action(args) === 'foreach')
  )
    return 'execution';
  if (subcommand === 'bundle' && action(args) === 'create') return 'output';
  // A configuration file outside this repository is a file of its own.
  if (
    subcommand === 'config' &&
    some(args, /^(?:--global|--system|--file(?:=|$)|-f)/) &&
    !readsConfiguration(args)
  )
    return 'output';
  for (let index = 0; index < args.length; index++) {
    const value = args[index]!;
    if (value === '--') break;
    if (value === null) continue;
    if (GIT_DATA_OPERANDS[subcommand]?.includes(value)) {
      index++;
      continue;
    }
    // A remote helper URL names a program to run.
    if (value.startsWith('ext::')) return 'execution';
    if (!value.startsWith('-')) continue;
    if (abbreviates(value, GIT_OUTPUT_OPTIONS, GIT_EXACT_OPTIONS)) return 'output';
    if (abbreviates(value, GIT_EXECUTION_OPTION_NAMES, GIT_EXACT_OPTIONS)) return 'execution';
    if (GIT_OUTPUT_SHORT.includes(subcommand) && /^-[^-]*o/.test(value)) return 'output';
    if (subcommand === 'cat-file' && value === '--filters') return 'execution';
    if (subcommand === 'rebase' && /^-[A-Za-z]*x/.test(value)) return 'execution';
    if (
      (subcommand === 'checkout-index' || subcommand === 'read-tree') &&
      abbreviates(value, ['prefix'], [])
    )
      return 'output';
    if (subcommand === 'clone' && (/^-[cu]/.test(value) || abbreviates(value, ['config'], [])))
      return 'execution';
    if (
      (subcommand === 'clone' || subcommand === 'init') &&
      abbreviates(value, ['template', 'separate-git-dir'], [])
    )
      return 'execution';
    if (subcommand === 'grep' && clusterSets(value, 'O', GIT_GREP_OPERANDS)) return 'execution';
    if (GIT_HOOK_SUBCOMMANDS.includes(subcommand) && abbreviates(value, ['no-verify'], []))
      return 'hooks';
    if (
      (subcommand === 'commit' || subcommand === 'am') &&
      clusterSets(value, 'n', GIT_COMMIT_OPERANDS)
    )
      return 'hooks';
  }
  return null;
}

/** Options that take the next argument, where an operand can follow them. */
const GIT_OPERAND_OPTIONS: Readonly<Record<string, readonly string[]>> = {
  clone: [
    ...['-b', '--branch', '--depth', '-o', '--origin', '-j', '--jobs', '--filter'],
    ...['--reference', '--reference-if-able', '--shallow-since', '--shallow-exclude'],
    ...['--server-option', '--bundle-uri'],
  ],
  init: ['-b', '--initial-branch', '--object-format', '--ref-format'],
  worktree: ['-b', '-B', '--reason'],
  push: ['-o', '--push-option', '--repo'],
  'merge-file': ['-L', '--marker-size'],
  restore: ['-s', '--source', '--conflict'],
  config: ['-f', '--file', '--blob', '--default', '--type'],
  clean: ['-e', '--exclude'],
};
/** Positions of the operands, past options and the arguments they take. */
function operandPositions(subcommand: string, args: Arguments): number[] {
  const taking = GIT_OPERAND_OPTIONS[subcommand] ?? [];
  const found: number[] = [];
  let options = true;
  for (let index = 0; index < args.length; index++) {
    const value = args[index]!;
    if (options && value === '--') options = false;
    else if (!options || value === null || !value.startsWith('-') || value === '-')
      found.push(index);
    else if (taking.includes(value)) index++;
  }
  return found;
}
const LOCAL_REPOSITORY = /^(?:file:\/\/|\/|~|\.{1,2}(?:\/|$))/;
/**
 * Arguments that name a path the invocation writes outside the repository's own
 * metadata; -1 is the directory it runs in. `routed` says the working tree is
 * not the one the shell is in, where operand extraction cannot resolve them.
 */
export function gitWriteOperands(subcommand: string, args: Arguments, routed: boolean): number[] {
  const found = operandPositions(subcommand, args);
  const [first, second] = found;
  const separator = args.indexOf('--');
  switch (subcommand) {
    case 'rm':
      return args.includes('--cached') ? [] : found;
    case 'mv':
      return found;
    case 'clone':
      return [second ?? -1];
    case 'init':
      return [first ?? -1];
    case 'merge-file':
      return first === undefined || some(args, /^(?:-p|--stdout)$/) ? [] : [first];
    case 'worktree':
      return first === undefined || !['add', 'remove', 'move', 'repair'].includes(args[first] ?? '')
        ? []
        : args[first] === 'add'
          ? found.slice(1, 2)
          : found.slice(1);
    case 'push':
      return first !== undefined && LOCAL_REPOSITORY.test(args[first] ?? '') ? [first] : [];
    case 'restore':
      return routed && (!some(args, /^(?:-S|--staged)$/) || some(args, /^(?:-W|--worktree)$/))
        ? found
        : [];
    case 'clean':
      return routed ? found : [];
    case 'checkout':
    case 'reset':
      return routed && separator >= 0 ? found.filter((index) => index > separator) : [];
    default:
      return [];
  }
}
/** Subcommands that write refs, configuration or the index and no working tree. */
const GIT_METADATA_ONLY = new Set(
  (
    'add branch commit config fetch gc maintenance notes pack-refs prune push reflog remote ' +
    'repack replace rerere symbolic-ref tag update-index update-ref'
  ).split(' ')
);
export function gitLeavesWorkingTree(subcommand: string): boolean {
  return GIT_METADATA_ONLY.has(subcommand);
}

const GIT_INSPECTION = new Set(
  (
    'annotate archive blame cat-file check-attr check-ignore check-mailmap check-ref-format ' +
    'cherry column commit-tree count-objects describe diff diff-files diff-index diff-pairs ' +
    'diff-tree fast-export for-each-ref fsck get-tar-commit-id grep hash-object help log ' +
    'ls-files ls-remote ls-tree merge-base merge-tree mktag mktree name-rev patch-id ' +
    'range-diff rev-list rev-parse shortlog show show-branch show-index show-ref status ' +
    'stripspace var verify-commit verify-pack verify-tag version whatchanged write-tree'
  ).split(' ')
);
/** The selected action, whatever options precede it; an unknown one is no action. */
const action = (args: Arguments): string => {
  const first = args.find((value) => value === null || !value.startsWith('-'));
  return first === undefined ? '' : (first ?? 'unknown');
};
const some = (args: Arguments, pattern: RegExp): boolean =>
  args.some((value) => value !== null && pattern.test(value));
/** Every argument is known, and every option is one that only inspects. */
const only = (args: Arguments, options: RegExp): boolean =>
  args.every((value) => value !== null && (!value.startsWith('-') || options.test(value)));
/** An action this form reads must come first, where no option can take it as text. */
const begins = (args: Arguments, ...actions: string[]): boolean =>
  args.length > 0 ? actions.includes(args[0] ?? 'unknown') : actions.includes('');
const REFERENCE_LISTING =
  '(?:no-)?(?:color|column|abbrev)(?:=.*)?|(?:no-)?(?:contains|merged)(?:=.*)?|points-at(?:=.*)?|sort=.*|format=.*|ignore-case|omit-empty';
const BRANCH_OPTIONS = new RegExp(
  `^(?:-[arvli]+|--(?:all|remotes|verbose|list|show-current|${REFERENCE_LISTING}))$`
);
const TAG_OPTIONS = new RegExp(`^(?:-[lvi]|-n\\d*|--(?:list|verify|${REFERENCE_LISTING}))$`);
const CONFIG_OPTIONS =
  /^(?:-[lz]|-f.*|--(?:get|get-all|get-regexp|get-urlmatch|get-color|get-colorbool|list|null|name-only|show-origin|show-scope|show-names|(?:no-)?includes|local|worktree|global|system|file(?:=.*)?|blob(?:=.*)?|type(?:=.*)?|bool|int|bool-or-int|path|expiry-date|default(?:=.*)?|all|regexp|fixed-value|value=.*|url=.*))$/;
function readsConfiguration(args: Arguments): boolean {
  return (
    only(args, CONFIG_OPTIONS) &&
    (some(args, /^(?:-l|--list|--get(?:-all|-regexp|-urlmatch|-color|-colorbool)?)$/) ||
      begins(args, 'get', 'list') ||
      operandPositions('config', args).length === 1)
  );
}
/** Subcommands that inspect only in some forms. */
const GIT_INSPECTION_FORMS: Readonly<Record<string, (args: Arguments) => boolean>> = {
  branch: (args) =>
    only(args, BRANCH_OPTIONS) &&
    (action(args) === '' ||
      some(args, /^(?:-[a-z]*l[a-z]*|--(?:list|(?:no-)?(?:contains|merged)|points-at)(?:=.*)?)$/)),
  tag: (args) =>
    only(args, TAG_OPTIONS) &&
    (action(args) === '' ||
      some(
        args,
        /^(?:-[lv]|-n\d*|--(?:list|verify|(?:no-)?(?:contains|merged)|points-at)(?:=.*)?)$/
      )),
  remote: (args) =>
    begins(
      args.filter((value) => value !== '-v' && value !== '--verbose'),
      '',
      'show',
      'get-url'
    ),
  config: readsConfiguration,
  stash: (args) => begins(args, 'list', 'show'),
  worktree: (args) => begins(args, 'list'),
  reflog: (args) =>
    args.length === 0 ||
    (typeof args[0] === 'string' && !['expire', 'delete', 'drop', 'write'].includes(args[0])),
  notes: (args) => begins(args, '', 'list', 'show', 'get-ref'),
  submodule: (args) => begins(args, '', 'status', 'summary'),
  bisect: (args) => begins(args, 'log', 'terms'),
  'sparse-checkout': (args) => begins(args, 'list', 'check-rules'),
  'symbolic-ref': (args) =>
    only(args, /^(?:-q|--(?:quiet|short|(?:no-)?recurse))$/) &&
    operandPositions('symbolic-ref', args).length === 1,
  bundle: (args) => begins(args, 'verify', 'list-heads'),
  rerere: (args) => begins(args, 'status', 'diff', 'remaining'),
  // These write another path, which gitWriteOperands names, and no metadata here.
  clone: () => true,
  init: () => true,
  'merge-file': () => true,
};
/**
 * Whether an invocation leaves the repository's refs, index and working tree
 * alone. Writing unreferenced objects changes none of them. A form this table
 * does not know is treated as a write and reaches the ownership check.
 */
export function isGitInspection(subcommand: string, args: Arguments): boolean {
  if (GIT_INSPECTION.has(subcommand)) return true;
  const form = Object.prototype.hasOwnProperty.call(GIT_INSPECTION_FORMS, subcommand)
    ? GIT_INSPECTION_FORMS[subcommand]
    : undefined;
  return form !== undefined && form(args);
}

// ── Readers ─────────────────────────────────────────────────────────────────

/** Short sort options that take their value attached or as the next argument. */
const SORT_OPERANDS = 'kStT';
export function readerHazard(name: string, args: readonly (string | null)[]): Hazard | null {
  let positional = 0;
  let options = true;
  for (let index = 0; index < args.length; index++) {
    const value = args[index]!;
    if (options && value === '--') {
      options = false;
      continue;
    }
    if (!options || value === null || value === '-' || !value.startsWith('-')) {
      // uniq names its output as a second operand.
      if (name === 'uniq' && ++positional > 1) return 'output';
      continue;
    }
    if (name === 'uniq' && /^-[fsw]$/.test(value)) index++;
    if (name === 'rg' && /^--(?:pre|hostname-bin)(?:=|$)/.test(value)) return 'execution';
    if (name !== 'sort') continue;
    if (abbreviates(value, ['output'], [])) return 'output';
    if (abbreviates(value, ['compress-program'], [])) return 'execution';
    if (value.startsWith('--')) continue;
    for (let flag = 1; flag < value.length; flag++) {
      if (value[flag] === 'o') return 'output';
      if (!SORT_OPERANDS.includes(value[flag]!)) continue;
      if (flag === value.length - 1) index++;
      break;
    }
  }
  return null;
}

// ── sed ─────────────────────────────────────────────────────────────────────

export type SedHazard = Hazard | 'syntax';
const SED_STREAMS = ['/dev/stdout', '/dev/stderr', '/dev/null'];

/** One reading of a script; `brackets` says whether [/] hides the delimiter. */
function readSedScript(script: string, brackets: boolean): SedHazard | null {
  let index = 0;
  const peek = (): string => script[index] ?? '';
  const skip = (pattern: RegExp): void => {
    while (index < script.length && pattern.test(peek())) index++;
  };
  const line = (): string => {
    const start = index;
    while (index < script.length && peek() !== '\n') index++;
    return script.slice(start, index).trim();
  };
  /** Consume through an unescaped delimiter; false when it never appears. */
  const delimited = (delimiter: string, expression: boolean): boolean => {
    while (index < script.length) {
      const character = script[index++]!;
      if (character === '\\') index++;
      else if (character === delimiter) return true;
      else if (expression && brackets && character === '[') {
        // A leading ^ and ] are members of the bracket expression.
        if (peek() === '^') index++;
        if (peek() === ']') index++;
        while (index < script.length && peek() !== ']') index++;
        index++;
      }
    }
    return false;
  };
  const address = (): boolean | null => {
    const start = peek();
    if (/[0-9+~]/.test(start)) {
      index++;
      skip(/[0-9~]/);
      return true;
    }
    if (start === '$') {
      index++;
      return true;
    }
    if (start === '/' || start === '\\') {
      index++;
      const delimiter = start === '/' ? '/' : script[index++];
      if (delimiter === undefined || delimiter === '\n' || delimiter === '\\') return null;
      if (!delimited(delimiter, true)) return null;
      skip(/[IM]/);
      return true;
    }
    return false;
  };
  const writesFile = (): boolean => !SED_STREAMS.includes(line());
  for (;;) {
    skip(/[\s;}]/);
    if (index >= script.length) return null;
    if (peek() === '#') {
      line();
      continue;
    }
    const first = address();
    if (first === null) return 'syntax';
    if (first) {
      skip(/[ \t]/);
      if (peek() === ',') {
        index++;
        skip(/[ \t]/);
        if (address() !== true) return 'syntax';
      }
    }
    skip(/[ \t!]/);
    const command = script[index++];
    switch (command) {
      case '{':
      case '=':
      case 'd':
      case 'D':
      case 'F':
      case 'g':
      case 'G':
      case 'h':
      case 'H':
      case 'n':
      case 'N':
      case 'p':
      case 'P':
      case 'x':
      case 'z':
        break;
      case 'l':
      case 'L':
      case 'q':
      case 'Q':
        skip(/[ \t0-9]/);
        break;
      case 'a':
      case 'i':
      case 'c':
        // Text continues across lines that end in a backslash.
        while (line().endsWith('\\') && index < script.length) index++;
        break;
      case ':':
      case 'b':
      case 't':
      case 'T':
      case 'v':
        while (index < script.length && !/[\n;}]/.test(peek())) index++;
        break;
      case 'r':
      case 'R':
        line();
        break;
      case 'w':
      case 'W':
        if (writesFile()) return 'output';
        break;
      case 'e':
        return 'execution';
      case 's':
      case 'y': {
        const delimiter = script[index++];
        if (delimiter === undefined || delimiter === '\n' || delimiter === '\\') return 'syntax';
        if (!delimited(delimiter, true) || !delimited(delimiter, false)) return 'syntax';
        if (command === 'y') break;
        for (; /[0-9a-zA-Z]/.test(peek()); index++) {
          if (peek() === 'e') return 'execution';
          if (peek() === 'w') {
            index++;
            if (writesFile()) return 'output';
            break;
          }
          if (!/[0-9gpiImM]/.test(peek())) return 'syntax';
        }
        break;
      }
      default:
        return 'syntax';
    }
    skip(/[ \t]/);
    if (index < script.length && !/[\n;}#]/.test(peek()) && command !== '{') return 'syntax';
  }
}

/**
 * Whether a sed script writes a file or runs a program. Implementations differ
 * on whether a bracket expression hides its delimiter, so both readings are
 * checked: the one the installed sed rejects cannot run, and either effect holds.
 */
export function sedScriptHazard(script: string): SedHazard | null {
  const readings = [readSedScript(script, true), readSedScript(script, false)];
  return (
    readings.find((reading) => reading === 'execution') ??
    readings.find((reading) => reading === 'output') ??
    (readings.every((reading) => reading === 'syntax') ? 'syntax' : null)
  );
}
