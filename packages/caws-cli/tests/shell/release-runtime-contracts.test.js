'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { initProject } = require('../../dist/store/init-store');
const { createSpec } = require('../../dist/store/specs-writer');
const { createWorktree, mergeWorktree } = require('../../dist/store/worktrees-writer');
const {
  readGateChanges,
  listStagedChanges,
} = require('../../dist/shell/gates/local-evaluators/diff-helpers');
const { makeTempRepo, cleanupAll, git } = require('../helpers/git-repo-factory');
const CLI = path.resolve(__dirname, '../../dist/index.js');
const session = { session_id: 'release-runtime-fixture', platform: 'jest' };
const actor = { kind: 'agent', id: 'release-runtime-fixture', session_id: session.session_id };
const candidates = { candidates: [{ identity: session, source: 'hook_env' }], trace: [] };
afterAll(cleanupAll);

function retain(name, value) {
  if (!process.env.CAWS_RELEASE_ARTIFACT_DIR) return;
  fs.mkdirSync(process.env.CAWS_RELEASE_ARTIFACT_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(process.env.CAWS_RELEASE_ARTIFACT_DIR, name + '.json'),
    JSON.stringify(value, null, 2) + '\n'
  );
}
function fixture(scope = ['src']) {
  const root = fs.realpathSync(makeTempRepo());
  expect(initProject(root).ok).toBe(true);
  const caws = path.join(root, '.caws');
  expect(
    createSpec(caws, {
      id: 'RELEASE-001',
      title: 'Release fixture',
      mode: 'fix',
      actor,
      scopeIn: scope,
    }).ok
  ).toBe(true);
  fs.writeFileSync(path.join(root, 'conflict.txt'), 'base\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-m', 'fixture baseline']);
  expect(createWorktree(caws, { name: 'lane', specId: 'RELEASE-001', session, actor }).ok).toBe(
    true
  );
  return { root, caws, lane: path.join(caws, 'worktrees/lane') };
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
function commit(root, file, text) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
  git(root, ['add', file]);
  git(root, ['commit', '-m', 'fixture change']);
}

