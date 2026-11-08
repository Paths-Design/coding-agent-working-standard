'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const shared = path.resolve(__dirname, '../../templates/hook-packs/shared');
const cli = path.resolve(__dirname, '../../dist/index.js');
let root, repo, external, sibling;
function env() {
  const result = { ...process.env };
  for (const key of Object.keys(result))
    if (/^(?:HOOK_|_HOOK_|_CAWS_|CAWS_|CODEX_|CLAUDE_|GIT_)/.test(key)) delete result[key];
  return result;
}
function git(cwd, ...args) {
  return cp.execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args], {
    encoding: 'utf8',
    env: env(),
  });
}
function registry(owner = 'owner') {
  fs.writeFileSync(
    path.join(repo, '.caws/worktrees.json'),
    JSON.stringify({
      lane: {
        name: 'lane',
        specId: 'LANE',
        path: external,
        owner: { session_id: owner },
        baseBranch: 'main',
      },
    })
  );
}
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'caws-linked-guard-')));
  repo = path.join(root, 'repo');
  external = path.join(root, 'app-lane');
  sibling = path.join(root, 'foreign');
  fs.mkdirSync(repo);
  fs.mkdirSync(sibling);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'commit', '-qm', 'initial', '--allow-empty');
  git(repo, 'worktree', 'add', '-qb', 'lane', external);
  git(sibling, 'init', '-q');
  fs.mkdirSync(path.join(repo, '.caws/specs'), { recursive: true });
  registry();
  fs.writeFileSync(
    path.join(root, 'caws'),
    `#!/bin/sh\nexec '${process.execPath}' '${cli}' "$@"\n`,
    { mode: 0o755 }
  );
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
function membership(target) {
  const result = cp.spawnSync(
    '/bin/bash',
    [
      '-c',
      'source "$1/lib/caws-state.sh"; source "$1/lib/bash-mutation-targets.sh"; caws_foreign_repo_root "$2" "$3"',
      '_',
      shared,
      target,
      repo,
    ],
    { env: env(), encoding: 'utf8' }
  );
  expect(result.status).toBe(0);
  return result.stdout;
}
function oracle(target) {
  const result = cp.spawnSync(
    process.execPath,
    [path.join(shared, 'lib/worktree-claim-oracle.cjs')],
    {
      env: {
        ...env(),
        CAWS_ORACLE_PROJECT_DIR: repo,
        CAWS_ORACLE_REL_PATH: target,
        CAWS_ORACLE_SESSION_ID: 'owner',
        CAWS_ORACLE_CURRENT_BRANCH: 'main',
      },
      encoding: 'utf8',
    }
  );
  expect(result.status).toBe(0);
  return result.stdout.trim();
}
function guard(target) {
  const command = `touch '${target.replace(/'/g, "'\\''")}'`;
  return cp.spawnSync('/bin/bash', [path.join(shared, 'bash-write-guard.sh')], {
    encoding: 'utf8',
    env: {
      ...env(),
      CAWS_PROJECT_DIR: repo,
      CAWS_AGENT_SURFACE: 'claude-code',
      CAWS_BIN: path.join(root, 'caws'),
      HOOK_CWD: external,
      HOOK_SESSION_ID: 'owner',
      HOOK_TOOL_NAME: 'Bash',
      HOOK_COMMAND: command,
      HOOK_PERMISSION_MODE: 'bypassPermissions',
    },
    input: JSON.stringify({
      tool_name: 'Bash',
      cwd: external,
      session_id: 'owner',
      permission_mode: 'bypassPermissions',
      tool_input: { command },
    }),
  });
}
test('real external linked checkout reaches actual handler ownership admission', () => {
  const target = path.join(external, 'car.txt');
  expect(membership(target)).toBe('');
  expect(oracle(target)).toBe('pass:owner-self:lane');
  const result = guard(target);
  expect({ code: result.status, err: result.stderr }).toEqual({ code: 0, err: '' });
  expect(fs.existsSync(target)).toBe(false); // Adjudication never executes the command.
});
test('same repository still blocks a different owner in the actual handler', () => {
  registry('other');
  const target = path.join(external, 'car.txt');
  expect(membership(target)).toBe('');
  expect(oracle(target)).toBe('block_foreign_worktree:lane:other');
  const result = guard(target);
  expect(result.status).toBe(2);
  expect(result.stderr).toContain('DIFFERENT session');
});
test.each(['empty', 'absent'])(
  'unregistered checkout and its directory remain held with %s registry',
  (kind) => {
    const file = path.join(repo, '.caws/worktrees.json');
    if (kind === 'empty') fs.writeFileSync(file, '{}');
    else fs.unlinkSync(file);
    for (const target of [external, path.join(external, 'car.txt')]) {
      expect(membership(target)).toBe('');
      expect(oracle(target)).toBe('ask_uncertain:worktree-payload-no-entry:external');
    }
    expect(guard(path.join(external, 'car.txt')).status).toBe(2);
  }
);
test('unrelated repository stays foreign before ownership lookup', () => {
  const target = path.join(sibling, 'car.txt');
  expect(membership(target)).toBe(sibling);
  const result = guard(target);
  expect(result.status).toBe(2);
  expect(result.stderr).toContain('DIFFERENT repository');
});
test('nested unregistered linked checkout remains held inside the canonical directory', () => {
  const nested = path.join(repo, 'tmp/app-lane');
  fs.mkdirSync(path.dirname(nested), { recursive: true });
  git(repo, 'worktree', 'move', external, nested);
  external = nested;
  fs.writeFileSync(path.join(repo, '.caws/worktrees.json'), '{}');
  const target = path.join(external, 'car.txt');
  expect(membership(target)).toBe('');
  expect(oracle(target)).toBe('ask_uncertain:worktree-payload-no-entry:external');
  expect(guard(target).status).toBe(2);
});
test('nested independent repository is foreign despite its canonical path prefix', () => {
  const nested = path.join(repo, 'tmp/foreign');
  fs.mkdirSync(path.dirname(nested), { recursive: true });
  fs.renameSync(sibling, nested);
  const target = path.join(nested, 'car.txt');
  expect(membership(target)).toBe(nested);
  const result = guard(target);
  expect(result.status).toBe(2);
  expect(result.stderr).toContain('DIFFERENT repository');
});
test('broken linked metadata cannot establish same-repository membership', () => {
  fs.writeFileSync(path.join(external, '.git'), 'gitdir: /nonexistent/caws-test\n');
  expect(membership(path.join(external, 'car.txt'))).toBe(external);
});
test('physical aliases and line-feed-ending linked roots retain identity', () => {
  const unusual = external + '\n';
  git(repo, 'worktree', 'move', external, unusual);
  external = unusual;
  registry();
  const alias = path.join(root, 'alias');
  fs.symlinkSync(external, alias);
  expect(membership(path.join(external, 'car.txt'))).toBe('');
  expect(oracle(path.join(alias, 'car.txt'))).toBe('pass:owner-self:lane');
});
