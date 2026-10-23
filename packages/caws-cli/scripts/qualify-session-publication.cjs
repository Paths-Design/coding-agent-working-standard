#!/usr/bin/env node
'use strict';

// Direct native frontend + compiled engine + sole stock SessionEnd logger.
// Operational journals are observations, never substitutes for durable CONSUMED.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const { setTimeout, clearTimeout } = require('node:timers');
const { setTimeout: delay } = require('node:timers/promises');
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
      if (!closed) child.kill('SIGTERM');
      const finish = () => process.exit(0);
      if (closed) finish();
      else child.once('close', finish);
    }
  });
  process.on('disconnect', () => {
    if (!closed) child.kill('SIGTERM');
    if (closed) process.exit(1);
    else child.once('close', () => process.exit(1));
  });
  child.stdin.end(spec.input);
} else {
  const { installMachineRuntime } = require('../dist/init/machine-adapters');
  const { validateSystemPolicy } = require('../dist/init/system-project-policy');
  const options = new Map();
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i],
      value = process.argv[i + 1];
    assert(
      ['--native', '--node', '--artifacts'].includes(key) && value && !options.has(key),
      'usage: qualify-session-publication.cjs --native <absolute> --node <absolute> --artifacts <fresh absolute>'
    );
    assert(path.isAbsolute(value));
    options.set(key, value);
  }
  assert.equal(options.size, 3);
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
  const limits = [
    'Direct native invoke, not installed harness or vendor callback qualification',
    'SessionEnd only; no Render discovery, SQL publication, calendar or subagent parity',
    'Fresh PID refresh and empty-directory reap execution; stale candidate reaping is not qualified',
    'Diagnostic observations alone do not establish durable acceptance or heavy release',
    'One hostile synchronization attempt per case; an ACK race is an unexercised failure, never a pass',
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
  put(path.join(root, 'inputs.json'), { native, node, engine, beforePins, limits });
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
        active.delete(child);
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
  function journal(session) {
    const directory = path.join(session, 'hook-invocations');
    if (!fs.existsSync(directory)) return null;
    const files = fs.readdirSync(directory).filter((name) => name.endsWith('.jsonl'));
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
  function createCase(name, surface, missing, large) {
    const directory = path.join(root, name);
    fs.mkdirSync(directory, { mode: 0o700 });
    const environment = {
      HOME: path.join(directory, 'user'),
      CAWS_HOME: path.join(directory, 'machine'),
      PATH: path.dirname(node) + ':/usr/bin:/bin',
      TMPDIR: directory,
      LANG: 'C',
      LC_ALL: 'C',
      TZ: 'UTC',
      CAWS_TRAP_KILL: '0',
    };
    fs.mkdirSync(environment.HOME, { mode: 0o700 });
    const installed = installMachineRuntime({
      home: environment.CAWS_HOME,
      templatesRoot: templates,
    });
    const defaults = read(
      path.join(environment.CAWS_HOME, 'lib/runtimes', installed.digest, 'system-policy.json')
    ).events;
    put(path.join(environment.CAWS_HOME, 'surfaces', surface, 'settings.json'), {
      version: 1,
      enabled: true,
    });
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
    const owner = {
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
        maxRetainedRecords: 1,
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
    const environment = {
      ...fixture.environment,
      [fixture.surface === 'codex' ? 'CODEX_THREAD_ID' : 'CLAUDE_SESSION_ID']: fixture.sid,
    };
    const spec = path.join(fixture.directory, 'agent-input.json');
    put(spec, { native, argv, cwd: fixture.project, environment, input });
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
    let nativePid, signalResult, terminal;
    const nativeTerminal = new Promise((resolve, reject) => {
      agent.child.on('message', (message) => {
        if (message.type === 'native-started') {
          nativePid = message.pid;
          trackedPids.add(nativePid);
          put(path.join(fixture.directory, 'native-started.json'), message);
        }
        if (message.type === 'signal-result') {
          signalResult = message;
          put(path.join(fixture.directory, 'signal-result.json'), message);
        }
        if (message.type === 'native-terminal') {
          terminal = message;
          put(path.join(fixture.directory, 'native-terminal.json'), message);
          resolve(message);
        }
        if (message.type === 'spawn-error') reject(new Error(message.error));
      });
    });
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
    assert.equal(envelope.created_at, envelope.last_seen_at);
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
      const receipts = path.join(
        fixture.environment.CAWS_HOME,
        'state/render-writer-receipts',
        hash(JSON.stringify(['caws-render-writer-project-v1', fixture.project]))
      );
      const values = fs.readdirSync(receipts).map((file) => read(path.join(receipts, file)));
      assert(values.some((row) => row.state === 'reaped_and_output_eof' && row.exitCode === 0));
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
    await bounded(
      invocation.agent.terminal,
      5000,
      'original recognized ancestor did not reap/exit'
    );
  }
  async function stopHost(host) {
    if (host.child.exitCode === null && host.child.signalCode === null) host.child.kill('SIGTERM');
    await bounded(host.terminal, 5000, 'original renderer-host did not terminate');
  }
  async function followup(fixture, admitted) {
    const next = {
      ...fixture,
      name: fixture.name + '-next',
      sid: fixture.sid + '-next',
      directory: path.join(fixture.directory, 'followup'),
      missing: true,
      large: false,
      turns: [],
    };
    next.session = path.join(fixture.project, '.caws/sessions', next.sid);
    fs.mkdirSync(next.directory, { mode: 0o700 });
    const invocation = await invoke(next);
    const terminal = await bounded(
      invocation.nativeTerminal,
      25000,
      'follow-up original did not settle'
    );
    const record = journal(next.session);
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
      assert.equal(durable.row, null, 'full shared frontier admitted another original');
      assert(!fs.existsSync(path.join(next.session, '.session-publication.json')));
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
    const results = [];
    results.push(await runCase('codex-normal', 'codex', false));
    results.push(await runCase('claude-normal', 'claude-code', false));
    results.push(await runCase('codex-missing-metadata', 'codex', true));
    results.push(await runCase('codex-changed-input', 'codex', false, 'changed-input'));
    results.push(await runCase('codex-lost-ack', 'codex', false, 'lost-ack'));
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
      afterPins: pinInputs(),
      limits,
    });
    process.stderr.write(String(error.stack || error) + '\n');
    process.exitCode = 1;
  });
}
