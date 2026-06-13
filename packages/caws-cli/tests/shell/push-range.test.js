'use strict';

/**
 * Unit tests for the push-range guard (A1, lineage E18 — silent push of a
 * parallel-session commit).
 *
 * CAWS-TEST-CLI-SHELL-001. classifyRange is a PURE classifier: given the
 * outgoing commits, the specs + their scope.in, the current slice, and the
 * acked SHAs, it produces a report and a refuse/proceed decision. The guard's
 * whole point is to REFUSE a commit that is not attributable to the current
 * slice — exactly the Entry 18 failure (an authority push silently carried a
 * peer session's commit). Tests assert the actual classification + refusal, so
 * a mutation that admits a foreign commit is killed.
 *
 * SUT loaded from dist/.
 */

const { classifyRange } = require('../../dist/shell/push-range/classify-range');
const { scopeEntryMatches, normalizeRel } = require('../../dist/shell/push-range/scope-match');

const ORIGIN_MAIN = { remote: 'origin', branch: 'main' };

function input(over = {}) {
  return {
    commits: [],
    specs: [],
    baseRef: 'origin/main',
    target: ORIGIN_MAIN,
    ...over,
  };
}

const spec = (specId, scopeIn, lifecycleState = 'active') => ({ specId, scopeIn, lifecycleState });
const commit = (sha, subject, touchedFiles, over = {}) => ({ sha, subject, touchedFiles, ...over });

describe('scope-match: normalizeRel + scopeEntryMatches', () => {
  test('normalizeRel strips ./ prefix, trailing slash, backslashes', () => {
    expect(normalizeRel('./src/x.ts')).toBe('src/x.ts');
    expect(normalizeRel('src/x/')).toBe('src/x');
    expect(normalizeRel('src\\x.ts')).toBe('src/x.ts');
  });

  test('exact match', () => {
    expect(scopeEntryMatches('src/x.ts', 'src/x.ts')).toBe(true);
  });

  test('directory entry matches descendants ON A PATH BOUNDARY only', () => {
    expect(scopeEntryMatches('src/store', 'src/store/x.ts')).toBe(true);
    // 'src/store' must NOT match 'src/storefront.ts' (sibling, not descendant).
    expect(scopeEntryMatches('src/store', 'src/storefront.ts')).toBe(false);
  });

  test('a glob entry matches by anchored pattern', () => {
    expect(scopeEntryMatches('src/*.ts', 'src/x.ts')).toBe(true);
    expect(scopeEntryMatches('src/*.ts', 'src/x.js')).toBe(false);
    expect(scopeEntryMatches('src/?.ts', 'src/a.ts')).toBe(true);
    expect(scopeEntryMatches('src/?.ts', 'src/ab.ts')).toBe(false);
  });
});

describe('classifyRange: provenance attribution', () => {
  test('a commit touching a spec scope.in is attributed by file_touch', () => {
    const r = classifyRange(
      input({
        commits: [commit('aaa', 'do work', ['src/store/x.ts'])],
        specs: [spec('SPEC-1', ['src/store'])],
        currentSpecId: 'SPEC-1',
      })
    );
    const c = r.commits[0];
    expect(c.inferredSpecIds).toEqual(['SPEC-1']);
    expect(c.provenanceSource).toBe('file_touch');
    expect(c.currentSliceMatch).toBe(true);
    expect(c.ambiguous).toBe(false);
  });

  test('a commit naming a KNOWN spec in its subject is attributed by commit_subject (additive)', () => {
    const r = classifyRange(
      input({
        commits: [commit('bbb', 'fix something (SPEC-2)', ['unrelated/file.ts'])],
        specs: [spec('SPEC-2', ['src/store'])],
      })
    );
    const c = r.commits[0];
    expect(c.inferredSpecIds).toEqual(['SPEC-2']);
    expect(c.provenanceSource).toBe('commit_subject');
  });

  test('file_touch AND subject -> combined provenance source', () => {
    const r = classifyRange(
      input({
        commits: [commit('ccc', 'work on SPEC-1', ['src/store/x.ts'])],
        specs: [spec('SPEC-1', ['src/store'])],
      })
    );
    expect(r.commits[0].provenanceSource).toBe('file_touch+commit_subject');
  });

  test('a commit matching NO spec by file-touch and naming no known spec is AMBIGUOUS', () => {
    const r = classifyRange(
      input({
        commits: [commit('ddd', 'random change', ['nowhere/x.ts'])],
        specs: [spec('SPEC-1', ['src/store'])],
      })
    );
    const c = r.commits[0];
    expect(c.ambiguous).toBe(true);
    expect(c.provenanceSource).toBe('none');
    expect(c.inferredSpecIds).toEqual([]);
  });

  test('subject mentioning an UNKNOWN spec id does not attribute it (only known specs)', () => {
    const r = classifyRange(
      input({
        commits: [commit('eee', 'ref NOPE-99', ['nowhere/x.ts'])],
        specs: [spec('SPEC-1', ['src/store'])],
      })
    );
    expect(r.commits[0].ambiguous).toBe(true);
  });

  test('only active/closed specs are considered (a draft spec is ignored)', () => {
    const r = classifyRange(
      input({
        commits: [commit('fff', 'work', ['src/store/x.ts'])],
        specs: [spec('SPEC-DRAFT', ['src/store'], 'draft')],
      })
    );
    expect(r.commits[0].inferredSpecIds).toEqual([]); // draft not considered
  });
});

