const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const dist = process.env.CAWS_TEST_DIST || path.join(__dirname, '../../dist');
const { configureSystemRuntime } = require(path.join(dist, 'init/system-runtime'));
const {
  machineCommand,
  systemCommand,
  isCawsNativeCommand,
  qualifiedHookTimeout,
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
test.each([undefined, NaN, Infinity, -Infinity, 45, 44999])(
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
