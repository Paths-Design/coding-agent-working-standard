/** Actual native owner + reviewed copied Sterling profile. Root runs after build.
 * Usage: qualify-render-owner.js <caws-cli-root> <sterling-root> [debug|release] [--prepare-only|--warm-session-end --artifacts <fresh-absolute>]
 * Warm mode requires the supervising Node child argv0 to be claude, so the
 * original frontend can independently observe its real Claude ancestor.
 * This installs a runtime only into its retained private sandbox. It never
 * changes selected machine adapters, modifies foreign sources, adopts a PID,
 * signals a service PID, or deletes a sandbox. Preparation alone is not qualification.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { TextDecoder } from 'node:util';
import { spawn, spawnSync } from 'node:child_process';
import {
  selectRequestChain,
  confirmRequestChain,
  retainRequestInstance,
  requestCleanupObservation,
  type ProcessInstance as Instance,
  type ProcessRow,
  type RequestCoverage,
} from './render-request-topology';
import {
  RequestCustodyCollector,
  combinedRequestCleanup,
  decodeInvocationIdentity,
  MAX_TYPED_JOURNAL,
  type CustodyExpectation,
} from './render-request-custody';

type Data = Record<string, unknown>;
type CommandReceipt = {
  code: number | null;
  signal: NodeJS.Signals | null;
  error: string | null;
  directory: string;
  pid?: number;
  timedOut?: boolean;
};
assert(process.argv[2] && process.argv[3], 'CLI root and Sterling root are required');
const cli = fs.realpathSync(path.resolve(process.argv[2]));
const sterling = fs.realpathSync(path.resolve(process.argv[3]));
const crate = path.resolve(cli, '../caws-native');
const optionalArguments = process.argv.slice(4);
const nativeProfile = ['debug', 'release'].includes(optionalArguments[0] ?? '')
  ? optionalArguments.shift()!
  : 'release';
const prepareOnly = optionalArguments[0] === '--prepare-only';
if (prepareOnly) optionalArguments.shift();
const warmSessionEnd = optionalArguments[0] === '--warm-session-end';
if (warmSessionEnd) optionalArguments.shift();
assert(!(prepareOnly && warmSessionEnd), 'preparation and warm qualification are separate modes');
let explicitArtifactRoot: string | undefined;
if (optionalArguments[0] === '--artifacts') {
  assert(warmSessionEnd, '--artifacts is reserved for warm qualification');
  optionalArguments.shift();
  explicitArtifactRoot = optionalArguments.shift();
  assert(explicitArtifactRoot, '--artifacts requires a fresh absolute path');
}
assert(
  !warmSessionEnd || explicitArtifactRoot,
  'warm qualification requires --artifacts <fresh-absolute>'
);
if (warmSessionEnd)
  assert.equal(process.argv0, 'claude', 'launch qualifier with real argv0=claude');
assert.equal(
  optionalArguments.length,
  0,
  'expected optional debug|release followed by --prepare-only or --warm-session-end --artifacts <fresh-absolute>'
);
const selectedRequest = process.env.CAWS_NATIVE_BUILD_REQUEST;
assert(
  selectedRequest && path.isAbsolute(selectedRequest),
  'CAWS_NATIVE_BUILD_REQUEST must name an explicit absolute request file'
);
const nativeBuild = (
  createRequire(path.join(cli, 'package.json'))(
    './dist/tooling/native-sqlite-build.js'
  ) as typeof import('../dist/tooling/native-sqlite-build')
).loadNativeSqliteBuild(selectedRequest);
assert.equal(nativeBuild.build.profile, nativeProfile, 'native qualification profile mismatch');
const native = nativeBuild.build.artifacts.native.path;
const observer = nativeBuild.build.artifacts.observer.path;
const custodyObserver = nativeBuild.build.artifacts.custodyObserver.path;
const root =
  explicitArtifactRoot ??
  path.join(
    crate,
    'target/qualification/render-owner-' + new Date().toISOString().replace(/[:.]/g, '-')
  );
if (warmSessionEnd) {
  assert(
    path.isAbsolute(root) && path.normalize(root) === root,
    'artifact root must be absolute and normalized'
  );
  assert.equal(
    fs.realpathSync(path.dirname(root)),
    path.dirname(root),
    'artifact parent must use its physical path'
  );
  fs.mkdirSync(root, { mode: 0o700 });
} else fs.mkdirSync(root, { recursive: true, mode: 0o700 });
fs.chmodSync(root, 0o700);
// An independent repository is required by init's canonical/worktree contract.
// Evidence stays in the owned ignored artifact root; the sandbox is retained.
const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'caws-render-owner-')));
const home = path.join(sandbox, 'machine'),
  project = path.join(sandbox, 'project');
const owner = path.join(home, 'state/render-service');
const engine = path.join(cli, 'dist/runtime/engine-entry.js');
const cliEntry = path.join(cli, 'dist/index.js');
const sessionId = 'render-owner-private-fixture';
const session = path.join(project, '.caws/sessions', sessionId);
const transcriptFile = path.join(root, 'transcript.jsonl');
const nativeSocket = path.join(
  '/private/tmp',
  'caws-render-' + process.getuid?.() + '-' + digest(home).slice(0, 24),
  'owner.sock'
);
const failures: string[] = [],
  gaps: string[] = [];
const requests: Data[] = [];
const processes = new Map<number, Instance>();
const requestProcesses = new Map<number, Instance>();
const requestCoverage = new Map<string, RequestCoverage>();
const requestCustodies = new Map<
  string,
  {
    collector: RequestCustodyCollector;
    expected: CustodyExpectation | null;
  }
>();
const backendPids = new Set<number>();
const manifest: Data = {
  schema: 'caws.qualification.render-owner.v1',
  nativeBuild: {
    requestFile: nativeBuild.requestFile,
    completionReceipt: nativeBuild.completionReceipt,
    requestDigest: nativeBuild.build.requestDigest,
    profile: nativeBuild.build.profile,
    prefixManifest: nativeBuild.build.prefixManifest,
    adoption: nativeBuild.build.adoption,
  },
  state: 'running',
  mode: prepareOnly ? 'prepare_only' : warmSessionEnd ? 'warm_session_end' : 'full_qualification',
  artifactRoot: root,
  sandbox,
  nativeProfile,
  cli,
  sterling,
  home,
  project,
  native,
  observer,
  custodyObserver,
  engine,
  startedAt: new Date().toISOString(),
  requests,
  failures,
  evidenceGaps: gaps,
  nonclaims: [
    'deployed Sterling parity',
    'machine installation/adoption',
    'arbitrary same-UID adversary defense',
    'power-cut durability',
    'legacy Render consumer acknowledgement, compaction, or live-capacity progression',
    'legacy Render B current-marker validation',
    'event ordering without a contender does not independently prove uninterrupted writer custody',
    'concurrent FIFO ordering (warm SessionEnd mode is sequential)',
    'full operating-system dependency hash closure',
  ],
};
let commandNumber = 0,
  monitor: ReturnType<typeof setInterval> | undefined;
let fixturePrepared = false;
let lastDaemon: Instance | null = null;
let lastNativeWorker: { created: Data; birth: Instance } | null = null;
let warmSealInvocationId: string | null = null;
let cleanup: Data = { state: 'not_observed' };
const pause = (ms: number): Promise<void> => new Promise((accept) => setTimeout(accept, ms));
function object(value: unknown): value is Data {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function row(value: unknown, label = 'object'): Data {
  assert(object(value), label);
  return value;
}
function digest(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
function put(file: string, bytes: string | Uint8Array): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, bytes, { mode: 0o600 });
}
function json(file: string, value: unknown): void {
  put(file, JSON.stringify(value, null, 2) + '\n');
}
function persist(): void {
  json(path.join(root, 'manifest.json'), manifest);
}
function read(file: string): Data {
  return row(JSON.parse(fs.readFileSync(file, 'utf8')), file);
}
function list(directory: string, prefix = ''): string[] {
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory)
    .sort()
    .flatMap((name) => {
      const relative = prefix ? prefix + '/' + name : name;
      const file = path.join(directory, name),
        stat = fs.lstatSync(file);
      assert(!stat.isSymbolicLink(), 'refuse snapshot/source symlink: ' + file);
      return stat.isDirectory() ? list(file, relative) : stat.isFile() ? [relative] : [];
    });
}
function snapshot(directory: string, destination: string): Data {
  const records: Data = {};
  for (const name of list(directory)) {
    const source = path.join(directory, name),
      bytes = fs.readFileSync(source);
    assert(bytes.length <= 8 * 1024 * 1024, 'snapshot member bound: ' + source);
    put(path.join(destination, name), bytes);
    records[name] = { sha256: digest(bytes), bytes: bytes.length };
  }
  json(path.join(destination, '.snapshot.json'), records);
  return records;
}
function nextCommand(
  name: string,
  executable: string,
  args: readonly string[],
  cwd: string
): string {
  const directory = path.join(
    root,
    'commands',
    String(++commandNumber).padStart(3, '0') + '-' + name
  );
  json(path.join(directory, 'command.json'), { executable, args, cwd });
  return directory;
}
function run(
  name: string,
  executable: string,
  args: string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
  input?: string
): CommandReceipt {
  const directory = nextCommand(name, executable, args, cwd);
  if (input !== undefined) put(path.join(directory, 'stdin.bin'), input);
  const out = fs.openSync(path.join(directory, 'stdout.bin'), 'wx', 0o600);
  const err = fs.openSync(path.join(directory, 'stderr.bin'), 'wx', 0o600);
  let result;
  try {
    result = spawnSync(executable, args, {
      cwd,
      env: environment,
      input,
      stdio: ['pipe', out, err],
      timeout: 15000,
    });
  } finally {
    fs.closeSync(out);
    fs.closeSync(err);
  }
  const receipt: CommandReceipt = {
    code: result.status,
    signal: result.signal,
    error: result.error?.message ?? null,
    directory,
  };
  json(path.join(directory, 'receipt.json'), receipt);
  return receipt;
}
function success(receipt: CommandReceipt): void {
  assert.equal(
    receipt.code,
    0,
    JSON.stringify(receipt) +
      '\n' +
      fs.readFileSync(path.join(receipt.directory, 'stderr.bin'), 'utf8')
  );
}
function observe(pid: number): Data {
  const result = spawnSync(observer, ['--observe', String(pid)], {
    env: { PATH: '/usr/bin:/bin' },
    encoding: 'utf8',
    timeout: 1000,
    maxBuffer: 16384,
  });
  if (result.status !== 0)
    return {
      state: 'unavailable',
      code: result.status,
      error: result.error?.message ?? null,
      stderr: result.stderr,
    };
  try {
    return row(JSON.parse(result.stdout));
  } catch {
    return { state: 'unavailable', stdout: result.stdout };
  }
}
function instance(value: unknown): Instance {
  const p = row(value);
  for (const key of ['pid', 'parent', 'group'])
    assert(Number.isSafeInteger(p[key]) && Number(p[key]) > 0, 'process ' + key);
  assert(typeof p.startSeconds === 'string' && /^\d+$/.test(p.startSeconds));
  assert(typeof p.startMicros === 'string' && /^\d+$/.test(p.startMicros));
  assert(typeof p.zombie === 'boolean');
  return p as Instance;
}
function same(a: Instance, b: Instance): boolean {
  return a.pid === b.pid && a.startSeconds === b.startSeconds && a.startMicros === b.startMicros;
}
function processRows(): ProcessRow[] {
  const result = spawnSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,state=,command='], {
    env: { PATH: '/usr/bin:/bin' },
    encoding: 'utf8',
    timeout: 1000,
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(result.status, 0, 'kernel process inventory unavailable');
  assert.equal(result.stderr, '', 'process inventory diagnostics make cleanup unavailable');
  return result.stdout
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
      assert(m, 'unparsed process inventory row; cleanup unavailable');
      return {
        pid: Number(m[1]),
        parent: Number(m[2]),
        group: Number(m[3]),
        state: m[4]!,
        command: m[5]!,
      };
    });
}
function remember(p: ProcessRow, request?: RequestCoverage): void {
  if (processes.has(p.pid)) {
    // Request witnesses must be freshly observed, even when a PID appeared in
    // a previous invocation. The global map is discovery, never coverage.
    if (!request) return;
  }
  const result = observe(p.pid);
  if (result.state !== 'observed') return;
  const witnessed = instance(result.process);
  processes.set(p.pid, witnessed);
  if (request) {
    requestProcesses.set(p.pid, witnessed);
    retainRequestInstance(request, witnessed);
  }
}
function captureWorkers(): void {
  const workers = path.join(owner, 'workers');
  if (!fs.existsSync(workers)) return;
  for (const name of fs.readdirSync(workers)) {
    const directory = path.join(workers, name);
    for (const relative of [
      'worker.json',
      'backend/lease.json',
      'backend/stdout.bin',
      'backend/stderr.bin',
      'backend/worker-exit.json',
    ]) {
      try {
        const file = path.join(directory, relative),
          stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink()) continue;
        const body = fs.readFileSync(file);
        put(path.join(root, 'worker-snapshots', name, relative), body);
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? ''))
          throw error;
      }
    }
  }
}
function sample(request?: RequestCoverage): void {
  captureWorkers();
  const rows = processRows(),
    nativePid = request?.expected?.frontendPid,
    requestTree = new Set<number>(nativePid ? [nativePid] : []);
  for (let pass = 0; pass < 6; pass++) {
    for (const p of rows)
      if (
        requestTree.has(p.parent) &&
        !p.command.includes('renderer-host') &&
        !p.command.includes('renderer-worker')
      )
        requestTree.add(p.pid);
  }
  const retained = rows.filter(
    (p) =>
      requestTree.has(p.pid) ||
      p.command.includes(path.join(owner, 'config.json')) ||
      backendPids.has(p.pid) ||
      [...processes.values()].some(
        (known) => known.pid === p.parent && !requestProcesses.has(known.pid)
      )
  );
  for (const p of retained) remember(p, requestTree.has(p.pid) ? request : undefined);
  let requestWitness: Data | undefined;
  if (request) {
    const chain = request.expected ? selectRequestChain(rows, request.expected) : null;
    const before = chain?.map((p) => observe(p.pid)) ?? [];
    const after = chain?.map((p) => observe(p.pid)) ?? [];
    const confirmed = chain
      ? confirmRequestChain(chain, request.originalFrontend, before, after)
      : null;
    requestWitness = {
      expected: request.expected,
      originalFrontend: request.originalFrontend,
      chain,
      before,
      after,
      confirmed,
    };
    if (chain && confirmed) {
      // This grants observation only. Cleanup stays with actual Child owners.
      request.confirmedChains.push(confirmed);
      for (const p of confirmed) {
        processes.set(p.pid, p);
        requestProcesses.set(p.pid, p);
        retainRequestInstance(request, p);
      }
    }
  }
  fs.appendFileSync(
    path.join(root, 'process-inventory.jsonl'),
    JSON.stringify({ at: Date.now(), rows: retained, requestWitness }) + '\n',
    { mode: 0o600 }
  );
}
function sourceCustody(profile: Readonly<Record<string, string>>, copy = false): Data[] {
  return Object.entries(profile)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, expected]) => {
      const original = path.join(sterling, '.caws/hooks', name),
        target = path.join(project, '.caws/hooks', name);
      const before = fs.lstatSync(original);
      assert(before.isFile() && !before.isSymbolicLink(), 'foreign source is not regular: ' + name);
      const bytes = fs.readFileSync(original);
      const after = fs.lstatSync(original);
      assert.equal(digest(bytes), expected, 'foreign reviewed source changed: ' + name);
      assert.deepEqual(
        [after.dev, after.ino, after.size, after.mtimeMs, after.ctimeMs],
        [before.dev, before.ino, before.size, before.mtimeMs, before.ctimeMs]
      );
      if (copy) {
        put(target, bytes);
        fs.chmodSync(target, 0o700);
      }
      assert.equal(
        digest(fs.readFileSync(target)),
        expected,
        'copied foreign bytes changed: ' + name
      );
      return {
        name,
        original,
        copied: target,
        sha256: expected,
        bytes: bytes.length,
        originalDevice: before.dev,
        originalInode: before.ino,
        originalMtimeMs: before.mtimeMs,
      };
    });
}
function transcript(count: number): string {
  const records: Data[] = [];
  for (let i = 1; i <= count; i++) {
    const timestamp = `2026-10-01T12:0${i}:00Z`;
    records.push(
      {
        timestamp,
        type: 'turn_context',
        payload: { turn_id: 'owner-turn-' + i, cwd: project, model: 'owner-fixture-model' },
      },
      {
        timestamp,
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'OWNER user turn ' + i }],
        },
      },
      {
        timestamp,
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'exec_command',
          call_id: 'owner-call-' + i,
          arguments: JSON.stringify({ cmd: 'touch MUST-NOT-EXECUTE' }),
        },
      },
      {
        timestamp,
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'owner-call-' + i,
          output: 'OWNER tool result ' + i,
        },
      },
      {
        timestamp,
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'OWNER assistant turn ' + i }],
        },
      }
    );
  }
  return records.map((record) => JSON.stringify(record)).join('\n') + '\n';
}
function turns(directory: string, count: number): Data[] {
  const values = list(session)
    .filter((name) => /^turn-\d+\.json$/.test(name))
    .sort()
    .map((name) => read(path.join(session, name)));
  assert.equal(values.length, count, 'semantic turn count');
  values.forEach((turn, index) => {
    assert.equal(turn.user, 'OWNER user turn ' + (index + 1));
    assert(Array.isArray(turn.timeline), 'ordered semantic timeline missing');
    const timeline = turn.timeline.map((item) => row(item));
    const tool = timeline.findIndex(
      (item) => item.kind === 'tool_call' && item.name === 'exec_command'
    );
    const assistant = timeline.findIndex(
      (item) => item.kind === 'reasoning' && item.text === 'OWNER assistant turn ' + (index + 1)
    );
    assert(tool >= 0 && assistant > tool, 'tool and assistant order lost');
    assert(
      JSON.stringify(timeline[tool]).includes('OWNER tool result ' + (index + 1)),
      'tool result not correlated'
    );
    assert.equal(turn.status, 'ok');
  });
  snapshot(session, path.join(directory, 'session-snapshot'));
  json(path.join(directory, 'semantic-turns.json'), values);
  assert(!fs.existsSync(path.join(project, 'MUST-NOT-EXECUTE')), 'transcript command was executed');
  return values;
}
function ownerObservations(): Data[] {
  const file = path.join(owner, 'observations.jsonl');
  if (!fs.existsSync(file)) return [];
  const bytes = fs.readFileSync(file, 'utf8');
  assert(bytes.endsWith('\n'), 'owner observation append is incomplete');
  return bytes
    .trim()
    .split('\n')
    .map((line) => {
      const envelope = row(JSON.parse(line));
      assert.equal(envelope.schema, 'caws.render.owner.observation.v1');
      return row(envelope.observation);
    });
}
function operationRows(): Data[] {
  return list(path.join(owner, 'custody/operations/services'))
    .filter((name) => /(?:^|\/)\w{64}\.json$/.test(name))
    .map((name) => read(path.join(owner, 'custody/operations/services', name)));
}
function backendLease(): { lease: Data; file: string } | null {
  const files = list(path.join(owner, 'workers')).filter((name) =>
    name.endsWith('/backend/lease.json')
  );
  assert(files.length <= 1, 'more than one backend exists for the selected project');
  return files[0]
    ? {
        lease: read(path.join(owner, 'workers', files[0])),
        file: path.join(owner, 'workers', files[0]),
      }
    : null;
}
async function invoke(
  args: string[],
  env: NodeJS.ProcessEnv,
  input: string
): Promise<CommandReceipt> {
  const directory = nextCommand('native-stop', native, args, project);
  // Retained through service idle: persistent children may inherit this path.
  const temporary = path.join(directory, 'tmp');
  fs.mkdirSync(temporary, { mode: 0o700 });
  requestCustodies.set(directory, {
    collector: new RequestCustodyCollector(temporary, path.join(directory, 'native-custody')),
    expected: null,
  });
  json(path.join(directory, 'request-temporary.json'), { path: temporary, retained: true });
  put(path.join(directory, 'stdin.bin'), input);
  const out = fs.openSync(path.join(directory, 'stdout.bin'), 'wx', 0o600),
    err = fs.openSync(path.join(directory, 'stderr.bin'), 'wx', 0o600);
  const child = spawn(native, args, {
    cwd: project,
    env: { ...env, TMPDIR: temporary },
    stdio: ['pipe', out, err],
  });
  fs.closeSync(out);
  fs.closeSync(err);
  const originalFrontend = child.pid ? observe(child.pid) : { state: 'unavailable' };
  json(path.join(directory, 'original-frontend.json'), originalFrontend);
  if (originalFrontend.state !== 'observed')
    gaps.push('original native request identity unavailable: ' + directory);
  const request: RequestCoverage = {
    expected: child.pid
      ? {
          platform: process.platform,
          frontendPid: child.pid,
          frontendCommand: [native, ...args].join(' '),
          native,
          node: process.execPath,
          engine,
        }
      : null,
    originalFrontend,
    confirmedChains: [],
    witnesses: [],
  };
  requestCoverage.set(directory, request);
  if (originalFrontend.state === 'observed') {
    const frontend = instance(originalFrontend.process);
    processes.set(frontend.pid, frontend);
    requestProcesses.set(frontend.pid, frontend);
    retainRequestInstance(request, frontend);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watchRequest = (): void => {
    try {
      sample(request);
    } catch (error) {
      if (!gaps.includes(String(error))) gaps.push(String(error));
    }
  };
  const requestMonitor = setInterval(watchRequest, 50);
  watchRequest();
  const result = await new Promise<CommandReceipt>((accept) => {
    let settled = false;
    const finish = (receipt: CommandReceipt): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        clearInterval(requestMonitor);
        accept(receipt);
      }
    };
    child.once('error', (error) =>
      finish({ code: null, signal: null, error: error.message, directory })
    );
    child.once('close', (code, signal) =>
      finish({ code, signal, error: null, directory, ...(child.pid ? { pid: child.pid } : {}) })
    );
    // A timeout is retained uncertainty. Do not signal or adopt service PIDs.
    timer = setTimeout(() => {
      child.unref();
      finish({
        code: null,
        signal: null,
        error: 'native request exit unconfirmed; preserve and stop',
        directory,
        timedOut: true,
        ...(child.pid ? { pid: child.pid } : {}),
      });
    }, 40000);
    child.stdin!.on('error', () => {});
    child.stdin!.end(input);
  });
  json(path.join(directory, 'receipt.json'), result);
  json(path.join(directory, 'request-coverage.json'), request);
  return result;
}
async function awaitCleanup(): Promise<Data> {
  const custody = path.join(owner, 'custody');
  const until = Date.now() + 15000;
  let result: Data = { state: 'unknown' };
  do {
    captureWorkers();
    const observations = [...processes.values()].map((witness) => ({
      witness,
      observation: observe(witness.pid),
    }));
    const active = observations.filter(
      ({ witness, observation }) =>
        observation.state === 'observed' &&
        same(witness, instance(observation.process)) &&
        !instance(observation.process).zombie
    );
    const unknown = observations.some(
      ({ observation }) => !['observed', 'absent'].includes(String(observation.state))
    );
    const workers = fs.existsSync(path.join(owner, 'workers'))
      ? fs.readdirSync(path.join(owner, 'workers'))
      : [];
    let lockFree = !fs.existsSync(custody);
    let custodyObservation: Data = { state: 'not_initialized' };
    if (fs.existsSync(custody)) {
      const receipt = run('custody-observation', custodyObserver, [custody], root, {
        HOME: home,
        PATH: '/usr/bin:/bin',
      });
      try {
        custodyObservation = read(path.join(receipt.directory, 'stdout.bin'));
        assert.equal(custodyObservation.schema, 'caws.service.custody.observation.v1');
        lockFree = receipt.code === 0 && custodyObservation.state === 'free';
      } catch (error) {
        custodyObservation = { state: 'unavailable', error: String(error), receipt };
      }
    }
    const requestCleanups = [...requestCoverage].map(([directory, coverage]) => ({
      directory,
      ...requestCleanupObservation(coverage, processRows(), observe),
    }));
    const nativeCustody = [...requestCustodies].map(([directory, entry]) => ({
      directory,
      observation: entry.expected
        ? entry.collector.collect(entry.expected)
        : { state: 'unknown', error: 'typed invocation identity unavailable' },
    }));
    result = {
      state:
        !unknown &&
        active.length === 0 &&
        workers.length === 0 &&
        !fs.existsSync(nativeSocket) &&
        lockFree &&
        requestCleanups.every((request) => request.state === 'confirmed_inactive') &&
        nativeCustody.every((entry) => entry.observation.state === 'confirmed_settled')
          ? 'confirmed_inactive'
          : 'unknown',
      observations,
      requestCleanups,
      nativeCustody,
      active,
      workers,
      custodyObservation,
      socketExists: fs.existsSync(nativeSocket),
      custodyLockFree: lockFree,
      at: Date.now(),
    };
    fs.appendFileSync(
      path.join(root, 'cleanup-observations.jsonl'),
      JSON.stringify(result) + '\n',
      { mode: 0o600 }
    );
    if (result.state === 'confirmed_inactive') return result;
    await pause(200);
  } while (Date.now() < until);
  return result;
}

/** Foreign compatibility baseline only: the reviewed renderer runs unchanged.
 * Service lifetime, publication, and owner execution remain independently checked
 * above. Git metadata is copied; the original object DB/worktree stay live data.
 */
