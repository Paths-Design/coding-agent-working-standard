const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { AbortController } = globalThis;
const { sendMessage, getMessageDeliveryState } = require('../../dist/store/messages-store');
const { heartbeatAgentActivity } = require('../../dist/application/agent-heartbeat');
const { readGitDirInfo } = require('../../dist/store/repo-root');
const { createHandlerExecutor } = require('../../dist/runtime/handler-executor');
const { actorContext } = require('../../dist/runtime/actor-context');
const ROWS = require('./actor-context-rows.json');

jest.setTimeout(180_000);

const CLI = path.resolve(__dirname, '../..');
// Falsifier runs point this at a disposable copy of the shared tree carrying one edit.
const SHARED =
  process.env.CAWS_HEARTBEAT_CUSTODY_SHARED_DIR || path.join(CLI, 'templates/hook-packs/shared');
const PLACEHOLDER = 'custody-session';
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

let root,
  repo,
  hooks,
  env,
  counter = 0;

function cleanEnvironment() {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) =>
        typeof value === 'string' &&
        !/^(GIT_|HOOK_|CAWS_)/.test(key) &&
        key !== 'BASH_ENV' &&
        key !== 'NODE_OPTIONS'
    )
  );
}
function run(executable, args, { input = '', extra = {} } = {}) {
  return spawnSync(executable, args, {
    cwd: repo,
    env: { ...env, ...extra },
    input,
    encoding: 'utf8',
    timeout: 90_000,
  });
}

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'caws-heartbeat-custody-')));
  const home = path.join(root, 'user');
  const bin = path.join(root, 'bin');
  for (const directory of [home, bin, path.join(root, 'machine'), path.join(root, 'tmp')])
    fs.mkdirSync(directory);
  repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  const caws = path.join(bin, 'caws');
  fs.writeFileSync(
    caws,
    `#!/bin/sh\nexec '${process.execPath}' '${path.join(CLI, 'dist/index.js')}' "$@"\n`,
    { mode: 0o755 }
  );
  env = {
    ...cleanEnvironment(),
    HOME: home,
    CAWS_HOME: path.join(root, 'machine'),
    TMPDIR: path.join(root, 'tmp'),
    CAWS_BIN: caws,
    CAWS_PROJECT_DIR: repo,
    CAWS_AGENT_SURFACE: 'claude-code',
    GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'),
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C',
  };
  const git = (...args) => {
    const result = run('git', args);
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  };
  git('-c', 'init.defaultBranch=main', 'init', '-q');
  git('config', 'core.hooksPath', '/dev/null');
  fs.writeFileSync(path.join(repo, 'fixture.txt'), 'heartbeat custody fixture\n');
  git('add', 'fixture.txt');
  git(
    '-c',
    'user.name=Custody',
    '-c',
    'user.email=custody@example.invalid',
    'commit',
    '-qm',
    'fixture'
  );
  const init = run(process.execPath, [
    path.join(CLI, 'dist/index.js'),
    'init',
    '--agent-surface',
    'none',
  ]);
  if (init.status !== 0) throw new Error(`caws init: ${init.stdout}${init.stderr}`);
  hooks = path.join(repo, 'hooks');
  fs.cpSync(SHARED, hooks, { recursive: true });
  // Installed hooks are executable; run_handlers skips a non-executable handler as missing.
  for (const entry of fs.readdirSync(hooks, { recursive: true }))
    if (entry.endsWith('.sh')) fs.chmodSync(path.join(hooks, entry), 0o755);
  // The copied tree doubles as the typed executor's runtime directory, with the real preload.
  fs.copyFileSync(
    path.join(CLI, 'templates/hook-packs/runtime/handler-env.sh'),
    path.join(hooks, 'handler-env.sh')
  );
});
afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function session() {
  counter += 1;
  return `custody-${counter}`;
}
function seed(sessionId) {
  const text = `custody mail for ${sessionId}`;
  const sent = sendMessage(path.join(repo, '.caws'), {
    actor: { kind: 'agent', id: 'peer', session_id: 'peer' },
    to: sessionId,
    text,
    requireLive: false,
  });
  if (!sent.ok) throw new Error(JSON.stringify(sent));
  return { id: sent.value.message.id, text, to: sessionId };
}
function offers(id) {
  return fs
    .readFileSync(path.join(repo, '.caws/messages.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((record) => record.record === 'offer' && record.deliver_ids.includes(id));
}
// The lease proves the heartbeat ran for this session, so a withheld result cannot
// come from a handler that never executed.
function custody(mail, stdout) {
  const state = getMessageDeliveryState(path.join(repo, '.caws'), mail.id);
  if (!state.ok) throw new Error(JSON.stringify(state));
  return {
    ran: fs.existsSync(path.join(repo, '.caws/leases', `${mail.to}.json`)),
    shown: stdout.includes(mail.text),
    delivered: state.value.delivered,
    offers: offers(mail.id).length,
  };
}
const WITHHELD = { ran: true, shown: false, delivered: false, offers: 0 };
const CONSUMED = { ran: true, shown: true, delivered: true, offers: 0 };
const RESERVED = { ran: true, shown: true, delivered: false, offers: 1 };

function payload(sessionId, extra = {}) {
  return {
    session_id: sessionId,
    hook_event_name: 'PreToolUse',
    cwd: repo,
    tool_name: 'Read',
    tool_input: { file_path: path.join(repo, 'fixture.txt') },
    ...extra,
  };
}
const SUBAGENT = { agent_id: 'a13a6319c8155f001', agent_type: 'general-purpose' };
// What a dispatcher exports to its handlers after parsing: the known fast path.
const fastPath = (sessionId) => ({
  HOOK_TOOL_NAME: 'Read',
  HOOK_SESSION_ID: sessionId,
  HOOK_EVENT_NAME: 'PreToolUse',
  HOOK_CWD: repo,
});
const heartbeat = (input, extra) =>
  run('/bin/bash', [path.join(hooks, 'agent-heartbeat.sh')], { input, extra });
const dispatcher = (input, extra) =>
  run('/bin/bash', [path.join(hooks, 'dispatch/pre_tool_use.sh')], { input, extra });

async function typedExecutor(value, extra = {}) {
  const file = path.join(hooks, 'agent-heartbeat.sh');
  const selected = {
    name: 'agent-heartbeat.sh',
    entry: 'agent-heartbeat.sh',
    args: [],
    path: file,
    sha256: sha(file),
    kind: 'project-override',
    tier: 'repo-policy',
  };
  const selection = {
    status: 'active',
    runtimeDigest: 'b'.repeat(64),
    checkout: repo,
    canonical: repo,
    surface: 'claude-code',
    event: 'pre_tool_use',
    configuration: 'system',
    runtimeDirectory: hooks,
    hooksDirectory: hooks,
    handlers: [selected],
    libraries: {},
    overrides: { 'agent-heartbeat.sh': file },
    libraryOverrides: {},
    transcriptAdapter: null,
  };
  const environment = { ...env, ...extra };
  const request = {
    schema: 'caws.runtime.request.v1',
    id: 'heartbeat-custody',
    runtimeDigest: selection.runtimeDigest,
    surface: 'claude-code',
    event: 'pre_tool_use',
    configuration: 'system',
    caller: { cwd: repo, environment },
    deadlineEpochMs: Date.now() + 90_000,
    payload: value,
    inputJson: JSON.stringify(value),
  };
  const execute = createHandlerExecutor({
    request,
    selection,
    environment,
    signal: new AbortController().signal,
  });
  const result = await execute(selected, 0);
  return { status: result.exitCode, stdout: Buffer.from(result.stdout).toString() };
}

describe('shell heartbeat decides mail custody from its own ingress, matching actorContext', () => {
  test.each(ROWS.filter((row) => row.object))(
    'parsed by the handler: $label',
    ({ json, expected }) => {
      let parsed;
      try {
        parsed = JSON.parse(json);
      } catch {
        parsed = undefined;
      }
      expect(actorContext(parsed)).toBe(expected);
      const sid = session();
      const mail = seed(sid);
      const result = heartbeat(json.replaceAll(PLACEHOLDER, sid));
      expect(result.status).toBe(0);
      expect(custody(mail, result.stdout)).toEqual(expected === 'main' ? CONSUMED : WITHHELD);
    }
  );

  test.each(ROWS)('read from stdin on the dispatcher fast path: $label', ({ json, expected }) => {
    const sid = session();
    const mail = seed(sid);
    const result = heartbeat(json.replaceAll(PLACEHOLDER, sid), fastPath(sid));
    expect(result.status).toBe(0);
    expect(custody(mail, result.stdout)).toEqual(expected === 'main' ? CONSUMED : WITHHELD);
  });
});

describe('every carrier preserves the original actor context', () => {
  test.each([
    ['subagent', SUBAGENT, WITHHELD],
    ['parent', {}, CONSUMED],
  ])('spill transport (inline threshold 0): %s', (_, extra, expected) => {
    const sid = session();
    const mail = seed(sid);
    const result = heartbeat(JSON.stringify(payload(sid, extra)), {
      CAWS_HOOK_INLINE_PAYLOAD_MAX_BYTES: '0',
    });
    expect(result.status).toBe(0);
    expect(custody(mail, result.stdout)).toEqual(expected);
  });

  test.each([
    ['subagent', SUBAGENT, WITHHELD],
    ['parent', {}, CONSUMED],
  ])('project dispatcher with the full stock chain: %s', (_, extra, expected) => {
    const sid = session();
    const mail = seed(sid);
    const result = dispatcher(JSON.stringify(payload(sid, extra)));
    expect(result.status).toBe(0);
    expect(custody(mail, result.stdout)).toEqual(expected);
  });

  test.each([
    ['subagent inline', SUBAGENT, {}, false],
    ['parent inline', {}, {}, true],
    ['subagent spilled', SUBAGENT, { CAWS_HOOK_INLINE_PAYLOAD_MAX_BYTES: '0' }, false],
    ['parent spilled', {}, { CAWS_HOOK_INLINE_PAYLOAD_MAX_BYTES: '0' }, true],
  ])('typed per-handler executor: %s', async (_, extra, environment, offered) => {
    const sid = session();
    const mail = seed(sid);
    const result = await typedExecutor(payload(sid, extra), environment);
    expect(result.status).toBe(0);
    // The executor supplies the settlement channel, so a parent poll reserves rather than consumes.
    expect(custody(mail, result.stdout)).toEqual(offered ? RESERVED : WITHHELD);
  });
});

describe('inherited environment never vouches for main-thread ingress', () => {
  // The dispatcher's own response to this environment is outside this contract (it does
  // not currently reach its handlers); only the parent's mail outcome is pinned here. The
  // handler-level case below and the empty-stdin fast-path row pin the heartbeat's decision.
  test('project dispatcher with inherited HOOK_TOOL_NAME and HOOK_ACTOR_CONTEXT=main', () => {
    const sid = session();
    const mail = seed(sid);
    const result = dispatcher(JSON.stringify(payload(sid, SUBAGENT)), {
      HOOK_TOOL_NAME: 'Read',
      HOOK_SESSION_ID: sid,
      HOOK_ACTOR_CONTEXT: 'main',
    });
    expect(custody(mail, result.stdout)).toMatchObject({
      shown: false,
      delivered: false,
      offers: 0,
    });
  });

  test('handler fast path with HOOK_ACTOR_CONTEXT=main still reads the subagent bytes on stdin', () => {
    const sid = session();
    const mail = seed(sid);
    const result = heartbeat(JSON.stringify(payload(sid, SUBAGENT)), {
      ...fastPath(sid),
      HOOK_ACTOR_CONTEXT: 'main',
    });
    expect(result.status).toBe(0);
    expect(custody(mail, result.stdout)).toEqual(WITHHELD);
  });

  test('a preset HOOK_INPUT_JSON without a parse marker is inherited, not witnessed', () => {
    const sid = session();
    const mail = seed(sid);
    const result = heartbeat(JSON.stringify(payload(sid, SUBAGENT)), {
      HOOK_INPUT_JSON: JSON.stringify(payload(sid)),
    });
    expect(result.status).toBe(0);
    expect(custody(mail, result.stdout)).toEqual(WITHHELD);
  });
});

test('a subagent call keeps the lease write and peer notice while the mail waits', () => {
  const cawsDir = path.join(repo, '.caws');
  const registered = heartbeatAgentActivity({
    cawsDir,
    identity: { session_id: 'custody-peer', platform: 'claude-code' },
    context: { repo_root: repo, cwd: repo, ...readGitDirInfo(repo), hook_pid: process.pid },
    now: () => new Date(),
    reason: 'pre_tool_use',
  });
  expect(registered.ok).toBe(true);
  const sid = session();
  const mail = seed(sid);
  // The notice is rate-limited project-wide; earlier cases in this file must not suppress it.
  const result = heartbeat(JSON.stringify(payload(sid, SUBAGENT)), {
    HEARTBEAT_EMIT_MIN_INTERVAL_MS: '0',
  });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('MULTI-AGENT NOTICE');
  expect(result.stdout).toContain('custody-peer');
  expect(custody(mail, result.stdout)).toEqual(WITHHELD);
  expect(fs.existsSync(path.join(cawsDir, 'leases', `${sid}.json`))).toBe(true);
});

test('mail observed by a subagent call is offered exactly once at the next parent call', async () => {
  const sid = session();
  const mail = seed(sid);
  const fromSubagent = await typedExecutor(payload(sid, SUBAGENT));
  expect(custody(mail, fromSubagent.stdout)).toEqual(WITHHELD);
  const fromParent = await typedExecutor(payload(sid));
  expect(custody(mail, fromParent.stdout)).toEqual(RESERVED);
  expect(fromParent.stdout.split(mail.text)).toHaveLength(2);
});
