/**
 * caws worktree merge/destroy refuses when the caller's cwd is inside the
 * target worktree.
 * CAWS-FIX-WORKTREE-MERGE-CWD-SELF-DESTRUCT-GUARD-001.
 *
 * The hazard this suite pins: destroyWorktree (the final step of
 * mergeWorktree, and the whole of destroy) deletes the worktree
 * directory. If the caller process's cwd is inside that directory, the
 * teardown removes the ground under the caller's shell, and every
 * subsequent process spawn fails ENOENT. The guard reads the caller cwd
 * once at invocation and refuses the teardown before any mutation.
 *
 * These drive the REAL compiled writers against REAL git repositories in
 * temp dirs — no mocked git — because the property under test is real
 * path containment on a real filesystem.
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

const SESSION_ID = 'sess-cwd-guard';
const SESSION = { session_id: SESSION_ID, platform: 'jest' };
const ACTOR = { kind: 'agent', id: 'cwd-guard-agent', session_id: SESSION_ID };
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
  // scopeIn covers the files this suite's lanes commit (payload.txt): the
  // merge-time lane-provenance guard (CAWS-PREPUSH-PROVENANCE-REWORK-001)
  // refuses any lane commit touching paths outside the bound spec's scope.
  const r = createSpec(caws, {
    id,
    title: 'x',
    mode: 'chore',
    riskTier: 3,
    actor: ACTOR,
    scopeIn: ['payload.txt'],
  });
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

afterAll(() => {
  for (const r of repos) {
    try {
      fs.rmSync(r, { recursive: true, force: true });
    } catch {
      /* best effort cleanup */
    }
  }
});

// Shared setup: a repo with a created worktree (no work merged yet), so
// destroy/merge have a real target directory whose containment can be tested.
function setupWorktree(prefix, name, specId) {
  const repo = mkRepo(prefix);
  const caws = setupCaws(repo);
  seedBoundableSpec(caws, specId);
  commitCaws(repo, 'seed spec');
  const created = createWorktree(caws, { name, specId, session: SESSION, actor: ACTOR });
  if (!created.ok || created.value.kind !== 'success') {
    throw new Error('createWorktree failed: ' + JSON.stringify(created));
  }
  const wtPath = path.join(caws, 'worktrees', name);
  return { repo, caws, wtPath, branch: created.value.data.branch };
}

describe('A1: merge refuses when cwd is inside the worktree', () => {
  test('a real merge from inside the worktree is refused with no mutation', () => {
    const { repo, caws, wtPath, branch } = setupWorktree('cwdg-a1-', 'wt-a1', 'CWDG-A1-001');
    const before = fs.existsSync(wtPath);

    // The hazard: caller cwd is the worktree dir itself.
    const result = mergeWorktree(caws, {
      name: 'wt-a1',
      session: SESSION,
      sessionCandidates: CANDIDATES,
      actor: ACTOR,
      callerCwd: wtPath,
    });

    // HEADLINE: refused, not success.
    expect(result.ok).toBe(false);
    expect(result.errors[0].message).toMatch(/Refusing to destroy worktree "wt-a1"/);
    expect(result.errors[0].message).toMatch(/current directory is inside it/);
    // The remediation tells the operator exactly what to do.
    expect(result.errors[0].message).toMatch(/cd <repo-root>/);

    // No teardown ran: the worktree dir still exists and the branch is intact.
    expect(fs.existsSync(wtPath)).toBe(before);
    expect(branches(repo)).toContain(branch);
  });

  test('a cwd nested under the worktree (a descendant) is also refused', () => {
    const { caws, wtPath } = setupWorktree('cwdg-a1b-', 'wt-a1b', 'CWDG-A1B-001');

    // A cwd deeper inside the worktree — same hazard (the dir tree is removed).
    const nestedCwd = path.join(wtPath, 'packages', 'caws-cli');
    const result = mergeWorktree(caws, {
      name: 'wt-a1b',
      session: SESSION,
      sessionCandidates: CANDIDATES,
      actor: ACTOR,
      callerCwd: nestedCwd,
    });

    expect(result.ok).toBe(false);
    expect(result.errors[0].message).toMatch(/Refusing to destroy worktree "wt-a1b"/);
  });
});

