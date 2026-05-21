/**
 * @fileoverview CAWS-CLI-BIN-EXECUTABLE-BIT-001 — build script must set
 * the owner-executable bit on packages/caws-cli/dist/index.js after build
 * on POSIX systems.
 *
 * Strategy: this test runs AFTER the global pretest build (`npm test`
 * invokes `npm run build` before jest). It does NOT delete or rebuild
 * dist/ — doing so would race with other parallel jest workers that
 * load `require('../../dist/store')` at module-load time.
 *
 * The test relies on:
 *   - the global build having already produced dist/index.js (true under
 *     `npm test` and `npm run test:unit`)
 *   - chmod being deterministic for a given build output (asserted by
 *     stat-ing the file)
 *   - static inspection of build-cli.js to verify the chmod step exists
 *     and is correctly platform-guarded
 *
 * A separate test (commented out below) would prove the build's clean-
 * rebuild idempotency by invoking build-cli.js into a temp directory.
 * That belongs in a smoke harness, not the parallel jest pool.
 *
 * @author @darianrosebrook
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const BUILD_SCRIPT = path.join(REPO_ROOT, 'packages', 'caws-cli', 'scripts', 'build-cli.js');
const DIST_INDEX = path.join(REPO_ROOT, 'packages', 'caws-cli', 'dist', 'index.js');

// =============================================================================
// Static inspection of build-cli.js — proves the chmod step is wired in,
// independent of whether dist/ exists at test time.
// =============================================================================

describe('CAWS-CLI-BIN-EXECUTABLE-BIT-001 — build script static inspection', () => {
  let buildScriptSource;

  beforeAll(() => {
    buildScriptSource = fs.readFileSync(BUILD_SCRIPT, 'utf8');
  });

  it('contains a chmod 0o755 call (paired with an index.js path reference)', () => {
    // The chmod call uses a variable (distIndex) holding the path. Assert:
    //   - the chmod call exists with 0o755
    //   - that variable is assigned to a path ending in 'index.js'
    // This is two assertions because the chmod and the path resolution are
    // on separate lines.
    expect(buildScriptSource).toMatch(/fs\.chmodSync\([^)]+,\s*0o755\s*\)/);
    expect(buildScriptSource).toMatch(/['"`]index\.js['"`]/);
  });

  it('platform-guards the chmod with process.platform !== "win32"', () => {
    // The chmod must NOT run on Windows. The guard appears as a conditional
    // around the chmod block.
    expect(buildScriptSource).toMatch(/process\.platform\s*!==?\s*['"`]win32['"`]/);
  });

  it('places the chmod step AFTER tsc emit (so tsc cannot overwrite the mode)', () => {
    // Find indices of the tsc invocation and the chmod call. chmod must come
    // after. This is a defensive ordering check — if a refactor moves chmod
    // before tsc, the bit would be cleared by tsc's output.
    const tscIdx = buildScriptSource.search(/tsc[\s\S]*tsconfig\.vnext\.json/);
    const chmodIdx = buildScriptSource.search(/fs\.chmodSync/);
    expect(tscIdx).toBeGreaterThan(-1);
    expect(chmodIdx).toBeGreaterThan(-1);
    expect(chmodIdx).toBeGreaterThan(tscIdx);
  });

  it('fails loudly on chmod errors (no silent skip on POSIX)', () => {
    // A non-executable bin is a published defect. The script must
    // process.exit(non-zero) if chmod throws.
    expect(buildScriptSource).toMatch(/process\.exit\(1\)/);
    // The error must be logged to stderr/console.error before exiting.
    expect(buildScriptSource).toMatch(/console\.error[\s\S]*chmod/i);
  });
});

// =============================================================================
// POSIX runtime check — relies on the existing build output, does NOT
// rebuild. Safe to run in parallel jest workers.
// =============================================================================

const describeOnPosix = process.platform === 'win32' ? describe.skip : describe;

describeOnPosix('CAWS-CLI-BIN-EXECUTABLE-BIT-001 — POSIX build output', () => {
  it('A1: dist/index.js exists after the pretest build', () => {
    // `npm test` runs `npm run build` before jest. If dist/index.js does not
    // exist here, the build harness is broken — but that is a separate issue
    // from THIS spec's contract. Assert presence as a precondition for the
    // mode check.
    expect(fs.existsSync(DIST_INDEX)).toBe(true);
  });

  it('A1: dist/index.js has owner-executable bit set (mode & 0o100 != 0)', () => {
    const mode = fs.statSync(DIST_INDEX).mode;
    expect(mode & 0o100).not.toBe(0);
  });

  it('A1: dist/index.js has mode 0o755 specifically (not just owner-x)', () => {
    // The script uses chmod(0o755), so all three rwx-r-x-r-x bits should be
    // set. Group + world execute matter for npm installs under restrictive
    // umasks.
    const mode = fs.statSync(DIST_INDEX).mode & 0o777;
    expect(mode).toBe(0o755);
  });

  it('A2: dist/index.js is invokable directly via shebang (not via `node`)', () => {
    // Direct exec of the file. With +x set, exec'ing through the shebang
    // should print the cli version.
    const r = spawnSync(DIST_INDEX, ['--version'], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});

// =============================================================================
// Windows runtime check — skipped suite on POSIX. The Windows-specific
// behavior is "chmod is skipped, build completes without error." Asserted
// in the static-inspection suite above (the platform guard exists);
// runtime verification on Windows CI would assert that the build completes
// and dist/index.js exists, but does NOT assert POSIX mode bits.
// =============================================================================

const describeOnWindows = process.platform === 'win32' ? describe : describe.skip;

describeOnWindows('CAWS-CLI-BIN-EXECUTABLE-BIT-001 — Windows', () => {
  it('A4: dist/index.js exists after the pretest build (no chmod attempt)', () => {
    expect(fs.existsSync(DIST_INDEX)).toBe(true);
    // No POSIX-mode assertion — fs.statSync(file).mode is not meaningful
    // for executable semantics on Windows. npm bin-linking creates .cmd
    // shims separately.
  });
});

// =============================================================================
// NOTE on idempotency / clean-rebuild testing:
//
// A test that calls `fs.rmSync(distDir)` + `node scripts/build-cli.js`
// CANNOT live in the parallel jest pool. Other test files do
// `require('../../dist/store')` at module-load time, and rebuilding dist
// mid-suite races with their require-cache misses, causing ENOENT in
// unrelated suites.
//
// Idempotency proof belongs in a smoke harness invoked OUTSIDE jest:
//   - `scripts/fresh-install-smoke.mjs` packs the tarball and installs
//     it; if chmod didn't run, the installed shebang invocation would
//     fail. This is already wired as a prepublishOnly gate.
//   - The dry-run release smoke (CAWS_RELEASE_DRY_RUN=1 node
//     scripts/release-tag-publish.mjs caws-cli-vX.Y.Z) exercises the
//     full build + smoke + would-publish flow.
//
// Both already run on this PR's CI (the dry-run smoke is in
// release-tag-publish.test.js). So the clean-rebuild path is exercised;
// it just doesn't live in this file.
// =============================================================================
