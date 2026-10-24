'use strict';
// Private filesystem/installer and local-observation controls. Fake native
// assets are never executed; these tests do not qualify a real harness image.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { installMachineRuntime } = require('../../dist/init/machine-adapters');
const {
  configureSystemRuntime,
  migrateSystemProject,
  systemProjectPath,
} = require('../../dist/init/system-runtime');
const { installHookPack } = require('../../dist/init/hook-install');
const { OPENCODE_PACK } = require('../../dist/init/hook-packs/manifest-opencode');
const { SHARED_PACK } = require('../../dist/init/hook-packs/manifest-shared');
const { sha } = require('../../dist/init/machine-runtime-state');
const {
  OPENCODE_NATIVE_PLUGIN_MEMBER,
  renderOpenCodeNativePlugin,
} = require('../../dist/init/opencode-native-plugin');
const { openCodeRegistrationRoots } = require('../../dist/init/opencode-project-registration');
const { resolveInvocationSelection } = require('../../dist/runtime/selection');
const {
  SelectionObservationSnapshot,
  resolveObservedInvocationSelection,
} = require('../../dist/runtime/selection-observation');
const { captureSelectionRead } = require('../../dist/init/selection-read-io');
const { runInitCommand } = require('../../dist/shell/commands/init');
const artifactRoot = process.env.CAWS_TEST_ARTIFACT_DIR;
const template = fs.readFileSync(
  path.resolve(__dirname, '../../templates/hook-packs/opencode/plugin.ts')
);
let root, home, user, repo, options, installed, environment, priorEnvironment;
function write(file, bytes, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    Buffer.isBuffer(bytes) || typeof bytes === 'string' ? bytes : JSON.stringify(bytes)
  );
  fs.chmodSync(file, mode);
}
function tree(dir) {
  const rows = {};
  const visit = (folder) => {
    if (!fs.existsSync(folder)) return;
    for (const name of fs.readdirSync(folder).sort()) {
      if (name === '.git') continue;
      const file = path.join(folder, name),
        stat = fs.lstatSync(file);
      rows[path.relative(dir, file)] = stat.isDirectory()
        ? 'directory'
        : fs.readFileSync(file).toString('base64');
      if (stat.isDirectory()) visit(file);
    }
  };
  visit(dir);
  return rows;
}
function nativeImage() {
  const prefixRoot = path.join(root, 'prefix');
  const input = {
    schema: 'caws.runtime.native-image-input.v1',
    prefixRoot,
    files: {},
    packages: {},
    omissions: {},
    timeoutMs: 1000,
  };
  const cli = 'node_modules/@paths.design/caws-cli';
  function member(relative, bytes) {
    write(path.join(prefixRoot, relative), bytes);
    input.files[relative] = { sha256: sha(Buffer.from(bytes)), mode: 0o644 };
  }
  member(
    'package.json',
    JSON.stringify({ dependencies: { '@paths.design/caws-cli': 'file:reviewed.tgz' } })
  );
  member(
    cli + '/package.json',
    JSON.stringify({ name: '@paths.design/caws-cli', version: '1.0.0', dependencies: {} })
  );
  member(cli + '/LICENSE', 'Synthetic fixture license\n');
  input.packages[cli] = { name: '@paths.design/caws-cli', version: '1.0.0', licenses: ['LICENSE'] };
  for (const file of [
    'dist/index.js',
    'dist/runtime/engine-entry.js',
    'dist/runtime/describe-entry.js',
    'templates/hook-packs/runtime/bootstrap.py',
  ])
    member(cli + '/' + file, 'Synthetic asset; never executed\n');
  member(
    'package-lock.json',
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { dependencies: { '@paths.design/caws-cli': 'file:reviewed.tgz' } },
        [cli]: { name: '@paths.design/caws-cli', version: '1.0.0', dependencies: {} },
      },
    })
  );
  for (const name of ['native', 'node', 'stableEntry']) {
    const source = path.join(root, name),
      bytes = '#!/bin/sh\nexit 73\n';
    write(source, bytes, 0o755);
    input[name] = { source, sha256: sha(bytes) };
    if (name !== 'stableEntry') {
      const notice = path.join(root, name + '.LICENSE');
      write(notice, 'Fixture notice\n');
      input[name].notices = { LICENSE: { source: notice, sha256: sha('Fixture notice\n') } };
    }
  }
  const file = path.join(root, 'native-image.json');
  write(file, input);
  return file;
}
beforeEach(() => {
  if (artifactRoot && !path.isAbsolute(artifactRoot))
    throw new Error('Artifact root must be absolute');
  if (artifactRoot) fs.mkdirSync(artifactRoot, { recursive: true });
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(artifactRoot || os.tmpdir(), 'caws-opencode-registration-'))
  );
  home = path.join(root, 'machine');
  user = path.join(root, 'user');
  repo = path.join(root, 'project');
  fs.mkdirSync(user);
  fs.mkdirSync(path.join(repo, '.caws/specs'), { recursive: true });
  write(path.join(repo, '.caws/policy.yaml'), 'version: 1\n');
  expect(spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repo }).status).toBe(0);
  environment = {
    HOME: user,
    XDG_CONFIG_HOME: path.join(root, 'config'),
    XDG_DATA_HOME: path.join(root, 'data'),
    XDG_STATE_HOME: path.join(root, 'state'),
    XDG_CACHE_HOME: path.join(root, 'cache'),
    PATH: process.env.PATH,
  };
  priorEnvironment = { ...process.env };
  for (const key of Object.keys(process.env))
    if (key.startsWith('OPENCODE_')) delete process.env[key];
  Object.assign(process.env, environment);
  installed = installMachineRuntime({ home, nativeImage: nativeImage() });
  options = {
    home,
    userHome: user,
    repo,
    surface: 'opencode',
    registrationEnvironment: environment,
  };
});
afterEach(() => {
  for (const key of Object.keys(process.env))
    if (!(key in priorEnvironment)) delete process.env[key];
  Object.assign(process.env, priorEnvironment);
  if (artifactRoot)
    write(path.join(root, 'test-observation.json'), {
      test: expect.getState().currentTestName,
      root,
      home,
      user,
      repo,
      environment,
      runtimeDigest: installed?.digest ?? null,
      producerSha256: sha(renderOpenCodeNativePlugin(template, home)),
      scope:
        'Synthetic installer/local-registration observations only; no harness loading, native execution or SQL qualification',
    });
  else fs.rmSync(root, { recursive: true, force: true });
});
function configure() {
  return configureSystemRuntime({ ...options, entry: 'native' });
}
function legacy() {
  installHookPack(SHARED_PACK, { repoRoot: repo });
  installHookPack(OPENCODE_PACK, { repoRoot: repo });
}
function reviewed(policy = { disabled: {}, extensions: {}, handlers: {}, libraries: {} }) {
  const fromFile = path.join(root, 'reviewed-policy.json');
  write(fromFile, policy);
  return { ...options, fromFile };
}
function selection(cwd = repo, env = environment) {
  return {
    home,
    canonical: repo,
    checkout: repo,
    runtimeDigest: installed.digest,
    surface: 'opencode',
    event: 'stop',
    system: true,
    caller: { cwd, environment: env },
  };
}

