const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { AbortController } = globalThis;
const { installMachineRuntime } = require('../../dist/init/machine-adapters');
const { resolveInvocationSelection } = require('../../dist/runtime/selection');
const { qualifiesForNativeContainment } = require('../../dist/runtime/stock-handlers');
const {
  createContainmentCapability,
  parseContainmentIntent,
  containmentWire,
  copyContainment,
  observeContainmentLatch,
  producerLatchReadLimit,
} = require('../../dist/runtime/containment');
const { composeHandlers } = require('../../dist/runtime/composer');
const { decodeHandoff } = require('../../dist/runtime/live-protocol');
const { recordContainmentHandoff } = require('../../dist/runtime/engine');
const templates = path.resolve(__dirname, '../../templates/hook-packs');
const block = {
  exitCode: 0,
  stdout: Buffer.from('{"decision":"block","reason":"QUARANTINED"}\n'),
  stderr: Buffer.alloc(0),
};
let root, owner, directory, data, latch, intent;
function put(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value), {
    mode: 0o600,
  });
}
function capability() {
  const cap = createContainmentCapability(owner, fs.mkdtempSync(path.join(directory, 'receipt-')));
  expect(cap).not.toBeNull();
  return cap;
}
function validated() {
  const cap = capability();
  put(cap.file, data);
  const captured = cap.consume(block);
  expect(captured.diagnostic).toBe('');
  expect(captured.intent).not.toBeNull();
  return captured.intent;
}
function receipt(changes = {}) {
  return {
    ...data,
    schema: 'caws.containment.receipt.v1',
    status: 'signal-accepted',
    reason: 'signal-accepted',
    errno: null,
    ...changes,
  };
}
function handoff(changes = {}) {
  return {
    schema: 'caws.runtime.handoff.v2',
    id: owner.request.id,
    runtimeDigest: owner.request.runtimeDigest,
    token: 'proposal-one',
    success: true,
    containment: receipt(),
    ...changes,
  };
}
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'caws-containment-contract-')));
  const repo = path.join(root, 'repo');
  const home = path.join(root, 'home');
  put(path.join(repo, '.caws/policy.yaml'), 'version: 1\n');
  fs.mkdirSync(path.join(repo, '.caws/specs'));
  const installed = installMachineRuntime({ home, templatesRoot: templates });
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
      surfaces: { codex: { disabled: {}, extensions: {}, handlers: {}, libraries: {} } },
    }
  );
  const selection = resolveInvocationSelection({
    checkout: repo,
    canonical: repo,
    home,
    runtimeDigest: installed.digest,
    surface: 'codex',
    event: 'pre_tool_use',
    system: true,
  });
  expect(selection.status).toBe('active');
  const handler = selection.handlers.find((entry) => entry.name === 'block-dangerous.sh');
  expect(handler).toBeDefined();
  const environment = {
    PATH: '/usr/bin:/bin',
    HOME: root,
    CAWS_HOME: home,
    CAWS_SESSION_ID: 'contract-session',
    CAWS_TRAP_KILL: '1',
  };
  owner = {
    selection,
    handler,
    environment,
    signal: new AbortController().signal,
    request: {
      id: 'contract-invocation',
      runtimeDigest: installed.digest,
      surface: 'codex',
      event: 'pre_tool_use',
      payload: {
        tool_name: 'Bash',
        tool_input: { command: 'evaluated text only' },
        session_id: 'contract-session',
      },
    },
  };
  directory = path.join(root, 'capabilities');
  fs.mkdirSync(directory);
  data = {
    schema: 'caws.containment.intent.v1',
    pid: 123,
    startEpoch: '1700000000',
    comm: '/owned/agent',
    sessionId: 'contract-session',
    latchPath: path.join(repo, '.codex/hooks/state/danger-latch-contract-session.json'),
    latchGeneration: 'a'.repeat(32),
  };
  latch = {
    agent_pid: '123',
    agent_pid_started_at: data.startEpoch,
    agent_pid_comm: data.comm,
    latch_generation: data.latchGeneration,
    trap_strikes: 1,
  };
  put(data.latchPath, latch);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

test('producer latch limit covers successful argv admission and escaped state', () => {
  expect(producerLatchReadLimit('1048576\n')).toBe(6324224);
  for (const value of [
    '0',
    '-1',
    'unlimited',
    '1.5',
    '1e6',
    ' 1048576',
    '9007199254740993',
    '8388609',
  ])
    expect(() => producerLatchReadLimit(value)).toThrow('argument limit');
});

