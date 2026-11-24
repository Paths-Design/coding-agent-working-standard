/**
 * Argument forms that make an ordinary command write a file or run a program.
 *
 * The write projection names the targets of the utilities it recognizes. These
 * forms carry an effect that extraction does not see, so the projection holds
 * them. Everything else an ordinary command accepts is data to it: an option
 * missing from this file is not a reason to refuse the command.
 */
export type Hazard = 'execution' | 'output';

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
/** Subcommand short options whose next or attached text is data. */
const GIT_GREP_OPERANDS = 'efABCm';
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
  /^(?:core\.(?:pager|editor)=(?:cat|true|:|)|pager\.[a-z-]+=(?:cat|false|0|)|core\.fsmonitor=(?:false|0|)|core\.hookspath=(?:\/dev\/null|)|credential\.helper=)$/i;
/** A command-line configuration value that cannot select a program. */
export function isGitDataConfiguration(assignment: string): boolean {
  const key = assignment.split('=', 1)[0]!;
  return GIT_DATA_CONFIGURATION.test(key) || GIT_DISABLED_CONFIGURATION.test(assignment);
}

/** The effect of one Git invocation's options and operands, when it has one. */
export function gitHazard(subcommand: string, args: readonly (string | null)[]): Hazard | null {
  if (
    GIT_PROGRAM_SUBCOMMANDS.includes(subcommand) ||
    (subcommand === 'bisect' && action(args) === 'run') ||
    (subcommand === 'submodule' && action(args) === 'foreach')
  )
    return 'execution';
  if (subcommand === 'bundle' && action(args) === 'create') return 'output';
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
    if (GIT_OUTPUT_SHORT.includes(subcommand) && value.startsWith('-o')) return 'output';
    if (subcommand === 'cat-file' && value === '--filters') return 'execution';
    if (subcommand === 'rebase' && value.startsWith('-x')) return 'execution';
    if (
      (subcommand === 'checkout-index' || subcommand === 'read-tree') &&
      value.startsWith('--prefix=')
    )
      return 'output';
    if (
      subcommand === 'clone' &&
      (/^-[cu]/.test(value) || abbreviates(value, ['config', 'template', 'separate-git-dir'], []))
    )
      return 'execution';
    if (subcommand === 'grep' && /^-[^-]/.test(value))
      for (const flag of value.slice(1)) {
        if (flag === 'O') return 'execution';
        if (GIT_GREP_OPERANDS.includes(flag)) break;
      }
  }
  return null;
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
type Arguments = readonly (string | null)[];
const operands = (args: Arguments): (string | null)[] =>
  args.filter((value) => value === null || !value.startsWith('-'));
/** The selected action; an unknown one matches no inspecting form. */
const action = (args: Arguments): string => {
  const [first] = operands(args);
  return first === undefined ? '' : (first ?? 'unknown');
};
const some = (args: Arguments, pattern: RegExp): boolean =>
  args.some((value) => value !== null && pattern.test(value));
/** Subcommands that inspect only in some forms. */
const GIT_INSPECTION_FORMS: Readonly<Record<string, (args: Arguments) => boolean>> = {
  branch: (args) =>
    !some(
      args,
      /^(?:-[^-]*[dDmMcCfu]|--(?:delete|move|copy|force|set-upstream-to|unset-upstream|edit-description|track|create-reflog))/
    ) &&
    (operands(args).length === 0 ||
      some(
        args,
        /^(?:-l|--list|--contains|--no-contains|--merged|--no-merged|--points-at)(?:=|$)/
      )),
  tag: (args) =>
    !some(args, /^(?:-[^-]*[dafsu]|--delete)/) &&
    (operands(args).length === 0 ||
      some(
        args,
        /^(?:-l|-n[0-9]*|-v|--list|--verify|--contains|--no-contains|--merged|--no-merged|--points-at)(?:=|$)/
      )),
  remote: (args) => ['', 'show', 'get-url'].includes(action(args)),
  config: (args) =>
    // User, system and named files are not this repository's metadata.
    some(args, /^(?:--global|--system|-f|--file(?:=.*)?)$/) ||
    (!some(
      args,
      /^(?:--unset(?:-all)?|--(?:remove|rename)-section|--replace-all|--add|--edit|-e)$/
    ) &&
      (some(args, /^(?:-l|--list|--get(?:-all|-regexp|-urlmatch|-color|-colorbool)?)$/) ||
        ['get', 'list'].includes(action(args)) ||
        operands(args).length === 1)),
  stash: (args) => ['list', 'show'].includes(action(args)),
  worktree: (args) => action(args) === 'list',
  reflog: (args) => !['expire', 'delete', 'drop', 'unknown'].includes(action(args)),
  notes: (args) => ['', 'list', 'show', 'get-ref'].includes(action(args)),
  submodule: (args) => ['', 'status', 'summary'].includes(action(args)),
  bisect: (args) => ['log', 'terms'].includes(action(args)),
  'sparse-checkout': (args) => ['list', 'check-rules'].includes(action(args)),
  'symbolic-ref': (args) => operands(args).length === 1 && !some(args, /^(?:-d|--delete)$/),
  bundle: (args) => ['verify', 'list-heads'].includes(action(args)),
  rerere: (args) => ['status', 'diff', 'remaining'].includes(action(args)),
  // These make a repository elsewhere; they do not write this one's metadata.
  clone: () => true,
  init: () => true,
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
