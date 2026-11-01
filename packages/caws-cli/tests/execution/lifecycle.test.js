const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const { createHash } = require('node:crypto');
const { spawnCoveredSync } = require('./child-coverage.cjs');
const { authorityFixture, cleanupAll } = require('./authority-fixture');
const { git } = require('../helpers/git-repo-factory');
const {
  parseExecutionLifecycleArguments,
  inspectExecutionLifecycleGit,
  readExecutionLifecycleAuthority,
  readExecutionLifecycleRuntimeHomes,
  readExecutionLifecycleHookPolicy,
} = require('../../dist/execution/lifecycle');
const { loadEvents } = require('../../dist/store/events-store');
afterAll(cleanupAll);
const entry = path.resolve(__dirname, '../../dist/execution/lifecycle-main.js');

function fixture() {
  const f = authorityFixture();
  git(f.root, ['config', '--unset', 'core.hooksPath']);
  f.registry.owned.branch = 'owned';
  f.registry.owned.baseBranch = git(f.root, ['branch', '--show-current']).trim();
  f.registry.owned.baseSha = git(f.lane, ['rev-parse', 'HEAD']).trim();
  fs.writeFileSync(f.registryPath, JSON.stringify(f.registry));
  fs.writeFileSync(f.specPath, yaml.dump(f.spec));
  fs.writeFileSync(
    path.join(f.root, '.gitignore'),
    '/owned*/\n.caws/state.lock\n.caws/events.jsonl.lock\n.caws/claims/\n'
  );
  git(f.root, ['add', '--', '.caws', '.gitignore']);
  git(f.root, ['commit', '-m', 'fixture governance']);
  fs.writeFileSync(path.join(f.lane, 'src/owned.txt'), 'owned before\n');
  fs.writeFileSync(path.join(f.lane, 'src/sentinel.txt'), 'sentinel before\n');
  git(f.lane, ['add', '--', 'src/owned.txt', 'src/sentinel.txt']);
  git(f.lane, ['commit', '-m', 'fixture source']);
  f.env = {
    PATH: '/usr/bin:/bin',
    LC_ALL: 'C',
    CAWS_EXECUTION_PROJECT: f.root,
    CAWS_EXECUTION_CALLER: f.lane,
    CAWS_EXECUTION_SESSION: 'native-lineage',
    CAWS_EXECUTION_THREAD: 'thread-owned',
    CAWS_EXECUTION_CALL: 'operation-call',
  };
  return f;
}
function execute(f, argv, { cwd = f.lane, caller = cwd, fence = true, setup = '' } = {}) {
  const lock = path.join(f.caws, 'state.lock');
  let fd;
  if (fence) {
    fd = fs.openSync(lock, 'wx+', 0o600);
    fs.writeFileSync(
      fd,
      JSON.stringify({
        pid: process.pid,
        at: new Date().toISOString(),
        purpose: 'execution-launch',
        nonce: 'lifecycle-test-nonce',
        protocol: 'caws.execution.fence.v1',
      })
    );
  }
  try {
    const script = `delete process.env.CAWS_TEST_CHILD_COVERAGE;
      delete process.env.__STRYKER_ACTIVE_MUTANT__;
      ${setup}
      process.argv.splice(1,0,${JSON.stringify(entry)});
      require(${JSON.stringify(entry)});`;
    return spawnCoveredSync(process.execPath, ['-e', script, ...argv], {
      cwd,
      env: { ...f.env, CAWS_EXECUTION_CALLER: caller },
      stdio: ['ignore', 'pipe', 'pipe', fd ?? 'ignore'],
      encoding: 'utf8',
      timeout: 30000,
      maxBuffer: 1048576,
    });
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
      fs.unlinkSync(lock);
    }
  }
}
function success(result) {
  expect(result.error).toBeUndefined();
  expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
  return JSON.parse(result.stdout);
}
function spec(f) {
  return yaml.load(fs.readFileSync(f.specPath, 'utf8'));
}
function runtimeHomes(f) {
  const home = path.join(f.root, 'runtime-home');
  const cawsHome = path.join(home, 'machine');
  const codexHome = path.join(home, '.codex');
  fs.mkdirSync(cawsHome, { recursive: true });
  fs.mkdirSync(codexHome);
  Object.assign(f.env, { HOME: home, CAWS_HOME: cawsHome, CODEX_HOME: codexHome });
  return { home, cawsHome, codexHome };
}

test('event ledger keeps legacy absent-byte ordering and hashes a large tail completely', () => {
  const f = fixture();
  const ledger = path.join(f.caws, 'events.jsonl');
  const read = () => readExecutionLifecycleAuthority(f.record, { operation: 'git-head' }).revision;
  const absent = read();
  fs.writeFileSync(ledger, 'absent');
  expect(read()).toBe(absent);
  const contents = Buffer.alloc(1048576 + 131, 0x61);
  contents[contents.length - 1] = 0x7a;
  fs.writeFileSync(ledger, contents);
  const originalOpen = fs.openSync.bind(fs);
  const originalRead = fs.readSync.bind(fs);
  const observed = createHash('sha256');
  let bytesRead = 0;
  let ledgerFd;
  const open = jest.spyOn(fs, 'openSync').mockImplementation((name, flags, ...rest) => {
    const fd = originalOpen(name, flags, ...rest);
    if (
      name === ledger &&
      typeof flags === 'number' &&
      (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR)) === 0
    )
      ledgerFd = fd;
    return fd;
  });
  const readSpy = jest
    .spyOn(fs, 'readSync')
    .mockImplementation((fd, buffer, offset, length, position) => {
      const count = originalRead(fd, buffer, offset, length, position);
      if (fd === ledgerFd && count > 0) {
        observed.update(buffer.subarray(offset, offset + count));
        bytesRead += count;
      }
      return count;
    });
  let first;
  try {
    first = read();
  } finally {
    readSpy.mockRestore();
    open.mockRestore();
  }
  expect(bytesRead).toBe(contents.length);
  expect(observed.digest('hex')).toBe(createHash('sha256').update(contents).digest('hex'));
  contents[contents.length - 1] = 0x79;
  fs.writeFileSync(ledger, contents);
  expect(read()).not.toBe(first);
});

test.each(['append', 'truncate', 'replace', 'disappear-before-open'])(
  'event ledger refuses %s during the read',
  (change) => {
    const f = fixture();
    const ledger = path.join(f.caws, 'events.jsonl');
    fs.writeFileSync(ledger, Buffer.alloc(131073, 0x61));
    const originalOpen = fs.openSync.bind(fs);
    const originalRead = fs.readSync.bind(fs);
    let ledgerFd;
    let injected = false;
    const open = jest.spyOn(fs, 'openSync').mockImplementation((name, flags, ...rest) => {
      if (name === ledger && change === 'disappear-before-open' && !injected) {
        injected = true;
        fs.unlinkSync(ledger);
      }
      const fd = originalOpen(name, flags, ...rest);
      if (
        name === ledger &&
        typeof flags === 'number' &&
        (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR)) === 0
      )
        ledgerFd = fd;
      return fd;
    });
    const readSpy = jest
      .spyOn(fs, 'readSync')
      .mockImplementation((fd, buffer, offset, length, position) => {
        const count = originalRead(fd, buffer, offset, length, position);
        if (fd === ledgerFd && count > 0 && !injected) {
          injected = true;
          if (change === 'append') fs.appendFileSync(ledger, 'x');
          if (change === 'truncate') fs.truncateSync(ledger, 3);
          if (change === 'replace') {
            fs.renameSync(ledger, `${ledger}.old`);
            fs.writeFileSync(ledger, Buffer.alloc(131073, 0x61));
          }
        }
        return count;
      });
    try {
      expect(() => readExecutionLifecycleAuthority(f.record, { operation: 'git-head' })).toThrow();
    } finally {
      readSpy.mockRestore();
      open.mockRestore();
    }
    expect(injected).toBe(true);
  }
);

