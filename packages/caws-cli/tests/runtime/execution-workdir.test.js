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
    if (kind === 'adopted') {
      fs.mkdirSync(path.join(session, '.caws'));
      fs.writeFileSync(path.join(session, '.caws/policy.yaml'), 'version: 1\n');
    }
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

test.each([undefined, null, 'missing-directory', 'conflicting-aliases'])(
  'selected Stop parser ignores unrelated execution fields %p and preserves its session writes',
  (execution) => {
    cp.execFileSync('git', ['init', '--quiet', session]);
    fs.mkdirSync(path.join(session, '.caws/sessions/peer'), { recursive: true });
    const peer = path.join(session, '.caws/sessions/peer/.session-envelope.json');
    const peerBytes = Buffer.from('{"session_id":"peer","created_at":"preserve"}\n');
    fs.writeFileSync(peer, peerBytes);
    const input = payload({
      execution_workdir: execution === 'conflicting-aliases' ? command : execution,
      hook_event_name: 'Stop',
      session_id: 'original',
      tool_use_id: 'original-call',
      tool_input: { command: 'printf unchanged', workdir: session, cwd: command },
    });
    const program = [
      'source "$2" || exit $?;',
      'source "$1" || exit $?;',
      'parse_hook_input || exit $?;',
      'printf "%s\\n" "$HOOK_CWD" "$HOOK_SESSION_CWD" "$HOOK_EXECUTION_WORKDIR_STATUS" "$HOOK_EXECUTION_WORKDIR" "$HOOK_SESSION_ID" "$HOOK_TOOL_USE_ID" "$HOOK_EVENT_NAME";',
      // The native image preloads the same completion marker. A second call
      // must neither reparse execution context nor repeat envelope writes.
      '_hook_extract_scalar_fields() { printf forbidden-extractor >&2; return 91; };',
      '_write_durable_session_envelope() { printf forbidden-cache-write >&2; return 92; };',
      'parse_hook_input',
    ].join('\n');
    const result = cp.spawnSync(
      '/bin/bash',
      [
        '-c',
        program,
        'stop-parser-test',
        path.join(templates, 'codex/hooks/lib/parse-input.sh'),
        path.join(templates, 'shared/runtime-paths.sh'),
      ],
      {
        input: JSON.stringify(input),
        encoding: 'utf8',
        env: {
          HOME: root,
          PATH: process.env.PATH,
          CAWS_SHARED_LIB_DIR: path.join(templates, 'shared/lib'),
          CAWS_PROJECT_DIR: session,
        },
      }
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout.split('\n')).toEqual([
      session,
      session,
      'not_applicable',
      '',
      'original',
      'original-call',
      'Stop',
      '',
    ]);
    expect(
      JSON.parse(
        fs.readFileSync(path.join(session, '.caws/sessions/original/.session-envelope.json'))
      )
    ).toMatchObject({
      session_id: 'original',
      repo_root: session,
      hook_event: 'Stop',
      platform: 'codex',
    });
    expect(
      JSON.parse(fs.readFileSync(path.join(session, '.caws/sessions/.caller-session.json')))
    ).toMatchObject({ session_id: 'original', repo_root: session });
    expect(fs.readFileSync(peer)).toEqual(peerBytes);
    expect(fs.existsSync(path.join(command, '.caws'))).toBe(false);
    expect(fs.readdirSync(path.join(session, '.caws/sessions')).sort()).toEqual([
      '.caller-session.json',
      'original',
      'peer',
    ]);
  }
);

