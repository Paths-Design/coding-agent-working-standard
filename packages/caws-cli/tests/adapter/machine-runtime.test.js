'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  installMachineRuntime,
  rollbackMachineRuntime,
} = require('../../dist/init/machine-adapters');
const { getMessageDeliveryState } = require('../../dist/store/messages-store');

const templatesRoot = path.resolve(__dirname, '../../templates/hook-packs');
let root;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'caws machine runtime '));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function repository(name, handlers) {
  const repo = path.join(root, name);
  fs.mkdirSync(path.join(repo, '.caws/hooks'), { recursive: true });
  const git = spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, encoding: 'utf8' });
  expect(git.status).toBe(0);
  for (const [script, body] of Object.entries(handlers)) {
    fs.writeFileSync(path.join(repo, '.caws/hooks', script), '#!/bin/bash\n' + body, {
      mode: 0o755,
    });
  }
  fs.writeFileSync(
    path.join(repo, '.caws/hooks/adapter-policy.json'),
    JSON.stringify({
      version: 1,
      surfaces: {
        codex: {
          events: {
            pre_tool_use: {
              hooks_dir: '.caws/hooks',
              handlers: Object.keys(handlers),
            },
          },
          libraries: {},
        },
      },
    })
  );
  return repo;
}

function invoke(home, repo, session = 'machine-runtime-test', event = 'pre_tool_use', extraEnv = {}) {
  return spawnSync('python3', [path.join(home, 'bin/caws-hook'), 'codex', event], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, CAWS_HOME: home, CAWS_PROJECT_DIR: repo, ...extraEnv },
    input: JSON.stringify({
      tool_name: 'Write',
      tool_input: { file_path: 'example.ts' },
      session_id: session,
    }),
  });
}

test('two same-priority advisory handlers survive as one bounded adapter result', () => {
  const home = path.join(root, 'home');
  installMachineRuntime({ home, templatesRoot });
  const repo = repository('composed-advisories', {
    'first.sh': 'echo \'{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"first advisory"}}\'\n',
    'second.sh': 'echo \'{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"second advisory"}}\'\n',
  });
  const result = invoke(home, repo);
  expect(result.status).toBe(0);
  const output = JSON.parse(result.stdout);
  expect(output.hookSpecificOutput.additionalContext).toContain('first advisory');
  expect(output.hookSpecificOutput.additionalContext).toContain('second advisory');
});

test('unresolvable project context fails open loudly instead of blocking the session', () => {
  const home = path.join(root, 'home');
  installMachineRuntime({ home, templatesRoot });
  // Shape 1: a .caws ancestor without any git repository (proving-grounds).
  const cawsAncestor = path.join(root, 'bench');
  fs.mkdirSync(path.join(cawsAncestor, '.caws'), { recursive: true });
  fs.mkdirSync(path.join(cawsAncestor, 'subject'), { recursive: true });
  const cawsResult = invoke(home, path.join(cawsAncestor, 'subject'));
  expect(cawsResult.status).toBe(0);
  expect(cawsResult.stderr).toContain('continuing without CAWS governance');
  // Shape 2: a broken .git ancestor (empty .git directory, no repository).
  const broken = path.join(root, 'broken');
  fs.mkdirSync(path.join(broken, '.git'), { recursive: true });
  fs.mkdirSync(path.join(broken, 'subject'), { recursive: true });
  const brokenResult = invoke(home, path.join(broken, 'subject'));
  expect(brokenResult.status).toBe(0);
  expect(brokenResult.stderr).toContain('continuing without CAWS governance');
  // Shape 3: a plain directory with neither marker stays quiet.
  const plain = path.join(root, 'plain');
  fs.mkdirSync(plain);
  const quiet = invoke(home, plain);
  expect(quiet.status).toBe(0);
  expect(quiet.stderr).not.toContain('CAWS machine adapter');
});

