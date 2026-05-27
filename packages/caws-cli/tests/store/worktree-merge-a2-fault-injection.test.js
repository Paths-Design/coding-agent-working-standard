/**
 * WORKTREE-MERGE-A2-FAULT-INJECTION-001
 *
 * Automated regression for mergeWorktree's honest-completion path: when
 * the composed closeSpec lifecycle transaction returns
 * partial_failure_recovered (state writes rolled back), mergeWorktree
 * must surface err(LIFECYCLE_PARTIAL_FAILURE_UNRECOVERED), preserve the
 * worktree, and leave the spec active.
 *
 * Originating session: WORKTREE-MERGE-CLEARS-SPEC-BINDING-001 PR #5,
 * where A2 was proven manually by inducing a faulty event-data field.
 * That manual proof is not in CI; this file adds the automated
 * regression by way of a SHARED, test-only fault-injection seam in
 * lifecycle-transaction.ts.
 *
 * Acceptance criteria coverage:
 *   A1 — mergeWorktree surfaces err(LIFECYCLE_PARTIAL_FAILURE_UNRECOVERED)
 *        when closeSpec returns partial_failure_recovered.
 *   A2 — no worktree_merged / worktree_destroyed / spec_closed events
 *        appended under the injected fault.
 *   A3 — operator-retry pattern: after fault cleared, a second
 *        mergeWorktree call succeeds end-to-end.
 *   A4 — happy path unaffected: no fault active, mergeWorktree behaves
 *        as before.
 *   A5 — production-refusal: the seam must refuse the env var when
 *        NODE_ENV !== 'test' and JEST_WORKER_ID is undefined.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  createWorktree,
  mergeWorktree,
} = require('../../dist/store/worktrees-writer');
const { initProject } = require('../../dist/store/init-store');
const {
  runLifecycleTransaction,
} = require('../../dist/store/lifecycle-transaction');
const {
  acquireLifecycleLock,
  releaseLifecycleLock,
} = require('../../dist/store/lifecycle-lock');

const FAULT_ENV = 'CAWS_TEST_INJECT_LIFECYCLE_FAULT';

function mkRepo(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync('git', ['init', '--quiet', '-b', 'main', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 't@test.com']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
  execFileSync('git', [
    '-C',
    root,
    'commit',
    '--quiet',
    '--allow-empty',
    '-m',
    'init',
  ]);
  return root;
}

function rmrf(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

function setupCaws(repoRoot) {
  const result = initProject(repoRoot);
  if (!result.ok) {
    throw new Error('initProject failed: ' + JSON.stringify(result.errors));
  }
  return path.join(repoRoot, '.caws');
}

function readEvents(cawsDir) {
  const p = path.join(cawsDir, 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  const lines = fs
    .readFileSync(p, 'utf8')
    .trim()
    .split('\n')
    .filter((l) => l.length > 0);
  return lines.map((l) => JSON.parse(l));
}

function writeActiveSpec(cawsDir, id) {
  const body = `id: ${id}
title: 'Fault-injection target spec'
risk_tier: 3
mode: chore
lifecycle_state: active
created_at: '2026-05-21T00:00:00.000Z'
updated_at: '2026-05-21T00:00:00.000Z'
blast_radius:
  modules:
    - tests
  data_migration: false
operational_rollback_slo: 5m
scope:
  in:
    - tests
  out: []
invariants:
  - 'fixture spec'
acceptance:
  - id: A1
    given: 'fixture'
    when: 'fixture'
    then: 'fixture'
non_functional:
  reliability:
    - 'fixture'
  performance:
    - 'fixture'
contracts: []
`;
  fs.writeFileSync(path.join(cawsDir, 'specs', `${id}.yaml`), body);
}

const SESSION = { session_id: 'sess-test-a2', platform: 'jest' };
const ACTOR = {
  kind: 'agent',
  id: 'test-agent',
  session_id: 'sess-test-a2',
};

// CAWS-WORKTREE-DESTROY-SESSION-RESOLUTION-001: ownership-comparison
// surfaces (merge, destroy) require a candidate set instead of a
// single session. For tests that previously asserted on session-id
// equality, wrap the test SESSION as the only capsule candidate —
// preserves the original semantic while satisfying the new input.
const SESSION_CANDIDATES = {
  candidates: [{ identity: SESSION, source: 'capsule' }],
  trace: [
    { source: 'claude_env', outcome: 'absent', reason: 'test fixture' },
    { source: 'hook_env', outcome: 'absent', reason: 'test fixture' },
    { source: 'capsule', outcome: 'admitted', count: 1 },
    { source: 'cursor_env', outcome: 'absent', reason: 'test fixture' },
  ],
};

function setupBoundWorktree(repoRoot, cawsDir, name, specId) {
  writeActiveSpec(cawsDir, specId);
  const createResult = createWorktree(cawsDir, {
    name,
    specId,
    session: SESSION,
    actor: ACTOR,
  });
  if (!createResult.ok) {
    throw new Error(
      'createWorktree failed: ' + JSON.stringify(createResult.errors)
    );
  }
  if (createResult.value.kind !== 'success') {
    throw new Error(
      'createWorktree non-success: ' + JSON.stringify(createResult.value)
    );
  }
  // Add a feature commit on the worktree branch so the merge has something
  // to integrate.
  const wtPath = path.join(cawsDir, 'worktrees', name);
  fs.writeFileSync(path.join(wtPath, 'feature.txt'), 'feature contents\n');
  execFileSync('git', ['-C', wtPath, 'add', 'feature.txt']);
  execFileSync('git', [
    '-C',
    wtPath,
    'commit',
    '--quiet',
    '-m',
    'feat: add feature.txt',
  ]);
  return wtPath;
}

describe('WORKTREE-MERGE-A2-FAULT-INJECTION-001 (fault-injection seam)', () => {
  let repo;
  let cawsDir;

  beforeEach(() => {
    repo = mkRepo('caws-a2fi-');
    cawsDir = setupCaws(repo);
    // Belt and braces: ensure no env var leaks in from a prior test.
    delete process.env[FAULT_ENV];
  });

  afterEach(() => {
    delete process.env[FAULT_ENV];
    rmrf(repo);
  });

  // ─────────────────────────────────────────────────────────────────
  // A4: happy path proves the seam is dormant when no fault is set.
  // Listed first so that if the seam regresses to always-fault, A4
  // surfaces it immediately.
  // ─────────────────────────────────────────────────────────────────

  test('A4: happy path — no fault injected, mergeWorktree succeeds end-to-end', () => {
    setupBoundWorktree(repo, cawsDir, 'wt-a4', 'A4FIX-001');

    const result = mergeWorktree(cawsDir, {
      name: 'wt-a4',
      session: SESSION,
      sessionCandidates: SESSION_CANDIDATES,
      actor: ACTOR,
    });

    expect(result.ok).toBe(true);
    expect(result.value.kind).toBe('success');
    expect(result.value.action).toBe('merged');

    // Spec is closed.
    const specBody = fs.readFileSync(
      path.join(cawsDir, 'specs', 'A4FIX-001.yaml'),
      'utf8'
    );
    expect(specBody).toMatch(/^lifecycle_state:\s*closed/m);

    // Events: spec_closed + worktree_merged appear.
    const events = readEvents(cawsDir);
    const kinds = events.map((e) => e.event);
    expect(kinds).toContain('spec_closed');
    expect(kinds).toContain('worktree_merged');
  });

  // ─────────────────────────────────────────────────────────────────
  // A1: fault induced -> mergeWorktree surfaces the honest failure.
  // ─────────────────────────────────────────────────────────────────

  test('A1: fault injected on closeSpec -> err(LIFECYCLE_PARTIAL_FAILURE_UNRECOVERED), spec remains active, worktree preserved', () => {
    setupBoundWorktree(repo, cawsDir, 'wt-a1', 'A1FIX-001');

    process.env[FAULT_ENV] = JSON.stringify({
      eventMatch: 'spec_closed',
      cause: 'a2-regression-test-injection',
    });

    const result = mergeWorktree(cawsDir, {
      name: 'wt-a1',
      session: SESSION,
      sessionCandidates: SESSION_CANDIDATES,
      actor: ACTOR,
    });

    // The whole point of A2: closeSpec rolled back, mergeWorktree must
    // err — not pretend success.
    expect(result.ok).toBe(false);
    const messages = result.errors.map((e) => e.message).join('\n');
    expect(messages).toMatch(/spec close transaction rolled back/i);
    // The diagnostic names the merge commit, per the spec invariant.
    expect(messages).toMatch(/\bcommit\s+[0-9a-f]{7,40}\b/i);
    // The diagnostic carries the cause string from the seam.
    const data = result.errors[0].data ?? {};
    const causeStr = JSON.stringify(data);
    expect(causeStr).toMatch(/a2-regression-test-injection/);

    // Spec status: still active (the close transaction rolled back).
    const specBody = fs.readFileSync(
      path.join(cawsDir, 'specs', 'A1FIX-001.yaml'),
      'utf8'
    );
    expect(specBody).toMatch(/^lifecycle_state:\s*active/m);

    // Worktree still present in the registry (not destroyed).
    const registry = JSON.parse(
      fs.readFileSync(path.join(cawsDir, 'worktrees.json'), 'utf8')
    );
    expect(registry['wt-a1']).toBeDefined();
    expect(registry['wt-a1'].specId).toBe('A1FIX-001');
  });

  // ─────────────────────────────────────────────────────────────────
  // A2: same setup, audit-log invariants under the fault.
  // ─────────────────────────────────────────────────────────────────

  test('A2: under injected fault, no spec_closed/worktree_merged/worktree_destroyed events appear', () => {
    setupBoundWorktree(repo, cawsDir, 'wt-a2', 'A2FIX-001');

    // Collect baseline event count (worktree_created + worktree_bound
    // from setup are expected, and they MUST remain unchanged).
    const baseline = readEvents(cawsDir);
    const baselineKinds = baseline.map((e) => e.event).sort();

    process.env[FAULT_ENV] = JSON.stringify({
      eventMatch: 'spec_closed',
      cause: 'a2-event-log-test',
    });

    const result = mergeWorktree(cawsDir, {
      name: 'wt-a2',
      session: SESSION,
      sessionCandidates: SESSION_CANDIDATES,
      actor: ACTOR,
    });
    expect(result.ok).toBe(false);

    const after = readEvents(cawsDir);
    const afterKinds = after.map((e) => e.event).sort();

    // No new lifecycle-completion events from the failed merge.
    expect(afterKinds).toEqual(baselineKinds);
    expect(afterKinds).not.toContain('spec_closed');
    expect(afterKinds).not.toContain('worktree_merged');
    expect(afterKinds).not.toContain('worktree_destroyed');
  });

  // ─────────────────────────────────────────────────────────────────
  // A3: operator-retry pattern — after fault cleared, retry succeeds.
  // ─────────────────────────────────────────────────────────────────

  test('A3: after first attempt fails, clearing the fault and retrying merges cleanly', () => {
    setupBoundWorktree(repo, cawsDir, 'wt-a3', 'A3FIX-001');

    process.env[FAULT_ENV] = JSON.stringify({
      eventMatch: 'spec_closed',
      cause: 'a3-first-attempt',
    });

    const first = mergeWorktree(cawsDir, {
      name: 'wt-a3',
      session: SESSION,
      sessionCandidates: SESSION_CANDIDATES,
      actor: ACTOR,
    });
    expect(first.ok).toBe(false);

    // Operator investigates, fixes the underlying problem, retries.
    delete process.env[FAULT_ENV];

    const second = mergeWorktree(cawsDir, {
      name: 'wt-a3',
      session: SESSION,
      sessionCandidates: SESSION_CANDIDATES,
      actor: ACTOR,
    });

    expect(second.ok).toBe(true);
    expect(second.value.kind).toBe('success');

    // Final state has spec_closed and worktree_merged.
    const events = readEvents(cawsDir);
    const kinds = events.map((e) => e.event);
    expect(kinds).toContain('spec_closed');
    expect(kinds).toContain('worktree_merged');
  });

  // ─────────────────────────────────────────────────────────────────
  // A5: production-refusal contract.
  // ─────────────────────────────────────────────────────────────────

  test('A5: seam refuses the env var when NODE_ENV != "test" and JEST_WORKER_ID is unset', () => {
    // Save and clear test markers.
    const savedNodeEnv = process.env.NODE_ENV;
    const savedJestWorker = process.env.JEST_WORKER_ID;
    process.env.NODE_ENV = 'production';
    delete process.env.JEST_WORKER_ID;

    try {
      // Set the fault env var. Without the test markers, the seam must
      // refuse to honor it.
      process.env[FAULT_ENV] = JSON.stringify({
        eventMatch: 'test_recorded',
        cause: 'a5-production-refusal-attempt',
      });

      // Run a plain runLifecycleTransaction with a valid event. If the
      // seam HONORED the env var, this would return
      // partial_failure_recovered. The seam must refuse, so the
      // transaction proceeds normally to ok({ kind: 'success' }).
      const target = path.join(repo, 'a5-target.txt');
      fs.writeFileSync(target, 'pre');

      const validEvent = {
        event: 'test_recorded',
        ts: new Date().toISOString(),
        actor: ACTOR,
        spec_id: 'A5FIX-001',
        data: { command: 'echo a5', exit_code: 0 },
      };

      const acquired = acquireLifecycleLock(cawsDir, {
        maxAttempts: 5,
        retryDelayMs: 10,
        staleThresholdMs: 60000,
      });
      if (!acquired.ok) throw new Error('lock acquire failed');
      let txnResult;
      try {
        txnResult = runLifecycleTransaction({
          cawsDir,
          plannedWrites: [{ path: target, contents: 'post' }],
          events: [validEvent],
        });
      } finally {
        releaseLifecycleLock(acquired.value);
      }

      // Without seam honoring the env var, the transaction succeeds.
      expect(txnResult.ok).toBe(true);
      expect(txnResult.value.kind).toBe('success');
      expect(fs.readFileSync(target, 'utf8')).toBe('post');
    } finally {
      if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = savedNodeEnv;
      if (savedJestWorker !== undefined) {
        process.env.JEST_WORKER_ID = savedJestWorker;
      }
      delete process.env[FAULT_ENV];
    }
  });
});
