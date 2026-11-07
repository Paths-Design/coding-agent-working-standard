'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { openCustody } = require('../../scripts/native-qualification-custody.cjs');
const root = path.resolve(__dirname, '../..');
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const relative = (file) => path.relative(root, file).split(path.sep).join('/');
let fixture, request, requestFile;
beforeEach(() => {
  fs.mkdirSync(path.join(root, 'reports'), { recursive: true });
  fixture = fs.mkdtempSync(path.join(root, 'reports/custody-unit-'));
  const input = (name, executable = false) => {
    const file = path.join(fixture, name);
    const bytes = Buffer.from(`controlled fixture ${name}\n`);
    fs.writeFileSync(file, bytes);
    fs.chmodSync(file, executable ? 0o755 : 0o644);
    return { path: relative(file), sha256: hash(bytes) };
  };
  request = {
    schema: 'caws.native-session.request.v1',
    surface: 'codex',
    candidate: { commit: 'a'.repeat(40), tarball: input('candidate.tgz') },
    host: { image: input('host', true), provenance: { kind: 'unit-fixture' } },
    node: input('node', true),
    runtime: { entry: 'legacy' },
    paths: Object.fromEntries(
      ['profile', 'consumer', 'project', 'output'].map((name) => [
        name,
        relative(path.join(fixture, name)),
      ])
    ),
    scenario: {
      ownedFile: relative(path.join(fixture, 'project/owned.txt')),
      protectedFile: relative(path.join(fixture, 'project/protected.txt')),
    },
    budgetMs: 180000,
  };
  requestFile = path.join(fixture, 'request.json');
});
afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(fixture, { recursive: true, force: true });
});
const open = () => {
  fs.writeFileSync(requestFile, JSON.stringify(request));
  return openCustody(requestFile);
};