test('explicit configure previews without writes and opts in only machine settings', () => {
  const before = tree(root);
  expect(() => configureSystemRuntime(options)).toThrow('explicit --entry native');
  const plan = configureSystemRuntime({ ...options, entry: 'native', plan: true });
  expect(plan.changes.map((change) => path.relative(home, change.path))).toEqual([
    'surfaces/opencode/settings.json',
  ]);
  expect(tree(root)).toEqual(before);
  configure();
  expect(JSON.parse(fs.readFileSync(path.join(home, 'surfaces/opencode/settings.json')))).toEqual({
    version: 1,
    enabled: true,
    transport: 'project-native-stop',
  });
  expect(fs.existsSync(path.join(repo, '.opencode/plugins/caws.ts'))).toBe(false);
  expect(configureSystemRuntime(options).changed).toBe(false);
  expect(() => configureSystemRuntime({ ...options, entry: 'legacy' })).toThrow(
    'explicit --entry native'
  );
});
test('configure refuses a legacy image without authoring settings or project files', () => {
  const legacyHome = path.join(root, 'legacy-machine');
  installMachineRuntime({ home: legacyHome });
  const before = tree(root);
  expect(() => configureSystemRuntime({ ...options, home: legacyHome, entry: 'native' })).toThrow(
    'native-image'
  );
  expect(tree(root)).toEqual(before);
});
test('migration preserves reviewed chain/overrides and replaces exactly one stock producer transactionally', () => {
  configure();
  legacy();
  const handler = path.join(repo, 'custom/custom.sh');
  write(handler, '#!/bin/sh\nexit 0\n', 0o755);
  const policy = {
    disabled: { stop: ['plan-transcript-finalize.sh'] },
    extensions: { stop: [{ handler: 'custom.sh precise', before: 'agent-stop.sh' }] },
    handlers: { 'custom.sh': 'custom/custom.sh' },
    libraries: {},
  };
  const chosen = reviewed(policy),
    prior = tree(root);
  const plan = migrateSystemProject({ ...chosen, plan: true });
  expect(plan.changes.map((change) => change.path)).toEqual([
    path.join(repo, '.opencode/plugins/caws.ts'),
    systemProjectPath(home, repo),
  ]);
  expect(tree(root)).toEqual(prior);
  const applied = migrateSystemProject(chosen);
  expect(applied.policy).toEqual(policy);
  const producer = fs.readFileSync(path.join(repo, '.opencode/plugins/caws.ts'));
  expect(producer).toEqual(renderOpenCodeNativePlugin(template, home));
  const record = JSON.parse(fs.readFileSync(systemProjectPath(home, repo)));
  expect(record.surfaces.opencode).toEqual(policy);
  expect(fs.existsSync(path.join(repo, '.caws/hooks/dispatch/pre_tool_use.sh'))).toBe(true);
  expect(migrateSystemProject(options).changed).toBe(false);
  const selected = resolveInvocationSelection(selection());
  expect(selected.status).toBe('active');
  expect(selected.handlers.map((entry) => entry.entry)).toEqual([
    'goal-ac-gate.sh',
    'session-log.sh',
    'custom.sh precise',
    'agent-stop.sh',
  ]);
  const backups = fs
    .readdirSync(path.join(home, 'state/adoption-backups'))
    .map((name) => JSON.parse(fs.readFileSync(path.join(home, 'state/adoption-backups', name))));
  const backup = backups.find((value) =>
    value.changes.some((change) => change.path === path.join(repo, '.opencode/plugins/caws.ts'))
  );
  expect(
    backup.changes.find((change) => change.path === path.join(repo, '.opencode/plugins/caws.ts'))
      .before
  ).toBe(Buffer.from(prior['project/.opencode/plugins/caws.ts'], 'base64').toString('utf8'));
});
test('missing reviewed policy and custom plugin edits refuse without mutation', () => {
  configure();
  legacy();
  let prior = tree(root);
  expect(() => migrateSystemProject(options)).toThrow('reviewed --from');
  expect(tree(root)).toEqual(prior);
  fs.appendFileSync(path.join(repo, '.opencode/plugins/caws.ts'), '\n// custom hook behavior\n');
  const chosen = reviewed();
  prior = tree(root);
  expect(() => migrateSystemProject(chosen)).toThrow('Custom OpenCode plugin');
  expect(tree(root)).toEqual(prior);
});
test('migration rollback preserves the exact original plugin when the project-policy write fails', () => {
  configure();
  legacy();
  const chosen = reviewed();
  const plugin = path.join(repo, '.opencode/plugins/caws.ts');
  const bytes = fs.readFileSync(plugin),
    original = fs.renameSync;
  const spy = jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (to === systemProjectPath(home, repo))
      throw new Error('injected project policy publication failure');
    return original(from, to);
  });
  try {
    expect(() => migrateSystemProject(chosen)).toThrow('injected project policy');
  } finally {
    spy.mockRestore();
  }
  expect(fs.readFileSync(plugin)).toEqual(bytes);
  expect(fs.existsSync(systemProjectPath(home, repo))).toBe(false);
  expect(fs.existsSync(path.join(home, 'state/system-configuration.lock'))).toBe(false);
});
test('duplicate and redirected local producers refuse migration before any publication', () => {
  configure();
  legacy();
  const chosen = reviewed();
  const duplicate = path.join(user, '.opencode/plugins/another.ts');
  write(duplicate, 'export default () => ({})');
  let prior = tree(root);
  expect(() => migrateSystemProject(chosen)).toThrow('exactly one understood');
  expect(tree(root)).toEqual(prior);
  fs.unlinkSync(duplicate);
  const plugin = path.join(repo, '.opencode/plugins/caws.ts');
  const target = path.join(root, 'redirected-plugin.ts');
  fs.renameSync(plugin, target);
  fs.symlinkSync(target, plugin);
  expect(() => migrateSystemProject(chosen)).toThrow('Refusing symlink');
  expect(fs.readFileSync(target)).toEqual(fs.readFileSync(plugin));
  expect(fs.existsSync(systemProjectPath(home, repo))).toBe(false);
});
test('local discovery refuses effective user, singular, nested and explicit-config-dir additions', () => {
  configure();
  legacy();
  migrateSystemProject(reviewed());
  const nested = path.join(repo, 'nested');
  fs.mkdirSync(nested);
  const candidates = [
    path.join(user, '.opencode/plugin/second.js'),
    path.join(environment.XDG_CONFIG_HOME, 'opencode/plugins/second.ts'),
    path.join(repo, '.opencode/plugin/second.js'),
    path.join(nested, '.opencode/plugins/second.ts'),
    path.join(root, 'extra/plugins/second.js'),
  ];
  for (const file of candidates) {
    write(file, 'export default () => ({})');
    const env = file.includes('/extra/')
      ? { ...environment, OPENCODE_CONFIG_DIR: path.join(root, 'extra') }
      : environment;
    expect(() => resolveInvocationSelection(selection(nested, env))).toThrow(
      'exactly one understood'
    );
    fs.unlinkSync(file);
  }
  expect(resolveInvocationSelection(selection(nested)).status).toBe('active');
});
test('nested config imports, substitutions, JSONC transforms and opaque environment routes refuse', () => {
  configure();
  legacy();
  migrateSystemProject(reviewed());
  const nested = path.join(repo, 'nested');
  fs.mkdirSync(nested);
  const file = path.join(nested, 'opencode.json');
  for (const bytes of [
    '{"plugin":["file:///other.ts"]}',
    '{"plugins":[]}',
    '{"model":"{env:MODEL}"}',
    '{/* comment */}',
  ]) {
    write(file, bytes);
    expect(() => resolveInvocationSelection(selection(nested))).toThrow(
      /reconciliation|literal JSON/
    );
  }
  fs.unlinkSync(file);
  for (const name of [
    'OPENCODE_CONFIG_CONTENT',
    'OPENCODE_CONFIG',
    'OPENCODE_AUTH_CONTENT',
    'OPENCODE_PURE',
    'OPENCODE_DISABLE_PROJECT_CONFIG',
  ])
    expect(() =>
      resolveInvocationSelection(selection(nested, { ...environment, [name]: '1' }))
    ).toThrow(name);
});
test('selection requires original caller, explicit project policy, selected producer and stable entry', () => {
  configure();
  legacy();
  migrateSystemProject(reviewed());
  const selected = selection();
  delete selected.caller;
  expect(() => resolveInvocationSelection(selected)).toThrow('original native caller');
  const project = systemProjectPath(home, repo),
    policy = fs.readFileSync(project);
  write(project, { version: 1, root: repo, surfaces: {} });
  expect(() => resolveInvocationSelection(selection())).toThrow('explicit policy migration');
  write(project, policy);
  const plugin = path.join(repo, '.opencode/plugins/caws.ts'),
    bytes = fs.readFileSync(plugin);
  fs.appendFileSync(plugin, '// changed');
  expect(() => resolveInvocationSelection(selection())).toThrow('differs from selected generation');
  write(plugin, bytes);
  fs.chmodSync(path.join(home, 'bin/caws-hook-native'), 0o644);
  expect(() => resolveInvocationSelection(selection())).toThrow('stable entry differs');
});
test('all local registration evidence is captured before observed selection seals', async () => {
  configure();
  legacy();
  migrateSystemProject(reviewed());
  const nested = path.join(repo, 'nested');
  fs.mkdirSync(nested);
  const snapshot = new SelectionObservationSnapshot('opencode-local-registration', {
    maximumObservations: 16384,
    maximumBytes: 64 * 1024 * 1024,
    maximumPathBytes: 8192,
  });
  const result = await resolveObservedInvocationSelection(selection(nested), {
    snapshot,
    maximumRequests: 16384,
    capture: async (request) => ({
      ...request,
      observationId: 'local-' + request.sequence,
      result: captureSelectionRead(request.operation),
    }),
  });
  expect(result.selection.status).toBe('active');
  const operations = snapshot.observations.map((row) => row.operation);
  expect(operations).toContainEqual({
    kind: 'runtime-file',
    path: path.join(repo, '.opencode/plugins/caws.ts'),
    singleLink: false,
  });
  expect(operations).toContainEqual({ kind: 'exists', path: path.join(nested, 'opencode.json') });
  expect(operations).toContainEqual({ kind: 'exists', path: path.join(user, '.opencode/plugins') });
  expect(() => snapshot.record({})).toThrow('snapshot is sealed');
  if (artifactRoot)
    write(path.join(root, 'local-readset.json'), {
      operations,
      producer: OPENCODE_NATIVE_PLUGIN_MEMBER,
      status: 'local observation only',
    });
});
test('ordinary init preview is read-only and apply retains compatibility guards with exact selected producer', () => {
  configure();
  fs.rmSync(path.join(repo, '.caws'), { recursive: true, force: true });
  const prior = tree(root),
    out = [],
    err = [];
  expect(
    runInitCommand({
      cwd: repo,
      home,
      agentSurface: 'opencode',
      plan: true,
      json: true,
      out: (line) => out.push(line),
      err: (line) => err.push(line),
    })
  ).toBe(0);
  expect(tree(root)).toEqual(prior);
  const plan = JSON.parse(out.join('\n'));
  expect(plan.opencode_project_transport).toEqual([
    path.join(repo, '.opencode/plugins/caws.ts'),
    systemProjectPath(home, repo),
  ]);
  expect(
    plan.hook_pack.actions.some(
      (action) => action.destPath === '.caws/hooks/dispatch/pre_tool_use.sh'
    )
  ).toBe(true);
  out.length = 0;
  expect(
    runInitCommand({
      cwd: repo,
      home,
      agentSurface: 'opencode',
      out: (line) => out.push(line),
      err: (line) => err.push(line),
    })
  ).toBe(0);
  expect(err).toEqual([]);
  expect(fs.readFileSync(path.join(repo, '.opencode/plugins/caws.ts'))).toEqual(
    renderOpenCodeNativePlugin(template, home)
  );
  expect(fs.existsSync(path.join(repo, '.caws/hooks/dispatch/pre_tool_use.sh'))).toBe(true);
  expect(resolveInvocationSelection(selection()).handlers.map((entry) => entry.entry)).toEqual([
    'goal-ac-gate.sh',
    'plan-transcript-finalize.sh',
    'session-log.sh',
    'agent-stop.sh',
  ]);
});
test('original root precedence uses XDG plus HOME and adds explicit directory; no ambient root substitution', () => {
  const nested = path.join(repo, 'nested');
  fs.mkdirSync(nested);
  const roots = openCodeRegistrationRoots({
    checkout: repo,
    caller: {
      cwd: nested,
      environment: { ...environment, OPENCODE_CONFIG_DIR: path.join(root, 'extra') },
    },
  });
  expect(roots.directories).toEqual([
    path.join(environment.XDG_CONFIG_HOME, 'opencode'),
    path.join(nested, '.opencode'),
    path.join(repo, '.opencode'),
    path.join(user, '.opencode'),
    path.join(root, 'extra'),
  ]);
  expect(() =>
    openCodeRegistrationRoots({ checkout: repo, caller: { cwd: nested, environment: {} } })
  ).toThrow('original HOME');
});
test('ZCode system Stop remains refused rather than borrowing the OpenCode adapter', () => {
  expect(() => configureSystemRuntime({ ...options, surface: 'zcode', entry: 'native' })).toThrow(
    'requires an adapter'
  );
  expect(() => resolveInvocationSelection({ ...selection(), surface: 'zcode' })).toThrow(
    'qualified JSON harness'
  );
});

