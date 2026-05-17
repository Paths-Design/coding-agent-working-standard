/**
 * Primitive 5c.4a regression test for resolveBinding.
 *
 * Locks the semantic that a registry-matched worktree with NO `specId`
 * resolves to `unbound`, not `one_sided`. This matters because downstream
 * `scope check` keys its diagnostic (`scope.no_authority.unbound` vs
 * `scope.no_authority.binding_one_sided`) off this state and surfaces
 * different repairs.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { resolveBinding } = require('../../dist/shell');

function mkTempRepoRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'caws-shell-rb-'));
}

describe('resolveBinding — semantic correctness', () => {
  let repoRoot;
  let worktreeRoot;
  afterEach(() => {
    if (repoRoot) fs.rmSync(repoRoot, { recursive: true, force: true });
    if (worktreeRoot) fs.rmSync(worktreeRoot, { recursive: true, force: true });
  });

  it('registry-matched worktree with NO specId resolves to unbound (NOT one_sided)', () => {
    repoRoot = mkTempRepoRoot();
    worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-shell-wt-'));
    const r = resolveBinding({
      repoRoot,
      cwd: worktreeRoot,
      registry: {
        'wt-x': { path: worktreeRoot }, // no specId
      },
      specs: [],
      // Stub out git porcelain so the test does not depend on real git
      // (we want the registry-path match to fire, not the porcelain fallback).
      gitWorktreeList: () => [],
    });
    expect(r.binding.kind).toBe('unbound');
    expect(r.worktreeName).toBe('wt-x');
    expect(r.source).toBe('registry_path_match');
  });

  it('registry has specId but the spec did not load → one_sided', () => {
    // This case IS legitimately one-sided: registry points at a spec that
    // the store could not parse/validate. Repair = re-validate/fix that
    // spec, not "bind this worktree".
    repoRoot = mkTempRepoRoot();
    worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-shell-wt-'));
    const r = resolveBinding({
      repoRoot,
      cwd: worktreeRoot,
      registry: {
        'wt-x': { path: worktreeRoot, specId: 'MISSING-1' },
      },
      specs: [], // MISSING-1 didn't load
      gitWorktreeList: () => [],
    });
    expect(r.binding.kind).toBe('one_sided');
    if (r.binding.kind === 'one_sided') {
      expect(r.binding.detail.registryHasSpecId).toBe(true);
      expect(r.binding.detail.registrySpecId).toBe('MISSING-1');
    }
    expect(r.worktreeName).toBe('wt-x');
  });

  it('cwd outside any worktree → unbound, no worktreeName, source=none', () => {
    repoRoot = mkTempRepoRoot();
    const r = resolveBinding({
      repoRoot,
      cwd: repoRoot, // main checkout itself
      registry: {},
      specs: [],
      gitWorktreeList: () => [],
    });
    expect(r.binding.kind).toBe('unbound');
    expect(r.worktreeName).toBeUndefined();
    expect(r.source).toBe('none');
  });
});
