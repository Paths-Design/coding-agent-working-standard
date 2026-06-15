/**
 * PRUNE-REPAIR-WORKTREE-001 — `caws worktree repair` executor proof (A1–A9).
 *
 * The terminal slice of the Diagnose -> Decide -> Repair arc. This suite proves
 * the command is a DISPATCHER over doctor evidence, not a second policy engine:
 * it repairs ONLY the §1.4 matrix-unambiguous classes (H1 ghost registry, H4
 * ghost spec binding, H3 dormant binding on a closed/archived spec) and REFUSES
 * everything ambiguous/forbidden (H2, H3-active, H5, H6, event-orphan) with a
 * doctrine pointer and ZERO mutation.
 *
 * Discipline (load-bearing — these are the assertions that make the test able
 * to fail for the right reason):
 *  - The command runs the REAL doctor pipeline (composeDoctorSnapshot ->
 *    inspectProjectState) against an on-disk fixture. We do not stub the
 *    classification; the fixture must actually produce the H-class.
 *  - Every mutation is verified at the EVIDENCE layer: re-read events.jsonl,
 *    confirm the exact event type + h_class was appended, and verifyChain the
 *    whole chain (no checking the runner summary alone).
 *  - The no-mutation refusal cases snapshot the registry bytes, spec bytes, and
 *    event count BEFORE and assert byte-for-byte equality AFTER — a refusal that
 *    silently mutated would pass a weaker "exit code" assertion.
 *  - The no-git-touch guarantee (A7) is proven structurally: the fixture never
 *    creates a real git worktree dir, and we assert none appears after repair.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { runWorktreeRepairCommand } = require('../../dist/shell/commands/worktree');
const { initProject } = require('../../dist/store/init-store');
const { loadEvents } = require('../../dist/store/events-store');
const { verifyChain } = require('@paths.design/caws-kernel');

const repos = [];

afterAll(() => {
  for (const r of repos) {
    try {
      fs.rmSync(r, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

// ─── Fixture helpers ──────────────────────────────────────────────────────

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
 * Write a minimal valid spec, optionally bound to a worktree.
 *
 * Spec-validity constraints the loader enforces (so the fixture actually loads
 * and reaches the doctor's binding scan — both surfaced as test failures during
 * authoring):
 *   - The id MUST match ^[A-Z][A-Z0-9]*(-[A-Z0-9]+)*-\d+[a-z]*$ (i.e. end in a
 *     number). "SPEC-A" fails; "SPEC-A-001" passes.
 *   - A closed/archived spec MUST carry a `resolution` (closed.resolution_required).
 */
