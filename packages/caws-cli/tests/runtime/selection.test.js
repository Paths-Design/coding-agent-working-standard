const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveInvocationSelection } = require('../../dist/runtime/selection');
const { sha } = require('../../dist/init/machine-runtime-state');
const { MACHINE_EVENTS, machineCommand } = require('../../dist/init/native-hook-identification');

let root;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'caws-selection-')));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});
const empty = () => ({ disabled: {}, extensions: {}, handlers: {}, libraries: {} });
function write(file, content, executable = false) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  if (executable) fs.chmodSync(file, 0o755);
}
function fixture() {
  const home = path.join(root, 'home');
  const canonical = path.join(root, 'project');
  const checkout = path.join(root, 'linked-checkout');
  fs.mkdirSync(canonical, { recursive: true });
  fs.mkdirSync(checkout);
  const files = {
    'launcher.py': '# fixture source-generation launcher\n',
    'bootstrap.py': '# fixture retained bootstrap\n',
    'first.sh': '#!/bin/sh\nexit 0\n',
    'last.sh': '#!/bin/sh\nexit 0\n',
    'lib/helper.sh': 'shared helper\n',
    'lib/shared.sh': 'shared only\n',
    'surfaces/codex/lib/helper.sh': 'surface helper\n',
    'surfaces/codex/lib/session-transcript.py': '# surface transcript\n',
    'system-policy.json': JSON.stringify({
      version: 1,
      events: Object.fromEntries(
        Object.keys(MACHINE_EVENTS).map((event) => [event, ['first.sh', 'last.sh']])
      ),
    }),
  };
  const manifest = JSON.stringify(
    Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, sha(bytes)]))
  );
  const runtimeDigest = sha(manifest);
  const runtime = path.join(home, 'lib/runtimes', runtimeDigest);
  for (const [name, bytes] of Object.entries(files))
    write(path.join(runtime, name), bytes, name.endsWith('.sh'));
  write(path.join(runtime, 'manifest.json'), manifest);
  write(path.join(home, 'bin/caws-hook'), files['bootstrap.py'], true);
  write(path.join(canonical, '.caws/policy.yaml'), 'version: 1\n');
  fs.mkdirSync(path.join(canonical, '.caws/specs'));
  write(path.join(home, 'surfaces/codex/settings.json'), { version: 1, enabled: true });
  const projectFile = path.join(home, 'state/projects', sha(canonical) + '.json');
  const options = {
    home,
    canonical,
    checkout,
    runtimeDigest,
    surface: 'codex',
    event: 'pre_tool_use',
    system: true,
  };
  const configure = (policy = empty()) =>
    write(projectFile, { version: 1, root: canonical, surfaces: { codex: policy } });
  configure();
  return {
    options,
    runtime,
    projectFile,
    configure,
    repo: (surfaces, guards) =>
      write(path.join(canonical, '.caws/hooks/hook-policy.json'), {
        version: 1,
        surfaces,
        ...(guards ? { guards } : {}),
      }),
    custom: (name, text = name) => {
      const relative = 'custom/' + name;
      write(path.join(canonical, relative), text, true);
      return relative;
    },
  };
}

test('selects verified stock bytes using canonical policy while retaining actual checkout', () => {
  const f = fixture();
  const selected = resolveInvocationSelection(f.options);
  expect(selected.status).toBe('active');
  expect(selected.checkout).toBe(f.options.checkout);
  expect(selected.canonical).toBe(f.options.canonical);
  expect(selected.runtimeDirectory).toBe(f.runtime);
  expect(selected.hooksDirectory).toBe(f.runtime);
  expect(selected.handlers).toEqual(
    ['first.sh', 'last.sh'].map((name) => ({
      entry: name,
      name,
      args: [],
      path: path.join(f.runtime, name),
      sha256: sha('#!/bin/sh\nexit 0\n'),
      tier: 'stock',
      kind: 'stock',
    }))
  );
  expect(selected.libraries['helper.sh']).toEqual({
    path: path.join(f.runtime, 'surfaces/codex/lib/helper.sh'),
    sha256: sha('surface helper\n'),
    kind: 'surface',
  });
  expect(selected.libraries['shared.sh'].kind).toBe('shared');
  expect(selected.transcriptAdapter.path).toBe(
    path.join(f.runtime, 'surfaces/codex/lib/session-transcript.py')
  );
  expect(Object.isFrozen(selected)).toBe(true);
  expect(Object.isFrozen(selected.handlers)).toBe(true);
  expect(Object.isFrozen(selected.handlers[0].args)).toBe(true);
  expect(Object.isFrozen(selected.libraries['helper.sh'])).toBe(true);
});

