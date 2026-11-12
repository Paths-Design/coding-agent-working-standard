'use strict';
// The typed (native) handlers replace selected shell handlers only for source
// bytes they were reviewed against. These cases install the handlers that
// actually ship, with no reviewed fixture laid over them, and pin two things:
// which typed routes answer for shipped bytes, and that every route that does
// answer returns what the shipped shell handler returns for the same payload.
const fs = require('node:fs');
const { AbortController } = globalThis;
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { tryExecuteStockHandler } = require('../../dist/runtime/stock-handlers');
const { prepareFileToolHandlers } = require('../../dist/runtime/file-tool-handlers');
const { createHandlerExecutor } = require('../../dist/runtime/handler-executor');

const templates = path.resolve(__dirname, '../../templates/hook-packs');
const digest = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const SESSION = 'agreement-fixture';
const directories = [];
afterAll(() =>
  directories.forEach((directory) => fs.rmSync(directory, { recursive: true, force: true }))
);
afterEach(() => jest.restoreAllMocks());

/** A machine runtime holding exactly the shipped handler and library bytes. */
function shippedFixture(surface = 'codex') {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'caws-agreement-')));
  directories.push(directory);
  const runtime = path.join(directory, 'runtime');
  const project = path.join(directory, 'project');
  const home = path.join(directory, 'home');
  const bin = path.join(directory, 'bin');
  for (const made of [project, home, bin]) fs.mkdirSync(made);
  fs.cpSync(path.join(templates, 'shared'), runtime, { recursive: true });
  for (const name of ['dispatch.sh', 'handler-env.sh'])
    fs.copyFileSync(path.join(templates, 'runtime', name), path.join(runtime, name));
  const pending = [runtime];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(file);
      else if (entry.isFile() && entry.name.endsWith('.sh')) fs.chmodSync(file, 0o755);
    }
  }
  const libraries = {};
  for (const name of fs.readdirSync(path.join(runtime, 'lib'))) {
    if (!name.endsWith('.sh')) continue;
    const file = path.join(runtime, 'lib', name);
    libraries[name] = { path: file, sha256: digest(file), kind: 'shared' };
  }
  if (surface === 'codex')
    for (const name of ['parse-input.sh', 'emit.sh']) {
      const file = path.join(runtime, 'surfaces/codex/lib', name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.copyFileSync(path.join(templates, 'codex/hooks/lib', name), file);
      fs.chmodSync(file, 0o755);
      libraries[name] = { path: file, sha256: digest(file), kind: 'surface' };
    }
  fs.symlinkSync(path.resolve(__dirname, '../../dist/index.js'), path.join(bin, 'caws'));
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  const environment = {
    HOME: home,
    CAWS_HOME: path.join(home, '.caws'),
    TMPDIR: directory,
    // The shell heartbeat gives its CLI call three seconds by default, which a
    // loaded test machine can exceed; the comparison is not about that limit.
    CAWS_HEARTBEAT_CLI_DEADLINE_SECONDS: '30',
    PATH: [bin, path.dirname(execFileSync('/usr/bin/which', ['git']).toString().trim())]
      .concat(['/usr/bin', '/bin'])
      .join(':'),
  };
  const selection = {
    status: 'active',
    runtimeDigest: 'a'.repeat(64),
    checkout: project,
    canonical: project,
    surface,
    event: 'pre_tool_use',
    configuration: 'system',
    runtimeDirectory: runtime,
    hooksDirectory: runtime,
    handlers: [],
    libraries,
    overrides: {},
    libraryOverrides: {},
    transcriptAdapter: null,
  };
  const request = {
    schema: 'caws.runtime.request.v1',
    id: 'agreement-fixture',
    runtimeDigest: selection.runtimeDigest,
    surface,
    event: 'pre_tool_use',
    configuration: 'system',
    caller: { cwd: project, processId: process.pid, environment },
    deadlineEpochMs: Date.now() + 60000,
    inputJson: '{}',
    payload: {},
  };
  const fixture = {
    directory,
    runtime,
    project,
    home,
    selection,
    request,
    environment,
    context: () => ({ request, selection, environment, signal: new AbortController().signal }),
    select(...names) {
      selection.handlers = names.map((name) => ({
        path: path.join(runtime, name),
        sha256: digest(path.join(runtime, name)),
        entry: name,
        name,
        args: [],
        tier: 'stock',
        kind: 'stock',
      }));
      return selection.handlers[0];
    },
    payload(tool_name, tool_input) {
      request.payload = { tool_name, session_id: SESSION, cwd: project, tool_input };
      request.inputJson = JSON.stringify(request.payload);
    },
    git: (...args) =>
      execFileSync('git', args, { cwd: project, env: environment, encoding: 'utf8' }),
  };
  fixture.git('init', '-q');
  return fixture;
}

