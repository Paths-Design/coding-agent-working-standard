'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { installMachineRuntime } = require('../../dist/init/machine-adapters');
const {
  configureSystemRuntime,
  migrateSystemProject,
  systemProjectPath,
} = require('../../dist/init/system-runtime');
const {
  isCawsNativeCommand,
  adoptMachineAdapter,
} = require('../../dist/init/machine-adapter-policy');
let root, repo, home, user, options;
const templates = path.resolve(__dirname, '../../templates/hook-packs');
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-system-registration-'));
  repo = path.join(root, 'repo');
  home = path.join(root, 'machine');
  user = path.join(root, 'user');
  fs.mkdirSync(path.join(repo, '.caws/specs'), { recursive: true });
  fs.mkdirSync(path.join(repo, '.codex'), { recursive: true });
  fs.mkdirSync(user);
  fs.writeFileSync(path.join(repo, '.caws/policy.yaml'), 'version: 1\n');
  fs.cpSync(path.join(templates, 'shared'), path.join(repo, '.caws/hooks'), { recursive: true });
  for (const name of fs.readdirSync(path.join(repo, '.caws/hooks')))
    if (name.endsWith('.sh')) fs.chmodSync(path.join(repo, '.caws/hooks', name), 0o755);
  expect(spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repo }).status).toBe(0);
  fs.writeFileSync(
    path.join(repo, '.codex/hooks.json'),
    JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [
              { type: 'command', command: `"${repo}/.caws/hooks/dispatch/pre_tool_use.sh"` },
              { type: 'command', command: `"${repo}/.codex/hooks/custom-lint.sh"` },
            ],
          },
        ],
      },
    })
  );
  installMachineRuntime({ home });
  options = { repo, home, userHome: user, surface: 'codex' };
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const blank = () => ({ disabled: {}, extensions: {}, handlers: {}, libraries: {} });

