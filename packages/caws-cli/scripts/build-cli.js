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

console.log('caws-cli build complete (v11 allowlist).');
