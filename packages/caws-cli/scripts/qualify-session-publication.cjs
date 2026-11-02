#!/usr/bin/env node
'use strict';

// Direct native frontend + compiled engine + sole stock SessionEnd logger.
// Operational journals are observations, never substitutes for durable CONSUMED.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const { setTimeout, clearTimeout, setInterval, clearInterval } = require('node:timers');
const { setTimeout: delay } = require('node:timers/promises');
const { performance } = require('node:perf_hooks');
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

// A real argv[0]-recognized ancestor owns the original native Child. Keep this
// ancestor alive until its cache identity and original-child exit are observed.
if (process.argv[2] === '--agent-child') {
  const spec = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
  const child = cp.spawn(spec.native, spec.argv, {
    cwd: spec.cwd,
    env: spec.environment,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = Buffer.alloc(0),
    stderr = Buffer.alloc(0),
    closed = false;
  // This existing ancestor has its own event loop. The parent keeps sampling
  // original process custody without delaying the one-shot hostile action.
  let hostileTimer, hostileResult;
  const finishHostile = (result) => {
    if (!spec.hostileControl || hostileResult) return;
    clearInterval(hostileTimer);
    hostileResult = { ...result, observedAt: Date.now(), nativePid: child.pid };
    try {
      fs.writeFileSync(spec.hostileControl.receipt, JSON.stringify(hostileResult, null, 2) + '\n', {
        flag: 'wx',
        mode: 0o600,
      });
    } catch (error) {
      hostileResult = {
        ...hostileResult,
        actionStatus: hostileResult.status,
        status: 'failed',
        error: 'hostile action receipt failed: ' + String(error),
      };
    }
    if (process.connected) process.send?.({ type: 'hostile-result', result: hostileResult });
  };
  const armHostile = () => {
    if (!spec.hostileControl) return;
    const plan = spec.hostileControl;
    const deadline = performance.now() + 15000;
    const poll = () => {
      try {
        assert(performance.now() < deadline, 'hostile watcher deadline expired');
        const directory = path.join(plan.session, 'hook-invocations');
        if (!fs.existsSync(directory)) return;
        const names = fs
          .readdirSync(directory)
          .filter((name) => new RegExp('^' + child.pid + '-[0-9]+\\.jsonl$').test(name));
        assert(names.length <= 1, 'ambiguous original invocation journal');
        if (!names.length) return;
        const file = path.join(directory, names[0]);
        assert(fs.statSync(file).size <= 1024 * 1024, 'hostile journal exceeds bound');
        const bytes = fs.readFileSync(file, 'utf8');
        const end = bytes.lastIndexOf('\n');
        if (end < 0) return;
        const entries = bytes.slice(0, end).split('\n').filter(Boolean).map(JSON.parse);
        const started = entries[0];
        const completed = entries.filter((row) => row.stage === 'session_seal_consumer_completed');
        if (!completed.length) return;
        assert.equal(completed.length, 1);
        assert.equal(started.stage, 'invocation_started');
        assert.equal(started.dispatch_cwd, spec.cwd);
        assert.equal(started.resolved_session_id, plan.sid);
        const consumer = completed[0];
        for (const row of [started, consumer]) {
          assert.equal(row.schema, 'caws.hook_invocation.v1');
          assert.equal(row.invocation_id + '.jsonl', names[0]);
          assert.equal(row.surface, 'codex');
          assert.equal(row.event, 'session_end');
          assert.equal(row.runtime_digest, plan.runtimeDigest);
          assert.equal(row.input_sha256, hash(spec.input));
        }
        assert.equal(consumer.status, 'published');
        const key = hash(
          JSON.stringify(['caws-project-service-key-v1', spec.cwd, 'session-render'])
        );
        const request = hash(JSON.stringify(['caws.session.original.v1', started.invocation_id]));
        const operationFile = path.join(
          spec.environment.CAWS_HOME,
          'state/render-service/custody/operations/services',
          key,
          request + '.json'
        );
        const operation = JSON.parse(fs.readFileSync(operationFile, 'utf8'));
        assert.equal(operation.body.identity.requestId, request);
        assert.equal(operation.body.identity.projectServiceKey, key);
        assert.equal(operation.body.outcome.execution, 'returned', 'ACK race: A already consumed');
        assert.equal(operation.body.outcome.result.terminalDigest, consumer.terminal_digest);
        assert.equal(fs.statSync(plan.target).ino, plan.beforeInode);
        const actionStartedAt = Date.now();
        fs.renameSync(plan.replacement, plan.target);
        const actionCompletedAt = Date.now();
        const afterInode = fs.statSync(plan.target).ino;
        const sameBytesSha256 = hash(fs.readFileSync(plan.target));
        assert.notEqual(afterInode, plan.beforeInode);
        assert.equal(sameBytesSha256, plan.originalSha256);
        finishHostile({
          status: 'applied',
          type: 'changed-input',
          invocationId: started.invocation_id,
          journal: file,
          consumer,
          beforeAction: { file: operationFile, row: operation },
          beforeInode: plan.beforeInode,
          afterInode,
          originalSha256: plan.originalSha256,
          sameBytesSha256,
          actionStartedAt,
          actionCompletedAt,
        });
      } catch (error) {
        finishHostile({ status: 'failed', error: String(error) });
      }
    };
    hostileTimer = setInterval(poll, 2);
  };
  child.stdout.on('data', (bytes) => {
    stdout = Buffer.concat([stdout, bytes]);
    process.stdout.write(bytes);
  });
  child.stderr.on('data', (bytes) => {
    stderr = Buffer.concat([stderr, bytes]);
    process.stderr.write(bytes);
  });
  child.stdin.on('error', () => {});
  child.once('error', (error) => process.send?.({ type: 'spawn-error', error: String(error) }));
  child.once('spawn', () =>
    process.send?.({
      type: 'native-started',
      pid: child.pid,
      parentPid: process.pid,
      argv0: process.argv0,
    })
  );
  child.once('close', (code, signal) => {
    closed = true;
    finishHostile({ status: 'failed', error: 'native child closed before hostile action' });
    process.send?.({
      type: 'native-terminal',
      pid: child.pid,
      code,
      signal,
      stdoutSha256: hash(stdout),
      stderrSha256: hash(stderr),
    });
  });
  process.on('message', (message) => {
    if (message.type === 'signal-native') {
      const accepted = !closed && child.kill(message.signal);
      process.send?.({ type: 'signal-result', signal: message.signal, accepted, pid: child.pid });
    } else if (message.type === 'release') {
      finishHostile({ status: 'failed', error: 'ancestor released before hostile action' });
      if (!closed) child.kill('SIGTERM');
      const finish = () => process.exit(0);
      if (closed) finish();
      else child.once('close', finish);
    }
  });
  process.on('disconnect', () => {
    finishHostile({ status: 'failed', error: 'parent disconnected before hostile action' });
    if (!closed) child.kill('SIGTERM');
    if (closed) process.exit(1);
    else child.once('close', () => process.exit(1));
  });
  armHostile();
  child.stdin.end(spec.input);
} else {
  const options = new Map();
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i],
      value = process.argv[i + 1];
    assert(
      [
        '--native',
        '--node',
        '--artifacts',
        '--original-count',
        '--scenario',
        '--custody-tools',
        '--process-observer',
      ].includes(key) &&
        value &&
        !options.has(key),
      'usage: qualify-session-publication.cjs --native <absolute> --node <absolute> --artifacts <fresh absolute> [--original-count 258 | --scenario uncertain-project-progress] [--custody-tools <physical emitted root> --process-observer <physical binary>]'
    );
    if (key === '--original-count')
      assert.equal(value, '258', 'capacity qualification requires exactly 258 originals');
    else if (key === '--scenario') assert.equal(value, 'uncertain-project-progress');
    else assert(path.isAbsolute(value));
    options.set(key, value);
  }
  for (const key of ['--native', '--node', '--artifacts'])
    assert(options.has(key), 'missing ' + key);
  const originalCount = options.has('--original-count') ? 258 : 0;
  const uncertainProgress = options.get('--scenario') === 'uncertain-project-progress';
  assert(
    !(originalCount && uncertainProgress),
    'Select the original workload or the bounded progress scenario'
  );
  const requestProofRequired = Boolean(originalCount || uncertainProgress);
  for (const key of ['--custody-tools', '--process-observer'])
    assert.equal(
      options.has(key),
      requestProofRequired,
      'custody dependency requires --original-count or --scenario uncertain-project-progress: ' +
        key
    );
  const custodyTools = requestProofRequired ? options.get('--custody-tools') : null;
  const observer = requestProofRequired ? options.get('--process-observer') : null;
  for (const file of [custodyTools, observer].filter(Boolean))
    assert.equal(fs.realpathSync(file), file, 'capacity dependency must use its physical path');
  const strictCustody = requestProofRequired
    ? {
        ...require(path.join(custodyTools, 'scripts/render-request-topology.js')),
        ...require(path.join(custodyTools, 'scripts/render-request-custody.js')),
      }
    : null;
  const { installMachineRuntime } = require('../dist/init/machine-adapters');
  const { validateSystemPolicy } = require('../dist/init/system-project-policy');
  assert.equal(process.platform, 'darwin', 'native original ancestry profile is Darwin-specific');
  const native = fs.realpathSync(options.get('--native'));
  const node = fs.realpathSync(options.get('--node'));
  const root = options.get('--artifacts');
  assert.equal(path.normalize(root), root);
  fs.mkdirSync(root, { mode: 0o700 }); // Never reuse or remove a prior fixture.
  assert.equal(fs.realpathSync(root), root, 'artifacts must use the physical absolute path');
  const cli = path.resolve(__dirname, '..');
  const engine = path.join(cli, 'dist/runtime/engine-entry.js');
  const templates = path.join(cli, 'templates/hook-packs');
  const nativeSource = path.resolve(cli, '../caws-native');
  const put = (file, value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      file,
      Buffer.isBuffer(value) || typeof value === 'string'
        ? value
        : JSON.stringify(value, null, 2) + '\n',
      { flag: 'wx', mode: 0o600 }
    );
  };
  const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
  const rows = (file) => {
    if (!fs.existsSync(file)) return [];
    const bytes = fs.readFileSync(file, 'utf8');
    const end = bytes.lastIndexOf('\n');
    return end < 0
      ? []
      : bytes
          .slice(0, end)
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line));
  };
  const ownerRows = (file) =>
    rows(file).map((row) => {
      assert.equal(row.schema, 'caws.render.owner.observation.v1');
      assert(row.observation && typeof row.observation === 'object');
      return row.observation;
    });
  const active = new Map(),
    trackedPids = new Set(),
    snapshots = [];
  let capacityProgress = originalCount
    ? { requestedOriginals: originalCount, completedOriginals: 0, hostPid: null, completed: [] }
    : null;
  const limits = [
    'Direct native invoke, not installed harness or vendor callback qualification',
    'SessionEnd only; no Render discovery, SQL publication, calendar or subagent parity',
    'Fresh PID refresh and empty-directory reap execution; stale candidate reaping is not qualified',
    'Diagnostic observations alone do not establish durable acceptance or heavy release',
    'One hostile synchronization attempt per case; an ACK race is an unexercised failure, never a pass',
    'Capacity cleanup covers witnessed births and confirmed request groups; it does not exclude arbitrary detached or reparented descendants',
  ];
  function pin(file) {
    const metadata = fs.lstatSync(file);
    assert(metadata.isFile() && !metadata.isSymbolicLink(), 'regular pinned input: ' + file);
    return {
      path: file,
      sizeBytes: metadata.size,
      sha256: hash(fs.readFileSync(file)),
      mode: metadata.mode & 0o7777,
    };
  }
  function tree(directory) {
    const output = [];
    function visit(current) {
      for (const name of fs.readdirSync(current).sort()) {
        const file = path.join(current, name),
          metadata = fs.lstatSync(file);
        assert(!metadata.isSymbolicLink(), 'source tree symlink: ' + file);
        if (metadata.isDirectory()) visit(file);
        else {
          assert(metadata.isFile());
          output.push(pin(file));
        }
      }
    }
    visit(directory);
    return output;
  }
  const pinInputs = () =>
    [
      native,
      node,
      '/usr/bin/git',
      __filename,
      path.join(cli, 'package.json'),
      path.join(nativeSource, 'Cargo.toml'),
      path.join(nativeSource, 'Cargo.lock'),
      path.join(nativeSource, 'build.rs'),
    ]
      .map(pin)
      .concat(
        ...(requestProofRequired
          ? [
              observer,
              path.join(cli, 'scripts/render-request-custody.ts'),
              path.join(cli, 'scripts/render-request-topology.ts'),
              path.join(custodyTools, 'scripts/render-request-custody.js'),
              path.join(custodyTools, 'scripts/render-request-topology.js'),
              path.join(custodyTools, 'src/runtime/json-custody.js'),
            ].map(pin)
          : []),
        ...[
          'src/runtime',
          'src/transcripts',
          'dist/runtime',
          'dist/transcripts',
          'dist/init',
          'templates/hook-packs',
        ].map((name) => tree(path.join(cli, name))),
        tree(path.join(nativeSource, 'src'))
      );
  const beforePins = pinInputs();
  put(path.join(root, 'inputs.json'), {
    native,
    node,
    engine,
    beforePins,
    limits,
    originalCount,
    scenario: uncertainProgress ? 'uncertain-project-progress' : null,
    custodyTools,
    observer,
  });
  async function bounded(promise, milliseconds, message) {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(message)), milliseconds);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  function processes() {
    const result = cp.spawnSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,stat=,command='], {
      encoding: 'utf8',
      timeout: 3000,
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout
      .split('\n')
      .filter(Boolean)
      .map((raw) => {
        const match = raw.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
        assert(match, raw);
        return {
          pid: Number(match[1]),
          ppid: Number(match[2]),
          pgid: Number(match[3]),
          stat: match[4],
          command: match[5],
        };
      });
  }
  function snapshot(label) {
    const all = processes();
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of all)
        if (trackedPids.has(row.ppid) && !trackedPids.has(row.pid)) {
          trackedPids.add(row.pid);
          changed = true;
        }
    }
    const selected = all.filter((row) => trackedPids.has(row.pid));
    snapshots.push({ label, at: Date.now(), rows: selected });
    return selected;
  }
  function observeInstance(pid) {
    const result = cp.spawnSync(observer, ['--observe', String(pid)], {
      env: { PATH: '/usr/bin:/bin' },
      encoding: 'utf8',
      timeout: 1000,
      maxBuffer: 16384,
    });
    assert.equal(result.status, 0, 'native birth observation unavailable: ' + result.stderr);
    assert.equal(result.stderr, '', 'native birth observation diagnostic');
    const observation = JSON.parse(result.stdout);
    assert(
      ['observed', 'absent'].includes(observation.state),
      'native birth observation uncertain'
    );
    if (observation.state === 'observed') {
      const instance = observation.process;
      assert.equal(instance.pid, pid);
      for (const key of ['pid', 'parent', 'group'])
        assert(Number.isSafeInteger(instance[key]) && instance[key] > 0, 'native process ' + key);
      for (const key of ['startSeconds', 'startMicros'])
        assert(
          typeof instance[key] === 'string' && /^[0-9]+$/.test(instance[key]),
          'native process birth ' + key
        );
      assert.equal(typeof instance.zombie, 'boolean');
    }
    return observation;
  }
  const topologyRows = () =>
    processes().map((row) => ({
      pid: row.pid,
      parent: row.ppid,
      group: row.pgid,
      state: row.stat,
      command: row.command,
    }));
  function launch(name, executable, argv, cwd, environment, input, extra = {}) {
    const directory = path.join(root, name);
    fs.mkdirSync(directory, { mode: 0o700 });
    const child = cp.spawn(executable, argv, {
      cwd,
      env: environment,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...extra,
    });
    trackedPids.add(child.pid);
    let stdout = Buffer.alloc(0),
      stderr = Buffer.alloc(0);
    child.stdout.on('data', (bytes) => {
      stdout = Buffer.concat([stdout, bytes]);
    });
    child.stderr.on('data', (bytes) => {
      stderr = Buffer.concat([stderr, bytes]);
    });
    child.stdin.on('error', () => {});
    const started = Date.now();
    put(path.join(directory, 'started.json'), {
      executable,
      argv,
      cwd,
      environment,
      pid: child.pid,
      started,
      inputSha256: hash(input ?? ''),
      argv0: extra.argv0 ?? executable,
    });
    const terminal = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => {
        try {
          put(path.join(directory, 'stdout.bin'), stdout);
          put(path.join(directory, 'stderr.bin'), stderr);
          const result = {
            pid: child.pid,
            code,
            signal,
            elapsedMs: Date.now() - started,
            stdoutSha256: hash(stdout),
            stderrSha256: hash(stderr),
          };
          put(path.join(directory, 'terminal.json'), result);
          resolve({ ...result, stdout, stderr });
        } catch (error) {
          reject(error);
        } finally {
          active.delete(child);
        }
      });
    });
    active.set(child, terminal);
    child.stdin.end(input ?? '');
    return { child, terminal, directory, output: () => ({ stdout, stderr }) };
  }
  async function waitFor(check, milliseconds, message) {
    const end = Date.now() + milliseconds;
    do {
      const value = check();
      if (value) return value;
      await delay(2);
    } while (Date.now() < end);
    throw new Error(message);
  }
  function journal(session, excluded = []) {
    const directory = path.join(session, 'hook-invocations');
    if (!fs.existsSync(directory)) return null;
    const files = fs
      .readdirSync(directory)
      .filter((name) => name.endsWith('.jsonl') && !excluded.includes(name));
    assert(files.length <= 1, 'one original invocation per case');
    return files.length
      ? { file: path.join(directory, files[0]), rows: rows(path.join(directory, files[0])) }
      : null;
  }
  const fields = [
    'input_tokens',
    'output_tokens',
    'cache_read_input_tokens',
    'cache_creation_input_tokens',
    'cached_input_tokens',
    'reasoning_output_tokens',
    'total_tokens',
  ];
  const huge = '9'.repeat(4300),
    expectedCount = '1' + '0'.repeat(4299) + '1';
  const usage = (value) =>
    '{' + fields.map((key) => JSON.stringify(key) + ':' + value).join(',') + '}';
  function createCase(name, surface, missing, large, shared = null) {
    const directory = path.join(root, name);
    fs.mkdirSync(directory, { mode: 0o700 });
    const environment = {
      HOME: shared ? shared.environment.HOME : path.join(directory, 'user'),
      CAWS_HOME: shared ? shared.environment.CAWS_HOME : path.join(directory, 'machine'),
      PATH: path.dirname(node) + ':/usr/bin:/bin',
      TMPDIR: directory,
      LANG: 'C',
      LC_ALL: 'C',
      TZ: 'UTC',
      CAWS_TRAP_KILL: '0',
    };
    if (!shared) fs.mkdirSync(environment.HOME, { mode: 0o700 });
    const installed = shared
      ? shared.installed
      : installMachineRuntime({
          home: environment.CAWS_HOME,
          templatesRoot: templates,
        });
    const defaults = read(
      path.join(environment.CAWS_HOME, 'lib/runtimes', installed.digest, 'system-policy.json')
    ).events;
    const settings = path.join(environment.CAWS_HOME, 'surfaces', surface, 'settings.json');
    if (shared) assert.deepEqual(read(settings), { version: 1, enabled: true });
    else put(settings, { version: 1, enabled: true });
    const policy = {
      disabled: {
        session_end: [...new Set(defaults.session_end.map((entry) => entry.split(' ')[0]))].filter(
          (entry) => entry !== 'session-log.sh'
        ),
      },
      extensions: {},
      handlers: {},
      libraries: {},
    };
    const project = path.join(directory, 'project');
    fs.mkdirSync(project, { mode: 0o700 });
    const git = (args) => {
      const result = cp.spawnSync('/usr/bin/git', args, {
        cwd: project,
        env: environment,
        encoding: 'utf8',
        timeout: 10000,
      });
      put(path.join(directory, 'git-' + args[0] + '.json'), {
        argv: ['/usr/bin/git', ...args],
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
      });
      assert.equal(result.status, 0, result.stderr);
    };
    git(['init', '-q']);
    put(path.join(project, 'owned.txt'), 'Session publication qualification\n');
    git(['add', '--', 'owned.txt']);
    git([
      '-c',
      'user.name=CAWS qualification',
      '-c',
      'user.email=qualification@example.invalid',
      'commit',
      '-qm',
      'Private qualification fixture',
    ]);
    put(path.join(project, '.caws/policy.yaml'), 'version: 1\n');
    fs.mkdirSync(path.join(project, '.caws/specs'));
    validateSystemPolicy(project, policy, { files: [...installed.files], defaults });
    put(path.join(environment.CAWS_HOME, 'state/projects', hash(project) + '.json'), {
      version: 1,
      root: project,
      surfaces: { [surface]: policy },
    });
    const sid = name,
      session = path.join(project, '.caws/sessions', sid);
    fs.mkdirSync(session, { recursive: true, mode: 0o700 });
    const metadata =
      '{"unrelated":{"exact":9007199254740993,"text":"retained"},"models":["historical"],"padding":' +
      JSON.stringify(large ? 'x'.repeat(512 * 1024) : '') +
      '}';
    if (!missing) put(path.join(session, '.meta.json'), metadata);
    const turns = [
      [
        'turn-002.json',
        '{"schema_version":2,"models":["later","first"],"usage":' + usage('2') + '}',
      ],
      [
        'turn-001.json',
        '{"schema_version":2,"models":["first","separate"],"usage":' + usage(huge) + '}',
      ],
    ];
    // Keep every input inside the ordinary preparer's 1MiB per-file and
    // 8MiB aggregate limits, while making final generation revalidation real.
    if (large)
      for (let index = 3; index <= 8; index++)
        turns.push([
          'turn-' + String(index).padStart(3, '0') + '.json',
          JSON.stringify({ schema_version: 2, retained: 'r'.repeat(900 * 1024) }),
        ]);
    if (!missing) for (const [file, bytes] of turns) put(path.join(session, file), bytes);
    const owner = shared
      ? shared.owner
      : {
          schema: 'caws.render.owner.config.v1',
          home: environment.CAWS_HOME,
          clientRoot: path.dirname(engine),
          templateRoot: path.join(templates, 'runtime/service-image'),
          clientShellSource: path.join(templates, 'shared/lib/session-render-service-client.sh'),
          nativeExecutable: native,
          limits: {
            maxConnections: 8,
            maxProjects: 4,
            maxBackends: 1,
            maxQueuePerProject: 4,
            maxFrameBytes: 2097152,
            maxRetainedRecords: large ? 2 : 1,
            firstFrameMs: 3000,
            requestMs: 20000,
            startupMs: 3000,
            idleMs: 300000,
            backendIdleSeconds: 30,
            cacheMegabytes: 1,
            worker: {
              startupMs: 3000,
              connectMs: 3000,
              writeMs: 3000,
              renderMs: 20000,
              readMs: 3000,
              cleanupMs: 3000,
            },
          },
        };
    put(path.join(directory, 'owner-input.json'), owner);
    put(path.join(directory, 'fixture.json'), {
      name,
      surface,
      sid,
      session,
      project,
      environment,
      runtimeDigest: installed.digest,
      policy,
      metadataSha256: missing ? null : hash(metadata),
      turns: turns.map(([name, bytes]) => ({ name, sha256: hash(bytes) })),
      missing,
      large,
    });
    return {
      name,
      surface,
      directory,
      environment,
      installed,
      project,
      sid,
      session,
      owner,
      turns,
      missing,
      large,
    };
  }
  async function provision(fixture) {
    const initialized = launch(
      fixture.name + '-init',
      native,
      ['renderer-service-init'],
      fixture.project,
      fixture.environment,
      JSON.stringify(fixture.owner)
    );
    const result = await bounded(initialized.terminal, 8000, 'owner initialization did not settle');
    assert.equal(result.code, 0, result.stderr.toString());
    const config = path.join(fixture.environment.CAWS_HOME, 'state/render-service/config.json');
    assert.deepEqual(read(config), fixture.owner);
    const host = launch(
      fixture.name + '-host',
      native,
      ['renderer-host', '--config', config],
      fixture.project,
      fixture.environment
    );
    const observations = path.join(
      fixture.environment.CAWS_HOME,
      'state/render-service/observations.jsonl'
    );
    await waitFor(
      () =>
        ownerRows(observations).some(
          (row) => row.event === 'host_started' && row.hostPid === host.child.pid
        ),
      5000,
      'original renderer-host did not start'
    );
    assert.equal(host.child.exitCode, null);
    return { host, observations };
  }
  async function invoke(fixture) {
    const reason = 'qualification authored reason';
    const input =
      JSON.stringify({
        cwd: fixture.project,
        session_id: fixture.sid,
        hook_event_name: 'SessionEnd',
        reason,
      }) + '\n';
    const argv = [
      'invoke',
      '--engine',
      engine,
      '--node',
      node,
      '--surface',
      fixture.surface,
      '--event',
      'session_end',
      '--runtime-digest',
      fixture.installed.digest,
      '--timeout-ms',
      '20000',
      '--configuration',
      'system',
    ];
    const temporary = fixture.capacityObservation
      ? path.join(fixture.directory, 'request-temporary')
      : fixture.environment.TMPDIR;
    if (fixture.capacityObservation) fs.mkdirSync(temporary, { mode: 0o700 });
    const environment = {
      ...fixture.environment,
      TMPDIR: temporary,
      [fixture.surface === 'codex' ? 'CODEX_THREAD_ID' : 'CLAUDE_SESSION_ID']: fixture.sid,
    };
    const spec = path.join(fixture.directory, 'agent-input.json');
    put(spec, {
      native,
      argv,
      cwd: fixture.project,
      environment,
      input,
      hostileControl: fixture.hostileControl,
    });
    const agent = launch(
      fixture.name + '-agent',
      node,
      [__filename, '--agent-child', spec],
      fixture.project,
      environment,
      '',
      {
        argv0: fixture.surface === 'codex' ? 'codex' : 'claude',
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      }
    );
    let nativePid, signalResult, terminal, monitor, hostileResult;
    const coverage = fixture.capacityObservation
      ? { expected: null, originalFrontend: null, confirmedChains: [], witnesses: [] }
      : null;
    const observationErrors = [];
    const collector = coverage
      ? new strictCustody.RequestCustodyCollector(
          temporary,
          path.join(fixture.directory, 'native-custody')
        )
      : null;
    let samples = 0;
    const sample = () => {
      if (!coverage?.expected) return;
      try {
        assert(++samples <= 512, 'request topology observation bound exhausted');
        const inventory = topologyRows();
        const chain = strictCustody.selectRequestChain(inventory, coverage.expected);
        const before = chain?.map((row) => observeInstance(row.pid)) ?? [];
        const after = chain?.map((row) => observeInstance(row.pid)) ?? [];
        const confirmed = chain
          ? strictCustody.confirmRequestChain(chain, coverage.originalFrontend, before, after)
          : null;
        if (confirmed) {
          coverage.confirmedChains.push(confirmed);
          for (const instance of confirmed) {
            strictCustody.retainRequestInstance(coverage, instance);
            trackedPids.add(instance.pid);
          }
        }
        fs.appendFileSync(
          path.join(fixture.directory, 'request-topology.jsonl'),
          JSON.stringify({ at: Date.now(), inventory, chain, before, after, confirmed }) + '\n',
          { mode: 0o600 }
        );
      } catch (error) {
        observationErrors.push(String(error));
        clearInterval(monitor);
      }
    };
    const nativeTerminal = new Promise((resolve, reject) => {
      agent.child.on('message', (message) => {
        if (message.type === 'native-started') {
          nativePid = message.pid;
          trackedPids.add(nativePid);
          put(path.join(fixture.directory, 'native-started.json'), message);
          if (coverage) {
            try {
              coverage.expected = {
                platform: process.platform,
                frontendPid: nativePid,
                frontendCommand: [native, ...argv].join(' '),
                native,
                node,
                engine,
              };
              coverage.originalFrontend = observeInstance(nativePid);
              assert.equal(
                coverage.originalFrontend.state,
                'observed',
                'original frontend birth unavailable'
              );
              strictCustody.retainRequestInstance(coverage, coverage.originalFrontend.process);
              sample();
              if (!observationErrors.length) monitor = setInterval(sample, 50);
            } catch (error) {
              observationErrors.push(String(error));
            }
          }
        }
        if (message.type === 'signal-result') {
          signalResult = message;
          put(path.join(fixture.directory, 'signal-result.json'), message);
        }
        if (message.type === 'hostile-result') hostileResult = message.result;
        if (message.type === 'native-terminal') {
          clearInterval(monitor);
          terminal = message;
          put(path.join(fixture.directory, 'native-terminal.json'), message);
          resolve(message);
        }
        if (message.type === 'spawn-error') {
          clearInterval(monitor);
          reject(new Error(message.error));
        }
      });
      agent.terminal.then(() => {
        clearInterval(monitor);
        if (!terminal) reject(new Error('recognized ancestor exited before native terminal'));
      }, reject);
    });
    // Defer propagation to the actual awaited boundary, including failures
    // during the recognized-ancestor startup observation.
    nativeTerminal.catch(() => {});
    await waitFor(() => nativePid, 3000, 'recognized ancestor did not launch native child');
    snapshot(fixture.name + '-native-live');
    const ps = processes();
    const ancestor = ps.find((row) => row.pid === agent.child.pid),
      frontend = ps.find((row) => row.pid === nativePid);
    assert(
      ancestor && frontend && frontend.ppid === ancestor.pid,
      'observed original ancestor/native relationship'
    );
    const comm = cp.spawnSync('/bin/ps', ['-p', String(agent.child.pid), '-o', 'comm='], {
      encoding: 'utf8',
      timeout: 2000,
    });
    assert.equal(comm.status, 0);
    assert.equal(comm.stdout.trim(), fixture.surface === 'codex' ? 'codex' : 'claude');
    put(path.join(fixture.directory, 'ancestry.json'), { ancestor, frontend, comm: comm.stdout });
    return {
      agent,
      nativeTerminal,
      nativePid,
      reason,
      signalResult: () => signalResult,
      terminal: () => terminal,
      hostileResult: () => hostileResult,
      coverage,
      collector,
      observationErrors,
    };
  }
  function checkPrefix(fixture, invocation, record, fresh = true) {
    const prefix = record.rows.filter((row) => row.stage === 'session_end_prefix_completed');
    assert.equal(prefix.length, 1, 'actual selected native prefix completion required');
    assert.equal(prefix[0].status, 'completed');
    assert.equal(prefix[0].prefix_complete, true);
    assert.equal(prefix[0].envelope_published, true);
    assert.equal(prefix[0].pointer_published, true);
    assert.equal(prefix[0].agent_pid, 'refreshed');
    if (fresh) assert.equal(prefix[0].reap, 'completed');
    else assert(['completed', 'rate_limited'].includes(prefix[0].reap));
    const envelope = read(path.join(fixture.session, '.session-envelope.json'));
    assert.equal(envelope.session_id, fixture.sid);
    assert.equal(envelope.repo_root, fixture.project);
    assert.equal(envelope.hook_event, 'SessionEnd');
    assert.equal(envelope.platform, fixture.surface);
    if (fresh) assert.equal(envelope.created_at, envelope.last_seen_at);
    else assert(Date.parse(envelope.created_at) <= Date.parse(envelope.last_seen_at));
    assert.match(envelope.last_seen_at, /^\d{4}-\d\d-/);
    const pointer = read(path.join(fixture.project, '.caws/sessions/.caller-session.json'));
    assert.equal(pointer.session_id, fixture.sid);
    assert.equal(pointer.repo_root, fixture.project);
    assert.equal(pointer.last_seen_at, envelope.last_seen_at);
    const pidFile = path.join(
      fixture.project,
      '.caws/sessions',
      'agent-pid-' + invocation.agent.child.pid + '.json'
    );
    const pid = read(pidFile);
    assert.equal(pid.agent_pid, invocation.agent.child.pid);
    assert.equal(pid.session_id, fixture.sid);
    assert.equal(pid.surface, fixture.surface);
    assert.equal(pid.repo_root, fixture.project);
    assert.match(pid.started_at, /^\d+$/);
    assert.equal(pid.created_at, pid.last_seen_at);
    assert(
      fs.statSync(path.join(fixture.project, '.caws/sessions/.agent-pid-reap-marker')).isFile()
    );
    put(path.join(fixture.directory, 'prefix-observed.json'), {
      prefix: prefix[0],
      envelope,
      pointer,
      pid,
      pidFile,
    });
  }
  function operation(fixture, id) {
    const key = hash(
      JSON.stringify(['caws-project-service-key-v1', fixture.project, 'session-render'])
    );
    const request = hash(JSON.stringify(['caws.session.original.v1', id]));
    const file = path.join(
      fixture.environment.CAWS_HOME,
      'state/render-service/custody/operations/services',
      key,
      request + '.json'
    );
    return { file, row: fs.existsSync(file) ? read(file) : null };
  }
  function checkConsumer(fixture, record) {
    assert.equal(record.rows[0].selected_handlers.length, 1);
    assert.equal(record.rows[0].selected_handlers[0].name, 'session-log.sh');
    assert.equal(record.rows[0].selected_handlers[0].kind, 'stock');
    const completed = record.rows.filter((row) => row.stage === 'session_seal_consumer_completed');
    assert.equal(completed.length, 1, 'actual ordinary semantic consumer required');
    const consumer = completed[0];
    const prefixIndex = record.rows.findIndex(
      (row) => row.stage === 'session_end_prefix_completed'
    );
    assert(prefixIndex >= 0 && prefixIndex < record.rows.indexOf(consumer));
    if (fixture.missing) {
      assert.equal(consumer.status, 'not_published');
      assert.equal(consumer.missing_metadata, true);
      assert(!fs.existsSync(path.join(fixture.session, '.meta.json')));
      assert(!fs.existsSync(path.join(fixture.session, '.session-publication.json')));
    } else {
      assert.equal(consumer.status, 'published');
      assert.equal(consumer.summary_mode, 'recomputed');
      const bytes = fs.readFileSync(path.join(fixture.session, '.meta.json'));
      const text = bytes.toString('utf8'),
        parsed = JSON.parse(text);
      assert.equal(hash(bytes), consumer.metadata_sha256);
      assert.equal(consumer.unrelated_metadata_preserved, true);
      assert.deepEqual(consumer.models, ['first', 'separate', 'later']);
      assert.deepEqual(parsed.models, consumer.models);
      assert.equal(consumer.reason, 'qualification authored reason');
      assert.equal(parsed.ended.reason, consumer.reason);
      assert.equal(parsed.ended.ts, consumer.ended_at);
      assert.match(consumer.ended_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
      assert(text.includes('9007199254740993'), 'unrelated integer token must remain exact');
      assert.equal(parsed.unrelated.text, 'retained');
      assert.equal(parsed.padding, fixture.large ? 'x'.repeat(512 * 1024) : '');
      for (const field of fields) {
        const value = consumer.counts.find((row) => row.field === field)?.value;
        assert.equal(value?.lexeme, expectedCount, 'ordinary consumer exact ' + field);
        assert.equal(text.match(new RegExp('"' + field + '"\\s*:\\s*(\\d+)'))?.[1], expectedCount);
      }
      const markerBytes = fs.readFileSync(path.join(fixture.session, '.session-publication.json'));
      const marker = JSON.parse(markerBytes.toString());
      assert.equal(marker.canonicalRoot, fixture.project);
      assert.equal(marker.sessionId, fixture.sid);
      assert.equal(marker.terminalDigest, consumer.terminal_digest);
      assert.equal(marker.correlation.id, record.rows[0].invocation_id);
      assert.equal(marker.correlation.runtimeDigest, fixture.installed.digest);
      assert.equal(
        marker.terminalDigest,
        hash(JSON.stringify([marker.correlation, 'published', marker.artifacts]))
      );
      for (const descriptor of marker.artifacts) {
        const artifact = fs.readFileSync(path.join(fixture.session, descriptor.name));
        assert.equal(artifact.length, descriptor.byteLength);
        assert.equal(hash(artifact), descriptor.sha256);
      }
      for (const [file, expected] of fixture.turns)
        assert.equal(fs.readFileSync(path.join(fixture.session, file), 'utf8'), expected);
      put(path.join(fixture.directory, 'marker.bin'), markerBytes);
      put(path.join(fixture.directory, 'final-metadata.bin'), bytes);
    }
    return consumer;
  }
  async function writerProbe(fixture, expected) {
    const receipts = path.join(
      fixture.environment.CAWS_HOME,
      'state/render-writer-receipts',
      hash(JSON.stringify(['caws-render-writer-project-v1', fixture.project]))
    );
    const priorReceipts = new Set(fs.existsSync(receipts) ? fs.readdirSync(receipts) : []);
    const probe = launch(
      fixture.name + '-writer-probe',
      native,
      [
        'render-writer',
        '--home',
        fixture.environment.CAWS_HOME,
        '--canonical-project',
        fixture.project,
        '--output-directory',
        fixture.session,
        '--session-id',
        fixture.sid,
        '--source-generation',
        fixture.installed.digest,
        '--timeout-ms',
        '500',
        '--',
        '/usr/bin/true',
      ],
      fixture.project,
      fixture.environment
    );
    const result = await bounded(probe.terminal, 5000, 'writer custody probe did not settle');
    if (expected === 'released') {
      assert.equal(result.code, 0, result.stderr.toString());
      assert.equal(result.signal, null);
      const values = fs
        .readdirSync(receipts)
        .filter((file) => !priorReceipts.has(file))
        .map((file) => read(path.join(receipts, file)));
      assert(
        values.some(
          (row) =>
            row.state === 'reaped_and_output_eof' &&
            row.exitCode === 0 &&
            row.timedOut === false &&
            row.identity.schema === 'caws.render.writer.receipt.v1' &&
            row.identity.canonicalProject === fixture.project &&
            row.identity.outputDirectory === fixture.session &&
            row.identity.sessionId === fixture.sid &&
            row.identity.sourceGeneration === fixture.installed.digest &&
            row.identity.program === '/usr/bin/true'
        ),
        'current writer must release its actual Child and both output pipes'
      );
      put(path.join(fixture.directory, 'writer-receipts.json'), values);
    } else {
      assert.equal(result.code, 75);
      assert.equal(
        result.stderr.toString(),
        'CAWS render writer unavailable: service journal unavailable: another machine owner retains custody\n'
      );
      assert(
        !fs.existsSync(path.join(fixture.environment.CAWS_HOME, 'state/render-writer-receipts'))
      );
    }
    return {
      code: result.code,
      stdoutSha256: result.stdoutSha256,
      stderrSha256: result.stderrSha256,
    };
  }
  async function release(invocation) {
    if (invocation.agent.child.connected) invocation.agent.child.send({ type: 'release' });
    const result = await bounded(
      invocation.agent.terminal,
      5000,
      'original recognized ancestor did not reap/exit'
    );
    assert.equal(result.code, 0, 'recognized ancestor failed during release');
    assert.equal(result.signal, null);
    return result;
  }
  async function stopHost(host) {
    assert.equal(host.child.exitCode, null, 'owner exited before intentional shutdown');
    assert.equal(host.child.signalCode, null);
    assert(host.child.kill('SIGTERM'), 'original owner did not accept shutdown');
    const result = await bounded(host.terminal, 5000, 'original renderer-host did not terminate');
    assert(
      (result.code === 0 && result.signal === null) ||
        (result.code === null && result.signal === 'SIGTERM'),
      'unexpected owner terminal: ' + JSON.stringify(result)
    );
    return result;
  }
  async function followup(fixture, admitted) {
    const next = {
      ...fixture,
      name: fixture.name + '-next',
      sid: admitted ? fixture.sid + '-next' : fixture.sid,
      directory: path.join(fixture.directory, 'followup'),
      missing: true,
      large: false,
      turns: [],
    };
    next.session = path.join(fixture.project, '.caws/sessions', next.sid);
    fs.mkdirSync(next.directory, { mode: 0o700 });
    const priorJournals = admitted
      ? []
      : fs.readdirSync(path.join(next.session, 'hook-invocations'));
    const retainedBefore = admitted
      ? null
      : ['.meta.json', '.session-publication.json'].map((name) => ({
          name,
          sha256: hash(fs.readFileSync(path.join(next.session, name))),
        }));
    const originalCreated = admitted
      ? null
      : read(path.join(next.session, '.session-envelope.json')).created_at;
    const invocation = await invoke(next);
    const terminal = await bounded(
      invocation.nativeTerminal,
      25000,
      'follow-up original did not settle'
    );
    const record = journal(next.session, priorJournals);
    assert(record, 'follow-up did not execute ordinary engine');
    checkPrefix(next, invocation, record, false);
    const durable = operation(next, record.rows[0].invocation_id);
    put(path.join(next.directory, 'operation-observed.json'), durable);
    if (admitted) {
      assert.equal(terminal.code, 0, invocation.agent.output().stderr.toString());
      const consumer = checkConsumer(next, record);
      assert.equal(durable.row?.body.outcome.execution, 'consumed');
      assert.equal(durable.row.body.outcome.terminalDigest, consumer.terminal_digest);
      assert.equal(durable.row.body.verifiedRequestBase64, '');
    } else {
      assert.notEqual(terminal.code, 0, 'retained original did not fence later frontend');
      assert(!record.rows.some((row) => row.stage === 'session_seal_consumer_completed'));
      assert.equal(durable.row, null, 'uncertain owner reserved another original');
      assert.deepEqual(
        ['.meta.json', '.session-publication.json'].map((name) => ({
          name,
          sha256: hash(fs.readFileSync(path.join(next.session, name))),
        })),
        retainedBefore,
        'same-session retry changed the retained publication'
      );
      assert.equal(
        read(path.join(next.session, '.session-envelope.json')).created_at,
        originalCreated
      );
      assert(
        ownerRows(
          path.join(next.environment.CAWS_HOME, 'state/render-service/observations.jsonl')
        ).some(
          (row) =>
            row.event === 'admission_denied' &&
            row.reason === 'unknown_fence' &&
            row.invocationId === record.rows[0].invocation_id
        ),
        'same-session retry must reach the unknown-effect fence with spare live capacity'
      );
    }
    await release(invocation);
    return { terminal, journal: record.file, operation: durable.file, admitted };
  }
  async function runCase(name, surface, missing, hostile = null) {
    const fixture = createCase(name, surface, missing, Boolean(hostile));
    const { host, observations } = await provision(fixture);
    const invocation = await invoke({ ...fixture, surface });
    let action;
    if (hostile) {
      const observed = await waitFor(
        () => {
          const record = journal(fixture.session);
          return record?.rows.some((row) => row.stage === 'session_seal_consumer_completed')
            ? record
            : null;
        },
        15000,
        'hostile control never reached actual ordinary consumer'
      );
      const pending = operation(fixture, observed.rows[0].invocation_id);
      assert.equal(
        pending.row?.body.outcome.execution,
        'returned',
        'ACK race: no unconsumed terminal at synchronization'
      );
      put(path.join(fixture.directory, 'pre-action-operation.json'), pending);
      action = {
        type: hostile,
        at: Date.now(),
        journal: observed.file,
        observedRows: observed.rows.length,
      };
      if (hostile === 'changed-input') {
        const target = path.join(fixture.session, fixture.turns[0][0]),
          temporary = path.join(fixture.directory, 'replacement-turn.json');
        const before = fs.statSync(target);
        put(temporary, fs.readFileSync(target));
        fs.renameSync(temporary, target);
        const after = fs.statSync(target);
        assert.notEqual(before.ino, after.ino);
        action.replacement = {
          beforeInode: before.ino,
          afterInode: after.ino,
          sameBytesSha256: hash(fs.readFileSync(target)),
        };
      } else {
        invocation.agent.child.send({ type: 'signal-native', signal: 'SIGKILL' });
        const signal = await waitFor(
          invocation.signalResult,
          2000,
          'original Child signal response missing'
        );
        assert.equal(
          signal.accepted,
          true,
          'ACK race: native child already settled; hostile case not exercised'
        );
        action.signal = signal;
      }
      put(path.join(fixture.directory, 'hostile-action.json'), action);
    }
    const terminal = await bounded(
      invocation.nativeTerminal,
      25000,
      'native SessionEnd did not settle'
    );
    const record = journal(fixture.session);
    assert(record, 'no ordinary invocation journal; unsupported branch retained');
    checkPrefix({ ...fixture, surface }, invocation, record);
    const consumer = checkConsumer(fixture, record);
    const durable = operation(fixture, record.rows[0].invocation_id);
    put(path.join(fixture.directory, 'operation-observed.json'), durable);
    if (hostile) {
      await waitFor(
        () =>
          ownerRows(observations).some(
            (row) =>
              row.event === 'actor_stage' &&
              row.stage === 'session_retained' &&
              row.invocationId === record.rows[0].invocation_id
          ),
        5000,
        'ACK race or retention failure: actual original was not retained'
      );
      const current = operation(fixture, record.rows[0].invocation_id);
      assert.equal(
        current.row.body.outcome.execution,
        'returned',
        'hostile window missed: no durable unconsumed publication'
      );
      assert.equal(current.row.body.outcome.result.terminalDigest, consumer.terminal_digest);
      assert(current.row.body.verifiedRequestBase64.length > 0);
      if (hostile === 'lost-ack') assert.equal(terminal.signal, 'SIGKILL');
      else assert.notEqual(terminal.code, 0, 'changed input was acknowledged as successful');
      assert(
        !ownerRows(observations).some(
          (row) =>
            row.stage === 'session_consumed_durable' &&
            row.invocationId === record.rows[0].invocation_id
        )
      );
      await writerProbe(fixture, 'retained');
    } else {
      assert.equal(terminal.code, 0, invocation.agent.output().stderr.toString());
      assert.equal(invocation.agent.output().stdout.length, 0, 'SessionEnd must be silent');
      assert.equal(invocation.agent.output().stderr.length, 0, 'SessionEnd must be silent');
      assert.equal(durable.row.body.outcome.execution, 'consumed');
      assert.equal(durable.row.body.outcome.terminalDigest, consumer.terminal_digest);
      assert.equal(durable.row.body.verifiedRequestBase64, '');
      await waitFor(
        () =>
          ownerRows(observations).some(
            (row) =>
              row.stage === 'session_heavy_released' &&
              row.invocationId === record.rows[0].invocation_id
          ),
        3000,
        'actual heavy release missing'
      );
      assert.equal(host.child.exitCode, null, 'writer release must precede host process exit');
      await writerProbe(fixture, 'released');
    }
    assert.equal(host.child.exitCode, null, 'shared-capacity probe requires same live owner');
    const subsequent = await followup(fixture, !hostile);
    assert.equal(
      operation(fixture, record.rows[0].invocation_id).row.body.outcome.execution,
      hostile ? 'returned' : 'consumed'
    );
    put(path.join(fixture.directory, 'owner-observations.json'), ownerRows(observations));
    snapshot(name + '-before-release');
    await release(invocation);
    await stopHost(host);
    return {
      name,
      surface,
      missing,
      hostile,
      terminal,
      journal: record.file,
      operation: durable.file,
      consumerStatus: consumer.status,
      terminalDigest: consumer.terminal_digest,
      subsequent,
      action: action ?? null,
    };
  }
  async function runUncertainProjectProgress() {
    const a = createCase('codex-uncertain-A', 'codex', false, true);
    const policyA = path.join(a.environment.CAWS_HOME, 'state/projects', hash(a.project) + '.json');
    const policyBeforeB = pin(policyA);
    const b = createCase('codex-progress-B', 'codex', false, false, a);
    assert.deepEqual(pin(policyA), policyBeforeB, 'B setup changed A policy');
    a.capacityObservation = true;
    b.capacityObservation = true;
    assert.equal(a.owner.limits.maxRetainedRecords, 2);
    assert.notEqual(a.project, b.project);
    assert.equal(a.environment.CAWS_HOME, b.environment.CAWS_HOME);
    assert.equal(a.installed.digest, b.installed.digest);
    const { host, observations } = await provision(a);
    const hostBirth = observeInstance(host.child.pid);
    const assertOwner = (label) => {
      assert.equal(host.child.exitCode, null);
      assert.equal(host.child.signalCode, null);
      const observed = observeInstance(host.child.pid);
      assert(sameOwnerBirth(hostBirth, observed), 'original owner birth changed');
      assert.deepEqual(
        read(path.join(a.environment.CAWS_HOME, 'state/render-service/config.json')),
        a.owner
      );
      put(path.join(a.directory, label + '-owner.json'), observed);
    };
    const identity = (file) => {
      const stat = fs.lstatSync(file, { bigint: true });
      assert(stat.isFile() && !stat.isSymbolicLink());
      return {
        ...pin(file),
        ...Object.fromEntries(
          ['dev', 'ino', 'birthtimeNs', 'ctimeNs', 'mtimeNs', 'nlink'].map((key) => [
            key,
            String(stat[key]),
          ])
        ),
      };
    };
    const settle = async (fixture, invocation, id, success) => {
      const ancestor = await release(invocation);
      assert.deepEqual(invocation.observationErrors, []);
      const custody = invocation.collector.collect({
        coverage: invocation.coverage,
        invocationId: id,
        runtimeDigest: fixture.installed.digest,
        node,
        engine,
      });
      put(path.join(fixture.directory, 'custody-observed.json'), custody);
      assert.equal(custody.state, 'confirmed_settled', custody.error);
      assert(Number.isSafeInteger(custody.terminal.child_exit_raw));
      if (success) assert.equal(custody.terminal.child_exit_raw, 0);
      let cleanup;
      await waitFor(
        () => {
          cleanup = strictCustody.requestCleanupObservation(
            invocation.coverage,
            topologyRows(),
            observeInstance
          );
          return cleanup.state === 'confirmed_inactive';
        },
        2000,
        'original request birth/group cleanup remains unknown'
      );
      assert.equal(strictCustody.combinedRequestCleanup(cleanup, custody), 'confirmed_inactive');
      put(path.join(fixture.directory, 'cleanup-observed.json'), cleanup);
      return {
        ancestor: { pid: ancestor.pid, code: ancestor.code, signal: ancestor.signal },
        custody,
        cleanup,
      };
    };
    assertOwner('before-A');
    const target = path.join(a.session, a.turns[0][0]);
    const replacement = path.join(a.directory, 'replacement-turn.json');
    const originalBytes = fs.readFileSync(target);
    const originalSha256 = hash(originalBytes);
    const beforeInode = fs.statSync(target).ino;
    put(replacement, originalBytes);
    a.hostileControl = {
      target,
      replacement,
      originalSha256,
      beforeInode,
      session: a.session,
      sid: a.sid,
      runtimeDigest: a.installed.digest,
      receipt: path.join(a.directory, 'hostile-action.json'),
    };
    const originalA = await invoke(a);
    const action = await waitFor(
      () => originalA.hostileResult(),
      17000,
      'A hostile watcher did not settle'
    );
    assert.equal(action.status, 'applied', action.error);
    assert.equal(action.nativePid, originalA.nativePid);
    assert.deepEqual(read(a.hostileControl.receipt), action);
    const recordA = journal(a.session);
    assert(recordA, 'A ordinary consumer journal missing');
    const idA = recordA.rows[0].invocation_id;
    assert.equal(action.invocationId, idA);
    assert.equal(action.journal, recordA.file);
    put(path.join(a.directory, 'pre-action-operation.json'), action.beforeAction);
    const terminalA = await bounded(originalA.nativeTerminal, 25000, 'A did not settle');
    // Native terminal IPC can arrive before the ancestor's forwarded stderr.
    // Settle the original ancestor and its pipes before inspecting those bytes.
    const proofA = await settle(a, originalA, idA, false);
    assert.equal(hash(originalA.agent.output().stderr), terminalA.stderrSha256);
    assert.equal(fs.statSync(target).ino, action.afterInode);
    assert.equal(hash(fs.readFileSync(target)), action.sameBytesSha256);
    checkPrefix(a, originalA, recordA);
    const consumerA = checkConsumer(a, recordA);
    assert.match(
      originalA.agent.output().stderr.toString(),
      /published generation bytes or inventory changed/
    );
    assert.equal(terminalA.signal, null);
    assert.equal(terminalA.code, 2, 'A did not preserve the native infrastructure refusal');
    await waitFor(
      () =>
        ownerRows(observations).some(
          (row) => row.stage === 'session_retained' && row.invocationId === idA
        ),
      5000,
      'A was not retained; hostile window missed'
    );
    const durableA = operation(a, idA);
    assert.equal(durableA.row.body.outcome.execution, 'returned');
    assert.equal(durableA.row.body.outcome.result.terminalDigest, consumerA.terminal_digest);
    assert(durableA.row.body.verifiedRequestBase64.length > 0);
    assert(
      !ownerRows(observations).some(
        (row) => row.stage === 'session_consumed_durable' && row.invocationId === idA
      )
    );
    const guardedFiles = [
      durableA.file,
      path.join(a.session, '.meta.json'),
      path.join(a.session, '.session-publication.json'),
      policyA,
      path.join(a.environment.CAWS_HOME, 'surfaces/codex/settings.json'),
    ];
    const retainedBefore = guardedFiles.map(identity);
    const assertA = (label) => {
      assert(
        !ownerRows(observations).some(
          (row) =>
            row.invocationId === idA &&
            [
              'session_consumed_durable',
              'session_heavy_released',
              'session_rejected_before_effects',
            ].includes(row.stage)
        ),
        'A was consumed or released while its uncertainty remained'
      );
      const observed = guardedFiles.map(identity);
      assert.deepEqual(observed, retainedBefore, 'A custody changed during other admission');
      put(path.join(a.directory, label + '-retained-A.json'), observed);
    };
    await writerProbe(a, 'retained');
    assertOwner('after-A');

    const a2 = {
      ...a,
      hostileControl: undefined,
      name: 'codex-refused-A2',
      directory: path.join(a.directory, 'a2'),
    };
    fs.mkdirSync(a2.directory, { mode: 0o700 });
    const priorJournals = fs.readdirSync(path.join(a.session, 'hook-invocations'));
    const originalA2 = await invoke(a2);
    const terminalA2 = await bounded(originalA2.nativeTerminal, 25000, 'A2 did not settle');
    const recordA2 = journal(a2.session, priorJournals);
    assert(recordA2, 'A2 did not execute the ordinary engine');
    checkPrefix(a2, originalA2, recordA2, false);
    const idA2 = recordA2.rows[0].invocation_id;
    assert.notEqual(idA2, idA);
    assert.equal(terminalA2.signal, null);
    assert(Number.isInteger(terminalA2.code) && terminalA2.code !== 0);
    assert(!recordA2.rows.some((row) => row.stage === 'session_seal_consumer_completed'));
    await waitFor(
      () => {
        const observed = ownerRows(observations);
        return (
          observed.some(
            (row) =>
              row.event === 'admission_denied' &&
              row.reason === 'unknown_fence' &&
              row.invocationId === idA2
          ) &&
          observed.some(
            (row) => row.stage === 'session_rejected_before_effects' && row.invocationId === idA2
          )
        );
      },
      3000,
      'A2 did not reach the proven non-execution refund'
    );
    assert(
      !ownerRows(observations).some(
        (row) => row.stage === 'session_original_reserved' && row.invocationId === idA2
      )
    );
    const durableA2 = operation(a2, idA2);
    assert.equal(durableA2.row, null);
    put(path.join(a2.directory, 'operation-observed.json'), durableA2);
    const proofA2 = await settle(a2, originalA2, idA2, false);
    assertA('after-A2');
    assertOwner('after-A2');

    const originalB = await invoke(b);
    const terminalB = await bounded(originalB.nativeTerminal, 25000, 'B did not progress');
    assert.equal(terminalB.code, 0, originalB.agent.output().stderr.toString());
    assert.equal(terminalB.signal, null);
    assert.equal(originalB.agent.output().stdout.length, 0);
    assert.equal(originalB.agent.output().stderr.length, 0);
    const recordB = journal(b.session);
    assert(recordB, 'B did not execute the ordinary engine');
    checkPrefix(b, originalB, recordB);
    const idB = recordB.rows[0].invocation_id;
    assert.notEqual(idB, idA);
    assert.notEqual(idB, idA2);
    const consumerB = checkConsumer(b, recordB);
    const durableB = operation(b, idB);
    assert.equal(durableB.row.body.outcome.execution, 'consumed');
    assert.equal(durableB.row.body.outcome.terminalDigest, consumerB.terminal_digest);
    assert.equal(durableB.row.body.verifiedRequestBase64, '');
    await waitFor(
      () =>
        ownerRows(observations).some(
          (row) => row.stage === 'session_heavy_released' && row.invocationId === idB
        ),
      3000,
      'B did not release its heavy record'
    );
    const lifecycleB = capacityLifecycle(ownerRows(observations), idB);
    const proofB = await settle(b, originalB, idB, true);
    assertA('after-B');
    assertOwner('after-B');
    await writerProbe({ ...a, name: a.name + '-after-B' }, 'retained');
    await writerProbe(b, 'released');
    assertA('after-writer-probes');
    assertOwner('before-shutdown');
    put(path.join(a.directory, 'owner-observations.json'), ownerRows(observations));
    const hostTerminal = await stopHost(host);
    return {
      name: 'uncertain-project-progress',
      hostPid: host.child.pid,
      hostBirth,
      limits: a.owner.limits,
      hostTerminal: { code: hostTerminal.code, signal: hostTerminal.signal },
      A: {
        id: idA,
        terminal: terminalA,
        journal: recordA.file,
        operation: durableA.file,
        retainedBefore,
        proof: proofA,
      },
      A2: {
        id: idA2,
        terminal: terminalA2,
        journal: recordA2.file,
        operation: durableA2.file,
        proof: proofA2,
      },
      B: {
        id: idB,
        terminal: terminalB,
        journal: recordB.file,
        operation: durableB.file,
        terminalDigest: consumerB.terminal_digest,
        lifecycle: lifecycleB,
        proof: proofB,
      },
      nonclaims: [
        'Bounded cross-project SessionEnd progress only; no general scheduling fairness',
        'A remained retained through B consumption; owner shutdown is explicit fixture teardown',
      ],
    };
  }

  function engineCustody(fixture, invocation, id) {
    assert.deepEqual(invocation.observationErrors, [], 'request birth/topology observation failed');
    const custody = invocation.collector.collect({
      coverage: invocation.coverage,
      invocationId: id,
      runtimeDigest: fixture.installed.digest,
      node,
      engine,
    });
    put(path.join(fixture.directory, 'custody-observed.json'), custody);
    assert.equal(custody.state, 'confirmed_settled', custody.error);
    assert.equal(custody.terminal.child_exit_raw, 0);
    return custody;
  }
  function sameOwnerBirth(original, current) {
    return (
      original?.state === 'observed' &&
      current?.state === 'observed' &&
      original.process?.zombie === false &&
      current.process?.zombie === false &&
      ['pid', 'parent', 'group', 'startSeconds', 'startMicros'].every(
        (key) => original.process[key] === current.process[key]
      )
    );
  }
  function capacityLifecycle(observations, id) {
    const stages = [
      'session_original_reserved',
      'session_writer_retained',
      'session_consumed_durable',
      'session_heavy_released',
    ];
    const lifecycle = observations
      .map((row, index) => ({ index, row }))
      .filter(
        ({ row }) =>
          row.event === 'actor_stage' && row.invocationId === id && stages.includes(row.stage)
      );
    assert.deepEqual(
      lifecycle.map(({ row }) => row.stage),
      stages,
      'capacity original must occupy its actual reservation and writer before durable consumption and release'
    );
    return lifecycle;
  }
  async function runCapacityCase(overallStarted) {
    assert.equal(originalCount, 258);
    const fixture = createCase('codex-capacity', 'codex', false, false);
    fixture.capacityObservation = true;
    assert.equal(fixture.owner.limits.maxRetainedRecords, 1);
    assert.equal(fixture.owner.limits.requestMs, 20000);
    const metadata = fs.readFileSync(path.join(fixture.session, '.meta.json'));
    const { host, observations } = await provision(fixture);
    const hostPid = host.child.pid;
    const hostBirth = observeInstance(hostPid);
    assert.equal(hostBirth.state, 'observed');
    assert.equal(hostBirth.process.zombie, false);
    capacityProgress.hostPid = hostPid;
    const identities = new Set();
    const assertOriginalOwner = () => {
      assert.equal(host.child.pid, hostPid);
      assert.equal(host.child.exitCode, null, 'capacity test lost its original live owner');
      assert.equal(host.child.signalCode, null);
      const current = observeInstance(hostPid);
      assert.equal(current.state, 'observed', 'original owner birth is unavailable');
      assert(sameOwnerBirth(hostBirth, current), 'original owner birth/ancestry changed or zombie');
      const starts = ownerRows(observations).filter((row) => row.event === 'host_started');
      assert.equal(starts.length, 1, 'capacity test must not restart or replace its owner');
      assert.equal(starts[0].hostPid, hostPid);
    };
    // Overall allowance is separate from the unchanged 20s request deadline.
    // Do not race the loop against a timer that could leave it launching work
    // after rejection. Reserve an existing step's full outer waits before spawn.
    const workloadExpires = overallStarted + 600000;
    for (let index = 1; index <= originalCount; index++) {
      assert(
        performance.now() + 45000 <= workloadExpires,
        'capacity workload budget exhausted before complete original count'
      );
      assertOriginalOwner();
      const label = String(index).padStart(3, '0');
      const current =
        index === 1
          ? fixture
          : {
              ...fixture,
              name: fixture.name + '-' + label,
              sid: fixture.sid + '-' + label,
              directory: path.join(fixture.directory, 'original-' + label),
            };
      if (index !== 1) {
        current.session = path.join(fixture.project, '.caws/sessions', current.sid);
        fs.mkdirSync(current.directory, { mode: 0o700 });
        fs.mkdirSync(current.session, { mode: 0o700 });
        put(path.join(current.session, '.meta.json'), metadata);
        for (const [file, bytes] of fixture.turns) put(path.join(current.session, file), bytes);
      }
      const invocation = await invoke(current);
      const terminal = await bounded(
        invocation.nativeTerminal,
        25000,
        'capacity original did not settle'
      );
      assert.equal(terminal.code, 0, invocation.agent.output().stderr.toString());
      assert.equal(terminal.signal, null);
      assert.equal(
        invocation.agent.output().stdout.length,
        0,
        'capacity SessionEnd must be silent'
      );
      assert.equal(
        invocation.agent.output().stderr.length,
        0,
        'capacity SessionEnd must be silent'
      );
      const record = journal(current.session);
      assert(record, 'capacity original did not execute the ordinary engine');
      const id = record.rows[0].invocation_id;
      assert.match(
        id,
        new RegExp('^' + invocation.nativePid + '-[0-9]+$'),
        'identity must come from the actual native original'
      );
      assert(!identities.has(id), 'capacity test reused an original invocation ID');
      identities.add(id);
      checkPrefix(current, invocation, record, index === 1);
      const envelope = read(path.join(current.session, '.session-envelope.json'));
      assert.equal(envelope.created_at, envelope.last_seen_at, 'fresh session envelope required');
      const consumer = checkConsumer(current, record);
      const durable = operation(current, id);
      assert.equal(durable.row?.body.outcome.execution, 'consumed');
      assert.equal(durable.row.body.outcome.terminalDigest, consumer.terminal_digest);
      assert.equal(durable.row.body.verifiedRequestBase64, '');
      await waitFor(
        () =>
          ownerRows(observations).some(
            (row) => row.stage === 'session_heavy_released' && row.invocationId === id
          ),
        3000,
        'capacity original heavy-release observation missing'
      );
      const lifecycle = capacityLifecycle(ownerRows(observations), id);
      assertOriginalOwner();
      const writer = await writerProbe(current, 'released');
      assertOriginalOwner();
      const custody = engineCustody(current, invocation, id);
      const ancestor = await release(invocation);
      let cleanup;
      await waitFor(
        () => {
          cleanup = strictCustody.requestCleanupObservation(
            invocation.coverage,
            topologyRows(),
            observeInstance
          );
          return cleanup.state === 'confirmed_inactive';
        },
        2000,
        'completed capacity original birth/group cleanup remains unknown'
      );
      assert.equal(strictCustody.combinedRequestCleanup(cleanup, custody), 'confirmed_inactive');
      assertOriginalOwner();
      const completed = {
        index,
        id,
        nativePid: invocation.nativePid,
        hostPid,
        terminal,
        ancestor: { pid: ancestor.pid, code: ancestor.code, signal: ancestor.signal },
        journal: record.file,
        operation: pin(durable.file),
        marker: pin(path.join(current.session, '.session-publication.json')),
        terminalDigest: consumer.terminal_digest,
        lifecycle,
        custody,
        cleanup,
        writer,
      };
      capacityProgress.completed.push(completed);
      capacityProgress.completedOriginals = capacityProgress.completed.length;
      put(path.join(fixture.directory, 'completed-' + label + '.json'), completed);
      snapshot('capacity-completed-' + label);
    }
    assert.equal(
      capacityProgress.completedOriginals,
      originalCount,
      'partial capacity run cannot pass'
    );
    assert.equal(identities.size, originalCount);
    assertOriginalOwner();
    // Rescan every durable receipt and publication after the final admission:
    // subsequent originals may not replace or expand an earlier tombstone.
    for (const completed of capacityProgress.completed) {
      assert.deepEqual(pin(completed.operation.path), completed.operation);
      assert.deepEqual(pin(completed.marker.path), completed.marker);
      const durable = read(completed.operation.path);
      assert.equal(durable.body.outcome.execution, 'consumed');
      assert.equal(durable.body.verifiedRequestBase64, '');
      assert.equal(durable.body.outcome.terminalDigest, completed.terminalDigest);
    }
    const operations = fs
      .readdirSync(path.dirname(capacityProgress.completed[0].operation.path))
      .filter((name) => /^[0-9a-f]{64}\.json$/.test(name));
    assert.equal(
      operations.length,
      originalCount,
      'every successful actual original must retain its own compact tombstone'
    );
    assert(
      performance.now() <= workloadExpires,
      'capacity workload exceeded its overall allowance'
    );
    const hostTerminal = await stopHost(host);
    put(path.join(fixture.directory, 'owner-observations.json'), ownerRows(observations));
    const result = {
      name: fixture.name,
      requestedOriginals: originalCount,
      completedOriginals: capacityProgress.completedOriginals,
      uniqueOriginals: identities.size,
      hostPid,
      hostBirth,
      hostTerminal: { pid: hostTerminal.pid, code: hostTerminal.code, signal: hostTerminal.signal },
      limits: fixture.owner.limits,
      elapsedMs: Math.round(performance.now() - overallStarted),
    };
    put(path.join(fixture.directory, 'capacity-result.json'), result);
    return result;
  }
  async function settleTracked() {
    for (let i = 0; i < 100; i++) {
      if (snapshot('settlement-' + i).length === 0) return;
      await delay(20);
    }
    throw new Error(
      'original process/descendant residue remains; fixture retained without guessed cleanup'
    );
  }
  async function main() {
    const overallStarted = performance.now();
    const results = [];
    if (uncertainProgress) results.push(await runUncertainProjectProgress());
    else {
      results.push(await runCase('codex-normal', 'codex', false));
      results.push(await runCase('claude-normal', 'claude-code', false));
      results.push(await runCase('codex-missing-metadata', 'codex', true));
      results.push(await runCase('codex-changed-input', 'codex', false, 'changed-input'));
      results.push(await runCase('codex-lost-ack', 'codex', false, 'lost-ack'));
      if (originalCount) results.push(await runCapacityCase(overallStarted));
    }
    await settleTracked();
    const afterPins = pinInputs();
    assert.deepEqual(afterPins, beforePins, 'source/tool input changed during qualification');
    put(path.join(root, 'process-observations.json'), snapshots);
    put(path.join(root, 'result.json'), {
      status: 'passed',
      results,
      beforePins,
      afterPins,
      limits,
      capacity: capacityProgress,
    });
    process.stdout.write(
      JSON.stringify({ status: 'passed', artifacts: root, cases: results.length }) + '\n'
    );
  }
  main().catch(async (error) => {
    const cleanup = [];
    for (const [child] of active) {
      try {
        if (child.connected) child.send({ type: 'release' });
        else child.kill('SIGTERM');
      } catch (failure) {
        cleanup.push({ pid: child.pid, error: String(failure) });
      }
    }
    for (const [child, terminal] of [...active]) {
      try {
        await bounded(terminal, 5000, 'original child cleanup did not settle');
      } catch (failure) {
        cleanup.push({ pid: child.pid, error: String(failure) });
      }
    }
    try {
      await settleTracked();
    } catch (failure) {
      cleanup.push({ error: String(failure) });
    }
    if (!fs.existsSync(path.join(root, 'process-observations.json')))
      put(path.join(root, 'process-observations.json'), snapshots);
    put(path.join(root, 'failure.json'), {
      message: String(error),
      stack: error.stack,
      cleanup,
      capacity: capacityProgress,
      afterPins: pinInputs(),
      limits,
    });
    process.stderr.write(String(error.stack || error) + '\n');
    process.exitCode = 1;
  });
}
