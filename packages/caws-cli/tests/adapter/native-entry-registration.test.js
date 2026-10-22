const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const dist = process.env.CAWS_TEST_DIST || path.join(__dirname, '../../dist');
const { configureSystemRuntime } = require(path.join(dist, 'init/system-runtime'));
const { machineCommand, systemCommand, isCawsNativeCommand, MACHINE_EVENTS } = require(
  path.join(dist, 'init/native-hook-identification')
);
const { migrateNativeCommand } = require(path.join(dist, 'init/machine-adapter-policy'));
const { resolveInvocationSelection } = require(path.join(dist, 'runtime/selection'));
const sha = (s) => createHash('sha256').update(s).digest('hex');
let root, home, user, canonical, checkout, options;
function write(file, value, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  fs.chmodSync(file, mode);
}
function registration(file, command, matcher = '.*', extra = {}) {
  write(file, {
    hooks: { PreToolUse: [{ matcher, hooks: [{ type: 'command', command }], ...extra }] },
  });
}
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'caws-native-registration-')));
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
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
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
