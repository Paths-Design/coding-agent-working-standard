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

const { createSpec, closeSpec } = require('../../dist/store/specs-writer');
const { createWorktree, mergeWorktree } = require('../../dist/store/worktrees-writer');
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

function seedSpec(caws, id, scopeIn = ['work.txt']) {
  // scopeIn defaults to the fixture's lane file: CAWS-PREPUSH-PROVENANCE-
  // REWORK-001's merge-time lane check verifies every lane-branch commit
  // against the bound spec's scope.in, so fixtures must declare scope or
  // their own 'branch work' commit reads as foreign.
  const r = createSpec(caws, { id, title: 'apply fixture', mode: 'chore', riskTier: 3, actor: ACTOR, scopeIn });
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

// =========================================================================
// caws worktree merge --closure-notes (CAWS-FEAT-WORKTREE-MERGE-CLOSURE-NOTES-FLAG-01).
// The merge auto-closes the bound spec with a machine stub by default;
// --closure-notes lets the operator author closure_notes THROUGH the merge.
// Mirrors the caws specs close closure-notes alias contract. These drive the
// REAL compiled shell command against REAL git worktrees.
// =========================================================================

function readSpecYaml(caws, id) {
  return fs.readFileSync(path.join(caws, 'specs', `${id}.yaml`), 'utf8');
}

describe('caws worktree merge --closure-notes (CAWS-FEAT-WORKTREE-MERGE-CLOSURE-NOTES-FLAG-01)', () => {
  test('B1: --closure-notes writes the operator notes to the bound spec on auto-close', () => {
    const { repo, caws, wtPath } = setupReadyWorktree('merge-notes-b1-', 'wt-b1', 'MERGE-NOTES-B1-001');
    const notes = 'Closed via merge: two-process replay verified, parity exact, LOCAL_ONLY retained.';
    const result = runMerge(repo, 'wt-b1', { closureNotes: notes });

    expect(result.code).toBe(0);
    expect(result.out).toMatch(/merged wt-b1 \(merge_commit:/);
    expect(result.out).toMatch(/auto_closed_spec: MERGE-NOTES-B1-001/);
    // The worktree dir is gone (teardown ran).
    expect(fs.existsSync(wtPath)).toBe(false);

    const yaml = readSpecYaml(caws, 'MERGE-NOTES-B1-001');
    // Operator notes land verbatim; the machine stub is absent.
    expect(yaml).toContain(`closure_notes: '${notes}'`);
    expect(yaml).not.toContain('Auto-closed by caws worktree merge');
    expect(yaml).toContain('lifecycle_state: closed');
  });

  test('B2: the --notes alias writes the same field (alias parity with caws specs close)', () => {
    const { repo, caws } = setupReadyWorktree('merge-notes-b2-', 'wt-b2', 'MERGE-NOTES-B2-001');
    const notes = 'closed via --notes alias';
    const result = runMerge(repo, 'wt-b2', { notes });

    expect(result.code).toBe(0);
    const yaml = readSpecYaml(caws, 'MERGE-NOTES-B2-001');
    expect(yaml).toContain(`closure_notes: '${notes}'`);
    expect(yaml).not.toContain('Auto-closed by caws worktree merge');
  });

  test('B3: passing two note aliases is a usage error (exit 2, no merge, no spec close)', () => {
    const { repo, wtPath, caws } = setupReadyWorktree('merge-notes-b3-', 'wt-b3', 'MERGE-NOTES-B3-001');
    const result = runMerge(repo, 'wt-b3', { closureNotes: 'one', reason: 'two' });

    expect(result.code).toBe(2);
    expect(result.err).toMatch(/all write closure_notes; pass only one/);
    // Nothing happened: worktree dir still there, spec still active.
    expect(fs.existsSync(wtPath)).toBe(true);
    const yaml = readSpecYaml(caws, 'MERGE-NOTES-B3-001');
    expect(yaml).toContain('lifecycle_state: active');
    expect(yaml).not.toContain('closure_notes:');
  });

  test('B4: --closure-notes on an already-closed spec warns and points at reopen-then-close, but the merge still succeeds', () => {
    const { repo, caws, wtPath } = setupReadyWorktree('merge-notes-b4-', 'wt-b4', 'MERGE-NOTES-B4-001');
    const preCloseNotes = 'pre-closed by hand before the merge';
    // Pre-close the spec via caws specs close (the documented escape). The merge
    // then hits its already-closed fast path and skips closeSpec.
    const closed = closeSpec(caws, {
      id: 'MERGE-NOTES-B4-001',
      resolution: 'completed',
      reason: preCloseNotes,
      actor: ACTOR,
    });
    expect(closed.ok).toBe(true);
    commitCaws(repo, 'pre-close the spec');

    const result = runMerge(repo, 'wt-b4', { closureNotes: 'merge-time notes should be ignored' });

    // Merge still succeeds (exit 0); teardown still ran.
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/merged wt-b4 \(merge_commit:/);
    expect(fs.existsSync(wtPath)).toBe(false);
    // The warning fired on stderr, naming the reopen-then-close recovery path.
    expect(result.err).toMatch(/--closure-notes was ignored/);
    expect(result.err).toMatch(/already closed/);
    expect(result.err).toMatch(/caws specs reopen MERGE-NOTES-B4-001/);
    expect(result.err).toMatch(/caws specs close MERGE-NOTES-B4-001 --closure-notes/);
    // The spec closure_notes are unchanged — the pre-close notes survive.
    const yaml = readSpecYaml(caws, 'MERGE-NOTES-B4-001');
    expect(yaml).toContain(`closure_notes: '${preCloseNotes}'`);
    expect(yaml).not.toContain('merge-time notes should be ignored');
  });
});

// =========================================================================
// Lane provenance at the merge boundary (CAWS-PREPUSH-PROVENANCE-REWORK-001).
// MERGE IS THE SINGLE GOVERNED LANDING DOOR: every commit a lane lands must
// belong to the lane, verified BEFORE the CAS sequence. Attribution is
// SCOPE-keyed, never author/session-keyed (A8). Real git worktrees, real
// compiled shell + store.
// =========================================================================

describe('caws worktree merge — lane provenance (CAWS-PREPUSH-PROVENANCE-REWORK-001)', () => {
  test('P1 (A1): a clean lane merge records lane_tip + base_before in worktree_merged', () => {
    const { repo, caws, wtPath } = setupReadyWorktree('prov-p1-', 'wt-p1', 'PROV-P1-001');
    const registry = JSON.parse(fs.readFileSync(path.join(caws, 'worktrees.json'), 'utf8'));
    const branch = registry['wt-p1'].branch;
    const laneTip = execFileSync('git', ['-C', repo, 'rev-parse', branch], { encoding: 'utf8' }).trim();

    const result = runMerge(repo, 'wt-p1');
    expect(result.code).toBe(0);
    expect(fs.existsSync(wtPath)).toBe(false); // teardown ran

    const events = fs.readFileSync(path.join(caws, 'events.jsonl'), 'utf8')
      .trim().split('\n').map((l) => JSON.parse(l));
    const merged = events.filter((e) => e.event === 'worktree_merged').pop();
    expect(merged).toBeDefined();
    expect(merged.data.lane_tip).toBe(laneTip);
    expect(merged.data.base_before).toMatch(/^[0-9a-f]{40}$/);
    // The recorded range resolves and contains the lane's commit(s).
    const range = execFileSync(
      'git',
      ['-C', repo, 'rev-list', `${merged.data.base_before}..${merged.data.lane_tip}`],
      { encoding: 'utf8' }
    ).trim().split('\n').filter(Boolean);
    expect(range.length).toBeGreaterThanOrEqual(1);
  });

  test('P2 (A2): a lane commit OUTSIDE the spec scope refuses pre-merge and writes nothing', () => {
    const { repo, caws, wtPath } = setupReadyWorktree('prov-p2-', 'wt-p2', 'PROV-P2-001');
    fs.writeFileSync(path.join(wtPath, 'foreign.txt'), 'not lane work\n');
    execFileSync('git', ['-C', wtPath, 'add', 'foreign.txt']);
    execFileSync('git', ['-C', wtPath, 'commit', '--quiet', '-m', 'foreign work swept into the lane']);

    const beforeEvents = fs.readFileSync(path.join(caws, 'events.jsonl'), 'utf8');
    const result = runMerge(repo, 'wt-p2');

    expect(result.code).toBe(1);
    expect(result.err).toMatch(/outside spec scope/);
    expect(result.err).toMatch(/foreign\.txt/);
    // Nothing was written: no destroy, no new events, main did not advance.
    expect(fs.existsSync(wtPath)).toBe(true);
    expect(fs.readFileSync(path.join(caws, 'events.jsonl'), 'utf8')).toBe(beforeEvents);
    expect(() =>
      execFileSync('git', ['-C', repo, 'show', 'main:foreign.txt'], { stdio: 'pipe' })
    ).toThrow();
  });

  test('P2b (A2/dry-run honesty): a dry run reports the same provenance findings', () => {
    const { repo, wtPath } = setupReadyWorktree('prov-p2b-', 'wt-p2b', 'PROV-P2B-001');
    fs.writeFileSync(path.join(wtPath, 'foreign.txt'), 'not lane work\n');
    execFileSync('git', ['-C', wtPath, 'add', 'foreign.txt']);
    execFileSync('git', ['-C', wtPath, 'commit', '--quiet', '-m', 'foreign work']);

    const result = runMerge(repo, 'wt-p2b', { dryRun: true });
    expect(result.out + result.err).toMatch(/outside spec scope/);
    expect(fs.existsSync(wtPath)).toBe(true);
  });

  test('P3 (A2 remediation): the refusal names candidate lanes for the out-of-scope paths', () => {
    const { repo, caws, wtPath } = setupReadyWorktree('prov-p3-', 'wt-p3', 'PROV-P3-001');
    // A second ACTIVE spec whose scope admits the foreign path — the lane the
    // commit might actually belong to.
    seedSpec(caws, 'OTHER-LANE-1', ['foreign.txt']);
    commitCaws(repo, 'seed other spec');
    fs.writeFileSync(path.join(wtPath, 'foreign.txt'), 'x\n');
    execFileSync('git', ['-C', wtPath, 'add', 'foreign.txt']);
    execFileSync('git', ['-C', wtPath, 'commit', '--quiet', '-m', 'foreign work']);

    // Store-level: the refusal diagnostic carries structured foreign_commits
    // detail (offending sha, out-of-scope paths, candidate spec ids).
    const result = mergeWorktree(caws, {
      name: 'wt-p3',
      session: SESSION,
      actor: ACTOR,
      sessionCandidates: CANDIDATES,
      now: () => new Date('2026-08-06T12:00:00.000Z'),
    });
    expect(result.ok).toBe(false);
    const payload = JSON.stringify(result.errors);
    expect(payload).toContain('foreign.txt');
    expect(payload).toContain('OTHER-LANE-1');
    expect(fs.existsSync(wtPath)).toBe(true); // nothing written
  });

  test('P4 (A8): provenance is scope-keyed, never author/session-keyed — a lane commit by a DIFFERENT author merges', () => {
    const { repo, wtPath } = setupReadyWorktree('prov-p4-', 'wt-p4', 'PROV-P4-001');
    // Simulates the takeover chain: a second session (different git author)
    // commits in-scope lane work. The lane is the authority unit, so the
    // authorship change must not affect the verdict.
    fs.appendFileSync(path.join(wtPath, 'work.txt'), 'more lane work\n');
    execFileSync('git', ['-C', wtPath, 'add', 'work.txt']);
    execFileSync('git', [
      '-C', wtPath,
      '-c', 'user.name=OtherSession',
      '-c', 'user.email=other@t.com',
      'commit', '--quiet', '-m', 'lane work from a second session (takeover chain)',
    ]);

    const result = runMerge(repo, 'wt-p4');
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/merged wt-p4 \(merge_commit:/);
  });
});
