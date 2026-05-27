/**
 * CAWS-MERGE-CLOSE-MISSING-UPDATED-AT-001
 *
 * Regression coverage for closeSpec and archiveSpec when the input
 * spec YAML lacks a top-level `updated_at` field.
 *
 * Before this slice: setTopLevelScalar returned YAML_PATCH_KEY_NOT_FOUND;
 * the close/archive transaction rolled back; the composed
 * mergeWorktree → closeSpec path reported partial_failure_unrecovered
 * with the underlying patch-key error buried in close_errors.
 *
 * After this slice: an insert-or-update fallback mirrors the pattern
 * already used for `resolution` and `closure_notes`. Absent `updated_at`
 * is inserted at a deterministic anchor (after created_at if present,
 * otherwise after lifecycle_state). Present `updated_at` is updated
 * in place (unchanged from pre-fix behavior).
 *
 * Acceptance mapping:
 *   A1 — closeSpec absent-key insert succeeds (this file)
 *   A2 — archiveSpec absent-key insert succeeds (this file)
 *   A3 — byte-preservation of unrelated content (this file)
 *   A4 — present-key update unchanged (this file)
 *   A5 — merge composition end-to-end (covered by existing
 *        worktree merge tests; this slice does not modify
 *        worktrees-writer.ts so no new merge test is required)
 *   A6 — pre-existing tests remain green (verified by full suite run
 *        outside this file)
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// archiveSpec import removed: the A2 archive test was superseded by
// CAWS-ARCHIVE-AS-TOMBSTONE-001 (see reconciliation note below where
// the A2 describe block used to live). closeSpec is the sole writer
// this slice exercises post-merge.
const { closeSpec } = require('../../dist/store/specs-writer');

// ─── Helpers ────────────────────────────────────────────────────────────

function mkBareGitRepo(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync('git', ['init', '--quiet', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 't@t.com']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'T']);
  execFileSync('git', [
    '-C', root, 'commit', '--quiet', '--allow-empty', '-m', 'init',
  ]);
  fs.mkdirSync(path.join(root, '.caws', 'specs'), { recursive: true });
  return { root, cawsDir: path.join(root, '.caws') };
}

function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
}

const NOW = () => new Date('2026-05-27T22:00:00.000Z');

// Minimal v11 spec missing updated_at. Mirrors the legacy /
// v10-migrated shape that triggers the defect: every kernel-required
// field present, but updated_at omitted.
function specYamlNoUpdatedAt(id, opts = {}) {
  const withCreatedAt = opts.includeCreatedAt !== false;
  const createdLine = withCreatedAt ? `created_at: '2026-05-01T00:00:00.000Z'\n` : '';
  return `id: ${id}
title: 'legacy spec without updated_at'
risk_tier: 3
mode: fix
lifecycle_state: active
${createdLine}# Hand-authored or v10-migrated: no updated_at field.
# Comments and blank lines below MUST survive close/archive byte-for-byte.

blast_radius:
  modules:
    - some/module
  data_migration: false
operational_rollback_slo: 5m
scope:
  in:
    - some/module
  out: []
invariants:
  - 'invariant one'
acceptance:
  - id: A1
    given: 'given'
    when: 'when'
    then: 'then'
non_functional: {}
contracts: []
`;
}

// Same shape but WITH updated_at, to prove A4 (present-key update unchanged).
function specYamlWithUpdatedAt(id) {
  return `id: ${id}
title: 'spec with updated_at'
risk_tier: 3
mode: fix
lifecycle_state: active
created_at: '2026-05-01T00:00:00.000Z'
updated_at: '2026-05-15T12:00:00.000Z'
blast_radius:
  modules:
    - some/module
  data_migration: false
operational_rollback_slo: 5m
scope:
  in:
    - some/module
  out: []
invariants:
  - 'invariant one'
acceptance:
  - id: A1
    given: 'given'
    when: 'when'
    then: 'then'
non_functional: {}
contracts: []
`;
}

const ACTOR = { kind: 'agent', id: 'test-agent', session_id: 'sess-cmc-test' };

// ─── A1: closeSpec inserts updated_at when absent ────────────────────────

describe('CAWS-MERGE-CLOSE-MISSING-UPDATED-AT-001 A1: closeSpec absent-key insert', () => {
  let env;
  beforeEach(() => { env = mkBareGitRepo('caws-cmc-a1-'); });
  afterEach(() => rmrf(env.root));

  it('closes a spec lacking updated_at; inserts after created_at', () => {
    const specPath = path.join(env.cawsDir, 'specs', 'LEGACY-1.yaml');
    fs.writeFileSync(specPath, specYamlNoUpdatedAt('LEGACY-1'));

    const r = closeSpec(env.cawsDir, {
      id: 'LEGACY-1',
      resolution: 'completed',
      reason: 'done',
      actor: ACTOR,
      now: NOW,
    });

    expect(r.ok).toBe(true);
    // Outcome inspection per CLAUDE.md hygiene: partial_failure_recovered
    // wraps in ok() but is NOT success.
    expect(r.value.kind).toBe('success');

    const patched = fs.readFileSync(specPath, 'utf8');
    expect(patched).toMatch(/^lifecycle_state: closed$/m);
    expect(patched).toMatch(/^resolution: completed$/m);
    expect(patched).toMatch(/^closure_notes: 'done'$/m);
    // The new updated_at line landed and matches the injected now.
    expect(patched).toMatch(/^updated_at: '2026-05-27T22:00:00\.000Z'$/m);
    // Anchor: updated_at inserted immediately after created_at.
    const lines = patched.split('\n');
    const createdIdx = lines.findIndex((l) => l.startsWith('created_at:'));
    const updatedIdx = lines.findIndex((l) => l.startsWith('updated_at:'));
    expect(createdIdx).toBeGreaterThan(-1);
    expect(updatedIdx).toBe(createdIdx + 1);
  });

  it('closes a spec lacking BOTH created_at and updated_at; inserts after lifecycle_state', () => {
    const specPath = path.join(env.cawsDir, 'specs', 'LEGACY-2.yaml');
    fs.writeFileSync(specPath, specYamlNoUpdatedAt('LEGACY-2', { includeCreatedAt: false }));

    const r = closeSpec(env.cawsDir, {
      id: 'LEGACY-2',
      resolution: 'completed',
      actor: ACTOR,
      now: NOW,
    });

    expect(r.ok).toBe(true);
    expect(r.value.kind).toBe('success');

    const patched = fs.readFileSync(specPath, 'utf8');
    expect(patched).toMatch(/^updated_at: '2026-05-27T22:00:00\.000Z'$/m);
    // Anchor: updated_at landed after lifecycle_state (no created_at to
    // anchor on; closeSpec also inserts resolution after lifecycle_state,
    // so the precise order depends on insertion timing but updated_at
    // must follow the lifecycle/resolution/closure block).
    const lines = patched.split('\n');
    const lifecycleIdx = lines.findIndex((l) => l.startsWith('lifecycle_state:'));
    const updatedIdx = lines.findIndex((l) => l.startsWith('updated_at:'));
    expect(lifecycleIdx).toBeGreaterThan(-1);
    expect(updatedIdx).toBeGreaterThan(lifecycleIdx);
  });
});

// ─── A2: archiveSpec — superseded by CAWS-ARCHIVE-AS-TOMBSTONE-001 ───────
//
// Reconciliation note (added at merge resolution): A2 of this slice
// originally asserted that archiveSpec inserts `updated_at` when
// absent (parallel to the closeSpec fix). On merge to main this
// slice converged with CAWS-ARCHIVE-AS-TOMBSTONE-001 (merge 2a4cc30),
// which restructured archiveSpec to NOT write a body to
// .caws/specs/.archive/<id>.yaml at all — archive is now a deletion +
// spec_archived event carrying blob_sha for git-history recovery.
//
// The absent-`updated_at` defect class no longer exists in
// archiveSpec because there is no YAML patch step. The A2 acceptance
// criterion is therefore vacuously satisfied (no patch step = no
// YAML_PATCH_KEY_NOT_FOUND failure path can fire there).
//
// The closeSpec fix (A1 above) remains the load-bearing change in
// this slice; A3 byte-preservation and A4 present-key-update tests
// continue to exercise the closeSpec path, which is unaffected by
// the tombstone restructure.

// ─── A3: byte-preservation of unrelated content ──────────────────────────

describe('CAWS-MERGE-CLOSE-MISSING-UPDATED-AT-001 A3: raw-byte preservation', () => {
  let env;
  beforeEach(() => { env = mkBareGitRepo('caws-cmc-a3-'); });
  afterEach(() => rmrf(env.root));

  it('closeSpec preserves comments, blank lines, and field ordering', () => {
    const specPath = path.join(env.cawsDir, 'specs', 'LEGACY-4.yaml');
    const original = specYamlNoUpdatedAt('LEGACY-4');
    fs.writeFileSync(specPath, original);

    const r = closeSpec(env.cawsDir, {
      id: 'LEGACY-4',
      resolution: 'completed',
      reason: 'done',
      actor: ACTOR,
      now: NOW,
    });
    expect(r.ok).toBe(true);
    expect(r.value.kind).toBe('success');

    const patched = fs.readFileSync(specPath, 'utf8');
    // The two distinctive comment lines from the fixture must survive
    // verbatim (byte-preserved).
    expect(patched).toContain('# Hand-authored or v10-migrated: no updated_at field.');
    expect(patched).toContain('# Comments and blank lines below MUST survive close/archive byte-for-byte.');
    // The blank line between comments and blast_radius must survive.
    expect(patched).toMatch(/byte-for-byte\.\n\nblast_radius:/);
    // Unrelated YAML structure unchanged.
    expect(patched).toMatch(/^title: 'legacy spec without updated_at'$/m);
    expect(patched).toMatch(/operational_rollback_slo: 5m/);
    expect(patched).toMatch(/contracts: \[\]/);
  });
});

// ─── A4: present-key update unchanged from pre-fix behavior ──────────────

describe('CAWS-MERGE-CLOSE-MISSING-UPDATED-AT-001 A4: present-key path unchanged', () => {
  let env;
  beforeEach(() => { env = mkBareGitRepo('caws-cmc-a4-'); });
  afterEach(() => rmrf(env.root));

  it('closeSpec updates existing updated_at in place; no duplication', () => {
    const specPath = path.join(env.cawsDir, 'specs', 'MODERN-1.yaml');
    fs.writeFileSync(specPath, specYamlWithUpdatedAt('MODERN-1'));

    const r = closeSpec(env.cawsDir, {
      id: 'MODERN-1',
      resolution: 'completed',
      actor: ACTOR,
      now: NOW,
    });
    expect(r.ok).toBe(true);
    expect(r.value.kind).toBe('success');

    const patched = fs.readFileSync(specPath, 'utf8');
    // Exactly ONE updated_at line — the insert fallback MUST NOT fire
    // when the key was already present.
    const updatedAtLines = patched.split('\n').filter((l) => l.startsWith('updated_at:'));
    expect(updatedAtLines).toHaveLength(1);
    expect(updatedAtLines[0]).toBe(`updated_at: '2026-05-27T22:00:00.000Z'`);
    // Old value is gone.
    expect(patched).not.toMatch(/2026-05-15T12:00:00\.000Z/);
  });
});
