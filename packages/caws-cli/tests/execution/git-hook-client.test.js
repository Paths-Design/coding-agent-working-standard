const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const {
  bridgeRequest,
  runGitHookClient,
  GitHookBridgeRefused,
} = require('../../dist/execution/git-hook-client-main');
const transactionModule = require('../../dist/execution/git-hook-transaction');
const PROTOCOL = 'caws.execution.git-bridge.v1';
const roots = [];
afterEach(() => {
  jest.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function frame(body) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const head = Buffer.alloc(4);
  head.writeUInt32BE(bytes.length);
  return Buffer.concat([head, bytes]);
}
function ok(envelope, data) {
  return JSON.stringify({
    protocol: PROTOCOL,
    requestId: envelope.requestId,
    response: { status: 'ok', data },
  });
}
/** Fake only the private Native transport. All index, Source, object and pinned
 * Git operations in the client integration cases below remain real. */
function wire(reply, { fd = 4, partial = false, interrupted = false, captureOutput = false } = {}) {
  const originalWrite = fs.writeSync;
  const originalRead = fs.readSync;
  let outbound = Buffer.alloc(0);
  let inbound = Buffer.alloc(0);
  let readInterrupted = false;
  let writeInterrupted = false;
  const requests = [];
  const stdout = [];
  const stderr = [];
  jest.spyOn(fs, 'writeSync').mockImplementation((target, buffer, offset, length, position) => {
    if (captureOutput && (target === 1 || target === 2)) {
      const bytes = buffer.subarray(offset, offset + length);
      (target === 1 ? stdout : stderr).push(Buffer.from(bytes));
      return bytes.length;
    }
    if (target !== fd) return originalWrite(target, buffer, offset, length, position);
    if (interrupted && !writeInterrupted) {
      writeInterrupted = true;
      throw Object.assign(new Error('interrupted write'), { code: 'EINTR' });
    }
    const count = Math.min(length, partial ? 3 : length);
    outbound = Buffer.concat([outbound, buffer.subarray(offset, offset + count)]);
    if (outbound.length >= 4 && outbound.length === outbound.readUInt32BE(0) + 4) {
      const envelope = JSON.parse(outbound.subarray(4).toString('utf8'));
      requests.push(envelope);
      const response = reply(envelope, requests.length);
      inbound = response && response.rawFrame ? response.rawFrame : frame(response);
      outbound = Buffer.alloc(0);
    }
    return count;
  });
  jest.spyOn(fs, 'readSync').mockImplementation((target, buffer, offset, length, position) => {
    if (target !== fd) return originalRead(target, buffer, offset, length, position);
    if (interrupted && !readInterrupted) {
      readInterrupted = true;
      throw Object.assign(new Error('interrupted read'), { code: 'EINTR' });
    }
    const count = Math.min(length, inbound.length, partial ? 2 : length);
    inbound.copy(buffer, offset, 0, count);
    inbound = inbound.subarray(count);
    return count;
  });
  return {
    requests,
    output: () => ({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }),
  };
}
function rootConfig(cwd) {
  return {
    cwd,
    authorizedPaths: [],
    hooksDirectory: `${cwd}/.git/hooks`,
    hooks: { 'pre-commit': null },
    formatters: { eslint: null, prettier: null },
    readOnlyPaths: [],
  };
}

test('bridge handles partial frame I/O and EINTR with exact request identity', () => {
  const transport = wire((envelope) => ok(envelope, { failed: false }), {
    partial: true,
    interrupted: true,
  });
  expect(bridgeRequest({ operation: 'verdict' })).toEqual({ failed: false });
  expect(transport.requests).toHaveLength(1);
  expect(transport.requests[0]).toEqual({
    protocol: PROTOCOL,
    requestId: expect.stringMatching(/^[0-9a-f]{32}$/),
    request: { operation: 'verdict' },
  });
});

test.each([false, true])('Native refusal preserves userSpawnMayHaveOccurred=%s', (spawned) => {
  wire((envelope) =>
    JSON.stringify({
      protocol: PROTOCOL,
      requestId: envelope.requestId,
      response: { status: 'refused', reason: 'source_changed', userSpawnMayHaveOccurred: spawned },
    })
  );
  let error;
  try {
    bridgeRequest({ operation: 'verdict' });
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(GitHookBridgeRefused);
  expect(error.reason).toBe('source_changed');
  expect(error.userSpawnMayHaveOccurred).toBe(spawned);
});

test.each([
  'protocol',
  'identity',
  'envelope-extra',
  'response-extra',
  'data-extra',
  'array-data',
  'unknown-status',
  'reason',
])('reply %s violations refuse', (kind) => {
  wire((envelope) => {
    const reply = {
      protocol: PROTOCOL,
      requestId: envelope.requestId,
      response: { status: 'ok', data: { failed: false } },
    };
    if (kind === 'protocol') reply.protocol = 'foreign';
    if (kind === 'identity') reply.requestId = '0'.repeat(32);
    if (kind === 'envelope-extra') reply.extra = true;
    if (kind === 'response-extra') reply.response.extra = true;
    if (kind === 'data-extra') reply.response.data.extra = true;
    if (kind === 'array-data') reply.response.data = [];
    if (kind === 'unknown-status') reply.response.status = 'pending';
    if (kind === 'reason')
      reply.response = {
        status: 'refused',
        reason: 'raw error /path',
        userSpawnMayHaveOccurred: false,
      };
    return JSON.stringify(reply);
  });
  expect(() => bridgeRequest({ operation: 'verdict' })).toThrow();
});

test.each(['root', 'nested', 'escaped'])('duplicate %s JSON members refuse', (kind) => {
  wire((envelope) => {
    const id = JSON.stringify(envelope.requestId);
    if (kind === 'root')
      return `{"protocol":"${PROTOCOL}","requestId":${id},"requestId":${id},"response":{"status":"ok","data":{"failed":false}}}`;
    if (kind === 'escaped')
      return `{"protocol":"${PROTOCOL}","requestId":${id},"response":{"status":"ok","data":{"failed":false,"\\u0066ailed":true}}}`;
    return `{"protocol":"${PROTOCOL}","requestId":${id},"response":{"status":"ok","data":{"failed":false,"failed":true}}}`;
  });
  expect(() => bridgeRequest({ operation: 'verdict' })).toThrow('Duplicate JSON');
});

test.each([0, 1048577])('invalid reply length %s refuses without allocating its body', (length) => {
  wire(() => {
    const header = Buffer.alloc(4);
    header.writeUInt32BE(length);
    return { rawFrame: header };
  });
  expect(() => bridgeRequest({ operation: 'verdict' })).toThrow('reply frame limit');
});

test('invalid UTF8 refuses before JSON interpretation', () => {
  wire(() => Buffer.from([0xc3, 0x28]));
  expect(() => bridgeRequest({ operation: 'verdict' })).toThrow();
});

test('truncated reply is a failure rather than an empty successful response', () => {
  wire(() => {
    const header = Buffer.alloc(4);
    header.writeUInt32BE(20);
    return { rawFrame: Buffer.concat([header, Buffer.from('{}')]) };
  });
  expect(() => bridgeRequest({ operation: 'verdict' })).toThrow('closed before complete reply');
});

test('unknown requests and fields refuse before sending any frame', () => {
  const transport = wire((envelope) => ok(envelope, {}));
  expect(() => bridgeRequest({ operation: 'verdict', command: 'arbitrary' })).toThrow();
  expect(() => bridgeRequest({ operation: 'spawn', argv: ['arbitrary'] })).toThrow();
  expect(() => bridgeRequest({ operation: 'verdict' }, 3)).toThrow('fd unavailable');
  expect(transport.requests).toHaveLength(0);
});

test('oversized valid-shaped configuration refuses at the frame boundary', () => {
  const transport = wire((envelope) => ok(envelope, {}));
  const root = rootConfig('/repo');
  root.authorizedPaths = Array.from({ length: 2000 }, () => 'a'.repeat(600));
  expect(() => bridgeRequest({ operation: 'configure', roots: [root] })).toThrow(
    'request frame limit'
  );
  expect(transport.requests).toHaveLength(0);
});

test('configure preserves separate ordered shim directories per worktree', () => {
  const roots = [rootConfig('/canonical'), rootConfig('/lane')];
  wire((envelope) =>
    ok(envelope, {
      shimDirectories: [
        { cwd: '/canonical', shimDirectory: '/private/canonical-shims' },
        { cwd: '/lane', shimDirectory: '/private/lane-shims' },
      ],
    })
  );
  expect(bridgeRequest({ operation: 'configure', roots })).toEqual({
    shimDirectories: [
      { cwd: '/canonical', shimDirectory: '/private/canonical-shims' },
      { cwd: '/lane', shimDirectory: '/private/lane-shims' },
    ],
  });
});

test.each(['order', 'shared', 'unknown'])(
  'configure %s reply violates per-root shim identity',
  (kind) => {
    const roots = [rootConfig('/canonical'), rootConfig('/lane')];
    wire((envelope) => {
      const rows = [
        { cwd: '/canonical', shimDirectory: '/private/one' },
        { cwd: '/lane', shimDirectory: '/private/two' },
      ];
      if (kind === 'order') rows.reverse();
      if (kind === 'shared') rows[1].shimDirectory = rows[0].shimDirectory;
      if (kind === 'unknown') rows[0].extra = true;
      return ok(envelope, { shimDirectories: rows });
    });
    expect(() => bridgeRequest({ operation: 'configure', roots })).toThrow();
  }
);

test('configure preserves wide decimal-string hook identity without numeric conversion', () => {
  const root = rootConfig('/canonical');
  root.hooks['pre-commit'] = {
    path: '/canonical/.git/hooks/pre-commit',
    sha256: 'a'.repeat(64),
    dev: '18446744073709551615',
    ino: '9007199254740993',
    mode: '33261',
  };
  const transport = wire((envelope) =>
    ok(envelope, { shimDirectories: [{ cwd: '/canonical', shimDirectory: '/producer/shims' }] })
  );
  expect(bridgeRequest({ operation: 'configure', roots: [root] })).toEqual({
    shimDirectories: [{ cwd: '/canonical', shimDirectory: '/producer/shims' }],
  });
  expect(transport.requests[0].request.roots[0].hooks['pre-commit']).toEqual(
    root.hooks['pre-commit']
  );
});

test.each([
  ['dev', 1],
  ['ino', 9007199254740992],
  ['mode', 33261],
  ['dev', '01'],
  ['ino', '-1'],
  ['mode', '1e3'],
  ['dev', ''],
  ['ino', ' 1'],
])('configure refuses noncanonical %s hook identity %j before sending', (field, value) => {
  const root = rootConfig('/canonical');
  root.hooks['pre-commit'] = {
    path: '/canonical/.git/hooks/pre-commit',
    sha256: 'a'.repeat(64),
    dev: '1',
    ino: '9007199254740993',
    mode: '33261',
    [field]: value,
  };
  const transport = wire((envelope) => ok(envelope, {}));
  expect(() => bridgeRequest({ operation: 'configure', roots: [root] })).toThrow();
  expect(transport.requests).toHaveLength(0);
});

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'caws-hook-client-')));
  roots.push(root);
  const project = path.join(root, 'project');
  const producer = path.join(root, 'producer');
  const quarantine = path.join(root, 'output', 'transaction');
  fs.mkdirSync(project);
  fs.mkdirSync(producer);
  fs.mkdirSync(quarantine, { recursive: true });
  const environment = { PATH: '/usr/bin:/bin', LC_ALL: 'C', HOME: root, PWD: project };
  const git = (argv, extra = {}, input) =>
    execFileSync('/usr/bin/git', argv, {
      cwd: project,
      env: { ...environment, ...extra },
      input,
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 40 * 1024 * 1024,
    });
  git(['init', '-q']);
  fs.writeFileSync(path.join(project, 'selected.txt'), 'initial selected\n');
  fs.writeFileSync(path.join(project, 'foreign.txt'), 'initial foreign\n');
  git(['add', 'selected.txt', 'foreign.txt']);
  const index = git(['rev-parse', '--path-format=absolute', '--git-path', 'index'])
    .toString()
    .trim();
  const baseline = fs.readFileSync(index);
  const stdinPath = path.join(root, 'stdin');
  fs.writeFileSync(stdinPath, 'actual Git input\n');
  let stdinFd;
  const launch = (config = {}) => {
    const contextId = 'a'.repeat(64);
    const transport = wire(
      (envelope) => {
        const request = envelope.request;
        if (request.operation === 'open')
          return ok(envelope, {
            contextId,
            projectRoot: project,
            transactionRoot: producer,
            authorizedPaths: config.authorizedPaths ?? ['selected.txt'],
            gitEnvironment: config.cleanEnvironment ?? { ...environment, GIT_INDEX_FILE: index },
            ...(config.openExtra ?? {}),
          });
        if (request.operation === 'assert' || request.operation === 'finish')
          return ok(envelope, {});
        if (request.operation !== 'execute')
          throw new Error(`unexpected request ${request.operation}`);
        const seed = fs.readFileSync(request.seedIndexPath);
        expect(path.dirname(request.seedIndexPath)).toBe(producer);
        expect(fs.statSync(request.seedIndexPath).mode & 0o777).toBe(0o400);
        expect(createHash('sha256').update(seed).digest('hex')).toBe(request.seedIndexSha256);
        expect(seed).toEqual(baseline);
        const privateIndex = path.join(quarantine, 'index');
        const objects = path.join(quarantine, 'objects');
        fs.writeFileSync(privateIndex, seed);
        fs.mkdirSync(objects);
        const privateEnvironment = {
          GIT_INDEX_FILE: privateIndex,
          GIT_OBJECT_DIRECTORY: objects,
          GIT_ALTERNATE_OBJECT_DIRECTORIES: request.objectDirectory,
        };
        if (config.execute)
          config.execute({ git, privateEnvironment, privateIndex, index, project });
        return ok(envelope, {
          exitCode: config.exitCode ?? 0,
          stdoutBase64: Buffer.from('actual hook stdout\n').toString('base64'),
          stderrBase64: Buffer.from('actual hook stderr\n').toString('base64'),
          privateIndexPath: privateIndex,
          privateObjectDirectory: objects,
          ...(config.executeExtra ?? {}),
        });
      },
      { fd: 419, captureOutput: true, partial: !!config.partial, interrupted: !!config.interrupted }
    );
    jest.spyOn(process, 'cwd').mockReturnValue(project);
    stdinFd = fs.openSync(stdinPath, 'r');
    try {
      const status = runGitHookClient(
        config.argv ?? ['--hook', 'pre-commit', '--', 'literal argument'],
        {
          bridgeFd: 419,
          stdinFd,
          environment: config.environment ?? { ...environment, GIT_INDEX_FILE: index },
        }
      );
      return {
        status,
        requests: transport.requests.map((envelope) => envelope.request),
        ...transport.output(),
      };
    } finally {
      fs.closeSync(stdinFd);
    }
  };
  return { root, project, producer, git, index, baseline, environment, stdinPath, launch };
}