test.each(['.git', '.caws'])(
  'failed session and target Git queries retain unresolved target %s markers',
  async (marker) => {
    const home = path.join(root, 'machine');
    fs.mkdirSync(home);
    fs.mkdirSync(path.join(command, marker));
    if (marker === '.caws')
      fs.writeFileSync(path.join(command, marker, 'policy.yaml'), 'version: 1\n');
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
  fs.writeFileSync(path.join(session, '.caws/policy.yaml'), 'version: 1\n');
  await expect(
    prepareRuntimeInvocation(request, new AbortController().signal, undefined, git)
  ).rejects.toThrow(/requires a resolvable session project/);
  fs.unlinkSync(path.join(session, '.caws/policy.yaml'));
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

// These predicate controls inspect physical fixture metadata; no marker grants authority.
const { runtimeProjectRequiresResolvedAuthority } = require('../../dist/runtime/context');
const { ContextGitError } = require('../../dist/runtime/context-git-wire');
function predicateRequest(home) {
  const input = payload({
    execution_workdir: command,
    session_id: 'original',
    tool_use_id: 'call',
  });
  return {
    schema: 'caws.runtime.request.v1',
    id: 'predicate-context',
    runtimeDigest: 'a'.repeat(64),
    surface: 'codex',
    event: 'pre_tool_use',
    configuration: 'system',
    payload: input,
    inputJson: JSON.stringify(input),
    caller: { cwd: session, environment: { HOME: root, CAWS_HOME: home } },
    deadlineEpochMs: Date.now() + 5000,
  };
}
function danglingMarker(directory, home, kind) {
  if (kind === 'adoption') {
    const key = require('node:crypto').createHash('sha256').update(directory).digest('hex');
    const file = path.join(home, 'state/projects', key + '.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.symlinkSync(path.join(root, 'missing-adoption'), file);
  } else fs.symlinkSync(path.join(root, 'missing-marker'), path.join(directory, kind));
}
test.each(['state', 'state/projects'])(
  'unresolved adoption namespace %s cannot establish absence',
  (component) => {
    const home = path.join(root, 'machine');
    fs.mkdirSync(path.dirname(path.join(home, component)), { recursive: true });
    fs.symlinkSync(path.join(root, 'missing-adoption-namespace'), path.join(home, component));
    expect(runtimeProjectRequiresResolvedAuthority(session, home)).toBe(true);
    expect(runtimeProjectRequiresResolvedAuthority(session, home, 'resolved-canonical')).toBe(true);
  }
);

test('machine runtime and session-cache directories without project artifacts do not opt in', () => {
  const user = path.join(root, 'user');
  const home = path.join(user, '.caws');
  fs.mkdirSync(path.join(home, 'state/projects'), { recursive: true });
  for (const name of ['lib', 'bin', 'sessions']) fs.mkdirSync(path.join(home, name));
  const ordinary = path.join(user, '.codex/artifacts/session');
  fs.mkdirSync(ordinary, { recursive: true });
  expect(runtimeProjectRequiresResolvedAuthority(ordinary, home)).toBe(false);
  fs.mkdirSync(path.join(session, '.caws/sessions'), { recursive: true });
  expect(runtimeProjectRequiresResolvedAuthority(session, home)).toBe(false);
  fs.mkdirSync(path.join(session, '.git'));
  expect(runtimeProjectRequiresResolvedAuthority(session, home)).toBe(true);
  expect(runtimeProjectRequiresResolvedAuthority(session, home, 'resolved-canonical')).toBe(false);
});
test.each(['policy.yaml', 'specs', 'working-spec.yaml'])(
  'project artifact %s requires resolution even when dangling',
  (artifact) => {
    const home = path.join(root, 'machine');
    fs.mkdirSync(path.join(session, '.caws'));
    fs.symlinkSync(path.join(root, 'missing-artifact'), path.join(session, '.caws', artifact));
    expect(runtimeProjectRequiresResolvedAuthority(session, home)).toBe(true);
    expect(runtimeProjectRequiresResolvedAuthority(session, home, 'resolved-canonical')).toBe(true);
  }
);
test.each([
  ['ENOENT', false],
  ['EACCES', true],
  ['EIO', true],
  ['ENOTDIR', true],
])('only ENOENT establishes missing project metadata (%s)', (code, expected) => {
  const home = path.join(root, 'machine');
  fs.mkdirSync(path.join(session, '.caws'));
  const file = path.join(session, '.caws/policy.yaml');
  const actual = fs.lstatSync;
  const spy = jest.spyOn(fs, 'lstatSync').mockImplementation((value, ...args) => {
    if (String(value) === file) throw Object.assign(new Error('fixture metadata error'), { code });
    return actual(value, ...args);
  });
  try {
    expect(runtimeProjectRequiresResolvedAuthority(session, home)).toBe(expected);
    expect(spy).toHaveBeenCalledWith(file);
  } finally {
    spy.mockRestore();
  }
});
test.each(['.git', '.caws', 'adoption'])(
  'dangling original %s refuses before target query slots',
  async (kind) => {
    const home = path.join(root, 'machine');
    fs.mkdirSync(home);
    danglingMarker(session, home, kind);
    const request = {
      ...predicateRequest(home),
      contextGit: 'caws.runtime.context-git.execution-workdir.v1',
    };
    const git = {
      run: jest.fn(async () => {
        throw new ContextGitError('git_exit', 'fixture no Git');
      }),
    };
    await expect(
      prepareRuntimeInvocation(request, new AbortController().signal, undefined, git)
    ).rejects.toThrow(/requires a resolvable session project/);
    expect(git.run.mock.calls).toEqual([[['rev-parse', '--show-toplevel'], session]]);
  }
);
test.each(['.git', '.caws', 'adoption'])(
  'failed target with dangling %s cannot become inactive',
  async (kind) => {
    const home = path.join(root, 'machine');
    fs.mkdirSync(home);
    danglingMarker(command, home, kind);
    const request = {
      ...predicateRequest(home),
      contextGit: 'caws.runtime.context-git.execution-workdir.v1',
    };
    const git = {
      run: jest.fn(async () => {
        throw new ContextGitError('git_exit', 'fixture no Git');
      }),
    };
    await expect(
      prepareRuntimeInvocation(request, new AbortController().signal, undefined, git)
    ).rejects.toThrow(/execution directory cannot deactivate/);
    expect(git.run.mock.calls).toEqual([
      [['rev-parse', '--show-toplevel'], session],
      [['rev-parse', '--path-format=absolute', '--git-common-dir'], session],
      [['rev-parse', '--show-toplevel'], command],
    ]);
  }
);
test.each(['.caws', 'adoption'])(
  'resolved session with dangling %s cannot borrow foreign canonical authority',
  async (kind) => {
    const home = path.join(root, 'machine');
    fs.mkdirSync(home);
    danglingMarker(session, home, kind);
    const request = predicateRequest(home);
    const git = {
      run: jest.fn(async (args, cwd) => (args.length === 2 ? cwd : path.join(cwd, '.git'))),
    };
    const select = jest.fn(async () => ({
      status: 'inactive',
      reason: 'fixture no selected policy',
    }));
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
    ).rejects.toThrow(/foreign canonical project/);
    expect(git.run).toHaveBeenCalledTimes(4);
    expect(select).toHaveBeenCalledTimes(1);
    expect(select.mock.calls[0][0].canonical).toBe(session);
  }
);

test.each(['.caws', '.caws/policy.yaml', '.caws/specs', '.caws/working-spec.yaml'])(
  'resolved host target with dangling %s cannot become inactive',
  async (marker) => {
    const home = path.join(root, 'machine');
    fs.mkdirSync(home);
    fs.mkdirSync(path.dirname(path.join(command, marker)), { recursive: true });
    fs.symlinkSync(path.join(root, 'missing-target-governance'), path.join(command, marker));
    const request = predicateRequest(home);
    const git = {
      run: jest.fn(async (args, cwd) => {
        if (cwd === session) throw new ContextGitError('git_exit', 'fixture no session Git');
        return args.length === 2 ? command : path.join(command, '.git');
      }),
    };
    const select = jest.fn(async () => ({
      status: 'inactive',
      reason: 'fixture no selected policy',
    }));
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
    ).rejects.toThrow('Refusing symlink: ' + path.join(command, marker));
    expect(select).toHaveBeenCalledTimes(1);
    expect(select.mock.calls[0][0].canonical).toBe(command);
  }
);
test.each(['.caws', '.caws/policy.yaml', '.caws/specs', '.caws/working-spec.yaml'])(
  'same-canonical inactive host target cannot hide dangling %s',
  async (marker) => {
    const home = path.join(root, 'machine');
    fs.mkdirSync(home);
    fs.mkdirSync(path.dirname(path.join(command, marker)), { recursive: true });
    fs.symlinkSync(path.join(root, 'missing-target-governance'), path.join(command, marker));
    const request = predicateRequest(home);
    request.payload.cwd = command;
    request.caller.cwd = command;
    request.inputJson = JSON.stringify(request.payload);
    const git = {
      run: jest.fn(async (args) => (args.length === 2 ? command : path.join(command, '.git'))),
    };
    const select = jest.fn(async () => ({
      status: 'inactive',
      reason: 'fixture legacy suppression',
    }));
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
    ).rejects.toThrow('Refusing symlink: ' + path.join(command, marker));
    expect(select).toHaveBeenCalledTimes(2);
  }
);
test.each(['cache', 'legacy'])(
  'valid same-canonical %s suppression retains inactive selection',
  async (kind) => {
    const home = path.join(root, 'machine');
    fs.mkdirSync(home);
    fs.mkdirSync(path.join(command, '.caws/sessions'), { recursive: true });
    if (kind === 'legacy')
      fs.writeFileSync(path.join(command, '.caws/working-spec.yaml'), 'legacy fixture\n');
    const request = predicateRequest(home);
    request.payload.cwd = command;
    request.caller.cwd = command;
    request.inputJson = JSON.stringify(request.payload);
    const git = {
      run: jest.fn(async (args) => (args.length === 2 ? command : path.join(command, '.git'))),
    };
    const select = jest.fn(async () => ({
      status: 'inactive',
      reason: 'fixture existing suppression',
    }));
    const invocation = await prepareRuntimeInvocation(
      request,
      new AbortController().signal,
      undefined,
      git,
      undefined,
      undefined,
      select
    );
    expect(invocation.active).toBe(false);
    expect(select).toHaveBeenCalledTimes(2);
  }
);