test.each(['symlink', 'hardlink'])('event ledger refuses a %s alias', (kind) => {
  const f = fixture();
  const ledger = path.join(f.caws, 'events.jsonl');
  const other = path.join(f.root, 'ledger-other');
  fs.writeFileSync(other, 'ledger');
  if (kind === 'symlink') fs.symlinkSync(other, ledger);
  else fs.linkSync(other, ledger);
  expect(() => readExecutionLifecycleAuthority(f.record, { operation: 'git-head' })).toThrow();
});

test('the ordinary metadata file limit remains enforced', () => {
  const f = fixture();
  const policy = path.join(f.caws, 'policy.yaml');
  const original = fs.readFileSync(policy);
  const atLimit = Buffer.concat([
    original,
    Buffer.from('\n#'),
    Buffer.alloc(1048576 - original.length - 2, 0x78),
  ]);
  fs.writeFileSync(policy, atLimit);
  expect(readExecutionLifecycleAuthority(f.record, { operation: 'git-head' }).specId).toBe(
    'EXEC-001'
  );
  fs.appendFileSync(policy, 'x');
  expect(() => readExecutionLifecycleAuthority(f.record, { operation: 'git-head' })).toThrow();
});
const hookNames = [
  'applypatch-msg',
  'pre-applypatch',
  'post-applypatch',
  'pre-commit',
  'pre-auto-gc',
  'pre-merge-commit',
  'prepare-commit-msg',
  'commit-msg',
  'post-commit',
  'post-checkout',
  'post-merge',
  'pre-push',
  'pre-rebase',
  'post-rewrite',
  'reference-transaction',
  'post-index-change',
  'push-to-checkout',
  'proc-receive',
  'update',
  'pre-receive',
  'post-receive',
  'post-update',
];
function pinHookPolicy(f, { version = 1 } = {}) {
  const homes = runtimeHomes(f);
  const roots = [f.root, f.lane].map((cwd) => {
    const hooksDirectory = git(cwd, ['rev-parse', '--path-format=absolute', '--git-path', 'hooks']);
    const hooks = Object.fromEntries(
      hookNames.map((name) => {
        const file = path.join(hooksDirectory, name);
        if (!fs.existsSync(file)) return [name, null];
        const stat = fs.lstatSync(file, { bigint: true });
        return [
          name,
          {
            path: file,
            sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
            dev: stat.dev.toString(),
            ino: stat.ino.toString(),
            mode: stat.mode.toString(),
          },
        ];
      })
    );
    return version === 2
      ? {
          cwd,
          hooksDirectory,
          hooks,
          formatters: { eslint: null, prettier: null },
          readOnlyPaths: [],
        }
      : { cwd, hooksDirectory, hooks };
  });
  const policy = path.join(homes.home, 'lifecycle-hooks.json');
  fs.writeFileSync(
    policy,
    JSON.stringify({ schema: `caws.execution.git-hook-policy.v${version}`, roots })
  );
  Object.assign(f.env, {
    CAWS_EXECUTION_GIT_HOOK_POLICY: policy,
    CAWS_EXECUTION_GIT_HOOK_POLICY_SHA256: createHash('sha256')
      .update(fs.readFileSync(policy))
      .digest('hex'),
  });
  return policy;
}
test('multiline commit messages remain data while all other lifecycle words stay single-line', () => {
  const message =
    'fix: preserve literal commit data\n\n- Keep printf blocked > protected.txt in the message';
  expect(
    parseExecutionLifecycleArguments(['git-commit', '--message', message, '--', 'src/owned.txt'])
  ).toStrictEqual({ operation: 'git-commit', message, paths: ['src/owned.txt'] });
  for (const invalid of [
    ['git-commit', '--message', 'bad\0message', '--', 'src/owned.txt'],
    ['git-commit', '--message', 'bad\rmessage', '--', 'src/owned.txt'],
    ['git-commit', '--message', 'x'.repeat(8193), '--', 'src/owned.txt'],
    ['git-commit', '--message', message, '--', 'src/owned\n.txt'],
    ['git-commit\n', '--message', message, '--', 'src/owned.txt'],
  ])
    expect(() => parseExecutionLifecycleArguments(invalid)).toThrow(
      'Execution authority is unavailable'
    );
});

