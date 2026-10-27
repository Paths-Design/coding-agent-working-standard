'use strict';

// Tests the admission decision only, not native cache writes or PATH/tool qualification.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const {
  qualifiesForNativeSessionCache,
  qualifiesForNativeSessionEndPrefix,
} = require('../../dist/runtime/session-cache-admission');
const templates = path.resolve(__dirname, '../../templates/hook-packs');
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const libraryKinds = {
  'agent-surface.sh': 'shared',
  'parse-input.sh': 'surface',
  'session-id.sh': 'shared',
  'session-cache.sh': 'shared',
  'emit.sh': 'surface',
};
let root, home, user, checkout, runtime, selection, request, environment;
const observations = [];
let stateObservation;
const artifactRoot = process.env.CAWS_TEST_ARTIFACT_DIR;
if (artifactRoot && !path.isAbsolute(artifactRoot))
  throw new Error('Artifact root must be absolute');
const qualify = () => {
  const admitted = qualifiesForNativeSessionCache({ request, selection, environment });
  observations.push({
    test: expect.getState().currentTestName,
    admitted,
    request: {
      surface: request.surface,
      event: request.event,
      cwd: request.payload.cwd,
      sessionId: request.payload.session_id ?? null,
    },
    handlers: selection.handlers.length,
    originalEnvironmentKeys: Object.keys(request.caller.environment).sort(),
    derivedEnvironmentKeys: Object.keys(environment).sort(),
  });
  return admitted;
};
afterAll(() => {
  if (!artifactRoot) return;
  fs.writeFileSync(
    path.join(artifactRoot, 'admission-decisions.json'),
    JSON.stringify(observations, null, 2) + '\n'
  );
  if (stateObservation)
    fs.writeFileSync(
      path.join(artifactRoot, 'read-only-state.json'),
      JSON.stringify(stateObservation, null, 2) + '\n'
    );
});
const selectedFile = (name) => selection.libraries[name].path;
const prefixFiles = () => [
  path.join(runtime, 'dispatch.sh'),
  path.join(runtime, 'runtime-paths.sh'),
  path.join(runtime, 'handler-env.sh'),
  ...Object.keys(libraryKinds).map(selectedFile),
];
function payload(value) {
  request.payload = value;
  request.inputJson = JSON.stringify(value);
}
function derived() {
  return {
    CAWS_PROJECT_DIR: selection.checkout,
    CAWS_MACHINE_POLICY_ROOT: selection.canonical,
    CAWS_MACHINE_RUNTIME: '1',
    CAWS_SYSTEM_RUNTIME: '1',
    CAWS_AGENT_SURFACE: 'codex',
    CAWS_ADAPTER_RUNTIME_DIGEST: selection.runtimeDigest,
    CAWS_SHARED_LIB_DIR: path.join(runtime, 'lib'),
    CAWS_MACHINE_ADAPTER_LIB_DIR: path.join(runtime, 'surfaces/codex/lib'),
    CAWS_MACHINE_LIBRARIES: '{}',
    CAWS_MACHINE_HANDLERS: '{}',
    HOOKS_DIR: runtime,
  };
}
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function snapshot(directory) {
  const rows = {};
  function walk(absolute, relative) {
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      rows[relative] = { kind: 'link', target: fs.readlinkSync(absolute), mode: stat.mode };
    } else if (stat.isDirectory()) {
      rows[relative] = { kind: 'directory', mode: stat.mode };
      for (const name of fs.readdirSync(absolute).sort())
        walk(path.join(absolute, name), relative ? relative + '/' + name : name);
    } else {
      rows[relative] = {
        kind: 'file',
        mode: stat.mode,
        bytes: stat.size,
        sha256: sha(fs.readFileSync(absolute)),
        mtimeMs: stat.mtimeMs,
      };
    }
  }
  walk(directory, '');
  return rows;
}
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'caws-cache-admission-')));
  home = path.join(root, 'effective-home');
  user = path.join(root, 'user');
  checkout = path.join(root, 'checkout');
  runtime = path.join(home, 'lib/runtimes', 'a'.repeat(64));
  fs.mkdirSync(user);
  fs.mkdirSync(path.join(checkout, '.caws/hooks'), { recursive: true });
  fs.mkdirSync(path.dirname(runtime), { recursive: true });
  fs.cpSync(path.join(templates, 'shared'), runtime, { recursive: true });
  for (const name of ['dispatch.sh', 'handler-env.sh'])
    fs.copyFileSync(path.join(templates, 'runtime', name), path.join(runtime, name));
  fs.cpSync(path.join(templates, 'codex/hooks/lib'), path.join(runtime, 'surfaces/codex/lib'), {
    recursive: true,
  });
  const libraries = {};
  for (const [name, kind] of Object.entries(libraryKinds)) {
    const file =
      kind === 'shared'
        ? path.join(runtime, 'lib', name)
        : path.join(runtime, 'surfaces/codex/lib', name);
    libraries[name] = { path: file, sha256: sha(fs.readFileSync(file)), kind };
  }
  selection = {
    status: 'active',
    runtimeDigest: 'a'.repeat(64),
    checkout,
    canonical: checkout,
    surface: 'codex',
    event: 'pre_tool_use',
    configuration: 'system',
    runtimeDirectory: runtime,
    hooksDirectory: runtime,
    handlers: [],
    libraries,
    overrides: {},
    libraryOverrides: {},
    transcriptAdapter: null,
  };
  const original = { HOME: user, CAWS_HOME: home, PATH: '/usr/bin:/bin' };
  environment = { ...original };
  request = {
    schema: 'caws.runtime.request.v1',
    id: 'cache-admission-fixture',
    runtimeDigest: selection.runtimeDigest,
    surface: 'codex',
    event: 'pre_tool_use',
    configuration: 'system',
    caller: { cwd: checkout, environment: { ...original }, processId: process.pid },
    deadlineEpochMs: Date.now() + 60000,
    inputJson: '',
    payload: {},
  };
  // No SID: qualification cannot manufacture one or require an upstream fallback.
  payload({ tool_name: 'Bash', tool_input: { command: 'printf fixture' } });
});
afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

