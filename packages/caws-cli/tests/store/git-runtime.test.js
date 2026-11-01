const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { withExecutionGitRuntime, executionGitOptions } = require('../../dist/store/git-runtime');
const { resolveRepoRoot } = require('../../dist/store/repo-root');

const temporary = [];
let inheritedConfig;
function configName(name) {
  return (
    name === 'GIT_CONFIG_COUNT' ||
    name === 'GIT_CONFIG_PARAMETERS' ||
    /^GIT_CONFIG_(?:KEY|VALUE)_/.test(name)
  );
}
beforeEach(() => {
  inheritedConfig = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => configName(name))
  );
  for (const name of Object.keys(process.env)) if (configName(name)) delete process.env[name];
});
afterEach(() => {
  for (const name of Object.keys(process.env)) if (configName(name)) delete process.env[name];
  Object.assign(process.env, inheritedConfig);
  for (const root of temporary.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'caws-git-runtime-')));
  temporary.push(root);
  const canonical = path.join(root, 'canonical');
  const lane = path.join(root, 'lane');
  const canonicalShim = path.join(root, 'canonical-shims');
  const laneShim = path.join(root, 'lane-shims');
  for (const directory of [canonical, lane, canonicalShim, laneShim]) fs.mkdirSync(directory);
  const runtime = {
    shimDirectories: [
      { cwd: canonical, shimDirectory: canonicalShim },
      { cwd: lane, shimDirectory: laneShim },
    ],
    bridgeFd: 4,
  };
  return { root, canonical, lane, canonicalShim, laneShim, runtime };
}
function transient(shimDirectory) {
  return {
    GIT_OPTIONAL_LOCKS: '0',
    GIT_CONFIG_COUNT: '3',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: shimDirectory,
    GIT_CONFIG_KEY_1: 'maintenance.auto',
    GIT_CONFIG_VALUE_1: 'false',
    GIT_CONFIG_KEY_2: 'gc.auto',
    GIT_CONFIG_VALUE_2: '0',
  };
}

test('runtime installs per-root transient config and fd4 without altering process environment', () => {
  const f = fixture();
  const before = { ...process.env };
  const result = withExecutionGitRuntime(f.runtime, () => {
    const canonical = executionGitOptions(f.canonical);
    const lane = executionGitOptions(f.lane);
    expect(canonical).toEqual({
      env: { ...before, ...transient(f.canonicalShim) },
      stdio: ['ignore', 'pipe', 'pipe', 'ignore', 4],
    });
    expect(lane).toEqual({
      env: { ...before, ...transient(f.laneShim) },
      stdio: ['ignore', 'pipe', 'pipe', 'ignore', 4],
    });
    return 'effect result';
  });
  expect(result).toBe('effect result');
  expect(process.env).toEqual(before);
  expect(executionGitOptions(f.canonical)).toEqual({ stdio: ['ignore', 'pipe', 'pipe'] });
});