test('client uses real Git with captured stdin, Native-only formatting and truthful finished publication', () => {
  const f = fixture();
  const result = f.launch({
    partial: true,
    interrupted: true,
    execute: ({ git, privateEnvironment, project }) => {
      // This test fakes Native's settled Source effect; it proves client integration,
      // not the actual no-fork role or Host admission boundary.
      fs.writeFileSync(path.join(project, 'selected.txt'), 'Native formatted Source\n');
      git(['add', 'selected.txt'], privateEnvironment);
    },
  });
  expect(result.status).toBe(0);
  expect(result.stdout.toString()).toBe('actual hook stdout\n');
  expect(result.stderr.toString()).toBe('actual hook stderr\n');
  expect(result.requests[0]).toMatchObject({
    operation: 'open',
    cwd: f.project,
    hook: 'pre-commit',
    args: ['literal argument'],
    stdinBase64: Buffer.from('actual Git input\n').toString('base64'),
  });
  expect(result.requests[result.requests.length - 1]).toEqual({
    operation: 'finish',
    contextId: 'a'.repeat(64),
    exitCode: 0,
    publication: 'index-published',
  });
  expect(f.git(['show', ':selected.txt']).toString()).toBe('Native formatted Source\n');
  expect(f.git(['show', ':foreign.txt']).toString()).toBe('initial foreign\n');
});

