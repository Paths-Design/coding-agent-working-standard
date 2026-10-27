const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const { AbortController } = globalThis;
const { setTimeout, clearTimeout } = require('node:timers');
const { installMachineRuntime } = require('../../dist/init/machine-adapters');
const { validateSystemPolicy } = require('../../dist/init/system-project-policy');
const { prepareRuntimeInvocation } = require('../../dist/runtime/engine');
const templates = path.resolve(__dirname, '../../templates/hook-packs');
const quote = (text) => "'" + text.replace(/'/g, "'\\''") + "'";

test('a selected project override receives complete Codex normalization through compatibility dispatch', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'caws-engine-route-')));
  const repo = path.join(root, 'project');
  const home = path.join(root, 'machine');
  fs.mkdirSync(repo);
  const put = (file, value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  };
  const environment = {
    PATH: '/usr/bin:/bin',
    HOME: root,
    CAWS_HOME: home,
    CODEX_THREAD_ID: 'routing-fixture',
    CAWS_TRAP_KILL: '0',
    CAWS_NATIVE_CONTAINMENT_FILE: '/caller/forged-capability',
    CONSUMED_FILE: path.join(root, 'consumed.json'),
  };
  try {
    const git = cp.spawnSync('/usr/bin/git', ['init', '-q'], { cwd: repo, env: environment });
    expect(git.status).toBe(0);
    put(path.join(repo, '.caws/policy.yaml'), 'version: 1\n');
    fs.mkdirSync(path.join(repo, '.caws/specs'));
    const script = path.join(repo, '.caws/hooks/guard.cjs');
    const override = path.join(repo, '.caws/hooks/guard.sh');
    put(
      script,
      "const fs=require('node:fs');const names=['HOOK_TOOL_NAME','HOOK_ORIGINAL_TOOL_NAME','HOOK_FILE_PATH','HOOK_FILE_PATHS','CAWS_NATIVE_CONTAINMENT_FILE'];const consumed=Object.fromEntries(names.map(name=>[name,process.env[name]??null]));fs.writeFileSync(process.env.CONSUMED_FILE,JSON.stringify(consumed));if(consumed.HOOK_ORIGINAL_TOOL_NAME==='Bash'&&consumed.HOOK_FILE_PATHS==='/owned/file'){process.stdout.write(JSON.stringify({decision:'block',reason:'normalized extension refusal'}));process.exitCode=2;}"
    );
    put(override, '#!/bin/bash\nexec ' + quote(process.execPath) + ' ' + quote(script) + '\n');
    fs.chmodSync(override, 0o755);
    const installed = installMachineRuntime({ home, templatesRoot: templates });
    const defaults = JSON.parse(
      fs.readFileSync(path.join(home, 'lib/runtimes', installed.digest, 'system-policy.json'))
    );
    const policy = {
      disabled: {
        pre_tool_use: [
          ...new Set(
            defaults.events.pre_tool_use
              .map((entry) => entry.split(' ')[0])
              .filter((name) => name !== 'block-dangerous.sh')
          ),
        ],
      },
      extensions: {},
      handlers: { 'block-dangerous.sh': '.caws/hooks/guard.sh' },
      libraries: {},
    };
    validateSystemPolicy(repo, policy, { files: [...installed.files], defaults: defaults.events });
    put(path.join(home, 'surfaces/codex/settings.json'), { version: 1, enabled: true });
    const projectDigest = crypto.createHash('sha256').update(repo).digest('hex');
    put(path.join(home, 'state/projects', projectDigest + '.json'), {
      version: 1,
      root: repo,
      surfaces: { codex: policy },
    });
    const payload = {
      cwd: repo,
      session_id: 'routing-fixture',
      tool_name: 'Bash',
      tool_input: { command: 'echo safe', file_path: '/owned/file' },
    };
    const request = {
      schema: 'caws.runtime.request.v1',
      id: 'routing-invocation',
      runtimeDigest: installed.digest,
      surface: 'codex',
      event: 'pre_tool_use',
      configuration: 'system',
      caller: { processId: process.pid, cwd: repo, environment },
      deadlineEpochMs: Date.now() + 15000,
      inputJson: JSON.stringify(payload),
      payload,
    };
    const invocation = await prepareRuntimeInvocation(request, new AbortController().signal);
    expect(invocation.active).toBe(true);
    const { nativeResult: result, containment } = await invocation.dispatch();
    expect(containment).toBeNull();
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(Buffer.from(result.stdout).toString()).reason).toBe(
      'normalized extension refusal'
    );
    expect(JSON.parse(fs.readFileSync(environment.CONSUMED_FILE))).toEqual({
      HOOK_TOOL_NAME: 'Bash',
      HOOK_ORIGINAL_TOOL_NAME: 'Bash',
      HOOK_FILE_PATH: '/owned/file',
      HOOK_FILE_PATHS: '/owned/file',
      CAWS_NATIVE_CONTAINMENT_FILE: null,
    });
    await invocation.acknowledgeHandoff(true);
    const rows = fs
      .readFileSync(
        path.join(repo, '.caws/sessions/routing-fixture/hook-invocations/routing-invocation.jsonl'),
        'utf8'
      )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(rows.map((row) => row.stage)).toContain('compatibility_dispatch_completed');
    expect(rows.map((row) => row.stage)).not.toContain('handler_started');
    expect(rows.at(-1)).toMatchObject({ stage: 'adapter_finished', exit_code: 2 });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 20000);