function compareForeignRendererBytes(
  imageRoot: string,
  imageDigest: string,
  tools: readonly { readonly name: string; readonly path: string; readonly sha256: string }[],
  environment: NodeJS.ProcessEnv
): Data {
  const baseline = path.join(root, 'foreign-byte-baseline');
  fs.mkdirSync(baseline, { mode: 0o700 });
  const result: Data = {
    state: 'running',
    directory: baseline,
    boundary:
      'unchanged copied reviewed renderer; exact final durable argv except output directory; native private Git metadata snapshot',
  };
  manifest.foreignByteBaseline = result;
  json(path.join(baseline, 'result.json'), result);
  persist();
  // Operation's serde camelCase contract is authoritative: base64 wraps the
  // exact verified RenderRequest bytes, including its fixed 12-string argv.
  const operations = operationRows().map((envelope) => row(envelope.body));
  const final = operations.filter((operation) => row(row(operation.outcome).result).served === 3);
  assert.equal(final.length, 1, 'last actual returned operation unavailable for baseline');
  const operation = final[0]!;
  assert(typeof operation.verifiedRequestBase64 === 'string');
  const requestBytes = Buffer.from(operation.verifiedRequestBase64, 'base64');
  assert.equal(
    requestBytes.toString('base64'),
    operation.verifiedRequestBase64,
    'noncanonical retained request base64'
  );
  assert.equal(
    digest(requestBytes),
    operation.verifiedRequestSha256,
    'retained verified request bytes changed'
  );
  put(path.join(baseline, 'verified-request.bin'), requestBytes);
  const request = row(JSON.parse(requestBytes.toString('utf8')));
  assert.equal(request.schema, 'caws.service.render.request.v1');
  assert.equal(request.canonicalProject, project);
  assert.equal(request.selectedIndex, 2);
  assert.equal(row(request.executionImage).imageDigest, imageDigest);
  assert(
    Array.isArray(request.arguments) &&
      request.arguments.length === 12 &&
      request.arguments.every((argument) => typeof argument === 'string'),
    'durable renderer argv is not exact 12-string contract'
  );
  const argumentsOriginal = request.arguments as string[];
  assert.equal(argumentsOriginal[0], session);
  assert.equal(argumentsOriginal[1], project);
  assert.equal(argumentsOriginal[2], sessionId);
  assert.equal(
    digest(JSON.stringify(['caws-session-render-argv-v1', argumentsOriginal])),
    request.argumentDigest
  );
  assert.equal(row(operation.identity).argumentDigest, request.argumentDigest);
  json(path.join(baseline, 'operation.json'), operation);
  const retainedOwner = path.join(root, 'request-3/owner-state-snapshot');
  const configs = list(retainedOwner).filter((file) => /^workers\/[^/]+\/worker\.json$/.test(file));
  assert.equal(configs.length, 1, 'final actual worker configuration missing');
  const config = read(path.join(retainedOwner, configs[0]!));
  const backend = row(config.backend),
    view = row(backend.gitView);
  assert.equal(backend.imageDigest, imageDigest);
  assert.equal(backend.hooksDir, path.join(imageRoot, 'hooks'));
  assert.equal(view.gitWorkTree, project);
  assert.equal(backend.home, home);
  assert.equal(backend.searchPath, path.join(imageRoot, 'bin'));
  for (const key of ['gitDirectory', 'gitWorkTree', 'gitOriginalDirectory', 'gitCommonDirectory'])
    assert(
      typeof view[key] === 'string' && path.isAbsolute(view[key]),
      'native worker Git view ' + key
    );
  const liveGitDirectory = view.gitDirectory as string;
  const relativeGit = path.relative(owner, liveGitDirectory);
  assert(
    relativeGit.startsWith('workers/') && !relativeGit.split('/').includes('..'),
    'worker Git namespace escaped owner'
  );
  // Owner retirement deletes its namespace. Its retained final-request snapshot
  // is an exact per-file hashed copy, so baseline never depends on idle timing.
  const live = fs.existsSync(liveGitDirectory);
  const sourceGit = live ? liveGitDirectory : path.join(retainedOwner, relativeGit);
  const copiedGit = path.join(baseline, 'git-view');
  const custody: Data[] = [];
  const retainedHashes = read(path.join(retainedOwner, '.snapshot.json'));
  let total = 0;
  const copyTree = (source: string, target: string, relative = ''): void => {
    const before = fs.lstatSync(source);
    assert(!before.isSymbolicLink(), 'baseline refuses private Git symlink: ' + source);
    if (before.isDirectory()) {
      fs.mkdirSync(target, { mode: 0o700 });
      for (const entry of fs.readdirSync(source).sort())
        copyTree(
          path.join(source, entry),
          path.join(target, entry),
          relative ? relative + '/' + entry : entry
        );
    } else {
      assert(
        before.isFile() && before.size <= 32 * 1024 * 1024,
        'baseline Git metadata member envelope'
      );
      const bytes = fs.readFileSync(source),
        after = fs.lstatSync(source);
      assert.deepEqual(
        [after.dev, after.ino, after.size, after.mtimeMs, after.ctimeMs],
        [before.dev, before.ino, before.size, before.mtimeMs, before.ctimeMs],
        'Git metadata changed during baseline snapshot'
      );
      total += bytes.length;
      assert(
        total <= 64 * 1024 * 1024 && custody.length < 4096,
        'baseline Git metadata closure envelope'
      );
      if (!live)
        assert.equal(
          digest(bytes),
          row(retainedHashes[relativeGit + '/' + relative]).sha256,
          'retained native Git metadata changed'
        );
      fs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
      custody.push({
        relative,
        source,
        copied: target,
        bytes: bytes.length,
        sha256: digest(bytes),
      });
    }
  };
  copyTree(sourceGit, copiedGit);
  json(path.join(baseline, 'git-view-custody.json'), {
    liveOriginal: liveGitDirectory,
    sourceGit,
    source: live
      ? 'live actual worker namespace'
      : 'retained final actual worker namespace snapshot',
    view,
    copiedGit,
    records: custody,
    boundary:
      'metadata copied without transformation; object alternates and checkout remain original live data',
  });
  const python = tools.find((tool) => tool.name === 'python3');
  assert(python, 'pinned Python missing');
  assert.equal(
    digest(fs.readFileSync(python.path)),
    python.sha256,
    'pinned Python changed before baseline'
  );
  const renderer = path.join(project, '.caws/hooks/session_log_renderer.py');
  const initialCustody = JSON.parse(
    fs.readFileSync(path.join(root, 'source-custody-initial.json'), 'utf8')
  ) as Data[];
  const reviewedRenderer = initialCustody.find((entry) => entry.name === 'session_log_renderer.py');
  assert(reviewedRenderer, 'reviewed copied renderer custody missing');
  assert.equal(
    digest(fs.readFileSync(renderer)),
    reviewedRenderer.sha256,
    'copied foreign renderer changed'
  );
  const output = path.join(baseline, 'turns');
  fs.mkdirSync(output, { mode: 0o700 });
  const argumentsBaseline = [...argumentsOriginal];
  argumentsBaseline[0] = output;
  assert.deepEqual(argumentsBaseline.slice(1), argumentsOriginal.slice(1));
  const baselineEnvironment: NodeJS.ProcessEnv = {
    ...environment,
    HOME: home,
    PATH: path.join(imageRoot, 'bin'),
    CAWS_AGENT_SURFACE: 'codex',
    PYTHONDONTWRITEBYTECODE: '1',
    CAWS_SERVICE_GIT_DIRECTORY: copiedGit,
    CAWS_SERVICE_GIT_WORK_TREE: view.gitWorkTree as string,
    CAWS_SERVICE_GIT_ORIGINAL_DIRECTORY: view.gitOriginalDirectory as string,
    CAWS_SERVICE_GIT_COMMON_DIRECTORY: view.gitCommonDirectory as string,
  };
  for (const key of Object.keys(baselineEnvironment))
    if (key.startsWith('GIT_')) delete baselineEnvironment[key];
  json(path.join(baseline, 'arguments.json'), {
    original: argumentsOriginal,
    baseline: argumentsBaseline,
  });
  const command = run(
    'unchanged-foreign-byte-baseline',
    python.path,
    ['-I', '-S', '-B', renderer, ...argumentsBaseline],
    project,
    baselineEnvironment
  );
  result.command = command;
  json(path.join(baseline, 'result.json'), result);
  persist();
  success(command);
  const actualFiles = list(session).filter((file) => /^turn-\d+\.json$/.test(file));
  const baselineFiles = list(output).filter((file) => /^turn-\d+\.json$/.test(file));
  assert.deepEqual(baselineFiles, actualFiles, 'foreign baseline turn membership differs');
  assert.equal(actualFiles.length, 2, 'actual final turn membership changed');
  const comparisons = actualFiles.map((file) => {
    const actual = fs.readFileSync(path.join(session, file)),
      reference = fs.readFileSync(path.join(output, file));
    put(path.join(baseline, 'actual-turns', file), actual);
    return {
      file,
      actualSha256: digest(actual),
      baselineSha256: digest(reference),
      actualBytes: actual.length,
      baselineBytes: reference.length,
      byteIdentical: actual.equals(reference),
    };
  });
  result.comparisons = comparisons;
  result.state = comparisons.every((item) => item.byteIdentical) ? 'byte_identical' : 'different';
  json(path.join(baseline, 'result.json'), result);
  persist();
  assert(
    comparisons.every((item) => item.byteIdentical),
    'unchanged foreign renderer baseline turn bytes differ'
  );
  assert.equal(
    digest(fs.readFileSync(renderer)),
    reviewedRenderer.sha256,
    'copied foreign renderer mutated during baseline'
  );
  return result;
}

