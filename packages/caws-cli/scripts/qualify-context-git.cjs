#!/usr/bin/env node
'use strict';

// Actual native frontend + compiled engine + selected stock guard. Retains
// fixture state and observations; this is not installed-harness or residency proof.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { installMachineRuntime } = require('../dist/init/machine-adapters');
const { validateSystemPolicy } = require('../dist/init/system-project-policy');

const options = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i],
    value = process.argv[i + 1];
  assert(
    ['--native', '--node', '--artifacts'].includes(key) && value && !options.has(key),
    'usage: qualify-context-git.cjs --native <absolute> --node <absolute> --artifacts <fresh absolute>'
  );
  assert(path.isAbsolute(value));
  options.set(key, value);
}
assert.equal(options.size, 3);
const native = fs.realpathSync(options.get('--native'));
const node = fs.realpathSync(options.get('--node'));
const root = options.get('--artifacts');
fs.mkdirSync(root); // Existing artifacts are never overwritten or removed.
const engine = path.resolve(__dirname, '../dist/runtime/engine-entry.js');
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const put = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n',
    { flag: 'wx' }
  );
};
const quote = (value) => "'" + value.replace(/'/g, "'\\''") + "'";
const baseEnvironment = {
  HOME: path.join(root, 'user'),
  CAWS_HOME: path.join(root, 'machine'),
  PATH: path.dirname(node) + ':/usr/bin:/bin',
  CAWS_TRAP_KILL: '0',
  TMPDIR: root,
  LANG: 'en_US.UTF-8',
  LC_ALL: 'en_US.UTF-8',
};
fs.mkdirSync(baseEnvironment.HOME);
const commands = [];
function git(cwd, args) {
  const result = cp.spawnSync('/usr/bin/git', args, {
    cwd,
    env: baseEnvironment,
    encoding: 'utf8',
    timeout: 10000,
  });
  commands.push({
    argv: ['/usr/bin/git', ...args],
    cwd,
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  });
  put(path.join(root, 'setup-' + commands.length + '.json'), commands.at(-1));
  assert.equal(result.status, 0, result.stderr);
}
const installed = installMachineRuntime({
  home: baseEnvironment.CAWS_HOME,
  templatesRoot: path.resolve(__dirname, '../templates/hook-packs'),
});
const defaults = JSON.parse(
  fs.readFileSync(
    path.join(baseEnvironment.CAWS_HOME, 'lib/runtimes', installed.digest, 'system-policy.json')
  )
);
put(path.join(baseEnvironment.CAWS_HOME, 'surfaces/codex/settings.json'), {
  version: 1,
  enabled: true,
});
const policy = {
  disabled: {
    pre_tool_use: [
      ...new Set(defaults.events.pre_tool_use.map((entry) => entry.split(' ')[0])),
    ].filter((name) => name !== 'block-dangerous.sh'),
  },
  extensions: {},
  handlers: {},
  libraries: {},
};
function project(name) {
  const directory = path.join(root, name);
  fs.mkdirSync(directory);
  git(directory, ['init', '-q']);
  put(path.join(directory, 'owned.txt'), 'Tracked qualification input\n');
  git(directory, ['add', '--', 'owned.txt']);
  git(directory, [
    '-c',
    'user.name=CAWS qualification',
    '-c',
    'user.email=qualification@example.invalid',
    'commit',
    '-qm',
    'Qualification fixture',
  ]);
  put(path.join(directory, '.caws/policy.yaml'), 'version: 1\n');
  fs.mkdirSync(path.join(directory, '.caws/specs'));
  validateSystemPolicy(directory, policy, {
    files: [...installed.files],
    defaults: defaults.events,
  });
  put(path.join(baseEnvironment.CAWS_HOME, 'state/projects', hash(directory) + '.json'), {
    version: 1,
    root: directory,
    surfaces: { codex: policy },
  });
  return directory;
}
const first = project('project-a'),
  second = project('project-b');
const linked = path.join(root, 'linked-a');
git(first, ['worktree', 'add', '--detach', linked]);
for (const checkout of [first, second, linked]) {
  fs.unlinkSync(path.join(checkout, 'owned.txt'));
  git(checkout, ['add', '-u', '--', 'owned.txt']);
}
const pins = {
  native: hash(fs.readFileSync(native)),
  node: hash(fs.readFileSync(node)),
  engine: hash(fs.readFileSync(engine)),
};
put(path.join(root, 'inputs.json'), {
  native,
  node,
  engine,
  pins,
  runtimeDigest: installed.digest,
  policy,
  limits: [
    'Direct native invoke, not an installed entry or vendor callback',
    'One-shot clients, not resident reuse or thirteen-session qualification',
    'Only stock dangerous-command guard selected; full hook and containment parity unverified',
  ],
});

const active = new Map();
const observedCustody = [];
function launch(name, cwd, session, overrides = {}, command = 'git commit -m unrelated') {
  const directory = path.join(root, name);
  fs.mkdirSync(directory);
  const payload = { cwd, session_id: session, tool_name: 'Bash', tool_input: { command } };
  const input = JSON.stringify(payload, null, 2) + '\n';
  put(path.join(directory, 'input.json'), input);
  const argv = [
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
    '10000',
    '--configuration',
    'system',
  ];
  const child = cp.spawn(native, argv, {
    cwd,
    env: { ...baseEnvironment, CODEX_THREAD_ID: session, ...overrides },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const start = Date.now();
  put(path.join(directory, 'started.json'), {
    argv: [native, ...argv],
    cwd,
    pid: child.pid,
    session,
    inputSha256: hash(input),
    overrides,
  });
  let stdout = Buffer.alloc(0),
    stderr = Buffer.alloc(0);
  child.stdout.on('data', (bytes) => {
    stdout = Buffer.concat([stdout, bytes]);
  });
  child.stderr.on('data', (bytes) => {
    stderr = Buffer.concat([stderr, bytes]);
  });
  child.stdin.on('error', () => {});
  const terminal = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      active.delete(child);
      put(path.join(directory, 'stdout.log'), stdout.toString());
      put(path.join(directory, 'stderr.log'), stderr.toString());
      const row = {
        code,
        signal,
        elapsedMs: Date.now() - start,
        pid: child.pid,
        stdoutSha256: hash(stdout),
        stderrSha256: hash(stderr),
      };
      put(path.join(directory, 'terminal.json'), row);
      resolve({ ...row, stdout: stdout.toString(), stderr: stderr.toString() });
    });
  });
  active.set(child, terminal);
  child.stdin.end(input);
  return { child, terminal, directory, inputSha256: hash(input) };
}
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
function guardJournal(canonical, session, checkout, inputSha256, stdout) {
  const directory = path.join(canonical, '.caws/sessions', session, 'hook-invocations');
  const files = fs.readdirSync(directory);
  assert.equal(files.length, 1, 'exact one invocation journal');
  const rows = fs
    .readFileSync(path.join(directory, files[0]), 'utf8')
    .trim()
    .split('\n')
    .map(JSON.parse);
  assert.equal(rows[0].stage, 'invocation_started');
  assert.equal(rows[0].dispatch_cwd, checkout);
  assert.equal(rows[0].runtime_digest, installed.digest);
  assert.equal(rows[0].resolved_session_id, session);
  assert.equal(rows[0].input_sha256, inputSha256);
  assert.equal(rows[0].selected_handlers.length, 1);
  assert.equal(rows[0].selected_handlers[0].name, 'block-dangerous.sh');
  assert.equal(rows[0].selected_handlers[0].kind, 'stock');
  const guard = rows.find(
    (row) => row.stage === 'handler_completed' && row.handler === 'block-dangerous.sh'
  );
  assert(guard, 'selected stock guard must complete');
  assert.equal(guard.exit_code, 0, 'stock protective JSON is promoted by composer');
  assert.equal(
    guard.source_sha256,
    hash(
      fs.readFileSync(
        path.join(baseEnvironment.CAWS_HOME, 'lib/runtimes', installed.digest, 'block-dangerous.sh')
      )
    )
  );
  assert.equal(Buffer.from(guard.stdout_base64, 'base64').toString(), stdout);
  assert.equal(rows.at(-1).stage, 'adapter_finished');
  assert.equal(rows.at(-1).exit_code, 2);
  assert(
    rows.every(
      (row) =>
        row.invocation_id === rows[0].invocation_id &&
        row.input_sha256 === inputSha256 &&
        row.runtime_digest === installed.digest
    )
  );
  return { path: path.join(directory, files[0]), invocationId: rows[0].invocation_id };
}
async function refused(invocation, canonical, session, checkout) {
  const result = await bounded(invocation.terminal, 15000, 'native guard did not settle');
  assert.equal(result.code, 2, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.decision, 'block');
  assert.match(output.reason, /currently stages 1 deletion\(s\) of tracked files \(owned\.txt\)/);
  assert.match(output.reason, /danger latch was NOT armed/);
  return guardJournal(canonical, session, checkout, invocation.inputSha256, result.stdout);
}
function processRow(pid) {
  const observed = cp.spawnSync('/bin/ps', ['-p', String(pid), '-o', 'pid=,ppid=,pgid=,stat='], {
    encoding: 'utf8',
    timeout: 2000,
  });
  assert([0, 1].includes(observed.status), 'process observation failed');
  return observed.stdout.trim();
}
function topology(pids, frontendPid) {
  const rows = pids.map((pid) => ({ pid, row: processRow(pid) }));
  const parsed = rows.map(({ row }) => row.split(/\s+/));
  assert(
    parsed.every((row) => row.length === 4 && !row[3].startsWith('Z')),
    'original processes must be observed live'
  );
  assert.equal(Number(parsed[0][1]), pids[2], 'Git parent must be observed custodian');
  assert.equal(Number(parsed[0][2]), pids[0], 'Git must lead its private process group');
  assert.equal(Number(parsed[1][1]), pids[0], 'pipe holder must descend from original Git');
  assert.equal(
    Number(parsed[1][2]),
    pids[0],
    'pipe holder must remain in original private Git group'
  );
  assert.equal(
    Number(parsed[2][1]),
    frontendPid,
    'Git custodian must be directly owned by original native frontend'
  );
  const command = cp.spawnSync('/bin/ps', ['-p', String(pids[2]), '-o', 'command='], {
    encoding: 'utf8',
    timeout: 2000,
  });
  assert.equal(command.status, 0);
  assert(
    command.stdout.includes(native + ' context-git-custodian '),
    'original parent must execute native Git custodian mode'
  );
  return { rows, custodianCommand: command.stdout.trim() };
}
async function waitPids(file, count = 3) {
  for (let i = 0; i < 200; i++) {
    if (fs.existsSync(file)) {
      const values = fs.readFileSync(file, 'utf8').trim().split(/\s+/).map(Number);
      if (
        values.length === count &&
        values.every((value) => Number.isSafeInteger(value) && value > 1)
      )
        return values;
    }
    await delay(10);
  }
  throw new Error('slow Git child did not expose its original process identities');
}
async function settled(pids, directory) {
  const observations = [];
  for (let i = 0; i < 100; i++) {
    const rows = pids.map((pid) => ({ pid, row: processRow(pid) }));
    observations.push({ at: Date.now(), rows });
    // A zombie is no longer executing, but does not establish reaping. Keep
    // observing until each original process has disappeared from the table.
    if (rows.every(({ row }) => row === '')) {
      put(path.join(directory, 'settlement-observations.json'), observations);
      return;
    }
    await delay(20);
  }
  put(path.join(directory, 'settlement-observations.json'), observations);
  throw new Error(
    'original Git/custodian processes remain live; preserved fixture, no next scenario'
  );
}
async function main() {
  const ordinary = await refused(launch('ordinary', first, 'ordinary'), first, 'ordinary', first);
  const linkedResult = await refused(launch('linked', linked, 'linked'), first, 'linked', linked);
  assert.notEqual(ordinary.invocationId, linkedResult.invocationId);
  const results = [];
  for (const crossRepository of [false, true])
    for (const signal of ['SIGTERM', 'SIGKILL']) {
      const name = (crossRepository ? 'cross-' : 'same-') + signal.toLowerCase();
      const observation = path.join(root, name + '-git-pids');
      const wrapper = path.join(root, name + '-git');
      put(
        wrapper,
        '#!/bin/sh\nsleep 30 &\nchild=$!\nprintf "%s %s %s\\n" "$$" "$child" "$PPID" > ' +
          quote(observation) +
          '\nwait\n'
      );
      fs.chmodSync(wrapper, 0o700);
      const a = launch(
        name + '-a',
        first,
        name + '-a',
        { CAWS_GIT_BINARY: wrapper },
        'echo harmless'
      );
      const pids = await waitPids(observation);
      observedCustody.push({ pids, directory: a.directory });
      put(path.join(a.directory, 'live-processes.json'), topology(pids, a.child.pid));
      const bRepo = crossRepository ? second : first;
      const bStarted = path.join(root, name + '-b-started');
      const bRelease = path.join(root, name + '-b-release');
      const bWrapper = path.join(root, name + '-b-git');
      put(
        bWrapper,
        '#!/bin/sh\nprintf "%s %s\\n" "$$" "$PPID" > ' +
          quote(bStarted) +
          '\nwhile [ ! -f ' +
          quote(bRelease) +
          ' ]; do /bin/sleep 0.01; done\nexec /usr/bin/git "$@"\n'
      );
      fs.chmodSync(bWrapper, 0o700);
      const b = launch(name + '-b', bRepo, name + '-b', { CAWS_GIT_BINARY: bWrapper });
      const bPids = await waitPids(bStarted, 2);
      const bRows = bPids.map((pid) => ({ pid, row: processRow(pid) }));
      assert(
        bRows.every(({ row }) => row && !/\sZ\S*$/.test(row)),
        'B must be observed in flight before A cancellation'
      );
      put(path.join(b.directory, 'before-a-cancellation.json'), bRows);
      assert(a.child.kill(signal), 'original frontend did not accept cancellation signal');
      const aResult = await bounded(a.terminal, 15000, 'cancelled frontend did not terminate');
      if (signal === 'SIGKILL') assert.equal(aResult.signal, signal);
      else assert.equal(aResult.code, 2, aResult.stderr);
      await settled(pids, a.directory);
      const bSurvived = bPids.map((pid) => ({ pid, row: processRow(pid) }));
      assert(
        bSurvived.every(({ row }) => row && !/\sZ\S*$/.test(row)),
        'B original Git and custodian must survive A settlement'
      );
      put(path.join(b.directory, 'after-a-settlement.json'), bSurvived);
      put(bRelease, 'continue\n');
      const bJournal = await refused(b, bRepo, name + '-b', bRepo);
      assert(
        !fs.existsSync(path.join(first, '.caws/sessions', name + '-a', 'hook-invocations')),
        'cancelled pre-Ready A acquired a journal'
      );
      results.push({ name, a: aResult, b: bJournal, originalGitPids: pids });
    }
  assert.deepEqual(
    {
      native: hash(fs.readFileSync(native)),
      node: hash(fs.readFileSync(node)),
      engine: hash(fs.readFileSync(engine)),
    },
    pins
  );
  put(path.join(root, 'result.json'), {
    status: 'passed',
    ordinary,
    linked: linkedResult,
    cases: results,
    pins,
  });
  process.stdout.write(
    JSON.stringify({ status: 'passed', artifacts: root, cases: results.length }) + '\n'
  );
}
main().catch(async (error) => {
  // Signal only original live Child handles. Custodians retain private Git
  // groups after frontend loss; never kill a PID learned from a fixture file.
  const pending = [...active];
  for (const [child] of pending) child.kill('SIGTERM');
  const cleanup = [];
  for (const [child, terminal] of pending) {
    try {
      await bounded(terminal, 15000, 'original frontend did not settle after failure');
    } catch (failure) {
      cleanup.push({ pid: child.pid, error: String(failure) });
    }
  }
  for (const { pids, directory } of observedCustody) {
    if (fs.existsSync(path.join(directory, 'settlement-observations.json'))) continue;
    try {
      await settled(pids, directory);
    } catch (failure) {
      cleanup.push({ pids, error: String(failure) });
    }
  }
  put(path.join(root, 'failure.json'), { message: String(error), stack: error.stack, cleanup });
  process.stderr.write(String(error.stack || error) + '\n');
  process.exitCode = 1;
});
