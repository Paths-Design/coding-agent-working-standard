/** Actual unchanged foreign writer counterexample and cooperative successor.
 * Usage: qualify-render-legacy.js <cli-root> <sterling-root> [debug|release]
 * Foreign bytes are copied into a private independent repository; no machine
 * install or foreign checkout mutation occurs. Evidence and sandbox remain.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as net from 'node:net';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createRenderHarness } from './render-qualification-harness';

type Row = Record<string, unknown>;
assert(process.argv[2] && process.argv[3], 'CLI root and Sterling root required');
const cli = fs.realpathSync(path.resolve(process.argv[2]));
const sterling = fs.realpathSync(path.resolve(process.argv[3]));
const profile = process.argv[4] ?? 'release';
assert(['debug', 'release'].includes(profile), 'native profile must be debug or release');
const crate = path.resolve(cli, '../caws-native');
const root = path.join(
  crate,
  'target/qualification/render-legacy-' + new Date().toISOString().replace(/[:.]/g, '-')
);
fs.mkdirSync(root, { recursive: true, mode: 0o700 });
const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'caws-render-legacy-')));
const project = path.join(sandbox, 'project'),
  home = path.join(sandbox, 'machine');
const hooks = path.join(project, '.caws/hooks'),
  sessionId = 'legacy-writer-private-fixture';
const output = path.join(project, '.caws/sessions', sessionId);
const native = path.join(crate, 'target', profile, 'caws-native');
const requireCli = createRequire(path.join(cli, 'package.json'));
const { STERLING_SESSION_SOURCE_PROFILE } = requireCli('./dist/runtime/service-image.js') as {
  STERLING_SESSION_SOURCE_PROFILE: Record<string, string>;
};
const sha = (bytes: string | Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
function put(file: string, bytes: string | Uint8Array): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, bytes, { mode: 0o600 });
}
function json(file: string, value: unknown): void {
  put(file, JSON.stringify(value, null, 2) + '\n');
}
const environment: NodeJS.ProcessEnv = {
  HOME: sandbox,
  CAWS_HOME: home,
  PATH: process.env.PATH,
  PYTHONDONTWRITEBYTECODE: '1',
  CAWS_SLRD_IDLE_S: '1',
};
const commands: Row[] = [];
const manifest: Row = {
  schema: 'caws.qualification.render-legacy.v1',
  state: 'running',
  root,
  sandbox,
  project,
  home,
  native,
  commands,
  nonclaims: [
    'Sterling source adoption',
    'machine installation',
    'unchanged legacy exclusion',
    'arbitrary same-UID adversary defense',
  ],
};
function persist(): void {
  json(path.join(root, 'manifest.json'), manifest);
}
let ordinal = 0;
function launch(
  name: string,
  executable: string,
  args: string[],
  env = environment
): {
  child: ChildProcess;
  done: Promise<Row>;
  directory: string;
} {
  const directory = path.join(root, 'commands', String(++ordinal).padStart(3, '0') + '-' + name);
  json(path.join(directory, 'command.json'), { executable, args, cwd: project });
  const out = fs.openSync(path.join(directory, 'stdout.bin'), 'wx', 0o600);
  const err = fs.openSync(path.join(directory, 'stderr.bin'), 'wx', 0o600);
  const child = spawn(executable, args, { cwd: project, env, stdio: ['pipe', out, err] });
  child.stdin?.on('error', (error) => put(path.join(directory, 'stdin-error.txt'), String(error)));
  fs.closeSync(out);
  fs.closeSync(err);
  const receipt: Row = { name, directory, executable, args, pid: child.pid, state: 'running' };
  commands.push(receipt);
  persist();
  const done = new Promise<Row>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      Object.assign(receipt, { state: 'exited', code, signal });
      json(path.join(directory, 'receipt.json'), receipt);
      persist();
      resolve(receipt);
    });
  });
  return { child, done, directory };
}
async function waitFor(check: () => boolean, label: string, maximum = 10000): Promise<void> {
  const end = Date.now() + maximum;
  while (!check()) {
    assert(Date.now() < end, 'deadline: ' + label);
    await pause(20);
  }
}
async function bounded<T>(promise: Promise<T>, label: string, maximum = 12000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('deadline; sandbox retained: ' + label)),
          maximum
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function retainManagedFailure(
  action: () => Promise<void>,
  observeCleanup: () => Promise<Row>,
  retain: (failure: Row) => void
): Promise<void> {
  try {
    await action();
  } catch (original) {
    const describe = (error: unknown): string =>
      error instanceof Error ? (error.stack ?? String(error)) : String(error);
    let cleanup: Row;
    try {
      cleanup = await observeCleanup();
    } catch (error) {
      cleanup = { state: 'unknown', error: describe(error) };
    }
    try {
      retain({
        state: 'failed',
        error: describe(original),
        cleanup,
        cleanupMethod: 'observation of autonomous retirement; no stop or signal requested',
        nonclaim: 'external all-writer adoption and prior-writer drain',
      });
    } catch (error) {
      process.stderr.write('Failure artifact could not be retained: ' + describe(error) + '\n');
    }
    throw original;
  }
}
const generation = sha('reviewed-private-legacy-source-generation');
function writerArgs(
  timeout: number,
  program: string,
  args: string[] = [],
  version = generation
): string[] {
  return [
    'render-writer',
    '--home',
    home,
    '--canonical-project',
    project,
    '--output-directory',
    output,
    '--session-id',
    sessionId,
    '--source-generation',
    version,
    '--timeout-ms',
    String(timeout),
    '--',
    program,
    ...args,
  ];
}
function turns(): Row {
  return Object.fromEntries(
    fs
      .readdirSync(output)
      .filter((name) => /^turn-\d+\.json$/.test(name))
      .sort()
      .map((name) => [
        name,
        {
          sha256: sha(fs.readFileSync(path.join(output, name))),
          payload: JSON.parse(fs.readFileSync(path.join(output, name), 'utf8')),
        },
      ])
  );
}
let holder: ReturnType<typeof launch> | undefined;
let daemon: ReturnType<typeof launch> | undefined;
let proxy: net.Server | undefined;
async function managedOwnerRace(): Promise<void> {
  assert.equal(profile, 'release', 'managed-owner race requires the shared release harness');
  const harness = await createRenderHarness({
    cli,
    sterling,
    label: 'render-legacy-managed-owner',
  });
  manifest.managedOwnerArtifactRoot = harness.root;
  persist();
  let cleanupObservation: Promise<Row> | undefined;
  // Share one observation attempt with the failure path, including rejection;
  // an uncertain first result must not restart the twenty-second budget.
  const observeCleanup = (): Promise<Row> => (cleanupObservation ??= harness.cleanup(20000));
  await retainManagedFailure(
    async () => {
      const fixture = await harness.createProject({
        name: 'managed-vs-cooperative-legacy',
        sessions: ['same-output-session'],
      });
      harness.startHost();
      harness.success(
        await bounded(harness.invoke(fixture), 'actual managed renderer invocation', 40000)
      );
      const created = harness
        .ownerEvents()
        .find((event) => event.event === 'worker_created' && typeof event.backendPid === 'number');
      assert(created, 'actual managed backend was not observed');
      const live = harness.observe(Number(created.backendPid));
      assert.equal(live.state, 'observed', 'managed backend not live before cooperative contender');
      harness.writeJson('managed-backend-before-contender.json', live);
      const python = harness.tools.find((tool) => tool.name === 'python3');
      assert(python);
      const alternateHome = path.join(harness.sandbox, 'alternate-machine');
      fs.mkdirSync(alternateHome, { mode: 0o700 });
      const fields = [
        fixture.session,
        fixture.project,
        fixture.sessionId,
        'started',
        'model',
        'branch',
        'head',
        '0',
        'start',
        fixture.transcriptFile,
        '',
        '',
      ];
      const sourceHelper = path.join(
        harness.home,
        'lib/runtimes',
        harness.installed.digest,
        'lib/session-render-writer.sh'
      );
      const templateHelper = path.join(
        cli,
        'templates/hook-packs/shared/lib/session-render-writer.sh'
      );
      const installedHelperBytes = fs.readFileSync(sourceHelper);
      assert.equal(
        sha(installedHelperBytes),
        sha(fs.readFileSync(templateHelper)),
        'installed cooperative helper differs'
      );
      harness.writeJson('installed-cooperative-helper-custody.json', {
        installedPath: sourceHelper,
        templatePath: templateHelper,
        sha256: sha(installedHelperBytes),
        bytes: installedHelperBytes.length,
      });
      const args = [
        '-c',
        'source "$1"\nshift\nif slrd_try_render "$@"; then printf cooperative-rendered; else touch UNFENCED-FALLBACK; fi',
        'managed-race',
        sourceHelper,
        path.join(fixture.project, '.caws/hooks'),
        path.join(fixture.project, 'not-custody.json'),
        ...fields,
      ];
      const env = {
        ...harness.env,
        CAWS_HOME: alternateHome,
        CAWS_ROOT: fixture.project,
        CAWS_RENDER_WRITER_NATIVE: harness.native,
        CAWS_RENDER_WRITER_PYTHON: python.path,
        CAWS_RENDER_WRITER_GENERATION: sha('cooperative-other-home-generation'),
        CAWS_RENDER_WRITER_TIMEOUT_MS: '50',
      };
      const before = fs.readFileSync(path.join(fixture.session, 'turn-001.json'));
      const refusal = harness.run(
        'actual-managed-backend-refuses-adopted-legacy',
        '/bin/bash',
        args,
        fixture.project,
        env
      );
      assert.equal(refusal.code, 75, 'cooperative foreign renderer overlapped a managed backend');
      assert.match(
        fs.readFileSync(path.join(refusal.directory, 'stderr.bin'), 'utf8'),
        /another machine owner retains custody/
      );
      assert(!fs.existsSync(path.join(fixture.project, 'UNFENCED-FALLBACK')));
      assert.equal(
        sha(fs.readFileSync(path.join(fixture.session, 'turn-001.json'))),
        sha(before),
        'refused contender changed managed artifacts'
      );
      harness.writeJson('refused-contender-artifact-identity.json', {
        before: sha(before),
        after: sha(fs.readFileSync(path.join(fixture.session, 'turn-001.json'))),
      });
      const cleanup = await observeCleanup();
      assert.equal(cleanup.state, 'confirmed_inactive');
      const after = harness.run(
        'adopted-legacy-after-managed-cleanup',
        '/bin/bash',
        args,
        fixture.project,
        {
          ...env,
          CAWS_RENDER_WRITER_TIMEOUT_MS: '3000',
          CAWS_RENDER_WRITER_GENERATION: sha('after-managed-generation'),
        }
      );
      harness.success(after);
      assert.equal(
        fs.readFileSync(path.join(after.directory, 'stdout.bin'), 'utf8'),
        'cooperative-rendered'
      );
      assert.match(
        fs.readFileSync(path.join(fixture.session, 'turn-001.json'), 'utf8'),
        new RegExp(fixture.label + ' user 1')
      );
      harness.writeJson('race-result.json', {
        state: 'passed',
        managedBackend: created,
        cooperativeRefusal: refusal,
        cleanup,
        cooperativeAfterCleanup: after,
        nonclaim: 'external all-writer adoption and prior-writer drain',
      });
    },
    // Existing cleanup observes exact owned processes, pipe EOF and custody;
    // no PID or lease is converted into permission to stop a process.
    observeCleanup,
    (failure) => harness.writeJson('race-result.json', failure)
  );
}
async function main(): Promise<void> {
  fs.mkdirSync(output, { recursive: true, mode: 0o700 });
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const source: Row[] = [];
  for (const [relative, expected] of Object.entries(STERLING_SESSION_SOURCE_PROFILE)) {
    const original = path.join(sterling, '.caws/hooks', relative);
    const bytes = fs.readFileSync(original);
    assert.equal(sha(bytes), expected, 'reviewed source changed: ' + relative);
    const target = path.join(hooks, relative);
    put(target, bytes);
    source.push({ original, target, relative, sha256: expected, bytes: bytes.length });
  }
  json(path.join(root, 'reviewed-sources.json'), source);
  const git = spawnSync('git', ['init', '--quiet', project], {
    env: environment,
    encoding: 'utf8',
  });
  assert.equal(git.status, 0, git.stderr);
  const python = spawnSync('/bin/sh', ['-c', 'command -v python3'], {
    env: environment,
    encoding: 'utf8',
  });
  assert.equal(python.status, 0);
  const interpreter = fs.realpathSync(python.stdout.trim());
  manifest.executableIdentity = {
    nativeSha256: sha(fs.readFileSync(native)),
    python: interpreter,
    pythonSha256: sha(fs.readFileSync(interpreter)),
    qualifierSha256: sha(fs.readFileSync(__filename)),
  };
  put(path.join(root, 'source/qualify-render-legacy.js'), fs.readFileSync(__filename));
  put(
    path.join(root, 'source/render-qualification-harness.js'),
    fs.readFileSync(path.join(__dirname, 'render-qualification-harness.js'))
  );
  const transcript = path.join(sandbox, 'transcript.jsonl');
  put(
    transcript,
    [
      {
        timestamp: '2026-10-01T12:01:00Z',
        type: 'turn_context',
        payload: { turn_id: 'legacy-turn', cwd: project, model: 'legacy-model' },
      },
      {
        timestamp: '2026-10-01T12:01:00Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'LEGACY actual user' }],
        },
      },
      {
        timestamp: '2026-10-01T12:01:01Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'LEGACY actual assistant' }],
        },
      },
    ]
      .map((value) => JSON.stringify(value))
      .join('\n') + '\n'
  );
  const fields = [
    output,
    project,
    sessionId,
    'started',
    'model',
    'branch',
    'head',
    '0',
    'start',
    transcript,
    '',
    '',
  ];
  json(path.join(root, 'renderer-arguments.json'), fields);

  // The real native wrapper has entered its child only after acquiring custody.
  // A second generation must contend on the same key, regardless of metadata.
  holder = launch('native-fence-holder', native, writerArgs(30000, '/bin/cat'));
  holder.child.stdin!.write('native-fence-held\n');
  await waitFor(
    () =>
      fs
        .readFileSync(path.join(holder!.directory, 'stdout.bin'), 'utf8')
        .includes('native-fence-held'),
    'native fence holder'
  );
  const anchor = path.join(project, '.caws/.render-writer-custody/.service-owner.lock');
  const anchorStat = fs.lstatSync(anchor);
  manifest.anchorIdentity = {
    path: anchor,
    device: anchorStat.dev,
    inode: anchorStat.ino,
    mode: anchorStat.mode & 0o7777,
  };
  const contender = launch(
    'different-generation-refused',
    native,
    writerArgs(50, '/usr/bin/true', [], sha('other-generation'))
  );
  contender.child.stdin!.end();
  assert.equal(
    (await bounded(contender.done, 'native contender')).code,
    75,
    'writer generation escaped stable fence'
  );
  const alternateHome = path.join(sandbox, 'alternate-machine');
  fs.mkdirSync(alternateHome, { mode: 0o700 });
  const crossHomeArgs = writerArgs(50, '/usr/bin/true', [], sha('other-home-generation'));
  crossHomeArgs[2] = alternateHome;
  const crossHome = launch('different-machine-home-refused', native, crossHomeArgs);
  crossHome.child.stdin!.end();
  assert.equal(
    (await bounded(crossHome.done, 'cross-home native contender')).code,
    75,
    'same canonical output split custody across machine homes'
  );

  const custodyDirectory = path.dirname(anchor);
  const movedCustody = path.join(project, '.caws/.render-writer-custody-moved');
  fs.renameSync(custodyDirectory, movedCustody);
  const missingLeaf = launch('registered-missing-leaf-refused', native, crossHomeArgs);
  missingLeaf.child.stdin!.end();
  assert.equal((await bounded(missingLeaf.done, 'registered missing-leaf contender')).code, 75);
  assert(!fs.existsSync(custodyDirectory), 'registered missing custody leaf was reinitialized');
  assert.equal(fs.lstatSync(path.join(movedCustody, '.service-owner.lock')).ino, anchorStat.ino);
  fs.renameSync(movedCustody, custodyDirectory);
  const sessions = path.join(project, '.caws/sessions');
  const movedSessions = path.join(project, '.caws/sessions-moved');
  fs.renameSync(sessions, movedSessions);
  fs.mkdirSync(output, { recursive: true, mode: 0o700 });
  const cacheReplacement = launch('session-cache-replacement-still-refused', native, crossHomeArgs);
  cacheReplacement.child.stdin!.end();
  assert.equal(
    (await bounded(cacheReplacement.done, 'session cache replacement contender')).code,
    75
  );
  assert.match(
    fs.readFileSync(path.join(cacheReplacement.directory, 'stderr.bin'), 'utf8'),
    /another machine owner retains custody/
  );
  fs.rmSync(sessions, { recursive: true });
  fs.renameSync(movedSessions, sessions);
  json(path.join(root, 'registered-anchor-and-cache-replacement.json'), {
    marker: path.join(project, '.caws/.render-writer-provisioned'),
    missingLeafRefusedWithoutCreation: true,
    sessionCacheReplacementStillContends: true,
    restoredSameLockInode: fs.lstatSync(anchor).ino,
  });
  const oneShot = launch('unchanged-one-shot-ignores-fence', interpreter, [
    '-I',
    '-S',
    '-B',
    path.join(hooks, 'session_log_renderer.py'),
    ...fields,
  ]);
  oneShot.child.stdin!.end();
  assert.equal((await bounded(oneShot.done, 'actual unchanged one-shot')).code, 0);
  assert.equal(Object.keys(turns()).length, 1, 'unchanged renderer did not write under held fence');
  assert.match(JSON.stringify(turns()), /LEGACY actual user/);
  assert.match(JSON.stringify(turns()), /LEGACY actual assistant/);
  json(path.join(root, 'one-shot-under-native-fence.json'), turns());

  // Different transcript bytes force the real daemon to produce a different
  // artifact before its reply is suppressed, rather than merely cache-hit.
  put(
    transcript,
    fs
      .readFileSync(transcript, 'utf8')
      .replace('LEGACY actual assistant', 'DAEMON actual assistant')
  );

  const actualLease = path.join(sandbox, 'actual-daemon-lease.json');
  daemon = launch('unchanged-daemon', interpreter, [
    '-I',
    '-S',
    '-B',
    path.join(hooks, 'session_log_daemon.py'),
    '--hooks-dir',
    hooks,
    '--lease-file',
    actualLease,
    '--idle-s',
    '1',
  ]);
  daemon.child.stdin!.end();
  await waitFor(() => fs.existsSync(actualLease), 'actual daemon lease');
  const lease = JSON.parse(fs.readFileSync(actualLease, 'utf8')) as {
    port: number;
    token: string;
    pid: number;
  };
  assert.equal(lease.pid, daemon.child.pid, 'owned daemon identity');
  json(path.join(root, 'actual-daemon-lease.json'), lease);
  // Forward actual bytes to the actual unchanged daemon. Retain and suppress
  // its response only after it renders. No fake daemon or renderer is used.
  let response = Buffer.alloc(0),
    requestBytes = Buffer.alloc(0);
  proxy = net.createServer((client) => {
    const backend = net.connect(lease.port, '127.0.0.1');
    client.on('data', (chunk: Buffer) => {
      requestBytes = Buffer.concat([requestBytes, chunk]);
      put(path.join(root, 'legacy-request.bin'), requestBytes);
      backend.write(chunk);
    });
    backend.on('data', (chunk: Buffer) => {
      response = Buffer.concat([response, chunk]);
      put(path.join(root, 'lost-daemon-response.bin'), response);
      json(path.join(root, 'daemon-artifacts-before-lost-response.json'), turns());
      backend.end();
      // Leave the real Bash client's read open until its own three second timeout.
    });
    client.on('close', () => backend.destroy());
    client.on('error', () => backend.destroy());
    backend.on('error', (error) => {
      put(path.join(root, 'proxy-error.txt'), String(error));
      client.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => {
    proxy!.once('error', reject);
    proxy!.listen(0, '127.0.0.1', resolve);
  });
  const address = proxy.address();
  assert(address && typeof address === 'object');
  const proxyLease = path.join(sandbox, 'response-loss-lease.json');
  json(proxyLease, {
    ...lease,
    pid: process.pid,
    port: address.port,
    last_used: Date.now() / 1000,
    idle_s: 60,
  });
  // Actual client plus the caller's actual one-shot fallback command. Spawn is
  // deliberately absent: the already-owned real daemon is the observed writer.
  const shell =
    'source "$1"\nshift\npython="$1"; renderer="$2"; hooks="$3"; lease="$4"; shift 4\n' +
    'if slrd_try_render "$hooks" "$lease" "$@"; then printf daemon-ok; else printf actual-inline-fallback; "$python" -I -S -B "$renderer" "$@"; fi\n';
  const client = launch('actual-client-response-loss-inline-fallback', '/bin/bash', [
    '-c',
    shell,
    'counterexample',
    path.join(hooks, 'lib/session-log-daemon-client.sh'),
    interpreter,
    path.join(hooks, 'session_log_renderer.py'),
    hooks,
    proxyLease,
    ...fields,
  ]);
  client.child.stdin!.end();
  assert.equal((await bounded(client.done, 'actual response-loss client')).code, 0);
  assert.match(
    fs.readFileSync(path.join(client.directory, 'stdout.bin'), 'utf8'),
    /actual-inline-fallback/
  );
  assert.match(
    response.toString('utf8'),
    /^ok /,
    'real daemon did not finish before response was lost'
  );
  assert.equal(
    requestBytes.toString('utf8'),
    [lease.token, ...fields].join('\x1f') + '\n',
    'actual client wire bytes differ'
  );
  assert.match(
    fs.readFileSync(path.join(root, 'daemon-artifacts-before-lost-response.json'), 'utf8'),
    /DAEMON actual assistant/
  );
  json(path.join(root, 'response-loss-rendered-artifacts.json'), turns());
  await new Promise<void>((resolve) => proxy!.close(() => resolve()));
  proxy = undefined;
  assert.equal((await bounded(daemon.done, 'owned daemon idle cleanup')).code, 0);
  manifest.actualDaemonReaped = true;

  const cooperative = path.join(cli, 'templates/hook-packs/shared/lib/session-render-writer.sh');
  const successor = launch(
    'adopted-client-refuses-under-held-fence',
    '/bin/bash',
    [
      '-c',
      'source "$1"\nshift\nif slrd_try_render "$@"; then :; else touch UNFENCED-FALLBACK; fi',
      'successor',
      cooperative,
      hooks,
      proxyLease,
      ...fields,
    ],
    {
      ...environment,
      CAWS_ROOT: project,
      CAWS_RENDER_WRITER_NATIVE: native,
      CAWS_RENDER_WRITER_GENERATION: generation,
      CAWS_RENDER_WRITER_PYTHON: interpreter,
      CAWS_RENDER_WRITER_TIMEOUT_MS: '50',
    }
  );
  successor.child.stdin!.end();
  assert.equal((await bounded(successor.done, 'adopted fenced client')).code, 75);
  assert(
    !fs.existsSync(path.join(project, 'UNFENCED-FALLBACK')),
    'adopted client escaped native refusal'
  );
  holder.child.stdin!.end();
  assert.equal((await bounded(holder.done, 'native holder release')).code, 0);
  const after = launch(
    'next-generation-after-release',
    native,
    writerArgs(1000, '/usr/bin/true', [], sha('next-generation'))
  );
  after.child.stdin!.end();
  assert.equal((await bounded(after.done, 'native release acquisition')).code, 0);
  assert.equal(fs.lstatSync(anchor).ino, anchorStat.ino, 'custody anchor was replaced');
  await managedOwnerRace();
  manifest.state = 'passed-bounded-counterexample-and-successor';
  manifest.externalDependency =
    'Sterling all-writer source adoption plus positively owned old-writer drain remains required; an absent lease is never drain proof.';
  persist();
  process.stdout.write(root + '\n');
}
main().catch((error: unknown) => {
  manifest.state = 'failed';
  manifest.error = String(error);
  persist();
  // Only direct children have handles; no lease PID is ever signalled. Closing
  // this owned holder's input allows its native custody path to finish normally.
  holder?.child.stdin?.end();
  proxy?.close();
  process.stderr.write(String(error) + '\nArtifacts retained: ' + root + '\n');
  process.exitCode = 1;
});
