/**
 * `caws worktree merge --dry-run` readiness must agree with the real merge.
 * CAWS-DEFECT-MERGE-DRYRUN-FALSE-READY-001.
 *
 * Drives the REAL compiled writers against REAL git repositories in temp
 * dirs; nothing about git is mocked, because the property is what
 * `git merge-tree` does with the two tips.
 *
 * A1 (conflict is not an unqualified ready) is also pinned at the CLI/ref
 * level by "merge preview distinguishes clean and conflicting branches..." in
 * tests/shell/release-runtime-contracts.test.js; the conflicting case here
 * also pins that the real merge refuses and leaves refs untouched.
 * A2 (a ready preview is followed by a real merge that lands the previewed
 * commit) had no test before this file.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { createSpec } = require('../../dist/store/specs-writer');
const { createWorktree, mergeWorktree } = require('../../dist/store/worktrees-writer');
const { initProject } = require('../../dist/store/init-store');

const SESSION_ID = 'sess-dryrun-conflict';
const SESSION = { session_id: SESSION_ID, platform: 'jest' };
const ACTOR = { kind: 'agent', id: 'dryrun-conflict-agent', session_id: SESSION_ID };
const CANDIDATES = { candidates: [{ identity: SESSION, source: 'hook_env' }], trace: [] };

const repos = [];

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function mkRepo(prefix) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  execFileSync('git', ['init', '--quiet', '-b', 'main', root]);
  git(root, ['config', 'user.email', 't@test.com']);
  git(root, ['config', 'user.name', 'Test']);
  git(root, ['commit', '--quiet', '--allow-empty', '-m', 'init']);
  repos.push(root);
  return root;
}

function commitAll(cwd, message) {
  git(cwd, ['add', '-A']);
  git(cwd, ['commit', '--quiet', '--no-verify', '-m', message]);
}

/** A governed repo with one lane forked from a base that holds conflict.txt. */
function fixture(prefix, specId) {
  const root = mkRepo(prefix);
  const init = initProject(root);
  if (!init.ok) throw new Error('initProject failed: ' + JSON.stringify(init.errors));
  const caws = path.join(root, '.caws');
  const spec = createSpec(caws, {
    id: specId,
    title: 'dry-run readiness fixture',
    mode: 'chore',
    actor: ACTOR,
    scopeIn: ['payload.txt', 'conflict.txt'],
  });
  if (!spec.ok || spec.value.kind !== 'success') {
    throw new Error('createSpec failed: ' + JSON.stringify(spec));
  }
  fs.writeFileSync(path.join(root, 'conflict.txt'), 'base\n');
  commitAll(root, 'seed spec and baseline');
  const created = createWorktree(caws, { name: 'lane', specId, session: SESSION, actor: ACTOR });
  if (!created.ok || created.value.kind !== 'success') {
    throw new Error('createWorktree failed: ' + JSON.stringify(created));
  }
  return { root, caws, lane: path.join(caws, 'worktrees', 'lane') };
}

function merge(caws, dryRun) {
  return mergeWorktree(caws, {
    name: 'lane',
    session: SESSION,
    sessionCandidates: CANDIDATES,
    actor: ACTOR,
    dryRun,
  });
}

afterAll(() => {
  for (const r of repos) {
    try {
      fs.rmSync(r, { recursive: true, force: true });
    } catch {
      /* best effort cleanup */
    }
  }
});