function sessionEnd(surface = 'codex') {
  selection.surface = request.surface = surface;
  selection.event = request.event = 'session_end';
  payload({ session_id: 'original', cwd: checkout, reason: 'clear' });
  for (const name of [
    'agent-pid.sh',
    'parse-input.sh',
    'emit.sh',
    'run-handlers.sh',
    'reprieve.sh',
    'reprieve-reader.cjs',
    'guard-config.sh',
    'guard-config.cjs',
  ]) {
    const kind =
      surface === 'codex' && ['parse-input.sh', 'emit.sh', 'run-handlers.sh'].includes(name)
        ? 'surface'
        : 'shared';
    const file = path.join(runtime, kind === 'shared' ? 'lib' : 'surfaces/codex/lib', name);
    selection.libraries[name] = { path: file, sha256: sha(fs.readFileSync(file)), kind };
  }
  const file = path.join(runtime, 'session-log.sh');
  selection.handlers = [
    {
      name: 'session-log.sh',
      entry: 'session-log.sh',
      args: [],
      path: file,
      sha256: sha(fs.readFileSync(file)),
      tier: 'stock',
      kind: 'stock',
    },
  ];
}
const qualifyEnd = (sessionId = 'original') =>
  qualifiesForNativeSessionEndPrefix({
    request,
    selection,
    environment,
    sessionId,
  });

test.each(['codex', 'claude-code'])(
  'complete reviewed SessionEnd source profile qualifies for %s',
  (surface) => {
    sessionEnd(surface);
    const before = snapshot(root);
    expect(qualifyEnd()).toBe(true);
    expect(snapshot(root)).toEqual(before);
    expect(fs.existsSync(path.join(checkout, '.caws/sessions'))).toBe(false);
  }
);

test.each([
  'session-log.sh',
  'dispatch.sh',
  'handler-env.sh',
  'runtime-paths.sh',
  'lib/parse-input.sh',
  'lib/agent-surface.sh',
  'lib/session-cache.sh',
  'lib/agent-pid.sh',
  'lib/run-handlers.sh',
  'lib/reprieve.sh',
  'lib/reprieve-reader.cjs',
  'lib/guard-config.sh',
  'lib/guard-config.cjs',
  'lib/session-id.sh',
  'surfaces/codex/lib/parse-input.sh',
  'surfaces/codex/lib/emit.sh',
  'surfaces/codex/lib/run-handlers.sh',
])('SessionEnd source mutation declines before effects: %s', (relative) => {
  sessionEnd();
  expect(qualifyEnd()).toBe(true);
  fs.appendFileSync(path.join(runtime, relative), '\n# unreviewed source\n');
  expect(qualifyEnd()).toBe(false);
});

