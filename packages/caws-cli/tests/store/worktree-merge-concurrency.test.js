/**
 * worktree merge is agent-safe under concurrency.
 * CAWS-WORKTREE-MERGE-LOCKFREE-CAS-001.
 *
 * Real git repositories, real concurrent merges, no mocks — the property
 * under test is what git itself does when two agents race for the same ref.
 *
 * The design being defended: the merge is computed in the object database
 * (merge-tree + commit-tree) and the base advances via an atomic
 * compare-and-swap (update-ref with an expected-old SHA). The old sequence
 * checked out the base branch, mutating a working tree every agent shares.
 *
 * A4 is the load-bearing case: an outcome-only assertion cannot tell a
 * CAS-based merge from a checkout-based one, so the absence of `checkout`
 * is asserted directly.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { createSpec } = require('../../dist/store/specs-writer');
const { createWorktree, mergeWorktree } = require('../../dist/store/worktrees-writer');
const { initProject } = require('../../dist/store/init-store');

const SESSION_ID = 'sess-merge-cas';
const SESSION = { session_id: SESSION_ID, platform: 'jest' };
const ACTOR = { kind: 'agent', id: 'cas-agent', session_id: SESSION_ID };
const CANDIDATES = { candidates: [{ identity: SESSION, source: 'hook_env' }], trace: [] };

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

function setupCaws(repoRoot) {
  const r = initProject(repoRoot);
  if (!r.ok) throw new Error('initProject failed: ' + JSON.stringify(r.errors));
  return path.join(repoRoot, '.caws');
}

function commitCaws(repoRoot, message) {
  git(repoRoot, ['add', '-A']);
  git(repoRoot, ['commit', '--quiet', '--no-verify', '-m', message]);
}

function seedSpec(caws, id, scopeIn) {
  // CAWS-PREPUSH-PROVENANCE-REWORK-001: merge now enforces lane provenance —
  // every lane commit must touch only paths inside the bound spec's scope.in.
  // Seed that scope so the fixture lanes stay mergeable.
  const r = createSpec(caws, { id, title: 'x', mode: 'chore', riskTier: 3, actor: ACTOR, scopeIn });
  if (!r.ok || r.value.kind !== 'success') throw new Error('seed failed');
}

/** Create a worktree and put one real commit on its branch. */
function seedWorktree(caws, name, specId, file) {
  const created = createWorktree(caws, { name, specId, session: SESSION, actor: ACTOR });
  if (!created.ok || created.value.kind !== 'success') {
    throw new Error('createWorktree failed: ' + JSON.stringify(created));
  }
  const wt = path.join(caws, 'worktrees', name);
  fs.writeFileSync(path.join(wt, file), `work from ${name}\n`);
  git(wt, ['add', file]);
  git(wt, ['commit', '--quiet', '--no-verify', '-m', `feat: ${name}`]);
  return created.value.data.branch;
}

function merge(caws, name) {
  return mergeWorktree(caws, {
    name,
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
      /* best effort */
    }
  }
});

describe('A1: concurrent merges both land; the base never moves backward', () => {
  test('two worktrees merged back-to-back are BOTH ancestors of the final base', () => {
    const caws = setupCaws(mkRepo('cas-a1-'));
    const repo = path.dirname(caws);
    seedSpec(caws, 'CAS-A1-001', ['a.txt']);
    seedSpec(caws, 'CAS-A1-002', ['b.txt']);
    commitCaws(repo, 'seed specs');

    const branchA = seedWorktree(caws, 'wt-a', 'CAS-A1-001', 'a.txt');
    const branchB = seedWorktree(caws, 'wt-b', 'CAS-A1-002', 'b.txt');

    const baseAtStart = git(repo, ['rev-parse', 'main']);

    const rA = merge(caws, 'wt-a');
    expect(rA.ok).toBe(true);
    expect(rA.value.kind).toBe('success');

    const rB = merge(caws, 'wt-b');
    expect(rB.ok).toBe(true);
    expect(rB.value.kind).toBe('success');

    // Neither merge was lost — the whole point.
    const finalBase = git(repo, ['rev-parse', 'main']);
    for (const [label, sha] of [
      ['first merge', rA.value.data.merge_commit],
      ['second merge', rB.value.data.merge_commit],
    ]) {
      expect(() =>
        git(repo, ['merge-base', '--is-ancestor', sha, finalBase])
      ).not.toThrow(`${label} is not reachable from the final base`);
    }

    // And the base only ever moved FORWARD.
    expect(() =>
      git(repo, ['merge-base', '--is-ancestor', baseAtStart, finalBase])
    ).not.toThrow();

    // Both payloads are present on the merged base.
    const tree = git(repo, ['ls-tree', '-r', '--name-only', 'main']);
    expect(tree).toContain('a.txt');
    expect(tree).toContain('b.txt');
  });
});

