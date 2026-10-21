'use strict';

// Tests the admission decision only, not native cache writes or PATH/tool qualification.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const { qualifiesForNativeSessionCache } = require('../../dist/runtime/session-cache-admission');
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
