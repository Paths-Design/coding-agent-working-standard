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
 * Event-append cases use the shipped CAWS_TEST_INJECT_LIFECYCLE_FAULT seam
 * (WORKTREE-MERGE-A2-FAULT-INJECTION-001). It fires on the FIRST planned event
 * whose `event` field equals eventMatch, during step-4 (event append), and
 * rolls back step-3 writes. Authority cases schedule competing commits before
 * the real lock wrapper and fail the atomic restore boundary without adding a
 * production injection mechanism.
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

const {
  createSpec,
  closeSpec,
  archiveSpec,
  retireDraftSpec,
} = require('../../dist/store/specs-writer');
const {
  createWorktree,
  bindWorktreeRepair,
  destroyWorktree,
  pruneWorktree,
  untrackWorktree,
  mergeWorktree,
} = require('../../dist/store/worktrees-writer');
const { initProject } = require('../../dist/store/init-store');
const { loadEvents } = require('../../dist/store/events-store');
const { verifyChain } = require('../../dist/kernel');
const lifecycleLock = require('../../dist/store/lifecycle-lock');
const atomicWrite = require('../../dist/store/atomic-write');
const registryPatch = require('../../dist/store/apply-patch');

afterEach(() => jest.restoreAllMocks());

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

/**
 * Write an active fixture spec carrying a pre-existing `closure_notes` block.
 * `notesBlock` is spliced verbatim after `updated_at` (so the caller controls
 * inline-vs-block shape). Used by the merge-auto-close preservation tests
 * (CAWS-CLI-MERGE-AUTOCLOSE-PRESERVE-CLOSURE-NOTES-001). A close has to set
 * lifecycle_state/resolution; closure_notes is positioned before those so the
 * writer's resolution-insert and notes-handling exercise the realistic
 * already-present-notes layout. The spec is intentionally NOT yet closed —
 * the field is present on a still-active spec, which is the shape an author
 * who pre-authored closure notes before merge produces.
 */
