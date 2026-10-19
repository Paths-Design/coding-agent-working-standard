import type {
  Assignment,
  Command,
  ParsedScript,
  PipelineNode,
  AndOr,
  Redirection,
  Statement,
  Word,
} from './parser-types';
import { loadParser } from './load-parser';
import { inside, inspectInvocation, resolveDirectory, sensitiveBinding } from './policies';
import { basename, dirname } from 'node:path';
import { resolveGitContext } from './git-context';
import type { GitContext, GitDiscoveryFailure } from './git-context';
import { expandWord } from './words';
import type {
  AnalysisContext,
  AnalysisDependencies,
  AnalysisRequest,
  AnalysisResult,
  Argument,
  Location,
  State,
  Value,
} from './types';
export type { AnalysisRequest, AnalysisResult } from './types';

const MAX_BYTES = 65536;
const MAX_STATES = 32;
const MAX_DEPTH = 16;
const MAX_VISITS = 4096;
const clone = (state: State): State => ({ ...state, bindings: new Map(state.bindings) });

/** A bounded abstract interpreter. It inspects source; it never executes it. */
export async function analyzeCommand(
  request: AnalysisRequest,
  dependencies: AnalysisDependencies = {}
): Promise<AnalysisResult> {
  const result: AnalysisResult = { decision: 'allow', reasons: [], trace: [] };
  const whole = { pos: 0, end: request.command.length };
  const reason: AnalysisContext['reason'] = (node, code, message, deny = false) => {
    if (deny) result.decision = 'deny';
    else if (result.decision === 'allow') result.decision = 'unresolved';
    const start = Math.max(0, Math.min(request.command.length, node.pos));
    const end = Math.max(start, Math.min(request.command.length, node.end));
    if (
      !result.reasons.some(
        (item) =>
          item.code === code && item.start === start && item.end === end && item.message === message
      )
    ) {
      result.reasons.push({ code, message, start, end });
    }
  };
  if ((request.shell ?? 'bash') !== 'bash')
    reason(whole, 'shell-dialect', 'Only the declared Bash subset is supported.');
  if (Buffer.byteLength(request.command, 'utf8') > MAX_BYTES || request.command.includes('\0')) {
    reason(whole, 'source-budget', 'Command exceeds 64 KiB or contains a NUL byte.');
    return result;
  }
  const worktree = resolveDirectory(dependencies.context?.worktree ?? request.worktree, '/');
  const marker = request.worktree.indexOf('/.caws/worktrees/');
  const canonical = dependencies.context
    ? resolveDirectory(dependencies.context.canonical, '/')
    : marker < 0
      ? null
      : resolveDirectory(request.worktree.slice(0, marker), '/');
  const cwd = resolveDirectory(request.cwd, '/');
  if (!worktree || !canonical || !cwd) {
    reason(
      whole,
      'context-unresolved',
      'Existing cwd, worktree, and canonical repository paths are required.'
    );
    return result;
  }
  if (result.decision !== 'allow') return result;
  const gitContexts = new Map<string, GitContext | null>();
  let discoveryRetryAvailable = true;
  const ctx: AnalysisContext = {
    result,
    worktree,
    canonical,
    outside: !inside(cwd, worktree),
    visits: 0,
    gitInvocations: [],
    ...(dependencies.observers?.gitMetadata
      ? { gitMetadata: dependencies.observers.gitMetadata }
      : {}),
    gitContext: (input) => {
      const key = JSON.stringify([input.cwd, Object.entries(input.overrides).sort()]);
      if (gitContexts.has(key)) return gitContexts.get(key)!;
      if (gitContexts.size >= 8) {
        reason(
          whole,
          'git-discovery-budget',
          'At most eight distinct Git discovery contexts are inspected.'
        );
        return null;
      }
      const query = () => {
        const attempt: { context: GitContext | null; failure?: GitDiscoveryFailure } = {
          context: null,
        };
        attempt.context = (dependencies.gitContext ?? resolveGitContext)(input, (failure) => {
          attempt.failure = failure;
        });
        return attempt;
      };
      let attempt = query();
      if (
        attempt.context === null &&
        attempt.failure === 'git-discovery-timeout' &&
        discoveryRetryAvailable
      ) {
        discoveryRetryAvailable = false;
        attempt = query();
      }
      if (attempt.failure) {
        const failure = attempt.failure;
        reason(
          whole,
          failure,
          failure === 'git-discovery-timeout'
            ? 'Read-only Git discovery exceeded its 500 ms budget; inspect host load and retry.'
            : failure === 'git-discovery-protocol'
              ? 'Read-only Git discovery returned an unsupported protocol or repository kind.'
              : 'Read-only Git discovery failed; inspect Git availability and repository paths.'
        );
        attempt.context = null;
      }
      gitContexts.set(key, attempt.context);
      return attempt.context;
    },
    reason,
    trace: (node, kind, detail) =>
      result.trace.push({ kind, detail, start: node.pos, end: node.end }),
  };
  const initial: State = { cwd, bindings: new Map() };
  const budgetExhausted = Symbol();
  // Shell startup/aliases/functions and executable identity are a declared host
  // contract, not a fact the source parser can establish. Refuse known inherited
  // overrides rather than pretending they cannot affect profiled programs.
  for (const [name, value] of Object.entries(process.env)) {
    if (
      name.startsWith('BASH_FUNC_') &&
      !/^(?:command|env|git|caws|cd|sed|printf|echo|pwd|true|false|:|test|\[|read|rg|grep|cat|head|tail|wc|ls|cut|tr|sort|uniq)%%$/.test(
        name.slice(10)
      )
    )
      continue;
    if (
      value !== undefined &&
      (/^(?:GIT_|BASH_FUNC_)/.test(name) ||
        [
          'BASH_ENV',
          'ENV',
          'RIPGREP_CONFIG_PATH',
          'GLOBIGNORE',
          'CDPATH',
          'POSIXLY_CORRECT',
        ].includes(name))
    ) {
      initial.bindings.set(name, [value]);
      if (!name.startsWith('GIT_'))
        reason(whole, 'inherited-environment', `Unmodeled inherited environment ${name}.`);
    }
    if (name === 'BASHOPTS' && value?.split(':').includes('lastpipe'))
      reason(
        whole,
        'inherited-environment',
        'Bash lastpipe conflicts with the declared pipeline-state model.'
      );
    if (
      name === 'SHELLOPTS' &&
      value?.split(':').some((option) => ['posix', 'keyword'].includes(option))
    )
      reason(
        whole,
        'inherited-environment',
        'Inherited SHELLOPTS enables an unsupported assignment mode (posix or keyword).'
      );
  }

  for (const [name, value] of dependencies.inheritedBindings ?? [])
    initial.bindings.set(name, value === null ? null : [...value]);

  function budget(node: Location, depth: number): void {
    if (++ctx.visits > MAX_VISITS || depth > MAX_DEPTH) {
      reason(node, 'analysis-budget', 'AST visit/depth budget exceeded.');
      throw budgetExhausted;
    }
  }
  function bounded(states: State[], node: Location): State[] {
    const unique = new Map<string, State>();
    for (const state of states) {
      const key = JSON.stringify([
        state.cwd,
        state.filesystemChanged === true,
        [...state.bindings].sort(([a], [b]) => a.localeCompare(b)),
      ]);
      unique.set(key, state);
      if (unique.size > MAX_STATES) {
        reason(node, 'state-budget', 'Control-flow alternatives exceed 32 states.');
        return [];
      }
    }
    return [...unique.values()];
  }
  function script(tree: ParsedScript, states: State[], reader: boolean, depth: number): State[] {
    if (tree.errors?.length) {
      reason(tree, 'parse-error', 'Parser recovery is not an admission proof.');
      return states;
    }
    return list(tree.commands, states, reader, depth);
  }
  function substitution(tree: ParsedScript, state: State, depth: number): void {
    const outputs = script(tree, [clone(state)], true, depth);
    // Bindings and cwd are local to the producer; filesystem effects are shared.
    if (outputs.some((output) => output.filesystemChanged === true)) state.filesystemChanged = true;
    ctx.trace(
      tree,
      'substitution',
      'Producer inspected without execution; output remains opaque data.'
    );
  }
  function word(node: Word, state: State, depth: number, assignment = false): Argument[][] {
    budget(node, depth);
    return expandWord(node, state, ctx, substitution, depth, assignment).map((variant) =>
      variant.map((argument) => ({ ...argument, source: { pos: node.pos, end: node.end } }))
    );
  }
  function assign(node: Assignment, state: State, depth: number): State {
    const next = clone(state);
    if (sensitiveBinding(node.name) || node.name.startsWith('BASH'))
      reason(node, 'environment-change', `Unmodeled shell environment change ${node.name}.`);
    if (node.append || node.index || node.value.type !== 'Word') {
      reason(
        node,
        'assignment-syntax',
        'Array, append, and indexed assignments are outside the admitted subset.'
      );
      next.bindings.set(node.name, null);
      return next;
    }
    const expanded = word(node.value, state, depth, true);
    if (state.filesystemChanged === true) next.filesystemChanged = true;
    const values: string[] = [];
    let unknown = false;
    for (const variant of expanded) {
      if (variant.length !== 1 || variant[0]!.value === null) unknown = true;
      else values.push(variant[0]!.value!);
    }
    next.bindings.set(node.name, unknown ? null : [...new Set(values)]);
    ctx.trace(
      node,
      'assignment',
      `Tracked ${node.name} in source order (${unknown ? 'opaque' : `${values.length} finite value(s)`}).`
    );
    return next;
  }
  function redirect(node: Redirection, state: State, reader: boolean, depth: number): void {
    if (node.descriptor?.type === 'FileDescriptorVariable') {
      reason(
        node.descriptor,
        'redirect-variable',
        'Named file descriptor allocation or closure is outside the admitted binding model.'
      );
      return;
    }
    if (node.type === 'HereDoc') {
      if (!node.delimiter) reason(node, 'heredoc-delimiter', 'Here-document delimiter is missing.');
      if (!node.delimiter?.quoted && node.body.parts?.length) {
        word(
          {
            type: 'Word',
            text: node.body.text,
            value: node.body.text,
            pos: node.body.pos,
            end: node.body.end,
            parts: node.body.parts,
          },
          state,
          depth,
          true
        );
      }
      return;
    }
    if (node.type === 'HereString') {
      const targets = node.target ? word(node.target, state, depth, true) : [];
      dependencies.observers?.redirection?.({ node, targets, state: clone(state), reader });
      return;
    }
    if (!node.target) {
      reason(node, 'redirect-target', 'Redirection has no proven target.');
      return;
    }
    const values = word(node.target, state, depth);
    dependencies.observers?.redirection?.({ node, targets: values, state: clone(state), reader });
    if (['>&', '<&'].includes(node.operator)) {
      if (values.some((args) => args.length !== 1 || !/^(?:[0-9]+|-)$/.test(args[0]?.value ?? '')))
        reason(node, 'redirect-descriptor', 'Only literal descriptor duplication is modeled.');
      return;
    }
    if (reader && node.operator !== '<')
      reason(
        node,
        'substitution-effects',
        'Read substitutions cannot contain output redirections.'
      );
    if (
      node.operator !== '<' &&
      values.some((args) => args.length !== 1 || args[0]?.value !== '/dev/null')
    )
      state.filesystemChanged = true;
    for (const args of values) {
      const value = args.length === 1 ? args[0]?.value : null;
      if (value === null || value === undefined)
        reason(node, 'redirect-target', 'Redirection requires a known single target.');
      else if (node.operator !== '<') {
        const parent = resolveDirectory(dirname(value), state.cwd);
        const common = resolveDirectory(`${ctx.canonical}/.git`, '/');
        const destination =
          resolveDirectory(value, state.cwd) ?? (parent && `${parent}/${basename(value)}`);
        if (
          basename(destination ?? value).toLowerCase() === '.git' ||
          (destination && common && inside(destination, common))
        )
          reason(
            node,
            'repository-mapping-write',
            'Submitted writes to Git metadata invalidate repository routing assumptions.'
          );
      }
    }
  }
  function command(node: Command, state: State, reader: boolean, depth: number): State[] {
    ctx.trace(
      node,
      'command',
      'Inspect executable, argument roles, prefix environment, and redirections.'
    );
    // argv is expanded using the old shell state, before prefix assignments.
    let vectors: Argument[][] = [[]];
    const words: Word[] = node.name ? [node.name] : [];
    for (const suffix of node.suffix) {
      if (suffix.type === 'Word') words.push(suffix);
      else if (suffix.type === 'Assignment') {
        // The pinned parser reserves these arguments for declaration commands,
        // none of which has an admitted profile. Inspect the original RHS for
        // nested producers without inventing argv or changing parent bindings.
        reason(
          suffix,
          'command-assignment',
          'Declaration assignment arguments have no admitted program profile.'
        );
        if (suffix.value.type === 'Word') word(suffix.value, state, depth + 1, true);
      }
    }
    for (const part of words) {
      const variants = word(part, state, depth + 1);
      if (vectors.length * variants.length > MAX_STATES) {
        reason(node, 'argument-budget', 'Argument alternatives exceed 32 vectors.');
        return [state];
      }
      vectors = vectors.flatMap((left) => variants.map((right) => [...left, ...right]));
    }
    let assigned = clone(state);
    for (const prefix of node.prefix) {
      if (prefix.type === 'Assignment') assigned = assign(prefix, assigned, depth + 1);
      else redirect(prefix, state, reader, depth + 1);
    }
    for (const suffix of node.suffix)
      if (suffix.type !== 'Word' && suffix.type !== 'Assignment')
        redirect(suffix, state, reader, depth + 1);
    if (assigned.filesystemChanged === true) state.filesystemChanged = true;
    assigned.filesystemChanged = state.filesystemChanged === true;
    if (!node.name) return [assigned];
    const env = new Map<string, Value>();
    for (const [name, value] of assigned.bindings)
      if (name.startsWith('GIT_') || name === 'PAGER') env.set(name, value);
    const out = vectors.flatMap((argv) => {
      const before = clone(state);
      dependencies.observers?.invocation?.({
        node,
        argv: argv.map((argument) => ({ ...argument })),
        state: clone(before),
        environment: new Map(env),
        reader,
      });
      const next = inspectInvocation(argv, before, env, ctx, node, reader);
      // A directory change can fail. Keeping both states also avoids treating
      // a failed cd as a successful repair of a preceding foreign directory.
      return next.cwd !== before.cwd ? [before, next] : [next];
    });
    return bounded(out, node);
  }
  function walk(node: PipelineNode | AndOr, state: State, reader: boolean, depth: number): State[] {
    budget(node, depth);
    switch (node.type) {
      case 'Command':
        return command(node, state, reader, depth);
      case 'AndOr': {
        let states = walk(node.commands[0]!, state, reader, depth + 1);
        for (const next of node.commands.slice(1))
          states = bounded(
            [...states, ...states.flatMap((item) => walk(next, clone(item), reader, depth + 1))],
            node
          );
        return states;
      }
      case 'Pipeline': {
        if (node.prefixes.length)
          reason(node, 'pipeline-prefix', 'Pipeline prefixes are outside the admitted subset.');
        if (node.commands.length === 1) return walk(node.commands[0]!, state, reader, depth + 1);
        const firstGit = ctx.gitInvocations.length;
        let filesystemChanged = state.filesystemChanged === true;
        for (const next of node.commands) {
          const outputs = walk(next, clone(state), reader, depth + 1);
          filesystemChanged ||= outputs.some((item) => item.filesystemChanged === true);
        }
        // Pipeline members run concurrently. A sibling's effects invalidate
        // every Git mapping observation in this pipeline, in either order.
        if (filesystemChanged)
          for (const invocation of ctx.gitInvocations.slice(firstGit))
            reason(
              invocation,
              'git-context-changed',
              'Concurrent pipeline effects invalidate the filesystem context used for Git admission.'
            );
        // Declared host contract: Bash lastpipe is disabled.
        return [{ ...state, filesystemChanged }];
      }
      case 'Subshell': {
        const outputs = list(node.body.commands, [clone(state)], reader, depth + 1);
        return [
          {
            ...state,
            filesystemChanged:
              state.filesystemChanged === true ||
              outputs.some((item) => item.filesystemChanged === true),
          },
        ];
      }
      case 'BraceGroup':
        return list(node.body.commands, [state], reader, depth + 1);
      case 'If': {
        let remaining = list(node.clause.commands, [clone(state)], reader, depth + 1);
        const branches = list(node.then.commands, remaining.map(clone), reader, depth + 1);
        for (const branch of node.elif) {
          remaining = list(branch.clause.commands, remaining, reader, depth + 1);
          branches.push(...list(branch.then.commands, remaining.map(clone), reader, depth + 1));
        }
        branches.push(
          ...(node.else ? list(node.else.commands, remaining, reader, depth + 1) : remaining)
        );
        return bounded(branches, node);
      }
      case 'For': {
        if (
          !node.wordlist ||
          !/^[A-Za-z_][A-Za-z_0-9]*$/.test(node.name.value) ||
          sensitiveBinding(node.name.value)
        ) {
          reason(
            node,
            'loop-input',
            'For loops require an explicit finite list and ordinary binding.'
          );
          return [state];
        }
        let sequences: Argument[][] = [[]];
        for (const item of node.wordlist) {
          const variants = word(item, state, depth + 1);
          if (sequences.length * variants.length > MAX_STATES) {
            reason(node, 'loop-budget', 'Loop alternatives exceed 32.');
            return [state];
          }
          sequences = sequences.flatMap((left) => variants.map((right) => [...left, ...right]));
        }
        const outputs: State[] = [];
        for (const sequence of sequences) {
          if (sequence.length > 32 || sequence.some((item) => item.value === null)) {
            reason(node, 'loop-budget', 'Loop requires at most 32 known iterations.');
            continue;
          }
          let states = [clone(state)];
          for (const item of sequence) {
            states = states.map((previous) => {
              const next = clone(previous);
              next.bindings.set(node.name.value, [item.value!]);
              return next;
            });
            states = list(node.body.commands, states, reader, depth + 1);
          }
          outputs.push(...states);
        }
        return bounded(outputs, node);
      }
      case 'Redirected':
        for (const redirection of node.redirects) redirect(redirection, state, reader, depth + 1);
        return walk(node.command, state, reader, depth + 1);
      default:
        reason(node, 'statement-syntax', `Unsupported statement: ${node.type}.`);
        return [state];
    }
  }
  function list(
    nodes: readonly Statement[],
    input: State[],
    reader: boolean,
    depth: number
  ): State[] {
    let states = input;
    for (const node of nodes) {
      budget(node, depth);
      if (node.background)
        reason(node, 'background', 'Background state and execution ordering are not modeled.');
      states = bounded(
        states.flatMap((state) => walk(node.command, state, reader, depth + 1)),
        node
      );
      if (!states.length) break;
    }
    return states;
  }
  try {
    const { parse } = await loadParser();
    script(parse(request.command), [initial], false, 0);
  } catch (error) {
    if (error !== budgetExhausted)
      reason(
        whole,
        'analysis-failure',
        'Parser or analyzer failed; no admission proof is available.'
      );
  }
  if (!request.command.trim())
    reason(whole, 'empty-command', 'No executable command was supplied.');
  return result;
}