describe('merge --dry-run readiness agrees with the real merge', () => {
  test('a clean preview reports ready and the real merge then lands the previewed commit', () => {
    const { root, caws, lane } = fixture('dryrun-a2-', 'DRYRUN-A2-001');
    fs.writeFileSync(path.join(lane, 'payload.txt'), 'lane payload\n');
    commitAll(lane, 'feat: lane payload');
    const branchTip = git(lane, ['rev-parse', 'HEAD']);
    const baseBefore = git(root, ['rev-parse', 'main']);

    const preview = merge(caws, true);
    expect(preview.ok).toBe(true);
    expect(preview.value.kind).toBe('dry_run');
    expect(preview.value.canProceed).toBe(true);
    expect(preview.value.findings).toEqual([]);
    const check = preview.value.data.merge_check;
    expect(check.status).toBe('clean');
    expect(check.base_sha).toBe(baseBefore);
    expect(check.branch_sha).toBe(branchTip);
    expect(git(root, ['rev-parse', 'main'])).toBe(baseBefore);

    const real = merge(caws, false);
    expect(real.ok).toBe(true);
    expect(real.value.kind).toBe('success');

    const baseAfter = git(root, ['rev-parse', 'main']);
    expect(baseAfter).not.toBe(baseBefore);
    // The merge commit is the first-parent merge on base; lifecycle
    // auto-commits (spec close) may sit on top of it, so locate it by shape.
    const mergeSha = git(root, ['log', '--first-parent', '--merges', '-1', '--format=%H', 'main']);
    expect(git(root, ['rev-list', '--parents', '-n', '1', mergeSha]).split(' ')).toEqual([
      mergeSha,
      baseBefore,
      branchTip,
    ]);
    // The tree the preview computed is the tree that landed.
    expect(git(root, ['rev-parse', `${mergeSha}^{tree}`])).toBe(check.tree_sha);
    expect(git(root, ['show', `${mergeSha}:payload.txt`])).toBe('lane payload');
    expect(fs.readFileSync(path.join(root, 'payload.txt'), 'utf8')).toBe('lane payload\n');
    console.log(
      'A2 evidence',
      JSON.stringify({
        preview: { canProceed: preview.value.canProceed, merge_check: check },
        real_kind: real.value.kind,
        base_before: baseBefore,
        base_after: baseAfter,
        merge_commit: mergeSha,
        parents: git(root, ['rev-list', '--parents', '-n', '1', mergeSha]),
      })
    );
  });

  test('a conflicting preview reports not ready with a qualified finding, and the real merge refuses leaving base unchanged', () => {
    const { root, caws, lane } = fixture('dryrun-a1-', 'DRYRUN-A1-001');
    fs.writeFileSync(path.join(lane, 'conflict.txt'), 'lane side\n');
    commitAll(lane, 'feat: lane edits conflict.txt');
    fs.writeFileSync(path.join(root, 'conflict.txt'), 'main side\n');
    git(root, ['add', 'conflict.txt']);
    git(root, ['commit', '--quiet', '--no-verify', '-m', 'feat: main edits conflict.txt']);
    const baseBefore = git(root, ['rev-parse', 'main']);
    const branchBefore = git(lane, ['rev-parse', 'HEAD']);

    const preview = merge(caws, true);
    expect(preview.ok).toBe(true);
    expect(preview.value.kind).toBe('dry_run');
    expect(preview.value.canProceed).toBe(false);
    const check = preview.value.data.merge_check;
    expect(check.status).toBe('conflict_or_error');
    // The preview qualifies its verdict instead of reporting an unqualified
    // ready: the finding states the preflight failed on conflict or Git error.
    expect(preview.value.findings).toHaveLength(1);
    expect(preview.value.findings[0]).toContain('merge preflight failed (conflict or Git error)');

    const real = merge(caws, false);
    expect(real.ok).toBe(false);
    expect(real.errors[0].message).toContain('conflicting changes');

    expect(git(root, ['rev-parse', 'main'])).toBe(baseBefore);
    expect(git(lane, ['rev-parse', 'HEAD'])).toBe(branchBefore);
    expect(git(root, ['log', '--merges', '--format=%H', 'main'])).toBe('');
    expect(fs.readFileSync(path.join(root, 'conflict.txt'), 'utf8')).toBe('main side\n');
    console.log(
      'A1 evidence',
      JSON.stringify({
        preview: { canProceed: preview.value.canProceed, merge_check: check },
        real_error: real.errors[0].message,
        base_before: baseBefore,
        base_after: git(root, ['rev-parse', 'main']),
      })
    );
  });
});
