// Actual compiled entry transport and selected stock logger, plus focused engine
// transitions. The framed test peer does not prove native ownership/settlement.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { setTimeout, clearTimeout } = require('node:timers');
const { AbortController } = globalThis;
const { installMachineRuntime } = require('../../dist/init/machine-adapters');
const { decodeRuntimeRequest } = require('../../dist/runtime/protocol');
const { RuntimeFrameReader, writeRuntimeFrame } = require('../../dist/runtime/live-protocol');
const { prepareRuntimeInvocation } = require('../../dist/runtime/engine');
const executor = require('../../dist/runtime/handler-executor');

const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const put = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value), {
    mode: 0o600,
  });
};
const completedPrefix = {
  status: 'completed',
  prefixComplete: true,
  envelopePublished: true,
  pointerPublished: true,
  agentPid: 'not_found',
  reap: 'not_run',
  diagnostic: null,
};
const declinedPrefix = {
  status: 'declined',
  prefixComplete: false,
  envelopePublished: false,
  pointerPublished: false,
  agentPid: 'not_run',
  reap: 'not_run',
  diagnostic: 'unsupported finite profile',
};
let root, home, project, installed, policy, runtime;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'caws-session-seal-routing-')));
  home = path.join(root, 'machine');
  project = path.join(root, 'project');
  fs.mkdirSync(path.join(root, 'user'));
  fs.mkdirSync(path.join(project, '.git'), { recursive: true });
  fs.mkdirSync(path.join(project, '.caws/specs'), { recursive: true });
  put(path.join(project, '.caws/policy.yaml'), 'version: 1\n');
  installed = installMachineRuntime({
    home,
    templatesRoot: path.resolve(__dirname, '../../templates/hook-packs'),
  });
  runtime = path.join(home, 'lib/runtimes', installed.digest);
  const defaults = JSON.parse(fs.readFileSync(path.join(runtime, 'system-policy.json'), 'utf8'));
  policy = {
    disabled: {
      session_end: defaults.events.session_end.filter((entry) => entry !== 'session-log.sh'),
    },
    extensions: {},
    handlers: {},
    libraries: {},
  };
  for (const surface of ['codex', 'claude-code'])
    put(path.join(home, 'surfaces', surface, 'settings.json'), { version: 1, enabled: true });
  savePolicy();
});
afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});
function savePolicy() {
  put(path.join(home, 'state/projects', sha(project) + '.json'), {
    version: 1,
    root: project,
    surfaces: { codex: policy, 'claude-code': policy },
  });
}
function request(surface = 'codex', changes = {}) {
  const payload = { cwd: project, session_id: 'original', reason: 'exit' };
  return decodeRuntimeRequest(
    JSON.stringify({
      schema: 'caws.runtime.request.v1',
      id: 'seal-routing',
      runtimeDigest: installed.digest,
      surface,
      event: 'session_end',
      configuration: 'system',
      contextGit: 'caws.runtime.context-git.v1',
      sessionPublication: 'caws.runtime.session-publication.v1',
      sessionEndPrefix: 'caws.runtime.session-end-prefix.v1',
      caller: {
        processId: process.pid,
        cwd: project,
        environment: {
          HOME: path.join(root, 'user'),
          CAWS_HOME: home,
          PATH: '/usr/bin:/bin',
          CAWS_GIT_BINARY: '/usr/bin/git',
          TMPDIR: os.tmpdir(),
        },
      },
      deadlineEpochMs: Date.now() + 10000,
      inputJson: JSON.stringify(payload),
      payload,
      ...changes,
    })
  );
}
function contextGit() {
  const calls = [];
  return {
    calls,
    async run(args, cwd) {
      calls.push({ args, cwd });
      return calls.length === 1 ? project : path.join(project, '.git');
    },
  };
}
function ports(capture = async () => completedPrefix) {
  const calls = [];
  return {
    calls,
    prefix: {
      async capture(canonicalRoot) {
        calls.push(['prefix', canonicalRoot]);
        return capture();
      },
    },
    seal: {
      async seal(canonicalRoot, sid, prepare, consume) {
        calls.push(['seal', canonicalRoot, sid]);
        const prepared = await prepare({
          kind: 'seal',
          sessionId: sid,
          reason: 'exit',
          endedAt: 'native-time',
          files: [],
          priorInventory: [],
          bytes() {
            throw new Error('No captured files');
          },
        });
        expect(prepared).toMatchObject({
          disposition: 'aborted',
          diagnostic: expect.stringMatching(/^missing_metadata:/),
        });
        const receipt = { status: 'not_published', terminalDigest: 'b'.repeat(64), artifacts: [] };
        await consume({ status: 'not_published', correlation: {}, receipt });
        return receipt;
      },
    },
  };
}
function compatibilitySpy() {
  return jest.spyOn(executor, 'executeCompatibilityDispatch').mockResolvedValue({
    exitCode: 0,
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    offerReceipts: Buffer.alloc(0),
    executionRecords: Buffer.alloc(0),
  });
}
async function prepare(invocation, owned) {
  const git = contextGit(),
    controller = new AbortController();
  const prepared = await prepareRuntimeInvocation(
    invocation,
    controller.signal,
    undefined,
    git,
    owned.seal,
    owned.prefix
  );
  expect(git.calls.map(({ args }) => args)).toEqual([
    ['rev-parse', '--show-toplevel'],
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
  ]);
  expect(owned.calls).toEqual([]); // Prefix is after grant, not during preparation.
  expect(prepared.serviceOffer).toBeUndefined();
  return { prepared, controller };
}

