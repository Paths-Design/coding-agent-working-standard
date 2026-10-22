const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const dist = process.env.CAWS_TEST_DIST || path.join(__dirname, '../../dist');
const { configureSystemRuntime, systemSurfaceEnabled, migrateSystemProject } = require(
  path.join(dist, 'init/system-runtime')
);
const { observeSystemRuntime } = require(path.join(dist, 'store/system-runtime-observation'));
const {
  machineCommand,
  systemCommand,
  isCawsNativeCommand,
  qualifiedHookTimeout,
  unconditionalCommandHook,
  MACHINE_EVENTS,
} = require(path.join(dist, 'init/native-hook-identification'));
const { migrateNativeCommand } = require(path.join(dist, 'init/machine-adapter-policy'));
const { resolveInvocationSelection } = require(path.join(dist, 'runtime/selection'));
const sha = (s) => createHash('sha256').update(s).digest('hex');
let root, home, user, canonical, checkout, options;
function write(file, value, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  fs.chmodSync(file, mode);
}
function registration(file, command, matcher = '.*', extra = {}, hookExtra = {}) {
  write(file, {
    hooks: {
      PreToolUse: [{ matcher, hooks: [{ type: 'command', command, ...hookExtra }], ...extra }],
    },
  });
}
function execFormCawsHook(kind, surface = 'claude-code') {
  if (kind === 'interpreter')
    return {
      type: 'command',
      command: 'python3',
      args: [path.join(home, 'bin/caws-hook'), surface, 'pre_tool_use', '--system'],
    };
  return {
    type: 'command',
    command: kind === 'native' ? path.join(home, 'bin/caws-hook-native') : 'operator-wrapper',
    args: [
      ...(kind === 'wrapper' ? [path.join(home, 'bin/caws-hook-native')] : []),
      surface,
      'pre_tool_use',
      '--system',
    ],
  };
}
function initializeCanonicalGitFixture() {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))
  );
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: canonical, env });
  expect(
    execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: canonical,
      env,
      encoding: 'utf8',
    }).trim()
  ).toBe(canonical);
}
function nativeObservationFixture() {
  // Inert assets exercise registration/layout verification only. No fixture
  // executable is invoked and this is not a native-image execution witness.
  const previous = path.join(home, 'lib/runtimes', options.runtimeDigest);
  const members = JSON.parse(fs.readFileSync(path.join(previous, 'manifest.json')));
  const files = Object.fromEntries(
    Object.keys(members).map((relative) => [
      relative,
      fs.readFileSync(path.join(previous, relative), 'utf8'),
    ])
  );
  const executable = '# Native observation fixture; never executed\n';
  Object.assign(files, {
    'native/caws-hook-native': executable,
    'native/caws-native': executable,
    'native/node': executable,
    'native-prefix/engine-entry.js': '// observation fixture\n',
    'native-prefix/describe-entry.js': '// observation fixture\n',
    'native-entry.json': JSON.stringify({
      schema: 'caws.runtime.native-entry.v1',
      nativeExecutable: 'native/caws-native',
      nodeExecutable: 'native/node',
      engineEntry: 'native-prefix/engine-entry.js',
      describeEntry: 'native-prefix/describe-entry.js',
      timeoutMs: 1000,
    }),
    'native-modes.json': '',
  });
  const modes = Object.fromEntries(
    Object.keys(files)
      .sort()
      .map((relative) => [
        relative,
        relative.startsWith('native/') || relative.endsWith('.sh') ? 0o755 : 0o644,
      ])
  );
  files['native-modes.json'] = JSON.stringify(modes);
  const manifest = JSON.stringify(
    Object.fromEntries(Object.entries(files).map(([relative, bytes]) => [relative, sha(bytes)]))
  );
  const digest = sha(manifest);
  for (const [relative, bytes] of Object.entries(files))
    write(path.join(home, 'lib/runtimes', digest, relative), bytes, modes[relative]);
  write(path.join(home, 'lib/runtimes', digest, 'manifest.json'), manifest);
  write(path.join(home, 'bin/caws-hook-native'), executable, 0o755);
  write(path.join(home, 'state/adapter-runtime.json'), {
    version: 1,
    digest,
    previous_digest: options.runtimeDigest,
  });
  return digest;
}
function fixtureBytes() {
  const result = {};
  const visit = (directory) => {
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name);
      const stat = fs.lstatSync(file);
      if (stat.isDirectory()) {
        result[path.relative(root, file)] = { type: 'directory', mode: stat.mode };
        visit(file);
      } else
        result[path.relative(root, file)] = { sha256: sha(fs.readFileSync(file)), mode: stat.mode };
    }
  };
  visit(root);
  return result;
}
function withObservationHome(run) {
  const previous = process.env.CAWS_HOME;
  process.env.CAWS_HOME = home;
  const homedir = jest.spyOn(os, 'homedir').mockReturnValue(user);
  try {
    return run();
  } finally {
    homedir.mockRestore();
    if (previous === undefined) delete process.env.CAWS_HOME;
    else process.env.CAWS_HOME = previous;
  }
}
beforeEach(() => {
  const artifacts = process.env.CAWS_NATIVE_REGISTRATION_ARTIFACT_DIR;
  if (artifacts) fs.mkdirSync(artifacts, { recursive: true });
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(artifacts || os.tmpdir(), 'caws-native-registration-'))
  );
  home = path.join(root, 'machine');
  user = path.join(root, 'user');
  canonical = path.join(root, 'repo');
  checkout = path.join(root, 'linked');
  fs.mkdirSync(user);
  fs.mkdirSync(checkout);
  write(path.join(canonical, '.caws/policy.yaml'), 'version: 1\n');
  fs.mkdirSync(path.join(canonical, '.caws/specs'));
  const files = {
    'launcher.py': '# fixture\n',
    'bootstrap.py': '# fixture\n',
    'guard.sh': '#!/bin/sh\nexit 0\n',
    'session_log_renderer.py': '# fixture\n',
    'system-policy.json': JSON.stringify({
      version: 1,
      events: Object.fromEntries(Object.keys(MACHINE_EVENTS).map((e) => [e, ['guard.sh']])),
    }),
  };
  const manifest = JSON.stringify(
    Object.fromEntries(Object.entries(files).map(([p, b]) => [p, sha(b)]))
  );
  const digest = sha(manifest),
    runtime = path.join(home, 'lib/runtimes', digest);
  for (const [p, b] of Object.entries(files))
    write(path.join(runtime, p), b, p.endsWith('.sh') ? 0o755 : 0o644);
  write(path.join(runtime, 'manifest.json'), manifest);
  write(path.join(home, 'bin/caws-hook'), files['bootstrap.py'], 0o755);
  write(path.join(home, 'state/adapter-runtime.json'), {
    version: 1,
    digest,
    previous_digest: null,
  });
  write(path.join(home, 'surfaces/codex/settings.json'), { version: 1, enabled: true });
  options = {
    home,
    canonical,
    checkout,
    runtimeDigest: digest,
    surface: 'codex',
    event: 'pre_tool_use',
    system: true,
  };
});
afterEach(() => {
  if (process.env.CAWS_NATIVE_REGISTRATION_ARTIFACT_DIR)
    write(path.join(root, 'test-observation.json'), {
      test: expect.getState().currentTestName,
      home,
      user,
      canonical,
      checkout,
      boundary: 'Configuration and selection fixtures; no native harness callback executed',
    });
  else fs.rmSync(root, { recursive: true, force: true });
});
test.each(['codex', 'claude-code', 'qwen-code'])(
  'fresh %s transport covers all tools with event budgets in harness units',
  (surface) => {
    configureSystemRuntime({ home, userHome: user, surface });
    const vendor =
      surface === 'codex'
        ? '.codex/hooks.json'
        : surface === 'claude-code'
          ? '.claude/settings.json'
          : '.qwen/settings.json';
    const value = JSON.parse(fs.readFileSync(path.join(user, vendor)));
    const scale = surface === 'qwen-code' ? 1000 : 1;
    const seconds = {
      PreToolUse: 45,
      PostToolUse: 60,
      SessionStart: 30,
      Stop: 30,
      PreCompact: 30,
      SessionEnd: 10,
    };
    for (const [name, budget] of Object.entries(seconds)) {
      expect(value.hooks[name][0].hooks[0].timeout).toBe(budget * scale);
    }
    for (const name of ['PreToolUse', 'PostToolUse'])
      expect(value.hooks[name][0].matcher).toBe('.*');
  }
);
test.each([
  ['codex', '.codex/hooks.json', 'exec_command'],
  ['claude-code', '.claude/settings.json', 'Bash'],
  ['qwen-code', '.qwen/settings.json', 'run_shell_command'],
])(
  'restricted %s registration refuses before enabling system state',
  (surface, relative, matcher) => {
    const file = path.join(user, relative);
    registration(
      file,
      machineCommand(home, surface, 'pre_tool_use'),
      matcher,
      {},
      surface === 'qwen-code' ? { timeout: 45000 } : {}
    );
    const bytes = fs.readFileSync(file);
    const settings = path.join(home, 'surfaces', surface, 'settings.json');
    const previous = fs.existsSync(settings) ? fs.readFileSync(settings) : null;
    expect(() => configureSystemRuntime({ home, userHome: user, surface })).toThrow(
      /Restricted CAWS matcher/
    );
    expect(fs.readFileSync(file)).toEqual(bytes);
    expect(fs.existsSync(settings) ? fs.readFileSync(settings) : null).toEqual(previous);
  }
);
test.each(['claude-code', 'qwen-code'])('%s refuses disabled settings before writes', (surface) => {
  const file = path.join(
    user,
    surface === 'claude-code' ? '.claude/settings.json' : '.qwen/settings.json'
  );
  write(file, { disableAllHooks: true });
  const bytes = fs.readFileSync(file);
  expect(() => configureSystemRuntime({ home, userHome: user, surface })).toThrow(
    /disableAllHooks/
  );
  expect(fs.readFileSync(file)).toEqual(bytes);
  expect(fs.existsSync(path.join(home, 'surfaces', surface, 'settings.json'))).toBe(false);
});
test('Qwen seconds-era timeout cannot survive entry migration or suppress the system chain', () => {
  const command = machineCommand(home, 'qwen-code', 'pre_tool_use');
  const value = {
    hooks: { PreToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command, timeout: 45 }] }] },
  };
  const file = path.join(user, '.qwen/settings.json');
  write(file, value);
  const bytes = fs.readFileSync(file);
  expect(() => configureSystemRuntime({ home, userHome: user, surface: 'qwen-code' })).toThrow(
    /millisecond-budget/
  );
  expect(fs.readFileSync(file)).toEqual(bytes);
  write(path.join(canonical, '.qwen/settings.json'), value);
  write(path.join(home, 'surfaces/qwen-code/settings.json'), { version: 1, enabled: true });
  expect(() => resolveInvocationSelection({ ...options, surface: 'qwen-code' })).toThrow(
    /reconciliation/
  );
});
test.each([undefined, NaN, Infinity, -Infinity, 45, 44999, 45000.5, 2147483648, Number.MAX_VALUE])(
  'Qwen unsupported budget %s refuses without changing operator bytes',
  (timeout) => {
    const file = path.join(user, '.qwen/settings.json');
    const command = machineCommand(home, 'qwen-code', 'pre_tool_use');
    write(file, {
      hooks: {
        PreToolUse: [
          {
            matcher: '.*',
            hooks: [{ type: 'command', command, ...(timeout === undefined ? {} : { timeout }) }],
          },
        ],
      },
    });
    const bytes = fs.readFileSync(file);
    // JSON encodes nonfinite numbers as null; check both the in-memory boundary
    // and the actual serialized configuration instead of claiming NaN JSON.
    expect(qualifiedHookTimeout('qwen-code', 'pre_tool_use', timeout)).toBe(false);
    expect(() => configureSystemRuntime({ home, userHome: user, surface: 'qwen-code' })).toThrow(
      /reconciliation/
    );
    expect(fs.readFileSync(file)).toEqual(bytes);
    expect(fs.existsSync(path.join(home, 'surfaces/qwen-code/settings.json'))).toBe(false);
    write(path.join(home, 'surfaces/qwen-code/settings.json'), { version: 1, enabled: true });
    write(path.join(canonical, '.qwen/settings.json'), JSON.parse(bytes));
    expect(() => resolveInvocationSelection({ ...options, surface: 'qwen-code' })).toThrow(
      /reconciliation/
    );
  }
);
test.each([
  ['pre_tool_use', 45000],
  ['post_tool_use', 60000],
  ['session_start', 30000],
  ['stop', 30000],
  ['pre_compact', 30000],
  ['session_end', 10000],
])('Qwen %s explicit floor %s preserves operator bytes on repeated configure', (event, timeout) => {
  const file = path.join(user, '.qwen/settings.json');
  write(file, {
    hooks: {
      [MACHINE_EVENTS[event]]: [
        {
          matcher: '.*',
          hooks: [{ type: 'command', command: machineCommand(home, 'qwen-code', event), timeout }],
        },
      ],
    },
  });
  configureSystemRuntime({ home, userHome: user, surface: 'qwen-code' });
  const bytes = fs.readFileSync(file);
  expect(JSON.parse(bytes).hooks[MACHINE_EVENTS[event]][0].hooks[0].timeout).toBe(timeout);
  expect(configureSystemRuntime({ home, userHome: user, surface: 'qwen-code' }).changed).toBe(
    false
  );
  expect(fs.readFileSync(file)).toEqual(bytes);
});
test.each([
  { if: 'Bash(rm *)' },
  { args: [] },
  { async: true },
  { type: 'http' },
  { unknownExecutionMode: true },
])(
  'execution-affecting hook fields %j require reconciliation before configuration or suppression',
  (fields) => {
    const command = machineCommand(home, 'codex', 'pre_tool_use');
    const value = {
      hooks: { PreToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command, ...fields }] }] },
    };
    const file = path.join(user, '.codex/hooks.json');
    write(file, value);
    const bytes = fs.readFileSync(file);
    expect(() => configureSystemRuntime({ home, userHome: user, surface: 'codex' })).toThrow(
      /reconciliation/
    );
    expect(fs.readFileSync(file)).toEqual(bytes);
    write(path.join(canonical, '.codex/hooks.json'), value);
    expect(() => resolveInvocationSelection(options)).toThrow(/reconciliation/);
  }
);
test('omitted Codex lifecycle matcher retains canonical event coverage', () => {
  write(path.join(canonical, '.codex/hooks.json'), {
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: machineCommand(home, 'codex', 'stop') }] }],
    },
  });
  expect(resolveInvocationSelection({ ...options, event: 'stop' }).status).toBe('inactive');
});
test('fresh configure remains legacy and installing an image is not implicit native registration', () => {
  configureSystemRuntime({ home, userHome: user, surface: 'codex' });
  const value = JSON.parse(fs.readFileSync(path.join(user, '.codex/hooks.json')));
  expect(value.hooks.PreToolUse[0].hooks[0].command).toBe(
    systemCommand(home, 'codex', 'pre_tool_use')
  );
  expect(value.hooks.PreToolUse[0].hooks[0].command).toContain('python3');
  const bytes = fs.readFileSync(path.join(user, '.codex/hooks.json'));
  expect(() =>
    configureSystemRuntime({ home, userHome: user, surface: 'codex', entry: 'native' })
  ).toThrow(/native-image/);
  expect(fs.readFileSync(path.join(user, '.codex/hooks.json'))).toEqual(bytes);
});
test.each(['legacy', 'native'])(
  'Claude failure policy blocks new %s PreToolUse handlers and retains foreign hooks',
  (entry) => {
    nativeObservationFixture();
    const file = path.join(user, '.claude/settings.json');
    const foreign = { type: 'command', command: '/operator/notify.sh', onFailure: 'continue' };
    write(file, { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [foreign] }] } });
    configureSystemRuntime({ home, userHome: user, surface: 'claude-code', entry });
    const value = JSON.parse(fs.readFileSync(file));
    expect(value.hooks.PreToolUse[0]).toEqual({ matcher: 'Bash', hooks: [foreign] });
    expect(value.hooks.PreToolUse[1].hooks[0]).toEqual({
      type: 'command',
      command: systemCommand(home, 'claude-code', 'pre_tool_use', entry),
      timeout: 45,
      onFailure: 'block',
    });
    for (const [event, groups] of Object.entries(value.hooks))
      if (event !== 'PreToolUse')
        for (const group of groups)
          for (const hook of group.hooks) expect(hook).not.toHaveProperty('onFailure');
  }
);
test.each([
  ['/p/.caws/hooks/dispatch/pre_tool_use.sh', undefined],
  ['/p/.caws/hooks/dispatch/pre_tool_use.sh', 'continue'],
  ['/p/bin/caws-hook-native', undefined],
  ['/p/bin/caws-hook-native', 'continue'],
])('producer configuration preserves quoted pathname data %s policy=%s', (operand, onFailure) => {
  const surface = 'claude-code';
  const file = path.join(user, '.claude/settings.json');
  const foreign = {
    type: 'command',
    command: `printf '%s\\n' '${operand}'`,
    ...(onFailure === undefined ? {} : { onFailure }),
  };
  write(file, {
    hooks: {
      PreToolUse: [
        {
          matcher: '.*',
          hooks: [
            foreign,
            {
              type: 'command',
              command: machineCommand(home, surface, 'pre_tool_use'),
            },
          ],
        },
      ],
    },
  });
  expect(configureSystemRuntime({ home, userHome: user, surface }).changed).toBe(true);
  const value = JSON.parse(fs.readFileSync(file));
  expect(value.hooks.PreToolUse[0].hooks[0]).toEqual(foreign);
  expect(value.hooks.PreToolUse[0].hooks[1]).toEqual({
    type: 'command',
    command: systemCommand(home, surface, 'pre_tool_use'),
    onFailure: 'block',
  });
  const before = fixtureBytes();
  expect(configureSystemRuntime({ home, userHome: user, surface, plan: true }).changed).toBe(false);
  expect(systemSurfaceEnabled(surface, home, user)).toBe(true);
  expect(fixtureBytes()).toEqual(before);
});
test.each([
  ['/p/.caws/hooks/dispatch/pre_tool_use.sh', undefined],
  ['/p/.caws/hooks/dispatch/pre_tool_use.sh', 'continue'],
  ['/p/bin/caws-hook-native', undefined],
  ['/p/bin/caws-hook-native', 'continue'],
])(
  'producer selection gives literal pathname data zero project coverage %s policy=%s',
  (operand, onFailure) => {
    const surface = 'claude-code';
    fs.unlinkSync(path.join(home, 'surfaces/codex/settings.json'));
    configureSystemRuntime({ home, userHome: user, surface, entry: 'legacy' });
    registration(
      path.join(canonical, '.claude/settings.json'),
      `printf '%s\\n' '${operand}'`,
      '.*',
      {},
      onFailure === undefined ? {} : { onFailure }
    );
    const before = fixtureBytes();
    expect(resolveInvocationSelection({ ...options, surface }).status).toBe('active');
    withObservationHome(() => {
      expect(observeSystemRuntime(canonical)).toEqual({
        surfaces: ['claude-code'],
        legacySurfaces: [],
        overrides: [],
        digest: options.runtimeDigest,
      });
    });
    expect(fixtureBytes()).toEqual(before);
  }
);
test.each(['--custom', '&& echo operator', 'dynamic-wrapper'])(
  'producer configuration keeps actual or unresolved CAWS %s fail-closed before writes',
  (kind) => {
    const surface = 'claude-code';
    const command =
      kind === 'dynamic-wrapper'
        ? 'operator-wrapper "$UNKNOWN/bin/caws-hook-native" claude-code pre_tool_use'
        : machineCommand(home, surface, 'pre_tool_use') + ' ' + kind;
    registration(path.join(user, '.claude/settings.json'), command);
    registration(path.join(canonical, '.claude/settings.json'), command);
    write(path.join(home, 'surfaces/claude-code/settings.json'), { version: 1, enabled: true });
    const before = fixtureBytes();
    for (const plan of [true, false])
      expect(() =>
        configureSystemRuntime({ home, userHome: user, surface, entry: 'legacy', plan })
      ).toThrow(/reconcil/i);
    expect(() => resolveInvocationSelection({ ...options, surface })).toThrow(/reconcil/i);
    expect(fixtureBytes()).toEqual(before);
  }
);
test('producer selection treats local and checkout literal path data as zero CAWS coverage', () => {
  const surface = 'claude-code';
  configureSystemRuntime({ home, userHome: user, surface, entry: 'legacy' });
  for (const file of [
    path.join(canonical, '.claude/settings.local.json'),
    path.join(checkout, '.claude/settings.json'),
  ])
    registration(file, "echo '/p/bin/caws-hook-native'", '.*', {}, { onFailure: 'continue' });
  const before = fixtureBytes();
  expect(resolveInvocationSelection({ ...options, surface }).status).toBe('active');
  expect(fixtureBytes()).toEqual(before);
});
test('producer entry inference follows the actual legacy dispatcher rather than assignment pathname data', () => {
  const surface = 'claude-code';
  const file = path.join(user, '.claude/settings.json');
  const assignment = "NOTE='/p/bin/caws-hook-native'";
  const dispatcher = path.join(user, '.caws/hooks/dispatch/pre_tool_use.sh');
  registration(file, `${assignment} "${dispatcher}"`);
  expect(fs.existsSync(path.join(home, 'bin/caws-hook-native'))).toBe(false);
  expect(configureSystemRuntime({ home, userHome: user, surface }).changed).toBe(true);
  const hook = JSON.parse(fs.readFileSync(file)).hooks.PreToolUse[0].hooks[0];
  expect(hook.command).toBe(
    assignment + ' ' + systemCommand(home, surface, 'pre_tool_use', 'legacy')
  );
  expect(hook.onFailure).toBe('block');
  expect(fs.existsSync(path.join(home, 'bin/caws-hook-native'))).toBe(false);
  expect(configureSystemRuntime({ home, userHome: user, surface, plan: true }).changed).toBe(false);
});
test.each(['interpreter', 'native', 'wrapper'])(
  'exec-form CAWS %s configuration refuses before fixture writes',
  (kind) => {
    const surface = 'claude-code';
    write(path.join(user, '.claude/settings.json'), {
      hooks: { PreToolUse: [{ hooks: [execFormCawsHook(kind)] }] },
    });
    const before = fixtureBytes();
    for (const plan of [true, false])
      expect(() =>
        configureSystemRuntime({ home, userHome: user, surface, entry: 'legacy', plan })
      ).toThrow(/reconcil/i);
    expect(fixtureBytes()).toEqual(before);
  }
);
test.each(['interpreter', 'native', 'wrapper'])(
  'exec-form CAWS %s selection refuses before fixture writes',
  (kind) => {
    const surface = 'claude-code';
    configureSystemRuntime({ home, userHome: user, surface, entry: 'legacy' });
    write(path.join(canonical, '.claude/settings.json'), {
      hooks: { PreToolUse: [{ matcher: '.*', hooks: [execFormCawsHook(kind)] }] },
    });
    const before = fixtureBytes();
    expect(() => resolveInvocationSelection({ ...options, surface })).toThrow(/reconcil/i);
    expect(fixtureBytes()).toEqual(before);
  }
);
test.each(['interpreter', 'native', 'wrapper'])(
  'exec-form CAWS %s project migration refuses before fixture writes',
  (kind) => {
    const surface = 'claude-code';
    initializeCanonicalGitFixture();
    configureSystemRuntime({ home, userHome: user, surface, entry: 'legacy' });
    write(path.join(canonical, '.claude/settings.json'), {
      hooks: { PreToolUse: [{ matcher: '.*', hooks: [execFormCawsHook(kind)] }] },
    });
    const before = fixtureBytes();
    for (const plan of [true, false])
      expect(() =>
        migrateSystemProject({ home, userHome: user, repo: canonical, surface, plan })
      ).toThrow(/reconcil/i);
    expect(fixtureBytes()).toEqual(before);
  }
);
test.each(['printf', 'echo'])(
  'exec-form literal %s path data preserves argv and supplies zero coverage',
  (command) => {
    const surface = 'claude-code';
    initializeCanonicalGitFixture();
    const foreign = {
      type: 'command',
      command,
      args: [
        '%s\\n',
        '/p/bin/caws-hook-native',
        '/p/.caws/hooks/dispatch/pre_tool_use.sh',
        "$LITERAL 'quoted' `literal`",
      ],
      onFailure: 'continue',
    };
    const file = path.join(user, '.claude/settings.json');
    write(file, { hooks: { PreToolUse: [{ matcher: '.*', hooks: [foreign] }] } });
    configureSystemRuntime({ home, userHome: user, surface, entry: 'legacy' });
    expect(JSON.parse(fs.readFileSync(file)).hooks.PreToolUse[0].hooks[0]).toEqual(foreign);
    expect(JSON.parse(fs.readFileSync(file)).hooks.PreToolUse[1].hooks[0].onFailure).toBe('block');
    write(path.join(canonical, '.claude/settings.json'), {
      hooks: { PreToolUse: [{ hooks: [foreign] }] },
    });
    const before = fixtureBytes();
    expect(resolveInvocationSelection({ ...options, surface }).status).toBe('active');
    expect(configureSystemRuntime({ home, userHome: user, surface, plan: true }).changed).toBe(
      false
    );
    expect(fixtureBytes()).toEqual(before);
    migrateSystemProject({ home, userHome: user, repo: canonical, surface });
    expect(
      JSON.parse(fs.readFileSync(path.join(canonical, '.claude/settings.json'))).hooks.PreToolUse[0]
        .hooks[0]
    ).toEqual(foreign);
    expect(resolveInvocationSelection({ ...options, surface }).status).toBe('active');
  }
);
test('Codex args on a recognized CAWS command remains unsupported and refuses before writes', () => {
  registration(
    path.join(user, '.codex/hooks.json'),
    machineCommand(home, 'codex', 'pre_tool_use'),
    '.*',
    {},
    { args: [] }
  );
  const before = fixtureBytes();
  expect(() => configureSystemRuntime({ home, userHome: user, surface: 'codex' })).toThrow(
    /reconcil/i
  );
  expect(fixtureBytes()).toEqual(before);
});
test.each(['legacy', 'native'])(
  'Claude failure policy retrofits absent %s policy through read-only plan then idempotent apply',
  (entry) => {
    nativeObservationFixture();
    const surface = 'claude-code';
    const settings = { home, userHome: user, surface, entry };
    configureSystemRuntime(settings);
    const file = path.join(user, '.claude/settings.json');
    const value = JSON.parse(fs.readFileSync(file));
    delete value.hooks.PreToolUse[0].hooks[0].onFailure;
    write(file, value);
    const before = fixtureBytes();
    expect(configureSystemRuntime({ ...settings, plan: true }).changed).toBe(true);
    expect(fixtureBytes()).toEqual(before);
    expect(configureSystemRuntime(settings).changed).toBe(true);
    value.hooks.PreToolUse[0].hooks[0].onFailure = 'block';
    expect(JSON.parse(fs.readFileSync(file))).toEqual(value);
    const applied = fixtureBytes();
    expect(configureSystemRuntime({ ...settings, plan: true }).changed).toBe(false);
    expect(systemSurfaceEnabled(surface, home, user)).toBe(true);
    expect(configureSystemRuntime(settings).changed).toBe(false);
    expect(fixtureBytes()).toEqual(applied);
  }
);
test.each([
  ['legacy', 'continue'],
  ['native', 'continue'],
  ['legacy', null],
  ['native', null],
  ['legacy', { action: 'block' }],
  ['native', { action: 'block' }],
])('Claude failure policy refuses explicit %s policy %j before any writes', (entry, onFailure) => {
  nativeObservationFixture();
  const surface = 'claude-code';
  const file = path.join(user, '.claude/settings.json');
  registration(file, machineCommand(home, surface, 'pre_tool_use', entry), '.*', {}, { onFailure });
  const before = fixtureBytes();
  for (const plan of [true, false])
    expect(() => configureSystemRuntime({ home, userHome: user, surface, entry, plan })).toThrow(
      /failure policy|reconciliation/i
    );
  expect(fixtureBytes()).toEqual(before);
});
test.each(['legacy', 'native'])(
  'Claude failure policy recognizes only unconditional block project %s coverage',
  (entry) => {
    nativeObservationFixture();
    const surface = 'claude-code';
    const file = path.join(canonical, '.claude/settings.json');
    const command = machineCommand(home, surface, 'pre_tool_use', entry);
    registration(file, command, '.*', {}, { onFailure: 'block' });
    expect(resolveInvocationSelection({ ...options, surface })).toEqual({
      status: 'inactive',
      reason: 'legacy native registration remains selected',
    });
    registration(file, command, '.*', {}, { onFailure: 'continue' });
    expect(() => resolveInvocationSelection({ ...options, surface })).toThrow(/reconciliation/);
    registration(file, command, '.*', {}, { onFailure: 'block', async: true });
    expect(() => resolveInvocationSelection({ ...options, surface })).toThrow(/reconciliation/);
  }
);
test.each([
  ['codex', 'pre_tool_use', '.codex/hooks.json'],
  ['qwen-code', 'pre_tool_use', '.qwen/settings.json'],
  ['claude-code', 'post_tool_use', '.claude/settings.json'],
])('failure policy remains unsupported for %s %s', (surface, event, relative) => {
  configureSystemRuntime({ home, userHome: user, surface });
  const file = path.join(user, relative);
  const value = JSON.parse(fs.readFileSync(file));
  for (const groups of Object.values(value.hooks))
    for (const group of groups)
      for (const hook of group.hooks)
        if (
          surface !== 'claude-code' ||
          hook.command !== systemCommand(home, surface, 'pre_tool_use')
        )
          expect(hook).not.toHaveProperty('onFailure');
  value.hooks[MACHINE_EVENTS[event]][0].hooks[0].onFailure = 'block';
  write(file, value);
  const before = fixtureBytes();
  expect(() => configureSystemRuntime({ home, userHome: user, surface })).toThrow(/reconciliation/);
  expect(fixtureBytes()).toEqual(before);
});
test('Claude failure policy recognition stays qualified by surface, event, exact value and execution fields', () => {
  const group = { matcher: '.*', hooks: [] };
  const hook = { type: 'command', command: '/operator/hook', onFailure: 'block' };
  expect(unconditionalCommandHook(group, hook, 'claude-code', 'pre_tool_use')).toBe(true);
  for (const onFailure of ['continue', 'BLOCK', null, undefined, { action: 'block' }])
    expect(
      unconditionalCommandHook(group, { ...hook, onFailure }, 'claude-code', 'pre_tool_use')
    ).toBe(false);
  for (const extra of [{ if: 'Bash' }, { async: true }, { args: [] }, { custom: true }])
    expect(
      unconditionalCommandHook(group, { ...hook, ...extra }, 'claude-code', 'pre_tool_use')
    ).toBe(false);
  expect(unconditionalCommandHook(group, hook)).toBe(false);
  expect(unconditionalCommandHook(group, hook, 'codex', 'pre_tool_use')).toBe(false);
  expect(unconditionalCommandHook(group, hook, 'qwen-code', 'pre_tool_use')).toBe(false);
  for (const event of Object.keys(MACHINE_EVENTS).filter((event) => event !== 'pre_tool_use'))
    expect(unconditionalCommandHook(group, hook, 'claude-code', event)).toBe(false);
});
test.each(['legacy', 'native'])(
  'system observation accepts explicitly configured %s transport without changing fixture bytes',
  (entry) => {
    const digest = nativeObservationFixture();
    configureSystemRuntime({ home, userHome: user, surface: 'codex', entry });
    const native = JSON.parse(fs.readFileSync(path.join(user, '.codex/hooks.json')));
    for (const [event, name] of Object.entries(MACHINE_EVENTS))
      expect(native.hooks[name][0].hooks[0].command).toBe(
        systemCommand(home, 'codex', event, entry)
      );
    const before = fixtureBytes();
    withObservationHome(() => {
      expect(configureSystemRuntime({ home, surface: 'codex', plan: true }).changed).toBe(false);
      expect(systemSurfaceEnabled('codex', home)).toBe(true);
      expect(observeSystemRuntime(canonical)).toEqual({
        surfaces: ['codex'],
        legacySurfaces: [],
        overrides: [],
        digest,
      });
    });
    expect(fixtureBytes()).toEqual(before);
  }
);
test('system observation accepts legacy-only selected generation without native metadata or entry', () => {
  configureSystemRuntime({ home, userHome: user, surface: 'codex', entry: 'legacy' });
  expect(fs.existsSync(path.join(home, 'bin/caws-hook-native'))).toBe(false);
  expect(
    fs.existsSync(path.join(home, 'lib/runtimes', options.runtimeDigest, 'native-entry.json'))
  ).toBe(false);
  const before = fixtureBytes();
  withObservationHome(() => {
    expect(configureSystemRuntime({ home, surface: 'codex', plan: true }).changed).toBe(false);
    expect(systemSurfaceEnabled('codex', home)).toBe(true);
    expect(observeSystemRuntime(canonical)).toEqual({
      surfaces: ['codex'],
      legacySurfaces: [],
      overrides: [],
      digest: options.runtimeDigest,
    });
  });
  expect(fixtureBytes()).toEqual(before);
});
function rollbackObservationFixture(farther = false) {
  const nativeDigest = nativeObservationFixture();
  configureSystemRuntime({ home, userHome: user, surface: 'codex', entry: 'native' });
  let previousDigest = nativeDigest;
  if (farther) {
    const legacyRoot = path.join(home, 'lib/runtimes', options.runtimeDigest);
    const manifest = JSON.parse(fs.readFileSync(path.join(legacyRoot, 'manifest.json')));
    const files = Object.fromEntries(
      Object.keys(manifest).map((relative) => [
        relative,
        fs.readFileSync(path.join(legacyRoot, relative)),
      ])
    );
    files['legacy-hop.txt'] = Buffer.from('A later legacy generation\n');
    const bytes = JSON.stringify(
      Object.fromEntries(
        Object.entries(files).map(([relative, content]) => [relative, sha(content)])
      )
    );
    previousDigest = sha(bytes);
    for (const [relative, content] of Object.entries(files))
      write(
        path.join(home, 'lib/runtimes', previousDigest, relative),
        content.toString('utf8'),
        relative.endsWith('.sh') ? 0o755 : 0o644
      );
    write(path.join(home, 'lib/runtimes', previousDigest, 'manifest.json'), bytes);
  }
  // Fixture pointer models ordinary rollback; no fixture executable is run.
  write(path.join(home, 'state/adapter-runtime.json'), {
    version: 1,
    digest: options.runtimeDigest,
    previous_digest: previousDigest,
  });
  return { nativeDigest, previousDigest };
}
test.each([false, true])(
  'rollback observation preserves a verified native transport across legacy selection (farther retained image: %s)',
  (farther) => {
    rollbackObservationFixture(farther);
    const before = fixtureBytes();
    withObservationHome(() => {
      expect(configureSystemRuntime({ home, surface: 'codex', plan: true }).changed).toBe(false);
      expect(systemSurfaceEnabled('codex', home)).toBe(true);
      expect(observeSystemRuntime(canonical)).toEqual({
        surfaces: ['codex'],
        legacySurfaces: [],
        overrides: [],
        digest: options.runtimeDigest,
      });
      expect(() =>
        configureSystemRuntime({ home, surface: 'codex', entry: 'native', plan: true })
      ).toThrow(/native-image/);
    });
    expect(fixtureBytes()).toEqual(before);
  }
);
test.each([
  'missing retained image',
  'corrupt retained manifest',
  'corrupt retained member',
  'invalid retained mode',
  'missing retained metadata',
  'orphan retained metadata',
  'missing stable entry',
  'changed stable entry',
  'invalid stable mode',
  'hardlinked stable entry',
  'changed selected legacy',
])('rollback observation refuses %s without repairing state', (kind) => {
  const { nativeDigest } = rollbackObservationFixture();
  const retained = path.join(home, 'lib/runtimes', nativeDigest);
  const stable = path.join(home, 'bin/caws-hook-native');
  if (kind === 'missing retained image') fs.rmSync(retained, { recursive: true });
  if (kind === 'corrupt retained manifest') write(path.join(retained, 'manifest.json'), '{}');
  if (kind === 'corrupt retained member')
    write(path.join(retained, 'guard.sh'), '# changed\n', 0o755);
  if (kind === 'invalid retained mode') fs.chmodSync(path.join(retained, 'native/node'), 0o644);
  if (kind === 'missing retained metadata') fs.unlinkSync(path.join(retained, 'native-entry.json'));
  if (kind === 'orphan retained metadata') {
    fs.rmSync(retained, { recursive: true });
    write(path.join(home, 'lib/runtimes', 'f'.repeat(64), 'native-entry.json'), {});
  }
  if (kind === 'missing stable entry') fs.unlinkSync(stable);
  if (kind === 'changed stable entry') write(stable, '# changed\n', 0o755);
  if (kind === 'invalid stable mode') fs.chmodSync(stable, 0o644);
  if (kind === 'hardlinked stable entry') fs.linkSync(stable, path.join(root, 'stable-hardlink'));
  if (kind === 'changed selected legacy')
    write(path.join(home, 'lib/runtimes', options.runtimeDigest, 'guard.sh'), '# changed\n', 0o755);
  const before = fixtureBytes();
  const pattern = kind === 'changed selected legacy' ? /modified/ : /native-image/;
  withObservationHome(() => {
    expect(() => configureSystemRuntime({ home, surface: 'codex', plan: true })).toThrow(pattern);
    expect(() => systemSurfaceEnabled('codex', home)).toThrow(pattern);
    expect(observeSystemRuntime(canonical)).toEqual({
      surfaces: ['codex'],
      legacySurfaces: [],
      overrides: [],
      error: expect.stringMatching(pattern),
    });
  });
  expect(fixtureBytes()).toEqual(before);
});
test.each(['absent', 'disabled'])(
  'system observation leaves %s system surface settings inactive and untouched',
  (state) => {
    nativeObservationFixture();
    configureSystemRuntime({ home, userHome: user, surface: 'codex', entry: 'native' });
    const settings = path.join(home, 'surfaces/codex/settings.json');
    if (state === 'absent') fs.unlinkSync(settings);
    else write(settings, { version: 1, enabled: false });
    const before = fixtureBytes();
    withObservationHome(() => {
      expect(systemSurfaceEnabled('codex', home)).toBe(false);
      expect(observeSystemRuntime(canonical)).toBeUndefined();
    });
    expect(fixtureBytes()).toEqual(before);
  }
);
test.each([
  ['legacy', 'restricted matcher', /Restricted CAWS matcher/],
  ['legacy', 'disabled hooks', /disableAllHooks/],
  ['native', 'disabled group', /Disabled CAWS registration/],
  ['native', 'conditional hook', /Conditional or unsupported CAWS hook/],
  ['native', 'mixed entry', /Mixed CAWS entry registrations/],
  ['legacy', 'duplicate hook', /Duplicate native CAWS registrations/],
  ['legacy', 'missing lifecycle event', /System surface settings and native registration disagree/],
  ['native', 'custom command', /reconciliation/i],
  ['native', 'tampered stable entry', /native-image/],
  ['native', 'tampered generation mode', /Native runtime member mode mismatch/],
])(
  'system observation rejects %s %s under the read-only registration contract',
  (entry, kind, pattern) => {
    const digest = nativeObservationFixture();
    configureSystemRuntime({ home, userHome: user, surface: 'codex', entry });
    const file = path.join(user, '.codex/hooks.json');
    const native = JSON.parse(fs.readFileSync(file));
    const group = native.hooks.PreToolUse[0];
    if (kind === 'restricted matcher') group.matcher = 'exec_command';
    if (kind === 'disabled hooks') native.disableAllHooks = true;
    if (kind === 'disabled group') group.enabled = false;
    if (kind === 'conditional hook') group.hooks[0].if = 'Bash(rm *)';
    if (kind === 'mixed entry')
      native.hooks.Stop[0].hooks[0].command = systemCommand(home, 'codex', 'stop', 'legacy');
    if (kind === 'duplicate hook') group.hooks.push({ ...group.hooks[0] });
    if (kind === 'missing lifecycle event') delete native.hooks.SessionEnd;
    if (kind === 'custom command') group.hooks[0].command += ' --unreviewed';
    if (kind === 'tampered stable entry')
      write(path.join(home, 'bin/caws-hook-native'), 'Changed observation fixture\n', 0o755);
    if (kind === 'tampered generation mode')
      fs.chmodSync(path.join(home, 'lib/runtimes', digest, 'native/node'), 0o644);
    write(file, native);
    const before = fixtureBytes();
    withObservationHome(() => {
      if (kind === 'missing lifecycle event')
        expect(configureSystemRuntime({ home, surface: 'codex', plan: true }).changed).toBe(true);
      else
        expect(() => configureSystemRuntime({ home, surface: 'codex', plan: true })).toThrow(
          pattern
        );
      let rejected;
      try {
        systemSurfaceEnabled('codex', home);
      } catch (error) {
        rejected = error;
      }
      expect(rejected).toBeInstanceOf(Error);
      expect(rejected.message).toMatch(pattern);
      expect(observeSystemRuntime(canonical)).toEqual({
        surfaces: ['codex'],
        legacySurfaces: [],
        overrides: [],
        error: rejected.message,
      });
    });
    expect(fixtureBytes()).toEqual(before);
  }
);
test('recognizes only exact native entry filename and migrates understood transport without evaluating shell', () => {
  const native = machineCommand(home, 'codex', 'pre_tool_use', 'native');
  expect(native).not.toContain('python3');
  expect(isCawsNativeCommand(native)).toBe(true);
  expect(isCawsNativeCommand(native.replace('caws-hook-native', 'caws-hook-native-evil'))).toBe(
    false
  );
  expect(migrateNativeCommand(native + ' --system', user, home, 'codex', 'pre_tool_use')).toBe(
    machineCommand(home, 'codex', 'pre_tool_use')
  );
  expect(
    migrateNativeCommand(
      machineCommand(home, 'codex', 'pre_tool_use'),
      user,
      home,
      'codex',
      'pre_tool_use',
      'native'
    )
  ).toBe(native);
  expect(() =>
    migrateNativeCommand(
      native + '; touch /tmp/should-not-run',
      user,
      home,
      'codex',
      'pre_tool_use'
    )
  ).toThrow(/reconciliation/);
});
test('universal understood canonical registration suppresses only its covered event', () => {
  registration(
    path.join(canonical, '.codex/hooks.json'),
    machineCommand(home, 'codex', 'pre_tool_use')
  );
  expect(resolveInvocationSelection(options)).toEqual({
    status: 'inactive',
    reason: 'legacy native registration remains selected',
  });
  expect(resolveInvocationSelection({ ...options, event: 'post_tool_use' }).status).toBe('active');
});
test.each(['Bash', '^Write$', 'Edit|Write'])(
  'restricted matcher %s is a protective unsupported boundary',
  (matcher) => {
    registration(
      path.join(canonical, '.codex/hooks.json'),
      machineCommand(home, 'codex', 'pre_tool_use'),
      matcher
    );
    expect(() => resolveInvocationSelection(options)).toThrow(/Restricted or additive/);
  }
);
test.each([
  'checkout',
  'local',
  'duplicate',
  'wrong-event',
  'wrapper',
  'inline',
  'system',
  'describe',
  'foreign-home',
  'modified-entry',
  'missing-entry',
  'quoted-assignment',
  'escaped-assignment',
  'missing-assignment',
  'duplicate-assignment',
])('does not silently suppress guards for %s registration', (kind) => {
  const command = machineCommand(home, 'codex', 'pre_tool_use');
  const primary = path.join(canonical, '.codex/hooks.json');
  if (kind === 'checkout') registration(path.join(checkout, '.codex/hooks.json'), command);
  if (kind === 'local') registration(path.join(canonical, '.codex/settings.local.json'), command);
  if (kind === 'duplicate')
    write(primary, {
      hooks: { PreToolUse: [{ matcher: '.*', hooks: [{ command }, { command }] }] },
    });
  if (kind === 'wrong-event') registration(primary, machineCommand(home, 'codex', 'stop'));
  if (kind === 'wrapper') registration(primary, command + ' && echo unmodeled');
  if (kind === 'inline')
    write(path.join(canonical, '.codex/config.toml'), '[hooks]\ncommand="' + command + '"');
  if (kind === 'system') registration(primary, command + ' --system');
  if (kind === 'describe') registration(primary, command + ' --describe');
  const assignmentEnd = command.indexOf(' python3');
  if (kind === 'quoted-assignment')
    registration(primary, `'CAWS_HOME=${home}'` + command.slice(assignmentEnd));
  if (kind === 'escaped-assignment')
    registration(primary, 'CAWS_HOME\\=' + command.slice('CAWS_HOME='.length));
  if (kind === 'missing-assignment') registration(primary, command.slice(assignmentEnd + 1));
  if (kind === 'duplicate-assignment')
    registration(primary, command.slice(0, assignmentEnd) + ' ' + command);
  if (kind === 'foreign-home')
    registration(
      primary,
      machineCommand(path.join(root, 'foreign-machine'), 'codex', 'pre_tool_use')
    );
  if (kind === 'modified-entry') {
    registration(primary, command);
    write(path.join(home, 'bin/caws-hook'), 'unrecognized entry');
  }
  if (kind === 'missing-entry') {
    registration(primary, command);
    fs.unlinkSync(path.join(home, 'bin/caws-hook'));
  }
  expect(() => resolveInvocationSelection(options)).toThrow(/reconciliation|reconcile/i);
});
test('disabled group does not claim coverage', () => {
  registration(
    path.join(canonical, '.codex/hooks.json'),
    machineCommand(home, 'codex', 'pre_tool_use'),
    'Bash',
    { enabled: false }
  );
  expect(resolveInvocationSelection(options).status).toBe('active');
});
