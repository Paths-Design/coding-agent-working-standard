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

function setup({ linked = false, dirty = true } = {}) {
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
    actor: ACTOR,
    scopeIn: ['payload.txt'],
  });
  if (!spec.ok || spec.value.kind !== 'success')
    throw new Error(`spec failed: ${JSON.stringify(spec)}`);
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
  let checkout = repo;
  if (linked) {
    git(repo, ['switch', '--quiet', '-c', 'canonical-side']);
    checkout = path.join(caws, 'worktrees', 'Parent workspace');
    git(repo, ['worktree', 'add', '--quiet', checkout, 'main']);
  }
  if (dirty) fs.writeFileSync(path.join(checkout, 'payload.txt'), 'local uncommitted edit\n');
  return { repo, checkout: fs.realpathSync(checkout) };
}

afterAll(() => {
  for (const repo of repos) fs.rmSync(repo, { recursive: true, force: true });
});

test('A2: the CLI names the stale checkout, Git failure, and exact refresh command', () => {
  const { repo } = setup();
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
  expect(warning).toContain(`git -C '${fs.realpathSync(repo)}' read-tree -u -m `);
  expect(warning).toMatch(/read-tree -u -m [0-9a-f]{40} [0-9a-f]{40}/);
  expect(warning).toContain('Preserve or commit the local changes first');
});

test('A1: --apply from a linked Parent workspace materializes the merged base', () => {
  const { repo, checkout } = setup({ linked: true, dirty: false });
  const canonicalIndex = git(repo, ['show', ':payload.txt']);
  const out = [];
  const err = [];

  const code = runWorktreeMergeCommand({
    cwd: checkout,
    name: 'wt-shell-stale',
    apply: true,
    env: { ...process.env, CAWS_SESSION_ID: SESSION_ID },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });

  expect(code).toBe(0);
  expect(out.join('\n')).toContain('merged wt-shell-stale');
  expect(err.join('\n')).not.toContain('STALE');
  expect(git(checkout, ['rev-parse', 'HEAD'])).toBe(git(repo, ['rev-parse', 'main']));
  expect(git(checkout, ['show', ':payload.txt'])).toBe('lane');
  expect(fs.readFileSync(path.join(checkout, 'payload.txt'), 'utf8')).toBe('lane\n');
  expect(git(checkout, ['status', '--short', '--', 'payload.txt'])).toBe('');
  expect(git(repo, ['symbolic-ref', '--short', 'HEAD'])).toBe('canonical-side');
  expect(git(repo, ['show', ':payload.txt'])).toBe(canonicalIndex);
  expect(fs.readFileSync(path.join(repo, 'payload.txt'), 'utf8')).toBe('base\n');
});

test('A2: --apply names a stale linked checkout rather than misidentifying the canonical checkout', () => {
  const { repo, checkout } = setup({ linked: true });
  const err = [];
  const code = runWorktreeMergeCommand({
    cwd: checkout,
    name: 'wt-shell-stale',
    apply: true,
    env: { ...process.env, CAWS_SESSION_ID: SESSION_ID },
    out: () => {},
    err: (line) => err.push(line),
  });

  expect(code).toBe(0);
  expect(git(repo, ['show', 'main:payload.txt'])).toBe('lane');
  expect(fs.readFileSync(path.join(checkout, 'payload.txt'), 'utf8')).toBe(
    'local uncommitted edit\n'
  );
  const warning = err.join('\n');
  expect(warning).toContain(`base checkout is STALE: ${checkout}`);
  expect(warning).not.toContain('canonical checkout is STALE');
  expect(warning).toContain(`git -C '${checkout}' read-tree -u -m `);
  expect(warning).toMatch(/would be overwritten|not uptodate/i);
  expect(warning).toContain('Preserve or commit the local changes first');
});

test.each(['close', 'merge event'])(
  'A3: default output retains the stale linked path after %s failure',
  (phase) => {
    const { repo, checkout } = setup({ linked: true, dirty: true });
    const target = path.join(repo, '.caws', phase === 'close' ? 'specs' : 'events.jsonl');
    const priorMode = fs.statSync(target).mode & 0o777;
    const indexBefore = git(checkout, ['write-tree']);
    const out = [],
      errors = [];
    fs.chmodSync(target, phase === 'close' ? 0o555 : 0o444);
    let code;
    try {
      code = runWorktreeMergeCommand({
        cwd: checkout,
        name: 'wt-shell-stale',
        apply: true,
        noClose: phase !== 'close',
        env: { ...process.env, CAWS_SESSION_ID: SESSION_ID },
        out: (line) => out.push(line),
        err: (line) => errors.push(line),
      });
    } finally {
      fs.chmodSync(target, priorMode);
    }
    expect(code).toBe(1);
    expect(git(repo, ['show', 'main:payload.txt'])).toBe('lane');
    expect(git(checkout, ['write-tree'])).toBe(indexBefore);
    expect(fs.readFileSync(path.join(checkout, 'payload.txt'), 'utf8')).toBe(
      'local uncommitted edit\n'
    );
    const text = errors.join('\n');
    expect(text).toContain(checkout);
    expect(text).toContain('STALE');
    expect(text).toMatch(/would be overwritten|not uptodate/i);
    expect(text).toContain(`git -C '${checkout}' read-tree -u -m `);
  }
);