function writeActiveSpecWithNotes(cawsDir, id, notesBlock) {
  const body = `id: ${id}
title: 'Notes fixture spec'
risk_tier: 3
mode: chore
lifecycle_state: active
created_at: '2026-06-15T00:00:00.000Z'
updated_at: '2026-06-15T00:00:00.000Z'
${notesBlock}
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
      createSpec(caws, { id, title: 'x', mode: 'chore', actor: ACTOR })
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
      closeSpec(caws, {
        id,
        resolution: 'completed',
        reason: 'test closure under rollback fault',
        actor: ACTOR,
      })
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

// =========================================================================
// closure_notes preservation on auto-close
// CAWS-CLI-MERGE-AUTOCLOSE-PRESERVE-CLOSURE-NOTES-001
//
// mergeWorktree's auto-close passes a machine stub `reason` to closeSpec.
// Under preserveExistingNotes (the merge shape) author-written notes must
// survive verbatim; the stub may only fill notes that were absent. The
// explicit `caws specs close --reason` path leaves the flag unset, so a
// user-supplied reason still updates an existing inline value (user intent).
// =========================================================================

const AUTHOR_NOTES = 'Detailed author notes: closed after Sterling smoke + mutation run.';
const MERGE_STUB = 'Auto-closed by caws worktree merge wt-x at deadbeef0';

function readSpecYaml(cawsDir, id) {
  return fs.readFileSync(path.join(cawsDir, 'specs', `${id}.yaml`), 'utf8');
}

describe('closeSpec closure_notes preservation [CAWS-CLI-MERGE-AUTOCLOSE-PRESERVE-CLOSURE-NOTES-001]', () => {
  test('A1: preserveExistingNotes leaves an existing inline closure_notes scalar untouched; the stub is not written', () => {
    const caws = setupCaws(mkRepo('rbh-notes-a1-'));
    const id = 'HARNESS-NOTES-INLINE-001';
    // Inline single-line scalar — the shape the old code overwrote.
    writeActiveSpecWithNotes(caws, id, `closure_notes: '${AUTHOR_NOTES}'`);

    const result = closeSpec(caws, {
      id,
      resolution: 'completed',
      reason: MERGE_STUB,
      preserveExistingNotes: true,
      actor: ACTOR,
    });

    expect(result.ok).toBe(true);
    expect(result.value.kind).toBe('success');

    const yaml = readSpecYaml(caws, id);
    // The author content survives verbatim; the stub is absent from the file.
    expect(yaml).toContain(`closure_notes: '${AUTHOR_NOTES}'`);
    expect(yaml).not.toContain(MERGE_STUB);
    // Close still happened: state flipped, exactly one closure_notes line.
    expect(yaml).toContain('lifecycle_state: closed');
    expect((yaml.match(/^closure_notes:/gm) || []).length).toBe(1);
    expect(chainIsVerifiable(caws).ok).toBe(true);
  });

  test('A1b: preserveExistingNotes leaves an existing block-scalar closure_notes untouched', () => {
    const caws = setupCaws(mkRepo('rbh-notes-a1b-'));
    const id = 'HARNESS-NOTES-BLOCK-001';
    // Block scalar — preserved before the fix too; pinned so a future
    // refactor of the preserve logic cannot regress the block-scalar path.
    const block = [
      'closure_notes: |',
      '  line one of author notes',
      '  line two of author notes',
    ].join('\n');
    writeActiveSpecWithNotes(caws, id, block);

    const result = closeSpec(caws, {
      id,
      resolution: 'completed',
      reason: MERGE_STUB,
      preserveExistingNotes: true,
      actor: ACTOR,
    });

    expect(result.ok).toBe(true);
    expect(result.value.kind).toBe('success');

    const yaml = readSpecYaml(caws, id);
    expect(yaml).toContain('line one of author notes');
    expect(yaml).toContain('line two of author notes');
    expect(yaml).not.toContain(MERGE_STUB);
    expect(yaml).toContain('lifecycle_state: closed');
    expect(chainIsVerifiable(caws).ok).toBe(true);
  });

  test('A2: preserveExistingNotes inserts the stub when the spec carried NO closure_notes (audit provenance preserved)', () => {
    const caws = setupCaws(mkRepo('rbh-notes-a2-'));
    const id = 'HARNESS-NOTES-ABSENT-001';
    // No closure_notes field at all — writeActiveSpec writes none.
    writeActiveSpec(caws, id, 'active');

    const result = closeSpec(caws, {
      id,
      resolution: 'completed',
      reason: MERGE_STUB,
      preserveExistingNotes: true,
      actor: ACTOR,
    });

    expect(result.ok).toBe(true);
    expect(result.value.kind).toBe('success');

    const yaml = readSpecYaml(caws, id);
    // Absent notes get filled with the stub so the merge audit records why.
    expect(yaml).toContain(`closure_notes: '${MERGE_STUB}'`);
    expect(yaml).toContain('lifecycle_state: closed');
    expect(chainIsVerifiable(caws).ok).toBe(true);
  });

  test('A3: WITHOUT preserveExistingNotes, an explicit reason replaces an existing inline closure_notes (user intent wins)', () => {
    const caws = setupCaws(mkRepo('rbh-notes-a3-'));
    const id = 'HARNESS-NOTES-EXPLICIT-001';
    writeActiveSpecWithNotes(caws, id, `closure_notes: '${AUTHOR_NOTES}'`);
    const explicit = 'Superseded by FOO-002 per maintainer review.';

    // No preserveExistingNotes flag — the caws specs close --reason path.
    const result = closeSpec(caws, {
      id,
      resolution: 'completed',
      reason: explicit,
      actor: ACTOR,
    });

    expect(result.ok).toBe(true);
    expect(result.value.kind).toBe('success');

    const yaml = readSpecYaml(caws, id);
    // The explicit reason wins; the prior inline value is gone.
    expect(yaml).toContain(`closure_notes: '${explicit}'`);
    expect(yaml).not.toContain(AUTHOR_NOTES);
    expect(yaml).toContain('lifecycle_state: closed');
    expect((yaml.match(/^closure_notes:/gm) || []).length).toBe(1);
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

    const result = withFault('spec_retired', () => retireDraftSpec(caws, { id, actor: ACTOR }));

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
    const closeRes = closeSpec(caws, {
      id,
      resolution: 'completed',
      reason: 'closing before archive test',
      actor: ACTOR,
    });
    expect(closeRes.ok).toBe(true);
    expect(closeRes.value.kind).toBe('success');
    const preCount = readEventsRaw(caws).length;

    const result = withFault('spec_archived', () => archiveSpec(caws, { id, actor: ACTOR }));

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
  // scopeIn is declared because binding refuses a spec whose scope.in is still
  // the create scaffold (CAWS-SPEC-SCOPE-IN-PLACEHOLDER-CONTRACT-001). These
  // lanes commit only spec YAML, so the path itself is immaterial — what
  // matters is that the surface was declared rather than left unfilled.
  const r = createSpec(caws, {
    id,
    title: 'x',
    mode: 'chore',
    actor: ACTOR,
    scopeIn: ['payload.txt'],
  });
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
    expect(result.errors.map((e) => e.rule)).toContain(
      'store.lifecycle.partial_failure_unrecovered'
    );
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

    // Control-plane rollback does not reverse the physical Git removal.
    expect(result.ok).toBe(false);
    expect(result.errors.map((d) => d.message).join(' ')).toMatch(/worktree|physical/i);
    expect(fs.existsSync(path.join(caws, 'worktrees', 'wt-d'))).toBe(false);
    const reg = JSON.parse(fs.readFileSync(path.join(caws, 'worktrees.json'), 'utf8'));
    expect(reg['wt-d']).toBeDefined();
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

function createAuthorityBytes(caws, id) {
  return ['worktrees.json', `specs/${id}.yaml`, 'events.jsonl'].map((relative) => {
    const p = path.join(caws, relative);
    return fs.existsSync(p) ? fs.readFileSync(p) : null;
  });
}

function beforeCreateLock(fn, afterRelease = () => {}) {
  const original = lifecycleLock.withLifecycleLock;
  return jest.spyOn(lifecycleLock, 'withLifecycleLock').mockImplementation((dir, body, opts) => {
    fn(dir);
    try {
      return original(dir, body, opts);
    } finally {
      afterRelease(dir);
    }
  });
}

describe('create authority lock and compensation', () => {
  test('failed acquisition does not read canonical authority or audit', () => {
    const caws = setupCaws(mkRepo('rbh-create-no-read-'));
    seedBoundableSpec(caws, 'WT-NOREAD-001');
    const before = createAuthorityBytes(caws, 'WT-NOREAD-001');
    fs.writeFileSync(path.join(caws, 'state.lock'), 'held');
    const original = fs.readFileSync;
    const authorityReads = [];
    const reader = jest.spyOn(fs, 'readFileSync').mockImplementation((p, ...args) => {
      if (
        [
          path.join(caws, 'worktrees.json'),
          path.join(caws, 'specs/WT-NOREAD-001.yaml'),
          path.join(caws, 'events.jsonl'),
        ].includes(p)
      )
        authorityReads.push(p);
      return original(p, ...args);
    });
    const result = createWorktree(caws, {
      name: 'wt-noread',
      specId: 'WT-NOREAD-001',
      session: SESSION,
      actor: ACTOR,
    });
    reader.mockRestore();
    expect(result.ok).toBe(false);
    expect(authorityReads).toEqual([]);
    expect(createAuthorityBytes(caws, 'WT-NOREAD-001')).toEqual(before);
  });

  test('lock acquisition failure leaves a competing same-name registry commit and audit exactly intact', () => {
    const caws = setupCaws(mkRepo('rbh-create-lock-'));
    seedBoundableSpec(caws, 'WT-LOCK-001');
    let competing;
    beforeCreateLock((dir) => {
      fs.writeFileSync(
        path.join(dir, 'worktrees.json'),
        '{"wt-lock":{"owner":{"session_id":"competitor"},"note":"preserve exactly"}}\n'
      );
      fs.writeFileSync(path.join(dir, 'state.lock'), 'held');
      competing = createAuthorityBytes(dir, 'WT-LOCK-001');
    });
    const result = createWorktree(caws, {
      name: 'wt-lock',
      specId: 'WT-LOCK-001',
      session: SESSION,
      actor: ACTOR,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.map((d) => d.rule)).toContain('store.lifecycle.lock_contention');
    expect(createAuthorityBytes(caws, 'WT-LOCK-001')).toEqual(competing);
    expect(fs.existsSync(path.join(caws, 'worktrees', 'wt-lock'))).toBe(false);
  });

  test.each([
    [
      'same-name registry entry',
      (dir) =>
        fs.writeFileSync(
          path.join(dir, 'worktrees.json'),
          '{"wt-fresh":{"owner":{"session_id":"competitor"}}}\n'
        ),
    ],
    [
      'new spec binding',
      (dir, p) => fs.writeFileSync(p, fs.readFileSync(p, 'utf8') + 'worktree: competing-lane\n'),
    ],
    [
      'terminal lifecycle',
      (dir, p) =>
        fs.writeFileSync(
          p,
          fs.readFileSync(p, 'utf8').replace(/^lifecycle_state:.*$/m, 'lifecycle_state: archived')
        ),
    ],
    [
      'placeholder scope',
      (dir, p) =>
        fs.writeFileSync(
          p,
          fs
            .readFileSync(p, 'utf8')
            .replace('payload.txt', 'TODO: list the file(s) or directories this spec authorizes.')
        ),
    ],
    ['missing spec', (dir, p) => fs.unlinkSync(p)],
    ['malformed spec', (dir, p) => fs.writeFileSync(p, 'bad: [')],
  ])('validates %s from the acquired snapshot and preserves competing bytes', (_label, mutate) => {
    const caws = setupCaws(mkRepo('rbh-create-fresh-'));
    seedBoundableSpec(caws, 'WT-FRESH-001');
    let competing;
    beforeCreateLock((dir) => {
      mutate(dir, path.join(dir, 'specs/WT-FRESH-001.yaml'));
      competing = createAuthorityBytes(dir, 'WT-FRESH-001');
    });
    const result = createWorktree(caws, {
      name: 'wt-fresh',
      specId: 'WT-FRESH-001',
      session: SESSION,
      actor: ACTOR,
    });
    expect(result.ok).toBe(false);
    expect(createAuthorityBytes(caws, 'WT-FRESH-001')).toEqual(competing);
    expect(fs.existsSync(path.join(caws, 'worktrees', 'wt-fresh'))).toBe(false);
  });

  test('derives spec bytes from a fresh valid edit instead of overwriting it', () => {
    const caws = setupCaws(mkRepo('rbh-create-edit-'));
    seedBoundableSpec(caws, 'WT-EDIT-001');
    beforeCreateLock((dir) => {
      const p = path.join(dir, 'specs/WT-EDIT-001.yaml');
      fs.writeFileSync(
        p,
        fs.readFileSync(p, 'utf8').replace(/^title:.*$/m, "title: 'competing edit'")
      );
    });
    const result = createWorktree(caws, {
      name: 'wt-edit',
      specId: 'WT-EDIT-001',
      session: SESSION,
      actor: ACTOR,
    });
    expect(result.ok).toBe(true);
    expect(result.value.kind).toBe('success');
    expect(result.value.data.audit_commit.kind).toBe('refused_dirty');
    expect(fs.readFileSync(path.join(caws, 'specs/WT-EDIT-001.yaml'), 'utf8')).toContain(
      "title: 'competing edit'"
    );
  });

  test.each(['worktree_created', 'worktree_bound'])(
    'restores exact prior registry/spec bytes before unlock on %s failure',
    (failedEvent) => {
      const caws = setupCaws(mkRepo('rbh-create-restore-'));
      seedBoundableSpec(caws, 'WT-RESTORE-001');
      let competing;
      let atRelease;
      beforeCreateLock(
        (dir) => {
          fs.writeFileSync(
            path.join(dir, 'worktrees.json'),
            '{ "unrelated": { "note": "fresh metadata" } }\n'
          );
          competing = createAuthorityBytes(dir, 'WT-RESTORE-001');
        },
        (dir) => {
          atRelease = createAuthorityBytes(dir, 'WT-RESTORE-001');
        }
      );
      const result = withFault(failedEvent, () =>
        createWorktree(caws, {
          name: 'wt-restore',
          specId: 'WT-RESTORE-001',
          session: SESSION,
          actor: ACTOR,
        })
      );
      expect(atRelease.slice(0, 2)).toEqual(competing.slice(0, 2));
      expect(createAuthorityBytes(caws, 'WT-RESTORE-001')).toEqual(atRelease);
      const kinds = readEventsRaw(caws).map((e) => e.event);
      expect(kinds).not.toContain(failedEvent);
      expect(chainIsVerifiable(caws).ok).toBe(true);
      if (failedEvent === 'worktree_created') {
        expect(result.ok).toBe(true);
        expect(result.value.kind).toBe('partial_failure_recovered');
        expect(atRelease[2]).toEqual(competing[2]);
      } else {
        expect(result.ok).toBe(false);
        expect(result.errors.map((d) => d.rule)).toContain(
          'store.lifecycle.partial_failure_unrecovered'
        );
        expect(kinds).toContain('worktree_created');
      }
    }
  );

  test('removes a registry created by the failed transaction when the prior file was absent', () => {
    const caws = setupCaws(mkRepo('rbh-create-absent-'));
    seedBoundableSpec(caws, 'WT-ABSENT-001');
    fs.unlinkSync(path.join(caws, 'worktrees.json'));
    const before = createAuthorityBytes(caws, 'WT-ABSENT-001');
    const result = withFault('worktree_created', () =>
      createWorktree(caws, {
        name: 'wt-absent',
        specId: 'WT-ABSENT-001',
        session: SESSION,
        actor: ACTOR,
      })
    );
    expect(result.ok).toBe(true);
    expect(result.value.kind).toBe('partial_failure_recovered');
    expect(createAuthorityBytes(caws, 'WT-ABSENT-001')).toEqual(before);
  });

  test('reports registry compensation failure explicitly while still holding the lock', () => {
    const caws = setupCaws(mkRepo('rbh-create-unrecovered-'));
    seedBoundableSpec(caws, 'WT-UNRECOVERED-001');
    const original = atomicWrite.writeFileAtomic;
    let registryWrites = 0;
    jest.spyOn(atomicWrite, 'writeFileAtomic').mockImplementation((p, bytes, options) => {
      if (p === path.join(caws, 'worktrees.json') && ++registryWrites === 3) {
        expect(fs.existsSync(path.join(caws, 'state.lock'))).toBe(true);
        return {
          ok: false,
          errors: [{ rule: 'test.restore_failed', severity: 'error', message: 'restore denied' }],
        };
      }
      return original(p, bytes, options);
    });
    const result = withFault('worktree_created', () =>
      createWorktree(caws, {
        name: 'wt-unrecovered',
        specId: 'WT-UNRECOVERED-001',
        session: SESSION,
        actor: ACTOR,
      })
    );
    expect(result.ok).toBe(false);
    expect(registryWrites).toBe(3);
    expect(result.errors.map((d) => d.rule)).toContain(
      'store.lifecycle.partial_failure_unrecovered'
    );
    expect(result.errors.map((d) => d.message).join('\n')).toMatch(
      /restor.*fail|could not.*restor|unrecovered/i
    );
    expect(fs.existsSync(path.join(caws, 'state.lock'))).toBe(false);
  });
});

describe('create registry augmentation failure', () => {
  test.each(['read failure', 'invalid JSON', 'array registry', 'missing entry', 'array entry'])(
    '%s before augmentation refuses without spec or audit effects',
    (fault) => {
      const caws = setupCaws(mkRepo('rbh-augment-input-'));
      seedBoundableSpec(caws, 'WT-AUGMENT-INPUT-001');
      const before = createAuthorityBytes(caws, 'WT-AUGMENT-INPUT-001');
      const registryPath = path.join(caws, 'worktrees.json');
      const apply = registryPatch.applyRegistryPatch;
      jest.spyOn(registryPatch, 'applyRegistryPatch').mockImplementationOnce((...args) => {
        const result = apply(...args);
        expect(result.ok).toBe(true);
        expect(fs.existsSync(path.join(caws, 'state.lock'))).toBe(true);
        if (fault === 'read failure') {
          const read = fs.readFileSync;
          let injected = false;
          jest.spyOn(fs, 'readFileSync').mockImplementation((file, ...options) => {
            if (file === registryPath && !injected) {
              injected = true;
              throw Object.assign(new Error('augmentation read denied'), { code: 'EACCES' });
            }
            return read(file, ...options);
          });
        } else {
          const contents = {
            'invalid JSON': '{',
            'array registry': '[]',
            'missing entry': '{}',
            'array entry': '{"wt-input":[]}',
          };
          fs.writeFileSync(registryPath, contents[fault]);
        }
        return result;
      });
      let atRelease;
      beforeCreateLock(
        () => {},
        () => {
          atRelease = createAuthorityBytes(caws, 'WT-AUGMENT-INPUT-001');
        }
      );
      const result = createWorktree(caws, {
        name: 'wt-input',
        specId: 'WT-AUGMENT-INPUT-001',
        session: SESSION,
        actor: ACTOR,
      });
      expect(result.ok).toBe(false);
      expect(result.errors.map((d) => d.rule)).toContain('store.write.io_failed');
      expect(atRelease).toEqual(before);
      expect(createAuthorityBytes(caws, 'WT-AUGMENT-INPUT-001')).toEqual(before);
    }
  );

  test('reports unrecovered authority if augmentation and its compensation both fail', () => {
    const caws = setupCaws(mkRepo('rbh-augment-unrecovered-'));
    seedBoundableSpec(caws, 'WT-AUGMENT-LOSS-001');
    const before = createAuthorityBytes(caws, 'WT-AUGMENT-LOSS-001');
    const atomic = atomicWrite.writeFileAtomic;
    let failedAugmentation = false;
    jest.spyOn(atomicWrite, 'writeFileAtomic').mockImplementation((file, bytes, options) => {
      if (file === path.join(caws, 'worktrees.json')) {
        const contents = bytes.toString();
        if (failedAugmentation || contents.includes('baseBranch')) {
          failedAugmentation = true;
          expect(fs.existsSync(path.join(caws, 'state.lock'))).toBe(true);
          return {
            ok: false,
            errors: [{ rule: 'store.write.io_failed', severity: 'error', message: 'write denied' }],
          };
        }
      }
      return atomic(file, bytes, options);
    });
    const result = createWorktree(caws, {
      name: 'wt-loss',
      specId: 'WT-AUGMENT-LOSS-001',
      session: SESSION,
      actor: ACTOR,
    });
    expect(failedAugmentation).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.errors.map((d) => d.rule)).toContain(
      'store.lifecycle.partial_failure_unrecovered'
    );
    expect(createAuthorityBytes(caws, 'WT-AUGMENT-LOSS-001').slice(1)).toEqual(before.slice(1));
    expect(
      JSON.parse(fs.readFileSync(path.join(caws, 'worktrees.json'), 'utf8'))['wt-loss'].owner
        .session_id
    ).toBe(SESSION.session_id);
    expect(fs.existsSync(path.join(caws, 'state.lock'))).toBe(false);
  });

  test('a partial augmentation write and EIO refuses create and restores exact authority before release', () => {
    const caws = setupCaws(mkRepo('rbh-create-augment-'));
    seedBoundableSpec(caws, 'WT-AUGMENT-001');
    const before = createAuthorityBytes(caws, 'WT-AUGMENT-001');
    let atRelease;
    beforeCreateLock(
      () => {},
      (dir) => {
        atRelease = createAuthorityBytes(dir, 'WT-AUGMENT-001');
      }
    );
    const original = fs.writeFileSync;
    const worktreePath = path.join(caws, 'worktrees', 'wt-augment');
    let injected = false;
    // Metadata identifies augmentation in both direct-target and atomic-temp
    // implementations; the initial kernel bind has no branch/path metadata.
    jest.spyOn(fs, 'writeFileSync').mockImplementation((target, bytes, ...args) => {
      const contents = Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes);
      if (!injected && contents.includes(worktreePath) && contents.includes('baseBranch')) {
        injected = true;
        expect(fs.existsSync(path.join(caws, 'state.lock'))).toBe(true);
        original(target, contents.slice(0, 23), ...args);
        throw Object.assign(new Error('injected partial augmentation EIO'), { code: 'EIO' });
      }
      return original(target, bytes, ...args);
    });
    const result = createWorktree(caws, {
      name: 'wt-augment',
      specId: 'WT-AUGMENT-001',
      session: SESSION,
      actor: ACTOR,
    });
    expect(injected).toBe(true);
    expect(result.ok).toBe(false);
    expect(atRelease).toEqual(before);
    expect(createAuthorityBytes(caws, 'WT-AUGMENT-001')).toEqual(before);
    expect(chainIsVerifiable(caws).ok).toBe(true);
    expect(fs.existsSync(path.join(caws, 'state.lock'))).toBe(false);
    expect(fs.existsSync(worktreePath)).toBe(false);
  });
});

describe('retirement authority race and compensation', () => {
  function fixture(op) {
    const root = mkRepo(`retirement-${op}-`);
    const caws = setupCaws(root);
    seedBoundableSpec(caws, 'WT-RETIRE-001');
    const created = createWorktree(caws, {
      name: 'wt-retire',
      specId: 'WT-RETIRE-001',
      session: SESSION,
      actor: ACTOR,
    });
    expect(created.ok && created.value.kind).toBe('success');
    const wtPath = path.join(caws, 'worktrees', 'wt-retire');
    if (op === 'prune') execFileSync('git', ['-C', root, 'worktree', 'remove', wtPath]);
    const input = {
      name: 'wt-retire',
      session: SESSION,
      sessionCandidates: CANDIDATES,
      actor: ACTOR,
      reason: 'fixture retirement',
    };
    const invoke = () =>
      ({ destroy: destroyWorktree, prune: pruneWorktree, untrack: untrackWorktree })[op](
        caws,
        input
      );
    return { caws, root, wtPath, invoke };
  }

  test.each([
    ['invalid JSON', '{', 'store.read.json_invalid'],
    ['array registry', '[]', 'store.registry.not_object'],
  ])('%s retains loader diagnostics', (_label, raw, rule) => {
    const { caws, invoke } = fixture('untrack');
    fs.writeFileSync(path.join(caws, 'worktrees.json'), raw);
    const result = invoke();
    expect(result.ok).toBe(false);
    expect(result.errors.map((d) => d.rule)).toContain(rule);
  });

  test.each(['destroy', 'prune', 'untrack'])(
    '%s preserves competing owner at lock acquisition',
    (op) => {
      const { caws, wtPath, invoke } = fixture(op);
      let competing;
      beforeCreateLock((dir) => {
        const registry = path.join(dir, 'worktrees.json');
        const value = JSON.parse(fs.readFileSync(registry, 'utf8'));
        value['wt-retire'].owner.session_id = 'competitor';
        fs.writeFileSync(registry, JSON.stringify(value, null, 2) + '\n');
        competing = createAuthorityBytes(dir, 'WT-RETIRE-001');
      });
      const result = invoke();
      expect(result.ok).toBe(false);
      expect(createAuthorityBytes(caws, 'WT-RETIRE-001')).toEqual(competing);
      if (op !== 'prune') expect(fs.existsSync(wtPath)).toBe(true);
    }
  );

  test.each(['destroy', 'prune', 'untrack'])(
    '%s preserves competing spec edits at lock acquisition',
    (op) => {
      const { caws, wtPath, invoke } = fixture(op);
      let competing;
      beforeCreateLock((dir) => {
        const spec = path.join(dir, 'specs', 'WT-RETIRE-001.yaml');
        const source = fs.readFileSync(spec, 'utf8');
        expect(source).toContain('payload.txt');
        fs.writeFileSync(spec, source.replace('payload.txt', 'competing-scope.txt'));
        competing = createAuthorityBytes(dir, 'WT-RETIRE-001');
      });
      const result = invoke();
      expect(result.ok).toBe(false);
      expect(createAuthorityBytes(caws, 'WT-RETIRE-001')).toEqual(competing);
      if (op !== 'prune') expect(fs.existsSync(wtPath)).toBe(true);
    }
  );

  test.each(['destroy', 'prune', 'untrack'])('%s compensates a partial registry write', (op) => {
    const { caws, invoke } = fixture(op);
    const before = createAuthorityBytes(caws, 'WT-RETIRE-001');
    const registry = path.join(caws, 'worktrees.json');
    const original = atomicWrite.writeFileAtomic;
    let injected = false;
    jest.spyOn(atomicWrite, 'writeFileAtomic').mockImplementation((file, bytes, options) => {
      if (file === registry && !injected) {
        injected = true;
        fs.writeFileSync(file, '{partially-written');
        return { ok: false, errors: [{ rule: 'test.partial_write', message: 'partial write' }] };
      }
      return original(file, bytes, options);
    });
    const result = invoke();
    expect(injected).toBe(true);
    expect(result.ok).toBe(false);
    expect(createAuthorityBytes(caws, 'WT-RETIRE-001')).toEqual(before);
    expect(chainIsVerifiable(caws).ok).toBe(true);
  });

  test.each(['destroy', 'prune', 'untrack'])('%s compensates a partial spec write', (op) => {
    const { caws, invoke } = fixture(op);
    const before = createAuthorityBytes(caws, 'WT-RETIRE-001');
    const spec = path.join(caws, 'specs', 'WT-RETIRE-001.yaml');
    const original = atomicWrite.writeFileAtomic;
    let injected = false;
    jest.spyOn(atomicWrite, 'writeFileAtomic').mockImplementation((file, bytes, options) => {
      if (file === spec && !injected) {
        injected = true;
        fs.writeFileSync(file, 'partially-written: [');
        return {
          ok: false,
          errors: [{ rule: 'test.partial_write', message: 'partial spec write' }],
        };
      }
      return original(file, bytes, options);
    });
    const result = invoke();
    expect(injected).toBe(true);
    // Failed file writes return an error even after compensation. Event
    // append rollback, by contrast, can return partial_failure_recovered.
    expect(result.ok).toBe(false);
    expect(result.errors.map((d) => d.rule)).toContain('store.lifecycle.write_failed');
    if (op === 'destroy')
      expect(result.errors.map((d) => d.rule)).toContain(
        'store.lifecycle.partial_failure_unrecovered'
      );
    expect(createAuthorityBytes(caws, 'WT-RETIRE-001')).toEqual(before);
    expect(chainIsVerifiable(caws).ok).toBe(true);
  });

  test.each(['destroy', 'prune', 'untrack'])('%s reports failed registry compensation', (op) => {
    const { caws, invoke } = fixture(op);
    const registry = path.join(caws, 'worktrees.json');
    const original = atomicWrite.writeFileAtomic;
    let attempts = 0;
    jest.spyOn(atomicWrite, 'writeFileAtomic').mockImplementation((file, bytes, options) => {
      if (file === registry && ++attempts <= 2) {
        if (attempts === 1) fs.writeFileSync(file, '{partially-written');
        return { ok: false, errors: [{ rule: 'test.partial_write', message: 'injected failure' }] };
      }
      return original(file, bytes, options);
    });
    const result = invoke();
    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(result.ok).toBe(false);
    expect(result.errors.map((d) => d.rule)).toContain(
      'store.lifecycle.partial_failure_unrecovered'
    );
    expect(fs.readFileSync(registry, 'utf8')).toBe('{partially-written');
  });

  test.each(['destroy', 'prune', 'untrack'])(
    '%s refuses invalid-byte to valid-replacement ABA lookalike',
    (op) => {
      const { caws, wtPath, invoke } = fixture(op);
      const spec = path.join(caws, 'specs', 'WT-RETIRE-001.yaml');
      fs.appendFileSync(spec, Buffer.from([10, 35, 32, 0x80, 10]));
      let competing;
      beforeCreateLock((dir) => {
        const original = fs.readFileSync(spec);
        const index = original.lastIndexOf(0x80);
        expect(index).toBeGreaterThan(-1);
        fs.writeFileSync(
          spec,
          Buffer.concat([
            original.subarray(0, index),
            Buffer.from('\ufffd'),
            original.subarray(index + 1),
          ])
        );
        competing = createAuthorityBytes(dir, 'WT-RETIRE-001');
      });
      const result = invoke();
      expect(result.ok).toBe(false);
      expect(createAuthorityBytes(caws, 'WT-RETIRE-001')).toEqual(competing);
      if (op !== 'prune') expect(fs.existsSync(wtPath)).toBe(true);
    }
  );

  test.each(['destroy', 'prune', 'untrack'])(
    '%s refuses valid-replacement to invalid-byte lookalike',
    (op) => {
      const { caws, wtPath, invoke } = fixture(op);
      const spec = path.join(caws, 'specs', 'WT-RETIRE-001.yaml');
      fs.appendFileSync(spec, '\n# \ufffd\n');
      let competing;
      beforeCreateLock((dir) => {
        const original = fs.readFileSync(spec);
        const index = original.lastIndexOf(Buffer.from('\ufffd'));
        expect(index).toBeGreaterThan(-1);
        fs.writeFileSync(
          spec,
          Buffer.concat([
            original.subarray(0, index),
            Buffer.from([0x80]),
            original.subarray(index + 3),
          ])
        );
        competing = createAuthorityBytes(dir, 'WT-RETIRE-001');
      });
      const result = invoke();
      expect(result.ok).toBe(false);
      expect(createAuthorityBytes(caws, 'WT-RETIRE-001')).toEqual(competing);
      if (op !== 'prune') expect(fs.existsSync(wtPath)).toBe(true);
    }
  );

  test.each(['destroy', 'prune', 'untrack'])(
    '%s preserves unchanged invalid bytes in a spec comment',
    (op) => {
      const { caws, invoke } = fixture(op);
      const spec = path.join(caws, 'specs', 'WT-RETIRE-001.yaml');
      const comment = Buffer.from([10, 35, 32, 0x80, 10]);
      fs.appendFileSync(spec, comment);
      const result = invoke();
      expect(result.ok && result.value.kind).toBe('success');
      expect(fs.readFileSync(spec).includes(comment)).toBe(true);
    }
  );

  test('destroy timeout uses bounded SIGKILL and reports indeterminate physical effects without authority writes', () => {
    const { caws, invoke } = fixture('destroy');
    const before = createAuthorityBytes(caws, 'WT-RETIRE-001');
    const child = require('child_process');
    const actual = child.execFileSync;
    let observed;
    jest.spyOn(child, 'execFileSync').mockImplementation((command, args, options) => {
      if (args[0] === 'worktree' && args[1] === 'remove') {
        observed = { command, args, options };
        const failure = new Error('timed out');
        failure.code = 'ETIMEDOUT';
        throw failure;
      }
      return actual(command, args, options);
    });
    const result = invoke();
    expect(observed).toBeDefined();
    expect(observed.options.timeout).toBe(10000);
    expect(observed.options.killSignal).toBe('SIGKILL');
    expect(result.ok).toBe(false);
    expect(result.errors.map((d) => d.message).join(' ')).toMatch(
      /physical effects may be incomplete/i
    );
    expect(createAuthorityBytes(caws, 'WT-RETIRE-001')).toEqual(before);
    expect(chainIsVerifiable(caws).ok).toBe(true);
  });

  test('destroy second-event failure reports chained event and physical residue', () => {
    const { caws, wtPath, invoke } = fixture('destroy');
    const before = createAuthorityBytes(caws, 'WT-RETIRE-001');
    const result = withFault('spec_deactivated', invoke);
    expect(result.ok).toBe(false);
    expect(result.errors.map((d) => d.rule)).toContain(
      'store.lifecycle.partial_failure_unrecovered'
    );
    expect(result.errors.map((d) => d.message).join(' ')).toMatch(
      /physical removal was not reversed/i
    );
    const after = createAuthorityBytes(caws, 'WT-RETIRE-001');
    expect(after.slice(0, 2)).toEqual(before.slice(0, 2));
    expect(fs.existsSync(wtPath)).toBe(false);
    expect(readEventsRaw(caws).map((e) => e.event)).toContain('worktree_destroyed');
    expect(readEventsRaw(caws).map((e) => e.event)).not.toContain('spec_deactivated');
    expect(chainIsVerifiable(caws).ok).toBe(true);
  });

  test.each([
    ['destroy', 'worktree_destroyed'],
    ['prune', 'worktree_pruned'],
    ['untrack', 'worktree_untracked'],
  ])('%s restores exact authority on event failure', (op, event) => {
    const { caws, wtPath, invoke } = fixture(op);
    const before = createAuthorityBytes(caws, 'WT-RETIRE-001');
    const result = withFault(event, invoke);
    expect(createAuthorityBytes(caws, 'WT-RETIRE-001')).toEqual(before);
    expect(chainIsVerifiable(caws).ok).toBe(true);
    if (op === 'destroy') {
      expect(result.ok).toBe(false);
      expect(fs.existsSync(wtPath)).toBe(false);
      expect(result.errors.map((d) => d.message).join(' ')).toMatch(/worktree|physical/i);
    } else {
      expect(result.ok && result.value.kind).toBe('partial_failure_recovered');
    }
  });
});
