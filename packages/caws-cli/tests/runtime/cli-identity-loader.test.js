const fs = require('node:fs');
const { AbortController } = globalThis;
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { loadGenerationCliIdentity } = require('../../dist/runtime/cli-identity-loader');
const { cliClosureDigest } = require('../../dist/runtime/cli-identity');
const sha = (b) => createHash('sha256').update(b).digest('hex');
const CLI = 'node_modules/@paths.design/caws-cli';
const ENGINE = 'native-prefix/' + CLI + '/dist/runtime/engine-entry.js';
let temp, root, request, controller, members, modes, source, actualExecPath;
const bytes = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
function add(name, value, mode = 0o644) {
  members[name] = bytes(value);
  modes[name] = mode;
}
function publish() {
  const manifest = {};
  add('native-modes.json', modes);
  // modes contains its own entry before serialization, just like the builder.
  members['native-modes.json'] = bytes(modes);
  for (const [name, data] of Object.entries(members)) manifest[name] = sha(data);
  const manifestBytes = bytes(manifest),
    digest = sha(manifestBytes);
  const next = path.join(temp, digest);
  fs.mkdirSync(next);
  for (const [name, data] of Object.entries({ ...members, 'manifest.json': manifestBytes })) {
    const file = path.join(next, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data, { mode: modes[name] || 0o644 });
  }
  root = next;
  request.runtimeDigest = digest;
  Object.defineProperty(process, 'execPath', {
    value: path.join(root, 'native/node'),
    configurable: true,
  });
}
const load = () => loadGenerationCliIdentity(request, controller.signal, path.join(root, ENGINE));
beforeEach(() => {
  temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'caws-cli-loader-')));
  members = {};
  modes = {};
  controller = new AbortController();
  actualExecPath = process.execPath;
  request = {
    schema: 'caws.runtime.request.v1',
    id: 'loader-original',
    runtimeDigest: 'a'.repeat(64),
    surface: 'opencode',
    event: 'stop',
    configuration: 'system',
    caller: { cwd: temp, environment: {}, processId: process.pid },
    inputJson: '{"session_id":"loader-original"}',
    payload: { session_id: 'loader-original' },
    deadlineEpochMs: Date.now() + 30000,
  };
  add(ENGINE, '// inert engine fixture\n');
  add('native/node', 'inert-node', 0o755);
  add('native-entry.json', {
    schema: 'caws.runtime.native-entry.v1',
    nativeExecutable: 'native/caws-native',
    nodeExecutable: 'native/node',
    engineEntry: ENGINE,
    describeEntry: 'describe.js',
    timeoutMs: 30000,
  });
  const filePins = {};
  for (const [name, value] of Object.entries({
    [CLI + '/package.json']: '{"name":"@paths.design/caws-cli","version":"1.0.0"}',
    [CLI + '/dist/index.js']: '#!/usr/bin/env node\n',
  }))
    add('native-prefix/' + name, value, name.endsWith('/dist/index.js') ? 0o755 : 0o644);
  for (const [name, data] of Object.entries(members))
    if (name.startsWith('native-prefix/'))
      filePins[name.slice('native-prefix/'.length)] = {
        sha256: sha(data),
        sizeBytes: data.length,
        mode: modes[name],
      };
  source = {
    schema: 'caws.runtime.cli-identity-source.v1',
    prefixRoot: 'native-prefix',
    files: filePins,
    packages: { [CLI]: { name: '@paths.design/caws-cli', version: '1.0.0' } },
    omissions: {},
    node: {
      path: 'native/node',
      sha256: sha(members['native/node']),
      sizeBytes: members['native/node'].length,
      mode: 0o755,
    },
  };
  const domain = {
    schema: 'caws.cli.agents-stop-domain.v1',
    operation: 'agents-stop-explicit-session-opencode',
    closureSha256: cliClosureDigest(source),
    importers: [
      {
        path: CLI + '/dist/index.js',
        sha256: filePins[CLI + '/dist/index.js'].sha256,
        requests: [],
      },
    ],
    dormantSites: [],
  };
  add('native-cli-domain.json', domain);
  source.domain = {
    path: 'native-cli-domain.json',
    sha256: sha(members['native-cli-domain.json']),
    sizeBytes: members['native-cli-domain.json'].length,
    mode: 0o644,
  };
  add('native-cli-identity.json', source);
  publish();
});
afterEach(() => {
  jest.restoreAllMocks();
  Object.defineProperty(process, 'execPath', { value: actualExecPath, configurable: true });
  fs.rmSync(temp, { recursive: true, force: true });
});
test('loads exact generation-relative reviewed pins without executing CLI or generating a domain', async () => {
  const reviewed = await load();
  expect(reviewed.prefixRoot).toBe(path.join(root, 'native-prefix'));
  expect(reviewed.files).toEqual(source.files);
  expect(reviewed.node.path).toBe(path.join(root, 'native/node'));
  expect(reviewed.domain.sha256).toBe(source.domain.sha256);
  // Fixture loading is not native admission or semantic qualification.
});
test('absent policy retains compatibility and never discovers selected CLI tables', async () => {
  delete members['native-cli-identity.json'];
  delete modes['native-cli-identity.json'];
  delete members['native-cli-domain.json'];
  delete modes['native-cli-domain.json'];
  publish();
  expect(await load()).toBeUndefined();
});
test.each(['native-cli-identity.json', 'native-cli-domain.json', 'native-entry.json', ENGINE])(
  'changed admitted %s fails its manifest pin',
  async (name) => {
    fs.appendFileSync(path.join(root, name), 'changed');
    await expect(load()).rejects.toThrow(/content changed/);
  }
);
test('descriptor cannot omit a package file even under a newly matching manifest', async () => {
  delete source.files[CLI + '/dist/index.js'];
  add('native-cli-identity.json', source);
  publish();
  await expect(load()).rejects.toThrow(/closure inventory/);
});
test('descriptor cannot retarget its domain outside the selected generation', async () => {
  source.domain.path = '../foreign-domain.json';
  add('native-cli-identity.json', source);
  publish();
  await expect(load()).rejects.toThrow(/source path/);
});
test('a newly pinned domain for a different reviewed closure fails', async () => {
  const domain = JSON.parse(members['native-cli-domain.json']);
  domain.closureSha256 = 'f'.repeat(64);
  add('native-cli-domain.json', domain);
  source.domain.sha256 = sha(members['native-cli-domain.json']);
  source.domain.sizeBytes = members['native-cli-domain.json'].length;
  add('native-cli-identity.json', source);
  publish();
  await expect(load()).rejects.toThrow(/domain closure/);
});
test('present untracked policy is not the compatibility case', async () => {
  delete members['native-cli-identity.json'];
  delete modes['native-cli-identity.json'];
  delete members['native-cli-domain.json'];
  delete modes['native-cli-domain.json'];
  publish();
  fs.writeFileSync(path.join(root, 'native-cli-domain.json'), '{}');
  await expect(load()).rejects.toThrow(/Untracked/);
});
test('manifest bytes bind the original runtime digest, not the current pointer', async () => {
  fs.appendFileSync(path.join(root, 'manifest.json'), ' ');
  await expect(load()).rejects.toThrow(/content changed/);
});
test('oversized declared closure refuses before dormant proof reads', async () => {
  for (const pin of Object.values(source.files)) pin.sizeBytes = 4 * 1024 * 1024;
  source.node.sizeBytes = 160 * 1024 * 1024;
  // Add enough admitted finite files to exceed the aggregate, without reading them.
  for (let i = 0; i < 24; i++) {
    const name = CLI + '/large-' + i + '.js';
    add('native-prefix/' + name, '// fixture');
    source.files[name] = {
      sha256: sha(members['native-prefix/' + name]),
      sizeBytes: 4 * 1024 * 1024,
      mode: 0o644,
    };
  }
  add('native-cli-identity.json', source);
  publish();
  await expect(load()).rejects.toThrow(/closure byte bound/);
});
test('running Node outside the selected generation refuses before comparison', async () => {
  Object.defineProperty(process, 'execPath', { value: actualExecPath, configurable: true });
  await expect(load()).rejects.toThrow(/running entry/);
});
test('symlink and hardlink policy members refuse', async () => {
  const name = path.join(root, 'native-cli-identity.json'),
    target = path.join(temp, 'saved');
  fs.renameSync(name, target);
  fs.symlinkSync(target, name);
  await expect(load()).rejects.toThrow(/Unsafe/);
  fs.unlinkSync(name);
  fs.linkSync(target, name);
  await expect(load()).rejects.toThrow(/Unsafe/);
});
test('cancellation after open closes the actual owned descriptor', async () => {
  const real = fsp.open;
  let closed = false;
  jest.spyOn(fsp, 'open').mockImplementationOnce(async (...args) => {
    const handle = await real(...args),
      close = handle.close.bind(handle);
    handle.close = async () => {
      closed = true;
      return close();
    };
    controller.abort();
    return handle;
  });
  await expect(load()).rejects.toThrow(/cancelled/);
  expect(closed).toBe(true);
});
test('post-read replacement is detected by the closing bracket', async () => {
  const real = fsp.open;
  let replaced = false;
  jest.spyOn(fsp, 'open').mockImplementation(async (...args) => {
    const handle = await real(...args),
      close = handle.close.bind(handle);
    if (args[0] === path.join(root, 'native-cli-domain.json'))
      handle.close = async () => {
        await close();
        fs.appendFileSync(path.join(root, 'native-cli-identity.json'), ' ');
        replaced = true;
      };
    return handle;
  });
  await expect(load()).rejects.toThrow(/changed after capture/);
  expect(replaced).toBe(true);
});
test('an expired original does no IO and cannot be renewed with a fresh signal', async () => {
  request.deadlineEpochMs = Date.now() - 1;
  const stat = jest.spyOn(fsp, 'lstat');
  await expect(load()).rejects.toThrow(/deadline/);
  expect(stat).not.toHaveBeenCalled();
});
test('retained original signal and request cannot be replaced on a second load', async () => {
  await load();
  controller = new AbortController();
  await expect(load()).rejects.toThrow(/original replaced/);
});
test('present malformed graph cannot turn into compatibility', async () => {
  const domain = JSON.parse(members['native-cli-domain.json']);
  domain.importers = [];
  add('native-cli-domain.json', domain);
  source.domain.sha256 = sha(members['native-cli-domain.json']);
  source.domain.sizeBytes = members['native-cli-domain.json'].length;
  add('native-cli-identity.json', source);
  publish();
  await expect(load()).rejects.toThrow(/import domain/);
});
test('backward wall clock does not renew the loader original monotonic deadline', async () => {
  const { performance } = require('node:perf_hooks');
  const start = performance.now(),
    wall = Date.now();
  await load();
  jest.spyOn(Date, 'now').mockReturnValue(wall - 60000);
  jest.spyOn(performance, 'now').mockReturnValue(start + 60000);
  await expect(load()).rejects.toThrow(/deadline/);
});
test('ordinary engine original signal survives delayed first comparison and backward wall clock', async () => {
  const identity = require('../../dist/runtime/cli-identity');
  const protocol = require('../../dist/runtime/protocol');
  const live = require('../../dist/runtime/live-protocol');
  const engine = require('../../dist/runtime/engine');
  const loader = require('../../dist/runtime/cli-identity-loader');
  const { runEngineEntry } = require('../../dist/runtime/engine-entry');
  const reviewed = await load(),
    selected = path.join(temp, 'selected'),
    bin = path.join(temp, 'bin');
  fs.cpSync(path.join(root, 'native-prefix'), selected, { recursive: true });
  fs.mkdirSync(bin);
  fs.symlinkSync(path.join(selected, CLI, 'dist/index.js'), path.join(bin, 'caws'));
  fs.symlinkSync(path.join(root, 'native/node'), path.join(bin, 'node'));
  request.caller.environment = { PATH: bin, HOME: temp };
  // Real comparator positive control establishes this finite fixture can match.
  const good = await identity.compareCliIdentity({
    request: { ...request },
    reviewed,
    signal: new AbortController().signal,
  });
  expect(good.status).toBe('matched');
  const prefix = jest.fn(),
    beforeApply = jest.fn(),
    savedExit = process.exitCode;
  const prepare = jest.spyOn(engine, 'prepareRuntimeInvocation').mockImplementation(async () => {
    prefix();
    beforeApply();
    throw new Error('expired invocation reached effects');
  });
  jest.spyOn(protocol, 'decodeRuntimeRequest').mockImplementation(() => request);
  jest.spyOn(live.RuntimeFrameReader.prototype, 'read').mockResolvedValue(Buffer.from('{}'));
  jest.spyOn(live, 'writeRuntimeFrame').mockResolvedValue(undefined);
  jest.spyOn(process.stdin, 'destroy').mockReturnValue(process.stdin);
  const comparison = jest.spyOn(identity, 'compareCliIdentity');
  let originalSignal;
  const wall = Date.now();
  request.deadlineEpochMs = wall + 1000;
  request.stopPrefix = protocol.STOP_PREFIX_CAPABILITY;
  request.sessionStore = protocol.TRANSCRIPT_STORE_CAPABILITY;
  request.sessionPublication = protocol.SESSION_PUBLICATION_CAPABILITY;
  jest.useFakeTimers({ doNotFake: ['performance'] });
  jest.spyOn(loader, 'loadGenerationCliIdentity').mockImplementation(async (_request, signal) => {
    originalSignal = signal;
    await new Promise((resolve) => globalThis.setTimeout(resolve, 1001));
    // First comparator observation occurs only after original elapsed budget.
    jest.spyOn(Date, 'now').mockReturnValue(wall - 60000);
    return reviewed;
  });
  try {
    const running = runEngineEntry();
    await jest.advanceTimersByTimeAsync(1001);
    await running;
    expect(originalSignal.aborted).toBe(true);
    expect(comparison).toHaveBeenCalledTimes(1);
    expect(comparison.mock.calls[0][0].signal).toBe(originalSignal);
    expect((await comparison.mock.results[0].value).status).toBe('declined');
    expect((await comparison.mock.results[0].value).reason).toMatch(/cancelled/);
    expect(prepare).not.toHaveBeenCalled();
    expect(prefix).not.toHaveBeenCalled();
    expect(beforeApply).not.toHaveBeenCalled();
  } finally {
    jest.useRealTimers();
    process.exitCode = savedExit;
  }
});
