import type {
  Assignment,
  Command,
  ParsedScript,
  PipelineNode,
  AndOr,
  Redirection,
  Statement,
  TestExpression,
  Word,
} from './parser-types';
import { loadParser } from './load-parser';
import {
  exactOperands,
  inside,
  inspectInvocation,
  namesGitMetadata,
  projectionSensitiveBinding,
  resolveDirectory,
  sensitiveBinding,
} from './policies';
import { basename, dirname, isAbsolute } from 'node:path';
import { resolveGitContext } from './git-context';
import type { GitContext, GitDiscoveryFailure } from './git-context';
import { expandWord, inspectArithmetic } from './words';
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
// Projection visits constructs admission refuses on sight, so ordinary nesting
// reaches further before it stops.
const PROJECTION_DEPTH = 48;
const PROJECTION_VISITS = 16384;
const LOOP_PASSES = 3;
const MAX_ALTERNATIVES = 8;
// A word whose only uncertainty is how many fields it becomes matters to an
// invocation that names write targets, and to no other.
const FIELD_UNCERTAINTY = new Set(['unknown-splitting', 'pathname-expansion', 'positional-spread']);
/** Commands for which a prefix assignment changes how this shell reads source. */
const SHELL_STATE_COMMANDS =
  /^(?:\.|source|eval|cd|pushd|export|declare|typeset|local|readonly|set|builtin|command|env|exec|bash|sh|zsh|dash|ksh)$/;
