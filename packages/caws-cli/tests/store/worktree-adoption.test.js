'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { initProject } = require('../../dist/store/init-store');
const { createSpec } = require('../../dist/store/specs-writer');
const { adoptWorktree } = require('../../dist/store/worktrees-writer');
const { acquireBridge } = require('../../dist/store/bridge-store');
const events = require('../../dist/store/events-store');
const session = { session_id: 'adoption-owner', platform: 'test' };
const actor = { kind: 'agent', id: 'test', session_id: session.session_id };
const sessionCandidates = { candidates: [{ identity: session, source: 'hook_env' }], trace: [] };
let root, repo, external, caws;
function git(cwd, ...args) {
  return cp.execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args], {
    encoding: 'utf8',
  });
}
function must(result) {
  if (!result.ok || result.value.kind !== 'success') throw new Error(JSON.stringify(result));
  return result.value;
}
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'caws-adopt-')));
  repo = path.join(root, 'repo');
  external = path.join(root, 'app-checkout');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src/car.txt'), 'original\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'initial');
  const initialized = initProject(repo);
  if (!initialized.ok) throw new Error(JSON.stringify(initialized));
  caws = path.join(repo, '.caws');
  must(
    createSpec(caws, {
      id: 'ADOPT-001',
      title: 'Adopt lane',
      mode: 'fix',
      actor,
      initialState: 'draft',
      scopeIn: ['src/'],
    })
  );
  git(repo, 'add', '.caws');
  git(repo, 'commit', '-qm', 'governance');
  git(repo, 'worktree', 'add', '-qb', 'caws/app-lane', external, 'main');
});
afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});
function adopt(overrides = {}) {
  return adoptWorktree(caws, {
    name: 'app-lane',
    path: external,
    specId: 'ADOPT-001',
    baseBranch: 'main',
    session,
    sessionCandidates,
    actor,
    ...overrides,
  });
}
function sourceSnapshot() {
  return {
    head: git(external, 'rev-parse', 'HEAD'),
    branch: git(external, 'rev-parse', '--abbrev-ref', 'HEAD'),
    staged: git(external, 'diff', '--cached', '--', 'src'),
    unstaged: git(external, 'diff', '--', 'src'),
    bytes: fs.readFileSync(path.join(external, 'src/car.txt')).toString('hex'),
    untracked: fs.existsSync(path.join(external, 'src/draft.bin'))
      ? fs.readFileSync(path.join(external, 'src/draft.bin')).toString('hex')
      : null,
  };
}
function dirtySource() {
  fs.writeFileSync(path.join(external, 'src/car.txt'), 'staged\n');
  git(external, 'add', 'src/car.txt');
  fs.appendFileSync(path.join(external, 'src/car.txt'), 'unstaged\n');
  fs.writeFileSync(path.join(external, 'src/draft.bin'), Buffer.from([0, 255, 10, 13]));
}
test('adopts real external Git checkout, activates canonical binding and preserves all source states', () => {
  dirtySource();
  const before = sourceSnapshot();
  const value = must(adopt());
  expect(value.action).toBe('adopted');
  expect(sourceSnapshot()).toEqual(before);
  const registry = JSON.parse(fs.readFileSync(path.join(caws, 'worktrees.json')));
  expect(registry['app-lane']).toMatchObject({
    path: external,
    specId: 'ADOPT-001',
    owner: session,
    branch: 'caws/app-lane',
    baseBranch: 'main',
  });
  const spec = fs.readFileSync(path.join(caws, 'specs/ADOPT-001.yaml'), 'utf8');
  expect(spec).toMatch(/lifecycle_state: active/);
  expect(spec).toMatch(/worktree: ['"]?app-lane/);
  expect(fs.existsSync(path.join(external, '.caws/specs/ADOPT-001.yaml'))).toBe(false);
  expect(git(external, 'sparse-checkout', 'list')).toBe('/*\n!/.caws/specs/\n');
});
test.each(['canonical', 'subdirectory', 'foreign', 'detached'])(
  'refuses %s identity without changing source',
  (kind) => {
    dirtySource();
    const before = sourceSnapshot();
    let target = external;
    if (kind === 'canonical') target = repo;
    if (kind === 'subdirectory') target = path.join(external, 'src');
    if (kind === 'foreign') {
      target = path.join(root, 'foreign');
      fs.mkdirSync(target);
      git(target, 'init', '-q');
    }
    if (kind === 'detached') git(external, 'checkout', '--detach', '-q');
    const result = adopt({ path: target });
    expect(result.ok).toBe(false);
    if (kind !== 'detached') expect(sourceSnapshot()).toEqual(before);
    expect(fs.existsSync(external)).toBe(true);
    expect(
      JSON.parse(fs.readFileSync(path.join(caws, 'worktrees.json')))['app-lane']
    ).toBeUndefined();
  }
);
test.each(['ordinary', 'assume-unchanged', 'skip-worktree'])(
  'refuses %s authority edits without losing hidden bytes',
  (flag) => {
    const rel = '.caws/specs/ADOPT-001.yaml';
    if (flag !== 'ordinary') git(external, 'update-index', `--${flag}`, rel);
    fs.appendFileSync(path.join(external, rel), '\n# local work\n');
    const before = fs.readFileSync(path.join(external, rel));
    const result = adopt();
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toContain('.caws/specs');
    expect(fs.readFileSync(path.join(external, rel))).toEqual(before);
  }
);
test('refuses a foreign spec bridge without source or authority changes', () => {
  const claimed = acquireBridge(caws, {
    specId: 'ADOPT-001',
    session: { session_id: 'other-owner' },
    actor,
    now: new Date(),
  });
  // Exercise the actual bridge store shape; an invalid setup cannot pass this control.
  expect(claimed.ok).toBe(true);
  const result = adopt();
  expect(result.ok).toBe(false);
  expect(JSON.stringify(result)).toContain('foreign owner');
  expect(fs.existsSync(path.join(external, '.caws/specs/ADOPT-001.yaml'))).toBe(true);
});
test('refuses overlapping registered payloads even with a different name', () => {
  fs.writeFileSync(
    path.join(caws, 'worktrees.json'),
    JSON.stringify({
      other: {
        specId: 'OTHER-001',
        path: path.join(external, 'src'),
        owner: { session_id: 'other' },
      },
    })
  );
  const result = adopt();
  expect(result.ok).toBe(false);
  expect(JSON.stringify(result)).toContain('overlaps');
});
test('event failure restores index, authority and source while retaining the checkout', () => {
  dirtySource();
  const before = sourceSnapshot();
  const directory = git(external, 'rev-parse', '--absolute-git-dir').trim();
  const index = fs.readFileSync(path.join(directory, 'index'));
  const authority = fs.readFileSync(path.join(external, '.caws/specs/ADOPT-001.yaml'));
  const original = events.appendEvent;
  jest.spyOn(events, 'appendEvent').mockImplementation((...args) => {
    if (args[1].event === 'worktree_created')
      return {
        ok: false,
        errors: [{ rule: 'test.append.failure', severity: 'error', message: 'injected' }],
      };
    return original(...args);
  });
  const result = adopt();
  expect(result).toMatchObject({ ok: true, value: { kind: 'partial_failure_recovered' } });
  expect(sourceSnapshot()).toEqual(before);
  expect(fs.readFileSync(path.join(directory, 'index'))).toEqual(index);
  expect(fs.readFileSync(path.join(external, '.caws/specs/ADOPT-001.yaml'))).toEqual(authority);
  expect(
    JSON.parse(fs.readFileSync(path.join(caws, 'worktrees.json')))['app-lane']
  ).toBeUndefined();
});
test('registered CLI adopt dispatches to the real store and records its caller', () => {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (/^(?:HOOK_|_HOOK_|_CAWS_|CAWS_|CODEX_|CLAUDE_|GIT_)/.test(key)) delete environment[key];
  }
  environment.CODEX_THREAD_ID = session.session_id;
  environment.CAWS_AGENT_SURFACE = 'codex';
  environment.CAWS_HOME = path.join(root, 'home');
  const result = cp.spawnSync(
    process.execPath,
    [
      path.resolve(__dirname, '../../dist/index.js'),
      'worktree',
      'adopt',
      'app-lane',
      '--path',
      external,
      '--spec',
      'ADOPT-001',
      '--base-branch',
      'main',
    ],
    { cwd: repo, env: environment, encoding: 'utf8' }
  );
  expect({ code: result.status, stderr: result.stderr }).toEqual({ code: 0, stderr: '' });
  expect(result.stdout).toContain('adopted app-lane');
  expect(
    JSON.parse(fs.readFileSync(path.join(caws, 'worktrees.json')))['app-lane'].owner.session_id
  ).toBe(session.session_id);
});
test('detached app checkout attaches an explicitly requested branch without changing source', () => {
  git(external, 'checkout', '--detach', '-q');
  dirtySource();
  const before = sourceSnapshot();
  must(adopt({ branch: 'caws/adopted-detached' }));
  const after = sourceSnapshot();
  expect(after.branch).toBe('caws/adopted-detached\n');
  expect({ ...after, branch: before.branch }).toEqual(before);
});
test('rollback refuses to overwrite concurrent staging after sparse setup', () => {
  dirtySource();
  const original = events.appendEvent;
  jest.spyOn(events, 'appendEvent').mockImplementation((...args) => {
    if (args[1].event === 'worktree_created') {
      fs.writeFileSync(path.join(external, 'src/car.txt'), 'concurrent staged bytes\n');
      git(external, 'add', 'src/car.txt');
      return {
        ok: false,
        errors: [{ rule: 'test.append.failure', severity: 'error', message: 'injected' }],
      };
    }
    return original(...args);
  });
  const result = adopt();
  expect(result.ok).toBe(false);
  expect(JSON.stringify(result)).toContain('Source staging changed');
  expect(git(external, 'show', ':src/car.txt')).toBe('concurrent staged bytes\n');
  expect(fs.readFileSync(path.join(external, 'src/car.txt'), 'utf8')).toBe(
    'concurrent staged bytes\n'
  );
  expect(
    JSON.parse(fs.readFileSync(path.join(caws, 'worktrees.json')))['app-lane']
  ).toBeUndefined();
});