test('lifecycle runtime homes are all-or-none physical directories with no alias fallback', () => {
  const f = fixture();
  const homes = runtimeHomes(f);
  const environment = Object.entries(f.env).map(([name, value]) => ({ name, value }));
  expect(readExecutionLifecycleRuntimeHomes(environment)).toEqual(homes);
  expect(readExecutionLifecycleRuntimeHomes([])).toBeUndefined();
  for (const missing of ['HOME', 'CAWS_HOME', 'CODEX_HOME'])
    expect(() =>
      readExecutionLifecycleRuntimeHomes(environment.filter(({ name }) => name !== missing))
    ).toThrow();
  const alias = path.join(f.root, 'home-alias');
  fs.symlinkSync(homes.home, alias);
  expect(() =>
    readExecutionLifecycleRuntimeHomes(
      environment.map((row) => (row.name === 'HOME' ? { name: 'HOME', value: alias } : row))
    )
  ).toThrow();
  expect(() =>
    readExecutionLifecycleRuntimeHomes([...environment, { name: 'HOME', value: homes.home }])
  ).toThrow();
});
test('normal lifecycle preflight readers expose real context without writing authority or indexes', () => {
  const f = fixture();
  runtimeHomes(f);
  const index = (cwd) =>
    fs.readFileSync(path.resolve(cwd, git(cwd, ['rev-parse', '--git-path', 'index'])));
  const before = [index(f.root), index(f.lane)];
  const source = fs.readFileSync(path.join(f.lane, 'src/owned.txt'));
  const head = git(f.lane, ['rev-parse', 'HEAD']);
  const status = success(execute(f, ['status']));
  expect(status).toMatchObject({ action: 'status', specId: 'EXEC-001', exitCode: 0 });
  expect(status.stdout).toContain('EXEC-001');
  expect(status.stdout).toContain('thread-owned');
  const agents = success(execute(f, ['agents-list']));
  expect(agents).toMatchObject({ action: 'agents-list', specId: 'EXEC-001', exitCode: 0 });
  expect(agents.stdout).toContain('active: 0');
  expect(agents.stdout).toContain('.caws/leases (operational cache');
  const review = success(
    execute(f, ['worktree-review', '--worktree', 'owned', '--spec', 'EXEC-001'])
  );
  expect(review).toMatchObject({ action: 'worktree-review', specId: 'EXEC-001', exitCode: 0 });
  expect(review.stdout).toContain('EXEC-001');
  expect(review.stdout).toContain('owned');
  expect([index(f.root), index(f.lane)]).toEqual(before);
  expect(git(f.lane, ['rev-parse', 'HEAD'])).toBe(head);
  expect(fs.readFileSync(path.join(f.lane, 'src/owned.txt'))).toEqual(source);
  expect(fs.existsSync(path.join(f.caws, 'events.jsonl'))).toBe(false);
  expect(fs.existsSync(path.join(f.caws, 'leases'))).toBe(false);
});
test.each([
  ['worktree-review', '--worktree', 'foreign', '--spec', 'EXEC-001'],
  ['worktree-review', '--worktree', 'owned', '--spec', 'OTHER-001'],
])('preflight review refuses a foreign worktree or spec: %j', (...argv) => {
  const f = fixture();
  runtimeHomes(f);
  const result = execute(f, argv);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('scope_refused');
  expect(fs.existsSync(path.join(f.caws, 'events.jsonl'))).toBe(false);
});
test('doctor uses the pinned runtime context and returns the actual diagnostic result', () => {
  const f = fixture();
  runtimeHomes(f);
  const lane = path.join(f.root, 'doctor-owned');
  git(f.root, ['worktree', 'move', f.lane, lane]);
  f.lane = lane;
  f.registry.owned.path = lane;
  fs.writeFileSync(f.registryPath, JSON.stringify(f.registry));
  f.env.CAWS_EXECUTION_CALLER = lane;
  expect(fs.existsSync(path.join(f.caws, 'events.jsonl'))).toBe(false);
  const result = execute(f, ['doctor']);
  const value = success(result);
  expect(value).toMatchObject({
    action: 'doctor',
    specId: 'EXEC-001',
    outcome: 'settled',
    exitCode: 0,
  });
  expect(value.stdout).toContain('0E');
  expect(fs.existsSync(path.join(f.caws, 'events.jsonl'))).toBe(false);
});
test('doctor preserves a real nonzero diagnostic instead of converting it to success', () => {
  const f = fixture();
  const homes = runtimeHomes(f);
  // This fixture's newline worktree is reported as a ghost by the ordinary
  // doctor reader. The consumer must faithfully carry that error and context.
  const result = execute(f, ['doctor']);
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe('');
  expect(result.status).toBe(1);
  const value = JSON.parse(result.stdout);
  expect(value).toMatchObject({ action: 'doctor', outcome: 'settled', exitCode: 1 });
  expect(value.stdout).toContain('doctor.worktree.ghost_registry_entry');
  expect(value.stdout).toContain(homes.cawsHome);
});
test('gates runs the real policy command and publishes only its actual same-thread events', () => {
  const f = fixture();
  runtimeHomes(f);
  fs.writeFileSync(path.join(f.lane, 'src/owned.txt'), 'owned changed\n');
  const before = loadEvents(f.caws);
  expect(before.ok).toBe(true);
  const result = execute(f, ['gates-run', '--spec', 'EXEC-001']);
  const value = success(result);
  expect(value).toMatchObject({
    action: 'gates-run',
    specId: 'EXEC-001',
    outcome: 'settled',
    exitCode: 0,
  });
  const after = loadEvents(f.caws);
  expect(after.ok).toBe(true);
  const added = after.value.events.slice(before.value.events.length);
  expect(added.length).toBeGreaterThan(0);
  expect(value.data.gateEventSequences).toEqual(added.map((event) => event.seq));
  for (const event of added) {
    expect(event.event).toBe('gate_evaluated');
    expect(event.spec_id).toBe('EXEC-001');
    expect(event.actor).toMatchObject({ session_id: 'thread-owned', platform: 'codex' });
  }
});
test('diagnostic operations cannot fall back to ambient homes or a foreign spec', () => {
  const f = fixture();
  expect(fs.existsSync(path.join(f.caws, 'events.jsonl'))).toBe(false);
  expect(execute(f, ['doctor']).status).not.toBe(0);
  expect(execute(f, ['status']).status).not.toBe(0);
  expect(execute(f, ['agents-list']).status).not.toBe(0);
  expect(
    execute(f, ['worktree-review', '--worktree', 'owned', '--spec', 'EXEC-001']).status
  ).not.toBe(0);
  runtimeHomes(f);
  expect(execute(f, ['gates-run', '--spec', 'OTHER-001']).status).not.toBe(0);
  expect(fs.existsSync(path.join(f.caws, 'events.jsonl'))).toBe(false);
});

function configureInactiveLocalMetadata(f, { sparse = true } = {}) {
  const marker = path.join(f.root, 'filter-must-not-run');
  const command = `sh -c 'echo executed > "${marker}"; exit 1'`;
  for (const [key, value] of [
    ['credential.helper', 'unused-local-helper'],
    ['init.defaultbranch', 'main'],
    ['inti.defaultbranch', 'main'],
    ['color.ui', 'auto'],
    ['filter.lfs.clean', command],
    ['filter.lfs.smudge', command],
    ['filter.lfs.process', command],
    ['filter.lfs.required', 'true'],
    ['push.autosetupremote', 'true'],
    ['http.postbuffer', '524288000'],
    ['pack.window', '1'],
    ['pull.ff', 'only'],
    ['pull.rebase', 'false'],
    ['remote.origin.url', 'file:///unused-fixture-remote'],
    ['remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'],
    ['branch.caws/fixture-base.remote', 'origin'],
    ['branch.caws/fixture-base.merge', 'refs/heads/caws/fixture-base'],
    ['extensions.worktreeconfig', 'true'],
  ])
    git(f.root, ['config', key, value]);
  if (sparse) {
    const configured =
      require('../../dist/store/git-sparse-checkout').configureWorktreeSparseCheckout(f.lane);
    expect(configured.ok).toBe(true);
  }
  return marker;
}

test('VS Code branch merge-base hints are opaque observed authority, while executable keys remain refused', () => {
  const f = fixture();
  const read = () => readExecutionLifecycleAuthority(f.record, { operation: 'git-head' }).revision;
  git(f.root, ['config', 'branch.main.vscode-merge-base', 'refs/heads/base-one']);
  git(f.root, ['config', 'branch.caws/fixture-base.vscode-merge-base', 'refs/heads/other']);
  const first = read();
  expect(read()).toBe(first);
  git(f.root, ['config', 'branch.main.vscode-merge-base', 'refs/heads/base-two']);
  expect(read()).not.toBe(first);
  for (const key of ['branch.main.vscode-merge-base-extra', 'core.fsmonitor', 'alias.status']) {
    const marker = path.join(f.root, 'config-command-ran');
    git(f.root, ['config', key, `sh -c 'echo ran > "${marker}"'`]);
    let caught;
    try {
      read();
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ reason: 'unsupported_profile' });
    expect(fs.existsSync(marker)).toBe(false);
    git(f.root, ['config', '--unset', key]);
  }
});

test('configured inactive LFS and local metadata permit normal sparse stage commit merge bridge and close', () => {
  const f = fixture();
  const marker = configureInactiveLocalMetadata(f);
  fs.writeFileSync(path.join(f.lane, 'src/owned.txt'), 'inert configuration consumer\n');
  success(execute(f, ['git-stage', '--', 'src/owned.txt']));
  success(
    execute(f, ['git-commit', '--message', 'fix: actual local consumer', '--', 'src/owned.txt'])
  );
  expect(success(execute(f, ['git-status'])).stdout).toBe('');
  f.spec.title = 'Pending local governance audit';
  fs.writeFileSync(f.specPath, yaml.dump(f.spec));
  success(execute(f, ['spec-commit', '--spec', 'EXEC-001']));
  const merged = success(
    execute(f, ['worktree-merge', '--worktree', 'owned', '--spec', 'EXEC-001'], { cwd: f.root })
  ).data.merge_commit;
  expect(fs.readFileSync(path.join(f.root, 'src/owned.txt'), 'utf8')).toBe(
    'inert configuration consumer\n'
  );
  success(
    execute(f, ['bridge-claim', '--spec', 'EXEC-001', '--merge-commit', merged], { cwd: f.root })
  );
  success(
    execute(
      f,
      [
        'spec-close',
        '--spec',
        'EXEC-001',
        '--merge-commit',
        merged,
        '--reason',
        'local downstream inspected',
      ],
      { cwd: f.root }
    )
  );
  expect(spec(f).lifecycle_state).toBe('closed');
  expect(fs.existsSync(marker)).toBe(false);
});