describe('A2: a stale compare-and-swap is refused by git, writing nothing', () => {
  test('update-ref with a stale expected-old SHA refuses and leaves the ref intact', () => {
    // Drives git directly: this asserts the PRIMITIVE the implementation
    // depends on, so a git behavior change would surface here rather than as
    // a mysterious merge bug.
    const repo = mkRepo('cas-a2-');
    const base = git(repo, ['rev-parse', 'main']);

    git(repo, ['checkout', '--quiet', '-b', 'feat1']);
    fs.writeFileSync(path.join(repo, 'one.txt'), '1\n');
    git(repo, ['add', 'one.txt']);
    git(repo, ['commit', '--quiet', '-m', 'feat1']);

    git(repo, ['checkout', '--quiet', '-b', 'feat2', 'main']);
    fs.writeFileSync(path.join(repo, 'two.txt'), '2\n');
    git(repo, ['add', 'two.txt']);
    git(repo, ['commit', '--quiet', '-m', 'feat2']);

    git(repo, ['checkout', '--quiet', 'main']);

    // Agent A wins the race.
    const treeA = git(repo, ['merge-tree', '--write-tree', 'main', 'feat1']);
    const mcA = git(repo, ['commit-tree', treeA, '-p', 'main', '-p', 'feat1', '-m', 'A']);
    git(repo, ['update-ref', 'refs/heads/main', mcA, base]);
    const afterA = git(repo, ['rev-parse', 'main']);
    expect(afterA).toBe(mcA);

    // Agent B computed against the ORIGINAL base and now tries to land.
    const treeB = git(repo, ['merge-tree', '--write-tree', base, 'feat2']);
    const mcB = git(repo, ['commit-tree', treeB, '-p', base, '-p', 'feat2', '-m', 'B']);

    let refused = false;
    let reason = '';
    try {
      execFileSync('git', ['-C', repo, 'update-ref', 'refs/heads/main', mcB, base], {
        stdio: 'pipe',
      });
    } catch (e) {
      refused = true;
      reason = String(e.stderr ?? '');
    }

    expect(refused).toBe(true);
    // Git names both SHAs, which is what makes contention diagnosable.
    expect(reason).toMatch(/but expected/);
    // A's merge survived untouched — B did not clobber it.
    expect(git(repo, ['rev-parse', 'main'])).toBe(afterA);
  });
});

describe('A4: the merge never checks out the base branch', () => {
  test('the merge source contains no checkout of the base, and does use CAS', () => {
    // Call observation on the argv. An outcome-only test cannot distinguish
    // a checkout-based merge from an object-database merge, so the absence
    // of the dangerous call is asserted directly.
    const src = fs.readFileSync(
      path.join(__dirname, '../../src/store/worktrees-writer.ts'),
      'utf8'
    );
    expect(src).not.toContain("runGit(['checkout', baseBranch]");
    expect(src).toContain("'merge-tree', '--write-tree'");
    expect(src).toContain("'update-ref', ref, mergeCommit, baseBefore");
  });

  test('merging leaves the canonical working tree clean, not mid-merge', () => {
    // The old path could strand a conflicted merge in the shared working
    // tree. The object-database path cannot: nothing is checked out.
    const caws = setupCaws(mkRepo('cas-a4-'));
    const repo = path.dirname(caws);
    seedSpec(caws, 'CAS-A4-001', ['x.txt']);
    commitCaws(repo, 'seed spec');
    seedWorktree(caws, 'wt-a4', 'CAS-A4-001', 'x.txt');

    const r = merge(caws, 'wt-a4');
    expect(r.value.kind).toBe('success');

    // The invariant is "no MERGE RESIDUE", not "no changes at all" — CAWS
    // legitimately appends to .caws/events.jsonl as part of the transaction.
    // What must NOT appear is a staged deletion (`D `), which is what a ref
    // advancing under a stale working tree produces.
    const status = git(repo, ['status', '--porcelain']);
    expect(status).not.toMatch(/^D /m);
    expect(status).not.toMatch(/^(UU|AA|DU|UD) /m);
    expect(fs.existsSync(path.join(repo, '.git', 'MERGE_HEAD'))).toBe(false);
    // And the merged payload is materialized on disk, not just in the ref —
    // this is the read-tree sync doing its job.
    expect(fs.existsSync(path.join(repo, 'x.txt'))).toBe(true);
  });
});

