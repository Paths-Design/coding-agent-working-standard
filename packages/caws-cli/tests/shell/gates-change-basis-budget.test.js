'use strict';

/**
 * budget_limit measures the lane's committed change set, not the canonical
 * index. CAWS-GATES-CHANGE-BASIS-002 (A1; A3 for the budget_limit event).
 *
 * Real temp repo, real linked worktree, real `caws gates run` through the
 * built CLI. budget_limit is advisory: an overage is reported and never
 * blocks.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { resolveGitBinary } = require('../../dist/store/git-binary');
const {
  readGateChanges,
  listStagedChanges,
} = require('../../dist/shell/gates/local-evaluators/diff-helpers');
const { initProject } = require('../../dist/store/init-store');
const { createSpec } = require('../../dist/store/specs-writer');
const { createWorktree } = require('../../dist/store/worktrees-writer');
const { makeTempRepo, cleanupAll, git } = require('../helpers/git-repo-factory');

const CLI = path.resolve(__dirname, '../../dist/index.js');
const SPEC_ID = 'BUDGET-BASIS-001';
const session = { session_id: 'budget-basis-fixture', platform: 'jest' };
const actor = { kind: 'agent', id: 'budget-basis-fixture', session_id: session.session_id };
afterAll(cleanupAll);

// Default policy risk-tier 3 sizing goal: max_files 30, max_loc 1500.
const TIER_MAX_FILES = 30;
const TIER_MAX_LOC = 1500;

function fixture() {
  const root = fs.realpathSync(makeTempRepo());
  expect(initProject(root).ok).toBe(true);
  const caws = path.join(root, '.caws');
  expect(
    createSpec(caws, {
      id: SPEC_ID,
      title: 'Budget basis fixture',
      mode: 'fix',
      actor,
      scopeIn: ['src'],
    }).ok
  ).toBe(true);
  // createSpec authors tierless specs; budget_limit only has a sizing goal
  // for a tiered one, so declare tier 3 on the temp repo's own spec.
  const specPath = path.join(caws, 'specs', SPEC_ID + '.yaml');
  const yaml = fs.readFileSync(specPath, 'utf8');
  expect(yaml).toMatch(/^mode: fix$/m);
  fs.writeFileSync(specPath, yaml.replace(/^mode: fix$/m, 'risk_tier: 3\nmode: fix'));
  git(root, ['add', '-A']);
  git(root, ['commit', '-m', 'fixture baseline']);
  const created = createWorktree(caws, { name: 'lane', specId: SPEC_ID, session, actor });
  if (!created.ok) throw new Error('createWorktree failed: ' + JSON.stringify(created.errors));
  return { root, caws, lane: path.join(caws, 'worktrees/lane') };
}

/** Commit `count` files of `lines` lines each under src/, one commit per call. */
function commitFiles(lane, prefix, count, lines) {
  fs.mkdirSync(path.join(lane, 'src'), { recursive: true });
  const names = [];
  for (let i = 0; i < count; i++) {
    const rel = `src/${prefix}-${i}.txt`;
    fs.writeFileSync(
      path.join(lane, rel),
      Array.from({ length: lines }, (_, n) => `line ${n}\n`).join('')
    );
    names.push(rel);
  }
  git(lane, ['add', ...names]);
  git(lane, ['commit', '-m', `add ${prefix}`]);
}

function cli(cwd, args) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/^(GIT_|CAWS_|CODEX_|CLAUDE_|DSH_|KIMI_)/.test(key)
    )
  );
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...env,
      HOME: cwd,
      CAWS_HOME: path.join(cwd, '.machine'),
      CLAUDE_CODE_SESSION_ID: session.session_id,
    },
  });
}