test.each(['codex', 'claude-code'])(
  'SessionEnd requires actual selected reprieve/config helpers and refuses custom parser for %s',
  (surface) => {
    sessionEnd(surface);
    expect(fs.existsSync(path.join(runtime, 'lib/guard-config.py'))).toBe(false);
    expect(qualifyEnd()).toBe(true);
    for (const name of ['guard-config.cjs', 'guard-config.sh', 'reprieve-reader.cjs']) {
      const file = path.join(runtime, 'lib', name);
      const original = fs.readFileSync(file);
      const selected = selection.libraries[name];
      delete selection.libraries[name];
      expect(qualifyEnd()).toBe(false);
      selection.libraries[name] = selected;
      for (const change of [
        { kind: 'surface' },
        { kind: 'project' },
        { path: path.join(runtime, 'redirected', name) },
        { sha256: '0'.repeat(64) },
      ]) {
        selection.libraries[name] = { ...selected, ...change };
        expect(qualifyEnd()).toBe(false);
      }
      selection.libraries[name] = selected;
      fs.rmSync(file);
      expect(qualifyEnd()).toBe(false);
      fs.symlinkSync(path.join(runtime, 'lib/session-id.sh'), file);
      expect(qualifyEnd()).toBe(false);
      fs.rmSync(file);
      fs.writeFileSync(file, original);
      expect(qualifyEnd()).toBe(true);
      for (const base of [home, runtime]) {
        const override = path.join(base, 'surfaces', surface, 'lib', name);
        fs.mkdirSync(path.dirname(override), { recursive: true });
        fs.writeFileSync(override, original);
        expect(qualifyEnd()).toBe(false);
        fs.rmSync(override);
        expect(qualifyEnd()).toBe(true);
      }
    }
    const custom = path.join(root, 'custom.py');
    fs.writeFileSync(custom, "raise Exception('must not execute')\n");
    for (const selectedEnvironment of [request.caller.environment, environment]) {
      selectedEnvironment.CAWS_GUARD_CONFIG_PY = custom;
      const before = snapshot(root);
      expect(qualifyEnd()).toBe(false);
      expect(snapshot(root)).toEqual(before);
      delete selectedEnvironment.CAWS_GUARD_CONFIG_PY;
      expect(qualifyEnd()).toBe(true);
    }
    expect(fs.existsSync(path.join(checkout, '.caws/sessions'))).toBe(false);
  }
);

test.each(['foreign', null, '', 'unknown', '../escape'])(
  'independent SessionEnd identity must match original %#',
  (sid) => {
    sessionEnd();
    expect(qualifyEnd(sid)).toBe(false);
  }
);

test('SessionEnd finite profile refuses extensions, argument variants, overrides and custom startup', () => {
  sessionEnd();
  const selected = selection.handlers[0];
  for (const change of [
    { args: ['ignored'] },
    { kind: 'project-override' },
    { sha256: 'b'.repeat(64) },
    { path: path.join(runtime, 'elsewhere') },
    { entry: 'session-log.sh x' },
  ]) {
    selection.handlers = [{ ...selected, ...change }];
    expect(qualifyEnd()).toBe(false);
  }
  selection.handlers = [selected, selected];
  expect(qualifyEnd()).toBe(false);
  selection.handlers = [];
  expect(qualifyEnd()).toBe(false);
  selection.handlers = [selected];
  selection.overrides = { 'session-log.sh': selected.path };
  expect(qualifyEnd()).toBe(false);
  selection.overrides = {};
  selection.libraryOverrides = { unused: '/unreviewed' };
  expect(qualifyEnd()).toBe(false);
  selection.libraryOverrides = {};
  environment.BASH_ENV = '/custom/startup';
  expect(qualifyEnd()).toBe(false);
  delete environment.BASH_ENV;
  environment.CAWS_PRIOR_BASH_ENV = '/custom/startup';
  expect(qualifyEnd()).toBe(false);
});

test.each(['codex', 'claude-code'])(
  'new higher-priority library, direct-source symlink or path routing mismatch refuses %s',
  (surface) => {
    sessionEnd(surface);
    const dir = path.join(home, 'surfaces', surface, 'lib');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'agent-pid.sh'), '# unreviewed');
    expect(qualifyEnd()).toBe(false);
    fs.rmSync(path.join(dir, 'agent-pid.sh'));
    expect(qualifyEnd()).toBe(true);
    const file = path.join(runtime, 'lib/parse-input.sh'),
      retained = fs.readFileSync(file);
    fs.rmSync(file);
    fs.symlinkSync(path.join(runtime, 'lib/session-cache.sh'), file);
    expect(qualifyEnd()).toBe(false);
    fs.rmSync(file);
    fs.writeFileSync(file, retained);
    expect(qualifyEnd()).toBe(true);
    environment.CAWS_AGENT_SURFACE = 'other';
    expect(qualifyEnd()).toBe(false);
  }
);

test('actual stock prefix qualifies with an empty chain and no session identity', () => {
  expect(qualify()).toBe(true);
  expect(request.payload).not.toHaveProperty('session_id');
  expect(request.caller.environment).not.toHaveProperty('CAWS_SESSION_ID');
  expect(fs.existsSync(path.join(checkout, '.caws/sessions'))).toBe(false);
});

test('selected stock handlers do not make cache eligibility depend on later reprieve execution', () => {
  const file = path.join(runtime, 'block-dangerous.sh');
  selection.handlers = [
    {
      name: 'block-dangerous.sh',
      entry: 'block-dangerous.sh',
      args: [],
      path: file,
      sha256: sha(fs.readFileSync(file)),
      tier: 'stock',
      kind: 'stock',
    },
  ];
  expect(qualify()).toBe(true);
  // An upstream all-reprieved chain can be empty; its prefix remains the same.
  selection.handlers = [];
  expect(qualify()).toBe(true);
  fs.appendFileSync(path.join(runtime, 'dispatch.sh'), '\n# changed\n');
  expect(qualify()).toBe(false);
});