test('a nonzero hook prints its diagnostics and never publishes private staging', () => {
  const f = fixture();
  const result = f.launch({
    exitCode: 23,
    execute: ({ git, privateEnvironment, project }) => {
      fs.writeFileSync(path.join(project, 'selected.txt'), 'failed hook private staging\n');
      git(['add', 'selected.txt'], privateEnvironment);
    },
  });
  expect(result.status).toBe(23);
  expect(result.stdout.toString()).toBe('actual hook stdout\n');
  expect(result.stderr.toString()).toBe('actual hook stderr\n');
  expect(fs.readFileSync(f.index)).toEqual(f.baseline);
  expect(result.requests[result.requests.length - 1]).toEqual({
    operation: 'finish',
    contextId: 'a'.repeat(64),
    exitCode: 23,
    publication: 'not-published',
  });
});

test('private staged content different from Source fails before real publication', () => {
  const f = fixture();
  const result = f.launch({
    execute: ({ git, privateEnvironment }) => {
      const oid = git(
        ['hash-object', '-w', '--stdin'],
        privateEnvironment,
        Buffer.from('private forgery\n')
      )
        .toString()
        .trim();
      git(['update-index', '--cacheinfo', `100644,${oid},selected.txt`], privateEnvironment);
    },
  });
  expect(result.status).toBe(1);
  expect(result.stderr.toString()).toContain('Private staged bytes differ from Source');
  expect(fs.readFileSync(f.index)).toEqual(f.baseline);
  expect(result.requests[result.requests.length - 1]).toMatchObject({
    operation: 'finish',
    exitCode: 1,
    publication: 'not-published',
  });
});