test('resolves repo then machine extensions including machine anchors into repo additions', () => {
  const f = fixture();
  const repoHandler = f.custom('repo.sh');
  const machineHandler = f.custom('machine.sh');
  f.repo({
    default: {
      extensions: {
        pre_tool_use: [
          { handler: 'repo.sh --quiet', before: 'last.sh', reason: 'Observe project behavior' },
        ],
      },
      handlers: { 'repo.sh': repoHandler },
    },
  });
  f.configure({
    ...empty(),
    extensions: { pre_tool_use: [{ handler: 'machine.sh', before: 'repo.sh' }] },
    handlers: { 'machine.sh': machineHandler },
  });
  const selected = resolveInvocationSelection(f.options);
  expect(selected.handlers.map((h) => [h.entry, h.tier])).toEqual([
    ['first.sh', 'stock'],
    ['machine.sh', 'machine-policy'],
    ['repo.sh --quiet', 'repo-policy'],
    ['last.sh', 'stock'],
  ]);
  expect(selected.handlers[2].args).toEqual(['--quiet']);
  expect(selected.handlers[2].path).toBe(path.join(f.options.canonical, repoHandler));
});

test('machine handler/library overrides win, and per-call reads observe changed source and policy', () => {
  const f = fixture();
  const repo = f.custom('repo-first.sh', 'repo guard');
  const machine = f.custom('machine-first.sh', 'machine guard');
  const lib = f.custom('helper.sh', 'project helper');
  f.repo({ codex: { handlers: { 'first.sh': repo }, libraries: { 'helper.sh': lib } } });
  f.configure({ ...empty(), handlers: { 'first.sh': machine } });
  const before = resolveInvocationSelection(f.options);
  expect(before.handlers[0]).toMatchObject({
    path: path.join(f.options.canonical, machine),
    tier: 'machine-policy',
    sha256: sha('machine guard'),
  });
  expect(before.libraries['helper.sh']).toEqual({
    path: path.join(f.options.canonical, lib),
    sha256: sha('project helper'),
    kind: 'project',
  });
  write(path.join(f.options.canonical, machine), 'changed machine guard', true);
  f.configure({
    ...empty(),
    disabled: { pre_tool_use: ['last.sh'] },
    handlers: { 'first.sh': machine },
  });
  const after = resolveInvocationSelection(f.options);
  expect(after.handlers.map((h) => h.name)).toEqual(['first.sh']);
  expect(after.handlers[0].sha256).toBe(sha('changed machine guard'));
  expect(before.handlers[0].sha256).toBe(sha('machine guard'));
});

test('library and transcript fallback honors user then surface without selecting shared transcript', () => {
  const f = fixture();
  const user = path.join(f.options.home, 'surfaces/codex/lib');
  write(path.join(user, 'helper.sh'), 'user helper');
  write(path.join(user, 'session-transcript.py'), '# user transcript');
  const selected = resolveInvocationSelection(f.options);
  expect(selected.libraries['helper.sh']).toEqual({
    path: path.join(user, 'helper.sh'),
    kind: 'user',
    sha256: sha('user helper'),
  });
  expect(selected.transcriptAdapter).toEqual({
    path: path.join(user, 'session-transcript.py'),
    sha256: sha('# user transcript'),
  });
  const transcript = f.custom('project-transcript.py', '# project transcript');
  f.configure({ ...empty(), libraries: { 'session-transcript.py': transcript } });
  expect(resolveInvocationSelection(f.options).transcriptAdapter.path).toBe(
    path.join(f.options.canonical, transcript)
  );
});

