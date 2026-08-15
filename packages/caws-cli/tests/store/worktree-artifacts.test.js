'use strict';

/**
 * Advisory artifact linking for `.caws/hooks/node_modules`
 * (CAWS-WORKTREE-ARTIFACT-CAWS-HOOKS-NODE-MODULES-001).
 *
 * `.caws` is in KNOWN_DIRS, so walkDirs prunes the whole `.caws` subtree at
 * walk depth 0 and would never discover the nested `.caws/hooks/node_modules`
 * artifact. The fix is an explicit ROOT_CANDIDATES entry checked directly
 * (bypassing the walk). These tests pin that discovery + link path WITHOUT
 * spinning a real `caws worktree create`: they drive linkWorktreeArtifacts
 * against temp dirs, with the worktree temp initialized as a git repo — the
 * ignore/exclude probes shell out to `git -C <worktree>`.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { linkWorktreeArtifacts } = require('../../dist/store/worktree-artifacts');

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function mkdtemp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}

// linkCandidate's ensureLinkIgnored runs `git -C <worktree> check-ignore` and
// resolves `info/exclude` via `git rev-parse --git-path`, then writes that file
// with fs.appendFileSync. For a LINKED worktree that path comes back ABSOLUTE
// (the common git dir's info/exclude); for a standalone `git init` it comes
// back RELATIVE (`.git/info/exclude`), which would resolve against Node's cwd
// rather than the worktree and leave the re-check reporting not-ignored. The
// production code only ever runs against linked worktrees, so the fixture must
// create one too — otherwise this test would report a phantom 'skipped_not_ignored'.
function mkGitWorktree() {
  const main = mkdtemp('wa-main-');
  execFileSync('git', ['init', '--quiet', '-b', 'main', main]);
  execFileSync('git', ['-C', main, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', main, 'config', 'user.name', 'Test']);
  execFileSync('git', ['-C', main, 'commit', '--quiet', '--allow-empty', '-m', 'init']);
  const wtParent = mkdtemp('wa-wtroot-');
  const wt = path.join(wtParent, 'wt');
  execFileSync('git', ['-C', main, 'worktree', 'add', '--quiet', '-b', 'wt-branch', wt]);
  return wt;
}

function mkdirp(p) {
  fs.mkdirSync(p, { recursive: true });
}

describe('CAWS-WORKTREE-ARTIFACT-CAWS-HOOKS-NODE-MODULES-001', () => {
  test('A1: canonical checkout with .caws/hooks/node_modules links it into the worktree', () => {
    const repo = mkdtemp('wa-repo-');
    // The nested artifact dir + a manifest that triggers hasAnyManifest
    // discovery (the ROOT_CANDIDATES bypass, since walkDirs prunes .caws).
    mkdirp(path.join(repo, '.caws', 'hooks', 'node_modules', 'js-yaml'));
    fs.writeFileSync(path.join(repo, '.caws', 'hooks', 'package.json'), '{}');
    const wt = mkGitWorktree();

    const { statuses } = linkWorktreeArtifacts(repo, wt);

    const hooks = statuses.find((s) => s.path === '.caws/hooks/node_modules');
    expect(hooks).toBeDefined();
    expect(hooks.kind).toBe('node_dependencies');
    expect(['linked', 'already_linked']).toContain(hooks.state);

    const linkPath = path.join(wt, '.caws', 'hooks', 'node_modules');
    expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
    const resolved = path.resolve(path.dirname(linkPath), fs.readlinkSync(linkPath));
    expect(resolved).toBe(path.resolve(repo, '.caws', 'hooks', 'node_modules'));
  });

  test('A2: canonical checkout without .caws/hooks node deps produces no link and no churn', () => {
    const repo = mkdtemp('wa-repo-'); // no .caws/hooks/* whatsoever
    const wt = mkGitWorktree();

    const { statuses } = linkWorktreeArtifacts(repo, wt);

    expect(statuses.find((s) => s.path === '.caws/hooks/node_modules')).toBeUndefined();
    expect(fs.existsSync(path.join(wt, '.caws', 'hooks', 'node_modules'))).toBe(false);
  });

  test('A3: a failed link op (dest already a real dir) is advisory — never throws', () => {
    const repo = mkdtemp('wa-repo-');
    mkdirp(path.join(repo, '.caws', 'hooks', 'node_modules'));
    fs.writeFileSync(path.join(repo, '.caws', 'hooks', 'package.json'), '{}');
    const wt = mkGitWorktree();
    // Pre-create the dest as a real directory so the symlink cannot be created.
    mkdirp(path.join(wt, '.caws', 'hooks', 'node_modules'));

    let result;
    expect(() => {
      result = linkWorktreeArtifacts(repo, wt);
    }).not.toThrow();

    const hooks = result.statuses.find((s) => s.path === '.caws/hooks/node_modules');
    expect(hooks).toBeDefined();
    expect(hooks.state).toBe('skipped_existing_path');
  });
});
