/**
 * CLI-GATES-003: resolveQualityGatesBin must locate caws-quality-gates
 * for both the project-local and the CLI-install-local install patterns.
 *
 * Pure resolver tests — no real subprocess, no real fs. The resolver
 * accepts an injected fsCheck so we can simulate disk layouts cheaply
 * and deterministically.
 */
'use strict';

const path = require('path');
const { resolveQualityGatesBin } = require('../../dist/shell');

const BIN_NAME = 'caws-quality-gates';

/**
 * Build a fsCheck closure that returns true for the listed absolute paths
 * (after path.resolve normalization) and false for everything else.
 */
function fsCheckOnly(presentPaths) {
  const set = new Set(presentPaths.map((p) => path.resolve(p)));
  return (p) => set.has(path.resolve(p));
}

describe('CLI-GATES-003 resolveQualityGatesBin', () => {
  const CLI_INSTALL = '/opt/caws-install/node_modules/@paths.design/caws-cli/dist/shell/gates';
  const PROJECT_CWD = '/home/user/myproject';

  test('A1: project-local install resolution still works (no regression)', () => {
    // Only the project-local bin exists; CLI install tree has no node_modules
    // adjacent (simulates the project-local install pattern where caws-cli
    // and caws-quality-gates both live in the project's node_modules).
    const projectBin = path.join(PROJECT_CWD, 'node_modules', '.bin', BIN_NAME);
    const fsCheck = fsCheckOnly([projectBin]);

    const result = resolveQualityGatesBin(CLI_INSTALL, PROJECT_CWD, fsCheck);
    expect(result).toEqual({ resolved: projectBin, source: 'project-local' });
  });

  test('A2: global/sandbox install resolution works (CLI-install-local wins, project has no node_modules)', () => {
    // CLI lives at /opt/caws-install/node_modules/@paths.design/caws-cli/...
    // The .bin shim is at /opt/caws-install/node_modules/.bin/caws-quality-gates
    // The consumer project has no node_modules at all.
    const cliBin = '/opt/caws-install/node_modules/.bin/' + BIN_NAME;
    const fsCheck = fsCheckOnly([cliBin]);

    const result = resolveQualityGatesBin(CLI_INSTALL, PROJECT_CWD, fsCheck);
    expect(result).toEqual({ resolved: cliBin, source: 'cli-local' });
  });

  test('A4: when both CLI-local and project-local bins exist, CLI-local wins (deterministic order)', () => {
    const cliBin = '/opt/caws-install/node_modules/.bin/' + BIN_NAME;
    const projectBin = path.join(PROJECT_CWD, 'node_modules', '.bin', BIN_NAME);
    const fsCheck = fsCheckOnly([cliBin, projectBin]);

    const result = resolveQualityGatesBin(CLI_INSTALL, PROJECT_CWD, fsCheck);
    expect(result).toEqual({ resolved: cliBin, source: 'cli-local' });
  });

  test('Neither bin found: returns tried[] with both CLI-local and project-local candidates for the diagnostic', () => {
    const fsCheck = fsCheckOnly([]); // nothing on disk
    const result = resolveQualityGatesBin(CLI_INSTALL, PROJECT_CWD, fsCheck);
    expect(result).toHaveProperty('tried');
    expect(result.tried.length).toBeGreaterThan(0);

    // Should have probed at least one ancestor of CLI_INSTALL and one
    // ancestor of PROJECT_CWD.
    const triedStr = result.tried.join('\n');
    expect(triedStr).toContain('/opt/caws-install/node_modules/.bin/' + BIN_NAME);
    expect(triedStr).toContain(path.join(PROJECT_CWD, 'node_modules', '.bin', BIN_NAME));
  });

  test('Walk-up: finds a bin in any ancestor node_modules, not only the immediate parent', () => {
    // CLI's bin is several levels above CLI_INSTALL — common when caws-cli
    // is nested inside a workspace's node_modules tree.
    const ancestorBin = '/opt/caws-install/node_modules/.bin/' + BIN_NAME;
    const fsCheck = fsCheckOnly([ancestorBin]);

    // CLI_INSTALL is /opt/caws-install/node_modules/@paths.design/caws-cli/dist/shell/gates
    // The resolver should walk up to /opt/caws-install/ and find node_modules/.bin/<BIN>
    const result = resolveQualityGatesBin(CLI_INSTALL, PROJECT_CWD, fsCheck);
    expect(result).toEqual({ resolved: ancestorBin, source: 'cli-local' });
  });

  test('Walk-up stops at fs root without infinite-looping', () => {
    // No bins anywhere; resolver must terminate.
    const fsCheck = fsCheckOnly([]);
    const result = resolveQualityGatesBin('/', '/', fsCheck);
    expect(result).toHaveProperty('tried');
    // From '/', only one candidate is produced (no parent to walk to).
    // So tried[] should be exactly [/node_modules/.bin/<BIN>] twice
    // (once for cli-local, once for project-local).
    expect(result.tried).toEqual([
      path.join('/', 'node_modules', '.bin', BIN_NAME),
      path.join('/', 'node_modules', '.bin', BIN_NAME),
    ]);
  });
});