test('an explicitly enabled optional stock hook survives migration as an inherited-code extension', () => {
  const native = path.join(repo, '.codex/hooks.json');
  const config = JSON.parse(fs.readFileSync(native));
  config.hooks.PostToolUse = [{ hooks: [{ command: `"${repo}/.caws/hooks/dispatch/post_tool_use.sh"` }] }];
  fs.writeFileSync(native, JSON.stringify(config));
  const dispatch = path.join(repo, '.caws/hooks/dispatch/post_tool_use.sh');
  fs.writeFileSync(dispatch, fs.readFileSync(dispatch, 'utf8').replace('# "quality-check.sh"', '"quality-check.sh"'));
  const result = migrateSystemProject({ ...options, plan: true });
  expect(result.policy.extensions.post_tool_use).toContainEqual({ handler: 'quality-check.sh', before: 'naming-check.sh' });
  expect(result.policy.handlers['quality-check.sh']).toBeUndefined();
});
test('unrelated native hook scripts are not classified as CAWS transports', () => {
  expect(isCawsNativeCommand('/home/u/.claude/hooks/stop-kokoro-voicemail.sh')).toBe(false);
  expect(isCawsNativeCommand('/home/u/.claude/hooks/instructions-loaded-logger.sh')).toBe(false);
  expect(isCawsNativeCommand('/home/u/.codex/hooks/custom-lint.sh')).toBe(false);
  expect(isCawsNativeCommand(`'${repo}/.codex/hooks/caws_dispatch/pre_tool_use.sh'`)).toBe(true);
  expect(isCawsNativeCommand('python3 /home/u/.caws/bin/caws-hook codex stop')).toBe(true);
});
test('system configure preserves unrelated user settings and hooks, is read-only in plan and idempotent on repeat', () => {
  const file = path.join(user, '.codex/hooks.json');
  fs.mkdirSync(path.dirname(file));
  const original = {
    theme: 'local',
    hooks: {
      Stop: [
        { hooks: [{ type: 'command', command: '/home/u/.codex/hooks/voicemail.sh', timeout: 8 }] },
      ],
    },
  };
  fs.writeFileSync(file, JSON.stringify(original));
  const prior = fs.readFileSync(file, 'utf8');
  const plan = configureSystemRuntime({ ...options, plan: true });
  expect(plan.changed).toBe(true);
  expect(fs.readFileSync(file, 'utf8')).toBe(prior);
  expect(fs.existsSync(path.join(home, 'surfaces/codex/settings.json'))).toBe(false);
  configureSystemRuntime(options);
  const after = JSON.parse(fs.readFileSync(file));
  expect(after.theme).toBe('local');
  expect(after.hooks.Stop[0]).toEqual(original.hooks.Stop[0]);
  expect(after.hooks.PreToolUse[0].matcher).toBe('.*');
  expect(after.hooks.PreToolUse[0].hooks[0].command).toContain('/bin/caws-hook');
  expect(configureSystemRuntime({ ...options, plan: true }).changed).toBe(false);
});
test('an unrelated user hook does not block project adapter adoption', () => {
  const file = path.join(user, '.codex/hooks.json');
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(
    file,
    JSON.stringify({
      hooks: { Stop: [{ hooks: [{ command: '/u/.codex/hooks/user-notification.sh' }] }] },
    })
  );
  const plan = adoptMachineAdapter({ ...options, plan: true });
  expect(plan.changed).toBe(true);
  expect(plan.policy.surfaces.codex.events.pre_tool_use.handlers).toContain('scope-guard.sh');
});
test('one-time migration preserves executable bytes and unrelated hooks, writes machine settings and stops freezing stock handler lists', () => {
  configureSystemRuntime(options);
  const hook = path.join(repo, '.caws/hooks/scope-guard.sh');
  const before = fs.readFileSync(hook, 'utf8');
  const native = path.join(repo, '.codex/hooks.json');
  const nativeBefore = fs.readFileSync(native, 'utf8');
  const plan = migrateSystemProject({ ...options, plan: true });
  expect(plan.policy).toEqual(blank());
  expect(fs.readFileSync(native, 'utf8')).toBe(nativeBefore);
  expect(fs.existsSync(systemProjectPath(home, repo))).toBe(false);
  const applied = migrateSystemProject(options);
  expect(applied.changed).toBe(true);
  expect(JSON.parse(fs.readFileSync(native)).hooks.PreToolUse[0].hooks).toEqual([
    { type: 'command', command: `"${repo}/.codex/hooks/custom-lint.sh"` },
  ]);
  expect(fs.readFileSync(hook, 'utf8')).toBe(before);
  expect(JSON.parse(fs.readFileSync(systemProjectPath(home, repo))).surfaces.codex).toEqual(
    blank()
  );
  expect(migrateSystemProject(options).changed).toBe(false);
  const backups = fs
    .readdirSync(path.join(home, 'state/adoption-backups'))
    .map((n) => JSON.parse(fs.readFileSync(path.join(home, 'state/adoption-backups', n))));
  expect(
    backups.some((b) =>
      b.changes.some((c) => c.path === fs.realpathSync(native) && c.before === nativeBefore)
    )
  ).toBe(true);
});
test('custom renderer growth is refused before any mutation and explicit reviewed policy can reconcile it', () => {
  configureSystemRuntime(options);
  fs.appendFileSync(
    path.join(repo, '.caws/hooks/session_log_renderer.py'),
    '\n# locally maintained renderer\n'
  );
  const before = fs.readFileSync(path.join(repo, '.codex/hooks.json'), 'utf8');
  expect(() => migrateSystemProject(options)).toThrow(
    /Custom helper requires explicit reconciliation/
  );
  expect(fs.readFileSync(path.join(repo, '.codex/hooks.json'), 'utf8')).toBe(before);
  expect(fs.existsSync(systemProjectPath(home, repo))).toBe(false);
  const reviewed = path.join(root, 'reviewed.json');
  fs.writeFileSync(reviewed, JSON.stringify(blank()));
  expect(migrateSystemProject({ ...options, fromFile: reviewed }).changed).toBe(true);
});
test('malformed and symlinked machine project settings are refused before native hooks change', () => {
  configureSystemRuntime(options);
  const file = systemProjectPath(home, repo);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{');
  const prior = fs.readFileSync(path.join(repo, '.codex/hooks.json'), 'utf8');
  expect(() => migrateSystemProject(options)).toThrow();
  expect(fs.readFileSync(path.join(repo, '.codex/hooks.json'), 'utf8')).toBe(prior);
  fs.unlinkSync(file);
  fs.symlinkSync(path.join(repo, '.caws/policy.yaml'), file);
  expect(() => migrateSystemProject(options)).toThrow(/symlink/);
  expect(fs.readFileSync(path.join(repo, '.codex/hooks.json'), 'utf8')).toBe(prior);
});
test('migration cannot remove project guards before system registration exists', () => {
  const prior = fs.readFileSync(path.join(repo, '.codex/hooks.json'), 'utf8');
  expect(() => migrateSystemProject(options)).toThrow(/Configure system registration first/);
  expect(fs.readFileSync(path.join(repo, '.codex/hooks.json'), 'utf8')).toBe(prior);
});

test('new project init inherits user registration without recreating project hook code or native wiring', () => {
  configureSystemRuntime(options);
  const fresh = path.join(root, 'fresh');
  fs.mkdirSync(fresh);
  expect(spawnSync('git', ['init', '-q'], { cwd: fresh }).status).toBe(0);
  const result = spawnSync(
    process.execPath,
    [path.resolve(__dirname, '../../dist/index.js'), 'init', '--agent-surface', 'codex'],
    {
      cwd: fresh,
      encoding: 'utf8',
      env: { ...process.env, HOME: user, CAWS_HOME: home },
    }
  );
  expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
  expect(result.stdout).toContain('System runtime configured');
  expect(fs.existsSync(path.join(fresh, '.caws/policy.yaml'))).toBe(true);
  expect(fs.existsSync(path.join(fresh, '.caws/hooks'))).toBe(false);
  expect(fs.existsSync(path.join(fresh, '.codex/hooks.json'))).toBe(false);
});

test('concurrent configuration is refused and a failed migration rolls back its first write from exact backups', () => {
  configureSystemRuntime(options);
  const lock = path.join(home, 'state/system-configuration.lock');
  fs.mkdirSync(lock);
  const native = fs.realpathSync(path.join(repo, '.codex/hooks.json'));
  const prior = fs.readFileSync(native, 'utf8');
  expect(() => migrateSystemProject(options)).toThrow(/configuration is locked/);
  expect(fs.readFileSync(native, 'utf8')).toBe(prior);
  fs.rmdirSync(lock);
  const rename = fs.renameSync;
  const injection = jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (to === native) throw new Error('injected native write failure');
    return rename(from, to);
  });
  try {
    expect(() => migrateSystemProject(options)).toThrow(/injected native write failure/);
  } finally {
    injection.mockRestore();
  }
  expect(fs.readFileSync(native, 'utf8')).toBe(prior);
  expect(fs.existsSync(systemProjectPath(home, repo))).toBe(false);
  expect(fs.existsSync(lock)).toBe(false);
});

test('doctor observes the effective machine runtime and identifies corruption without writing state', () => {
  const { observeSystemRuntime } = require('../../dist/store/system-runtime-observation');
  configureSystemRuntime(options);
  migrateSystemProject(options);
  const previous = process.env.CAWS_HOME;
  process.env.CAWS_HOME = home;
  const homedir = jest.spyOn(os, 'homedir').mockReturnValue(user);
  try {
    const observed = observeSystemRuntime(repo);
    expect(observed.error).toBeUndefined();
    expect(observed.surfaces).toEqual(['codex']);
    expect(observed.legacySurfaces).toEqual([]);
    fs.appendFileSync(
      path.join(home, 'lib/runtimes', observed.digest, 'scope-guard.sh'),
      '\n# corruption\n'
    );
    expect(observeSystemRuntime(repo).error).toContain('scope-guard.sh');
  } finally {
    homedir.mockRestore();
    if (previous === undefined) delete process.env.CAWS_HOME;
    else process.env.CAWS_HOME = previous;
  }
});
