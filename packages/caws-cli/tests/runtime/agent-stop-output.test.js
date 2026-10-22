'use strict';

// Installed stock-hook component controls. These execute the candidate CLI and
// selected immutable runtime scripts, not the native owner or platform harness.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { installMachineRuntime } = require('../../dist/init/machine-adapters');
const { resolveInvocationSelection } = require('../../dist/runtime/selection');
const { normalizeNativeResult } = require('../../dist/runtime/native-response');

// Reuse the bounded raw-command/retention helper, accepting this suite's public
// artifact destination without changing the helper or other suites' settings.
const previousArtifactRoot = process.env.CAWS_RUNTIME_ASSET_ARTIFACT_ROOT;
if (process.env.CAWS_TEST_ARTIFACT_DIR)
  process.env.CAWS_RUNTIME_ASSET_ARTIFACT_ROOT = process.env.CAWS_TEST_ARTIFACT_DIR;
const { scenario, temporaryRoot, invoke, succeeds } = require('./runtime-asset-fixture')();
if (previousArtifactRoot === undefined) delete process.env.CAWS_RUNTIME_ASSET_ARTIFACT_ROOT;
else process.env.CAWS_RUNTIME_ASSET_ARTIFACT_ROOT = previousArtifactRoot;

const cli = path.resolve(__dirname, '../..');
const cliEntry = path.join(cli, 'dist/index.js');
const templates =
  process.env.CAWS_AGENT_STOP_TEMPLATE_ROOT ?? path.join(cli, 'templates/hook-packs');
