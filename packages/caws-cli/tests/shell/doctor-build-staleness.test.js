'use strict';

// Unit tests for detectBuildStaleness (CAWS-GUARD-BUILD-FRESHNESS-001).
//
// detectBuildStaleness takes the running binary's dist/ directory and
// returns a warning finding when any compiled artifact is older than its
// src/ source (or a published install with no src/ → no-op). These tests
// drive the function directly against temp package roots, using
// fs.utimesSync to force mtimes — no real repo or caws init is needed.

const fs = require('fs');
const os = require('os');
const path = require('path');

const { detectBuildStaleness, BUILD_DIST_STALE_RULE } = require('../../dist/shell/build-freshness');

const ROOTS = [];

function mkPkgRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-build-fresh-'));
  ROOTS.push(root);
  // package-root layout: { src/, dist/ }
  fs.mkdirSync(path.join(root, 'src', 'store'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src', 'shell'), { recursive: true });
  fs.mkdirSync(path.join(root, 'dist', 'store'), { recursive: true });
  fs.mkdirSync(path.join(root, 'dist', 'shell'), { recursive: true });
  return root;
}

afterAll(() => {
  for (const r of ROOTS) {
    try {
      fs.rmSync(r, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

// Set mtime on a path to a fixed epoch (seconds — utimesSync uses seconds
// when given two numbers). Floors to the nearest second so the comparison
// is robust across filesystems with second-granularity mtimes.
function setMtime(p, epochSeconds) {
  fs.utimesSync(p, epochSeconds, epochSeconds);
}

const T0 = 1_700_000_000; // a fixed baseline epoch (seconds)

describe('detectBuildStaleness (CAWS-GUARD-BUILD-FRESHNESS-001)', () => {
  test('returns null when dist is fresh (every artifact >= its source)', () => {
    const root = mkPkgRoot();
    // A TS source + its two artifacts, all built at T0+100 (newer than source at T0).
    fs.writeFileSync(path.join(root, 'src', 'store', 'a.ts'), 'export const a = 1;');
    setMtime(path.join(root, 'src', 'store', 'a.ts'), T0);
    fs.writeFileSync(path.join(root, 'dist', 'store', 'a.js'), 'exports.a = 1;');
    fs.writeFileSync(path.join(root, 'dist', 'store', 'a.d.ts'), 'export declare const a = 1;');
    setMtime(path.join(root, 'dist', 'store', 'a.js'), T0 + 100);
    setMtime(path.join(root, 'dist', 'store', 'a.d.ts'), T0 + 100);
    // An allowlisted JS source + its 1:1 artifact, also fresh.
    fs.writeFileSync(path.join(root, 'src', 'index.js'), '// allowlisted');
    setMtime(path.join(root, 'src', 'index.js'), T0);
    fs.writeFileSync(path.join(root, 'dist', 'index.js'), '// allowlisted');
    setMtime(path.join(root, 'dist', 'index.js'), T0 + 100);

    const finding = detectBuildStaleness(path.join(root, 'dist'));
    expect(finding).toBeNull();
  });

  test('emits shell.build.dist_stale (warning) when a TS artifact is older than its source', () => {
    const root = mkPkgRoot();
    // Source edited AFTER build (source T0+200, artifact T0+100 → stale).
    fs.writeFileSync(path.join(root, 'src', 'shell', 'b.ts'), 'export const b = 2;');
    setMtime(path.join(root, 'src', 'shell', 'b.ts'), T0 + 200);
    fs.writeFileSync(path.join(root, 'dist', 'shell', 'b.js'), 'exports.b = 2;');
    fs.writeFileSync(path.join(root, 'dist', 'shell', 'b.d.ts'), 'export declare const b = 2;');
    setMtime(path.join(root, 'dist', 'shell', 'b.js'), T0 + 100);
    setMtime(path.join(root, 'dist', 'shell', 'b.d.ts'), T0 + 100);

    const finding = detectBuildStaleness(path.join(root, 'dist'));
    expect(finding).not.toBeNull();
    expect(finding.rule).toBe(BUILD_DIST_STALE_RULE);
    expect(finding.severity).toBe('warning');
    expect(finding.subject).toBe('dist/');
    expect(finding.message).toMatch(/older than src\//);
    expect(finding.narrowRepair).toMatch(/npm run build/);
    expect(finding.data.stale_files).toBeGreaterThanOrEqual(2); // .js + .d.ts
    expect(finding.data.oldest_delta_ms).toBeGreaterThan(0);
  });

  test('emits a finding when a compiled artifact is MISSING (strongest staleness signal)', () => {
    const root = mkPkgRoot();
    fs.writeFileSync(path.join(root, 'src', 'store', 'c.ts'), 'export const c = 3;');
    setMtime(path.join(root, 'src', 'store', 'c.ts'), T0);
    // No dist/store/c.js and no dist/store/c.d.ts at all.
    const finding = detectBuildStaleness(path.join(root, 'dist'));
    expect(finding).not.toBeNull();
    expect(finding.rule).toBe(BUILD_DIST_STALE_RULE);
    expect(finding.data.stale_files).toBeGreaterThanOrEqual(2); // both artifacts missing
  });

  test('returns null (no-op) on a published install with no sibling src/', () => {
    const root = mkPkgRoot();
    // Remove the src/ tree to simulate a published install (package.json
    // files ships only dist/).
    fs.rmSync(path.join(root, 'src'), { recursive: true, force: true });
    // dist still has artifacts — but no sources to compare against.
    fs.writeFileSync(path.join(root, 'dist', 'store', 'a.js'), 'exports.a = 1;');

    const finding = detectBuildStaleness(path.join(root, 'dist'));
    expect(finding).toBeNull();
  });

  test('flags stale allowlisted JS sources too (1:1 copy path)', () => {
    const root = mkPkgRoot();
    // Allowlisted JS source newer than its copied artifact.
    fs.writeFileSync(path.join(root, 'src', 'index.js'), '// edited');
    setMtime(path.join(root, 'src', 'index.js'), T0 + 300);
    fs.writeFileSync(path.join(root, 'dist', 'index.js'), '// stale');
    setMtime(path.join(root, 'dist', 'index.js'), T0);

    const finding = detectBuildStaleness(path.join(root, 'dist'));
    expect(finding).not.toBeNull();
    expect(finding.rule).toBe(BUILD_DIST_STALE_RULE);
    expect(finding.data.stale_files).toBeGreaterThanOrEqual(1);
  });
});