test.each(['large-command', 'escaped-command'])(
  'valid %s latch retains native intent beyond 64 KiB',
  (kind) => {
    latch = {
      ...latch,
      command: kind === 'large-command' ? 'x'.repeat(70 * 1024) : '\u0001'.repeat(12 * 1024),
    };
    put(data.latchPath, latch);
    expect(fs.statSync(data.latchPath).size).toBeGreaterThan(65536);
    intent = validated();
    expect(containmentWire(intent)).toEqual(data);
    expect(observeContainmentLatch(intent)).toBe('unchanged');
  }
);

test('canonical raw intent parsing does not itself create executor authority', () => {
  const parsed = parseContainmentIntent(JSON.stringify(data));
  expect(parsed).toEqual(data);
  expect(() => containmentWire(parsed)).toThrow('executor provenance');
  for (const token of [
    '123.00000000000000001',
    '1.23e2',
    '123.0',
    '0',
    '-1',
    '2147483648',
    '"123"',
  ]) {
    const text = JSON.stringify(data).replace('"pid":123', '"pid":' + token);
    expect(() => parseContainmentIntent(text)).toThrow('Malformed');
  }
  for (const changed of [
    { ...data, extra: true },
    { ...data, startEpoch: '0' },
    { ...data, startEpoch: '1'.repeat(21) },
    { ...data, comm: 'bad\0comm' },
    { ...data, sessionId: 'unknown' },
    { ...data, latchPath: 'relative' },
    { ...data, latchGeneration: 'A'.repeat(32) },
  ])
    expect(() => parseContainmentIntent(JSON.stringify(changed))).toThrow('Malformed');
});

test('capability consumes one completed protective guard result and records a source-latch snapshot', () => {
  const cap = capability();
  put(cap.file, data);
  const captured = cap.consume(block);
  expect(captured.diagnostic).toBe('');
  intent = captured.intent;
  expect(containmentWire(intent)).toEqual(data);
  expect(observeContainmentLatch(intent)).toBe('unchanged');
  expect(() => cap.consume(block)).toThrow('already consumed');
  expect(copyContainment(intent, owner.selection, owner.handler, owner.request.id)).toEqual(data);
  expect(copyContainment(intent, owner.selection, owner.handler, 'another-invocation')).toBeNull();
  expect(
    copyContainment({ ...intent }, owner.selection, owner.handler, owner.request.id)
  ).toBeNull();
  expect(
    copyContainment(
      intent,
      owner.selection,
      { ...owner.handler, sha256: '0'.repeat(64) },
      owner.request.id
    )
  ).toBeNull();
});

test.each([
  'allow',
  'bare-refusal',
  'malformed',
  'wrong-session',
  'wrong-generation',
  'no-strike',
  'redirected-receipt',
  'linked-receipt',
  'writable-receipt',
])('invalid capability input %s holds effects and leaves refusal bytes available', (kind) => {
  const cap = capability();
  put(cap.file, data);
  let result = block;
  if (kind === 'allow') result = { ...block, stdout: Buffer.from('{"decision":"allow"}') };
  if (kind === 'bare-refusal') result = { ...block, exitCode: 2, stdout: Buffer.alloc(0) };
  if (kind === 'malformed') put(cap.file, '{bad');
  if (kind === 'wrong-session') put(cap.file, { ...data, sessionId: 'neighbor' });
  if (kind === 'wrong-generation')
    put(data.latchPath, { ...latch, latch_generation: 'b'.repeat(32) });
  if (kind === 'no-strike') put(data.latchPath, { ...latch, trap_strikes: 0 });
  if (kind === 'redirected-receipt') {
    fs.unlinkSync(cap.file);
    fs.symlinkSync(data.latchPath, cap.file);
  }
  if (kind === 'linked-receipt') fs.linkSync(cap.file, path.join(directory, 'second-link'));
  if (kind === 'writable-receipt') fs.chmodSync(cap.file, 0o666);
  const before = Buffer.from(result.stdout);
  const captured = cap.consume(result);
  expect(captured.intent).toBeNull();
  expect(captured.diagnostic).toContain('signal held');
  expect(result.stdout).toEqual(before);
});

