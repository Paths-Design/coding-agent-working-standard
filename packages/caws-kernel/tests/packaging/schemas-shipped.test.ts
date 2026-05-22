/**
 * CAWS-MIGRATE-V10-EVENTS-001 A4: kernel-side packaging guard.
 *
 * Asserts that every JSON schema under src/schemas/ has a counterpart
 * under dist/schemas/ after build. Closes the gap that caws-cli already
 * has via tests/packaging/files-allowlist.test.js — without this guard,
 * a kernel-side schema addition could appear in src/ but be missing
 * from the published tarball if the static import in evidence/validate.ts
 * was forgotten (tsc only copies .json files that resolveJsonModule
 * actually pulls in).
 *
 * The assertion is enumeration-based, not hard-coded: walks src/schemas/
 * at runtime and checks each .json file has a dist counterpart. A
 * second, explicit assertion names dist/schemas/events/chain_rotated.v1.json
 * specifically, per the slice's acceptance criterion — it pins the
 * regression this slice was built to prevent.
 *
 * Prerequisite: the kernel must be built (`npm run build`) before this
 * test runs. CI's prepublishOnly chain already runs the build; local
 * developers running `npm test` after editing schemas should run
 * `npm run build` first. The test fails with a clear diagnostic if
 * dist/ is absent.
 */

import * as fs from 'fs';
import * as path from 'path';

const SRC_SCHEMAS = path.resolve(__dirname, '../../src/schemas');
const DIST_SCHEMAS = path.resolve(__dirname, '../../dist/schemas');

function walkJsonFiles(rootDir: string): string[] {
  const out: string[] = [];
  function recurse(dir: string): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        recurse(full);
      } else if (entry.isFile() && entry.name.endsWith('.json')) {
        out.push(path.relative(rootDir, full));
      }
    }
  }
  recurse(rootDir);
  return out.sort();
}

describe('CAWS-MIGRATE-V10-EVENTS-001 A4 — kernel schemas ship in dist', () => {
  test('src/schemas exists and is non-empty', () => {
    expect(fs.existsSync(SRC_SCHEMAS)).toBe(true);
    const srcFiles = walkJsonFiles(SRC_SCHEMAS);
    expect(srcFiles.length).toBeGreaterThan(0);
  });

  test('dist/schemas exists (kernel must be built before this test runs)', () => {
    // If this fails, run: cd packages/caws-kernel && npm run build
    expect(fs.existsSync(DIST_SCHEMAS)).toBe(true);
  });

  test('every src/schemas/**/*.json has a dist counterpart', () => {
    const srcFiles = walkJsonFiles(SRC_SCHEMAS);
    const missing: string[] = [];
    for (const rel of srcFiles) {
      const distPath = path.join(DIST_SCHEMAS, rel);
      if (!fs.existsSync(distPath)) {
        missing.push(rel);
      }
    }
    expect(missing).toEqual([]);
  });

  test('every dist/schemas/**/*.json has a src counterpart (no stale dist)', () => {
    // The reverse check: if dist contains a schema that src does not,
    // either the source was deleted without a clean rebuild, or
    // someone hand-edited dist/. Either way, the dist is not trustworthy
    // as a reflection of source.
    const distFiles = walkJsonFiles(DIST_SCHEMAS);
    const orphans: string[] = [];
    for (const rel of distFiles) {
      const srcPath = path.join(SRC_SCHEMAS, rel);
      if (!fs.existsSync(srcPath)) {
        orphans.push(rel);
      }
    }
    expect(orphans).toEqual([]);
  });

  test('dist/schemas/events/chain_rotated.v1.json exists (the regression this slice prevents)', () => {
    // Explicit named assertion per CAWS-MIGRATE-V10-EVENTS-001 A4.
    // The enumeration-based test above would catch a missing
    // chain_rotated.v1.json incidentally, but this assertion makes
    // the failure message explicit and pins the regression as a
    // named test case for future grep-able debugging.
    const chainRotatedDist = path.join(
      DIST_SCHEMAS,
      'events/chain_rotated.v1.json'
    );
    expect(fs.existsSync(chainRotatedDist)).toBe(true);
  });

  test('dist/schemas/events/chain_rotated.v1.json is semantically equal to the src copy', () => {
    // tsc with resolveJsonModule parses the source JSON and re-serializes
    // it into dist/ with its own formatting (4-space indentation by
    // default, distinct from our 2-space src style). Byte equality is
    // therefore NOT preserved — every schema in dist/ has different
    // whitespace than src/. The contract we actually need is that the
    // JSON VALUE is preserved: same fields, same types, same enums.
    // Detect drift via deep JSON equality after parsing both sides.
    const srcPath = path.join(SRC_SCHEMAS, 'events/chain_rotated.v1.json');
    const distPath = path.join(DIST_SCHEMAS, 'events/chain_rotated.v1.json');
    expect(fs.existsSync(srcPath)).toBe(true);
    expect(fs.existsSync(distPath)).toBe(true);
    const srcJson = JSON.parse(fs.readFileSync(srcPath, 'utf8'));
    const distJson = JSON.parse(fs.readFileSync(distPath, 'utf8'));
    expect(distJson).toEqual(srcJson);
  });
});
