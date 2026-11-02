import { isCawsReadInvocation, isCawsLiteralExecutable } from './caws-read-metadata';

/** Pure argument-role definitions shared by effect analysis and prefix inspection.
 * These profiles assume normal executable lookup and trusted Git configuration.
 * They do not authenticate executables, discover repositories or grant authority.
 */
export type ProfileIssue = (code: string, message: string, deny?: boolean) => void;
export const NODE_STARTUP_CONTROLS: readonly string[] = [
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_V8_COVERAGE',
  'NODE_COMPILE_CACHE',
  'NODE_REDIRECT_WARNINGS',
  'NODE_REPL_EXTERNAL_MODULE',
  'NODE_REPL_HISTORY',
  'NODE_ICU_DATA',
  'OPENSSL_CONF',
  'OPENSSL_ENGINES',
];
export const GIT_READ_COMMANDS: readonly string[] = [
  'status',
  'diff',
  'log',
  'show',
  'rev-parse',
  'ls-files',
  'ls-tree',
];
export const GIT_LITERAL_GLOBAL_FLAGS: readonly string[] = [
  '--no-pager',
  '--no-optional-locks',
  '--literal-pathspecs',
  '--no-replace-objects',
];
export const GIT_EXECUTION_OPTIONS: Record<string, RegExp> = {
  fetch: /^--upload-pack(?:=|$)/,
  pull: /^--upload-pack(?:=|$)/,
  clone: /^--upload-pack(?:=|$)/,
  'ls-remote': /^--upload-pack(?:=|$)/,
  push: /^--(?:receive-pack|exec)(?:=|$)/,
  diff: /^--(?:ext-diff|textconv)(?:=|$)/,
  log: /^--(?:ext-diff|textconv)(?:=|$)/,
  show: /^--(?:ext-diff|textconv)(?:=|$)/,
  grep: /^--open-files-in-pager(?:=|$)/,
  'cat-file': /^--(?:filters|textconv)(?:=|$)/,
};
export const GIT_DATA_OPTIONS: Record<string, readonly string[]> = {
  log: ['-n', '--max-count', '--grep', '--author', '--committer', '--since', '--until'],
  show: [],
  // Unified context counts are optional and attached. The next token must
  // retain its own option/path role, including output or execution options.
  diff: [],
  commit: ['-m', '--message', '-F', '--file'],
  grep: ['-e', '-f'],
};
export const GIT_DIFF_FLAGS =
  /^(?:-[psw]|-U[0-9]*|--(?:stat|numstat|shortstat|name-only|name-status|check|raw|patch|no-patch|quiet|exit-code|no-ext-diff|no-textconv|no-color|color(?:=.*)?|unified(?:=[0-9]+)?))$/;
export const GIT_OPTION_FLAGS: Record<string, RegExp> = {
  status: /^(?:-[sbz]+|--(?:short|branch|porcelain(?:=v[12])?|ignored|untracked-files(?:=.*)?))$/,
  diff: GIT_DIFF_FLAGS,
  log: /^(?:-[psw]|-n[0-9]+|-U[0-9]+|--(?:oneline|graph|all|first-parent|no-merges|merges|no-walk|decorate(?:=.*)?|stat|numstat|shortstat|name-only|name-status|raw|patch|no-patch|no-ext-diff|no-textconv|no-color|color(?:=.*)?|unified=[0-9]+|(?:max-count|grep|author|committer|since|until)=.*|(?:format|pretty)=(?:oneline|%H|%h|%s|%b|%B)))$/,
  show: /^(?:-[psw]|-U[0-9]+|--(?:oneline|stat|numstat|shortstat|name-only|name-status|raw|patch|no-patch|no-ext-diff|no-textconv|no-color|color(?:=.*)?|unified=[0-9]+|(?:format|pretty)=(?:oneline|%H|%h|%s|%b|%B)))$/,
  'rev-parse':
    /^--(?:verify|quiet|short(?:=[0-9]+)?|abbrev-ref|symbolic-full-name|show-toplevel|show-prefix|show-cdup|git-dir|absolute-git-dir|git-common-dir|is-inside-work-tree|is-bare-repository)$/,
  'ls-files': /^(?:-[zsomcd]+|--(?:stage|others|exclude-standard|cached|modified|deleted))$/,
  'ls-tree': /^(?:-[rzl]+|--(?:name-only|long|full-tree))$/,
  grep: /^(?:-[nliIvowcHEFra]+|--(?:line-number|files-with-matches|fixed-strings|extended-regexp|ignore-case|count|color(?:=.*)?))$/,
  add: /^(?:-[Aunv]+|--(?:all|update|dry-run|verbose))$/,
  commit: /^(?:-[aq]+|--(?:all|quiet|dry-run|allow-empty|signoff|no-gpg-sign|message=.*|file=.*))$/,
};

