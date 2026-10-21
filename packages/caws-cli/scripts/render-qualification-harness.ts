/** Shared actual-renderer qualification machinery. Private fixtures only; no machine adoption. */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  selectRequestChain,
  confirmRequestChain,
  retainRequestInstance,
  requestCleanupObservation,
  type RequestCoverage,
  type ProcessRow,
} from './render-request-topology';
import {
  RequestCustodyCollector,
  decodeInvocationIdentity,
  combinedRequestCleanup,
  MAX_TYPED_JOURNAL,
  type CustodyExpectation,
} from './render-request-custody';

export type Data = Record<string, unknown>;
export type Receipt = {
  code: number | null;
  signal: NodeJS.Signals | null;
  error: string | null;
  directory: string;
  pid?: number;
};
export type Started = {
  child: ChildProcess;
  done: Promise<Receipt>;
  directory: string;
  startedAt: number;
  originalBirth?: Data;
  invocation?: InvocationTrace;
};
export type InvocationTrace = {
  coverage: RequestCoverage;
  collector: RequestCustodyCollector;
  session: string;
  inputDigest: string;
  priorNames: Set<string>;
  expected: CustodyExpectation | null;
  journalPrefix: Buffer;
  journalFile: string | null;
  journalIdentity: string | null;
  rows: Data[];
  reads: number;
  event: 'stop' | 'pre_tool_use';
  errors: string[];
};
export type SessionFixture = {
  sessionId: string;
  session: string;
  transcriptFile: string;
  label: string;
  turns: number;
};
export type ProjectFixture = SessionFixture & {
  project: string;
  name: string;
  env: NodeJS.ProcessEnv;
  selection: Data;
  image: Data;
};
export type InvokeOptions = {
  sessionId?: string;
  surface?: string;
  event?: string;
  input?: Data | string;
  timeoutMs?: number;
  environment?: NodeJS.ProcessEnv;
  traceCustody?: boolean;
};
export function row(value: unknown): Data {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), 'expected object');
  return value as Data;
}
export function digest(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
export function put(file: string, value: string | Uint8Array): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, value, { mode: 0o600 });
}
export function writeJson(file: string, value: unknown): void {
  put(file, JSON.stringify(value, null, 2) + '\n');
}
export function readJson(file: string): Data {
  return row(JSON.parse(fs.readFileSync(file, 'utf8')));
}
export function files(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory)
    .sort()
    .flatMap((name) => {
      const absolute = path.join(directory, name);
      const stat = fs.lstatSync(absolute);
      assert(!stat.isSymbolicLink(), 'artifact symlink: ' + absolute);
      return stat.isDirectory() ? files(absolute).map((child) => name + '/' + child) : [name];
    });
}
export const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class RenderHarness {
  readonly cli: string;
  readonly sterling: string;
  readonly root: string;
  readonly sandbox: string;
  readonly home: string;
  readonly owner: string;
  readonly native: string;
  readonly engine: string;
  readonly cliEntry: string;
  readonly hookCli: string;
  readonly observer: string;
  readonly custodyObserver: string;
  readonly configPath: string;
  readonly env: NodeJS.ProcessEnv;
  readonly tools: readonly { name: string; path: string; sha256: string }[];
  readonly installed: { digest: string; files: readonly string[] };
  readonly ownerConfig: Data;
  private captureOnly = false;
  private command = 0;
  private readonly sessions = new Map<string, SessionFixture>();
  private readonly children: Started[] = [];
  private readonly api: ReturnType<typeof loadApi>;

  constructor(options: {
    cli: string;
    sterling?: string;
    capture?: {
      root: string;
      sandbox: string;
      home: string;
      native: string;
      observer: string;
      environment: NodeJS.ProcessEnv;
      tools: readonly { name: string; path: string; sha256: string }[];
      installed: { digest: string; files: readonly string[] };
    };
    label: string;
    limits?: Data;
    runtimeTemplates?: string;
    nativeProfile?: 'debug' | 'release';
  }) {
    this.cli = fs.realpathSync(options.cli);
    if (options.capture) {
      // Reuse capture/custody machinery without a renderer, wrapper, installation,
      // inherited startup code or a changed protective guard environment.
      const capture = options.capture;
      for (const directory of [capture.root, capture.sandbox, capture.home])
        assert(path.isAbsolute(directory) && fs.statSync(directory).isDirectory());
      this.captureOnly = true;
      this.sterling = ''; // Renderer-only APIs below refuse capture mode.
      this.root = fs.realpathSync(capture.root);
      this.sandbox = fs.realpathSync(capture.sandbox);
      this.home = fs.realpathSync(capture.home);
      this.owner = path.join(this.home, 'state/render-service');
      this.native = fs.realpathSync(capture.native);
      this.observer = fs.realpathSync(capture.observer);
      this.custodyObserver = ''; // No service custody API is available in this mode.
      this.engine = path.join(this.cli, 'dist/runtime/engine-entry.js');
      this.cliEntry = path.join(this.cli, 'dist/index.js');
      this.hookCli = ''; // In particular, no PATH wrapper is installed.
      this.configPath = '';
      this.env = { ...capture.environment };
      this.api = loadApi(this.cli);
      this.tools = capture.tools;
      this.installed = capture.installed;
      this.ownerConfig = { schema: 'caws.qualification.capture-only.v1' };
      return;
    }
    const nativeProfile = options.nativeProfile ?? 'release';
    assert(['debug', 'release'].includes(nativeProfile), 'native profile must be debug or release');
    const selectedRequest = process.env.CAWS_NATIVE_BUILD_REQUEST;
    assert(
      selectedRequest && path.isAbsolute(selectedRequest),
      'CAWS_NATIVE_BUILD_REQUEST must name an explicit absolute request file'
    );
    const nativeBuild = (
      createRequire(path.join(this.cli, 'package.json'))(
        './dist/tooling/native-sqlite-build.js'
      ) as typeof import('../dist/tooling/native-sqlite-build')
    ).loadNativeSqliteBuild(selectedRequest);
    assert.equal(nativeBuild.build.profile, nativeProfile, 'native qualification profile mismatch');

    assert(options.sterling, 'renderer qualification requires its source repository');
    this.sterling = fs.realpathSync(options.sterling);
    const crate = path.resolve(this.cli, '../caws-native');
    this.root = path.join(
      crate,
      'target/qualification',
      options.label + '-' + new Date().toISOString().replace(/[:.]/g, '-')
    );
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    this.sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'caws-render-qual-')));
    this.home = path.join(this.sandbox, 'machine');
    this.owner = path.join(this.home, 'state/render-service');
    this.native = nativeBuild.build.artifacts.native.path;
    this.observer = nativeBuild.build.artifacts.observer.path;
    this.custodyObserver = nativeBuild.build.artifacts.custodyObserver.path;
    this.engine = path.join(this.cli, 'dist/runtime/engine-entry.js');
    this.cliEntry = path.join(this.cli, 'dist/index.js');
    this.hookCli = path.join(this.root, 'hook-cli/caws');
    this.configPath = path.join(this.owner, 'config.json');
    for (const directory of [this.home, path.join(this.root, 'tmp')])
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    // Unsealed hooks also invoke `caws` (notably heartbeat). Bind that name to
    // this candidate, rather than silently measuring the host's installed CLI.
    // POSIX sh avoids inheriting the handlers' Bash startup hook recursively.
    const quote = (value: string): string => "'" + value.replace(/'/g, "'\\''") + "'";
    put(
      this.hookCli,
      '#!/bin/sh\nexec ' + quote(process.execPath) + ' ' + quote(this.cliEntry) + ' "$@"\n'
    );
    fs.chmodSync(this.hookCli, 0o700);
    this.env = {
      PATH: path.dirname(this.hookCli) + path.delimiter + (process.env.PATH ?? '/usr/bin:/bin'),
      HOME: this.home,
      CAWS_HOME: this.home,
      TMPDIR: path.join(this.root, 'tmp'),
      CAWS_TRAP_KILL: '0',
      PYTHONDONTWRITEBYTECODE: '1',
      LC_ALL: 'C',
      TZ: 'UTC',
    };
    this.api = loadApi(this.cli);
    this.tools = this.api.resolveRenderTools(
      this.env as Record<string, string>,
      path.join(this.cli, 'dist/runtime'),
      this.native
    );
    this.installed = this.api.installMachineRuntime({
      home: this.home,
      templatesRoot: options.runtimeTemplates
        ? fs.realpathSync(options.runtimeTemplates)
        : path.join(this.cli, 'templates/hook-packs'),
    });
    const installedWriter = path.join(
      this.home,
      'lib/runtimes',
      this.installed.digest,
      'lib/session-render-writer.sh'
    );
    assert.equal(
      digest(fs.readFileSync(installedWriter)),
      digest(
        fs.readFileSync(
          path.join(this.cli, 'templates/hook-packs/shared/lib/session-render-writer.sh')
        )
      ),
      'installed runtime omitted or changed the cooperative writer bridge'
    );
    const limits = {
      maxConnections: 32,
      maxProjects: 4,
      maxBackends: 4,
      maxQueuePerProject: 16,
      maxFrameBytes: 2 * 1024 * 1024,
      maxRetainedRecords: 128,
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
      ...options.limits,
    };
    this.ownerConfig = {
      schema: 'caws.render.owner.config.v1',
      home: this.home,
      clientRoot: path.join(this.cli, 'dist/runtime'),
      templateRoot: path.join(this.cli, 'templates/hook-packs/runtime/service-image'),
      clientShellSource: path.join(
        this.cli,
        'templates/hook-packs/shared/lib/session-render-service-client.sh'
      ),
      nativeExecutable: this.native,
      limits,
    };
    this.writeJson('harness.json', {
      schema: 'caws.qualification.render-harness.v1',
      nativeBuild: {
        requestFile: nativeBuild.requestFile,
        completionReceipt: nativeBuild.completionReceipt,
        requestDigest: nativeBuild.build.requestDigest,
        profile: nativeBuild.build.profile,
        prefixManifest: nativeBuild.build.prefixManifest,
        adoption: nativeBuild.build.adoption,
      },
      root: this.root,
      sandbox: this.sandbox,
      home: this.home,
      owner: this.owner,
      config: this.ownerConfig,
      tools: this.tools,
      installed: this.installed,
      unsealedHookCli: {
        mechanism: 'PATH',
        name: 'caws',
        path: this.env.PATH,
        wrapper: this.hookCli,
        sealedDispatchUsesItsOwnImageCli: true,
      },
      executables: [
        this.native,
        this.observer,
        this.custodyObserver,
        this.engine,
        this.cliEntry,
        process.execPath,
        this.hookCli,
      ].map((file) => ({ path: file, sha256: digest(fs.readFileSync(file)) })),
    });
    this.success(
      this.run(
        'owner-pristine-init',
        this.native,
        ['renderer-service-init'],
        this.sandbox,
        this.env,
        JSON.stringify(this.ownerConfig)
      )
    );
  }
  writeJson(name: string, value: unknown): void {
    writeJson(path.join(this.root, name), value);
  }
  run(
    name: string,
    executable: string,
    args: string[],
    cwd: string,
    env = this.env,
    input?: string
  ): Receipt {
    const directory = this.commandDirectory(name, executable, args, cwd);
    if (input !== undefined) put(path.join(directory, 'stdin.bin'), input);
    const stdout = fs.openSync(path.join(directory, 'stdout.bin'), 'wx', 0o600);
    const stderr = fs.openSync(path.join(directory, 'stderr.bin'), 'wx', 0o600);
    let result;
    try {
      result = spawnSync(executable, args, {
        cwd,
        env,
        input,
        stdio: [input === undefined ? 'ignore' : 'pipe', stdout, stderr],
        timeout: 45000,
      });
    } finally {
      fs.closeSync(stdout);
      fs.closeSync(stderr);
    }
    const receipt = {
      code: result.status,
      signal: result.signal,
      error: result.error?.message ?? null,
      directory,
      pid: result.pid,
    };
    writeJson(path.join(directory, 'receipt.json'), receipt);
    return receipt;
  }
  success(receipt: Receipt): void {
    assert.equal(receipt.error, null, JSON.stringify(receipt));
    assert.equal(
      receipt.code,
      0,
      JSON.stringify(receipt) +
        '\n' +
        fs.readFileSync(path.join(receipt.directory, 'stderr.bin'), 'utf8')
    );
  }
  private commandDirectory(name: string, executable: string, args: string[], cwd: string): string {
    const directory = path.join(
      this.root,
      'commands',
      String(++this.command).padStart(3, '0') + '-' + name
    );
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeJson(path.join(directory, 'command.json'), { executable, args, cwd, at: Date.now() });
    return directory;
  }
  start(
    name: string,
    executable: string,
    args: string[],
    cwd: string,
    env = this.env,
    input?: string,
    options: {
      keepInputOpen?: boolean;
      traceSession?: string;
      observeBirth?: boolean;
      traceEvent?: 'stop' | 'pre_tool_use';
    } = {}
  ): Started {
    const directory = this.commandDirectory(name, executable, args, cwd);
    const journalDirectory = options.traceSession
      ? path.join(options.traceSession, 'hook-invocations')
      : null;
    const priorNames = new Set(
      journalDirectory && fs.existsSync(journalDirectory) ? fs.readdirSync(journalDirectory) : []
    );
    let temporary: string | null = null;
    if (options.traceSession) {
      assert(input !== undefined, 'traced invocation requires exact input bytes');
      temporary = path.join(directory, 'tmp');
      fs.mkdirSync(temporary, { mode: 0o700 });
      env = { ...env, TMPDIR: temporary };
      writeJson(path.join(directory, 'request-temporary.json'), {
        path: temporary,
        retained: true,
      });
    }
    if (input !== undefined) put(path.join(directory, 'stdin.bin'), input);
    const out = fs.openSync(path.join(directory, 'stdout.bin'), 'wx', 0o600),
      err = fs.openSync(path.join(directory, 'stderr.bin'), 'wx', 0o600);
    const startedAt = Date.now();
    const child = spawn(executable, args, { cwd, env, stdio: ['pipe', out, err] });
    fs.closeSync(out);
    fs.closeSync(err);
    const originalBirth =
      options.traceSession || options.keepInputOpen || options.observeBirth
        ? child.pid
          ? this.observe(child.pid)
          : { state: 'unavailable' }
        : undefined;
    let monitor: ReturnType<typeof setInterval> | undefined;
    const done = new Promise<Receipt>((resolve) => {
      let settled = false;
      const finish = (receipt: Receipt): void => {
        if (!settled) {
          settled = true;
          if (monitor) clearInterval(monitor);
          writeJson(path.join(directory, 'receipt.json'), {
            ...receipt,
            startedAt,
            endedAt: Date.now(),
          });
          resolve(receipt);
        }
      };
      child.once('error', (error) =>
        finish({ code: null, signal: null, error: String(error), directory })
      );
      child.once('close', (code, signal) =>
        finish({
          code,
          signal,
          error: null,
          directory,
          ...(child.pid === undefined ? {} : { pid: child.pid }),
        })
      );
    });
    if (!options.keepInputOpen) {
      if (input !== undefined) child.stdin?.end(input);
      else child.stdin?.end();
    }
    const started: Started = {
      child,
      done,
      directory,
      startedAt,
      ...(originalBirth ? { originalBirth } : {}),
    };
    if (options.traceSession) {
      const coverage: RequestCoverage = {
        expected: child.pid
          ? {
              platform: process.platform,
              frontendPid: child.pid,
              frontendCommand: [executable, ...args].join(' '),
              native: this.native,
              node: process.execPath,
              engine: this.engine,
            }
          : null,
        originalFrontend: originalBirth,
        confirmedChains: [],
        witnesses: [],
      };
      started.invocation = {
        coverage,
        collector: new RequestCustodyCollector(temporary!, path.join(directory, 'native-custody')),
        session: options.traceSession,
        inputDigest: digest(input!),
        priorNames,
        expected: null,
        journalPrefix: Buffer.alloc(0),
        journalFile: null,
        journalIdentity: null,
        rows: [],
        reads: 0,
        event: options.traceEvent ?? 'stop',
        errors: [],
      };
      writeJson(path.join(directory, 'original-frontend.json'), originalBirth);
      const sample = (): void => {
        try {
          this.sampleInvocation(started);
        } catch (error) {
          const text = String(error);
          if (!started.invocation!.errors.includes(text) && started.invocation!.errors.length < 16)
            started.invocation!.errors.push(text);
        }
      };
      monitor = setInterval(sample, 50);
      sample();
    }
    this.children.push(started);
    return started;
  }
  startHost(observeBirth = false): Started {
    assert(!this.captureOnly, 'renderer operation unavailable in capture-only mode');
    return this.start(
      'owned-host',
      this.native,
      ['renderer-host', '--config', this.configPath],
      this.sandbox,
      this.env,
      undefined,
      { observeBirth }
    );
  }
  async createProject(options: {
    name: string;
    surface?: string;
    sessions?: string[];
    stopExtensions?: readonly { handler: 'agent-heartbeat.sh'; before: 'agent-stop.sh' }[];
  }): Promise<ProjectFixture> {
    assert(!this.captureOnly, 'renderer fixture unavailable in capture-only mode');
    assert(/^[a-zA-Z0-9_-]+$/.test(options.name));
    const project = path.join(this.sandbox, options.name),
      surface = options.surface ?? 'codex';
    assert(surface === 'codex' || surface === 'claude-code', 'qualified surface');
    fs.mkdirSync(project, { mode: 0o700 });
    const git = this.tools.find((tool) => tool.name === 'git');
    assert(git);
    const gitEnv = {
      ...this.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    };
    this.success(
      this.run(
        'git-init',
        git.path,
        ['-c', 'init.defaultBranch=main', 'init', '-q'],
        project,
        gitEnv
      )
    );
    this.success(
      this.run(
        'project-init',
        process.execPath,
        [this.cliEntry, 'init', '--agent-surface', 'none'],
        project
      )
    );
    const writerPaths =
      '.caws/.render-writer-provisioned\n.caws/.render-writer-custody/.service-owner.lock\n';
    const ignored = this.run(
      'writer-state-ignore',
      git.path,
      ['check-ignore', '--stdin'],
      project,
      gitEnv,
      writerPaths
    );
    this.success(ignored);
    assert.equal(
      fs.readFileSync(path.join(ignored.directory, 'stdout.bin'), 'utf8'),
      writerPaths,
      'durable runtime custody must be excluded from Git without being treated as disposable cache'
    );
    const custody: Data[] = [];
    for (const [name, expected] of Object.entries(this.api.STERLING_SESSION_SOURCE_PROFILE)) {
      const source = path.join(this.sterling, '.caws/hooks', name),
        before = fs.lstatSync(source),
        bytes = fs.readFileSync(source),
        after = fs.lstatSync(source);
      assert(before.isFile() && !before.isSymbolicLink());
      assert.deepEqual(
        [before.dev, before.ino, before.size, before.mtimeMs, before.ctimeMs],
        [after.dev, after.ino, after.size, after.mtimeMs, after.ctimeMs]
      );
      assert.equal(digest(bytes), expected, 'reviewed source drift: ' + source);
      put(path.join(project, '.caws/hooks', name), bytes);
      fs.chmodSync(path.join(project, '.caws/hooks', name), before.mode & 0o777);
      custody.push({ name, source, sha256: digest(bytes), bytes: bytes.length });
    }
    this.writeJson(options.name + '/source-custody.json', custody);
    put(
      path.join(project, 'fixture.txt'),
      'Private actual renderer qualification ' + options.name + '\n'
    );
    this.success(
      this.run(
        'git-add',
        git.path,
        ['-c', 'core.hooksPath=/dev/null', 'add', '--all'],
        project,
        gitEnv
      )
    );
    this.success(
      this.run(
        'git-commit',
        git.path,
        [
          '-c',
          'core.hooksPath=/dev/null',
          '-c',
          'user.name=Qualification',
          '-c',
          'user.email=qualification@invalid',
          'commit',
          '-qm',
          'private reviewed source fixture',
        ],
        project,
        gitEnv
      )
    );
    const runtime = path.join(this.home, 'lib/runtimes', this.installed.digest),
      defaults = row(readJson(path.join(runtime, 'system-policy.json')).events) as Record<
        string,
        string[]
      >;
    const policy = {
      disabled: {},
      extensions: options.stopExtensions?.length
        ? { stop: options.stopExtensions.map((extension) => ({ ...extension })) }
        : {},
      handlers: { 'session-log.sh': '.caws/hooks/session-log.sh' },
      libraries: {},
    };
    this.api.validateSystemPolicy(project, policy, { files: [...this.installed.files], defaults });
    writeJson(path.join(this.home, 'surfaces', surface, 'settings.json'), {
      version: 1,
      enabled: true,
    });
    writeJson(path.join(this.home, 'state/projects', digest(project) + '.json'), {
      version: 1,
      root: project,
      surfaces: { [surface]: policy },
    });
    const selection = this.api.resolveInvocationSelection({
      checkout: project,
      canonical: project,
      home: this.home,
      runtimeDigest: this.installed.digest,
      surface,
      event: 'stop',
      system: true,
    });
    assert.equal(selection.status, 'active');
    if (selection.status !== 'active') throw new Error('selection inactive');
    const selectedIndex = selection.handlers.findIndex(
      (handler) => handler.kind === 'project-override'
    );
    assert.equal(selectedIndex, 2);
    const state = path.join(this.home, 'state/projects', digest(project)),
      imageParent = path.join(state, 'service-images');
    fs.mkdirSync(imageParent, { recursive: true, mode: 0o700 });
    const image = this.api.prepareSessionRenderImage({
      selection,
      selectedIndex,
      imageParent,
      environment: this.env as Record<string, string>,
      toolchain: this.tools,
      clientDirectory: path.join(this.cli, 'dist/runtime'),
      templateDirectory: path.join(this.cli, 'templates/hook-packs/runtime/service-image'),
      clientShellPath: path.join(
        this.cli,
        'templates/hook-packs/shared/lib/session-render-service-client.sh'
      ),
    });
    writeJson(path.join(state, 'render-service.json'), {
      version: 1,
      adapter: image.manifest.adapter,
      profile: image.manifest.profile,
      root: project,
      handler: {
        entry: 'session-log.sh',
        path: selection.handlers[selectedIndex]!.path,
        sha256: selection.handlers[selectedIndex]!.sha256,
      },
      sourceProfileDigest: image.manifest.originalClosureDigest,
    });
    this.writeJson(options.name + '/selection.json', selection);
    this.writeJson(options.name + '/image.json', image);
    const fixture: ProjectFixture = {
      project,
      name: options.name,
      env: this.env,
      selection: selection as unknown as Data,
      image: image as unknown as Data,
      sessionId: '',
      session: '',
      transcriptFile: '',
      label: '',
      turns: 0,
    };
    for (const sessionId of options.sessions ?? ['shared-id']) {
      const session = this.createSession(fixture, { sessionId });
      if (!fixture.sessionId) Object.assign(fixture, session);
    }
    return fixture;
  }
  createSession(
    fixture: ProjectFixture,
    options: { sessionId: string; surface?: string; turns?: number; label?: string }
  ): SessionFixture {
    assert(/^[a-zA-Z0-9_-]+$/.test(options.sessionId));
    const session = path.join(fixture.project, '.caws/sessions', options.sessionId),
      label = options.label ?? fixture.name + ':' + options.sessionId,
      turns = options.turns ?? 1;
    const transcriptFile = path.join(
      this.root,
      fixture.name,
      options.sessionId,
      'transcript.jsonl'
    );
    put(transcriptFile, this.transcript(fixture.project, label, turns));
    writeJson(path.join(session, '.meta.json'), {
      local_time: '2026-10-01T12:00:00Z',
      model: 'owner-fixture-model',
      head_sha: 'fixture',
    });
    const value = { sessionId: options.sessionId, session, transcriptFile, label, turns };
    this.sessions.set(fixture.project + '\0' + options.sessionId, value);
    return value;
  }
  transcript(project: string, label: string, turns: number): string {
    const records: Data[] = [];
    for (let index = 1; index <= turns; index++) {
      const timestamp = new Date(Date.UTC(2026, 9, 1, 12, 0, index)).toISOString();
      records.push(
        {
          timestamp,
          type: 'turn_context',
          payload: { turn_id: label + '-' + index, cwd: project, model: 'owner-fixture-model' },
        },
        {
          timestamp,
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: label + ' user ' + index }],
          },
        },
        {
          timestamp,
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'exec_command',
            call_id: label + '-call-' + index,
            arguments: JSON.stringify({ cmd: 'touch MUST-NOT-EXECUTE' }),
          },
        },
        {
          timestamp,
          type: 'response_item',
          payload: {
            type: 'function_call_output',
            call_id: label + '-call-' + index,
            output: label + ' result ' + index,
          },
        },
        {
          timestamp,
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: label + ' assistant ' + index }],
          },
        }
      );
    }
    return records.map((record) => JSON.stringify(record)).join('\n') + '\n';
  }
  spawnInvocation(fixture: ProjectFixture, options: InvokeOptions = {}): Started {
    const sessionId = options.sessionId ?? fixture.sessionId,
      session = this.sessions.get(fixture.project + '\0' + sessionId);
    assert(session);
    const surface = options.surface ?? 'codex';
    if (options.traceCustody)
      assert(
        surface === 'codex' && (options.event ?? 'stop') === 'stop',
        'custody trace currently qualifies only codex/stop'
      );
    const env = {
      ...this.env,
      ...options.environment,
      CODEX_THREAD_ID: sessionId,
      CAWS_SESSION_ID: sessionId,
    };
    const input = options.input ?? {
      cwd: fixture.project,
      session_id: sessionId,
      transcript_path: session.transcriptFile,
    };
    return this.start(
      'native-' + fixture.name + '-' + sessionId,
      this.native,
      [
        'invoke',
        '--engine',
        this.engine,
        '--node',
        process.execPath,
        '--surface',
        surface,
        '--event',
        options.event ?? 'stop',
        '--runtime-digest',
        this.installed.digest,
        '--timeout-ms',
        String(options.timeoutMs ?? 30000),
        '--configuration',
        'system',
      ],
      fixture.project,
      env,
      typeof input === 'string' ? input : JSON.stringify(input),
      options.traceCustody ? { traceSession: session.session } : {}
    );
  }
  async invoke(fixture: ProjectFixture, options: InvokeOptions = {}): Promise<Receipt> {
    return this.spawnInvocation(fixture, options).done;
  }
  ownerEvents(): Data[] {
    assert(!this.captureOnly, 'renderer operation unavailable in capture-only mode');
    const file = path.join(this.owner, 'observations.jsonl');
    if (!fs.existsSync(file)) return [];
    const bytes = fs.readFileSync(file, 'utf8');
    // Concurrent observations may end in an in-progress append: omit only that
    // last fragment, retain raw bytes separately at the final settled boundary.
    return bytes
      .slice(0, bytes.lastIndexOf('\n') + 1)
      .split('\n')
      .filter(Boolean)
      .map((line) => row(row(JSON.parse(line)).observation));
  }
  operations(): Data[] {
    assert(!this.captureOnly, 'renderer operation unavailable in capture-only mode');
    const base = path.join(this.owner, 'custody/operations/services');
    return files(base)
      .filter((name) => /(?:^|\/)\w{64}\.json$/.test(name))
      .map((name) => readJson(path.join(base, name)));
  }
  observe(pid: number): Data {
    const result = spawnSync(this.observer, ['--observe', String(pid)], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin' },
      timeout: 1000,
      maxBuffer: 16384,
    });
    if (result.status !== 0 || result.stderr)
      return {
        state: 'unavailable',
        code: result.status,
        error: result.error?.message,
        stderr: result.stderr,
      };
    try {
      return row(JSON.parse(result.stdout));
    } catch {
      return { state: 'unavailable', stdout: result.stdout };
    }
  }
  /** Retained Child plus matching birth; the observed PID never becomes a signal handle. */
  originalChildAlive(started: Started): Data {
    assert(started.child.pid && started.originalBirth, 'original Child birth unavailable');
    assert.equal(started.child.exitCode, null, 'original Child exited');
    assert.equal(started.child.signalCode, null, 'original Child already signaled');
    const original = row(started.originalBirth);
    assert.equal(original.state, 'observed', 'original Child birth unavailable');
    const now = this.observe(started.child.pid);
    assert.equal(now.state, 'observed', 'current Child birth unavailable');
    const a = row(original.process),
      b = row(now.process);
    for (const key of ['pid', 'startSeconds', 'startMicros', 'group', 'parent'])
      assert.equal(b[key], a[key], 'original Child identity changed: ' + key);
    assert.equal(b.zombie, false, 'original Child is zombie');
    return now;
  }
  private processRows(): ProcessRow[] {
    const result = spawnSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,state=,command='], {
      env: { PATH: '/usr/bin:/bin' },
      encoding: 'utf8',
      timeout: 1000,
      maxBuffer: 4 * 1024 * 1024,
    });
    assert.equal(result.status, 0, 'process inventory unavailable');
    assert.equal(result.stderr, '', 'process inventory diagnostics');
    return result.stdout
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => {
        const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
        assert(m, 'unparsed process inventory');
        return {
          pid: Number(m[1]),
          parent: Number(m[2]),
          group: Number(m[3]),
          state: m[4]!,
          command: m[5]!,
        };
      });
  }
  observedGroupsAbsent(births: Data[]): Data | undefined {
    const groups = births.map((birth) => {
      assert.equal(birth.state, 'observed', 'group origin birth unavailable');
      const group = row(birth.process).group;
      assert(typeof group === 'number' && Number.isSafeInteger(group) && group > 1);
      return group;
    });
    const members = this.processRows().filter((process) => groups.includes(process.group));
    return members.length === 0 ? { groups, members, state: 'absent' } : undefined;
  }
  sampleInvocation(started: Started): boolean {
    const trace = started.invocation;
    assert(trace, 'invocation trace unavailable');
    const chain = trace.coverage.expected
      ? selectRequestChain(this.processRows(), trace.coverage.expected)
      : null;
    if (!chain) return false;
    const before = chain.map((p) => this.observe(p.pid));
    const after = chain.map((p) => this.observe(p.pid));
    const confirmed = confirmRequestChain(chain, trace.coverage.originalFrontend, before, after);
    if (!confirmed) return false;
    const previous = trace.coverage.confirmedChains.at(-1);
    if (JSON.stringify(previous) !== JSON.stringify(confirmed)) {
      assert(trace.coverage.confirmedChains.length < 16, 'request topology observation bound');
      trace.coverage.confirmedChains.push(confirmed);
      fs.appendFileSync(
        path.join(started.directory, 'request-topology.jsonl'),
        JSON.stringify({ at: Date.now(), chain, before, after, confirmed }) + '\n',
        { mode: 0o600 }
      );
    }
    for (const p of confirmed) retainRequestInstance(trace.coverage, p);
    return true;
  }
  /** Only complete records establish a live phase; final reads require full EOF-aligned bytes. */
  invocationJournal(started: Started, final = false): Data[] {
    const trace = started.invocation;
    assert(trace, 'invocation trace unavailable');
    const directory = path.join(trace.session, 'hook-invocations');
    assert(started.child.pid, 'original frontend PID unavailable');
    const names = fs
      .readdirSync(directory)
      .filter(
        (name) =>
          name.startsWith(String(started.child.pid) + '-') &&
          name.endsWith('.jsonl') &&
          !trace.priorNames.has(name)
      );
    if (!final && names.length === 0 && trace.journalFile === null) return [];
    assert.equal(names.length, 1, 'current typed invocation journal absent/ambiguous');
    const file = path.join(directory, names[0]!);
    assert(
      trace.journalFile === null || trace.journalFile === file,
      'invocation journal path changed'
    );
    const fd = fs.openSync(
      file,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
    );
    let bytes: Buffer, meta: fs.Stats;
    try {
      meta = fs.fstatSync(fd);
      assert(
        meta.isFile() &&
          meta.uid === process.getuid?.() &&
          meta.nlink === 1 &&
          (meta.mode & 0o077) === 0 &&
          meta.size > 0 &&
          meta.size <= MAX_TYPED_JOURNAL,
        'unsafe/oversized invocation journal'
      );
      assert(
        trace.journalIdentity === null || trace.journalIdentity === meta.dev + ':' + meta.ino,
        'invocation journal inode changed'
      );
      bytes = Buffer.alloc(meta.size);
      let offset = 0;
      while (offset < bytes.length) {
        const count = fs.readSync(fd, bytes, offset, bytes.length - offset, null);
        assert(count > 0, 'invocation journal truncated during read');
        offset += count;
      }
      assert(fs.fstatSync(fd).size >= meta.size, 'invocation journal shrank during read');
    } finally {
      fs.closeSync(fd);
    }
    assert(
      bytes.subarray(0, trace.journalPrefix.length).equals(trace.journalPrefix),
      'invocation journal prefix changed'
    );
    if (!bytes.equals(trace.journalPrefix)) {
      assert(trace.reads < 128, 'invocation journal observation bound');
      const snapshot = path.join(
        started.directory,
        'typed-journal-' + String(++trace.reads).padStart(3, '0') + '.jsonl'
      );
      put(snapshot, bytes);
      writeJson(snapshot + '.source.json', {
        path: file,
        device: meta.dev,
        inode: meta.ino,
        bytes: bytes.length,
        sha256: digest(bytes),
      });
    }
    trace.journalFile = file;
    trace.journalIdentity = meta.dev + ':' + meta.ino;
    trace.journalPrefix = bytes;
    const prefix = final ? bytes : bytes.subarray(0, bytes.lastIndexOf(10) + 1);
    if (!final && prefix.length === 0) return [];
    const identity = decodeInvocationIdentity(
      prefix,
      this.installed.digest,
      trace.inputDigest,
      trace.event
    );
    assert.equal(
      path.basename(file),
      identity.invocationId + '.jsonl',
      'typed journal filename identity differs'
    );
    assert(
      identity.invocationId.startsWith(String(started.child.pid) + '-'),
      'typed journal frontend differs'
    );
    if (trace.expected)
      assert.equal(identity.invocationId, trace.expected.invocationId, 'invocation ID changed');
    trace.expected = {
      ...identity,
      coverage: trace.coverage,
      node: process.execPath,
      engine: this.engine,
    };
    trace.rows = prefix
      .toString('utf8')
      .trim()
      .split('\n')
      .map((line) => row(JSON.parse(line)));
    return trace.rows;
  }
  requestCompletion(started: Started): Data {
    const trace = started.invocation;
    assert(trace, 'invocation trace unavailable');
    try {
      this.invocationJournal(started, true);
      let inventory: ProcessRow[] | null = null;
      try {
        inventory = this.processRows();
      } catch {
        /* strict absence stays unknown */
      }
      const absence = requestCleanupObservation(trace.coverage, inventory, (pid) =>
        this.observe(pid)
      );
      const custody = trace.collector.collect(trace.expected!);
      const result = {
        state: combinedRequestCleanup(absence, custody),
        absence,
        custody,
        errors: trace.errors,
      };
      writeJson(path.join(started.directory, 'request-completion.json'), result);
      return result;
    } catch (error) {
      const result = { state: 'unknown', error: String(error), errors: trace.errors };
      writeJson(path.join(started.directory, 'request-completion.json'), result);
      return result;
    }
  }
  /** Missing raw identity intentionally has no typed journal. This distinct
   * qualification path binds the original fixture input/argv/birth to native
   * custody; it does not relax the typed-journal requirement for Stop.
   */
  missingSidPreToolUseCompletion(started: Started): Data {
    const trace = started.invocation;
    assert(trace, 'invocation trace unavailable');
    try {
      assert.equal(trace.event, 'pre_tool_use', 'missing-SID path is PreToolUse only');
      assert.equal(trace.expected, null, 'missing-SID path cannot borrow a typed identity');
      assert.equal(trace.journalFile, null, 'missing-SID path cannot borrow a typed journal');
      assert.equal(trace.journalPrefix.length, 0);
      assert.equal(trace.rows.length, 0);
      const journalDirectory = path.join(trace.session, 'hook-invocations');
      if (fs.existsSync(journalDirectory)) {
        const meta = fs.lstatSync(journalDirectory);
        assert(meta.isDirectory() && !meta.isSymbolicLink(), 'unsafe typed journal directory');
        assert.deepEqual(this.invocationJournal(started), [], 'unexpected current typed journal');
      }
      const command = row(
        JSON.parse(fs.readFileSync(path.join(started.directory, 'command.json'), 'utf8'))
      );
      assert(typeof command.executable === 'string');
      assert(Array.isArray(command.args) && command.args.every((arg) => typeof arg === 'string'));
      const rawInput = fs.readFileSync(path.join(started.directory, 'stdin.bin'));
      const custody = trace.collector.observeMissingSidPreToolUse({
        coverage: trace.coverage,
        runtimeDigest: this.installed.digest,
        node: process.execPath,
        engine: this.engine,
        request: {
          executable: command.executable,
          args: command.args,
          rawInput,
          inputSha256: trace.inputDigest,
          temporary: trace.collector.temporary,
        },
      });
      let inventory: ProcessRow[] | null = null;
      try {
        inventory = this.processRows();
      } catch {
        /* strict absence stays unknown */
      }
      const absence = requestCleanupObservation(trace.coverage, inventory, (pid) =>
        this.observe(pid)
      );
      const result = {
        state: combinedRequestCleanup(absence, custody),
        provenance: 'native-only-missing-sid-pre-tool-use',
        absence,
        custody,
        errors: trace.errors,
      };
      writeJson(path.join(started.directory, 'request-completion.json'), result);
      return result;
    } catch (error) {
      const result = { state: 'unknown', error: String(error), errors: trace.errors };
      writeJson(path.join(started.directory, 'request-completion.json'), result);
      return result;
    }
  }
  async waitFor<T>(
    check: () => T | undefined | null | false,
    ms: number,
    label: string
  ): Promise<T> {
    const deadline = Date.now() + ms;
    do {
      const value = check();
      if (value) return value;
      await pause(20);
    } while (Date.now() < deadline);
    throw new Error('observation deadline: ' + label);
  }
  /** Stable qualification evidence only; cleanup receipts are observations, never authority. */
  retainSessionEvidence(): Data {
    const maximumFileBytes = 8 * 1024 * 1024;
    const identity = (stat: fs.Stats): number[] => [
      stat.dev,
      stat.ino,
      stat.size,
      stat.mtimeMs,
      stat.ctimeMs,
    ];
    const stableRead = (file: string) => {
      const named = fs.lstatSync(file);
      assert(
        named.isFile() && !named.isSymbolicLink(),
        'session evidence must be regular: ' + file
      );
      const fd = fs.openSync(
        file,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
      );
      try {
        const held = fs.fstatSync(fd);
        assert(
          held.isFile() && held.size <= maximumFileBytes,
          'session evidence capture limit: ' + file
        );
        assert.deepEqual(identity(held), identity(named), 'session evidence replaced before read');
        const buffer = Buffer.alloc(held.size + 1);
        let count = 0;
        while (count < buffer.length) {
          const size = fs.readSync(fd, buffer, count, buffer.length - count, null);
          if (!size) break;
          count += size;
        }
        assert.equal(count, held.size, 'session evidence size changed during read');
        assert.deepEqual(
          identity(fs.fstatSync(fd)),
          identity(held),
          'session evidence changed during read'
        );
        const after = fs.lstatSync(file);
        assert(after.isFile() && !after.isSymbolicLink());
        assert.deepEqual(
          identity(after),
          identity(held),
          'session evidence name replaced during read'
        );
        return {
          bytes: buffer.subarray(0, count),
          identity: identity(held),
          dev: held.dev,
          ino: held.ino,
        };
      } finally {
        fs.closeSync(fd);
      }
    };
    const cleanupPath = path.join(this.root, 'cleanup.json');
    const cleanup = stableRead(cleanupPath),
      cleanupSha256 = digest(cleanup.bytes);
    assert.equal(
      row(JSON.parse(cleanup.bytes.toString('utf8'))).state,
      'confirmed_inactive',
      'session evidence requires confirmed inactive cleanup; preserve sandbox'
    );
    const destination = path.join(this.root, 'session-evidence');
    fs.mkdirSync(destination, { mode: 0o700 }); // Existing evidence is never overwritten.
    const sessions: Data[] = [];
    let capturedBytes = 0,
      capturedFiles = 0;
    for (const [key, session] of this.sessions) {
      const parts = key.split('\0');
      assert.equal(parts.length, 2);
      const project = parts[0]!,
        sid = parts[1]!;
      assert.equal(
        path.dirname(project),
        this.sandbox,
        'registered project must be a direct private sandbox child'
      );
      const projectName = path.basename(project);
      assert(/^[a-zA-Z0-9_-]+$/.test(projectName) && /^[a-zA-Z0-9_-]+$/.test(sid));
      assert.equal(sid, session.sessionId);
      assert.equal(session.session, path.join(project, '.caws/sessions', sid));
      for (const directory of [
        this.sandbox,
        project,
        path.join(project, '.caws'),
        path.join(project, '.caws/sessions'),
        session.session,
      ]) {
        const stat = fs.lstatSync(directory);
        assert(
          stat.isDirectory() && !stat.isSymbolicLink(),
          'session evidence directory is redirected'
        );
      }
      const directoryBefore = fs.lstatSync(session.session),
        flatBefore = fs.readdirSync(session.session).sort(),
        before = files(session.session);
      const retainedBase = path.join(destination, projectName, sid, 'files');
      fs.mkdirSync(retainedBase, { recursive: true, mode: 0o700 });
      const members = before.map((relative) => {
        assert(++capturedFiles <= 32768, 'session evidence file count limit');
        const originalPath = path.join(session.session, relative),
          retainedPath = path.join(retainedBase, relative);
        const original = stableRead(originalPath);
        capturedBytes += original.bytes.length;
        assert(capturedBytes <= 512 * 1024 * 1024, 'session evidence total capture limit');
        fs.mkdirSync(path.dirname(retainedPath), { recursive: true, mode: 0o700 });
        fs.writeFileSync(retainedPath, original.bytes, { flag: 'wx', mode: 0o600 });
        assert.deepEqual(
          fs.readFileSync(retainedPath),
          original.bytes,
          'session evidence copy differs'
        );
        return {
          relative,
          originalPath,
          retainedPath,
          bytes: original.bytes.length,
          sha256: digest(original.bytes),
          dev: original.dev,
          ino: original.ino,
          identity: original.identity,
        };
      });
      const after = files(session.session),
        flatAfter = fs.readdirSync(session.session).sort(),
        directoryAfter = fs.lstatSync(session.session);
      assert.deepEqual(after, before, 'session evidence filename inventory changed');
      assert.deepEqual(flatAfter, flatBefore, 'session evidence flat filename inventory changed');
      assert.deepEqual(
        identity(directoryAfter),
        identity(directoryBefore),
        'session evidence directory changed'
      );
      for (const member of members) {
        const final = stableRead(member.originalPath);
        assert.deepEqual(
          final.identity,
          member.identity,
          'session evidence changed before copy settled'
        );
        assert.equal(
          digest(final.bytes),
          member.sha256,
          'session evidence bytes changed before copy settled'
        );
      }
      const evidence = {
        project,
        projectName,
        sessionId: sid,
        originalDirectory: session.session,
        retainedDirectory: retainedBase,
        directoryIdentity: identity(directoryAfter),
        beforeFiles: before,
        afterFiles: after,
        beforeFlatFilenames: flatBefore,
        finalFlatFilenames: flatAfter,
        members,
      };
      fs.writeFileSync(
        path.join(destination, projectName, sid, 'inventory.json'),
        JSON.stringify(evidence, null, 2) + '\n',
        { flag: 'wx', mode: 0o600 }
      );
      sessions.push(evidence);
    }
    assert.equal(
      digest(stableRead(cleanupPath).bytes),
      cleanupSha256,
      'cleanup receipt changed during retention'
    );
    const evidence = {
      cleanupPath,
      cleanupSha256,
      maximumFileBytes,
      maximumFiles: 32768,
      maximumTotalBytes: 512 * 1024 * 1024,
      capturedBytes,
      capturedFiles,
      sessions,
    };
    fs.writeFileSync(
      path.join(destination, 'inventory.json'),
      JSON.stringify(evidence, null, 2) + '\n',
      { flag: 'wx', mode: 0o600 }
    );
    return evidence;
  }
  async cleanup(ms = 20000): Promise<Data> {
    assert(!this.captureOnly, 'renderer operation unavailable in capture-only mode');
    const deadline = Date.now() + ms,
      socket = path.join(
        '/private/tmp',
        'caws-render-' + process.getuid?.() + '-' + digest(this.home).slice(0, 24),
        'owner.sock'
      );
    let result: Data = { state: 'unknown' };
    do {
      const workers = fs.existsSync(path.join(this.owner, 'workers'))
        ? fs.readdirSync(path.join(this.owner, 'workers'))
        : [];
      const receipt = this.run(
        'custody-observation',
        this.custodyObserver,
        [path.join(this.owner, 'custody')],
        this.sandbox
      );
      let custody: Data;
      try {
        custody = readJson(path.join(receipt.directory, 'stdout.bin'));
      } catch {
        custody = { state: 'unavailable' };
      }
      const children = this.children.map((child) => ({
        pid: child.child.pid,
        exitCode: child.child.exitCode,
        signalCode: child.child.signalCode,
      }));
      const events = this.ownerEvents();
      const observed = events
        .filter((event) => ['worker_created', 'worker_spawned'].includes(String(event.event)))
        .flatMap((event) =>
          ['nativeWorkerPid', 'backendPid']
            .filter((key) => typeof event[key] === 'number')
            .map((key) => ({ pid: event[key], observation: this.observe(Number(event[key])) }))
        );
      const gone = observed.every((entry) => entry.observation.state === 'absent');
      const hosts = events
        .filter((event) => event.event === 'host_started' && typeof event.hostPid === 'number')
        .map((event) => ({ pid: event.hostPid, observation: this.observe(Number(event.hostPid)) }));
      const hostsGone =
        hosts.length > 0 && hosts.every((host) => host.observation.state === 'absent');
      // Host death leaves evidence directories: retain them. A directory is
      // inactive only with an actual complete worker cleanup receipt AND kernel
      // absence of that exact observed worker/backend pair. Missing IDs or a
      // receipt without pipe EOF never become absence evidence.
      const retainedWorkers = workers.map((name) => {
        const directory = path.join(this.owner, 'workers', name);
        try {
          const exit = readJson(path.join(directory, 'backend/worker-exit.json'));
          const cleanup = row(exit.cleanup),
            stdout = row(cleanup.stdout),
            stderr = row(cleanup.stderr);
          const created = events.find(
            (event) =>
              event.event === 'worker_created' &&
              event.backendPid === cleanup.childPid &&
              typeof event.nativeWorkerPid === 'number'
          );
          const backend =
            typeof cleanup.childPid === 'number'
              ? this.observe(cleanup.childPid)
              : { state: 'unavailable' };
          const worker = created
            ? this.observe(Number(created.nativeWorkerPid))
            : { state: 'unavailable' };
          return {
            directory,
            exit,
            backend,
            worker,
            complete:
              cleanup.directChildReaped === true &&
              stdout.eof === true &&
              stderr.eof === true &&
              backend.state === 'absent' &&
              worker.state === 'absent',
          };
        } catch (error) {
          return { directory, complete: false, error: String(error) };
        }
      });
      const retainedComplete = retainedWorkers.every((worker) => worker.complete);
      const nativeRequests: Data[] = this.children
        .filter((child) => child.invocation)
        .map((child) => ({
          directory: child.directory,
          ...this.requestCompletion(child),
        }));
      result = {
        state:
          retainedComplete &&
          !fs.existsSync(socket) &&
          receipt.code === 0 &&
          custody.state === 'free' &&
          gone &&
          hostsGone &&
          nativeRequests.every((request) => request.state === 'confirmed_inactive') &&
          children.every((child) => child.exitCode !== null || child.signalCode !== null)
            ? 'confirmed_inactive'
            : 'unknown',
        workers,
        retainedWorkers,
        nativeRequests,
        socketExists: fs.existsSync(socket),
        custody,
        hosts,
        observed,
        children,
        at: Date.now(),
      };
      fs.appendFileSync(
        path.join(this.root, 'cleanup-observations.jsonl'),
        JSON.stringify(result) + '\n',
        { mode: 0o600 }
      );
      if (result.state === 'confirmed_inactive') break;
      await pause(200);
    } while (Date.now() < deadline);
    this.writeJson('cleanup.json', result);
    this.writeJson('owner-observations-final.json', this.ownerEvents());
    if (fs.existsSync(path.join(this.owner, 'observations.jsonl')))
      put(
        path.join(this.root, 'owner-observations-final.jsonl'),
        fs.readFileSync(path.join(this.owner, 'observations.jsonl'))
      );
    this.writeJson('operations-final.json', this.operations());
    return result;
  }
}
function loadApi(cli: string) {
  const require = createRequire(path.join(cli, 'package.json'));
  return {
    ...(require(
      path.join(cli, 'dist/init/machine-adapters')
    ) as typeof import('../dist/init/machine-adapters')),
    ...(require(
      path.join(cli, 'dist/init/system-project-policy')
    ) as typeof import('../dist/init/system-project-policy')),
    ...(require(
      path.join(cli, 'dist/runtime/selection')
    ) as typeof import('../dist/runtime/selection')),
    ...(require(
      path.join(cli, 'dist/runtime/service-image')
    ) as typeof import('../dist/runtime/service-image')),
    ...(require(
      path.join(cli, 'dist/runtime/service-offer')
    ) as typeof import('../dist/runtime/service-offer')),
  };
}
export async function createRenderHarness(
  options: ConstructorParameters<typeof RenderHarness>[0]
): Promise<RenderHarness> {
  return new RenderHarness(options);
}