test.each(['handler', 'manifest'])(
  'rejects runtime %s tampering before inactive adoption can hide it',
  (target) => {
    const f = fixture();
    write(path.join(f.runtime, target === 'handler' ? 'first.sh' : 'manifest.json'), 'tampered');
    fs.rmSync(path.join(f.options.canonical, '.caws'), { recursive: true });
    expect(() => resolveInvocationSelection(f.options)).toThrow(/integrity|modified/);
  }
);

test('rejects missing executable overrides and symlinked policy/library reads', () => {
  const f = fixture();
  const custom = f.custom('custom.sh');
  fs.chmodSync(path.join(f.options.canonical, custom), 0o644);
  f.configure({ ...empty(), handlers: { 'first.sh': custom } });
  expect(() => resolveInvocationSelection(f.options)).toThrow();
  f.configure();
  const outside = path.join(root, 'outside-policy.json');
  write(outside, { version: 1, surfaces: {} });
  const repoPolicy = path.join(f.options.canonical, '.caws/hooks/hook-policy.json');
  fs.mkdirSync(path.dirname(repoPolicy), { recursive: true });
  fs.symlinkSync(outside, repoPolicy);
  expect(() => resolveInvocationSelection(f.options)).toThrow(/symlink/);
  fs.unlinkSync(repoPolicy);
  const user = path.join(f.options.home, 'surfaces/codex/lib/helper.sh');
  fs.mkdirSync(path.dirname(user), { recursive: true });
  fs.symlinkSync(outside, user);
  expect(() => resolveInvocationSelection(f.options)).toThrow(/symlink/);
});

test('rejects duplicate extensions and missing anchors through the authority resolver', () => {
  const f = fixture();
  f.configure({
    ...empty(),
    extensions: { pre_tool_use: [{ handler: 'first.sh', before: null }] },
  });
  expect(() => resolveInvocationSelection(f.options)).toThrow(/already in the chain/);
  const custom = f.custom('custom.sh');
  f.configure({
    ...empty(),
    extensions: { pre_tool_use: [{ handler: 'custom.sh', before: 'missing.sh' }] },
    handlers: { 'custom.sh': custom },
  });
  expect(() => resolveInvocationSelection(f.options)).toThrow(/anchor is absent/);
});

test('shared repo parser rejects invalid guards instead of duplicating the weaker Python container check', () => {
  const f = fixture();
  f.repo({}, { 'unknown-guard.sh': {} });
  expect(() => resolveInvocationSelection(f.options)).toThrow(/guard/);
});

test('unknown projects without governance are inactive; adopted governance disappearance refuses', () => {
  const f = fixture();
  fs.rmSync(path.join(f.options.canonical, '.caws'), { recursive: true });
  expect(() => resolveInvocationSelection(f.options)).toThrow(
    'Adopted project governance is missing'
  );
  fs.unlinkSync(f.projectFile);
  expect(resolveInvocationSelection(f.options)).toEqual({
    status: 'inactive',
    reason: 'project governance is absent',
  });
});

test('legacy governance and disabled system surfaces do not silently adopt projects', () => {
  const f = fixture();
  fs.unlinkSync(f.projectFile);
  write(path.join(f.options.canonical, '.caws/working-spec.yaml'), 'legacy');
  expect(resolveInvocationSelection(f.options)).toEqual({
    status: 'inactive',
    reason: 'project governance requires migration',
  });
  fs.unlinkSync(path.join(f.options.canonical, '.caws/working-spec.yaml'));
  write(path.join(f.options.home, 'surfaces/codex/settings.json'), { version: 1, enabled: false });
  expect(resolveInvocationSelection(f.options)).toEqual({
    status: 'inactive',
    reason: 'system surface is disabled or project policy remains selected',
  });
});

