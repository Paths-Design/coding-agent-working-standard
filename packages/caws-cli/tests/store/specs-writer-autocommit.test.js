/**
 * Integration tests for CAWS-SPECS-WRITER-AUTOCOMMIT-001:
 * specs-writer mutations (createSpec, closeSpec, archiveSpec) must
 * auto-commit the spec yaml as the final step of each lifecycle
 * transaction, parity with worktrees-writer.
 *
 * These tests prove the AUTOCOMMIT contract:
 *   - A1: createSpec on a clean tree commits the new yaml.
 *   - A2: closeSpec on a clean tree commits the in-place patch.
 *   - A3: archiveSpec on a clean tree commits both the new archived
 *         path AND the unlink of the original — in ONE commit.
 *   - A4: dirty baseline → outcome.data.audit_commit.kind ===
 *         'refused_dirty'; the lifecycle change still applies to the
 *         working tree (writer's transaction succeeded); the prior
 *         dirty content is preserved.
 *   - A5: regression — close then destroyWorktree both succeed and
 *         both commit cleanly. This is the precise failure mode the
 *         slice was authored to fix (observed 2026-05-27 during the
 *         CAWS-WORKTREE-DESTROY-SESSION-RESOLUTION-001 close).
 *
 * Tests use real temp git repos and exercise the writer through its
 * public surface. Mirrors the fixture vocabulary of
 * worktrees-writer-autocommit.test.js so the parity is visible at
 * the test layer too.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { createSpec, closeSpec, archiveSpec } = require(
  '../../dist/store/specs-writer'
);
const { createWorktree, destroyWorktree } = require(
  '../../dist/store/worktrees-writer'
);
const { initProject } = require('../../dist/store');

// ─── Fixture helpers ────────────────────────────────────────────────────

function mkCawsGitRepo(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync('git', ['init', '--quiet', '-b', 'main', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@test.com']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test User']);
  execFileSync('git', ['-C', root, 'commit', '--quiet', '--allow-empty', '-m', 'init']);
  const result = initProject(root);
  if (!result.ok) throw new Error('initProject failed in fixture');
  execFileSync('git', ['-C', root, 'add', '.caws/']);
  execFileSync('git', ['-C', root, 'commit', '--quiet', '-m', 'chore: bootstrap caws']);
  return { root, cawsDir: path.join(root, '.caws') };
}

function rmrf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

function gitStatus(root) {
  return execFileSync('git', ['-C', root, 'status', '--porcelain', '-uno'], {
    encoding: 'utf8',
  }).trim();
}

function gitLastSubject(root) {
  return execFileSync('git', ['-C', root, 'log', '-1', '--pretty=%s'], {
    encoding: 'utf8',
  }).trim();
}

function gitLogSubjects(root, count) {
  return execFileSync(
    'git',
    ['-C', root, 'log', `-${count}`, '--pretty=%s'],
    { encoding: 'utf8' }
  ).trim().split('\n');
}

function gitHeadSha(root) {
  return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
}

function gitNameStatusInCommit(root, sha) {
  return execFileSync(
    'git',
    ['-C', root, 'show', '--name-status', '--pretty=format:', sha],
    { encoding: 'utf8' }
  ).trim().split('\n').filter(Boolean);
}

const ACTOR = {
  id: 'test-actor',
  kind: 'human',
};

const NOW = () => new Date('2026-05-27T20:00:00.000Z');

// ─── A1: createSpec autocommit ──────────────────────────────────────────

describe('A1: createSpec auto-commits a new spec yaml', () => {
  let fixture;
  afterEach(() => fixture && rmrf(fixture.root));

  it('commits the new yaml and leaves working tree clean', () => {
    fixture = mkCawsGitRepo('a1-create-');
    const headBefore = gitHeadSha(fixture.root);

    const result = createSpec(fixture.cawsDir, {
      id: 'FEAT-001',
      title: 'autocommit fixture',
      mode: 'chore',
      riskTier: 3,
      now: NOW,
      actor: ACTOR,
    });

    expect(result.ok).toBe(true);
    expect(result.value.kind).toBe('success');
    expect(result.value.id).toBe('FEAT-001');

    // The audit-commit outcome rides on data.audit_commit.
    const audit = result.value.data.audit_commit;
    expect(audit.kind).toBe('committed');
    expect(audit.sha).toMatch(/^[a-f0-9]+$/);

    // Working tree is clean (the new yaml is committed, not dirty).
    expect(gitStatus(fixture.root)).toBe('');

    // HEAD advanced by one commit.
    expect(gitHeadSha(fixture.root)).not.toBe(headBefore);
    expect(gitLastSubject(fixture.root)).toBe('chore(caws): create FEAT-001');
  });
});

// ─── A2: closeSpec autocommit ───────────────────────────────────────────

describe('A2: closeSpec auto-commits the in-place patch', () => {
  let fixture;
  afterEach(() => fixture && rmrf(fixture.root));

  it('commits the lifecycle_state flip + resolution + updated_at bump', () => {
    fixture = mkCawsGitRepo('a2-close-');

    // Seed: create the spec via the writer (this autocommits too).
    const c = createSpec(fixture.cawsDir, {
      id: 'FEAT-002',
      title: 'a2 fixture',
      mode: 'chore',
      riskTier: 3,
      now: NOW,
      actor: ACTOR,
    });
    expect(c.ok).toBe(true);
    expect(gitStatus(fixture.root)).toBe('');
    const headBeforeClose = gitHeadSha(fixture.root);

    const result = closeSpec(fixture.cawsDir, {
      id: 'FEAT-002',
      resolution: 'completed',
      now: NOW,
      actor: ACTOR,
    });

    expect(result.ok).toBe(true);
    expect(result.value.kind).toBe('success');
    const audit = result.value.data.audit_commit;
    expect(audit.kind).toBe('committed');
    expect(audit.sha).toMatch(/^[a-f0-9]+$/);

    // Tree is clean post-close.
    expect(gitStatus(fixture.root)).toBe('');
    // New commit on top.
    expect(gitHeadSha(fixture.root)).not.toBe(headBeforeClose);
    expect(gitLastSubject(fixture.root)).toBe('chore(caws): close FEAT-002');
  });
});

// ─── A3: archiveSpec autocommit (two-path single commit) ────────────────

describe('A3: archiveSpec auto-commits the move as ONE atomic commit', () => {
  let fixture;
  afterEach(() => fixture && rmrf(fixture.root));

  it('stages both the new archived path AND the unlink of the original', () => {
    fixture = mkCawsGitRepo('a3-archive-');

    // Seed: create + close so the spec is in lifecycle_state: closed.
    createSpec(fixture.cawsDir, {
      id: 'FEAT-003', title: 'a3 fixture', mode: 'chore', riskTier: 3,
      now: NOW, actor: ACTOR,
    });
    closeSpec(fixture.cawsDir, {
      id: 'FEAT-003', resolution: 'completed', now: NOW, actor: ACTOR,
    });
    expect(gitStatus(fixture.root)).toBe('');
    const headBeforeArchive = gitHeadSha(fixture.root);

    const result = archiveSpec(fixture.cawsDir, {
      id: 'FEAT-003',
      now: NOW,
      actor: ACTOR,
    });

    expect(result.ok).toBe(true);
    expect(result.value.kind).toBe('success');
    const audit = result.value.data.audit_commit;
    expect(audit.kind).toBe('committed');

    // Tree is clean; the new archived path is committed AND the
    // unlink of the original path is also committed.
    expect(gitStatus(fixture.root)).toBe('');
    expect(gitHeadSha(fixture.root)).not.toBe(headBeforeArchive);
    expect(gitLastSubject(fixture.root)).toBe('chore(caws): archive FEAT-003');

    // Critically: ONE commit covers the entire move. Git detects the
    // unlink + new write as a rename (R<similarity>), so the commit
    // shows ONE entry that names both the from-path and the to-path.
    // This is HEALTHIER than two separate add+delete entries because
    // it preserves file history through the move.
    const status = gitNameStatusInCommit(fixture.root, 'HEAD');
    expect(status).toHaveLength(1);
    expect(status[0]).toMatch(/^R\d+\t.caws\/specs\/FEAT-003\.yaml\t.caws\/specs\/\.archive\/FEAT-003\.yaml$/);
  });
});

// ─── A4: dirty baseline → refused_dirty ─────────────────────────────────

describe('A4: dirty spec yaml → autocommit refused, lifecycle change still applies', () => {
  let fixture;
  afterEach(() => fixture && rmrf(fixture.root));

  it('closeSpec applies the patch but data.audit_commit.kind === refused_dirty', () => {
    fixture = mkCawsGitRepo('a4-dirty-');

    createSpec(fixture.cawsDir, {
      id: 'FEAT-004', title: 'a4 fixture', mode: 'chore', riskTier: 3,
      now: NOW, actor: ACTOR,
    });
    expect(gitStatus(fixture.root)).toBe('');

    // Simulate a user hand-editing the spec yaml before running close.
    const specPath = path.join(fixture.cawsDir, 'specs', 'FEAT-004.yaml');
    const original = fs.readFileSync(specPath, 'utf8');
    fs.writeFileSync(specPath, original + '# manually-added comment\n');
    expect(gitStatus(fixture.root)).not.toBe('');

    const result = closeSpec(fixture.cawsDir, {
      id: 'FEAT-004', resolution: 'completed', now: NOW, actor: ACTOR,
    });

    // The lifecycle transaction itself succeeded — the patch landed
    // in the working tree.
    expect(result.ok).toBe(true);
    expect(result.value.kind).toBe('success');

    // But the autocommit refused because the file was dirty before
    // the writer touched it (this preserves user work; never silently
    // commits over unstaged edits).
    const audit = result.value.data.audit_commit;
    expect(audit.kind).toBe('refused_dirty');
    expect(audit.reason).toBeDefined();

    // The patch was still applied — the working tree should have the
    // closed-state yaml + the user's added comment, both unstaged.
    const onDisk = fs.readFileSync(specPath, 'utf8');
    expect(onDisk).toContain('lifecycle_state: closed');
    expect(onDisk).toContain('# manually-added comment');
  });
});

// ─── A5: regression — close then destroyWorktree both autocommit ────────

describe('A5: REGRESSION — closeSpec + destroyWorktree chain commits both writes', () => {
  let fixture;
  afterEach(() => fixture && rmrf(fixture.root));

  it('after close + destroy, tree is clean and both writes are committed', () => {
    fixture = mkCawsGitRepo('a5-regression-');

    // Seed: create a spec + a bound worktree.
    createSpec(fixture.cawsDir, {
      id: 'FEAT-005', title: 'a5 fixture', mode: 'chore', riskTier: 3,
      now: NOW, actor: ACTOR,
    });
    const wtCreate = createWorktree(fixture.cawsDir, {
      name: 'wt-a5', specId: 'FEAT-005',
      session: { session_id: 'sess-a5', platform: 'test' },
      actor: ACTOR,
      now: NOW,
    });
    expect(wtCreate.ok).toBe(true);
    expect(gitStatus(fixture.root)).toBe('');

    // Step 1: close the spec.
    const close = closeSpec(fixture.cawsDir, {
      id: 'FEAT-005', resolution: 'completed', now: NOW, actor: ACTOR,
    });
    expect(close.ok).toBe(true);
    expect(close.value.kind).toBe('success');
    // CRITICAL ASSERTION: close auto-commits, so tree is clean before
    // the next caws call. PRE-FIX: this would have left the spec yaml
    // dirty and broken the destroy autocommit below.
    expect(gitStatus(fixture.root)).toBe('');
    expect(close.value.data.audit_commit.kind).toBe('committed');

    // Step 2: destroyWorktree. The bound spec needs to be reset to
    // active for destroy to NOT trip the "spec already closed" path,
    // but actually destroyWorktree doesn't check spec lifecycle — it
    // just removes the worktree entry. So this should just work.
    //
    // The autocommit on destroyWorktree captures pre-write state on
    // worktrees.json AND the bound spec yaml. PRE-FIX: the spec yaml
    // was dirty (from step 1's close) → destroy's autocommit returned
    // refused_dirty → worktrees.json was uncommitted. POST-FIX: spec
    // yaml is clean (step 1 committed it) → destroy autocommit
    // succeeds.
    //
    // We need a non-closed bound spec for destroy to find the spec
    // yaml in active location. Actually destroyWorktree just clears
    // the worktree:<name> field from the bound spec; it works on
    // closed specs too. Let me verify by running it.
    const destroy = destroyWorktree(fixture.cawsDir, {
      name: 'wt-a5',
      session: { session_id: 'sess-a5', platform: 'test' },
      sessionCandidates: {
        candidates: [
          {
            identity: { session_id: 'sess-a5', platform: 'test' },
            source: 'capsule',
          },
        ],
        trace: [
          { source: 'claude_env', outcome: 'absent', reason: 'test fixture' },
          { source: 'hook_env', outcome: 'absent', reason: 'test fixture' },
          { source: 'capsule', outcome: 'admitted', count: 1 },
          { source: 'cursor_env', outcome: 'absent', reason: 'test fixture' },
        ],
      },
      actor: ACTOR,
      now: NOW,
    });

    expect(destroy.ok).toBe(true);
    expect(destroy.value.kind).toBe('success');
    // The exact post-fix invariant:
    expect(destroy.value.data.audit_commit.kind).toBe('committed');

    // Tree is clean. No dirty worktrees.json sitting around for the
    // next agent to stumble on.
    expect(gitStatus(fixture.root)).toBe('');

    // Verify the commit chain: bootstrap + create-spec + create-wt +
    // close-spec + destroy-wt = 5 commits beyond init+bootstrap.
    const subjects = gitLogSubjects(fixture.root, 6);
    expect(subjects[0]).toBe('chore(caws): destroy wt-a5');
    expect(subjects[1]).toBe('chore(caws): close FEAT-005');
  });
});
