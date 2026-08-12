'use strict';

/**
 * AC-evidence warn-mode advisory survives the merge composition boundary
 * (CAWS-DEFECT-AC-EVIDENCE-VISIBILITY-01, D2 part 2).
 *
 * The defect this suite pins: `caws worktree merge` auto-closes the bound spec
 * by calling closeSpec, which computes the AC-evidence advisory and folds it
 * into its own outcome's `warnings`. mergeWorktree read `closeResult` only to
 * check the outcome KIND and never carried the warnings into its success
 * `data`, so runWorktreeMergeCommand could not print them even if it tried.
 * Merge is the path most closures take, so this drop is what made the gate
 * invisible for the majority of closes.
 *
 * These drive the REAL compiled writers against REAL git repos in temp dirs
 * (same construction as worktree-merge-already-closed-spec.test.js) — the
 * property under test is the composed merge's handling of real on-disk state,
 * which a mocked git cannot exercise.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { createSpec, recordSpecEvidence } = require('../../dist/store/specs-writer');
const { createWorktree, mergeWorktree } = require('../../dist/store/worktrees-writer');
const { runWorktreeMergeCommand } = require('../../dist/shell/commands/worktree');
const { initProject } = require('../../dist/store/init-store');

const SESSION_ID = 'sess-ac-evidence-merge';
const SESSION = { session_id: SESSION_ID, platform: 'jest' };
const ACTOR = { kind: 'agent', id: 'ac-evidence-agent', session_id: SESSION_ID };
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

function seedBoundableSpec(caws, id) {
  // scopeIn covers payload.txt: the merge-time lane-provenance guard refuses
  // any lane commit touching paths outside the bound spec's scope.
  const r = createSpec(caws, {
    id,
    title: 'AC evidence merge fixture',
    mode: 'chore',
    riskTier: 3,
    actor: ACTOR,
    scopeIn: ['payload.txt'],
  });
  if (!r.ok || r.value.kind !== 'success') {
    throw new Error('seed spec failed: ' + JSON.stringify(r));
  }
}

/** Create the worktree, commit real work on its branch, sync it with main. */
function seedLane(caws, name, specId) {
  const created = createWorktree(caws, { name, specId, session: SESSION, actor: ACTOR });
  if (!created.ok || created.value.kind !== 'success') {
    throw new Error('createWorktree failed: ' + JSON.stringify(created));
  }
  const wtPath = path.join(caws, 'worktrees', name);
  fs.writeFileSync(path.join(wtPath, 'payload.txt'), 'work product\n');
  execFileSync('git', ['-C', wtPath, 'add', 'payload.txt']);
  execFileSync('git', ['-C', wtPath, 'commit', '--quiet', '--no-verify', '-m', 'feat: work']);
  execFileSync('git', ['-C', wtPath, 'merge', '--quiet', '--no-edit', 'main']);
  return wtPath;
}

function runMergeCommand(repoRoot, name) {
  const out = [];
  const errLines = [];
  const code = runWorktreeMergeCommand({
    cwd: repoRoot,
    name,
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: SESSION_ID },
    out: (line) => out.push(line),
    err: (line) => errLines.push(line),
  });
  return { code, out: out.join('\n'), err: errLines.join('\n') };
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

