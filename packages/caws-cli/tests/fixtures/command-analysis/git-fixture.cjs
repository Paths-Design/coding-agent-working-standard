// Real repository discovery is part of the oracle, not a synthetic mkdir pin.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const assert = require('node:assert/strict');
module.exports = function linkedRepository(canonical, worktrees) {
  fs.mkdirSync(canonical, { recursive: true });
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))
  );
  function git(args) {
    const child = spawnSync(
      'git',
      ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args],
      {
        cwd: canonical,
        env,
        shell: false,
        encoding: 'utf8',
        timeout: 15000,
      }
    );
    assert.equal(child.status, 0, child.error?.message || child.stderr);
    return child.stdout.trim();
  }
  git(['init', '--quiet', '--initial-branch=main']);
  git([
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@caws.invalid',
    'commit',
    '--quiet',
    '--allow-empty',
    '-m',
    'fixture',
  ]);
  for (const worktree of worktrees) {
    git(['worktree', 'add', '--quiet', '--detach', worktree, 'HEAD']);
    assert.equal(
      fs.realpathSync.native(git(['-C', worktree, 'rev-parse', '--show-toplevel'])),
      fs.realpathSync.native(worktree)
    );
  }
};
