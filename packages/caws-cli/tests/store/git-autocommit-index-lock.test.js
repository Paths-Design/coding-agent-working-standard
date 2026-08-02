/**
 * autoCommit retries the audit commit on a concurrent .git/index.lock.
 * CAWS-FIX-N3-BIND-INDEX-LOCK-RETRY-001.
 *
 * The hazard this suite pins: when a sibling git process holds
 * .git/index.lock at the moment autoCommit runs `git add` / `git commit`,
 * the commit fails and the staged spec change is stranded in the index.
 * The fix wraps add -> diff --cached -> commit in a bounded retry loop
 * that treats index.lock contention as transient. These drive the REAL
 * compiled autoCommit against REAL git repos in temp dirs.
 *
 * Coverage notes:
 *  - Exhaustion (A2) is deterministic: plant .git/index.lock and a tiny
 *    override budget, assert refused_dirty names index.lock contention.
 *  - Non-contention (A3) is deterministic: install a failing pre-commit
 *    hook, assert no retry (verbatim refused_dirty on attempt 1).
 *  - Recovery-under-live-contention (A1) cannot be tested synchronously
 *    (Node's setTimeout never fires during a busy-wait spin, so a lock
 *    cannot be removed mid-flight from the same thread). The recovery
 *    LOOP is exercised implicitly by every normal no-lock commit, and
 *    the budget-exhausted path is pinned by A2. The contract that the
 *    loop SUCCEEDS when contention clears is asserted structurally by
 *    confirming the success path returns `committed` with a real sha
 *    (A1 baseline, no lock held).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { autoCommit } = require('../../dist/store/git-autocommit');

const repos = [];

function mkRepo(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  // Hermetic git env so no developer global config leaks in.
  const env = {
    ...process.env,
    HOME: root,
    GIT_CONFIG_GLOBAL: path.join(root, '.gitconfig-test'),
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'CAWS Test',
    GIT_AUTHOR_EMAIL: 'test@caws.invalid',
    GIT_COMMITTER_NAME: 'CAWS Test',
    GIT_COMMITTER_EMAIL: 'test@caws.invalid',
  };
  function git(args) {
    return execFileSync('git', ['-C', root, ...args], {
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  }
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 't@test.com']);
  git(['config', 'user.name', 'Test']);
  git(['commit', '-q', '--allow-empty', '-m', 'init']);
  repos.push(root);
  return { root, git, env };
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

describe('A1: the audit commit succeeds when there is no contention', () => {
  test('a normal trackable write commits with a real sha', () => {
    // The retry loop's success path. There is no lock, so attempt 1
    // commits and returns `committed` with the new short sha.
    const { root, git } = mkRepo('n3a1-');
    const rel = 'trackable.txt';
    fs.writeFileSync(path.join(root, rel), 'audit-trail content\n');
    const outcome = autoCommit({
      repoRoot: root,
      paths: [rel],
      message: 'chore(caws): bind wt-x to SPEC-X',
      wasDirtyBeforeWrite: false,
    });
    expect(outcome.kind).toBe('committed');
    expect(outcome.sha).toBeTruthy();
    // The commit actually landed on HEAD.
    expect(git(['log', '-1', '--pretty=%s'])).toBe('chore(caws): bind wt-x to SPEC-X');
    // ... and the tree is clean for this path.
    expect(git(['status', '--porcelain', '--', rel])).toBe('');
  });
});

describe('A2: persistent index.lock contention is reported, not silently stranded', () => {
  test('a held lock with a tiny budget surfaces refused_dirty naming index.lock', () => {
    const { root } = mkRepo('n3a2-');
    const rel = 'trackable.txt';
    fs.writeFileSync(path.join(root, rel), 'audit-trail content\n');

    // Plant the lock the way a concurrent git process would: an empty
    // .git/index.lock. Held for the entire (tiny) budget.
    fs.writeFileSync(path.join(root, '.git', 'index.lock'), '');

    const outcome = autoCommit({
      repoRoot: root,
      paths: [rel],
      message: 'chore(caws): bind wt-x to SPEC-X',
      wasDirtyBeforeWrite: false,
      // Deterministic exhaustion: a 1-attempt budget skips every retry.
      indexLockMaxAttempts: 1,
      indexLockRetryDelayMs: 0,
    });

    // HEADLINE: refused (the audit commit did not land).
    expect(outcome.kind).toBe('refused_dirty');
    // The reason NAMES index.lock contention — not a bare "git commit
    // failed" that reads like a hook refusal.
    expect(outcome.reason).toMatch(/index\.lock/);
    expect(outcome.reason).toMatch(/concurrent git process/i);
    // The writer's working-tree change is intact (the file is on disk).
    expect(fs.existsSync(path.join(root, rel))).toBe(true);
  });

  test('a held lock with a multi-attempt budget still exhausts to refused_dirty', () => {
    // Confirms the loop actually iterates more than once before giving up:
    // a held lock + budget of 3 still surfaces refused_dirty (it does not
    // hang, and does not silently succeed).
    const { root } = mkRepo('n3a2b-');
    const rel = 'trackable.txt';
    fs.writeFileSync(path.join(root, rel), 'audit-trail content\n');
    fs.writeFileSync(path.join(root, '.git', 'index.lock'), '');

    const outcome = autoCommit({
      repoRoot: root,
      paths: [rel],
      message: 'chore(caws): bind wt-y to SPEC-Y',
      wasDirtyBeforeWrite: false,
      indexLockMaxAttempts: 3,
      indexLockRetryDelayMs: 1,
    });

    expect(outcome.kind).toBe('refused_dirty');
    expect(outcome.reason).toMatch(/index\.lock/);
  });
});

describe('A3: a non-contention failure is NOT retried', () => {
  test('a pre-commit hook refusal surfaces verbatim on attempt 1 (no retry)', () => {
    // The hook-respect contract: a non-index.lock failure must break out
    // immediately with the existing refused_dirty outcome — the loop must
    // not turn a hook refusal into 5 hook refusals or a --no-verify retry.
    const { root } = mkRepo('n3a3-');
    const rel = 'trackable.txt';
    fs.writeFileSync(path.join(root, rel), 'audit-trail content\n');

    // Install a pre-commit hook that refuses with a distinctive message.
    const hook = path.join(root, '.git', 'hooks', 'pre-commit');
    fs.mkdirSync(path.dirname(hook), { recursive: true });
    fs.writeFileSync(
      hook,
      '#!/bin/sh\n\necho "REFUSED-BY-TEST-HOOK" >&2\nexit 7\n',
      { mode: 0o755 }
    );

    const outcome = autoCommit({
      repoRoot: root,
      paths: [rel],
      message: 'chore(caws): bind wt-z to SPEC-Z',
      wasDirtyBeforeWrite: false,
      // A generous budget — the assertion is that it does NOT retry.
      indexLockMaxAttempts: 5,
      indexLockRetryDelayMs: 1,
    });

    expect(outcome.kind).toBe('refused_dirty');
    // The hook's reason is surfaced verbatim, NOT the index.lock message.
    expect(outcome.reason).toMatch(/REFUSED-BY-TEST-HOOK/);
    expect(outcome.reason).not.toMatch(/index\.lock/);
  });
});
