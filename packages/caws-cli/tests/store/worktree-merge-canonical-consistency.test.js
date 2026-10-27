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
const repoRootStore = require('../../dist/store/repo-root');
const { validateEventBody } = require('../../dist/kernel/evidence/validate');

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
  fs.writeFileSync(path.join(repo, 'unrelated.txt'), 'unrelated base\n');
  git(repo, ['add', 'payload.txt', 'unrelated.txt']);
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

function merge(caws, name, options = {}) {
  return mergeWorktree(caws, {
    name,
    session: SESSION,
    sessionCandidates: CANDIDATES,
    actor: ACTOR,
    ...options,
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
  expect(result.value.data.canonical_checkout_sync_error).toMatch(
    /would be overwritten|not uptodate/i
  );
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

function linkedBase(repo) {
  git(repo, ['switch', '--quiet', '-c', 'canonical-side']);
  // This checkout is deliberately absent from the CAWS registry. A space,
  // quote, and newline pin NUL parsing and usable shell quoting together.
  const parent = path.join(repo, '.caws', 'worktrees', "Parent workspace's\nbase");
  git(repo, ['worktree', 'add', '--quiet', parent, 'main']);
  return fs.realpathSync(parent);
}

function successful(result) {
  expect(result.ok).toBe(true);
  expect(result.value.kind).toBe('success');
  return result.value.data;
}

function eventBody(event) {
  return {
    event: event.event,
    ts: event.ts,
    actor: event.actor,
    spec_id: event.spec_id,
    data: event.data,
  };
}

afterEach(() => jest.restoreAllMocks());

test('A1: an unregistered linked base checkout refreshes while the canonical branch stays untouched', () => {
  const repo = mkRepo('caws-linked-clean-');
  const { caws } = seedMerge(repo, 'wt-linked-clean', 'LINKED-CLEAN-001');
  const parent = linkedBase(repo);
  const canonicalIndex = git(repo, ['show', ':payload.txt']);

  const data = successful(merge(caws, 'wt-linked-clean'));

  expect(git(parent, ['rev-parse', 'HEAD'])).toBe(git(repo, ['rev-parse', 'main']));
  expect(git(parent, ['show', ':payload.txt'])).toBe('lane');
  expect(fs.readFileSync(path.join(parent, 'payload.txt'), 'utf8')).toBe('lane\n');
  expect(git(parent, ['status', '--short', '--', 'payload.txt'])).toBe('');
  expect(git(repo, ['symbolic-ref', '--short', 'HEAD'])).toBe('canonical-side');
  expect(git(repo, ['show', ':payload.txt'])).toBe(canonicalIndex);
  expect(fs.readFileSync(path.join(repo, 'payload.txt'), 'utf8')).toBe('base\n');
  expect(data.base_checkout_sync).toEqual([{ path: parent, state: 'in_sync' }]);
  expect(data.canonical_checkout_state).toBe('in_sync');
  const event = mergedEvent(caws);
  expect(event.data).not.toHaveProperty('base_checkout_sync');
  expect(validateEventBody(eventBody(event)).ok).toBe(true);
});

test('A2: overlapping linked checkout edits remain byte-identical with an auditable stale path', () => {
  const repo = mkRepo('caws-linked-overlap-');
  const { caws } = seedMerge(repo, 'wt-linked-overlap', 'LINKED-OVERLAP-001');
  const parent = linkedBase(repo);
  const indexBefore = git(parent, ['write-tree']);
  fs.writeFileSync(path.join(parent, 'payload.txt'), 'linked local edit\n');

  const data = successful(merge(caws, 'wt-linked-overlap'));

  expect(git(repo, ['show', 'main:payload.txt'])).toBe('lane');
  expect(git(parent, ['write-tree'])).toBe(indexBefore);
  expect(fs.readFileSync(path.join(parent, 'payload.txt'), 'utf8')).toBe('linked local edit\n');
  expect(data.base_checkout_sync).toHaveLength(1);
  expect(data.base_checkout_sync[0]).toEqual({
    path: parent,
    state: 'stale',
    sync_error: expect.stringMatching(/would be overwritten|not uptodate/i),
    repair_command: expect.stringContaining(`git -C '`),
  });
  // Exercise the returned command as a shell command, after preserving the
  // local bytes outside the checkout. This pins quoting, cwd, and old/new SHAs.
  const localBytes = fs.readFileSync(path.join(parent, 'payload.txt'));
  fs.writeFileSync(path.join(parent, 'payload.txt'), 'base\n');
  // Stage the restored baseline to refresh Git's index stat cache; its blob
  // must remain the same. A raw filesystem write alone is not a Git restore.
  git(parent, ['add', 'payload.txt']);
  expect(git(parent, ['write-tree'])).toBe(indexBefore);
  execFileSync('/bin/sh', ['-c', data.base_checkout_sync[0].repair_command], { cwd: repo });
  expect(localBytes.toString()).toBe('linked local edit\n');
  expect(fs.readFileSync(path.join(parent, 'payload.txt'), 'utf8')).toBe('lane\n');
  expect(git(parent, ['status', '--short', '--', 'payload.txt'])).toBe('');
  const event = mergedEvent(caws);
  expect(event.data).not.toHaveProperty('base_checkout_sync');
  expect(validateEventBody(eventBody(event)).ok).toBe(true);
});

test('A2: unrelated staged and unstaged linked edits survive a successful refresh', () => {
  const repo = mkRepo('caws-linked-unrelated-');
  const { caws } = seedMerge(repo, 'wt-linked-unrelated', 'LINKED-UNRELATED-001');
  const parent = linkedBase(repo);
  fs.writeFileSync(path.join(parent, 'unrelated.txt'), 'staged local edit\n');
  git(parent, ['add', 'unrelated.txt']);
  fs.writeFileSync(path.join(parent, 'unrelated.txt'), 'unstaged local edit\n');

  const data = successful(merge(caws, 'wt-linked-unrelated'));

  expect(data.base_checkout_sync).toEqual([{ path: parent, state: 'in_sync' }]);
  expect(git(parent, ['show', ':payload.txt'])).toBe('lane');
  expect(fs.readFileSync(path.join(parent, 'payload.txt'), 'utf8')).toBe('lane\n');
  expect(git(parent, ['show', ':unrelated.txt'])).toBe('staged local edit');
  expect(fs.readFileSync(path.join(parent, 'unrelated.txt'), 'utf8')).toBe('unstaged local edit\n');
  expect(git(parent, ['status', '--short', '--', 'unrelated.txt'])).toBe('MM unrelated.txt');
});

test.each([
  ['unavailable', { ok: false, reason: 'injected worktree metadata failure' }],
  ['malformed', { ok: true, stdout: 'worktree /missing-final-NUL' }],
])('A3: %s inventory refuses before publishing or recording a merge', (_name, failure) => {
  const repo = mkRepo('caws-linked-discovery-');
  const { caws, wt } = seedMerge(repo, 'wt-discovery', 'LINKED-DISCOVERY-001');
  const parent = linkedBase(repo);
  const before = git(repo, ['rev-parse', 'main']);
  const eventsBefore = fs.readFileSync(path.join(caws, 'events.jsonl'), 'utf8');
  const original = repoRootStore.runGit;
  const calls = [];
  jest.spyOn(repoRootStore, 'runGit').mockImplementation((args, cwd) => {
    calls.push([...args]);
    return args[0] === 'worktree' && args[1] === 'list' ? failure : original(args, cwd);
  });

  const result = merge(caws, 'wt-discovery');

  expect(result.ok).toBe(false);
  expect(result.errors[0].data.checkout_discovery_failed).toBe(true);
  expect(result.errors[0].message).toMatch(/metadata|worktree list/);
  expect(calls.some((args) => args[0] === 'update-ref')).toBe(false);
  expect(git(repo, ['rev-parse', 'main'])).toBe(before);
  expect(git(parent, ['show', ':payload.txt'])).toBe('base');
  expect(fs.readFileSync(path.join(parent, 'payload.txt'), 'utf8')).toBe('base\n');
  expect(fs.existsSync(wt)).toBe(true);
  expect(fs.readFileSync(path.join(caws, 'events.jsonl'), 'utf8')).toBe(eventsBefore);
});

test.each([
  [
    'HEAD observation',
    'symbolic-ref',
    { ok: false, reason: 'injected checkout HEAD observation failure' },
    /Cannot observe checkout HEAD/,
  ],
  [
    'branch change',
    'symbolic-ref',
    { ok: true, stdout: 'refs/heads/another-branch\n' },
    /Checkout HEAD changed/,
  ],
  [
    'commit observation',
    'rev-parse',
    { ok: false, reason: 'injected checkout commit observation failure' },
    /Cannot observe checkout commit/,
  ],
  [
    'advanced HEAD',
    'rev-parse',
    { ok: true, stdout: `${'b'.repeat(40)}\n` },
    /Checkout HEAD advanced/,
  ],
  [
    'refresh refusal',
    'read-tree',
    { ok: false, reason: 'injected checkout refresh failure' },
    /injected checkout refresh failure/,
  ],
])(
  'A3: post-publication %s failure records the landed merge and exact checkout',
  (_name, command, failure, expectedError) => {
    const repo = mkRepo('caws-linked-head-failure-');
    const { caws } = seedMerge(repo, 'wt-head-failure', 'LINKED-HEAD-FAILURE-001');
    const parent = linkedBase(repo);
    const baseBefore = git(repo, ['rev-parse', 'main']);
    const original = repoRootStore.runGit;
    let published = false;
    jest.spyOn(repoRootStore, 'runGit').mockImplementation((args, cwd) => {
      if (published && cwd === parent && args[0] === command) return failure;
      const result = original(args, cwd);
      if (args[0] === 'update-ref' && result.ok) published = true;
      return result;
    });

    const data = successful(merge(caws, 'wt-head-failure'));

    expect(git(repo, ['rev-parse', 'main'])).not.toBe(baseBefore);
    expect(git(repo, ['show', 'main:payload.txt'])).toBe('lane');
    expect(git(parent, ['show', ':payload.txt'])).toBe('base');
    expect(fs.readFileSync(path.join(parent, 'payload.txt'), 'utf8')).toBe('base\n');
    expect(data.base_checkout_sync[0]).toEqual({
      path: parent,
      state: 'stale',
      sync_error: expect.stringMatching(expectedError),
      repair_command: expect.stringContaining('read-tree -u -m'),
    });
    expect(mergedEvent(caws).data).not.toHaveProperty('base_checkout_sync');
  }
);

test('CAS contention retries discovery and preserves the eventual linked checkout refresh', () => {
  const repo = mkRepo('caws-linked-retry-');
  const { caws } = seedMerge(repo, 'wt-linked-retry', 'LINKED-RETRY-001');
  const parent = linkedBase(repo);
  const original = repoRootStore.runGit;
  let attempts = 0;
  let observations = 0;
  jest.spyOn(repoRootStore, 'runGit').mockImplementation((args, cwd) => {
    if (args[0] === 'worktree' && args[1] === 'list') observations++;
    if (args[0] === 'update-ref' && ++attempts === 1) {
      return { ok: false, reason: 'cannot lock ref: injected contention' };
    }
    return original(args, cwd);
  });

  const data = successful(merge(caws, 'wt-linked-retry'));

  expect(attempts).toBe(2);
  expect(observations).toBe(2);
  expect(data.base_checkout_sync).toEqual([{ path: parent, state: 'in_sync' }]);
  expect(git(parent, ['show', ':payload.txt'])).toBe('lane');
  expect(fs.readFileSync(path.join(parent, 'payload.txt'), 'utf8')).toBe('lane\n');
});

test('the persisted merge payload preserves the strict installed-reader contract', () => {
  const body = {
    event: 'worktree_merged',
    ts: '2026-10-26T12:00:00.000Z',
    actor: ACTOR,
    data: { worktree_name: 'wt-schema', merge_commit: 'a'.repeat(40), base_branch: 'main' },
  };
  const validate = (entry) =>
    validateEventBody({ ...body, data: { ...body.data, base_checkout_sync: [entry] } });
  expect(validateEventBody(body).ok).toBe(true);
  expect(validate({ path: '/actual checkout', state: 'in_sync' }).ok).toBe(false);
  expect(
    validate({
      path: '/actual checkout',
      state: 'stale',
      sync_error: 'refused',
      repair_command: 'git -C /actual read-tree -u -m old new',
    }).ok
  ).toBe(false);
  expect(validate({ state: 'in_sync' }).ok).toBe(false);
  expect(validate({ path: '/actual checkout', state: 'unknown' }).ok).toBe(false);
  expect(validate({ path: '/actual checkout', state: 'stale' }).ok).toBe(false);
  expect(
    validate({ path: '/actual checkout', state: 'in_sync', sync_error: 'hidden failure' }).ok
  ).toBe(false);
  expect(validate({ path: '/actual checkout', state: 'in_sync', extra: true }).ok).toBe(false);
});

test.each(['close', 'merge event'])(
  'A3: stale linked checkout observations survive a later %s failure',
  (phase) => {
    const repo = mkRepo('caws-linked-partial-');
    const { caws, wt } = seedMerge(repo, 'wt-linked-partial', 'LINKED-PARTIAL-001');
    const parent = linkedBase(repo);
    const indexBefore = git(parent, ['write-tree']);
    fs.writeFileSync(path.join(parent, 'payload.txt'), 'preserved linked edit\n');
    const target = path.join(caws, phase === 'close' ? 'specs' : 'events.jsonl');
    const priorMode = fs.statSync(target).mode & 0o777;
    fs.chmodSync(target, phase === 'close' ? 0o555 : 0o444);
    let result;
    try {
      result = merge(caws, 'wt-linked-partial', { noClose: phase !== 'close' });
    } finally {
      fs.chmodSync(target, priorMode);
    }
    expect(result.ok).toBe(false);
    expect(git(repo, ['show', 'main:payload.txt'])).toBe('lane');
    expect(git(parent, ['write-tree'])).toBe(indexBefore);
    expect(fs.readFileSync(path.join(parent, 'payload.txt'), 'utf8')).toBe(
      'preserved linked edit\n'
    );
    expect(fs.existsSync(wt)).toBe(true);
    expect(mergedEvent(caws)).toBeUndefined();
    const diagnostic = result.errors[0];
    expect(diagnostic.data.base_checkout_sync[0]).toEqual({
      path: parent,
      state: 'stale',
      sync_error: expect.stringMatching(/would be overwritten|not uptodate/i),
      repair_command: expect.stringContaining('read-tree -u -m'),
    });
    expect(diagnostic.narrowRepair).toContain(parent);
    expect(diagnostic.narrowRepair).toContain(diagnostic.data.base_checkout_sync[0].repair_command);
  }
);