const PAYLOADS = {
  'Bash: harmless command': ['Bash', { command: 'echo safe' }],
  'Bash: destructive command': ['Bash', { command: 'git reset --hard HEAD~3' }],
  'Bash: opaque inline program': ['Bash', { command: 'python3 -c "print(1)"' }],
  'Write: file in the project': ['Write', { file_path: 'src/a.js', content: 'x' }],
  'Edit: file in the project': [
    'Edit',
    { file_path: 'src/a.js', old_string: 'x', new_string: 'y' },
  ],
  'apply_patch: delete a file': [
    'apply_patch',
    { command: '*** Begin Patch\n*** Delete File: src/a.js\n*** End Patch\n' },
  ],
};
const STOCK = ['agent-heartbeat.sh', 'block-dangerous.sh', 'hook-utilities.sh', 'agent-stop.sh'];

test('census of typed routes that answer for the shipped handlers', () => {
  const answered = [];
  for (const surface of ['codex', 'claude-code', 'qwen-code'])
    for (const name of STOCK)
      for (const [label, [tool, input]] of Object.entries(PAYLOADS)) {
        const f = shippedFixture(surface);
        f.payload(tool, input);
        const handler = f.select(name);
        if (tryExecuteStockHandler(handler, f.context()) !== null)
          answered.push(surface + ' | ' + name + ' | ' + label);
      }
  // Every other shipped handler declines, so its shell source answers. A new
  // entry here is a typed route going live: it needs its own comparison below.
  expect(answered).toEqual([
    'codex | agent-heartbeat.sh | Bash: harmless command',
    'codex | agent-heartbeat.sh | Bash: destructive command',
    'codex | agent-heartbeat.sh | Bash: opaque inline program',
  ]);
});

test('the typed file-tool route declines for the shipped handlers on every file payload', () => {
  const order = [
    'agent-heartbeat.sh',
    'cwd-guard.sh',
    'block-dangerous.sh',
    'worktree-guard.sh',
    'scope-guard.sh',
    'worktree-write-guard.sh',
    'bash-write-guard.sh',
    'protected-paths.sh',
    'scan-secrets.sh',
    'quiet-merge.sh',
  ];
  for (const [label, [tool, input]] of Object.entries(PAYLOADS)) {
    if (tool === 'Bash') continue;
    const f = shippedFixture('codex');
    f.payload(tool, input);
    f.select(
      ...(tool === 'apply_patch'
        ? [...order.slice(0, 8), 'shortcut-language-check.sh', ...order.slice(8)]
        : order)
    );
    Object.assign(f.request, {
      fileToolContext: 'caws.runtime.file-tool-context.v1',
      guardStrikes: 'caws.runtime.guard-strikes.v1',
    });
    const strike = jest.fn();
    const plan = prepareFileToolHandlers({
      ...f.context(),
      nativeFileToolContext: {
        captured: { checkout: f.project, canonical: f.project },
        revalidate: async () => ({ checkout: f.project, canonical: f.project }),
        incrementScopeGuard: strike,
      },
    });
    expect({ label, plan }).toEqual({ label, plan: null });
    expect(strike).not.toHaveBeenCalled();
  }
});