test('committed forbidden lane work is evaluated despite an empty canonical index; event carries its basis', () => {
  const { root, caws, lane } = fixture();
  commit(lane, 'forbidden.txt', 'outside declared src\n');
  expect(git(root, ['diff', '--cached', '--name-only'])).toBe('');
  const result = cli(lane, ['gates', 'run', '--spec', 'RELEASE-001']);
  expect(result.status).toBe(1);
  expect(result.stdout).toContain('forbidden.txt');
  const events = fs
    .readFileSync(path.join(caws, 'events.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map(JSON.parse);
  const scope = events
    .filter((e) => e.event === 'gate_evaluated' && e.data.gate_id === 'scope_boundary')
    .at(-1);
  expect(scope.data.result).toBe('fail');
  expect(scope.data.metrics.change_basis).toMatchObject({
    kind: 'branch_and_staged',
    checkout: lane,
    base_ref: 'main',
    head_sha: git(lane, ['rev-parse', 'HEAD']),
    files_evaluated: 1,
  });
  const narrowed = cli(lane, ['gates', 'run', '--spec', 'RELEASE-001', '--base', 'HEAD']);
  expect(narrowed.status).toBe(2);
  expect(narrowed.stderr).toContain('cannot narrow');
  fs.writeFileSync(path.join(lane, 'staged-forbidden.txt'), 'staged outside scope\n');
  git(lane, ['add', 'staged-forbidden.txt']);
  const stagedResult = cli(lane, ['gates', 'run', '--spec', 'RELEASE-001']);
  expect(stagedResult.status).toBe(1);
  const stagedScope = fs
    .readFileSync(path.join(caws, 'events.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map(JSON.parse)
    .filter((e) => e.event === 'gate_evaluated' && e.data.gate_id === 'scope_boundary')
    .at(-1);
  expect(stagedScope.data.violations.map((v) => v.subject).sort()).toEqual([
    'forbidden.txt',
    'staged-forbidden.txt',
  ]);
  retain('scope-staged', {
    exit_status: stagedResult.status,
    stdout: stagedResult.stdout,
    stderr: stagedResult.stderr,
    scope_event: stagedScope,
  });
  retain('scope-lane', {
    command: [CLI, 'gates', 'run', '--spec', 'RELEASE-001'],
    exit_status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    scope_event: scope,
    narrowed: { exit_status: narrowed.status, stderr: narrowed.stderr },
  });
});

test('empty canonical index and invalid base are unavailable, not pass; no evaluation event is fabricated', () => {
  const { root, caws } = fixture();
  const before = fs.readFileSync(path.join(caws, 'events.jsonl'), 'utf8');
  for (const extra of [[], ['--base', 'does-not-exist']]) {
    const result = cli(root, ['gates', 'run', '--spec', 'RELEASE-001', ...extra]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('change basis unavailable');
    expect(result.stdout).not.toContain('Overall: OK');
    expect(fs.readFileSync(path.join(caws, 'events.jsonl'), 'utf8')).toBe(before);
    retain(extra.length ? 'scope-invalid-base' : 'scope-empty-index', {
      exit_status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      events_unchanged: true,
    });
  }
});

test('explicit committed basis and staged renames retain both paths; Git failure throws', () => {
  const root = fs.realpathSync(makeTempRepo());
  commit(root, 'forbidden.txt', 'content\n');
  const base = git(root, ['rev-parse', 'HEAD']);
  fs.mkdirSync(path.join(root, 'src'));
  git(root, ['mv', 'forbidden.txt', 'src/allowed.txt']);
  const staged = readGateChanges(root, base);
  expect(staged.changes.map((c) => c.path)).toEqual(['forbidden.txt', 'src/allowed.txt']);
  git(root, ['commit', '-m', 'rename']);
  expect(readGateChanges(root, base).changes.map((c) => c.path)).toEqual([
    'forbidden.txt',
    'src/allowed.txt',
  ]);
  expect(() => listStagedChanges(path.join(root, 'missing'))).toThrow();
  retain('scope-rename', staged);
});

test('index receipt distinguishes different staged bytes with identical line counts', () => {
  const root = fs.realpathSync(makeTempRepo());
  commit(root, 'sample.txt', 'base\n');
  fs.writeFileSync(path.join(root, 'sample.txt'), 'first\n');
  git(root, ['add', 'sample.txt']);
  const first = readGateChanges(root);
  fs.writeFileSync(path.join(root, 'sample.txt'), 'other\n');
  git(root, ['add', 'sample.txt']);
  const second = readGateChanges(root);
  expect(first.changes).toEqual(second.changes);
  expect(first.basis.index_sha256).not.toBe(second.basis.index_sha256);
  retain('scope-index-identity', { first, second });
});

test('merge preview distinguishes clean and conflicting branches without changing refs, indexes, files or events', () => {
  for (const conflicting of [false, true]) {
    const { root, caws, lane } = fixture(['conflict.txt', 'clean.txt']);
    commit(lane, conflicting ? 'conflict.txt' : 'clean.txt', 'lane\n');
    commit(root, 'conflict.txt', 'main\n');
    const snapshot = () => ({
      refs: git(root, ['show-ref']),
      root_status: git(root, ['status', '--porcelain']),
      lane_status: git(lane, ['status', '--porcelain']),
      root_index: fs.readFileSync(path.join(root, '.git/index')).toString('base64'),
      lane_index: fs
        .readFileSync(git(lane, ['rev-parse', '--path-format=absolute', '--git-path', 'index']))
        .toString('base64'),
      root_file: fs.readFileSync(path.join(root, 'conflict.txt'), 'utf8'),
      lane_file: fs.readFileSync(path.join(lane, 'conflict.txt'), 'utf8'),
      events: fs.readFileSync(path.join(caws, 'events.jsonl'), 'utf8'),
    });
    const before = snapshot();
    const result = mergeWorktree(caws, {
      name: 'lane',
      session,
      sessionCandidates: candidates,
      actor,
      dryRun: true,
    });
    expect(result.ok).toBe(true);
    expect(result.value.kind).toBe('dry_run');
    expect(result.value.canProceed).toBe(!conflicting);
    expect(result.value.data.merge_check.status).toBe(conflicting ? 'conflict' : 'clean');
    const command = ['worktree', 'merge', 'lane', '--dry-run', '--data'];
    const preview = cli(lane, command);
    const after = snapshot();
    retain(conflicting ? 'merge-cli-conflict' : 'merge-cli-clean', {
      command: [process.execPath, CLI, ...command],
      exit_status: preview.status,
      stdout: preview.stdout,
      stderr: preview.stderr,
      before,
      after,
    });
    expect(preview.status).toBe(conflicting ? 1 : 0);
    expect(preview.stdout + preview.stderr).toContain(
      conflicting ? 'NOT ready to merge' : ': ready to merge.'
    );
    expect(preview.stdout + preview.stderr).toContain('"merge_check"');
    if (conflicting) {
      const output = preview.stdout + preview.stderr;
      expect(output).toContain('"conflicting_paths": [\n');
      expect(output).toContain('merge preflight found conflicts in 1 path(s): conflict.txt');
    }
    expect(after).toEqual(before);
    retain(conflicting ? 'merge-conflict' : 'merge-clean', { result, before, after });
  }
});
