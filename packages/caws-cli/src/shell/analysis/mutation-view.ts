import { basename, isAbsolute } from 'node:path';
import { analyzeCommand } from './analyze';
import { resolveGitContext } from './git-context';
import type { GitContext, GitContextResolver } from './git-context';
import type { Command, Redirection } from './parser-types';
import type { Argument, GitMetadataObservation, Location, State, Value } from './types';

export interface MutationViewRequest {
  command: string;
  cwd: string | null;
  project: string;
  shell?: string;
}
export interface MutationToken {
  value: string;
  kind: 'word' | 'op' | 'redirect' | 'input_redirect' | 'unsupported_nesting';
  dynamic: boolean;
  resolution: '' | 'runtime';
  prefix: '';
  prefixBasis: 'none';
  unrepresentable: boolean;
  cwd: string | null;
  start: number;
  end: number;
}
export interface MutationIssue {
  code: string;
  message: string;
  start: number;
  end: number;
}
export interface InterpreterPayload {
  text: string;
  origin: 'argument' | 'heredoc';
  start: number;
  end: number;
}
export interface MutationInterpreter {
  language: 'node' | 'python';
  argv: (string | null)[];
  payloads: InterpreterPayload[];
  cwd: string | null;
  start: number;
  end: number;
}
export interface MutationView {
  schema: 'caws.shell_mutation_view.v1';
  tokens: MutationToken[];
  issues: MutationIssue[];
  interpreters: MutationInterpreter[];
  gitMetadata: GitMetadataWrite[];
}
export interface GitMetadataWrite {
  subcommand: 'add' | 'commit';
  directory: string;
  common: string;
  worktree: string;
  start: number;
  end: number;
}
export interface MutationViewDependencies {
  gitContext?: GitContextResolver;
}
type Invocation = {
  node: Command;
  argv: Argument[];
  state: State;
  environment: Map<string, Value>;
  reader: boolean;
};
type RedirectObservation = {
  node: Redirection;
  targets: Argument[][];
  state: State;
  reader: boolean;
};
type Mapping = (location: Location) => Location;
type ScriptJob = { command: string; cwd: string | null; depth: number; map: Mapping };
type HereDoc = Extract<Redirection, { type: 'HereDoc' }>;
const MAX_TOKENS = 4096,
  MAX_DEPTH = 8,
  MAX_SCRIPTS = 32;
const MAX_SOURCE_BYTES = 65536,
  MAX_TEXT_BYTES = 262144;
const UNPROFILED_BUILTINS = new Set([
  '.',
  'alias',
  'bg',
  'bind',
  'break',
  'builtin',
  'caller',
  'compgen',
  'complete',
  'compopt',
  'continue',
  'declare',
  'dirs',
  'disown',
  'enable',
  'eval',
  'exit',
  'export',
  'fc',
  'fg',
  'getopts',
  'hash',
  'help',
  'history',
  'jobs',
  'kill',
  'let',
  'local',
  'logout',
  'mapfile',
  'popd',
  'pushd',
  'readarray',
  'readonly',
  'return',
  'set',
  'shift',
  'shopt',
  'source',
  'suspend',
  'times',
  'trap',
  'type',
  'typeset',
  'ulimit',
  'umask',
  'unalias',
  'unset',
  'wait',
]);

// New codes and every expansion/state/parser/resource failure remain visible.
const POLICY_ONLY = new Set([
  'outside-cwd',
  'foreign-git-target',
  'git-mapping-unresolved',
  'git-target-unresolved',
  'git-discovery-unresolved',
  'git-discovery-failed',
  'git-discovery-protocol',
]);

/**
 * Lexical projection for the mutation-role consumer, never a scope verdict.
 * Literal external applications retain the existing limited-recognizer residual:
 * no extracted mutation is not proof that arbitrary code cannot write.
 * Nested -c uses its whole original Word as coarse provenance: quote removal
 * can prevent a faithful character-by-character source map.
 */