/** Public frontend only: retire A, consume its native seal, then permit B. */
async function sealWarmRenderer(env: NodeJS.ProcessEnv, runtimeDigest: string): Promise<void> {
  assert(lastDaemon, 'A must retain its actual warm daemon');
  const old = lastDaemon;
  assert(lastNativeWorker, 'A native worker must have an independently observed live birth');
  const aWorker = lastNativeWorker;
  assert.equal(aWorker.created.backendPid, old.pid);
  const beforeNativeWorker = observe(aWorker.birth.pid);
  assert.equal(beforeNativeWorker.state, 'observed');
  assert(
    same(aWorker.birth, instance(beforeNativeWorker.process)),
    'A native worker birth changed before seal'
  );
  const beforeObservation = observe(old.pid);
  assert.equal(beforeObservation.state, 'observed');
  assert(same(old, instance(beforeObservation.process)), 'A is no longer the observed warm daemon');
  const directory = path.join(root, 'session-end');
  fs.mkdirSync(directory, { mode: 0o700 });
  const comm = run(
    'claude-original-comm',
    '/bin/ps',
    ['-p', String(process.pid), '-o', 'comm='],
    project,
    env
  );
  success(comm);
  assert.equal(fs.readFileSync(path.join(comm.directory, 'stdout.bin'), 'utf8').trim(), 'claude');
  json(path.join(directory, 'original-ancestor.json'), {
    pid: process.pid,
    observation: observe(process.pid),
    comm,
  });
  const { parseJsonSource } = createRequire(path.join(cli, 'package.json'))(
    './dist/runtime/json-custody.js'
  ) as typeof import('../dist/runtime/json-custody');
  const beforeMetadataSource = parseJsonSource(
    fs.readFileSync(path.join(session, '.meta.json'), 'utf8'),
    128,
    100_000,
    true
  );
  assert.equal(beforeMetadataSource.root.kind, 'object');
  const beforeMetadata = read(path.join(session, '.meta.json'));
  const turnBytes = list(session)
    .filter((name) => /^turn-\d+\.json$/.test(name))
    .map((name) => ({ name, bytes: fs.readFileSync(path.join(session, name)) }));
  assert.equal(turnBytes.length, 1, 'seal must consume the actual A output');
  snapshot(session, path.join(directory, 'before'));
  const before = new Set(list(path.join(session, 'hook-invocations')));
  const input = JSON.stringify({
    cwd: project,
    session_id: sessionId,
    hook_event_name: 'SessionEnd',
    reason: 'warm renderer qualification',
  });
  const status = await invoke(
    [
      'invoke',
      '--engine',
      engine,
      '--node',
      process.execPath,
      '--surface',
      'claude-code',
      '--event',
      'session_end',
      '--runtime-digest',
      runtimeDigest,
      '--timeout-ms',
      '30000',
      '--configuration',
      'system',
    ],
    { ...env, CLAUDE_SESSION_ID: sessionId },
    input
  );
  const result: Data = { operation: 'native_claude_session_end', status };
  requests.push(result);
  success(status);
  assert.equal(
    fs.statSync(path.join(status.directory, 'stdout.bin')).size,
    0,
    'seal must be silent'
  );
  assert.equal(
    fs.statSync(path.join(status.directory, 'stderr.bin')).size,
    0,
    'seal must be silent'
  );
  const files = list(path.join(session, 'hook-invocations')).filter((name) => !before.has(name));
  assert.equal(files.length, 1, 'one seal original must produce one journal');
  const journalFile = path.join(session, 'hook-invocations', files[0]!);
  const fd = fs.openSync(
    journalFile,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
  );
  let bytes: Buffer;
  try {
    const stat = fs.fstatSync(fd);
    assert(
      stat.isFile() &&
        stat.uid === process.getuid?.() &&
        stat.nlink === 1 &&
        stat.size > 0 &&
        stat.size <= MAX_TYPED_JOURNAL,
      'unsafe seal invocation journal'
    );
    bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, null);
      assert(count > 0, 'seal invocation journal truncated');
      offset += count;
    }
    assert.equal(fs.fstatSync(fd).size, stat.size, 'seal journal changed during read');
    json(path.join(directory, 'journal-source.json'), {
      path: journalFile,
      device: stat.dev,
      inode: stat.ino,
      bytes: bytes.length,
      sha256: digest(bytes),
    });
  } finally {
    fs.closeSync(fd);
  }
  put(path.join(directory, 'journal.jsonl'), bytes);
  const originalFrontend = read(path.join(status.directory, 'original-frontend.json'));
  assert.equal(originalFrontend.state, 'observed');
  assert.equal(
    row(originalFrontend.process).parent,
    process.pid,
    'native original must descend from real Claude ancestor'
  );
  // The shared decoder intentionally admits Codex Stop/PreToolUse only.
  // This Claude original uses the same strict journal correlation locally.
  assert.equal(bytes.at(-1), 10, 'seal invocation journal must end with LF');
  const journalText = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  const journal = journalText
    .slice(0, -1)
    .split('\n')
    .map((line) => {
      parseJsonSource(line, 32, 10_000, true);
      return row(JSON.parse(line));
    });
  assert.equal(journal[0]!.stage, 'invocation_started');
  const invocationId = journal[0]!.invocation_id;
  assert(typeof invocationId === 'string' && invocationId.length > 0 && invocationId.length <= 128);
  assert(
    journal.every(
      (item) =>
        item.schema === 'caws.hook_invocation.v1' &&
        item.invocation_id === invocationId &&
        item.runtime_digest === runtimeDigest &&
        item.input_sha256 === digest(input) &&
        item.surface === 'claude-code' &&
        item.event === 'session_end'
    ),
    'seal invocation journal identity differs'
  );
  const identity = { invocationId, runtimeDigest };
  warmSealInvocationId = invocationId;
  assert.deepEqual(
    (journal[0]!.selected_handlers as Data[]).map(({ name, kind }) => ({ name, kind })),
    [{ name: 'session-log.sh', kind: 'stock' }]
  );
  const prefix = journal.filter((item) => item.stage === 'session_end_prefix_completed');
  assert.equal(prefix.length, 1);
  for (const field of ['prefix_complete', 'envelope_published', 'pointer_published'])
    assert.equal(prefix[0]![field], true, 'native prefix ' + field);
  assert.equal(prefix[0]!.status, 'completed');
  assert.equal(prefix[0]!.agent_pid, 'refreshed');
  assert(['completed', 'rate_limited'].includes(String(prefix[0]!.reap)));
  const envelope = read(path.join(session, '.session-envelope.json'));
  const pointer = read(path.join(project, '.caws/sessions/.caller-session.json'));
  const pid = read(path.join(project, '.caws/sessions', `agent-pid-${process.pid}.json`));
  assert.equal(envelope.platform, 'claude-code');
  assert.equal(envelope.hook_event, 'SessionEnd');
  for (const value of [envelope, pointer, pid]) {
    assert.equal(value.session_id, sessionId);
    assert.equal(value.repo_root, project);
  }
  assert.equal(pointer.last_seen_at, envelope.last_seen_at);
  assert.equal(pid.agent_pid, process.pid, 'cache must name the real original Claude ancestor');
  assert.equal(pid.surface, 'claude-code');
  assert.match(String(pid.started_at), /^\d+$/);
  assert(fs.statSync(path.join(project, '.caws/sessions/.agent-pid-reap-marker')).isFile());
  json(path.join(directory, 'prefix.json'), {
    prefix,
    envelope,
    pointer,
    pid,
    argv0: process.argv0,
  });
  const consumers = journal.filter((item) => item.stage === 'session_seal_consumer_completed');
  assert.equal(consumers.length, 1, 'ordinary semantic reader must run before ACK');
  const consumer = consumers[0]!;
  assert(journal.indexOf(prefix[0]!) < journal.indexOf(consumer));
  assert.equal(consumer.status, 'published');
  assert(
    !journal.some((item) =>
      ['adapter_error', 'compatibility_dispatch_completed'].includes(String(item.stage))
    ),
    'seal must use native selection without compatibility execution'
  );
  const metadataBytes = fs.readFileSync(path.join(session, '.meta.json'));
  const metadata = row(JSON.parse(metadataBytes.toString('utf8')));
  const metadataSource = parseJsonSource(metadataBytes.toString('utf8'), 128, 100_000, true);
  assert(beforeMetadataSource.root.kind === 'object' && metadataSource.root.kind === 'object');
  for (const [key, node] of beforeMetadataSource.root.entries) {
    if (['ended', 'usage', 'models', 'summary_provenance'].includes(key)) continue;
    const after = metadataSource.root.entries.get(key);
    assert(after, 'unrelated metadata missing: ' + key);
    assert.equal(
      metadataSource.text.slice(after.start, after.end),
      beforeMetadataSource.text.slice(node.start, node.end),
      'unrelated metadata bytes changed: ' + key
    );
  }
  assert.equal(digest(metadataBytes), consumer.metadata_sha256);
  assert.equal(consumer.unrelated_metadata_preserved, true);
  for (const [key, value] of Object.entries(beforeMetadata))
    if (!['ended', 'usage', 'models', 'summary_provenance'].includes(key))
      assert.deepEqual(metadata[key], value, 'unrelated metadata changed: ' + key);
  assert.equal(row(metadata.ended).reason, 'warm renderer qualification');
  assert.equal(consumer.reason, row(metadata.ended).reason);
  assert.equal(consumer.ended_at, row(metadata.ended).ts);
  assert.match(String(consumer.ended_at), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  // Independent oracle from A's real turn bytes; this fixture uses safe integer counts.
  const fields = [
    'input_tokens',
    'output_tokens',
    'cache_read_input_tokens',
    'cache_creation_input_tokens',
    'cached_input_tokens',
    'reasoning_output_tokens',
    'total_tokens',
  ];
  const sums = new Map<string, bigint>(),
    models = new Set<string>();
  for (const turn of turnBytes) {
    assert(
      fs.readFileSync(path.join(session, turn.name)).equals(turn.bytes),
      'seal rewrote A turn'
    );
    const parsed = row(JSON.parse(turn.bytes.toString('utf8')));
    for (const field of fields) {
      const value = parsed.usage === undefined ? undefined : row(parsed.usage)[field];
      if (value !== undefined) {
        assert(
          typeof value === 'number' && Number.isSafeInteger(value) && value >= 0,
          'qualifier oracle only admits actual safe integer fixture usage'
        );
        sums.set(field, (sums.get(field) ?? 0n) + BigInt(value));
      }
    }
    if (parsed.models !== undefined) {
      assert(Array.isArray(parsed.models));
      for (const model of parsed.models) {
        assert.equal(typeof model, 'string');
        models.add(String(model));
      }
    }
  }
  assert.deepEqual(
    (consumer.counts as Data[]).map((count) => count.field),
    fields,
    'ordinary reader must expose every usage field once in contract order'
  );
  const recomputed = sums.size > 0 || models.size > 0;
  const expectedModels = models.size ? [...models] : recomputed ? undefined : beforeMetadata.models;
  assert.deepEqual(metadata.models, expectedModels);
  assert.deepEqual(consumer.models, expectedModels ?? null);
  if (recomputed && !sums.size) assert.equal(metadata.usage, undefined);
  assert.equal(consumer.summary_mode, recomputed ? 'recomputed' : 'preserved');
  if (!recomputed) assert.deepEqual(metadata.usage, beforeMetadata.usage);
  for (const count of consumer.counts as Data[]) {
    const expected = sums.get(String(count.field));
    if (expected !== undefined) {
      assert.equal(row(count.value).lexeme, expected.toString(), 'ordinary consumer exact count');
      assert.equal(row(metadata.usage)[String(count.field)], Number(expected));
    } else if (recomputed) assert.equal(count.value, undefined);
    else {
      const prior =
        beforeMetadata.usage === undefined
          ? undefined
          : row(beforeMetadata.usage)[String(count.field)];
      if (prior === undefined) assert.equal(count.value, undefined);
      else {
        assert(typeof prior === 'number' && Number.isSafeInteger(prior) && prior >= 0);
        assert.equal(row(count.value).lexeme, String(prior));
      }
    }
  }
  assert.equal((consumer.counts as Data[]).length, fields.length);
  const markerBytes = fs.readFileSync(path.join(session, '.session-publication.json'));
  const marker = row(JSON.parse(markerBytes.toString('utf8')));
  assert.equal(marker.canonicalRoot, project);
  assert.equal(marker.sessionId, sessionId);
  assert.equal(row(marker.correlation).id, journal[0]!.invocation_id);
  assert.equal(row(marker.correlation).runtimeDigest, runtimeDigest);
  assert.equal(marker.terminalDigest, consumer.terminal_digest);
  assert.equal(
    marker.terminalDigest,
    digest(JSON.stringify([marker.correlation, 'published', marker.artifacts]))
  );
  assert.deepEqual(
    (marker.artifacts as Data[]).map((item) => item.name).sort(),
    ['.meta.json', ...turnBytes.map((item) => item.name)].sort(),
    'marker must bind the complete retained inventory, including unchanged A turns'
  );
  for (const descriptor of marker.artifacts as Data[]) {
    const artifact = fs.readFileSync(path.join(session, String(descriptor.name)));
    assert.equal(artifact.length, descriptor.byteLength);
    assert.equal(digest(artifact), descriptor.sha256);
  }
  put(path.join(directory, 'marker.bin'), markerBytes);
  put(path.join(directory, 'metadata.bin'), metadataBytes);
  const events = ownerObservations();
  const position = (stage: string): number => {
    const matches = events
      .map((event, index) => ({ event, index }))
      .filter(
        ({ event }) => event.stage === stage && event.invocationId === journal[0]!.invocation_id
      );
    assert.equal(matches.length, 1, 'one actual Actor stage ' + stage);
    return matches[0]!.index;
  };
  const aCreated = events.filter(
    (event) =>
      event.event === 'worker_created' &&
      event.nativeWorkerPid === aWorker.created.nativeWorkerPid &&
      event.backendPid === aWorker.created.backendPid
  );
  assert.equal(aCreated.length, 1, 'one exact A worker_created tuple required');
  assert.deepEqual(aCreated[0], aWorker.created, 'retained A worker-created record changed');
  const cleanups = events
    .map((event, index) => ({ event, index }))
    .filter(
      ({ event }) =>
        event.event === 'worker_cleanup' &&
        event.nativeWorkerPid === aWorker.created.nativeWorkerPid &&
        event.backendPid === aWorker.created.backendPid
    );
  assert.equal(cleanups.length, 1, 'one cleanup must name the exact A native-worker/backend tuple');
  const cleanupIndex = cleanups[0]!.index;
  const receipt = row(events[cleanupIndex]!.receipt);
  assert.equal(receipt.directChildReaped, true);
  assert.equal(row(receipt.stdout).eof, true);
  assert.equal(row(receipt.stderr).eof, true);
  assert.equal(receipt.deadlineExceeded, false);
  assert(position('session_original_reserved') < cleanupIndex);
  const exits = events
    .map((event, index) => ({ event, index }))
    .filter(
      ({ event }) =>
        event.event === 'worker_exit' &&
        event.nativeWorkerPid === aWorker.created.nativeWorkerPid &&
        event.backendPid === aWorker.created.backendPid
    );
  assert.equal(exits.length, 1, 'one exit must name the exact A native-worker/backend tuple');
  const workerExit = exits[0]!.index;
  assert(
    cleanupIndex < workerExit && workerExit < position('session_writer_retained'),
    'writer use must follow backend reap/both EOFs and original native worker wait'
  );
  assert.equal(
    events.filter((event) => event.event === 'host_started').length,
    1,
    'same original owner required'
  );
  assert(position('session_writer_retained') < position('session_consumed_durable'));
  assert(position('session_consumed_durable') < position('session_heavy_released'));
  const afterObservation = observe(old.pid);
  assert(
    afterObservation.state === 'absent' ||
      (afterObservation.state === 'observed' && !same(old, instance(afterObservation.process))),
    'old daemon still exists after retirement'
  );
  const afterNativeWorker = observe(aWorker.birth.pid);
  assert(
    afterNativeWorker.state === 'absent' ||
      (afterNativeWorker.state === 'observed' &&
        !same(aWorker.birth, instance(afterNativeWorker.process))),
    'original A native worker still exists after seal'
  );
  assert.equal(backendLease(), null, 'seal must leave no old backend lease');
  const sealOperations = operationRows()
    .map((item) => row(item.body))
    .filter((item) => row(item.outcome).execution === 'consumed');
  assert.equal(sealOperations.length, 1);
  assert.equal(
    row(sealOperations[0]!.identity).requestId,
    digest(JSON.stringify(['caws.session.original.v1', journal[0]!.invocation_id]))
  );
  assert.equal(row(sealOperations[0]!.identity).sourceGeneration, runtimeDigest);
  assert.equal(row(sealOperations[0]!.outcome).terminalDigest, consumer.terminal_digest);
  assert.equal(sealOperations[0]!.verifiedRequestBase64, '', 'consumed heavy request not released');
  const custody = requestCustodies.get(status.directory),
    coverage = requestCoverage.get(status.directory);
  assert(custody && coverage);
  custody.expected = { ...identity, coverage, node: process.execPath, engine };
  const nativeCustody = custody.collector.collect(custody.expected);
  const requestCleanup = requestCleanupObservation(coverage, processRows(), observe);
  assert(requestCleanup.coverageComplete);
  assert.equal(combinedRequestCleanup(requestCleanup, nativeCustody), 'confirmed_inactive');
  Object.assign(result, {
    consumer,
    events,
    sealOperations,
    nativeCustody,
    requestCleanup,
    beforeObservation,
    afterObservation,
    aWorker,
    beforeNativeWorker,
    afterNativeWorker,
  });
  json(path.join(directory, 'result.json'), result);
  snapshot(owner, path.join(directory, 'owner-state-snapshot'));
  captureWorkers();
  persist();
}