// These are routing/ordering checks with an injected native port. The installed
// stock prefix is real and admission is unmocked; native publication is tested
// separately by the Rust invocation fixtures.
function cacheFixture(handlers = ['block-dangerous.sh']) {
  const base = process.env.CAWS_TEST_ARTIFACT_DIR;
  const root = fs.realpathSync(fs.mkdtempSync(path.join(base || os.tmpdir(), 'cache-engine-')));
  const repo = path.join(root, 'project');
  const home = path.join(root, 'machine');
  const put = (file, value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  };
  fs.mkdirSync(repo);
  const environment = {
    PATH: path.dirname(process.execPath) + ':/usr/bin:/bin',
    HOME: root,
    CAWS_HOME: home,
    CAWS_TRAP_KILL: '0',
  };
  const git = cp.spawnSync('/usr/bin/git', ['init', '-q'], { cwd: repo, env: environment });
  expect(git.status).toBe(0);
  put(path.join(repo, '.caws/policy.yaml'), 'version: 1\n');
  fs.mkdirSync(path.join(repo, '.caws/specs'));
  const installed = installMachineRuntime({ home, templatesRoot: templates });
  const runtime = path.join(home, 'lib/runtimes', installed.digest);
  const defaults = JSON.parse(fs.readFileSync(path.join(runtime, 'system-policy.json')));
  const policy = {
    disabled: {
      pre_tool_use: [
        ...new Set(defaults.events.pre_tool_use.map((entry) => entry.split(' ')[0])),
      ].filter((name) => !handlers.includes(name)),
    },
    extensions: {},
    handlers: {},
    libraries: {},
  };
  validateSystemPolicy(repo, policy, { files: [...installed.files], defaults: defaults.events });
  put(path.join(home, 'surfaces/codex/settings.json'), { version: 1, enabled: true });
  put(
    path.join(
      home,
      'state/projects',
      crypto.createHash('sha256').update(repo).digest('hex') + '.json'
    ),
    {
      version: 1,
      root: repo,
      surfaces: { codex: policy },
    }
  );
  let next = 0;
  return {
    root,
    repo,
    home,
    runtime,
    put,
    environment,
    digest: installed.digest,
    request(payloadChanges = {}) {
      const payload = {
        cwd: repo,
        session_id: 'cache-fixture',
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf /' },
        ...payloadChanges,
      };
      return {
        schema: 'caws.runtime.request.v1',
        id: 'cache-routing-' + ++next,
        runtimeDigest: installed.digest,
        surface: 'codex',
        event: 'pre_tool_use',
        configuration: 'system',
        sessionCache: 'caws.runtime.session-cache.v1',
        caller: { processId: process.pid, cwd: repo, environment },
        deadlineEpochMs: Date.now() + 15000,
        inputJson: JSON.stringify(payload),
        payload,
      };
    },
    rows(request) {
      const file = path.join(
        repo,
        '.caws/sessions/cache-fixture/hook-invocations',
        request.id + '.jsonl'
      );
      return fs.existsSync(file)
        ? fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse)
        : [];
    },
    dispose() {
      if (!base) fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
const capturedCache = () => ({ status: 'captured', envelopePublished: true, diagnostic: null });
const turn = () => new Promise((accept) => setImmediate(accept));

// Only the observed UTC last-seen timestamp is dynamic in cache parity checks.
function normalizedCacheObservation(value, earliest) {
  expect(value.last_seen_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  const observed = Date.parse(value.last_seen_at);
  expect(Number.isFinite(observed)).toBe(true);
  expect(new Date(observed).toISOString()).toBe(value.last_seen_at.replace('Z', '.000Z'));
  expect(observed).toBeGreaterThanOrEqual(Math.floor(earliest / 1000) * 1000);
  expect(observed).toBeLessThanOrEqual(Date.now());
  return { ...value, last_seen_at: '<observed UTC>' };
}

test.each([
  'empty-chain',
  'early-refusal',
  'old-envelope-decline',
  'missing-sid',
  'pointer-failure',
  'overwritten-input-numeric',
  'host-nested',
  'host-linked-nested',
  'host-cross-worktree-raw',
  'host-nongit-origin',
])(
  'actual native exchange publishes only the supplied session prefix: %s',
  (scenario) => {
    const refusing = ['early-refusal', 'pointer-failure'].includes(scenario);
    const f = cacheFixture(refusing ? ['block-dangerous.sh'] : []);
    try {
      const native =
        process.env.CAWS_TEST_NATIVE_EXECUTABLE ||
        path.resolve(__dirname, '../../../caws-native/target/debug/caws-native');
      const engine = path.resolve(__dirname, '../../dist/runtime/engine-entry.js');
      const payload = {
        cwd: f.repo,
        session_id: 'cache-fixture',
        tool_name: 'Bash',
        tool_input: { command: refusing ? 'rm -rf /' : 'echo safe' },
        hook_event_name: 'forged event',
      };
      const hostScenario = scenario.startsWith('host-');
      const compatibilityOnly = [
        'overwritten-input-numeric',
        'host-cross-worktree-raw',
        'host-nongit-origin',
      ].includes(scenario);
      const createdSeed = '2000-01-02T03:04:05Z';
      if (['host-linked-nested', 'host-cross-worktree-raw'].includes(scenario)) {
        const git = (args) => {
          const observed = cp.spawnSync('/usr/bin/git', args, {
            cwd: f.repo,
            env: f.environment,
            encoding: 'utf8',
          });
          expect(observed.status).toBe(0);
        };
        f.put(path.join(f.repo, 'cache-worktree-seed.txt'), 'fixture\n');
        git(['add', 'cache-worktree-seed.txt']);
        git([
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=fixture@example.invalid',
          'commit',
          '-qm',
          'fixture',
        ]);
        const linked = path.join(f.root, 'linked-checkout');
        git(['worktree', 'add', '-q', '-b', 'cache-linked', linked]);
        const nested = path.join(linked, 'nested');
        fs.mkdirSync(nested);
        payload.cwd = scenario === 'host-cross-worktree-raw' ? f.repo : linked;
        payload.execution_workdir = nested;
      } else if (hostScenario) {
        const nested = path.join(f.repo, 'nested');
        fs.mkdirSync(nested);
        payload.execution_workdir = nested;
        if (scenario === 'host-nongit-origin') {
          const origin = path.join(f.root, 'nongit-session');
          fs.mkdirSync(origin);
          payload.cwd = origin;
        }
      }
      const envelope = path.join(f.repo, '.caws/sessions/cache-fixture/.session-envelope.json');
      const pointer = path.join(f.repo, '.caws/sessions/.caller-session.json');
      if (scenario === 'old-envelope-decline')
        f.put(envelope, {
          session_id: 'cache-fixture',
          created_at: '2000-01-02T03:04:05Z',
          unused: 1,
        });
      if (hostScenario)
        f.put(envelope, {
          session_id: 'cache-fixture',
          repo_root: f.repo,
          created_at: createdSeed,
          last_seen_at: createdSeed,
          hook_event: 'PreToolUse',
          platform: 'codex',
        });
      if (scenario === 'pointer-failure') fs.mkdirSync(pointer, { recursive: true });
      if (scenario === 'missing-sid') delete payload.session_id;
      const temporary = path.join(f.root, 'tmp');
      fs.mkdirSync(temporary);
      const args = [
        'invoke',
        '--engine',
        engine,
        '--node',
        process.execPath,
        '--surface',
        'codex',
        '--event',
        'pre_tool_use',
        '--runtime-digest',
        f.digest,
        '--timeout-ms',
        '12000',
        '--configuration',
        'system',
      ];
      const input =
        scenario === 'overwritten-input-numeric'
          ? JSON.stringify(payload).replace(/}$/, ',"unused":1,"unused":"last"}')
          : JSON.stringify(payload);
      const invocationStarted = Date.now();
      const result = cp.spawnSync(native, args, {
        cwd: f.repo,
        input,
        env: {
          ...f.environment,
          TMPDIR: temporary,
          CODEX_THREAD_ID: 'foreign-cache',
          CAWS_SESSION_ID: 'foreign-cache',
        },
        timeout: 20000,
        maxBuffer: 4 * 1024 * 1024,
      });
      f.put(path.join(f.root, 'native.stdout'), result.stdout.toString());
      f.put(path.join(f.root, 'native.stderr'), result.stderr.toString());
      f.put(path.join(f.root, 'native-input.json'), input);
      f.put(path.join(f.root, 'native-receipt.json'), {
        scenario,
        native,
        engine,
        args,
        cwd: f.repo,
        nativeSha256: crypto.createHash('sha256').update(fs.readFileSync(native)).digest('hex'),
        engineSha256: crypto.createHash('sha256').update(fs.readFileSync(engine)).digest('hex'),
        inputSha256: crypto.createHash('sha256').update(input).digest('hex'),
        status: result.status,
        signal: result.signal,
        error: result.error?.message || null,
      });
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status).toBe(refusing ? 2 : 0);
      if (scenario === 'missing-sid') {
        expect(fs.existsSync(envelope)).toBe(false);
        expect(fs.existsSync(pointer)).toBe(false);
        expect(fs.existsSync(path.join(f.repo, '.caws/sessions/foreign-cache'))).toBe(false);
      } else {
        const actual = JSON.parse(fs.readFileSync(envelope));
        expect(actual).toMatchObject({
          session_id: 'cache-fixture',
          repo_root: f.repo,
          platform: 'codex',
          hook_event: 'PreToolUse',
        });
        if (scenario === 'pointer-failure') {
          expect(fs.lstatSync(pointer).isDirectory()).toBe(true);
          expect(result.stderr.toString()).toContain(
            'session cache unavailable at Pointer; envelope_published=true'
          );
        } else
          expect(JSON.parse(fs.readFileSync(pointer))).toMatchObject({
            session_id: 'cache-fixture',
            repo_root: f.repo,
          });
        if (scenario === 'old-envelope-decline' || hostScenario)
          expect(actual.created_at).toBe(createdSeed);
        if (hostScenario) {
          normalizedCacheObservation(actual, invocationStarted);
          const actualPointer = JSON.parse(fs.readFileSync(pointer));
          expect(actualPointer).toEqual({
            session_id: 'cache-fixture',
            repo_root: f.repo,
            last_seen_at: actual.last_seen_at,
          });
        }
        const journals = path.join(f.repo, '.caws/sessions/cache-fixture/hook-invocations');
        const rows = fs
          .readdirSync(journals)
          .flatMap((name) =>
            fs.readFileSync(path.join(journals, name), 'utf8').trim().split('\n').map(JSON.parse)
          );
        const stages = rows.map((row) => row.stage);
        if (compatibilityOnly) {
          expect(stages).not.toContain('session_cache_completed');
          expect(
            stages.filter((stage) => stage === 'compatibility_dispatch_completed')
          ).toHaveLength(1);
        } else expect(stages).toContain('session_cache_completed');
        if (scenario === 'old-envelope-decline') {
          expect(rows.find((row) => row.stage === 'session_cache_completed').status).toBe(
            'declined'
          );
          expect(stages).toContain('compatibility_dispatch_completed');
        } else if (!compatibilityOnly)
          expect(stages).not.toContain('compatibility_dispatch_completed');
        if (refusing) {
          expect(JSON.parse(result.stdout.toString()).decision).toBe('block');
          expect(stages.indexOf('session_cache_completed')).toBeLessThan(
            stages.indexOf('handler_started')
          );
        }
        if (['host-nested', 'host-linked-nested'].includes(scenario)) {
          const nativeEnvelope = normalizedCacheObservation(actual, invocationStarted);
          const nativePointer = normalizedCacheObservation(
            JSON.parse(fs.readFileSync(pointer)),
            invocationStarted
          );
          const before = new Set(fs.readdirSync(journals));
          // This existing unsupported raw-number profile forces complete parser
          // compatibility without changing the supplied command or identities.
          const compatibilityInput = JSON.stringify(payload).replace(
            /}$/,
            ',"unused":1,"unused":"last"}'
          );
          const compatibilityStarted = Date.now();
          const compared = cp.spawnSync(native, args, {
            cwd: f.repo,
            input: compatibilityInput,
            env: {
              ...f.environment,
              TMPDIR: temporary,
              CODEX_THREAD_ID: 'foreign-cache',
              CAWS_SESSION_ID: 'foreign-cache',
            },
            timeout: 20000,
            maxBuffer: 4 * 1024 * 1024,
          });
          f.put(path.join(f.root, 'comparison-compat.stdout'), compared.stdout.toString());
          f.put(path.join(f.root, 'comparison-compat.stderr'), compared.stderr.toString());
          f.put(path.join(f.root, 'comparison-compat-input.json'), compatibilityInput);
          expect(compared.error).toBeUndefined();
          expect(compared.signal).toBeNull();
          expect(compared.status).toBe(0);
          const added = fs.readdirSync(journals).filter((name) => !before.has(name));
          expect(added).toHaveLength(1);
          const comparedRows = fs
            .readFileSync(path.join(journals, added[0]), 'utf8')
            .trim()
            .split('\n')
            .map(JSON.parse);
          const comparedStages = comparedRows.map((row) => row.stage);
          expect(comparedStages).not.toContain('session_cache_completed');
          expect(
            comparedStages.filter((stage) => stage === 'compatibility_dispatch_completed')
          ).toHaveLength(1);
          const shellEnvelope = JSON.parse(fs.readFileSync(envelope));
          const shellPointer = JSON.parse(fs.readFileSync(pointer));
          expect(shellPointer.last_seen_at).toBe(shellEnvelope.last_seen_at);
          expect(normalizedCacheObservation(shellEnvelope, compatibilityStarted)).toEqual(
            nativeEnvelope
          );
          expect(normalizedCacheObservation(shellPointer, compatibilityStarted)).toEqual(
            nativePointer
          );
          f.put(path.join(f.root, 'actual-cache-parity.json'), {
            nativeEnvelope: actual,
            shellEnvelope,
            shellPointer,
            normalizedEnvelope: nativeEnvelope,
            normalizedPointer: nativePointer,
            comparisonStatus: compared.status,
            comparisonSignal: compared.signal,
          });
        }
        if (scenario === 'empty-chain') {
          f.put(path.join(f.root, 'native-cache-observation.json'), {
            envelope: actual,
            pointer: JSON.parse(fs.readFileSync(pointer)),
            envelopeSha256: crypto
              .createHash('sha256')
              .update(fs.readFileSync(envelope))
              .digest('hex'),
            pointerSha256: crypto
              .createHash('sha256')
              .update(fs.readFileSync(pointer))
              .digest('hex'),
          });
          const resolver = require('../../dist/shell/session/resolve-session');
          const options = {
            cawsDir: path.join(f.repo, '.caws'),
            worktreeRoot: f.repo,
            env: f.environment,
            allowMint: false,
          };
          const attribution = resolver.resolveSession(options);
          const caller = resolver.resolveCallerSession(options);
          const candidates = resolver.resolveSessionCandidates(options);
          expect(attribution.ok).toBe(true);
          expect(attribution.value).toMatchObject({
            source: 'durable_hook_envelope',
            identity: { session_id: 'cache-fixture' },
          });
          expect(caller.ok).toBe(false);
          expect(candidates.candidates).toHaveLength(0);
          expect(
            candidates.trace.some((entry) => entry.reason?.includes('uncorroborated-envelope'))
          ).toBe(true);
          const command = [
            path.resolve(__dirname, '../../dist/index.js'),
            'message',
            'status',
            '--mine',
            '--queued',
            '--json',
          ];
          const downstream = cp.spawnSync(process.execPath, command, {
            cwd: f.repo,
            env: f.environment,
            timeout: 10000,
            encoding: 'utf8',
          });
          f.put(path.join(f.root, 'downstream-cli.stdout'), downstream.stdout);
          f.put(path.join(f.root, 'downstream-cli.stderr'), downstream.stderr);
          expect(downstream.error).toBeUndefined();
          expect(downstream.status).toBe(0);
          expect(JSON.parse(downstream.stdout)).toMatchObject({
            ok: true,
            read_only: true,
            me: 'cache-fixture',
          });
          // A second fresh cache and forged caller pointer do not become caller
          // authority, including when the real caller is explicitly corroborated.
          f.put(path.join(f.repo, '.caws/sessions/foreign-cache/.session-envelope.json'), {
            ...actual,
            session_id: 'foreign-cache',
          });
          f.put(pointer, {
            session_id: 'foreign-cache',
            repo_root: f.repo,
            last_seen_at: actual.last_seen_at,
          });
          const pinned = {
            ...options,
            env: {
              ...f.environment,
              CAWS_AGENT_SURFACE: 'codex',
              CODEX_THREAD_ID: 'cache-fixture',
            },
          };
          const corroborated = resolver.resolveSessionCandidates(pinned);
          expect(corroborated.candidates.length).toBeGreaterThan(0);
          expect(
            corroborated.candidates.every(
              (candidate) => candidate.identity.session_id === 'cache-fixture'
            )
          ).toBe(true);
          expect(corroborated.trace.some((entry) => entry.reason?.includes('foreign-cache'))).toBe(
            true
          );
          f.put(path.join(f.root, 'downstream-resolver.json'), {
            attribution,
            caller,
            candidates,
            corroborated,
            cli: {
              executable: process.execPath,
              args: command,
              status: downstream.status,
              signal: downstream.signal,
              error: downstream.error?.message || null,
              environmentKeys: Object.keys(f.environment).sort(),
            },
          });
        }
      }
    } finally {
      f.dispose();
    }
  },
  25000
);

