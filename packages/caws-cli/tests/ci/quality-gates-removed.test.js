'use strict';

/**
 * Quality-gates removal invariants — QUALITY-GATES-PACKAGE-REMOVE-001.
 *
 * The standalone quality-gates package was removed (7901223e); its checks live
 * in the hook packs and `caws gates run`. These assertions pin the removal so a
 * revert, a stray template or a re-added workflow step cannot quietly bring it
 * back: no workspace package, no bin or dependency, no CI invocation, no guide
 * presenting it as a current tool, and none of the five `.caws/` configs that
 * only that package read.
 *
 * Files are read as bytes, never through grep: grep reports a file containing
 * a NUL byte as a non-match, which would turn this gate into a silent pass.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  cwd: __dirname,
  encoding: 'utf8',
}).trim();

/** Tracked files under the pathspecs that are materialized in this checkout. */
function trackedOnDisk(...pathspecs) {
  return execFileSync('git', ['ls-files', '-z', '--', ...pathspecs], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
    .split('\0')
    .filter((rel) => rel.length > 0 && fs.existsSync(path.join(REPO_ROOT, rel)));
}

function read(rel) {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

const ORPHAN_CONFIGS = [
  'code-freeze.yaml',
  'quality-exceptions.json',
  'duplication-exceptions.yaml',
  'refactor-baselines.yaml',
  'refactor-targets.yaml',
];

const REMOVED_PACKAGE = '@paths.design/quality-gates';
const REMOVED_BIN = 'caws-quality-gates';
const REMOVED_RUNNER = 'run-quality-gates';

describe('quality-gates package removal stays removed', () => {
  test('packages/quality-gates is not a workspace package', () => {
    expect(fs.existsSync(path.join(REPO_ROOT, 'packages/quality-gates'))).toBe(false);
    expect(trackedOnDisk('packages/quality-gates')).toEqual([]);
  });

  test('no manifest declares the caws-quality-gates bin or depends on the removed package', () => {
    const manifests = trackedOnDisk('package.json', 'packages/*/package.json');
    expect(manifests).toContain('package.json');
    expect(manifests).toContain('packages/caws-cli/package.json');
    const offenders = [];
    for (const rel of manifests) {
      const pkg = JSON.parse(read(rel));
      const bins = typeof pkg.bin === 'string' ? [pkg.name] : Object.keys(pkg.bin ?? {});
      if (bins.includes(REMOVED_BIN)) offenders.push(`${rel}: bin ${REMOVED_BIN}`);
      for (const field of [
        'dependencies',
        'devDependencies',
        'peerDependencies',
        'optionalDependencies',
      ]) {
        if (pkg[field] && REMOVED_PACKAGE in pkg[field]) offenders.push(`${rel}: ${field}`);
      }
      for (const ws of pkg.workspaces ?? []) {
        if (ws.includes('quality-gates')) offenders.push(`${rel}: workspaces ${ws}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('the lockfile installs no copy of the removed package', () => {
    const lock = JSON.parse(read('package-lock.json'));
    const entries = Object.keys(lock.packages ?? {});
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.filter((key) => key.includes('quality-gates'))).toEqual([]);
  });

  test('no CI workflow invokes the removed runner or bin', () => {
    const workflows = trackedOnDisk('.github/workflows');
    expect(workflows.length).toBeGreaterThan(0);
    const offenders = workflows.filter((rel) => {
      const text = read(rel);
      return text.includes(REMOVED_RUNNER) || text.includes(REMOVED_BIN);
    });
    expect(offenders).toEqual([]);
  });

  test('no guide or agent entry point presents caws-quality-gates as a current tool', () => {
    const docs = trackedOnDisk(
      'docs/guides',
      'README.md',
      'AGENTS.md',
      'packages/caws-cli/README.md'
    );
    // hook-packs.md is where the removal sends users, so the scan must reach it.
    expect(docs).toContain('docs/guides/hook-packs.md');
    const offenders = docs.filter((rel) => {
      const text = read(rel);
      return text.includes(REMOVED_BIN) || text.includes(REMOVED_RUNNER);
    });
    expect(offenders).toEqual([]);
  });
});

describe('the configs only quality-gates read are gone and have no reader', () => {
  test('none of the five configs exists or is tracked under .caws/', () => {
    const present = ORPHAN_CONFIGS.filter((name) =>
      fs.existsSync(path.join(REPO_ROOT, '.caws', name))
    );
    expect(present).toEqual([]);
    expect(trackedOnDisk(...ORPHAN_CONFIGS.map((name) => `.caws/${name}`))).toEqual([]);
  });

  test('no shipped source, template, script, hook or workflow names one of them', () => {
    const scanned = trackedOnDisk(
      'packages/caws-cli/src',
      'packages/caws-cli/templates',
      'scripts',
      '.caws/hooks',
      '.husky',
      '.github'
    );
    // The scan must reach real readers: policy.yaml is read by both the CLI
    // and the hooks, so a scan that cannot see it proves nothing about absence.
    const sees = (needle) => scanned.some((rel) => read(rel).includes(needle));
    expect(scanned.length).toBeGreaterThan(100);
    expect(sees('policy.yaml')).toBe(true);
    const readers = [];
    for (const rel of scanned) {
      const text = read(rel);
      for (const name of ORPHAN_CONFIGS) {
        if (text.includes(name)) readers.push(`${rel}: ${name}`);
      }
    }
    expect(readers).toEqual([]);
  });
});