export function inspectGitOptions(
  subcommand: string,
  commandArgs: readonly string[],
  issue: ProfileIssue
): string[] {
  const optionArgs: string[] = [];
  const dataOptions = GIT_DATA_OPTIONS;
  const flags = GIT_OPTION_FLAGS;
  const executionOptions = GIT_EXECUTION_OPTIONS;
  for (let index = 0; index < commandArgs.length; index++) {
    const value = commandArgs[index]!;
    if (value === '--') break;
    if (dataOptions[subcommand]?.includes(value)) {
      if (++index >= commandArgs.length)
        issue('git-option-unmodeled', 'A data-only Git option is missing its operand.');
      continue;
    }
    if (!value.startsWith('-') || value === '-') continue;
    optionArgs.push(value);
    if (executionOptions[subcommand]?.test(value)) continue;
    if (!flags[subcommand]?.test(value)) {
      issue('git-option-unmodeled', 'This Git option has no admitted argument/effect role.');
      break;
    }
  }
  return optionArgs;
}

export const READER_SHORT: Record<string, RegExp> = {
  rg: /^-[nliIvowcHFsSuaq0]+$/,
  grep: /^-[nliIvowcHEFrsSa]+$/,
  cat: /^-[benstuvAET]+$/,
  head: /^-[ncvq](?:[0-9]+)?$/,
  tail: /^-[ncvq](?:[0-9]+)?$/,
  wc: /^-[clwmL]+$/,
  ls: /^-[alhAdtrRS1]+$/,
  cut: /^-[bcdf](?:.+)?$/,
  tr: /^-[cdsC]+$/,
  sort: /^-[bdfginrMu]+$/,
  uniq: /^-[cdui]+$/,
};
export const READER_LONG: Record<string, RegExp> = {
  rg: /^--(?:files|hidden|no-ignore|no-config|line-number|files-with-matches|fixed-strings|ignore-case|count|heading|no-heading|color(?:=.*)?|glob(?:=.*)?|type(?:=.*)?|encoding(?:=.*)?|replace(?:=.*)?)$/,
  grep: /^--(?:line-number|files-with-matches|fixed-strings|extended-regexp|ignore-case|count|color(?:=.*)?)$/,
  cat: /^--(?:number|number-nonblank|show-all)$/,
  head: /^--(?:lines|bytes)(?:=.*)?$/,
  tail: /^--(?:lines|bytes)(?:=.*)?$/,
  wc: /^--(?:lines|bytes|words|chars)$/,
  ls: /^--(?:all|almost-all|directory|human-readable|color(?:=.*)?)$/,
  cut: /^--(?:bytes|characters|fields|delimiter)(?:=.*)?$/,
  tr: /^--(?:delete|squeeze-repeats|complement)$/,
  sort: /^--(?:numeric-sort|reverse|unique)$/,
  uniq: /^--(?:count|repeated|unique|ignore-case)$/,
};
export const READER_DATA_OPTIONS: Record<string, string[]> = {
  rg: ['-e', '--regexp', '--glob', '--type', '-r', '--replace', '-E', '--encoding'],
  grep: ['-e', '--regexp', '-f', '--file'],
  head: ['-n', '-c', '--lines', '--bytes'],
  tail: ['-n', '-c', '--lines', '--bytes'],
  cut: ['-b', '-c', '-d', '-f', '--bytes', '--characters', '--delimiter', '--fields'],
  sort: ['-k', '--key', '-S', '--buffer-size'],
};

/** Returns whether an output operand changes filesystem state. */
export function inspectReaderArguments(
  name: string,
  known: readonly (string | null)[],
  issue: ProfileIssue
): boolean {
  const short = READER_SHORT,
    long = READER_LONG,
    dataOptions = READER_DATA_OPTIONS;
  let options = true;
  let positional = 0;
  for (let index = 0; index < known.length; index++) {
    const value = known[index]!;
    if (options && value === '--') {
      options = false;
      continue;
    }
    if (!options || value === '-' || (value !== null && !value.startsWith('-'))) {
      if (name === 'uniq' && ++positional > 1) {
        issue('reader-output', 'uniq has a positional output file outside the read-only profile.');
        return true;
      }
      continue;
    }
    if (value === null) {
      issue('reader-option-unknown', 'Opaque reader operands require an explicit -- boundary.');
      continue;
    }
    if (dataOptions[name]?.includes(value)) {
      if (++index >= known.length) issue('reader-option', 'Reader data option has no operand.');
      continue;
    }
    if (
      (name === 'rg' && /^--(?:pre|hostname-bin)(?:=|$)/.test(value)) ||
      (name === 'sort' && /^--compress-program(?:=|$)/.test(value))
    ) {
      issue('reader-execution', 'This reader option invokes another program.', true);
      return false;
    }
    // Both head and tail accept the historical numeric count spelling.
    if ((name === 'head' || name === 'tail') && /^-[0-9]+$/.test(value)) continue;
    if (
      options &&
      value !== null &&
      value.startsWith('-') &&
      value !== '-' &&
      !short[name]!.test(value) &&
      !long[name]!.test(value)
    ) {
      issue('reader-option', `Unmodeled ${name} option.`);
      return false;
    }
  }
  return false;
}

