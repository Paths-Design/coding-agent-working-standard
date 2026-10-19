/**
 * Qualify selected native stock warning/latch behavior in a private installation.
 * Six absolute arguments: CLI directory, native binary, Node, Python, jq, new artifact directory.
 * Proposed shell text is input data only; killing is disabled.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

type Data = Record<string, unknown>;
type Status = { code: number | null; signal: NodeJS.Signals | null; error: string | null };
type Result = { status: Status; stdout: Buffer; stderr: Buffer };
type Expected = 'warning' | 'latch' | 'advisory' | 'ordinary';
type Observation = {
  name: string;
  command: string;
  sid: string;
  expected: Expected;
  status: Status;
  stdout: string;
  stderr: string;
  warn: Data | null;
  latch: Data | null;
  journal: Data[];
  problems: string[];
};
const object = (value: unknown): value is Data =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const sha = (bytes: Uint8Array): string => crypto.createHash('sha256').update(bytes).digest('hex');
const fileSha = (file: string): string => sha(fs.readFileSync(file));
function put(file: string, bytes: string | Uint8Array): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, bytes, { mode: 0o600 });
}
const json = (file: string, value: unknown): void =>
  put(file, JSON.stringify(value, null, 2) + '\n');
function read(file: string): Data {
  const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert(object(value), 'expected object: ' + file);
  return value;
}
function hashes(directory: string, prefix = ''): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of fs.readdirSync(directory).sort()) {
    if (name === '__pycache__') continue;
    const file = path.join(directory, name);
    const relative = path.join(prefix, name);
    const stat = fs.lstatSync(file);
    assert(!stat.isSymbolicLink(), 'source/build symlink: ' + file);
    if (stat.isDirectory()) Object.assign(result, hashes(file, relative));
    else {
      assert(stat.isFile());
      result[relative] = fileSha(file);
    }
  }
  return result;
}
function argument(index: number): string {
  const value = process.argv[index];
  assert(value && path.isAbsolute(value), 'six absolute paths required');
  return fs.realpathSync(value);
}
function exactKeys(value: Data, keys: string[]): boolean {
  return (
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}
const timestamp = (value: unknown): boolean =>
  typeof value === 'string' &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value) &&
  Number.isFinite(Date.parse(value));

assert.equal(process.argv.length, 8, 'six absolute paths required');
const cli = argument(2),
  native = argument(3),
  node = argument(4),
  python = argument(5),
  jq = argument(6);
const rootArgument = process.argv[7]!;
assert(path.isAbsolute(rootArgument));
const root = path.resolve(rootArgument);
assert(!fs.existsSync(root), 'artifact directory must be new');
assert(fs.existsSync(path.join(cli, 'src/runtime/engine.ts')));
for (const file of [native, node, python, jq]) {
  assert(fs.statSync(file).isFile());
  fs.accessSync(file, fs.constants.X_OK);
}
fs.mkdirSync(root, { recursive: true, mode: 0o700 });
fs.chmodSync(root, 0o700);
const repo = path.join(root, 'project'),
  home = path.join(root, 'machine'),
  user = path.join(root, 'user'),
  bin = path.join(root, 'bin'),
  temporary = path.join(root, 'tmp'),
  engine = path.join(cli, 'dist/runtime/engine-entry.js');
for (const directory of [repo, user, bin, temporary]) fs.mkdirSync(directory, { mode: 0o700 });
fs.symlinkSync(python, path.join(bin, 'python3'));
fs.symlinkSync(jq, path.join(bin, 'jq'));
const environment: NodeJS.ProcessEnv = {
  PATH: bin + ':/usr/bin:/bin',
  HOME: user,
  CAWS_HOME: home,
  TMPDIR: temporary,
  CAWS_AGENT_SURFACE: 'codex',
  CAWS_TRAP_KILL: '0',
  CAWS_HOOK_ADVISORY_DEDUP: '0',
  PYTHONDONTWRITEBYTECODE: '1',
  LC_ALL: 'C',
  TZ: 'UTC',
};
const failures: string[] = [],
  observations: Observation[] = [];
const manifest: Data = {
  schema: 'caws.native-substitution-qualification.v1',
  root,
  cli,
  runnerPid: process.pid,
  killMode: '0',
  proposedCommandsExecuted: false,
  cases: observations,
  failures,
  nonclaims: [
    'Selected stock guard only; no full chain or actual harness withholding',
    'Private installation; no shared adoption or Python retirement',
    'Killing disabled; no termination or exclusive session process ownership',
    'Hashes identify supplied bytes; they do not establish build derivation',
    'Capture completion does not establish descendant cleanup or a whole-machine process census',
  ],
};
const maximumOutput = 4 * 1024 * 1024;
async function invoke(
  executable: string,
  args: string[],
  input: Buffer,
  directory: string,
  env: NodeJS.ProcessEnv = environment
): Promise<Result> {
  put(path.join(directory, 'input.bin'), input);
  json(path.join(directory, 'command.json'), {
    executable,
    args,
    cwd: repo,
    inputSha256: sha(input),
    outerTimeoutMs: 35000,
    killMode: env.CAWS_TRAP_KILL,
    proposedCommandsExecuted: false,
  });
  return await new Promise<Result>((resolve, reject) => {
    const child = spawn(executable, args, { cwd: repo, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [],
      stderr: Buffer[] = [];
    const started = performance.now();
    let bytes = 0,
      error: string | null = null,
      cancelling = false,
      completed = false;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    let abandon: ReturnType<typeof setTimeout> | undefined;
    const retain = (
      code: number | null,
      signal: NodeJS.Signals | null,
      captureComplete: boolean
    ): Result => {
      const status = { code, signal, error };
      const out = Buffer.concat(stdout),
        err = Buffer.concat(stderr);
      put(path.join(directory, 'stdout.bin'), out);
      put(path.join(directory, 'stderr.bin'), err);
      json(path.join(directory, 'status.json'), {
        ...status,
        pid: child.pid,
        captureComplete,
        elapsedMs: performance.now() - started,
      });
      return { status, stdout: out, stderr: err };
    };
    const abort = (reason: string): void => {
      if (cancelling || completed) return;
      cancelling = true;
      error ??= reason;
      try {
        json(path.join(directory, 'cancellation.json'), {
          pid: child.pid,
          reason,
          directOwnedChildOnly: true,
          cleanupConfirmed: false,
        });
      } catch {
        /* Receipt failure must not prevent owned-child cancellation. */
      }
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      escalation = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        abandon = setTimeout(() => {
          if (completed) return;
          completed = true;
          try {
            retain(child.exitCode, child.signalCode, false);
          } catch {
            /* Preserve the original incomplete outcome. */
          } finally {
            clearTimeout(timeout);
            child.stdin.destroy();
            child.stdout.destroy();
            child.stderr.destroy();
            child.unref();
          }
          reject(new Error(reason + '; exit/pipe cleanup unconfirmed; retain fixture and stop'));
        }, 1000);
      }, 1000);
    };
    const timeout = setTimeout(() => abort('outer 35s deadline expired'), 35000);
    const collect =
      (chunks: Buffer[]) =>
      (chunk: Buffer): void => {
        if (completed) return;
        const remaining = Math.max(0, maximumOutput - bytes);
        if (remaining > 0) chunks.push(Buffer.from(chunk.subarray(0, remaining)));
        bytes = Math.min(maximumOutput + 1, bytes + chunk.length);
        if (bytes > maximumOutput) abort('output exceeded 4 MiB capture limit');
      };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.once('error', (value) => {
      error ??= value.message;
    });
    child.stdin.on('error', (value) => abort('stdin: ' + value.message));
    child.once('close', (code, signal) => {
      if (completed) return;
      completed = true;
      clearTimeout(timeout);
      if (escalation) clearTimeout(escalation);
      if (abandon) clearTimeout(abandon);
      try {
        const result = retain(code, signal, true);
        if (error || signal !== null)
          reject(new Error('incomplete invocation: ' + JSON.stringify(result.status)));
        else resolve(result);
      } catch (value) {
        reject(value);
      }
    });
    child.stdin.end(input);
  });
}

