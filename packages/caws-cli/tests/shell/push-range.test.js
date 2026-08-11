'use strict';

/**
 * Unit tests for the push-range guard (lineage E18 — silent push of a
 * parallel-session commit), reworked for CAWS-PREPUSH-PROVENANCE-REWORK-001.
 *
 * CAWS-TEST-CLI-SHELL-001. classifyRange is a PURE classifier: given the
 * outgoing commits, the governed-merge coverage (from worktree_merged
 * events), the specs + their scope.in (advisory attribution), and the
 * acked SHAs, it produces a report and a refuse/proceed decision.
 *
 * The refusal model is GOVERNANCE PROVENANCE, not slice attribution: a
 * commit refuses iff governance never touched it — no worktree_merged
 * coverage, no recognized CLI bookkeeping shape, no operator ack
 * (unvetted_direct) — or an ERROR-severity foreign worktree exists. A
 * registered, fully-merged worktree whose owner session is dead is a
 * GHOST: advisory, never ERROR (A7).
 *
 * SUT loaded from dist/.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { classifyRange } = require('../../dist/shell/push-range/classify-range');
const { scopeEntryMatches, normalizeRel } = require('../../dist/shell/push-range/scope-match');
const {
  normalizeCliAcks,
  loadAckStore,
  saveAckStore,
} = require('../../dist/shell/commands/prepush');

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

// helper: asserts array is a real array before returning it
function isOk_guard(arr) {
  expect(Array.isArray(arr)).toBe(true);
  return arr;
}

// 40-char hex fixtures for the ack helpers.
const SHA_A = '72321aabd9967a8dd4bba72d990936f750b9c96c';
const SHA_B = 'c7b4b42aeb1f8c563fc1d3e6e9479f6e41d64615';
const SHA_PFX1 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SHA_PFX2 = 'aaaaaaaabbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

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

describe('classifyRange: provenance attribution (advisory)', () => {
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

describe('classifyRange: governance classes (CAWS-PREPUSH-PROVENANCE-REWORK-001)', () => {
  test('a commit covered by a worktree_merged event is governed_merge and PROCEEDS', () => {
    const r = classifyRange(
      input({
        commits: [commit('aaa', 'merge(worktree): wt-x', [])],
        governedMergeShas: ['aaa'],
      })
    );
    expect(r.commits[0].governanceClass).toBe('governed_merge');
    expect(r.refused).toBe(false);
    expect(r.unvettedShas).toEqual([]);
  });

  test('a lane-range commit covered by an event is governed_merge (not just the merge commit)', () => {
    const r = classifyRange(
      input({
        commits: [
          commit('lane1', 'feat: lane work', ['src/x.ts']),
          commit('merge1', 'merge(worktree): wt-x', []),
        ],
        governedMergeShas: ['lane1', 'merge1'],
      })
    );
    expect(r.commits[0].governanceClass).toBe('governed_merge');
    expect(r.commits[1].governanceClass).toBe('governed_merge');
    expect(r.refused).toBe(false);
  });

  test('a CLI bookkeeping commit (chore(caws): + governed-state paths) is cli_bookkeeping and PROCEEDS', () => {
    const r = classifyRange(
      input({
        commits: [commit('b1', 'chore(caws): close SPEC-1', ['.caws/specs/SPEC-1.yaml'])],
      })
    );
    expect(r.commits[0].governanceClass).toBe('cli_bookkeeping');
    expect(r.refused).toBe(false);
  });

  test('a forged chore(caws): subject touching NON-governed paths is NOT bookkeeping', () => {
    const r = classifyRange(
      input({
        commits: [commit('b2', 'chore(caws): lookalike', ['src/store/x.ts'])],
      })
    );
    expect(r.commits[0].governanceClass).toBe('unvetted_direct');
    expect(r.refused).toBe(true);
    expect(r.unvettedShas).toEqual(['b2']);
  });

  test('.caws/policy.yaml is NOT bookkeeping-shaped (gate policy is supply-chain-sensitive)', () => {
    const r = classifyRange(
      input({
        commits: [commit('b3', 'chore(caws): tweak policy', ['.caws/policy.yaml'])],
      })
    );
    expect(r.commits[0].governanceClass).toBe('unvetted_direct');
    expect(r.refused).toBe(true);
  });

  test('.caws/hooks/ is NOT bookkeeping-shaped (guard source)', () => {
    const r = classifyRange(
      input({
        commits: [commit('b4', 'chore(caws): tweak hooks', ['.caws/hooks/scope-guard.sh'])],
      })
    );
    expect(r.commits[0].governanceClass).toBe('unvetted_direct');
    expect(r.refused).toBe(true);
  });

  test('a chore(caws): commit touching NOTHING cannot be verified -> unvetted', () => {
    const r = classifyRange(
      input({
        commits: [commit('b5', 'chore(caws): empty', [])],
      })
    );
    expect(r.commits[0].governanceClass).toBe('unvetted_direct');
  });

  test('an acknowledged unvetted commit is acked_exception and PROCEEDS', () => {
    const r = classifyRange(
      input({
        commits: [commit('e1', 'docs: direct trunk commit', ['docs/x.md'])],
        ackedShas: ['e1'],
      })
    );
    expect(r.commits[0].governanceClass).toBe('acked_exception');
    expect(r.refused).toBe(false);
    expect(r.unvettedShas).toEqual([]);
  });

  test('precedence: governed-merge beats ack; bookkeeping beats ack', () => {
    const r = classifyRange(
      input({
        commits: [
          commit('p1', 'merge(worktree): wt-x', []),
          commit('p2', 'chore(caws): close SPEC-1', ['.caws/specs/SPEC-1.yaml']),
        ],
        governedMergeShas: ['p1'],
        ackedShas: ['p1', 'p2'],
      })
    );
    expect(r.commits[0].governanceClass).toBe('governed_merge');
    expect(r.commits[1].governanceClass).toBe('cli_bookkeeping');
  });

  test('A3: a fully-governed range (governed merges + bookkeeping) proceeds with ZERO acks', () => {
    const r = classifyRange(
      input({
        commits: [
          commit('m1', 'merge(worktree): wt-a', []),
          commit('lane1', 'feat: lane work', ['src/a.ts']),
          commit('k1', 'chore(caws): close SPEC-A-1', ['.caws/specs/SPEC-A-1.yaml']),
        ],
        governedMergeShas: ['m1', 'lane1'],
      })
    );
    expect(r.refused).toBe(false);
    expect(r.unvettedShas).toEqual([]);
    expect(r.maxSeverity).toBe('INFO');
  });

  test('A4: an unvetted direct commit refuses, naming EXACTLY the unvetted commits', () => {
    const r = classifyRange(
      input({
        commits: [
          commit('m1', 'merge(worktree): wt-a', []),
          commit('x1', 'direct edit one', ['src/a.ts']),
          commit('k1', 'chore(caws): close SPEC-A-1', ['.caws/specs/SPEC-A-1.yaml']),
          commit('x2', 'direct edit two', ['README.md']),
        ],
        governedMergeShas: ['m1'],
      })
    );
    expect(r.refused).toBe(true);
    expect(r.unvettedShas).toEqual(['x1', 'x2']);
    expect(r.maxSeverity).toBe('ERROR');
  });

  test('advisory fields survive the rework (slice attribution still reported)', () => {
    const r = classifyRange(
      input({
        commits: [commit('aaa', 'work', ['src/store/x.ts'])],
        specs: [spec('SPEC-1', ['src/store'])],
        currentSpecId: 'SPEC-1',
        governedMergeShas: ['aaa'],
      })
    );
    expect(r.commits[0].currentSliceMatch).toBe(true);
    expect(r.commits[0].inferredSpecIds).toEqual(['SPEC-1']);
    expect(r.commits[0].governanceClass).toBe('governed_merge');
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

describe('classifyRange: ghost worktrees (A7 — dead owner + fully merged = advisory, never ERROR)', () => {
  const fwt = (over = {}) => ({
    name: 'wt-ghost',
    path: '/wt/ghost',
    unregistered: false,
    unmerged: false,
    ...over,
  });

  test('registered + fully merged + dead owner session is a GHOST: WARN with remediation, does NOT refuse', () => {
    const r = classifyRange(
      input({ foreignWorktrees: [fwt({ ownerSessionLive: false })] })
    );
    const f = r.foreignWorktrees[0];
    expect(f.ghost).toBe(true);
    expect(f.severity).toBe('WARN');
    expect(f.reasons).toContain('branch fully merged into base');
    expect(f.reasons).toContain('owner session is not live (no active lease or dead pid)');
    expect(f.remediation).toMatch(/caws worktree destroy/);
    expect(r.refused).toBe(false);
    expect(r.maxSeverity).toBe('WARN'); // never ERROR
  });

  test('a ghost-shaped worktree with a LIVE owner is not a ghost (WARN, live-residue)', () => {
    const r = classifyRange(
      input({ foreignWorktrees: [fwt({ ownerSessionLive: true })] })
    );
    expect(r.foreignWorktrees[0].ghost).toBeUndefined();
    expect(r.foreignWorktrees[0].severity).toBe('WARN');
  });

  test('dead owner but UNMERGED branch is NOT a ghost — still ERROR (work could be lost)', () => {
    const r = classifyRange(
      input({ foreignWorktrees: [fwt({ unmerged: true, ownerSessionLive: false })] })
    );
    expect(r.foreignWorktrees[0].ghost).toBeUndefined();
    expect(r.foreignWorktrees[0].severity).toBe('ERROR');
    expect(r.refused).toBe(true);
  });

  test('liveness UNKNOWN (ownerSessionLive undefined) keeps the legacy escalation', () => {
    const r = classifyRange(
      input({ foreignWorktrees: [fwt({ unmerged: true })] })
    );
    expect(r.foreignWorktrees[0].severity).toBe('ERROR');
  });
});

describe('classifyRange: closed specs are considered', () => {
  test('a closed spec is considered for file-touch attribution', () => {
    const r = classifyRange(
      input({
        commits: [commit('abc', 'work', ['src/store/x.ts'])],
        specs: [spec('SPEC-CLOSED', ['src/store'], 'closed')],
        currentSpecId: 'SPEC-CLOSED',
        governedMergeShas: ['abc'],
      })
    );
    expect(isOk_guard(r.commits[0].inferredSpecIds)).toContain('SPEC-CLOSED');
    expect(r.commits[0].currentSliceMatch).toBe(true);
    expect(r.refused).toBe(false);
  });

  test('a draft spec is NOT considered (only active/closed)', () => {
    const r = classifyRange(
      input({
        commits: [commit('abc', 'work', ['src/store/x.ts'])],
        specs: [spec('SPEC-DRAFT', ['src/store'], 'draft')],
        currentSpecId: 'SPEC-DRAFT',
      })
    );
    // Draft excluded → ambiguous, currentSliceMatch false, unvetted → refused
    expect(r.commits[0].inferredSpecIds).toEqual([]);
    expect(r.commits[0].currentSliceMatch).toBe(false);
    expect(r.refused).toBe(true);
  });
});

describe('classifyRange: SPEC_ID_IN_SUBJECT regex', () => {
  test('extracts a standard SPEC-123 from commit subject', () => {
    const r = classifyRange(
      input({
        commits: [commit('s1', 'fix(cli): ref SPEC-42', ['unrelated/x.ts'])],
        specs: [spec('SPEC-42', ['src/store'])],
      })
    );
    expect(r.commits[0].inferredSpecIds).toContain('SPEC-42');
    expect(r.commits[0].provenanceSource).toBe('commit_subject');
  });

  test('extracts a SPEC-ID with lowercase suffix (e.g. SPEC-42a)', () => {
    const r = classifyRange(
      input({
        commits: [commit('s2', 'fix: work on SPEC-42a', ['unrelated/x.ts'])],
        specs: [spec('SPEC-42a', ['src/store'])],
      })
    );
    expect(r.commits[0].inferredSpecIds).toContain('SPEC-42a');
  });

  test('does NOT match partial word like SPEC-42xxx (suffix boundary violated)', () => {
    const r = classifyRange(
      input({
        commits: [commit('s3', 'fix: SPEC-42xxx', ['unrelated/x.ts'])],
        specs: [spec('SPEC-42', ['src/store'])],
      })
    );
    expect(r.commits[0].ambiguous).toBe(true);
    const r2 = classifyRange(
      input({
        commits: [commit('s3b', 'fix: SPEC-42', ['unrelated/x.ts'])],
        specs: [spec('SPEC-42', ['src/store'])],
      })
    );
    expect(r2.commits[0].inferredSpecIds).toContain('SPEC-42');
  });

  test('multiple spec IDs in one subject — all known ones are extracted', () => {
    const r = classifyRange(
      input({
        commits: [commit('s4', 'fix: refs SPEC-1 and SPEC-2', ['unrelated/x.ts'])],
        specs: [spec('SPEC-1', ['a']), spec('SPEC-2', ['b'])],
      })
    );
    expect(isOk_guard(r.commits[0].inferredSpecIds).sort()).toEqual(['SPEC-1', 'SPEC-2']);
    expect(r.commits[0].provenanceSource).toBe('commit_subject');
  });
});

describe('classifyRange: severity rank ordering and maxSeverity', () => {
  const fwt = (over = {}) => ({
    name: 'wt-y', path: '/wt/y',
    unregistered: false, unmerged: false,
    ...over,
  });

  test('maxSeverity is INFO when no commits and no foreign worktrees', () => {
    const r = classifyRange(input({ commits: [], foreignWorktrees: [] }));
    expect(r.maxSeverity).toBe('INFO');
    expect(r.refused).toBe(false);
  });

  test('maxSeverity is WARN when only a clean foreign worktree exists (not ERROR)', () => {
    const r = classifyRange(input({ foreignWorktrees: [fwt()] }));
    expect(r.maxSeverity).toBe('WARN');
    expect(r.refused).toBe(false);
  });

  test('maxSeverity is ERROR when only unvetted commits exist (no foreign wts)', () => {
    const r = classifyRange(
      input({
        commits: [commit('foreign1', 'peer work', ['other/x.ts'])],
        specs: [spec('SPEC-1', ['src/store'])],
        currentSpecId: 'SPEC-1',
        foreignWorktrees: [],
      })
    );
    expect(r.unvettedShas).toEqual(['foreign1']);
    expect(r.maxSeverity).toBe('ERROR');
    expect(r.refused).toBe(true);
  });

  test('maxSeverity stays ERROR (highest) when both WARN foreign wt and unvetted commits', () => {
    const r = classifyRange(
      input({
        commits: [commit('foreign2', 'peer', ['other/y.ts'])],
        specs: [spec('SPEC-1', ['src/store'])],
        currentSpecId: 'SPEC-1',
        foreignWorktrees: [fwt()], // WARN severity on origin/main
      })
    );
    expect(r.maxSeverity).toBe('ERROR');
  });

  test('maxSeverity from a WARN worktree does NOT become ERROR without unvetted commits', () => {
    const r = classifyRange(
      input({
        commits: [commit('mine', 'work', ['src/store/x.ts'])],
        specs: [spec('SPEC-1', ['src/store'])],
        currentSpecId: 'SPEC-1',
        governedMergeShas: ['mine'],
        foreignWorktrees: [fwt()], // WARN on origin/main (no hard conditions)
      })
    );
    expect(r.unvettedShas).toEqual([]);
    expect(r.maxSeverity).toBe('WARN');
    expect(r.refused).toBe(false);
  });

  test('maxSeverity accumulates across multiple foreign worktrees — highest wins', () => {
    const r = classifyRange(
      input({
        foreignWorktrees: [
          fwt({ name: 'wt-warn', path: '/wt/warn' }),                    // WARN
          fwt({ name: 'wt-err', path: '/wt/err', unmerged: true }),      // ERROR
        ],
      })
    );
    expect(r.maxSeverity).toBe('ERROR');
    // ERROR worktree refuses even with no unvetted commits
    expect(r.refused).toBe(true);
  });
});

describe('classifyRange: file-touch matching uses some() not every()', () => {
  test('a commit touching ONE in-scope file (of several touched) is attributed', () => {
    const r = classifyRange(
      input({
        commits: [commit('x1', 'work', ['src/store/x.ts', 'unrelated/y.ts'])],
        specs: [spec('SPEC-1', ['src/store'])],
        currentSpecId: 'SPEC-1',
        governedMergeShas: ['x1'],
      })
    );
    expect(r.commits[0].inferredSpecIds).toContain('SPEC-1');
    expect(r.commits[0].currentSliceMatch).toBe(true);
    expect(r.refused).toBe(false);
  });

  test('a spec with one matching entry (of multiple scope.in) attributes the commit', () => {
    const r = classifyRange(
      input({
        commits: [commit('x2', 'work', ['src/store/x.ts'])],
        specs: [spec('SPEC-1', ['unrelated/path', 'src/store'])],
        currentSpecId: 'SPEC-1',
      })
    );
    expect(r.commits[0].inferredSpecIds).toContain('SPEC-1');
    expect(r.commits[0].currentSliceMatch).toBe(true);
  });
});

describe('classifyRange: inferredSpecIds includes both file_touch and subject matches', () => {
  test('file_touch + commit_subject attributions both appear in inferredSpecIds', () => {
    const r = classifyRange(
      input({
        commits: [commit('c1', 'ref SPEC-2', ['src/store/x.ts'])],
        specs: [spec('SPEC-1', ['src/store']), spec('SPEC-2', ['other'])],
      })
    );
    const ids = isOk_guard(r.commits[0].inferredSpecIds);
    expect(ids).toContain('SPEC-1'); // file_touch
    expect(ids).toContain('SPEC-2'); // commit_subject
    expect(r.commits[0].provenanceSource).toBe('file_touch+commit_subject');
  });

  test('inferredSpecIds is sorted (stable)', () => {
    const r = classifyRange(
      input({
        commits: [commit('c2', 'ref SPEC-Z and SPEC-A', ['unrelated/x.ts'])],
        specs: [spec('SPEC-Z', []), spec('SPEC-A', [])],
      })
    );
    const ids = r.commits[0].inferredSpecIds;
    expect(ids).toEqual([...ids].sort());
  });
});

describe('classifyRange: commit originWorktree and worktree branch fields', () => {
  test('classified commit includes originWorktree when the input commit has it', () => {
    const r = classifyRange(
      input({
        commits: [commit('o1', 'work', ['src/x.ts'], { originWorktree: 'wt-peer' })],
        specs: [],
      })
    );
    expect(r.commits[0].originWorktree).toBe('wt-peer');
  });

  test('classified commit does NOT have originWorktree when input commit lacks it', () => {
    const r = classifyRange(
      input({
        commits: [commit('o2', 'work', ['src/x.ts'])],
        specs: [],
      })
    );
    expect(Object.prototype.hasOwnProperty.call(r.commits[0], 'originWorktree')).toBe(false);
  });

  test('foreignWorktree result includes branch when it is defined', () => {
    const r = classifyRange(
      input({
        foreignWorktrees: [{
          name: 'wt-branch', path: '/wt/b',
          branch: 'feature/abc',
          unregistered: false, unmerged: false,
        }],
      })
    );
    expect(r.foreignWorktrees[0].branch).toBe('feature/abc');
  });

  test('foreignWorktree result omits branch key when branch is undefined', () => {
    const r = classifyRange(
      input({
        foreignWorktrees: [{
          name: 'wt-no-branch', path: '/wt/nb',
          unregistered: false, unmerged: false,
        }],
      })
    );
    expect(Object.prototype.hasOwnProperty.call(r.foreignWorktrees[0], 'branch')).toBe(false);
  });
});

describe('classifyRange: originWorktree → foreign worktree severity escalation', () => {
  const fwt = (over = {}) => ({
    name: 'wt-peer', path: '/wt/peer',
    unregistered: false, unmerged: false,
    ...over,
  });

  test('a commit originating from a foreign worktree adds it to reasons', () => {
    const r = classifyRange(
      input({
        commits: [commit('p1', 'peer work', ['other/x.ts'], { originWorktree: 'wt-peer' })],
        foreignWorktrees: [fwt()],
      })
    );
    expect(r.foreignWorktrees[0].reasons).toContain('commits in the outgoing range originate from it');
  });

  test('commits originating from a foreign worktree escalate severity to ERROR on origin/main', () => {
    const r = classifyRange(
      input({
        commits: [commit('p2', 'peer work', ['other/x.ts'], { originWorktree: 'wt-peer' })],
        foreignWorktrees: [fwt()],
      })
    );
    expect(r.foreignWorktrees[0].severity).toBe('ERROR');
    expect(r.refused).toBe(true);
  });

  test('a worktree not originating any commit stays WARN on origin/main when clean', () => {
    const r = classifyRange(
      input({
        commits: [commit('p3', 'my work', ['src/x.ts'], { originWorktree: 'wt-mine' })],
        foreignWorktrees: [fwt({ name: 'wt-different' })], // different name from originWorktree
      })
    );
    expect(r.foreignWorktrees[0].reasons).not.toContain('commits in the outgoing range originate from it');
    expect(r.foreignWorktrees[0].severity).toBe('WARN');
  });

  test('commit originWorktree equality is name-exact', () => {
    const r = classifyRange(
      input({
        commits: [
          commit('p4a', 'from wt-peer', ['a/x.ts'], { originWorktree: 'wt-peer' }),
          commit('p4b', 'from wt-other', ['b/y.ts'], { originWorktree: 'wt-other' }),
        ],
        foreignWorktrees: [
          fwt({ name: 'wt-peer' }),
          { name: 'wt-other', path: '/wt/other', unregistered: false, unmerged: false },
        ],
      })
    );
    const peer = r.foreignWorktrees.find((f) => f.name === 'wt-peer');
    expect(peer).toBeDefined();
    expect(peer.reasons).toContain('commits in the outgoing range originate from it');
    const other = r.foreignWorktrees.find((f) => f.name === 'wt-other');
    expect(other).toBeDefined();
    expect(other.reasons).toContain('commits in the outgoing range originate from it');
  });
});

describe('classifyRange: reason string literals', () => {
  const fwt = (over = {}) => ({
    name: 'wt-r', path: '/wt/r',
    unregistered: false, unmerged: false,
    ...over,
  });

  test('unregistered reason string is exact', () => {
    const r = classifyRange(input({ foreignWorktrees: [fwt({ unregistered: true })] }));
    expect(r.foreignWorktrees[0].reasons).toContain('branch not in worktrees.json');
  });

  test('unmerged reason string is exact', () => {
    const r = classifyRange(input({ foreignWorktrees: [fwt({ unmerged: true })] }));
    expect(r.foreignWorktrees[0].reasons).toContain('unmerged branch');
  });

  test('originating-commit reason string is exact', () => {
    const r = classifyRange(
      input({
        commits: [commit('r1', 'peer', ['x.ts'], { originWorktree: 'wt-r' })],
        foreignWorktrees: [fwt()],
      })
    );
    expect(r.foreignWorktrees[0].reasons).toContain('commits in the outgoing range originate from it');
  });

  test('on non-full-posture, a worktree with NO hard conditions is INFO', () => {
    const r = classifyRange(
      input({
        target: { remote: 'origin', branch: 'feature/y' },
        foreignWorktrees: [fwt()],
      })
    );
    expect(r.foreignWorktrees[0].severity).toBe('INFO');
    expect(r.refused).toBe(false);
  });

  test('on non-full-posture with a hard condition, severity is WARN not ERROR', () => {
    const r = classifyRange(
      input({
        target: { remote: 'origin', branch: 'feature/y' },
        foreignWorktrees: [fwt({ unmerged: true })],
      })
    );
    expect(r.foreignWorktrees[0].severity).toBe('WARN');
    expect(r.refused).toBe(false);
  });
});

describe('classifyRange: reasons.length > 0 boundary', () => {
  const fwt = (over = {}) => ({
    name: 'wt-len', path: '/wt/len',
    unregistered: false, unmerged: false,
    ...over,
  });

  test('zero reasons on origin/main → WARN (not ERROR), refuses=false', () => {
    const r = classifyRange(input({ foreignWorktrees: [fwt()] }));
    expect(r.foreignWorktrees[0].reasons).toHaveLength(0);
    expect(r.foreignWorktrees[0].severity).toBe('WARN');
  });

  test('non-empty reasons on origin/main → ERROR (distinguishes from zero-reason WARN)', () => {
    const r = classifyRange(input({ foreignWorktrees: [fwt({ unmerged: true })] }));
    expect(r.foreignWorktrees[0].reasons.length).toBeGreaterThan(0);
    expect(r.foreignWorktrees[0].severity).toBe('ERROR');
  });
});

describe('classifyRange: unvettedShas and fullPosture', () => {
  test('unvettedShas names the unvetted SHAs, governed commits excluded', () => {
    const r = classifyRange(
      input({
        commits: [
          commit('sha-mine', 'mine', ['src/store/x.ts']),
          commit('sha-peer', 'peer', ['other/y.ts']),
        ],
        specs: [spec('SPEC-1', ['src/store'])],
        currentSpecId: 'SPEC-1',
        governedMergeShas: ['sha-mine'],
      })
    );
    expect(r.unvettedShas).toEqual(['sha-peer']);
    expect(r.unvettedShas).not.toContain('sha-mine');
  });

  test('fullPosture requires BOTH remote=origin AND branch=main', () => {
    const fwt = { name: 'wt-fp', path: '/wt/fp', unregistered: false, unmerged: true };
    const rMain = classifyRange(input({ foreignWorktrees: [fwt] }));
    expect(rMain.foreignWorktrees[0].severity).toBe('ERROR'); // origin/main → full posture

    const rFeature = classifyRange(
      input({
        target: { remote: 'origin', branch: 'feature/z' },
        foreignWorktrees: [fwt],
      })
    );
    expect(rFeature.foreignWorktrees[0].severity).toBe('WARN'); // not full posture
  });

  test('fullPosture is false when remote is not origin', () => {
    const fwt = { name: 'wt-fp2', path: '/wt/fp2', unregistered: false, unmerged: true };
    const r = classifyRange(
      input({
        target: { remote: 'upstream', branch: 'main' },
        foreignWorktrees: [fwt],
      })
    );
    expect(r.foreignWorktrees[0].severity).toBe('WARN');
    expect(r.refused).toBe(false);
  });
});

describe('classifyRange: maxSeverity loop', () => {
  test('a single ERROR foreign worktree raises maxSeverity from INFO to ERROR', () => {
    const r = classifyRange(
      input({
        foreignWorktrees: [{
          name: 'wt-blk', path: '/wt/blk',
          unregistered: false, unmerged: true,
        }],
      })
    );
    expect(r.maxSeverity).toBe('ERROR');
  });
});

describe('classifyRange: maxSeverity set from unvettedShas', () => {
  test('maxSeverity = ERROR when unvettedShas > 0 even if foreignWorktrees is empty', () => {
    const r = classifyRange(
      input({
        commits: [commit('unexp', 'foreign work', ['other/x.ts'])],
        specs: [spec('SPEC-1', ['src/store'])],
        currentSpecId: 'SPEC-1',
      })
    );
    expect(r.unvettedShas).toEqual(['unexp']);
    expect(r.maxSeverity).toBe('ERROR');
  });

  test('maxSeverity stays at ERROR from foreign-wt even when unvettedShas length is 0', () => {
    const r = classifyRange(
      input({
        commits: [commit('mine', 'mine', ['src/store/x.ts'])],
        specs: [spec('SPEC-1', ['src/store'])],
        currentSpecId: 'SPEC-1',
        governedMergeShas: ['mine'],
        foreignWorktrees: [{
          name: 'wt-err', path: '/wt/err',
          unregistered: false, unmerged: true,
        }],
      })
    );
    expect(r.unvettedShas).toEqual([]);
    expect(r.maxSeverity).toBe('ERROR'); // set by the worktree loop, not by the unvetted branch
    expect(r.refused).toBe(true);
  });
});

describe('scope-match: return types and exact-match semantics', () => {
  test('normalizeRel returns the same string for an already-normalized path', () => {
    expect(normalizeRel('src/x.ts')).toBe('src/x.ts');
  });

  test('normalizeRel result is a non-empty string for a non-empty path', () => {
    const result = normalizeRel('src/foo/bar.ts');
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
    expect(result).toBe('src/foo/bar.ts');
  });

  test('scopeEntryMatches returns true (boolean) for an exact match, not a truthy object', () => {
    const result = scopeEntryMatches('src/x.ts', 'src/x.ts');
    expect(result).toBe(true);
    expect(typeof result).toBe('boolean');
  });

  test('scopeEntryMatches returns false (boolean) for a non-match, not a truthy object', () => {
    const result = scopeEntryMatches('src/x.ts', 'src/y.ts');
    expect(result).toBe(false);
    expect(typeof result).toBe('boolean');
  });
});

describe('scope-match: normalizeRel regex behavior', () => {
  test('./ prefix is stripped', () => {
    expect(normalizeRel('./src/x.ts')).toBe('src/x.ts');
    expect(normalizeRel('./src/x.ts')).not.toMatch(/^\.\//);
  });

  test('trailing slash is stripped', () => {
    expect(normalizeRel('src/x/')).toBe('src/x');
    expect(normalizeRel('src/x/')).not.toMatch(/\/$/);
  });

  test('both ./ and trailing slash stripped together', () => {
    expect(normalizeRel('./src/x/')).toBe('src/x');
  });

  test('path boundary: stripped trailing slash prevents false prefix match', () => {
    expect(scopeEntryMatches('src/store/', 'src/storefront.ts')).toBe(false);
    expect(scopeEntryMatches('./src/store', 'src/store/x.ts')).toBe(true);
  });

  test('multiple consecutive trailing slashes are all stripped', () => {
    expect(normalizeRel('src/x//')).toBe('src/x');
    expect(normalizeRel('src/x///')).toBe('src/x');
  });

  test('./ in the middle of a path is NOT stripped (only leading ./ is removed)', () => {
    expect(normalizeRel('a/./b.ts')).toBe('a/./b.ts');
  });
});

describe('classifyRange: currentSpecId=undefined does not grant currentSliceMatch', () => {
  test('when currentSpecId is undefined, no commit gets currentSliceMatch=true', () => {
    const r = classifyRange(
      input({
        commits: [commit('a1', 'work', ['src/store/x.ts'])],
        specs: [spec('SPEC-1', ['src/store'])],
        currentSpecId: undefined, // no current spec
      })
    );
    expect(r.commits[0].inferredSpecIds).toContain('SPEC-1');
    expect(r.commits[0].currentSliceMatch).toBe(false);
    // Nothing covers it → unvetted
    expect(r.unvettedShas).toContain('a1');
  });
});

describe('classifyRange: ackedShas default', () => {
  test('without ackedShas, no SHAs are pre-acked', () => {
    const r = classifyRange(
      input({
        commits: [commit('peer-sha', 'peer work', ['other/x.ts'])],
        specs: [spec('SPEC-1', ['src/store'])],
        currentSpecId: 'SPEC-1',
        // ackedShas intentionally omitted — tests the default
      })
    );
    expect(r.unvettedShas).toContain('peer-sha');
    expect(r.refused).toBe(true);
  });

  test('ackedShas defaults do not falsely ack any SHA that is not explicitly listed', () => {
    const rOmitted = classifyRange(
      input({
        commits: [commit('some-sha', 'peer', ['other/x.ts'])],
        specs: [spec('S1', ['src/x'])],
        currentSpecId: 'S1',
      })
    );
    const rEmpty = classifyRange(
      input({
        commits: [commit('some-sha', 'peer', ['other/x.ts'])],
        specs: [spec('S1', ['src/x'])],
        currentSpecId: 'S1',
        ackedShas: [],
      })
    );
    expect(rOmitted.unvettedShas).toEqual(rEmpty.unvettedShas);
    expect(rOmitted.refused).toBe(rEmpty.refused);
  });
});

describe('classifyRange: maxSeverity loop only upgrades (never downgrades)', () => {
  const fwt = (over = {}) => ({
    name: 'wt-sev', path: '/wt/sev',
    unregistered: false, unmerged: false,
    ...over,
  });

  test('when the first worktree is ERROR and the second is WARN, maxSeverity stays ERROR (not last-write-wins)', () => {
    const r = classifyRange(
      input({
        foreignWorktrees: [
          fwt({ name: 'wt-err', unmerged: true }),   // ERROR
          fwt({ name: 'wt-warn' }),                   // WARN (no conditions)
        ],
      })
    );
    expect(r.maxSeverity).toBe('ERROR');
  });

  test('when all worktrees are WARN, maxSeverity is WARN (not overwritten to INFO)', () => {
    const r = classifyRange(
      input({
        foreignWorktrees: [
          fwt({ name: 'wt-a' }),  // WARN
          fwt({ name: 'wt-b' }),  // WARN
        ],
      })
    );
    expect(r.maxSeverity).toBe('WARN');
    expect(r.refused).toBe(false);
  });
});

describe('classifyRange: severityRank ERROR comparison with existing maxSeverity', () => {
  const fwt = (over = {}) => ({
    name: 'wt-137', path: '/wt/137',
    unregistered: false, unmerged: false,
    ...over,
  });

  test('unvettedShas sets maxSeverity to ERROR even when maxSeverity is already WARN from a foreign wt', () => {
    const rWithWt = classifyRange(
      input({
        commits: [commit('unexp2', 'peer', ['other/x.ts'])],
        specs: [spec('SPEC-1', ['src/store'])],
        currentSpecId: 'SPEC-1',
        foreignWorktrees: [fwt()], // WARN worktree
      })
    );
    expect(rWithWt.unvettedShas).toEqual(['unexp2']);
    expect(rWithWt.maxSeverity).toBe('ERROR');
  });

  test('no unvettedShas + WARN worktree → maxSeverity stays WARN, not ERROR', () => {
    const r = classifyRange(
      input({
        commits: [commit('mine', 'mine', ['src/store/x.ts'])],
        specs: [spec('SPEC-1', ['src/store'])],
        currentSpecId: 'SPEC-1',
        governedMergeShas: ['mine'],
        foreignWorktrees: [fwt()], // WARN on origin/main
      })
    );
    expect(r.unvettedShas).toEqual([]);
    expect(r.maxSeverity).toBe('WARN'); // not ERROR
    expect(r.refused).toBe(false);
  });
});

// =========================================================================
// Command-layer ack helpers (CAWS-PREPUSH-PROVENANCE-REWORK-001 A5/A6).
// =========================================================================

describe('normalizeCliAcks (A6 — prefix-tolerant, never silently ignored)', () => {
  const noop = [];
  const report = (line) => noop.push(line);
  beforeEach(() => { noop.length = 0; });

  test('a FULL 40-char SHA (git rev-list output) matches', () => {
    const matched = normalizeCliAcks([SHA_A], [SHA_A, SHA_B], report);
    expect(matched).toEqual([SHA_A]);
    expect(noop).toEqual([]);
  });

  test('a 12-char prefix (the display form) matches', () => {
    const matched = normalizeCliAcks([SHA_A.slice(0, 12)], [SHA_A, SHA_B], report);
    expect(matched).toEqual([SHA_A]);
    expect(noop).toEqual([]);
  });

  test('a 7-char prefix (git abbrev minimum) matches', () => {
    const matched = normalizeCliAcks([SHA_A.slice(0, 7)], [SHA_A, SHA_B], report);
    expect(matched).toEqual([SHA_A]);
  });

  test('uppercase input is normalized to lowercase', () => {
    const matched = normalizeCliAcks([SHA_A.toUpperCase()], [SHA_A, SHA_B], report);
    expect(matched).toEqual([SHA_A]);
  });

  test('a non-matching ack produces a diagnostic NAMING it and is not recorded', () => {
    const matched = normalizeCliAcks(['fffffff'], [SHA_A, SHA_B], report);
    expect(matched).toEqual([]);
    expect(noop).toHaveLength(1);
    expect(noop[0]).toContain('fffffff');
    expect(noop[0]).toMatch(/did not match/);
  });

  test('an ambiguous prefix produces a diagnostic and is not recorded', () => {
    const matched = normalizeCliAcks(['aaaaaaa'], [SHA_PFX1, SHA_PFX2], report);
    expect(matched).toEqual([]);
    expect(noop).toHaveLength(1);
    expect(noop[0]).toMatch(/ambiguous/);
  });

  test('the ambiguous prefix lengthened to uniqueness resolves', () => {
    const matched = normalizeCliAcks(['aaaaaaaab'], [SHA_PFX1, SHA_PFX2], report);
    expect(matched).toEqual([SHA_PFX2]);
  });

  test('a non-hex / too-short ack produces a diagnostic', () => {
    const matched = normalizeCliAcks(['zz12'], [SHA_A], report);
    expect(matched).toEqual([]);
    expect(noop).toHaveLength(1);
    expect(noop[0]).toMatch(/not a valid hex SHA prefix/);
  });
});

describe('durable ack store (A5 — persists across invocations and sessions)', () => {
  const tmpDirs = [];
  function mkCawsDir() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ack-store-'));
    const caws = path.join(root, '.caws');
    fs.mkdirSync(caws, { recursive: true });
    tmpDirs.push(root);
    return caws;
  }
  afterAll(() => {
    for (const d of tmpDirs) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  test('an absent store reads as empty (no diagnostic)', () => {
    const store = loadAckStore(mkCawsDir());
    expect(store.acks).toEqual([]);
    expect(store.diagnostic).toBeUndefined();
  });

  test('save -> load round-trips the records (durable)', () => {
    const caws = mkCawsDir();
    saveAckStore(caws, [{ sha: SHA_A, acked_at: '2026-08-11T00:00:00Z' }]);
    const store = loadAckStore(caws);
    expect(store.acks).toEqual([{ sha: SHA_A, acked_at: '2026-08-11T00:00:00Z' }]);
  });

  test('save appends (accumulates) rather than replacing prior acks', () => {
    const caws = mkCawsDir();
    saveAckStore(caws, [{ sha: SHA_A, acked_at: '2026-08-11T00:00:00Z' }]);
    const prior = loadAckStore(caws).acks;
    saveAckStore(caws, [...prior, { sha: SHA_B, acked_at: '2026-08-11T01:00:00Z' }]);
    const store = loadAckStore(caws);
    expect(store.acks.map((a) => a.sha)).toEqual([SHA_A, SHA_B]);
  });

  test('a malformed store degrades to empty WITH a diagnostic (never a refusal)', () => {
    const caws = mkCawsDir();
    fs.writeFileSync(path.join(caws, 'prepush-acks.json'), '{not json', 'utf8');
    const store = loadAckStore(caws);
    expect(store.acks).toEqual([]);
    expect(store.diagnostic).toMatch(/malformed/);
  });

  test('records with invalid SHAs are filtered out on load', () => {
    const caws = mkCawsDir();
    fs.writeFileSync(
      path.join(caws, 'prepush-acks.json'),
      JSON.stringify({ version: 1, acks: [{ sha: 'not-a-sha', acked_at: 'x' }, { sha: SHA_A, acked_at: 'x' }] }),
      'utf8'
    );
    const store = loadAckStore(caws);
    expect(store.acks.map((a) => a.sha)).toEqual([SHA_A]);
  });
});