test('exact derived roots and maps are optional, while present mismatches refuse', () => {
  expect(qualify()).toBe(true);
  for (const [name, expected] of Object.entries(derived())) {
    environment[name] = '';
    expect(qualify()).toBe(true);
    environment[name] = expected;
    expect(qualify()).toBe(true);
    environment[name] = expected + '-foreign';
    expect(qualify()).toBe(false);
    delete environment[name];
  }
  Object.assign(environment, derived());
  expect(qualify()).toBe(true);
});

test('derived startup is absent, empty or exact pinned path; original startup is independently refused', () => {
  for (const value of ['', path.join(runtime, 'handler-env.sh')]) {
    environment.BASH_ENV = value;
    environment.CAWS_PRIOR_BASH_ENV = '';
    expect(qualify()).toBe(true);
  }
  environment.BASH_ENV = path.join(runtime, 'handler-env.sh');
  request.caller.environment.BASH_ENV = environment.BASH_ENV;
  expect(qualify()).toBe(false);
  delete request.caller.environment.BASH_ENV;
  environment.BASH_ENV = '/foreign/startup.sh';
  expect(qualify()).toBe(false);
  environment.BASH_ENV = path.join(runtime, 'handler-env.sh');
  environment.CAWS_PRIOR_BASH_ENV = '/foreign/prior.sh';
  expect(qualify()).toBe(false);
});

const startupKeys = ['BASH_ENV', 'CAWS_PRIOR_BASH_ENV', 'ENV', 'SHELLOPTS', 'BASHOPTS'];
test('empty original startup and shell-option values remain inert', () => {
  for (const name of startupKeys) request.caller.environment[name] = '';
  expect(qualify()).toBe(true);
});
test.each(startupKeys)('original %s cannot be laundered by a clean derived environment', (name) => {
  expect(qualify()).toBe(true);
  request.caller.environment[name] = 'custom';
  expect(qualify()).toBe(false);
});
test.each(['BASH_FUNC_source%%', 'BASH_FUNC_resolve_caws_session_id%%'])(
  'imported function %s refuses even with an empty value',
  (name) => {
    request.caller.environment[name] = '';
    expect(qualify()).toBe(false);
    delete request.caller.environment[name];
    environment[name] = '';
    expect(qualify()).toBe(false);
  }
);
test.each([
  '_HOOK_PARSE_INPUT_LOADED',
  '_CAWS_AGENT_SURFACE_SH_LOADED',
  '_CAWS_SESSION_ID_SH_LOADED',
  '_CAWS_EMIT_SH_LOADED',
])('loaded marker %s independently refuses original and derived input', (name) => {
  request.caller.environment[name] = '1';
  expect(qualify()).toBe(false);
  delete request.caller.environment[name];
  environment[name] = '1';
  expect(qualify()).toBe(false);
});
test.each([
  ['LD_PRELOAD', '/foreign/lib.so'],
  ['DYLD_INSERT_LIBRARIES', '/foreign/lib.dylib'],
  ['NODE_OPTIONS', '--require=/foreign.js'],
  ['NODE_PATH', '/foreign/modules'],
  ['PYTHONPATH', '/foreign/python'],
  ['PYTHONHOME', '/foreign/home'],
  ['PYTHONSTARTUP', '/foreign/startup.py'],
  ['PYTHONUTF8', '1'],
  ['PYTHONDONTWRITEBYTECODE', '0'],
])('execution modifier %s is refused before and after derivation', (name, value) => {
  request.caller.environment[name] = value;
  expect(qualify()).toBe(false);
  delete request.caller.environment[name];
  environment[name] = value;
  expect(qualify()).toBe(false);
});
test('the documented bytecode-disable value is admissible without choosing a Python profile', () => {
  request.caller.environment.PYTHONDONTWRITEBYTECODE = '1';
  environment.PYTHONDONTWRITEBYTECODE = '1';
  expect(qualify()).toBe(true);
});
test.each([
  'CAWS_HOOK_TIMING',
  'CLAUDE_HOOK_TIMING',
  'CODEX_HOOK_TIMING',
  'CAWS_HOOK_DRY_RUN',
  'CLAUDE_HOOK_DRY_RUN',
  'CODEX_HOOK_DRY_RUN',
  'CAWS_HOOK_INLINE_PAYLOAD_MAX_BYTES',
])('custom timing, dry-run or inline input %s refuses', (name) => {
  request.caller.environment[name] = '1';
  expect(qualify()).toBe(false);
  delete request.caller.environment[name];
  environment[name] = '1';
  expect(qualify()).toBe(false);
});

