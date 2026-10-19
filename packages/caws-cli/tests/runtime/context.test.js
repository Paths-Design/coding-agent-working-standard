const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  invocationCaller,
  invocationEnvironment,
  resolveRuntimeProject,
  createContextGitPort,
} = require('../../dist/runtime/context');
const { resolveGitBinary, resolveGitBinaryForEnvironment } = require('../../dist/store/git-binary');
const { repoRootFromGitCommonDir, resolveRepoRoot } = require('../../dist/store/repo-root');

let root;
const git = resolveGitBinary();
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'caws-context-')));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});
const caller = (cwd, environment = process.env) => invocationCaller(cwd, environment);
const deadline = () => Date.now() + 5000;
function initialize(directory) {
  fs.mkdirSync(directory, { recursive: true });
  execFileSync(git, ['init', '-q', directory]);
  return directory;
}
function script(name, body) {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}

test('captures immutable request environment and strips inherited routing without changing ambient state', () => {
  const environment = {
    PATH: '/usr/bin',
    GIT_DIR: '/foreign',
    GIT_WORK_TREE: '/foreign',
    HOOK_COMMAND: 'old',
    KEEP: 'yes',
    UNSET: undefined,
  };
  const captured = caller(root, environment);
  environment.KEEP = 'later';
  expect(invocationEnvironment(captured)).toEqual({ PATH: '/usr/bin', KEEP: 'yes' });
  expect(captured.environment.GIT_DIR).toBe('/foreign');
  expect(Object.isFrozen(captured)).toBe(true);
  expect(Object.isFrozen(captured.environment)).toBe(true);
  expect(environment.HOOK_COMMAND).toBe('old');
});

test.each([
  ['relative', {}],
  ['/valid\0bad', {}],
  ['/valid', { 'A=B': 'value' }],
  ['/valid', { '': 'value' }],
  ['/valid', { X: 'bad\0value' }],
])('rejects invalid native caller context %#', (cwd, env) => {
  expect(() => caller(cwd, env)).toThrow(/Caller/);
});

test('real linked checkout keeps checkout identity while sharing the owning store canonical mapping', async () => {
  const canonical = initialize(path.join(root, 'main'));
  execFileSync(git, [
    '-C',
    canonical,
    '-c',
    'user.name=CAWS test',
    '-c',
    'user.email=caws@example.test',
    'commit',
    '--allow-empty',
    '-qm',
    'fixture',
  ]);
  const linked = path.join(root, 'linked');
  execFileSync(git, ['-C', canonical, 'worktree', 'add', '-q', '-b', 'fixture-linked', linked]);
  const nested = path.join(linked, 'nested');
  fs.mkdirSync(nested);
  const context = await resolveRuntimeProject(
    { cwd: nested },
    caller(root, { ...process.env, GIT_DIR: '/foreign/missing', GIT_WORK_TREE: '/foreign' }),
    deadline()
  );
  expect(context).toEqual({ status: 'resolved', checkout: linked, canonical });
  expect(resolveRepoRoot(linked).value).toEqual({
    repoRoot: canonical,
    cawsDir: path.join(canonical, '.caws'),
  });
  expect(repoRootFromGitCommonDir(path.join(canonical, '.git'))).toEqual({
    repoRoot: canonical,
    cawsDir: path.join(canonical, '.caws'),
  });
});

test('payload cwd, project directory and caller cwd resolve in that order with request-relative paths', async () => {
  const a = initialize(path.join(root, 'a'));
  const b = initialize(path.join(root, 'b'));
  const c = caller(root, { ...process.env, CAWS_PROJECT_DIR: b });
  expect(await resolveRuntimeProject({ cwd: 'a' }, c, deadline())).toEqual({
    status: 'resolved',
    checkout: a,
    canonical: a,
  });
  expect(await resolveRuntimeProject({ cwd: '' }, c, deadline())).toEqual({
    status: 'resolved',
    checkout: b,
    canonical: b,
  });
  expect(await resolveRuntimeProject({}, caller(a), deadline())).toEqual({
    status: 'resolved',
    checkout: a,
    canonical: a,
  });
});

test('outside Git is quiet; a broken governance ancestor produces an explicit inactive diagnostic', async () => {
  expect(await resolveRuntimeProject({}, caller(root), deadline())).toEqual({
    status: 'inactive',
    reason: 'outside a resolvable Git project',
    diagnostic: '',
  });
  fs.mkdirSync(path.join(root, '.caws'));
  const context = await resolveRuntimeProject({}, caller(root), deadline());
  expect(context.status).toBe('inactive');
  expect(context.diagnostic).toContain('continuing without CAWS governance');
  expect(context.diagnostic).toContain(root);
});

