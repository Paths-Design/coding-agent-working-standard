// Actual engine/readers/ports; explicit native transport and selection seams.
// This is not a genuine Qwen host or a durable native publication proof.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { createHash } = require('node:crypto');
const { prepareRuntimeInvocation } = require('../../dist/runtime/engine');
const { createNativeFileToolContextPort } = require('../../dist/runtime/file-tool-context');
const { createNativeGuardStrikesPort } = require('../../dist/runtime/guard-strikes');
const { InvocationJournal } = require('../../dist/runtime/journal');
const { AdvisoryDedup } = require('../../dist/runtime/advisory-dedup');
const clone = (value) => JSON.parse(JSON.stringify(value));
const roots = [];
function put(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    file,
    typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value),
    { mode: 0o600 }
  );
}
function fixture({ count = 1, content = 'export const n = 2;\n' } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'native-qwen-engine-')));
  roots.push(root);
  const repo = path.join(root, 'project');
  const lane = path.join(repo, '.caws/worktrees/owned');
  const cwd = path.join(lane, 'src/allowed');
  const home = path.join(root, 'home');
  const machineHome = path.join(root, 'machine');
  const runtime = path.join(machineHome, 'lib/runtimes', 'a'.repeat(64));
  const gitDir = path.join(repo, '.git/worktrees/owned');
  for (const dir of [cwd, home, runtime, gitDir])
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(cwd, 'main.ts');
  put(file, 'export const n = 1;\n');
  const sid = 'actual-qwen_01';
  const policy = {
    version: 1,
    risk_tiers: {
      1: { max_files: 10, max_loc: 250 },
      2: { max_files: 100, max_loc: 10000 },
      3: { max_files: 500, max_loc: 40000 },
    },
    gates: {
      budget_limit: { enabled: true, mode: 'warn' },
      spec_completeness: { enabled: true, mode: 'block' },
      scope_boundary: { enabled: true, mode: 'block' },
    },
  };
  const spec = {
    id: 'QWEN-CONSUMER-001',
    title: 'Owned Qwen fixture',
    mode: 'chore',
    lifecycle_state: 'active',
    worktree: 'owned',
    blast_radius: { modules: ['fixture'] },
    scope: { in: ['src/allowed'], out: [] },
    invariants: ['Only the original owner proceeds'],
    acceptance: [{ id: 'A1', given: 'standing', when: 'write', then: 'checked' }],
    non_functional: {},
    contracts: [],
  };
  const registry = {
    owned: {
      path: lane,
      branch: 'caws/owned',
      baseBranch: 'main',
      specId: spec.id,
      owner: { session_id: sid, platform: 'qwen-code' },
    },
  };
  const context = {
    checkout: lane,
    canonical: repo,
    gitDir,
    commonDir: path.join(repo, '.git'),
    branch: 'caws/owned',
    mergeInProgress: false,
    worktrees: [
      { path: repo, branch: 'refs/heads/main', detached: false, prunable: false, bare: false },
      {
        path: lane,
        branch: 'refs/heads/caws/owned',
        detached: false,
        prunable: false,
        bare: false,
      },
    ],
  };
  const names = [
    'agent-heartbeat.sh',
    'cwd-guard.sh',
    'block-dangerous.sh',
    'worktree-guard.sh',
    'scope-guard.sh',
    'worktree-write-guard.sh',
    'bash-write-guard.sh',
    'protected-paths.sh',
    'shortcut-language-check.sh',
    'scan-secrets.sh',
    'quiet-merge.sh',
  ];
  const handlers = names.map((name) => {
    const bytes = fs.readFileSync(
      path.resolve(__dirname, '../../templates/hook-packs/shared', name)
    );
    const target = path.join(runtime, name);
    put(target, bytes);
    return {
      name,
      entry: name,
      path: target,
      args: [],
      kind: 'stock',
      tier: 'stock',
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  });
  const selection = {
    status: 'active',
    runtimeDigest: 'a'.repeat(64),
    checkout: lane,
    canonical: repo,
    surface: 'qwen-code',
    event: 'pre_tool_use',
    configuration: 'system',
    runtimeDirectory: runtime,
    hooksDirectory: runtime,
    handlers,
    libraries: {},
    overrides: {},
    libraryOverrides: {},
    transcriptAdapter: null,
  };
  const payload = {
    session_id: sid,
    cwd,
    tool_name: 'write_file',
    tool_use_id: 'original-use',
    tool_call_id: 'original-call',
    permission_mode: 'default',
    tool_input: { file_path: file, content },
  };
  const request = {
    schema: 'caws.runtime.request.v1',
    id: 'qwen-original',
    runtimeDigest: selection.runtimeDigest,
    surface: 'qwen-code',
    event: 'pre_tool_use',
    configuration: 'system',
    fileToolContext: 'caws.runtime.file-tool-context.v2',
    guardStrikes: 'caws.runtime.guard-strikes.v2',
    deadlineEpochMs: Date.now() + 30000,
    payload,
    inputJson: JSON.stringify(payload),
    caller: {
      processId: process.pid,
      cwd,
      environment: {
        HOME: home,
        CAWS_HOME: machineHome,
        PATH: '',
        PWD: repo,
        CAWS_SESSION_ID: 'foreign-env',
        QWEN_SESSION_ID: 'foreign-env',
        CAWS_GIT_BINARY: '/must-not-execute',
      },
    },
  };
  const f = {
    root,
    repo,
    lane,
    cwd,
    home,
    machineHome,
    runtime,
    file,
    sid,
    policy,
    spec,
    registry,
    context,
    selection,
    request,
    count,
    frames: [],
    events: [],
    third: undefined,
    onWrite: undefined,
    mutateReply: undefined,
    controller: new globalThis.AbortController(),
    persist() {
      put(path.join(repo, '.caws/policy.yaml'), policy);
      put(path.join(repo, '.caws/worktrees.json'), registry);
      put(path.join(repo, '.caws/specs', spec.id + '.yaml'), spec);
    },
    input(toolInput) {
      request.payload = { ...request.payload, tool_input: toolInput };
      request.inputJson = JSON.stringify(request.payload);
    },
  };
  f.persist();
  f.git = {
    run: jest.fn(async () => {
      throw new Error('generic Git route forbidden');
    }),
  };
  f.select = jest.fn(async (options) => {
    expect(options.checkout).toBe(lane);
    expect(options.canonical).toBe(repo);
    return selection;
  });
  f.prepare = async () => {
    let pending;
    const transport = {
      async write(frame) {
        expect(pending).toBeUndefined();
        f.frames.push(clone(frame));
        f.events.push(frame.ordinal ? 'context:' + frame.ordinal : 'strike:' + frame.operation);
        if (f.onWrite) await f.onWrite(frame);
        pending = frame.ordinal
          ? {
              schema: 'caws.runtime.file-tool-context.result.v2',
              id: frame.id,
              runtimeDigest: frame.runtimeDigest,
              token: frame.token,
              ordinal: frame.ordinal,
              snapshotToken: 'b'.repeat(64),
              context: clone(frame.ordinal === 3 && f.third ? f.third : context),
            }
          : {
              schema: 'caws.runtime.guard-strikes.result.v2',
              id: frame.id,
              runtimeDigest: frame.runtimeDigest,
              token: frame.token,
              operation: frame.operation,
              contextSnapshotToken: frame.contextSnapshotToken,
              count: f.count,
              stateSha256: 'c'.repeat(64),
            };
        if (f.mutateReply) f.mutateReply(pending, frame);
      },
      async read() {
        expect(pending).toBeDefined();
        const value = pending;
        pending = undefined;
        return Buffer.from(JSON.stringify(value));
      },
    };
    const contextPort = createNativeFileToolContextPort(request, transport, f.controller.signal);
    const strikesPort = createNativeGuardStrikesPort(
      request,
      transport,
      f.controller.signal,
      contextPort
    );
    return prepareRuntimeInvocation(
      request,
      f.controller.signal,
      undefined,
      f.git,
      undefined,
      undefined,
      f.select,
      undefined,
      undefined,
      undefined,
      undefined,
      contextPort,
      strikesPort
    );
  };
  return f;
}
const contexts = (f) => f.frames.filter((frame) => frame.ordinal).map((frame) => frame.ordinal);
const strikes = (f) => f.frames.filter((frame) => frame.operation);
afterEach(() => {
  jest.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test('owned managed-lane Qwen Write uses actual surface/session and three observations without mutation', async () => {
  const f = fixture();
  const heartbeat = jest.spyOn(
    require('../../dist/application/agent-heartbeat'),
    'heartbeatAgentActivity'
  );
  const spawn = jest.spyOn(cp, 'spawn');
  const prepared = await f.prepare();
  expect(prepared.active).toBe(true);
  expect(prepared.sessionId).toBe(f.sid);
  expect(contexts(f)).toEqual([1]);
  const result = await prepared.dispatch();
  expect(result.nativeResult.exitCode).toBe(0);
  expect(contexts(f)).toEqual([1, 2]);
  await expect(prepared.acknowledgeHandoff(true)).rejects.toThrow(/before its proposal seal/);
  const proposal = await prepared.finalizeProposal(f.request, result);
  expect(proposal.completion).toBe(result);
  expect(contexts(f)).toEqual([1, 2, 3]);
  proposal.seal();
  expect(() => proposal.seal()).toThrow(/single-use/);
  await expect(prepared.finalizeProposal(f.request, result)).rejects.toThrow(/single-use/);
  expect(strikes(f)).toEqual([]);
  expect(f.git.run).not.toHaveBeenCalled();
  expect(spawn).not.toHaveBeenCalled();
  expect(heartbeat).toHaveBeenCalledWith(
    expect.objectContaining({
      identity: { session_id: f.sid, platform: 'qwen-code' },
      context: expect.objectContaining({ cwd: f.cwd, repo_root: f.repo, hook_pid: process.pid }),
    })
  );
  expect(fs.readFileSync(f.file, 'utf8')).toBe('export const n = 1;\n');
  await prepared.acknowledgeHandoff(false);
});

test.each([1, 2, 3])('scope miss remains blocking at counter %i', async (count) => {
  const f = fixture({ count });
  f.input({ file_path: path.join(f.lane, 'src/other.ts'), content: 'export const n = 1;' });
  const prepared = await f.prepare();
  const result = await prepared.dispatch();
  expect(result.nativeResult.exitCode).toBe(2);
  expect(Buffer.from(result.nativeResult.stderr).toString()).toContain('scope-guard');
  expect(Buffer.from(result.nativeResult.stderr).toString()).toContain('strike ' + count);
  (await prepared.finalizeProposal(f.request, result)).seal();
  expect(contexts(f)).toEqual([1]);
  expect(strikes(f)).toHaveLength(1);
  expect(strikes(f)[0]).toMatchObject({
    operation: 'increment_scope_guard',
    token: f.frames[0].token,
    contextSnapshotToken: 'b'.repeat(64),
  });
});

test.each(['protected', 'scope-out', 'foreign'])(
  '%s target is a specific refusal without counter promotion',
  async (kind) => {
    const f = fixture({ content: '// TODO implement\n' });
    let target = f.file;
    if (kind === 'protected') {
      target = path.join(f.machineHome, 'bin/caws-hook-native');
      put(target, 'protected bytes');
      f.input({ file_path: target, content: '// TODO implement\n' });
    } else if (kind === 'scope-out') {
      f.spec.scope.out = ['src/allowed'];
      f.persist();
    } else {
      const peer = path.join(f.root, 'peer');
      fs.mkdirSync(peer);
      const spec = { ...clone(f.spec), id: 'QWEN-PEER-001', worktree: 'peer' };
      f.registry.peer = {
        path: peer,
        branch: 'caws/peer',
        baseBranch: 'main',
        specId: spec.id,
        owner: { session_id: 'foreign-owner', platform: 'qwen-code' },
      };
      f.context.worktrees.push({
        path: peer,
        branch: 'refs/heads/caws/peer',
        detached: false,
        prunable: false,
        bare: false,
      });
      put(path.join(f.repo, '.caws/specs', spec.id + '.yaml'), spec);
      f.persist();
      target = path.join(peer, 'main.ts');
      put(target, 'foreign bytes');
      f.input({ file_path: target, content: '// TODO implement\n' });
    }
    const before = fs.readFileSync(target);
    const mode = fs.statSync(target).mode;
    const prepared = await f.prepare();
    const result = await prepared.dispatch();
    expect(result.nativeResult.exitCode).toBe(2);
    const output = JSON.parse(Buffer.from(result.nativeResult.stdout).toString());
    expect(output.hookSpecificOutput.permissionDecision).toBe('deny');
    const stderr = Buffer.from(result.nativeResult.stderr).toString();
    expect(stderr).not.toContain('shortcut-language');
    expect(stderr).toContain(
      kind === 'protected'
        ? 'protected-paths.sh'
        : kind === 'scope-out'
          ? 'scope_out'
          : 'worktree-write-guard.sh'
    );
    expect(strikes(f)).toEqual([]);
    (await prepared.finalizeProposal(f.request, result)).seal();
    expect(contexts(f)).toEqual([1]);
    expect(fs.readFileSync(target)).toEqual(before);
    expect(fs.statSync(target).mode).toBe(mode);
  }
);

test.each([1, 2, 3])('authored Qwen Write uses independent shortcut count %i', async (count) => {
  const f = fixture({ count, content: '// TODO implement\nexport const n = 2;\n' });
  const prepared = await f.prepare();
  const result = await prepared.dispatch();
  expect(result.nativeResult.exitCode).toBe(count === 3 ? 2 : 0);
  expect(strikes(f)).toEqual([
    expect.objectContaining({
      operation: 'increment_shortcut_language',
      token: f.frames[0].token,
      contextSnapshotToken: 'b'.repeat(64),
    }),
  ]);
  if (count === 2)
    expect(
      JSON.parse(Buffer.from(result.nativeResult.stdout).toString()).hookSpecificOutput
        .permissionDecision
    ).toBe('ask');
  (await prepared.finalizeProposal(f.request, result)).seal();
  expect(contexts(f)).toEqual(count === 3 ? [1, 2] : [1, 2, 3]);
});

test.each(['reorder', 'custom', 'override', 'disabled', 'dry-run'])(
  '%s cannot select first-party compatibility',
  async (kind) => {
    const f = fixture();
    if (kind === 'reorder') f.selection.handlers.reverse();
    if (kind === 'custom') f.selection.handlers[0].kind = 'project-policy';
    if (kind === 'override') f.selection.libraryOverrides['emit.sh'] = '/custom';
    if (kind === 'disabled') f.selection.handlers.pop();
    if (kind === 'dry-run') f.request.caller.environment.CAWS_HOOK_DRY_RUN = 'nonzero';
    const spawn = jest.spyOn(cp, 'spawn');
    await expect(f.prepare()).rejects.toThrow(/Native Qwen file plan refused/);
    expect(spawn).not.toHaveBeenCalled();
    expect(f.git.run).not.toHaveBeenCalled();
    expect(strikes(f)).toEqual([]);
  }
);

test.each(['cwd', 'path', 'relative'])(
  'unsupported tool-input %s cannot replace original context',
  async (kind) => {
    const f = fixture();
    f.input(
      kind === 'relative'
        ? { file_path: 'main.ts', content: 'x' }
        : { ...f.request.payload.tool_input, [kind]: '/foreign' }
    );
    await expect(f.prepare()).rejects.toThrow(/Original Qwen Write refused/);
    expect(f.frames).toEqual([]);
  }
);

test('absent original payload cwd retains the actual caller cwd in heartbeat', async () => {
  const f = fixture();
  delete f.request.payload.cwd;
  f.request.inputJson = JSON.stringify(f.request.payload);
  const heartbeat = jest.spyOn(
    require('../../dist/application/agent-heartbeat'),
    'heartbeatAgentActivity'
  );
  const prepared = await f.prepare();
  const result = await prepared.dispatch();
  (await prepared.finalizeProposal(f.request, result)).seal();
  expect(heartbeat).toHaveBeenCalledWith(
    expect.objectContaining({
      context: expect.objectContaining({ cwd: f.request.caller.cwd }),
    })
  );
});

test.each(['..', '.', 'empty'])(
  'absolute path alias %s is refused without target effects',
  async (kind) => {
    const f = fixture();
    const before = fs.readFileSync(f.file);
    const mode = fs.statSync(f.file).mode;
    const file_path =
      kind === '..'
        ? f.cwd + '/../allowed/main.ts'
        : kind === '.'
          ? f.cwd + '/./main.ts'
          : f.cwd + '//main.ts';
    f.input({ file_path, content: 'export const n = 2;' });
    const prepared = await f.prepare();
    const result = await prepared.dispatch();
    expect(result.nativeResult.exitCode).toBe(2);
    expect(Buffer.from(result.nativeResult.stderr).toString()).toContain('invalid_file_path');
    (await prepared.finalizeProposal(f.request, result)).seal();
    expect(contexts(f)).toEqual([1]);
    expect(strikes(f)).toEqual([]);
    expect(fs.readFileSync(f.file)).toEqual(before);
    expect(fs.statSync(f.file).mode).toBe(mode);
  }
);

test('context3 follows all awaited composer journal/dedup work', async () => {
  const f = fixture({ content: '// TODO implement\n' });
  const record = InvocationJournal.prototype.record;
  jest
    .spyOn(InvocationJournal.prototype, 'record')
    .mockImplementation(async function (observation) {
      record.call(this, observation);
      await Promise.resolve();
      if (
        observation.stage === 'handler_completed' &&
        observation.handler.name === 'quiet-merge.sh'
      )
        f.events.push('journal:last');
    });
  jest.spyOn(AdvisoryDedup.prototype, 'seen').mockImplementation(async () => {
    await Promise.resolve();
    f.events.push('dedup:last');
    return false;
  });
  const prepared = await f.prepare();
  const result = await prepared.dispatch();
  expect(f.events).toContain('journal:last');
  expect(f.events).toContain('dedup:last');
  expect(contexts(f)).toEqual([1, 2]);
  (await prepared.finalizeProposal(f.request, result)).seal();
  expect(f.events.indexOf('context:3')).toBeGreaterThan(f.events.indexOf('journal:last'));
  expect(f.events.indexOf('context:3')).toBeGreaterThan(f.events.indexOf('dedup:last'));
});

test.each(['authority', 'target', 'mode', 'source', 'latch'])(
  'final synchronous seal catches %s drift after delivered context3',
  async (kind) => {
    const f = fixture();
    const prepared = await f.prepare();
    const result = await prepared.dispatch();
    const proposal = await prepared.finalizeProposal(f.request, result);
    expect(contexts(f)).toEqual([1, 2, 3]);
    if (kind === 'authority') {
      f.registry.owned.owner.session_id = 'foreign-after-context3';
      f.persist();
    } else if (kind === 'target') fs.writeFileSync(f.file, 'concurrent external replacement');
    else if (kind === 'mode') fs.chmodSync(f.file, 0o400);
    else if (kind === 'source') {
      const file = f.selection.handlers[0].path;
      const bytes = fs.readFileSync(file);
      fs.unlinkSync(file);
      put(file, bytes);
    } else put(path.join(f.repo, '.qwen/hooks/state', 'danger-latch-' + f.sid + '.json'), '{}');
    expect(() => proposal.seal()).toThrow();
    expect(() => proposal.seal()).toThrow(/single-use/);
    await expect(prepared.acknowledgeHandoff(true)).rejects.toThrow(/before its proposal seal/);
  }
);

test('fresh context3 is consumed rather than an original/second snapshot clone', async () => {
  const f = fixture();
  const prepared = await f.prepare();
  const result = await prepared.dispatch();
  f.third = { ...clone(f.context), branch: 'foreign-third-branch' };
  const proposal = await prepared.finalizeProposal(f.request, result);
  expect(() => proposal.seal()).toThrow(/original native context changed/);
});

test('wrong context3 token poisons finalization without query or effect replay', async () => {
  const f = fixture();
  const prepared = await f.prepare();
  const result = await prepared.dispatch();
  f.mutateReply = (reply, frame) => {
    if (frame.ordinal === 3) reply.token = 'e'.repeat(64);
  };
  await expect(prepared.finalizeProposal(f.request, result)).rejects.toThrow(/correlation/);
  await expect(prepared.finalizeProposal(f.request, result)).rejects.toThrow(/single-use/);
  expect(contexts(f)).toEqual([1, 2, 3]);
  expect(strikes(f)).toEqual([]);
});

test.each(['request clone', 'completion clone', 'bytes'])(
  'finalization refuses foreign %s before context3',
  async (kind) => {
    const f = fixture({ content: 'export const private_key = "value";\n' });
    const prepared = await f.prepare();
    const result = await prepared.dispatch();
    if (kind === 'bytes') {
      expect(result.nativeResult.stdout.length).toBeGreaterThan(0);
      result.nativeResult.stdout[0] = 0x78;
    }
    await expect(
      prepared.finalizeProposal(
        kind === 'request clone' ? { ...f.request } : f.request,
        kind === 'completion clone' ? { ...result } : result
      )
    ).rejects.toThrow(/original request\/completion/);
    expect(contexts(f)).toEqual([1, 2]);
  }
);

test('unknown finalization prevents subsequent dispatch effects', async () => {
  const f = fixture();
  const prepared = await f.prepare();
  await expect(
    prepared.finalizeProposal(f.request, {
      nativeResult: { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) },
      containment: null,
    })
  ).rejects.toThrow(/original request\/completion/);
  await expect(prepared.dispatch()).rejects.toThrow(/single-use/);
  expect(contexts(f)).toEqual([1]);
  expect(strikes(f)).toEqual([]);
});

test('inactive selection never becomes a declared V2 no-op allow', async () => {
  const f = fixture();
  f.select.mockResolvedValue({ status: 'inactive', reason: 'unsupported' });
  await expect(f.prepare()).rejects.toThrow(/active selected native consumer/);
  expect(contexts(f)).toEqual([1]);
  expect(strikes(f)).toEqual([]);
});

test.each(['cancel', 'deadline'])('%s after dispatch cannot mint finality', async (kind) => {
  const f = fixture();
  const prepared = await f.prepare();
  const result = await prepared.dispatch();
  if (kind === 'cancel') f.controller.abort(new Error('original owner cancelled'));
  else jest.spyOn(Date, 'now').mockReturnValue(f.request.deadlineEpochMs);
  await expect(prepared.finalizeProposal(f.request, result)).rejects.toThrow();
  await expect(prepared.finalizeProposal(f.request, result)).rejects.toThrow(/single-use/);
  expect(contexts(f)).toEqual([1, 2]);
});

test('authority drift during last awaited journal action refuses at egress', async () => {
  const f = fixture();
  const record = InvocationJournal.prototype.record;
  jest
    .spyOn(InvocationJournal.prototype, 'record')
    .mockImplementation(async function (observation) {
      record.call(this, observation);
      if (
        observation.stage === 'handler_completed' &&
        observation.handler.name === 'quiet-merge.sh'
      ) {
        await Promise.resolve();
        f.registry.owned.owner.session_id = 'foreign-during-journal';
        f.persist();
      }
    });
  const prepared = await f.prepare();
  const result = await prepared.dispatch();
  expect(result.nativeResult.exitCode).toBe(0); // Intermediate, not a delivered permission.
  const proposal = await prepared.finalizeProposal(f.request, result);
  expect(() => proposal.seal()).toThrow();
});

test('pending shortcut publication precedes context3; uncertain delivery is never retried', async () => {
  const f = fixture({ content: '// TODO implement\n' });
  let release, entered;
  const publication = new Promise((resolve) => {
    entered = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  f.onWrite = async (frame) => {
    if (frame.operation === 'increment_shortcut_language') {
      entered();
      await gate;
      throw new Error('mock transport lost result after accepted write');
    }
  };
  const prepared = await f.prepare();
  const dispatch = prepared.dispatch();
  await publication;
  expect(contexts(f)).toEqual([1, 2]);
  expect(strikes(f)).toHaveLength(1);
  release();
  const result = await dispatch;
  expect(result.nativeResult.exitCode).toBe(2);
  (await prepared.finalizeProposal(f.request, result)).seal();
  await expect(prepared.dispatch()).rejects.toThrow(/single-use/);
  expect(strikes(f)).toHaveLength(1);
  expect(contexts(f)).toEqual([1, 2]);
});