describe('A2: destroy refuses when cwd is inside the worktree', () => {
  test('a destroy from inside the worktree is refused with no mutation', () => {
    const { repo, caws, wtPath, branch } = setupWorktree('cwdg-a2-', 'wt-a2', 'CWDG-A2-001');
    const before = fs.existsSync(wtPath);

    const result = destroyWorktree(caws, {
      name: 'wt-a2',
      session: SESSION,
      sessionCandidates: CANDIDATES,
      actor: ACTOR,
      callerCwd: wtPath,
    });

    expect(result.ok).toBe(false);
    expect(result.errors[0].message).toMatch(/Refusing to destroy worktree "wt-a2"/);
    expect(result.errors[0].message).toMatch(/cd <repo-root>/);
    // Nothing destroyed.
    expect(fs.existsSync(wtPath)).toBe(before);
    expect(branches(repo)).toContain(branch);
  });
});

describe('A3: cwd at the repo root proceeds normally', () => {
  test('merge and destroy do NOT trip the guard when cwd is the repo root', () => {
    // The guard only blocks the self-inside-cwd case. From the repo root
    // (the disciplined invocation site), both operations must still work.
    const repo = mkRepo('cwdg-a3-');
    const caws = setupCaws(repo);
    seedBoundableSpec(caws, 'CWDG-A3-001');
    commitCaws(repo, 'seed spec');

    // --- destroy path ---
    const created = createWorktree(caws, {
      name: 'wt-a3d',
      specId: 'CWDG-A3-001',
      session: SESSION,
      actor: ACTOR,
    });
    if (!created.ok || created.value.kind !== 'success') {
      throw new Error('createWorktree failed: ' + JSON.stringify(created));
    }
    const destroyed = destroyWorktree(caws, {
      name: 'wt-a3d',
      session: SESSION,
      sessionCandidates: CANDIDATES,
      actor: ACTOR,
      // Caller is at the repo root, not inside wt-a3d.
      callerCwd: repo,
    });
    expect(destroyed.ok).toBe(true);
    // The guard did not fire, so destroy proceeded: the dir is gone.
    expect(fs.existsSync(path.join(caws, 'worktrees', 'wt-a3d'))).toBe(false);

    // --- merge path ---
    createWorktree(caws, {
      name: 'wt-a3m',
      specId: 'CWDG-A3-001',
      session: SESSION,
      actor: ACTOR,
    });
    commitCaws(repo, 'bind wt-a3m');
    const wtPath = path.join(caws, 'worktrees', 'wt-a3m');
    fs.writeFileSync(path.join(wtPath, 'payload.txt'), 'work\n');
    execFileSync('git', ['-C', wtPath, 'add', 'payload.txt']);
    execFileSync('git', ['-C', wtPath, 'commit', '--quiet', '--no-verify', '-m', 'feat: work']);
    execFileSync('git', ['-C', wtPath, 'merge', '--quiet', '--no-edit', 'main']);

    const merged = mergeWorktree(caws, {
      name: 'wt-a3m',
      session: SESSION,
      sessionCandidates: CANDIDATES,
      actor: ACTOR,
      // Caller at the repo root.
      callerCwd: repo,
    });
    expect(merged.ok).toBe(true);
    expect(merged.value.kind).toBe('success');
    expect(fs.existsSync(wtPath)).toBe(false);
  });
});

