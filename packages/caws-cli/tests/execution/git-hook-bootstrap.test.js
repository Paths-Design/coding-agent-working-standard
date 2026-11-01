const { setTimeout } = require('node:timers');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
jest.setTimeout(30000);

const bootstrap = path.resolve(__dirname, '../../dist/execution/git-hook-formatter-main.js');
const node = fs.realpathSync.native(process.execPath);
const launchId = 'a'.repeat(64);
const readyPrefix = 'CAWS_FORMATTER_READY_V1 ';
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const digestJson = (value) => hash(JSON.stringify(value));
const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64');
const live = new Set();
const roots = new Set();

// Parent-process decision tests exercise the instrumented implementation during
// per-file mutation qualification. Real child tests below separately establish
// Node main-module, READY and gate behavior without instrumentation exceptions.
function inBootstrapContext(f, action) {
  const previousEnv = { ...process.env };
  const previousCwd = process.cwd();
  const previousArgv = process.argv;
  const previousExecArgv = process.execArgv;
  for (const name of Object.keys(process.env)) delete process.env[name];
  Object.assign(process.env, f.env);
  process.chdir(f.cwd);
  process.execArgv = [];
  try {
    return action();
  } finally {
    process.chdir(previousCwd);
    process.argv = previousArgv;
    process.execArgv = previousExecArgv;
    for (const name of Object.keys(process.env)) delete process.env[name];
    Object.assign(process.env, previousEnv);
  }
}

test('instrumented parser binds physical entry bytes, closed environment and argument data', () => {
  const f = fixture();
  const { parseFormatterBootstrap } = require(bootstrap);
  inBootstrapContext(f, () => {
    expect(parseFormatterBootstrap(['--launch', encode(f.launch)])).toEqual(f.launch);
    for (const launch of [
      { ...f.launch, entry: { ...f.launch.entry, sha256: '0'.repeat(64) } },
      { ...f.launch, cwd: f.root },
      { ...f.launch, args: ['unsafe\0value'] },
      { ...f.launch, args: [37] },
      { ...f.launch, timeoutMs: 0 },
      { ...f.launch, timeoutMs: 30001 },
      { ...f.launch, extra: true },
    ])
      expect(() => parseFormatterBootstrap(['--launch', encode(launch)])).toThrow();
    for (const [name, value] of [
      ['NODE_OPTIONS', '--no-warnings'],
      ['LC_ALL', 'en_US.UTF-8'],
      ['CODEX_SANDBOX', 'other'],
      ['CODEX_SANDBOX_NETWORK_DISABLED', '0'],
      ['PWD', f.root],
    ]) {
      const original = process.env[name];
      process.env[name] = value;
      expect(() => parseFormatterBootstrap(['--launch', encode(f.launch)])).toThrow();
      if (original === undefined) delete process.env[name];
      else process.env[name] = original;
    }
  });
});

test.each(['success', 'wrong-gate', 'changed-entry', 'preexisting-gate'])(
  'instrumented bootstrap %s preserves the producer gate before loading task code',
  (control) => {
    const f = fixture();
    const { runFormatterBootstrap } = require(bootstrap);
    let ready;
    const originalWrite = fs.writeSync;
    const runMain = jest.spyOn(require('node:module'), 'runMain').mockImplementation(() => {});
    const output = jest.spyOn(fs, 'writeSync').mockImplementation((fd, bytes, ...args) => {
      if (fd === 1 && typeof bytes === 'string' && bytes.startsWith(readyPrefix)) {
        ready = JSON.parse(bytes.slice(readyPrefix.length));
        expect(runMain).not.toHaveBeenCalled();
        if (control === 'changed-entry') fs.appendFileSync(f.entry, '// changed after READY\n');
        installGate(f, {
          schema: 'caws.execution.formatter-go.v1',
          launchId: control === 'wrong-gate' ? 'b'.repeat(64) : launchId,
        });
        return Buffer.byteLength(bytes);
      }
      return originalWrite(fd, bytes, ...args);
    });
    try {
      if (control === 'preexisting-gate') installGate(f);
      inBootstrapContext(f, () => {
        const execute = () => runFormatterBootstrap(['--launch', encode(f.launch)]);
        if (control === 'success') {
          expect(execute).not.toThrow();
          expect(ready).toMatchObject({ launchId, pid: process.pid, node, cwd: f.cwd });
          expect(process.argv).toEqual([process.execPath, f.entry, ...f.args]);
          expect(runMain).toHaveBeenCalledTimes(1);
          expect(runMain).toHaveBeenCalledWith(f.entry);
        } else {
          expect(execute).toThrow();
          expect(runMain).not.toHaveBeenCalled();
          if (control === 'preexisting-gate') expect(ready).toBeUndefined();
        }
      });
      expect(fs.existsSync(f.marker)).toBe(false);
    } finally {
      output.mockRestore();
      runMain.mockRestore();
    }
  }
);

