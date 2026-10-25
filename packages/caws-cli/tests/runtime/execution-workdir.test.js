const fs = require('node:fs');
const { AbortController } = globalThis;
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { resolveExecutionWorkdir } = require('../../dist/runtime/execution-workdir');
const { prepareRuntimeInvocation } = require('../../dist/runtime/engine');
const templates = path.resolve(__dirname, '../../templates/hook-packs');
let root, session, command, link;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'caws-execution-workdir-')));
  session = path.join(root, 'session');
  command = path.join(root, 'command');
  link = path.join(root, 'alias');
  fs.mkdirSync(session);
  fs.mkdirSync(command);
  fs.symlinkSync(command, link);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const payload = (values = {}) => ({ tool_name: 'Bash', cwd: session, ...values });
test('absence remains unavailable even with a diagnostic alias and forged environment', () => {
  expect(
    resolveExecutionWorkdir(payload({ tool_input: { workdir: command } }), 'pre_tool_use')
  ).toEqual({ status: 'unavailable' });
});
test.each(['pre_tool_use', 'post_tool_use'])(
  'host command context resolves separately during %s',
  (event) => {
    const input = payload({
      execution_workdir: command,
      session_id: 'original',
      tool_use_id: 'call',
      tool_input: { command: 'echo unchanged', workdir: link, cwd: command },
    });
    const bytes = JSON.stringify(input);
    expect(resolveExecutionWorkdir(input, event)).toEqual({ status: 'resolved', path: command });
    expect(JSON.stringify(input)).toBe(bytes);
  }
);
test.each([null, 0, false, {}, [], '', 'relative', '/missing-execution-workdir', 'bad\0path'])(
  'present invalid host context %p refuses instead of session fallback',
  (value) => {
    expect(() =>
      resolveExecutionWorkdir(payload({ execution_workdir: value }), 'pre_tool_use')
    ).toThrow(/execution_workdir/);
  }
);
test('files, symlinks and noncanonical host spellings refuse', () => {
  const file = path.join(root, 'file');
  fs.writeFileSync(file, 'fixture');
  for (const value of [file, link, command + '/.', command + '/'])
    expect(() =>
      resolveExecutionWorkdir(payload({ execution_workdir: value }), 'pre_tool_use')
    ).toThrow(/execution_workdir/);
});
test.each([null, '', 'relative', '/missing-alias', 0])(
  'malformed present alias %p cannot accompany host authority',
  (value) => {
    for (const alias of ['workdir', 'cwd'])
      expect(() =>
        resolveExecutionWorkdir(
          payload({ execution_workdir: command, tool_input: { [alias]: value } }),
          'pre_tool_use'
        )
      ).toThrow(new RegExp('tool_input.' + alias));
  }
);
test('every present alias must agree physically', () => {
  expect(() =>
    resolveExecutionWorkdir(
      payload({ execution_workdir: command, tool_input: { workdir: command, cwd: session } }),
      'pre_tool_use'
    )
  ).toThrow(/disagrees/);
});
test.each(['stop', 'session_start', 'session_end', 'pre_compact'])(
  'lifecycle %s retains session coordinates',
  (event) => {
    expect(resolveExecutionWorkdir(payload({ execution_workdir: null }), event)).toEqual({
      status: 'not_applicable',
    });
  }
);
test('other tools retain session coordinates', () => {
  expect(
    resolveExecutionWorkdir(payload({ tool_name: 'Read', execution_workdir: null }), 'pre_tool_use')
  ).toEqual({ status: 'not_applicable' });
});
test.each(['outside', 'foreign', 'inactive', 'adopted'])(
  'governed session refuses %s command context before dispatch',
  async (kind) => {
    if (kind === 'adopted') fs.mkdirSync(path.join(session, '.caws'));
    const input = payload({
      execution_workdir: command,
      session_id: 'original',
      tool_use_id: 'call',
      turn_id: 'turn',
      tool_input: { command: 'echo unchanged' },
    });
    const inputJson = JSON.stringify(input);
    const request = {
      schema: 'caws.runtime.request.v1',
      id: 'execution-context',
      runtimeDigest: 'a'.repeat(64),
      surface: 'codex',
      event: 'pre_tool_use',
      configuration: 'system',
      payload: input,
      inputJson,
      caller: { cwd: session, environment: { HOME: root, CAWS_HOME: path.join(root, 'machine') } },
      deadlineEpochMs: Date.now() + 5000,
    };
    const observed = [];
    const git = {
      async run(args, cwd) {
        observed.push({ args, cwd });
        if (cwd === session) return args.length === 2 ? session : path.join(session, '.git');
        if (kind === 'outside') throw new Error('outside git');
        return args.length === 2
          ? command
          : path.join(['foreign', 'adopted'].includes(kind) ? command : session, '.git');
      },
    };
    const select = async ({ checkout, canonical }) =>
      kind !== 'adopted' && (checkout === session || kind !== 'inactive')
        ? { status: 'active', checkout, canonical }
        : { status: 'inactive', reason: 'fixture inactive' };
    await expect(
      prepareRuntimeInvocation(
        request,
        new AbortController().signal,
        undefined,
        git,
        undefined,
        undefined,
        select
      )
    ).rejects.toThrow(['foreign', 'adopted'].includes(kind) ? /foreign canonical/ : /deactivate/);
    expect(observed.map(({ cwd }) => cwd)).toEqual(
      kind === 'outside' ? [session, session, command] : [session, session, command, command]
    );
    expect(request.payload).toBe(input);
    expect(request.inputJson).toBe(inputJson);
  }
);
test('ordinary native profile refuses host directory before consuming its two-query port', async () => {
  const input = payload({ execution_workdir: command });
  const request = {
    id: 'old-profile',
    contextGit: 'caws.runtime.context-git.v1',
    surface: 'codex',
    event: 'pre_tool_use',
    payload: input,
    caller: { cwd: session, environment: { HOME: root } },
  };
  const git = { run: jest.fn() };
  await expect(
    prepareRuntimeInvocation(request, new AbortController().signal, undefined, git)
  ).rejects.toThrow(/does not support host execution-workdir/);
  expect(git.run).not.toHaveBeenCalled();
});
test('real compatibility parser exports command and session coordinates while preserving source identities', () => {
  const input = payload({
    execution_workdir: command,
    hook_event_name: 'PreToolUse',
    session_id: 'original',
    tool_use_id: 'call',
    tool_input: { command: 'echo unchanged', workdir: link },
  });
  const program =
    'source "$1" || exit $?; assignments=$(_hook_extract_scalar_fields) || exit $?; eval "$assignments"; printf "%s\\n" "$HOOK_CWD" "$HOOK_SESSION_CWD" "$HOOK_EXECUTION_WORKDIR_STATUS" "$HOOK_EXECUTION_WORKDIR" "$HOOK_SESSION_ID" "$HOOK_TOOL_USE_ID" "$HOOK_COMMAND"';
  const run = (value) =>
    cp.spawnSync(
      '/bin/bash',
      ['-c', program, 'parser-test', path.join(templates, 'codex/hooks/lib/parse-input.sh')],
      {
        input: JSON.stringify(value),
        encoding: 'utf8',
        env: {
          HOME: root,
          PATH: process.env.PATH,
          CAWS_SHARED_LIB_DIR: path.join(templates, 'shared/lib'),
          CAWS_PROJECT_DIR: session,
        },
      }
    );
  const result = run(input);
  expect({
    code: result.status,
    stderr: result.stderr,
    values: result.stdout.trim().split('\n'),
  }).toEqual({
    code: 0,
    stderr: '',
    values: [command, session, 'resolved', command, 'original', 'call', 'echo unchanged'],
  });
  expect(run({ ...input, execution_workdir: null }).status).toBe(2);
});

