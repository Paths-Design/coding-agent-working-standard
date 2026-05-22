/**
 * LIFECYCLE-ROLLBACK-FAILURE-HARNESS-001
 *
 * Adversarial fault-injection regression coverage for the
 * event-append failure boundary of runLifecycleTransaction across
 * every current direct caller in specs-writer.ts and worktrees-writer.ts.
 *
 * Mechanism: the shipped CAWS_TEST_INJECT_LIFECYCLE_FAULT seam (added by
 * WORKTREE-MERGE-A2-FAULT-INJECTION-001). No second injection mechanism.
 *
 * mergeWorktree event-append-boundary coverage is discharged by
 * worktree-merge-a2-fault-injection.test.js; A6 here is a sentinel that
 * fails if that test file disappears.
 *
 * Acceptance shape (from the spec):
 *   A1 — every direct caller has a test (or discharged equivalent)
 *   A2 — single-event callers produce ok({kind:'partial_failure_recovered'})
 *   A3 — archiveSpec source-unlink gate
 *   A4 — createWorktree first-event injection (recovered + compensation)
 *   A5 — createWorktree second-event injection (UNRECOVERED + compensation)
 *   A6 — mergeWorktree coverage discharged (sentinel)
 *   A7 — full store suite green; no production diff
 *
 * Discipline:
 * - Tests assert on result.value.kind (or typed err diagnostics), never
 *   on isOk(result) alone. Reason: partial_failure_recovered is wrapped
 *   in ok() and was misread as success during the A2 implementation.
 * - Tests assert file bytes / registry shape / event-log filtering, not
 *   just return values.
 * - For callers with external side effects that occur outside the
 *   transaction boundary (bindWorktreeRepair, destroyWorktree), the
 *   test records the observed posture honestly rather than asserting a
 *   pretended recovery. Findings feed PRUNE-REPAIR-WORKTREE-001.
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
} = require('../../dist/store/specs-writer');
const {
  createWorktree,
  bindWorktreeRepair,
  destroyWorktree,
} = require('../../dist/store/worktrees-writer');
const { initProject } = require('../../dist/store/init-store');

const FAULT_ENV = 'CAWS_TEST_INJECT_LIFECYCLE_FAULT';

// ─── Fixture helpers ─────────────────────────────────────────────────────

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
title: 'Harness fixture spec'
risk_tier: 3
mode: chore
lifecycle_state: active
created_at: '2026-05-22T00:00:00.000Z'
updated_at: '2026-05-22T00:00:00.000Z'
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

function withFault(eventMatch, fn) {
  process.env[FAULT_ENV] = JSON.stringify({
    eventMatch,
    cause: `harness-injection-${eventMatch}`,
  });
  try {
    return fn();
  } finally {
    delete process.env[FAULT_ENV];
  }
}

const SESSION = { session_id: 'sess-harness', platform: 'jest' };
const ACTOR = {
  kind: 'agent',
  id: 'harness-agent',
  session_id: 'sess-harness',
};

// ─── Test suite ──────────────────────────────────────────────────────────

describe('LIFECYCLE-ROLLBACK-FAILURE-HARNESS-001 (event-append boundary)', () => {
  let repo;
  let cawsDir;

  beforeEach(() => {
    repo = mkRepo('caws-lrfh-');
    cawsDir = setupCaws(repo);
    delete process.env[FAULT_ENV];
  });

  afterEach(() => {
    delete process.env[FAULT_ENV];
    rmrf(repo);
  });

  // ──────────────────────────────────────────────────────────────────────
  // A2 — createSpec (single-event: spec_created)
  // ──────────────────────────────────────────────────────────────────────

  describe('createSpec (single-event)', () => {
    test('A2: injection on spec_created -> partial_failure_recovered; no spec file, no event', () => {
      const id = 'HARNESS-CREATE-001';
      const specFile = path.join(cawsDir, 'specs', `${id}.yaml`);
      expect(fs.existsSync(specFile)).toBe(false);

      const result = withFault('spec_created', () =>
        createSpec(cawsDir, {
          id,
          title: 'harness create injection target',
          mode: 'chore',
          riskTier: 3,
          actor: ACTOR,
        })
      );

      // Outcome inspection (not isOk alone).
      expect(result.ok).toBe(true);
      expect(result.value.kind).toBe('partial_failure_recovered');

      // File rollback: the spec file was a fresh write (snapshot was
      // "did not exist"); rollback must remove it.
      expect(fs.existsSync(specFile)).toBe(false);

      // Event log: no spec_created event for this id.
      const events = readEvents(cawsDir).filter((e) => e.spec_id === id);
      const kinds = events.map((e) => e.event);
      expect(kinds).not.toContain('spec_created');
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // A2 — closeSpec (single-event: spec_closed)
  // ──────────────────────────────────────────────────────────────────────

  describe('closeSpec (single-event)', () => {
    test('A2: injection on spec_closed -> partial_failure_recovered; spec stays active; no event', () => {
      const id = 'HARNESS-CLOSE-001';
      writeActiveSpec(cawsDir, id);
      const specFile = path.join(cawsDir, 'specs', `${id}.yaml`);
      const preBytes = fs.readFileSync(specFile, 'utf8');

      const result = withFault('spec_closed', () =>
        closeSpec(cawsDir, {
          id,
          resolution: 'completed',
          reason: 'harness',
          actor: ACTOR,
        })
      );

      expect(result.ok).toBe(true);
      expect(result.value.kind).toBe('partial_failure_recovered');

      // File rollback: byte-identical to pre-call.
      const postBytes = fs.readFileSync(specFile, 'utf8');
      expect(postBytes).toBe(preBytes);
      expect(postBytes).toMatch(/^lifecycle_state:\s*active/m);

      // Event log: no spec_closed event for this id.
      const events = readEvents(cawsDir).filter((e) => e.spec_id === id);
      expect(events.map((e) => e.event)).not.toContain('spec_closed');
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // A3 — archiveSpec source-unlink gate
  // ──────────────────────────────────────────────────────────────────────

  describe('archiveSpec (single-event + external unlink gate)', () => {
    test('A3: injection on spec_archived -> partial_failure_recovered; source file remains; archive absent', () => {
      const id = 'HARNESS-ARCHIVE-001';
      writeActiveSpec(cawsDir, id);
      // archiveSpec requires the spec to be closed first (close before
      // archive in CAWS lifecycle).
      const closeRes = closeSpec(cawsDir, {
        id,
        resolution: 'completed',
        actor: ACTOR,
      });
      expect(closeRes.ok).toBe(true);
      expect(closeRes.value.kind).toBe('success');

      const fromPath = path.join(cawsDir, 'specs', `${id}.yaml`);
      const toPath = path.join(cawsDir, 'specs', '.archive', `${id}.yaml`);
      expect(fs.existsSync(fromPath)).toBe(true);
      expect(fs.existsSync(toPath)).toBe(false);
      const preFromBytes = fs.readFileSync(fromPath, 'utf8');

      const result = withFault('spec_archived', () =>
        archiveSpec(cawsDir, { id, actor: ACTOR })
      );

      expect(result.ok).toBe(true);
      expect(result.value.kind).toBe('partial_failure_recovered');

      // A3 core assertion: source remains. The unlink at
      // specs-writer.ts:547 is gated on r.value.kind === 'success' and
      // must not run on partial_failure_recovered.
      expect(fs.existsSync(fromPath)).toBe(true);
      expect(fs.readFileSync(fromPath, 'utf8')).toBe(preFromBytes);

      // Archive destination was a fresh write; rollback removes it.
      expect(fs.existsSync(toPath)).toBe(false);

      // No spec_archived event.
      const events = readEvents(cawsDir).filter((e) => e.spec_id === id);
      expect(events.map((e) => e.event)).not.toContain('spec_archived');
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // A4 — createWorktree first-event injection (recovered + compensation)
  // ──────────────────────────────────────────────────────────────────────

  describe('createWorktree first-event injection', () => {
    test('A4: injection on worktree_created -> partial_failure_recovered; git dir gone; registry empty; spec.worktree unchanged; no events', () => {
      const id = 'HARNESS-CREATEWT-004';
      writeActiveSpec(cawsDir, id);
      const specFile = path.join(cawsDir, 'specs', `${id}.yaml`);
      const preSpecBytes = fs.readFileSync(specFile, 'utf8');
      // Pre-state: spec has no worktree field (writeActiveSpec doesn't add one).
      expect(preSpecBytes).not.toMatch(/^worktree:/m);

      const wtName = 'wt-a4';
      const wtPath = path.join(cawsDir, 'worktrees', wtName);

      const result = withFault('worktree_created', () =>
        createWorktree(cawsDir, {
          name: wtName,
          specId: id,
          session: SESSION,
          actor: ACTOR,
        })
      );

      // First-event injection: txn rolls back cleanly (no prior events
      // in this txn yet). Caller maps the recovered txn outcome to
      // partial_failure_recovered.
      expect(result.ok).toBe(true);
      expect(result.value.kind).toBe('partial_failure_recovered');

      // Compensation (worktrees-writer.ts:444-451) ran:
      //   - git worktree remove --force
      //   - rollbackRegistryEntry
      expect(fs.existsSync(wtPath)).toBe(false);
      const registry = JSON.parse(
        fs.readFileSync(path.join(cawsDir, 'worktrees.json'), 'utf8')
      );
      expect(registry[wtName]).toBeUndefined();

      // Spec yaml: planned-write was inside the txn; rollback restores
      // it to byte-identical pre-state.
      const postSpecBytes = fs.readFileSync(specFile, 'utf8');
      expect(postSpecBytes).toBe(preSpecBytes);
      expect(postSpecBytes).not.toMatch(/^worktree:/m);

      // Event log: neither worktree_created nor worktree_bound for this
      // spec.
      const eventsForSpec = readEvents(cawsDir).filter(
        (e) =>
          e.spec_id === id ||
          (e.data &&
            (e.data.worktree_name === wtName || e.data.name === wtName))
      );
      const kinds = eventsForSpec.map((e) => e.event);
      expect(kinds).not.toContain('worktree_created');
      expect(kinds).not.toContain('worktree_bound');
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // A5 — createWorktree second-event injection (UNRECOVERED + compensation)
  // ──────────────────────────────────────────────────────────────────────

  describe('createWorktree second-event injection', () => {
    test('A5: injection on worktree_bound -> UNRECOVERED; worktree_created stays in hash chain; compensation still runs', () => {
      const id = 'HARNESS-CREATEWT-005';
      writeActiveSpec(cawsDir, id);
      const specFile = path.join(cawsDir, 'specs', `${id}.yaml`);
      const preSpecBytes = fs.readFileSync(specFile, 'utf8');
      const preEventCount = readEvents(cawsDir).length;

      const wtName = 'wt-a5';
      const wtPath = path.join(cawsDir, 'worktrees', wtName);

      const result = withFault('worktree_bound', () =>
        createWorktree(cawsDir, {
          name: wtName,
          specId: id,
          session: SESSION,
          actor: ACTOR,
        })
      );

      // Second-event injection: worktree_created already appended to the
      // hash chain before worktree_bound failed. The txn cannot un-append,
      // so it returns err(LIFECYCLE_PARTIAL_FAILURE_UNRECOVERED). The
      // createWorktree caller propagates that err.
      expect(result.ok).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      const diag = result.errors[0];
      expect(diag.rule).toBe('store.lifecycle.partial_failure_unrecovered');

      // Diagnostic subject names the failing event.
      expect(diag.subject).toBe('worktree_bound');

      // data.already_appended must list exactly one prior event, and the
      // referenced seq must resolve to a worktree_created event in
      // events.jsonl. The diagnostic carries seq + event_hash only (not
      // the event name), so the test resolves the name from the log.
      expect(diag.data).toBeDefined();
      expect(Array.isArray(diag.data.already_appended)).toBe(true);
      expect(diag.data.already_appended.length).toBe(1);
      const priorSeq = diag.data.already_appended[0].seq;
      expect(typeof priorSeq).toBe('number');
      expect(typeof diag.data.already_appended[0].event_hash).toBe('string');

      const events = readEvents(cawsDir);
      const prior = events.find((e) => e.seq === priorSeq);
      expect(prior).toBeDefined();
      expect(prior.event).toBe('worktree_created');

      // No worktree_bound event was appended.
      expect(events.map((e) => e.event)).not.toContain('worktree_bound');

      // Compensation still runs even on unrecovered: git worktree removed,
      // registry entry removed.
      expect(fs.existsSync(wtPath)).toBe(false);
      const registry = JSON.parse(
        fs.readFileSync(path.join(cawsDir, 'worktrees.json'), 'utf8')
      );
      expect(registry[wtName]).toBeUndefined();

      // Spec yaml planned-write was inside the txn; rollback restores
      // it. (worktree_created event in the log is honest evidence of
      // an attempted operation, NOT retroactively erased; spec content
      // is still byte-identical to pre-call.)
      const postSpecBytes = fs.readFileSync(specFile, 'utf8');
      expect(postSpecBytes).toBe(preSpecBytes);

      // Event count grew by exactly one (worktree_created), proving the
      // hash chain is honest and worktree_bound is NOT a phantom entry.
      const postEventCount = readEvents(cawsDir).length;
      expect(postEventCount).toBe(preEventCount + 1);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // A2 — bindWorktreeRepair (single-event: worktree_bound)
  //
  // Note: bindWorktreeRepair requires a pre-existing registry entry. We
  // set that up via a successful createWorktree to spec A, then call
  // bindWorktreeRepair to rebind to spec B with the seam firing on
  // worktree_bound. The applyRegistryPatch on line 551 of
  // worktrees-writer.ts runs OUTSIDE the txn — the registry mutation is
  // already applied when the event-append fails. The test records this
  // honest partial state rather than asserting pretended recovery.
  // Finding feeds PRUNE-REPAIR-WORKTREE-001.
  // ──────────────────────────────────────────────────────────────────────

  describe('bindWorktreeRepair (single-event + external registry-mutation pre-txn)', () => {
    test('A2: injection on worktree_bound (rebind) -> partial_failure_recovered; spec-yaml rollback succeeds; registry update observed as already-applied (finding for prune/repair)', () => {
      const idA = 'HARNESS-BIND-001';
      const idB = 'HARNESS-BIND-002';
      writeActiveSpec(cawsDir, idA);
      writeActiveSpec(cawsDir, idB);

      const wtName = 'wt-bind';
      const createRes = createWorktree(cawsDir, {
        name: wtName,
        specId: idA,
        session: SESSION,
        actor: ACTOR,
      });
      expect(createRes.ok).toBe(true);
      expect(createRes.value.kind).toBe('success');

      const specBFile = path.join(cawsDir, 'specs', `${idB}.yaml`);
      const preSpecBBytes = fs.readFileSync(specBFile, 'utf8');
      const registryPre = JSON.parse(
        fs.readFileSync(path.join(cawsDir, 'worktrees.json'), 'utf8')
      );
      expect(registryPre[wtName].specId).toBe(idA);

      const result = withFault('worktree_bound', () =>
        bindWorktreeRepair(cawsDir, {
          name: wtName,
          specId: idB,
          session: SESSION,
          actor: ACTOR,
        })
      );

      // Outcome: the txn rolls back its planned write (spec B yaml).
      // No worktree_bound event for the rebind exists in this txn yet
      // (single-event txn). Result is partial_failure_recovered.
      expect(result.ok).toBe(true);
      expect(result.value.kind).toBe('partial_failure_recovered');

      // Spec B yaml: rollback restores byte-identical pre-state.
      // (worktree: <name> was NOT added.)
      expect(fs.readFileSync(specBFile, 'utf8')).toBe(preSpecBBytes);
      expect(fs.readFileSync(specBFile, 'utf8')).not.toMatch(/^worktree:/m);

      // Event log: no worktree_bound event for this rebind attempt.
      // (The setup createWorktree appended one; assert no SECOND
      // worktree_bound for the rebind.)
      const boundEvents = readEvents(cawsDir).filter(
        (e) => e.event === 'worktree_bound'
      );
      expect(boundEvents.length).toBe(1); // the setup one
      expect(boundEvents[0].spec_id).toBe(idA);

      // HONEST PARTIAL STATE — applyRegistryPatch ran outside the txn,
      // so the registry now references spec B even though the spec yaml
      // rolled back. Spec A still has the worktree: field. This is the
      // observed posture; it is NOT a recovered state despite the txn
      // result. Finding for PRUNE-REPAIR-WORKTREE-001 and/or
      // WORKTREE-SPEC-AUTHORITY-CONTROL-PLANE-001.
      const registryPost = JSON.parse(
        fs.readFileSync(path.join(cawsDir, 'worktrees.json'), 'utf8')
      );
      expect(registryPost[wtName].specId).toBe(idB);

      const specAFile = path.join(cawsDir, 'specs', `${idA}.yaml`);
      const specABytes = fs.readFileSync(specAFile, 'utf8');
      expect(specABytes).toMatch(/^worktree:\s*['"]?wt-bind['"]?/m);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // A2 — destroyWorktree (single-event: worktree_destroyed)
  //
  // Note: destroyWorktree runs `git worktree remove` and the registry
  // removal BEFORE the txn (worktrees-writer.ts:653, :700). Injection on
  // worktree_destroyed rolls back the spec.worktree-clearing planned
  // write, but the git worktree directory and registry entry are
  // already gone. Observed partial state recorded honestly; finding
  // feeds PRUNE-REPAIR-WORKTREE-001.
  //
  // To inject cleanly we need a worktree whose branch is merged into
  // base (the unmerged-branch guard would otherwise refuse). We create
  // the worktree, make no commits on it, and merge its empty branch.
  // ──────────────────────────────────────────────────────────────────────

  describe('destroyWorktree (single-event + external git/registry mutation pre-txn)', () => {
    test('A2: injection on worktree_destroyed -> partial_failure_recovered; spec.worktree rolled back; git dir and registry already gone (finding for prune/repair)', () => {
      const id = 'HARNESS-DESTROY-001';
      writeActiveSpec(cawsDir, id);

      const wtName = 'wt-destroy';
      const createRes = createWorktree(cawsDir, {
        name: wtName,
        specId: id,
        session: SESSION,
        actor: ACTOR,
      });
      expect(createRes.ok).toBe(true);
      expect(createRes.value.kind).toBe('success');

      const wtPath = path.join(cawsDir, 'worktrees', wtName);
      expect(fs.existsSync(wtPath)).toBe(true);

      // Merge the worktree branch into main so the unmerged-branch guard
      // does not refuse destroy. The worktree branch is caws/wt-destroy
      // by convention; createWorktree creates an empty branch off main.
      // FF-merging it back is a no-op for content but flips the merged
      // check.
      const registryEntry = JSON.parse(
        fs.readFileSync(path.join(cawsDir, 'worktrees.json'), 'utf8')
      )[wtName];
      const branch = registryEntry.branch;
      expect(typeof branch).toBe('string');
      execFileSync('git', ['-C', repo, 'merge', '--quiet', '--ff-only', branch]);

      const specFile = path.join(cawsDir, 'specs', `${id}.yaml`);
      const preSpecBytes = fs.readFileSync(specFile, 'utf8');
      expect(preSpecBytes).toMatch(/^worktree:\s*['"]?wt-destroy['"]?/m);

      const result = withFault('worktree_destroyed', () =>
        destroyWorktree(cawsDir, {
          name: wtName,
          session: SESSION,
          actor: ACTOR,
        })
      );

      expect(result.ok).toBe(true);
      expect(result.value.kind).toBe('partial_failure_recovered');

      // Spec yaml: planned-write (clear worktree: field) rolled back.
      // Byte-identical to pre-call.
      const postSpecBytes = fs.readFileSync(specFile, 'utf8');
      expect(postSpecBytes).toBe(preSpecBytes);
      expect(postSpecBytes).toMatch(/^worktree:\s*['"]?wt-destroy['"]?/m);

      // No worktree_destroyed event appended.
      const events = readEvents(cawsDir);
      expect(events.map((e) => e.event)).not.toContain('worktree_destroyed');

      // HONEST PARTIAL STATE — git worktree remove and registry removal
      // ran BEFORE the txn (worktrees-writer.ts:653, :700). They are
      // unrecoverable from the txn's snapshot mechanism. The test
      // records the observed posture: physical worktree gone, registry
      // entry gone, spec yaml still claims the worktree exists. This
      // is the half-state class that PRUNE-REPAIR-WORKTREE-001 is
      // expected to detect and reconcile.
      expect(fs.existsSync(wtPath)).toBe(false);
      const registryPost = JSON.parse(
        fs.readFileSync(path.join(cawsDir, 'worktrees.json'), 'utf8')
      );
      expect(registryPost[wtName]).toBeUndefined();
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // A6 — mergeWorktree coverage discharged
  // ──────────────────────────────────────────────────────────────────────

  describe('mergeWorktree coverage (A6 sentinel)', () => {
    test('A6: event-append-boundary coverage is discharged by worktree-merge-a2-fault-injection.test.js', () => {
      const a2 = path.join(__dirname, 'worktree-merge-a2-fault-injection.test.js');
      expect(fs.existsSync(a2)).toBe(true);
      // Spot-check the file's spec citation so a future rename/refactor
      // that breaks the discharge link fails this test loudly.
      const body = fs.readFileSync(a2, 'utf8');
      expect(body).toMatch(/WORKTREE-MERGE-A2-FAULT-INJECTION-001/);
    });
  });
});
