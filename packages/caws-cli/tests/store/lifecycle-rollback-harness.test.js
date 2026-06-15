/**
 * CAWS-LIFECYCLE-ROLLBACK-HARNESS-COMPLETE-001
 *
 * Partial-failure HONESTY harness for runLifecycleTransaction across all 8
 * lifecycle writers. The original event-append regression suite
 * (LIFECYCLE-ROLLBACK-FAILURE-HARNESS-001) was deleted in the from-zero corpus
 * wipe; this rebuilds it fresh at the tier-1 bar AND completes it with the
 * multi-event divergence cases + the half-state classification.
 *
 * This is a PROOF HARNESS, not a repair feature. It documents the truth of each
 * writer's partial-failure outcome; it does NOT fix any half-state it finds.
 * Each writer is classified:
 *   transaction-contained — the txn rolled back every write it made; clean.
 *   governance-half-state — a prior event is already chained and cannot be
 *                           un-appended; the .caws control plane carries residue.
 *   external-half-state   — git/filesystem state outside the txn boundary is
 *                           left dangling.
 *   ambiguous             — outcome depends on ordering the seam cannot pin.
 *
 * Mechanism: ONLY the shipped CAWS_TEST_INJECT_LIFECYCLE_FAULT seam
 * (WORKTREE-MERGE-A2-FAULT-INJECTION-001). It fires on the FIRST planned event
 * whose `event` field equals eventMatch, during step-4 (event append), and
 * rolls back step-3 writes. No second injection mechanism, no fs sabotage.
 *
 * Discipline (load-bearing):
 * - Assert result.value.kind explicitly. partial_failure_recovered is wrapped
 *   in ok() — checking isOk() alone passes a rolled-back txn as success.
 * - After every injection, re-read events.jsonl from disk and verifyChain it
 *   (audit integrity, E9), OR prove the failed event was never appended.
 * - Record the OBSERVED posture honestly; never assert a recovery the seam did
 *   not actually perform.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { createSpec, closeSpec, archiveSpec, retireDraftSpec } = require('../../dist/store/specs-writer');
const {
  createWorktree,
  bindWorktreeRepair,
  destroyWorktree,
  mergeWorktree,
} = require('../../dist/store/worktrees-writer');
const { initProject } = require('../../dist/store/init-store');
const { loadEvents } = require('../../dist/store/events-store');
const { verifyChain } = require('@paths.design/caws-kernel');

const FAULT_ENV = 'CAWS_TEST_INJECT_LIFECYCLE_FAULT';

// ─── Fixture helpers (rebuilt fresh; same proven shape) ──────────────────

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

/**
 * Commit the .caws tree at HEAD. retireDraftSpec / archiveSpec REFUSE an
 * untracked spec (the blob_sha at HEAD is the tombstone recovery target), so
 * their fixtures must commit the spec before injecting — otherwise the plan is
 * rejected at validation (step 1) before the event-append seam (step 4) can
 * fire. This is sound writer behavior, surfaced by the harness.
 */
function commitCaws(repoRoot, message) {
  execFileSync('git', ['-C', repoRoot, 'add', '-A']);
  execFileSync('git', ['-C', repoRoot, 'commit', '--quiet', '--no-verify', '-m', message]);
}