describe('A5: a real conflict is reported without dirtying the working tree', () => {
  test('conflicting branches refuse the merge and leave no merge in progress', () => {
    const caws = setupCaws(mkRepo('cas-a5-'));
    const repo = path.dirname(caws);
    seedSpec(caws, 'CAS-A5-001', ['shared.txt']);
    seedSpec(caws, 'CAS-A5-002', ['shared.txt']);

    // A file both branches will edit differently.
    fs.writeFileSync(path.join(repo, 'shared.txt'), 'original\n');
    commitCaws(repo, 'seed specs + shared file');

    const wtA = path.join(caws, 'worktrees', 'wt-c1');
    createWorktree(caws, {
      name: 'wt-c1',
      specId: 'CAS-A5-001',
      session: SESSION,
      actor: ACTOR,
    });
    fs.writeFileSync(path.join(wtA, 'shared.txt'), 'from C1\n');
    git(wtA, ['add', 'shared.txt']);
    git(wtA, ['commit', '--quiet', '--no-verify', '-m', 'c1 edit']);

    const wtB = path.join(caws, 'worktrees', 'wt-c2');
    createWorktree(caws, {
      name: 'wt-c2',
      specId: 'CAS-A5-002',
      session: SESSION,
      actor: ACTOR,
    });
    fs.writeFileSync(path.join(wtB, 'shared.txt'), 'from C2\n');
    git(wtB, ['add', 'shared.txt']);
    git(wtB, ['commit', '--quiet', '--no-verify', '-m', 'c2 edit']);

    expect(merge(caws, 'wt-c1').value.kind).toBe('success');

    // The second merge genuinely conflicts.
    const r2 = merge(caws, 'wt-c2');
    expect(r2.ok).toBe(false);
    expect(r2.errors[0].message).toMatch(/conflicting changes/i);

    // The critical property: no half-merged state in the shared tree. The old
    // `git merge` path left conflict markers and a MERGE_HEAD for a human to
    // clean up; the object-database path cannot, because it never touches the
    // working tree. (CAWS bookkeeping writes are expected and ignored here.)
    const status = git(repo, ['status', '--porcelain']);
    expect(status).not.toMatch(/^(UU|AA|DU|UD) /m);
    expect(fs.existsSync(path.join(repo, '.git', 'MERGE_HEAD'))).toBe(false);
    // The conflicted file is untouched at its pre-merge content.
    expect(fs.readFileSync(path.join(repo, 'shared.txt'), 'utf8')).toBe('from C1\n');
  });
});

describe('A6: nothing destructive happens before the ref advances', () => {
  test('the merged branch is deleted only after it is an ancestor of the new base', () => {
    const caws = setupCaws(mkRepo('cas-a6-'));
    const repo = path.dirname(caws);
    seedSpec(caws, 'CAS-A6-001', ['y.txt']);
    commitCaws(repo, 'seed spec');
    const branch = seedWorktree(caws, 'wt-a6', 'CAS-A6-001', 'y.txt');

    const r = merge(caws, 'wt-a6');
    expect(r.value.kind).toBe('success');

    // Branch is gone (CAWS-WORKTREE-MERGE-DELETE-BRANCH-001) ...
    const branches = git(repo, ['branch', '--format=%(refname:short)']).split('\n');
    expect(branches).not.toContain(branch);

    // ... and the work it carried is reachable from the base, which is what
    // made the deletion safe in the first place.
    expect(() =>
      git(repo, ['merge-base', '--is-ancestor', r.value.data.merge_commit, 'main'])
    ).not.toThrow();
    expect(fs.existsSync(path.join(repo, 'y.txt'))).toBe(true);
  });
});