function budgetEvent(caws) {
  return fs
    .readFileSync(path.join(caws, 'events.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map(JSON.parse)
    .filter((e) => e.event === 'gate_evaluated' && e.data.gate_id === 'budget_limit')
    .at(-1);
}

test('a worktree branch whose committed work exceeds the budget reports an advisory overage measured from its base, not a PASS from the canonical index', () => {
  const { root, caws, lane } = fixture();
  // Two commits: the measured delta is the branch's cumulative change, not
  // its last commit. 20 files x 50 lines + 15 files x 50 lines = 35 files, 1750 loc.
  commitFiles(lane, 'first', 20, 50);
  commitFiles(lane, 'second', 15, 50);
  expect(git(root, ['diff', '--cached', '--name-only'])).toBe('');
  const laneHead = git(lane, ['rev-parse', 'HEAD']);

  const result = cli(lane, ['gates', 'run', '--spec', SPEC_ID]);
  console.log('A1 evidence stdout:\n' + result.stdout + '\nstderr:\n' + result.stderr);

  // Advisory: reported, never blocking.
  expect(result.status).toBe(0);
  expect(result.stdout).toContain(
    `Staged change touches 35 file(s); the risk-tier 3 sizing goal is ${TIER_MAX_FILES}.`
  );
  expect(result.stdout).toContain('OVER     budget_limit (mode=warn, 2 violations) [advisory');
  expect(result.stdout).not.toMatch(/PASS\s+budget_limit/);

  const event = budgetEvent(caws);
  expect(result.stdout).toContain('Overall: OK');
  expect(event.data.mode).toBe('warn');
  expect(event.data.violations).toHaveLength(2);
  expect(event.data.violations.map((v) => v.rule).sort()).toEqual([
    'max_files_exceeded',
    'max_loc_exceeded',
  ]);
  expect(event.data.violations.map((v) => v.details).sort()).toEqual([
    expect.stringContaining(
      `Staged change adds 1750 line(s); the risk-tier 3 sizing goal is ${TIER_MAX_LOC}.`
    ),
    expect.stringContaining(
      `Staged change touches 35 file(s); the risk-tier 3 sizing goal is ${TIER_MAX_FILES}.`
    ),
  ]);
  // A3 for this gate: the event records what was measured and where.
  expect(event.data.metrics.change_basis).toMatchObject({
    kind: 'branch_and_staged',
    checkout: lane,
    base_ref: 'main',
    head_sha: laneHead,
    files_evaluated: 35,
  });
  console.log('A1 budget_limit event: ' + JSON.stringify(event.data));
});

test('a worktree branch within the budget reports no budget_limit overage', () => {
  const { caws, lane } = fixture();
  commitFiles(lane, 'small', 2, 10);

  const result = cli(lane, ['gates', 'run', '--spec', SPEC_ID]);
  console.log('control stdout:\n' + result.stdout + '\nstderr:\n' + result.stderr);

  expect(result.status).toBe(0);
  expect(result.stdout).not.toContain('sizing goal');
  const event = budgetEvent(caws);
  expect(event.data.result).toBe('pass');
  expect(event.data.violations).toEqual([]);
  expect(event.data.metrics.change_basis).toMatchObject({
    kind: 'branch_and_staged',
    checkout: lane,
    base_ref: 'main',
    files_evaluated: 2,
  });
});

test('an index larger than 1 MiB retains its full fingerprint and exact committed and staged source delta', () => {
  const root = fs.realpathSync(makeTempRepo());
  const captureGit = (args, options = {}) =>
    execFileSync(resolveGitBinary(), ['-C', root, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
      ...options,
    });
  const blob = captureGit(['hash-object', '-w', '--stdin'], {
    input: 'fixture\n',
    stdio: ['pipe', 'pipe', 'pipe'],
  })
    .toString()
    .trim();
  // Real index entries share a real blob; no thousands of working files are needed.
  const paths = Array.from(
    { length: 6000 },
    (_, i) => `src/index-fixture/${'wide-'.repeat(32)}/${String(i).padStart(5, '0')}.txt`
  );
  captureGit(['update-index', '--index-info'], {
    input: paths.map((file) => `100644 ${blob}\t${file}\n`).join(''),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src/changed.txt'), 'first\nsecond\n');
  fs.writeFileSync(path.join(root, 'src/removed.txt'), 'removed\n');
  git(root, ['add', 'src/changed.txt', 'src/removed.txt']);
  git(root, ['commit', '-q', '-m', 'large index baseline']);
  const base = git(root, ['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(root, 'src/changed.txt'), 'first\nbranch\n');
  fs.writeFileSync(path.join(root, 'src/branch-only.txt'), 'branch only\n');
  git(root, ['add', 'src/changed.txt', 'src/branch-only.txt']);
  git(root, ['commit', '-q', '-m', 'committed source delta']);
  fs.writeFileSync(path.join(root, 'src/changed.txt'), 'first\nbranch\nstaged\n');
  const stagedPath = 'src/staged\tline\n.txt';
  fs.writeFileSync(path.join(root, stagedPath), 'staged only\n');
  fs.writeFileSync(path.join(root, 'src/binary.bin'), Buffer.from([0, 1, 2]));
  git(root, ['add', 'src/changed.txt', stagedPath, 'src/binary.bin']);
  git(root, ['rm', 'src/removed.txt']);
  const index = captureGit(['ls-files', '--stage', '-z']);
  expect(index.length).toBeGreaterThan(1024 * 1024);
  const fingerprint = createHash('sha256').update(index).digest('hex');
  console.log('large-index evidence: ' + JSON.stringify({ bytes: index.length, fingerprint }));

  const delta = [
    { path: 'src/binary.bin', insertions: null, deletions: null },
    { path: 'src/branch-only.txt', insertions: 1, deletions: 0 },
    { path: 'src/changed.txt', insertions: 2, deletions: 1 },
    { path: 'src/removed.txt', insertions: 0, deletions: 1 },
    { path: stagedPath, insertions: 1, deletions: 0 },
  ];
  const result = readGateChanges(root, base);
  expect(result.changes).toEqual(delta);
  expect(result.basis).toEqual({
    kind: 'branch_and_staged',
    checkout: root,
    head_sha: git(root, ['rev-parse', 'HEAD']),
    base_ref: base,
    base_sha: base,
    merge_base_sha: base,
    index_sha256: fingerprint,
    files_evaluated: delta.length,
  });
  const stagedDelta = delta
    .filter((change) => change.path !== 'src/branch-only.txt')
    .map((change) =>
      change.path === 'src/changed.txt' ? { ...change, insertions: 1, deletions: 0 } : change
    );
  expect(listStagedChanges(root)).toEqual(stagedDelta);
  expect(readGateChanges(root).changes).toEqual(stagedDelta);
});