test('malformed and over-budget optional advisories are omitted without acquiring denial authority', () => {
  const home = path.join(root, 'home');
  installMachineRuntime({ home, templatesRoot });
  const repo = repository('bounded-advisories', {
    'valid.sh': 'echo \'{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"kept"}}\'\n',
    'malformed.sh': 'echo \'{"hookSpecificOutput":{"additionalContext":7}}\'\n',
    'large.sh': 'echo \'{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"this card is too large"}}\'\n',
  });
  const result = invoke(home, repo, 'machine-runtime-test', 'pre_tool_use', {
    CAWS_HOOK_ADVISORY_BUDGET_BYTES: '8',
  });
  expect(result.status).toBe(0);
  const output = JSON.parse(result.stdout);
  expect(output.hookSpecificOutput.additionalContext).toBe('kept');
  expect(result.stderr).toContain('malformed.sh');
  expect(result.stderr).toContain('large.sh');
  expect(result.stderr).not.toContain('blocked');
});

test('advisory composition preserves an independently owned input rewrite', () => {
  const home = path.join(root, 'home');
  installMachineRuntime({ home, templatesRoot });
  const repo = repository('rewrite-and-advisory', {
    'advice.sh': 'echo \'{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"context survives"}}\'\n',
    'rewrite.sh': 'echo \'{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","updatedInput":{"file_path":"safe.ts"}}}\'\n',
  });
  const result = invoke(home, repo);
  expect(result.status).toBe(0);
  const output = JSON.parse(result.stdout).hookSpecificOutput;
  expect(output.updatedInput).toEqual({ file_path: 'safe.ts' });
  expect(output.additionalContext).toContain('context survives');
});

test('a block remains authoritative when an earlier advisory exists', () => {
  const home = path.join(root, 'home');
  installMachineRuntime({ home, templatesRoot });
  const repo = repository('block-and-advisory', {
    'advice.sh': 'echo \'{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"optional"}}\'\n',
    'block.sh': 'echo \'{"decision":"block","reason":"still denied"}\'\nexit 2\n',
  });
  const result = invoke(home, repo);
  expect(result.status).toBe(2);
  expect(JSON.parse(result.stdout)).toEqual({ decision: 'block', reason: 'still denied' });
});

test('the adapter settles selected offers at handoff and releases omitted members', () => {
  const home = path.join(root, 'home');
  installMachineRuntime({ home, templatesRoot });
  const settlementLog = path.join(root, 'settlements.log');
  const fakeCaws = path.join(root, 'fake-caws.sh');
  fs.writeFileSync(fakeCaws, '#!/bin/bash\nprintf \'%s\\n\' "$*" >> "$SETTLEMENT_LOG"\n', { mode: 0o755 });
  const offer = (id, context) =>
    `printf '%s\\n' '{"id":"${id}","recipient":"machine-runtime-test"}' > "$CAWS_HANDLER_OFFER_FILE"\n` +
    `printf '%s\\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"${context}"}}'\n`;
  const repo = repository('offer-settlement', {
    'selected.sh': offer('offer-selected', 'kept'),
    'omitted.sh': offer('offer-omitted', 'too-large'),
  });
  const result = invoke(home, repo, 'machine-runtime-test', 'pre_tool_use', {
    CAWS_BIN: fakeCaws,
    SETTLEMENT_LOG: settlementLog,
    CAWS_HOOK_ADVISORY_BUDGET_BYTES: '5',
  });
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout).hookSpecificOutput.additionalContext).toBe('kept');
  const settlements = fs.readFileSync(settlementLog, 'utf8').trim().split('\n');
  expect(settlements).toContain(
    'message settle offer-selected --me machine-runtime-test --outcome delivered --json'
  );
  expect(settlements).toContain(
    'message settle offer-omitted --me machine-runtime-test --outcome released --json'
  );
});

test('a later hard block releases an earlier selected offer', () => {
  const home = path.join(root, 'home');
  installMachineRuntime({ home, templatesRoot });
  const settlementLog = path.join(root, 'blocked-settlements.log');
  const fakeCaws = path.join(root, 'fake-caws-block.sh');
  fs.writeFileSync(fakeCaws, '#!/bin/bash\nprintf \'%s\\n\' "$*" >> "$SETTLEMENT_LOG"\n', { mode: 0o755 });
  const repo = repository('blocked-offer', {
    'advice.sh':
      'printf \'%s\\n\' \'{"id":"offer-before-block","recipient":"machine-runtime-test"}\' > "$CAWS_HANDLER_OFFER_FILE"\n' +
      'echo \'{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"optional"}}\'\n',
    'block.sh': 'echo \'{"decision":"block","reason":"denied"}\'\nexit 2\n',
  });
  const result = invoke(home, repo, 'machine-runtime-test', 'pre_tool_use', {
    CAWS_BIN: fakeCaws,
    SETTLEMENT_LOG: settlementLog,
  });
  expect(result.status).toBe(2);
  expect(fs.readFileSync(settlementLog, 'utf8')).toContain(
    'message settle offer-before-block --me machine-runtime-test --outcome released --json'
  );
});