test('unconfigured and nonexistent cwd retain legacy stdio and inherited env semantics', () => {
  const f = fixture();
  const outside = path.join(f.root, 'outside');
  fs.mkdirSync(outside);
  withExecutionGitRuntime(f.runtime, () => {
    expect(executionGitOptions(outside)).toEqual({ stdio: ['ignore', 'pipe', 'pipe'] });
    expect(executionGitOptions(path.join(f.root, 'missing'))).toEqual({
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  });
  expect(executionGitOptions(f.canonical)).toEqual({ stdio: ['ignore', 'pipe', 'pipe'] });
});

test('physical cwd resolution selects aliases and descendants with the nearest configured root', () => {
  const f = fixture();
  const nested = path.join(f.canonical, 'nested');
  const nestedShim = path.join(f.root, 'nested-shims');
  fs.mkdirSync(nested);
  fs.mkdirSync(nestedShim);
  const subdirectory = path.join(nested, 'src');
  fs.mkdirSync(subdirectory);
  const alias = path.join(f.root, 'alias');
  fs.symlinkSync(nested, alias);
  withExecutionGitRuntime(
    {
      shimDirectories: [...f.runtime.shimDirectories, { cwd: nested, shimDirectory: nestedShim }],
      bridgeFd: 4,
    },
    () => {
      expect(executionGitOptions(alias).env.GIT_CONFIG_VALUE_0).toBe(nestedShim);
      expect(executionGitOptions(subdirectory).env.GIT_CONFIG_VALUE_0).toBe(nestedShim);
      expect(executionGitOptions(f.canonical).env.GIT_CONFIG_VALUE_0).toBe(f.canonicalShim);
    }
  );
});

test('a thrown callback restores the enclosing runtime and then legacy options', () => {
  const f = fixture();
  const innerShim = path.join(f.root, 'inner-shim');
  fs.mkdirSync(innerShim);
  const failure = new Error('effect failed');
  withExecutionGitRuntime(f.runtime, () => {
    expect(() =>
      withExecutionGitRuntime(
        { shimDirectories: [{ cwd: f.canonical, shimDirectory: innerShim }], bridgeFd: 4 },
        () => {
          expect(executionGitOptions(f.canonical).env.GIT_CONFIG_VALUE_0).toBe(innerShim);
          throw failure;
        }
      )
    ).toThrow(failure);
    expect(executionGitOptions(f.canonical).env.GIT_CONFIG_VALUE_0).toBe(f.canonicalShim);
  });
  expect(executionGitOptions(f.canonical)).toEqual({ stdio: ['ignore', 'pipe', 'pipe'] });
});

test.each([
  { GIT_CONFIG_PARAMETERS: '' },
  { GIT_CONFIG_COUNT: '1' },
  { GIT_CONFIG_COUNT: '00' },
  { GIT_CONFIG_COUNT: '0', GIT_CONFIG_KEY_0: 'core.hooksPath' },
  { GIT_CONFIG_VALUE_0: 'unexpected' },
])('inherited unsupported config refuses before lifecycle effect: %j', (inherited) => {
  const f = fixture();
  Object.assign(process.env, inherited);
  let ran = false;
  expect(() =>
    withExecutionGitRuntime(f.runtime, () => {
      ran = true;
    })
  ).toThrow('Trusted Git runtime unavailable');
  expect(ran).toBe(false);
  expect(executionGitOptions(f.canonical)).toEqual({ stdio: ['ignore', 'pipe', 'pipe'] });
  for (const [name, value] of Object.entries(inherited)) expect(process.env[name]).toBe(value);
});

test('explicit empty indexed input is supported and checked again before each trusted Git spawn', () => {
  const f = fixture();
  process.env.GIT_CONFIG_COUNT = '0';
  withExecutionGitRuntime(f.runtime, () => {
    expect(executionGitOptions(f.canonical).env.GIT_CONFIG_COUNT).toBe('3');
    process.env.GIT_CONFIG_PARAMETERS = '';
    try {
      expect(() => executionGitOptions(f.canonical)).toThrow('GIT_CONFIG_PARAMETERS');
    } finally {
      delete process.env.GIT_CONFIG_PARAMETERS;
    }
  });
  expect(process.env.GIT_CONFIG_COUNT).toBe('0');
});

test.each(['fence-fd', 'shared-shim', 'duplicate-root', 'aliased-root'])(
  'invalid %s capability configuration refuses',
  (kind) => {
    const f = fixture();
    let runtime = f.runtime;
    if (kind === 'fence-fd') runtime = { ...runtime, bridgeFd: 3 };
    if (kind === 'shared-shim')
      runtime = {
        ...runtime,
        shimDirectories: [
          { cwd: f.canonical, shimDirectory: f.canonicalShim },
          { cwd: f.lane, shimDirectory: f.canonicalShim },
        ],
      };
    if (kind === 'duplicate-root')
      runtime = {
        ...runtime,
        shimDirectories: [
          { cwd: f.canonical, shimDirectory: f.canonicalShim },
          { cwd: f.canonical, shimDirectory: f.laneShim },
        ],
      };
    if (kind === 'aliased-root') {
      const alias = path.join(f.root, 'alias');
      fs.symlinkSync(f.canonical, alias);
      runtime = { ...runtime, shimDirectories: [{ cwd: alias, shimDirectory: f.canonicalShim }] };
    }
    let ran = false;
    expect(() =>
      withExecutionGitRuntime(runtime, () => {
        ran = true;
      })
    ).toThrow();
    expect(ran).toBe(false);
    expect(executionGitOptions(f.canonical)).toEqual({ stdio: ['ignore', 'pipe', 'pipe'] });
  }
);

test('async callbacks are rejected before their body and thenables cannot retain runtime', () => {
  const f = fixture();
  let ran = false;
  expect(() =>
    withExecutionGitRuntime(f.runtime, async () => {
      ran = true;
    })
  ).toThrow('effect must be synchronous');
  expect(ran).toBe(false);
  expect(() => withExecutionGitRuntime(f.runtime, () => ({ then() {} }))).toThrow('pending result');
  expect(executionGitOptions(f.canonical)).toEqual({ stdio: ['ignore', 'pipe', 'pipe'] });
});

test('public GitRunner injection retains the existing args/options signature', () => {
  const f = fixture();
  const calls = [];
  const result = resolveRepoRoot(f.canonical, {
    git: (args, options) => {
      calls.push({ args, options });
      return path.join(f.canonical, '.git');
    },
  });
  expect(calls).toEqual([
    {
      args: ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      options: { cwd: f.canonical },
    },
  ]);
  expect(result).toEqual({
    ok: true,
    value: { repoRoot: f.canonical, cawsDir: path.join(f.canonical, '.caws') },
  });
});

test('real path-limited linked-worktree commits retain foreign staging and expose actual callback indexes through per-root fd4 hooks', () => {
  const f = fixture();
  fs.rmdirSync(f.lane);
  const environment = {
    PATH: '/usr/bin:/bin',
    LC_ALL: 'C',
    HOME: f.root,
    GIT_AUTHOR_NAME: 'CAWS Test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'CAWS Test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
  };
  const git = (cwd, argv) =>
    execFileSync('/usr/bin/git', argv, {
      cwd,
      env: environment,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  git(f.canonical, ['init', '-q']);
  fs.writeFileSync(path.join(f.canonical, 'source.txt'), 'baseline\n');
  fs.writeFileSync(path.join(f.canonical, 'foreign.txt'), 'baseline foreign\n');
  git(f.canonical, ['add', 'source.txt', 'foreign.txt']);
  git(f.canonical, ['commit', '-q', '-m', 'baseline']);
  git(f.canonical, ['worktree', 'add', '--detach', f.lane, 'HEAD']);
  const originalCanonical = path.join(f.root, 'original-canonical-hooks');
  const originalLane = path.join(f.root, 'original-lane-hooks');
  fs.mkdirSync(originalCanonical);
  fs.mkdirSync(originalLane);
  git(f.canonical, ['config', 'extensions.worktreeConfig', 'true']);
  git(f.canonical, ['config', '--worktree', 'core.hooksPath', originalCanonical]);
  git(f.lane, ['config', '--worktree', 'core.hooksPath', originalLane]);
  fs.writeFileSync(
    path.join(f.canonicalShim, 'pre-commit'),
    '#!/bin/sh\nprintf "canonical-pre-commit|%s\\n" "$GIT_INDEX_FILE" >&4\n',
    { mode: 0o700 }
  );
  fs.writeFileSync(
    path.join(f.laneShim, 'commit-msg'),
    '#!/bin/sh\nprintf "lane-commit-msg|%s\\n" "$GIT_INDEX_FILE" >&4\n',
    { mode: 0o700 }
  );
  fs.writeFileSync(path.join(originalCanonical, 'pre-commit'), '#!/bin/sh\nexit 91\n', {
    mode: 0o700,
  });
  fs.writeFileSync(path.join(originalLane, 'commit-msg'), '#!/bin/sh\nexit 92\n', { mode: 0o700 });
  fs.writeFileSync(path.join(f.canonical, 'source.txt'), 'canonical committed\n');
  fs.writeFileSync(path.join(f.lane, 'source.txt'), 'lane committed\n');
  fs.writeFileSync(path.join(f.canonical, 'foreign.txt'), 'canonical staged foreign\n');
  fs.writeFileSync(path.join(f.lane, 'foreign.txt'), 'lane staged foreign\n');
  git(f.canonical, ['add', 'foreign.txt']);
  git(f.lane, ['add', 'foreign.txt']);
  const configPath = path.join(f.canonical, '.git/config');
  const configBefore = fs.readFileSync(configPath);
  const endpointPath = path.join(f.root, 'fd4-endpoint');
  const endpoint = fs.openSync(endpointPath, 'a+');
  const runtimeModule = path.resolve(__dirname, '../../dist/store/git-runtime.js');
  const repoModule = path.resolve(__dirname, '../../dist/store/repo-root.js');
  const input = { runtime: f.runtime, canonical: f.canonical, lane: f.lane };
  // The file endpoint proves actual fd inheritance through Git into hooks.
  // It is a transport fixture, not Native authority or Host admission proof.
  const script = `const {withExecutionGitRuntime}=require(${JSON.stringify(runtimeModule)});
const {runGit,defaultGitRunner}=require(${JSON.stringify(repoModule)});
const input=JSON.parse(process.argv[1]);
const results=withExecutionGitRuntime(input.runtime,()=>[input.canonical,input.lane].map(cwd=>{
 const add=runGit(['add','source.txt'],cwd);if(!add.ok)throw new Error(add.reason);
 const commit=runGit(['commit','-m','runtime hooks','--','source.txt'],cwd);if(!commit.ok)throw new Error(commit.reason);
 return {cwd,activeHooks:defaultGitRunner(['config','--get','core.hooksPath'],{cwd}),content:runGit(['show',':source.txt'],cwd)};
}));
const restored=[input.canonical,input.lane].map(cwd=>defaultGitRunner(['config','--get','core.hooksPath'],{cwd}));
process.stdout.write(JSON.stringify({results,restored}));`;
  let output;
  try {
    output = execFileSync(process.execPath, ['-e', script, JSON.stringify(input)], {
      cwd: f.canonical,
      env: environment,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe', 'ignore', endpoint],
      timeout: 20000,
    });
  } finally {
    fs.closeSync(endpoint);
  }
  const actual = JSON.parse(output);
  expect(actual.results).toEqual([
    {
      cwd: f.canonical,
      activeHooks: f.canonicalShim,
      content: { ok: true, stdout: 'canonical committed\n' },
    },
    { cwd: f.lane, activeHooks: f.laneShim, content: { ok: true, stdout: 'lane committed\n' } },
  ]);
  expect(actual.restored).toEqual([originalCanonical, originalLane]);
  const callbacks = fs
    .readFileSync(endpointPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => line.split('|'));
  expect(callbacks.map(([hook]) => hook)).toEqual(['canonical-pre-commit', 'lane-commit-msg']);
  for (const [index, cwd] of [f.canonical, f.lane].entries()) {
    const rawIndex = callbacks[index][1];
    expect(typeof rawIndex).toBe('string');
    expect(rawIndex.length).toBeGreaterThan(0);
    const callbackIndex = path.resolve(cwd, rawIndex);
    const administrativeDirectory = git(cwd, ['rev-parse', '--path-format=absolute', '--git-dir']);
    expect(path.dirname(callbackIndex)).toBe(administrativeDirectory);
    expect(path.basename(callbackIndex)).toMatch(
      /^(?:index(?:\.lock)?|next-index-[0-9]+(?:\.lock)?)$/
    );
    expect(git(cwd, ['show', 'HEAD:source.txt'])).toBe(
      index === 0 ? 'canonical committed' : 'lane committed'
    );
    expect(git(cwd, ['show', ':foreign.txt'])).toBe(
      index === 0 ? 'canonical staged foreign' : 'lane staged foreign'
    );
    expect(git(cwd, ['show', 'HEAD:foreign.txt'])).toBe('baseline foreign');
    expect(git(cwd, ['diff', '--cached', '--name-only'])).toBe('foreign.txt');
  }
  expect(fs.existsSync(path.join(f.canonicalShim, 'commit-msg'))).toBe(false);
  expect(fs.existsSync(path.join(f.laneShim, 'pre-commit'))).toBe(false);
  expect(fs.readFileSync(configPath)).toEqual(configBefore);
});
