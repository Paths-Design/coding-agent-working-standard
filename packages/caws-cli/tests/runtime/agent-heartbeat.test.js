const fs = require('node:fs');
const { AbortController } = globalThis;
const os = require('node:os');
const path = require('node:path');
const { executeAgentHeartbeat } = require('../../dist/runtime/agent-heartbeat');
const { heartbeatAgentActivity } = require('../../dist/application/agent-heartbeat');
const { pollAgentMessages } = require('../../dist/application/message-poll');
const {
  sendMessage,
  settleMessageOffer,
  getMessageDeliveryState,
} = require('../../dist/store/messages-store');
const { composeHandlers } = require('../../dist/runtime/composer');
let directory, checkout, canonical, context, now;
function metadata(ctx = context) {
  return {
    repo_root: ctx.selection.canonical,
    cwd: ctx.selection.checkout,
    git_common_dir: path.join(ctx.selection.canonical, '.git'),
    git_dir: path.join(ctx.selection.checkout, '.git'),
    hook_pid: ctx.request.caller.processId,
  };
}
function summary(peers = []) {
  return {
    ok: true,
    value: {
      ok: true,
      session_id: 'same-session',
      wrote: false,
      throttled: true,
      lease_path: '.caws/leases/same-session.json',
      active_agent_count: peers.length + 1,
      active_agents: [{ session_id: 'same-session', is_self: true }, ...peers],
    },
  };
}
function peer(id = 'peer', branch = 'main') {
  return {
    session_id: id,
    is_self: false,
    bound_worktree: null,
    bound_spec_id: null,
    git_dir_kind: 'canonical',
    branch,
    last_active_age_ms: 1000,
  };
}
function mail(text = 'STOP — verify', count = 0) {
  const message = {
    record: 'message',
    id: 'message-1',
    actor: { kind: 'agent', id: 'other', session_id: 'other' },
    to: 'same-session',
    text,
    channel: 'default',
    ts: new Date(now).toISOString(),
    urgency: 'critical',
  };
  return {
    ok: true,
    value: {
      message,
      messages: [{ message }],
      offer: { id: 'exact-offer', recipient: 'same-session' },
      waiting: 3,
      poll_ms: 2,
      mine_queued_1h: { count, oldest_age_ms: 3_600_000 },
    },
  };
}
function ports(overrides = {}) {
  return {
    heartbeat: jest.fn(() => summary()),
    poll: jest.fn(() => mail()),
    leaseContext: jest.fn(async (ctx) => metadata(ctx)),
    now: () => new Date(now),
    ...overrides,
  };
}
function output(result) {
  return Buffer.from(result.stdout).length
    ? JSON.parse(Buffer.from(result.stdout).toString()).hookSpecificOutput.additionalContext
    : '';
}
beforeEach(() => {
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'caws-heartbeat-consumer-')));
  checkout = path.join(directory, 'checkout');
  canonical = path.join(directory, 'canonical');
  for (const root of [checkout, canonical])
    fs.mkdirSync(path.join(root, '.caws'), { recursive: true });
  now = Date.now();
  const payload = { session_id: 'same-session', tool_name: 'Bash' };
  context = {
    request: {
      payload,
      inputJson: JSON.stringify(payload),
      caller: { processId: 9876 },
      deadlineEpochMs: now + 60_000,
    },
    selection: { checkout, canonical },
    environment: {},
    signal: new AbortController().signal,
  };
});
afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