const clone = (state: State): State => ({ ...state, bindings: new Map(state.bindings) });
const same = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);
/** Every value either alternative can hold, while there are few enough to list. */
function either(left: Value | undefined, right: Value | undefined): Value {
  if (!left || !right) return null;
  const values = [...new Set([...left, ...right])];
  return values.length <= MAX_ALTERNATIVES ? values : null;
}
/** Facts that hold in any alternative. A directory they disagree on is unknown. */
function widen(states: readonly State[]): State {
  const merged = clone(states[0]!);
  for (const state of states) {
    for (const name of new Set([...merged.bindings.keys(), ...state.bindings.keys()]))
      merged.bindings.set(name, either(merged.bindings.get(name), state.bindings.get(name)));
    if (state.cwd !== merged.cwd || state.cwdUnknown === true) merged.cwdUnknown = true;
    if (state.logical !== merged.logical) delete merged.logical;
    if (state.filesystemChanged === true) merged.filesystemChanged = true;
    if (state.mappingChanged === true) merged.mappingChanged = true;
  }
  delete merged.outcome;
  return merged;
}
/** One widened state per distinct directory. */
function join(states: readonly State[]): State[] {
  const groups = new Map<string, State[]>();
  for (const state of states) {
    const key = JSON.stringify([state.cwd, state.cwdUnknown === true, state.logical ?? null]);
    groups.set(key, [...(groups.get(key) ?? []), state]);
  }
  return [...groups.values()].map(widen);
}
function forget(state: State): State {
  const next = clone(state);
  for (const name of next.bindings.keys()) next.bindings.set(name, null);
  return { ...next, cwdUnknown: true, filesystemChanged: true, mappingChanged: true };
}
/** Filesystem effects outlive the subshell, pipeline or substitution that had them. */
function carryEffects(target: State, sources: readonly State[]): void {
  if (sources.some((source) => source.filesystemChanged === true)) target.filesystemChanged = true;
  if (sources.some((source) => source.mappingChanged === true)) target.mappingChanged = true;
}
function testOperands(expression: TestExpression): Word[] {
  switch (expression.type) {
    case 'TestUnary':
      return [expression.operand];
    case 'TestBinary':
      return [expression.left, expression.right];
    case 'TestLogical':
      return expression.operands.flatMap(testOperands);
    case 'TestNot':
      return testOperands(expression.operand);
    case 'TestGroup':
      return testOperands(expression.expression);
  }
}

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
  const mode = dependencies.projection;
  const projection = mode !== undefined;
  // Admission policy is one consumer's question. Projection observes the gap so
  // later facts can account for it, and leaves the command unrefused.
  const admission: AnalysisContext['admission'] = projection
    ? (node, code) => dependencies.observers?.unprofiled?.({ node, code })
    : reason;
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
    ...(mode
      ? {
          projection: mode,
          functions: new Map<string, PipelineNode[]>(),
          mapping: (node: Location) => dependencies.observers?.mapping?.(node),
        }
      : {}),
    reason,
    admission,
    trace: (node, kind, detail) =>
      result.trace.push({ kind, detail, start: node.pos, end: node.end }),
  };
  const initial: State = { cwd, bindings: new Map() };
  if (mode) {
    // The shell inherits these from the harness that also started the guard.
    // They are exact only until submitted source rebinds them.
    for (const name of ['HOME', 'TMPDIR']) {
      const value = process.env[name];
      if (value !== undefined && isAbsolute(value)) initial.bindings.set(name, [value]);
    }
    if (mode.cwdUnknown === true) initial.cwdUnknown = true;
    else {
      initial.bindings.set('PWD', [cwd]);
      initial.logical = mode.logical ?? request.cwd;
    }
  }
  const budgetExhausted = Symbol();
  const activeCalls: string[] = [];
  /** Open loops and calls, innermost last; a jump leaves its state with each. */
  const escapes: State[][] = [];
  /** Open subshells, innermost last; an exit ends only its own. */
  const subshells: State[][] = [];
  // Shell startup/aliases/functions and executable identity are a declared host
  // contract, not a fact the source parser can establish. Refuse known inherited
  // overrides rather than pretending they cannot affect profiled programs.
  for (const [name, value] of Object.entries(process.env)) {
    if (
      name.startsWith('BASH_FUNC_') &&
      !/^(?:command|env|git|caws|cd|sed|cp|mv|printf|echo|pwd|true|false|:|test|\[|read|rg|grep|cat|head|tail|wc|ls|cut|tr|sort|uniq)%%$/.test(
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
        (name === 'RIPGREP_CONFIG_PATH' ? admission : reason)(
          whole,
          'inherited-environment',
          `Unmodeled inherited environment ${name}.`
        );
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
    if (
      ++ctx.visits > (projection ? PROJECTION_VISITS : MAX_VISITS) ||
      depth > (projection ? PROJECTION_DEPTH : MAX_DEPTH)
    ) {
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
        state.cwdUnknown === true,
        state.logical ?? null,
        state.mappingChanged === true,
        state.outcome ?? null,
      ]);
      unique.set(key, state);
      if (unique.size > MAX_STATES) {
        if (projection) return [widen(states)];
        reason(node, 'state-budget', 'Control-flow alternatives exceed 32 states.');
        return [];
      }
    }
    return [...unique.values()];
  }
  /**
   * Visit a loop of unknown length. Each pass starts from what still holds after
   * the previous one; facts that keep changing are forgotten before the last.
   */
  function loop(
    state: State,
    node: Location,
    iterate: (entry: State[]) => { exits: State[]; next: State[] }
  ): State[] {
    const facts = (item: State): unknown => [
      item.cwd,
      [...item.bindings],
      item.cwdUnknown === true,
      item.logical ?? null,
      item.filesystemChanged === true,
      item.mappingChanged === true,
    ];
    let entry = [state];
    for (let pass = 0; ; pass++) {
      const { value: step, escaped } = jumping(() => iterate(entry.map(clone)));
      const joined = join([...entry, ...step.next, ...escaped]);
      const settled =
        joined.length === entry.length &&
        joined.every((item, index) => same(facts(item), facts(entry[index]!)));
      if (settled || pass === LOOP_PASSES) return bounded([...step.exits, ...escaped], node);
      entry = pass === LOOP_PASSES - 1 ? [forget(widen(joined))] : joined;
    }
  }
  /** Run a body that break, continue or return can leave, keeping those states. */
  function jumping<T>(run: () => T): { value: T; escaped: State[] } {
    const escaped: State[] = [];
    escapes.push(escaped);
    const value = run();
    escapes.pop();
    return { value, escaped };
  }
  /** Run source in a subshell: every state it can end in, including by exiting. */
  function contained(run: () => State[]): State[] {
    const exited: State[] = [];
    subshells.push(exited);
    const outputs = run();
    subshells.pop();
    return [...outputs, ...exited];
  }
  /** A call runs every body its name may hold, or none of them. */
  function call(
    name: string,
    bodies: readonly PipelineNode[],
    state: State,
    reader: boolean,
    depth: number
  ): State[] {
    if (activeCalls.includes(name)) return [forget(state)];
    activeCalls.push(name);
    const { value: outputs, escaped } = jumping(() =>
      bodies.flatMap((body) => walk(body, clone(state), reader, depth + 1))
    );
    activeCalls.pop();
    return join([state, ...outputs, ...escaped]);
  }
  function script(tree: ParsedScript, states: State[], reader: boolean, depth: number): State[] {
    if (tree.errors?.length) {
      reason(tree, 'parse-error', 'Parser recovery is not an admission proof.');
      return states;
    }
    return list(tree.commands, states, reader, depth);
  }
  function substitution(tree: ParsedScript, state: State, depth: number): void {
    // Bindings and cwd are local to the producer; filesystem effects are shared.
    carryEffects(
      state,
      contained(() => script(tree, [clone(state)], true, depth))
    );
    ctx.trace(
      tree,
      'substitution',
      'Producer inspected without execution; output remains opaque data.'
    );
  }
  /** Field uncertainty goes to `deferred`; its owner decides whether it matters. */
  function word(
    node: Word,
    state: State,
    depth: number,
    assignment = false,
    deferred?: Parameters<AnalysisContext['reason']>[]
  ): Argument[][] {
    budget(node, depth);
    const scoped: AnalysisContext = deferred
      ? {
          ...ctx,
          reason: (...entry) => {
            if (FIELD_UNCERTAINTY.has(entry[1])) deferred.push(entry);
            else reason(...entry);
          },
        }
      : ctx;
    return expandWord(node, state, scoped, substitution, depth, assignment).map((variant) =>
      variant.map((argument) => ({ ...argument, source: { pos: node.pos, end: node.end } }))
    );
  }
  /** Visit a word's nested commands; its value is not used. */
  function visit(node: Word, state: State, depth: number): void {
    word(node, state, depth, false, []);
  }
  function assign(node: Assignment, state: State, depth: number, program?: string): State {
    const next = clone(state);
    if (
      projection
        ? (projectionSensitiveBinding(node.name) &&
            (program === undefined || SHELL_STATE_COMMANDS.test(basename(program)))) ||
          // A bare cd goes to the HOME its own prefix assigns.
          (node.name === 'HOME' && program === 'cd')
        : sensitiveBinding(node.name) || node.name.startsWith('BASH')
    )
      reason(node, 'environment-change', `Unmodeled shell environment change ${node.name}.`);
    if (node.append || node.index || node.value.type !== 'Word') {
      admission(
        node,
        'assignment-syntax',
        'Array, append, and indexed assignments are outside the admitted subset.'
      );
      if (projection) {
        if (node.index) visit(node.index, next, depth);
        for (const value of node.value.type === 'Word' ? [node.value] : node.value.elements)
          visit(value, next, depth);
      }
      next.bindings.set(node.name, null);
      return next;
    }
    // Expansion can itself assign (${x:=y}, $((x=1))); keep those in this state.
    const source = projection ? next : state;
    const expanded = word(node.value, source, depth, true);
    carryEffects(next, [source]);
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
      admission(
        node,
        'substitution-effects',
        'Read substitutions cannot contain output redirections.'
      );
    if (
      node.operator !== '<' &&
      values.some((args) => args.length !== 1 || args[0]?.value !== '/dev/null')
    )
      state.filesystemChanged = true;
    if (
      projection &&
      node.operator !== '<' &&
      values.some((args) => args.some((arg) => arg.value !== null && namesGitMetadata(arg.value)))
    ) {
      state.mappingChanged = true;
      ctx.mapping?.(node);
    }
    for (const args of values) {
      const value = args.length === 1 ? args[0]?.value : null;
      if (value === null || value === undefined) {
        // Input from an unknown place writes nothing.
        if (node.operator !== '<' || !projection)
          reason(node, 'redirect-target', 'Redirection requires a known single target.');
      } else if (node.operator !== '<') {
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
    const declared: Assignment[] = [];
    const deferred: Parameters<AnalysisContext['reason']>[] = [];
    for (const suffix of node.suffix) {
      if (suffix.type === 'Word') words.push(suffix);
      else if (suffix.type === 'Assignment') {
        // The pinned parser reserves these arguments for declaration commands,
        // none of which has an admitted profile. Inspect the original RHS for
        // nested producers without inventing argv or changing parent bindings.
        admission(
          suffix,
          'command-assignment',
          'Declaration assignment arguments have no admitted program profile.'
        );
        if (projection) declared.push(suffix);
        else if (suffix.value.type === 'Word') word(suffix.value, state, depth + 1, true);
      }
    }
    for (const part of words) {
      const variants = word(part, state, depth + 1, false, projection ? deferred : undefined);
      if (vectors.length * variants.length > MAX_STATES) {
        if (!projection) {
          reason(node, 'argument-budget', 'Argument alternatives exceed 32 vectors.');
          return [state];
        }
        // One unknown argument stands for alternatives too many to enumerate.
        const unknown: Argument = { value: null, source: { pos: part.pos, end: part.end } };
        vectors = vectors.map((left) => [...left, unknown]);
        deferred.push([part, 'argument-budget', 'Argument alternatives exceed 32 vectors.']);
        continue;
      }
      vectors = vectors.flatMap((left) => variants.map((right) => [...left, ...right]));
    }
    // An unproved field matters where it can become a write target or select one.
    const exact = deferred.length ? vectors.flatMap(exactOperands) : [];
    for (const entry of deferred)
      if (exact.some(({ source }) => source!.pos <= entry[0].pos && entry[0].end <= source!.end))
        reason(...entry);
    const program = node.name && !node.name.parts?.length ? node.name.value : undefined;
    let assigned = clone(state);
    for (const prefix of node.prefix) {
      if (prefix.type === 'Assignment') assigned = assign(prefix, assigned, depth + 1, program);
      else redirect(prefix, state, reader, depth + 1);
    }
    for (const suffix of node.suffix)
      if (suffix.type !== 'Word' && suffix.type !== 'Assignment')
        redirect(suffix, state, reader, depth + 1);
    let declaring = clone(state);
    for (const assignment of declared) declaring = assign(assignment, declaring, depth + 1);
    carryEffects(state, [assigned, declaring]);
    assigned.filesystemChanged = state.filesystemChanged === true;
    if (projection) assigned.mappingChanged = state.mappingChanged === true;
    // A failed redirection skips the assignments it accompanies.
    if (!node.name) return projection && node.redirects.length ? [state, assigned] : [assigned];
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
      if (!projection) return next.cwd !== before.cwd ? [before, next] : [next];
      for (const assignment of declared)
        next.bindings.set(assignment.name, declaring.bindings.get(assignment.name) ?? null);
      const name = argv[0]?.value;
      // Nothing after this point runs on the path that exits. A redirection
      // can fail and leave the shell running, so it keeps the path alive.
      if (
        name === 'exit' &&
        argv.length <= 2 &&
        /^[0-9]*$/.test(argv[1] ? (argv[1].value ?? 'unknown') : '') &&
        node.redirects.length === 0
      ) {
        subshells.at(-1)?.push(clone(next));
        return [];
      }
      if (name === 'break' || name === 'continue' || name === 'return')
        for (const sink of escapes) sink.push(clone(next));
      const bodies = name ? ctx.functions?.get(name) : undefined;
      if (bodies) return call(name!, bodies, next, reader, depth);
      if (next.cwd === before.cwd && next.cwdUnknown === before.cwdUnknown) return [next];
      return [
        { ...before, outcome: 'failure' as const },
        { ...next, outcome: 'success' as const },
      ];
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
        for (const [index, next] of node.commands.slice(1).entries()) {
          const proceeds = node.operators[index] === '&&' ? 'success' : 'failure';
          const stops = proceeds === 'success' ? 'failure' : 'success';
          states = bounded(
            [
              ...states.filter((item) => item.outcome !== proceeds),
              ...states
                .filter((item) => item.outcome !== stops)
                .flatMap((item) => {
                  const entry = clone(item);
                  delete entry.outcome;
                  return walk(next, entry, reader, depth + 1);
                }),
            ],
            node
          );
        }
        return states;
      }
      case 'Pipeline': {
        if (node.prefixes.length)
          admission(node, 'pipeline-prefix', 'Pipeline prefixes are outside the admitted subset.');
        if (node.commands.length === 1) {
          const outputs = walk(node.commands[0]!, state, reader, depth + 1);
          // Negation inverts the status this pipeline reports.
          return node.prefixes.length
            ? outputs.map((item) => {
                const next = clone(item);
                delete next.outcome;
                return next;
              })
            : outputs;
        }
        const firstGit = ctx.gitInvocations.length;
        const outputs = node.commands.flatMap((next) =>
          contained(() => walk(next, clone(state), reader, depth + 1))
        );
        const next: State = { ...state, filesystemChanged: state.filesystemChanged === true };
        carryEffects(next, outputs);
        // Pipeline members run concurrently. A sibling's effects invalidate
        // every Git mapping observation in this pipeline, in either order.
        if (projection ? next.mappingChanged === true : next.filesystemChanged === true)
          for (const invocation of ctx.gitInvocations.slice(firstGit))
            reason(
              invocation,
              'git-context-changed',
              'Concurrent pipeline effects invalidate the filesystem context used for Git admission.'
            );
        // Declared host contract: Bash lastpipe is disabled.
        return [next];
      }
      case 'Subshell': {
        const outputs = contained(() =>
          list(node.body.commands, [clone(state)], reader, depth + 1)
        );
        const next: State = { ...state, filesystemChanged: state.filesystemChanged === true };
        carryEffects(next, outputs);
        return [next];
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
      case 'For':
      case 'Select': {
        if (node.type === 'Select' && !projection) {
          reason(node, 'statement-syntax', `Unsupported statement: ${node.type}.`);
          return [state];
        }
        const name = node.name.value;
        if (
          (!node.wordlist && !projection) ||
          !/^[A-Za-z_][A-Za-z_0-9]*$/.test(name) ||
          (projection ? projectionSensitiveBinding(name) : sensitiveBinding(name))
        ) {
          reason(
            node,
            'loop-input',
            'For loops require an explicit finite list and ordinary binding.'
          );
          return [state];
        }
        let sequences: Argument[][] = [[]];
        let finite = node.type === 'For' && node.wordlist !== undefined;
        for (const item of node.wordlist ?? []) {
          const variants = word(item, state, depth + 1, false, projection ? [] : undefined);
          if (sequences.length * variants.length > MAX_STATES) {
            if (!projection) {
              reason(node, 'loop-budget', 'Loop alternatives exceed 32.');
              return [state];
            }
            finite = false;
            continue;
          }
          sequences = sequences.flatMap((left) => variants.map((right) => [...left, ...right]));
        }
        if (
          projection &&
          (!finite ||
            sequences.some(
              (sequence) => sequence.length > 32 || sequence.some((item) => item.value === null)
            ))
        )
          return loop(state, node, (entry) => {
            for (const item of entry) item.bindings.set(name, null);
            const next = list(node.body.commands, entry.map(clone), reader, depth + 1);
            return { exits: [...entry, ...next], next };
          });
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
            const step = jumping(() => list(node.body.commands, states, reader, depth + 1));
            // A jump either ends the loop here or starts the next iteration.
            outputs.push(...step.escaped);
            states = bounded([...step.value, ...step.escaped], node);
          }
          outputs.push(...states);
        }
        return bounded(outputs, node);
      }
      case 'Redirected':
        for (const redirection of node.redirects) redirect(redirection, state, reader, depth + 1);
        return walk(node.command, state, reader, depth + 1);
      default:
        return projection ? compound(node, state, reader, depth) : unsupported(node, state);
    }
  }
  function unsupported(node: PipelineNode | AndOr, state: State): State[] {
    reason(node, 'statement-syntax', `Unsupported statement: ${node.type}.`);
    return [state];
  }
  /** Constructs only projection visits. Every nested command is reached. */
  function compound(
    node: PipelineNode | AndOr,
    state: State,
    reader: boolean,
    depth: number
  ): State[] {
    switch (node.type) {
      case 'While':
        return loop(state, node, (entry) => {
          const exits = list(node.clause.commands, entry, reader, depth + 1);
          const next = list(node.body.commands, exits.map(clone), reader, depth + 1);
          return { exits, next };
        });
      case 'ArithmeticFor': {
        const arithmetic = (item: State, expression = node.test): void => {
          if (expression) inspectArithmetic(expression, item, ctx, substitution, depth + 1);
        };
        arithmetic(state, node.initialize);
        return loop(state, node, (entry) => {
          for (const item of entry) arithmetic(item);
          const next = list(node.body.commands, entry.map(clone), reader, depth + 1);
          for (const item of next) arithmetic(item, node.update);
          return { exits: entry, next };
        });
      }
      case 'Case': {
        visit(node.word, state, depth + 1);
        const branches = [clone(state)];
        // ;& enters the next body and ;;& keeps matching, so a body can start
        // from any earlier body that did not end the case.
        let falling: State[] = [];
        for (const item of node.items) {
          for (const pattern of item.pattern) visit(pattern, state, depth + 1);
          const entry = [...falling.map(clone), clone(state)];
          const outputs = list(item.body.commands, entry, reader, depth + 1);
          if (item.terminator !== undefined && item.terminator !== ';;')
            falling = bounded([...falling, ...outputs], node);
          branches.push(...outputs);
        }
        return bounded(branches, node);
      }
      case 'TestCommand':
        for (const operand of testOperands(node.expression)) visit(operand, state, depth + 1);
        return [state];
      case 'ArithmeticCommand':
        if (!node.expression) return unsupported(node, state);
        inspectArithmetic(node.expression, state, ctx, substitution, depth + 1);
        return [state];
      case 'Function': {
        if (node.body.type === 'CompoundList' || node.name.parts?.length)
          return unsupported(node, state);
        const name = node.name.value;
        ctx.functions!.set(name, [...(ctx.functions!.get(name) ?? []), node.body]);
        return [state];
      }
      case 'Coproc': {
        if (node.body.type === 'CompoundList') return unsupported(node, state);
        const { body } = node;
        const next = clone(state);
        carryEffects(
          next,
          contained(() => walk(body, clone(state), reader, depth + 1))
        );
        return [next];
      }
      default:
        return unsupported(node, state);
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
      if (node.background) {
        admission(node, 'background', 'Background state and execution ordering are not modeled.');
        if (projection) {
          // A background job is a subshell: its effects reach this shell, its
          // directory and bindings do not.
          states = states.map((state) => {
            const next = clone(state);
            carryEffects(
              next,
              contained(() => walk(node.command, clone(state), reader, depth + 1))
            );
            return next;
          });
          continue;
        }
      }
      states = bounded(
        states.flatMap((state) => walk(node.command, state, reader, depth + 1)),
        node
      );
      if (projection)
        for (const [index, state] of states.entries())
          if (state.outcome !== undefined) {
            const next = { ...state };
            delete next.outcome;
            states[index] = next;
          }
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
