/**
 * CLI-GATES-002: caws-cli must resolve and install caws-quality-gates for v11 gates run.
 *
 * Spec AC A2: dependencies must declare @paths.design/quality-gates at a version
 * range compatible with the kernel's expected subprocess contract.
 *
 * This test reads package.json directly rather than the on-disk node_modules
 * symlink so it asserts the published-tarball contract, not the local workspace
 * state. The npm pack tarball includes package.json verbatim.
 */
const fs = require('fs');
const path = require('path');

describe('CLI-GATES-002 runtime dependencies', () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8')
  );

  test('declares @paths.design/quality-gates as a runtime dependency', () => {
    expect(pkg.dependencies).toBeDefined();
    expect(pkg.dependencies['@paths.design/quality-gates']).toBeDefined();
  });

  test('quality-gates range starts at the v2 major (matches v11 subprocess contract)', () => {
    const range = pkg.dependencies['@paths.design/quality-gates'];
    expect(range).toMatch(/^\^?2\./);
  });

  test('quality-gates is in dependencies, not devDependencies or peerDependencies', () => {
    expect(pkg.devDependencies?.['@paths.design/quality-gates']).toBeUndefined();
    expect(pkg.peerDependencies?.['@paths.design/quality-gates']).toBeUndefined();
  });
});