function fixture() {
  const root = fs.mkdtempSync(
    path.join(fs.realpathSync.native(os.tmpdir()), 'caws-formatter-bootstrap-')
  );
  roots.add(root);
  const invocationRoot = path.join(root, 'invocation');
  const cwd = path.join(root, 'project');
  fs.mkdirSync(invocationRoot, { mode: 0o700 });
  fs.mkdirSync(cwd, { mode: 0o700 });
  const entry = path.join(root, 'entry.cjs');
  const marker = path.join(cwd, 'formatter-result.json');
  fs.writeFileSync(
    entry,
    `const fs = require('node:fs');\nconst env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== '__CF_USER_TEXT_ENCODING').sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));\nconst result = { pid: process.pid, main: require.main === module, filename: require.main.filename, argv: process.argv, stdin: fs.readFileSync(0, 'utf8'), env };\nfs.writeFileSync(process.argv[2], JSON.stringify(result));\nprocess.exitCode = 37;\n`
  );
  const entryHash = hash(fs.readFileSync(entry));
  const args = [marker, '--fix', '--', './-name.js'];
  const env = {
    PATH: `${path.dirname(node)}:/usr/bin:/bin`,
    LC_ALL: 'C',
    PWD: cwd,
    TMPDIR: invocationRoot,
    HOME: root,
    CAWS_HOME: root,
    CODEX_HOME: root,
    CODEX_THREAD_ID: 'thread',
    CAWS_AGENT_SURFACE: 'codex',
    CAWS_PROJECT_DIR: cwd,
    CODEX_SANDBOX: 'seatbelt',
    CODEX_SANDBOX_NETWORK_DISABLED: '1',
  };
  const launch = {
    schema: 'caws.execution.formatter-bootstrap.v1',
    launchId,
    invocationRoot,
    cwd,
    entry: { path: entry, sha256: entryHash },
    args,
    timeoutMs: 5000,
  };
  return {
    root,
    invocationRoot,
    cwd,
    entry,
    marker,
    args,
    env,
    launch,
    gate: path.join(invocationRoot, 'formatter-go.json'),
  };
}