async function main(): Promise<void> {
  persist();
  assert.equal(process.platform, 'darwin', 'service-observer supplies Darwin birth identities');
  for (const file of [native, observer, custodyObserver, engine, cliEntry])
    assert(fs.statSync(file).isFile(), 'required built artifact: ' + file);
  manifest.executableArtifacts = [native, observer, custodyObserver, engine, cliEntry].map(
    (file) => ({
      path: file,
      sha256: digest(fs.readFileSync(file)),
      bytes: fs.statSync(file).size,
    })
  );
  manifest.qualifierSha256 = digest(
    fs.readFileSync(path.join(cli, 'scripts/qualify-render-owner.ts'))
  );
  const qualifierExecutable = fs.realpathSync(path.resolve(process.argv[1]!));
  manifest.qualifierExecution = {
    path: qualifierExecutable,
    sha256: digest(fs.readFileSync(qualifierExecutable)),
    cliRootSource: path.join(cli, 'scripts/qualify-render-owner.ts'),
    cliRootSourceSha256: manifest.qualifierSha256,
  };
  persist();
  for (const directory of [home, project, path.join(root, 'tmp')])
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const requireBuilt = createRequire(path.join(cli, 'package.json'));
  const { installMachineRuntime } = requireBuilt(
    path.join(cli, 'dist/init/machine-adapters')
  ) as typeof import('../dist/init/machine-adapters');
  const { validateSystemPolicy } = requireBuilt(
    path.join(cli, 'dist/init/system-project-policy')
  ) as typeof import('../dist/init/system-project-policy');
  const { resolveInvocationSelection } = requireBuilt(
    path.join(cli, 'dist/runtime/selection')
  ) as typeof import('../dist/runtime/selection');
  const { prepareSessionRenderImage, STERLING_SESSION_SOURCE_PROFILE } = requireBuilt(
    path.join(cli, 'dist/runtime/service-image')
  ) as typeof import('../dist/runtime/service-image');
  const { resolveRenderTools } = requireBuilt(
    path.join(cli, 'dist/runtime/service-offer')
  ) as typeof import('../dist/runtime/service-offer');
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: home,
    CAWS_HOME: home,
    TMPDIR: path.join(root, 'tmp'),
    CODEX_THREAD_ID: sessionId,
    CAWS_SESSION_ID: sessionId,
    CAWS_TRAP_KILL: '0',
    PYTHONDONTWRITEBYTECODE: '1',
    LC_ALL: 'C',
    TZ: 'UTC',
  };
  json(path.join(root, 'environment.json'), env);
  const tools = resolveRenderTools(
    env as Record<string, string>,
    path.join(cli, 'dist/runtime'),
    native
  );
  json(path.join(root, 'tools.json'), tools);
  const git = tools.find((tool) => tool.name === 'git')!.path;
  const gitEnv = {
    ...env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
  };
  success(run('git-init', git, ['-c', 'init.defaultBranch=main', 'init', '-q'], project, gitEnv));
  success(
    run(
      'project-init',
      process.execPath,
      [cliEntry, 'init', '--agent-surface', 'none'],
      project,
      env
    )
  );
  assert.equal(Object.keys(STERLING_SESSION_SOURCE_PROFILE).length, 28);
  json(
    path.join(root, 'source-custody-initial.json'),
    sourceCustody(STERLING_SESSION_SOURCE_PROFILE, true)
  );
  put(path.join(project, 'fixture.txt'), 'Actual native owner private fixture.\n');
  success(run('git-add', git, ['-c', 'core.hooksPath=/dev/null', 'add', '--all'], project, gitEnv));
  success(
    run(
      'git-commit',
      git,
      [
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'user.name=Render owner qualification',
        '-c',
        'user.email=render-owner@invalid',
        'commit',
        '-q',
        '-m',
        'private reviewed-source fixture',
      ],
      project,
      gitEnv
    )
  );
  assert(
    !list(path.join(project, '.git/hooks')).some((name) => !name.endsWith('.sample')),
    'real hooks installed in private fixture'
  );
  const installed = installMachineRuntime({
    home,
    templatesRoot: path.join(cli, 'templates/hook-packs'),
  });
  json(path.join(root, 'installation.json'), installed);
  const runtime = path.join(home, 'lib/runtimes', installed.digest);
  const defaults = read(path.join(runtime, 'system-policy.json')).events as Record<
    string,
    string[]
  >;
  assert.deepEqual(defaults.stop, [
    'goal-ac-gate.sh',
    'plan-transcript-finalize.sh',
    'session-log.sh',
    'agent-stop.sh',
  ]);
  const policy = {
    disabled: {},
    extensions: {},
    handlers: { 'session-log.sh': '.caws/hooks/session-log.sh' },
    libraries: {},
  };
  validateSystemPolicy(project, policy, { files: [...installed.files], defaults });
  json(path.join(home, 'surfaces/codex/settings.json'), { version: 1, enabled: true });
  const sealPolicy = {
    disabled: {
      session_end: [...new Set(defaults.session_end!.map((entry) => entry.split(' ')[0]!))].filter(
        (entry) => entry !== 'session-log.sh'
      ),
    },
    extensions: {},
    handlers: {},
    libraries: {},
  };
  if (warmSessionEnd) {
    validateSystemPolicy(project, sealPolicy, { files: [...installed.files], defaults });
    json(path.join(home, 'surfaces/claude-code/settings.json'), { version: 1, enabled: true });
  }
  json(path.join(home, 'state/projects', digest(project) + '.json'), {
    version: 1,
    root: project,
    surfaces: { codex: policy, ...(warmSessionEnd ? { 'claude-code': sealPolicy } : {}) },
  });
  if (warmSessionEnd) {
    const sealSelection = resolveInvocationSelection({
      checkout: project,
      canonical: project,
      home,
      runtimeDigest: installed.digest,
      surface: 'claude-code',
      event: 'session_end',
      system: true,
    });
    json(path.join(root, 'seal-selection.json'), sealSelection);
    assert.equal(sealSelection.status, 'active');
    if (sealSelection.status !== 'active') throw new Error('private seal selection inactive');
    assert.deepEqual(
      sealSelection.handlers.map(({ entry, kind }) => ({ entry, kind })),
      [{ entry: 'session-log.sh', kind: 'stock' }]
    );
  }
  const selected = resolveInvocationSelection({
    checkout: project,
    canonical: project,
    home,
    runtimeDigest: installed.digest,
    surface: 'codex',
    event: 'stop',
    system: true,
  });
  json(path.join(root, 'selection.json'), selected);
  assert.equal(selected.status, 'active');
  if (selected.status !== 'active') throw new Error('private selection inactive');
  assert.deepEqual(
    selected.handlers.map((handler) => handler.entry),
    defaults.stop
  );
  const selectedIndex = selected.handlers.findIndex(
    (handler) => handler.kind === 'project-override'
  );
  assert.equal(selectedIndex, 2);
  const projectState = path.join(home, 'state/projects', digest(project)),
    imageParent = path.join(projectState, 'service-images');
  fs.mkdirSync(imageParent, { recursive: true, mode: 0o700 });
  const prepareImage = (): ReturnType<typeof prepareSessionRenderImage> =>
    prepareSessionRenderImage({
      selection: selected,
      selectedIndex,
      imageParent,
      environment: env as Record<string, string>,
      toolchain: tools,
      clientDirectory: path.join(cli, 'dist/runtime'),
      templateDirectory: path.join(cli, 'templates/hook-packs/runtime/service-image'),
      clientShellPath: path.join(
        cli,
        'templates/hook-packs/shared/lib/session-render-service-client.sh'
      ),
    });
  const prepared = prepareImage();
  json(path.join(root, 'initial-prepared-image.json'), prepared);
  manifest.initialUnsubmittedStage = prepared.stagingRoot;
  json(path.join(projectState, 'render-service.json'), {
    version: 1,
    adapter: prepared.manifest.adapter,
    profile: prepared.manifest.profile,
    root: project,
    handler: {
      entry: 'session-log.sh',
      path: selected.handlers[selectedIndex]!.path,
      sha256: selected.handlers[selectedIndex]!.sha256,
    },
    sourceProfileDigest: prepared.manifest.originalClosureDigest,
  });
  const ownerConfig = {
    schema: 'caws.render.owner.config.v1',
    home,
    clientRoot: path.join(cli, 'dist/runtime'),
    templateRoot: path.join(cli, 'templates/hook-packs/runtime/service-image'),
    clientShellSource: path.join(
      cli,
      'templates/hook-packs/shared/lib/session-render-service-client.sh'
    ),
    nativeExecutable: native,
    limits: {
      maxConnections: 16,
      maxProjects: 4,
      maxBackends: 4,
      maxQueuePerProject: 16,
      maxFrameBytes: 2 * 1024 * 1024,
      maxRetainedRecords: 64,
      firstFrameMs: 5000,
      requestMs: 30000,
      startupMs: 5000,
      idleMs: 5000,
      backendIdleSeconds: 60,
      cacheMegabytes: 64,
      worker: {
        startupMs: 5000,
        connectMs: 5000,
        writeMs: 5000,
        renderMs: 30000,
        readMs: 5000,
        cleanupMs: 5000,
      },
    },
  };
  json(path.join(root, 'owner-config-input.json'), ownerConfig);
  if (prepareOnly) {
    // Both offers carry independently prepared stages. The actor must perform
    // native admission/publication and issue its own grants before any bridge.
    const preparedB = prepareImage();
    assert(prepared.stagingRoot && preparedB.stagingRoot, 'fresh fixture requires two stages');
    assert.notEqual(
      prepared.stagingRoot,
      preparedB.stagingRoot,
      'fixture stages must be independent'
    );
    json(path.join(root, 'fifo-B-prepared-image.json'), preparedB);
    put(transcriptFile, transcript(1));
    json(path.join(session, '.meta.json'), {
      local_time: '2026-10-01T12:00:00Z',
      model: 'owner-fixture-model',
      head_sha: 'fixture',
    });
    const policyFile = path.join(projectState, 'render-service.json');
    const policySha256 = digest(fs.readFileSync(policyFile));
    // Derive this from the selected inputs, independently of either image's
    // manifest, as the ordinary prepareNativeRenderOffer consumer does.
    const expectedSelection: typeof prepared.manifest.selection = {
      canonicalProject: selected.canonical,
      surface: 'codex',
      event: 'stop',
      configuration: 'system',
      runtimeDigest: selected.runtimeDigest,
      selectedIndex,
      handlers: selected.handlers.map((handler) => ({ ...handler, args: [...handler.args] })),
      libraries: Object.entries(selected.libraries)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([name, library]) => {
          assert(library.kind === 'shared' || library.kind === 'surface');
          return { name, path: library.path, sha256: library.sha256, kind: library.kind };
        }),
    };
    const renderArguments = [
      session,
      project,
      sessionId,
      '2026-10-01T12:00:00Z',
      'owner-fixture-model',
      'main',
      'fixture',
      '0',
      'fixture',
      transcriptFile,
      '',
      '',
    ];
    const offers = [
      { label: 'A', prepared },
      { label: 'B', prepared: preparedB },
    ].map(({ label, prepared: image }) => ({
      label,
      offer: {
        schema: 'caws.render.owner.offer.v1',
        prepared: image,
        expectedSelection,
        policySha256,
        checkout: selected.checkout,
        sessionId,
        invocationId: 'render-owner-fifo:' + label,
        callerEnvironment: env as Record<string, string>,
        remainingBudgetMs: 120000,
      } satisfies import('../dist/runtime/service-offer').NativeRenderOffer,
      renderArguments,
    }));
    const pin = (file: string): Data => {
      const bytes = fs.readFileSync(file);
      return { path: file, sha256: digest(bytes), bytes: bytes.length };
    };
    json(
      path.join(root, 'source-custody-prepared.json'),
      sourceCustody(STERLING_SESSION_SOURCE_PROFILE)
    );
    const fixtureFile = path.join(root, 'prepared-fixture.json');
    json(fixtureFile, {
      schema: 'caws.qualification.render-owner.prepared-fixture.v1',
      state: 'fixture_prepared',
      adoption: 'NOT_ADOPTED',
      artifactRoot: root,
      ownerConfig,
      project,
      home,
      sessionId,
      transcriptFile,
      offers,
      inputs: {
        nativeBuild: manifest.nativeBuild,
        qualifier: manifest.qualifierExecution,
        ownerConfig: pin(path.join(root, 'owner-config-input.json')),
        selection: pin(path.join(root, 'selection.json')),
        policy: pin(policyFile),
        tools: pin(path.join(root, 'tools.json')),
        sourceCustody: pin(path.join(root, 'source-custody-prepared.json')),
        preparedImages: [
          pin(path.join(root, 'initial-prepared-image.json')),
          pin(path.join(root, 'fifo-B-prepared-image.json')),
        ],
        transcript: pin(transcriptFile),
        meta: pin(path.join(session, '.meta.json')),
      },
      nonclaims: [
        'native image admission/publication or actor execution',
        'renderer ordering, store settlement, or ordinary renderer output',
        'full qualification, cross-session fairness, or Python retirement',
        'machine installation/adoption',
      ],
    });
    manifest.preparedFixture = pin(fixtureFile);
    manifest.adoption = 'NOT_ADOPTED';
    fixturePrepared = true;
    return;
  }
  success(
    run(
      'owner-pristine-init',
      native,
      ['renderer-service-init'],
      project,
      env,
      JSON.stringify(ownerConfig)
    )
  );
  const leaseFile = path.join(project, '.caws/leases', sessionId + '.json');
  json(path.join(session, '.meta.json'), {
    local_time: '2026-10-01T12:00:00Z',
    model: 'owner-fixture-model',
    head_sha: 'fixture',
  });
  const args = [
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
  const input = JSON.stringify({
    cwd: project,
    session_id: sessionId,
    transcript_path: transcriptFile,
  });
  monitor = setInterval(() => {
    try {
      sample();
    } catch (error) {
      if (!gaps.includes(String(error))) gaps.push(String(error));
    }
  }, 100);
  let previousTranscript = '';
  for (let ordinal = 1; ordinal <= (warmSessionEnd ? 2 : 3); ordinal++) {
    if (warmSessionEnd && ordinal === 2) await sealWarmRenderer(env, installed.digest);
    const servedOrdinal = warmSessionEnd ? 1 : ordinal;
    const directory = path.join(root, 'request-' + ordinal);
    fs.mkdirSync(directory, { mode: 0o700 });
    const count = ordinal === 1 ? 1 : 2;
    if (ordinal !== 3) put(transcriptFile, transcript(count));
    const currentTranscript = digest(fs.readFileSync(transcriptFile));
    if (ordinal === 3)
      assert.equal(
        currentTranscript,
        previousTranscript,
        'unchanged transcript request mutated input'
      );
    previousTranscript = currentTranscript;
    put(path.join(directory, 'transcript.jsonl'), fs.readFileSync(transcriptFile));
    success(
      run(
        'lease-register-' + ordinal,
        process.execPath,
        [
          cliEntry,
          'agents',
          'register',
          '--session-id',
          sessionId,
          '--platform',
          'codex',
          '--json',
        ],
        project,
        env
      )
    );
    assert.equal(read(leaseFile).status, 'active', 'actual CLI did not register the fixture lease');
    put(path.join(directory, 'lease-before.json'), fs.readFileSync(leaseFile));
    const before = new Set(list(path.join(session, 'hook-invocations')));
    if (warmSessionEnd && ordinal === 2) {
      assert(lastNativeWorker);
      const beforeB = observe(lastNativeWorker.birth.pid);
      json(path.join(directory, 'A-native-worker-before-B.json'), {
        witness: lastNativeWorker.birth,
        observation: beforeB,
      });
      assert(
        beforeB.state === 'absent' ||
          (beforeB.state === 'observed' &&
            !same(lastNativeWorker.birth, instance(beforeB.process))),
        'B must follow original A native worker absence'
      );
    }
    const statusPromise = invoke(args, env, input);
    // The service monitor observes kernel identities; it never wraps/replaces
    // the pinned interpreter or alters the copied daemon/renderer bytes.
    const status = await statusPromise;
    const requestResult: Data = { ordinal, status, transcriptSha256: currentTranscript };
    requests.push(requestResult);
    persist();
    success(status);
    const invocationFiles = list(path.join(session, 'hook-invocations')).filter(
      (name) => !before.has(name)
    );
    assert.equal(
      invocationFiles.length,
      1,
      'one native request must produce one invocation journal'
    );
    const journalFile = path.join(session, 'hook-invocations', invocationFiles[0]!);
    const journalFd = fs.openSync(
      journalFile,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
    );
    let journalBytes: Buffer;
    try {
      const stat = fs.fstatSync(journalFd);
      assert(
        stat.isFile() &&
          stat.uid === process.getuid?.() &&
          stat.nlink === 1 &&
          stat.size > 0 &&
          stat.size <= MAX_TYPED_JOURNAL,
        'unsafe/oversized typed invocation journal'
      );
      journalBytes = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < journalBytes.length) {
        const count = fs.readSync(
          journalFd,
          journalBytes,
          offset,
          journalBytes.length - offset,
          null
        );
        assert(count > 0, 'typed invocation journal truncated during read');
        offset += count;
      }
      const afterStat = fs.fstatSync(journalFd);
      assert.equal(afterStat.size, stat.size, 'typed invocation journal changed during read');
      json(path.join(directory, 'invocation-journal-source.json'), {
        path: journalFile,
        device: stat.dev,
        inode: stat.ino,
        bytes: journalBytes.length,
        sha256: digest(journalBytes),
      });
    } finally {
      fs.closeSync(journalFd);
    }
    put(path.join(directory, 'invocation-journal.jsonl'), journalBytes);
    const identity = decodeInvocationIdentity(journalBytes, installed.digest, digest(input));
    requestResult.identity = identity;
    const journal = journalBytes
      .toString('utf8')
      .trim()
      .split('\n')
      .map((line) => row(JSON.parse(line)));
    const custody = requestCustodies.get(status.directory);
    const coverage = requestCoverage.get(status.directory);
    assert(custody && coverage, 'current request custody/coverage record missing');
    custody.expected = { ...identity, coverage, node: process.execPath, engine };
    const nativeCustody = custody.collector.collect(custody.expected);
    requestResult.nativeCustody = nativeCustody;
    json(path.join(directory, 'native-custody.json'), requestResult.nativeCustody);
    const until = Date.now() + 1000;
    let backend = backendLease();
    while ((!backend || backend.lease.served !== servedOrdinal) && Date.now() < until) {
      await pause(25);
      backend = backendLease();
    }
    assert(backend, 'actual owner did not retain a backend lease');
    assert.equal(backend.lease.served, servedOrdinal, 'actual daemon served counter');
    const cache = row(backend.lease.cache);
    assert.equal(cache.sessions, 1, 'renderer cache lost selected transcript identity');
    assert.equal(cache.full, 1, 'warm path reparsed the complete transcript');
    assert.equal(
      cache.tail,
      warmSessionEnd || ordinal === 1 ? 0 : 1,
      'appended transcript did not use verified-prefix tail parsing'
    );
    assert.equal(backend.lease.hooks_dir, path.join(prepared.manifest.execution.root, 'hooks'));
    const pid = Number(backend.lease.pid);
    backendPids.add(pid);
    const observed = observe(pid);
    assert.equal(observed.state, 'observed', 'live daemon birth identity unavailable');
    const daemon = instance(observed.process);
    assert(!daemon.zombie, 'daemon is zombie');
    if (lastDaemon) {
      if (warmSessionEnd)
        assert(!same(lastDaemon, daemon), 'B must use a new daemon birth identity');
      else assert(same(lastDaemon, daemon), 'warm request used a different actual daemon');
    }
    lastDaemon = daemon;
    processes.set(pid, daemon);
    requestResult.daemon = { lease: backend.lease, observation: observed };
    const ownerEvents = ownerObservations();
    const created = ownerEvents.filter((event) => event.event === 'worker_created');
    assert.equal(created.length, warmSessionEnd ? ordinal : 1, 'actual worker creation count');
    const currentCreated = created[created.length - 1]!;
    assert.equal(currentCreated.backendPid, pid);
    if (warmSessionEnd) {
      const nativeWorkerPid = Number(currentCreated.nativeWorkerPid);
      assert(Number.isSafeInteger(nativeWorkerPid) && nativeWorkerPid > 1);
      const nativeWorkerObservation = observe(nativeWorkerPid);
      assert.equal(
        nativeWorkerObservation.state,
        'observed',
        'actual native worker live birth unavailable'
      );
      const birth = instance(nativeWorkerObservation.process);
      assert.equal(birth.pid, nativeWorkerPid);
      assert(!birth.zombie);
      assert.equal(
        daemon.parent,
        nativeWorkerPid,
        'actual backend must descend from the exact created native worker'
      );
      if (lastNativeWorker)
        assert(!same(lastNativeWorker.birth, birth), 'B must use a new native worker birth');
      lastNativeWorker = { created: { ...currentCreated }, birth };
      processes.set(nativeWorkerPid, birth);
      requestResult.nativeWorker = {
        created: currentCreated,
        observation: nativeWorkerObservation,
      };
    }
    if (warmSessionEnd && ordinal === 2) {
      assert(warmSealInvocationId);
      const releases = ownerEvents.filter(
        (event) =>
          event.stage === 'session_heavy_released' && event.invocationId === warmSealInvocationId
      );
      assert.equal(releases.length, 1, 'one release for the exact seal original required');
      const released = ownerEvents.indexOf(releases[0]!);
      assert(
        released >= 0 && released < ownerEvents.indexOf(created[1]!),
        'B worker must start after seal consumption and heavy release'
      );
    }
    assert.equal(
      ownerEvents.filter((event) => event.event === 'backend_reused').length,
      warmSessionEnd ? 0 : ordinal - 1
    );
    assert.equal(
      ownerEvents.filter((event) => event.event === 'journal_dispatch').length,
      ordinal,
      'unexpected owner retry'
    );
    const returned = ownerEvents.filter((event) => event.event === 'render_outcome');
    assert.deepEqual(
      returned.map((event) => event.served),
      Array.from({ length: ordinal }, (_, i) => (warmSessionEnd ? 1 : i + 1))
    );
    assert.deepEqual(
      returned.map((event) => event.cached),
      (warmSessionEnd ? [false, false] : [false, false, true]).slice(0, ordinal),
      'unchanged request did not use the renderer shortcut'
    );
    assert(returned.every((event) => event.execution === 'daemon_response'));
    assert(
      !ownerEvents.some((event) =>
        ['actor_error', 'worker_failure', 'worker_cleanup_deadline'].includes(String(event.event))
      )
    );
    const preparedEvents = ownerEvents.filter((event) => event.event === 'prepared');
    assert.equal(preparedEvents.length, ordinal);
    const preparedForOriginal = preparedEvents.filter(
      (event) => event.invocationId === identity.invocationId
    );
    assert.equal(
      preparedForOriginal.length,
      1,
      'each decoded original must have exactly one Prepared'
    );
    const currentPrepared = preparedForOriginal[0]!;
    assert.equal(
      currentPrepared.backendPid,
      pid,
      'this original Prepared must name its actual current backend'
    );
    assert.equal(currentPrepared.sessionId, sessionId);
    assert.equal(currentPrepared.selectedIndex, selectedIndex);
    requestResult.preparedBinding = {
      invocationId: identity.invocationId,
      prepared: currentPrepared,
      created: currentCreated,
    };
    requestResult.ownerObservations = ownerEvents;
    const processInventory = processRows();
    const requestCleanup = requestCleanupObservation(coverage, processInventory, observe);
    requestResult.requestCleanup = requestCleanup;
    json(path.join(directory, 'request-cleanup.json'), requestCleanup);
    json(path.join(directory, 'result.json'), requestResult);
    persist();
    assert(requestCleanup.coverageComplete, 'current native request chain was not confirmed');
    assert.equal(
      requestCleanup.state,
      'confirmed_inactive',
      'current native request cleanup unconfirmed'
    );
    assert.equal(
      combinedRequestCleanup(requestCleanup, nativeCustody),
      'confirmed_inactive',
      'current native request receipt/absence correlation unconfirmed'
    );
    json(path.join(directory, 'daemon-live.json'), requestResult.daemon);
    captureWorkers();
    const leaseAfter = read(leaseFile);
    assert.equal(leaseAfter.status, 'stopped', 'stock agent-stop failed to stop the actual lease');
    json(path.join(directory, 'lease-after.json'), leaseAfter);
    const completed = journal.find((item) => item.stage === 'compatibility_dispatch_completed');
    assert(
      completed && typeof completed.execution_records_base64 === 'string',
      'actual compatibility completion missing'
    );
    const execution = Buffer.from(completed.execution_records_base64, 'base64')
      .toString('utf8')
      .trim()
      .split('\n')
      .map((line) => row(JSON.parse(line)));
    assert.deepEqual(
      execution.map((item) => item.path),
      selected.handlers.map((handler) => handler.path)
    );
    assert(
      execution.every((item) => item.status === 'completed' && item.exit_code === 0),
      'full stock chain did not complete'
    );
    assert(
      !journal.some((item) => item.stage === 'adapter_error'),
      'adapter recorded incomplete execution'
    );
    const operations = operationRows().map((envelope) => row(envelope.body));
    assert.equal(
      operations.length,
      ordinal + (warmSessionEnd && ordinal === 2 ? 1 : 0),
      'duplicate or missing durable owner operation'
    );
    const renderOperations = operations.filter(
      (operation) => row(operation.outcome).execution !== 'consumed'
    );
    assert.equal(
      renderOperations.length,
      ordinal,
      'legacy Render remains returned without consumer ACK'
    );
    for (const operation of renderOperations)
      assert.equal(
        row(operation.outcome).execution,
        'returned',
        'owner journal retained unknown/running/cancelled work'
      );
    const served = renderOperations
      .map((operation) => Number(row(row(operation.outcome).result).served))
      .sort((a, b) => a - b);
    assert.deepEqual(
      served,
      Array.from({ length: ordinal }, (_, i) => (warmSessionEnd ? 1 : i + 1))
    );
    requestResult.ownerOperations = operations;
    requestResult.semanticTurns = turns(directory, count);
    json(
      path.join(directory, 'source-custody.json'),
      sourceCustody(STERLING_SESSION_SOURCE_PROFILE)
    );
    snapshot(owner, path.join(directory, 'owner-state-snapshot'));
    json(path.join(directory, 'result.json'), requestResult);
    persist();
  }
  if (warmSessionEnd) {
    manifest.established = [
      'actual reviewed Codex Render A, native stock Claude SessionEnd, actual Codex Render B',
      'exact A native-worker/backend tuple reaped with both EOFs and original native-worker birth absent before B',
      'native prefix and ordinary semantic consumer before exact durable CONSUMED and heavy release',
      'A turn bytes preserved by seal; B exposes exact two-turn user/tool/assistant output',
      'B uses a new daemon birth identity after seal release; legacy Render records remain returned',
    ];
    return;
  }
  compareForeignRendererBytes(prepared.manifest.execution.root, prepared.imageDigest, tools, env);
  manifest.established = [
    'native-published sealed image through actual full ordered Stop dispatcher',
    'unchanged reviewed selected handler and adjacent descriptor client',
    'actual daemon served 1/2/3 under one kernel birth identity',
    'exact user/tool/assistant timelines for cold, appended, and unchanged transcript',
    'actual stock lease stopped after every invocation',
    'three durable returned owner operations',
  ];
}
void main()
  .catch((error) => {
    failures.push(String(error));
    manifest.failureStack = error instanceof Error ? error.stack : String(error);
  })
  .finally(async () => {
    if (prepareOnly) {
      manifest.state =
        fixturePrepared && failures.length === 0 && gaps.length === 0
          ? 'fixture_prepared'
          : 'failed';
      manifest.cleanup = {
        state: 'not_started',
        reason: 'prepare-only does not launch native owner',
      };
      manifest.completedAt = new Date().toISOString();
      persist();
      process.stdout.write(
        JSON.stringify(
          {
            artifactRoot: root,
            manifest: path.join(root, 'manifest.json'),
            state: manifest.state,
            adoption: 'NOT_ADOPTED',
            preparedFixture: manifest.preparedFixture ?? null,
            failures,
            evidenceGaps: gaps,
            cleanup: manifest.cleanup,
          },
          null,
          2
        ) + '\n'
      );
      if (!fixturePrepared || failures.length || gaps.length) process.exitCode = 1;
      return;
    }
    if (monitor) clearInterval(monitor);
    try {
      cleanup = await awaitCleanup();
    } catch (error) {
      cleanup = { state: 'unknown', error: String(error) };
    }
    manifest.cleanup = cleanup;
    if (cleanup.state !== 'confirmed_inactive')
      failures.push(
        'owner/socket/custody/request cleanup remains unknown; artifacts preserved, no further request or signal'
      );
    try {
      manifest.workerArtifacts = list(path.join(root, 'worker-snapshots'));
      const events = ownerObservations();
      json(path.join(root, 'owner-observations-final.json'), events);
      if (fs.existsSync(path.join(owner, 'observations.jsonl')))
        put(
          path.join(root, 'owner-observations-final.jsonl'),
          fs.readFileSync(path.join(owner, 'observations.jsonl'))
        );
      if (requests.length > 0) {
        const receipts = events.filter((event) => event.event === 'worker_cleanup');
        assert.equal(
          receipts.length,
          warmSessionEnd ? 2 : 1,
          'actual worker cleanup receipt missing'
        );
        for (const [receiptIndex, observation] of receipts.entries()) {
          const receipt = row(observation.receipt);
          assert.equal(receipt.directChildReaped, true);
          assert.equal(receipt.logsPersisted, true);
          assert.equal(receipt.deadlineExceeded, false);
          assert.equal(row(receipt.stdout).eof, true);
          assert.equal(row(receipt.stderr).eof, true);
          for (const channel of [
            'stdoutPrefixBase64',
            'stderrPrefixBase64',
            'workerStderrPrefixBase64',
          ]) {
            assert.equal(
              typeof observation[channel],
              'string',
              'bounded retained backend log prefix missing'
            );
            const prefix = Buffer.from(String(observation[channel]), 'base64');
            assert(prefix.length <= 512, 'backend diagnostic prefix exceeds contract');
            put(
              path.join(root, (warmSessionEnd ? receiptIndex + '-' : '') + channel + '.bin'),
              prefix
            );
          }
        }
        assert.equal(
          events.filter((event) => event.event === 'worker_exit').length,
          warmSessionEnd ? 2 : 1,
          'actual native worker wait missing'
        );
        assert.equal(
          events.filter((event) => event.event === 'host_idle_exit').length,
          1,
          'actual owner idle exit missing'
        );
        manifest.backendLogBoundary =
          'retained bounded native observation prefixes (512 bytes per channel), not full stdout/stderr';
      }
    } catch (error) {
      gaps.push(String(error));
    }
    manifest.state = failures.length
      ? 'failed'
      : gaps.length
        ? 'incomplete_evidence'
        : 'verified_slice';
    manifest.completedAt = new Date().toISOString();
    persist();
    process.stdout.write(
      JSON.stringify(
        {
          artifactRoot: root,
          manifest: path.join(root, 'manifest.json'),
          state: manifest.state,
          failures,
          evidenceGaps: gaps,
          cleanup,
        },
        null,
        2
      ) + '\n'
    );
    if (failures.length || gaps.length) process.exitCode = 1;
  });