test.each([undefined, '', 'unknown', 17])(
  'payload identity %p is inert despite environment and cache identity',
  async (session_id) => {
    context.request.payload.session_id = session_id;
    context.environment = {
      CAWS_SESSION_ID: 'environment-session',
      CODEX_THREAD_ID: 'another-session',
    };
    const p = ports();
    const result = await executeAgentHeartbeat(context, p);
    expect(output(result)).toBe('');
    expect(result.exitCode).toBe(0);
    expect(p.leaseContext).not.toHaveBeenCalled();
    expect(p.heartbeat).not.toHaveBeenCalled();
    expect(p.poll).not.toHaveBeenCalled();
  }
);
test('heartbeat refusal and thrown writes are silent and stop polling', async () => {
  for (const heartbeat of [
    () => ({ ok: false, stage: 'load', errors: [] }),
    () => {
      throw new Error('store failure');
    },
  ]) {
    const p = ports({ heartbeat });
    const result = await executeAgentHeartbeat(context, p);
    expect(output(result)).toBe('');
    expect(result.exitCode).toBe(0);
    expect(p.poll).not.toHaveBeenCalled();
  }
});
test('15s heartbeat write throttle still polls critical mail and returns exact offer without settlement', async () => {
  const p = ports();
  const result = await executeAgentHeartbeat(context, p);
  expect(p.heartbeat.mock.calls[0][0]).toMatchObject({
    cawsDir: path.join(canonical, '.caws'),
    context: { hook_pid: 9876 },
    throttleMs: 15_000,
    reason: 'pre_tool_use',
    includeActiveSummary: true,
    identity: { session_id: 'same-session', platform: 'codex' },
  });
  expect(p.poll.mock.calls[0][0]).toMatchObject({
    cawsDir: path.join(canonical, '.caws'),
    recipient: 'same-session',
    options: { receipt: 'auto', drain: 5, offer: true, offerTtlMs: 30_000 },
  });
  expect(output(result)).toContain('CRITICAL MESSAGE');
  expect(output(result)).toContain('STOP — verify');
  expect(result.offers).toEqual([{ offerId: 'exact-offer', recipient: 'same-session' }]);
  const telemetry = JSON.parse(
    fs.readFileSync(path.join(checkout, '.caws/leases/heartbeat-message-telemetry.jsonl'), 'utf8')
  );
  expect(telemetry).toMatchObject({
    session_id: 'same-session',
    injected_count: 1,
    bytes: output(result).length,
    waiting: 3,
    poll_ms: 2,
  });
  expect(
    fs.existsSync(path.join(canonical, '.caws/leases/heartbeat-message-telemetry.jsonl'))
  ).toBe(false);
});
test.each([
  ['1', 1],
  ['999999999', 300_000],
  ['-10', 1],
  ['', 30_000],
  ['malformed', 30_000],
])('offer TTL %p stays bounded', async (raw, expected) => {
  context.environment.CAWS_MESSAGE_OFFER_TTL_MS = raw;
  const p = ports();
  await executeAgentHeartbeat(context, p);
  expect(p.poll.mock.calls[0][0].options.offerTtlMs).toBe(expected);
});
test('peer hash ignores age, records changed suppressed peers and emits a later changed set', async () => {
  const p = ports({
    heartbeat: jest.fn(() => summary([peer()])),
    poll: jest.fn(() => ({ ok: false, stage: 'poll', errors: [] })),
  });
  expect(output(await executeAgentHeartbeat(context, p))).toContain('peer (no worktree)');
  const file = path.join(checkout, '.caws/leases/heartbeat-emit-state.json');
  const first = JSON.parse(fs.readFileSync(file, 'utf8'));
  p.heartbeat.mockReturnValue(summary([{ ...peer(), last_active_age_ms: 80000 }]));
  now += 1000;
  expect(output(await executeAgentHeartbeat(context, p))).toBe('');
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(first);
  p.heartbeat.mockReturnValue(summary([peer('peer', 'changed')]));
  expect(output(await executeAgentHeartbeat(context, p))).toBe('');
  const suppressed = JSON.parse(fs.readFileSync(file, 'utf8'));
  expect(suppressed.peer_set_hash).not.toBe(first.peer_set_hash);
  expect(suppressed.last_emitted_ts_ms).toBe(first.last_emitted_ts_ms);
  now += 61_000;
  context.request.deadlineEpochMs = now + 60_000;
  expect(output(await executeAgentHeartbeat(context, p))).toBe('');
  p.heartbeat.mockReturnValue(summary([peer('third')]));
  expect(output(await executeAgentHeartbeat(context, p))).toContain('third (no worktree)');
});
test('peer and mail share one envelope and one blank-line boundary', async () => {
  const p = ports({ heartbeat: () => summary([peer()]) });
  const result = await executeAgentHeartbeat(context, p);
  expect(output(result)).toContain('verify it against the repo.\n\nCRITICAL MESSAGE');
  expect(Buffer.from(result.stdout).toString().trim().split('\n')).toHaveLength(1);
});
test('dead letters emit without inbound messages, suppress unchanged count, and re-emit on time or count', async () => {
  const value = {
    message: null,
    messages: [],
    waiting: 0,
    poll_ms: 1,
    mine_queued_1h: { count: 2, oldest_age_ms: 3_600_000 },
  };
  const p = ports({ poll: () => ({ ok: true, value }) });
  expect(output(await executeAgentHeartbeat(context, p))).toBe(
    '2 of YOUR sent messages are still undelivered after 1h — caws message status --mine --queued --older-than-ms 3600000.'
  );
  expect(output(await executeAgentHeartbeat(context, p))).toBe('');
  now += 3_600_001;
  context.request.deadlineEpochMs = now + 60_000;
  expect(output(await executeAgentHeartbeat(context, p))).toContain('2 of YOUR');
  value.mine_queued_1h.count = 3;
  expect(output(await executeAgentHeartbeat(context, p))).toContain('3 of YOUR');
});
test('same session id in two canonical repositories never shares lease/mail or peer cache state', async () => {
  const p = ports({ heartbeat: () => summary([peer()]) });
  expect(output(await executeAgentHeartbeat(context, p))).toContain('MULTI-AGENT NOTICE');
  const other = path.join(directory, 'other');
  fs.mkdirSync(path.join(other, '.caws'), { recursive: true });
  context.selection = { checkout: other, canonical: other };
  expect(output(await executeAgentHeartbeat(context, p))).toContain('MULTI-AGENT NOTICE');
  expect(p.poll.mock.calls.map(([input]) => input.cawsDir)).toEqual([
    path.join(canonical, '.caws'),
    path.join(other, '.caws'),
  ]);
});
test('real application stores retain offered mail until exact settlement, including after heartbeat throttle', async () => {
  const p = ports({ heartbeat: heartbeatAgentActivity, poll: pollAgentMessages });
  await executeAgentHeartbeat(context, p);
  const cawsDir = path.join(canonical, '.caws');
  const sent = sendMessage(cawsDir, {
    actor: { kind: 'agent', id: 'sender', session_id: 'sender' },
    to: 'same-session',
    text: 'critical stop',
    urgency: 'critical',
  });
  expect(sent.ok).toBe(true);
  const result = await executeAgentHeartbeat(context, p);
  expect(output(result)).toContain('critical stop');
  expect(result.offers).toHaveLength(1);
  const before = getMessageDeliveryState(cawsDir, sent.value.message.id);
  expect(before.ok).toBe(true);
  expect(before.value.delivered).toBe(false);
  const lease = JSON.parse(fs.readFileSync(path.join(cawsDir, 'leases/same-session.json'), 'utf8'));
  expect(lease.hook_pid).toBe(9876);
  const offer = result.offers[0];
  const settled = settleMessageOffer(cawsDir, offer.offerId, offer.recipient, 'released');
  expect(settled.ok).toBe(true);
  expect(output(await executeAgentHeartbeat(context, p))).toContain('critical stop');
});