const regression = 'git init; echo "$(kubectl delete pod demo)"';
const backtick = 'git init; echo `kubectl delete pod demo`';
const inverse = 'echo "$(kubectl delete pod demo)"; git init';
const literal = "git init; echo '$(kubectl delete pod demo)'";
const capabilityReason = 'command substitution: destructive operation (K8S_DELETE)';
const advisoryReason =
  'git init requires human approval; do not retry by wrapping, reordering, aliasing, or indirect invocation';
function coverageProblems(calls: Record<string, number>, classifierRequired: boolean): string[] {
  const result: string[] = [];
  if (!(calls.tryExecuteStockHandler! > 0)) result.push('stock-executor-not-observed');
  if (classifierRequired && !(calls.classifyCommand! > 0))
    result.push('typed-classifier-not-observed');
  return result;
}
function coverage(directory: string): { calls: Record<string, number>; witnesses: Data[] } {
  const targets = [
    ['runtime/classifier/index.js', 'classifyCommand'],
    ['runtime/stock-handlers.js', 'tryExecuteStockHandler'],
  ] as const;
  const calls: Record<string, number> = { classifyCommand: 0, tryExecuteStockHandler: 0 };
  const witnesses: Data[] = [];
  const files = fs.readdirSync(directory).filter((file) => file.endsWith('.json'));
  assert(files.length > 0 && files.length <= 16, 'bounded coverage files required');
  for (const name of files) {
    const file = path.join(directory, name);
    const stat = fs.lstatSync(file);
    assert(stat.isFile() && stat.size <= 32 * 1024 * 1024, 'bounded regular coverage required');
    const data = read(file);
    assert(Array.isArray(data.result));
    for (const [relative, functionName] of targets) {
      const module = path.join(cli, 'dist', relative);
      const url = pathToFileURL(module).href;
      const text = fs.readFileSync(module, 'utf8');
      for (const script of data.result) {
        if (!object(script) || script.url !== url) continue;
        assert(Array.isArray(script.functions));
        const functions = script.functions.filter(
          (entry) => object(entry) && entry.functionName === functionName
        );
        assert.equal(functions.length, 1, 'exact compiled function witness required');
        const fn: unknown = functions[0];
        assert(object(fn) && Array.isArray(fn.ranges));
        const range: unknown = fn.ranges[0];
        assert(
          object(range) &&
            typeof range.count === 'number' &&
            Number.isSafeInteger(range.count) &&
            range.count >= 0
        );
        assert(typeof range.startOffset === 'number' && Number.isSafeInteger(range.startOffset));
        assert(typeof range.endOffset === 'number' && Number.isSafeInteger(range.endOffset));
        assert(
          range.startOffset >= 0 &&
            range.endOffset <= text.length &&
            range.endOffset > range.startOffset
        );
        assert(
          text
            .slice(range.startOffset, range.endOffset)
            .startsWith('function ' + functionName + '('),
          'coverage offset does not name the compiled function'
        );
        calls[functionName] = (calls[functionName] ?? 0) + range.count;
        witnesses.push({
          file,
          coverageSha256: fileSha(file),
          url,
          moduleSha256: fileSha(module),
          functionName,
          ...range,
        });
      }
    }
  }
  return { calls, witnesses };
}
function problems(observation: Observation): string[] {
  const result: string[] = [];
  const { expected, warn, latch, command, status, stdout, stderr, journal } = observation;
  const reason = expected === 'advisory' ? advisoryReason : capabilityReason;
  if (status.code !== (expected === 'latch' ? 2 : 0)) result.push('native-exit');
  if (status.signal !== null || status.error !== null) result.push('native-completion');
  if (expected === 'ordinary' || expected === 'advisory') {
    const expectedStderr =
      expected === 'advisory'
        ? '[block-dangerous.sh] caws advisory (non-blocking): ' + reason + '\n'
        : '';
    if (stdout !== '' || stderr !== expectedStderr) result.push('nonblocking-output');
    if (warn !== null || latch !== null) result.push('unexpected-state');
  } else {
    if (
      !warn ||
      !exactKeys(warn, ['ts', 'hook', 'kind', 'reason', 'command']) ||
      !timestamp(warn.ts) ||
      warn.hook !== 'block-dangerous.sh' ||
      warn.kind !== 'capability-warn' ||
      warn.command !== command ||
      warn.reason !== reason
    )
      result.push('warning-json');
    if (expected === 'warning') {
      const expectedStderr =
        '[block-dangerous.sh] caws command-safety (WARN, first capability ask — not blocked): ' +
        reason +
        '\n' +
        '[block-dangerous.sh]   A SECOND capability-risk command this session will ARM the danger latch. Command was: ' +
        command +
        '\n';
      if (stdout !== '' || stderr !== expectedStderr) result.push('warning-output');
      if (latch !== null) result.push('premature-latch');
    } else {
      let body: unknown;
      try {
        body = JSON.parse(stdout);
      } catch {
        body = null;
      }
      if (
        !object(body) ||
        !exactKeys(body, ['decision', 'reason']) ||
        body.decision !== 'block' ||
        typeof body.reason !== 'string' ||
        !body.reason.includes(reason) ||
        !body.reason.includes('SECOND capability-risk command') ||
        !body.reason.endsWith('Command was: ' + command)
      )
        result.push('protective-output');
      if (
        object(body) &&
        typeof body.reason === 'string' &&
        stderr !==
          '[caws machine adapter ' + String(journal[0]?.runtime_digest) + '] ' + body.reason + '\n'
      )
        result.push('protective-stderr');
      if (
        !latch ||
        !exactKeys(latch, [
          'ts',
          'hook',
          'decision',
          'reason',
          'command',
          'latch_generation',
          'message',
        ]) ||
        !timestamp(latch.ts) ||
        latch.hook !== 'block-dangerous.sh' ||
        latch.decision !== 'ask' ||
        latch.reason !== reason ||
        latch.command !== command ||
        latch.message !==
          'Dangerous command boundary engaged. User reset required before more Bash commands may run in this session.' ||
        typeof latch.latch_generation !== 'string' ||
        !/^[a-f0-9]{32}$/.test(latch.latch_generation)
      )
        result.push('latch-json');
    }
  }
  if (!journal.length) result.push('journal-missing');
  if (
    !journal.some(
      (row) => row.stage === 'adapter_stdout_handoff' && row.exit_code === status.code
    ) ||
    !journal.some((row) => row.stage === 'adapter_finished' && row.exit_code === status.code)
  )
    result.push('journal-finalization');
  if (
    journal.filter(
      (row) => row.stage === 'handler_completed' && row.handler === 'block-dangerous.sh'
    ).length !== 1
  )
    result.push('guard-completion');
  if (journal.some((row) => String(row.stage).startsWith('containment_')))
    result.push('unexpected-containment');
  if (
    latch &&
    [
      'agent_pid',
      'agent_pid_started_at',
      'agent_pid_comm',
      'trap_escalated_pid',
      'trap_escalated_at',
    ].some((key) => Object.hasOwn(latch, key))
  )
    result.push('unexpected-process-target');
  return result;
}
async function run(): Promise<void> {
  const gitMetadata = (args: string[]) => {
    const result = spawnSync('/usr/bin/git', args, {
      cwd: cli,
      env: environment,
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(result.status, 0);
    return result.stdout;
  };
  manifest.revision = gitMetadata(['rev-parse', 'HEAD']).trim();
  manifest.sourceStatus = gitMetadata(['status', '--short']);
  put(path.join(root, 'source.diff'), gitMetadata(['diff', '--binary', 'HEAD']));
  const executables = Object.fromEntries(
    Object.entries({ native, node, python, jq }).map(([name, file]) => [
      name,
      { path: file, sha256: fileSha(file) },
    ])
  );
  manifest.executables = executables;
  const beforeSource = hashes(path.join(cli, 'src')),
    beforeBuild = hashes(path.join(cli, 'dist'));
  json(path.join(root, 'source-hashes.json'), beforeSource);
  json(path.join(root, 'build-hashes.json'), beforeBuild);
  assert(process.argv[1]);
  manifest.compiledRunnerSha256 = fileSha(process.argv[1]);
  manifest.runnerSourceSha256 = fileSha(path.join(cli, 'scripts/qualify-native-substitution.ts'));
  const requireBuilt = createRequire(path.join(cli, 'package.json'));
  const api = requireBuilt(path.join(cli, 'dist/init/machine-adapters')) as {
    installMachineRuntime(options: { home: string; templatesRoot: string }): {
      home: string;
      digest: string;
      files: string[];
    };
  };
  const installed = api.installMachineRuntime({
    home,
    templatesRoot: path.join(cli, 'templates/hook-packs'),
  });
  assert.equal(installed.home, home);
  json(path.join(root, 'installation.json'), installed);
  const runtime = path.join(home, 'lib/runtimes', installed.digest);
  const beforeRuntime = hashes(runtime);
  json(path.join(root, 'immutable-runtime-hashes.json'), beforeRuntime);
  manifest.runtimeDigest = installed.digest;
  const setupArgs = ['-c', 'core.hooksPath=/dev/null', 'init', '-q'];
  const setup = spawnSync('/usr/bin/git', setupArgs, {
    cwd: repo,
    env: environment,
    timeout: 5000,
    maxBuffer: 65536,
  });
  json(path.join(root, 'repository-setup.json'), {
    executable: '/usr/bin/git',
    args: setupArgs,
    status: setup.status,
    signal: setup.signal,
    stdout: setup.stdout.toString(),
    stderr: setup.stderr.toString(),
    error: setup.error?.message ?? null,
  });
  assert.equal(setup.status, 0);
  put(path.join(repo, '.caws/policy.yaml'), 'version: 1\n');
  fs.mkdirSync(path.join(repo, '.caws/specs'));
  put(
    path.join(repo, '.caws/hooks/.test-harness'),
    'private nonterminating substitution qualification\n'
  );
  const defaults = read(path.join(runtime, 'system-policy.json'));
  assert(object(defaults.events));
  const entries = defaults.events.pre_tool_use;
  assert(Array.isArray(entries) && entries.every((entry) => typeof entry === 'string'));
  const policy = {
    disabled: {
      pre_tool_use: [
        ...new Set(
          (entries as string[])
            .map((entry) => entry.split(' ')[0]!)
            .filter((name) => name !== 'block-dangerous.sh')
        ),
      ],
    },
    extensions: {},
    handlers: {},
    libraries: {},
  };
  const validator = requireBuilt(path.join(cli, 'dist/init/system-project-policy')) as {
    validateSystemPolicy(repo: string, policy: unknown, options: unknown): void;
  };
  validator.validateSystemPolicy(repo, policy, {
    files: installed.files,
    defaults: defaults.events,
  });
  json(path.join(home, 'surfaces/codex/settings.json'), { version: 1, enabled: true });
  json(path.join(home, 'state/projects', sha(Buffer.from(repo)) + '.json'), {
    version: 1,
    root: repo,
    surfaces: { codex: policy },
  });
  const selectionApi = requireBuilt(path.join(cli, 'dist/runtime/selection')) as {
    resolveInvocationSelection(options: unknown): Data;
  };
  const selection = selectionApi.resolveInvocationSelection({
    checkout: repo,
    canonical: repo,
    home,
    runtimeDigest: installed.digest,
    surface: 'codex',
    event: 'pre_tool_use',
    system: true,
  });
  json(path.join(root, 'selection.json'), selection);
  assert.equal(selection.status, 'active');
  assert(Array.isArray(selection.handlers) && selection.handlers.length === 1);
  const handler: unknown = selection.handlers[0];
  assert(object(handler));
  assert.equal(handler.kind, 'stock');
  assert.equal(handler.name, 'block-dangerous.sh');
  assert.equal(handler.path, path.join(runtime, 'block-dangerous.sh'));
  assert.equal(handler.sha256, fileSha(path.join(runtime, 'block-dangerous.sh')));
  assert.deepEqual(selection.overrides, {});
  assert.deepEqual(selection.libraryOverrides, {});
  const cases: Array<[string, string, string, Expected]> = [
    ['single-quoted-first', 'literal', literal, 'advisory'],
    ['single-quoted-repeat', 'literal', literal, 'advisory'],
    ['regression-first', 'regression', regression, 'warning'],
    ['backtick-first', 'backtick', backtick, 'warning'],
    ['inverse-first', 'inverse', inverse, 'warning'],
    ['regression-repeat', 'regression', regression, 'latch'],
    ['backtick-repeat', 'backtick', backtick, 'latch'],
    ['inverse-repeat', 'inverse', inverse, 'latch'],
    ['ordinary-sibling', 'ordinary', 'echo safe', 'ordinary'],
    ['fresh-session', 'fresh', regression, 'warning'],
  ];
  const allState = (): Record<string, string> => {
    const directory = path.join(repo, '.codex/hooks/state');
    return fs.existsSync(directory) ? hashes(directory) : {};
  };
  for (const [name, session, command, expected] of cases) {
    const directory = path.join(root, name),
      sid = 'substitution-' + session;
    const stateBefore = allState();
    json(path.join(directory, 'state-before.json'), stateBefore);
    const reason = expected === 'advisory' ? advisoryReason : capabilityReason;
    const classifier = await invoke(
      python,
      [
        path.join(runtime, 'classify_command.py'),
        '--repo-root',
        repo,
        '--home',
        user,
        '--cwd',
        repo,
      ],
      Buffer.from(command),
      path.join(directory, 'python-classifier')
    );
    assert.equal(classifier.status.code, 0);
    const classified: unknown = JSON.parse(classifier.stdout.toString('utf8'));
    if (expected === 'ordinary') {
      assert(object(classified));
      assert.equal(classified.decision, 'allow');
    } else
      assert.deepEqual(
        classified,
        {
          decision: 'ask',
          reason,
          source: expected === 'advisory' ? 'legacy_family' : 'capability',
          enforcement: expected === 'advisory' ? 'advisory' : 'confirm',
        },
        'independent Python contract changed'
      );
    const journals = path.join(repo, '.caws/sessions', sid, 'hook-invocations');
    const previous = new Set(fs.existsSync(journals) ? fs.readdirSync(journals) : []);
    const input = Buffer.from(
      JSON.stringify({
        cwd: repo,
        session_id: sid,
        tool_name: 'Bash',
        tool_input: { command },
      }) + '\n'
    );
    const coverageDirectory = path.join(directory, 'v8-coverage');
    fs.mkdirSync(coverageDirectory, { recursive: true, mode: 0o700 });
    const result = await invoke(
      native,
      [
        'invoke',
        '--engine',
        engine,
        '--node',
        node,
        '--surface',
        'codex',
        '--event',
        'pre_tool_use',
        '--runtime-digest',
        installed.digest,
        '--timeout-ms',
        '30000',
        '--configuration',
        'system',
      ],
      input,
      directory,
      {
        ...environment,
        CODEX_THREAD_ID: sid,
        CAWS_SESSION_ID: sid,
        NODE_V8_COVERAGE: coverageDirectory,
      }
    );
    const added = fs.existsSync(journals)
      ? fs.readdirSync(journals).filter((file) => !previous.has(file))
      : [];
    const journal: Data[] = [];
    for (const file of added) {
      const raw = fs.readFileSync(path.join(journals, file));
      put(path.join(directory, 'journals', file), raw);
      for (const line of raw.toString('utf8').split('\n').filter(Boolean)) {
        const row: unknown = JSON.parse(line);
        assert(object(row));
        journal.push(row);
      }
    }
    const state = path.join(repo, '.codex/hooks/state');
    const optional = (kind: string): Data | null => {
      const file = path.join(state, 'danger-' + kind + '-' + sid + '.json');
      if (!fs.existsSync(file)) return null;
      put(path.join(directory, kind + '.json'), fs.readFileSync(file));
      return read(file);
    };
    const observation: Observation = {
      name,
      command,
      sid,
      expected,
      status: result.status,
      stdout: result.stdout.toString('utf8'),
      stderr: result.stderr.toString('utf8'),
      warn: optional('warn'),
      latch: optional('latch'),
      journal,
      problems: [],
    };
    observation.problems.push(...problems(observation));
    const trace = coverage(coverageDirectory);
    const classifierRequired = !Object.keys(stateBefore).some((file) =>
      file.startsWith('danger-latch-')
    );
    json(path.join(directory, 'typed-execution.json'), { ...trace, classifierRequired });
    observation.problems.push(...coverageProblems(trace.calls, classifierRequired));
    if (
      added.length !== 1 ||
      journal.some(
        (row) => row.input_sha256 !== sha(input) || row.runtime_digest !== installed.digest
      )
    )
      observation.problems.push('journal-custody');
    const started = journal.filter((row) => row.stage === 'invocation_started'),
      selected = started[0]?.selected_handlers;
    if (
      started.length !== 1 ||
      started[0]!.resolved_session_id !== sid ||
      !Array.isArray(selected) ||
      selected.length !== 1 ||
      !object(selected[0]) ||
      selected[0].sha256 !== handler.sha256 ||
      selected[0].path !== handler.path ||
      selected[0].kind !== 'stock'
    )
      observation.problems.push('actual-selection');
    const stateAfter = allState();
    json(path.join(directory, 'state-after.json'), stateAfter);
    for (const [file, digest] of Object.entries(stateBefore))
      if (stateAfter[file] !== digest) observation.problems.push('existing-state-changed');
    observations.push(observation);
    json(path.join(directory, 'observation.json'), observation);
    if (observation.problems.length) failures.push(name + ': ' + observation.problems.join(', '));
    console.log(JSON.stringify({ name, code: result.status.code, problems: observation.problems }));
  }
  const warning = observations.find(
    (entry) => entry.expected === 'warning' && entry.problems.length === 0
  );
  const latch = observations.find(
    (entry) => entry.expected === 'latch' && entry.problems.length === 0
  );
  assert(warning && latch, 'positive controls required for oracle checks');
  const controls: Array<{ name: string; value: Observation; catches: string }> = [
    { name: 'missing-warning', value: { ...warning, warn: null }, catches: 'warning-json' },
    {
      name: 'wrong-warning-command',
      value: { ...warning, warn: { ...warning.warn, command: 'foreign' } },
      catches: 'warning-json',
    },
    {
      name: 'missing-finalization',
      value: { ...warning, journal: [] },
      catches: 'journal-finalization',
    },
    {
      name: 'premature-latch',
      value: { ...warning, latch: { command: warning.command } },
      catches: 'premature-latch',
    },
    {
      name: 'wrong-latch-command',
      value: { ...latch, latch: { ...latch.latch, command: 'foreign' } },
      catches: 'latch-json',
    },
    {
      name: 'allow-instead-of-block',
      value: { ...latch, stdout: '{"decision":"allow"}\n' },
      catches: 'protective-output',
    },
  ];
  json(
    path.join(root, 'oracle-controls.json'),
    controls.map((control) => {
      const rejected = problems(control.value);
      assert(rejected.includes(control.catches), 'oracle accepted corruption: ' + control.name);
      return { name: control.name, rejected };
    })
  );
  assert(
    coverageProblems({ tryExecuteStockHandler: 1, classifyCommand: 0 }, true).includes(
      'typed-classifier-not-observed'
    )
  );
  assert(
    coverageProblems({ tryExecuteStockHandler: 0, classifyCommand: 1 }, true).includes(
      'stock-executor-not-observed'
    )
  );
  json(path.join(root, 'coverage-oracle-controls.json'), {
    missingClassifier: coverageProblems({ tryExecuteStockHandler: 1, classifyCommand: 0 }, true),
    missingExecutor: coverageProblems({ tryExecuteStockHandler: 0, classifyCommand: 1 }, true),
  });
  assert.deepEqual(hashes(runtime), beforeRuntime);
  assert.deepEqual(hashes(path.join(cli, 'src')), beforeSource);
  assert.deepEqual(hashes(path.join(cli, 'dist')), beforeBuild);
  assert.deepEqual(
    Object.fromEntries(
      Object.entries({ native, node, python, jq }).map(([name, file]) => [
        name,
        { path: file, sha256: fileSha(file) },
      ])
    ),
    executables
  );
}
void run()
  .catch((error: unknown) => {
    failures.push(error instanceof Error ? (error.stack ?? error.message) : String(error));
  })
  .finally(() => {
    manifest.status = failures.length ? 'failed' : 'passed';
    manifest.fixtureRetained = true;
    json(path.join(root, 'manifest.json'), manifest);
    console.log(JSON.stringify({ status: manifest.status, artifacts: root, failures }, null, 2));
    process.exitCode = failures.length ? 1 : 0;
  });