test('inactive selection cannot call the cache port', async () => {
  const f = cacheFixture([]);
  try {
    f.put(path.join(f.home, 'surfaces/codex/settings.json'), { version: 1, enabled: false });
    const capture = jest.fn(async () => {
      throw new Error('inactive capture');
    });
    const invocation = await prepareRuntimeInvocation(f.request(), new AbortController().signal, {
      capture,
    });
    expect(invocation.active).toBe(false);
    expect((await invocation.dispatch()).nativeResult.exitCode).toBe(0);
    expect(capture).not.toHaveBeenCalled();
  } finally {
    f.dispose();
  }
});

test('the stock cache prefix is awaited before an early guard refusal; unavailable capture preserves it', async () => {
  const f = cacheFixture();
  try {
    const request = f.request();
    let release;
    const capture = jest.fn(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    const invocation = await prepareRuntimeInvocation(request, new AbortController().signal, {
      capture,
    });
    expect(capture).not.toHaveBeenCalled();
    const pending = invocation.dispatch();
    await turn();
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith(f.repo);
    expect(f.rows(request).some((row) => row.stage === 'handler_started')).toBe(false);
    release(capturedCache());
    const first = await pending;
    expect(first.nativeResult.exitCode).toBe(2);
    expect(JSON.parse(Buffer.from(first.nativeResult.stdout).toString()).decision).toBe('block');
    const stages = f.rows(request).map((row) => row.stage);
    expect(stages.indexOf('session_cache_completed')).toBeLessThan(
      stages.indexOf('handler_started')
    );
    expect(stages).not.toContain('compatibility_dispatch_completed');
    await invocation.acknowledgeHandoff(true);

    // The first refusal arms its session latch. Compare an independent fresh
    // fixture so a valid subsequent quarantine refusal cannot mask this oracle.
    const fresh = cacheFixture();
    try {
      const secondRequest = fresh.request();
      const unavailable = jest.fn(async () => ({
        status: 'unavailable',
        envelopePublished: true,
        diagnostic: 'fixture pointer publication unavailable',
      }));
      const second = await prepareRuntimeInvocation(secondRequest, new AbortController().signal, {
        capture: unavailable,
      });
      const completed = await second.dispatch();
      expect(completed.nativeResult.exitCode).toBe(2);
      // Each machine home is embedded in its OpenCode plugin, so independent
      // fixtures have distinct content-addressed generations. Verify the exact
      // selected reset script before comparing the complete refusal semantics.
      const refusalFromSelectedGeneration = (fixture, ownRequest, result) => {
        const selected = fixture.rows(ownRequest).find((row) => row.stage === 'invocation_started');
        expect(ownRequest.runtimeDigest).toBe(fixture.digest);
        expect(selected.runtime_digest).toBe(fixture.digest);
        expect(fixture.runtime).toBe(path.join(fixture.home, 'lib/runtimes', fixture.digest));
        expect(
          selected.selected_handlers.find((handler) => handler.name === 'block-dangerous.sh').path
        ).toBe(path.join(fixture.runtime, 'block-dangerous.sh'));
        expect(
          JSON.parse(fs.readFileSync(path.join(fixture.home, 'state/adapter-runtime.json'))).digest
        ).toBe(fixture.digest);
        const manifestBytes = fs.readFileSync(path.join(fixture.runtime, 'manifest.json'));
        expect(crypto.createHash('sha256').update(manifestBytes).digest('hex')).toBe(
          fixture.digest
        );
        const manifest = JSON.parse(manifestBytes);
        const resetScript = path.join(fixture.runtime, 'reset-danger-latch.sh');
        expect(crypto.createHash('sha256').update(fs.readFileSync(resetScript)).digest('hex')).toBe(
          manifest['reset-danger-latch.sh']
        );
        const stdout = Buffer.from(result.stdout).toString();
        expect(JSON.parse(stdout).reason).toContain(
          'bash ' + resetScript + ' --session cache-fixture --reason '
        );
        expect(stdout.split(resetScript)).toHaveLength(2);
        return stdout.replace(resetScript, '$RESET_SCRIPT').split(fixture.root).join('$FIXTURE');
      };
      const firstRefusal = refusalFromSelectedGeneration(f, request, first.nativeResult);
      const secondRefusal = refusalFromSelectedGeneration(
        fresh,
        secondRequest,
        completed.nativeResult
      );
      expect(secondRefusal).toBe(firstRefusal);
      expect(Buffer.from(completed.nativeResult.stderr).toString()).toContain(
        'fixture pointer publication unavailable'
      );
      expect(unavailable).toHaveBeenCalledTimes(1);
      expect(fresh.rows(secondRequest).map((row) => row.stage)).not.toContain(
        'compatibility_dispatch_completed'
      );
      await second.acknowledgeHandoff(true);
    } finally {
      fresh.dispose();
    }
  } finally {
    f.dispose();
  }
}, 30000);

test('confirmed decline runs full compatibility exactly once; a lost cache response cannot replay', async () => {
  const f = cacheFixture([]);
  try {
    const request = f.request({ tool_input: { command: 'echo safe' } });
    const capture = jest.fn(async () => ({
      status: 'declined',
      envelopePublished: false,
      diagnostic: 'unsupported old envelope profile',
    }));
    const invocation = await prepareRuntimeInvocation(request, new AbortController().signal, {
      capture,
    });
    expect((await invocation.dispatch()).nativeResult.exitCode).toBe(0);
    expect(capture).toHaveBeenCalledTimes(1);
    const stages = f.rows(request).map((row) => row.stage);
    expect(stages.filter((stage) => stage === 'compatibility_dispatch_completed')).toHaveLength(1);
    expect(stages).not.toContain('handler_started');
    // This file comes from the actual compatibility parser, not the injected port.
    expect(
      JSON.parse(
        fs.readFileSync(path.join(f.repo, '.caws/sessions/cache-fixture/.session-envelope.json'))
      )
    ).toMatchObject({
      session_id: 'cache-fixture',
      repo_root: f.repo,
      hook_event: 'PreToolUse',
      platform: 'codex',
    });
    await expect(invocation.dispatch()).rejects.toThrow('single-use');
    await invocation.acknowledgeHandoff(true);

    const lostRequest = f.request();
    const sentinel = new Error('lost cache response');
    const lost = jest.fn(async () => {
      throw sentinel;
    });
    const interrupted = await prepareRuntimeInvocation(lostRequest, new AbortController().signal, {
      capture: lost,
    });
    await expect(interrupted.dispatch()).rejects.toBe(sentinel);
    const lostStages = f.rows(lostRequest).map((row) => row.stage);
    expect(lostStages).not.toContain('handler_started');
    expect(lostStages).not.toContain('compatibility_dispatch_completed');
    expect(lost).toHaveBeenCalledTimes(1);
    await expect(interrupted.dispatch()).rejects.toThrow('single-use');
    await interrupted.acknowledgeHandoff(false);
  } finally {
    f.dispose();
  }
}, 30000);

test.each([false, true])(
  'empty or entirely reprieved handler selections retain cache capture (reprieved=%s)',
  async (reprieved) => {
    const f = cacheFixture(reprieved ? ['block-dangerous.sh'] : []);
    try {
      if (reprieved)
        f.put(path.join(f.home, 'state/sessions/cache-fixture/guard-reprieve-cache-fixture.json'), {
          session_id: 'cache-fixture',
          repo_root: f.repo,
          created_at: new Date().toISOString(),
          approved_by: 'synthetic test fixture',
          reason: 'exercise actual eligibility reader',
          expires_at: new Date(Date.now() + 60000).toISOString(),
          handlers: ['block-dangerous.sh'],
        });
      const request = f.request();
      const capture = jest.fn(async () => capturedCache());
      const invocation = await prepareRuntimeInvocation(request, new AbortController().signal, {
        capture,
      });
      expect((await invocation.dispatch()).nativeResult.exitCode).toBe(0);
      expect(capture).toHaveBeenCalledTimes(1);
      const rows = f.rows(request);
      expect(rows.some((row) => row.stage === 'handler_started')).toBe(false);
      expect(rows.some((row) => row.stage === 'compatibility_dispatch_completed')).toBe(false);
      if (reprieved)
        expect(rows.some((row) => JSON.stringify(row).includes('reprieved'))).toBe(true);
      await invocation.acknowledgeHandoff(true);
    } finally {
      f.dispose();
    }
  },
  20000
);

test('compiled engine entry uses one framed reader for Ready, cache exchange and result handoff', async () => {
  const f = cacheFixture([]);
  const { RuntimeFrameReader, writeRuntimeFrame } = require('../../dist/runtime/live-protocol');
  const controller = new AbortController();
  const child = cp.spawn(
    process.execPath,
    [path.resolve(__dirname, '../../dist/runtime/engine-entry.js')],
    { cwd: f.repo, env: f.environment, stdio: ['pipe', 'pipe', 'pipe'] }
  );
  const timer = setTimeout(() => {
    controller.abort(new Error('entry fixture deadline'));
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }, 18000);
  const stderr = [];
  child.stderr.on('data', (bytes) => stderr.push(bytes));
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  const transcript = [];
  const reader = new RuntimeFrameReader(child.stdout);
  const read = async () => {
    const row = JSON.parse(Buffer.from(await reader.read(controller.signal)).toString());
    transcript.push({ from: 'engine', ...row });
    return row;
  };
  const write = async (frame) => {
    transcript.push({ from: 'fixture', ...frame });
    await writeRuntimeFrame(child.stdin, frame, controller.signal);
  };
  try {
    const request = f.request({ tool_input: { command: 'echo safe' } });
    const binding = { id: request.id, runtimeDigest: request.runtimeDigest };
    await write(request);
    expect(await read()).toMatchObject({
      schema: 'caws.runtime.ready.v1',
      active: true,
      ...binding,
    });
    // No cache request is produced while the native grant is withheld.
    await turn();
    expect(f.rows(request).some((row) => row.stage === 'session_cache_completed')).toBe(false);
    await write({ schema: 'caws.runtime.dispatch.v1', ...binding });
    const cache = await read();
    expect(cache).toMatchObject({
      schema: 'caws.runtime.session-cache.request.v1',
      ...binding,
      canonicalRoot: f.repo,
    });
    await write({
      schema: 'caws.runtime.session-cache.previous.v1',
      ...binding,
      token: cache.token,
      existingBase64: null,
    });
    expect(await read()).toEqual({
      schema: 'caws.runtime.session-cache.decision.v1',
      ...binding,
      token: cache.token,
      action: 'capture',
      createdUnits: null,
    });
    await write({
      schema: 'caws.runtime.session-cache.result.v1',
      ...binding,
      token: cache.token,
      status: 'captured',
      envelopePublished: true,
      diagnostic: null,
    });
    const proposal = await read();
    expect(proposal).toMatchObject({
      schema: 'caws.runtime.proposal.v2',
      ...binding,
      containment: null,
    });
    expect(proposal.response.result.exitCode).toBe(0);
    await write({
      schema: 'caws.runtime.handoff.v2',
      ...binding,
      token: proposal.token,
      success: true,
      containment: null,
    });
    child.stdin.end();
    expect(await closed).toEqual({ code: 0, signal: null });
    expect(Buffer.concat(stderr).toString()).toBe('');
    expect(f.rows(request).map((row) => row.stage)).toContain('session_cache_completed');
    // The protocol peer simulates native publication; no filesystem claim here.
    expect(
      fs.existsSync(path.join(f.repo, '.caws/sessions/cache-fixture/.session-envelope.json'))
    ).toBe(false);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
    f.put(path.join(f.root, 'entry-frames.json'), transcript);
    f.put(path.join(f.root, 'entry-stderr.txt'), Buffer.concat(stderr).toString());
    f.dispose();
  }
}, 25000);

test.each([
  'numeric',
  'overwritten-numeric',
  'parser-override',
  'missing-capability',
  'unsafe-sid',
])(
  'unsupported cache prefix uses compatibility before native effects: %s',
  async (profile) => {
    const f = cacheFixture([]);
    try {
      const request = f.request({ tool_input: { command: 'echo safe' } });
      if (profile === 'numeric') {
        request.payload.unused = 1;
        request.inputJson = JSON.stringify(request.payload);
      }
      if (profile === 'overwritten-numeric') {
        request.payload.unused = 'last';
        request.inputJson = request.inputJson.replace(/}$/, ',"unused":1,"unused":"last"}');
      }
      if (profile === 'parser-override')
        f.put(path.join(f.repo, '.caws/hooks/runtime-paths.sh'), '# project runtime override\n');
      if (profile === 'missing-capability') delete request.sessionCache;
      if (profile === 'unsafe-sid') {
        request.payload.session_id = 'unsafe/identity';
        request.inputJson = JSON.stringify(request.payload);
      }
      const capture = jest.fn(async () => {
        throw new Error('unsupported prefix reached native');
      });
      const invocation = await prepareRuntimeInvocation(request, new AbortController().signal, {
        capture,
      });
      expect((await invocation.dispatch()).nativeResult.exitCode).toBe(0);
      expect(capture).not.toHaveBeenCalled();
      if (profile !== 'unsafe-sid')
        expect(f.rows(request).map((row) => row.stage)).toContain(
          'compatibility_dispatch_completed'
        );
      await invocation.acknowledgeHandoff(true);
    } finally {
      f.dispose();
    }
  },
  20000
);