// Schema/pinning fixtures only; the installed CLI owns full v2 validation.
function nativeDescriptor(schema = 'caws.runtime.native-image-input.v2') {
  const file = path.join(fixture, 'native-image.json');
  const bytes = Buffer.from(JSON.stringify({ schema }));
  fs.writeFileSync(file, bytes, { mode: 0o644 });
  request.runtime = {
    entry: 'native',
    nativeImage: { path: relative(file), sha256: hash(bytes) },
  };
  return file;
}
test.each([
  undefined,
  null,
  {},
  { entry: 'automatic' },
  { entry: 'native' },
  { entry: 'legacy', nativeImage: { path: 'unused', sha256: '0'.repeat(64) } },
])('runtime selection is explicit and discriminated: %p', (runtime) => {
  request.runtime = runtime;
  expect(open).toThrow();
  expect(fs.existsSync(path.join(fixture, 'profile'))).toBe(false);
});
test('captures the native descriptor separately from the harness image', () => {
  const file = nativeDescriptor();
  const custody = open();
  expect(custody.inputs.runtime).toMatchObject({
    entry: 'native',
    nativeImage: { path: file, sha256: request.runtime.nativeImage.sha256, mode: 0o644 },
  });
  expect(custody.inputs.host.image.path).not.toBe(file);
  expect(custody.revalidateInputs().nativeImage.sha256).toBe(request.runtime.nativeImage.sha256);
});
test.each(['v1', 'malformed', 'hash', 'symlink', 'escape', 'profile'])(
  'rejects unsuitable native descriptor before command execution: %s',
  (kind) => {
    const file = nativeDescriptor();
    if (kind === 'v1') {
      const bytes = Buffer.from(JSON.stringify({ schema: 'caws.runtime.native-image-input.v1' }));
      fs.writeFileSync(file, bytes);
      request.runtime.nativeImage.sha256 = hash(bytes);
    } else if (kind === 'malformed') {
      fs.writeFileSync(file, '{');
      request.runtime.nativeImage.sha256 = hash('{');
    } else if (kind === 'hash') request.runtime.nativeImage.sha256 = '0'.repeat(64);
    else if (kind === 'symlink') {
      const alias = path.join(fixture, 'native-alias.json');
      fs.symlinkSync(file, alias);
      request.runtime.nativeImage.path = relative(alias);
    } else if (kind === 'escape') request.runtime.nativeImage.path = '../native-image.json';
    else {
      const privateFile = path.join(fixture, 'profile/native-image.json');
      fs.mkdirSync(path.dirname(privateFile), { mode: 0o700 });
      fs.copyFileSync(file, privateFile);
      request.runtime.nativeImage.path = relative(privateFile);
    }
    expect(open).toThrow();
  }
);
test('native descriptor mode drift prevents command launch', () => {
  const file = nativeDescriptor();
  const custody = open();
  fs.chmodSync(file, 0o444);
  const marker = path.join(fixture, 'forbidden-marker');
  expect(() =>
    custody.run('image-mode-drift', [
      process.execPath,
      '-e',
      'require("node:fs").writeFileSync(process.argv[1],"ran")',
      marker,
    ])
  ).toThrow('Command failed');
  expect(fs.existsSync(marker)).toBe(false);
});
test('post-command descriptor drift preserves streams and fails the operation', () => {
  const file = nativeDescriptor();
  const custody = open();
  let failure;
  try {
    custody.run('image-drift-after', [
      process.execPath,
      '-e',
      'require("node:fs").appendFileSync(process.argv[1]," ");process.stdout.write("completed-before-drift-check")',
      file,
    ]);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeDefined();
  const retained = JSON.parse(fs.readFileSync(failure.receipt.path)).data;
  expect(retained.status).toBe(0);
  expect(Buffer.from(retained.stdoutBase64, 'base64').toString()).toBe(
    'completed-before-drift-check'
  );
  expect(retained.inputValidation.error.phase).toBe('after');
});
test.each(['request', 'tooling', 'registry'])(
  'revalidates the captured original %s identity before launch',
  (name) => {
    const custody = open();
    const target = custody.inputs[name].path;
    const descriptors = new Map();
    const originalOpen = fs.openSync;
    const originalRead = fs.readSync;
    jest.spyOn(fs, 'openSync').mockImplementation((file, ...args) => {
      const fd = originalOpen(file, ...args);
      descriptors.set(fd, file);
      return fd;
    });
    jest.spyOn(fs, 'readSync').mockImplementation((fd, buffer, offset, ...args) => {
      const count = originalRead(fd, buffer, offset, ...args);
      if (descriptors.get(fd) === target && count > 0) buffer[offset] ^= 1;
      return count;
    });
    const marker = path.join(fixture, 'must-not-run');
    expect(() =>
      custody.run('changed-' + name, [
        process.execPath,
        '-e',
        'require("node:fs").writeFileSync(process.argv[1],"ran")',
        marker,
      ])
    ).toThrow('Command failed');
    expect(fs.existsSync(marker)).toBe(false);
  }
);

test('growing input is bounded and rejected before command launch', () => {
  const file = nativeDescriptor();
  const custody = open();
  const originalSize = fs.statSync(file).size;
  const descriptors = new Map();
  const originalOpen = fs.openSync,
    originalRead = fs.readSync;
  let grew = false,
    readBytes = 0;
  jest.spyOn(fs, 'openSync').mockImplementation((selected, ...args) => {
    const fd = originalOpen(selected, ...args);
    descriptors.set(fd, selected);
    return fd;
  });
  jest.spyOn(fs, 'readSync').mockImplementation((fd, ...args) => {
    const count = originalRead(fd, ...args);
    if (descriptors.get(fd) === file) {
      readBytes += count;
      if (!grew) {
        grew = true;
        fs.appendFileSync(file, Buffer.alloc(1024 * 1024, 120));
      }
    }
    return count;
  });
  const marker = path.join(fixture, 'must-not-launch-after-growth');
  expect(() =>
    custody.run('growth', [
      process.execPath,
      '-e',
      'require("node:fs").writeFileSync(process.argv[1],"ran")',
      marker,
    ])
  ).toThrow('Command failed');
  expect(grew).toBe(true);
  expect(readBytes).toBe(originalSize + 1);
  expect(fs.existsSync(marker)).toBe(false);
});

test('preserves the first receipt and refuses replacement', () => {
  const custody = open();
  const first = custody.record('observation', { observed: 'original' });
  const before = fs.readFileSync(first.path);
  expect(hash(before)).toBe(first.sha256);
  expect(fs.statSync(first.path).mode & 0o777).toBe(0o600);
  expect(() => custody.record('observation', { observed: 'replacement' })).toThrow();
  expect(fs.readFileSync(first.path)).toEqual(before);
  expect(() => custody.record('../escape', {})).toThrow('Invalid receipt label');
});

test.each(['../escape', '/absolute', 'reports/../escape', 'reports/./escape'])(
  'rejects nonnormalized generated root %s before creating private state',
  (value) => {
    request.paths.output = value;
    expect(open).toThrow();
    expect(fs.existsSync(path.join(fixture, 'profile'))).toBe(false);
  }
);
test('a changed pin refuses before private state is created', () => {
  fs.appendFileSync(path.join(root, request.host.image.path), 'changed');
  expect(open).toThrow('Public input hash mismatch');
  expect(fs.existsSync(path.join(fixture, 'profile'))).toBe(false);
});
test('refuses a symbolic-link input before opening it', () => {
  const original = path.join(root, request.candidate.tarball.path);
  const alias = path.join(fixture, 'alias.tgz');
  fs.symlinkSync(original, alias);
  request.candidate.tarball.path = relative(alias);
  const opened = jest.spyOn(fs, 'openSync');
  expect(open).toThrow('Symbolic-link path refused');
  expect(opened.mock.calls.some(([file]) => file === alias)).toBe(false);
});
test('refuses credential-shaped public inputs before opening them', () => {
  const sensitive = path.join(fixture, '.env');
  fs.writeFileSync(sensitive, 'fixture only');
  request.candidate.tarball = { path: relative(sensitive), sha256: hash('fixture only') };
  const opened = jest.spyOn(fs, 'openSync');
  expect(open).toThrow('Sensitive path is not a public input');
  expect(opened.mock.calls.some(([file]) => file === sensitive)).toBe(false);
});
test('captures scoped sentinel bytes and refuses unrelated capture', () => {
  const custody = open();
  const owned = custody.resolvePath(request.scenario.ownedFile);
  fs.writeFileSync(owned, Buffer.from([0, 255, 10]));
  const result = custody.capture(request.scenario.ownedFile, { bytes: true });
  expect(result).toMatchObject({
    kind: 'file',
    bytesBase64: 'AP8K',
    sha256: hash(Buffer.from([0, 255, 10])),
  });
  expect(custody.capture(request.scenario.protectedFile)).toMatchObject({ kind: 'missing' });
  expect(() => custody.capture(request.candidate.tarball.path)).toThrow('Capture is limited');
});
test('retains nonzero status and lossless streams before throwing', () => {
  const custody = open();
  const argv = [
    process.execPath,
    '-e',
    'process.stdout.write(Buffer.from([255,0,10]));process.stderr.write("failure witness");process.exitCode=7',
  ];
  let failure;
  try {
    custody.run('failed-command', argv);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeDefined();
  const retained = JSON.parse(fs.readFileSync(failure.receipt.path)).data;
  expect(retained).toMatchObject({
    argv,
    status: 7,
    signal: null,
    error: null,
    stdoutBase64: '/wAK',
    stderrBase64: Buffer.from('failure witness').toString('base64'),
  });
});
test('does not inherit caller credentials or identity into a command', () => {
  jest.replaceProperty(process, 'env', {
    ...process.env,
    CAWS_UNIT_PRIVATE_TOKEN: 'fixture-secret',
    CAWS_SESSION_ID: 'foreign-fixture',
  });
  const custody = open();
  const result = custody.run('environment', [
    process.execPath,
    '-e',
    'console.log(JSON.stringify({tokenPresent:Object.hasOwn(process.env,"CAWS_UNIT_PRIVATE_TOKEN"),identityPresent:Object.hasOwn(process.env,"CAWS_SESSION_ID"),cwd:process.cwd(),home:process.env.HOME}))',
  ]);
  expect(JSON.parse(result.stdout)).toEqual({
    tokenPresent: false,
    identityPresent: false,
    cwd: custody.resolvePath(request.paths.project),
    home: custody.env.HOME,
  });
  expect(custody.env.HOME.startsWith(custody.resolvePath(request.paths.profile) + path.sep)).toBe(
    true
  );
});
test('expired original budget records refusal without starting the command', async () => {
  request.budgetMs = 20;
  const custody = open();
  await new Promise((resolve) => globalThis.setTimeout(resolve, 30));
  const marker = path.join(fixture, 'should-not-exist');
  let failure;
  try {
    custody.run('expired', [
      process.execPath,
      '-e',
      'require("node:fs").writeFileSync(process.argv[1],"ran")',
      marker,
    ]);
  } catch (error) {
    failure = error;
  }
  expect(failure.observation).toMatchObject({
    status: null,
    signal: null,
    error: { message: 'Budget expired' },
  });
  expect(fs.existsSync(marker)).toBe(false);
});
test('revalidation rejects persistent input or mode changes', () => {
  const custody = open();
  fs.chmodSync(path.join(root, request.host.image.path), 0o555);
  expect(custody.revalidateInputs).toThrow('Public input mode changed');
});
test.each(['equal', 'inside', 'outside'])(
  'rejects overlapping profile and consumer roots: %s',
  (kind) => {
    request.paths.consumer =
      kind === 'equal'
        ? request.paths.profile
        : kind === 'inside'
          ? request.paths.profile + '/consumer'
          : relative(fixture);
    expect(open).toThrow('pairwise separate');
    expect(fs.existsSync(path.join(fixture, 'profile'))).toBe(false);
  }
);
test('public receipt reads exclude private profiles and symlinks before opening', () => {
  const custody = open();
  const privateFile = path.join(fixture, 'profile/receipt.json');
  fs.writeFileSync(privateFile, 'private fixture');
  const publicFile = path.join(fixture, 'public.json');
  fs.writeFileSync(publicFile, 'public fixture');
  const alias = path.join(fixture, 'alias.json');
  fs.symlinkSync(privateFile, alias);
  const opened = jest.spyOn(fs, 'openSync');
  expect(() => custody.readPublic(relative(privateFile))).toThrow('private profile');
  expect(() => custody.readPublic(relative(alias))).toThrow('Symbolic-link');
  expect(opened.mock.calls.some(([file]) => file === privateFile || file === alias)).toBe(false);
  expect(custody.readPublic(relative(publicFile)).bytes.toString()).toBe('public fixture');
});