test('empty Source authority can validate governance-only staging', () => {
  const f = fixture();
  const result = f.launch({ authorizedPaths: [] });
  expect(result.status).toBe(0);
  expect(fs.readFileSync(f.index)).toEqual(f.baseline);
  expect(result.requests[result.requests.length - 1]).toMatchObject({
    operation: 'finish',
    publication: 'index-published',
  });
});

test('a foreign index lock remains intact and finish reports no publication', () => {
  const f = fixture();
  const result = f.launch({ execute: () => fs.writeFileSync(`${f.index}.lock`, 'foreign lock') });
  expect(result.status).toBe(1);
  expect(fs.readFileSync(f.index)).toEqual(f.baseline);
  expect(fs.readFileSync(`${f.index}.lock`, 'utf8')).toBe('foreign lock');
  expect(result.requests[result.requests.length - 1]).toMatchObject({
    operation: 'finish',
    publication: 'not-published',
  });
});

test.each(['objects-may-exist', 'index-published'])(
  'client retains truthful %s disposition after publication failure',
  (disposition) => {
    const f = fixture();
    jest.spyOn(transactionModule, 'publishGitHookTransaction').mockImplementation(() => {
      throw new transactionModule.GitHookTransactionError(
        'injected publication failure',
        disposition
      );
    });
    const result = f.launch();
    expect(result.status).toBe(1);
    expect(result.stderr.toString()).toContain('injected publication failure');
    expect(result.requests[result.requests.length - 1]).toMatchObject({
      operation: 'finish',
      exitCode: 1,
      publication: disposition,
    });
  }
);