test.each([true, false])(
  'other-surface policy cannot bypass reviewed OpenCode migration in plan=%s',
  (plan) => {
    configure();
    legacy();
    write(systemProjectPath(home, repo), {
      version: 1,
      root: repo,
      surfaces: { codex: { disabled: {}, extensions: {}, handlers: {}, libraries: {} } },
    });
    const before = tree(root),
      out = [],
      err = [];
    const status = runInitCommand({
      cwd: repo,
      home,
      agentSurface: 'opencode',
      plan,
      out: (line) => out.push(line),
      err: (line) => err.push(line),
    });
    const after = tree(root);
    if (artifactRoot)
      write(path.join(root, 'other-surface-init-refusal.json'), {
        plan,
        status,
        out,
        err,
        unchanged: JSON.stringify(after) === JSON.stringify(before),
      });
    expect(status).toBe(1);
    expect(err.join('\n')).toContain(
      'Legacy OpenCode hooks require reviewed adapters migrate --from policy'
    );
    expect(after).toEqual(before);
  }
);

test('existing reviewed OpenCode policy permits repeated init without inferring another surface policy', () => {
  configure();
  legacy();
  migrateSystemProject(reviewed());
  const plugin = fs.readFileSync(path.join(repo, '.opencode/plugins/caws.ts'));
  const policy = fs.readFileSync(systemProjectPath(home, repo));
  const err = [];
  expect(
    runInitCommand({
      cwd: repo,
      home,
      agentSurface: 'opencode',
      out: () => {},
      err: (line) => err.push(line),
    })
  ).toBe(0);
  expect(err).toEqual([]);
  expect(fs.readFileSync(path.join(repo, '.opencode/plugins/caws.ts'))).toEqual(plugin);
  expect(fs.readFileSync(systemProjectPath(home, repo))).toEqual(policy);
});