test.each([
  ['git-stage', '--', ':(top,glob)**'],
  ['git-stage', '--', '../escape'],
  ['git-diff', '--', '../escape'],
  ['git-diff', '--cached', '--', 'src/owned.txt'],
  ['git-stage', '--', '/absolute'],
  ['git-stage', '--', 'src/a', 'src/a'],
  ['git-commit', '--amend', '--message', 'bad', '--', 'src/a'],
  ['worktree-merge', '--worktree', 'owned', '--spec', 'EXEC-001', '--force'],
  ['spec-close', '--spec', 'EXEC-001', '--merge-commit', '0'.repeat(40), '--reason', ' '],
  ['bridge-claim', '--spec', 'EXEC-001', '--merge-commit', '0'.repeat(40), '--takeover'],
  ['git-status', '--ignored'],
  ['status', '--heartbeat'],
  ['agents-list', '--stop'],
  ['worktree-review', '--worktree', 'owned', '--spec', 'EXEC-001', '--json'],
  ['git-head', 'OTHER_REF'],
  ['git-branch', '--all'],
])('rejects closed-protocol escape %j', (...argv) => {
  expect(() => parseExecutionLifecycleArguments(argv)).toThrow(
    'Execution authority is unavailable'
  );
});

test('stages literal owned content and commits only it while foreign staged content survives', () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.lane, 'src/owned.txt'), 'owned after\n');
  fs.writeFileSync(path.join(f.lane, 'src/sentinel.txt'), 'sentinel after\n');
  git(f.lane, ['add', '--', 'src/sentinel.txt']);
  const oldHead = git(f.lane, ['rev-parse', 'HEAD']);
  expect(success(execute(f, ['git-stage', '--', 'src/owned.txt']))).toMatchObject({
    action: 'git-stage',
    outcome: 'settled',
    specId: 'EXEC-001',
  });
  const indexPath = path.resolve(f.lane, git(f.lane, ['rev-parse', '--git-path', 'index']));
  const stagedBefore = fs.readFileSync(indexPath);
  const diff = success(execute(f, ['git-diff', '--', 'src/owned.txt']));
  expect(diff).toMatchObject({ action: 'git-diff', specId: 'EXEC-001', exitCode: 0 });
  expect(diff.stdout).toContain('+owned after');
  expect(diff.stdout).not.toContain('sentinel after');
  expect(fs.readFileSync(indexPath)).toEqual(stagedBefore);
  expect(git(f.lane, ['rev-parse', 'HEAD'])).toBe(oldHead);
  const committed = success(
    execute(f, ['git-commit', '--message', 'fix: owned source', '--', 'src/owned.txt'])
  );
  expect(git(f.lane, ['rev-parse', 'HEAD'])).not.toBe(oldHead);
  expect(git(f.lane, ['show', 'HEAD:src/owned.txt'])).toBe('owned after');
  expect(git(f.lane, ['show', 'HEAD:src/sentinel.txt'])).toBe('sentinel before');
  expect(git(f.lane, ['diff', '--cached', '--name-only'])).toBe('src/sentinel.txt');
  expect(committed.head).toBe(git(f.lane, ['rev-parse', 'HEAD']));
});

test('fixed Git readers report actual owned status HEAD and branch without refreshing the index', () => {
  const f = fixture();
  const head = git(f.lane, ['rev-parse', 'HEAD']);
  const index = git(f.lane, ['rev-parse', '--path-format=absolute', '--git-path', 'index']);
  const before = fs.readFileSync(index);
  fs.writeFileSync(path.join(f.lane, 'src/owned.txt'), 'edited\n');
  expect(success(execute(f, ['git-status']))).toMatchObject({ head, stdout: ' M src/owned.txt\n' });
  expect(success(execute(f, ['git-head']))).toMatchObject({ head, stdout: `${head}\n` });
  expect(success(execute(f, ['git-branch']))).toMatchObject({ head, stdout: 'owned\n' });
  expect(fs.readFileSync(index)).toEqual(before);
});

test('status refuses tracked submodule execution outside the inspected Git configuration closure', () => {
  const f = fixture();
  const head = git(f.lane, ['rev-parse', 'HEAD']);
  git(f.lane, ['update-index', '--add', '--cacheinfo', `160000,${head},src/submodule`]);
  const result = execute(f, ['git-status']);
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('unsupported_profile');
});

