/**
 * caws worktree merge deletes the merged branch.
 * CAWS-WORKTREE-MERGE-DELETE-BRANCH-001.
 *
 * These drive the REAL compiled writers against REAL git repositories in
 * temp dirs — no mocked git — because the property under test is what git
 * itself does with `branch -d`.
 *
 * The safety argument this suite defends: after a successful `--no-ff`
 * merge the branch is by definition reachable from base, so `-d` cannot
 * lose work. A4 is the load-bearing case — a `-D` implementation would
 * satisfy every outcome assertion in A1 identically while destroying the
 * safety property, so it is asserted directly rather than by outcome.
 *
 * Measured motivation: this repo accumulated 210 fully-merged orphaned
 * branches out of 219 local branches before the fix.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { createSpec } = require('../../dist/store/specs-writer');
const {
  createWorktree,
  destroyWorktree,
  mergeWorktree,
} = require('../../dist/store/worktrees-writer');
const { initProject } = require('../../dist/store/init-store');

const SESSION_ID = 'sess-branch-delete';
const SESSION = { session_id: SESSION_ID, platform: 'jest' };
const ACTOR = { kind: 'agent', id: 'branch-delete-agent', session_id: SESSION_ID };
// Ownership-comparison surfaces (merge, destroy) take the resolver's
// candidate envelope, not a bare id list.
const CANDIDATES = {
  candidates: [{ identity: SESSION, source: 'hook_env' }],
  trace: [],
};

const repos = [];

function mkRepo(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync('git', ['init', '--quiet', '-b', 'main', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 't@test.com']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
  execFileSync('git', ['-C', root, 'commit', '--quiet', '--allow-empty', '-m', 'init']);
  repos.push(root);
  return root;
}

function setupCaws(repoRoot) {
  const r = initProject(repoRoot);
  if (!r.ok) throw new Error('initProject failed: ' + JSON.stringify(r.errors));
  return path.join(repoRoot, '.caws');
}

function commitCaws(repoRoot, message) {
  execFileSync('git', ['-C', repoRoot, 'add', '-A']);
  execFileSync('git', ['-C', repoRoot, 'commit', '--quiet', '--no-verify', '-m', message]);
}

function seedBoundableSpec(caws, id) {
  const r = createSpec(caws, { id, title: 'x', mode: 'chore', riskTier: 3, actor: ACTOR });
  if (!r.ok || r.value.kind !== 'success') {
    throw new Error('seed spec failed: ' + JSON.stringify(r));
  }
}

/** Local branch names, as git reports them. */
function branches(repoRoot) {
  return execFileSync('git', ['-C', repoRoot, 'branch', '--format=%(refname:short)'], {
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .filter((b) => b.length > 0);
}

/** Create a worktree, put a real commit on its branch, and merge it. */
function createAndMerge(caws, name, specId) {
  const created = createWorktree(caws, { name, specId, session: SESSION, actor: ACTOR });
  if (!created.ok || created.value.kind !== 'success') {
    throw new Error('createWorktree failed: ' + JSON.stringify(created));
  }
  const branch = created.value.data.branch;

  // A real commit on the worktree branch, so the merge is non-empty and the
  // branch is genuinely ahead of base before it is merged.
  const wtPath = path.join(caws, 'worktrees', name);
  fs.writeFileSync(path.join(wtPath, 'payload.txt'), 'work product\n');
  execFileSync('git', ['-C', wtPath, 'add', 'payload.txt']);
  execFileSync('git', ['-C', wtPath, 'commit', '--quiet', '--no-verify', '-m', 'feat: work']);

  const result = mergeWorktree(caws, {
    name,
    session: SESSION,
    sessionCandidates: CANDIDATES,
    actor: ACTOR,
  });
  return { result, branch };
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

describe('A1: merge deletes the merged branch', () => {
  test('the branch is gone after a clean merge, and the outcome reports it', () => {
    const caws = setupCaws(mkRepo('wmbd-a1-'));
    const repo = path.dirname(caws);
    seedBoundableSpec(caws, 'WMBD-A1-001');
    commitCaws(repo, 'seed spec');

    const { result, branch } = createAndMerge(caws, 'wt-a1', 'WMBD-A1-001');

    expect(result.ok).toBe(true);
    expect(result.value.kind).toBe('success');

    // The headline assertion: the branch no longer exists.
    expect(branches(repo)).not.toContain(branch);

    // The outcome carries the result, so the shell reports it without
    // re-querying git.
    expect(result.value.data.branch).toBe(branch);
    expect(result.value.data.branch_deleted).toBe(true);
    // No error field on the success path.
    expect(result.value.data.branch_delete_error).toBeUndefined();
  });

  test('the merged work survives the branch deletion', () => {
    // Deleting the ref must not affect reachability of the work itself.
    const caws = setupCaws(mkRepo('wmbd-a1b-'));
    const repo = path.dirname(caws);
    seedBoundableSpec(caws, 'WMBD-A1B-001');
    commitCaws(repo, 'seed spec');

    const { result } = createAndMerge(caws, 'wt-a1b', 'WMBD-A1B-001');
    expect(result.value.kind).toBe('success');

    expect(fs.existsSync(path.join(repo, 'payload.txt'))).toBe(true);
    const log = execFileSync('git', ['-C', repo, 'log', '--oneline'], { encoding: 'utf8' });
    expect(log).toContain('feat: work');
  });
});

describe('A3: standalone destroy PRESERVES the branch', () => {
  test('destroy REFUSES a worktree with unmerged work unless explicitly abandoned', () => {
    // First layer of protection, discovered while writing this suite:
    // destroyWorktree will not silently discard a tree holding unmerged
    // commits. This is upstream of the branch question entirely.
    const caws = setupCaws(mkRepo('wmbd-a3r-'));
    const repo = path.dirname(caws);
    seedBoundableSpec(caws, 'WMBD-A3R-001');
    commitCaws(repo, 'seed spec');

    const created = createWorktree(caws, {
      name: 'wt-a3r',
      specId: 'WMBD-A3R-001',
      session: SESSION,
      actor: ACTOR,
    });
    expect(created.ok).toBe(true);

    const wtPath = path.join(caws, 'worktrees', 'wt-a3r');
    fs.writeFileSync(path.join(wtPath, 'unmerged.txt'), 'in progress\n');
    execFileSync('git', ['-C', wtPath, 'add', 'unmerged.txt']);
    execFileSync('git', ['-C', wtPath, 'commit', '--quiet', '--no-verify', '-m', 'wip: partial']);

    const destroyed = destroyWorktree(caws, {
      name: 'wt-a3r',
      session: SESSION,
      sessionCandidates: CANDIDATES,
      actor: ACTOR,
    });

    expect(destroyed.ok).toBe(false);
    expect(destroyed.errors[0].message).toMatch(/not merged into "main"/);
    expect(destroyed.errors[0].message).toMatch(/--abandon-unmerged/);
  });

  test('even an explicitly abandoned destroy leaves branch and commit intact', () => {
    // Destroy has no proof of reachability — the operator may be parking
    // unmerged work. Only the merge path, which has that proof, deletes.
    // This is the case that matters: the operator has said "abandon the
    // worktree", and the branch must STILL survive as the recovery handle.
    const caws = setupCaws(mkRepo('wmbd-a3-'));
    const repo = path.dirname(caws);
    seedBoundableSpec(caws, 'WMBD-A3-001');
    commitCaws(repo, 'seed spec');

    const created = createWorktree(caws, {
      name: 'wt-a3',
      specId: 'WMBD-A3-001',
      session: SESSION,
      actor: ACTOR,
    });
    expect(created.ok).toBe(true);
    const branch = created.value.data.branch;

    // Unmerged work — exactly what must not be lost.
    const wtPath = path.join(caws, 'worktrees', 'wt-a3');
    fs.writeFileSync(path.join(wtPath, 'unmerged.txt'), 'in progress\n');
    execFileSync('git', ['-C', wtPath, 'add', 'unmerged.txt']);
    execFileSync('git', ['-C', wtPath, 'commit', '--quiet', '--no-verify', '-m', 'wip: partial']);
    const sha = execFileSync('git', ['-C', wtPath, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();

    const destroyed = destroyWorktree(caws, {
      name: 'wt-a3',
      session: SESSION,
      sessionCandidates: CANDIDATES,
      actor: ACTOR,
      abandonUnmerged: true,
    });
    if (!destroyed.ok) {
      throw new Error('destroyWorktree failed: ' + JSON.stringify(destroyed.errors));
    }
    expect(destroyed.ok).toBe(true);

    // Branch survives, and so does the commit it points at.
    expect(branches(repo)).toContain(branch);
    const objectType = execFileSync('git', ['-C', repo, 'cat-file', '-t', sha], {
      encoding: 'utf8',
    }).trim();
    expect(objectType).toBe('commit');
  });
});

describe('A4: -d semantics, never -D', () => {
  test('git refuses -d on genuinely unmerged work, leaving it intact', () => {
    // The safety property the entire fix rests on, asserted against real
    // git: -d REFUSES unmerged work. If this ever stopped holding, the fix
    // would silently become capable of destroying work.
    const repo = mkRepo('wmbd-a4-');

    execFileSync('git', ['-C', repo, 'checkout', '--quiet', '-b', 'unmerged-work']);
    fs.writeFileSync(path.join(repo, 'divergent.txt'), 'never merged\n');
    execFileSync('git', ['-C', repo, 'add', 'divergent.txt']);
    execFileSync('git', ['-C', repo, 'commit', '--quiet', '--no-verify', '-m', 'divergent']);
    execFileSync('git', ['-C', repo, 'checkout', '--quiet', 'main']);

    let refused = false;
    let reason = '';
    try {
      execFileSync('git', ['-C', repo, 'branch', '-d', 'unmerged-work'], { stdio: 'pipe' });
    } catch (e) {
      refused = true;
      reason = String(e.stderr ?? '');
    }

    expect(refused).toBe(true);
    expect(reason).toMatch(/not fully merged/i);
    // The branch — and therefore the work — is still there.
    expect(branches(repo)).toContain('unmerged-work');
  });

  test('the merge source calls branch -d and never branch -D', () => {
    // Call observation. A1 asserts only that the branch disappeared, which
    // a `-D` implementation satisfies identically — inspecting the argv is
    // the only assertion that separates the safe implementation from the
    // work-destroying one.
    const src = fs.readFileSync(
      path.join(__dirname, '../../src/store/worktrees-writer.ts'),
      'utf8'
    );
    expect(src).toContain("runGit(['branch', '-d', branch]");
    expect(src).not.toContain("'branch', '-D'");
  });
});

describe('A2: deletion never rolls back or fails the merge', () => {
  test('the merge outcome stays success and carries the branch fields', () => {
    // Branch deletion runs last, after the merge commit, spec close,
    // worktree_merged event and destroy have all landed. The outcome
    // contract the shell renders against must therefore always be a
    // success carrying branch/branch_deleted — never a partial failure.
    const caws = setupCaws(mkRepo('wmbd-a2-'));
    const repo = path.dirname(caws);
    seedBoundableSpec(caws, 'WMBD-A2-001');
    commitCaws(repo, 'seed spec');

    const { result, branch } = createAndMerge(caws, 'wt-a2', 'WMBD-A2-001');

    expect(result.ok).toBe(true);
    expect(result.value.kind).toBe('success');
    expect(result.value.kind).not.toBe('partial_failure_recovered');
    expect(result.value.data.branch).toBe(branch);
    expect(branches(repo)).not.toContain(branch);
  });
});
