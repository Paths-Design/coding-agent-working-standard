'use strict';

/**
 * Canonical checkout consistency after object-database merges.
 * CAWS-DEFECT-MERGE-STALE-CANONICAL-INDEX-001 A1/A2/A3.
 *
 * These tests use real repositories because the contract depends on Git's
 * index/worktree safety checks. A mocked spawn cannot prove that merged files
 * are materialized or that local edits survive a failed refresh.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { initProject } = require('../../dist/store/init-store');
const { createSpec } = require('../../dist/store/specs-writer');
const { createWorktree, mergeWorktree } = require('../../dist/store/worktrees-writer');

const SESSION_ID = 'sess-canonical-consistency';
const SESSION = { session_id: SESSION_ID, platform: 'jest' };
const ACTOR = { kind: 'agent', id: 'canonical-consistency-agent', session_id: SESSION_ID };
const CANDIDATES = {
  candidates: [{ identity: SESSION, source: 'hook_env' }],
  trace: [],
};
const repos = [];

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

function mkRepo(prefix) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync('git', ['init', '--quiet', '-b', 'main', repo]);
  git(repo, ['config', 'user.email', 'test@caws.invalid']);
  git(repo, ['config', 'user.name', 'CAWS Test']);
  fs.writeFileSync(path.join(repo, 'payload.txt'), 'base\n');
  git(repo, ['add', 'payload.txt']);
  git(repo, ['commit', '--quiet', '-m', 'base']);
  repos.push(repo);
  return repo;
}

function seedMerge(repo, name, specId) {
  const initialized = initProject(repo);
  if (!initialized.ok) throw new Error(`init failed: ${JSON.stringify(initialized.errors)}`);
  const caws = path.join(repo, '.caws');
  const spec = createSpec(caws, {
    id: specId,
    title: 'canonical consistency fixture',
    mode: 'fix',
    riskTier: 3,
    actor: ACTOR,
    scopeIn: ['payload.txt'],
  });
  if (!spec.ok || spec.value.kind !== 'success') {
    throw new Error(`spec failed: ${JSON.stringify(spec)}`);
  }
  git(repo, ['add', '-A']);
  git(repo, ['commit', '--quiet', '--no-verify', '-m', 'seed caws']);

  const created = createWorktree(caws, {
    name,
    specId,
    session: SESSION,
    actor: ACTOR,
  });
  if (!created.ok || created.value.kind !== 'success') {
    throw new Error(`worktree failed: ${JSON.stringify(created)}`);
  }
  const wt = path.join(caws, 'worktrees', name);
  fs.writeFileSync(path.join(wt, 'payload.txt'), 'lane\n');
  git(wt, ['add', 'payload.txt']);
  git(wt, ['commit', '--quiet', '--no-verify', '-m', 'change payload']);
  return { caws, wt };
}

function merge(caws, name) {
  return mergeWorktree(caws, {
    name,
    session: SESSION,
    sessionCandidates: CANDIDATES,
    actor: ACTOR,
  });
}

function mergedEvent(caws) {
  const events = fs
    .readFileSync(path.join(caws, 'events.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  return events.findLast((event) => event.event === 'worktree_merged');
}

afterAll(() => {
  for (const repo of repos) {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('A1/A3: a clean canonical checkout is advanced without checkout or staged rollback', () => {
  const repo = mkRepo('caws-canonical-clean-');
  const { caws } = seedMerge(repo, 'wt-clean', 'CANONICAL-CLEAN-001');

  const result = merge(caws, 'wt-clean');

  expect(result.ok).toBe(true);
  expect(result.value.kind).toBe('success');
  expect(result.value.data.canonical_checkout_state).toBe('in_sync');
  expect(fs.readFileSync(path.join(repo, 'payload.txt'), 'utf8')).toBe('lane\n');
  expect(git(repo, ['diff', '--cached', '--name-only'])).not.toContain('payload.txt');
  expect(git(repo, ['status', '--short', '--', 'payload.txt'])).toBe('');
  expect(fs.existsSync(path.join(repo, '.git', 'MERGE_HEAD'))).toBe(false);

  const event = mergedEvent(caws);
  expect(event.data.canonical_checkout_state).toBe('in_sync');
  expect(event.data).not.toHaveProperty('canonical_checkout_sync_error');
});

test('A2: a conflicting canonical edit is preserved and the stale state is auditable', () => {
  const repo = mkRepo('caws-canonical-stale-');
  const { caws } = seedMerge(repo, 'wt-stale', 'CANONICAL-STALE-001');
  fs.writeFileSync(path.join(repo, 'payload.txt'), 'local uncommitted edit\n');

  const result = merge(caws, 'wt-stale');

  expect(result.ok).toBe(true);
  expect(result.value.kind).toBe('success');
  expect(result.value.data.canonical_checkout_state).toBe('stale');
  expect(result.value.data.canonical_checkout_sync_error).toMatch(/would be overwritten|not uptodate/i);
  expect(result.value.data.canonical_checkout_repair_command).toMatch(
    /^git read-tree -u -m [0-9a-f]{40} [0-9a-f]{40}$/
  );
  expect(fs.readFileSync(path.join(repo, 'payload.txt'), 'utf8')).toBe('local uncommitted edit\n');
  expect(git(repo, ['status', '--short', '--', 'payload.txt'])).not.toBe('');

  const event = mergedEvent(caws);
  expect(event.data.canonical_checkout_state).toBe('stale');
  expect(event.data.canonical_checkout_sync_error).toBe(
    result.value.data.canonical_checkout_sync_error
  );
  expect(event.data.canonical_checkout_repair_command).toBe(
    result.value.data.canonical_checkout_repair_command
  );
});