test('canonical lookup failure after checkout resolution is a configuration error', async () => {
  const port = {
    run: jest
      .fn()
      .mockResolvedValueOnce(root)
      .mockRejectedValueOnce(new Error('common directory failed')),
  };
  await expect(resolveRuntimeProject({}, caller(root), deadline(), port)).rejects.toThrow(
    'common directory failed'
  );
  await expect(resolveRuntimeProject({ cwd: 7 }, caller(root), deadline(), port)).rejects.toThrow(
    'cwd must be a string'
  );
  expect(port.run).toHaveBeenCalledTimes(2);
  expect(() => repoRootFromGitCommonDir('relative')).toThrow('must be absolute');
});

test.each([0, false, [], {}])(
  'malformed cwd does not silently select another project %#',
  async (cwd) => {
    await expect(resolveRuntimeProject({ cwd }, caller(root), deadline())).rejects.toThrow(
      'cwd must be a string'
    );
  }
);

test('caller executable resolution is isolated from resident cache and resolves relative PATH against caller cwd', () => {
  const a = script('a/git', 'exit 0');
  const b = script('b/git', 'exit 0');
  expect(resolveGitBinaryForEnvironment({ PATH: 'a' }, root)).toBe(a);
  expect(resolveGitBinaryForEnvironment({ PATH: 'b' }, root)).toBe(b);
  expect(resolveGitBinaryForEnvironment({ PATH: ':', CAWS_GIT_BINARY: '' }, root)).toBeUndefined();
  expect(resolveGitBinaryForEnvironment({ PATH: 'b', CAWS_GIT_BINARY: 'git' }, root)).toBe(b);
  expect(resolveGitBinaryForEnvironment({ CAWS_GIT_BINARY: './a/git' }, root)).toBe(a);
  expect(resolveGitBinaryForEnvironment({ CAWS_GIT_BINARY: a }, root)).toBe(a);
  expect(resolveGitBinary()).toBe(git);
});

test('interleaved fake Git callers use their own environment and executable', async () => {
  const a = script('a/git', 'printf "%s" "$MARKER"');
  const b = script('b/git', 'printf "%s" "$MARKER"');
  const results = await Promise.all([
    createContextGitPort(
      caller(root, { PATH: '/usr/bin', CAWS_GIT_BINARY: a, MARKER: 'first' }),
      deadline()
    ).run([], root),
    createContextGitPort(
      caller(root, { PATH: '/usr/bin', CAWS_GIT_BINARY: b, MARKER: 'second' }),
      deadline()
    ).run([], root),
  ]);
  expect(results).toEqual(['first', 'second']);
});

test.each(['stdout', 'stderr'])(
  'invalid UTF8 on Git %s cannot select an authority root through replacement decoding',
  async (channel) => {
    const file = script('invalid-utf8', `printf '\\377' ${channel === 'stderr' ? '>&2' : ''}`);
    await expect(
      createContextGitPort(caller(root, { CAWS_GIT_BINARY: file }), deadline()).run([], root)
    ).rejects.toThrow('not valid UTF-8');
  }
);

test('Git response limits reject elapsed deadlines, unavailable executables, oversized output and process errors', async () => {
  const slow = script('slow', 'exec /bin/sleep 5');
  const port = createContextGitPort(caller(root, { CAWS_GIT_BINARY: slow }), Date.now() + 50);
  await expect(port.run([], root)).rejects.toThrow(/timed out|expired/);
  await expect(
    createContextGitPort(caller(root, { PATH: '' }), deadline()).run([], root)
  ).rejects.toThrow('unavailable');
  const large = script('large', 'exec /usr/bin/head -c 1048577 /dev/zero');
  await expect(
    createContextGitPort(caller(root, { CAWS_GIT_BINARY: large }), deadline()).run([], root)
  ).rejects.toThrow('byte limit');
  const broken = script('broken', 'echo precise-error >&2; exit 4');
  await expect(
    createContextGitPort(caller(root, { CAWS_GIT_BINARY: broken }), deadline()).run([], root)
  ).rejects.toThrow('precise-error');
  await expect(
    createContextGitPort(caller(root, { CAWS_GIT_BINARY: '/missing/git' }), deadline()).run(
      [],
      root
    )
  ).rejects.toThrow('ENOENT');
  expect(() => createContextGitPort(caller(root), NaN)).toThrow('integer');
});