describe('A4: merge --dry-run is exempt', () => {
  test('a dry run from inside the worktree still reports readiness (no teardown)', () => {
    // Dry runs perform no teardown, so the cwd hazard does not apply — the
    // guard must not turn a read-only readiness check into a refusal.
    const { repo, caws, wtPath } = setupWorktree('cwdg-a4-', 'wt-a4', 'CWDG-A4-001');
    commitCaws(repo, 'bind wt-a4');
    // Put a real commit on the branch so the merge would be non-empty.
    fs.writeFileSync(path.join(wtPath, 'payload.txt'), 'work\n');
    execFileSync('git', ['-C', wtPath, 'add', 'payload.txt']);
    execFileSync('git', ['-C', wtPath, 'commit', '--quiet', '--no-verify', '-m', 'feat: work']);
    execFileSync('git', ['-C', wtPath, 'merge', '--quiet', '--no-edit', 'main']);

    const result = mergeWorktree(caws, {
      name: 'wt-a4',
      session: SESSION,
      sessionCandidates: CANDIDATES,
      actor: ACTOR,
      dryRun: true,
      callerCwd: wtPath,
    });

    // The guard did not fire: this is a dry_run outcome, not an error.
    expect(result.ok).toBe(true);
    expect(result.value.kind).toBe('dry_run');
    expect(result.value.canProceed).toBe(true);
  });
});

// CAWS-FIX-CWD-GUARD-COVERAGE-001 (hole 2): the merge's internal destroy
// call (the teardown step after a successful merge+close) now threads
// callerCwd through to destroyWorktree. This is defense-in-depth — the
// merge's EARLY guard (tested in A1) refuses the same condition before
// teardown is ever reached, so the internal destroy guard is unreachable
// for the cwd-inside-worktree case in current code. These tests document
// that relationship: a merge with callerCwd inside the worktree is
// refused identically whether it would have reached the internal destroy
// or not, and the diagnostic shape is the cwdSelfDestructRefusal one.
describe('merge internal teardown carries callerCwd (CAWS-FIX-CWD-GUARD-COVERAGE-001 hole 2)', () => {
  test('a merge from inside the worktree is refused with the cwd-guard diagnostic (early guard fires first)', () => {
    const { caws, wtPath } = setupWorktree('cwdg-h2-', 'wt-h2', 'CWDG-H2-001');
    const result = mergeWorktree(caws, {
      name: 'wt-h2',
      session: SESSION,
      sessionCandidates: CANDIDATES,
      actor: ACTOR,
      callerCwd: wtPath,
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0].message).toMatch(/Refusing to destroy worktree "wt-h2"/);
    expect(result.errors[0].message).toMatch(/cd <repo-root>/);
    // No mutation: the early guard returned before any teardown.
    expect(fs.existsSync(wtPath)).toBe(true);
  });

  test('a merge from the repo root proceeds and the internal destroy completes (guard does not fire when cwd is safe)', () => {
    const { repo, caws, wtPath } = setupWorktree('cwdg-h2b-', 'wt-h2b', 'CWDG-H2B-001');
    commitCaws(repo, 'bind wt-h2b');
    // Put a real commit on the branch so the merge is non-empty.
    fs.writeFileSync(path.join(wtPath, 'payload.txt'), 'work\n');
    execFileSync('git', ['-C', wtPath, 'add', 'payload.txt']);
    execFileSync('git', ['-C', wtPath, 'commit', '--quiet', '--no-verify', '-m', 'feat: work']);
    execFileSync('git', ['-C', wtPath, 'merge', '--quiet', '--no-edit', 'main']);

    const result = mergeWorktree(caws, {
      name: 'wt-h2b',
      session: SESSION,
      sessionCandidates: CANDIDATES,
      actor: ACTOR,
      callerCwd: repo, // safe cwd — the internal destroy guard must not fire
    });
    expect(result.ok).toBe(true);
    expect(result.value.kind).toBe('success');
    // The internal destroy completed: the worktree dir is gone.
    expect(fs.existsSync(wtPath)).toBe(false);
  });
});