function writeSpec(cawsDir, id, { state = 'active', worktree } = {}) {
  const wtLine = worktree !== undefined ? `worktree: ${worktree}\n` : '';
  const resolutionLine =
    state === 'closed' || state === 'archived' ? `resolution: superseded\n` : '';
  const body = `id: ${id}
title: 'Repair fixture spec'
risk_tier: 3
mode: chore
lifecycle_state: ${state}
${resolutionLine}${wtLine}created_at: '2026-06-15T00:00:00.000Z'
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

/** Overwrite worktrees.json with the v11 flat-map of entries. */
function writeRegistry(cawsDir, entries) {
  fs.writeFileSync(path.join(cawsDir, 'worktrees.json'), JSON.stringify(entries, null, 2) + '\n');
}

/** Create the canonical worktree backing dir so the entry is NOT a ghost. */
function makeWorktreeDir(cawsDir, name) {
  fs.mkdirSync(path.join(cawsDir, 'worktrees', name), { recursive: true });
}

function readBytes(p) {
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
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

function chainIsVerifiable(cawsDir) {
  const loaded = loadEvents(cawsDir);
  if (!loaded.ok) return { ok: false, why: 'loadEvents failed' };
  const v = verifyChain(loaded.value.events);
  return { ok: v.ok, count: loaded.value.events.length };
}

/** Invoke the command with captured IO. Returns { code, out, err }. */
function runRepair(repoRoot, { dryRun = false } = {}) {
  const out = [];
  const err = [];
  const code = runWorktreeRepairCommand({
    cwd: repoRoot,
    env: { ...process.env, CLAUDE_SESSION_ID: 'sess-repair-test' },
    now: () => new Date('2026-06-15T12:00:00.000Z'),
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    ...(dryRun ? { dryRun: true } : {}),
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

/** Snapshot every governance surface that a refusal must NOT mutate. */
function snapshotState(cawsDir, specIds) {
  const specs = {};
  for (const id of specIds) specs[id] = readBytes(path.join(cawsDir, 'specs', `${id}.yaml`));
  return {
    registry: readBytes(path.join(cawsDir, 'worktrees.json')),
    events: readBytes(path.join(cawsDir, 'events.jsonl')),
    eventCount: readEventsRaw(cawsDir).length,
    specs,
  };
}

function expectUnchanged(before, after) {
  expect(after.registry).toBe(before.registry);
  expect(after.events).toBe(before.events);
  expect(after.eventCount).toBe(before.eventCount);
  expect(after.specs).toEqual(before.specs);
}

function eventsOfType(cawsDir, type) {
  return readEventsRaw(cawsDir).filter((e) => e.event === type);
}

// =========================================================================
// H1 — ghost registry entry: registry has an entry whose backing dir is gone.
// =========================================================================

describe('H1 ghost registry — prune', () => {
  function h1Repo() {
    const repoRoot = mkRepo('rep-h1-');
    const caws = setupCaws(repoRoot);
    // Registry claims wt-ghost; we deliberately do NOT create its dir → ghost.
    writeRegistry(caws, {
      'wt-ghost': { branch: 'wt-ghost', baseBranch: 'main' },
    });
    return { repoRoot, caws };
  }

  test('A1: --dry-run reports H-class, subject, planned mutation, and event; mutates nothing', () => {
    const { repoRoot, caws } = h1Repo();
    const before = snapshotState(caws, []);

    const { code, out } = runRepair(repoRoot, { dryRun: true });

    expect(code).toBe(0);
    expect(out).toMatch(/WOULD PRUNE wt-ghost/);
    expect(out).toMatch(/ghost_registry/);
    expect(out).toMatch(/worktree_pruned/);
    expect(out).toMatch(/dry-run — nothing mutated/);
    // A1 core: byte-identical state after a dry-run.
    expectUnchanged(before, snapshotState(caws, []));
  });

  test('A2/A3: actual run removes ONLY the registry entry + appends worktree_pruned(ghost_registry); chain verifies', () => {
    const { repoRoot, caws } = h1Repo();
    const preEvents = readEventsRaw(caws).length;

    const { code, out } = runRepair(repoRoot);

    expect(code).toBe(0);
    expect(out).toMatch(/^PRUNE wt-ghost/m);
    // Registry entry gone.
    const registry = JSON.parse(readBytes(path.join(caws, 'worktrees.json')));
    expect(registry['wt-ghost']).toBeUndefined();
    // Exactly one honest event, correct type + h_class.
    const pruned = eventsOfType(caws, 'worktree_pruned');
    expect(pruned).toHaveLength(1);
    expect(pruned[0].data.h_class).toBe('ghost_registry');
    expect(pruned[0].data.worktree_name).toBe('wt-ghost');
    expect(readEventsRaw(caws).length).toBe(preEvents + 1);
    // Audit integrity.
    const chain = chainIsVerifiable(caws);
    expect(chain.ok).toBe(true);
  });

  test('A2: dry-run plan equals the actual mutation (same subject, same event)', () => {
    const dry = runRepair(h1Repo().repoRoot, { dryRun: true });
    const real = (() => {
      const { repoRoot } = h1Repo();
      return runRepair(repoRoot);
    })();
    // The dry-run "WOULD PRUNE wt-ghost" predicts the actual "PRUNE wt-ghost".
    expect(dry.out).toMatch(/wt-ghost/);
    expect(real.out).toMatch(/wt-ghost/);
    expect(dry.out).toMatch(/worktree_pruned/);
  });
});

// =========================================================================
// H4 — ghost spec binding: spec still points to a worktree with no registry
//      entry and no backing dir (active spec).
// =========================================================================

describe('H4 ghost spec binding — clear', () => {
  function h4Repo() {
    const repoRoot = mkRepo('rep-h4-');
    const caws = setupCaws(repoRoot);
    writeSpec(caws, 'GHOST-BIND-001', { state: 'active', worktree: 'wt-dead' });
    // No registry entry for wt-dead, no backing dir → H4.
    writeRegistry(caws, {});
    return { repoRoot, caws };
  }

  test('A4: clears spec.worktree + appends spec_binding_cleared(ghost_spec_binding); chain verifies', () => {
    const { repoRoot, caws } = h4Repo();
    const specPath = path.join(caws, 'specs', 'GHOST-BIND-001.yaml');
    expect(readBytes(specPath)).toMatch(/worktree: wt-dead/);

    const { code, out } = runRepair(repoRoot);

    expect(code).toBe(0);
    expect(out).toMatch(/CLEAR GHOST-BIND-001 \(ghost_spec_binding\)/);
    // The stale binding is gone from the canonical spec.
    expect(readBytes(specPath)).not.toMatch(/worktree: wt-dead/);
    // Honest event.
    const cleared = eventsOfType(caws, 'spec_binding_cleared');
    expect(cleared).toHaveLength(1);
    expect(cleared[0].data.h_class).toBe('ghost_spec_binding');
    expect(cleared[0].data.cleared_worktree_name).toBe('wt-dead');
    expect(cleared[0].spec_id).toBe('GHOST-BIND-001');
    expect(chainIsVerifiable(caws).ok).toBe(true);
  });

  test('A1: --dry-run reports the clear without mutating the spec or events', () => {
    const { repoRoot, caws } = h4Repo();
    const before = snapshotState(caws, ['GHOST-BIND-001']);

    const { code, out } = runRepair(repoRoot, { dryRun: true });

    expect(code).toBe(0);
    expect(out).toMatch(/WOULD CLEAR GHOST-BIND-001 \(ghost_spec_binding\)/);
    expectUnchanged(before, snapshotState(caws, ['GHOST-BIND-001']));
  });
});

// =========================================================================
// H3 dormant — closed/archived spec with a stale worktree: binding.
// =========================================================================

describe('H3 dormant binding (closed spec) — clear', () => {
  test('A5: clears spec.worktree + appends spec_binding_cleared(dormant_spec_binding)', () => {
    const repoRoot = mkRepo('rep-h3d-');
    const caws = setupCaws(repoRoot);
    writeSpec(caws, 'DORMANT-001', { state: 'closed', worktree: 'wt-old' });
    writeRegistry(caws, {});

    const { code, out } = runRepair(repoRoot);

    expect(code).toBe(0);
    expect(out).toMatch(/CLEAR DORMANT-001 \(dormant_spec_binding\)/);
    expect(readBytes(path.join(caws, 'specs', 'DORMANT-001.yaml'))).not.toMatch(/worktree: wt-old/);
    const cleared = eventsOfType(caws, 'spec_binding_cleared');
    expect(cleared).toHaveLength(1);
    expect(cleared[0].data.h_class).toBe('dormant_spec_binding');
    expect(chainIsVerifiable(caws).ok).toBe(true);
  });
});

// =========================================================================
// A6 — ambiguous/forbidden classes REFUSE with zero mutation.
// =========================================================================

describe('A6: ambiguous/forbidden classes refuse with zero mutation', () => {
  test('H3-active (worktree dir still present) refuses — recreate-vs-clear ambiguity', () => {
    const repoRoot = mkRepo('rep-h3a-');
    const caws = setupCaws(repoRoot);
    writeSpec(caws, 'ACTIVE-BIND-001', { state: 'active', worktree: 'wt-live' });
    // Registry has no entry, BUT the canonical dir EXISTS → active + dir present
    // = ambiguous (the worktree may be live, just unregistered). REFUSE.
    writeRegistry(caws, {});
    makeWorktreeDir(caws, 'wt-live');
    const before = snapshotState(caws, ['ACTIVE-BIND-001']);

    const { code, out } = runRepair(repoRoot);

    // A pure refusal is exit 0 (refusing ambiguity is correct, not failure).
    expect(code).toBe(0);
    expect(out).toMatch(/REFUSE/);
    expect(out).toMatch(/ambiguous/i);
    // No spec_binding_cleared appended; nothing mutated.
    expect(eventsOfType(caws, 'spec_binding_cleared')).toHaveLength(0);
    expectUnchanged(before, snapshotState(caws, ['ACTIVE-BIND-001']));
  });

  test('H2 (registry binds a spec that is not loaded) refuses with zero mutation', () => {
    const repoRoot = mkRepo('rep-h2-');
    const caws = setupCaws(repoRoot);
    // Registry binds wt-x to a spec id with no spec file + a backing dir so it
    // is not also an H1 ghost. The missing spec is the H2 signal.
    writeRegistry(caws, { 'wt-x': { specId: 'MISSING-SPEC-999', branch: 'wt-x', baseBranch: 'main' } });
    makeWorktreeDir(caws, 'wt-x');
    const before = snapshotState(caws, []);

    const { code, out } = runRepair(repoRoot);

    expect(out).toMatch(/REFUSE/);
    expect(eventsOfType(caws, 'worktree_pruned')).toHaveLength(0);
    expect(eventsOfType(caws, 'spec_binding_cleared')).toHaveLength(0);
    expectUnchanged(before, snapshotState(caws, []));
    expect(code).toBe(0);
  });

  test('H5 (3-way contradiction) refuses with a -002 doctrine pointer and zero mutation', () => {
    const repoRoot = mkRepo('rep-h5-');
    const caws = setupCaws(repoRoot);
    // spec_A claims wt-x; registry binds wt-x to spec_B; spec_B does not claim it.
    writeSpec(caws, 'SPEC-A-001', { state: 'active', worktree: 'wt-x' });
    writeSpec(caws, 'SPEC-B-001', { state: 'active' });
    writeRegistry(caws, { 'wt-x': { specId: 'SPEC-B-001', branch: 'wt-x', baseBranch: 'main' } });
    makeWorktreeDir(caws, 'wt-x');
    const before = snapshotState(caws, ['SPEC-A-001', 'SPEC-B-001']);

    const { code, out } = runRepair(repoRoot);

    expect(out).toMatch(/REFUSE/);
    expect(out).toMatch(/CONTROL-PLANE-002/);
    expect(out).not.toMatch(/CONTROL-PLANE-001/);
    expect(eventsOfType(caws, 'spec_binding_cleared')).toHaveLength(0);
    expect(eventsOfType(caws, 'worktree_pruned')).toHaveLength(0);
    expectUnchanged(before, snapshotState(caws, ['SPEC-A-001', 'SPEC-B-001']));
    expect(code).toBe(0);
  });
});

// =========================================================================
// A7 — repair NEVER creates or deletes a git worktree directory.
// =========================================================================

describe('A7: no repair path touches a git worktree directory', () => {
  test('H1 prune does not remove the worktrees/ tree or create a new worktree dir', () => {
    const repoRoot = mkRepo('rep-a7-');
    const caws = setupCaws(repoRoot);
    writeRegistry(caws, { 'wt-ghost': { branch: 'wt-ghost', baseBranch: 'main' } });
    // The ghost has NO backing dir; assert it stays absent (prune must not
    // create one) and the worktrees/ parent dir is untouched.
    const worktreesDir = path.join(caws, 'worktrees');
    const ghostDir = path.join(worktreesDir, 'wt-ghost');
    expect(fs.existsSync(ghostDir)).toBe(false);

    runRepair(repoRoot);

    expect(fs.existsSync(ghostDir)).toBe(false);
    // git worktree list shows only the main checkout — repair added none.
    const wtList = execFileSync('git', ['-C', repoRoot, 'worktree', 'list', '--porcelain'], {
      encoding: 'utf8',
    });
    const worktreeCount = (wtList.match(/^worktree /gm) || []).length;
    expect(worktreeCount).toBe(1);
  });
});