test('engine awaits actual full prefix before logger; capability alone earns no seal', async () => {
  let release, started;
  const entered = new Promise((accept) => {
    started = accept;
  });
  const prefixResult = new Promise((accept) => {
    release = accept;
  });
  const owned = ports(() => {
    started();
    return prefixResult;
  });
  const fallback = compatibilitySpy();
  const { prepared } = await prepare(request(), owned);
  const dispatch = prepared.dispatch();
  await Promise.race([
    entered,
    dispatch.then(() => {
      throw new Error('Dispatch finished without the mandatory native prefix');
    }),
  ]);
  expect(owned.calls).toEqual([['prefix', project]]);
  release(completedPrefix);
  expect((await dispatch).nativeResult).toMatchObject({ exitCode: 0 });
  expect(owned.calls).toEqual([
    ['prefix', project],
    ['seal', project, 'original'],
  ]);
  expect(fallback).not.toHaveBeenCalled();
  await prepared.acknowledgeHandoff(true);
});

test('reprieved logger still receives mandatory prefix effects and no seal attempt', async () => {
  put(path.join(home, 'state/sessions/original/guard-reprieve-original.json'), {
    session_id: 'original',
    created_at: new Date().toISOString(),
    approved_by: 'test',
    reason: 'finite reprieve',
    expires_at: new Date(Date.now() + 60000).toISOString(),
    handlers: ['session-log.sh'],
    repo_root: project,
  });
  const owned = ports(),
    fallback = compatibilitySpy();
  const { prepared } = await prepare(request(), owned);
  expect((await prepared.dispatch()).nativeResult.exitCode).toBe(0);
  expect(owned.calls).toEqual([['prefix', project]]);
  expect(fallback).not.toHaveBeenCalled();
  await prepared.acknowledgeHandoff(true);
});

test('only explicit coherent no-effect prefix decline returns to full compatibility', async () => {
  const owned = ports(async () => declinedPrefix),
    fallback = compatibilitySpy();
  const { prepared } = await prepare(request(), owned);
  await prepared.dispatch();
  expect(fallback).toHaveBeenCalledTimes(1);
  expect(owned.calls).toEqual([['prefix', project]]);
  await prepared.acknowledgeHandoff(true);
});