test.each([0, 1, 2, 3, 4, 5, 6, 7])('prefix file %i must match actual pinned bytes', (index) => {
  const file = prefixFiles()[index];
  expect(qualify()).toBe(true);
  fs.appendFileSync(file, '\n# modified stock prefix\n');
  expect(qualify()).toBe(false);
});
test.each(Object.keys(libraryKinds))('updated metadata cannot admit changed %s bytes', (name) => {
  const file = selectedFile(name);
  fs.appendFileSync(file, '\n# locally changed\n');
  selection.libraries[name].sha256 = sha(fs.readFileSync(file));
  expect(qualify()).toBe(false);
});
test.each([0, 1, 2, 3, 4, 5, 6, 7])(
  'prefix file %i must be regular and never a symlink',
  (index) => {
    const file = prefixFiles()[index];
    const retained = file + '.fixture-original';
    fs.renameSync(file, retained);
    fs.symlinkSync(retained, file);
    expect(sha(fs.readFileSync(file))).toBe(sha(fs.readFileSync(retained)));
    expect(qualify()).toBe(false);
    fs.unlinkSync(file);
    fs.mkdirSync(file);
    expect(qualify()).toBe(false);
    fs.rmdirSync(file);
    expect(qualify()).toBe(false);
  }
);
test.each([
  '.',
  'lib',
  'lib/runtimes',
  'lib/runtimes/DIGEST',
  'lib/runtimes/DIGEST/lib',
  'lib/runtimes/DIGEST/surfaces',
  'lib/runtimes/DIGEST/surfaces/codex',
  'lib/runtimes/DIGEST/surfaces/codex/lib',
])('a redirected ancestor %s cannot retain qualification through identical bytes', (relative) => {
  const directory = path.join(home, relative.replace('DIGEST', selection.runtimeDigest));
  const retained = directory + '.fixture-original';
  fs.renameSync(directory, retained);
  fs.symlinkSync(retained, directory, 'dir');
  expect(qualify()).toBe(false);
});
test.each(Object.keys(libraryKinds))(
  'selected %s metadata must describe its exact prefix source',
  (name) => {
    const original = { ...selection.libraries[name] };
    selection.libraries[name].sha256 = '0'.repeat(64);
    expect(qualify()).toBe(false);
    selection.libraries[name] = { ...original, path: original.path + '.foreign' };
    fs.copyFileSync(original.path, selection.libraries[name].path);
    expect(qualify()).toBe(false);
    for (const kind of [
      'project',
      'user',
      'unknown',
      original.kind === 'shared' ? 'surface' : 'shared',
    ]) {
      selection.libraries[name] = { ...original, kind };
      expect(qualify()).toBe(false);
    }
    delete selection.libraries[name];
    expect(qualify()).toBe(false);
  }
);
test.each(['agent-surface.sh', 'session-id.sh', 'session-cache.sh'])(
  'new higher-priority surface %s invalidates stale shared selection',
  (name) => {
    const file = path.join(runtime, 'surfaces/codex/lib', name);
    expect(fs.existsSync(file)).toBe(false);
    fs.copyFileSync(selectedFile(name), file);
    expect(selection.libraries[name].kind).toBe('shared');
    expect(qualify()).toBe(false);
  }
);

