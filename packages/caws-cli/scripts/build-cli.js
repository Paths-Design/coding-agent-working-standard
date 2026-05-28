#!/usr/bin/env node
/**
 * Build the caws-cli package for v11.0.0.
 *
 * v11 ONLY ships the governed core. The build emits exactly the dist/
 * subtrees that v11 runtime actually loads, plus their immediate JS
 * dependencies under src/. Everything else stays in src/ for archaeology
 * and is removed from the package boundary.
 *
 * Allowlist (derived from actual runtime trace under
 *   `node dist/index.js [--help|init|doctor|status|scope|claim|gates|
 *    evidence|waiver]`):
 *
 *   dist/index.js
 *   dist/config/index.js
 *   dist/error-handler.js
 *   dist/utils/detection.js          (transitive via config)
 *   dist/utils/error-categories.js   (transitive via error-handler)
 *   dist/shell/**\/*.js              (TS-compiled by tsc)
 *   dist/store/**\/*.js              (TS-compiled by tsc)
 *
 * Anything else under `src/` (commands/, scaffold/, sidecars/, session/,
 * parallel/, worktree/, spec/, validation/, policy/*.js, generators/,
 * test-analysis.js, utils/event-log.js, utils/spec-resolver.js,
 * utils/* not on the allowlist, etc.) does NOT enter dist/ — those are
 * orphaned-by-removal under slices 8a3.1–8a3.5 (see
 * docs/architecture/caws-vnext-command-surface.md §3) and would only
 * leak old authority into the v11 package.
 *
 * `templates/` (legacy scaffold IDE/hook templates referencing removed
 * commands) is NOT copied into dist/ in v11. The `"templates"` entry is
 * also removed from package.json:files in slice 8b.3.
 *
 * Why an allowlist instead of a `.npmignore` blocklist? Replacement,
 * not continuity (slice 8a doctrine). A blocklist would silently ship
 * any new dormant subtree added later; an allowlist forces an explicit
 * decision.
 *
 * Two outputs land in dist/:
 *   1. JS sources from src/ (allowlisted JS files only)
 *   2. TS vNext layer (store + shell) compiled via `tsc -p tsconfig.vnext.json`
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const pkgRoot = path.resolve(__dirname, '..');
const srcDir = path.join(pkgRoot, 'src');
const distDir = path.join(pkgRoot, 'dist');

/**
 * v11 JS-source allowlist. Each entry is a path relative to `src/`.
 * Files are copied verbatim from src/<entry> to dist/<entry>.
 *
 * Keep this list MINIMAL. Discovered via runtime require-trace; if a
 * file is added here, it must be required at runtime by `dist/index.js`
 * or by something on this list (transitively).
 */
const JS_ALLOWLIST = [
  'index.js',
  'config/index.js',
  'error-handler.js',
  'shell/legacy-command-map.js',
  'shell/registered-command-groups.js',
  'utils/detection.js',
  'utils/error-categories.js',
];

function rmrf(target) {
  if (!fs.existsSync(target)) return;
  fs.rmSync(target, { recursive: true, force: true });
}

function copyOne(relative) {
  const from = path.join(srcDir, relative);
  const to = path.join(distDir, relative);
  if (!fs.existsSync(from)) {
    throw new Error(`build-cli: allowlisted file not found: src/${relative}`);
  }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit' });
  if (r.status !== 0) {
    process.exit(r.status ?? 1);
  }
}

// 1. Clean dist
rmrf(distDir);
fs.mkdirSync(distDir, { recursive: true });

// 2. Copy allowlisted JS sources
for (const rel of JS_ALLOWLIST) {
  copyOne(rel);
}

// 3. Compile TS vNext layer (store + shell). tsc emits JS into dist/
//    according to outDir in tsconfig.vnext.json. No .ts source files
//    leak into dist (only .d.ts declarations, which are typed surface).
const tscBin = path.resolve(pkgRoot, '..', '..', 'node_modules', '.bin', 'tsc');
const tscArg = ['-p', 'tsconfig.vnext.json'];
if (fs.existsSync(tscBin)) {
  run(tscBin, tscArg, pkgRoot);
} else {
  // Fall back to PATH-resolved tsc (workspace install pattern).
  run('npx', ['--no', 'tsc', ...tscArg], pkgRoot);
}

// 4. Set executable bit on dist/index.js (CAWS-CLI-BIN-EXECUTABLE-BIT-001).
//    npm install's bin-linking handles this at install time for downstream
//    consumers, but workspace-local symlinks (node_modules/.bin/caws in CI
//    before publishing, or fresh `npm install --workspaces` setups) do not.
//    Without +x, tarball-truth tests had to invoke `node dist/index.js`
//    directly rather than the symlink.
//
//    Step 4 runs AFTER tsc emit (step 3). If chmod ran before tsc, tsc
//    would overwrite dist/index.js and clear the mode bits. The current
//    order — copy → tsc → chmod — guarantees the bit is set on the final
//    output. Note that index.js is a JS source COPY (not tsc output) per
//    JS_ALLOWLIST, so it is created in step 2 and tsc does not touch it;
//    the post-tsc ordering is defense in depth.
//
//    On Windows (process.platform === "win32"), chmod is skipped silently.
//    POSIX modes do not apply; npm bin-linking creates .cmd shims separately.
//
//    A failed chmod on POSIX fails the build loudly (exit non-zero) — a
//    non-executable bin is a published defect, not a recoverable warning.
if (process.platform !== 'win32') {
  const distIndex = path.join(distDir, 'index.js');
  try {
    fs.chmodSync(distIndex, 0o755);
  } catch (err) {
    console.error(`build-cli: chmod 0o755 failed on ${distIndex}: ${err.message}`);
    process.exit(1);
  }
}

console.log('caws-cli build complete (v11 allowlist).');
