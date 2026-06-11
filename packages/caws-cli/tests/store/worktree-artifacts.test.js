'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  linkWorktreeArtifacts,
  listVerifiedArtifactLinks,
  removeWorktreeArtifactLinks,
} = require('../../dist/store/worktree-artifacts');

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// The default ignorePattern is the dir-only spelling (`node_modules/`)
// because that is what real repos overwhelmingly use — and it is the
// spelling that does NOT match a symlink, the trap at the heart of
// CAWS-WORKTREE-ARTIFACT-LINK-SYMLINK-IGNORE-001.
function mkRepo({ ignored = true, withNodeModules = true, ignorePattern = 'node_modules/' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-artifacts-'));
  execFileSync('git', ['init', '--quiet', '-b', 'main', root]);
  git(root, ['config', 'user.email', 'test@test.com']);
  git(root, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(root, 'package.json'), '{"scripts":{"test":"node -e 1"}}\n');
  fs.writeFileSync(path.join(root, 'package-lock.json'), '{"lockfileVersion":3}\n');
  if (ignored) fs.writeFileSync(path.join(root, '.gitignore'), `${ignorePattern}\n`);
  git(root, ['add', '-A']);
  git(root, ['commit', '--quiet', '-m', 'init']);
  if (withNodeModules) {
    fs.mkdirSync(path.join(root, 'node_modules', '.bin'), { recursive: true });
  }
  const wt = path.join(os.tmpdir(), path.basename(root) + '-wt');
  git(root, ['worktree', 'add', '--quiet', '-b', 'wt-branch', wt]);
  return { root, wt };
}

function cleanup(ctx) {
  try {
    git(ctx.root, ['worktree', 'remove', '--force', ctx.wt]);
  } catch {
    fs.rmSync(ctx.wt, { recursive: true, force: true });
  }
  fs.rmSync(ctx.root, { recursive: true, force: true });
}

describe('linkWorktreeArtifacts', () => {
  const cleanups = [];
  afterEach(() => {
    while (cleanups.length > 0) cleanup(cleanups.pop());
  });

  it('links ignored root node_modules with a relative symlink', () => {
    const ctx = mkRepo();
    cleanups.push(ctx);

    const result = linkWorktreeArtifacts(ctx.root, ctx.wt);
    const nodeModules = result.statuses.find((s) => s.path === 'node_modules');

    expect(nodeModules).toBeDefined();
    expect(nodeModules.state).toBe('linked');
    expect(fs.lstatSync(path.join(ctx.wt, 'node_modules')).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(path.join(ctx.wt, 'node_modules'))).toBe(
      path.relative(ctx.wt, path.join(ctx.root, 'node_modules'))
    );
    expect(nodeModules.unlinkCommand).toBe("rm 'node_modules'");
  });

  it('reports missing target without failing the caller', () => {
    const ctx = mkRepo({ withNodeModules: false });
    cleanups.push(ctx);

    const result = linkWorktreeArtifacts(ctx.root, ctx.wt);
    const nodeModules = result.statuses.find((s) => s.path === 'node_modules');

    expect(nodeModules).toBeDefined();
    expect(nodeModules.state).toBe('missing_target');
    expect(nodeModules.reason).toMatch(/No canonical artifact exists/);
    expect(fs.existsSync(path.join(ctx.wt, 'node_modules'))).toBe(false);
  });

  it('leaves an existing worktree path untouched', () => {
    const ctx = mkRepo();
    cleanups.push(ctx);
    fs.mkdirSync(path.join(ctx.wt, 'node_modules'), { recursive: true });

    const result = linkWorktreeArtifacts(ctx.root, ctx.wt);
    const nodeModules = result.statuses.find((s) => s.path === 'node_modules');

    expect(nodeModules).toBeDefined();
    expect(nodeModules.state).toBe('skipped_existing_path');
    expect(fs.lstatSync(path.join(ctx.wt, 'node_modules')).isSymbolicLink()).toBe(false);
  });

  it('adds a shared git exclude before linking a target not ignored by tracked files', () => {
    const ctx = mkRepo({ ignored: false });
    cleanups.push(ctx);

    const result = linkWorktreeArtifacts(ctx.root, ctx.wt);
    const nodeModules = result.statuses.find((s) => s.path === 'node_modules');

    expect(nodeModules).toBeDefined();
    expect(nodeModules.state).toBe('linked');
    expect(fs.lstatSync(path.join(ctx.wt, 'node_modules')).isSymbolicLink()).toBe(true);
    const status = execFileSync('git', ['-C', ctx.wt, 'status', '--short', 'node_modules'], {
      encoding: 'utf8',
    });
    expect(status).toBe('');
    // info/exclude resolves through the common git dir, so the entry written
    // for the not-ignored case lands in the canonical repo's exclude file.
    const exclude = fs.readFileSync(path.join(ctx.root, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude).toMatch(/^node_modules$/m);
  });

  it('does not touch the shared exclude when the tracked ignore genuinely covers the symlink', () => {
    // A plain (no trailing slash) pattern matches files, directories AND
    // symlinks — only this spelling actually covers the live link, so
    // only here must the exclude stay untouched (spec A2).
    const ctx = mkRepo({ ignorePattern: 'node_modules' });
    cleanups.push(ctx);

    const result = linkWorktreeArtifacts(ctx.root, ctx.wt);
    const nodeModules = result.statuses.find((s) => s.path === 'node_modules');

    expect(nodeModules).toBeDefined();
    expect(nodeModules.state).toBe('linked');
    const excludePath = path.join(ctx.root, '.git', 'info', 'exclude');
    const exclude = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, 'utf8') : '';
    expect(exclude).not.toMatch(/node_modules/);
    expect(exclude).not.toMatch(/CAWS worktree artifact links/);
  });

  it('keeps a linked artifact invisible to git status when .gitignore only has a dir-only pattern', () => {
    // `node_modules/` in .gitignore matches a DIRECTORY at that path but
    // never the symlink CAWS creates. The pre-fix ignore probe accepted
    // the trailing-slash spelling, reported `linked`, and left the link
    // showing as `?? node_modules` — untracked dirt that blocked the
    // governed merge/destroy clean checks (spec A1, the Sterling repro).
    const ctx = mkRepo(); // default ignorePattern: 'node_modules/'
    cleanups.push(ctx);

    const result = linkWorktreeArtifacts(ctx.root, ctx.wt);
    const nodeModules = result.statuses.find((s) => s.path === 'node_modules');

    expect(nodeModules).toBeDefined();
    expect(nodeModules.state).toBe('linked');
    const status = execFileSync('git', ['-C', ctx.wt, 'status', '--porcelain'], {
      encoding: 'utf8',
    });
    expect(status).toBe('');
    // The dir-only pattern cannot cover the symlink, so the shared
    // exclude must now carry a plain entry for it.
    const exclude = fs.readFileSync(path.join(ctx.root, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude).toMatch(/^node_modules$/m);
  });

  it('links root Python venv variants such as .venv-smoke', () => {
    const ctx = mkRepo();
    cleanups.push(ctx);
    fs.mkdirSync(path.join(ctx.root, '.venv-smoke'), { recursive: true });

    const result = linkWorktreeArtifacts(ctx.root, ctx.wt);
    const venv = result.statuses.find((s) => s.path === '.venv-smoke');

    expect(venv).toBeDefined();
    expect(venv.state).toBe('linked');
    expect(fs.lstatSync(path.join(ctx.wt, '.venv-smoke')).isSymbolicLink()).toBe(true);
  });
});

describe('listVerifiedArtifactLinks / removeWorktreeArtifactLinks', () => {
  const cleanups = [];
  afterEach(() => {
    while (cleanups.length > 0) cleanup(cleanups.pop());
  });

  it('lists and removes only verified links; real directories and foreign symlinks are untouched', () => {
    const ctx = mkRepo();
    cleanups.push(ctx);
    // Make `.venv` and `target` discoverable candidates by materializing
    // them in the canonical checkout.
    fs.mkdirSync(path.join(ctx.root, '.venv'), { recursive: true });
    fs.mkdirSync(path.join(ctx.root, 'target'), { recursive: true });
    // Worktree obstacles: a REAL directory at one candidate path and a
    // symlink pointing somewhere other than the canonical counterpart at
    // another (spec A3).
    fs.mkdirSync(path.join(ctx.wt, '.venv'), { recursive: true });
    fs.symlinkSync(path.join(ctx.root, 'package.json'), path.join(ctx.wt, 'target'));
    // The genuine artifact link for node_modules.
    const linkResult = linkWorktreeArtifacts(ctx.root, ctx.wt);
    expect(
      linkResult.statuses.find((s) => s.path === 'node_modules').state
    ).toBe('linked');

    const links = listVerifiedArtifactLinks(ctx.root, ctx.wt);
    expect(links).toEqual(['node_modules']);

    const removed = removeWorktreeArtifactLinks(ctx.root, ctx.wt);
    expect(removed).toEqual(['node_modules']);
    expect(fs.existsSync(path.join(ctx.wt, 'node_modules'))).toBe(false);
    expect(fs.lstatSync(path.join(ctx.wt, '.venv')).isDirectory()).toBe(true);
    expect(fs.lstatSync(path.join(ctx.wt, 'target')).isSymbolicLink()).toBe(true);
  });
});
