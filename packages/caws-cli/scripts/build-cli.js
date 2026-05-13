#!/usr/bin/env node
/**
 * Build the caws-cli package.
 *
 * Two outputs land in dist/:
 *   1. JS sources from src/ (copied verbatim, EXCLUDING any *.ts files)
 *   2. TS vNext layer (store + shell) compiled via `tsc -p tsconfig.vnext.json`
 *
 * Plus templates/ copied verbatim.
 *
 * Why a Node script instead of shell? Two reasons:
 *   - `cp -r src/* dist/` cannot portably exclude *.ts on macOS/Linux.
 *   - We need an explicit ordering: copy first, compile second, so the
 *     TS compiler's emitted JS overlays any stale dist/store/*.js from
 *     a previous run.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const pkgRoot = path.resolve(__dirname, '..');
const srcDir = path.join(pkgRoot, 'src');
const distDir = path.join(pkgRoot, 'dist');
const templatesDir = path.join(pkgRoot, 'templates');

function rmrf(target) {
  if (!fs.existsSync(target)) return;
  fs.rmSync(target, { recursive: true, force: true });
}

/**
 * Recursive copy that:
 *  - skips files ending in `.ts` and `.ts.map`
 *  - skips `.d.ts` files (they're build artifacts, not sources)
 *  - skips any tsconfig.json under src/ (defensive)
 */
function copyJsTree(srcRoot, destRoot) {
  if (!fs.existsSync(srcRoot)) return;
  fs.mkdirSync(destRoot, { recursive: true });
  for (const entry of fs.readdirSync(srcRoot, { withFileTypes: true })) {
    const from = path.join(srcRoot, entry.name);
    const to = path.join(destRoot, entry.name);
    if (entry.isDirectory()) {
      copyJsTree(from, to);
      continue;
    }
    if (!entry.isFile()) continue;
    if (entry.name.endsWith('.ts') || entry.name.endsWith('.ts.map')) continue;
    if (entry.name === 'tsconfig.json') continue;
    fs.copyFileSync(from, to);
  }
}

function copyDir(srcRoot, destRoot) {
  if (!fs.existsSync(srcRoot)) return;
  fs.cpSync(srcRoot, destRoot, { recursive: true });
}

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit' });
  if (r.status !== 0) {
    process.exit(r.status ?? 1);
  }
}

// 1. clean dist
rmrf(distDir);
fs.mkdirSync(distDir, { recursive: true });

// 2. copy JS sources (excluding *.ts) from src/ to dist/
copyJsTree(srcDir, distDir);

// 3. copy templates/ verbatim into dist/templates
if (fs.existsSync(templatesDir)) {
  copyDir(templatesDir, path.join(distDir, 'templates'));
}

// 4. compile TS vNext layer (store + shell)
const tscBin = path.resolve(pkgRoot, '..', '..', 'node_modules', '.bin', 'tsc');
const tscArg = ['-p', 'tsconfig.vnext.json'];
if (fs.existsSync(tscBin)) {
  run(tscBin, tscArg, pkgRoot);
} else {
  // Fall back to PATH-resolved tsc (workspace install pattern).
  run('npx', ['--no', 'tsc', ...tscArg], pkgRoot);
}

console.log('caws-cli build complete.');