test('composer releases the exact heartbeat offer after a later protective guard or failed dispatch', async () => {
  const offered = await executeAgentHeartbeat(context, ports());
  const handlers = ['agent-heartbeat.sh', 'later-guard.sh'].map((name) => ({
    name,
    entry: name,
    args: [],
    path: '/fixture/' + name,
    sha256: 'a'.repeat(64),
    tier: 'stock',
    kind: 'stock',
  }));
  const selection = { ...context.selection, surface: 'codex', event: 'pre_tool_use', handlers };
  const blocked = await composeHandlers(
    selection,
    {},
    {
      record: () => {},
      execute: async (_, index) =>
        index === 0
          ? offered
          : {
              exitCode: 2,
              stdout: Buffer.from('{"decision":"block","reason":"protected"}\n'),
              stderr: Buffer.alloc(0),
            },
    }
  );
  expect(blocked.nativeResult.exitCode).toBe(2);
  expect(blocked.offers).toEqual([
    expect.objectContaining({
      offerId: 'exact-offer',
      recipient: 'same-session',
      action: 'released',
    }),
  ]);
  await expect(
    composeHandlers(
      selection,
      {},
      {
        record: () => {},
        execute: async (_, index) => {
          if (!index) return offered;
          throw new Error('handoff did not complete');
        },
      }
    )
  ).rejects.toMatchObject({
    offers: [expect.objectContaining({ offerId: 'exact-offer', action: 'released' })],
  });
});