test('a budget-omitted heartbeat message retries and delivers on the next adapter handoff', () => {
  const home = path.join(root, 'home');
  installMachineRuntime({ home, templatesRoot });
  const repo = repository('real-message-retry', {
    'agent-heartbeat.sh': 'exit 99\n',
    'other.sh': 'echo \'{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"kept"}}\'\n',
  });
  fs.copyFileSync(
    path.join(templatesRoot, 'shared', 'agent-heartbeat.sh'),
    path.join(repo, '.caws/hooks/agent-heartbeat.sh')
  );
  fs.chmodSync(path.join(repo, '.caws/hooks/agent-heartbeat.sh'), 0o755);
  fs.mkdirSync(path.join(repo, '.caws/hooks/lib'), { recursive: true });
  for (const name of ['parse-input.sh', 'agent-surface.sh']) {
    fs.copyFileSync(
      path.join(templatesRoot, 'shared/lib', name),
      path.join(repo, '.caws/hooks/lib', name)
    );
  }
  const cli = path.resolve(__dirname, '../../dist/index.js');
  const cawsBin = path.join(root, 'fixture-caws.sh');
  fs.writeFileSync(
    cawsBin,
    `#!/bin/bash\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(cli)} "$@"\n`,
    { mode: 0o755 }
  );
  const registered = spawnSync(cawsBin, [
    'agents', 'register', '--session-id', 'machine-runtime-test', '--platform', 'codex', '--json',
  ], { cwd: repo, encoding: 'utf8' });
  expect(registered.status).toBe(0);
  const message = {
    record: 'message',
    id: 'retry-message',
    actor: { kind: 'agent', id: 'sender', session_id: 'sender' },
    to: 'machine-runtime-test',
    channel: 'machine-runtime-test::sender',
    text: 'MESSAGE MUST RETRY AFTER OMISSION',
    ts: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(repo, '.caws/messages.jsonl'), JSON.stringify(message) + '\n');

  const omitted = invoke(home, repo, 'machine-runtime-test', 'pre_tool_use', {
    CAWS_BIN: cawsBin,
    CAWS_HOOK_ADVISORY_BUDGET_BYTES: '4',
  });
  expect(omitted.status).toBe(0);
  expect(JSON.parse(omitted.stdout).hookSpecificOutput.additionalContext).toBe('kept');
  expect(getMessageDeliveryState(path.join(repo, '.caws'), message.id).value.delivered).toBe(false);

  const retried = invoke(home, repo, 'machine-runtime-test', 'pre_tool_use', {
    CAWS_BIN: cawsBin,
    CAWS_HOOK_ADVISORY_BUDGET_BYTES: '32768',
  });
  expect(retried.status).toBe(0);
  expect(JSON.parse(retried.stdout).hookSpecificOutput.additionalContext).toContain(message.text);
  expect(getMessageDeliveryState(path.join(repo, '.caws'), message.id).value.delivered).toBe(true);

  const after = invoke(home, repo, 'machine-runtime-test', 'pre_tool_use', {
    CAWS_BIN: cawsBin,
    CAWS_HOOK_ADVISORY_BUDGET_BYTES: '32768',
  });
  expect(after.status).toBe(0);
  // CAWS-HOOK-ADVISORY-SESSION-DEDUP-01: the fixture emits one constant card
  // ("kept") plus the message offer. After the message is delivered, the only
  // remaining card is a byte-identical repeat of advice this session already
  // received, so the composer suppresses it and the response carries no
  // additionalContext at all. The claim under test is unchanged -- the delivered
  // message must not be re-surfaced -- so an absent context satisfies it.
  expect(after.stdout).not.toContain(message.text);
  if (after.stdout.trim()) {
    expect(JSON.parse(after.stdout).hookSpecificOutput.additionalContext ?? '').not.toContain(message.text);
  }
});

