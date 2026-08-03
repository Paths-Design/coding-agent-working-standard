/**
 * CAWS-REFACTOR-SHARED-UTILS-001 — the consolidated shared utilities exist,
 * are re-exported from the store barrel, and behave identically to the
 * private copies they replaced.
 *
 * This suite is the A3 acceptance test: it pins that the refactor
 * introduced one shared home for each formerly-duplicated helper and that
 * the helpers' observable behavior matches the documented semantics. It
 * does NOT re-test the full behavior of the consumers (the existing
 * lifecycle / merge / specs / events suites do that); it tests the
 * helpers themselves plus the consolidation invariants (no private copies
 * remain where the spec said to collapse them).
 *
 * SUT: compiled surface — require('../../dist/store'). `npm run build`
 * compiles TS -> dist before jest runs.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const store = require('../../dist/store');
const repoRootModule = require('../../dist/store/repo-root');
const kernel = require('@paths.design/caws-kernel');

const repos = [];
function mkRepo(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 't@test.com']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
  execFileSync('git', ['-C', root, 'commit', '-q', '--allow-empty', '-m', 'init']);
  repos.push(root);
  return root;
}
afterAll(() => {
  for (const r of repos) {
    try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe('CAWS-REFACTOR-SHARED-UTILS-001 — shared utilities are exported and behave', () => {
  test('the store barrel re-exports the consolidated helpers', () => {
    // Task 1: sleepSyncMs, repoRootFromCawsDir
    expect(typeof store.sleepSyncMs).toBe('function');
    expect(typeof store.repoRootFromCawsDir).toBe('function');
    // Task 2: validateSpecId (CLI wrapper around kernel SPEC_ID_REGEX)
    expect(typeof store.validateSpecId).toBe('function');
    // Task 3: runGit (result-shape helper)
    expect(typeof store.runGit).toBe('function');
    // Task 4: realpathSafe (simple variant)
    expect(typeof store.realpathSafe).toBe('function');
    // Task A: readGitDirInfo (extracted from status/agents triplicate)
    expect(typeof store.readGitDirInfo).toBe('function');
    // Task 5: storeDiagnostic (widened with severity)
    expect(typeof store.storeDiagnostic).toBe('function');
  });

  test('A1/Task1: sleepSyncMs busy-waits approximately the requested ms', () => {
    const before = Date.now();
    store.sleepSyncMs(40);
    const elapsed = Date.now() - before;
    // Busy-wait; allow scheduler slack but it must have waited roughly.
    expect(elapsed).toBeGreaterThanOrEqual(30);
    expect(elapsed).toBeLessThan(500);
  });

  test('A1/Task1: repoRootFromCawsDir returns path.dirname of the caws dir', () => {
    expect(store.repoRootFromCawsDir('/x/y/.caws')).toBe('/x/y');
    expect(store.repoRootFromCawsDir('/a/.caws')).toBe('/a');
  });

  test('A2/Task2: SPEC_ID_REGEX and WORKTREE_NAME_REGEX are shared from the kernel', () => {
    // The kernel now exports SPEC_ID_REGEX (formerly private).
    expect(kernel.SPEC_ID_REGEX).toBeInstanceOf(RegExp);
    expect(kernel.WORKTREE_NAME_REGEX).toBeInstanceOf(RegExp);
    // Same grammar as before.
    expect(kernel.SPEC_ID_REGEX.test('FEAT-001')).toBe(true);
    expect(kernel.SPEC_ID_REGEX.test('CLI-SPECS-001')).toBe(true);
    expect(kernel.SPEC_ID_REGEX.test('bad')).toBe(false);
    expect(kernel.WORKTREE_NAME_REGEX.test('wt-auth')).toBe(true);
    expect(kernel.WORKTREE_NAME_REGEX.test('wt auth')).toBe(false);
  });

  test('A2/Task2: validateSpecId is the shared CLI helper with STORE_RULES diagnostics', () => {
    const ok = store.validateSpecId('FEAT-001');
    expect(ok.ok).toBe(true);
    expect(ok.value).toBe(true);

    const empty = store.validateSpecId('');
    expect(empty.ok).toBe(false);
    expect(empty.errors[0].rule).toMatch(/plan_rejected/);
    expect(empty.errors[0].message).toMatch(/Spec id is required/);

    const bad = store.validateSpecId('not-a-spec-id');
    expect(bad.ok).toBe(false);
    expect(bad.errors[0].message).toMatch(/does not match the v11 pattern/);
    // The repair hint includes an example and the pattern in data.
    expect(bad.errors[0].data.pattern).toBe(kernel.SPEC_ID_REGEX.source);
  });

  test('A3/Task3: runGit returns the result shape (ok/stdout or ok:false/reason)', () => {
    const root = mkRepo('refactor-rungit-');
    // Success: rev-parse HEAD returns a sha.
    const head = store.runGit(['rev-parse', '--short', 'HEAD'], root);
    expect(head.ok).toBe(true);
    expect(typeof head.stdout).toBe('string');
    expect(head.stdout.trim().length).toBeGreaterThan(0);

    // Failure: an unknown subcommand surfaces { ok: false, reason }.
    const bad = store.runGit(['not-a-real-subcommand'], root);
    expect(bad.ok).toBe(false);
    expect(typeof bad.reason).toBe('string');
    expect(bad.reason.length).toBeGreaterThan(0);
  });

  test('A4/Task4: realpathSafe resolves existing paths and falls back for missing ones', () => {
    const root = mkRepo('refactor-realpath-');
    // Existing dir resolves through realpath (collapses any symlinks).
    const real = store.realpathSafe(root);
    expect(typeof real).toBe('string');
    expect(real.length).toBeGreaterThan(0);

    // Missing path falls back to the literal (does not throw).
    const missing = path.join(root, 'does-not-exist');
    const fallback = store.realpathSafe(missing);
    expect(fallback).toBe(missing);
  });

  test('A5/Task5: storeDiagnostic accepts an optional severity and threads it through', () => {
    const d = store.storeDiagnostic('test.rule', 'msg', { severity: 'info', subject: 'x' });
    expect(d.rule).toBe('test.rule');
    expect(d.authority).toBe('kernel/diagnostics');
    expect(d.message).toBe('msg');
    expect(d.subject).toBe('x');
    expect(d.severity).toBe('info');
  });

  test('A5/Task5: storeDiagnostic defaults severity to error when not provided', () => {
    // The kernel diagnostic() builder defaults severity to 'error'; the widened
    // storeDiagnostic inherits that default when severity is omitted (matches the
    // pre-refactor behavior of the inline literals that did not set severity).
    const d = store.storeDiagnostic('test.rule', 'msg');
    expect(d.severity).toBe('error');
  });
});

describe('CAWS-REFACTOR-SHARED-UTILS-001 — consolidation invariants (no private copies)', () => {
  // These source-text assertions pin that the refactor did not regress: the
  // formerly-private copies are gone from their old homes. Compiled-dist
  // behavior is covered above; these guard the source-level consolidation.

  test('no private sleepSyncMs/sleepSync definitions remain outside repo-root.ts', () => {
    const readSrc = (rel) => fs.readFileSync(path.join(__dirname, '../../src', rel), 'utf8');
    const storeFiles = [
      'store/lifecycle-lock.ts',
      'store/events-store.ts',
      'store/messages-store.ts',
      'store/git-autocommit.ts',
    ];
    for (const f of storeFiles) {
      const src = readSrc(f);
      // No function definition of sleepSyncMs/sleepSync (allow the word in comments).
      expect(src).not.toMatch(/function\s+sleepSyncMs?\s*\(/);
    }
  });

  test('no private repoRootFromCawsDir definitions remain outside repo-root.ts', () => {
    const readSrc = (rel) => fs.readFileSync(path.join(__dirname, '../../src', rel), 'utf8');
    for (const f of ['store/worktrees-writer.ts', 'store/specs-writer.ts', 'store/specs-migration.ts']) {
      expect(readSrc(f)).not.toMatch(/function\s+repoRootFromCawsDir\s*\(/);
    }
  });

  test('no private runGit result-shape definitions remain in the two consolidated files', () => {
    const readSrc = (rel) => fs.readFileSync(path.join(__dirname, '../../src', rel), 'utf8');
    // git-autocommit.ts and worktrees-writer.ts formerly each had their own runGit.
    // After consolidation they import it; the divergent variants (diff-helpers,
    // git-sparse-checkout, worktree.ts gitOutput, prepush) are deliberately NOT
    // touched and are NOT in this assertion.
    expect(readSrc('store/git-autocommit.ts')).not.toMatch(/function\s+runGit\s*\(/);
    expect(readSrc('store/worktrees-writer.ts')).not.toMatch(/function\s+runGit\s*\(/);
  });

  test('no private realpathSafe/safeRealpath definitions remain in the 4 migrated files', () => {
    const readSrc = (rel) => fs.readFileSync(path.join(__dirname, '../../src', rel), 'utf8');
    for (const f of [
      'shell/binding/resolve-binding.ts',
      'shell/commands/status.ts',
      'shell/commands/worktree.ts',
      'shell/commands/agents.ts',
    ]) {
      const src = readSrc(f);
      expect(src).not.toMatch(/function\s+realpathSafe\s*\(/);
      expect(src).not.toMatch(/function\s+safeRealpath\s*\(/);
    }
  });

  test('Task A: no private readGitDirInfo/GitDirInfo definitions remain in status/agents', () => {
    const readSrc = (rel) => fs.readFileSync(path.join(__dirname, '../../src', rel), 'utf8');
    for (const f of ['shell/commands/status.ts', 'shell/commands/agents.ts']) {
      const src = readSrc(f);
      expect(src).not.toMatch(/function\s+readGitDirInfo\s*\(/);
      expect(src).not.toMatch(/interface\s+GitDirInfo\s*\{/);
    }
  });

  test('Task B: git-sparse-checkout runGit and worktree gitOutput are consolidated (flipped to shared runGit)', () => {
    const readSrc = (rel) => fs.readFileSync(path.join(__dirname, '../../src', rel), 'utf8');
    // The swapped-arg local copies are gone; both now import the shared runGit.
    expect(readSrc('store/git-sparse-checkout.ts')).not.toMatch(/function\s+runGit\s*\(/);
    expect(readSrc('shell/commands/worktree.ts')).not.toMatch(/function\s+gitOutput\s*\(/);
  });

  test('the still-divergent variants deliberately remain (not consolidated)', () => {
    // Only the genuinely-different variants stay: the THROWING runGit in
    // diff-helpers.ts, claim.ts's path.resolve-fallback safeRealpath (different
    // semantics from the simple realpathSafe), and the ancestor-walk
    // realpathOrLiteral (required for the cwd-self-destruct guard on macOS).
    const readSrc = (rel) => fs.readFileSync(path.join(__dirname, '../../src', rel), 'utf8');
    expect(readSrc('shell/gates/local-evaluators/diff-helpers.ts')).toMatch(/function\s+runGit\s*\(/);
    // claim.ts keeps its path.resolve-fallback safeRealpath (different semantics).
    expect(readSrc('shell/commands/claim.ts')).toMatch(/function\s+safeRealpath\s*\(/);
    // worktrees-writer.ts keeps the ancestor-walk realpathOrLiteral (required for the
    // cwd-self-destruct guard on macOS).
    expect(readSrc('store/worktrees-writer.ts')).toMatch(/function\s+realpathOrLiteral\s*\(/);
  });
});