test('production metadata persists native frontend PID rather than engine PID', async () => {
  const contextModule = require('../../dist/runtime/context');
  const common = path.join(canonical, '.git'),
    gitDir = path.join(checkout, '.git');
  fs.mkdirSync(common);
  fs.mkdirSync(gitDir);
  const run = jest.fn(async (args) =>
    args.includes('--git-common-dir') ? common : args.includes('--git-dir') ? gitDir : 'feature'
  );
  const spy = jest.spyOn(contextModule, 'createContextGitPort').mockReturnValue({ run });
  try {
    await executeAgentHeartbeat(context);
    const lease = JSON.parse(
      fs.readFileSync(path.join(canonical, '.caws/leases/same-session.json'), 'utf8')
    );
    expect(lease.hook_pid).toBe(9876);
    expect(lease.hook_pid).not.toBe(process.pid);
    expect(lease).toMatchObject({
      repo_root: canonical,
      cwd: checkout,
      git_common_dir: common,
      git_dir: gitDir,
      branch: 'feature',
    });
    expect(run.mock.calls.every(([, cwd]) => cwd === checkout)).toBe(true);
  } finally {
    spy.mockRestore();
  }
});

test('canonical poll sender specId reaches the message tag while absent sender fields remain inert', async () => {
  const p = ports({ heartbeat: heartbeatAgentActivity, poll: pollAgentMessages });
  await executeAgentHeartbeat(context, p);
  const registered = heartbeatAgentActivity({
    cawsDir: path.join(canonical, '.caws'),
    identity: { session_id: 'sender', platform: 'codex' },
    context: { ...metadata(), bound_worktree: 'sender-lane', bound_spec_id: 'SENDER-SPEC' },
    now: () => new Date(now),
    reason: 'pre_tool_use',
  });
  expect(registered.ok).toBe(true);
  expect(
    sendMessage(path.join(canonical, '.caws'), {
      actor: { kind: 'agent', id: 'sender', session_id: 'sender' },
      to: 'same-session',
      text: 'tagged',
    }).ok
  ).toBe(true);
  const tagged = await executeAgentHeartbeat(context, p);
  expect(output(tagged)).toContain('(worktree sender-lane, spec SENDER-SPEC):\ntagged');
  const absent = await executeAgentHeartbeat(context, ports());
  expect(output(absent)).toContain('(id other):\nSTOP — verify');
  expect(output(absent)).not.toContain('spec undefined');
});

test('fork annotations reach canonical lease and malformed fork context stops mail polling', async () => {
  context.environment = { CAWS_SESSION_KIND: 'fork', CAWS_FORKED_FROM: 'parent-session' };
  const p = ports({ heartbeat: heartbeatAgentActivity });
  await executeAgentHeartbeat(context, p);
  const lease = JSON.parse(
    fs.readFileSync(path.join(canonical, '.caws/leases/same-session.json'), 'utf8')
  );
  expect(lease).toMatchObject({ harness_session_kind: 'fork', forked_from: 'parent-session' });
  context.environment.CAWS_SESSION_KIND = 'main';
  p.poll.mockClear();
  expect(output(await executeAgentHeartbeat(context, p))).toBe('');
  expect(p.poll).not.toHaveBeenCalled();
});
test('redirected checkout sidecars cannot write outside the checkout and never suppress mail', async () => {
  const outside = path.join(directory, 'outside');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(checkout, '.caws/leases'));
  const result = await executeAgentHeartbeat(
    context,
    ports({ heartbeat: () => summary([peer()]) })
  );
  expect(output(result)).toContain('MULTI-AGENT NOTICE');
  expect(output(result)).toContain('CRITICAL MESSAGE');
  expect(result.offers).toEqual([{ offerId: 'exact-offer', recipient: 'same-session' }]);
  expect(fs.readdirSync(outside)).toEqual([]);
});

