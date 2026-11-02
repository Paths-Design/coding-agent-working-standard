/**
 * R33 cold-service qualification, not a default unit test. Foreign code executes
 * only from retained private copies. No real Sterling lease/settings/data is read.
 * Arguments: caws-cli directory, Sterling directory, absolute Python, absolute jq.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';

type Data = Record<string, unknown>;
type Mode = 'legacy-python' | 'candidate-native';
type Instance = {
  pid: number;
  parent: number;
  group: number;
  startSeconds: string;
  startMicros: string;
  status: number;
  flags: number;
  zombie: boolean;
};
type Sample = { witness: Instance; observation: Data; state: 'live' | 'inactive' | 'unknown' };
type Samples = { values: Sample[]; incomplete: boolean };
type Exit = { code: number | null; signal: NodeJS.Signals | null };
type RequestResult = {
  ordinal: number;
  status: Data;
  rendered: Data;
  lease: Data | null;
  publishedLiveInstance: Instance | null;
  oneShotRendererExecutions: string[];
  state: Samples;
};

assert.equal(process.platform, 'darwin', 'this probe observes Darwin process identities');
for (const index of [2, 3, 4, 5]) assert(process.argv[index], 'four path arguments required');
const cli = fs.realpathSync(path.resolve(process.argv[2]!));
const sterling = fs.realpathSync(process.argv[3]!);
const python = fs.realpathSync(process.argv[4]!);
const jq = fs.realpathSync(process.argv[5]!);
for (const value of [cli, sterling, python, jq]) assert(path.isAbsolute(value));
assert(fs.existsSync(path.join(cli, 'src/runtime/engine.ts')));
const crate = path.resolve(cli, '../caws-native');
const requireBuilt = createRequire(path.join(cli, 'package.json'));
const selectedRequest = process.env.CAWS_NATIVE_BUILD_REQUEST;
assert(
  selectedRequest && path.isAbsolute(selectedRequest),
  'CAWS_NATIVE_BUILD_REQUEST must name an explicit absolute request file'
);
const nativeBuild = (
  requireBuilt(
    './dist/tooling/native-sqlite-build.js'
  ) as typeof import('../dist/tooling/native-sqlite-build')
).loadNativeSqliteBuild(selectedRequest);
assert.equal(nativeBuild.build.profile, 'debug', 'native qualification profile mismatch');
const native = nativeBuild.build.artifacts.native.path;
const observer = nativeBuild.build.artifacts.observer.path;
const nativeBuildEvidence = {
  requestFile: nativeBuild.requestFile,
  completionReceipt: nativeBuild.completionReceipt,
  requestDigest: nativeBuild.build.requestDigest,
  profile: nativeBuild.build.profile,
  prefixManifest: nativeBuild.build.prefixManifest,
  adoption: nativeBuild.build.adoption,
};
const engine = path.join(cli, 'dist/runtime/engine-entry.js');
const legacy = path.join(cli, 'templates/hook-packs/runtime/caws-hook.py');
const root = path.join(
  crate,
  'target/qualification/service-lifetime-' + new Date().toISOString().replace(/[:.]/g, '-')
);
fs.mkdirSync(root, { recursive: true, mode: 0o700 });
fs.chmodSync(root, 0o700);
const failures: string[] = [];
const results: Data[] = [];
// Longer than one bounded hook call. The foreign PID-only wedge reaper starts
// after 2*idle, so a fresh private lease cannot enter that path within our call.
const idleSeconds = 60;
const hookMilliseconds = 35000;
const cleanupMilliseconds = (idleSeconds + 8) * 1000;
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function put(file: string, value: string | Uint8Array): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, value, { mode: 0o600 });
}
function json(file: string, value: unknown): void {
  put(file, JSON.stringify(value, null, 2) + '\n');
}
function record(value: unknown): value is Data {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function read(file: string): Data {
  const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert(record(value), 'expected object: ' + file);
  return value;
}
function sha(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function files(directory: string, prefix = ''): string[] {
  return fs
    .readdirSync(directory)
    .sort()
    .flatMap((name) => {
      if (name === '__pycache__') return [];
      const relative = path.join(prefix, name);
      const stat = fs.lstatSync(path.join(directory, name));
      assert(!stat.isSymbolicLink(), 'unexpected source symlink: ' + relative);
      return stat.isDirectory()
        ? files(path.join(directory, name), relative)
        : stat.isFile()
          ? [relative]
          : [];
    });
}
function instance(value: unknown): Instance {
  assert(record(value), 'expected process instance');
  for (const key of ['pid', 'parent', 'group', 'status', 'flags'])
    assert(Number.isSafeInteger(value[key]) && Number(value[key]) >= 0, 'invalid ' + key);
  assert(Number(value.pid) > 1 && Number(value.pid) <= 2147483647);
  assert(typeof value.startSeconds === 'string' && /^[1-9][0-9]*$/.test(value.startSeconds));
  assert(typeof value.startMicros === 'string' && /^[0-9]{1,6}$/.test(value.startMicros));
  assert(Number(value.startMicros) < 1000000 && typeof value.zombie === 'boolean');
  return value as Instance;
}
function same(a: Instance, b: Instance): boolean {
  return a.pid === b.pid && a.startSeconds === b.startSeconds && a.startMicros === b.startMicros;
}
function observation(pid: number): Data {
  const r = spawnSync(observer, ['--observe', String(pid)], {
    env: { PATH: '/usr/bin:/bin' },
    encoding: 'utf8',
    timeout: 1000,
    maxBuffer: 16384,
  });
  if (r.status !== 0)
    return {
      state: 'unavailable',
      code: r.status,
      signal: r.signal,
      stderr: r.stderr,
      error: r.error?.message,
    };
  try {
    const value: unknown = JSON.parse(r.stdout);
    assert(record(value));
    return value;
  } catch {
    return { state: 'unavailable', stdout: r.stdout };
  }
}
function sample(directory: string, log: string): Samples {
  const names = fs.readdirSync(directory);
  assert(names.length <= 8, 'unexpected daemon startup count');
  let incomplete = names.some((name) => name.endsWith('.pending'));
  const values: Sample[] = [];
  for (const name of names.filter((name) => name.endsWith('.json'))) {
    let witness: Instance;
    try {
      witness = instance(read(path.join(directory, name)).process);
    } catch {
      incomplete = true;
      continue;
    }
    const current = observation(witness.pid);
    let state: Sample['state'] = 'unknown';
    if (current.state === 'absent') state = 'inactive';
    if (current.state === 'observed') {
      try {
        const observed = instance(current.process);
        state = !same(witness, observed) || observed.zombie ? 'inactive' : 'live';
      } catch {
        /* Malformed observations stay unknown, never cleaned. */
      }
    }
    values.push({ witness, observation: current, state });
  }
  const value = { values, incomplete };
  fs.appendFileSync(log, JSON.stringify({ at: Date.now(), ...value }) + '\n', { mode: 0o600 });
  return value;
}
function git(args: string[], repo: string, env: NodeJS.ProcessEnv): string {
  const r = spawnSync('/usr/bin/git', args, {
    cwd: repo,
    env,
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 1048576,
  });
  assert.equal(
    r.status,
    0,
    JSON.stringify({ args, code: r.status, stderr: r.stderr, error: r.error?.message })
  );
  return r.stdout.trim();
}
function transcript(repo: string, count: number): string {
  const rows: Data[] = [];
  for (let i = 1; i <= count; i++) {
    const timestamp = `2026-10-01T12:0${i}:00Z`;
    rows.push({
      timestamp,
      type: 'turn_context',
      payload: {
        turn_id: 'R33-' + i,
        cwd: repo,
        model: 'r33-fixture',
      },
    });
    rows.push({
      timestamp,
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'R33 user turn ' + i }],
      },
    });
    rows.push({
      timestamp,
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'exec_command',
        call_id: 'R33-call-' + i,
        arguments: JSON.stringify({ cmd: 'touch MUST-NOT-EXECUTE' }),
      },
    });
    rows.push({
      timestamp,
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'R33-call-' + i,
        output: 'Transcript data only; no command ran.',
      },
    });
    rows.push({
      timestamp,
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'R33 assistant turn ' + i }],
      },
    });
  }
  return rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
}
async function invoke(
  executable: string,
  args: string[],
  repo: string,
  env: NodeJS.ProcessEnv,
  directory: string,
  input: string,
  witness: string
): Promise<Data> {
  put(path.join(directory, 'input.bin'), input);
  json(path.join(directory, 'command.json'), { executable, args, cwd: repo });
  const out = fs.openSync(path.join(directory, 'stdout.bin'), 'wx', 0o600);
  const err = fs.openSync(path.join(directory, 'stderr.bin'), 'wx', 0o600);
  const child = spawn(executable, args, { cwd: repo, env, stdio: ['pipe', out, err] });
  fs.closeSync(out);
  fs.closeSync(err);
  let timedOut = false;
  let monitorFailed = false;
  let postKill: NodeJS.Timeout | undefined;
  const started = Date.now();
  let rejectWait: (error: Error) => void = () => {};
  const exited = new Promise<Exit>((resolve, reject) => {
    rejectWait = reject;
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  const timer = setTimeout(() => {
    timedOut = true;
    // Only the direct, still-owned hook child; never a daemon PID or group.
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    postKill = setTimeout(() => {
      json(path.join(directory, 'wait-unconfirmed.json'), {
        pid: child.pid,
        timedOut,
        reason: 'no owned-child exit notification within 2s after timeout signal',
      });
      child.unref();
      rejectWait(new Error('owned hook exit remains unconfirmed; retain sandbox and stop'));
    }, 2000);
  }, hookMilliseconds);
  const monitor = setInterval(() => {
    try {
      sample(witness, path.join(directory, 'process-observations.jsonl'));
    } catch (error) {
      if (!monitorFailed) failures.push(`${directory}: process monitor failed`);
      monitorFailed = true;
      json(path.join(directory, 'monitor-error.json'), { error: String(error) });
    }
  }, 250);
  child.stdin!.on('error', () => {});
  child.stdin!.end(input);
  try {
    const exit = await exited;
    const value = { ...exit, pid: child.pid, timedOut, elapsedMs: Date.now() - started };
    json(path.join(directory, 'status.json'), value);
    return value;
  } finally {
    clearTimeout(timer);
    clearTimeout(postKill);
    clearInterval(monitor);
  }
}
function render(session: string, directory: string, count: number): Data {
  const hashes: Record<string, string> = {};
  const turns: Data[] = [];
  for (const relative of files(session)) {
    const source = path.join(session, relative);
    put(path.join(directory, 'rendered', relative), fs.readFileSync(source));
    hashes[relative] = sha(source);
    if (/^turn-\d+\.json$/.test(relative)) turns.push(read(source));
  }
  const expected = Array.from({ length: count }, (_, i) => 'R33 user turn ' + (i + 1));
  const users = turns.map((turn) => turn.user);
  const value = {
    hashes,
    users,
    expected,
    complete: JSON.stringify(users) === JSON.stringify(expected),
    projection: turns.map((turn) => ({
      user: turn.user,
      status: turn.status,
      timeline: turn.timeline,
    })),
  };
  json(path.join(directory, 'render-observation.json'), value);
  return value;
}
function liveLease(lease: Data | null, state: Samples, hooks: string): Instance | null {
  if (!lease) return null;
  assert.equal(lease.hooks_dir, hooks);
  assert.equal(lease.idle_s, idleSeconds);
  assert.match(String(lease.token), /^[0-9a-f]{32}$/);
  assert(Number.isSafeInteger(lease.port) && Number(lease.port) > 0 && Number(lease.port) <= 65535);
  return (
    state.values.find((v) => v.state === 'live' && v.witness.pid === lease.pid)?.witness ?? null
  );
}

async function scenario(mode: Mode): Promise<boolean> {
  const directory = path.join(root, mode);
  const repo = path.join(directory, 'project');
  const home = path.join(directory, 'machine');
  const hooks = path.join(repo, '.caws/hooks');
  const witness = path.join(directory, 'witness');
  const renderWitness = path.join(directory, 'renderer-executions');
  const log = path.join(directory, 'process-observations.jsonl');
  for (const target of [
    repo,
    home,
    hooks,
    witness,
    renderWitness,
    path.join(directory, 'user'),
    path.join(directory, 'tmp'),
    path.join(directory, 'bin'),
  ])
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  fs.copyFileSync(observer, path.join(directory, 'bin/python3'));
  fs.chmodSync(path.join(directory, 'bin/python3'), 0o700);
  fs.symlinkSync(jq, path.join(directory, 'bin/jq'));
  fs.symlinkSync(process.execPath, path.join(directory, 'bin/node'));

  const foreign = path.join(sterling, '.caws/hooks');
  const sources = [
    'session-log.sh',
    'session_log_renderer.py',
    'session_log_daemon.py',
    'runtime-paths.sh',
    ...files(path.join(foreign, 'lib'))
      .filter((name) => /\.(py|sh|cjs)$/.test(name))
      .map((name) => path.join('lib', name)),
  ];
  const custody: Data[] = [];
  for (const relative of sources) {
    const source = path.join(foreign, relative);
    assert(fs.lstatSync(source).isFile());
    put(path.join(hooks, relative), fs.readFileSync(source));
    fs.chmodSync(path.join(hooks, relative), 0o700);
    const sourceSha256 = sha(source),
      copiedSha256 = sha(path.join(hooks, relative));
    assert.equal(sourceSha256, copiedSha256, 'source changed while copying: ' + relative);
    custody.push({ relative, source, sourceSha256, copiedSha256 });
  }
  json(path.join(directory, 'foreign-source-custody.json'), custody);
  const sid = 'R33-private-service';
  const env: NodeJS.ProcessEnv = {
    PATH: path.join(directory, 'bin') + ':/usr/bin:/bin',
    HOME: path.join(directory, 'user'),
    CAWS_HOME: home,
    CAWS_AGENT_SURFACE: 'codex',
    CAWS_SESSION_ID: sid,
    CODEX_THREAD_ID: sid,
    CAWS_TRAP_KILL: '0',
    CAWS_SLRD_IDLE_S: String(idleSeconds),
    LC_ALL: 'C',
    TZ: 'UTC',
    TMPDIR: path.join(directory, 'tmp'),
    PYTHONDONTWRITEBYTECODE: '1',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    CAWS_PROBE_REAL_PYTHON: python,
    CAWS_PROBE_DAEMON: path.join(hooks, 'session_log_daemon.py'),
    CAWS_PROBE_WITNESS: witness,
    CAWS_PROBE_RENDERER: path.join(hooks, 'session_log_renderer.py'),
    CAWS_PROBE_RENDER_WITNESS: renderWitness,
  };
  git(['init', '-q'], repo, env);
  git(
    [
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'user.name=R33 fixture',
      '-c',
      'user.email=r33@invalid',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'isolated fixture',
    ],
    repo,
    env
  );
  put(path.join(repo, '.caws/policy.yaml'), 'version: 1\n');
  fs.mkdirSync(path.join(repo, '.caws/specs'));

  const { installMachineRuntime } = requireBuilt(
    path.join(cli, 'dist/init/machine-adapters')
  ) as typeof import('../dist/init/machine-adapters');
  const { validateSystemPolicy } = requireBuilt(
    path.join(cli, 'dist/init/system-project-policy')
  ) as typeof import('../dist/init/system-project-policy');
  const { resolveInvocationSelection } = requireBuilt(
    path.join(cli, 'dist/runtime/selection')
  ) as typeof import('../dist/runtime/selection');
  const installed = installMachineRuntime({
    home,
    templatesRoot: path.join(cli, 'templates/hook-packs'),
  });
  json(path.join(directory, 'installer.json'), installed);
  const runtime = path.join(home, 'lib/runtimes', installed.digest);
  const defaults = read(path.join(runtime, 'system-policy.json')).events as Record<
    string,
    string[]
  >;
  assert(Array.isArray(defaults.stop));
  const present = defaults.stop.some((entry) => entry.split(' ')[0] === 'session-log.sh');
  const policy = {
    disabled: {
      stop: defaults.stop
        .map((entry) => entry.split(' ')[0]!)
        .filter((name) => name !== 'session-log.sh'),
    },
    extensions: present ? {} : { stop: [{ handler: 'session-log.sh', before: null }] },
    handlers: { 'session-log.sh': '.caws/hooks/session-log.sh' },
    libraries: {},
  };
  validateSystemPolicy(repo, policy, { files: [...installed.files], defaults });
  json(path.join(home, 'surfaces/codex/settings.json'), { version: 1, enabled: true });
  json(
    path.join(
      home,
      'state/projects',
      crypto.createHash('sha256').update(repo).digest('hex') + '.json'
    ),
    { version: 1, root: repo, surfaces: { codex: policy } }
  );
  const selection = resolveInvocationSelection({
    checkout: repo,
    canonical: repo,
    home,
    runtimeDigest: installed.digest,
    surface: 'codex',
    event: 'stop',
    system: true,
  });
  json(path.join(directory, 'selection.json'), selection);
  assert.equal(selection.status, 'active');
  if (selection.status !== 'active') throw new Error('inactive selection');
  assert.equal(selection.handlers.length, 1);
  assert.equal(selection.handlers[0]!.kind, 'project-override');
  assert.equal(selection.handlers[0]!.path, path.join(hooks, 'session-log.sh'));

  const session = path.join(repo, '.caws/sessions', sid);
  const leaseFile = path.join(repo, '.caws/sessions/.renderer-daemon.json');
  const transcriptFile = path.join(directory, 'codex-transcript.jsonl');
  json(path.join(session, '.meta.json'), {
    local_time: '2026-10-01T12:00:00Z',
    model: 'r33-fixture',
    head_sha: 'fixture',
  });
  const executable = mode === 'legacy-python' ? python : native;
  const args =
    mode === 'legacy-python'
      ? [legacy, 'codex', 'stop', '--system']
      : [
          'invoke',
          '--engine',
          engine,
          '--node',
          process.execPath,
          '--surface',
          'codex',
          '--event',
          'stop',
          '--runtime-digest',
          installed.digest,
          '--timeout-ms',
          '30000',
          '--configuration',
          'system',
        ];
  const input =
    JSON.stringify({
      cwd: repo,
      session_id: sid,
      transcript_path: transcriptFile,
      hook_event_name: 'Stop',
    }) + '\n';
  const requests: RequestResult[] = [];
  const result: Data = {
    mode,
    directory,
    requests,
    initiallyLeaseAbsent: !fs.existsSync(leaseFile),
    initiallyWitnessEmpty: fs.readdirSync(witness).length === 0,
  };
  results.push(result);
  let unresolved = true;
  try {
    for (let ordinal = 1; ordinal <= 2; ordinal++) {
      const step = path.join(directory, 'request-' + ordinal);
      fs.mkdirSync(step, { mode: 0o700 });
      if (ordinal === 2 && fs.existsSync(leaseFile)) {
        const lease = read(leaseFile),
          state = sample(witness, log);
        if (!liveLease(lease, state, hooks)) {
          assert(
            !state.incomplete &&
              state.values.length > 0 &&
              state.values.every((v) => v.state === 'inactive'),
            'ambiguous startup; stop additional requests'
          );
          // Do not contact a known-stale private lease or invoke its PID-only reaper.
          fs.renameSync(leaseFile, path.join(step, 'removed-stale-private-lease.json'));
        } else {
          assert(
            typeof lease.last_used === 'number' && Date.now() / 1000 - lease.last_used < 10,
            'do not activate the foreign stale-lease reaper'
          );
        }
      }
      put(transcriptFile, transcript(repo, ordinal + 1));
      put(path.join(step, 'transcript.jsonl'), fs.readFileSync(transcriptFile));
      const beforeRenderExecs = new Set(fs.readdirSync(renderWitness));
      const status = await invoke(executable, args, repo, env, step, input, witness);
      const oneShotRendererExecutions = fs
        .readdirSync(renderWitness)
        .filter((name) => !beforeRenderExecs.has(name));
      json(path.join(step, 'renderer-executions.json'), oneShotRendererExecutions);
      const rendered = render(session, step, ordinal + 1);
      assert(!fs.existsSync(path.join(repo, 'MUST-NOT-EXECUTE')));
      let state = sample(witness, log);
      let lease: Data | null = null,
        live: Instance | null = null;
      const until = Date.now() + 5000;
      do {
        state = sample(witness, log);
        lease = fs.existsSync(leaseFile) ? read(leaseFile) : null;
        live = liveLease(lease, state, hooks);
        // The daemon sends its response before publishing the updated served
        // count. Wait for that write rather than manufacturing a reuse failure.
        if (live && (ordinal === 1 || Number(lease?.served) > Number(requests[0]?.lease?.served)))
          break;
        await pause(100);
      } while (Date.now() < until);
      if (lease) json(path.join(step, 'lease.json'), lease);
      const value: RequestResult = {
        ordinal,
        status,
        rendered,
        lease,
        publishedLiveInstance: live,
        oneShotRendererExecutions,
        state,
      };
      requests.push(value);
      json(path.join(step, 'observation.json'), value);
      console.log(
        JSON.stringify({
          mode,
          ordinal,
          status,
          users: rendered.users,
          serviceInstance: live,
          served: lease?.served,
          oneShotRendererExecutions,
          observation: path.join(step, 'observation.json'),
        })
      );
      if (
        status.code !== 0 ||
        status.signal !== null ||
        status.timedOut ||
        rendered.complete !== true
      )
        failures.push(`${mode}: request ${ordinal} invocation/render failed`);
      if (!live) failures.push(`${mode}: request ${ordinal} service survival unproved`);
      if (
        oneShotRendererExecutions.some((name) => !name.endsWith('.json')) ||
        oneShotRendererExecutions.length !== (ordinal === 1 ? 1 : 0)
      )
        failures.push(
          `${mode}: request ${ordinal} did not follow cold-inline/warm-daemon execution`
        );
      assert(
        !state.incomplete &&
          state.values.length > 0 &&
          state.values.every((v) => v.state !== 'unknown'),
        'unknown startup identity; stop additional requests'
      );
    }
    const first = requests[0]!,
      second = requests[1]!;
    const a = first.publishedLiveInstance,
      b = second.publishedLiveInstance;
    const reused = a !== null && b !== null && same(a, b);
    const served =
      reused &&
      typeof first.lease?.served === 'number' &&
      typeof second.lease?.served === 'number' &&
      second.lease.served > first.lease.served;
    result.secondRequestServedByFirstDaemon = served;
    if (!served) failures.push(`${mode}: first daemon did not serve second request`);
  } finally {
    const until = Date.now() + cleanupMilliseconds;
    let state = sample(witness, log);
    do {
      state = sample(witness, log);
      unresolved =
        state.incomplete ||
        state.values.length === 0 ||
        state.values.some((v) => v.state !== 'inactive');
      if (!unresolved) break;
      await pause(250);
    } while (Date.now() < until);
    const cleanup = {
      policy: 'foreign-self-idle-only',
      state,
      leasePresent: fs.existsSync(leaseFile),
      unresolved,
    };
    result.cleanup = cleanup;
    json(path.join(directory, 'cleanup.json'), cleanup);
    json(path.join(directory, 'result.json'), result);
    console.log(
      JSON.stringify(
        {
          mode,
          requests: requests.map((r) => ({
            ordinal: r.ordinal,
            status: r.status,
            users: r.rendered.users,
            publishedLiveInstance: r.publishedLiveInstance,
            served: r.lease?.served,
          })),
          cleanup,
        },
        null,
        2
      )
    );
    if (unresolved || cleanup.leasePresent)
      failures.push(`${mode}: cleanup unresolved; retain sandbox and stop`);
  }
  return unresolved || fs.existsSync(leaseFile);
}

async function run(): Promise<void> {
  console.log(JSON.stringify({ artifactRoot: root, stage: 'starting' }));
  const self = observation(process.pid),
    invalid = observation(1);
  json(path.join(root, 'observer-controls.json'), { self, invalid });
  assert.equal(self.state, 'observed');
  assert.equal(instance(self.process).pid, process.pid);
  assert.equal(invalid.state, 'unavailable');
  const identities: Record<string, string> = {};
  for (const file of [native, observer, engine, legacy, python, jq, process.execPath])
    identities[file] = sha(file);
  const modules: Record<string, string> = {};
  for (const relative of files(path.join(cli, 'dist')))
    if (/\.(js|json)$/.test(relative)) modules[relative] = sha(path.join(cli, 'dist', relative));
  json(path.join(root, 'build-identities.json'), {
    nativeBuild: nativeBuildEvidence,
    identities,
    modules,
    revision: git(['rev-parse', 'HEAD'], cli, { PATH: '/usr/bin:/bin' }),
    runnerSource: sha(path.join(cli, 'scripts/qualify-native-services.ts')),
    observerSource: sha(path.join(crate, 'examples/service-observer.rs')),
    emittedRunner: sha(process.argv[1]!),
  });
  for (const mode of ['legacy-python', 'candidate-native'] as const) {
    try {
      if (await scenario(mode)) break;
    } catch (error) {
      failures.push(`${mode}: ${error instanceof Error ? error.stack : String(error)}`);
      break; // No additional case after uncertain cleanup or interrupted accounting.
    }
  }
}
void run()
  .catch((error) => {
    failures.push(error instanceof Error ? (error.stack ?? error.message) : String(error));
  })
  .finally(() => {
    json(path.join(root, 'manifest.json'), {
      root,
      failures,
      results,
      nonclaims: [
        'No installed runtime or real Sterling daemon/settings/data was exercised.',
        'A pre-exec witness alone does not establish interpreter exec or readiness.',
        'No daemon wait status or independent cause of process disappearance.',
        'Render completeness checks user strings only; tool, assistant and timeline semantics are unqualified.',
        'Inactive samples account only for witnessed instances, not every descendant.',
        'No concurrent starters, generation retirement, reaper safety or request-child canary.',
        'No service ownership implementation, Python retirement or full parity.',
        'Unwitnessed startup or unavailable observation leaves cleanup unresolved.',
        'Self-idle observation cannot guarantee reclamation of a wedged orphan.',
      ],
    });
    console.log(JSON.stringify({ artifactRoot: root, failures }, null, 2));
    process.exitCode = failures.length === 0 ? 0 : 1;
  });