function launchChild(f, options = {}) {
  const payload = options.payload === undefined ? encode(f.launch) : options.payload;
  const args = options.args || [bootstrap, '--launch', payload];
  const child = spawn(node, args, {
    cwd: f.cwd,
    env: options.env || f.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  live.add(child);
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (s) => {
    stdout += s;
  });
  child.stderr.on('data', (s) => {
    stderr += s;
  });
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => {
      live.delete(child);
      resolve({ code, signal, stdout, stderr });
    });
  });
  async function waitReady() {
    const end = Date.now() + 10000;
    for (;;) {
      const newline = stdout.indexOf('\n');
      if (newline >= 0) {
        const line = stdout.slice(0, newline);
        if (!line.startsWith(readyPrefix)) throw new Error(`unexpected READY line: ${line}`);
        return JSON.parse(line.slice(readyPrefix.length));
      }
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(`child exited before READY: ${stderr}`);
      if (Date.now() >= end) throw new Error('timed out awaiting READY');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  return { child, done, waitReady, payload };
}

function installGate(f, value = { schema: 'caws.execution.formatter-go.v1', launchId }) {
  const temp = path.join(f.invocationRoot, 'producer.pending');
  fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
  fs.renameSync(temp, f.gate);
}

function runInvalid(f, options = {}) {
  const payload = options.payload === undefined ? encode(f.launch) : options.payload;
  const args = options.args || [bootstrap, '--launch', payload];
  const result = spawnSync(node, args, {
    cwd: f.cwd,
    env: options.env || f.env,
    encoding: 'utf8',
    timeout: 10000,
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status).not.toBe(0);
  expect(result.stdout).not.toContain(readyPrefix);
  expect(result.stderr).toContain('caws formatter bootstrap refused');
  expect(fs.existsSync(f.marker)).toBe(false);
}

afterEach(async () => {
  const children = [...live];
  for (const child of children)
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await Promise.all(
    children.map(
      (child) =>
        new Promise((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) resolve();
          else child.once('close', resolve);
        })
    )
  );
  live.clear();
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots.clear();
});

test('READY binds the real Node tuple and GO executes the pinned main in the same PID', async () => {
  const f = fixture();
  const running = launchChild(f);
  const message = await running.waitReady();
  const sortedEnv = Object.fromEntries(
    Object.entries(f.env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  );
  expect(message).toEqual({
    schema: 'caws.execution.formatter-ready.v1',
    launchId,
    pid: running.child.pid,
    node,
    cwd: f.cwd,
    argvSha256: digestJson([node, bootstrap, '--launch', running.payload]),
    environmentSha256: digestJson(sortedEnv),
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(fs.existsSync(f.marker)).toBe(false);
  installGate(f);
  const result = await running.done;
  expect(result.signal).toBeNull();
  expect(result.code).toBe(37);
  expect(result.stderr).toBe('');
  const observed = JSON.parse(fs.readFileSync(f.marker, 'utf8'));
  expect(observed).toEqual({
    pid: message.pid,
    main: true,
    filename: f.entry,
    argv: [node, f.entry, ...f.args],
    stdin: '',
    env: sortedEnv,
  });
  expect(message.environmentSha256).toBe(digestJson(observed.env));
});

test.each(['wrong-id', 'wrong-schema', 'extra-field', 'invalid-json', 'wrong-mode', 'symlink'])(
  'refuses a %s GO after READY without loading entry',
  async (kind) => {
    const f = fixture();
    const running = launchChild(f);
    await running.waitReady();
    if (kind === 'wrong-id')
      installGate(f, { schema: 'caws.execution.formatter-go.v1', launchId: 'b'.repeat(64) });
    else if (kind === 'wrong-schema') installGate(f, { schema: 'other', launchId });
    else if (kind === 'extra-field')
      installGate(f, { schema: 'caws.execution.formatter-go.v1', launchId, extra: true });
    else if (kind === 'invalid-json') {
      fs.writeFileSync(f.gate, '{"broken":', { mode: 0o600 });
    } else if (kind === 'wrong-mode') {
      const temp = path.join(f.invocationRoot, 'wrong-mode.pending');
      fs.writeFileSync(
        temp,
        JSON.stringify({ schema: 'caws.execution.formatter-go.v1', launchId }),
        { mode: 0o644, flag: 'wx' }
      );
      fs.chmodSync(temp, 0o644);
      fs.renameSync(temp, f.gate);
    } else {
      const target = path.join(f.root, 'foreign-gate');
      fs.writeFileSync(target, '{}', { mode: 0o600 });
      fs.symlinkSync(target, f.gate);
    }
    const result = await running.done;
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('caws formatter bootstrap refused');
    expect(fs.existsSync(f.marker)).toBe(false);
  }
);

test.each(['regular', 'symlink'])('refuses a pre-existing %s GO before READY', (kind) => {
  const f = fixture();
  if (kind === 'regular') installGate(f);
  else {
    const target = path.join(f.root, 'gate-target');
    fs.writeFileSync(target, '{}');
    fs.symlinkSync(target, f.gate);
  }
  runInvalid(f);
});

test('changed entry after READY is refused even with correct GO', async () => {
  const f = fixture();
  const running = launchChild(f);
  await running.waitReady();
  fs.writeFileSync(
    f.entry,
    `require('node:fs').writeFileSync(${JSON.stringify(f.marker)}, 'substituted');`
  );
  installGate(f);
  const result = await running.done;
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain('caws formatter bootstrap refused');
  expect(fs.existsSync(f.marker)).toBe(false);
});

test('timeout with no GO never loads entry or creates invocation files', async () => {
  const f = fixture();
  f.launch.timeoutMs = 100;
  const running = launchChild(f);
  await running.waitReady();
  const result = await running.done;
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain('caws formatter bootstrap refused');
  expect(fs.readdirSync(f.invocationRoot)).toEqual([]);
  expect(fs.existsSync(f.marker)).toBe(false);
});

test('malformed descriptor, base64, tuple and environment refuse before READY', () => {
  const f = fixture();
  const changes = [
    { payload: 'not-base64!' },
    { payload: Buffer.from('{"schema":').toString('base64') },
    {
      payload: Buffer.from(
        JSON.stringify(f.launch).replace(
          '{"schema":',
          '{"schema":"caws.execution.formatter-bootstrap.v1","schema":'
        )
      ).toString('base64'),
    },
    { args: [bootstrap, '--launch'] },
    { args: [bootstrap, '--launch', encode(f.launch), 'extra'] },
    { payload: encode({ ...f.launch, schema: 'wrong' }) },
    { payload: encode({ ...f.launch, extra: true }) },
    { payload: encode({ ...f.launch, launchId: 'A'.repeat(64) }) },
    { payload: encode({ ...f.launch, entry: { ...f.launch.entry, sha256: '0'.repeat(64) } }) },
    { payload: encode({ ...f.launch, entry: { ...f.launch.entry, extra: true } }) },
    { payload: encode({ ...f.launch, args: ['a\0b'] }) },
    { payload: encode({ ...f.launch, args: [1] }) },
    { payload: encode({ ...f.launch, args: Array(261).fill('a') }) },
    { payload: encode({ ...f.launch, timeoutMs: 0 }) },
    { payload: encode({ ...f.launch, timeoutMs: 30001 }) },
    { env: { ...f.env, EXTRA_UNTRUSTED: '1' } },
    { env: { ...f.env, CODEX_SANDBOX: 'other' } },
    { env: { ...f.env, PWD: '/' } },
    // This proves the bootstrap refuses this environment only after Node has
    // started. Native must exclude startup influences before spawning Node.
    { env: { ...f.env, NODE_OPTIONS: '--no-warnings' } },
    { args: ['--trace-warnings', bootstrap, '--launch', encode(f.launch)] },
  ];
  for (const options of changes) runInvalid(f, options);
});
