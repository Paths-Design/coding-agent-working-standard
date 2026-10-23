const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  SERVICE_IMAGE_TOOLS,
  SERVICE_IMAGE_OPTIONAL_TOOLS,
  SERVICE_IMAGE_PLAN_TOOL,
  SERVICE_IMAGE_TEMPLATES,
  assertServiceImageEnvironment,
  quoteServiceImageLiteral,
  expandServiceImageTemplate,
  claimNativeRenderAdmission,
  disposeNativeRenderAdmission,
  prepareSessionRenderImage,
  transformServiceImageRunner,
  verifyPublishedServiceImage,
  STERLING_SESSION_SOURCE_PROFILE,
} = require('../../dist/runtime/service-image');

const templates = path.resolve(__dirname, '../../templates/hook-packs/runtime/service-image');
const readTemplate = (name) => fs.readFileSync(path.join(templates, name), 'utf8');
let root;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'caws-image-')));
});
afterEach(() => {
  // Successful image preparation intentionally seals directories without write
  // permission. Only this test's disposable tree is unsealed for removal.
  const unseal = (directory) => {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    fs.chmodSync(directory, 0o700);
    for (const entry of fs.readdirSync(directory)) unseal(path.join(directory, entry));
  };
  unseal(root);
  fs.rmSync(root, { recursive: true, force: true });
});

test('declares every required current Stop tool without ambient PATH fallback', () => {
  expect([...SERVICE_IMAGE_TOOLS]).toEqual([
    'awk',
    'basename',
    'bash',
    'cat',
    'caws',
    'cp',
    'cut',
    'date',
    'dirname',
    'find',
    'git',
    'grep',
    'head',
    'jq',
    'mkdir',
    'mktemp',
    'node',
    'pgrep',
    'ps',
    'python3',
    'readlink',
    'rm',
    'sed',
    'sh',
    'sleep',
    'sort',
    'stat',
    'tail',
    'tr',
    'wc',
  ]);
  expect(SERVICE_IMAGE_TEMPLATES).toHaveLength(11);
  expect([...SERVICE_IMAGE_OPTIONAL_TOOLS]).toEqual(['cmp', 'iconv']);
  expect(SERVICE_IMAGE_TEMPLATES).toContain('plan-transcript-finalize.sh');
});

test.each([
  ['BASH_ENV', '/foreign/startup'],
  ['ENV', '/foreign/startup'],
  ['SHELLOPTS', 'xtrace'],
  ['BASHOPTS', 'extdebug'],
  ['CAWS_PRIOR_BASH_ENV', '/foreign/startup'],
  ['BASH_FUNC_caws_source_lib%%', '() { false; }'],
  ['_HOOK_PARSE_INPUT_LOADED', '1'],
  ['_CAWS_AGENT_SURFACE_SH_LOADED', '1'],
  ['CAWS_GUARD_CONFIG_PY', '/foreign/config.py'],
  ['NODE_OPTIONS', '--require=/foreign/preload.js'],
  ['NODE_PATH', '/foreign/modules'],
  ['PYTHONPATH', '/foreign/modules'],
  ['PYTHONHOME', '/foreign/python'],
  ['LD_PRELOAD', '/foreign/library.so'],
  ['DYLD_INSERT_LIBRARIES', '/foreign/library.dylib'],
  ['CAWS_SERVICE_GIT_DIRECTORY', '/caller/forged-git'],
  ['CAWS_BIN', '/mutable/bin/caws'],
])('refuses effective executable input %s', (name, value) => {
  expect(() => assertServiceImageEnvironment({ [name]: value })).toThrow(
    'unsupported ambient executable input'
  );
});

test('permits data environment and the required no-bytecode setting', () => {
  expect(() =>
    assertServiceImageEnvironment({
      HOME: '/private/user',
      CAWS_HOME: '/private/caws',
      CAWS_TRAP_KILL: '0',
      PYTHONDONTWRITEBYTECODE: '1',
    })
  ).not.toThrow();
});

test('expands original markers once and quotes hostile legal path bytes', () => {
  const markerPath = path.join(root, "__CAWS_IMAGE_ENTRY__ ' $(touch injected) `touch injected`");
  const entry = path.join(root, "entry ' $(touch injected) `touch injected`");
  const output = expandServiceImageTemplate(
    "printf '%s\\n' __CAWS_IMAGE_NODE__ __CAWS_IMAGE_ENTRY__\n",
    {
      __CAWS_IMAGE_NODE__: quoteServiceImageLiteral(markerPath),
      __CAWS_IMAGE_ENTRY__: quoteServiceImageLiteral(entry),
    }
  );
  const child = spawnSync('/bin/sh', ['-c', output], {
    cwd: root,
    env: {},
    encoding: 'utf8',
    timeout: 2000,
  });
  expect(child.error).toBeUndefined();
  expect(child.status).toBe(0);
  expect(child.stdout).toBe(markerPath + '\n' + entry + '\n');
  expect(fs.existsSync(path.join(root, 'injected'))).toBe(false);
});

test.each([
  ['__CAWS_IMAGE_NODE__ __CAWS_IMAGE_NODE__', { __CAWS_IMAGE_NODE__: "'x'" }],
  ['__CAWS_IMAGE_UNKNOWN__', { __CAWS_IMAGE_NODE__: "'x'" }],
  ['no marker', { __CAWS_IMAGE_NODE__: "'x'" }],
])('refuses missing, duplicate or undeclared original marker: %s', (body, values) => {
  expect(() => expandServiceImageTemplate(body, values)).toThrow('template markers');
});

