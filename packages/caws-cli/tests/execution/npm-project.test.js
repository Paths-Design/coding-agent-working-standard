const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { snapshotNpmProject } = require('../../dist/execution/npm-project');

const roots = [];
afterAll(() =>
  roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true }))
);
function fixture() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'caws-npm-path-')));
  roots.push(root);
  const cwd = path.join(root, 'project');
  fs.mkdirSync(cwd);
  fs.writeFileSync(
    path.join(cwd, 'package.json'),
    JSON.stringify({ workspaces: ['packages/*'], scripts: { test: 'jest' } })
  );
  const safePath = [
    ...new Set(
      [path.dirname(fs.realpathSync.native(process.execPath)), '/usr/bin', '/bin'].map((p) =>
        fs.realpathSync.native(p)
      )
    ),
  ].join(':');
  const snapshot = () => snapshotNpmProject(cwd, safePath, Date.now() + 30000);
  return { root, cwd, safePath, snapshot };
}
function bin(root) {
  const result = path.join(root, 'node_modules', '.bin');
  fs.mkdirSync(result, { recursive: true });
  return result;
}

test('captures ordinary package bins and permits explicit-prefix workspace package roots', () => {
  const f = fixture();
  const target = path.join(f.cwd, 'jest.js');
  fs.writeFileSync(target, 'console.log("test")\n');
  fs.symlinkSync('../../jest.js', path.join(bin(f.cwd), 'jest'));
  const first = f.snapshot();
  expect(first).toEqual(f.snapshot());
  expect(first.testScript).toBe('jest');
  expect(first.packageJson.path).toBe(path.join(f.cwd, 'package.json'));
  expect(first.pathShadowSha256).toMatch(/^[a-f0-9]{64}$/);
});

test.each(['node', 'npm', 'npx', 'sh', 'Node', 'SH', 'no\u200dde'])(
  'refuses project and ancestor protected role %s',
  (name) => {
    for (const ancestor of [false, true]) {
      const f = fixture();
      fs.writeFileSync(path.join(bin(ancestor ? f.root : f.cwd), name), 'fake green\n', {
        mode: 0o755,
      });
      expect(f.snapshot).toThrow('Execution authority is unavailable');
    }
  }
);

test('refuses package paths that split npm lifecycle PATH entries', () => {
  const f = fixture();
  const colon = f.cwd + ':package';
  fs.renameSync(f.cwd, colon);
  expect(() => snapshotNpmProject(colon, f.safePath, Date.now() + 30000)).toThrow();
});

test('observes entry, mode, target bytes, symlink and directory replacements', () => {
  const f = fixture();
  const directory = bin(f.root);
  const firstTarget = path.join(f.root, 'first.js');
  const secondTarget = path.join(f.root, 'second.js');
  fs.writeFileSync(firstTarget, 'first\n');
  fs.writeFileSync(secondTarget, 'second\n');
  const link = path.join(directory, 'jest');
  fs.symlinkSync(firstTarget, link);
  let previous = f.snapshot().pathShadowSha256;
  for (const change of [
    () => fs.writeFileSync(firstTarget, 'changed\n'),
    () => fs.chmodSync(firstTarget, 0o755),
    () => {
      fs.unlinkSync(link);
      fs.symlinkSync(secondTarget, link);
    },
    () => {
      fs.renameSync(directory, directory + '-old');
      fs.mkdirSync(directory);
      fs.symlinkSync(secondTarget, link);
    },
    () => fs.unlinkSync(link),
  ]) {
    change();
    const next = f.snapshot().pathShadowSha256;
    expect(next).not.toBe(previous);
    previous = next;
  }
});