test('no receipt means no terminal intent, rather than synthetic effect success', () => {
  expect(capability().consume(block)).toEqual({ intent: null, diagnostic: '' });
});

test('changed guard, startup, source overrides and dry-run cannot receive a capability', () => {
  expect(qualifiesForNativeContainment(owner.handler, owner)).toBe(true);
  for (const environment of [
    { ...owner.environment, BASH_ENV: '/caller/startup.sh' },
    { ...owner.environment, CAWS_PRIOR_BASH_ENV: '/caller/startup.sh' },
    { ...owner.environment, CAWS_TRAP_KILL: 'dryrun' },
    { ...owner.environment, CAWS_TRAP_KILL: '0' },
    { ...owner.environment, CAWS_HOOK_DRY_RUN: '1' },
  ])
    expect(createContainmentCapability({ ...owner, environment }, directory)).toBeNull();
  const override = { ...owner.handler, kind: 'project' };
  expect(
    createContainmentCapability(
      { ...owner, handler: override, selection: { ...owner.selection, handlers: [override] } },
      directory
    )
  ).toBeNull();
  fs.appendFileSync(
    path.join(owner.selection.runtimeDirectory, 'handler-env.sh'),
    '\n# changed startup\n'
  );
  expect(createContainmentCapability(owner, directory)).toBeNull();
});

test('composer carries only an owned intent from the selected protective completion, without exposing its authority to observers', async () => {
  intent = validated();
  let observed = false;
  const actual = await composeHandlers(
    { ...owner.selection, handlers: [owner.handler] },
    { requestId: owner.request.id },
    {
      execute: async () => ({ ...block, containment: intent }),
      record: async (row) => {
        if (row.stage === 'handler_completed') {
          observed = true;
          expect(row.result.containment).toBeUndefined();
          row.result.stdout.fill(120);
        }
      },
    }
  );
  expect(observed).toBe(true);
  expect(actual.nativeResult.stdout).toEqual(block.stdout);
  expect(actual.nativeResult.exitCode).toBe(2);
  expect(containmentWire(actual.containment)).toEqual(data);
  expect(actual.containment).not.toBe(intent);
  const forged = await composeHandlers(
    { ...owner.selection, handlers: [owner.handler] },
    { requestId: owner.request.id },
    {
      execute: async () => ({ ...block, containment: { ...intent } }),
      record: () => {},
    }
  );
  expect(forged.containment).toBeNull();
  expect(forged.nativeResult.exitCode).toBe(2);
  expect(forged.nativeResult.stderr.toString()).toContain('executor provenance');
  const allow = await composeHandlers(
    { ...owner.selection, handlers: [owner.handler] },
    { requestId: owner.request.id },
    {
      execute: async () => ({
        exitCode: 0,
        stdout: Buffer.from('{"decision":"allow"}'),
        stderr: Buffer.alloc(0),
        containment: intent,
      }),
      record: () => {},
    }
  );
  expect(allow.containment).toBeNull();
  expect(allow.nativeResult.exitCode).toBe(0);
});

test('handoff v2 correlates every echoed field and rejects forged, contradictory or rounded receipts', () => {
  intent = validated();
  const wire = containmentWire(intent);
  const decode = (value, expected = wire) =>
    decodeHandoff(Buffer.from(JSON.stringify(value)), owner.request, 'proposal-one', expected);
  expect(decode(handoff())).toEqual({ success: true, containment: receipt() });
  expect(decode(handoff({ success: false }))).toEqual({ success: false, containment: receipt() });
  expect(
    decode(handoff({ containment: receipt({ status: 'held', reason: 'identity-mismatch' }) }))
  ).toEqual({
    success: true,
    containment: receipt({ status: 'held', reason: 'identity-mismatch' }),
  });
  for (const field of ['pid', 'startEpoch', 'comm', 'sessionId', 'latchPath', 'latchGeneration']) {
    const changed = field === 'pid' ? 124 : wire[field] + 'x';
    expect(() => decode(handoff({ containment: receipt({ [field]: changed }) }))).toThrow(
      'receipt'
    );
  }
  for (const changed of [
    handoff({ schema: 'caws.runtime.handoff.v1' }),
    handoff({ token: 'neighbor' }),
    handoff({ containment: receipt({ status: 'held' }) }),
    handoff({ containment: receipt({ errno: 1 }) }),
    handoff({ containment: receipt({ extra: true }) }),
  ])
    expect(() => decode(changed)).toThrow();
  expect(() => decode(handoff(), null)).toThrow('receipt');
  const fraction = JSON.stringify(handoff()).replace('"pid":123', '"pid":123.00000000000000001');
  expect(() => decodeHandoff(Buffer.from(fraction), owner.request, 'proposal-one', wire)).toThrow(
    'receipt'
  );
  expect(() =>
    decodeHandoff(Buffer.alloc(64 * 1024 + 1, 32), owner.request, 'proposal-one', wire)
  ).toThrow('byte limit');
});