if (!path.isAbsolute(templates)) throw new Error('Agent stop template root must be absolute');
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
function put(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value, null, 2)
  );
}
function fixture(label, { heartbeat = false, goal = false } = {}) {
  const root = temporaryRoot();
  const project = path.join(root, 'project');
  const home = path.join(root, 'machine');
  const session = label + '-self';
  fs.mkdirSync(path.join(project, '.caws/specs'), { recursive: true });
  fs.mkdirSync(path.join(root, 'git-template'));
  put(path.join(project, '.caws/policy.yaml'), 'version: 1\n');
  const env = {
    HOME: root,
    XDG_CONFIG_HOME: path.join(root, 'config'),
    PATH: path.dirname(process.execPath) + ':' + process.env.PATH,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TEMPLATE_DIR: path.join(root, 'git-template'),
    GIT_TERMINAL_PROMPT: '0',
    CAWS_HOME: home,
    CAWS_PROJECT_DIR: project,
    CAWS_BIN: cliEntry,
    CLAUDE_CODE_SESSION_ID: session,
    CAWS_TRAP_KILL: '0',
    CAWS_HOOK_ADVISORY_DEDUP: '0',
    CAWS_HOOK_ADVISORY_BUDGET_BYTES: '32768',
  };
  succeeds(invoke(root, '/usr/bin/git', ['init', '-q', '-b', 'main', project], undefined, { env }));
  const installed = installMachineRuntime({ home, templatesRoot: templates });
  const runtime = path.join(home, 'lib/runtimes', installed.digest);
  const defaults = JSON.parse(fs.readFileSync(path.join(runtime, 'system-policy.json')));
  const kept = goal ? ['goal-ac-gate.sh', 'agent-stop.sh'] : ['agent-stop.sh'];
  const policy = {
    disabled: {
      stop: defaults.events.stop
        .map((entry) => entry.split(' ')[0])
        .filter((name) => !kept.includes(name)),
    },
    extensions: heartbeat
      ? { stop: [{ handler: 'agent-heartbeat.sh', before: 'agent-stop.sh' }] }
      : {},
    handlers: {},
    libraries: {},
  };
  put(path.join(home, 'surfaces/codex/settings.json'), { version: 1, enabled: true });
  put(path.join(home, 'state/projects', sha(project) + '.json'), {
    version: 1,
    root: project,
    surfaces: { codex: policy },
  });
  const selection = resolveInvocationSelection({
    checkout: project,
    canonical: project,
    home,
    runtimeDigest: installed.digest,
    surface: 'codex',
    event: 'stop',
    system: true,
  });
  put(path.join(root, 'identity.json'), {
    label,
    claim: 'private installed stock-handler and Bash composition component',
    nonclaims: ['native service execution', 'platform delivery', 'full five-handler Stop chain'],
    node: { path: process.execPath, version: process.version },
    cli: { path: cliEntry, sha256: sha(fs.readFileSync(cliEntry)) },
    templateRoot: { path: templates, actualPath: fs.realpathSync(templates) },
    source: {
      path: path.join(templates, 'shared/agent-stop.sh'),
      sha256: sha(fs.readFileSync(path.join(templates, 'shared/agent-stop.sh'))),
    },
    installed,
    selection,
    environment: env,
  });
  expect(selection.status).toBe('active');
  expect(selection.handlers.map((handler) => handler.name)).toEqual(
    goal
      ? ['goal-ac-gate.sh', 'agent-stop.sh']
      : heartbeat
        ? ['agent-heartbeat.sh', 'agent-stop.sh']
        : ['agent-stop.sh']
  );
  for (const handler of selection.handlers) {
    expect(handler.kind).toBe('stock');
    expect(handler.path).toBe(path.join(runtime, handler.name));
    expect(handler.sha256).toBe(sha(fs.readFileSync(handler.path)));
  }
  let sequence = 0;
  const command = (args) =>
    invoke(root, process.execPath, [cliEntry, ...args], undefined, { env, cwd: project });
  const register = (sid) => {
    const result = command([
      'agents',
      'register',
      '--session-id',
      sid,
      '--platform',
      'codex',
      '--json',
    ]);
    succeeds(result);
    expect(JSON.parse(result.stdout).ok).toBe(true);
    expect(
      JSON.parse(fs.readFileSync(path.join(project, '.caws/leases', sid + '.json'))).status
    ).toBe('active');
    return result;
  };
  const leasePath = (sid) => path.join(project, '.caws/leases', sid + '.json');
  const dispatch = (sid = session) => {
    const execution = path.join(root, 'execution-' + ++sequence + '.jsonl');
    const payload = Buffer.from(
      JSON.stringify({ cwd: project, session_id: sid, hook_event_name: 'Stop' })
    );
    const result = invoke(
      root,
      '/bin/bash',
      [
        path.join(runtime, 'dispatch.sh'),
        'codex',
        'stop',
        selection.hooksDirectory,
        ...selection.handlers.map((handler) => handler.entry),
      ],
      payload,
      {
        env: { ...env, CLAUDE_CODE_SESSION_ID: sid, CAWS_HOOK_EXECUTION_FILE: execution },
        cwd: project,
      }
    );
    const records = fs
      .readFileSync(execution, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    put(path.join(root, 'dispatch-' + sequence + '.json'), {
      receipt: result.receipt,
      execution,
      records,
    });
    return { ...result, records };
  };
  return { root, project, session, register, command, dispatch, leasePath };
}

scenario(
  'stock stop changes its actual lease and preserves a peer without emitting hook context',
  () => {
    const f = fixture('stop-output');
    f.register(f.session);
    f.register('untouched-peer');
    const peer = fs.readFileSync(f.leasePath('untouched-peer'));
    const before = fs.readFileSync(f.leasePath(f.session));
    put(path.join(f.root, 'before-leases.json'), {
      self: JSON.parse(before),
      peer: JSON.parse(peer),
    });
    const result = f.dispatch();
    succeeds(result);
    expect(result.stdout.toString()).toBe('');
    expect(result.stderr.toString()).toContain('[agent-stop.sh] stopped ' + f.session + '\n');
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({
      handler: 'agent-stop.sh',
      status: 'completed',
      exit_code: 0,
      stdout: '',
      stderr: 'stopped ' + f.session + '\n',
    });
    const self = JSON.parse(fs.readFileSync(f.leasePath(f.session)));
    expect(self.status).toBe('stopped');
    expect(typeof self.stopped_at).toBe('string');
    expect(Number.isFinite(Date.parse(self.stopped_at))).toBe(true);
    expect(fs.readFileSync(f.leasePath('untouched-peer'))).toEqual(peer);
    expect(JSON.parse(before).status).toBe('active');
  }
);

scenario(
  'direct CLI human and JSON receipts remain intact; missing and broken leases keep hook best effort',
  () => {
    const f = fixture('stop-contract');
    f.register('human-stop');
    f.register('json-stop');
    const human = f.command([
      'agents',
      'stop',
      '--session-id',
      'human-stop',
      '--platform',
      'codex',
    ]);
    succeeds(human);
    expect(human.stdout.toString()).toBe('stopped human-stop\n');
    const json = f.command([
      'agents',
      'stop',
      '--session-id',
      'json-stop',
      '--platform',
      'codex',
      '--json',
    ]);
    succeeds(json);
    expect(JSON.parse(json.stdout)).toMatchObject({
      ok: true,
      session_id: 'json-stop',
      wrote: true,
    });
    for (const sid of ['human-stop', 'json-stop'])
      expect(JSON.parse(fs.readFileSync(f.leasePath(sid))).status).toBe('stopped');
    const priorNames = fs.readdirSync(path.dirname(f.leasePath('missing-stop'))).sort();
    const missing = f.dispatch('missing-stop');
    succeeds(missing);
    expect(missing.stdout.toString()).toBe('');
    expect(missing.stderr.toString()).toContain(
      '[agent-stop.sh] no prior lease for missing-stop (no-op)\n'
    );
    expect(fs.existsSync(f.leasePath('missing-stop'))).toBe(false);
    expect(fs.readdirSync(path.dirname(f.leasePath('missing-stop'))).sort()).toEqual(priorNames);
    // Individual malformed files are skipped. A non-directory at the leases
    // path exercises the real strict load failure without permissions guesses.
    const leases = path.dirname(f.leasePath('human-stop'));
    const retainedLeases = path.join(f.root, 'leases-before-load-failure');
    const unchanged = fs.readFileSync(f.leasePath('human-stop'));
    fs.renameSync(leases, retainedLeases);
    put(leases, 'not a lease directory\n');
    const refused = f.command([
      'agents',
      'stop',
      '--session-id',
      'human-stop',
      '--platform',
      'codex',
    ]);
    expect(refused.status).toBe(2);
    expect(refused.stderr.toString()).toContain('lease directory unreadable');
    const broken = f.dispatch('human-stop');
    succeeds(broken);
    expect(broken.stdout.toString()).toBe('');
    expect(broken.stderr.toString()).toBe('');
    expect(fs.readFileSync(path.join(retainedLeases, 'human-stop.json'))).toEqual(unchanged);
    expect(fs.readFileSync(leases, 'utf8')).toBe('not a lease directory\n');
  }
);

scenario(
  'natural real-peer heartbeat advice survives the selected stock stop and native normalization exactly',
  () => {
    const f = fixture('stop-advice', { heartbeat: true });
    for (const sid of [f.session, 'natural-peer-a', 'natural-peer-b']) f.register(sid);
    const peers = ['natural-peer-a', 'natural-peer-b'].map((sid) => [
      sid,
      fs.readFileSync(f.leasePath(sid)),
    ]);
    const result = f.dispatch();
    succeeds(result);
    expect(result.records.map((record) => record.handler)).toEqual([
      'agent-heartbeat.sh',
      'agent-stop.sh',
    ]);
    expect(
      result.records.every((record) => record.status === 'completed' && record.exit_code === 0)
    ).toBe(true);
    const produced = JSON.parse(result.records[0].stdout);
    const advice = produced.hookSpecificOutput.additionalContext;
    expect(advice).toContain('MULTI-AGENT NOTICE');
    for (const [sid, bytes] of peers) {
      expect(advice).toContain(sid);
      expect(fs.readFileSync(f.leasePath(sid))).toEqual(bytes);
    }
    expect(JSON.parse(result.stdout)).toEqual(produced);
    expect(result.stderr.toString()).not.toContain('optional advisories omitted');
    expect(result.records[1]).toMatchObject({ stdout: '', stderr: 'stopped ' + f.session + '\n' });
    const native = normalizeNativeResult(
      { surface: 'codex', event: 'stop', runtimeDigest: 'component-normalization' },
      { exitCode: result.status, stdout: result.stdout, stderr: result.stderr }
    );
    put(path.join(f.root, 'normalized.stdout.bin'), native.stdout);
    put(path.join(f.root, 'normalized.stderr.bin'), native.stderr);
    expect(Buffer.from(native.stdout)).toEqual(result.stdout);
    expect(JSON.parse(native.stdout).hookSpecificOutput.additionalContext).toBe(advice);
    expect(JSON.parse(fs.readFileSync(f.leasePath(f.session))).status).toBe('stopped');
  }
);

scenario(
  'a preceding real goal refusal preserves control bytes and leaves the stop lease untouched',
  () => {
    const f = fixture('stop-refusal', { goal: true });
    f.register(f.session);
    const before = fs.readFileSync(f.leasePath(f.session));
    // Corrupt goal state is a real fail-closed guard input, not a stub producer.
    put(path.join(f.project, '.caws/sessions', f.session, 'goal.json'), '{unreadable-goal');
    const result = f.dispatch();
    expect(result.status).toBe(2);
    expect(result.records).toHaveLength(1);
    expect(result.records[0].handler).toBe('goal-ac-gate.sh');
    const produced = result.records[0].stdout;
    expect(JSON.parse(produced)).toMatchObject({ decision: 'block' });
    expect(JSON.parse(produced).reason).toContain('binding');
    expect(result.stdout.toString()).toBe(produced + '\n');
    expect(fs.readFileSync(f.leasePath(f.session))).toEqual(before);
    expect(result.stderr.toString()).not.toContain('stopped ' + f.session);
  }
);
