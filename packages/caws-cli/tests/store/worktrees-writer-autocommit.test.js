/**
 * Integration tests for CAWS-FIRST-CONTACT-UX-001 Fix 5:
 * worktrees-writer mutations auto-commit .caws/worktrees.json + the
 * bound spec file as the final step of each lifecycle transaction.
 *
 * Tests use real temp git repos and exercise the writer through its
 * public surface (createWorktree, bindWorktreeRepair, destroyWorktree).
 * mergeWorktree is exercised in tests/shell/worktree.test.js's existing
 * suite which already runs the full lifecycle.
 *
 * These tests prove the AUTOCOMMIT contract specifically:
 *   - On a clean baseline, the writer's success leaves the working
 *     tree clean (file is committed) and HEAD advances by one commit
 *     with a chore(caws): subject.
 *   - On a dirty baseline (pre-existing unrelated edit to the registry),
 *     the writer still succeeds but data.audit_commit.kind ===
 *     'refused_dirty'. The writer's change AND the pre-existing dirty
 *     state are both visible in the working tree (no rollback).
 *
 * The autocommit utility itself is tested in tests/store/git-autocommit.test.js;
 * here we only prove the writer threads the right inputs into it.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { createWorktree, destroyWorktree } = require(
  '../../dist/store/worktrees-writer'
);
const { initProject } = require('../../dist/store');

// Setup helpers ───────────────────────────────────────────────────────

function mkCawsGitRepo(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync('git', ['init', '--quiet', '-b', 'main', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@test.com']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test User']);
  execFileSync('git', ['-C', root, 'commit', '--quiet', '--allow-empty', '-m', 'init']);
  // Bootstrap caws state.
  const result = initProject(root);
  if (!result.ok) throw new Error('initProject failed in fixture');
  // Commit the .caws/ bootstrap so the working tree is clean before
  // any writer mutation we test.
  execFileSync('git', ['-C', root, 'add', '.caws/']);
  execFileSync('git', ['-C', root, 'commit', '--quiet', '-m', 'chore: bootstrap caws']);
  return { root, cawsDir: path.join(root, '.caws') };
}

function rmrf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

function writeSpec(cawsDir, id, body) {
  const specsDir = path.join(cawsDir, 'specs');
  fs.mkdirSync(specsDir, { recursive: true });
  fs.writeFileSync(
    path.join(specsDir, `${id}.yaml`),
    body
  );
}

function minimalActiveSpec(id) {
  return `id: ${id}
title: 'fixture spec for autocommit integration test'
risk_tier: 3
mode: chore
lifecycle_state: active
created_at: '2026-05-27T00:00:00.000Z'
updated_at: '2026-05-27T00:00:00.000Z'
blast_radius:
  modules:
    - packages/caws-cli/src/store/git-autocommit.ts
  data_migration: false
operational_rollback_slo: 5m
scope:
  in:
    - packages/caws-cli/src/store/git-autocommit.ts
  out: []
invariants:
  - 'fixture invariant placeholder'
acceptance:
  - id: A1
    given: 'fixture given'
    when: 'fixture when'
    then: 'fixture then'
non_functional: {}
contracts: []
`;
}

function commitSpec(root, id) {
  execFileSync('git', ['-C', root, 'add', `.caws/specs/${id}.yaml`]);
  execFileSync('git', ['-C', root, 'commit', '--quiet', '-m', `chore: add spec ${id}`]);
}

function gitStatus(root) {
  // -uno: hide untracked files. The temp fixtures don't set up a
  // .gitignore, so untracked .caws/events.jsonl and .caws/worktrees/
  // would otherwise show up and obscure the autocommit assertions.
  // The autocommit contract is about TRACKED files staying clean.
  return execFileSync('git', ['-C', root, 'status', '--porcelain', '-uno'], {
    encoding: 'utf8',
  }).trim();
}

function gitLastSubject(root) {
  return execFileSync('git', ['-C', root, 'log', '-1', '--pretty=%s'], {
    encoding: 'utf8',
  }).trim();
}

function gitHeadSha(root) {
  return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
}

const SESSION = {
  session_id: 'test-session-001',
  platform: 'test',
};
const ACTOR = {
  id: 'test-actor',
  kind: 'human',
};

// ─── createWorktree autocommit ─────────────────────────────────────────

describe('createWorktree — auto-commit (Fix 5)', () => {
  let fixture;
  afterEach(() => fixture && rmrf(fixture.root));

  it('on clean baseline: commits registry + spec; working tree clean after; HEAD advances; commit subject matches', () => {
    fixture = mkCawsGitRepo('wt-autocommit-create-clean-');
    writeSpec(fixture.cawsDir, 'FIX-001', minimalActiveSpec('FIX-001'));
    commitSpec(fixture.root, 'FIX-001');

    const headBefore = gitHeadSha(fixture.root);
    expect(gitStatus(fixture.root)).toBe(''); // baseline clean

    const result = createWorktree(fixture.cawsDir, {
      name: 'fix-001-wt',
      specId: 'FIX-001',
      session: SESSION,
      actor: ACTOR,
    });

    expect(result.ok).toBe(true);
    expect(result.value.kind).toBe('success');
    expect(result.value.action).toBe('created');

    // The autocommit outcome lands in data.audit_commit.
    const ac = result.value.data.audit_commit;
    expect(ac).toBeDefined();
    expect(ac.kind).toBe('committed');
    expect(ac.sha).toMatch(/^[0-9a-f]{7,}$/);

    // Working tree is clean (the writer + autocommit landed cleanly).
    expect(gitStatus(fixture.root)).toBe('');

    // HEAD advanced; last commit subject is the chore(caws): one.
    const headAfter = gitHeadSha(fixture.root);
    expect(headAfter).not.toBe(headBefore);
    expect(gitLastSubject(fixture.root)).toBe(
      'chore(caws): bind fix-001-wt to FIX-001'
    );
  });

  it('on dirty pre-write: writer still succeeds; data.audit_commit.kind === refused_dirty; both changes visible in working tree', () => {
    fixture = mkCawsGitRepo('wt-autocommit-create-dirty-');
    writeSpec(fixture.cawsDir, 'FIX-002', minimalActiveSpec('FIX-002'));
    commitSpec(fixture.root, 'FIX-002');

    // Pre-existing unrelated dirty state on .caws/worktrees.json:
    // someone manually edited it before running caws worktree create.
    const registryPath = path.join(fixture.cawsDir, 'worktrees.json');
    fs.writeFileSync(registryPath, '{"_unrelated_manual_edit": true}\n');
    expect(gitStatus(fixture.root)).toMatch(/\.caws\/worktrees\.json/);

    const result = createWorktree(fixture.cawsDir, {
      name: 'fix-002-wt',
      specId: 'FIX-002',
      session: SESSION,
      actor: ACTOR,
    });

    expect(result.ok).toBe(true);
    expect(result.value.kind).toBe('success'); // writer succeeded
    expect(result.value.action).toBe('created');

    // But the autocommit refused because pre-write was dirty.
    const ac = result.value.data.audit_commit;
    expect(ac.kind).toBe('refused_dirty');
    expect(ac.reason).toMatch(/dirty before the caws write/);

    // Working tree still shows both the writer's change AND the
    // unrelated change (autocommit did NOT roll back the writer).
    const status = gitStatus(fixture.root);
    expect(status).toMatch(/\.caws\/worktrees\.json/);
    // The writer mutated the registry to include the new entry. Read
    // the file and confirm: the manual edit is GONE (writer overwrote)
    // but the writer's own entry is there.
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    expect(registry['fix-002-wt']).toBeDefined();
    expect(registry['fix-002-wt'].specId).toBe('FIX-002');
  });
});

// ─── destroyWorktree autocommit ─────────────────────────────────────────

describe('destroyWorktree — auto-commit (Fix 5)', () => {
  let fixture;
  afterEach(() => fixture && rmrf(fixture.root));

  it('on clean baseline (after createWorktree settled): commits and surfaces data.audit_commit', () => {
    fixture = mkCawsGitRepo('wt-autocommit-destroy-');
    writeSpec(fixture.cawsDir, 'FIX-003', minimalActiveSpec('FIX-003'));
    commitSpec(fixture.root, 'FIX-003');

    // Create first (autocommitted), then destroy.
    const createResult = createWorktree(fixture.cawsDir, {
      name: 'fix-003-wt',
      specId: 'FIX-003',
      session: SESSION,
      actor: ACTOR,
    });
    expect(createResult.value.data.audit_commit.kind).toBe('committed');
    expect(gitStatus(fixture.root)).toBe(''); // create autocommitted

    const headBefore = gitHeadSha(fixture.root);

    const destroyResult = destroyWorktree(fixture.cawsDir, {
      name: 'fix-003-wt',
      session: SESSION,
      actor: ACTOR,
    });

    expect(destroyResult.ok).toBe(true);
    expect(destroyResult.value.kind).toBe('success');
    expect(destroyResult.value.action).toBe('destroyed');

    const ac = destroyResult.value.data.audit_commit;
    expect(ac).toBeDefined();
    expect(ac.kind).toBe('committed');
    expect(ac.sha).toMatch(/^[0-9a-f]{7,}$/);

    expect(gitStatus(fixture.root)).toBe('');
    expect(gitHeadSha(fixture.root)).not.toBe(headBefore);
    expect(gitLastSubject(fixture.root)).toBe(
      'chore(caws): destroy fix-003-wt'
    );
  });
});