test('closed source resolver refuses a library absent from its image table', () => {
  const library = path.join(root, 'allowed.sh');
  fs.writeFileSync(library, 'printf allowed\n');
  const resolver = expandServiceImageTemplate(readTemplate('libraries.sh'), {
    __CAWS_IMAGE_LIBRARY_CASES__:
      "    'allowed.sh') source " + quoteServiceImageLiteral(library) + '; return $? ;;',
  });
  const child = spawnSync('/bin/bash', ['-c', resolver + '\ncaws_source_lib undeclared.sh\n'], {
    cwd: root,
    env: {},
    encoding: 'utf8',
    timeout: 2000,
  });
  expect(child.status).toBe(2);
  expect(child.stdout).toBe('');
  expect(child.stderr).toContain('Undeclared library');
});

test.each([
  [0, '3 4 5 '],
  [1, ''],
])(
  'actual routing helper exposes capability descriptors only at selected index (%s)',
  (index, expected) => {
    const file = path.join(root, 'descriptor');
    fs.writeFileSync(file, '');
    const descriptors = [0, 1, 2].map(() => fs.openSync(file, 'r+'));
    try {
      const helper = expandServiceImageTemplate(readTemplate('execute-handler.sh'), {
        __CAWS_IMAGE_SELECTED_INDEX__: '0',
      });
      const program =
        helper +
        '\n_rh_handler_index=' +
        index +
        '\nhandler_execution_path=/bin/bash\n' +
        "_caws_service_image_exec -c 'for fd in 3 4 5; do " +
        '[[ -e /dev/fd/$fd ]] && printf "%s " "$fd"; done; true\'\n';
      const child = spawnSync('/bin/bash', ['-c', program], {
        cwd: root,
        env: {},
        encoding: 'utf8',
        timeout: 2000,
        stdio: ['ignore', 'pipe', 'pipe', ...descriptors],
      });
      expect(child.error).toBeUndefined();
      expect(child.status).toBe(0);
      expect(child.stdout).toBe(expected);
    } finally {
      for (const fd of descriptors) fs.closeSync(fd);
    }
  }
);

const currentRunnerSource = () =>
  fs.readFileSync(path.resolve(templates, '../../shared/lib/run-handlers.sh'), 'utf8');
function directRunnerSource() {
  // The older supported layout has only the file and pipe calls. Keep the
  // remaining real runner code so both layouts execute the same dispatch checks.
  return currentRunnerSource()
    .replace(/^_rh_exec_staged\(\) \{[\s\S]*?\n}\n/m, '')
    .replace(
      '    elif (( stage_inline )); then\n      stdout_buf=$(_rh_exec_staged "$handler_path" "$stderr_file" "$@")\n',
      ''
    );
}
function runnerTransform(runner, selectedIndex = 0, handlerRoutes = '') {
  return transformServiceImageRunner({
    runner,
    selectedIndex,
    handlerRoutes,
    parseInput: readTemplate('parse-input.sh'),
    executeHandler: expandServiceImageTemplate(readTemplate('execute-handler.sh'), {
      __CAWS_IMAGE_SELECTED_INDEX__: String(selectedIndex),
    }),
  });
}

test.each(['direct', 'staged'])('recognized %s runner is complete Bash syntax', (layout) => {
  const source = layout === 'direct' ? directRunnerSource() : currentRunnerSource();
  const child = spawnSync('/bin/bash', ['-n'], {
    input: runnerTransform(source),
    encoding: 'utf8',
    timeout: 2000,
  });
  expect(child.error).toBeUndefined();
  expect(child.status).toBe(0);
});

test.each([
  [
    'file call',
    (source) =>
      source.replace('stdout_buf=$("$handler_path" "$@" <', 'stdout_buf=$("$handler_path"  "$@" <'),
  ],
  [
    'pipe call',
    (source) => source.replace('| "$handler_path" "$@" 2>', '| "$handler_path"  "$@" 2>'),
  ],
  [
    'staged call',
    (source) =>
      source.replace(
        'stdout_buf=$(_rh_exec_staged "$handler_path"',
        'stdout_buf=$(_rh_exec_staged  "$handler_path"'
      ),
  ],
  [
    'staged exec',
    (source) => source.replace('exec "$handler_path" "$@"', 'exec "$handler_path"  "$@"'),
  ],
  [
    'duplicate file call',
    (source) =>
      source.replace(
        '      stdout_buf=$("$handler_path" "$@" < "$stdin_file" 2>"$stderr_file")\n',
        '      stdout_buf=$("$handler_path" "$@" < "$stdin_file" 2>"$stderr_file")\n'.repeat(2)
      ),
  ],
  [
    'missing parser',
    (source) =>
      source.replace('    source "${HOOKS_DIR}/lib/parse-input.sh" 2>/dev/null || return 0\n', ''),
  ],
  [
    'duplicate routes anchor',
    (source) =>
      source.replace(
        '    if [[ ! -x "$handler_path" ]]; then\n',
        '    if [[ ! -x "$handler_path" ]]; then\n'.repeat(2)
      ),
  ],
])('runner refuses unsupported %s before execution', (_label, mutate) => {
  expect(() => runnerTransform(mutate(currentRunnerSource()))).toThrow('runtime transform anchor');
});
test.each([-1, 0.5, 65536, NaN])('runner refuses invalid selected index %s', (index) => {
  expect(() => runnerTransform(currentRunnerSource(), index)).toThrow('selected handler index');
});