describe('mergeWorktree carries the auto-close AC-evidence advisory in its outcome', () => {
  test('an unsatisfied criterion appears in the merge success data', () => {
    const caws = setupCaws(mkRepo('acmerge-store-'));
    const repo = path.dirname(caws);
    const SPEC = 'ACMERGE-STORE-001';
    seedBoundableSpec(caws, SPEC);
    commitCaws(repo, 'seed spec');
    seedLane(caws, 'wt-acm-store', SPEC);

    const result = mergeWorktree(caws, {
      name: 'wt-acm-store',
      session: SESSION,
      sessionCandidates: CANDIDATES,
      actor: ACTOR,
    });

    expect(result.ok).toBe(true);
    expect(result.value.kind).toBe('success');
    // HEADLINE: before the fix this key did not exist — closeSpec's warnings
    // were read for their outcome kind and then discarded.
    const warnings = result.value.data.evidence_warnings;
    expect(Array.isArray(warnings)).toBe(true);
    expect(warnings.join('\n')).toContain('lacking satisfying evidence');
    expect(warnings.join('\n')).toContain(`caws specs evidence ${SPEC} --ac A1`);
  });

  test('a fully-evidenced spec merges with no evidence_warnings key at all', () => {
    const caws = setupCaws(mkRepo('acmerge-clean-'));
    const repo = path.dirname(caws);
    const SPEC = 'ACMERGE-CLEAN-001';
    seedBoundableSpec(caws, SPEC);
    const recorded = recordSpecEvidence(caws, {
      id: SPEC,
      criterionId: 'A1',
      status: 'pass',
      evidenceRef: 'npx jest worktree-merge-evidence-warning',
      actor: ACTOR,
    });
    if (!recorded.ok || recorded.value.kind !== 'success') {
      throw new Error('recordSpecEvidence failed: ' + JSON.stringify(recorded));
    }
    commitCaws(repo, 'seed spec + evidence');
    seedLane(caws, 'wt-acm-clean', SPEC);

    const result = mergeWorktree(caws, {
      name: 'wt-acm-clean',
      session: SESSION,
      sessionCandidates: CANDIDATES,
      actor: ACTOR,
    });

    expect(result.ok).toBe(true);
    expect(result.value.kind).toBe('success');
    // Absent, not empty: a clean merge must not carry a vestigial key, or the
    // "did this close warn?" question needs a length check at every reader.
    expect(result.value.data).not.toHaveProperty('evidence_warnings');
  });
});

describe('caws worktree merge prints the advisory', () => {
  test('the advisory reaches stderr and the merge still exits 0', () => {
    const caws = setupCaws(mkRepo('acmerge-shell-'));
    const repo = path.dirname(caws);
    const SPEC = 'ACMERGE-SHELL-001';
    seedBoundableSpec(caws, SPEC);
    commitCaws(repo, 'seed spec');
    seedLane(caws, 'wt-acm-shell', SPEC);

    const result = runMergeCommand(repo, 'wt-acm-shell');

    // The merge is complete and durable — the advisory must not become a
    // soft block.
    expect(result.code).toBe(0);
    expect(result.out).toContain('merged wt-acm-shell');

    expect(result.err).toContain('caws advisory (non-blocking)');
    expect(result.err).toContain('A1');
    expect(result.err).toContain(`caws specs evidence ${SPEC} --ac A1 --status pass`);
  });

  test('a fully-evidenced spec merges with no advisory on stderr', () => {
    const caws = setupCaws(mkRepo('acmerge-shell-clean-'));
    const repo = path.dirname(caws);
    const SPEC = 'ACMERGE-SHELL-002';
    seedBoundableSpec(caws, SPEC);
    const recorded = recordSpecEvidence(caws, {
      id: SPEC,
      criterionId: 'A1',
      status: 'waived',
      waiverReason: 'structural chore; no separately verifiable criterion',
      actor: ACTOR,
    });
    if (!recorded.ok || recorded.value.kind !== 'success') {
      throw new Error('recordSpecEvidence failed: ' + JSON.stringify(recorded));
    }
    commitCaws(repo, 'seed spec + waiver');
    seedLane(caws, 'wt-acm-shell-clean', SPEC);

    const result = runMergeCommand(repo, 'wt-acm-shell-clean');

    expect(result.code).toBe(0);
    expect(result.out).toContain('merged wt-acm-shell-clean');
    expect(result.err).not.toContain('lacking satisfying evidence');
    expect(result.err).not.toContain('caws advisory (non-blocking)');
  });
});
