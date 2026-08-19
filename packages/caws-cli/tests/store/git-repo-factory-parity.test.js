'use strict';

/**
 * CAWS-GIT-SPAWN-COST-001 — the test-repo factory builds by copy, not by spawn.
 *
 * `makeTempRepo` used to run six git subprocesses per repo (1257 ms in a jest
 * worker); it now copies a per-worker template (5.1 ms). That is only sound if
 * a copied repository is INDISTINGUISHABLE from an initialized one, so this
 * file pins the equivalence rather than the speed.
 *
 * The load-bearing property is that a git repository is position-independent:
 * nothing under `.git/` records its own absolute path, so a directory copy is a
 * real repository at its new location. If that ever stops being true — a git
 * change, a `core.worktree` setting, an absolute path in the template — the
 * toplevel test below is what catches it.
 */

const fs = require('fs');
const path = require('path');

const { makeTempRepo, cleanupRepo, cleanupAll, git } = require('../helpers/git-repo-factory');

afterAll(() => {
  cleanupAll();
});

describe('temp repo factory parity', () => {
  test('a repo is a real repository rooted at its own path, not the template', () => {
    const repo = makeTempRepo();

    // The decisive assertion: git resolves the toplevel to THIS directory. A
    // template that leaked an absolute path would resolve to the template.
    const toplevel = git(repo, ['rev-parse', '--show-toplevel']);
    expect(fs.realpathSync(toplevel)).toBe(fs.realpathSync(repo));
    expect(git(repo, ['rev-parse', '--is-inside-work-tree'])).toBe('true');
  });

  test('the default shape has a main branch, one root commit, and a clean tree', () => {
    const repo = makeTempRepo();

    expect(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main');
    expect(git(repo, ['status', '--porcelain'])).toBe('');
    expect(git(repo, ['rev-list', '--count', 'HEAD'])).toBe('1');
    expect(git(repo, ['log', '-1', '--pretty=%s'])).toBe('root commit');
  });

  test('the hermetic config survives the copy', () => {
    const repo = makeTempRepo();

    expect(git(repo, ['config', '--get', 'user.email'])).toBe('test@caws.invalid');
    expect(git(repo, ['config', '--get', 'commit.gpgsign'])).toBe('false');
    expect(git(repo, ['config', '--get', 'core.hooksPath'])).toBe('/dev/null');
  });

  test('two repos are fully independent — a commit in one is invisible to the other', () => {
    const a = makeTempRepo();
    const b = makeTempRepo();

    expect(a).not.toBe(b);
    fs.writeFileSync(path.join(a, 'only-in-a.txt'), 'a\n');
    git(a, ['add', 'only-in-a.txt']);
    git(a, ['commit', '-q', '-m', 'work in a']);

    expect(git(a, ['rev-list', '--count', 'HEAD'])).toBe('2');
    expect(git(b, ['rev-list', '--count', 'HEAD'])).toBe('1');
    expect(git(b, ['status', '--porcelain'])).toBe('');
    expect(fs.existsSync(path.join(b, 'only-in-a.txt'))).toBe(false);
  });

  test('a non-default branch name is honoured and does not reuse the main template', () => {
    const dev = makeTempRepo({ defaultBranch: 'dev' });
    const main = makeTempRepo();

    expect(git(dev, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('dev');
    expect(git(main, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main');
  });

  test('initialCommit:false yields a repo with no commits, not a copy of the committed shape', () => {
    const bare = makeTempRepo({ initialCommit: false });

    expect(git(bare, ['rev-parse', '--is-inside-work-tree'])).toBe('true');
    // No HEAD commit: rev-parse HEAD fails, which allowFail surfaces as ''.
    expect(git(bare, ['rev-parse', 'HEAD'], { allowFail: true })).toBe('');
  });

  test('cleanupRepo removes the repo and leaves later repos workable', () => {
    const doomed = makeTempRepo();
    expect(fs.existsSync(doomed)).toBe(true);

    cleanupRepo(doomed);
    expect(fs.existsSync(doomed)).toBe(false);

    // The template must NOT have been removed along with it — the next repo
    // still builds. (Sharing one template is the whole optimization; deleting
    // it with the first repo would silently restore the six-spawn cost.)
    const next = makeTempRepo();
    expect(git(next, ['status', '--porcelain'])).toBe('');
  });
});