test.each([
  ['direct', 'file'],
  ['direct', 'pipe'],
  ['staged', 'file'],
  ['staged', 'pipe'],
  ['staged', 'inline'],
  ['staged', 'fallback'],
])(
  'actual %s runner preserves %s dispatch, staged cleanup and selected capability',
  (layout, mode) => {
    const logical = path.join(root, 'logical'),
      mapped = path.join(root, 'mapped'),
      temporary = path.join(root, 'tmp');
    for (const directory of [logical, mapped, temporary]) fs.mkdirSync(directory);
    const poison = path.join(root, 'logical-path-executed');
    const entries = ['selected.sh alpha literal;value', 'adjacent.sh beta'];
    const cases = [];
    for (const [index, entry] of entries.entries()) {
      const name = entry.split(' ')[0];
      const original = path.join(logical, name),
        sealed = path.join(mapped, name);
      const trace = path.join(root, name);
      fs.writeFileSync(
        original,
        '#!/bin/bash\nprintf poison > ' + quoteServiceImageLiteral(poison) + '\nexit 99\n',
        { mode: 0o700 }
      );
      fs.writeFileSync(
        sealed,
        '#!/bin/bash\n' +
          'cat > ' +
          quoteServiceImageLiteral(trace + '.stdin') +
          '\n' +
          'printf "%s\\n" "$@" > ' +
          quoteServiceImageLiteral(trace + '.args') +
          '\n' +
          'printf "%s\\n" "$PPID" > ' +
          quoteServiceImageLiteral(trace + '.parent') +
          '\n' +
          'for fd in 3 4 5; do [[ ! -e /dev/fd/$fd ]] || printf "%s " "$fd"; done > ' +
          quoteServiceImageLiteral(trace + '.fds') +
          '\n' +
          'printf "diagnostic\\n" >&2\nexit ' +
          (index === 0 ? '7' : '0') +
          '\n',
        { mode: 0o700 }
      );
      cases.push(
        '      ' +
          index +
          ') [[ "$entry" == ' +
          quoteServiceImageLiteral(entry) +
          ' && "$handler_path" == ' +
          quoteServiceImageLiteral(original) +
          ' ]] || return 2; handler_execution_path=' +
          quoteServiceImageLiteral(sealed) +
          ' ;;'
      );
    }
    const routes = expandServiceImageTemplate(readTemplate('handler-routes.sh'), {
      __CAWS_IMAGE_HANDLER_CASES__: cases.join('\n'),
    });
    const output = runnerTransform(
      layout === 'direct' ? directRunnerSource() : currentRunnerSource(),
      0,
      routes
    );
    const payload = JSON.stringify({
      data:
        mode === 'inline' || mode === 'fallback' ? 'x'.repeat(40000) : 'literal $(touch injected)',
    });
    const inputFile = path.join(root, 'payload');
    fs.writeFileSync(inputFile, payload);
    let searchPath = '/usr/bin:/bin';
    if (mode === 'fallback') {
      const bin = path.join(root, 'bin');
      fs.mkdirSync(bin);
      fs.writeFileSync(
        path.join(bin, 'mktemp'),
        '#!/bin/bash\n[[ "${1:-}" != -d ]] || exit 1\nexec /usr/bin/mktemp "$@"\n',
        { mode: 0o700 }
      );
      searchPath = bin + ':' + searchPath;
    }
    const descriptor = path.join(root, 'descriptor');
    fs.writeFileSync(descriptor, '');
    const descriptors = [0, 1, 2].map(() => fs.openSync(descriptor, 'r+'));
    let child;
    try {
      const program =
        'set -uo pipefail\n' +
        output +
        '\nprintf "%s\\n" "$$" > ' +
        quoteServiceImageLiteral(path.join(root, 'dispatcher.pid')) +
        '\nrun_handlers ' +
        entries.map(quoteServiceImageLiteral).join(' ') +
        '\n';
      child = spawnSync('/bin/bash', ['-c', program], {
        cwd: root,
        env: {
          PATH: searchPath,
          HOOKS_DIR: logical,
          HOOK_INPUT_JSON: payload,
          ...(mode === 'file' ? { HOOK_PAYLOAD_FILE: inputFile } : {}),
          TMPDIR: temporary,
          CAWS_HOOK_ADVISORY_DEDUP: '0',
        },
        encoding: 'utf8',
        timeout: 3000,
        stdio: ['ignore', 'pipe', 'pipe', ...descriptors],
      });
    } finally {
      for (const fd of descriptors) fs.closeSync(fd);
    }
    expect(child.error).toBeUndefined();
    expect(child.signal).toBeNull();
    expect(child.status).toBe(7);
    expect(child.stdout).toBe('');
    expect(child.stderr).toBe('[selected.sh] diagnostic\n[adjacent.sh] diagnostic\n');
    expect(fs.existsSync(poison)).toBe(false);
    expect(fs.existsSync(path.join(root, 'injected'))).toBe(false);
    for (const [index, name] of ['selected.sh', 'adjacent.sh'].entries()) {
      expect(fs.readFileSync(path.join(root, name + '.stdin'), 'utf8')).toBe(payload);
      expect(fs.readFileSync(path.join(root, name + '.args'), 'utf8')).toBe(
        index === 0 ? 'alpha\nliteral;value\n' : 'beta\n'
      );
      expect(fs.readFileSync(path.join(root, name + '.fds'), 'utf8')).toBe(
        index === 0 ? '3 4 5 ' : ''
      );
      if (mode === 'inline')
        expect(fs.readFileSync(path.join(root, name + '.parent'), 'utf8')).toBe(
          fs.readFileSync(path.join(root, 'dispatcher.pid'), 'utf8')
        );
    }
    expect(fs.readdirSync(temporary)).toEqual([]);
  }
);