test.each(['pre-commit', 'pre-auto-gc', 'reference-transaction', 'post-index-change'])(
  'refuses unsupported executable %s hook without running or bypassing it',
  (hook) => {
    const f = fixture();
    const marker = path.join(f.root, 'hook-ran');
    fs.writeFileSync(
      path.join(f.root, '.git/hooks', hook),
      `#!/bin/sh\necho ran > '${marker}'\nexit 1\n`,
      { mode: 0o755 }
    );
    fs.writeFileSync(path.join(f.lane, 'src/owned.txt'), 'edit\n');
    const head = git(f.lane, ['rev-parse', 'HEAD']);
    const result = execute(f, ['git-stage', '--', 'src/owned.txt']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unsupported_profile');
    expect(fs.existsSync(marker)).toBe(false);
    expect(git(f.lane, ['rev-parse', 'HEAD'])).toBe(head);
    expect(git(f.lane, ['diff', '--cached', '--name-only'])).toBe('');
  }
);

test('staged diff refuses excluded paths before disclosing their contents or changing the index', () => {
  const f = fixture();
  fs.mkdirSync(path.join(f.lane, 'private'));
  fs.writeFileSync(path.join(f.lane, 'private/excluded.txt'), 'excluded staged contents\n');
  git(f.lane, ['add', '--', 'private/excluded.txt']);
  const index = path.resolve(f.lane, git(f.lane, ['rev-parse', '--git-path', 'index']));
  const before = fs.readFileSync(index);
  const result = execute(f, ['git-diff', '--', 'private/excluded.txt']);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('scope_refused');
  expect(result.stdout).toBe('');
  expect(fs.readFileSync(index)).toEqual(before);
});
test.each(['git-commit', 'spec-commit'])(
  'legacy v1 executable hook refuses %s before any Git effect',
  (operation) => {
    const f = fixture();
    const marker = path.join(f.root, 'hook-observation');
    const script = `const fs=require('node:fs');let data='';try{data=fs.readFileSync(3,'utf8')}catch{};if(data.includes('lifecycle-test-nonce'))process.exit(91);fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({node:process.execPath,thread:process.env.CODEX_THREAD_ID,surface:process.env.CAWS_AGENT_SURFACE,project:process.env.CAWS_PROJECT_DIR,privateNames:Object.keys(process.env).filter(name=>name.startsWith('CAWS_EXECUTION_'))}));`;
    const quoted = `'${script.replace(/'/g, "'\\''")}'`;
    fs.writeFileSync(path.join(f.root, '.git/hooks/pre-commit'), `#!/bin/sh\nnode -e ${quoted}\n`, {
      mode: 0o755,
    });
    pinHookPolicy(f);
    fs.writeFileSync(path.join(f.lane, 'src/owned.txt'), 'hook checked change\n');
    if (operation === 'spec-commit') {
      f.spec.title = 'Pending audit';
      fs.writeFileSync(f.specPath, yaml.dump(f.spec));
    }
    const index = (cwd) =>
      fs.readFileSync(git(cwd, ['rev-parse', '--path-format=absolute', '--git-path', 'index']));
    const before = [index(f.root), index(f.lane)];
    const heads = [git(f.root, ['rev-parse', 'HEAD']), git(f.lane, ['rev-parse', 'HEAD'])];
    const args =
      operation === 'git-commit'
        ? [
            'git-commit',
            '--message',
            'fix: literal message\n\n- preserve data',
            '--',
            'src/owned.txt',
          ]
        : ['spec-commit', '--spec', 'EXEC-001'];
    const result = execute(f, args);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('unsupported_profile');
    expect(fs.existsSync(marker)).toBe(false);
    expect([index(f.root), index(f.lane)]).toEqual(before);
    expect([git(f.root, ['rev-parse', 'HEAD']), git(f.lane, ['rev-parse', 'HEAD'])]).toEqual(heads);
    expect(fs.readFileSync(path.join(f.lane, 'src/owned.txt'), 'utf8')).toBe(
      'hook checked change\n'
    );
  }
);

test.each([
  'partial',
  'digest',
  'unknown-root-field',
  'missing-hook',
  'duplicate-root',
  'foreign-hook-path',
  'invalid-mode',
])('hook startup policy rejects malformed %s authority', (change) => {
  const f = fixture();
  const target = path.join(f.root, '.git/hooks/pre-commit');
  fs.writeFileSync(target, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const policy = pinHookPolicy(f, { version: 2 });
  const environment = () => Object.entries(f.env).map(([name, value]) => ({ name, value }));
  expect(readExecutionLifecycleHookPolicy(environment())).toMatchObject({
    path: policy,
    sha256: f.env.CAWS_EXECUTION_GIT_HOOK_POLICY_SHA256,
  });
  if (change === 'partial') delete f.env.CAWS_EXECUTION_GIT_HOOK_POLICY_SHA256;
  else if (change === 'digest') f.env.CAWS_EXECUTION_GIT_HOOK_POLICY_SHA256 = '0'.repeat(64);
  else {
    const value = JSON.parse(fs.readFileSync(policy));
    if (change === 'unknown-root-field') value.roots[0].allow = true;
    if (change === 'missing-hook') delete value.roots[0].hooks['pre-commit'];
    if (change === 'duplicate-root') value.roots.push(value.roots[0]);
    if (change === 'foreign-hook-path')
      value.roots[0].hooks['pre-commit'].path = '/foreign/pre-commit';
    if (change === 'invalid-mode') value.roots[0].hooks['pre-commit'].mode = '-1';
    fs.writeFileSync(policy, JSON.stringify(value));
    f.env.CAWS_EXECUTION_GIT_HOOK_POLICY_SHA256 = createHash('sha256')
      .update(fs.readFileSync(policy))
      .digest('hex');
  }
  expect(() => readExecutionLifecycleHookPolicy(environment())).toThrow(
    'Execution authority is unavailable'
  );
});

test('legacy v1 rejecting hook is refused before the hook or commit runs', () => {
  const f = fixture();
  const marker = path.join(f.root, 'required-hook-ran');
  fs.writeFileSync(
    path.join(f.root, '.git/hooks/pre-commit'),
    `#!/bin/sh\nprintf checked > '${marker}'\nprintf 'required policy refused\\n' >&2\nexit 23\n`,
    { mode: 0o755 }
  );
  pinHookPolicy(f);
  fs.writeFileSync(path.join(f.lane, 'src/owned.txt'), 'refused change\n');
  const head = git(f.lane, ['rev-parse', 'HEAD']);
  const result = execute(f, [
    'git-commit',
    '--message',
    'fix: require hook gate',
    '--',
    'src/owned.txt',
  ]);
  expect(result.status).not.toBe(0);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('unsupported_profile');
  expect(fs.existsSync(marker)).toBe(false);
  expect(git(f.lane, ['rev-parse', 'HEAD'])).toBe(head);
});

test.each(['bytes', 'remove', 'replace', 'chmod', 'insert', 'redirect'])(
  'startup hook policy refuses %s drift before index or hook effects',
  (change) => {
    const f = fixture();
    const target = path.join(f.root, '.git/hooks/pre-commit');
    const marker = path.join(f.root, 'drifted-hook-ran');
    const body = `#!/bin/sh\nprintf bad > '${marker}'\n`;
    fs.writeFileSync(target, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    pinHookPolicy(f, { version: 2 });
    if (change === 'bytes') fs.writeFileSync(target, body);
    if (change === 'remove') fs.unlinkSync(target);
    if (change === 'replace') {
      fs.unlinkSync(target);
      fs.writeFileSync(target, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    }
    if (change === 'chmod') fs.chmodSync(target, 0o644);
    if (change === 'insert')
      fs.writeFileSync(path.join(f.root, '.git/hooks/post-index-change'), body, { mode: 0o755 });
    if (change === 'redirect') {
      const directory = path.join(f.root, 'other-hooks');
      fs.mkdirSync(directory);
      fs.writeFileSync(path.join(directory, 'pre-commit'), body, { mode: 0o755 });
      git(f.root, ['config', 'core.hooksPath', directory]);
    }
    const indexPath = git(f.lane, ['rev-parse', '--path-format=absolute', '--git-path', 'index']);
    const before = fs.readFileSync(indexPath);
    fs.writeFileSync(path.join(f.lane, 'src/owned.txt'), 'candidate\n');
    const result = execute(f, ['git-stage', '--', 'src/owned.txt']);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('authority_changed');
    expect(fs.readFileSync(indexPath)).toEqual(before);
    expect(fs.existsSync(marker)).toBe(false);
  }
);

function equivalentFilesystemPaths(stored, requested) {
  const actual = fs.lstatSync(stored, { bigint: true });
  try {
    const lookup = fs.lstatSync(requested, { bigint: true });
    return actual.dev === lookup.dev && actual.ino === lookup.ino;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

test('exact Git hook pathname probes refuse filesystem-equivalent uppercase callback without executing it', () => {
  const f = fixture();
  const marker = path.join(f.root, 'uppercase-hook-ran');
  const stored = path.join(f.root, '.git/hooks/PRE-COMMIT');
  const requested = path.join(f.root, '.git/hooks/pre-commit');
  fs.writeFileSync(stored, `#!/bin/sh\necho executed > '${marker}'\nexit 1\n`, { mode: 0o755 });
  const equivalent = equivalentFilesystemPaths(stored, requested);
  process.stdout.write(`Git hook pathname filesystem equivalence: ${equivalent}\n`);
  fs.writeFileSync(path.join(f.lane, 'src/owned.txt'), 'alias callback candidate\n');
  const index = git(f.lane, ['rev-parse', '--path-format=absolute', '--git-path', 'index']);
  const before = fs.readFileSync(index);
  const result = execute(f, ['git-stage', '--', 'src/owned.txt']);
  expect(fs.existsSync(marker)).toBe(false);
  if (equivalent) {
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('unsupported_profile');
    expect(fs.readFileSync(index)).toEqual(before);
  } else {
    // A genuinely different pathname is not Git's pre-commit callback.
    expect(success(result).outcome).toBe('settled');
    expect(fs.readFileSync(index)).not.toEqual(before);
  }
});

test.each(['alternates', 'http-alternates'])(
  'exact forbidden metadata pathname probe refuses filesystem-equivalent uppercase %s',
  (name) => {
    const f = fixture();
    const stored = path.join(f.root, '.git/objects/info', name.toUpperCase());
    const requested = path.join(f.root, '.git/objects/info', name);
    fs.writeFileSync(stored, '');
    const equivalent = equivalentFilesystemPaths(stored, requested);
    process.stdout.write(`Git ${name} pathname filesystem equivalence: ${equivalent}\n`);
    const index = git(f.lane, ['rev-parse', '--path-format=absolute', '--git-path', 'index']);
    const before = {
      index: fs.readFileSync(index),
      spec: fs.readFileSync(f.specPath),
      refs: git(f.root, ['show-ref', '--head']),
    };
    const result = execute(f, ['git-stage', '--', 'src/owned.txt']);
    if (equivalent) {
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('unsupported_profile');
      expect(fs.readFileSync(index)).toEqual(before.index);
    } else expect(success(result).outcome).toBe('settled');
    expect(fs.readFileSync(f.specPath)).toEqual(before.spec);
    expect(git(f.root, ['show-ref', '--head'])).toBe(before.refs);
  }
);

test.each([
  'filter.hostile.clean',
  'core.fsmonitor',
  'gpg.program',
  'include.path',
  'core.sshCommand',
])('refuses executable or included Git configuration %s before mutation', (key) => {
  const f = fixture();
  const marker = path.join(f.root, 'config-ran');
  git(f.root, ['config', key, `sh -c 'echo ran > "${marker}"'`]);
  if (key.startsWith('filter.'))
    fs.writeFileSync(path.join(f.lane, '.gitattributes'), 'src/** filter=hostile\n');
  const result = execute(f, ['git-stage', '--', 'src/owned.txt']);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('unsupported_profile');
  expect(fs.existsSync(marker)).toBe(false);
});

test.each(['working', 'cached', 'untracked', 'governance', 'ignored-explicit'])(
  'configured LFS refuses active %s attributes without invoking its helper or changing Git state',
  (view) => {
    const f = fixture();
    const attributes = path.join(f.lane, '.gitattributes');
    // Construct the hostile cached view before configuring its executable
    // driver: update-index itself can refresh other paths using new attributes.
    if (view === 'cached') {
      const input = path.join(f.root, 'attribute-input');
      fs.writeFileSync(input, 'src/** filter=lfs\n');
      const blob = git(f.root, ['hash-object', '-w', input]);
      git(f.lane, ['update-index', '--add', '--cacheinfo', `100644,${blob},.gitattributes`]);
      fs.writeFileSync(attributes, '* -filter\n');
    }
    const marker = configureInactiveLocalMetadata(f, { sparse: view !== 'cached' });
    let argv = ['git-stage', '--', 'src/owned.txt'];
    if (view === 'working') fs.writeFileSync(attributes, 'src/** filter=lfs\n');
    if (view === 'untracked') {
      fs.writeFileSync(attributes, 'src/future.txt filter=lfs\n');
      fs.writeFileSync(path.join(f.lane, 'src/future.txt'), 'untracked candidate\n');
    }
    if (view === 'ignored-explicit') {
      fs.writeFileSync(attributes, 'src/ignored.txt filter=lfs\n');
      fs.writeFileSync(path.join(f.lane, '.gitignore'), 'src/ignored.txt\n');
      fs.writeFileSync(path.join(f.lane, 'src/ignored.txt'), 'explicit ignored candidate\n');
      argv = ['git-stage', '--', 'src/ignored.txt'];
    }
    if (view === 'governance') {
      fs.writeFileSync(path.join(f.root, '.gitattributes'), '.caws/specs/*.yaml filter=lfs\n');
      argv = ['spec-commit', '--spec', 'EXEC-001'];
    }
    const index = git(f.lane, ['rev-parse', '--path-format=absolute', '--git-path', 'index']);
    const before = {
      index: fs.readFileSync(index),
      refs: git(f.root, ['show-ref', '--head']),
      source: fs.readFileSync(f.specPath),
    };
    const result = execute(f, argv);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('unsupported_profile');
    expect(fs.readFileSync(index)).toEqual(before.index);
    expect(git(f.root, ['show-ref', '--head'])).toBe(before.refs);
    expect(fs.readFileSync(f.specPath)).toEqual(before.source);
    expect(fs.existsSync(marker)).toBe(false);
  }
);

test('configured LFS rejects active immutable HEAD attributes even when worktree and index disable them', () => {
  const f = fixture();
  const attributes = path.join(f.lane, '.gitattributes');
  fs.writeFileSync(attributes, 'src/** filter=lfs\n');
  git(f.lane, ['add', '--', '.gitattributes']);
  git(f.lane, ['commit', '-m', 'fixture active HEAD attributes without configured driver']);
  fs.writeFileSync(attributes, '* -filter\n');
  git(f.lane, ['add', '--', '.gitattributes']);
  const marker = configureInactiveLocalMetadata(f, { sparse: false });
  expect(() => inspectExecutionLifecycleGit(f.lane)).toThrow('Execution authority is unavailable');
  expect(fs.existsSync(marker)).toBe(false);
});

test.each([
  'remote.origin.promisor',
  'extensions.partialclone',
  'include.path',
  'alias.status',
  'filter.unset.clean',
  'filter.unspecified.process',
])(
  'configured LFS still refuses unsafe configuration %s with state and helper sentinel unchanged',
  (key) => {
    const f = fixture();
    const marker = configureInactiveLocalMetadata(f);
    git(f.root, ['config', key, key.endsWith('.promisor') ? 'true' : 'unsupported']);
    const index = git(f.lane, ['rev-parse', '--path-format=absolute', '--git-path', 'index']);
    const before = fs.readFileSync(index);
    const result = execute(f, ['git-stage', '--', 'src/owned.txt']);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('unsupported_profile');
    expect(fs.readFileSync(index)).toEqual(before);
    expect(fs.existsSync(marker)).toBe(false);
  }
);

test('configured LFS revalidation rejects a filter activated between observation and stage', () => {
  const f = fixture();
  const marker = configureInactiveLocalMetadata(f);
  const index = git(f.lane, ['rev-parse', '--path-format=absolute', '--git-path', 'index']);
  const before = fs.readFileSync(index);
  const setup = `const fs=require('node:fs');const open=fs.openSync;let changed=false;
    fs.openSync=function(p,...a){const fd=open.call(this,p,...a);if(!changed&&p===${JSON.stringify(path.join(f.lane, 'src/owned.txt'))}){changed=true;fs.writeFileSync(${JSON.stringify(path.join(f.lane, '.gitattributes'))},'src/** filter=lfs\\n');}return fd;};`;
  const result = execute(f, ['git-stage', '--', 'src/owned.txt'], { setup });
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('unsupported_profile');
  expect(fs.readFileSync(index)).toEqual(before);
  expect(fs.existsSync(marker)).toBe(false);
});

test('refuses missing parent fence and protected infrastructure paths', () => {
  const f = fixture();
  const missing = execute(f, ['git-stage', '--', 'src/owned.txt'], { fence: false });
  expect(missing.status).toBe(1);
  expect(missing.stdout).toBe('');
  const protectedResult = execute(f, ['git-stage', '--', '.caws/specs/EXEC-001.yaml']);
  expect(protectedResult.status).toBe(1);
  expect(protectedResult.stderr).toContain('scope_refused');
});

test.each(['fence', 'owner', 'ref'])(
  'refuses changed %s between observation and stage',
  (target) => {
    const f = fixture();
    const base = f.registry.owned.baseSha;
    const index = git(f.lane, ['rev-parse', '--path-format=absolute', '--git-path', 'index']);
    const beforeIndex = fs.readFileSync(index);
    const mutation =
      target === 'fence'
        ? `fs.unlinkSync(${JSON.stringify(path.join(f.caws, 'state.lock'))}); fs.writeFileSync(${JSON.stringify(path.join(f.caws, 'state.lock'))}, '{}');`
        : target === 'owner'
          ? `const r=JSON.parse(fs.readFileSync(${JSON.stringify(f.registryPath)},'utf8'));r.owned.owner.session_id='foreign';fs.writeFileSync(${JSON.stringify(f.registryPath)},JSON.stringify(r));`
          : `require('node:child_process').execFileSync('/usr/bin/git',['update-ref','refs/heads/owned',${JSON.stringify(base)}]);`;
    const setup = `const fs=require('node:fs');const open=fs.openSync;let changed=false;
    fs.openSync=function(p,...a){const fd=open.call(this,p,...a);if(p===${JSON.stringify(path.join(f.lane, 'src/owned.txt'))}&&!changed){changed=true;${mutation}}return fd;};`;
    const result = execute(f, ['git-stage', '--', 'src/owned.txt'], { setup });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/fence_unverified|foreign_owner|authority_changed/);
    expect(fs.readFileSync(index)).toEqual(beforeIndex);
  }
);

test('audit-commits only bound spec state through normal Git', () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.root, 'sentinel.txt'), 'unrelated staged content\n');
  git(f.root, ['add', '--', 'sentinel.txt']);
  f.spec.title = 'Pending bounded evidence state';
  fs.writeFileSync(f.specPath, yaml.dump(f.spec));
  const result = success(execute(f, ['spec-commit', '--spec', 'EXEC-001']));
  expect(result.data.kind).toBe('committed');
  expect(git(f.root, ['show', '--format=', '--name-only', 'HEAD'])).toBe(
    '.caws/specs/EXEC-001.yaml'
  );
  expect(yaml.load(git(f.root, ['show', 'HEAD:.caws/specs/EXEC-001.yaml'])).title).toBe(
    f.spec.title
  );
  expect(git(f.root, ['diff', '--cached', '--name-only'])).toBe('sentinel.txt');
});

test.each(['source-symlink', 'source-hardlink', 'index-symlink'])(
  'refuses physical alias %s without touching its target',
  (kind) => {
    const f = fixture();
    const target = path.join(f.root, 'external-target');
    const owned = path.join(f.lane, 'src/owned.txt');
    if (kind === 'index-symlink') {
      const metadata = git(f.lane, ['rev-parse', '--path-format=absolute', '--git-path', 'index']);
      fs.copyFileSync(metadata, target);
      fs.unlinkSync(metadata);
      fs.symlinkSync(target, metadata);
    } else {
      fs.writeFileSync(target, 'external before\n');
      fs.unlinkSync(owned);
      if (kind === 'source-symlink') fs.symlinkSync(target, owned);
      else fs.linkSync(target, owned);
    }
    const before = fs.readFileSync(target);
    const result = execute(f, ['git-stage', '--', 'src/owned.txt']);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(fs.readFileSync(target)).toEqual(before);
  }
);

test('lands without close, requires explicit same-owner bridge, then closes using existing lifecycle writer', () => {
  const f = fixture();
  const result = success(
    execute(f, ['worktree-merge', '--worktree', 'owned', '--spec', 'EXEC-001'], { cwd: f.root })
  );
  const merged = result.data.merge_commit;
  expect(result.data).toMatchObject({
    auto_closed_spec: false,
    spec_left_open: true,
    canonical_checkout_state: 'in_sync',
  });
  expect(fs.existsSync(f.lane)).toBe(false);
  expect(spec(f).lifecycle_state).toBe('active');
  expect(spec(f).worktree).toBeUndefined();
  expect(JSON.parse(fs.readFileSync(f.registryPath))).toEqual({});
  expect(fs.readFileSync(path.join(f.root, 'src/owned.txt'), 'utf8')).toBe('owned before\n');
  const premature = execute(
    f,
    ['spec-close', '--spec', 'EXEC-001', '--merge-commit', merged, '--reason', 'checked'],
    { cwd: f.root }
  );
  expect(premature.status).toBe(1);
  expect(spec(f).lifecycle_state).toBe('active');
  f.env.CAWS_EXECUTION_THREAD = 'thread-foreign';
  const foreignClaim = execute(
    f,
    ['bridge-claim', '--spec', 'EXEC-001', '--merge-commit', merged],
    { cwd: f.root }
  );
  expect(foreignClaim.status).toBe(1);
  expect(fs.existsSync(path.join(f.caws, 'claims/bridge.json'))).toBe(false);
  f.env.CAWS_EXECUTION_THREAD = 'thread-owned';
  success(
    execute(f, ['bridge-claim', '--spec', 'EXEC-001', '--merge-commit', merged], { cwd: f.root })
  );
  expect(
    JSON.parse(fs.readFileSync(path.join(f.caws, 'claims/bridge.json')))['EXEC-001']
  ).toMatchObject({ session_id: 'thread-owned', platform: 'codex' });
  success(
    execute(
      f,
      [
        'spec-close',
        '--spec',
        'EXEC-001',
        '--merge-commit',
        merged,
        '--reason',
        'downstream consumer inspected',
      ],
      { cwd: f.root }
    )
  );
  expect(spec(f)).toMatchObject({
    lifecycle_state: 'closed',
    resolution: 'completed',
    closure_notes: 'downstream consumer inspected',
  });
  const events = loadEvents(f.caws);
  expect(events.ok).toBe(true);
  expect(events.value.events.map((event) => event.event)).toEqual(
    expect.arrayContaining([
      'worktree_merged',
      'worktree_destroyed',
      'claim_bridged',
      'spec_closed',
    ])
  );
});

test('post-CAS event failure reports publication requiring inspection and preserves merge identity', () => {
  const f = fixture();
  const before = git(f.root, ['rev-parse', 'HEAD']);
  const setup = `const cp=require('node:child_process');const fs=require('node:fs');const run=cp.execFileSync;
    cp.execFileSync=function(image,args,...rest){const out=run.call(this,image,args,...rest);if(args[0]==='update-ref')fs.writeFileSync(${JSON.stringify(path.join(f.caws, 'events.jsonl.lock'))},JSON.stringify({pid:process.pid,at:new Date().toISOString()}));return out;};`;
  const result = execute(f, ['worktree-merge', '--worktree', 'owned', '--spec', 'EXEC-001'], {
    cwd: f.root,
    setup,
  });
  expect(result.status).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({
    outcome: 'publication-failure',
    action: 'worktree-merge',
    disposition: 'inspect-before-retry',
  });
  const after = git(f.root, ['rev-parse', 'HEAD']);
  expect(after).not.toBe(before);
  expect(JSON.parse(result.stdout)).toMatchObject({
    headBefore: before,
    headAfter: after,
    mergeCommit: after,
  });
  expect(fs.existsSync(f.lane)).toBe(true);
  expect(spec(f).lifecycle_state).toBe('active');
});

test('a fence replaced immediately before merge publication cannot advance the base ref', () => {
  const f = fixture();
  const head = git(f.root, ['rev-parse', 'HEAD']);
  const registry = fs.readFileSync(f.registryPath);
  const source = fs.readFileSync(f.specPath);
  const setup = `const cp=require('node:child_process');const fs=require('node:fs');const run=cp.execFileSync;let objectWritten=false;
    cp.execFileSync=function(image,args,...rest){const out=run.call(this,image,args,...rest);if(args[0]==='commit-tree')objectWritten=true;if(objectWritten&&args[0]==='worktree'&&args[1]==='list'){fs.unlinkSync(${JSON.stringify(path.join(f.caws, 'state.lock'))});fs.writeFileSync(${JSON.stringify(path.join(f.caws, 'state.lock'))},'{}');}return out;};`;
  const result = execute(f, ['worktree-merge', '--worktree', 'owned', '--spec', 'EXEC-001'], {
    cwd: f.root,
    setup,
  });
  expect(result.status).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({
    action: 'worktree-merge',
    outcome: 'publication-failure',
    headBefore: head,
    headAfter: head,
  });
  expect(git(f.root, ['rev-parse', 'HEAD'])).toBe(head);
  expect(fs.readFileSync(f.registryPath)).toEqual(registry);
  expect(fs.readFileSync(f.specPath)).toEqual(source);
  expect(fs.existsSync(f.lane)).toBe(true);
});

test('owned lifecycle settles while dirty unrelated and detached worktrees remain byte-identical', () => {
  const f = fixture();
  const others = [path.join(f.root, 'owned-unrelated'), path.join(f.root, 'owned-detached')];
  git(f.root, ['worktree', 'add', '-b', 'unrelated', others[0], 'owned']);
  git(f.root, ['worktree', 'add', '--detach', others[1], 'owned']);
  for (const cwd of others) {
    fs.writeFileSync(path.join(cwd, 'src/sentinel.txt'), 'foreign staged\n');
    git(cwd, ['add', '--', 'src/sentinel.txt']);
    fs.writeFileSync(path.join(cwd, 'src/owned.txt'), 'foreign unstaged\n');
  }
  git(f.root, ['worktree', 'lock', '--reason', 'foreign work in progress', others[0]]);
  const before = others.map((cwd) => ({
    head: git(cwd, ['rev-parse', 'HEAD']),
    status: git(cwd, ['--no-optional-locks', 'status', '--short']),
    index: fs.readFileSync(
      git(cwd, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])
    ),
    source: fs.readFileSync(path.join(cwd, 'src/owned.txt')),
    staged: fs.readFileSync(path.join(cwd, 'src/sentinel.txt')),
  }));
  expect(success(execute(f, ['git-status'])).stdout).toBe('');
  fs.writeFileSync(path.join(f.lane, 'src/owned.txt'), 'owned fixed\n');
  success(execute(f, ['git-stage', '--', 'src/owned.txt']));
  success(
    execute(f, ['git-commit', '--message', 'fix: update owned source', '--', 'src/owned.txt'])
  );
  const merged = success(
    execute(f, ['worktree-merge', '--worktree', 'owned', '--spec', 'EXEC-001'], { cwd: f.root })
  ).data.merge_commit;
  success(
    execute(f, ['bridge-claim', '--spec', 'EXEC-001', '--merge-commit', merged], { cwd: f.root })
  );
  success(
    execute(
      f,
      [
        'spec-close',
        '--spec',
        'EXEC-001',
        '--merge-commit',
        merged,
        '--reason',
        'consumer checked',
      ],
      { cwd: f.root }
    )
  );
  expect(spec(f).lifecycle_state).toBe('closed');
  expect(fs.readFileSync(path.join(f.root, 'src/owned.txt'), 'utf8')).toBe('owned fixed\n');
  for (const [index, cwd] of others.entries()) {
    expect(git(cwd, ['rev-parse', 'HEAD'])).toBe(before[index].head);
    expect(git(cwd, ['--no-optional-locks', 'status', '--short'])).toBe(before[index].status);
    expect(
      fs.readFileSync(git(cwd, ['rev-parse', '--path-format=absolute', '--git-path', 'index']))
    ).toEqual(before[index].index);
    expect(fs.readFileSync(path.join(cwd, 'src/owned.txt'))).toEqual(before[index].source);
    expect(fs.readFileSync(path.join(cwd, 'src/sentinel.txt'))).toEqual(before[index].staged);
  }
});

test('duplicate owned branch permits index-only staging but refuses its shared ref publication', () => {
  const f = fixture();
  const extra = path.join(f.root, 'owned-duplicate');
  git(f.root, ['worktree', 'add', '--force', extra, 'owned']);
  const head = git(extra, ['rev-parse', 'HEAD']);
  const index = fs.readFileSync(
    git(extra, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])
  );
  fs.writeFileSync(path.join(f.lane, 'src/owned.txt'), 'owned change\n');
  expect(success(execute(f, ['git-status'])).stdout).toBe(' M src/owned.txt\n');
  success(execute(f, ['git-stage', '--', 'src/owned.txt']));
  const result = execute(f, [
    'git-commit',
    '--message',
    'fix: refuse duplicate ref',
    '--',
    'src/owned.txt',
  ]);
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('scope_refused');
  expect(git(extra, ['rev-parse', 'HEAD'])).toBe(head);
  expect(
    fs.readFileSync(git(extra, ['rev-parse', '--path-format=absolute', '--git-path', 'index']))
  ).toEqual(index);
  expect(git(f.lane, ['diff', '--cached', '--name-only'])).toBe('src/owned.txt');
});