/**
 * What the heartbeat promises other sessions: the lease record and the activity
 * stamp. The shell's .hb and .mail files only ration its own CLI calls, which
 * the in-process typed route does not make, so they are not part of the promise.
 */
function leaseState(f) {
  const directory = path.join(f.project, '.caws/leases');
  if (!fs.existsSync(directory)) return null;
  const state = {};
  for (const name of fs.readdirSync(directory).sort()) {
    if (/\.(hb|hb\.lease|mail)$/.test(name)) continue;
    if (name.endsWith('.active')) {
      state[name] = 'stamped';
      continue;
    }
    state[name] = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'), (key, entry) =>
      /(_at|_active|pid|hostname|_ms)$/.test(key)
        ? '<' + typeof entry + '>'
        : typeof entry === 'string'
          ? entry.split(f.directory).join('<fixture>')
          : entry
    );
  }
  return state;
}
async function bothRoutes(prepare, run = 1) {
  const outcome = {};
  for (const route of ['typed', 'shell']) {
    const f = shippedFixture('codex');
    fs.mkdirSync(path.join(f.project, '.caws'));
    prepare(f);
    const handler = f.select('agent-heartbeat.sh');
    if (route === 'shell')
      jest
        .spyOn(require('../../dist/runtime/stock-handlers'), 'tryExecuteStockHandler')
        .mockReturnValue(null);
    else expect(tryExecuteStockHandler(handler, f.context())).not.toBeNull();
    const results = [];
    for (let index = 0; index < run; index++) {
      const result = await createHandlerExecutor(f.context())(handler, 0);
      results.push({
        exitCode: result.exitCode,
        stdout: Buffer.from(result.stdout).toString(),
        stderr: Buffer.from(result.stderr).toString(),
      });
    }
    jest.restoreAllMocks();
    outcome[route] = { results, leases: leaseState(f) };
  }
  return outcome;
}

test('the typed Codex heartbeat and the shipped shell heartbeat keep the same lease and stamp', async () => {
  const outcome = await bothRoutes((f) => f.payload('Bash', { command: 'echo safe' }));
  expect(outcome.typed).toEqual(outcome.shell);
  // Both routes did the work, so equality is not two empty results.
  expect(outcome.shell.leases).toEqual({
    [SESSION + '.active']: 'stamped',
    [SESSION + '.json']: expect.objectContaining({
      session_id: SESSION,
      platform: 'codex',
      status: 'active',
      repo_root: '<fixture>/project',
      last_seen_reason: 'pre_tool_use',
    }),
  });
  expect(outcome.shell.results).toEqual([{ exitCode: 0, stdout: '', stderr: '' }]);
});

test('three calls in a row agree between the typed and the shell heartbeat', async () => {
  const outcome = await bothRoutes((f) => f.payload('Bash', { command: 'echo safe' }), 3);
  expect(outcome.typed).toEqual(outcome.shell);
  expect(outcome.shell.results).toHaveLength(3);
});

test('a session that already holds a lease is refreshed the same way by both routes', async () => {
  const outcome = await bothRoutes((f) => {
    const leases = path.join(f.project, '.caws/leases');
    fs.mkdirSync(leases);
    fs.writeFileSync(
      path.join(leases, SESSION + '.json'),
      JSON.stringify({
        lease_version: 1,
        session_id: SESSION,
        platform: 'codex',
        status: 'active',
        started_at: '2026-01-01T00:00:00.000Z',
        last_active: '2026-01-01T00:00:00.000Z',
        repo_root: f.project,
        cwd: f.project,
        last_seen_reason: 'session_start',
      })
    );
    f.payload('Bash', { command: 'echo safe' });
  });
  expect(outcome.typed).toEqual(outcome.shell);
  expect(outcome.shell.leases[SESSION + '.json'].last_seen_reason).toBe('pre_tool_use');
});