test('POSIX tool wrapper does not recursively load an inherited Bash startup', () => {
  const startup = path.join(root, 'startup');
  const marker = path.join(root, 'startup-ran');
  fs.writeFileSync(startup, 'printf ran > ' + quoteServiceImageLiteral(marker) + '\n');
  const wrapper = path.join(root, 'tool');
  fs.writeFileSync(
    wrapper,
    expandServiceImageTemplate(readTemplate('tool.sh'), {
      __CAWS_IMAGE_TOOL_PATH__: "'/bin/echo'",
      __CAWS_IMAGE_TOOL_FLAGS__: '',
    }),
    { mode: 0o700 }
  );
  const child = spawnSync(wrapper, ['value'], {
    cwd: root,
    env: { BASH_ENV: startup },
    encoding: 'utf8',
    timeout: 2000,
  });
  expect(child.error).toBeUndefined();
  expect(child.status).toBe(0);
  expect(child.stdout).toBe('value\n');
  expect(fs.existsSync(marker)).toBe(false);
});

test('invalid native admission closes transferred descriptor copies before refusal', () => {
  const file = path.join(root, 'descriptor');
  fs.writeFileSync(file, '');
  const descriptors = [0, 1, 2].map(() => fs.openSync(file, 'r+'));
  expect(() =>
    claimNativeRenderAdmission(
      {
        schema: 'forged',
        descriptors: {
          transport: descriptors[0],
          grant: descriptors[1],
          receipt: descriptors[2],
        },
      },
      {},
      {},
      {}
    )
  ).toThrow('admission descriptors');
  for (const fd of descriptors)
    expect(() => fs.fstatSync(fd)).toThrow(expect.objectContaining({ code: 'EBADF' }));
});

// These are real builder refusals with SHA-256 and filesystem I/O. The synthetic
// project bytes intentionally cannot satisfy the reviewed foreign source table;
// successful deployed-profile staging/admission belongs to native qualification.
function builderFixture() {
  const crypto = require('node:crypto');
  const digest = (body) => crypto.createHash('sha256').update(body).digest('hex');
  const runtimeDirectory = path.join(root, 'runtime');
  const hooks = path.join(root, 'project/.caws/hooks');
  const clientDirectory = path.join(root, 'client/dist/runtime');
  const imageParent = path.join(root, 'images');
  for (const directory of [runtimeDirectory, path.join(hooks, 'lib'), clientDirectory, imageParent])
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(imageParent, 0o700);
  const runtimeSources = {
    'before.sh': '#!/bin/bash\nexit 0\n',
    'after.sh': '#!/bin/bash\nexit 0\n',
    'launcher.py': '# fixture runtime launcher\n',
    'dispatch.sh': '# fixture dispatcher\n',
    'handler-env.sh': '# fixture startup\n',
    'lib/run-handlers.sh': '# fixture runner\n',
    'lib/session-render-service-client.sh': '# fixture client source\n',
  };
  for (const [name, body] of Object.entries(runtimeSources)) {
    const file = path.join(runtimeDirectory, name);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, body, { mode: 0o700 });
  }
  const runtimeManifest = JSON.stringify(
    Object.fromEntries(Object.entries(runtimeSources).map(([name, body]) => [name, digest(body)]))
  );
  fs.writeFileSync(path.join(runtimeDirectory, 'manifest.json'), runtimeManifest);
  const fixtureExecutable = path.join(root, 'tool');
  fs.writeFileSync(fixtureExecutable, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const cawsEntry = path.resolve(clientDirectory, '../index.js');
  fs.writeFileSync(cawsEntry, '// fixture trusted authority adapter\n');
  const toolchain = SERVICE_IMAGE_TOOLS.map((name) => {
    const file =
      name === 'bash'
        ? '/bin/bash'
        : name === 'sh'
          ? '/bin/sh'
          : name === 'caws'
            ? cawsEntry
            : fixtureExecutable;
    return { name, path: file, sha256: digest(fs.readFileSync(file)) };
  });
  const selected = {
    entry: 'session-log.sh',
    name: 'session-log.sh',
    args: [],
    path: path.join(hooks, 'session-log.sh'),
    sha256: '0'.repeat(64),
    tier: 'machine-policy',
    kind: 'project-override',
  };
  const stock = (name) => ({
    entry: name,
    name,
    args: [],
    path: path.join(runtimeDirectory, name),
    sha256: digest(runtimeSources[name]),
    tier: 'stock',
    kind: 'stock',
  });
  const selection = {
    status: 'active',
    configuration: 'system',
    surface: 'codex',
    event: 'stop',
    checkout: path.join(root, 'project'),
    canonical: path.join(root, 'project'),
    runtimeDirectory,
    hooksDirectory: runtimeDirectory,
    runtimeDigest: digest(runtimeManifest),
    handlers: [stock('before.sh'), selected, stock('after.sh')],
    libraries: {},
    overrides: { 'session-log.sh': selected.path },
    libraryOverrides: {},
    transcriptAdapter: null,
  };
  return {
    selection,
    selectedIndex: 1,
    imageParent,
    environment: {},
    toolchain,
    clientDirectory,
    templateDirectory: templates,
    clientShellPath: path.resolve(templates, '../../shared/lib/session-render-service-client.sh'),
  };
}
function expectBuilderRefusal(options, reason) {
  expect(() => prepareSessionRenderImage(options)).toThrow(reason);
  expect(fs.readdirSync(options.imageParent)).toEqual([]);
}

