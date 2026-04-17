/**
 * @fileoverview CAWSFIX-18 — destroyWorktree auto-commits .caws/worktrees.json
 * so the working tree stays clean across sessions.
 * @author @darianrosebrook
 */

const path = require('path');
const fs = require('fs-extra');
const { execFileSync } = require('child_process');
const { createTemplateRepo, cloneFixture, cleanupTestDir, cleanupTemplate } = require('./helpers/git-fixture');
const { createWorktree, destroyWorktree } = require('../src/worktree/worktree-manager');

describe('CAWSFIX-18 — destroyWorktree auto-commits registry', () => {
  let templateDir;
  let testDir;
  let originalCwd;

  beforeAll(() => {
    templateDir = createTemplateRepo();
  });

  afterAll(() => {
    cleanupTemplate(templateDir);
  });

  beforeEach(() => {
    originalCwd = process.cwd();
    testDir = cloneFixture(templateDir, 'cawsfix-18-');
    process.chdir(testDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    cleanupTestDir(testDir);
  });

  const porcelain = (filePath) =>
    execFileSync('git', ['status', '--porcelain', filePath], { cwd: testDir }).toString().trim();
  const lastCommitSubject = () =>
    execFileSync('git', ['log', '-1', '--pretty=%s'], { cwd: testDir }).toString().trim();

  test('A1: clean working tree for .caws/worktrees.json after destroy of only worktree', () => {
    createWorktree('cf18-only');
    // createWorktree intentionally writes the registry but does NOT commit it —
    // stage+commit so our baseline is clean.
    execFileSync('git', ['add', '.caws/worktrees.json'], { cwd: testDir });
    execFileSync('git', ['commit', '-m', 'chore(worktree): register cf18-only'], { cwd: testDir });

    destroyWorktree('cf18-only');

    expect(porcelain('.caws/worktrees.json')).toBe('');
  });

  test('A4: only .caws/worktrees.json is staged (no -A)', () => {
    createWorktree('cf18-scope');
    execFileSync('git', ['add', '.caws/worktrees.json'], { cwd: testDir });
    execFileSync('git', ['commit', '-m', 'chore(worktree): register cf18-scope'], { cwd: testDir });

    // Drop an untracked file in the working tree; auto-commit must not pick it up.
    fs.writeFileSync(path.join(testDir, 'UNRELATED.md'), 'should not be committed\n');

    destroyWorktree('cf18-scope');

    expect(porcelain('.caws/worktrees.json')).toBe('');
    // The unrelated file is still untracked (git status shows ??)
    const unrelated = execFileSync('git', ['status', '--porcelain', 'UNRELATED.md'], {
      cwd: testDir,
    }).toString().trim();
    expect(unrelated).toMatch(/^\?\? UNRELATED\.md/);
  });

  test('A3: idempotent destroy does not create an empty commit', () => {
    createWorktree('cf18-idem');
    execFileSync('git', ['add', '.caws/worktrees.json'], { cwd: testDir });
    execFileSync('git', ['commit', '-m', 'chore(worktree): register cf18-idem'], { cwd: testDir });

    destroyWorktree('cf18-idem');
    const firstHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: testDir })
      .toString()
      .trim();

    // Second destroy: status is already 'destroyed' → guard prevents re-commit.
    destroyWorktree('cf18-idem');
    const secondHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: testDir })
      .toString()
      .trim();

    expect(secondHead).toBe(firstHead);
  });

  test('A5: uses wip(checkpoint) prefix when other worktrees remain active', () => {
    createWorktree('cf18-keep');
    createWorktree('cf18-drop');
    execFileSync('git', ['add', '.caws/worktrees.json'], { cwd: testDir });
    execFileSync('git', ['commit', '-m', 'chore(worktree): register two'], { cwd: testDir });

    destroyWorktree('cf18-drop');

    expect(lastCommitSubject()).toMatch(/^wip\(checkpoint\): record destroyed cf18-drop$/);
    expect(porcelain('.caws/worktrees.json')).toBe('');
  });

  test('A2: destroy succeeds and warns when git commit fails', () => {
    createWorktree('cf18-fail');
    execFileSync('git', ['add', '.caws/worktrees.json'], { cwd: testDir });
    execFileSync('git', ['commit', '-m', 'chore(worktree): register cf18-fail'], { cwd: testDir });

    const hookDir = path.join(testDir, '.git', 'hooks');
    fs.ensureDirSync(hookDir);
    fs.writeFileSync(path.join(hookDir, 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(() => destroyWorktree('cf18-fail')).not.toThrow();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('could not auto-commit .caws/worktrees.json')
      );

      const reg = JSON.parse(fs.readFileSync(
        path.join(testDir, '.caws', 'worktrees.json'), 'utf8'
      ));
      expect(reg.worktrees['cf18-fail'].status).toBe('destroyed');
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('A5: uses chore(worktree) prefix when no other worktrees remain active', () => {
    createWorktree('cf18-solo');
    execFileSync('git', ['add', '.caws/worktrees.json'], { cwd: testDir });
    execFileSync('git', ['commit', '-m', 'chore(worktree): register cf18-solo'], { cwd: testDir });

    destroyWorktree('cf18-solo');

    expect(lastCommitSubject()).toMatch(/^chore\(worktree\): record destroyed cf18-solo$/);
  });
});
