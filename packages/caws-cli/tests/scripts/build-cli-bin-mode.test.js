/**
 * @fileoverview CAWS-CLI-BIN-EXECUTABLE-BIT-001 — build script must set
 * the owner-executable bit on packages/caws-cli/dist/index.js after build
 * on POSIX systems. On Windows, the build should complete without
 * attempting chmod.
 *
 * Strategy: run the build script as a subprocess against the real
 * packages/caws-cli/dist/ output, then stat the file. The build is
 * already idempotent and fast (sub-second after caches warm), so this
 * doesn't need a temp-dir fixture to be deterministic.
 *
 * @author @darianrosebrook
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const BUILD_SCRIPT = path.join(REPO_ROOT, 'packages', 'caws-cli', 'scripts', 'build-cli.js');
const DIST_INDEX = path.join(REPO_ROOT, 'packages', 'caws-cli', 'dist', 'index.js');
const DIST_DIR = path.join(REPO_ROOT, 'packages', 'caws-cli', 'dist');

function runBuild(extraEnv = {}) {
  return spawnSync('node', [BUILD_SCRIPT], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
  });
}

// =============================================================================
// POSIX behavior
// =============================================================================

const describeOnPosix = process.platform === 'win32' ? describe.skip : describe;

describeOnPosix('CAWS-CLI-BIN-EXECUTABLE-BIT-001 — POSIX', () => {
  beforeAll(() => {
    // Clean dist first to ensure we test the full build path (not a cached
    // state that already has the bit set from a prior run).
    fs.rmSync(DIST_DIR, { recursive: true, force: true });
    const r = runBuild();
    if (r.status !== 0) {
      throw new Error(`build failed (exit ${r.status}): ${r.stderr || r.stdout}`);
    }
  });

  it('A1: dist/index.js exists after a clean build', () => {
    expect(fs.existsSync(DIST_INDEX)).toBe(true);
  });

  it('A1: dist/index.js has owner-executable bit set (mode & 0o100 != 0)', () => {
    const mode = fs.statSync(DIST_INDEX).mode;
    expect(mode & 0o100).not.toBe(0);
  });

  it('A1: dist/index.js has mode 0o755 specifically (not just owner-x)', () => {
    // The script uses chmod(0o755), so all three rwx-r-x-r-x bits should
    // be set. Group + world execute matter for npm installs that use a
    // restrictive umask.
    const mode = fs.statSync(DIST_INDEX).mode & 0o777;
    expect(mode).toBe(0o755);
  });

  it('A2: dist/index.js is invokable directly via shebang (not via `node`)', () => {
    // The script's shebang dispatches to node. With +x set, exec'ing the
    // file directly should print the cli version.
    const r = spawnSync(DIST_INDEX, ['--version'], {
      encoding: 'utf8',
    });
    expect(r.status).toBe(0);
    // Output is the version string; assert it's semver-shaped.
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});

// =============================================================================
// Windows behavior — skipped suite on POSIX
// =============================================================================

const describeOnWindows = process.platform === 'win32' ? describe : describe.skip;

describeOnWindows('CAWS-CLI-BIN-EXECUTABLE-BIT-001 — Windows', () => {
  beforeAll(() => {
    fs.rmSync(DIST_DIR, { recursive: true, force: true });
    const r = runBuild();
    if (r.status !== 0) {
      throw new Error(`build failed on Windows (exit ${r.status}): ${r.stderr || r.stdout}`);
    }
  });

  it('A4: build completes without error on Windows (no chmod attempted)', () => {
    expect(fs.existsSync(DIST_INDEX)).toBe(true);
  });

  // No POSIX-mode assertion on Windows — fs.statSync(file).mode is not
  // meaningful for executable semantics there. npm bin-linking creates
  // .cmd shims separately.
});

// =============================================================================
// Cross-platform: the build never overwrites the chmod-set bit
// =============================================================================

describe('CAWS-CLI-BIN-EXECUTABLE-BIT-001 — build idempotency', () => {
  it('A1: a second build preserves the executable bit (chmod is the last step)', () => {
    // First build (POSIX: chmod ran; Windows: nothing to set).
    const first = runBuild();
    expect(first.status).toBe(0);

    if (process.platform !== 'win32') {
      const firstMode = fs.statSync(DIST_INDEX).mode & 0o777;
      expect(firstMode).toBe(0o755);
    }

    // Second build (without removing dist) — the script still cleans and
    // re-emits, so the chmod must run again deterministically.
    const second = runBuild();
    expect(second.status).toBe(0);

    if (process.platform !== 'win32') {
      const secondMode = fs.statSync(DIST_INDEX).mode & 0o777;
      expect(secondMode).toBe(0o755);
    }
  });
});