const optionalToolSets = [[], ['cmp'], ['iconv'], ['cmp', 'iconv']];
const declaredToolSets = optionalToolSets.flatMap((optional) =>
  [false, true].map((plan) => ({ optional, plan }))
);
function addFixtureToolPins(options, names) {
  const crypto = require('node:crypto');
  for (const name of names) {
    const file = path.join(root, 'pinned-' + name);
    fs.writeFileSync(file, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    options.toolchain.push({
      name,
      path: file,
      sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
    });
  }
}

test.each(declaredToolSets)(
  'tool-name validation retains the exact base with optional=$optional plan=$plan',
  ({ optional, plan }) => {
    const options = builderFixture();
    addFixtureToolPins(options, [...optional, ...(plan ? [SERVICE_IMAGE_PLAN_TOOL] : [])]);
    options.toolchain.reverse();
    // This deliberately incomplete foreign-source fixture reaches the profile
    // check only after every declared tool passes name, path and pin validation.
    expectBuilderRefusal(options, 'undeclared project library or incomplete profile');
  }
);

test.each([
  'duplicate base',
  'duplicate optional',
  'duplicate plan',
  'unknown tool',
  'missing base',
])('tool-name validation rejects %s before staging', (mutation) => {
  const options = builderFixture();
  addFixtureToolPins(options, ['cmp', SERVICE_IMAGE_PLAN_TOOL]);
  if (mutation === 'duplicate base')
    options.toolchain.push({ ...options.toolchain.find((pin) => pin.name === 'awk') });
  else if (mutation === 'duplicate optional')
    options.toolchain.push({ ...options.toolchain.find((pin) => pin.name === 'cmp') });
  else if (mutation === 'duplicate plan')
    options.toolchain.push({
      ...options.toolchain.find((pin) => pin.name === SERVICE_IMAGE_PLAN_TOOL),
    });
  else if (mutation === 'unknown tool')
    options.toolchain.push({ ...options.toolchain[0], name: 'unreviewed-tool' });
  else options.toolchain = options.toolchain.filter((pin) => pin.name !== 'awk');
  expectBuilderRefusal(options, 'incomplete toolchain');
});

test.each([
  ['stale', 'tool changed'],
  ['deleted', 'ENOENT'],
  ['symlink', 'symlink source or image'],
  ['invalid hash', 'tool changed'],
  ['relative path', 'noncanonical path'],
  ['nonexecutable', 'EACCES'],
])('declared optional tool rejects %s pins', (mutation, reason) => {
  const options = builderFixture();
  addFixtureToolPins(options, ['cmp']);
  const pin = options.toolchain.find((tool) => tool.name === 'cmp');
  if (mutation === 'stale') fs.appendFileSync(pin.path, '# changed\n');
  else if (mutation === 'deleted') fs.unlinkSync(pin.path);
  else if (mutation === 'symlink') {
    const target = pin.path + '-referent';
    fs.renameSync(pin.path, target);
    fs.symlinkSync(target, pin.path);
  } else if (mutation === 'invalid hash') pin.sha256 = 'not-a-digest';
  else if (mutation === 'relative path') pin.path = 'relative-cmp';
  else fs.chmodSync(pin.path, 0o600);
  expectBuilderRefusal(options, reason);
});

test('real builder rejects a runtime source mutation before staging any image', () => {
  const options = builderFixture();
  fs.appendFileSync(path.join(options.selection.runtimeDirectory, 'before.sh'), '# mutated\n');
  expectBuilderRefusal(options, 'source fingerprint changed');
});

test('real builder rejects undeclared runtime executable bytes', () => {
  const options = builderFixture();
  fs.writeFileSync(path.join(options.selection.runtimeDirectory, 'unlisted.sh'), 'exit 0\n');
  expectBuilderRefusal(options, 'undeclared runtime member');
});

test('real builder refuses an ambient Python cache inside immutable runtime', () => {
  const options = builderFixture();
  const cache = path.join(options.selection.runtimeDirectory, '__pycache__');
  fs.mkdirSync(cache);
  fs.writeFileSync(path.join(cache, 'entry.pyc'), 'unlisted executable bytecode');
  expectBuilderRefusal(options, 'undeclared runtime member');
});

test('real builder rejects a same-byte symlink replacing a declared source', () => {
  const options = builderFixture();
  const original = path.join(options.selection.runtimeDirectory, 'before.sh');
  const referent = path.join(root, 'same-bytes.sh');
  fs.renameSync(original, referent);
  fs.symlinkSync(referent, original);
  expectBuilderRefusal(options, 'symlink source or image');
});

test('real builder preserves stock identity checks around a nonzero selected index', () => {
  const options = builderFixture();
  options.selection.handlers[2].sha256 = 'f'.repeat(64);
  expectBuilderRefusal(options, 'stock handler fingerprint');
});

test('descriptor disposal is idempotent and cannot close a recycled descriptor', () => {
  const file = path.join(root, 'descriptor');
  fs.writeFileSync(file, '');
  const descriptors = [0, 1, 2].map(() => fs.openSync(file, 'r+'));
  const admission = {
    schema: 'forged',
    descriptors: {
      transport: descriptors[0],
      grant: descriptors[1],
      receipt: descriptors[2],
    },
  };
  disposeNativeRenderAdmission(admission);
  const recycled = fs.openSync(file, 'r+');
  try {
    disposeNativeRenderAdmission(admission);
    expect(() => claimNativeRenderAdmission(admission, {}, {}, {})).toThrow('already consumed');
    expect(fs.fstatSync(recycled).isFile()).toBe(true);
  } finally {
    fs.closeSync(recycled);
  }
});

test('authority CLI wrapper pins real Git and preserves project/session context', () => {
  const git = path.join(root, 'pinned git');
  const entry = path.join(root, 'authority adapter.js');
  fs.writeFileSync(git, '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o700 });
  fs.writeFileSync(
    entry,
    `
    const { execFileSync } = require('node:child_process');
    const git = execFileSync(process.env.CAWS_GIT_BINARY,
      ['-C', process.env.CAWS_PROJECT_DIR, 'rev-parse', '--git-common-dir'],
      { encoding: 'utf8' });
    process.stdout.write(JSON.stringify({ args: process.argv.slice(2), git,
      project: process.env.CAWS_PROJECT_DIR, session: process.env.CAWS_SESSION_ID,
      platform: process.env.CAWS_AGENT_SURFACE, home: process.env.CAWS_HOME }));
  `
  );
  const wrapper = path.join(root, 'caws');
  fs.writeFileSync(
    wrapper,
    expandServiceImageTemplate(readTemplate('caws.sh'), {
      __CAWS_IMAGE_GIT_PATH__: quoteServiceImageLiteral(git),
      __CAWS_IMAGE_NODE_PATH__: quoteServiceImageLiteral(process.execPath),
      __CAWS_IMAGE_CLI_ENTRY__: quoteServiceImageLiteral(entry),
    }),
    { mode: 0o700 }
  );
  const child = spawnSync(wrapper, ['agents', 'stop'], {
    cwd: root,
    env: {
      PATH: '/unavailable',
      CAWS_GIT_BINARY: '/caller/forged',
      CAWS_PROJECT_DIR: root,
      CAWS_SESSION_ID: 'fixture-session',
      CAWS_AGENT_SURFACE: 'codex',
      CAWS_HOME: path.join(root, 'authority-home'),
    },
    encoding: 'utf8',
    timeout: 5000,
  });
  expect(child.error).toBeUndefined();
  expect(child.status).toBe(0);
  expect(JSON.parse(child.stdout)).toEqual({
    args: ['agents', 'stop'],
    git: '-C\n' + root + '\nrev-parse\n--git-common-dir\n',
    project: root,
    session: 'fixture-session',
    platform: 'codex',
    home: path.join(root, 'authority-home'),
  });
});

// The 28 reviewed foreign files are external inputs; their bytes are never
// distributed in this repository. Root qualification enables these tests with
// CAWS_TEST_REVIEWED_SESSION_HOOKS pointing at the exact reviewed source tree.
// They read that tree and execute copies only inside the disposable fixture.
const reviewedProfileTest = process.env.CAWS_TEST_REVIEWED_SESSION_HOOKS ? test : test.skip;
function reviewedProfileFixture() {
  const crypto = require('node:crypto');
  const { installMachineRuntime } = require('../../dist/init/machine-adapters');
  const hash = (body) => crypto.createHash('sha256').update(body).digest('hex');
  const pin = (file) => ({ path: file, sha256: hash(fs.readFileSync(file)) });
  const project = path.join(root, 'reviewed-project');
  const hooks = path.join(project, '.caws/hooks');
  const home = path.join(root, 'reviewed-home');
  const imageParent = path.join(root, 'reviewed-images');
  fs.mkdirSync(hooks, { recursive: true, mode: 0o700 });
  fs.mkdirSync(imageParent, { mode: 0o700 });
  for (const [name, expected] of Object.entries(STERLING_SESSION_SOURCE_PROFILE)) {
    const original = fs.readFileSync(path.join(process.env.CAWS_TEST_REVIEWED_SESSION_HOOKS, name));
    expect(hash(original)).toBe(expected);
    const target = path.join(hooks, name);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, original, { mode: 0o700 });
  }
  const installation = installMachineRuntime({
    home,
    templatesRoot: path.resolve(templates, '../..'),
  });
  const runtimeDirectory = path.join(home, 'lib/runtimes', installation.digest);
  const entries = JSON.parse(fs.readFileSync(path.join(runtimeDirectory, 'system-policy.json')))
    .events.stop;
  expect(entries).toEqual([
    'goal-ac-gate.sh',
    'plan-transcript-finalize.sh',
    'session-log.sh',
    'agent-stop.sh',
  ]);
  const selectedIndex = entries.indexOf('session-log.sh');
  const handlers = entries.map((name) => ({
    ...pin(path.join(name === 'session-log.sh' ? hooks : runtimeDirectory, name)),
    entry: name,
    name,
    args: [],
    tier: name === 'session-log.sh' ? 'machine-policy' : 'stock',
    kind: name === 'session-log.sh' ? 'project-override' : 'stock',
  }));
  const libraries = {};
  for (const [relative, kind] of [
    ['lib', 'shared'],
    ['surfaces/codex/lib', 'surface'],
  ]) {
    const directory = path.join(runtimeDirectory, relative);
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name);
      if (fs.statSync(file).isFile()) libraries[name] = { ...pin(file), kind };
    }
  }
  const clientDirectory = path.resolve(__dirname, '../../dist/runtime');
  const toolchain = SERVICE_IMAGE_TOOLS.map((name) => {
    let file;
    if (name === 'bash') file = '/bin/bash';
    else if (name === 'sh') file = '/bin/sh';
    else if (name === 'node') file = fs.realpathSync(process.execPath);
    else if (name === 'caws') file = path.resolve(clientDirectory, '../index.js');
    else {
      const located = spawnSync('/bin/sh', ['-c', 'command -v "$1"', 'caws-test-tool', name], {
        env: { PATH: process.env.PATH },
        encoding: 'utf8',
        timeout: 2000,
      });
      expect(located.status).toBe(0);
      file = fs.realpathSync(located.stdout.trim());
    }
    return { name, ...pin(file) };
  });
  const selection = {
    status: 'active',
    configuration: 'system',
    surface: 'codex',
    event: 'stop',
    checkout: project,
    canonical: project,
    runtimeDirectory,
    hooksDirectory: runtimeDirectory,
    runtimeDigest: installation.digest,
    handlers,
    libraries,
    overrides: { 'session-log.sh': path.join(hooks, 'session-log.sh') },
    libraryOverrides: {},
    transcriptAdapter: pin(libraries['session-transcript.py'].path),
  };
  return {
    project,
    home,
    options: {
      selection,
      selectedIndex,
      imageParent,
      environment: {},
      toolchain,
      clientDirectory,
      templateDirectory: templates,
      clientShellPath: path.resolve(templates, '../../shared/lib/session-render-service-client.sh'),
    },
  };
}
function fixturePublish(image) {
  // A test-only rename lets integrity and dispatcher assertions inspect the
  // final paths. It exercises no native publication, grant, or admission code.
  fs.renameSync(image.stagingRoot, image.manifest.execution.root);
}

