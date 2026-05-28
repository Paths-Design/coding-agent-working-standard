/**
 * SCOPE-CHECK-CWD-BINDING-RESOLUTION-001 — resolveBinding cwd-independence.
 *
 * resolveBinding must resolve the governing binding for a TARGET PATH via a
 * deterministic 3-step fallback chain, independent of process.cwd():
 *   (1) cwd registry/porcelain match   (existing; strongest intent)
 *   (2) target-path worktree-location  (path under .caws/worktrees/<name>/)
 *   (3) target-path scope.in claim     (a bound spec's scope.in admits the
 *                                        canonical path) — fixes the post-
 *                                        sparse-checkout canonical-path case.
 * Step (3) tie-break is REFUSE-ON-CONFLICT: >1 bound claimant → a distinct
 * ambiguous result naming every claimant, with actionable resolution detail.
 *
 * These tests inject registry/specs/gitWorktreeList so they are deterministic
 * and do not touch real git. They run against dist/ like the sibling
 * resolve-binding-primitive.test.js.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { resolveBinding } = require('../../dist/shell');

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Minimal valid loaded-spec stub with a scope.in list. */
function specStub(id, scopeIn, worktreeName) {
  return {
    id,
    lifecycle_state: 'active',
    worktree: worktreeName,
    scope: { in: scopeIn, out: [] },
  };
}

describe('resolveBinding — step (3) scope.in-claim resolution (cwd-independent)', () => {
  let repoRoot;
  let wtRoot;
  afterEach(() => {
    if (repoRoot) fs.rmSync(repoRoot, { recursive: true, force: true });
    if (wtRoot) fs.rmSync(wtRoot, { recursive: true, force: true });
    repoRoot = undefined;
    wtRoot = undefined;
  });

  it('targetPath claimed by ONE bound spec resolves to that binding even when cwd is the main checkout', () => {
    repoRoot = mkTmp('caws-rb-claim-');
    wtRoot = mkTmp('caws-rb-wt-');
    const r = resolveBinding({
      repoRoot,
      cwd: repoRoot, // MAIN checkout — the failing case today
      targetPath: 'packages/foo/bar.ts',
      registry: { 'wt-a': { path: wtRoot, specId: 'FEAT-A' } },
      specs: [specStub('FEAT-A', ['packages/foo/bar.ts'], 'wt-a')],
      gitWorktreeList: () => [],
    });
    // Must NOT be unbound: the path is claimed by FEAT-A's scope.in.
    expect(r.binding.kind).not.toBe('unbound');
    expect(r.worktreeName).toBe('wt-a');
    expect(r.source).toBe('target_scope_in_claim');
  });

  it('with NO targetPath and cwd=main, behavior is unchanged (unbound)', () => {
    repoRoot = mkTmp('caws-rb-nopath-');
    wtRoot = mkTmp('caws-rb-wt-');
    const r = resolveBinding({
      repoRoot,
      cwd: repoRoot,
      // no targetPath
      registry: { 'wt-a': { path: wtRoot, specId: 'FEAT-A' } },
      specs: [specStub('FEAT-A', ['packages/foo/bar.ts'], 'wt-a')],
      gitWorktreeList: () => [],
    });
    expect(r.binding.kind).toBe('unbound');
  });

  it('cwd-inside-worktree still wins (step 1) even when a targetPath is given', () => {
    repoRoot = mkTmp('caws-rb-cwdwin-');
    wtRoot = mkTmp('caws-rb-wt-');
    const r = resolveBinding({
      repoRoot,
      cwd: wtRoot, // physically inside wt-a
      targetPath: 'packages/other/thing.ts',
      registry: { 'wt-a': { path: wtRoot, specId: 'FEAT-A' } },
      specs: [specStub('FEAT-A', ['packages/foo/bar.ts'], 'wt-a')],
      gitWorktreeList: () => [],
    });
    expect(r.worktreeName).toBe('wt-a');
    expect(r.source).toBe('registry_path_match'); // step 1, not step 3
  });
});

describe('resolveBinding — step (3) refuse-on-conflict (ambiguous binding)', () => {
  let repoRoot;
  let wtA;
  let wtB;
  afterEach(() => {
    for (const d of [repoRoot, wtA, wtB]) if (d) fs.rmSync(d, { recursive: true, force: true });
    repoRoot = wtA = wtB = undefined;
  });

  it('two bound specs claiming the same path → ambiguous result naming both claimants with actionable detail', () => {
    repoRoot = mkTmp('caws-rb-amb-');
    wtA = mkTmp('caws-rb-wta-');
    wtB = mkTmp('caws-rb-wtb-');
    const r = resolveBinding({
      repoRoot,
      cwd: repoRoot,
      targetPath: 'packages/shared/thing.ts',
      registry: {
        'wt-a': { path: wtA, specId: 'FEAT-A' },
        'wt-b': { path: wtB, specId: 'FEAT-B' },
      },
      specs: [
        specStub('FEAT-A', ['packages/shared/thing.ts'], 'wt-a'),
        specStub('FEAT-B', ['packages/shared'], 'wt-b'),
      ],
      gitWorktreeList: () => [],
    });
    // binding stays unbound (safe default); ambiguity rides in r.ambiguous.
    expect(r.binding.kind).toBe('unbound');
    expect(r.ambiguous).toBeDefined();
    expect(r.ambiguous.targetPath).toBe('packages/shared/thing.ts');
    // Names BOTH claimants (spec id + worktree + matching scope.in entry).
    const claimants = r.ambiguous.claimants;
    expect(Array.isArray(claimants)).toBe(true);
    const byId = Object.fromEntries(claimants.map((c) => [c.specId, c]));
    expect(byId['FEAT-A']).toBeDefined();
    expect(byId['FEAT-B']).toBeDefined();
    expect(byId['FEAT-A'].worktreeName).toBe('wt-a');
    expect(byId['FEAT-A'].matchedScopeInEntry).toBe('packages/shared/thing.ts');
    expect(byId['FEAT-B'].matchedScopeInEntry).toBe('packages/shared');
    // It must NOT silently pick one.
    expect(r.worktreeName).toBeUndefined();
  });
});
