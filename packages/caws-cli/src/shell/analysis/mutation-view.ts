import { readdirSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import { analyzeCommand } from './analyze';
import { classifyInterpreterEffects } from './interpreter-effects';
import { resolveGitContext } from './git-context';
import type { GitContext, GitContextResolver } from './git-context';
import type { Command, Redirection } from './parser-types';
import {
  isShellBuiltin,
  namesGitMetadata,
  nodeStartupBinding,
  projectBuiltin,
  writesRelativeTarget,
} from './policies';
import type {
  Argument,
  GitMetadataObservation,
  GitWriteObservation,
  Location,
  State,
  Value,
} from './types';

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
  /** Inline source, or what this command writes to a program's entry file. */
  payloads: InterpreterPayload[];
  effects: ReturnType<typeof classifyInterpreterEffects>;
  /**
   * `inline` source is part of the command and is read here. A `program` is a
   * file, module or query this projection launches without reading.
   */
  launch: 'inline' | 'program';
  /** A program's entry file, when the command names one literally. */
  entry: string | null;
  /** The command also writes the entry file in a way its payloads do not show. */
  rewritten: boolean;
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
  subcommand: string;
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
    mappingChanged: boolean;
    cwdUnknown: boolean;
    logical: string | undefined;
    gitEnvironmentUnresolved: boolean;
    bindings: ReadonlyMap<string, Value>;
  };
  writeRedirect: boolean;
  /** An effect in this job can replace a repository mapping. */
  mappingEffects: boolean;
  /** Interpreter source had that effect, which this job's own state cannot show. */
  interpreterMapping: boolean;
  metadata: Location[];
  unmodeledInvocations: Set<string>;
  nonShellInvocations: Set<string>;
};
interface SubmittedFile {
  documents: (Location & { text: string; map: Mapping })[];
  /** The documents are everything this command puts in the file. */
  complete: boolean;
}
interface WrittenFile {
  path: string;
  before: SubmittedFile | undefined;
}
type HereDoc = Extract<Redirection, { type: 'HereDoc' }>;
/** How an interpreter or shell invocation selects the source it runs. */
type Selection =
  | { kind: 'code'; argument: Argument; code: string }
  | { kind: 'stdin' }
  | { kind: 'program'; entry: string | null; unknown?: Argument };
const MAX_TOKENS = 4096,
  MAX_DEPTH = 8,
  MAX_SCRIPTS = 32;
const MAX_SOURCE_BYTES = 65536,
  MAX_TEXT_BYTES = 262144;
const NODE_QUERIES = /^(?:-[vh]|--version|--help|--v8-options)$/;
/** Node modes that take files or nothing, and never a program from stdin. */
const NODE_PROGRAM_MODES = /^(?:-c|--check|--test|--run(?:=.*)?|--build-snapshot)$/;
const NODE_NEUTRAL = /^(?:--no-warnings|--input-type=(?:module|commonjs))$/;
/** Node options that take the next argument when no value is attached. */
const NODE_OPERANDS =
  /^(?:-r|--require|--import|--loader|--experimental-loader|-C|--conditions|--env-file(?:-if-exists)?|--title|--disable-warning|--watch-path|--test-(?:name-pattern|skip-pattern|reporter|reporter-destination|concurrency|shard|timeout))$/;
/** Source a command supplies to itself through an open descriptor. */
const STDIN_PATH = /^\/(?:dev\/(?:stdin|fd\/0)|proc\/self\/fd\/0)$/;
const DESCRIPTOR_PATH = /^\/(?:dev\/(?:stdin|fd\/|tty)|proc\/(?:self|[0-9]+)\/fd\/)/;
/**
 * Text every expansion of a word begins with, which no option or descriptor
 * path can. A leading tilde is a variable's value, so it is not such text.
 */