test('callback index cannot silently be replaced by Native default index', () => {
  const f = fixture();
  const result = f.launch({ environment: { ...f.environment, GIT_INDEX_FILE: `${f.index}.next` } });
  expect(result.status).toBe(1);
  expect(result.stderr.toString()).toContain('callback index mismatch');
  expect(result.requests.map((request) => request.operation)).toEqual(['open', 'finish']);
  expect(fs.readFileSync(f.index)).toEqual(f.baseline);
});

test('forwarded Git environment drops private and Node startup controls', () => {
  const f = fixture();
  const result = f.launch({
    environment: {
      ...f.environment,
      GIT_INDEX_FILE: f.index,
      NODE_OPTIONS: '--require arbitrary',
      CAWS_EXECUTION_SESSION: 'private',
      CAWS_NATIVE_FENCE_FD: '3',
      SECRET_TOKEN: 'private',
      GIT_AUTHOR_NAME: 'Author',
      GIT_CONFIG_COUNT: '3',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
      GIT_CONFIG_VALUE_0: '/producer/shims',
      GIT_CONFIG_KEY_1: 'maintenance.auto',
      GIT_CONFIG_VALUE_1: 'false',
      GIT_CONFIG_KEY_2: 'gc.auto',
      GIT_CONFIG_VALUE_2: '0',
    },
  });
  expect(result.status).toBe(0);
  expect(result.requests[0].gitEnvironment).toEqual({
    ...f.environment,
    GIT_INDEX_FILE: f.index,
    GIT_AUTHOR_NAME: 'Author',
    GIT_CONFIG_COUNT: '3',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: '/producer/shims',
    GIT_CONFIG_KEY_1: 'maintenance.auto',
    GIT_CONFIG_VALUE_1: 'false',
    GIT_CONFIG_KEY_2: 'gc.auto',
    GIT_CONFIG_VALUE_2: '0',
  });
});

