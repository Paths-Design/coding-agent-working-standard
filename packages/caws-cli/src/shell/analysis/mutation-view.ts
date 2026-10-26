import { basename, isAbsolute } from 'node:path';
import { analyzeCommand } from './analyze';
import { classifyInterpreterEffects } from './interpreter-effects';
import { resolveGitContext } from './git-context';
import type { GitContext, GitContextResolver } from './git-context';
import type { Command, Redirection } from './parser-types';
import { nodeStartupBinding } from './policies';
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
  effects: ReturnType<typeof classifyInterpreterEffects>;
  cwd: string | null;
  start: number;
  end: number;
}
export interface CopyInvocation {
  operation: 'cp' | 'mv';
  start: number;
  end: number;
}
export interface CopyOperation extends CopyInvocation {
  knowledge: 'finite' | 'readonly' | 'unresolved';
  sources: string[];
  destination: string | null;
  directoryMode: 'auto' | 'directory' | null;
  cwd: string | null;
}
export interface MutationView {
  schema: 'caws.shell_mutation_view.v2';
  tokens: MutationToken[];
  issues: MutationIssue[];
  interpreterInvocations: { language: 'node' | 'python'; start: number; end: number }[];
  interpreters: MutationInterpreter[];
  gitMetadata: GitMetadataWrite[];
  copyInvocations: CopyInvocation[];
  copyOperations: CopyOperation[];
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
type ScriptJob = {
  command: string;
  cwd: string | null;
  depth: number;
  map: Mapping;
  parent?: {
    job: ScriptJob;
    caller: string;
    inheritedEffects: boolean;
    gitEnvironmentUnresolved: boolean;
    disabledPagers: ReadonlyMap<string, Value>;
  };
  writeRedirect: boolean;
  unmodeledInvocations: Set<string>;
  nonShellInvocations: Set<string>;
};
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
    schema: 'caws.shell_mutation_view.v2',
    tokens: [],
    issues: [],
    interpreterInvocations: [],
    interpreters: [],
    gitMetadata: [],
    copyInvocations: [],
    copyOperations: [],
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
  function queue(
    command: string,
    cwd: string | null,
    depth: number,
    map: Mapping,
    parent?: ScriptJob['parent']
  ): void {
    if (exhausted) return;
    const location = map({ pos: 0, end: command.length });
    sourceBytes += Buffer.byteLength(command, 'utf8');
    if (depth > MAX_DEPTH || jobs.length >= MAX_SCRIPTS || sourceBytes > MAX_SOURCE_BYTES) {
      exhaust(location);
      return;
    }
    jobs.push({
      command,
      cwd: request.cwd === null ? null : cwd,
      depth,
      map,
      ...(parent ? { parent } : {}),
      writeRedirect: false,
      unmodeledInvocations: new Set(),
      nonShellInvocations: new Set(),
    });
  }
  function inheritedEffects(job: ScriptJob): boolean {
    for (let link = job.parent; link; link = link.job.parent) {
      if (
        link.inheritedEffects ||
        link.job.writeRedirect ||
        [...link.job.unmodeledInvocations].some(
          (caller) => caller !== link.caller || link.job.nonShellInvocations.has(caller)
        )
      )
        return true;
    }
    return false;
  }
  queue(request.command, request.cwd, 0, (location) => location);
  for (let cursor = 0; cursor < jobs.length && !exhausted; cursor++) {
    const job = jobs[cursor]!;
    const finiteCallees = new Set<string>();
    const metadataInvocations = new Set<string>();
    const span = (location: Location): Location => job.map(location);
    const parent = (node: Location, state: State): NonNullable<ScriptJob['parent']> => ({
      job,
      caller: JSON.stringify([node.pos, node.end]),
      inheritedEffects: state.filesystemChanged === true,
      // An inherited environment entry is exported. Preserve only proven
      // disabled pager bindings; absent entries must not become child variables.
      disabledPagers: new Map(
        [...state.bindings].filter(
          ([name, values]) =>
            (name === 'GIT_PAGER' || name === 'PAGER') &&
            process.env[name] !== undefined &&
            values !== null &&
            values.length > 0 &&
            values.every((value) => value === '' || value === 'cat')
        )
      ),
      // Export attributes are not modeled. Rebinding an inherited exported
      // variable changes a child process's environment, so its original
      // launcher value cannot supply proof for nested Git coordinates.
      gitEnvironmentUnresolved:
        job.parent?.gitEnvironmentUnresolved === true ||
        [...state.bindings].some(([name, values]) => {
          if (name !== 'PAGER' && !name.startsWith('GIT_')) return false;
          if (
            (name === 'PAGER' || name === 'GIT_PAGER') &&
            values &&
            values.length > 0 &&
            values.every((value) => value === '' || value === 'cat')
          )
            return false;
          if (name === 'PAGER') return true;
          return !values || values.length !== 1 || values[0] !== process.env[name];
        }),
    });
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
        // env's assignment names need not be shell identifiers. An unsupported
        // binding cannot become a fictitious executable hiding the real child.
        if (
          args[offset]?.value?.startsWith('-') ||
          (name === 'env' && args[offset]?.value?.includes('='))
        ) {
          issue(
            'mutation-wrapper-option',
            'Wrapper option or assignment effects are not modeled.',
            span(node)
          );
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
      let selected: { argument: Argument; code: string; stdin: false } | undefined;
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
        const long = language === 'node' && value.startsWith('--eval=');
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
          if (
            language === 'node' &&
            (code.value.startsWith('-') ||
              code.value.startsWith('\\-') ||
              (['-p', '--print'].includes(value) && code.value === ''))
          ) {
            issue(
              'mutation-code-source',
              'Node code-operand option or escape semantics are outside this profile.',
              argSpan(code, node)
            );
            return null;
          }
          if (language !== 'node') return { argument: code, code: code.value, stdin: false };
          if (selected) {
            issue(
              'mutation-code-source',
              'Multiple Node code selectors are not modeled.',
              argSpan(arg, node)
            );
            return null;
          }
          selected = { argument: code, code: code.value, stdin: false };
          // Node keeps parsing options after an eval/print operand. Returning
          // here would hide preloads and later replacements of the eval source.
          index += 2;
          continue;
        }
        if (long) {
          if (selected || value === '--eval=') {
            issue(
              'mutation-code-source',
              'Node code selection is repeated or empty.',
              argSpan(arg, node)
            );
            return null;
          }
          selected = { argument: arg, code: value.slice('--eval='.length), stdin: false };
          index++;
          continue;
        }
        if (short) return { argument: arg, code: value.slice(2), stdin: false };
        if (value === '-') return selected ?? { stdin: true };
        if (value === '--')
          return selected ?? { stdin: index + 1 >= args.length || args[index + 1]?.value === '-' };
        if (!value.startsWith('-')) return selected ?? { stdin: false };
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
      return selected ?? { stdin: true };
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
      if (name === 'git' && job.parent?.gitEnvironmentUnresolved)
        issue(
          'mutation-shell-environment',
          'Source-selected Git environment has no proven nested export state.',
          span(node)
        );
      if (name !== 'bash') job.nonShellInvocations.add(JSON.stringify([node.pos, node.end]));
      if (UNPROFILED_BUILTINS.has(name)) {
        issue(
          'mutation-shell-builtin',
          'Shell builtin state or execution effects are not modeled.',
          span(node)
        );
        return;
      }
      finiteCallees.add(JSON.stringify([node.pos, node.end]));
      if (name === 'cp' || name === 'mv') {
        const original = span(node);
        const identity: CopyInvocation = {
          operation: name,
          start: original.pos,
          end: original.end,
        };
        view.copyInvocations.push(identity);
        const unresolved = (message: string): void => {
          view.copyOperations.push({
            ...identity,
            knowledge: 'unresolved',
            sources: [],
            destination: null,
            directoryMode: null,
            cwd: request.cwd === null ? null : state.cwd,
          });
          issue('mutation-copy-roles', message, original);
        };
        const commandOffset = argv[1]?.value === '--' ? 2 : 1;
        const commandWrapper =
          argv[0]?.value === 'command' && argv.length - args.length === commandOffset;
        if (
          (args !== argv && !commandWrapper) ||
          unwrapped.environment ||
          node.prefix.some((part) => part.type === 'Assignment') ||
          executable !== name ||
          state.bindings.has('PATH') ||
          state.bindings.has('LD_PRELOAD') ||
          state.bindings.has('DYLD_INSERT_LIBRARIES') ||
          process.env[`BASH_FUNC_${name}%%`] !== undefined
        ) {
          unresolved('Copy or move executable selection and environment are not proven.');
          return;
        }
        if (args.length === 2 && ['--help', '--version'].includes(args[1]?.value ?? '')) {
          view.copyOperations.push({
            ...identity,
            knowledge: 'readonly',
            sources: [],
            destination: null,
            directoryMode: null,
            cwd: request.cwd === null ? null : state.cwd,
          });
          return;
        }
        if (
          state.filesystemChanged === true ||
          args.some((arg) => arg.value === null || arg.value.length === 0)
        ) {
          unresolved('Copy or move operands or preceding filesystem effects are unresolved.');
          return;
        }
        const operands: string[] = [];
        let directory: string | null = null,
          options = true,
          delimiter = false;
        for (let index = 1; index < args.length; index++) {
          const value = args[index]!.value!;
          if (options && value === '--') {
            options = false;
            delimiter = true;
            continue;
          }
          if (options && (value === '-t' || value === '--target-directory')) {
            if (directory !== null || index + 1 >= args.length) {
              unresolved('A single target directory requires one proven operand.');
              return;
            }
            directory = args[++index]!.value!;
            continue;
          }
          if (options && value.startsWith('--target-directory=')) {
            if (directory !== null || value === '--target-directory=') {
              unresolved('A single nonempty target directory is required.');
              return;
            }
            directory = value.slice('--target-directory='.length);
            continue;
          }
          if (
            options &&
            [
              '-f',
              '--force',
              '-i',
              '--interactive',
              '-n',
              '--no-clobber',
              '-v',
              '--verbose',
            ].includes(value)
          )
            continue;
          if (options && name === 'cp' && value === '-p') continue;
          if (!delimiter && value.startsWith('-') && value !== '-') {
            unresolved('Copy or move option semantics are outside the closed file profile.');
            return;
          }
          options = false;
          operands.push(value);
        }
        if (operands.length < (directory === null ? 2 : 1)) {
          unresolved('Copy or move requires proven source and destination operands.');
          return;
        }
        const destination = directory ?? operands.pop()!;
        if (!operands.every((value) => text(value, original)) || !text(destination, original)) {
          unresolved('Copy or move path observations exceeded the projection budget.');
          return;
        }
        view.copyOperations.push({
          ...identity,
          knowledge: 'finite',
          sources: operands,
          destination,
          directoryMode: directory === null ? 'auto' : 'directory',
          cwd: request.cwd === null ? null : state.cwd,
        });
        return;
      }
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
      if (language) {
        const original = span(node);
        view.interpreterInvocations.push({ language, start: original.pos, end: original.end });
      }
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
        if (shell)
          queue(selected.code, state.cwd, job.depth + 1, () => original, parent(node, state));
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
              queue(
                body,
                state.cwd,
                job.depth + 1,
                (location) =>
                  span({ pos: last.body.pos + location.pos, end: last.body.pos + location.end }),
                parent(node, state)
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
        // Source profiles establish effects only under the declared controlled
        // interpreter host. Submitted environment/startup changes and script
        // files cannot borrow the profile of a literal payload.
        const startupChanged =
          unwrapped.environment ||
          node.prefix.some((part) => part.type === 'Assignment') ||
          [...state.bindings.keys()].some((key) =>
            language === 'node' ? nodeStartupBinding(key) : key.startsWith('PYTHON')
          ) ||
          // This profile permits only literal builtin fs imports. Node resolves
          // those before NODE_PATH's fallback lookup for nonbuiltin modules.
          // Known startup controls include coverage/compile-cache writers and
          // native configuration loaders. Only known inactive empty settings
          // can be omitted; a source rebind above never borrows that exception.
          (language === 'node'
            ? Object.keys(process.env).some(
                (key) =>
                  nodeStartupBinding(key) &&
                  key !== 'NODE_PATH' &&
                  !(['NODE_OPTIONS', 'NODE_V8_COVERAGE'].includes(key) && process.env[key] === '')
              )
            : Object.keys(process.env).some((key) => key.startsWith('PYTHON')));
        const effects: MutationInterpreter['effects'] = startupChanged
          ? {
              kind: 'unresolved',
              profile: null,
              reason: 'Interpreter environment or startup effects are not proven.',
              writes: [],
            }
          : payloads.length !== 1
            ? {
                kind: 'unresolved',
                profile: null,
                reason: 'Exactly one literal inline or here-document source is required.',
                writes: [],
              }
            : classifyInterpreterEffects(language, payloads[0]!.text);
        if (effects.kind === 'unresolved')
          issue('mutation-interpreter-effects', effects.reason, original);
        view.interpreters.push({
          language,
          argv: args.map((arg) => arg.value),
          payloads,
          effects,
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
      if (kind === 'redirect') job.writeRedirect = true;
      for (const fields of targets) {
        token(node.operator, kind, false, span(node), state.cwd);
        for (const arg of fields)
          token(arg.value ?? raw(arg), 'word', arg.value === null, argSpan(arg, node), state.cwd);
        token(';', 'op', false, span({ pos: node.end, end: node.end }), state.cwd);
      }
    };
    const observeGitMetadata = ({ node, subcommand, input }: GitMetadataObservation): void => {
      metadataInvocations.add(JSON.stringify([node.pos, node.end]));
      if (exhausted) return;
      const original = span(node);
      if (
        request.cwd === null ||
        input === null ||
        inheritedEffects(job) ||
        job.parent?.gitEnvironmentUnresolved
      ) {
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
        ...(job.parent ? { inheritedBindings: job.parent.disabledPagers } : {}),
        observers: {
          invocation: observeInvocation,
          redirection: observeRedirect,
          gitMetadata: observeGitMetadata,
        },
      }
    );
    for (const reason of analysis.reasons) {
      if (reason.code === 'utility-unsupported')
        job.unmodeledInvocations.add(JSON.stringify([reason.start, reason.end]));
      // Pin-policy mapping uncertainty matters to this consumer only when a
      // recognized metadata write actually needs that mapping for ownership.
      // This is a write-target recognizer, not an admission verdict for reads.
      if (
        reason.code === 'git-context-changed' &&
        !metadataInvocations.has(JSON.stringify([reason.start, reason.end]))
      )
        continue;
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