// The runtime guarantees payload is the parse of inputJson (or {} for empty input).
function ingress(payload, inputJson = JSON.stringify(payload)) {
  context.request.payload = payload;
  context.request.inputJson = inputJson;
}
function offerRecords(cawsDir, id) {
  return fs
    .readFileSync(path.join(cawsDir, 'messages.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((record) => record.record === 'offer' && record.deliver_ids.includes(id));
}
function queue(text) {
  const cawsDir = path.join(canonical, '.caws');
  const sent = sendMessage(cawsDir, {
    actor: { kind: 'agent', id: 'sender', session_id: 'sender' },
    to: 'same-session',
    text,
    requireLive: false,
  });
  expect(sent.ok).toBe(true);
  return { cawsDir, id: sent.value.message.id };
}

// A subagent's hooks carry the parent's session id; offering the parent's mail there
// would settle it into a context the parent never reads.
test.each([['sub-1'], [''], [7], [null]])(
  'agent_id %p keeps the lease write and peer notice but never polls the parent mailbox',
  async (agentId) => {
    ingress({ session_id: 'same-session', tool_name: 'Bash', agent_id: agentId });
    const p = ports({ heartbeat: jest.fn(() => summary([peer()])) });
    const result = await executeAgentHeartbeat(context, p);
    expect(p.heartbeat).toHaveBeenCalledTimes(1);
    expect(p.poll).not.toHaveBeenCalled();
    expect(output(result)).toContain('MULTI-AGENT NOTICE');
    expect(output(result)).not.toContain('MESSAGE from');
    expect(result.offers).toEqual([]);
  }
);
test('real stores keep subagent-observed mail pending until the parent context offers it once', async () => {
  const p = ports({ heartbeat: heartbeatAgentActivity, poll: pollAgentMessages });
  const { cawsDir, id } = queue('for the parent only');

  ingress({
    session_id: 'same-session',
    tool_name: 'Bash',
    agent_id: 'a13a6319c8155f001',
    agent_type: 'general-purpose',
  });
  const fromSubagent = await executeAgentHeartbeat(context, p);
  expect(output(fromSubagent)).not.toContain('for the parent only');
  expect(fromSubagent.offers).toEqual([]);
  expect(offerRecords(cawsDir, id)).toEqual([]);
  expect(getMessageDeliveryState(cawsDir, id).value.delivered).toBe(false);

  ingress({ session_id: 'same-session', tool_name: 'Bash' });
  const fromParent = await executeAgentHeartbeat(context, p);
  expect(output(fromParent)).toContain('for the parent only');
  expect(fromParent.offers).toHaveLength(1);
  expect(offerRecords(cawsDir, id)).toHaveLength(1);
  const [offer] = fromParent.offers;
  expect(offer.recipient).toBe('same-session');
  expect(settleMessageOffer(cawsDir, offer.offerId, offer.recipient, 'delivered').ok).toBe(true);
  expect(getMessageDeliveryState(cawsDir, id).value.delivered).toBe(true);
  expect(output(await executeAgentHeartbeat(context, p))).not.toContain('for the parent only');
});

// Empty hook input is admitted as payload {}; custody follows the original text, so the
// same session context is withheld for absent or unparseable input and offered once for
// a valid main-thread object.
test.each([
  ['empty', ''],
  ['malformed', '{"session_id":"same-session"'],
  ['non-object', '[{"session_id":"same-session"}]'],
])(
  'real stores withhold for %s original input with session context, then offer a valid original once',
  async (_, inputJson) => {
    const p = ports({ heartbeat: heartbeatAgentActivity, poll: pollAgentMessages });
    const { cawsDir, id } = queue('original-input custody');
    ingress({ session_id: 'same-session', tool_name: 'Bash' }, inputJson);
    const absent = await executeAgentHeartbeat(context, p);
    expect(output(absent)).not.toContain('original-input custody');
    expect(absent.offers).toEqual([]);
    expect(offerRecords(cawsDir, id)).toEqual([]);
    expect(getMessageDeliveryState(cawsDir, id).value.delivered).toBe(false);

    ingress({ session_id: 'same-session', tool_name: 'Bash' });
    const valid = await executeAgentHeartbeat(context, p);
    expect(output(valid)).toContain('original-input custody');
    expect(valid.offers).toHaveLength(1);
    expect(offerRecords(cawsDir, id)).toHaveLength(1);
  }
);