test('a settlement interruption remains uncertain and retries after offer expiry', () => {
  const home = path.join(root, 'home');
  installMachineRuntime({ home, templatesRoot });
  const repo = repository('settlement-interruption', {
    'agent-heartbeat.sh': 'exit 99\n',
  });
  fs.copyFileSync(
    path.join(templatesRoot, 'shared', 'agent-heartbeat.sh'),
    path.join(repo, '.caws/hooks/agent-heartbeat.sh')
  );
  fs.chmodSync(path.join(repo, '.caws/hooks/agent-heartbeat.sh'), 0o755);
  fs.mkdirSync(path.join(repo, '.caws/hooks/lib'), { recursive: true });
  for (const name of ['parse-input.sh', 'agent-surface.sh']) {
    fs.copyFileSync(path.join(templatesRoot, 'shared/lib', name), path.join(repo, '.caws/hooks/lib', name));
  }
  const cli = path.resolve(__dirname, '../../dist/index.js');
  const failedOnce = path.join(root, 'settlement-failed-once');
  const cawsBin = path.join(root, 'interruptible-caws.sh');
  fs.writeFileSync(
    cawsBin,
    '#!/bin/bash\n' +
      'if [[ "$1 $2" == "message settle" && ! -f "$FAIL_ONCE_FILE" ]]; then\n' +
      '  touch "$FAIL_ONCE_FILE"\n' +
      '  echo "simulated settlement interruption" >&2\n' +
      '  exit 1\n' +
      'fi\n' +
      `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(cli)} "$@"\n`,
    { mode: 0o755 }
  );
  expect(spawnSync(cawsBin, [
    'agents', 'register', '--session-id', 'machine-runtime-test', '--platform', 'codex', '--json',
  ], { cwd: repo, encoding: 'utf8', env: { ...process.env, FAIL_ONCE_FILE: failedOnce } }).status).toBe(0);
  const message = {
    record: 'message', id: 'interrupted-message',
    actor: { kind: 'agent', id: 'sender', session_id: 'sender' },
    to: 'machine-runtime-test', channel: 'machine-runtime-test::sender',
    text: 'RETRY AFTER SETTLEMENT INTERRUPTION', ts: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(repo, '.caws/messages.jsonl'), JSON.stringify(message) + '\n');
  const env = {
    CAWS_BIN: cawsBin,
    FAIL_ONCE_FILE: failedOnce,
    CAWS_MESSAGE_OFFER_TTL_MS: '5000',
  };

  const uncertain = invoke(home, repo, 'machine-runtime-test', 'pre_tool_use', env);
  expect(uncertain.status).toBe(0);
  expect(uncertain.stdout).toContain(message.text);
  expect(uncertain.stderr).toContain('deferred to expiry');
  expect(getMessageDeliveryState(path.join(repo, '.caws'), message.id).value.delivered).toBe(false);

  const firstOffer = fs.readFileSync(path.join(repo, '.caws/messages.jsonl'), 'utf8')
    .trim().split('\n').map((line) => JSON.parse(line)).find((line) => line.record === 'offer');
  const waitMs = Math.max(0, Date.parse(firstOffer.expires_at) - Date.now() + 25);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
  const retried = invoke(home, repo, 'machine-runtime-test', 'pre_tool_use', env);
  expect(retried.status).toBe(0);
  expect(retried.stdout).toContain(message.text);
  expect(getMessageDeliveryState(path.join(repo, '.caws'), message.id).value.delivered).toBe(true);
});