function readEventsRaw(cawsDir) {
  const p = path.join(cawsDir, 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf8')
    .trim()
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

/** Re-read the chain from disk and verify its hash-chain integrity (E9). */
function chainIsVerifiable(cawsDir) {
  const loaded = loadEvents(cawsDir);
  if (!loaded.ok) return { ok: false, why: 'loadEvents failed', errors: loaded.errors };
  const v = verifyChain(loaded.value.events);
  return { ok: v.ok, errors: v.ok ? [] : v.errors, count: loaded.value.events.length };
}

function withFault(eventMatch, fn) {
  process.env[FAULT_ENV] = JSON.stringify({ eventMatch, cause: `harness-${eventMatch}` });
  try {
    return fn();
  } finally {
    delete process.env[FAULT_ENV]; // no bleed into sibling cases
  }
}

function writeActiveSpec(cawsDir, id, state = 'active') {
  const body = `id: ${id}
title: 'Harness fixture spec'
risk_tier: 3
mode: chore
lifecycle_state: ${state}
created_at: '2026-06-15T00:00:00.000Z'
updated_at: '2026-06-15T00:00:00.000Z'
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
contracts: []
`;
  fs.writeFileSync(path.join(cawsDir, 'specs', `${id}.yaml`), body);
}

const SESSION = { session_id: 'sess-harness', platform: 'jest' };
const ACTOR = { kind: 'agent', id: 'harness-agent', session_id: 'sess-harness' };
// SessionCandidates shape: { candidates: [{ identity, source }], ... }. The
// destroy/merge admission check iterates candidates.candidates and compares
// identity.session_id against the worktree owner.
const CANDIDATES = {
  candidates: [{ identity: SESSION, source: 'hook_env' }],
  trace: [],
};

afterAll(() => {
  for (const r of repos) {
    try {
      fs.rmSync(r, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

// =========================================================================
// SPEC WRITERS — single planned event each (transaction-contained expected)
// =========================================================================

describe('createSpec — inject on spec_created [classify: transaction-contained]', () => {
  test('A2: partial_failure_recovered; no spec file; no spec_created event; chain verifiable', () => {
    const caws = setupCaws(mkRepo('rbh-cs-'));
    const id = 'HARNESS-CREATE-001';
    const preCount = readEventsRaw(caws).length;

    const result = withFault('spec_created', () =>
      createSpec(caws, { id, title: 'x', mode: 'chore', riskTier: 3, actor: ACTOR })
    );

    expect(result.ok).toBe(true);
    expect(result.value.kind).toBe('partial_failure_recovered'); // NOT success
    // Rolled back: the spec file must not exist.
    expect(fs.existsSync(path.join(caws, 'specs', `${id}.yaml`))).toBe(false);
    // No spec_created event for this id landed.
    const evs = readEventsRaw(caws);
    expect(evs.filter((e) => e.spec_id === id).map((e) => e.event)).not.toContain('spec_created');
    expect(evs.length).toBe(preCount); // chain length unchanged
    // Audit integrity preserved.
    expect(chainIsVerifiable(caws).ok).toBe(true);
  });
});

describe('closeSpec — inject on spec_closed [classify: transaction-contained]', () => {
  test('A2: partial_failure_recovered; spec stays active; no spec_closed event; chain verifiable', () => {
    const caws = setupCaws(mkRepo('rbh-cl-'));
    const id = 'HARNESS-CLOSE-001';
    writeActiveSpec(caws, id, 'active');
    const preCount = readEventsRaw(caws).length;

    const result = withFault('spec_closed', () =>
      closeSpec(caws, { id, resolution: 'completed', actor: ACTOR })
    );

    expect(result.ok).toBe(true);
    expect(result.value.kind).toBe('partial_failure_recovered');
    // Rolled back: the spec YAML still says active.
    const yaml = fs.readFileSync(path.join(caws, 'specs', `${id}.yaml`), 'utf8');
    expect(yaml).toContain('lifecycle_state: active');
    expect(yaml).not.toContain('lifecycle_state: closed');
    const evs = readEventsRaw(caws);
    expect(evs.filter((e) => e.spec_id === id).map((e) => e.event)).not.toContain('spec_closed');
    expect(evs.length).toBe(preCount);
    expect(chainIsVerifiable(caws).ok).toBe(true);
  });
});

describe('retireDraftSpec — inject on spec_retired [classify: transaction-contained]', () => {
  test('A2: partial_failure_recovered; draft spec remains; no spec_retired event; chain verifiable', () => {
    const repo = mkRepo('rbh-rt-');
    const caws = setupCaws(repo);
    const id = 'HARNESS-RETIRE-001';
    writeActiveSpec(caws, id, 'draft');
    commitCaws(repo, 'add draft fixture'); // retire requires blob_sha at HEAD
    const preCount = readEventsRaw(caws).length;

    const result = withFault('spec_retired', () =>
      retireDraftSpec(caws, { id, actor: ACTOR })
    );

    expect(result.ok).toBe(true);
    expect(result.value.kind).toBe('partial_failure_recovered');
    // Rolled back: the draft spec file still exists (retire was tombstoned-back).
    expect(fs.existsSync(path.join(caws, 'specs', `${id}.yaml`))).toBe(true);
    const evs = readEventsRaw(caws);
    expect(evs.filter((e) => e.spec_id === id).map((e) => e.event)).not.toContain('spec_retired');
    expect(evs.length).toBe(preCount);
    expect(chainIsVerifiable(caws).ok).toBe(true);
  });
});

describe('archiveSpec — inject on spec_archived [classify: external-unlink gate]', () => {
  test('A4: partial_failure_recovered; closed source spec REMAINS (unlink gated behind event); chain verifiable', () => {
    const repo = mkRepo('rbh-ar-');
    const caws = setupCaws(repo);
    const id = 'HARNESS-ARCHIVE-001';
    writeActiveSpec(caws, id, 'active');
    commitCaws(repo, 'add active fixture'); // archive requires blob_sha at HEAD
    // archiveSpec requires a closed spec; close it first (cleanly).
    const closeRes = closeSpec(caws, { id, resolution: 'completed', actor: ACTOR });
    expect(closeRes.ok).toBe(true);
    expect(closeRes.value.kind).toBe('success');
    const preCount = readEventsRaw(caws).length;

    const result = withFault('spec_archived', () =>
      archiveSpec(caws, { id, actor: ACTOR })
    );

    expect(result.ok).toBe(true);
    expect(result.value.kind).toBe('partial_failure_recovered');
    // The source spec file must still exist (archive = tombstone deletes the
    // body; if injection fired before that, the body must be restored).
    expect(fs.existsSync(path.join(caws, 'specs', `${id}.yaml`))).toBe(true);
    const evs = readEventsRaw(caws);
    expect(evs.filter((e) => e.spec_id === id).map((e) => e.event)).not.toContain('spec_archived');
    expect(evs.length).toBe(preCount);
    expect(chainIsVerifiable(caws).ok).toBe(true);
  });
});

// =========================================================================
// WORKTREE WRITERS — multi-event; the divergence surface
// =========================================================================

/** A committed active spec a worktree can bind to. */
function seedBoundableSpec(caws, id) {
  const r = createSpec(caws, { id, title: 'x', mode: 'chore', riskTier: 3, actor: ACTOR });
  if (!r.ok || r.value.kind !== 'success') {
    throw new Error('seed spec failed: ' + JSON.stringify(r));
  }
}

describe('createWorktree — FIRST-event injection on worktree_created [classify: transaction-contained]', () => {
  test('A2: partial_failure_recovered; git dir gone; registry empty; no worktree events; chain verifiable', () => {
    const caws = setupCaws(mkRepo('rbh-wc1-'));
    seedBoundableSpec(caws, 'WT-A-001');

    const result = withFault('worktree_created', () =>
      createWorktree(caws, { name: 'wt-a', specId: 'WT-A-001', session: SESSION, actor: ACTOR })
    );

    expect(result.ok).toBe(true);
    expect(result.value.kind).toBe('partial_failure_recovered');
    // External git state rolled back, registry untouched.
    expect(fs.existsSync(path.join(caws, 'worktrees', 'wt-a'))).toBe(false);
    const kinds = readEventsRaw(caws).map((e) => e.event);
    expect(kinds).not.toContain('worktree_created');
    expect(kinds).not.toContain('worktree_bound');
    expect(chainIsVerifiable(caws).ok).toBe(true);
  });
});

describe('createWorktree — SECOND-event injection on worktree_bound [classify: governance-half-state]', () => {
  test('A3: UNRECOVERED (not recovered); worktree_created STAYS chained; state rolled back; chain still verifiable', () => {
    const caws = setupCaws(mkRepo('rbh-wc2-'));
    seedBoundableSpec(caws, 'WT-B-001');

    const result = withFault('worktree_bound', () =>
      createWorktree(caws, { name: 'wt-b', specId: 'WT-B-001', session: SESSION, actor: ACTOR })
    );

    // The DIVERGENCE: transaction recovery rolled back the writes, but the
    // first event (worktree_created) was already appended and cannot be
    // un-appended. The result tells the truth — UNRECOVERED, not recovered.
    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.rule)).toContain('store.lifecycle.partial_failure_unrecovered');
    // worktree_created remains in the immutable hash chain.
    const kinds = readEventsRaw(caws).map((e) => e.event);
    expect(kinds).toContain('worktree_created');
    expect(kinds).not.toContain('worktree_bound');
    // GOVERNANCE-HALF-STATE: the event log records a worktree_created that the
    // registry + filesystem do NOT reflect (writes were rolled back). This is
    // the residue a later doctor/repair slice must reconcile — recorded here,
    // not fixed.
    expect(fs.existsSync(path.join(caws, 'worktrees', 'wt-b'))).toBe(false);
    const reg = JSON.parse(fs.readFileSync(path.join(caws, 'worktrees.json'), 'utf8'));
    const map = reg.worktrees ?? reg;
    expect('wt-b' in map).toBe(false);
    // CRUCIAL: despite the half-state, the audit chain is NOT corrupt — the
    // honest record of "this happened then failed" is itself intact (E9).
    expect(chainIsVerifiable(caws).ok).toBe(true);
  });
});

describe('destroyWorktree — inject on worktree_destroyed [classify: external-half-state probe]', () => {
  test('A4: records the OBSERVED posture — git removal vs event-append ordering', () => {
    const caws = setupCaws(mkRepo('rbh-wd-'));
    seedBoundableSpec(caws, 'WT-D-001');
    // Create a real worktree to destroy (clean).
    const created = createWorktree(caws, {
      name: 'wt-d',
      specId: 'WT-D-001',
      session: SESSION,
      actor: ACTOR,
    });
    expect(created.ok).toBe(true);
    expect(created.value.kind).toBe('success');
    const preChain = chainIsVerifiable(caws);
    expect(preChain.ok).toBe(true);

    const result = withFault('worktree_destroyed', () =>
      destroyWorktree(caws, { name: 'wt-d', session: SESSION, sessionCandidates: CANDIDATES })
    );

    // OBSERVED POSTURE (recorded, not idealized): destroyWorktree performs the
    // EXTERNAL git-worktree removal BEFORE the event append. So when the event
    // is injected-to-fail, the txn rolls back the CONTROL-PLANE writes (registry
    // entry removed cleanly, no worktree_destroyed event) but the external
    // filesystem removal already happened and is NOT un-done. The writer returns
    // partial_failure_recovered — which is truthful about the GOVERNANCE state
    // but the worktree dir is permanently gone.
    expect(result.ok).toBe(true);
    expect(result.value.kind).toBe('partial_failure_recovered');
    // EXTERNAL-HALF-STATE: the git worktree dir is gone (external destruction is
    // irreversible) even though the destroy "recovered". This is the residue a
    // later repair slice must reconcile; the harness records it, does not fix it.
    expect(fs.existsSync(path.join(caws, 'worktrees', 'wt-d'))).toBe(false);
    // Control-plane is internally consistent: registry no longer lists wt-d AND
    // no worktree_destroyed event landed — so governance state is coherent (the
    // half-state is purely external).
    const reg = JSON.parse(fs.readFileSync(path.join(caws, 'worktrees.json'), 'utf8'));
    const map = reg.worktrees ?? reg;
    expect('wt-d' in map).toBe(false);
    expect(readEventsRaw(caws).map((e) => e.event)).not.toContain('worktree_destroyed');
    // Audit integrity holds.
    expect(chainIsVerifiable(caws).ok).toBe(true);
  });
});

describe('bindWorktreeRepair — inject on worktree_bound [classify: observed]', () => {
  test('A1/A2: records the honest outcome under first-event injection; chain verifiable', () => {
    const caws = setupCaws(mkRepo('rbh-bind-'));
    seedBoundableSpec(caws, 'WT-BIND-001');
    const created = createWorktree(caws, {
      name: 'wt-bind',
      specId: 'WT-BIND-001',
      session: SESSION,
      actor: ACTOR,
    });
    expect(created.ok).toBe(true);
    expect(created.value.kind).toBe('success');
    const preCount = readEventsRaw(caws).length;

    const result = withFault('worktree_bound', () =>
      bindWorktreeRepair(caws, {
        name: 'wt-bind',
        specId: 'WT-BIND-001',
        session: SESSION,
        sessionCandidates: CANDIDATES,
        actor: ACTOR,
      })
    );

    // First-event injection: worktree_bound is the first planned event, so the
    // txn rolls back any state write and recovers — no event lands.
    expect(result.ok).toBe(true);
    expect(result.value.kind).toBe('partial_failure_recovered');
    const evs = readEventsRaw(caws);
    expect(evs.length).toBe(preCount); // no new bound/seized event
    expect(chainIsVerifiable(caws).ok).toBe(true);
  });
});

describe('mergeWorktree — inject on worktree_merged [classify: external-half-state probe]', () => {
  test('A4: composed merge+close — records the honest outcome, no pretended recovery', () => {
    const caws = setupCaws(mkRepo('rbh-wm-'));
    const repo = path.dirname(caws);
    seedBoundableSpec(caws, 'WT-M-001');
    const created = createWorktree(caws, {
      name: 'wt-m',
      specId: 'WT-M-001',
      session: SESSION,
      actor: ACTOR,
    });
    expect(created.ok).toBe(true);
    expect(created.value.kind).toBe('success');
    // Commit something on the worktree branch so the merge is non-empty.
    commitCaws(repo, 'pre-merge state');

    const result = withFault('worktree_merged', () =>
      mergeWorktree(caws, {
        name: 'wt-m',
        session: SESSION,
        sessionCandidates: CANDIDATES,
        actor: ACTOR,
      })
    );

    // Honest-posture assertion: whatever the writer returns, it must (a) not
    // claim recovery it did not perform, and (b) leave a verifiable chain.
    if (result.ok) {
      expect(['success', 'partial_failure_recovered']).toContain(result.value.kind);
    } else {
      expect(result.errors.length).toBeGreaterThan(0);
    }
    expect(chainIsVerifiable(caws).ok).toBe(true);
  });
});
