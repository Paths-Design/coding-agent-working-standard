/**
 * TEMPLATES-PUBLISH-REGRESSION-001: package.json:files must include every
 * subtree the v11 runtime reads from at install time.
 *
 * This is the cheap jest-layer guard. The expensive guard is
 * scripts/fresh-install-smoke.mjs (npm pack → install → init), wired as
 * prepublishOnly. Both must agree.
 *
 * Why both? The jest test fires on every PR (catches the bug at code-review
 * time). The smoke test fires at publish (catches packaging regressions
 * introduced by tooling or by future package.json restructures the jest
 * test couldn't anticipate). They check different invariants:
 *
 *   - jest test: the allowlist DECLARES the templates subtree.
 *   - smoke test: the tarball CONTAINS the manifest's declared files AND
 *                 caws init succeeds against the installed tarball.
 *
 * If only the jest test existed, someone could rename templates/ without
 * updating the allowlist and break installs. If only the smoke existed,
 * the regression wouldn't surface until release.
 */
const fs = require('fs');
const path = require('path');

describe('TEMPLATES-PUBLISH-REGRESSION-001 files allowlist', () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8')
  );

  test('files allowlist is declared', () => {
    expect(Array.isArray(pkg.files)).toBe(true);
    expect(pkg.files.length).toBeGreaterThan(0);
  });

  test('dist is included (compiled CLI entrypoint and library code)', () => {
    expect(pkg.files).toEqual(expect.arrayContaining(['dist']));
  });

  test('templates/hook-packs/** is included (v11 hook installer source assets)', () => {
    // The narrow allowlist — NOT bare 'templates'. Slice 8b correctly excluded
    // the dead scaffold/template surfaces; this glob re-includes only the
    // hook-pack subtree that INIT-HOOK-PACKS-001 added as a runtime dependency.
    expect(pkg.files).toEqual(expect.arrayContaining(['templates/hook-packs/**']));
  });

  test('bare templates is NOT included (slice 8b deadwood exclusion preserved)', () => {
    expect(pkg.files).not.toContain('templates');
    expect(pkg.files).not.toContain('templates/**');
    expect(pkg.files).not.toContain('templates/*');
  });

  test('README.md is included', () => {
    expect(pkg.files).toEqual(expect.arrayContaining(['README.md']));
  });
});
