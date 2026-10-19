/**
 * Explicit effect qualification, not a default unit suite or a native-harness claim.
 * Build this file with the installed TypeScript compiler, then pass the absolute
 * caws-cli directory to the emitted program. All signals are selected by the real
 * guard against a dedicated compiled ancestor; the runner never signals a PID.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';

type Exit = { code: number | null; signal: NodeJS.Signals | null };
type Owned = {
  child: ChildProcess;
  exited: Promise<Exit>;
  captureClosed?: Promise<void>;
  stopCapture?: () => void;
};
type CaseKind =
  | 'enabled'
  | 'disabled'
  | 'wrong-start'
  | 'wrong-pid'
  | 'wrong-comm'
  | 'missing-stamp'
  | 'missing-pid'
  | 'missing-start'
  | 'missing-comm'
  | 'malformed-pid'
  | 'malformed-start';
type Mode = 'legacy-python' | 'candidate-native';
type ObjectData = Record<string, unknown>;

const cli = fs.realpathSync(path.resolve(process.argv[2] ?? '.'));
assert(fs.existsSync(path.join(cli, 'src/runtime/engine.ts')), 'pass the caws-cli directory');
const crate = path.resolve(cli, '../caws-native');
const requireBuilt = createRequire(path.join(cli, 'package.json'));
const root = path.join(
  crate,
  'target/qualification/containment-effect-' + new Date().toISOString().replace(/[:.]/g, '-')
);
fs.mkdirSync(root, { recursive: true, mode: 0o700 });
fs.chmodSync(root, 0o700);

function put(file: string, value: string | Uint8Array): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, value, { mode: 0o600 });
}
function json(file: string, value: unknown): void {
  put(file, JSON.stringify(value, null, 2) + '\n');
}
function object(file: string): ObjectData {
  const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as ObjectData;
}
function sha(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function start(
  executable: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  directory: string,
  captureProbe = false
): Owned {
  const out = fs.openSync(path.join(directory, 'process-stdout.bin'), 'w', 0o600);
  const err = fs.openSync(path.join(directory, 'process-stderr.bin'), 'w', 0o600);
  let child: ChildProcess;
  try {
    child = spawn(executable, args, {
      cwd,
      env,
      stdio: captureProbe ? ['ignore', out, err, 'pipe', 'pipe'] : ['ignore', out, err],
    });
  } finally {
    fs.closeSync(out);
    fs.closeSync(err);
  }
  const owned: Owned = {
    child,
    exited: new Promise<Exit>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    }),
  };
  if (captureProbe) {
    const stdout = child.stdio[3],
      stderr = child.stdio[4];
    assert(stdout instanceof Readable && stderr instanceof Readable);
    const capture = new AbortController();
    owned.stopCapture = () => capture.abort();
    owned.captureClosed = Promise.all([
      pipeline(
        stdout,
        fs.createWriteStream(path.join(directory, 'probe/stdout.bin'), { mode: 0o600 }),
        { signal: capture.signal }
      ),
      pipeline(
        stderr,
        fs.createWriteStream(path.join(directory, 'probe/stderr.bin'), { mode: 0o600 }),
        { signal: capture.signal }
      ),
    ]).then(
      () => {
        put(
          path.join(directory, 'probe/output-capture-complete.marker'),
          'both pipe writers reached EOF\n'
        );
      },
      (error: unknown) => {
        json(path.join(directory, 'probe/output-capture-incomplete.json'), {
          captureComplete: false,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    );
    void owned.captureClosed.catch(() => undefined); // The original promise is awaited below.
  }
  return owned;
}
async function until(
  check: () => boolean,
  description: string,
  milliseconds = 15000
): Promise<void> {
  const end = Date.now() + milliseconds;
  while (!check()) {
    if (Date.now() >= end) throw new Error('Timed out: ' + description);
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}
async function bounded<T>(pending: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Owned process did not exit')), milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
function exited(owned: Owned, milliseconds = 15000): Promise<Exit> {
  return bounded(owned.exited, milliseconds);
}
function observe(pid: number, file: string): string {
  const result = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'pid=,ppid=,lstart=,comm='], {
    encoding: 'utf8',
  });
  json(file, {
    command: ['/bin/ps', '-p', String(pid), '-o', 'pid=,ppid=,lstart=,comm='],
    exit_code: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  });
  assert.equal(result.status, 0);
  return result.stdout;
}

const manifest: {
  revision: string;
  root: string;
  cases: ObjectData[];
  failures: string[];
  nonclaims: string[];
  [key: string]: unknown;
} = {
  revision: spawnSync('/usr/bin/git', ['rev-parse', 'HEAD'], {
    cwd: cli,
    encoding: 'utf8',
  }).stdout.trim(),
  root,
  cases: [],
  failures: [],
  nonclaims: [
    'Both frontends select the same generated template snapshot, which may differ from the installed release',
    'Disposable caller and sibling, not actual harness ingress or exclusive shared-backend targeting',
    'Only selected stock Codex block-dangerous; not the default complete guard chain',
    'No proposed shell command executes; permitted fixture work is limited to marker files',
    'No resident service, installation, thirteen-session workload or full migration acceptance',
  ],
};

async function qualifyWatchdog(binary: string): Promise<void> {
  const directory = path.join(root, 'watchdog-control');
  put(path.join(directory, 'unlatched/input.bin'), '{}\n');
  put(path.join(directory, 'hook-args.bin'), '30');
  const started = process.hrtime.bigint();
  const caller = start(
    binary,
    [],
    directory,
    {
      PATH: '/usr/bin:/bin',
      PROBE_CASE_ROOT: directory,
      PROBE_HOOK_EXECUTABLE: '/bin/sleep',
      PROBE_HOOK_TIMEOUT_MS: '100',
    },
    directory
  );
  try {
    const status = await exited(caller, 15000);
    const reaped = object(path.join(directory, 'unlatched/watchdog-reaped.json'));
    const observation = {
      callerExit: status,
      ownedHookWait: reaped,
      elapsedMs: Number(process.hrtime.bigint() - started) / 1e6,
      allowedMarker: fs.existsSync(path.join(directory, 'allowed-before-latch.marker')),
    };
    json(path.join(directory, 'observation.json'), observation);
    manifest.watchdogControl = observation;
    console.log(JSON.stringify({ watchdogControl: observation }, null, 2));
    assert.deepEqual(status, { code: 21, signal: null });
    assert.deepEqual(reaped, { code: null, signal: 15 });
    assert.equal(observation.allowedMarker, false);
  } finally {
    put(path.join(directory, 'abort-probe'), 'cooperative abort of owned watchdog control\n');
    await exited(caller, 45000);
  }
}

async function run(): Promise<void> {
  const binary = path.join(root, 'bin/caws-q-agent');
  fs.mkdirSync(path.dirname(binary), { mode: 0o700 });
  // Resolve the ancestor walk with the system observer, ahead of caller PATH tools.
  fs.symlinkSync('/bin/ps', path.join(root, 'bin/ps'));
  const fixture = path.join(crate, 'tests/fixtures/containment-agent.rs');
  const build = spawnSync('rustc', [fixture, '-o', binary], { encoding: 'utf8' });
  json(path.join(root, 'fixture-build.json'), {
    command: ['rustc', fixture, '-o', binary],
    exit_code: build.status,
    stdout: build.stdout,
    stderr: build.stderr,
  });
  assert.equal(build.status, 0);
  await qualifyWatchdog(binary);
  const native = path.join(crate, 'target/debug/caws-native');
  const engine = path.join(cli, 'dist/runtime/engine-entry.js');
  const legacy = path.join(cli, 'templates/hook-packs/runtime/caws-hook.py');
  manifest.binaryIdentities = {
    fixture: sha(binary),
    native: sha(native),
    engine: sha(engine),
    legacy: sha(legacy),
  };
  manifest.fixtureSourceSha256 = sha(fixture);
  manifest.runnerSourceSha256 = sha(path.join(cli, 'scripts/qualify-native-containment.ts'));
  assert(process.argv[1] !== undefined);
  manifest.compiledRunnerSha256 = sha(process.argv[1]);
  const modules: Record<string, string> = {};
  for (const name of fs.readdirSync(path.join(cli, 'dist/runtime')))
    if (name.endsWith('.js')) modules[name] = sha(path.join(cli, 'dist/runtime', name));
  json(path.join(root, 'runtime-build.json'), modules);
  const { installMachineRuntime } = requireBuilt(
    path.join(cli, 'dist/init/machine-adapters')
  ) as typeof import('../dist/init/machine-adapters');
  const { validateSystemPolicy } = requireBuilt(
    path.join(cli, 'dist/init/system-project-policy')
  ) as typeof import('../dist/init/system-project-policy');
  const home = path.join(root, 'machine');
  const installed = installMachineRuntime({
    home,
    templatesRoot: path.join(cli, 'templates/hook-packs'),
  });
  json(path.join(root, 'installer.json'), installed);
  manifest.runtimeDigest = installed.digest;
  const runtime = path.join(home, 'lib/runtimes', installed.digest);
  manifest.selectedGuardSha256 = sha(path.join(runtime, 'block-dangerous.sh'));
  const defaults = object(path.join(runtime, 'system-policy.json'));
  assert(defaults.events !== null && typeof defaults.events === 'object');
  const events = defaults.events as Record<string, string[]>;
  const entries = events.pre_tool_use;
  assert(Array.isArray(entries));
  const policy = {
    disabled: {
      pre_tool_use: [
        ...new Set(
          entries
            .map((entry) => entry.split(' ')[0]!)
            .filter((name) => name !== 'block-dangerous.sh')
        ),
      ],
    },
    extensions: {},
    handlers: {},
    libraries: {},
  };
  json(path.join(home, 'surfaces/codex/settings.json'), { version: 1, enabled: true });

  for (const mode of ['legacy-python', 'candidate-native'] as const) {
    for (const kind of [
      'enabled',
      'disabled',
      'wrong-start',
      'wrong-pid',
      'wrong-comm',
      'missing-stamp',
      'missing-pid',
      'missing-start',
      'missing-comm',
      'malformed-pid',
      'malformed-start',
    ] as const) {
      try {
        await scenario(
          mode,
          kind,
          binary,
          home,
          runtime,
          policy,
          installed,
          validateSystemPolicy,
          native,
          engine,
          legacy
        );
      } catch (error: unknown) {
        const failure = {
          mode,
          kind,
          error: error instanceof Error ? (error.stack ?? error.message) : String(error),
        };
        json(path.join(root, mode, kind, 'scenario-incomplete.json'), failure);
        manifest.failures.push(mode + '/' + kind + ': ' + failure.error);
        console.log(JSON.stringify(failure, null, 2));
      }
    }
  }
}

async function scenario(
  mode: Mode,
  kind: CaseKind,
  binary: string,
  home: string,
  runtime: string,
  policy: Parameters<typeof import('../dist/init/system-project-policy').validateSystemPolicy>[1],
  installed: ReturnType<typeof import('../dist/init/machine-adapters').installMachineRuntime>,
  validateSystemPolicy: typeof import('../dist/init/system-project-policy').validateSystemPolicy,
  native: string,
  engine: string,
  legacy: string
): Promise<void> {
  const directory = path.join(root, mode, kind);
  const repo = path.join(directory, 'project');
  const siblingDir = path.join(directory, 'sibling');
  fs.mkdirSync(repo, { recursive: true, mode: 0o700 });
  fs.mkdirSync(siblingDir, { mode: 0o700 });
  const env: NodeJS.ProcessEnv = {
    PATH: path.dirname(binary) + ':' + (process.env.PATH ?? '/usr/bin:/bin'),
    HOME: directory,
    CAWS_HOME: home,
    CAWS_AGENT_SURFACE: 'codex',
    CAWS_AGENT_PROCESS_NAMES: 'caws-q-agent',
    CAWS_TRAP_KILL: kind === 'disabled' ? '0' : '1',
    LC_ALL: 'C',
    PROBE_CASE_ROOT: directory,
    PROBE_CAPTURE_FDS: '1',
  };
  const init = spawnSync('/usr/bin/git', ['init', '-q'], { cwd: repo, env });
  assert.equal(init.status, 0);
  put(path.join(repo, '.caws/policy.yaml'), 'version: 1\n');
  fs.mkdirSync(path.join(repo, '.caws/specs'));
  // Stock safety attestation strips live platform names; only our compiled caller remains.
  put(path.join(repo, '.caws/hooks/.test-harness'), 'owned disposable containment fixture\n');
  const defaults = JSON.parse(fs.readFileSync(path.join(runtime, 'system-policy.json'), 'utf8'));
  validateSystemPolicy(repo, policy, { files: [...installed.files], defaults: defaults.events });
  const projectKey = crypto.createHash('sha256').update(repo).digest('hex');
  json(path.join(home, 'state/projects', projectKey + '.json'), {
    version: 1,
    root: repo,
    surfaces: { codex: policy },
  });
  const sid = 'effect-' + kind;
  for (const [step, command] of [
    ['unlatched', 'node -e \'process.stdout.write("fixture")\''],
    ['arm', 'rm -rf /'],
    ['probe', 'node -e \'process.stdout.write("fixture")\''],
  ]) {
    assert(step !== undefined && command !== undefined);
    put(
      path.join(directory, step, 'input.bin'),
      JSON.stringify({ cwd: repo, session_id: sid, tool_name: 'Bash', tool_input: { command } }) +
        '\n'
    );
  }
  const executable = mode === 'legacy-python' ? '/usr/bin/python3' : native;
  const args =
    mode === 'legacy-python'
      ? [legacy, 'codex', 'pre_tool_use', '--system']
      : [
          'invoke',
          '--engine',
          engine,
          '--node',
          process.execPath,
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
        ];
  put(path.join(directory, 'hook-args.bin'), args.join('\0'));
  env.PROBE_HOOK_EXECUTABLE = executable;
  json(path.join(directory, 'hook-command.json'), {
    executable,
    args,
    cwd: repo,
    surface: 'codex',
    session_id: sid,
    kill_mode: env.CAWS_TRAP_KILL,
    proposedCommandsExecuted: false,
  });
  const sibling = start(
    binary,
    ['--sibling'],
    repo,
    { PATH: process.env.PATH, PROBE_CASE_ROOT: siblingDir },
    siblingDir
  );
  const caller = start(binary, [], repo, env, directory, true);
  const callerPid = caller.child.pid;
  const siblingPid = sibling.child.pid;
  assert(callerPid !== undefined && siblingPid !== undefined && callerPid !== siblingPid);
  try {
    const observed = observe(callerPid, path.join(directory, 'caller-observed.json'));
    observe(siblingPid, path.join(directory, 'sibling-observed.json'));
    assert(observed.includes(binary));
    await until(
      () =>
        fs.existsSync(path.join(directory, 'ready-for-next-attempt')) ||
        caller.child.exitCode !== null ||
        caller.child.signalCode !== null,
      'caller arming'
    );
    assert.equal(caller.child.exitCode, null);
    assert.equal(caller.child.signalCode, null);
    assert(fs.existsSync(path.join(directory, 'allowed-before-latch.marker')));
    const latchFile = path.join(repo, '.codex/hooks/state/danger-latch-' + sid + '.json');
    const armed = object(latchFile);
    json(path.join(directory, 'latch-armed.json'), armed);
    assert.equal(armed.agent_pid, String(callerPid));
    assert.equal(armed.agent_pid_comm, binary);
    assert(
      typeof armed.agent_pid_started_at === 'string' &&
        /^[1-9][0-9]*$/.test(armed.agent_pid_started_at)
    );
    if (kind === 'wrong-start') armed.agent_pid_started_at = '1';
    if (kind === 'wrong-pid') armed.agent_pid = String(siblingPid);
    if (kind === 'wrong-comm') armed.agent_pid_comm = binary + '-foreign';
    if (kind === 'missing-pid') delete armed.agent_pid;
    if (kind === 'missing-start') delete armed.agent_pid_started_at;
    if (kind === 'missing-comm') delete armed.agent_pid_comm;
    if (kind === 'malformed-pid') armed.agent_pid = '-1';
    if (kind === 'malformed-start') armed.agent_pid_started_at = 'not-an-epoch';
    if (kind === 'missing-stamp') {
      delete armed.agent_pid;
      delete armed.agent_pid_started_at;
      delete armed.agent_pid_comm;
    }
    if (kind !== 'enabled' && kind !== 'disabled') json(latchFile, armed);
    json(path.join(directory, 'latch-before-next-attempt.json'), object(latchFile));
    const heartbeat = path.join(siblingDir, 'sibling-heartbeat.txt');
    await until(() => fs.existsSync(heartbeat), 'sibling heartbeat');
    const before = fs.statSync(heartbeat).size;
    put(path.join(directory, 'release-next-attempt'), 'validated owned target\n');
    const callerExit = await exited(caller, 45000);
    json(path.join(directory, 'caller-wait-status.json'), callerExit);
    await until(
      () => fs.statSync(heartbeat).size > before,
      'sibling continuation after caller exit'
    );
    assert.equal(sibling.child.exitCode, null);
    assert.equal(sibling.child.signalCode, null);
    const after = fs.statSync(heartbeat).size;
    const escalation = path.join(repo, '.codex/logs/danger-latch-escalations.log');
    // The hook can outlive its terminated caller. EOF is the capture barrier;
    // the surviving runner keeps the raw bytes without changing caller ancestry.
    assert(caller.captureClosed !== undefined);
    await bounded(caller.captureClosed, 45000);
    const stdout = fs.readFileSync(path.join(directory, 'probe/stdout.bin'), 'utf8');
    const stderr = fs.readFileSync(path.join(directory, 'probe/stderr.bin'), 'utf8');
    const expectedSignal = kind === 'enabled' ? 'SIGTERM' : null;
    let refusal: unknown;
    try {
      refusal = JSON.parse(stdout);
    } catch {
      refusal = null;
    }
    const knownRefusal =
      refusal !== null &&
      typeof refusal === 'object' &&
      (refusal as ObjectData).decision === 'block' &&
      typeof (refusal as ObjectData).reason === 'string' &&
      ((refusal as ObjectData).reason as string).includes('QUARANTINED');
    const outcome = {
      mode,
      kind,
      directory,
      callerPid,
      siblingPid,
      callerExit,
      expectedSignal,
      outputCaptureComplete: true,
      hookExitStatusObservedByCaller: fs.existsSync(
        path.join(directory, 'probe/caller-observed-exit.txt')
      )
        ? fs.readFileSync(path.join(directory, 'probe/caller-observed-exit.txt'), 'utf8')
        : null,
      identitySafe:
        kind === 'enabled'
          ? callerExit.signal === 'SIGTERM'
          : callerExit.code === 0 && callerExit.signal === null,
      allowedActionObserved: fs.existsSync(path.join(directory, 'allowed-before-latch.marker')),
      forbiddenActionObserved: fs.existsSync(path.join(directory, 'forbidden-after-latch.marker')),
      callerSurvivedRefusal: fs.existsSync(path.join(directory, 'survived-after-refusal.marker')),
      siblingHeartbeatBytesBefore: before,
      siblingHeartbeatBytesAfter: after,
      knownRefusal,
      stdout,
      stderr,
      latch: object(latchFile),
      escalation: fs.existsSync(escalation) ? fs.readFileSync(escalation, 'utf8') : null,
    };
    json(path.join(directory, 'observation.json'), outcome);
    manifest.cases.push(outcome);
    console.log(
      JSON.stringify({
        mode,
        kind,
        callerExit,
        identitySafe: outcome.identitySafe,
        knownRefusal,
        forbiddenActionObserved: outcome.forbiddenActionObserved,
        siblingHeartbeatBytesBefore: before,
        siblingHeartbeatBytesAfter: after,
        escalation: outcome.escalation,
        artifacts: directory,
      })
    );
    if (
      !outcome.identitySafe ||
      outcome.forbiddenActionObserved ||
      !knownRefusal ||
      outcome.escalation === null
    )
      manifest.failures.push(
        mode + '/' + kind + ': intended containment/refusal behavior not established'
      );
  } finally {
    put(path.join(directory, 'abort-probe'), 'stop owned fixture if it is still waiting\n');
    put(path.join(siblingDir, 'stop-sibling'), 'cooperative fixture stop\n');
    caller.stopCapture?.();
    await caller.captureClosed?.catch(() => undefined);
    const siblingExit = await exited(sibling);
    json(path.join(directory, 'sibling-wait-status.json'), siblingExit);
    assert.deepEqual(siblingExit, { code: 0, signal: null });
    await exited(caller, 45000);
  }
}

run()
  .catch((error: unknown) => {
    manifest.failures.push(error instanceof Error ? (error.stack ?? error.message) : String(error));
  })
  .finally(() => {
    manifest.status = manifest.failures.length ? 'failed' : 'passed';
    json(path.join(root, 'manifest.json'), manifest);
    console.log(
      JSON.stringify(
        {
          status: manifest.status,
          artifacts: root,
          failures: manifest.failures,
          nonclaims: manifest.nonclaims,
        },
        null,
        2
      )
    );
    process.exitCode = manifest.failures.length ? 1 : 0;
  });
