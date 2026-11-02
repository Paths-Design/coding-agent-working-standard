/**
 * Lifecycle audit commits never stage a path that does not exist, and a destroy
 * of a worktree whose bound spec is archived audits the spec at its real
 * .archive/ path. CAWS-DEFECT-WORKTREE-DESTROY-ARCHIVED-SPEC-AUDIT-COMMIT-01.
 *
 * These drive the REAL compiled writers against REAL temp git repositories.
 * Before the fix, destroy always git-added `.caws/specs/<id>.yaml`; for an
 * archived spec that path is gone, so `git add` failed with "pathspec ... did
 * not match" and the transition was reported NOT committed (refused_dirty).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { createSpec, closeSpec, archiveSpec } = require('../../dist/store/specs-writer');
const { createWorktree, destroyWorktree } = require('../../dist/store/worktrees-writer');
const { autoCommit } = require('../../dist/store/git-autocommit');
const { initProject } = require('../../dist/store/init-store');
const lifecycleLock = require('../../dist/store/lifecycle-lock');

const SESSION = { session_id: 'sess-destroy-archived', platform: 'jest' };
const ACTOR = { kind: 'agent', id: 'destroy-archived-agent', session_id: SESSION.session_id };
const CANDIDATES = {
  candidates: [{ identity: SESSION, source: 'hook_env' }],
  trace: [],
};

const repos = [];

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

function mkRepo(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync('git', ['init', '--quiet', '-b', 'main', root]);
  git(root, ['config', 'user.email', 't@test.com']);
  git(root, ['config', 'user.name', 'Test']);
  git(root, ['commit', '--quiet', '--allow-empty', '-m', 'init']);
  repos.push(root);
  return root;
}

function commitAll(repo, message) {
  git(repo, ['add', '-A']);
  git(repo, ['commit', '--quiet', '--no-verify', '-m', message]);
}

function head(repo) {
  return git(repo, ['rev-parse', 'HEAD']);
}

function filesInCommit(repo, rev) {
  return git(repo, ['show', '--name-only', '--format=', rev])
    .split('\n')
    .filter((l) => l.length > 0);
}

function stagedPaths(repo) {
  return git(repo, ['diff', '--cached', '--name-only']);
}

/** Repo with a spec bound to a worktree; optionally archives the spec body. */
function setup(prefix, specId, { archive, ignoreArchive }) {
  const repo = mkRepo(prefix);
  const init = initProject(repo);
  if (!init.ok) throw new Error('initProject failed: ' + JSON.stringify(init.errors));
  const caws = path.join(repo, '.caws');
  // The registry and worktree checkouts are ephemeral, untracked state in a
  // real CAWS repo (the destroy audit set drops them as gitignored).
  fs.appendFileSync(path.join(repo, '.gitignore'), '\n.caws/worktrees.json\n.caws/worktrees/\n');
  if (ignoreArchive) {
    fs.appendFileSync(path.join(repo, '.gitignore'), '.archive/\n');
  }
  const spec = createSpec(caws, {
    id: specId,
    title: 'x',
    mode: 'chore',
    actor: ACTOR,
    scopeIn: ['payload.txt'],
  });
  if (!spec.ok || spec.value.kind !== 'success') throw new Error('createSpec failed');
  commitAll(repo, 'seed spec');
  const created = createWorktree(caws, { name: 'wt', specId, session: SESSION, actor: ACTOR });
  if (!created.ok || created.value.kind !== 'success') {
    throw new Error('createWorktree failed: ' + JSON.stringify(created));
  }
  if (archive) {
    const closed = closeSpec(caws, {
      id: specId,
      resolution: 'completed',
      reason: 'fixture',
      actor: ACTOR,
    });
    if (!closed.ok || closed.value.kind !== 'success') {
      throw new Error('closeSpec failed: ' + JSON.stringify(closed));
    }
    commitAll(repo, 'close spec');
    const archived = archiveSpec(caws, { id: specId, actor: ACTOR });
    if (!archived.ok || archived.value.kind !== 'success') {
      throw new Error('archiveSpec failed: ' + JSON.stringify(archived));
    }
    commitAll(repo, 'archive spec');
  }
  return { repo, caws };
}

function destroy(caws) {
  return destroyWorktree(caws, {
    name: 'wt',
    session: SESSION,
    sessionCandidates: CANDIDATES,
    actor: ACTOR,
  });
}