test.each([
  'incomplete',
  'lost',
  'effectful-decline',
  'changed-source',
  'changed-reader',
  'cancelled',
  'cancelled-unavailable',
])('prefix %s cannot replay compatibility or reach seal', async (kind) => {
  let controller;
  const owned = ports(async () => {
    if (kind === 'lost') throw new Error('lost prefix result after effects');
    if (kind.startsWith('cancelled')) {
      controller.abort(new Error('prefix cancelled'));
      return kind === 'cancelled'
        ? completedPrefix
        : {
            ...completedPrefix,
            status: 'unavailable',
            diagnostic: 'PID refresh unavailable; prefix completed',
            agentPid: 'unavailable',
          };
    }
    if (kind === 'effectful-decline') return { ...declinedPrefix, envelopePublished: true };
    if (kind === 'changed-source' || kind === 'changed-reader') {
      fs.appendFileSync(
        path.join(
          runtime,
          kind === 'changed-reader' ? 'lib/reprieve-reader.cjs' : 'lib/run-handlers.sh'
        ),
        kind === 'changed-reader' ? '\n// replaced after prefix\n' : '\n# replaced after prefix\n'
      );
      return completedPrefix;
    }
    return { ...declinedPrefix, status: 'unavailable' };
  });
  const fallback = compatibilitySpy();
  const state = await prepare(request(), owned);
  controller = state.controller;
  await expect(state.prepared.dispatch()).rejects.toThrow();
  expect(fallback).not.toHaveBeenCalled();
  expect(owned.calls).toEqual([['prefix', project]]);
  if (kind === 'changed-source' || kind === 'changed-reader') {
    await expect(state.prepared.dispatch()).rejects.toThrow('single-use');
    expect(owned.calls).toEqual([['prefix', project]]);
    expect(fallback).not.toHaveBeenCalled();
  }
  if (kind.startsWith('cancelled')) {
    const rows = fs
      .readFileSync(
        path.join(project, '.caws/sessions/original/hook-invocations/seal-routing.jsonl'),
        'utf8'
      )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const observed = rows.filter((row) => row.stage === 'session_end_prefix_completed');
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({
      status: kind === 'cancelled' ? 'completed' : 'unavailable',
      prefix_complete: true,
      envelope_published: true,
      pointer_published: true,
      agent_pid: kind === 'cancelled' ? 'not_found' : 'unavailable',
      reap: 'not_run',
    });
    expect(rows.findIndex((row) => row.stage === 'session_end_prefix_completed')).toBeLessThan(
      rows.findIndex((row) => row.stage === 'adapter_error')
    );
  }
  await state.prepared.acknowledgeHandoff(false);
});

test('complete best-effort prefix failure still runs logger with diagnostic and explicit no-publication', async () => {
  const owned = ports(async () => ({
    ...completedPrefix,
    status: 'unavailable',
    envelopePublished: false,
    pointerPublished: false,
    diagnostic: 'envelope unavailable; all siblings attempted',
  }));
  const fallback = compatibilitySpy();
  const { prepared } = await prepare(request(), owned),
    result = await prepared.dispatch();
  expect(result.nativeResult.exitCode).toBe(0);
  expect(Buffer.from(result.nativeResult.stderr).toString()).toContain('envelope unavailable');
  expect(owned.calls.map(([kind]) => kind)).toEqual(['prefix', 'seal']);
  expect(fallback).not.toHaveBeenCalled();
  await prepared.acknowledgeHandoff(true);
});