test('planning writes nothing; install is idempotent and runs distinct project guards', () => {
  const home = path.join(root, 'home');
  const plan = installMachineRuntime({ home, templatesRoot, plan: true });
  expect(plan.changed).toBe(true);
  expect(fs.existsSync(home)).toBe(false);
  const installed = installMachineRuntime({ home, templatesRoot });
  expect(installed.digest).toBe(plan.digest);
  expect(installMachineRuntime({ home, templatesRoot }).changed).toBe(false);
  const a = repository('a', {
    'first.sh': 'echo first >&2\n',
    'deny.sh': 'echo \'{"decision":"block","reason":"A denied"}\'\nexit 2\n',
    'never.sh': 'echo SHOULD_NOT_RUN >&2\n',
  });
  const b = repository('b', {
    'only.sh': 'echo \'{"hookSpecificOutput":{"additionalContext":"B allowed"}}\'\n',
  });
  const ra = invoke(home, a);
  expect(ra.status).toBe(2);
  expect(ra.stderr).toContain('first');
  expect(ra.stderr).not.toContain('SHOULD_NOT_RUN');
  expect(JSON.parse(ra.stdout).reason).toBe('A denied');
  const rb = invoke(home, b);
  expect(rb.status).toBe(0);
  expect(JSON.parse(rb.stdout).hookSpecificOutput.additionalContext).toBe('B allowed');
});

function eventRepository(event, body) {
  const repo = repository('native-output', { 'native.sh': body });
  const file = path.join(repo, '.caws/hooks/adapter-policy.json');
  const policy = JSON.parse(fs.readFileSync(file));
  policy.surfaces.codex.events[event] = policy.surfaces.codex.events.pre_tool_use;
  if (event !== 'pre_tool_use') delete policy.surfaces.codex.events.pre_tool_use;
  fs.writeFileSync(file, JSON.stringify(policy));
  return repo;
}

test.each([
  [
    'pre_tool_use',
    '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"native fixture refusal"}}',
  ],
  ['stop', '{"decision":"block","reason":"native fixture refusal"}'],
])(
  'Codex %s exit 2 supplies the native stderr blocking reason and selected digest',
  (event, output) => {
    const home = path.join(root, 'home');
    const installed = installMachineRuntime({ home, templatesRoot });
    const repo = eventRepository(event, `printf '%s\\n' '${output}'\nexit 2\n`);
    const result = invoke(home, repo, 'native-output', event);
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toEqual(JSON.parse(output));
    expect(result.stderr).toContain('native fixture refusal');
    expect(result.stderr).toContain(installed.digest);
  }
);

test('Codex bare blocking exit cannot become a reasonless native hook failure', () => {
  const home = path.join(root, 'home');
  installMachineRuntime({ home, templatesRoot });
  const repo = eventRepository('pre_tool_use', 'exit 2\n');
  const result = invoke(home, repo);
  expect(result.status).toBe(2);
  expect(result.stderr).toContain('CAWS pre_tool_use blocked with exit code 2');
});

test('Codex Stop retains plain lifecycle output in a native JSON message', () => {
  const home = path.join(root, 'home');
  installMachineRuntime({ home, templatesRoot });
  const repo = eventRepository('stop', 'printf "stopped fixture-session\\n"\n');
  const result = invoke(home, repo, 'native-output', 'stop');
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ systemMessage: 'stopped fixture-session' });
});

test('Codex Stop preserves an existing structured continuation decision', () => {
  const home = path.join(root, 'home');
  installMachineRuntime({ home, templatesRoot });
  const output = { decision: 'block', reason: 'a required check is still pending' };
  const repo = eventRepository('stop', `printf '%s\\n' '${JSON.stringify(output)}'\n`);
  const result = invoke(home, repo, 'native-output', 'stop');
  expect(result.status).toBe(2);
  expect(JSON.parse(result.stdout)).toEqual(output);
  expect(result.stderr).toContain(output.reason);
});

test.each(['{"decision":', 'null', '[]', 'true'])(
  'Codex malformed Stop JSON %s is not silently converted to informational success',
  (output) => {
    const home = path.join(root, 'home');
    installMachineRuntime({ home, templatesRoot });
    const repo = eventRepository('stop', `printf '%s\\n' '${output}'\n`);
    const result = invoke(home, repo, 'native-output', 'stop');
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Malformed Codex Stop JSON');
  }
);