test('legacy native duplicate avoidance is event-specific and respects disabled registrations', () => {
  const f = fixture();
  const native = path.join(f.options.canonical, '.codex/hooks.json');
  const hook = {
    type: 'command',
    command: machineCommand(f.options.home, 'codex', 'pre_tool_use'),
  };
  write(native, { hooks: { PreToolUse: [{ matcher: '.*', hooks: [hook] }] } });
  expect(resolveInvocationSelection(f.options)).toEqual({
    status: 'inactive',
    reason: 'legacy native registration remains selected',
  });
  expect(resolveInvocationSelection({ ...f.options, event: 'post_tool_use' }).status).toBe(
    'active'
  );
  write(native, {
    hooks: {
      PreToolUse: [{ enabled: false, hooks: [hook] }, { hooks: [{ ...hook, enabled: false }] }],
    },
  });
  expect(resolveInvocationSelection(f.options).status).toBe('active');
  write(native, { hooks: { PreToolUse: { hooks: [hook] } } });
  expect(() => resolveInvocationSelection(f.options)).toThrow(
    'Malformed legacy native registration'
  );
});

test('legacy executable growth requires migration while an adapter-policy remains explicitly selected', () => {
  const f = fixture();
  fs.unlinkSync(f.projectFile);
  const legacy = path.join(f.options.canonical, '.caws/hooks');
  fs.mkdirSync(legacy, { recursive: true });
  expect(() => resolveInvocationSelection(f.options)).toThrow('one-time system migration');
  write(path.join(legacy, 'adapter-policy.json'), {
    version: 1,
    surfaces: {
      codex: {
        events: { pre_tool_use: { hooks_dir: '.caws/hooks', handlers: ['custom.sh --quiet'] } },
        libraries: {},
      },
    },
  });
  write(path.join(legacy, 'custom.sh'), '#!/bin/sh\nexit 0\n', true);
  expect(resolveInvocationSelection(f.options).status).toBe('inactive');
  const selected = resolveInvocationSelection({ ...f.options, system: false });
  expect(selected.configuration).toBe('project-policy');
  expect(selected.handlers[0]).toMatchObject({
    name: 'custom.sh',
    args: ['--quiet'],
    path: path.join(legacy, 'custom.sh'),
    kind: 'project-policy',
  });
  expect(
    resolveInvocationSelection({ ...f.options, system: false, event: 'post_tool_use' })
  ).toEqual({ status: 'inactive', reason: 'project policy has no handler chain for this event' });
});

test('all-or-nothing machine policy and native settings errors stay visible', () => {
  const f = fixture();
  write(f.projectFile, { version: 1, root: f.options.canonical, surfaces: {} });
  expect(() => resolveInvocationSelection(f.options)).toThrow('System project requires migration');
  f.configure({ ...empty(), unknown: true });
  expect(() => resolveInvocationSelection(f.options)).toThrow('Malformed system project surface');
  f.configure();
  write(path.join(f.options.home, 'surfaces/codex/settings.json'), {
    version: 1,
    enabled: true,
    unknown: true,
  });
  expect(() => resolveInvocationSelection(f.options)).toThrow('Malformed system surface settings');
});

test('selection has no environment or cross-project mutable state', () => {
  const f = fixture();
  const before = { ...process.env };
  const selected = resolveInvocationSelection(f.options);
  expect(selected.handlers.map((h) => h.name)).toEqual(['first.sh', 'last.sh']);
  expect(process.env).toEqual(before);
  expect(() =>
    resolveInvocationSelection({ ...f.options, canonical: path.join(root, 'absent-project') })
  ).not.toThrow();
  expect(resolveInvocationSelection(f.options).handlers).toEqual(selected.handlers);
});