const LITERAL_START = /^["']?(?:\.?\w|\.{1,2}\/|\/(?!dev\/|proc\/)\w[\w.-]*\/)/;
/** A glob, every field of which begins as it does. */
const PLAIN_GLOB = /^[^$`]*$/;
/** A glob in a literal directory, which can be listed. */
const LISTED_GLOB = /^((?:[\w.@%+:,=-]+\/|\/)*)([\w.@%+:,=*?[\]!^-]+)$/;
/** Names a written file has when a launch of each kind would run it. */
const RUNNABLE = {
  shell: /(?:\.(?:ba|z|k|da)?sh|\/[^./]+)$/,
  python: /(?:\.pyw?|\/[^./]+)$/,
  node: /(?:\.[cm]?[jt]sx?|\/[^./]+)$/,
};
/** An argument that neither selects code nor is code that could write. */
const PLAIN_OPERAND = /^(?!-[A-Za-z]*[ceps]|--(?:eval|print))[\w@%+:,./=-]*$/;
const PYTHON_QUERIES = /^(?:-V+|-h|-\?|--version|--help(?:-[a-z]+)?)$/;
const SCRIPT_FILE = /\.(?:py|[cm]?[jt]sx?)$/;
/** Single-letter Bash options that leave how source is read unchanged. */
const BASH_NEUTRAL = /^[befhlmnuvxBCEHT]$/;
const BASH_NEUTRAL_LONG = /^--(?:norc|noprofile|login|verbose|noediting)$/;
const BASH_QUERIES = /^--(?:version|help)$/;
const BASH_NEUTRAL_NAMES =
  /^(?:braceexpand|errexit|errtrace|functrace|hashall|monitor|noclobber|noglob|notify|nounset|onecmd|pipefail|verbose|xtrace)$/;

/**
 * Lexical projection for the mutation-role consumer, never a scope verdict.
 * Programs retain the limited-recognizer residual however they are launched:
 * no extracted mutation is not proof that arbitrary code cannot write. An
 * issue means a write target, a directory it depends on, or source the shell
 * would run could not be established; a program without a profile is not one.
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
  const interpreterRows = new Set<string>();
  const submittedJobs = new Set<string>();
  /** Files this command has written so far, and the literal text it gave them. */
  const submittedFiles = new Map<string, SubmittedFile>();
  const redirectWrites = new Map<Redirection, WrittenFile | null>();
  // Zsh ignores case and underscores in an option's name.
  const vanishingGlobs = /nullglob/i.test(
    `${request.command} ${process.env.BASHOPTS ?? ''}`.replaceAll('_', '')
  );
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
      mappingEffects: false,
      interpreterMapping: false,
      metadata: [],
      unmodeledInvocations: new Set(),
      nonShellInvocations: new Set(),
    });
  }
  /** A mapping effect anywhere around a nested job may run before it. */
  function mappingUncertain(job: ScriptJob): boolean {
    for (let link = job.parent; link; link = link.job.parent)
      if (link.mappingChanged || link.job.mappingEffects) return true;
    return false;
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
    const metadataInvocations = new Set<string>();
    const span = (location: Location): Location => job.map(location);
    const parent = (node: Location, state: State): NonNullable<ScriptJob['parent']> => ({
      job,
      caller: JSON.stringify([node.pos, node.end]),
      inheritedEffects: state.filesystemChanged === true,
      mappingChanged: state.mappingChanged === true,
      cwdUnknown: state.cwdUnknown === true,
      logical: state.logical,
      bindings: new Map<string, Value>([
        // An inherited environment entry is exported. Preserve only proven
        // disabled pager bindings; absent entries must not become child variables.
        ...[...state.bindings].filter(
          ([name, values]) =>
            (name === 'GIT_PAGER' || name === 'PAGER') &&
            process.env[name] !== undefined &&
            values !== null &&
            values.length > 0 &&
            values.every((value) => value === '' || value === 'cat')
        ),
        // A nested shell starts from the launcher's value only while this one
        // still holds it; a rebinding may or may not have reached its child.
        ...['HOME', 'TMPDIR']
          .filter((name) => {
            const values = state.bindings.get(name);
            return values?.length !== 1 || values[0] !== process.env[name];
          })
          .map((name): [string, Value] => [name, null]),
      ]),
      // Export attributes are not modeled. Rebinding an inherited exported
      // variable changes a child process's environment, so its original
      // launcher value cannot supply proof for nested Git coordinates. Neither
      // can one this source has unset.
      gitEnvironmentUnresolved:
        job.parent?.gitEnvironmentUnresolved === true ||
        Object.keys(process.env).some(
          (name) => name.startsWith('GIT_') && !state.bindings.has(name)
        ) ||
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
    ): { args: Argument[]; environment: string[] } | null => {
      let args = argv;
      const environment: string[] = [];
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
        // `command -v`, a bare `env` and a redirecting `exec` run no program.
        if (name === 'command' && /^-[vV]$/.test(args[1]?.value ?? '')) return null;
        if (name !== 'command' && args.length === 1) return null;
        let offset = 1;
        if (args[offset]?.value === '--') offset++;
        if (name === 'env') {
          while (/^[A-Za-z_][A-Za-z_0-9]*=/.test(args[offset]?.value ?? '')) {
            environment.push(args[offset]!.value!.split('=', 1)[0]!);
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
    /** The text a here-document supplies; an unquoted one loses its escapes. */
    const supplied = ({ delimiter, body }: HereDoc): string =>
      delimiter?.quoted === false
        ? body.text.replace(/\\([\\$`\n])/g, (_, kept: string) => (kept === '\n' ? '' : kept))
        : body.text;
    /** Where supplied text came from: the whole body, once escapes are gone. */
    const suppliedMap = (document: HereDoc, map: Mapping): Mapping =>
      supplied(document) === document.body.text ? map : () => map(document.body);
    /** Why a here-document's text cannot be read at all. */
    const documentProblem = (document: HereDoc): [string, string, Location] | null => {
      if (!document.delimiter || !document.closing)
        return ['mutation-heredoc-source', 'Here-document source is incomplete.', document];
      if (
        document.operator === '<<-' ||
        job.command.slice(document.body.pos, document.body.end) !== document.body.text
      )
        return [
          'mutation-heredoc-source',
          'Here-document transformations lack an exact source map.',
          document.body,
        ];
      if (
        !document.delimiter.quoted &&
        document.body.parts?.some((part) => part.type !== 'Literal')
      )
        return [
          'mutation-code-expanded',
          'Expanded interpreter input is not proven literal code.',
          document.body,
        ];
      return null;
    };
    const documentText = (document: HereDoc): string | null => {
      const problem = documentProblem(document);
      if (!problem) return supplied(document);
      issue(problem[0], problem[1], span(problem[2]));
      return null;
    };
    const opaqueSelection = (arg: Argument, node: Location): null => {
      issue('mutation-code-source', 'Interpreter source selection is opaque.', argSpan(arg, node));
      return null;
    };
    const unmodeledOption = (arg: Argument, node: Location): null => {
      issue(
        'mutation-interpreter-option',
        'Interpreter option effects are not modeled.',
        argSpan(arg, node)
      );
      return null;
    };
    const missingCode = (code: Argument | undefined, node: Location): null => {
      issue(
        'mutation-code-source',
        'Interpreter code is not a finite argument.',
        code ? argSpan(code, node) : span(node)
      );
      return null;
    };
    /**
     * An operand that names a program, or source the command supplies through a
     * descriptor. A single unknown field is a program: beside nothing that could
     * be code, it cannot make this command's own text one. Several fields are
     * one too when their text starts literally, which makes the first a path and
     * the others its arguments; with nullglob there may be no first field.
     */
    const literalStart = (arg: Argument): boolean =>
      !vanishingGlobs && LITERAL_START.test(raw(arg));
    const plainGlob = (arg: Argument): boolean =>
      arg.several === true && literalStart(arg) && PLAIN_GLOB.test(raw(arg));
    const operand = (args: Argument[], index: number, node: Command): Selection | null => {
      const arg = args[index];
      if (!arg || arg.value === '-') return { kind: 'stdin' };
      if (arg.value === null) {
        const rest = args.slice(index + 1);
        return (arg.several !== true || literalStart(arg)) &&
          stdinRedirect(node) === undefined &&
          rest.every((item) =>
            item.value === null ? plainGlob(item) : PLAIN_OPERAND.test(item.value)
          )
          ? { kind: 'program', entry: null, unknown: arg }
          : opaqueSelection(arg, node);
      }
      if (STDIN_PATH.test(arg.value)) return { kind: 'stdin' };
      if (arg.descriptor === true || DESCRIPTOR_PATH.test(arg.value))
        return opaqueSelection(arg, node);
      return { kind: 'program', entry: arg.value };
    };
    /**
     * An option whose effect is unknown can change which source runs. Beside
     * literal code it would let that code stand in for another program, so it
     * is held there; a program launch claims nothing about the source it runs.
     */
    const selectNode = (args: Argument[], node: Command): Selection | null => {
      let selected: Selection | undefined;
      let unmodeled: Argument | undefined;
      let mode: Argument | undefined;
      // Without an attached value, the next argument may be the option's own.
      let ambiguous = false;
      const candidates: string[] = [];
      const settle = (chosen: Selection | null): Selection | null =>
        chosen?.kind === 'stdin' && unmodeled ? unmodeledOption(unmodeled, node) : chosen;
      for (let index = 1; index < args.length; index++) {
        const arg = args[index]!,
          value = arg.value;
        if (value === null) {
          // Past a possible entry file this is that program's own argument.
          if (!selected && candidates.length) continue;
          // A mode takes files alone, and an option may take the first field.
          if (selected || (arg.several === true ? ambiguous && !plainGlob(arg) : mode))
            return opaqueSelection(arg, node);
          return settle(operand(args, index, node));
        }
        if (value === '-' || value === '--') {
          if (selected || mode) break;
          if (candidates.length && value === '-') return unmodeledOption(unmodeled!, node);
          if (candidates.length) break;
          return settle(operand(args, value === '-' ? index : index + 1, node));
        }
        if (NODE_OPERANDS.test(value) || value === '--input-type') {
          const given = args[++index];
          if (given?.several === true) return opaqueSelection(given, node);
          if (value !== '--input-type' || !/^(?:module|commonjs)$/.test(given?.value ?? ''))
            unmodeled ??= arg;
          continue;
        }
        const attached = value.startsWith('--eval=');
        if (attached || /^(?:-e|-p|-pe|--eval|--print)$/.test(value)) {
          const code = attached ? arg : args[index + 1];
          if (!code || code.value === null) return missingCode(code, node);
          const text = attached ? value.slice('--eval='.length) : code.value;
          if (selected || (attached && text === '')) {
            issue(
              'mutation-code-source',
              'Node code selection is repeated or empty.',
              argSpan(arg, node)
            );
            return null;
          }
          if (
            !attached &&
            (/^\\?-/.test(text) || (text === '' && !/^(?:-e|--eval)$/.test(value)))
          ) {
            issue(
              'mutation-code-source',
              'Node code-operand option or escape semantics are outside this profile.',
              argSpan(code, node)
            );
            return null;
          }
          selected = { kind: 'code', argument: code, code: text };
          // Node keeps parsing options after an eval/print operand. Returning
          // here would hide preloads and later replacements of the eval source.
          if (!attached) index++;
          continue;
        }
        if (!value.startsWith('-')) {
          if (selected) break;
          if (!ambiguous) return settle(operand(args, index, node));
          if (arg.descriptor === true || DESCRIPTOR_PATH.test(value))
            return opaqueSelection(arg, node);
          candidates.push(value);
          continue;
        }
        if (NODE_QUERIES.test(value)) return { kind: 'program', entry: null };
        if (NODE_PROGRAM_MODES.test(value)) mode ??= arg;
        else if (!NODE_NEUTRAL.test(value)) {
          unmodeled ??= arg;
          ambiguous ||= !value.includes('=');
        }
      }
      const conflicting = unmodeled ?? mode;
      if (selected) return conflicting ? unmodeledOption(conflicting, node) : selected;
      // Its only candidate may be the option's own, leaving stdin the program.
      const input = stdinRedirect(node);
      if (candidates.length === 1 && !mode && input !== undefined && input.type !== 'Redirect')
        return unmodeledOption(unmodeled!, node);
      if (candidates.length || mode)
        return {
          kind: 'program',
          entry: candidates.find((value) => SCRIPT_FILE.test(value)) ?? null,
        };
      return unmodeled ? unmodeledOption(unmodeled, node) : { kind: 'stdin' };
    };
    const selectPython = (args: Argument[], node: Command): Selection | null => {
      let unmodeled: Argument | undefined;
      const settle = (chosen: Selection | null): Selection | null =>
        unmodeled && chosen !== null && chosen.kind !== 'program'
          ? unmodeledOption(unmodeled, node)
          : chosen;
      for (let index = 1; index < args.length; index++) {
        const arg = args[index]!,
          value = arg.value;
        if (value === null) return settle(operand(args, index, node));
        if (PYTHON_QUERIES.test(value)) return { kind: 'program', entry: null };
        if (value === '--') return settle(operand(args, index + 1, node));
        if (value === '-' || !value.startsWith('-')) return settle(operand(args, index, node));
        if (value === '--check-hash-based-pycs') {
          index++;
          continue;
        }
        if (value.startsWith('--')) {
          unmodeled ??= arg;
          continue;
        }
        for (let flag = 1; flag < value.length; flag++) {
          const letter = value[flag]!;
          const rest = value.slice(flag + 1);
          if (letter === 'c') {
            const code = rest === '' ? args[index + 1] : arg;
            if (!code || code.value === null) return missingCode(code, node);
            return settle({
              kind: 'code',
              argument: code,
              code: rest === '' ? code.value : rest,
            });
          }
          if (letter === 'm') return { kind: 'program', entry: null };
          if (letter === 'W' || letter === 'X') {
            if (rest === '' && args[++index]?.several === true)
              return opaqueSelection(args[index]!, node);
            break;
          }
          if (!'bBdEIOPqRsSuv'.includes(letter)) unmodeled ??= arg;
        }
      }
      return settle({ kind: 'stdin' });
    };
    const selectShell = (args: Argument[], node: Command): Selection | null => {
      let code = false,
        stdin = false;
      let unmodeled: Argument | undefined;
      const choose = (index: number): Selection | null => {
        const arg = args[index];
        if (code) {
          if (!arg || arg.value === null) return missingCode(arg, node);
          if (unmodeled) return unmodeledOption(unmodeled, node);
          return { kind: 'code', argument: arg, code: arg.value };
        }
        const chosen: Selection | null =
          stdin || !arg ? { kind: 'stdin' } : operand(args, index, node);
        return chosen?.kind === 'stdin' && unmodeled ? unmodeledOption(unmodeled, node) : chosen;
      };
      for (let index = 1; index < args.length; index++) {
        const arg = args[index]!,
          value = arg.value;
        if (value === null) return choose(index);
        // A lone dash ends options exactly as a double dash does.
        if (value === '--' || value === '-') return choose(index + 1);
        if (value.startsWith('--')) {
          if (BASH_QUERIES.test(value)) return { kind: 'program', entry: null };
          if (!BASH_NEUTRAL_LONG.test(value)) return unmodeledOption(arg, node);
          continue;
        }
        if (!/^[-+]/.test(value)) return choose(index);
        for (const letter of value.slice(1)) {
          if (letter === 'c') code = true;
          else if (letter === 's') stdin = true;
          else if (letter === 'O') {
            // A shopt name follows, and can change how the source is parsed.
            unmodeled ??= arg;
            if (args[++index]?.value === null) return opaqueSelection(args[index]!, node);
          } else if (letter === 'o') {
            const name = args[++index];
            if (name?.several === true) return opaqueSelection(name, node);
            if (!name || name.value === null || !BASH_NEUTRAL_NAMES.test(name.value))
              unmodeled ??= arg;
          } else if (!BASH_NEUTRAL.test(letter)) unmodeled ??= arg;
        }
      }
      return choose(args.length);
    };
    /** Where a written file is, when the directory it depends on is known. */
    const located = (target: string | null, state: State): string | null =>
      target === null || request.cwd === null || (state.cwdUnknown === true && !isAbsolute(target))
        ? null
        : resolve(state.cwd, target);
    /** Note that this command writes a file; its text is unread until recorded. */
    const written = (target: string | null, state: State): WrittenFile | null => {
      const path = located(target, state);
      if (path === null) return null;
      const before = submittedFiles.get(path);
      submittedFiles.set(path, { documents: before?.documents ?? [], complete: false });
      return { path, before };
    };
    /** Literal text `cat` or `tee` copies from a here-document into one file. */
    const recordDocument = (node: Command, name: string, args: Argument[], state: State): void => {
      const operands = args.slice(1).map(({ value }) => value);
      const outputs = node.redirects.filter((part) => redirectWrites.has(part));
      const output = outputs[0];
      let file: WrittenFile | null | undefined;
      if (name === 'tee' && operands.length === 1 && operands[0]?.startsWith('-') === false)
        file = written(operands[0], state);
      else if (name === 'cat' && outputs.length === 1 && operands.every((value) => value === '-'))
        file = redirectWrites.get(output!);
      const input = stdinRedirect(node);
      if (!file || input?.type !== 'HereDoc' || documentProblem(input)) return;
      const { pos, end } = input.body;
      const text = supplied(input);
      const documents = (file.before?.documents ?? []).filter((item) => item.text !== text);
      submittedFiles.set(file.path, {
        documents: [...documents, { text, pos, end, map: suppliedMap(input, job.map) }],
        complete: file.before?.complete !== false && output?.operator !== '>>',
      });
    };
    /** What this command wrote into the file a launch runs: any of its kind, if unknown. */
    const submittedBy = (
      { entry, unknown }: { entry: string | null; unknown?: Argument },
      kind: keyof typeof RUNNABLE,
      state: State
    ): SubmittedFile => {
      const file = submittedFiles.get(located(entry, state) ?? '');
      if (!unknown) return file ?? { documents: [], complete: true };
      const files = [...submittedFiles].filter(([path]) => RUNNABLE[kind].test(path));
      return { documents: files.flatMap(([, { documents }]) => documents), complete: true };
    };
    /**
     * The entry files a launch can have. A listed glob puts its first match
     * there, in whichever order the locale sorts; any other unknown is unread.
     */
    const entriesOf = (
      { entry, unknown }: { entry: string | null; unknown?: Argument },
      state: State
    ): (string | null)[] => {
      const [, directory, pattern] =
        (unknown?.several === true && LISTED_GLOB.exec(raw(unknown))) || [];
      const path = pattern === undefined ? null : located(directory || '.', state);
      if (path === null) return [entry];
      try {
        const matcher = new RegExp(
          `^${pattern!
            .replace(/[.+]/g, '\\$&')
            .replaceAll('*', '.*')
            .replaceAll('?', '.')
            .replaceAll('[!', '[^')}$`
        );
        const names = readdirSync(path).filter(
          (name) => matcher.test(name) && name.startsWith('.') === pattern!.startsWith('.')
        );
        const first = [names.sort()[0], names.sort((a, b) => a.localeCompare(b))[0]];
        const found = [...new Set(first)].flatMap((name) => (name ? [directory + name] : []));
        return found.length ? found : [entry];
      } catch {
        return [entry];
      }
    };
    /** Read a shell program this command wrote for itself; a loop runs it once. */
    const queueSubmitted = (
      launch: { entry: string | null; unknown?: Argument },
      node: Command,
      state: State
    ): void => {
      for (const document of submittedBy(launch, 'shell', state).documents) {
        if (/^#!/.test(document.text) && !/^#!.*\b(?:ba|z|da|k)?sh\b/.test(document.text)) continue;
        const context = parent(node, state);
        const key = JSON.stringify([
          { ...context, job: jobs.indexOf(job), bindings: [...context.bindings] },
          document.text,
          state.cwd,
        ]);
        if (submittedJobs.has(key)) continue;
        submittedJobs.add(key);
        queue(
          document.text,
          state.cwd,
          job.depth + 1,
          (location) =>
            document.map({ pos: document.pos + location.pos, end: document.pos + location.end }),
          context
        );
      }
    };
    /** Report one interpreter; a loop that repeats it adds nothing. */
    const interpreter = (
      row: Pick<
        MutationInterpreter,
        'language' | 'payloads' | 'effects' | 'launch' | 'entry' | 'rewritten'
      >,
      args: readonly Argument[],
      node: Command,
      state: State
    ): void => {
      const original = span(node);
      const complete: MutationInterpreter = {
        ...row,
        argv: args.map((arg) => arg.value),
        cwd: request.cwd === null || state.cwdUnknown === true ? null : state.cwd,
        start: original.pos,
        end: original.end,
      };
      const key = JSON.stringify(complete);
      if (interpreterRows.has(key)) view.interpreterInvocations.pop();
      else view.interpreters.push(complete);
      interpreterRows.add(key);
    };
    const unresolvedEffects = (reason: string): MutationInterpreter['effects'] => ({
      kind: 'unresolved',
      profile: null,
      reason,
      writes: [],
    });
    const invokes = (language: 'node' | 'python', node: Command): void => {
      const original = span(node);
      view.interpreterInvocations.push({ language, start: original.pos, end: original.end });
    };
    /** Report a program launch, with the text this command gave its entry file. */
    const launched = (
      language: 'node' | 'python',
      args: readonly Argument[],
      launch: { entry: string | null; unknown?: Argument },
      node: Command,
      state: State
    ): void => {
      const file = submittedBy(launch, language, state);
      const payloads: InterpreterPayload[] = [];
      for (const document of file.documents) {
        const original = document.map(document);
        if (!text(document.text, original)) return;
        payloads.push({
          text: document.text,
          origin: 'heredoc',
          start: original.pos,
          end: original.end,
        });
      }
      const effects = unresolvedEffects('The launched program is not read by this projection.');
      const rewritten = !file.complete;
      for (const entry of entriesOf(launch, state)) {
        invokes(language, node);
        interpreter(
          { language, payloads, effects, launch: 'program', entry, rewritten },
          args,
          node,
          state
        );
      }
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
      if (
        executable === name &&
        isShellBuiltin(name) &&
        projectBuiltin(name, args.slice(1), state) === null
      ) {
        issue(
          'mutation-shell-builtin',
          'This shell builtin can run or define code the projection cannot read.',
          span(node)
        );
        return;
      }
      if (
        state.cwdUnknown === true &&
        request.cwd !== null &&
        writesRelativeTarget(name, args.slice(1))
      )
        issue(
          'cwd-unresolved',
          'A relative write follows a directory change that could not be established.',
          span(node)
        );
      recordDocument(node, name, args, state);
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
          unwrapped.environment.length > 0 ||
          node.prefix.some((part) => part.type === 'Assignment') ||
          executable !== name ||
          state.bindings.has('PATH') ||
          [...state.bindings.keys()].some((key) => /^(?:LD_|DYLD_)/.test(key)) ||
          Object.keys(process.env).some((key) => /^(?:LD_|DYLD_)/.test(key)) ||
          process.env[`BASH_FUNC_${name}%%`] !== undefined
        ) {
          unresolved('Copy or move executable selection and environment are not proven.');
          return;
        }
        if (
          state.filesystemChanged === true ||
          inheritedEffects(job) ||
          args.some((arg) => arg.value === null || arg.value.length === 0)
        ) {
          unresolved('Copy or move operands or preceding filesystem effects are unresolved.');
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
        for (const source of operands)
          for (const target of [destination, `${destination}/${basename(source)}`])
            written(target, state);
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
        // A script file is a program in any dialect. Source in this command is
        // read as Bash, which sh does not promise to be.
        const selection = selectShell(args, node);
        if (selection?.kind !== 'program')
          issue(
            'mutation-shell-dialect',
            'sh execution does not establish the declared non-POSIX Bash model.',
            span(node)
          );
        else queueSubmitted(selection, node, state);
        return;
      }
      if (executable === '.' || executable === 'source') {
        queueSubmitted({ entry: args[1]?.value ?? null }, node, state);
        return;
      }
      const shell = name === 'bash';
      const language =
        name === 'node' || name === 'nodejs'
          ? 'node'
          : /^python(?:[0-9]+(?:\.[0-9]+)*)?$/.test(name)
            ? 'python'
            : null;
      if (!shell && !language) {
        // A program this command wrote runs as what its first line says it is.
        if (!executable.includes('/')) return;
        const first = submittedFiles.get(located(executable, state) ?? '')?.documents.at(-1)?.text;
        const runner = /^#!.*?\b(python|node)/.exec(first ?? '')?.[1];
        if (runner !== 'python' && runner !== 'node') {
          queueSubmitted({ entry: executable }, node, state);
          return;
        }
        launched(runner, [{ value: runner }, ...args], { entry: executable }, node, state);
        return;
      }
      const submitted = [
        ...unwrapped.environment,
        ...node.prefix.flatMap((part) => (part.type === 'Assignment' ? [part.name] : [])),
      ];
      const selected = (shell ? selectShell : language === 'node' ? selectNode : selectPython)(
        args,
        node
      );
      if (language && selected?.kind !== 'program') invokes(language, node);
      if (!selected) return;
      if (shell && selected.kind !== 'program' && submitted.length > 0)
        issue(
          'mutation-shell-environment',
          'Shell prefix environment is not a proven nested binding state.',
          span(node)
        );
      if (selected.kind === 'program') {
        if (language) launched(language, args, selected, node, state);
        else queueSubmitted(selected, node, state);
        return;
      }
      const payloads: InterpreterPayload[] = [];
      if (selected.kind === 'code') {
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
      } else if (selected.kind === 'stdin') {
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
                suppliedMap(last, (location) =>
                  span({ pos: last.body.pos + location.pos, end: last.body.pos + location.end })
                ),
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
      }
      if (language && !exhausted) {
        const original = span(node);
        // Source profiles establish effects only under the declared controlled
        // interpreter host. Submitted environment/startup changes and script
        // files cannot borrow the profile of a literal payload.
        const control = (name: string): boolean =>
          language === 'node' ? nodeStartupBinding(name) : name.startsWith('PYTHON');
        const submittedStartup =
          submitted.some(control) || [...state.bindings.keys()].some(control);
        const inheritedStartup =
          // This profile permits only literal builtin fs imports. Node resolves
          // those before NODE_PATH's fallback lookup for nonbuiltin modules.
          // Known startup controls include coverage/compile-cache writers and
          // native configuration loaders. Only known inactive empty settings
          // can be omitted; a source rebind above never borrows that exception.
          language === 'node' &&
          Object.keys(process.env).some(
            (key) =>
              nodeStartupBinding(key) &&
              key !== 'NODE_PATH' &&
              !(['NODE_OPTIONS', 'NODE_V8_COVERAGE'].includes(key) && process.env[key] === '')
          );
        const effects =
          submittedStartup || inheritedStartup
            ? unresolvedEffects('Interpreter environment or startup effects are not proven.')
            : payloads.length !== 1
              ? unresolvedEffects('Exactly one literal inline or here-document source is required.')
              : classifyInterpreterEffects(language, payloads[0]!.text);
        // Literal source whose startup the command itself replaces is not the
        // program that runs, and missing source cannot be read at all.
        if (submittedStartup || payloads.length !== 1)
          issue('mutation-interpreter-effects', (effects as { reason: string }).reason, original);
        for (const write of effects.writes) {
          if (namesGitMetadata(write.target)) job.interpreterMapping = true;
          if (state.cwdUnknown === true && request.cwd !== null && !isAbsolute(write.target))
            issue(
              'cwd-unresolved',
              'A relative write follows a directory change that could not be established.',
              original
            );
        }
        interpreter(
          { language, payloads, effects, launch: 'inline', entry: null, rewritten: false },
          args,
          node,
          state
        );
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
      if (kind === 'redirect') {
        job.writeRedirect = true;
        const files = targets.map((fields) =>
          written(fields.length === 1 ? fields[0]!.value : null, state)
        );
        redirectWrites.set(node, files.length === 1 ? files[0]! : null);
      }
      if (
        kind === 'redirect' &&
        state.cwdUnknown === true &&
        request.cwd !== null &&
        targets.some((fields) => fields.some((arg) => arg.value !== null && !isAbsolute(arg.value)))
      )
        issue(
          'cwd-unresolved',
          'A relative write follows a directory change that could not be established.',
          span(node)
        );
      for (const fields of targets) {
        token(node.operator, kind, false, span(node), state.cwd);
        for (const arg of fields)
          token(arg.value ?? raw(arg), 'word', arg.value === null, argSpan(arg, node), state.cwd);
        token(';', 'op', false, span({ pos: node.end, end: node.end }), state.cwd);
      }
    };
    /** A path Git writes is a target like any other utility's. */
    const observeGitWrite = ({
      node,
      target,
      source,
      located: known,
    }: GitWriteObservation): void => {
      if (exhausted) return;
      const original = span(node);
      if (!known && request.cwd !== null && target !== null && !isAbsolute(target))
        issue(
          'cwd-unresolved',
          'A relative write follows a directory change that could not be established.',
          original
        );
      const place = source ? span(source) : original;
      const raw = source ? job.command.slice(source.pos, source.end) : '';
      token('touch', 'word', false, original, job.cwd ?? request.project);
      token(target ?? raw, 'word', target === null, place, job.cwd ?? request.project);
      token(';', 'op', false, span({ pos: node.end, end: node.end }), job.cwd ?? request.project);
    };
    const observeGitMetadata = ({ node, subcommand, input }: GitMetadataObservation): void => {
      metadataInvocations.add(JSON.stringify([node.pos, node.end]));
      if (exhausted) return;
      const original = span(node);
      if (
        request.cwd === null ||
        input === null ||
        mappingUncertain(job) ||
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
      job.metadata.push(original);
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
        projection: {
          ...(job.cwd === null || job.parent?.cwdUnknown === true ? { cwdUnknown: true } : {}),
          ...(job.parent?.logical === undefined ? {} : { logical: job.parent.logical }),
        },
        ...(job.parent ? { inheritedBindings: job.parent.bindings } : {}),
        observers: {
          invocation: observeInvocation,
          redirection: observeRedirect,
          gitMetadata: observeGitMetadata,
          gitWrite: observeGitWrite,
          unprofiled: ({ node, code }) => {
            if (code === 'utility-unsupported')
              job.unmodeledInvocations.add(JSON.stringify([node.pos, node.end]));
          },
          mapping: () => {
            job.mappingEffects = true;
          },
        },
      }
    );
    for (const reason of analysis.reasons) {
      // Pin-policy mapping uncertainty matters to this consumer only when a
      // recognized metadata write actually needs that mapping for ownership.
      // This is a write-target recognizer, not an admission verdict for reads.
      if (
        reason.code === 'git-context-changed' &&
        !metadataInvocations.has(JSON.stringify([reason.start, reason.end]))
      )
        continue;
      issue(reason.code, reason.message, span({ pos: reason.start, end: reason.end }));
    }
  }
  // Nested sources run at their caller's position, which this order does not
  // preserve. A mapping effect in one can precede a metadata write in another.
  for (const effect of jobs)
    if (effect.mappingEffects || effect.interpreterMapping)
      for (const job of jobs)
        if (job !== effect || effect.interpreterMapping)
          for (const location of job.metadata)
            issue(
              'metadata-coordinate-unresolved',
              'Git metadata write coordinates are not proven.',
              location
            );
  return view;
}