afterAll(() => {
  for (const r of repos) {
    try {
      fs.rmSync(r, { recursive: true, force: true });
    } catch {
      /* best effort cleanup */
    }
  }
});
afterEach(() => jest.restoreAllMocks());

function expectArchivedTeardown(repo, caws, specId, bytes) {
  expect(fs.readFileSync(path.join(caws, 'specs/.archive', specId + '.yaml'))).toEqual(bytes);
  expect(fs.existsSync(path.join(caws, 'specs', specId + '.yaml'))).toBe(false);
  expect(fs.existsSync(path.join(caws, 'worktrees/wt'))).toBe(false);
  expect(JSON.parse(fs.readFileSync(path.join(caws, 'worktrees.json'), 'utf8')).wt).toBeUndefined();
  const events = fs
    .readFileSync(path.join(caws, 'events.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map(JSON.parse);
  expect(events.filter((event) => event.event === 'worktree_destroyed')).toEqual([
    expect.objectContaining({
      data: expect.objectContaining({ worktree_name: 'wt', removed_git_worktree: true }),
    }),
  ]);
  expect(stagedPaths(repo)).toBe('');
}

describe('A1: destroy of a worktree bound to an archived spec', () => {
  test('archived and gitignored body: committed no-op, never a git-add failure', () => {
    const SPEC = 'DAA-A1-IGNORED-001';
    const { repo, caws } = setup('daa-a1i-', SPEC, { archive: true, ignoreArchive: true });
    const archivedBody = path.join(caws, 'specs', '.archive', `${SPEC}.yaml`);
    expect(fs.existsSync(archivedBody)).toBe(true);
    expect(fs.existsSync(path.join(caws, 'specs', `${SPEC}.yaml`))).toBe(false);
    expect(git(repo, ['check-ignore', '--', `.caws/specs/.archive/${SPEC}.yaml`])).not.toBe('');
    const before = head(repo);
    const archiveBytes = fs.readFileSync(archivedBody);

    const result = destroy(caws);

    expect(result).toMatchObject({ ok: true, value: { kind: 'success' } });
    const audit = result.value.data.audit_commit;
    expect(audit).toEqual({ kind: 'committed', sha: '' });
    expect(head(repo)).toBe(before);
    expect(stagedPaths(repo)).toBe('');
    expectArchivedTeardown(repo, caws, SPEC, archiveBytes);
  });

  test('archived and tracked body: unchanged by destroy, so committed no-op with a clean index', () => {
    const SPEC = 'DAA-A1-TRACKED-001';
    const { repo, caws } = setup('daa-a1t-', SPEC, { archive: true, ignoreArchive: false });
    expect(git(repo, ['ls-files', `.caws/specs/.archive/${SPEC}.yaml`])).toBe(
      `.caws/specs/.archive/${SPEC}.yaml`
    );
    const before = head(repo);
    const archiveBytes = fs.readFileSync(path.join(caws, 'specs/.archive', SPEC + '.yaml'));

    const result = destroy(caws);

    expect(result).toMatchObject({ ok: true, value: { kind: 'success' } });
    expect(result.value.data.audit_commit).toEqual({ kind: 'committed', sha: '' });
    expect(head(repo)).toBe(before);
    expect(stagedPaths(repo)).toBe('');
    expectArchivedTeardown(repo, caws, SPEC, archiveBytes);
  });

  test.each(['changed archive', 'missing archive', 'new live body', 'dangling live link'])(
    'retirement revalidates archive selection under the lock: %s',
    (change) => {
      const SPEC = 'DAA-ARCHIVE-CAS-001';
      const { repo, caws } = setup('daa-archive-cas-', SPEC, {
        archive: true,
        ignoreArchive: true,
      });
      const archived = path.join(caws, 'specs/.archive', SPEC + '.yaml');
      const live = path.join(caws, 'specs', SPEC + '.yaml');
      const bytes = fs.readFileSync(archived);
      const registry = fs.readFileSync(path.join(caws, 'worktrees.json'));
      const events = fs.readFileSync(path.join(caws, 'events.jsonl'));
      const original = lifecycleLock.withLifecycleLock;
      const lock = jest
        .spyOn(lifecycleLock, 'withLifecycleLock')
        .mockImplementation((dir, body, opts) => {
          if (change === 'changed archive')
            fs.appendFileSync(archived, '\n# concurrent archive change\n');
          if (change === 'missing archive') fs.unlinkSync(archived);
          if (change === 'new live body') fs.writeFileSync(live, bytes);
          if (change === 'dangling live link')
            fs.symlinkSync(path.join(repo, 'absent-target'), live);
          return original(dir, body, opts);
        });
      const result = destroy(caws);
      expect(lock).toHaveBeenCalledTimes(1);
      expect(result.ok).toBe(false);
      expect(result.errors.map((d) => d.message).join(' ')).toMatch(
        /retirement authority|Authority changed/
      );
      expect(fs.existsSync(path.join(caws, 'worktrees/wt'))).toBe(true);
      expect(fs.readFileSync(path.join(caws, 'worktrees.json'))).toEqual(registry);
      expect(fs.readFileSync(path.join(caws, 'events.jsonl'))).toEqual(events);
      if (change === 'changed archive')
        expect(fs.readFileSync(archived)).toEqual(
          Buffer.concat([bytes, Buffer.from('\n# concurrent archive change\n')])
        );
      if (change === 'missing archive') expect(fs.existsSync(archived)).toBe(false);
      if (change === 'new live body') expect(fs.readFileSync(live)).toEqual(bytes);
      if (change === 'dangling live link') expect(fs.lstatSync(live).isSymbolicLink()).toBe(true);
      expect(stagedPaths(repo)).toBe('');
    }
  );

  test.each(['wrong id', 'active', 'bound', 'malformed'])(
    'invalid archived authority refuses before teardown: %s',
    (change) => {
      const SPEC = 'DAA-ARCHIVE-INVALID-001';
      const { caws } = setup('daa-archive-invalid-', SPEC, { archive: true, ignoreArchive: true });
      const archived = path.join(caws, 'specs/.archive', SPEC + '.yaml');
      let source = fs.readFileSync(archived, 'utf8');
      if (change === 'wrong id') source = source.replace(SPEC, 'DAA-OTHER-001');
      if (change === 'active')
        source = source.replace('lifecycle_state: archived', 'lifecycle_state: active');
      if (change === 'bound') source += '\nworktree: wt\n';
      if (change === 'malformed') source = 'broken: [\n';
      fs.writeFileSync(archived, source);
      const registry = fs.readFileSync(path.join(caws, 'worktrees.json'));
      const events = fs.readFileSync(path.join(caws, 'events.jsonl'));
      const result = destroy(caws);
      expect(result.ok).toBe(false);
      expect(fs.existsSync(path.join(caws, 'worktrees/wt'))).toBe(true);
      expect(fs.readFileSync(archived, 'utf8')).toBe(source);
      expect(fs.readFileSync(path.join(caws, 'worktrees.json'))).toEqual(registry);
      expect(fs.readFileSync(path.join(caws, 'events.jsonl'))).toEqual(events);
    }
  );

  test('a live spec takes precedence over its retained historical archive', () => {
    const SPEC = 'DAA-LIVE-PRECEDENCE-001';
    const { repo, caws } = setup('daa-live-precedence-', SPEC, {
      archive: false,
      ignoreArchive: true,
    });
    const live = path.join(caws, 'specs', SPEC + '.yaml');
    const archived = path.join(caws, 'specs/.archive', SPEC + '.yaml');
    const oldBytes = Buffer.from('id: DAA-HISTORICAL-001\nlifecycle_state: archived\n');
    fs.mkdirSync(path.dirname(archived), { recursive: true });
    fs.writeFileSync(archived, oldBytes);
    const result = destroy(caws);
    expect(result).toMatchObject({ ok: true, value: { kind: 'success' } });
    expect(fs.readFileSync(archived)).toEqual(oldBytes);
    expect(fs.readFileSync(live, 'utf8')).not.toMatch(/^worktree:/m);
    expect(fs.existsSync(path.join(caws, 'worktrees/wt'))).toBe(false);
    expect(stagedPaths(repo)).toBe('');
  });

  test('a failed live-path observation cannot select an archive', () => {
    const SPEC = 'DAA-LIVE-UNOBSERVED-001';
    const { caws } = setup('daa-live-unobserved-', SPEC, { archive: true, ignoreArchive: true });
    const live = path.join(caws, 'specs', SPEC + '.yaml');
    const events = fs.readFileSync(path.join(caws, 'events.jsonl'));
    const registry = fs.readFileSync(path.join(caws, 'worktrees.json'));
    const original = fs.lstatSync;
    const observed = jest.spyOn(fs, 'lstatSync').mockImplementation((file, ...args) => {
      if (file === live) throw Object.assign(new Error('denied observation'), { code: 'EACCES' });
      return original(file, ...args);
    });
    const result = destroy(caws);
    expect(observed).toHaveBeenCalledWith(live);
    expect(result.ok).toBe(false);
    expect(result.errors.map((d) => d.message).join(' ')).toContain(
      'Cannot select retirement authority'
    );
    expect(fs.existsSync(path.join(caws, 'worktrees/wt'))).toBe(true);
    expect(fs.readFileSync(path.join(caws, 'events.jsonl'))).toEqual(events);
    expect(fs.readFileSync(path.join(caws, 'worktrees.json'))).toEqual(registry);
  });

  test('live spec: destroy still lands an audit commit containing exactly the live spec path', () => {
    const SPEC = 'DAA-A1-LIVE-001';
    const { repo, caws } = setup('daa-a1l-', SPEC, { archive: false, ignoreArchive: false });
    const before = head(repo);

    const result = destroy(caws);

    expect(result.ok).toBe(true);
    expect(result.value.kind).toBe('success');
    const audit = result.value.data.audit_commit;
    expect(audit.kind).toBe('committed');
    expect(audit.sha).toMatch(/^[0-9a-f]{7,}$/);
    expect(head(repo)).not.toBe(before);
    expect(filesInCommit(repo, 'HEAD')).toEqual([`.caws/specs/${SPEC}.yaml`]);
    expect(stagedPaths(repo)).toBe('');
  });
});

describe('autoCommit input paths that are absent on disk', () => {
  function plainRepo(prefix) {
    const repo = mkRepo(prefix);
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'one\n');
    commitAll(repo, 'add tracked');
    return repo;
  }

  test('A2: absent path is dropped; existing changed path still commits alone', () => {
    const repo = plainRepo('daa-a2-');
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'two\n');

    const outcome = autoCommit({
      repoRoot: repo,
      paths: ['gone/missing.yaml', 'tracked.txt'],
      message: 'chore(caws): a2',
      wasDirtyBeforeWrite: false,
    });

    expect(outcome.kind).toBe('committed');
    expect(outcome.sha).toMatch(/^[0-9a-f]{7,}$/);
    expect(git(repo, ['rev-parse', '--short', 'HEAD'])).toBe(outcome.sha);
    expect(filesInCommit(repo, outcome.sha)).toEqual(['tracked.txt']);
    expect(fs.existsSync(path.join(repo, 'gone'))).toBe(false);
    expect(stagedPaths(repo)).toBe('');
  });

  test('A2: an existing, non-ignored archived-style body is staged and committed', () => {
    const repo = plainRepo('daa-a2b-');
    fs.mkdirSync(path.join(repo, '.caws', 'specs', '.archive'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.caws', 'specs', '.archive', 'S.yaml'), 'id: S\n');

    const outcome = autoCommit({
      repoRoot: repo,
      paths: ['.caws/specs/S.yaml', '.caws/specs/.archive/S.yaml'],
      message: 'chore(caws): archived body',
      wasDirtyBeforeWrite: false,
    });

    expect(outcome.kind).toBe('committed');
    expect(filesInCommit(repo, outcome.sha)).toEqual(['.caws/specs/.archive/S.yaml']);
  });

  test('a tracked path deleted on disk is kept so the audit commit records the removal', () => {
    const repo = plainRepo('daa-del-');
    fs.rmSync(path.join(repo, 'tracked.txt'));

    const outcome = autoCommit({
      repoRoot: repo,
      paths: ['tracked.txt', 'gone/missing.yaml'],
      message: 'chore(caws): delete',
      wasDirtyBeforeWrite: false,
    });

    expect(outcome.kind).toBe('committed');
    expect(git(repo, ['show', '--name-status', '--format=', outcome.sha])).toBe('D\ttracked.txt');
    expect(stagedPaths(repo)).toBe('');
  });

  test('A3: every path absent or gitignored is the committed no-op', () => {
    const repo = plainRepo('daa-a3-');
    fs.writeFileSync(path.join(repo, '.gitignore'), 'ignored.txt\n');
    commitAll(repo, 'ignore');
    fs.writeFileSync(path.join(repo, 'ignored.txt'), 'x\n');
    const before = head(repo);

    const outcome = autoCommit({
      repoRoot: repo,
      paths: ['gone/missing.yaml', 'ignored.txt'],
      message: 'chore(caws): a3',
      wasDirtyBeforeWrite: false,
    });

    expect(outcome).toEqual({ kind: 'committed', sha: '' });
    expect(head(repo)).toBe(before);
    expect(stagedPaths(repo)).toBe('');
  });
});
