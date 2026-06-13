'use strict';

/**
 * Unit tests for shell binding resolution (A4 — bound / unbound / one_sided).
 *
 * CAWS-TEST-CLI-SHELL-001. Two surfaces:
 *   - parseWorktreePorcelain: the PURE parser for `git worktree list
 *     --porcelain` output (blank-line-separated records, optional branch).
 *   - resolveBinding: turns (repoRoot, cwd, registry, specs) into a
 *     BindingState. Tested in-process with an injected gitWorktreeList and real
 *     temp paths (no real git), so the bound/unbound/one_sided classification is
 *     asserted deterministically. A mutation that reports a one-sided binding as
 *     bound (E36-adjacent: misreading a partial binding) is killed.
 *
 * SUT loaded from dist/.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  parseWorktreePorcelain,
  resolveBinding,
} = require('../../dist/shell/binding/resolve-binding');

describe('parseWorktreePorcelain: parses the porcelain record format', () => {
  test('a single worktree with a branch', () => {
    const out = parseWorktreePorcelain('worktree /repo\nbranch refs/heads/main\n');
    expect(out).toEqual([{ path: '/repo', branch: 'refs/heads/main' }]);
  });

  test('multiple blank-line-separated records', () => {
    const text = [
      'worktree /repo',
      'branch refs/heads/main',
      '',
      'worktree /repo/.caws/worktrees/wt-a',
      'branch refs/heads/wt-a',
      '',
    ].join('\n');
    const out = parseWorktreePorcelain(text);
    expect(out).toEqual([
      { path: '/repo', branch: 'refs/heads/main' },
      { path: '/repo/.caws/worktrees/wt-a', branch: 'refs/heads/wt-a' },
    ]);
  });

  test('a worktree without a branch line (detached) parses with no branch', () => {
    const out = parseWorktreePorcelain('worktree /repo\nHEAD abc123\n');
    expect(out).toEqual([{ path: '/repo' }]);
  });

  test('the final record without a trailing blank line is still captured', () => {
    const out = parseWorktreePorcelain('worktree /a\nbranch x\n\nworktree /b\nbranch y');
    expect(out.map((w) => w.path)).toEqual(['/a', '/b']);
    expect(out[1]).toEqual({ path: '/b', branch: 'y' });
  });

  test('empty input -> no entries', () => {
    expect(parseWorktreePorcelain('')).toEqual([]);
  });
});

describe('resolveBinding: bound / unbound / one_sided classification', () => {
  const dirs = [];
  function tmp(name) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-bind-'));
    dirs.push(base);
    const p = path.join(base, name);
    fs.mkdirSync(p, { recursive: true });
    return p;
  }
  afterAll(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  /** Minimal spec carrying only id + worktree (the binding-relevant fields). */
  const spec = (id, worktree) => ({ id, worktree });

  test('bidirectional binding (registry.specId === spec.id AND spec.worktree === name) -> bound', () => {
    const wtPath = tmp('wt-a');
    const repoRoot = tmp('repo');
    const r = resolveBinding({
      repoRoot,
      cwd: wtPath,
      registry: { 'wt-a': { specId: 'SPEC-1', path: wtPath } },
      specs: [spec('SPEC-1', 'wt-a')],
      gitWorktreeList: () => [{ path: wtPath, branch: 'wt-a' }],
    });
    expect(r.binding.kind).toBe('bound');
    expect(r.worktreeName).toBe('wt-a');
  });

  test('registry points to a spec, but spec.worktree is unset -> one_sided (NOT bound)', () => {
    const wtPath = tmp('wt-b');
    const repoRoot = tmp('repo');
    const r = resolveBinding({
      repoRoot,
      cwd: wtPath,
      registry: { 'wt-b': { specId: 'SPEC-1', path: wtPath } },
      specs: [spec('SPEC-1', undefined)], // spec does NOT point back
      gitWorktreeList: () => [{ path: wtPath, branch: 'wt-b' }],
    });
    // Exactly one direction is set -> one_sided. A mutation reporting this as
    // bound would be a silent authority escape.
    expect(r.binding.kind).toBe('one_sided');
  });

  test('registry specId and spec.worktree disagree (cross-mismatch) -> one_sided, not bound', () => {
    const wtPath = tmp('wt-c');
    const repoRoot = tmp('repo');
    const r = resolveBinding({
      repoRoot,
      cwd: wtPath,
      registry: { 'wt-c': { specId: 'SPEC-1', path: wtPath } },
      specs: [spec('SPEC-1', 'a-different-worktree')], // points elsewhere
      gitWorktreeList: () => [{ path: wtPath, branch: 'wt-c' }],
    });
    expect(r.binding.kind).toBe('one_sided');
  });

  test('cwd in the main checkout (no registry match) -> unbound', () => {
    const repoRoot = tmp('repo-main');
    const r = resolveBinding({
      repoRoot,
      cwd: repoRoot,
      registry: {},
      specs: [],
      gitWorktreeList: () => [{ path: repoRoot, branch: 'main' }],
    });
    expect(r.binding.kind).toBe('unbound');
    expect(r.worktreeName).toBeUndefined();
  });
});