const shortcutRoutes = ['installed-bootstrap', 'native-engine-compat'];
// Explicit native executable input makes this a real Rust consumer probe.
// The ordinary suite still exercises both immutable adapter/engine routes.
if (process.env.CAWS_TEST_NATIVE_EXECUTABLE) shortcutRoutes.push('rust-native-compat');
test.each(shortcutRoutes)(
  'Codex PostToolUse %s scans authored patch sections and reports applied edits',
  async (route) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shortcut-post-')));
    const repo = path.join(root, 'project');
    const home = path.join(root, 'machine');
    const put = (file, data) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data));
    };
    const environment = {
      ...process.env,
      HOME: root,
      CAWS_HOME: home,
      CODEX_THREAD_ID: 'shortcut-test',
      CAWS_TRAP_KILL: '0',
      CAWS_HOOK_ADVISORY_DEDUP: '0',
    };
    try {
      fs.mkdirSync(repo);
      expect(cp.spawnSync('git', ['init', '-q'], { cwd: repo, env: environment }).status).toBe(0);
      put(path.join(repo, '.caws/policy.yaml'), 'version: 1\n');
      fs.mkdirSync(path.join(repo, '.caws/specs'));
      const installed = installMachineRuntime({ home, templatesRoot: templates });
      const runtime = path.join(home, 'lib/runtimes', installed.digest);
      const defaults = JSON.parse(fs.readFileSync(path.join(runtime, 'system-policy.json')));
      const policy = {
        disabled: {
          pre_tool_use: defaults.events.pre_tool_use
            .map((entry) => entry.split(' ')[0])
            .filter((name) => name !== 'shortcut-language-check.sh'),
          post_tool_use: defaults.events.post_tool_use
            .map((entry) => entry.split(' ')[0])
            .filter((name) => name !== 'shortcut-language-check.sh'),
        },
        extensions: {},
        handlers: {},
        libraries: {},
      };
      validateSystemPolicy(repo, policy, {
        files: [...installed.files],
        defaults: defaults.events,
      });
      put(path.join(home, 'surfaces/codex/settings.json'), { version: 1, enabled: true });
      put(
        path.join(
          home,
          'state/projects',
          crypto.createHash('sha256').update(repo).digest('hex') + '.json'
        ),
        { version: 1, root: repo, surfaces: { codex: policy } }
      );
      const first = path.join(repo, 'first.js');
      const second = path.join(repo, 'second.js');
      put(first, '// TODO already existed\nconst x = 2;\n');
      put(second, 'const clean = 1;\n');
      const strikes = path.join(root, '.caws/state/sessions/shortcut-test/strikes.json');
      let counter = 0;
      let lastStderr = '';
      async function runTool(toolName, toolInput, expectedExit = 0, event = 'post_tool_use') {
        const payload = {
          hook_event_name: event === 'pre_tool_use' ? 'PreToolUse' : 'PostToolUse',
          cwd: repo,
          session_id: 'shortcut-test',
          tool_name: toolName,
          tool_input: toolInput,
        };
        if (route === 'installed-bootstrap' || route === 'rust-native-compat') {
          const binary =
            route === 'rust-native-compat'
              ? process.env.CAWS_TEST_NATIVE_EXECUTABLE
              : path.join(home, 'bin/caws-hook');
          expect(path.isAbsolute(binary)).toBe(true);
          const args =
            route === 'rust-native-compat'
              ? [
                  'invoke',
                  '--engine',
                  path.resolve(__dirname, '../../dist/runtime/engine-entry.js'),
                  '--node',
                  process.execPath,
                  '--surface',
                  'codex',
                  '--event',
                  event,
                  '--runtime-digest',
                  installed.digest,
                  '--timeout-ms',
                  '15000',
                  '--configuration',
                  'system',
                ]
              : ['codex', event, '--system'];
          const result = cp.spawnSync(binary, args, {
            cwd: repo,
            env: environment,
            input: JSON.stringify(payload),
            encoding: 'utf8',
            timeout: 15000,
          });
          expect(result.error).toBeUndefined();
          lastStderr = result.stderr;
          expect(result.status).toBe(expectedExit);
          return result.stdout;
        }
        const request = {
          schema: 'caws.runtime.request.v1',
          id: 'shortcut-post-' + ++counter,
          runtimeDigest: installed.digest,
          surface: 'codex',
          event,
          configuration: 'system',
          caller: { processId: process.pid, cwd: repo, environment },
          deadlineEpochMs: Date.now() + 15000,
          inputJson: JSON.stringify(payload),
          payload,
        };
        const invocation = await prepareRuntimeInvocation(request, new AbortController().signal);
        expect(invocation.active).toBe(true);
        const { nativeResult } = await invocation.dispatch();
        await invocation.acknowledgeHandoff(true);
        lastStderr = Buffer.from(nativeResult.stderr).toString();
        expect(nativeResult.exitCode).toBe(expectedExit);
        return Buffer.from(nativeResult.stdout).toString();
      }
      const runPatch = (command, expectedExit = 0) =>
        runTool('apply_patch', { command }, expectedExit);
      const patch = (lines) => ['*** Begin Patch', ...lines, '*** End Patch'].join('\n');
      const noNewStub = patch([
        `*** Update File: ${first}`,
        '@@',
        ' // TODO already existed',
        '-const x = 1;',
        '+const x = 2;',
        `*** Update File: ${second}`,
        '@@',
        '-const clean = 0;',
        '+const clean = 1;',
      ]);
      await runPatch(noNewStub);
      expect(fs.existsSync(strikes)).toBe(false);
      const deletion = patch([`*** Update File: ${first}`, '@@', '-const old = 1;']);
      await runPatch(deletion);
      expect(fs.existsSync(strikes)).toBe(false);
      const secondFileStub = patch([
        `*** Update File: ${first}`,
        '@@',
        '-a',
        '+b',
        `*** Update File: ${second}`,
        '@@',
        '+// TODO newly introduced',
      ]);
      put(first, 'b\n');
      put(second, '// TODO newly introduced\n');
      for (let count = 1; count <= 3; count++) {
        const output = await runPatch(secondFileStub, count === 3 ? 2 : 0);
        expect(JSON.parse(fs.readFileSync(strikes)).shortcut_language).toBe(count);
        expect(output).toContain('second.js');
        expect(output).toMatch(/PostToolUse|already applied/i);
        expect(output).not.toMatch(/permissionDecision"\s*:\s*"deny/i);
        if (count === 3) {
          expect(JSON.parse(output).decision).toBe('block');
          // The pinned Codex consumer requires nonempty stderr when exit is 2.
          expect(lastStderr).toContain('this tool result is blocked');
          expect(lastStderr).not.toContain('further progress is blocked');
        } else expect(JSON.parse(output).hookSpecificOutput.hookEventName).toBe('PostToolUse');
      }
      // Each call counts at most once, even if multiple eligible files match.
      const runAndCount = async (command, count, named) => {
        const output = await runPatch(command, 2);
        expect(JSON.parse(fs.readFileSync(strikes)).shortcut_language).toBe(count);
        if (named) expect(output).toContain(named);
      };
      await runAndCount(
        patch([
          `*** Add File: ${repo}/tests/excluded.js`,
          '+// TODO test fixture',
          `*** Add File: ${repo}/added.js`,
          '+// TODO new added source',
        ]),
        4,
        'added.js'
      );
      put(path.join(repo, 'moved.js'), '// TODO moved source\n');
      await runAndCount(
        patch([
          `*** Update File: ${first}`,
          `*** Move to: ${repo}/moved.js`,
          '@@',
          '-const x = 1;',
          '+// TODO moved source',
        ]),
        5,
        'moved.js'
      );
      await runAndCount(
        patch([
          `*** Add File: ${repo}/a.js`,
          '+// TODO one',
          `*** Add File: ${repo}/b.js`,
          '+// TODO two',
        ]),
        6,
        'a.js'
      );
      // A full file deletion and malformed patch must not scan the disk fallback.
      await runPatch(patch([`*** Delete File: ${first}`]));
      await runPatch(`*** Begin Patch\n*** Update File: ${first}\nunknown`);
      expect(lastStderr).toContain('authored content unavailable; no strike recorded');
      expect(JSON.parse(fs.readFileSync(strikes)).shortcut_language).toBe(6);
      // Direct Edit: identical old lines, empty/deletion and missing fields never
      // charge old content, including filenames carrying a literal LF.
      const lfPath = path.join(repo, 'owned\nlane.js');
      put(lfPath, '// TODO existing\n');
      await runTool('Edit', {
        file_path: lfPath,
        old_string: '// TODO existing\n',
        new_string: '// TODO existing\n',
      });
      await runTool('Edit', {
        file_path: lfPath,
        old_string: '// TODO existing\n',
        new_string: '',
      });
      await runTool('Edit', { file_path: lfPath, old_string: '// TODO existing\n' });
      expect(JSON.parse(fs.readFileSync(strikes)).shortcut_language).toBe(6);
      put(lfPath, '// TODO existing\n// TODO new duplicate\n');
      const lfOutput = await runTool(
        'Edit',
        {
          file_path: lfPath,
          old_string: '// TODO existing\n',
          new_string: '// TODO existing\n// TODO new duplicate\n',
        },
        2
      );
      expect(JSON.parse(fs.readFileSync(strikes)).shortcut_language).toBe(7);
      expect(lfOutput).toContain('owned\\nlane.js');
      // Identical old/new lines are a multiset: an excess second copy is new.
      put(lfPath, '// TODO repeat\n// TODO repeat\n');
      await runTool(
        'Edit',
        {
          file_path: lfPath,
          old_string: '// TODO repeat\n',
          new_string: '// TODO repeat\n// TODO repeat\n',
        },
        2
      );
      expect(JSON.parse(fs.readFileSync(strikes)).shortcut_language).toBe(8);
      // Lexer sees surrounding unchanged block-comment context but charges only
      // the added lowercase marker. References count the complete new fragment.
      put(second, '/*\n todo implement this\n*/\n');
      const contextPatch = patch([
        `*** Update File: ${second}`,
        '@@',
        ' /*',
        '+ todo implement this',
        ' */',
      ]);
      const blockOutput = await runPatch(contextPatch, 2);
      expect(JSON.parse(fs.readFileSync(strikes)).shortcut_language).toBe(9);
      expect(blockOutput).toContain('line 2 of the edit');
      expect(blockOutput).toContain('todo implement this');
      put(second, '/*\n todo implement this\n */\n');
      const editOutput = await runTool(
        'Edit',
        { file_path: second, old_string: '/*\n */', new_string: '/*\n todo implement this\n */' },
        2
      );
      expect(JSON.parse(fs.readFileSync(strikes)).shortcut_language).toBe(10);
      expect(editOutput).toContain('line 2 of the edit');
      // Existing lowercase marker in unchanged comment context remains uncharged.
      put(second, '/*\n todo existing\n */\nconst value = 1;');
      await runTool('Edit', {
        file_path: second,
        old_string: '/*\n todo existing\n */',
        new_string: '/*\n todo existing\n */\nconst value = 1;',
      });
      expect(JSON.parse(fs.readFileSync(strikes)).shortcut_language).toBe(10);
      expect(lastStderr).not.toContain('authored content unavailable');
      // Two independent hunks do not share synthetic comment state.
      put(second, 'todo standalone\n');
      await runPatch(patch([`*** Update File: ${second}`, '@@', ' /*', '@@', '+todo standalone']));
      expect(JSON.parse(fs.readFileSync(strikes)).shortcut_language).toBe(10);
      await runPatch(patch([`*** Delete File: ${first}`]));
      expect(lastStderr).not.toContain('authored content unavailable');
      // Pre Write observes an actual regular preimage; retained markers do not
      // strike. A Post Write must not charge again or trust forged preimages.
      const writePath = path.join(repo, 'write.js');
      put(writePath, '// TODO retained\nconst changed = 1;\n');
      const retainedWrite = '// TODO retained\nconst changed = 2;\n';
      await runTool('Write', { file_path: writePath, content: retainedWrite }, 0, 'pre_tool_use');
      expect(JSON.parse(fs.readFileSync(strikes)).shortcut_language).toBe(10);
      put(writePath, retainedWrite);
      await runTool('Write', {
        file_path: writePath,
        content: retainedWrite,
        old_string: '',
        created: true,
      });
      expect(JSON.parse(fs.readFileSync(strikes)).shortcut_language).toBe(10);
      const preOutput = await runTool(
        'Write',
        { file_path: writePath, content: retainedWrite + '// TODO genuinely new\n' },
        2,
        'pre_tool_use'
      );
      expect(preOutput).toContain('genuinely new');
      expect(preOutput).not.toMatch(/already applied/i);
      expect(JSON.parse(fs.readFileSync(strikes)).shortcut_language).toBe(11);
      // ENOENT leaf with an existing parent establishes an empty preimage.
      const newPath = path.join(repo, 'new-file.js');
      const createOutput = await runTool(
        'Write',
        { file_path: newPath, content: '// TODO new file\n' },
        2,
        'pre_tool_use'
      );
      expect(createOutput).toContain('TODO new file');
      expect(JSON.parse(fs.readFileSync(strikes)).shortcut_language).toBe(12);
      // A symlink cannot supply the observed regular-file preimage.
      const link = path.join(repo, 'link.js');
      fs.symlinkSync(writePath, link);
      await runTool(
        'Write',
        { file_path: link, content: '// TODO not qualified\n' },
        0,
        'pre_tool_use'
      );
      expect(lastStderr).toMatch(/authored content unavailable/i);
      expect(JSON.parse(fs.readFileSync(strikes)).shortcut_language).toBe(12);
      // The postimage supplies block-comment context omitted from the hunk.
      put(second, '/*\n  earlier block context\n  todo implement this\n */\n');
      const outside = await runPatch(
        patch([
          `*** Update File: ${second}`,
          '@@',
          '   earlier block context',
          '+  todo implement this',
        ]),
        2
      );
      expect(outside).toContain('todo implement this');
      expect(JSON.parse(fs.readFileSync(strikes)).shortcut_language).toBe(13);
      // A repeated span cannot establish the actual occurrence.
      put(second, '/*\n  earlier block context\n  todo implement this\n */\n'.repeat(2));
      await runPatch(
        patch([
          `*** Update File: ${second}`,
          '@@',
          '   earlier block context',
          '+  todo implement this',
        ])
      );
      expect(lastStderr).toMatch(/authored content unavailable/i);
      expect(JSON.parse(fs.readFileSync(strikes)).shortcut_language).toBe(13);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
  120000
);
