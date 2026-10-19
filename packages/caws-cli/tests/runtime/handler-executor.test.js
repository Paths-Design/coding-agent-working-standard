const fs = require('node:fs');
const { AbortController } = globalThis;
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const {
  createHandlerExecutor,
  executeCompatibilityDispatch,
  HandlerExecutionError,
  HANDLER_CAPTURE_LIMIT_BYTES,
} = require('../../dist/runtime/handler-executor');
const templates = path.resolve(__dirname, '../../templates/hook-packs');
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const quoted = (text) => "'" + text.replace(/'/g, "'\\''") + "'";
let root, runtime, project, environment, selection, request, controller;
function options() {
  return { request, selection, environment, signal: controller.signal };
}
function handler(name, program, args = []) {
  const file = path.join(project, 'custom', name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.js', program);
  fs.writeFileSync(
    file,
    `#!/bin/bash\nexec ${quoted(process.execPath)} ${quoted(file + '.js')} "$@"\n`,
    { mode: 0o755 }
  );
  const selected = {
    name,
    entry: [name, ...args].join(' '),
    args,
    path: file,
    sha256: sha(file),
    kind: 'project-override',
    tier: 'repo-policy',
  };
  selection.handlers.push(selected);
  selection.overrides[name] = file;
  return selected;
}
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'caws-handler-executor-')));
  runtime = path.join(root, 'runtime');
  project = path.join(root, 'project');
  fs.mkdirSync(runtime);
  fs.mkdirSync(project);
  fs.writeFileSync(
    path.join(runtime, 'handler-env.sh'),
    'if [[ -n "${CAWS_PRIOR_BASH_ENV:-}" ]]; then source "$CAWS_PRIOR_BASH_ENV" || exit 2; fi\nexport TEST_BOOTSTRAP=selected\n'
  );
  environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) =>
        !key.startsWith('GIT_') &&
        !key.startsWith('HOOK_') &&
        !key.startsWith('CAWS_') &&
        key !== 'BASH_ENV' &&
        typeof value === 'string'
    )
  );
  environment.HOME = root;
  environment.CAWS_HOME = path.join(root, 'home');
  environment.TMPDIR = root;
  selection = {
    status: 'active',
    runtimeDigest: 'b'.repeat(64),
    checkout: project,
    canonical: project,
    surface: 'codex',
    event: 'pre_tool_use',
    configuration: 'system',
    runtimeDirectory: runtime,
    hooksDirectory: runtime,
    handlers: [],
    libraries: {},
    overrides: {},
    libraryOverrides: {},
    transcriptAdapter: null,
  };
  request = {
    schema: 'caws.runtime.request.v1',
    id: 'executor-fixture',
    runtimeDigest: selection.runtimeDigest,
    surface: 'codex',
    event: 'pre_tool_use',
    configuration: 'system',
    caller: { cwd: project, environment },
    deadlineEpochMs: Date.now() + 60000,
    inputJson: '{}',
    payload: {
      tool_name: 'Bash',
      session_id: 'fixture',
      hook_event_name: 'WrongEvent',
      tool_input: { command: 'echo safe' },
    },
  };
  controller = new AbortController();
});
afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

test('selected absolute path and args execute with full enriched stdin and owned immutable projection', async () => {
  environment.MY_VALUE = 'original';
  environment.HOOK_TOOL_NAME = 'stale';
  environment.GIT_DIR = '/wrong/repo';
  const selected = handler(
    'custom.sh',
    `const fs=require('node:fs'); process.stdout.write(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2),payload:JSON.parse(fs.readFileSync(0,'utf8')),file:JSON.parse(fs.readFileSync(process.env.HOOK_PAYLOAD_FILE,'utf8')),tool:process.env.HOOK_TOOL_NAME,value:process.env.MY_VALUE,git:process.env.GIT_DIR||null,bootstrap:process.env.TEST_BOOTSTRAP,libraries:JSON.parse(process.env.CAWS_MACHINE_LIBRARIES)}));`,
    ['one', 'two']
  );
  selection.libraryOverrides['helper.sh'] = path.join(project, 'custom/helper.sh');
  const execute = createHandlerExecutor(options());
  environment.MY_VALUE = 'mutated';
  const result = await execute(selected, 0);
  expect(result.exitCode).toBe(0);
  const value = JSON.parse(Buffer.from(result.stdout).toString());
  expect(value).toEqual({
    cwd: project,
    args: ['one', 'two'],
    payload: { ...request.payload, hook_event_name: 'PreToolUse' },
    file: { ...request.payload, hook_event_name: 'PreToolUse' },
    tool: 'Bash',
    value: 'original',
    git: null,
    bootstrap: 'selected',
    libraries: { 'helper.sh': 'custom/helper.sh' },
  });
  expect(fs.readdirSync(root).filter((name) => name.startsWith('caws-native-handler-'))).toEqual(
    []
  );
});

