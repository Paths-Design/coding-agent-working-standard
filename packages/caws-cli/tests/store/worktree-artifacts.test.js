'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { linkWorktreeArtifacts } = require('../../dist/store/worktree-artifacts');

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function mkRepo({ ignored = true, withNodeModules = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-artifacts-'));
  execFileSync('git', ['init', '--quiet', '-b', 'main', root]);
  git(root, ['config', 'user.email', 'test@test.com']);
  git(root, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(root, 'package.json'), '{"scripts":{"test":"node -e 1"}}\n');
  fs.writeFileSync(path.join(root, 'package-lock.json'), '{"lockfileVersion":3}\n');
  if (ignored) fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n');
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

  it('does not touch the shared exclude when the path is already gitignored', () => {
    const ctx = mkRepo(); // .gitignore tracks node_modules/
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
