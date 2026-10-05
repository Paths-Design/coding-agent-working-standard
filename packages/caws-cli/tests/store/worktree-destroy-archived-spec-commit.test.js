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

describe('A1: destroy of a worktree bound to an archived spec', () => {
  test('archived and gitignored body: committed no-op, never a git-add failure', () => {
    const SPEC = 'DAA-A1-IGNORED-001';
    const { repo, caws } = setup('daa-a1i-', SPEC, { archive: true, ignoreArchive: true });
    const archivedBody = path.join(caws, 'specs', '.archive', `${SPEC}.yaml`);
    expect(fs.existsSync(archivedBody)).toBe(true);
    expect(fs.existsSync(path.join(caws, 'specs', `${SPEC}.yaml`))).toBe(false);
    expect(git(repo, ['check-ignore', '--', `.caws/specs/.archive/${SPEC}.yaml`])).not.toBe('');
    const before = head(repo);

    const result = destroy(caws);

    expect(result.ok).toBe(true);
    expect(result.value.kind).toBe('success');
    const audit = result.value.data.audit_commit;
    expect(audit).toEqual({ kind: 'committed', sha: '' });
    expect(head(repo)).toBe(before);
    expect(stagedPaths(repo)).toBe('');
  });

  test('archived and tracked body: unchanged by destroy, so committed no-op with a clean index', () => {
    const SPEC = 'DAA-A1-TRACKED-001';
    const { repo, caws } = setup('daa-a1t-', SPEC, { archive: true, ignoreArchive: false });
    expect(git(repo, ['ls-files', `.caws/specs/.archive/${SPEC}.yaml`])).toBe(
      `.caws/specs/.archive/${SPEC}.yaml`
    );
    const before = head(repo);

    const result = destroy(caws);

    expect(result.ok).toBe(true);
    expect(result.value.kind).toBe('success');
    expect(result.value.data.audit_commit).toEqual({ kind: 'committed', sha: '' });
    expect(head(repo)).toBe(before);
    expect(stagedPaths(repo)).toBe('');
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