test.each(Object.keys(libraryKinds))('user override %s must actually be absent', (name) => {
  const file = path.join(home, 'surfaces/codex/lib', name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.copyFileSync(selectedFile(name), file);
  expect(qualify()).toBe(false);
  fs.unlinkSync(file);
  fs.symlinkSync(path.join(root, 'nonexistent'), file);
  expect(qualify()).toBe(false);
  fs.unlinkSync(file);
  fs.mkdirSync(file);
  expect(qualify()).toBe(false);
});
test('ENOTDIR under the user override root is not evidence of absence', () => {
  fs.mkdirSync(path.join(home, 'surfaces'));
  fs.writeFileSync(path.join(home, 'surfaces/codex'), 'not a directory');
  expect(qualify()).toBe(false);
});
test.each(['file', 'directory', 'dangling-link'])(
  'project runtime-paths %s prevents stock prefix qualification',
  (kind) => {
    const file = path.join(checkout, '.caws/hooks/runtime-paths.sh');
    if (kind === 'file') fs.copyFileSync(path.join(runtime, 'runtime-paths.sh'), file);
    else if (kind === 'directory') fs.mkdirSync(file);
    else fs.symlinkSync(path.join(root, 'missing-project-source'), file);
    expect(qualify()).toBe(false);
  }
);
test('ENOTDIR under project runtime-paths is not evidence of absence', () => {
  fs.rmdirSync(path.join(checkout, '.caws/hooks'));
  fs.writeFileSync(path.join(checkout, '.caws/hooks'), 'not a directory');
  expect(qualify()).toBe(false);
});
test.each([
  ['EACCES', 'user'],
  ['EIO', 'user'],
  ['EACCES', 'project'],
  ['EIO', 'project'],
])('unexpected %s while checking %s absence refuses rather than guessing', (code, tier) => {
  const target =
    tier === 'user'
      ? path.join(home, 'surfaces/codex/lib/parse-input.sh')
      : path.join(checkout, '.caws/hooks/runtime-paths.sh');
  const original = fs.lstatSync;
  let hits = 0;
  expect(qualify()).toBe(true);
  jest.spyOn(fs, 'lstatSync').mockImplementation((file, ...args) => {
    if (String(file) === target) {
      hits++;
      throw Object.assign(new Error('fixture I/O failure'), { code });
    }
    return original(file, ...args);
  });
  expect(qualify()).toBe(false);
  expect(hits).toBeGreaterThan(0);
});
test('an unexpected error reading a real prefix refuses', () => {
  let hits = 0;
  expect(qualify()).toBe(true);
  jest.spyOn(fs, 'readSync').mockImplementation(() => {
    hits++;
    throw Object.assign(new Error('fixture read failure'), { code: 'EIO' });
  });
  expect(qualify()).toBe(false);
  expect(hits).toBeGreaterThan(0);
});

test.each([
  ['request', 'configuration', 'project'],
  ['selection', 'configuration', 'project-policy'],
  ['request', 'surface', 'claude-code'],
  ['selection', 'surface', 'claude-code'],
  ['request', 'event', 'post_tool_use'],
  ['selection', 'event', 'post_tool_use'],
  ['request', 'runtimeDigest', 'b'.repeat(64)],
  ['selection', 'runtimeDigest', 'b'.repeat(64)],
])('%s %s mismatch refuses', (owner, key, value) => {
  (owner === 'request' ? request : selection)[key] = value;
  expect(qualify()).toBe(false);
});
test('matching invented digest strings cannot relabel a different installed directory', () => {
  request.runtimeDigest = selection.runtimeDigest = 'b'.repeat(64);
  expect(qualify()).toBe(false);
});
test.each(['overrides', 'libraryOverrides'])(
  'nonempty %s refuses even outside required names',
  (field) => {
    selection[field] = { unrelated: '/foreign/source.sh' };
    expect(qualify()).toBe(false);
  }
);
test.each(['project-override', 'project-policy', 'unknown'])(
  'selected handler kind %s refuses',
  (kind) => {
    selection.handlers = [
      {
        name: 'example.sh',
        entry: 'example.sh',
        args: [],
        tier: 'stock',
        path: path.join(runtime, 'example.sh'),
        sha256: '0'.repeat(64),
        kind,
      },
    ];
    expect(qualify()).toBe(false);
  }
);
test.each(['project', 'user', 'unknown'])('additional selected library kind %s refuses', (kind) => {
  selection.libraries['extra.sh'] = {
    path: selectedFile('session-id.sh'),
    sha256: selection.libraries['session-id.sh'].sha256,
    kind,
  };
  expect(qualify()).toBe(false);
});
test('a foreign effective home cannot relabel the selected installed runtime', () => {
  environment.CAWS_HOME = path.join(root, 'another-home');
  request.caller.environment.CAWS_HOME = environment.CAWS_HOME;
  fs.mkdirSync(environment.CAWS_HOME);
  expect(qualify()).toBe(false);
});
test('non-Bash tools and non-string commands are unsupported', () => {
  payload({ tool_name: 'Read', tool_input: { command: 'printf fixture' } });
  expect(qualify()).toBe(false);
  for (const command of [null, 1, {}, []]) {
    payload({ tool_name: 'Bash', tool_input: { command } });
    expect(qualify()).toBe(false);
  }
  for (const tool_input of [null, 'command', []]) {
    payload({ tool_name: 'Bash', tool_input });
    expect(qualify()).toBe(false);
  }
});
test('absent/null/empty cwd and native absolute existing directories within checkout qualify', () => {
  for (const cwd of [null, '', checkout]) {
    payload({ tool_name: 'Bash', cwd, tool_input: { command: 'printf fixture' } });
    expect(qualify()).toBe(true);
  }
  const directory = path.join(checkout, 'nested directory');
  fs.mkdirSync(directory);
  payload({ tool_name: 'Bash', cwd: directory, tool_input: { command: 'printf fixture' } });
  expect(qualify()).toBe(true);
});
test('relative, unnormalized, missing, foreign, non-directory and non-native cwd refuse', () => {
  const file = path.join(checkout, 'file');
  fs.writeFileSync(file, 'ordinary file');
  const nested = path.join(checkout, 'nested');
  fs.mkdirSync(nested);
  for (const cwd of [
    '.',
    'nested',
    nested + '/..',
    path.join(checkout, 'missing'),
    root,
    file,
    checkout + '/\0',
    checkout + '/\ud800',
    1,
    {},
    [],
  ]) {
    payload({ tool_name: 'Bash', cwd, tool_input: { command: 'printf fixture' } });
    expect(qualify()).toBe(false);
  }
  const link = path.join(checkout, 'linked');
  fs.symlinkSync(nested, link, 'dir');
  payload({ tool_name: 'Bash', cwd: link, tool_input: { command: 'printf fixture' } });
  expect(qualify()).toBe(false);
});

test('LF-final canonical repository and CR/LF cwd remain outside the shell path profile', () => {
  const canonical = path.join(root, 'canonical\n');
  fs.mkdirSync(canonical);
  expect(fs.existsSync(canonical.slice(0, -1))).toBe(false);
  selection.canonical = canonical;
  expect(qualify()).toBe(false);
  selection.canonical = checkout;
  for (const suffix of ['\n', '\r']) {
    const cwd = path.join(checkout, 'directory' + suffix);
    fs.mkdirSync(cwd);
    payload({ tool_name: 'Bash', cwd, tool_input: { command: 'printf fixture' } });
    expect(qualify()).toBe(false);
  }
});

test.each([1, 9, 31, 127, 128, 159])(
  'control character %i in a real canonical directory declines before native transport',
  (code) => {
    selection.canonical = path.join(root, 'canonical' + String.fromCharCode(code));
    fs.mkdirSync(selection.canonical);
    expect(qualify()).toBe(false);
  }
);

test('native root byte limit is checked before filesystem interpretation', () => {
  selection.canonical = '/' + 'é'.repeat(2048);
  expect(selection.canonical.length).toBeLessThan(4096);
  expect(Buffer.byteLength(selection.canonical)).toBe(4097);
  const stat = fs.lstatSync(checkout);
  const original = fs.lstatSync;
  let rootReads = 0;
  jest.spyOn(fs, 'lstatSync').mockImplementation((file, ...args) => {
    if (file === selection.canonical) {
      rootReads++;
      return stat;
    }
    return original(file, ...args);
  });
  expect(qualify()).toBe(false);
  expect(rootReads).toBe(0);
});

test('non-root trailing slash declines before native root transport', () => {
  expect(qualify()).toBe(true);
  selection.canonical = checkout + '/';
  expect(fs.statSync(selection.canonical).isDirectory()).toBe(true);
  expect(qualify()).toBe(false);
  selection.canonical = checkout;
  payload({ tool_name: 'Bash', cwd: checkout + '/', tool_input: { command: 'printf fixture' } });
  expect(qualify()).toBe(false);
});

test('qualification does not mutate frozen inputs, write cache state or spawn a process', () => {
  const before = snapshot(root);
  const serialized = JSON.stringify({ request, selection, environment });
  freeze(request);
  freeze(selection);
  freeze(environment);
  const writes = [
    'writeFileSync',
    'appendFileSync',
    'mkdirSync',
    'unlinkSync',
    'rmSync',
    'renameSync',
    'copyFileSync',
    'truncateSync',
    'chmodSync',
  ];
  const writeSpies = writes.map((name) =>
    jest.spyOn(fs, name).mockImplementation(() => {
      throw new Error('admission attempted a write: ' + name);
    })
  );
  const spawnSpies = [
    'spawn',
    'spawnSync',
    'exec',
    'execSync',
    'execFile',
    'execFileSync',
    'fork',
  ].map((name) =>
    jest.spyOn(childProcess, name).mockImplementation(() => {
      throw new Error('admission attempted a subprocess: ' + name);
    })
  );
  expect(qualify()).toBe(true);
  expect(JSON.stringify({ request, selection, environment })).toBe(serialized);
  const after = snapshot(root);
  expect(after).toEqual(before);
  for (const spy of [...writeSpies, ...spawnSpies]) expect(spy).not.toHaveBeenCalled();
  expect(fs.existsSync(path.join(checkout, '.caws/sessions'))).toBe(false);
  stateObservation = {
    before,
    after,
    equal: true,
    inputsUnchanged: true,
    writeCalls: writeSpies.map((spy, i) => ({ name: writes[i], count: spy.mock.calls.length })),
    subprocessCalls: spawnSpies.map((spy) => spy.mock.calls.length),
    sessionsDirectoryExists: false,
  };
});

test('only the reviewed host-workdir Codex parser identity qualifies', () => {
  const parser = selection.libraries['parse-input.sh'];
  expect(sha(fs.readFileSync(parser.path))).toBe(
    'c33d320efef119f826de58b145344288264b985f10d911b435645f6d851444fc'
  );
  expect(qualify()).toBe(true);
  parser.sha256 = '04a21ee0cd24d917bbee4c63f9285a2a867f2f9a08a9cdf2f9a78d3400a73c61';
  expect(qualify()).toBe(false);
});
test('validated nested host context qualifies without changing raw session coordinates or identity', () => {
  const nested = path.join(checkout, 'host nested');
  fs.mkdirSync(nested);
  payload({
    tool_name: 'Bash',
    cwd: checkout,
    execution_workdir: nested,
    session_id: 'original',
    tool_use_id: 'original-tool',
    turn_id: 'original-turn',
    tool_input: { command: 'echo unchanged', cwd: nested, workdir: nested },
  });
  const input = request.inputJson;
  const before = snapshot(root);
  expect(qualify()).toBe(true);
  expect(request.inputJson).toBe(input);
  expect(request.payload.cwd).toBe(checkout);
  expect(snapshot(root)).toEqual(before);
});
test('a real linked checkout permits nested host context only with raw cwd inside that checkout', () => {
  const git = (args, cwd = checkout) => {
    const result = childProcess.spawnSync('/usr/bin/git', args, {
      cwd,
      env: request.caller.environment,
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
  };
  git(['init', '-q']);
  git([
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '--allow-empty',
    '-qm',
    'fixture',
  ]);
  const linked = path.join(root, 'linked-checkout');
  git(['worktree', 'add', '-q', '-b', 'cache-linked', linked]);
  const nested = path.join(linked, 'nested');
  fs.mkdirSync(nested);
  selection.checkout = linked;
  request.caller.cwd = linked;
  payload({
    tool_name: 'Bash',
    cwd: linked,
    execution_workdir: nested,
    tool_input: { command: 'echo unchanged' },
  });
  expect(selection.canonical).toBe(checkout);
  expect(qualify()).toBe(true);
  payload({ ...request.payload, cwd: checkout });
  expect(qualify()).toBe(false);
});
test.each([null, '', false, 0, {}, [], 'relative', '/missing-host-context', 'bad\0host'])(
  'present invalid host execution directory declines native cache: %p',
  (execution_workdir) => {
    payload({
      tool_name: 'Bash',
      cwd: checkout,
      execution_workdir,
      tool_input: { command: 'echo unchanged' },
    });
    expect(qualify()).toBe(false);
  }
);
test('stale, symlinked, nonphysical, outside and nondirectory host contexts decline', () => {
  const nested = path.join(checkout, 'nested');
  fs.mkdirSync(nested);
  const stale = path.join(checkout, 'stale');
  fs.mkdirSync(stale);
  fs.rmdirSync(stale);
  const link = path.join(checkout, 'host-link');
  fs.symlinkSync(nested, link);
  const file = path.join(checkout, 'file');
  fs.writeFileSync(file, 'fixture');
  for (const execution_workdir of [stale, link, nested + '/.', nested + '/', root, file]) {
    payload({
      tool_name: 'Bash',
      cwd: checkout,
      execution_workdir,
      tool_input: { command: 'echo unchanged' },
    });
    expect(qualify()).toBe(false);
  }
});
test.each(['workdir', 'cwd'])(
  'host context requires valid agreeing explicit tool_input.%s',
  (alias) => {
    const nested = path.join(checkout, 'nested');
    fs.mkdirSync(nested);
    const link = path.join(checkout, 'alias');
    fs.symlinkSync(nested, link);
    payload({
      tool_name: 'Bash',
      cwd: checkout,
      execution_workdir: nested,
      tool_input: { command: 'echo unchanged', [alias]: link },
    });
    expect(qualify()).toBe(true);
    for (const value of [checkout, null, 'relative', path.join(checkout, 'missing')]) {
      payload({ ...request.payload, tool_input: { command: 'echo unchanged', [alias]: value } });
      expect(qualify()).toBe(false);
    }
  }
);
test('absent host field retains old raw-cwd semantics without promoting diagnostic aliases', () => {
  payload({
    tool_name: 'Bash',
    cwd: checkout,
    tool_input: { command: 'echo unchanged', workdir: root, cwd: null },
  });
  expect(qualify()).toBe(true);
  payload({ ...request.payload, cwd: root });
  expect(qualify()).toBe(false);
});
test('a validated host inside checkout never relaxes the existing outside raw-cwd restriction', () => {
  const nested = path.join(checkout, 'nested');
  fs.mkdirSync(nested);
  payload({
    tool_name: 'Bash',
    cwd: root,
    execution_workdir: nested,
    tool_input: { command: 'echo unchanged' },
  });
  expect(qualify()).toBe(false);
});
test.each([null, 'relative', '/missing-unused-host'])(
  'SessionEnd ignores unused host context and aliases (%p)',
  (execution_workdir) => {
    sessionEnd('codex');
    payload({
      ...request.payload,
      tool_name: 'Bash',
      execution_workdir,
      tool_input: { workdir: null, cwd: 'relative' },
    });
    expect(qualifyEnd()).toBe(true);
  }
);

test('current exact-path agent surface qualifies, but a changed selected body does not', () => {
  const agent = selection.libraries['agent-surface.sh'];
  expect(sha(fs.readFileSync(agent.path))).toBe(
    '455dbfc2bfcf3a5ca891449e1a5f51ce7d9a9a1203ff680bc5fa90fe933e5a8f'
  );
  expect(qualify()).toBe(true);
  fs.appendFileSync(agent.path, '\n# unreviewed behavior\n');
  agent.sha256 = sha(fs.readFileSync(agent.path));
  expect(qualify()).toBe(false);
});

test.each(['codex', 'claude-code'])(
  'SessionEnd accepts exact-path agent surface only when selected and body identities match: %s',
  (surface) => {
    sessionEnd(surface);
    const agent = selection.libraries['agent-surface.sh'];
    expect(sha(fs.readFileSync(agent.path))).toBe(
      '455dbfc2bfcf3a5ca891449e1a5f51ce7d9a9a1203ff680bc5fa90fe933e5a8f'
    );
    expect(qualifyEnd()).toBe(true);
    fs.appendFileSync(agent.path, '\n# unreviewed behavior\n');
    agent.sha256 = sha(fs.readFileSync(agent.path));
    expect(qualifyEnd()).toBe(false);
  }
);