test('custom stdout and stderr retain non-UTF8 bytes, NULs and trailing LFs exactly', async () => {
  const selected = handler(
    'bytes.sh',
    'process.stdout.write(Buffer.from([255,0,97,10,10]));process.stderr.write(Buffer.from([254,0,98,10]));process.exitCode=2;'
  );
  const result = await createHandlerExecutor(options())(selected, 0);
  expect(result.exitCode).toBe(2);
  expect(Buffer.from(result.stdout)).toEqual(Buffer.from([255, 0, 97, 10, 10]));
  expect(Buffer.from(result.stderr)).toEqual(Buffer.from([254, 0, 98, 10]));
});

test('completed bare refusal is retained when its receipt cannot be decoded', async () => {
  const selected = handler(
    'refusal.sh',
    'require("node:fs").writeFileSync(process.env.CAWS_HANDLER_OFFER_FILE,"{bad");process.stderr.write("real guard\\n");process.exitCode=2;'
  );
  let failure;
  try {
    await createHandlerExecutor(options())(selected, 0);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(HandlerExecutionError);
  expect(failure.completedExitCode).toBe(2);
  expect(Buffer.from(failure.stdout)).toEqual(Buffer.alloc(0));
  expect(Buffer.from(failure.stderr).toString()).toBe('real guard\n');
});

test('shell fallback preserves inherited startup through the selected handler preload', async () => {
  const startup = path.join(project, 'startup.sh');
  fs.writeFileSync(startup, 'export PRIOR_STARTUP=preserved\n');
  environment.BASH_ENV = startup;
  const selected = handler(
    'startup.sh',
    'process.stdout.write(process.env.PRIOR_STARTUP+":"+process.env.TEST_BOOTSTRAP);'
  );
  const result = await createHandlerExecutor(options())(selected, 0);
  expect(Buffer.from(result.stdout).toString()).toBe('preserved:selected');
});

test('large payload file remains complete and scalar matching fields remain available', async () => {
  environment.CAWS_HOOK_INLINE_PAYLOAD_MAX_BYTES = '128';
  request.payload.tool_input.content = 'x'.repeat(300000);
  const selected = handler(
    'large.sh',
    'const fs=require("node:fs");const input=fs.readFileSync(0);const file=fs.readFileSync(process.env.HOOK_PAYLOAD_FILE);process.stdout.write(JSON.stringify({equal:input.equals(file),size:JSON.parse(file).tool_input.content.length,inline:process.env.HOOK_INPUT_JSON,truncated:process.env.HOOK_PAYLOAD_TRUNCATED,command:process.env.HOOK_COMMAND}));'
  );
  const result = await createHandlerExecutor(options())(selected, 0);
  expect(JSON.parse(Buffer.from(result.stdout).toString())).toEqual({
    equal: true,
    size: 300000,
    inline: '',
    truncated: '1',
    command: 'echo safe',
  });
});

test('exact heartbeat offer receipts retain identity without settling or consuming them', async () => {
  const selected = handler(
    'offers.sh',
    'const fs=require("node:fs");fs.writeFileSync(process.env.CAWS_HANDLER_OFFER_FILE,JSON.stringify({id:"offer-one",recipient:"session-one"},null,2)+"\\n"+JSON.stringify({id:"offer-two",recipient:"session-two"})+"\\n");process.stdout.write("card");'
  );
  const result = await createHandlerExecutor(options())(selected, 0);
  expect(result.offers).toEqual([
    { offerId: 'offer-one', recipient: 'session-one' },
    { offerId: 'offer-two', recipient: 'session-two' },
  ]);
  expect(Buffer.from(result.stdout).toString()).toBe('card');
  expect(fs.existsSync(path.join(project, '.caws/messages.jsonl'))).toBe(false);
});

test('malformed receipt failure retains an already emitted protective decision byte for byte', async () => {
  const bytes = '{"decision":"block","reason":"known guard refusal"}\n';
  const selected = handler(
    'bad-offer.sh',
    `const fs=require('node:fs');fs.writeFileSync(process.env.CAWS_HANDLER_OFFER_FILE,'{');process.stdout.write(${JSON.stringify(bytes)});`
  );
  const failure = await createHandlerExecutor(options())(selected, 0).catch((error) => error);
  expect(failure).toBeInstanceOf(HandlerExecutionError);
  expect(failure.message).toContain('receipt could not be captured');
  expect(Buffer.from(failure.stdout)).toEqual(Buffer.from(bytes));
});

test('missing, changed, redirected and incorrectly indexed handlers never become implicit skips', async () => {
  const selected = handler('selected.sh', 'process.stdout.write("executed");');
  const execute = createHandlerExecutor(options());
  await expect(execute(selected, 1)).rejects.toThrow('outside the ordered');
  fs.appendFileSync(selected.path, '# changed\n');
  await expect(execute(selected, 0)).rejects.toThrow('changed after selection');
  fs.unlinkSync(selected.path);
  await expect(execute(selected, 0)).rejects.toThrow();
  fs.symlinkSync(selected.path + '.js', selected.path);
  await expect(execute(selected, 0)).rejects.toThrow('symlink');
});

test('cancellation after observed output preserves partial bytes and the native owner group', async () => {
  const selected = handler(
    'cancel.sh',
    'process.stdout.write(Buffer.from([255,0,97]));setInterval(()=>{},1000);'
  );
  const original = childProcess.spawn;
  const spawn = jest.spyOn(childProcess, 'spawn').mockImplementation((...args) => {
    const child = original(...args);
    child.stdout.once('data', () => setImmediate(() => controller.abort()));
    return child;
  });
  const failure = await createHandlerExecutor(options())(selected, 0).catch((error) => error);
  expect(failure).toBeInstanceOf(HandlerExecutionError);
  expect(failure.message).toContain('cancelled');
  expect(Buffer.from(failure.stdout)).toEqual(Buffer.from([255, 0, 97]));
  expect(spawn.mock.calls[0][2].detached).toBe(false);
});

test('deadline and output limits return bounded partial observations', async () => {
  const idle = handler('deadline.sh', 'setInterval(()=>{},1000);');
  request.deadlineEpochMs = Date.now() + 100;
  await expect(createHandlerExecutor(options())(idle, 0)).rejects.toThrow('deadline expired');
  request.deadlineEpochMs = Date.now() + 60000;
  const flood = handler(
    'flood.sh',
    `process.stdout.write(Buffer.alloc(${HANDLER_CAPTURE_LIMIT_BYTES + 1},97));setInterval(()=>{},1000);`
  );
  const failure = await createHandlerExecutor(options())(flood, 1).catch((error) => error);
  expect(failure).toBeInstanceOf(HandlerExecutionError);
  expect(failure.message).toContain('output exceeds byte limit');
  expect(Buffer.from(failure.stdout)).toEqual(Buffer.alloc(HANDLER_CAPTURE_LIMIT_BYTES, 97));
});

test('already cancelled execution never starts a child and request-selection mismatch is rejected', async () => {
  const selected = handler('never.sh', 'throw new Error("must not execute");');
  const spawn = jest.spyOn(childProcess, 'spawn');
  controller.abort();
  await expect(createHandlerExecutor(options())(selected, 0)).rejects.toThrow('cancelled');
  expect(spawn).not.toHaveBeenCalled();
  request.runtimeDigest = 'c'.repeat(64);
  expect(() => createHandlerExecutor(options())).toThrow('does not match request');
});

test('executor uses selected index and arguments without reordering the chain', async () => {
  const first = handler('first.sh', 'process.stdout.write(process.argv.slice(2).join(","));', [
    'first',
  ]);
  const second = handler('second.sh', 'process.stdout.write(process.argv.slice(2).join(","));', [
    'second',
  ]);
  const execute = createHandlerExecutor(options());
  expect(Buffer.from((await execute(second, 1)).stdout).toString()).toBe('second');
  expect(Buffer.from((await execute(first, 0)).stdout).toString()).toBe('first');
  await expect(execute(first, 1)).rejects.toThrow('outside the ordered');
});

test('compatibility executes the actual dispatcher with custom parser/composer and keeps raw receipt actions', async () => {
  fs.cpSync(path.join(templates, 'shared'), runtime, { recursive: true });
  fs.copyFileSync(path.join(templates, 'runtime/dispatch.sh'), path.join(runtime, 'dispatch.sh'));
  const selected = handler(
    'custom.sh',
    'throw new Error("custom composer owns dispatch; do not call individually");',
    ['arg']
  );
  const custom = (name, source) => {
    const file = path.join(project, 'custom', name);
    fs.writeFileSync(file, source);
    selection.libraryOverrides[name] = file;
    selection.libraries[name] = { path: file, sha256: sha(file), kind: 'project' };
  };
  custom(
    'parse-input.sh',
    'parse_hook_input() { cat >/dev/null; export PARSER_WAS_SELECTED=yes HOOK_SESSION_ID=fixture; }\n'
  );
  custom(
    'session-id.sh',
    'resolve_caws_session_id_with_payload() { printf fixture; }; caws_normalize_session_env() { export CAWS_SESSION_ID="$1"; }\n'
  );
  custom(
    'run-handlers.sh',
    'run_handlers() { printf \'{"selected":"%s","parser":"%s","preload":"%s"}\\n\' "${*: -1}" "$PARSER_WAS_SELECTED" "${TEST_BOOTSTRAP:-none}"; printf \'{"offer_id":"selected-offer","recipient":"fixture","action":"selected","handler":"custom.sh","reason":"selected"}\\n{"offer_id":"released-offer","recipient":"fixture","action":"released","handler":"custom.sh","reason":"omitted"}\\n\' >"$CAWS_HOOK_SETTLEMENT_FILE"; printf \'{"status":"completed","handler":"custom.sh"}\\n\' >"$CAWS_HOOK_EXECUTION_FILE"; }\n'
  );
  const result = await executeCompatibilityDispatch(options());
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(Buffer.from(result.stdout).toString())).toEqual({
    selected: selected.entry,
    parser: 'yes',
    preload: 'none',
  });
  expect(result.offers).toEqual([{ offerId: 'selected-offer', recipient: 'fixture' }]);
  expect(Buffer.from(result.offerReceipts).toString()).toContain('"offer_id":"released-offer"');
  expect(JSON.parse(Buffer.from(result.executionRecords).toString())).toEqual({
    status: 'completed',
    handler: 'custom.sh',
  });
});
