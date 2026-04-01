/**
 * @fileoverview Shared Git Fixture Utilities for Tests
 *
 * Creates a template git repo once (beforeAll), then clones it cheaply
 * per test (beforeEach) instead of running git init + config + add + commit
 * every time. This saves ~30-50ms per test across 100+ git-dependent tests.
 *
 * Usage:
 *   const { createTemplateRepo, cloneFixture, cleanupTemplate } = require('./helpers/git-fixture');
 *
 *   let templateDir;
 *   beforeAll(() => { templateDir = createTemplateRepo(); });
 *   afterAll(() => { cleanupTemplate(templateDir); });
 *
 *   let testDir;
 *   beforeEach(() => { testDir = cloneFixture(templateDir); });
 *   afterEach(() => { cleanupTestDir(testDir); });
 */

const path = require('path');
const fs = require('fs-extra');
const os = require('os');
const { execFileSync } = require('child_process');

/**
 * Create a reusable template git repo with initial commit.
 * Call this in beforeAll().
 *
 * @param {Object} [options]
 * @param {string} [options.branch='main'] - Initial branch name
 * @param {Object<string, string>} [options.files] - Additional files to create { relativePath: content }
 * @returns {string} Path to template directory
 */
function createTemplateRepo(options = {}) {
  const { branch = 'main', files = {} } = options;
  const templateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-git-template-'));

  execFileSync('git', ['init', '-b', branch], { cwd: templateDir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: templateDir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: templateDir, stdio: 'pipe' });

  // Default files
  fs.writeFileSync(path.join(templateDir, 'README.md'), '# Test');
  fs.ensureDirSync(path.join(templateDir, 'src'));
  fs.writeFileSync(path.join(templateDir, 'src', 'index.js'), 'module.exports = {};');

  // Additional files
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = path.join(templateDir, relPath);
    fs.ensureDirSync(path.dirname(fullPath));
    if (typeof content === 'object') {
      fs.writeJsonSync(fullPath, content);
    } else {
      fs.writeFileSync(fullPath, content);
    }
  }

  execFileSync('git', ['add', '.'], { cwd: templateDir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: templateDir, stdio: 'pipe' });

  return templateDir;
}

/**
 * Clone the template repo into a fresh test directory.
 * Uses `git clone --local` which is significantly faster than init + add + commit
 * because it hard-links objects instead of copying.
 *
 * Call this in beforeEach().
 *
 * @param {string} templateDir - Path from createTemplateRepo()
 * @param {string} [prefix='caws-test-'] - Temp directory prefix
 * @returns {string} Path to cloned test directory
 */
function cloneFixture(templateDir, prefix = 'caws-test-') {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  // Remove the empty dir — git clone needs a non-existing target
  fs.removeSync(testDir);
  execFileSync('git', ['clone', '--local', templateDir, testDir], { stdio: 'pipe' });
  // Set config in clone (not inherited from template's local config)
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: testDir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: testDir, stdio: 'pipe' });
  return testDir;
}

/**
 * Clean up a test directory, handling worktree pruning first.
 * @param {string} testDir
 */
function cleanupTestDir(testDir) {
  if (!testDir || !fs.existsSync(testDir)) return;
  try {
    execFileSync('git', ['worktree', 'prune'], { cwd: testDir, stdio: 'pipe' });
  } catch { /* ignore */ }
  fs.removeSync(testDir);
}

/**
 * Clean up the template directory.
 * Call this in afterAll().
 * @param {string} templateDir
 */
function cleanupTemplate(templateDir) {
  if (templateDir && fs.existsSync(templateDir)) {
    fs.removeSync(templateDir);
  }
}

module.exports = {
  createTemplateRepo,
  cloneFixture,
  cleanupTestDir,
  cleanupTemplate,
};