reviewedProfileTest.each(declaredToolSets)(
  'reviewed image seals optional=$optional plan=$plan into its exact toolchain identity',
  ({ optional, plan }) => {
    const fixture = reviewedProfileFixture();
    const baseline = prepareSessionRenderImage(fixture.options);
    const extra = [...optional, ...(plan ? [SERVICE_IMAGE_PLAN_TOOL] : [])];
    addFixtureToolPins(fixture.options, extra);
    fixture.options.toolchain.reverse();
    const image = prepareSessionRenderImage(fixture.options);
    expect(image.manifest.toolchainTcb.tools.map((pin) => pin.name)).toEqual(
      [...SERVICE_IMAGE_TOOLS, ...extra].sort()
    );
    for (const name of extra) {
      const declared = fixture.options.toolchain.find((pin) => pin.name === name);
      expect(image.manifest.toolchainTcb.tools.find((pin) => pin.name === name)).toEqual(declared);
      expect(fs.readFileSync(path.join(image.stagingRoot, 'bin', name), 'utf8')).toContain(
        declared.path
      );
    }
    if (extra.length) {
      expect(image.imageKey).not.toBe(baseline.imageKey);
      expect(image.imageDigest).not.toBe(baseline.imageDigest);
      expect(image.manifest.sourceGeneration).not.toBe(baseline.manifest.sourceGeneration);
    } else {
      expect(image.imageKey).toBe(baseline.imageKey);
      expect(image.imageDigest).toBe(baseline.imageDigest);
    }
    fixturePublish(image);
    expect(() => verifyPublishedServiceImage(image)).not.toThrow();
  },
  30000
);

