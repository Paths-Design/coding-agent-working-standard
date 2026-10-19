import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, sep } from 'node:path';
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
  /^(?:IFS|PATH|CDPATH|ENV|BASH_ENV|SHELLOPTS|BASHOPTS|GLOBIGNORE|POSIXLY_CORRECT|LANG|LC_.*|RIPGREP_CONFIG_PATH|GIT_CONFIG.*|NODE_OPTIONS|NODE_PATH|PYTHONPATH|PYTHONHOME|PYTHONSTARTUP|PYTHONINSPECT|LD_.*|DYLD_.*)$/;
export function sensitiveBinding(name: string): boolean {
  return SENSITIVE.test(name);
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
    if (
      ['--no-pager', '--no-optional-locks', '--literal-pathspecs', '--no-replace-objects'].includes(
        word
      )
    )
      continue;
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
  const optionArgs: string[] = [];
  const executionOptions: Record<string, RegExp> = {
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
  const dataOptions: Record<string, readonly string[]> = {
    log: ['-n', '--max-count', '--grep', '--author', '--committer', '--since', '--until'],
    show: [],
    diff: ['-U', '--unified'],
    commit: ['-m', '--message', '-F', '--file'],
    grep: ['-e', '-f'],
  };
  const diffFlags =
    /^(?:-[psw]|-U[0-9]+|--(?:stat|numstat|shortstat|name-only|name-status|check|raw|patch|no-patch|quiet|exit-code|no-ext-diff|no-textconv|no-color|color(?:=.*)?|unified=[0-9]+))$/;
  const flags: Record<string, RegExp> = {
    status: /^(?:-[sbz]+|--(?:short|branch|porcelain(?:=v[12])?|ignored|untracked-files(?:=.*)?))$/,
    diff: diffFlags,
    log: /^(?:-[psw]|-n[0-9]+|-U[0-9]+|--(?:oneline|graph|all|first-parent|no-merges|merges|no-walk|decorate(?:=.*)?|stat|numstat|shortstat|name-only|name-status|raw|patch|no-patch|no-ext-diff|no-textconv|no-color|color(?:=.*)?|unified=[0-9]+|(?:max-count|grep|author|committer|since|until)=.*|(?:format|pretty)=(?:oneline|%H|%h|%s|%b|%B)))$/,
    show: /^(?:-[psw]|-U[0-9]+|--(?:stat|numstat|shortstat|name-only|name-status|raw|patch|no-patch|no-ext-diff|no-textconv|no-color|color(?:=.*)?|unified=[0-9]+|(?:format|pretty)=(?:oneline|%H|%h|%s|%b|%B)))$/,
    'rev-parse':
      /^--(?:verify|quiet|short(?:=[0-9]+)?|abbrev-ref|symbolic-full-name|show-toplevel|show-prefix|show-cdup|git-dir|absolute-git-dir|git-common-dir|is-inside-work-tree|is-bare-repository)$/,
    'ls-files': /^(?:-[zsomcd]+|--(?:stage|others|exclude-standard|cached|modified|deleted))$/,
    'ls-tree': /^(?:-[rzl]+|--(?:name-only|long|full-tree))$/,
    grep: /^(?:-[nliIvowcHEFra]+|--(?:line-number|files-with-matches|fixed-strings|extended-regexp|ignore-case|count|color(?:=.*)?))$/,
    add: /^(?:-[Aunv]+|--(?:all|update|dry-run|verbose))$/,
    commit:
      /^(?:-[aq]+|--(?:all|quiet|dry-run|allow-empty|signoff|no-gpg-sign|message=.*|file=.*))$/,
  };
  for (let index = 0; index < commandArgs.length; index++) {
    const value = commandArgs[index]!;
    if (value === '--') break;
    if (dataOptions[subcommand]?.includes(value)) {
      if (++index >= commandArgs.length)
        ctx.reason(node, 'git-option-unmodeled', 'A data-only Git option is missing its operand.');
      continue;
    }
    if (!value.startsWith('-') || value === '-') continue;
    optionArgs.push(value);
    if (executionOptions[subcommand]?.test(value)) continue;
    if (!flags[subcommand]?.test(value)) {
      ctx.reason(
        node,
        'git-option-unmodeled',
        'This Git option has no admitted argument/effect role.'
      );
      break;
    }
  }
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
  if (
    reader &&
    !['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'ls-tree'].includes(subcommand)
  ) {
    ctx.reason(node, 'substitution-effects', 'This Git command is not an admitted read producer.');
  }
}

function sedPolicy(args: Argument[], ctx: AnalysisContext, node: Location): void {
  let options = true;
  let hasScript = false;
  function script(value: string | null): void {
    hasScript = true;
    if (value === null) {
      ctx.reason(node, 'sed-script-unknown', 'Opaque data cannot prove a sed script safe.');
      return;
    }
    // Admit a deliberately small grammar, not a blacklist of dangerous bytes.
    const address = '(?:(?:[0-9]+|\\$)(?:,(?:[0-9]+|\\$))?)?';
    const printOnly = new RegExp(`^\\s*${address}[pd=q]\\s*(?:;\\s*${address}[pd=q]\\s*)*$`);
    if (printOnly.test(value)) {
      ctx.trace(node, 'sed-script', 'Known print/delete/quit script; no execution or writes.');
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
      ctx.reason(
        node,
        'sed-execution',
        'Sed script contains an execution-bearing command or substitution flag.',
        true
      );
    } else
      ctx.reason(
        node,
        'sed-script-unsupported',
        'Sed script is outside the admitted non-executing grammar.'
      );
  }
  for (let i = 0; i < args.length; i++) {
    const value = args[i]!.value;
    if (options && value === '--') {
      options = false;
      continue;
    }
    if (options && value !== null && value.startsWith('-') && value !== '-') {
      if (['-n', '-E', '-r', '--quiet', '--silent', '--regexp-extended', '--posix'].includes(value))
        continue;
      if (value === '-e' || value === '--expression') {
        script(args[++i]?.value ?? null);
        continue;
      }
      if (value.startsWith('-e') || value.startsWith('--expression=')) {
        script(value.startsWith('-e') ? value.slice(2) : value.slice(13));
        continue;
      }
      ctx.reason(
        node,
        'sed-option',
        'Sed script files, writes, and unmodeled options require a stronger proof.'
      );
      continue;
    }
    if (!hasScript) script(value);
    else if (value === null && options)
      ctx.reason(
        node,
        'sed-option-unknown',
        'An opaque filename before -- can introduce sed options.'
      );
  }
  if (!hasScript) ctx.reason(node, 'sed-script-missing', 'Sed has no proven script.');
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
  if (
    ['rg', 'grep', 'cat', 'head', 'tail', 'wc', 'ls', 'cut', 'tr', 'sort', 'uniq'].includes(name)
  ) {
    const known = args.map((arg) => arg.value);
    const short: Record<string, RegExp> = {
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
    const long: Record<string, RegExp> = {
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
    let options = true;
    const dataOptions: Record<string, string[]> = {
      rg: ['-e', '--regexp', '--glob', '--type', '-r', '--replace', '-E', '--encoding'],
      grep: ['-e', '--regexp', '-f', '--file'],
      head: ['-n', '-c', '--lines', '--bytes'],
      tail: ['-n', '-c', '--lines', '--bytes'],
      cut: ['-b', '-c', '-d', '-f', '--bytes', '--characters', '--delimiter', '--fields'],
      sort: ['-k', '--key', '-S', '--buffer-size'],
    };
    let positional = 0;
    for (let index = 0; index < known.length; index++) {
      const value = known[index]!;
      if (options && value === '--') {
        options = false;
        continue;
      }
      if (!options || value === '-' || (value !== null && !value.startsWith('-'))) {
        if (name === 'uniq' && ++positional > 1) {
          ctx.reason(
            node,
            'reader-output',
            'uniq has a positional output file outside the read-only profile.'
          );
          return { ...state, filesystemChanged: true };
        }
        continue;
      }
      if (value === null) {
        ctx.reason(
          node,
          'reader-option-unknown',
          'Opaque reader operands require an explicit -- boundary.'
        );
        continue;
      }
      if (dataOptions[name]?.includes(value)) {
        if (++index >= known.length)
          ctx.reason(node, 'reader-option', 'Reader data option has no operand.');
        continue;
      }
      if (
        (name === 'rg' && /^--(?:pre|hostname-bin)(?:=|$)/.test(value)) ||
        (name === 'sort' && /^--compress-program(?:=|$)/.test(value))
      ) {
        ctx.reason(node, 'reader-execution', 'This reader option invokes another program.', true);
        return state;
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
        ctx.reason(node, 'reader-option', `Unmodeled ${name} option.`);
        return state;
      }
    }
    return state;
  }
  ctx.reason(node, 'utility-unsupported', `No admitted argument-role profile for ${name}.`);
  // A consumer may recognize this application's write operands separately.
  // Its unmodeled effects must still invalidate later filesystem observations.
  return { ...state, filesystemChanged: true };
}