test('accepts verified absence and refuses dangling paths and lifecycle hooks', () => {
  const f = fixture();
  expect(f.snapshot().npmrc).toBeNull();
  fs.symlinkSync('missing', path.join(f.cwd, 'node_modules'));
  expect(f.snapshot).toThrow();
  fs.unlinkSync(path.join(f.cwd, 'node_modules'));
  fs.symlinkSync('missing', path.join(f.cwd, '.npmrc'));
  expect(f.snapshot).toThrow();
  fs.unlinkSync(path.join(f.cwd, '.npmrc'));
  fs.writeFileSync(
    path.join(f.cwd, 'package.json'),
    '{"scripts":{"test":"jest","posttest":"node alter.js"}}'
  );
  expect(f.snapshot).toThrow();
});

test('pins inert project reporting settings and the overridden literal cache operand', () => {
  const f = fixture(),
    file = path.join(f.cwd, '.npmrc');
  const content =
    '# bounded project settings\ncache=../outside-cache\naudit=false\nfund=false\nupdate-notifier=false\n';
  fs.writeFileSync(file, content);
  const before = fs.readFileSync(file);
  const first = f.snapshot();
  expect(first.npmrc).toEqual({
    path: file,
    sha256: require('node:crypto').createHash('sha256').update(before).digest('hex'),
  });
  expect(f.snapshot()).toEqual(first);
  expect(fs.readFileSync(file)).toEqual(before);
  expect(fs.existsSync(path.join(f.root, 'outside-cache'))).toBe(false);
  fs.writeFileSync(file, 'cache=../another-cache\n');
  expect(f.snapshot().npmrc.sha256).not.toBe(first.npmrc.sha256);
});
test.each([
  'registry=https://example.invalid\n',
  '_authToken=not-a-real-token\n',
  'script-shell=/bin/sh\n',
  'audit=true\n',
  'fund=false\nfund=false\n',
  'cache=${HOME}/cache\n',
  'cache=https://example.invalid\n',
  'cache=one=two\n',
  '[section]\n',
  'cache=some\\path\n',
  'cache=\n',
  'audit=false\0\n',
])('refuses unsupported project configuration %j', (content) => {
  const f = fixture();
  fs.writeFileSync(path.join(f.cwd, '.npmrc'), content);
  expect(f.snapshot).toThrow('Execution authority is unavailable');
});
test('refuses config hard links and changes admitted config identity without mutating it', () => {
  const f = fixture(),
    file = path.join(f.cwd, '.npmrc');
  fs.writeFileSync(file, 'audit=false\n');
  const original = f.snapshot().npmrc;
  fs.linkSync(file, path.join(f.root, 'config-alias'));
  expect(f.snapshot).toThrow();
  fs.unlinkSync(path.join(f.root, 'config-alias'));
  fs.writeFileSync(file, 'fund=false\n');
  expect(f.snapshot().npmrc.sha256).not.toBe(original.sha256);
});
const protectedFixture = process.env.CAWS_NPM_PROJECT_FIXTURE_ROOT;
(protectedFixture ? test : test.skip)(
  'observes the frozen real workflow npm configuration without editing inputs',
  () => {
    const root = fs.realpathSync.native(protectedFixture);
    const safePath = [
      path.dirname(fs.realpathSync.native(process.execPath)),
      '/usr/bin',
      '/bin',
    ].join(':');
    const first = snapshotNpmProject(root, safePath, Date.now() + 30000);
    expect(first.npmrc.path).toBe(path.join(root, '.npmrc'));
    expect(first.npmrc.sha256).toBe(
      '067b1efd5f43ac5e70b38bb4cfcce066bed73033d585c155dd4c5a5a779ffee2'
    );
    expect(snapshotNpmProject(root, safePath, Date.now() + 30000)).toEqual(first);
  }
);

test('refuses entry overflow and expires without reading package effects', () => {
  const f = fixture();
  const directory = bin(f.cwd);
  for (let i = 0; i < 1025; i++)
    fs.symlinkSync('../../package.json', path.join(directory, `tool-${i}`));
  expect(f.snapshot).toThrow();
  expect(() => snapshotNpmProject(f.cwd, f.safePath, Date.now() - 1)).toThrow();
});