export async function projectMutationView(
  request: MutationViewRequest,
  dependencies: MutationViewDependencies = {}
): Promise<MutationView> {
  const view: MutationView = {
    schema: 'caws.shell_mutation_view.v1',
    tokens: [],
    issues: [],
    interpreters: [],
    gitMetadata: [],
  };
  type MetadataResult = {
    context: GitContext | null;
    failure: 'metadata-discovery-timeout' | 'metadata-discovery-failure' | null;
  };
  const metadataCache = new Map<string, MetadataResult>();
  const metadataRows = new Set<string>();
  const issueKeys = new Set<string>();
  const jobs: ScriptJob[] = [];
  let exhausted = false,
    sourceBytes = 0,
    textBytes = 0;
  function issue(code: string, message: string, location: Location): void {
    const start = Math.max(0, Math.min(request.command.length, location.pos));
    const end = Math.max(start, Math.min(request.command.length, location.end));
    const key = JSON.stringify([code, start, end]);
    if (issueKeys.has(key) || (exhausted && code !== 'mutation-view-budget')) return;
    if (
      code !== 'mutation-view-budget' &&
      (view.issues.length >= MAX_TOKENS ||
        textBytes + Buffer.byteLength(message, 'utf8') > MAX_TEXT_BYTES)
    ) {
      exhaust(location);
      return;
    }
    textBytes += Buffer.byteLength(message, 'utf8');
    issueKeys.add(key);
    view.issues.push({ code, message, start, end });
  }
  function exhaust(location: Location): void {
    if (exhausted) return;
    exhausted = true;
    issue(
      'mutation-view-budget',
      'Mutation projection exceeded its shared resource budget.',
      location
    );
  }
  function text(value: string, location: Location): boolean {
    textBytes += Buffer.byteLength(value, 'utf8');
    if (textBytes > MAX_TEXT_BYTES) {
      exhaust(location);
      return false;
    }
    return true;
  }
  function token(
    value: string,
    kind: MutationToken['kind'],
    dynamic: boolean,
    location: Location,
    cwd: string
  ): void {
    if (exhausted) return;
    if (view.tokens.length >= MAX_TOKENS || !text(value, location)) {
      exhaust(location);
      return;
    }
    view.tokens.push({
      value,
      kind,
      dynamic,
      resolution: dynamic ? 'runtime' : '',
      prefix: '',
      prefixBasis: 'none',
      unrepresentable: /[\n\t]/.test(value),
      cwd: request.cwd === null ? null : cwd,
      start: location.pos,
      end: location.end,
    });
  }
  function queue(command: string, cwd: string | null, depth: number, map: Mapping): void {
    if (exhausted) return;
    const location = map({ pos: 0, end: command.length });
    sourceBytes += Buffer.byteLength(command, 'utf8');
    if (depth > MAX_DEPTH || jobs.length >= MAX_SCRIPTS || sourceBytes > MAX_SOURCE_BYTES) {
      exhaust(location);
      return;
    }
    jobs.push({ command, cwd: request.cwd === null ? null : cwd, depth, map });
  }
  queue(request.command, request.cwd, 0, (location) => location);
  for (let cursor = 0; cursor < jobs.length && !exhausted; cursor++) {
    const job = jobs[cursor]!;
    const finiteCallees = new Set<string>();
    const span = (location: Location): Location => job.map(location);
    const raw = (arg: Argument): string =>
      arg.source ? job.command.slice(arg.source.pos, arg.source.end) : '';
    const argSpan = (arg: Argument, fallback: Location): Location => span(arg.source ?? fallback);
    const words = (argv: Argument[], node: Location, cwd: string): void => {
      for (const arg of argv)
        token(arg.value ?? raw(arg), 'word', arg.value === null, argSpan(arg, node), cwd);
      token(';', 'op', false, span({ pos: node.end, end: node.end }), cwd);
    };
    const unwrap = (
      argv: Argument[],
      node: Location
    ): { args: Argument[]; environment: boolean } | null => {
      let args = argv,
        environment = false;
      for (let wrappers = 0; wrappers <= 8; wrappers++) {
        const executable = args[0]?.value;
        if (!executable) {
          issue(
            'mutation-executable-unknown',
            'Executable identity is not a finite value.',
            span(node)
          );
          return null;
        }
        const name = basename(executable);
        if (!['command', 'env', 'exec'].includes(name)) return { args, environment };
        if (wrappers === 8) {
          issue(
            'mutation-wrapper-budget',
            'Wrapper nesting exceeds the projection budget.',
            span(node)
          );
          return null;
        }
        let offset = 1;
        if (args[offset]?.value === '--') offset++;
        if (name === 'env') {
          while (/^[A-Za-z_][A-Za-z_0-9]*=/.test(args[offset]?.value ?? '')) {
            environment = true;
            offset++;
          }
        }
        if (args[offset]?.value?.startsWith('-')) {
          issue('mutation-wrapper-option', 'Wrapper option effects are not modeled.', span(node));
          return null;
        }
        args = args.slice(offset);
      }
      return null;
    };
    const stdinRedirect = (node: Command): Redirection | undefined =>
      [...node.prefix, ...node.suffix]
        .filter((part): part is Redirection => part.type !== 'Word' && part.type !== 'Assignment')
        .filter(
          (part) =>
            (part.descriptor === undefined ||
              (part.descriptor.type === 'FileDescriptor' && part.descriptor.value === 0)) &&
            ['<', '<>', '<&', '<<<', '<<', '<<-'].includes(part.operator)
        )
        .at(-1);
    const documentText = (document: HereDoc): string | null => {
      if (!document.delimiter || !document.closing) {
        issue('mutation-heredoc-source', 'Here-document source is incomplete.', span(document));
        return null;
      }
      if (
        document.operator === '<<-' ||
        job.command.slice(document.body.pos, document.body.end) !== document.body.text
      ) {
        issue(
          'mutation-heredoc-source',
          'Here-document transformations lack an exact source map.',
          span(document.body)
        );
        return null;
      }
      if (
        !document.delimiter.quoted &&
        document.body.parts?.some((part) => part.type !== 'Literal')
      ) {
        issue(
          'mutation-code-expanded',
          'Expanded interpreter input is not proven literal code.',
          span(document.body)
        );
        return null;
      }
      return document.body.text;
    };
    const mode = (
      args: Argument[],
      language: 'node' | 'python' | 'shell',
      node: Location
    ): { argument?: Argument; code?: string; stdin: boolean } | null => {
      const flag = language === 'node' ? '-e' : '-c';
      let index = 1;
      while (index < args.length) {
        const arg = args[index]!,
          value = arg.value;
        if (value === null) {
          issue(
            'mutation-code-source',
            'Interpreter source selection is opaque.',
            argSpan(arg, node)
          );
          return null;
        }
        const long = language === 'node' && /^(?:--eval|--print)=/.test(value);
        const short = language === 'python' && value.startsWith(flag) && value.length > flag.length;
        if (
          value === flag ||
          (language === 'node' && ['--eval', '-p', '--print'].includes(value))
        ) {
          const code = args[index + 1];
          if (!code || code.value === null) {
            issue(
              'mutation-code-source',
              'Interpreter code is not a finite argument.',
              code ? argSpan(code, node) : span(node)
            );
            return null;
          }
          return { argument: code, code: code.value, stdin: false };
        }
        if (long || short)
          return {
            argument: arg,
            code: long ? value.slice(value.indexOf('=') + 1) : value.slice(2),
            stdin: false,
          };
        if (value === '-') return { stdin: true };
        if (value === '--')
          return { stdin: index + 1 >= args.length || args[index + 1]?.value === '-' };
        if (!value.startsWith('-')) return { stdin: false };
        const harmless =
          (language === 'node' &&
            (value === '--no-warnings' || /^--input-type=(?:module|commonjs)$/.test(value))) ||
          (language === 'python' &&
            ['-u', '-B', '-E', '-I', '-s', '-S', '-O', '-OO', '-q'].includes(value)) ||
          (language === 'shell' && value === '-s');
        if (!harmless) {
          issue(
            'mutation-interpreter-option',
            'Interpreter option effects are not modeled.',
            argSpan(arg, node)
          );
          return null;
        }
        index++;
      }
      return { stdin: true };
    };
    const observeInvocation = ({ node, argv, state }: Invocation): void => {
      if (exhausted) return;
      words(argv, node, state.cwd);
      if (exhausted) return;
      const unwrapped = unwrap(argv, node);
      if (!unwrapped) return;
      const { args } = unwrapped;
      const executable = args[0]!.value!,
        name = basename(executable);
      if (UNPROFILED_BUILTINS.has(name)) {
        issue(
          'mutation-shell-builtin',
          'Shell builtin state or execution effects are not modeled.',
          span(node)
        );
        return;
      }
      finiteCallees.add(JSON.stringify([node.pos, node.end]));
      if (name === 'sh') {
        issue(
          'mutation-shell-dialect',
          'sh execution does not establish the declared non-POSIX Bash model.',
          span(node)
        );
        return;
      }
      const shell = name === 'bash';
      const language =
        name === 'node' || name === 'nodejs'
          ? 'node'
          : /^python(?:[0-9]+(?:\.[0-9]+)*)?$/.test(name)
            ? 'python'
            : null;
      if (!shell && !language) return;
      if (
        shell &&
        (unwrapped.environment || node.prefix.some((part) => part.type === 'Assignment'))
      ) {
        issue(
          'mutation-shell-environment',
          'Shell prefix environment is not a proven nested binding state.',
          span(node)
        );
      }
      const selected = mode(args, language ?? 'shell', node);
      if (!selected) return;
      const payloads: InterpreterPayload[] = [];
      if (selected.argument && selected.code !== undefined) {
        const original = argSpan(selected.argument, node);
        if (shell) queue(selected.code, state.cwd, job.depth + 1, () => original);
        else if (text(selected.code, original))
          payloads.push({
            text: selected.code,
            origin: 'argument',
            start: original.pos,
            end: original.end,
          });
      } else if (selected.stdin) {
        // Only the final redirection of fd 0 supplies executable stdin.
        // Earlier heredoc expansions remain inspected by the shared engine.
        const last = stdinRedirect(node);
        if (last?.type !== 'HereDoc')
          issue(
            shell ? 'mutation-shell-source' : 'mutation-interpreter-source',
            'Executable stdin is not proven by a literal here-document.',
            span(node)
          );
        if (last?.type === 'HereDoc') {
          const body = documentText(last);
          if (body !== null) {
            const original = span(last.body);
            if (shell)
              queue(body, state.cwd, job.depth + 1, (location) =>
                span({ pos: last.body.pos + location.pos, end: last.body.pos + location.end })
              );
            else if (text(body, original))
              payloads.push({
                text: body,
                origin: 'heredoc',
                start: original.pos,
                end: original.end,
              });
          }
        }
      } else if (shell)
        issue(
          'mutation-shell-source',
          'Shell script-file input is outside this source-only projection.',
          span(node)
        );
      if (language && !exhausted) {
        const original = span(node);
        view.interpreters.push({
          language,
          argv: args.map((arg) => arg.value),
          payloads,
          cwd: request.cwd === null ? null : state.cwd,
          start: original.pos,
          end: original.end,
        });
      }
    };
    const observeRedirect = ({ node, targets, state }: RedirectObservation): void => {
      if (exhausted || node.type === 'HereDoc') return;
      if (node.operator === '>&' || node.operator === '<&') {
        if (
          !targets.every(
            (fields) => fields.length === 1 && /^(?:[0-9]+|-)$/.test(fields[0]?.value ?? '')
          )
        )
          issue(
            'redirect-descriptor',
            'Descriptor redirection is not a proven numeric duplication.',
            span(node)
          );
        return;
      }
      const kind =
        node.type === 'HereString' || node.operator === '<' ? 'input_redirect' : 'redirect';
      for (const fields of targets) {
        token(node.operator, kind, false, span(node), state.cwd);
        for (const arg of fields)
          token(arg.value ?? raw(arg), 'word', arg.value === null, argSpan(arg, node), state.cwd);
        token(';', 'op', false, span({ pos: node.end, end: node.end }), state.cwd);
      }
    };
    const observeGitMetadata = ({ node, subcommand, input }: GitMetadataObservation): void => {
      if (exhausted) return;
      const original = span(node);
      if (request.cwd === null || input === null) {
        issue(
          'metadata-coordinate-unresolved',
          'Git metadata write coordinates are not proven.',
          original
        );
        return;
      }
      if (view.gitMetadata.length >= MAX_TOKENS) {
        exhaust(original);
        return;
      }
      const key = JSON.stringify([input.cwd, Object.entries(input.overrides).sort()]);
      let outcome = metadataCache.get(key);
      if (!outcome) {
        if (metadataCache.size >= 8) {
          issue(
            'metadata-discovery-budget',
            'At most eight distinct metadata contexts are inspected.',
            original
          );
          return;
        }
        outcome = { context: null, failure: null };
        try {
          const context = (dependencies.gitContext ?? resolveGitContext)(input, (failure) => {
            outcome!.failure =
              failure === 'git-discovery-timeout'
                ? 'metadata-discovery-timeout'
                : 'metadata-discovery-failure';
          });
          if (
            !outcome.failure &&
            context &&
            [context.directory, context.common, context.worktree].every(
              (value) => typeof value === 'string' && isAbsolute(value)
            )
          ) {
            outcome.context = context;
          } else outcome.failure ??= 'metadata-discovery-failure';
        } catch {
          outcome.context = null;
          outcome.failure = 'metadata-discovery-failure';
        }
        metadataCache.set(key, outcome);
      }
      if (!outcome.context || outcome.failure) {
        const code = outcome.failure ?? 'metadata-discovery-failure';
        issue(
          code,
          code === 'metadata-discovery-timeout'
            ? 'Constant Git metadata discovery exceeded its 500 ms query budget.'
            : 'Constant Git metadata discovery did not establish a non-bare repository context.',
          original
        );
        return;
      }
      const { directory, common, worktree } = outcome.context;
      if (worktree === null) {
        issue('metadata-discovery-failure', 'Git metadata has no proven working tree.', original);
        return;
      }
      const row = {
        subcommand,
        directory,
        common,
        worktree,
        start: original.pos,
        end: original.end,
      };
      const rowKey = JSON.stringify(row);
      if (metadataRows.has(rowKey) || !text(directory + '\0' + common + '\0' + worktree, original))
        return;
      metadataRows.add(rowKey);
      view.gitMetadata.push(row);
    };
    const analysis = await analyzeCommand(
      {
        command: job.command,
        // A null coordinate uses the project only to traverse syntax. Output
        // coordinates remain null, so no relative write borrows this placeholder.
        cwd: job.cwd ?? request.project,
        worktree: request.project,
        ...(request.shell === undefined ? {} : { shell: request.shell }),
      },
      {
        context: { canonical: request.project, worktree: request.project },
        gitContext: () => null,
        observers: {
          invocation: observeInvocation,
          redirection: observeRedirect,
          gitMetadata: observeGitMetadata,
        },
      }
    );
    for (const reason of analysis.reasons) {
      if (POLICY_ONLY.has(reason.code)) continue;
      if (
        reason.code === 'utility-unsupported' &&
        finiteCallees.has(JSON.stringify([reason.start, reason.end]))
      )
        continue;
      issue(reason.code, reason.message, span({ pos: reason.start, end: reason.end }));
    }
  }
  return view;
}