test.each(['worktree-merge', 'spec-close'])(
  'refuses an extra forced base checkout before %s and preserves that checkout',
  (operation) => {
    const f = fixture();
    let mergeCommit;
    if (operation !== 'worktree-merge') {
      mergeCommit = success(
        execute(f, ['worktree-merge', '--worktree', 'owned', '--spec', 'EXEC-001'], { cwd: f.root })
      ).data.merge_commit;
      if (operation === 'spec-close')
        success(
          execute(f, ['bridge-claim', '--spec', 'EXEC-001', '--merge-commit', mergeCommit], {
            cwd: f.root,
          })
        );
    }
    const extra = path.join(f.root, 'forced-extra-base');
    git(f.root, ['worktree', 'add', '--force', extra, f.registry.owned.baseBranch]);
    const index = git(extra, ['rev-parse', '--path-format=absolute', '--git-path', 'index']);
    const before = {
      tracked: fs.readFileSync(path.join(extra, '.gitignore')),
      index: fs.readFileSync(index),
      refs: git(f.root, ['show-ref', '--head']),
      head: git(extra, ['rev-parse', 'HEAD']),
      registry: fs.readFileSync(f.registryPath),
      spec: fs.readFileSync(f.specPath),
      events: fs.existsSync(path.join(f.caws, 'events.jsonl'))
        ? fs.readFileSync(path.join(f.caws, 'events.jsonl'))
        : null,
    };
    const argv =
      operation === 'worktree-merge'
        ? ['worktree-merge', '--worktree', 'owned', '--spec', 'EXEC-001']
        : [
            operation,
            '--spec',
            'EXEC-001',
            '--merge-commit',
            mergeCommit,
            ...(operation === 'spec-close' ? ['--reason', 'consumer checked'] : []),
          ];
    const result = execute(f, argv, { cwd: f.root });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('scope_refused');
    expect(fs.readFileSync(path.join(extra, '.gitignore'))).toEqual(before.tracked);
    expect(fs.readFileSync(index)).toEqual(before.index);
    expect(git(f.root, ['show-ref', '--head'])).toBe(before.refs);
    expect(git(extra, ['rev-parse', 'HEAD'])).toBe(before.head);
    expect(fs.readFileSync(f.registryPath)).toEqual(before.registry);
    expect(fs.readFileSync(f.specPath)).toEqual(before.spec);
    expect(
      fs.existsSync(path.join(f.caws, 'events.jsonl'))
        ? fs.readFileSync(path.join(f.caws, 'events.jsonl'))
        : null
    ).toEqual(before.events);
    expect(fs.existsSync(extra)).toBe(true);
  }
);