reviewedProfileTest(
  'real reviewed-profile builder seals exact bytes, full chain and immutable cache identity',
  () => {
    const fixture = reviewedProfileFixture();
    const image = prepareSessionRenderImage(fixture.options);
    expect(image.stagingRoot).toMatch(/\/\.stage-[^/]+$/);
    expect(fs.existsSync(image.manifest.execution.root)).toBe(false);
    expect(fs.statSync(image.stagingRoot).mode & 0o777).toBe(0o500);
    expect(image.manifest.selection.selectedIndex).toBe(2);
    expect(image.manifest.execution.handlerRoutes.map((route) => route.originalPath)).toEqual(
      fixture.options.selection.handlers.map((handler) => handler.path)
    );
    const original = fs.readFileSync(fixture.options.selection.handlers[2].path);
    expect(fs.readFileSync(path.join(image.stagingRoot, 'hooks/session-log.sh'))).toEqual(original);
    expect(Object.isFrozen(image)).toBe(true);
    expect(Object.isFrozen(image.manifest.selection.handlers[2].args)).toBe(true);
    expect(Reflect.set(image.manifest.execution, 'root', '/changed')).toBe(false);
    const manifestBytes = fs.readFileSync(path.join(image.stagingRoot, 'manifest.json'));
    expect(manifestBytes.toString()).toBe(JSON.stringify(image.manifest));
    expect(require('node:crypto').createHash('sha256').update(manifestBytes).digest('hex')).toBe(
      image.imageDigest
    );
    fixturePublish(image);
    expect(() => verifyPublishedServiceImage(image)).not.toThrow();
    const reused = prepareSessionRenderImage(fixture.options);
    expect(reused.stagingRoot).toBeNull();
    expect(reused.imageKey).toBe(image.imageKey);
    expect(reused.imageDigest).toBe(image.imageDigest);
    expect(fs.readdirSync(fixture.options.imageParent)).toEqual([image.imageKey]);
  },
  30000
);