test.each(['.git', '.caws'])(
  'failed session and target Git queries retain unresolved target %s markers',
  async (marker) => {
    const home = path.join(root, 'machine');
    fs.mkdirSync(home);
    fs.mkdirSync(path.join(command, marker));
    const request = {
      schema: 'caws.runtime.request.v1',
      id: 'inactive-target',
      runtimeDigest: 'a'.repeat(64),
      surface: 'codex',
      event: 'pre_tool_use',
      configuration: 'system',
      payload: payload({ execution_workdir: command }),
      caller: { cwd: session, environment: { HOME: root, CAWS_HOME: home } },
      deadlineEpochMs: Date.now() + 5000,
    };
    const git = {
      run: jest.fn(async () => {
        throw new Error('Git unavailable');
      }),
    };
    await expect(
      prepareRuntimeInvocation(request, new AbortController().signal, undefined, git)
    ).rejects.toThrow(/execution directory cannot deactivate/);
    expect(git.run).toHaveBeenCalledTimes(2);
  }
);

test('a failed session Git query cannot erase ancestor governance or exact machine adoption', async () => {
  const crypto = require('node:crypto');
  const home = path.join(root, 'machine');
  fs.mkdirSync(home);
  const request = {
    schema: 'caws.runtime.request.v1',
    id: 'inactive-authority',
    runtimeDigest: 'a'.repeat(64),
    surface: 'codex',
    event: 'pre_tool_use',
    configuration: 'system',
    payload: payload({ execution_workdir: session }),
    caller: { cwd: session, environment: { HOME: root, CAWS_HOME: home } },
    deadlineEpochMs: Date.now() + 5000,
  };
  const git = {
    run: jest.fn(async () => {
      throw new Error('Git unavailable');
    }),
  };
  fs.mkdirSync(path.join(session, '.caws'));
  await expect(
    prepareRuntimeInvocation(request, new AbortController().signal, undefined, git)
  ).rejects.toThrow(/requires a resolvable session project/);
  fs.rmdirSync(path.join(session, '.caws'));
  const key = crypto.createHash('sha256').update(session).digest('hex');
  fs.mkdirSync(path.join(home, 'state/projects'), { recursive: true });
  fs.writeFileSync(path.join(home, 'state/projects', key + '.json'), '{}');
  await expect(
    prepareRuntimeInvocation(request, new AbortController().signal, undefined, git)
  ).rejects.toThrow(/requires a resolvable session project/);
  fs.unlinkSync(path.join(home, 'state/projects', key + '.json'));
  fs.writeFileSync(path.join(session, '.git'), 'gitdir: /unresolved-canonical/worktrees/fixture\n');
  await expect(
    prepareRuntimeInvocation(request, new AbortController().signal, undefined, git)
  ).rejects.toThrow(/requires a resolvable session project/);
  expect(git.run).toHaveBeenCalledTimes(3);
});