export function inspectSedArguments(
  args: readonly (string | null)[],
  issue: ProfileIssue,
  trace: (kind: string, detail: string) => void = () => {}
): void {
  let options = true;
  let hasScript = false;
  function script(value: string | null): void {
    hasScript = true;
    if (value === null) {
      issue('sed-script-unknown', 'Opaque data cannot prove a sed script safe.');
      return;
    }
    // Admit a deliberately small grammar, not a blacklist of dangerous bytes.
    const address = '(?:(?:[0-9]+|\\$)(?:,(?:[0-9]+|\\$))?)?';
    const printOnly = new RegExp(`^\\s*${address}[pd=q]\\s*(?:;\\s*${address}[pd=q]\\s*)*$`);
    if (printOnly.test(value)) {
      trace('sed-script', 'Known print/delete/quit script; no execution or writes.');
      return;
    }
    const execute = new RegExp(`^\\s*(?:${address}[pd=q]\\s*;\\s*)*${address}e(?:\\s|$)`);
    // Recognize a complete substitution with an execution flag. Delimited
    // fields consume escapes as pairs; letters in patterns/replacements are data.
    const substitution = value.match(new RegExp(`^\\s*${address}s([^\\w\\s\\\\])`));
    let executionFlag = false;
    if (substitution) {
      const delimiter = substitution[1]!;
      let offset = substitution[0].length;
      let fields = 0;
      while (offset < value.length && fields < 2) {
        const character = value[offset++]!;
        if (character === '\\') offset++;
        else if (character === delimiter) fields++;
      }
      executionFlag = fields === 2 && /^[0-9gIp]*e[0-9gIp]*\s*$/.test(value.slice(offset));
    }
    if (execute.test(value) || executionFlag) {
      issue(
        'sed-execution',
        'Sed script contains an execution-bearing command or substitution flag.',
        true
      );
    } else
      issue('sed-script-unsupported', 'Sed script is outside the admitted non-executing grammar.');
  }
  for (let i = 0; i < args.length; i++) {
    const value = args[i]!;
    if (options && value === '--') {
      options = false;
      continue;
    }
    if (options && value !== null && value.startsWith('-') && value !== '-') {
      if (['-n', '-E', '-r', '--quiet', '--silent', '--regexp-extended', '--posix'].includes(value))
        continue;
      if (value === '-e' || value === '--expression') {
        script(args[++i] ?? null);
        continue;
      }
      if (value.startsWith('-e') || value.startsWith('--expression=')) {
        script(value.startsWith('-e') ? value.slice(2) : value.slice(13));
        continue;
      }
      issue(
        'sed-option',
        'Sed script files, writes, and unmodeled options require a stronger proof.'
      );
      continue;
    }
    if (!hasScript) script(value);
    else if (value === null && options)
      issue('sed-option-unknown', 'An opaque filename before -- can introduce sed options.');
  }
  if (!hasScript) issue('sed-script-missing', 'Sed has no proven script.');
}

/** Closed inspection subset, independent of contextual effects/ownership policy. */
export function isInspectionInvocation(argv: readonly string[]): boolean {
  if (isCawsLiteralExecutable(argv[0])) return isCawsReadInvocation(argv);
  const name = argv[0]?.replace(/^\/(?:usr\/)?bin\//, '');
  if (!name || name.includes('/')) return false;
  const args = argv.slice(1);
  let valid = true;
  const issue: ProfileIssue = () => {
    valid = false;
  };
  if (name === 'pwd')
    return args.length === 0 || (args.length === 1 && ['-P', '-L'].includes(args[0]!));
  if (name === 'git') {
    let offset = 0;
    while (GIT_LITERAL_GLOBAL_FLAGS.includes(args[offset] ?? '')) offset++;
    const subcommand = args[offset++],
      rest = args.slice(offset);
    if (subcommand === 'branch') return rest.length === 1 && rest[0] === '--show-current';
    if (!subcommand || !GIT_READ_COMMANDS.includes(subcommand)) return false;
    const options = inspectGitOptions(subcommand, rest, issue);
    return valid && !options.some((option) => GIT_EXECUTION_OPTIONS[subcommand]?.test(option));
  }
  if (name === 'sed') {
    inspectSedArguments(args, issue);
    return valid;
  }
  if (Object.prototype.hasOwnProperty.call(READER_SHORT, name)) {
    const writes = inspectReaderArguments(name, args, issue);
    return valid && !writes;
  }
  return false;
}