test('one runtime update reaches two projects without project edits; rollback restores the digest', () => {
  const home = path.join(root, 'home');
  const sources = path.join(root, 'templates');
  fs.cpSync(templatesRoot, sources, {
    recursive: true,
    filter: (p) =>
      !path.relative(templatesRoot, p).includes('__pycache__') &&
      !path.relative(templatesRoot, p).includes('.caws/'),
  });
  const first = installMachineRuntime({ home, templatesRoot: sources });
  const a = repository('a', {
    'report.sh':
      'echo "$CAWS_ADAPTER_RUNTIME_DIGEST ${CAWS_TEST_ADAPTER_REVISION:-original}" >&2\n',
  });
  const b = repository('b', {
    'report.sh':
      'echo "$CAWS_ADAPTER_RUNTIME_DIGEST ${CAWS_TEST_ADAPTER_REVISION:-original}" >&2\n',
  });
  const policies = [a, b].map((r) =>
    fs.readFileSync(path.join(r, '.caws/hooks/adapter-policy.json'))
  );
  for (const repo of [a, b]) expect(invoke(home, repo).stderr).toContain(first.digest);
  fs.appendFileSync(
    path.join(sources, 'shared/lib/session-id.sh'),
    '\nexport CAWS_TEST_ADAPTER_REVISION=updated\n'
  );
  const second = installMachineRuntime({ home, templatesRoot: sources });
  expect(second.digest).not.toBe(first.digest);
  for (const [i, repo] of [a, b].entries()) {
    const result = invoke(home, repo);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain(second.digest);
    expect(result.stderr).toContain('updated');
    expect(fs.readFileSync(path.join(repo, '.caws/hooks/adapter-policy.json'))).toEqual(
      policies[i]
    );
  }
  expect(rollbackMachineRuntime({ home, plan: true }).digest).toBe(first.digest);
  expect(invoke(home, a).stderr).toContain(second.digest);
  rollbackMachineRuntime({ home });
  expect(invoke(home, a).stderr).toContain(first.digest);
  expect(invoke(home, a).stderr).toContain('original');
});

test('corrupt runtime and missing declared guards fail closed; unadopted projects are identified', () => {
  const home = path.join(root, 'home');
  const installed = installMachineRuntime({ home, templatesRoot });
  const repo = repository('a', { 'required.sh': 'exit 0\n' });
  fs.unlinkSync(path.join(repo, '.caws/hooks/required.sh'));
  expect(invoke(home, repo).status).toBe(2);
  fs.unlinkSync(path.join(repo, '.caws/hooks/adapter-policy.json'));
  const absent = invoke(home, repo);
  expect(absent.status).toBe(2);
  expect(absent.stderr).toContain('adopt');
  fs.appendFileSync(
    path.join(home, 'lib/runtimes', installed.digest, 'lib/emit.sh'),
    '\n# unreviewed drift\n'
  );
  expect(() => installMachineRuntime({ home, templatesRoot })).toThrow(
    /modified|digest|integrity/i
  );
});

test('invalid policy paths and symlinked machine destinations are refused without execution', () => {
  const home = path.join(root, 'home');
  const external = path.join(root, 'external');
  fs.mkdirSync(home);
  fs.mkdirSync(external);
  fs.symlinkSync(external, path.join(home, 'lib'));
  expect(() => installMachineRuntime({ home, templatesRoot })).toThrow(/symlink/i);
  expect(fs.readdirSync(external)).toEqual([]);
});

test('failed activation preserves the previous executable runtime; conflicting install and launcher drift are refused', () => {
  const home = path.join(root, 'home');
  const sources = path.join(root, 'sources');
  fs.cpSync(templatesRoot, sources, { recursive: true });
  const first = installMachineRuntime({ home, templatesRoot: sources });
  const repo = repository('project', { 'guard.sh': 'echo healthy >&2\n' });
  fs.appendFileSync(path.join(sources, 'shared/lib/session-id.sh'), '\n# new snapshot\n');
  const rename = fs.renameSync;
  const fault = jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (to === path.join(home, 'state/adapter-runtime.json'))
      throw new Error('fixture activation failure');
    return rename(from, to);
  });
  try {
    expect(() => installMachineRuntime({ home, templatesRoot: sources })).toThrow(
      /activation failure/
    );
  } finally {
    fault.mockRestore();
  }
  expect(JSON.parse(fs.readFileSync(path.join(home, 'state/adapter-runtime.json'))).digest).toBe(
    first.digest
  );
  expect(invoke(home, repo).status).toBe(0);
  fs.mkdirSync(path.join(home, 'state/adapter-install.lock'));
  expect(() => installMachineRuntime({ home, templatesRoot: sources })).toThrow(/locked/);
  fs.rmdirSync(path.join(home, 'state/adapter-install.lock'));
  installMachineRuntime({ home, templatesRoot: sources });
  fs.appendFileSync(path.join(home, 'bin/caws-hook'), '\n# local growth\n');
  expect(() => rollbackMachineRuntime({ home })).toThrow(/launcher modified/);
});