test.each(['cap-absent', 'seal-cap-absent', 'custom-source', 'unsupported-input'])(
  'known pre-effect %s retains compatibility',
  async (kind) => {
    const owned = ports(),
      fallback = compatibilitySpy();
    if (kind === 'custom-source') {
      put(path.join(project, '.caws/custom-logger.sh'), '#!/bin/sh\nexit 0\n');
      fs.chmodSync(path.join(project, '.caws/custom-logger.sh'), 0o755);
      policy.handlers['session-log.sh'] = '.caws/custom-logger.sh';
      savePolicy();
    }
    const invocation = request();
    const changes =
      kind === 'cap-absent'
        ? { sessionEndPrefix: undefined }
        : kind === 'seal-cap-absent'
          ? { sessionPublication: undefined }
          : kind === 'unsupported-input'
            ? {
                inputJson: '{"session_id":"original","unused":1}',
                payload: { session_id: 'original', unused: 1 },
              }
            : {};
    // These are internal request values; the decoder separately rejects explicit
    // undefined wire properties. JSON transport omits absent capabilities.
    const state = await prepare({ ...invocation, ...changes }, owned);
    await state.prepared.dispatch();
    expect(owned.calls).toEqual([]);
    expect(fallback).toHaveBeenCalledTimes(1);
    await state.prepared.acknowledgeHandoff(true);
  }
);

const gitResult = (frame, stdout) => ({
  schema: 'caws.runtime.context-git.result.v1',
  id: frame.id,
  runtimeDigest: frame.runtimeDigest,
  token: frame.token,
  ordinal: frame.ordinal,
  operation: frame.operation,
  status: 'exited',
  exitCode: 0,
  signal: null,
  stdout: Buffer.from(stdout + '\n').toString('base64'),
  stderr: '',
  cleanup: { groupSettled: true, stdoutEof: true, stderrEof: true, reaped: true },
  diagnostic: '',
});

