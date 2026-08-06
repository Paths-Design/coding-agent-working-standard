'use strict';

/**
 * caws worktree merge --apply (CAWS-DEFECT-MERGE-APPLY-FLAG-01, DEFECT-04).
 *
 * --apply collapses the dry-run-then-real ceremony (95% of dry-run turns in
 * the harvest immediately re-ran the real merge). It runs the dry-run gate,
 * then merges if canProceed; refuses with findings otherwise; never forces.
 *
 * These drive the REAL compiled shell command against REAL git worktrees
 * (no mocked git) so the two-call composition (gate then merge) is exercised
 * end to end, including the real merge commit + spec auto-close.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { createSpec } = require('../../dist/store/specs-writer');
const { createWorktree } = require('../../dist/store/worktrees-writer');
const { initProject } = require('../../dist/store/init-store');
const { runWorktreeMergeCommand } = require('../../dist/shell/commands/worktree');
const { cleanupAll } = require('../helpers/git-repo-factory');

const SESSION_ID = 'sess-apply';
const SESSION = { session_id: SESSION_ID, platform: 'jest' };
const ACTOR = { kind: 'agent', id: 'apply-agent', session_id: SESSION_ID };
const CANDIDATES = {
  candidates: [{ identity: SESSION, source: 'hook_env' }],
  trace: [],
};

const repos = [];

function mkRepo(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync('git', ['init', '--quiet', '-b', 'main', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 't@test.com']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
  execFileSync('git', ['-C', root, 'commit', '--quiet', '--allow-empty', '-m', 'init']);
  repos.push(root);
  return root;
}

function setupCaws(repoRoot) {
  const r = initProject(repoRoot);
  if (!r.ok) throw new Error('initProject failed: ' + JSON.stringify(r.errors));
  return path.join(repoRoot, '.caws');
}

function commitCaws(repoRoot, message) {
  execFileSync('git', ['-C', repoRoot, 'add', '-A']);
  execFileSync('git', ['-C', repoRoot, 'commit', '--quiet', '--no-verify', '-m', message]);
}

function seedSpec(caws, id) {
  const r = createSpec(caws, { id, title: 'apply fixture', mode: 'chore', riskTier: 3, actor: ACTOR });
  if (!r.ok || r.value.kind !== 'success') {
    throw new Error('seed spec failed: ' + JSON.stringify(r));
  }
}

/**
 * Build a READY-to-merge worktree: a created worktree with one commit on its
 * branch that is not yet on main, a clean tree, and a spec binding. The caller
 * cwd is the REPO ROOT (outside the worktree) so the cwd-self-destruct guard
 * does not fire.
 */
function setupReadyWorktree(prefix, name, specId) {
  const repo = mkRepo(prefix);
  const caws = setupCaws(repo);
  seedSpec(caws, specId);
  commitCaws(repo, 'seed spec');
  const created = createWorktree(caws, { name, specId, session: SESSION, actor: ACTOR });
  if (!created.ok || created.value.kind !== 'success') {
    throw new Error('createWorktree failed: ' + JSON.stringify(created));
  }
  const wtPath = path.join(caws, 'worktrees', name);
  // One commit on the worktree branch, not on main yet.
  fs.writeFileSync(path.join(wtPath, 'work.txt'), 'branch work\n');
  execFileSync('git', ['-C', wtPath, 'add', 'work.txt']);
  execFileSync('git', ['-C', wtPath, 'commit', '--quiet', '-m', 'branch work']);
  return { repo, caws, wtPath };
}

function runMerge(repo, name, opts = {}) {
  const out = [];
  const err = [];
  const code = runWorktreeMergeCommand({
    cwd: repo,
    name,
    // The shell command resolves the operating session from env (precedence
    // chain in resolve-session.ts). Pass CAWS_SESSION_ID so the resolver
    // recognizes the caller as the owner the worktree was created with.
    env: { ...process.env, CAWS_SESSION_ID: SESSION_ID },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    now: () => new Date('2026-08-06T12:00:00.000Z'),
    ...opts,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

afterAll(() => {
  cleanupAll();
  for (const r of repos) {
    try {
      fs.rmSync(r, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

describe('caws worktree merge --apply (CAWS-DEFECT-MERGE-APPLY-FLAG-01)', () => {
  test('A1: --apply on a ready worktree gates then merges in one command', () => {
    const { repo, caws, wtPath } = setupReadyWorktree('apply-a1-', 'wt-a1', 'APPLY-A1-001');
    const result = runMerge(repo, 'wt-a1', { apply: true });

    // One command merged: exit 0 + the same success line a plain merge emits.
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/merged wt-a1 \(merge_commit:/);
    expect(result.out).toMatch(/auto_closed_spec: APPLY-A1-001/);
    // The worktree dir is gone (teardown ran) — proof the real merge executed.
    expect(fs.existsSync(wtPath)).toBe(false);
  });

  test('A2: --apply on a NOT-ready worktree (uncommitted changes) refuses with findings, no merge', () => {
    const { repo, caws, wtPath } = setupReadyWorktree('apply-a2-', 'wt-a2', 'APPLY-A2-001');
    // Make the tree dirty so the gate's "uncommitted changes" finding fires.
    fs.writeFileSync(path.join(wtPath, 'uncommitted.txt'), 'dirty\n');

    const beforeEvents = fs.existsSync(path.join(caws, 'events.jsonl'))
      ? fs.readFileSync(path.join(caws, 'events.jsonl'), 'utf8')
      : '';
    const result = runMerge(repo, 'wt-a2', { apply: true });

    // Refused: exit 1, findings printed, the NOT-ready framing.
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/NOT ready to merge/);
    expect(result.err).toMatch(/uncommitted changes/);
    // No merge ran: the worktree dir still exists...
    expect(fs.existsSync(wtPath)).toBe(true);
    // ...and no new events were appended (no spec_closed / worktree_merged).
    const afterEvents = fs.existsSync(path.join(caws, 'events.jsonl'))
      ? fs.readFileSync(path.join(caws, 'events.jsonl'), 'utf8')
      : '';
    expect(afterEvents).toBe(beforeEvents);
  });

  test('A3: --dry-run and --apply together is a usage error (exit 2, no merge)', () => {
    const { repo, wtPath } = setupReadyWorktree('apply-a3-', 'wt-a3', 'APPLY-A3-001');
    const result = runMerge(repo, 'wt-a3', { dryRun: true, apply: true });

    expect(result.code).toBe(2);
    expect(result.err).toMatch(/mutually exclusive/);
    // Nothing happened: worktree dir still there.
    expect(fs.existsSync(wtPath)).toBe(true);
  });
});