function crashAtPointer(home, sources, phase) {
  const modulePath = path.resolve(__dirname, '../../dist/init/machine-adapters');
  return spawnSync(
    process.execPath,
    [
      '-e',
      `
    const fs = require('node:fs');
    const { installMachineRuntime } = require(${JSON.stringify(modulePath)});
    const rename = fs.renameSync;
    fs.renameSync = function(from, to) {
      if (to !== ${JSON.stringify(path.join(home, 'state/adapter-runtime.json'))})
        return rename.apply(this, arguments);
      if (${JSON.stringify(phase)} === 'after') rename.apply(this, arguments);
      process.exit(73);
    };
    installMachineRuntime({ home: ${JSON.stringify(home)}, templatesRoot: ${JSON.stringify(sources)} });
  `,
    ],
    { encoding: 'utf8' }
  );
}

test.each(['before', 'after'])(
  'process termination %s activation keeps a complete runtime and permits retry and rollback',
  (phase) => {
    const home = path.join(root, 'home');
    const sources = path.join(root, 'sources');
    fs.cpSync(templatesRoot, sources, { recursive: true });
    const driver = path.join(sources, 'runtime/caws-hook.py');
    fs.writeFileSync(
      driver,
      fs
        .readFileSync(driver, 'utf8')
        .replace('def main():', 'def main():\n    print("DRIVER=A", file=sys.stderr)')
    );
    const first = installMachineRuntime({ home, templatesRoot: sources });
    const bootstrap = fs.readFileSync(first.launcher);
    const repo = repository('project', {
      'guard.sh': 'echo "DIGEST=$CAWS_ADAPTER_RUNTIME_DIGEST" >&2\n',
    });
    fs.writeFileSync(driver, fs.readFileSync(driver, 'utf8').replace('DRIVER=A', 'DRIVER=B'));
    const second = installMachineRuntime({ home, templatesRoot: sources, plan: true });
    const crash = crashAtPointer(home, sources, phase);
    expect(crash.status).toBe(73);
    expect(fs.existsSync(path.join(home, 'state/adapter-install.lock'))).toBe(true);
    const active = invoke(home, repo);
    expect(active.status).toBe(0);
    expect(active.stderr).toContain(phase === 'before' ? 'DRIVER=A' : 'DRIVER=B');
    expect(active.stderr).toContain(`DIGEST=${phase === 'before' ? first.digest : second.digest}`);
    expect(fs.readFileSync(first.launcher)).toEqual(bootstrap);
    // An operator has inspected the interrupted install. Clearing this fixture
    // lock must be sufficient; no executable or pointer repair is necessary.
    fs.rmdirSync(path.join(home, 'state/adapter-install.lock'));
    installMachineRuntime({ home, templatesRoot: sources });
    expect(invoke(home, repo).stderr).toContain('DRIVER=B');
    rollbackMachineRuntime({ home, templatesRoot: sources });
    const restored = invoke(home, repo);
    expect(restored.status).toBe(0);
    expect(restored.stderr).toContain('DRIVER=A');
    expect(restored.stderr).toContain(`DIGEST=${first.digest}`);
  }
);

test('an interrupted first installation can be retried without overwriting an unmanaged launcher', () => {
  const home = path.join(root, 'home');
  const crash = crashAtPointer(home, templatesRoot, 'before');
  expect(crash.status).toBe(73);
  const repo = repository('project', { 'guard.sh': 'echo ready >&2\n' });
  expect(invoke(home, repo).status).toBe(2);
  fs.rmdirSync(path.join(home, 'state/adapter-install.lock'));
  const completed = installMachineRuntime({ home, templatesRoot });
  expect(completed.changed).toBe(true);
  const active = invoke(home, repo);
  expect(active.status).toBe(0);
  expect(active.stderr).toContain('ready');
});

