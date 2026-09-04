'use strict';

/** Shell visibility for a completed merge whose canonical refresh failed. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { initProject } = require('../../dist/store/init-store');
const { createSpec } = require('../../dist/store/specs-writer');
const { createWorktree } = require('../../dist/store/worktrees-writer');
const { runWorktreeMergeCommand } = require('../../dist/shell/commands/worktree');

const SESSION_ID = 'sess-canonical-shell';
const SESSION = { session_id: SESSION_ID, platform: 'jest' };
const ACTOR = { kind: 'agent', id: 'canonical-shell-agent', session_id: SESSION_ID };
const repos = [];

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

function setup() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-canonical-shell-'));
  repos.push(repo);
  execFileSync('git', ['init', '--quiet', '-b', 'main', repo]);
  git(repo, ['config', 'user.email', 'test@caws.invalid']);
  git(repo, ['config', 'user.name', 'CAWS Test']);
  fs.writeFileSync(path.join(repo, 'payload.txt'), 'base\n');
  git(repo, ['add', 'payload.txt']);
  git(repo, ['commit', '--quiet', '-m', 'base']);

  const initialized = initProject(repo);
  if (!initialized.ok) throw new Error(`init failed: ${JSON.stringify(initialized.errors)}`);
  const caws = path.join(repo, '.caws');
  const spec = createSpec(caws, {
    id: 'CANONICAL-SHELL-001',
    title: 'canonical shell fixture',
    mode: 'fix',
    riskTier: 3,
    actor: ACTOR,
    scopeIn: ['payload.txt'],
  });
  if (!spec.ok || spec.value.kind !== 'success') throw new Error(`spec failed: ${JSON.stringify(spec)}`);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '--quiet', '--no-verify', '-m', 'seed caws']);

  const created = createWorktree(caws, {
    name: 'wt-shell-stale',
    specId: 'CANONICAL-SHELL-001',
    session: SESSION,
    actor: ACTOR,
  });
  if (!created.ok || created.value.kind !== 'success') {
    throw new Error(`worktree failed: ${JSON.stringify(created)}`);
  }
  const wt = path.join(caws, 'worktrees', 'wt-shell-stale');
  fs.writeFileSync(path.join(wt, 'payload.txt'), 'lane\n');
  git(wt, ['add', 'payload.txt']);
  git(wt, ['commit', '--quiet', '--no-verify', '-m', 'change payload']);
  fs.writeFileSync(path.join(repo, 'payload.txt'), 'local uncommitted edit\n');
  return repo;
}

afterAll(() => {
  for (const repo of repos) fs.rmSync(repo, { recursive: true, force: true });
});

test('A2: the CLI names the stale checkout, Git failure, and exact refresh command', () => {
  const repo = setup();
  const out = [];
  const err = [];

  const code = runWorktreeMergeCommand({
    cwd: repo,
    name: 'wt-shell-stale',
    env: { ...process.env, CAWS_SESSION_ID: SESSION_ID },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });

  expect(code).toBe(0);
  expect(out.join('\n')).toContain('merged wt-shell-stale');
  const warning = err.join('\n');
  expect(warning).toContain('canonical checkout is STALE');
  expect(warning).toContain('Git refused the safe refresh');
  expect(warning).toMatch(/git read-tree -u -m [0-9a-f]{40} [0-9a-f]{40}/);
  expect(warning).toContain('Preserve or commit the local changes first');
});
