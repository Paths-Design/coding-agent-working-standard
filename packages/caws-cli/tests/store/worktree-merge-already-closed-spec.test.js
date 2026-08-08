/**
 * caws worktree merge treats an already-closed bound spec as idempotent.
 * CAWS-FIX-N5-MERGE-IDEMPOTENT-CLOSE-001.
 *
 * These drive the REAL compiled writers against REAL git repositories in
 * temp dirs — no mocked git — because the property under test is the
 * composed merge's handling of real on-disk spec state.
 *
 * The defect this suite pins: before the fix, `caws worktree merge` called
 * closeSpec unconditionally after the merge commit landed. When the bound
 * spec had been pre-closed (a valid close-before-merge workflow),
 * closeSpec returned LIFECYCLE_PLAN_REJECTED via nonActiveCloseSpecError
 * ("already closed"), and mergeWorktree turned that into a false
 * LIFECYCLE_PARTIAL_FAILURE_UNRECOVERED claiming "the bound spec remains
 * active" — which was false. The merge then left a one-sided worktree
 * binding. The fix makes the close step idempotent: an already-closed
 * spec is treated as closed and the merge continues to append
 * worktree_merged and destroy the worktree.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { createSpec, closeSpec } = require('../../dist/store/specs-writer');
const {
  createWorktree,
  mergeWorktree,
} = require('../../dist/store/worktrees-writer');
const { initProject } = require('../../dist/store/init-store');
// Read the chain directly so we can assert event counts without going
// through a render layer.
const { loadEvents } = require('../../dist/store/events-store');

const SESSION_ID = 'sess-n5-already-closed';
const SESSION = { session_id: SESSION_ID, platform: 'jest' };
const ACTOR = { kind: 'agent', id: 'n5-agent', session_id: SESSION_ID };
// Ownership-comparison surface (merge) takes the resolver's candidate
// envelope, not a bare id list.
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
  const r = createSpec(caws, { id, title: 'x', mode: 'chore', riskTier: 3, actor: ACTOR });
  if (!r.ok || r.value.kind !== 'success') {
    throw new Error('seed spec failed: ' + JSON.stringify(r));
  }
}

/** Local branch names, as git reports them. */
function branches(repoRoot) {
  return execFileSync('git', ['-C', repoRoot, 'branch', '--format=%(refname:short)'], {
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .filter((b) => b.length > 0);
}

function readEvents(caws) {
  const r = loadEvents(caws);
  if (!r.ok) throw new Error('loadEvents failed: ' + JSON.stringify(r.errors));
  return r.value.events;
}

function countEvents(caws, event) {
  return readEvents(caws).filter((e) => e.event === event).length;
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

describe('A1: merge of an already-closed bound spec is idempotent', () => {
  test('a pre-closed bound spec merges as success, not partial_failure', () => {
    const caws = setupCaws(mkRepo('n5mac-a1-'));
    const repo = path.dirname(caws);
    const SPEC = 'N5MAC-A1-001';
    seedBoundableSpec(caws, SPEC);
    commitCaws(repo, 'seed spec');

    // Create the worktree + a real commit on its branch (genuine work to
    // merge, exactly like the close-before-merge workflow).
    const created = createWorktree(caws, {
      name: 'wt-a1',
      specId: SPEC,
      session: SESSION,
      actor: ACTOR,
    });
    if (!created.ok || created.value.kind !== 'success') {
      throw new Error('createWorktree failed: ' + JSON.stringify(created));
    }
    const branch = created.value.data.branch;
    const wtPath = path.join(caws, 'worktrees', 'wt-a1');
    fs.writeFileSync(path.join(wtPath, 'payload.txt'), 'work product\n');
    execFileSync('git', ['-C', wtPath, 'add', 'payload.txt']);
    execFileSync('git', ['-C', wtPath, 'commit', '--quiet', '--no-verify', '-m', 'feat: work']);

    // Pre-close the bound spec the way an operator would, then commit
    // that control-plane change. This is the N5 trigger: the spec is
    // genuinely lifecycle_state: closed before merge runs its close step.
    const closed = closeSpec(caws, {
      id: SPEC,
      resolution: 'completed',
      reason: 'pre-closed before merge',
      actor: ACTOR,
    });
    if (!closed.ok || closed.value.kind !== 'success') {
      throw new Error('pre-close failed: ' + JSON.stringify(closed));
    }
    commitCaws(repo, 'pre-close bound spec');

    // Update the worktree from main so the merge preconditions hold.
    execFileSync('git', ['-C', wtPath, 'merge', '--quiet', '--no-edit', 'main']);

    const result = mergeWorktree(caws, {
      name: 'wt-a1',
      session: SESSION,
      sessionCandidates: CANDIDATES,
      actor: ACTOR,
    });

    // HEADLINE: the merge succeeds. Before the fix this was a false
    // LIFECYCLE_PARTIAL_FAILURE_UNRECOVERED claiming the spec was active.
    expect(result.ok).toBe(true);
    expect(result.value.kind).toBe('success');

    // The outcome reports the idempotent-close discriminant honestly.
    expect(result.value.data.spec_id).toBe(SPEC);
    expect(result.value.data.auto_closed_spec).toBe(true);
    expect(result.value.data.spec_already_closed).toBe(true);

    // Cleanup completed: branch gone, worktree dir gone.
    expect(branches(repo)).not.toContain(branch);
    expect(fs.existsSync(wtPath)).toBe(false);

    // No double-close: the idempotent fast path must NOT append a second
    // spec_closed. The pre-close appended exactly one; the merge skipped
    // closeSpec, so the count stays at 1. (If the fast path regressed into
    // calling closeSpec, closeSpec would refuse the already-closed spec
    // and the merge would surface partial_failure upstream of this point.)
    expect(countEvents(caws, 'spec_closed')).toBe(1);
  });
});

describe('A2: an active bound spec still closes normally on merge', () => {
  test('a normal (not pre-closed) merge sets spec_already_closed: false', () => {
    // Regression guard: the fast path must only trigger when the spec was
    // ACTUALLY already closed. A normal active-spec merge must still call
    // closeSpec, append spec_closed, and report spec_already_closed: false.
    const caws = setupCaws(mkRepo('n5mac-a2-'));
    const repo = path.dirname(caws);
    const SPEC = 'N5MAC-A2-001';
    seedBoundableSpec(caws, SPEC);
    commitCaws(repo, 'seed spec');

    const created = createWorktree(caws, {
      name: 'wt-a2',
      specId: SPEC,
      session: SESSION,
      actor: ACTOR,
    });
    if (!created.ok || created.value.kind !== 'success') {
      throw new Error('createWorktree failed: ' + JSON.stringify(created));
    }
    const branch = created.value.data.branch;
    const wtPath = path.join(caws, 'worktrees', 'wt-a2');
    fs.writeFileSync(path.join(wtPath, 'payload.txt'), 'work product\n');
    execFileSync('git', ['-C', wtPath, 'add', 'payload.txt']);
    execFileSync('git', ['-C', wtPath, 'commit', '--quiet', '--no-verify', '-m', 'feat: work']);
    execFileSync('git', ['-C', wtPath, 'merge', '--quiet', '--no-edit', 'main']);

    const result = mergeWorktree(caws, {
      name: 'wt-a2',
      session: SESSION,
      sessionCandidates: CANDIDATES,
      actor: ACTOR,
    });

    expect(result.ok).toBe(true);
    expect(result.value.kind).toBe('success');
    // The normal path: the merge performed the close itself.
    expect(result.value.data.spec_already_closed).toBe(false);
    expect(result.value.data.auto_closed_spec).toBe(true);
    expect(countEvents(caws, 'spec_closed')).toBe(1);
    expect(branches(repo)).not.toContain(branch);
  });
});

// =========================================================================
// mergeWorktree — closure_notes authored at merge time (CAWS-FEAT-WORKTREE-
// MERGE-CLOSURE-NOTES-FLAG-01). The merge auto-close feeds closeSpec a
// machine stub reason by default; the `closureNotes` input lets the operator
// replace that stub. These cases pin the writer-side contract: user notes
// land when the spec carried none, and pre-written YAML notes still win
// (preserve contract unchanged). The already-closed + --closure-notes
// warning is covered at the shell layer (tests/shell/worktree-merge.test.js
// B4) because the warning is a shell-rendered message, not a store outcome.
// =========================================================================

function readSpecYaml(cawsDir, id) {
  return fs.readFileSync(path.join(cawsDir, 'specs', `${id}.yaml`), 'utf8');
}

describe('mergeWorktree closure_notes authored at merge time [CAWS-FEAT-WORKTREE-MERGE-CLOSURE-NOTES-FLAG-01]', () => {
  test('A4: closureNotes supplied at merge time replace the machine stub when the spec carried no closure_notes', () => {
    const repo = mkRepo('mn-a4-');
    const caws = setupCaws(repo);
    const id = 'WT-MERGE-NOTES-001';
    seedBoundableSpec(caws, id);
    const created = createWorktree(caws, {
      name: 'wt-mn',
      specId: id,
      session: SESSION,
      actor: ACTOR,
    });
    expect(created.ok).toBe(true);
    expect(created.value.kind).toBe('success');
    // Non-empty commit on the worktree branch so the merge has something to merge.
    commitCaws(repo, 'pre-merge state for closure-notes');

    const userNotes = 'Closed via merge: A4 two-process replay verified, parity exact, LOCAL_ONLY retained.';
    const result = mergeWorktree(caws, {
      name: 'wt-mn',
      session: SESSION,
      sessionCandidates: CANDIDATES,
      actor: ACTOR,
      closureNotes: userNotes,
    });

    expect(result.ok).toBe(true);
    expect(result.value.kind).toBe('success');
    // The auto-close discriminant: the spec was closed by THIS merge.
    expect(result.value.data.spec_already_closed).toBe(false);

    const yaml = readSpecYaml(caws, id);
    // User-authored notes land verbatim; the machine stub is absent.
    expect(yaml).toContain(`closure_notes: '${userNotes}'`);
    expect(yaml).not.toContain('Auto-closed by caws worktree merge');
    expect(yaml).toContain('lifecycle_state: closed');
    expect((yaml.match(/^closure_notes:/gm) || []).length).toBe(1);

    // The spec_closed event carries the user notes as closure_notes too.
    const closedEvents = readEvents(caws).filter((e) => e.event === 'spec_closed');
    expect(closedEvents.length).toBe(1);
    expect(closedEvents[0].data.closure_notes).toBe(userNotes);
  });

  test('A4b: closureNotes at merge time do NOT clobber pre-written YAML closure_notes (preserve contract unchanged)', () => {
    const repo = mkRepo('mn-a4b-');
    const caws = setupCaws(repo);
    const id = 'WT-MERGE-NOTES-PRE-002';
    const preAuthoredNotes = 'Pre-written by the author before merging.';
    seedBoundableSpec(caws, id);
    // Splice a closure_notes line into the still-active spec — the shape an
    // author who pre-wrote notes before merging produces.
    const specPath = path.join(caws, 'specs', `${id}.yaml`);
    const body = fs.readFileSync(specPath, 'utf8').replace(
      'lifecycle_state: active',
      `lifecycle_state: active\nclosure_notes: '${preAuthoredNotes}'`
    );
    fs.writeFileSync(specPath, body);
    commitCaws(repo, 'spec with pre-written closure_notes');
    const created = createWorktree(caws, {
      name: 'wt-mn2',
      specId: id,
      session: SESSION,
      actor: ACTOR,
    });
    expect(created.ok).toBe(true);
    expect(created.value.kind).toBe('success');
    commitCaws(repo, 'worktree branch commit');

    const result = mergeWorktree(caws, {
      name: 'wt-mn2',
      session: SESSION,
      sessionCandidates: CANDIDATES,
      actor: ACTOR,
      closureNotes: 'merge-time notes should NOT win over pre-written YAML notes',
    });

    expect(result.ok).toBe(true);
    expect(result.value.kind).toBe('success');

    const yaml = readSpecYaml(caws, id);
    // Pre-written YAML notes survive; merge-time closureNotes did NOT overwrite.
    expect(yaml).toContain(`closure_notes: '${preAuthoredNotes}'`);
    expect(yaml).not.toContain('merge-time notes should NOT win');
    expect(yaml).toContain('lifecycle_state: closed');
    expect((yaml.match(/^closure_notes:/gm) || []).length).toBe(1);
  });
});