describe('classifyRange: refusal (E18 — foreign/unattributable commit is REFUSED)', () => {
  test('a current-slice commit alone PROCEEDS (not refused)', () => {
    const r = classifyRange(
      input({
        commits: [commit('aaa', 'work', ['src/store/x.ts'])],
        specs: [spec('SPEC-1', ['src/store'])],
        currentSpecId: 'SPEC-1',
      })
    );
    expect(r.refused).toBe(false);
    expect(r.unexpectedUnacked).toEqual([]);
  });

  test('a commit NOT matching the current slice is unexpected -> REFUSED', () => {
    const r = classifyRange(
      input({
        commits: [
          commit('aaa', 'mine', ['src/store/x.ts']),
          commit('bbb', 'a peer-session commit', ['other/y.ts']), // foreign
        ],
        specs: [spec('SPEC-1', ['src/store'])],
        currentSpecId: 'SPEC-1',
      })
    );
    expect(r.refused).toBe(true);
    expect(r.unexpectedUnacked).toEqual(['bbb']);
    expect(r.maxSeverity).toBe('ERROR');
  });

  test('acking the foreign SHA clears the refusal (per-SHA acknowledgement)', () => {
    const r = classifyRange(
      input({
        commits: [
          commit('aaa', 'mine', ['src/store/x.ts']),
          commit('bbb', 'peer', ['other/y.ts']),
        ],
        specs: [spec('SPEC-1', ['src/store'])],
        currentSpecId: 'SPEC-1',
        ackedShas: ['bbb'],
      })
    );
    expect(r.refused).toBe(false);
    expect(r.unexpectedUnacked).toEqual([]);
  });

  test('an ambiguous (unattributable) commit is unexpected and REFUSED', () => {
    const r = classifyRange(
      input({
        commits: [commit('zzz', 'mystery', ['nowhere/x.ts'])],
        specs: [spec('SPEC-1', ['src/store'])],
        currentSpecId: 'SPEC-1',
      })
    );
    expect(r.refused).toBe(true);
    expect(r.unexpectedUnacked).toEqual(['zzz']);
  });
});

describe('classifyRange: foreign-worktree severity (origin/main escalates; feature branch weakens)', () => {
  const fwt = (over = {}) => ({
    name: 'wt-x',
    path: '/wt/x',
    unregistered: false,
    unmerged: false,
    ...over,
  });

  test('on origin/main, an unmerged foreign worktree is an ERROR and REFUSES', () => {
    const r = classifyRange(
      input({ foreignWorktrees: [fwt({ unmerged: true })] })
    );
    expect(r.foreignWorktrees[0].severity).toBe('ERROR');
    expect(r.foreignWorktrees[0].reasons).toContain('unmerged branch');
    expect(r.refused).toBe(true);
  });

  test('on origin/main, an unregistered foreign worktree is an ERROR', () => {
    const r = classifyRange(input({ foreignWorktrees: [fwt({ unregistered: true })] }));
    expect(r.foreignWorktrees[0].severity).toBe('ERROR');
  });

  test('on origin/main, a clean foreign worktree (no OR-condition) is WARN, does NOT refuse', () => {
    const r = classifyRange(input({ foreignWorktrees: [fwt()] }));
    expect(r.foreignWorktrees[0].severity).toBe('WARN');
    expect(r.refused).toBe(false);
  });

  test('on a FEATURE branch, the same unmerged worktree weakens to WARN (does not refuse)', () => {
    const r = classifyRange(
      input({
        target: { remote: 'origin', branch: 'feature/x' },
        foreignWorktrees: [fwt({ unmerged: true })],
      })
    );
    expect(r.foreignWorktrees[0].severity).toBe('WARN');
    expect(r.refused).toBe(false);
  });
});