test('rollback selects a verified previous snapshot even when the active snapshot is corrupt', () => {
  const home = path.join(root, 'home');
  const sources = path.join(root, 'sources');
  fs.cpSync(templatesRoot, sources, { recursive: true });
  const first = installMachineRuntime({ home, templatesRoot: sources });
  fs.appendFileSync(path.join(sources, 'runtime/caws-hook.py'), '\n# next runtime\n');
  const second = installMachineRuntime({ home, templatesRoot: sources });
  const corrupt = path.join(home, 'lib/runtimes', second.digest, 'lib/emit.sh');
  fs.appendFileSync(corrupt, '\n# damaged active file\n');
  const preserved = fs.readFileSync(corrupt);
  const repo = repository('project', { 'guard.sh': 'echo healthy >&2\n' });
  expect(invoke(home, repo).status).toBe(2);
  expect(rollbackMachineRuntime({ home, templatesRoot: sources, plan: true }).digest).toBe(
    first.digest
  );
  expect(invoke(home, repo).status).toBe(2);
  rollbackMachineRuntime({ home, templatesRoot: sources });
  expect(invoke(home, repo).status).toBe(0);
  expect(fs.readFileSync(corrupt)).toEqual(preserved);
});

test('an invocation keeps its selected driver and libraries when activation races with driver loading', () => {
  const home = path.join(root, 'home');
  const sources = path.join(root, 'sources');
  fs.cpSync(templatesRoot, sources, { recursive: true });
  const first = installMachineRuntime({ home, templatesRoot: sources });
  const pointer = path.join(home, 'state/adapter-runtime.json');
  const oldPointer = fs.readFileSync(pointer);
  fs.appendFileSync(
    path.join(sources, 'shared/lib/session-id.sh'),
    '\nexport CAWS_FIXTURE_REVISION=updated\n'
  );
  const second = installMachineRuntime({ home, templatesRoot: sources });
  const nextPointer = fs.readFileSync(pointer, 'utf8');
  fs.writeFileSync(pointer, oldPointer);
  const repo = repository('project', {
    'guard.sh': 'echo "$CAWS_ADAPTER_RUNTIME_DIGEST ${CAWS_FIXTURE_REVISION:-original}" >&2\n',
  });
  const raced = spawnSync(
    'python3',
    [
      '-c',
      `
import runpy, sys
from pathlib import Path
original = runpy.run_path
def activate_during_load(filename, *args, **kwargs):
    if filename.endswith('/launcher.py'):
        Path(sys.argv[3]).write_text(sys.argv[4])
        sys.argv = [sys.argv[0], 'codex', 'pre_tool_use']
    return original(filename, *args, **kwargs)
runpy.run_path = activate_during_load
original(sys.argv[1], run_name='__main__')
`,
      first.launcher,
      repo,
      pointer,
      nextPointer,
    ],
    {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, CAWS_HOME: home, CAWS_PROJECT_DIR: repo },
      input: JSON.stringify({
        cwd: repo,
        session_id: 'race-fixture',
        tool_name: 'Bash',
        tool_input: { command: 'true' },
      }),
    }
  );
  expect(raced.status).toBe(0);
  expect(raced.stderr).toContain(`${first.digest} original`);
  expect(JSON.parse(fs.readFileSync(pointer)).digest).toBe(second.digest);
  expect(invoke(home, repo).stderr).toContain(`${second.digest} updated`);
});

test('quiet outside governed repositories; traversal, symlink policies and missing runtimes fail before guard execution', () => {
  const home = path.join(root, 'home');
  installMachineRuntime({ home });
  const plain = path.join(root, 'plain');
  fs.mkdirSync(plain);
  expect(invoke(home, plain).status).toBe(0);
  const repo = repository('governed', { 'guard.sh': 'echo MUST_NOT_RUN >&2\n' });
  const file = path.join(repo, '.caws/hooks/adapter-policy.json');
  const policy = JSON.parse(fs.readFileSync(file));
  policy.surfaces.codex.events.pre_tool_use.hooks_dir = '../outside';
  fs.writeFileSync(file, JSON.stringify(policy));
  const escaped = invoke(home, repo);
  expect(escaped.status).toBe(2);
  expect(escaped.stderr).not.toContain('MUST_NOT_RUN');
  fs.unlinkSync(path.join(home, 'state/adapter-runtime.json'));
  expect(invoke(home, repo).status).toBe(2);
});