test.each([
  { GIT_CONFIG_PARAMETERS: '' },
  { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'x', GIT_CONFIG_VALUE_0: 'y' },
  { GIT_CONFIG_KEY_0: 'x', GIT_CONFIG_VALUE_0: 'y' },
  { GIT_CONFIG_COUNT: '65' },
  { GIT_CONFIG_COUNT: '0', GIT_CONFIG_KEY_01: 'x' },
])('unsupported or incomplete Git configuration refuses before open: %j', (extra) => {
  const f = fixture();
  const result = f.launch({ environment: { ...f.environment, ...extra } });
  expect(result.status).toBe(1);
  expect(result.requests).toHaveLength(0);
  expect(fs.readFileSync(f.index)).toEqual(f.baseline);
});

test('stdin limit refuses before opening a Native context', () => {
  const f = fixture();
  fs.writeFileSync(f.stdinPath, Buffer.alloc(524289));
  const result = f.launch();
  expect(result.status).toBe(1);
  expect(result.stderr.toString()).toContain('stdin limit');
  expect(result.requests).toHaveLength(0);
});

test.each([-1, 256])('invalid or signal-only hook exit %s cannot become success', (exitCode) => {
  const f = fixture();
  const result = f.launch({ exitCode });
  expect(result.status).toBe(1);
  expect(fs.readFileSync(f.index)).toEqual(f.baseline);
  expect(result.requests[result.requests.length - 1]).toMatchObject({
    operation: 'finish',
    exitCode: 1,
    publication: 'not-published',
  });
});

test.each([
  ['--hook', 'pre-commit'],
  ['--hook', '../arbitrary', '--'],
  ['--command', 'git', '--'],
])('CLI accepts only bounded hook callback arguments %j', (argv) => {
  const f = fixture();
  const result = f.launch({ argv });
  expect(result.status).toBe(1);
  expect(result.requests).toHaveLength(0);
});
