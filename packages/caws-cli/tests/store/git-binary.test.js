'use strict';

/**
 * CAWS-GIT-SPAWN-COST-001 — the git-binary resolver.
 *
 * The resolver exists purely for speed, which makes its correctness bar
 * unusual: it must be *invisible*. Every test here pins the property that it
 * does not change which git runs — the fallback, the override, the skip rules
 * — rather than the property that it is fast. A resolver that picked a
 * different binary would be a far worse defect than the cost it removes.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { resolveGitBinary, resetGitBinaryCache } = require('../../dist/store');

const ORIGINAL_PATH = process.env.PATH;
const ORIGINAL_OVERRIDE = process.env.CAWS_GIT_BINARY;
const trash = [];

function mkdir(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  trash.push(d);
  return d;
}

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
  if (ORIGINAL_OVERRIDE === undefined) delete process.env.CAWS_GIT_BINARY;
  else process.env.CAWS_GIT_BINARY = ORIGINAL_OVERRIDE;
  resetGitBinaryCache();
});

afterAll(() => {
  for (const d of trash) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

describe('resolveGitBinary', () => {
  test('returns an absolute path to an executable file that really is git', () => {
    const resolved = resolveGitBinary();

    expect(path.isAbsolute(resolved)).toBe(true);
    expect(fs.statSync(resolved).isFile()).toBe(true);
    const version = execFileSync(resolved, ['--version'], { encoding: 'utf8' });
    expect(version).toMatch(/^git version /);
  });

  test('selects the same binary the OS would — the first git on PATH', () => {
    // Build a PATH whose FIRST entry holds a working git shim. If the resolver
    // scanned in any other order, or skipped the entry, it would return the
    // system git instead and this fails.
    const first = mkdir('gitbin-first-');
    const shim = path.join(first, 'git');
    fs.writeFileSync(shim, '#!/bin/sh\necho "git version 0.0.0-shim"\n');
    fs.chmodSync(shim, 0o755);

    process.env.PATH = `${first}${path.delimiter}${ORIGINAL_PATH}`;
    resetGitBinaryCache();

    expect(resolveGitBinary()).toBe(shim);
    expect(execFileSync(shim, ['--version'], { encoding: 'utf8' }).trim()).toBe(
      'git version 0.0.0-shim'
    );
  });

  test('skips a DIRECTORY named git — execute permission on a dir is traversal, not runnability', () => {
    // accessSync(X_OK) alone passes for an executable directory. Without the
    // isFile check the resolver would hand a directory to execFileSync, and
    // every git call in the process would fail with EACCES.
    const decoy = mkdir('gitbin-decoy-');
    fs.mkdirSync(path.join(decoy, 'git'), { mode: 0o755 });

    process.env.PATH = `${decoy}${path.delimiter}${ORIGINAL_PATH}`;
    resetGitBinaryCache();

    const resolved = resolveGitBinary();
    expect(resolved).not.toBe(path.join(decoy, 'git'));
    expect(fs.statSync(resolved).isFile()).toBe(true);
    expect(execFileSync(resolved, ['--version'], { encoding: 'utf8' })).toMatch(/^git version /);
  });

  test('skips a non-executable file named git', () => {
    const decoy = mkdir('gitbin-noexec-');
    const notExec = path.join(decoy, 'git');
    fs.writeFileSync(notExec, 'not executable\n');
    fs.chmodSync(notExec, 0o644);

    process.env.PATH = `${decoy}${path.delimiter}${ORIGINAL_PATH}`;
    resetGitBinaryCache();

    expect(resolveGitBinary()).not.toBe(notExec);
  });

  test('falls back to the bare name when PATH holds no git at all', () => {
    // This is the invariant that makes the whole change safe: if resolution
    // fails for ANY reason, call sites get exactly what they passed before.
    process.env.PATH = mkdir('gitbin-empty-');
    resetGitBinaryCache();

    expect(resolveGitBinary()).toBe('git');
  });

  test('falls back to the bare name when PATH is unset', () => {
    delete process.env.PATH;
    resetGitBinaryCache();

    expect(resolveGitBinary()).toBe('git');
  });

  test('does not honour an empty PATH entry as the current directory', () => {
    // execvp treats "" as cwd. We deliberately do not, because CAWS runs git
    // inside repositories whose contents it does not control, and a checked-in
    // ./git would otherwise win.
    const cwdDecoy = mkdir('gitbin-cwd-');
    const planted = path.join(cwdDecoy, 'git');
    fs.writeFileSync(planted, '#!/bin/sh\necho pwned\n');
    fs.chmodSync(planted, 0o755);
    const previousCwd = process.cwd();
    process.chdir(cwdDecoy);
    try {
      process.env.PATH = `${path.delimiter}${ORIGINAL_PATH}`;
      resetGitBinaryCache();

      expect(resolveGitBinary()).not.toBe(planted);
      expect(path.basename(path.dirname(resolveGitBinary()))).not.toBe(
        path.basename(cwdDecoy)
      );
    } finally {
      process.chdir(previousCwd);
    }
  });

  test('CAWS_GIT_BINARY is used verbatim, in preference to PATH', () => {
    process.env.CAWS_GIT_BINARY = '/some/pinned/git';
    resetGitBinaryCache();

    expect(resolveGitBinary()).toBe('/some/pinned/git');
  });

  test('CAWS_GIT_BINARY is re-read per call, so it is never pinned by an earlier cache fill', () => {
    resetGitBinaryCache();
    const fromPath = resolveGitBinary(); // fills the cache

    process.env.CAWS_GIT_BINARY = '/pinned/later';
    expect(resolveGitBinary()).toBe('/pinned/later');

    delete process.env.CAWS_GIT_BINARY;
    expect(resolveGitBinary()).toBe(fromPath);
  });

  test('an empty CAWS_GIT_BINARY is ignored rather than used as a binary name', () => {
    process.env.CAWS_GIT_BINARY = '';
    resetGitBinaryCache();

    expect(resolveGitBinary()).not.toBe('');
    expect(path.isAbsolute(resolveGitBinary())).toBe(true);
  });

  test('the result is cached: a PATH change after the first call has no effect until reset', () => {
    // Call-observation of the cache without mocking fs: if the second call
    // re-scanned, it would find the shim that is now first on PATH.
    resetGitBinaryCache();
    const first = resolveGitBinary();

    const shimDir = mkdir('gitbin-cache-');
    const shim = path.join(shimDir, 'git');
    fs.writeFileSync(shim, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(shim, 0o755);
    process.env.PATH = `${shimDir}${path.delimiter}${ORIGINAL_PATH}`;

    expect(resolveGitBinary()).toBe(first); // cached — did NOT rescan

    resetGitBinaryCache();
    expect(resolveGitBinary()).toBe(shim); // positive control: rescanning works
  });
});