reviewedProfileTest(
  'real full Stop dispatcher executes unchanged reviewed handler and exits its missing-grant path',
  () => {
    const fixture = reviewedProfileFixture();
    const image = prepareSessionRenderImage(fixture.options);
    fixturePublish(image);
    const rootPath = image.manifest.execution.root;
    const git = fixture.options.toolchain.find((tool) => tool.name === 'git').path;
    const init = spawnSync(git, ['-c', 'init.defaultBranch=main', 'init', fixture.project], {
      env: {
        PATH: process.env.PATH,
        HOME: fixture.home,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_CONFIG_GLOBAL: '/dev/null',
      },
      encoding: 'utf8',
      timeout: 5000,
    });
    expect(init.status).toBe(0);
    const executions = path.join(root, 'executions.jsonl');
    const settlements = path.join(root, 'settlements.jsonl');
    fs.writeFileSync(executions, '');
    fs.writeFileSync(settlements, '');
    const sessionId = 'reviewed-dispatch-fixture';
    const child = spawnSync(
      '/bin/bash',
      [
        path.join(rootPath, 'runtime/dispatch.sh'),
        'codex',
        'stop',
        fixture.options.selection.runtimeDirectory,
        ...fixture.options.selection.handlers.map((handler) => handler.entry),
      ],
      {
        cwd: fixture.project,
        encoding: 'utf8',
        timeout: 15000,
        input: JSON.stringify({
          hook_event_name: 'Stop',
          session_id: sessionId,
          cwd: fixture.project,
          transcript_path: '',
        }),
        env: {
          HOME: fixture.home,
          CAWS_HOME: fixture.home,
          TMPDIR: root,
          PATH: path.join(rootPath, 'bin'),
          BASH_ENV: path.join(rootPath, 'runtime/handler-env.sh'),
          CAWS_SHARED_LIB_DIR: path.join(rootPath, 'runtime/lib'),
          CAWS_MACHINE_ADAPTER_LIB_DIR: path.join(rootPath, 'runtime/surfaces/codex/lib'),
          CAWS_PROJECT_DIR: fixture.project,
          CAWS_MACHINE_POLICY_ROOT: fixture.project,
          CAWS_SYSTEM_RUNTIME: '1',
          CAWS_AGENT_SURFACE: 'codex',
          CAWS_SESSION_ID: sessionId,
          CAWS_BIN: path.join(rootPath, 'bin/caws'),
          CAWS_MACHINE_HANDLERS: JSON.stringify(fixture.options.selection.overrides),
          CAWS_MACHINE_LIBRARIES: '{}',
          CAWS_HOOK_EXECUTION_FILE: executions,
          CAWS_HOOK_SETTLEMENT_FILE: settlements,
          PYTHONDONTWRITEBYTECODE: '1',
          CAWS_SESSION_TRANSCRIPT_ADAPTER: path.join(
            rootPath,
            'runtime/surfaces/codex/lib/session-transcript.py'
          ),
          CAWS_SERVICE_GIT_DIRECTORY: path.join(fixture.project, '.git'),
          CAWS_SERVICE_GIT_WORK_TREE: fixture.project,
          CAWS_SERVICE_GIT_ORIGINAL_DIRECTORY: path.join(fixture.project, '.git'),
          CAWS_SERVICE_GIT_COMMON_DIRECTORY: path.join(fixture.project, '.git'),
        },
      }
    );
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(75);
    const records = fs.readFileSync(executions, 'utf8').trim().split('\n').map(JSON.parse);
    expect(records.map((record) => record.path)).toEqual(
      fixture.options.selection.handlers.map((handler) => handler.path)
    );
    expect(records.map((record) => record.status)).toEqual([
      'completed',
      'completed',
      'completed',
      'completed',
    ]);
    expect(records[2].exit_code).toBe(75);
    expect(records[2].stderr).toContain('session render service unavailable');
    expect(records[2].stderr).not.toContain('session_log_renderer.py');
    // A missing transferred grant must terminate the selected handler, while the
    // full dispatcher still records the stock handler after it. This does not
    // establish native broker success, native Git admission, or stock effects.
  },
  30000
);
