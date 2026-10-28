import { createHash } from 'node:crypto';
import { resolveExecutionWorkdir } from './execution-workdir';
import {
  accessSync,
  constants,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { basename, delimiter, isAbsolute, join } from 'node:path';
import { TextDecoder } from 'node:util';
import { assertMachinePath } from '../init/machine-paths';
import { classifyCommand } from './classifier';
import { executeAgentHeartbeat } from './agent-heartbeat';
import { assertMatchedCliIdentityReceipt, type MatchedCliIdentityReceipt } from './cli-identity';
import { executeAgentStop } from './agent-stop';
import type { NativeStopLeaseContextPort } from './stop-lease-context';
import { createGuardUtilityPorts, runGuardUtilities } from './guard-utilities';
import type { HandlerResult } from './composer';
import type { RuntimeRequest } from './protocol';
import type { ActiveInvocationSelection, SelectedHandler } from './selection';
import { qualifiesForNativeSessionEndPrefix } from './session-cache-admission';

/** Compatibility identities, not trust inferred from a filename or the current template bytes. */
const HANDLERS: Readonly<Record<string, string>> = {
  'agent-stop.sh': 'c94358159f8fd77585bcb8c3679cd81c8d3d5dba0ff0970c50bf91a0f5f5eaa5',
  'agent-heartbeat.sh': 'fb3d05634e974cbf1978a0748c4db59cc84dc87f43072a8b14761f9fc7cc5fed',
  'block-dangerous.sh': '636f16dba6556cca02782e1df88864dafa920a35c38424afc88457a90cf57bb5',
  'hook-utilities.sh': '8a38d1f75df38568566fdfbbc17acec468c1cc2b11b3f02f71705d2c930d56a8',
};
const LIBRARIES: Readonly<Record<string, readonly string[]>> = {
  'agent-surface.sh': [
    'f8d154f1795c0f643479daa715411a584cb062136cf9003ee007de5f25338e5a',
    // Exact '{}' bypasses only the empty override-map lookup; source tiers stay ordered.
    '9fb104eab8cc5955157dd2da7dc25c19a4bfcd008aa148cfacfba842c9310c32',
    // Exact-path fallback is dormant with the selected nonempty checkout below.
    '455dbfc2bfcf3a5ca891449e1a5f51ce7d9a9a1203ff680bc5fa90fe933e5a8f',
  ],
  'parse-input.sh': [
    // Host execution-workdir validation and separate session/command coordinates.
    'c33d320efef119f826de58b145344288264b985f10d911b435645f6d851444fc',
    'd1823c3913094d20059823b1215ea5b173515912545eea09f8dfbcbb9c03ca30',
    '04a21ee0cd24d917bbee4c63f9285a2a867f2f9a08a9cdf2f9a78d3400a73c61',
    // Comment-only revision of d1823c39: the comment-stripped bytes are identical,
    // so parsed payload bytes, refusal exits and stage lifetime are unchanged.
    'b61ca58672ec23722042fa55b4ba65b8c95ebc67a28dbcdc4f335770fe32d5de',
  ],
  'emit.sh': [
    '32bd200bf9160dffc5d349a7e13341bbcf6644ab9c47ad3f491f68d3ba77bcf4',
    '7719c904cce6073598717e6a90d82e1c88e99482f79afbfd12b35d23f6d7e86e',
  ],
  'session-id.sh': ['cf662f10e6d3477cecbf5deabd8d2b63284f6f4ac14fa7070725ff8502515c53'],
  'caws-state.sh': [
    '2d27e94fbc3303ca96d7729720d8d7570ec772bc0f9a02d5b1bf46b98f4931e1',
    '8a3484f121b0751e566cb7173406c1eb296154af3c1fa08ca09927acd7fdf837',
  ],
  'guard-message.sh': ['7b8a131c93cefb31c4205564f4429586325a292924ea809c396b4b154004e148'],
  'agent-pid.sh': ['f075356c6fe4179ac14ff3e1131ba355690f55a2ced04dd2f42df6aa0f8ff800'],
  'bash-mutation-targets.sh': [
    '3b40bcc29a9793c85c7db4f01c0e4650429be46db504df774e3ff95d6ab8f6ac',
    'd545511184b6513b2f40ca5b37d8bf2a45b0914626293f45884df50cc50ef3b5',
  ],
  'heredoc.sh': [
    '75643e42630f6077959da625f50f6cdf888ed82e4d0d983a560378d928cc5e0d',
    'dbb2382397ba26846021f10d8c7dddd721f15efe6de5c5f4efd4ce53403a41b0',
  ],
};
const STARTUP_SOURCES: Readonly<Record<string, readonly string[]>> = {
  'handler-env.sh': ['901ecd961b65f5383a48ec0e4db7ef2117975963f117ff48d5ed1fab75773cc7'],
  'runtime-paths.sh': ['c2cc098b08c110723c2d1805170ba2d73a855f0864e5792bb7a88a2c3def7f08'],
  'lib/session-cache.sh': ['eea9bb74ec74d07931eb13ac45e6822a348ce7fb49e4a7baa9d590e321e093cb'],
  'lib/agent-surface.sh': LIBRARIES['agent-surface.sh']!,
  // Agent and utility handlers also source the shared parser directly, even
  // when startup selected the Codex parser. A surface selection cannot
  // authenticate that shared file; retain this conservative common closure.
  'lib/parse-input.sh': LIBRARIES['parse-input.sh']!.filter(
    (value) => value !== 'c33d320efef119f826de58b145344288264b985f10d911b435645f6d851444fc'
  ),
  'lib/session-id.sh': LIBRARIES['session-id.sh']!,
  'lib/agent-pid.sh': LIBRARIES['agent-pid.sh']!,
};
const CODEX_LIBRARIES: Readonly<Record<string, string>> = {
  'parse-input.sh': 'c33d320efef119f826de58b145344288264b985f10d911b435645f6d851444fc',
  'emit.sh': '7719c904cce6073598717e6a90d82e1c88e99482f79afbfd12b35d23f6d7e86e',
};
const DIRECT = {
  classifier: '97c50613224a981d73469883bbf8371b036a33ef9777618ff23e82e9f91ff018',
  utilities: 'dd9362ce74a7a2f524c9eebff3cc62d63f14805a436e665d97ca88e47fb2c362',
};
export interface NativeSessionSealExecution {
  readonly sessionId: string;
  execute(): Promise<HandlerResult>;
}
export interface StockHandlerContext {
  readonly request: RuntimeRequest;
  readonly selection: ActiveInvocationSelection;
  readonly environment: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
  readonly nativeSessionSeal?: NativeSessionSealExecution;
  /** Supplied only after native Stop prefix completion, independently of logger eligibility. */
  readonly nativeStopLeaseContext?: NativeStopLeaseContextPort;
  readonly nativeStopCliIdentity?: MatchedCliIdentityReceipt;
}
const empty = (): HandlerResult => ({
  exitCode: 0,
  stdout: new Uint8Array(),
  stderr: new Uint8Array(),
});
const sha = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Preserve the shell's executable selection before replacing its CLI calls.
 * Relative/empty PATH entries and a missing PATH retain shell execution, including
 * runtime-paths.sh's recovery behavior. Admission never invokes an unknown CLI.
 */
function heartbeatCliCompatible(environment: Readonly<Record<string, string>>): boolean {
  const directories = environment.PATH?.split(delimiter);
  if (!directories?.length || directories.some((directory) => !isAbsolute(directory))) return false;
  const resolve = (name: string): string | null => {
    for (const directory of directories) {
      const candidate = join(directory, name);
      try {
        if (!statSync(candidate).isFile()) continue;
        accessSync(candidate, constants.X_OK);
        return realpathSync(candidate);
      } catch {
        // Continue the shell's left-to-right executable search.
      }
    }
    return null;
  };
  try {
    const entry = realpathSync(join(__dirname, '../index.js'));
    return (
      resolve('caws') === entry &&
      resolve('node') === realpathSync(process.execPath) &&
      // This entry is copied verbatim by build-cli.js. A custom startup at the
      // same filename is an extension, even when its package path is unchanged.
      sha(entry) === '53ddd298061d30435160b8ee60a7ea7a5f4c495bab57cfcf36ee6c9e3e86c183'
    );
  } catch {
    return false;
  }
}

function compatible(handler: SelectedHandler, context: StockHandlerContext): boolean {
  const { selection, environment } = context;
  if (
    selection.configuration !== 'system' ||
    handler.kind !== 'stock' ||
    handler.args.length ||
    !Object.hasOwn(HANDLERS, handler.name) ||
    handler.path !== join(selection.runtimeDirectory, handler.name) ||
    handler.sha256 !== HANDLERS[handler.name] ||
    !selection.checkout ||
    !isAbsolute(selection.checkout) ||
    selection.hooksDirectory !== selection.runtimeDirectory
  )
    return false;
  const startup =
    environment.CAWS_PRIOR_BASH_ENV ||
    (environment.BASH_ENV !== join(selection.runtimeDirectory, 'handler-env.sh')
      ? environment.BASH_ENV
      : '');
  if (
    startup ||
    Object.entries(environment).some(
      ([key, value]) =>
        Boolean(value) && (/^_(?:CAWS|HOOK).*LOADED/.test(key) || key.startsWith('BASH_FUNC_'))
    ) ||
    environment.CAWS_BASH_ANALYSIS_REQUIRED === '1'
  )
    return false;
  const extra =
    handler.name === 'hook-utilities.sh'
      ? ['heredoc.sh', 'bash-mutation-targets.sh']
      : handler.name === 'block-dangerous.sh'
        ? ['caws-state.sh', 'guard-message.sh', 'bash-mutation-targets.sh']
        : [];
  const required = ['agent-surface.sh', 'parse-input.sh', 'session-id.sh', 'emit.sh', ...extra];
  try {
    assertMachinePath(selection.runtimeDirectory, handler.path);
    if (sha(handler.path) !== handler.sha256) return false;
    for (const name of required) {
      const library = selection.libraries[name];
      if (
        !library ||
        selection.libraryOverrides[name] ||
        !(
          library.kind === 'shared' ||
          (library.kind === 'surface' &&
            selection.surface === 'codex' &&
            (name === 'parse-input.sh' || name === 'emit.sh'))
        ) ||
        !(library.kind === 'surface'
          ? library.sha256 === CODEX_LIBRARIES[name]
          : LIBRARIES[name]!.includes(library.sha256) && library.sha256 !== CODEX_LIBRARIES[name])
      )
        return false;
      const expected =
        library.kind === 'shared'
          ? join(selection.runtimeDirectory, 'lib', name)
          : join(selection.runtimeDirectory, 'surfaces', selection.surface, 'lib', name);
      if (library.path !== expected) return false;
      assertMachinePath(selection.runtimeDirectory, library.path);
      if (sha(library.path) !== library.sha256) return false;
    }
    const routing: Readonly<Record<string, string>> = {
      CAWS_PROJECT_DIR: selection.checkout,
      CAWS_MACHINE_POLICY_ROOT: selection.canonical,
      CAWS_MACHINE_RUNTIME: '1',
      CAWS_SYSTEM_RUNTIME: '1',
      CAWS_AGENT_SURFACE: selection.surface,
      CAWS_SHARED_LIB_DIR: join(selection.runtimeDirectory, 'lib'),
      CAWS_MACHINE_ADAPTER_LIB_DIR: join(
        selection.runtimeDirectory,
        'surfaces',
        selection.surface,
        'lib'
      ),
      CAWS_MACHINE_LIBRARIES: '{}',
      HOOKS_DIR: selection.runtimeDirectory,
    };
    for (const [name, expected] of Object.entries(routing))
      if (environment[name] && environment[name] !== expected) return false;
    // Codex can source a checkout-local runtime bootstrap before the machine
    // fallback. Only proven absence admits that fallback; links/errors decline.
    const projectRuntime = join(selection.checkout, '.caws/hooks/runtime-paths.sh');
    assertMachinePath(selection.checkout, projectRuntime);
    try {
      lstatSync(projectRuntime);
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
    }
    const direct: Record<string, readonly string[]> = { ...STARTUP_SOURCES };
    for (const name of extra) direct['lib/' + name] = LIBRARIES[name]!;
    for (const [name, expected] of Object.entries(direct)) {
      const dependency = join(selection.runtimeDirectory, name);
      assertMachinePath(selection.runtimeDirectory, dependency);
      if (!lstatSync(dependency).isFile() || !expected.includes(sha(dependency))) return false;
    }
    if (handler.name === 'agent-heartbeat.sh' || handler.name === 'agent-stop.sh') return true;
    const file =
      handler.name === 'hook-utilities.sh'
        ? join(selection.runtimeDirectory, 'lib/hook-utilities.py')
        : join(selection.runtimeDirectory, 'classify_command.py');
    assertMachinePath(selection.runtimeDirectory, file);
    return (
      sha(file) === (handler.name === 'hook-utilities.sh' ? DIRECT.utilities : DIRECT.classifier)
    );
  } catch {
    return false;
  }
}

/** Exact direct-stock bridge eligibility; this grants a receipt, never signal authority. */
export function qualifiesForNativeContainment(
  handler: SelectedHandler,
  context: StockHandlerContext
): boolean {
  const { request, selection, environment } = context;
  if (
    handler.name !== 'block-dangerous.sh' ||
    !compatible(handler, context) ||
    selection.surface !== 'codex' ||
    selection.event !== 'pre_tool_use' ||
    request.surface !== selection.surface ||
    request.event !== selection.event ||
    request.runtimeDigest !== selection.runtimeDigest ||
    request.payload.tool_name !== 'Bash' ||
    !object(request.payload.tool_input) ||
    typeof request.payload.tool_input.command !== 'string' ||
    selection.handlers.some((entry) => entry.kind !== 'stock') ||
    Object.values(selection.libraries).some(
      (entry) => entry.kind === 'project' || entry.kind === 'user'
    ) ||
    Object.keys(selection.libraryOverrides).length > 0 ||
    Object.keys(selection.overrides).length > 0 ||
    !selection.handlers.some(
      (entry) =>
        entry.path === handler.path &&
        entry.sha256 === handler.sha256 &&
        entry.entry === handler.entry
    ) ||
    environment.CAWS_TRAP_KILL === '0' ||
    environment.CAWS_TRAP_KILL === 'dryrun' ||
    [
      environment.CAWS_HOOK_DRY_RUN,
      environment.CLAUDE_HOOK_DRY_RUN,
      environment.CODEX_HOOK_DRY_RUN,
    ].some((value) => Boolean(value && value !== '0'))
  )
    return false;
  const startup = join(selection.runtimeDirectory, 'handler-env.sh');
  try {
    assertMachinePath(selection.runtimeDirectory, startup);
    return (
      lstatSync(startup).isFile() &&
      sha(startup) === '901ecd961b65f5383a48ec0e4db7ef2117975963f117ff48d5ed1fab75773cc7'
    );
  } catch {
    return false;
  }
}

/** Prove absence without guessing the session resolver's live PID/cached identity. */
function noDangerLatch(selection: ActiveInvocationSelection): boolean {
  for (const root of new Set([selection.checkout, selection.canonical])) {
    const state = join(root, '.codex/hooks/state');
    try {
      assertMachinePath(root, state);
      const entries = readdirSync(state);
      if (
        entries.length > 4096 ||
        entries.some((name) => name.startsWith('danger-latch-') && name.endsWith('.json'))
      )
        return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
    }
  }
  return true;
}

/** Check before prefix effects and repeat immediately before lease application. */
export function assertNativeStopAgentSelection(
  handler: SelectedHandler,
  context: StockHandlerContext,
  phase: 'preflight' | 'lease' = 'lease'
): void {
  const { request, selection, environment } = context;
  const chain = [
    ['goal-ac-gate.sh', 'ef16f932c95c0d8e32a070ddd5b3309705d720f0d1e6ff96c51781671f100402'],
    [
      'plan-transcript-finalize.sh',
      '8ed0b7173c5add2991a67789a2219a03b809046a39596c5d8a60d052f3d02ce2',
    ],
    ['session-log.sh', '8f6358e4ec37e9dcd35c98d77d2a77776e6d73c761895f37069b21e61f2f66a9'],
    ['agent-stop.sh', HANDLERS['agent-stop.sh']],
  ] as const;
  if (
    request.configuration !== 'system' ||
    selection.surface !== 'opencode' ||
    selection.event !== 'stop' ||
    request.surface !== selection.surface ||
    request.event !== selection.event ||
    request.runtimeDigest !== selection.runtimeDigest ||
    selection.hooksDirectory !== selection.runtimeDirectory ||
    selection.handlers.length !== 4 ||
    selection.handlers[3] !== handler ||
    Object.keys(selection.overrides).length ||
    Object.keys(selection.libraryOverrides).length ||
    (environment.CAWS_BIN && environment.CAWS_BIN !== 'caws') ||
    !compatible(handler, context)
  )
    throw new Error(
      phase === 'preflight'
        ? 'Native Stop agent consumer is ineligible before prefix'
        : 'Native Stop agent consumer changed after prefix; shell replay refused'
    );
  for (const [index, selected] of selection.handlers.entries()) {
    const expected = chain[index]!;
    assertMachinePath(selection.runtimeDirectory, selected.path);
    if (
      selected.kind !== 'stock' ||
      selected.name !== expected[0] ||
      selected.entry !== expected[0] ||
      selected.sha256 !== expected[1] ||
      selected.args.length ||
      selected.path !== join(selection.runtimeDirectory, expected[0]) ||
      sha(selected.path) !== selected.sha256
    )
      throw new Error(
        phase === 'preflight'
          ? 'Native Stop ordered source is ineligible before prefix'
          : 'Native Stop ordered source changed before lease application'
      );
  }
}

/** Null means execute the selected shell source; it never means skip the handler. */
export function tryExecuteStockHandler(
  handler: SelectedHandler,
  context: StockHandlerContext
): HandlerResult | Promise<HandlerResult> | null {
  if (context.signal.aborted) throw new Error('Handler invocation cancelled');
  if (Date.now() >= context.request.deadlineEpochMs) throw new Error('Handler deadline expired');
  if (context.nativeSessionSeal) {
    // Prefix effects have happened. A source change is an invocation failure,
    // never permission to replay a shell parser or fall through to runChild.
    if (
      handler.name !== 'session-log.sh' ||
      !qualifiesForNativeSessionEndPrefix({
        ...context,
        sessionId: context.nativeSessionSeal.sessionId,
      })
    )
      throw new Error('Native SessionEnd source profile changed after prefix completion');
    return context.nativeSessionSeal.execute();
  }
  if (handler.name === 'agent-stop.sh' && context.nativeStopLeaseContext) {
    const cli = context.nativeStopCliIdentity;
    if (!cli) throw new Error('Native Stop agent consumer lacks CLI identity owner');
    assertMatchedCliIdentityReceipt(cli, context.request, context.signal);
    return executeAgentStop(context, context.nativeStopLeaseContext, () => {
      assertMatchedCliIdentityReceipt(cli, context.request, context.signal);
      cli.assertOwner(context.request, context.signal);
      assertNativeStopAgentSelection(handler, context);
    });
  }
  if (!compatible(handler, context)) return null;
  const { request, selection, environment } = context;
  const payload = request.payload;
  const toolInput = object(payload.tool_input) ? payload.tool_input : {};
  if (handler.name === 'agent-heartbeat.sh') {
    if (
      selection.surface !== 'codex' ||
      selection.event !== 'pre_tool_use' ||
      request.surface !== selection.surface ||
      request.event !== selection.event ||
      request.runtimeDigest !== selection.runtimeDigest ||
      payload.tool_name !== 'Bash' ||
      typeof toolInput.command !== 'string' ||
      (environment.CAWS_BIN && environment.CAWS_BIN !== 'caws') ||
      !heartbeatCliCompatible(environment) ||
      Object.entries(environment).some(
        ([name, value]) =>
          Boolean(value) &&
          (name === 'NODE_OPTIONS' ||
            name === 'NODE_PATH' ||
            name.startsWith('LD_') ||
            name.startsWith('DYLD_') ||
            name.startsWith('BASH_FUNC_'))
      ) ||
      selection.handlers.some((entry) => entry.kind !== 'stock') ||
      Object.values(selection.libraries).some(
        (entry) => entry.kind === 'project' || entry.kind === 'user'
      ) ||
      Object.keys(selection.overrides).length ||
      Object.keys(selection.libraryOverrides).length
    )
      return null;
    return executeAgentHeartbeat(context);
  }
  if (handler.name === 'hook-utilities.sh') {
    // The current shell helper projects bounded Node heredocs before tokenizing.
    // The typed utility tokenizer implements only file-sink heredocs. Keep all
    // heredoc-shaped payloads on the selected shell until that consumer agrees.
    if (typeof toolInput.command === 'string' && toolInput.command.includes('<<')) return null;
    const policy = environment.CAWS_OPTIONAL_HOOK_POLICY;
    let text: string | null = null;
    if (policy) {
      const path = isAbsolute(policy) ? policy : join(selection.checkout, policy);
      try {
        // Large/nonregular/redirected policy inputs retain the selected shell behavior.
        const metadata = lstatSync(path);
        if (!metadata.isFile() || metadata.size > 1024 * 1024) return null;
        text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
          readFileSync(path)
        );
      } catch {
        return null;
      }
    }
    const ports = createGuardUtilityPorts(environment, request.deadlineEpochMs);
    let cwd = selection.checkout;
    const execution = resolveExecutionWorkdir(payload, request.event);
    if (execution.status === 'resolved') cwd = execution.path;
    else if (typeof payload.cwd === 'string' && payload.cwd) {
      try {
        // The shell utility resolves HOOK_CWD from its checkout-based process.
        // Keep symlink/.. traversal intact until the filesystem resolver sees it.
        cwd = ports.realpath(
          isAbsolute(payload.cwd) ? payload.cwd : `${selection.checkout}/${payload.cwd}`
        );
      } catch {
        return null;
      }
    }
    return runGuardUtilities(
      text,
      {
        tool: typeof payload.tool_name === 'string' ? payload.tool_name : '',
        toolInput,
        cwd,
      },
      ports
    );
  }
  // The bounded first consumer migration is Codex. Other surface emit/state semantics stay selected shell behavior.
  if (
    selection.surface !== 'codex' ||
    selection.event !== 'pre_tool_use' ||
    !noDangerLatch(selection)
  )
    return null;
  if (
    environment.CAWS_TRUSTED_WORKTREE_CREATE_CONTEXT === '1' ||
    environment.CAWS_CLASSIFY_FACTS_DUMP === '1'
  )
    return null;
  const tool = payload.tool_name;
  if (tool !== 'Bash') return null;
  const command = toolInput.command;
  if (typeof command !== 'string' || !command) return null;
  if (command.includes('.codex/hooks/worktree-write-guard.sh')) return null;
  const home = environment.HOME;
  if (!home || !isAbsolute(home)) return null;
  const classification = classifyCommand(command, {
    repoRoot: selection.checkout,
    cwd: (() => {
      const execution = resolveExecutionWorkdir(payload, request.event);
      return execution.status === 'resolved' ? execution.path : selection.checkout;
    })(),
    home,
    environment,
    deadlineUnixMs: request.deadlineEpochMs,
    ...(environment.TMPDIR !== undefined ? { temporaryDirectory: environment.TMPDIR } : {}),
    ownerIdentities: [
      basename(home),
      ...(environment.CAWS_OWNER_IDENTITIES ?? '').split(/[\s,]+/).filter(Boolean),
    ],
  });
  if (context.signal.aborted) throw new Error('Handler invocation cancelled');
  if (classification.decision === 'allow') return empty();
  if (classification.decision === 'ask' && classification.enforcement !== 'confirm') {
    return {
      ...empty(),
      stderr: Buffer.from(`caws advisory (non-blocking): ${classification.reason}\n`),
    };
  }
  if (
    classification.decision !== 'ask' ||
    classification.enforcement !== 'confirm' ||
    classification.source !== 'commit_deletions'
  )
    return null;
  const reason = classification.reason.includes('a merge is in progress')
    ? `CAWS command-safety: ${classification.reason}. This command was refused — the session danger latch was NOT armed. Command was: ${command}`
    : `CAWS command-safety: ${classification.reason}. This command was refused — the session danger latch was NOT armed. Do this instead: (1) inspect what is actually staged: git status && git diff --cached --stat; (2) if the staged set is exactly what you intend, commit it with the paths named explicitly: git commit -m "<msg>" -- <paths>; (3) if the staged set contains work that is NOT yours (another session's files, a half-applied revert), STOP and ask the user before unstaging anything. Do NOT rephrase the same bare commit to evade this. Command was: ${command}`;
  // Stock emit_block emits a protective JSON decision with exit 0; composer promotes it.
  return { ...empty(), stdout: Buffer.from(`${JSON.stringify({ decision: 'block', reason })}\n`) };
}