test('effect receipts and lost acknowledgements are separate from output acceptance and never rewrite a latch', () => {
  intent = validated();
  const before = fs.readFileSync(data.latchPath);
  const events = [];
  const journal = { append: (stage, fields) => events.push({ stage, ...fields }), diagnostics: [] };
  recordContainmentHandoff(journal, intent, false, null);
  expect(events[0]).toMatchObject({
    stage: 'containment_settled',
    native_output_accepted: false,
    effect_observation: 'not_observed',
    receipt: null,
    process_exit_observed: false,
    legacy_latch_written: false,
    latch_state: 'unchanged',
  });
  recordContainmentHandoff(journal, intent, true, receipt());
  expect(events[1]).toMatchObject({
    native_output_accepted: true,
    effect_observation: 'signal-accepted',
    process_exit_observed: false,
    legacy_latch_written: false,
  });
  expect(fs.readFileSync(data.latchPath)).toEqual(before);
  put(data.latchPath, { ...latch, latch_generation: 'b'.repeat(32) });
  const replacement = fs.readFileSync(data.latchPath);
  recordContainmentHandoff(journal, intent, true, receipt());
  expect(events[2].latch_state).toBe('changed');
  expect(fs.readFileSync(data.latchPath)).toEqual(replacement);
  recordContainmentHandoff(journal, intent, false, receipt());
  expect(events[3]).toMatchObject({
    native_output_accepted: false,
    effect_observation: 'signal-accepted',
    process_exit_observed: false,
  });
  const count = events.length;
  expect(() => recordContainmentHandoff(journal, intent, true, receipt({ pid: 124 }))).toThrow(
    'receipt'
  );
  expect(events).toHaveLength(count);
});

test('non-ASCII session filenames match the selected bytewise shell sanitizer', () => {
  const sid = 'session-雪-😀';
  owner = { ...owner, environment: { ...owner.environment, CAWS_SESSION_ID: sid } };
  data = {
    ...data,
    sessionId: sid,
    latchPath: path.join(
      owner.selection.checkout,
      '.codex/hooks/state/danger-latch-session-___-____.json'
    ),
  };
  put(data.latchPath, latch);
  expect(containmentWire(validated())).toEqual(data);
});

test('source mutation after a grant cannot mint a completed intent', () => {
  const cap = capability();
  put(cap.file, data);
  fs.appendFileSync(owner.handler.path, '\n# changed after grant\n');
  const actual = cap.consume(block);
  expect(actual.intent).toBeNull();
  expect(actual.diagnostic).toContain('source changed');
});

test('a mixed handler selection cannot receive native containment capability', () => {
  const extension = { ...owner.handler, kind: 'project', path: '/project/extension.sh' };
  expect(
    createContainmentCapability(
      {
        ...owner,
        selection: { ...owner.selection, handlers: [...owner.selection.handlers, extension] },
      },
      directory
    )
  ).toBeNull();
});

test('escaped maximum-size intent fields fit the admitted handoff envelope', () => {
  // JSON escaping expands bytes; the handoff bound must cover that expansion.
  data = { ...data, comm: '\u0001'.repeat(4096) };
  latch = { ...latch, agent_pid_comm: data.comm };
  put(data.latchPath, latch);
  intent = validated();
  const bytes = Buffer.from(JSON.stringify(handoff()));
  expect(bytes.length).toBeGreaterThan(16 * 1024);
  expect(bytes.length).toBeLessThanOrEqual(64 * 1024);
  expect(decodeHandoff(bytes, owner.request, 'proposal-one', containmentWire(intent))).toEqual({
    success: true,
    containment: receipt(),
  });
});