test.each([
  ['codex', false],
  ['claude-code', false],
  ['codex', true],
])(
  'actual entry serializes Git, prefix, seal and semantic consumption for %s; wrong input schema=%s',
  async (surface, wrongInputSchema) => {
    const invocation = request(surface),
      entry = path.resolve(__dirname, '../../dist/runtime/engine-entry.js');
    const child = spawn(process.execPath, [entry], {
      cwd: project,
      env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const controller = new AbortController(),
      reader = new RuntimeFrameReader(child.stdout);
    let closed = false,
      stderr = '';
    child.stderr.on('data', (bytes) => {
      stderr += bytes.toString();
    });
    child.stdin.on('error', () => {});
    const terminal = new Promise((accept) => {
      child.once('error', (error) => {
        closed = true;
        accept({ error });
      });
      child.once('close', (code, signal) => {
        closed = true;
        accept({ code, signal });
      });
    });
    const timer = setTimeout(() => {
      controller.abort(new Error('entry route deadline'));
      if (!closed) child.kill('SIGKILL');
    }, 12000);
    const emitted = [];
    const read = async () => {
      const frame = JSON.parse((await reader.read(controller.signal)).toString());
      emitted.push(frame);
      return frame;
    };
    const write = (frame) => writeRuntimeFrame(child.stdin, frame, controller.signal);
    try {
      await write(invocation);
      const checkout = await read();
      expect(checkout.operation).toBe('checkout');
      await write(gitResult(checkout, project));
      const common = await read();
      expect(common).toEqual({ ...checkout, ordinal: 2, operation: 'commonDir' });
      await write(gitResult(common, path.join(project, '.git')));
      expect(await read()).toMatchObject({
        schema: 'caws.runtime.ready.v1',
        active: true,
        sessionId: 'original',
      });
      const identity = { id: invocation.id, runtimeDigest: invocation.runtimeDigest };
      await write({ schema: 'caws.runtime.dispatch.v1', ...identity });
      const prefix = await read();
      expect(prefix).toMatchObject({
        schema: 'caws.runtime.session-end-prefix.request.v1',
        canonicalRoot: project,
        ...identity,
      });
      const prefixIdentity = { ...identity, token: prefix.token };
      await write({
        schema: 'caws.runtime.session-end-prefix.previous.v1',
        ...prefixIdentity,
        existingBase64: null,
      });
      expect(await read()).toEqual({
        schema: 'caws.runtime.session-end-prefix.decision.v1',
        ...prefixIdentity,
        action: 'capture',
        createdUnits: null,
      });
      await write({
        schema: 'caws.runtime.session-end-prefix.result.v1',
        ...prefixIdentity,
        ...completedPrefix,
      });
      const seal = await read();
      expect(seal).toMatchObject({
        schema: 'caws.runtime.session-seal.request.v1',
        canonicalRoot: project,
        ...identity,
      });
      const correlation = { ...identity, token: seal.token, attempt: 'original-attempt' };
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
        metadata = Buffer.from('{"unrelated":{"exact":9007199254740993}}');
      const turn = Buffer.from(
        '{"schema_version":2,"models":["first","second"],"usage":{' +
          fields.map((field) => JSON.stringify(field) + ':' + huge).join(',') +
          '}}'
      );
      const directory = path.join(project, '.caws/sessions/original');
      put(path.join(directory, '.meta.json'), metadata.toString());
      put(path.join(directory, 'turn-001.json'), turn.toString());
      const descriptor = (name, role, bytes) => ({
        name,
        role,
        byteLength: bytes.length,
        sha256: sha(bytes),
      });
      const files = [
        descriptor('.meta.json', 'metadata', metadata),
        descriptor('turn-001.json', 'turn', turn),
      ];
      await write({
        schema: 'caws.runtime.session-publication.prepare.v1',
        ...correlation,
        kind: 'seal',
        snapshot: {
          observationId: 'native-observation',
          inputDigest: 'b'.repeat(64),
          sessionId: 'original',
          reason: 'native-reason',
          endedAt: '2026-10-23T06:00:00Z',
          files: wrongInputSchema ? [files[0]] : files,
          priorInventory: files,
        },
      });
      if (wrongInputSchema) {
        // One complete native-shaped input stream: the wrong CHUNK schema is
        // the sole defect. A decoder that accepts it can reach Prepared rather
        // than failing later on missing bytes, so this control is discriminating.
        const frames = [
          {
            schema: 'caws.runtime.session-publication.chunk.v1',
            ...correlation,
            kind: 'seal',
            name: '.meta.json',
            offset: 0,
            base64: metadata.toString('base64'),
          },
          {
            schema: 'caws.runtime.session-publication.ready.v1',
            ...correlation,
            kind: 'seal',
            direction: 'inputs',
          },
        ];
        await new Promise((accept, reject) =>
          child.stdin.write(
            frames.map((frame) => JSON.stringify(frame) + '\n').join(''),
            (error) => (error ? reject(error) : accept())
          )
        );
        expect(await read()).toEqual({
          schema: 'caws.runtime.failure.v1',
          ...identity,
          message: expect.stringContaining('Invalid native publication chunk'),
        });
        expect(await terminal).toEqual({ code: 1, signal: null });
        await expect(read()).rejects.toThrow(); // No unread downstream frame.
        expect(
          emitted.filter((frame) =>
            [
              'caws.runtime.session-publication.prepared.v1',
              'caws.runtime.session-publication.chunk.v1',
              'caws.runtime.session-publication.consumed.v1',
            ].includes(frame.schema)
          )
        ).toEqual([]);
        expect(fs.readFileSync(path.join(directory, '.meta.json'))).toEqual(metadata);
        expect(fs.existsSync(path.join(directory, '.session-publication.json'))).toBe(false);
        return;
      }
      for (const [name, bytes] of [
        ['.meta.json', metadata],
        ['turn-001.json', turn],
      ])
        await write({
          schema: 'caws.runtime.session-publication.inputs.v1',
          ...correlation,
          kind: 'seal',
          name,
          offset: 0,
          base64: bytes.toString('base64'),
        });
      await write({
        schema: 'caws.runtime.session-publication.ready.v1',
        ...correlation,
        kind: 'seal',
        direction: 'inputs',
      });
      const prepared = await read();
      expect(prepared.disposition).toBe('ready');
      const chunks = [];
      for (;;) {
        const frame = await read();
        if (frame.schema === 'caws.runtime.session-publication.ready.v1') break;
        expect(frame.schema).toBe('caws.runtime.session-publication.chunk.v1');
        chunks.push(Buffer.from(frame.base64, 'base64'));
      }
      const sealed = Buffer.concat(chunks);
      expect(prepared.artifacts).toEqual([descriptor('.meta.json', 'metadata', sealed)]);
      const artifacts = [prepared.artifacts[0], files[1]],
        terminalDigest = sha(JSON.stringify([correlation, 'published', artifacts]));
      put(path.join(directory, '.meta.json'), sealed.toString());
      put(path.join(directory, '.session-publication.json'), {
        schema: 'caws.session.publication.v1',
        canonicalRoot: project,
        sessionId: 'original',
        correlation,
        terminalDigest,
        artifacts,
      });
      await write({
        schema: 'caws.runtime.session-publication.result.v1',
        ...correlation,
        status: 'published',
        terminalDigest,
        artifacts,
      });
      expect(await read()).toEqual({
        schema: 'caws.runtime.session-publication.consumed.v1',
        ...correlation,
        terminalDigest,
      });
      const journal = fs
        .readFileSync(path.join(directory, 'hook-invocations', invocation.id + '.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map(JSON.parse);
      const prefixRecord = journal.find((row) => row.stage === 'session_end_prefix_completed');
      expect(prefixRecord).toMatchObject({
        prefix_complete: true,
        agent_pid: 'not_found',
        reap: 'not_run',
      });
      const consumed = journal.find((row) => row.stage === 'session_seal_consumer_completed');
      expect(consumed.counts.map(({ field, value }) => [field, value.lexeme])).toEqual(
        fields.map((field) => [field, huge])
      );
      expect(consumed.models).toEqual(['first', 'second']);
      expect(consumed.metadata_sha256).toBe(sha(sealed));
      expect(sealed.toString()).toContain('"exact":9007199254740993');
      expect(consumed).toMatchObject({
        status: 'published',
        reason: 'native-reason',
        ended_at: '2026-10-23T06:00:00Z',
      });
      const proposal = await read();
      expect(proposal).toMatchObject({
        schema: 'caws.runtime.proposal.v2',
        response: { result: { exitCode: 0, stdoutBase64: '' } },
      });
      await write({
        schema: 'caws.runtime.handoff.v2',
        ...identity,
        token: proposal.token,
        success: true,
        containment: null,
      });
      expect(await terminal).toEqual({ code: 0, signal: null });
      expect(stderr).toBe('');
    } finally {
      clearTimeout(timer);
      if (!closed) child.kill('SIGKILL');
      await terminal;
    }
  }
);

// Real private records and actual eligibility/composition; framed native ports
// are boundary doubles, not installed publication/cleanup qualification.
test.each([
  ['ISO', '2099-01-01T00:00:00Z', 'fixture reason', true],
  ['basic', '20990101T000000Z', 'fixture reason', true],
  ['week', '2099-W01-1T00:00', 'fixture reason', true],
  ['naive UTC', '2099-01-01T00:00:00', 'fixture reason', true],
  ['invalid reason', '20990101T000000Z', '\ud800', false],
  ['expired', '2000-01-01T00:00:00Z', 'fixture reason', false],
])(
  'actual SessionEnd reprieve %s leaves mandatory prefix and gates sealing',
  async (_name, expires_at, reason, skipped) => {
    put(path.join(home, 'state/sessions/original/guard-reprieve-original.json'), {
      session_id: 'original',
      created_at: 'fixture',
      approved_by: 'fixture approver',
      reason,
      expires_at,
      handlers: ['session-log.sh'],
      repo_root: project,
    });
    const owned = ports(),
      fallback = compatibilitySpy();
    const { prepared } = await prepare(request(), owned);
    expect((await prepared.dispatch()).nativeResult.exitCode).toBe(0);
    expect(owned.calls).toEqual([
      ['prefix', project],
      ...(skipped ? [] : [['seal', project, 'original']]),
    ]);
    expect(fallback).not.toHaveBeenCalled();
    await prepared.acknowledgeHandoff(true);
  }
);
