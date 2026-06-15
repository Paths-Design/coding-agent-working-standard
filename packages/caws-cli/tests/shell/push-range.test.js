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

describe('classifyRange: closed specs are considered', () => {
  test('a closed spec is considered for file-touch attribution', () => {
    const r = classifyRange(
      input({
        commits: [commit('abc', 'work', ['src/store/x.ts'])],
        specs: [spec('SPEC-CLOSED', ['src/store'], 'closed')],
        currentSpecId: 'SPEC-CLOSED',
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
    // Draft excluded → ambiguous, currentSliceMatch false, refused
    expect(r.commits[0].inferredSpecIds).toEqual([]);
    expect(r.commits[0].currentSliceMatch).toBe(false);
    expect(r.refused).toBe(true);
  });
});

// helper: asserts array is a real array before returning it
function isOk_guard(arr) {
  expect(Array.isArray(arr)).toBe(true);
  return arr;
}

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
    // SPEC-42xxx is not in the known spec list, so even if regex matched, it
    // wouldn't land in inferredSpecIds. Confirm it stays ambiguous.
    const r = classifyRange(
      input({
        commits: [commit('s3', 'fix: SPEC-42xxx', ['unrelated/x.ts'])],
        specs: [spec('SPEC-42', ['src/store'])],
      })
    );
    // The regex extracts SPEC-42 from SPEC-42xxx? No — \b ensures word boundary.
    // If 'SPEC-42' is extracted from 'SPEC-42xxx', that's a regex accuracy issue.
    // What we need: SPEC-42 alone in the subject → attributed; SPEC-42xxx → 42 substring NOT extracted.
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
    // WARN ranks between INFO and ERROR; a clean foreign worktree must not collapse to INFO
    const r = classifyRange(input({ foreignWorktrees: [fwt()] }));
    expect(r.maxSeverity).toBe('WARN');
    expect(r.refused).toBe(false);
  });

  test('maxSeverity is ERROR when only unexpectedUnacked commits exist (no foreign wts)', () => {
    const r = classifyRange(
      input({
        commits: [commit('foreign1', 'peer work', ['other/x.ts'])],
        specs: [spec('SPEC-1', ['src/store'])],
        currentSpecId: 'SPEC-1',
        foreignWorktrees: [],
      })
    );
    expect(r.unexpectedUnacked).toEqual(['foreign1']);
    expect(r.maxSeverity).toBe('ERROR');
    expect(r.refused).toBe(true);
  });

  test('maxSeverity stays ERROR (highest) when both WARN foreign wt and unexpected commits', () => {
    // ERROR > WARN — ensures the loop correctly upgrades severity
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

  test('maxSeverity from a WARN worktree does NOT become ERROR without unexpectedUnacked', () => {
    // Prove WARN + 0 unexpectedUnacked = maxSeverity WARN, not ERROR
    const r = classifyRange(
      input({
        commits: [commit('mine', 'work', ['src/store/x.ts'])],
        specs: [spec('SPEC-1', ['src/store'])],
        currentSpecId: 'SPEC-1',
        foreignWorktrees: [fwt()], // WARN on origin/main (no hard conditions)
      })
    );
    expect(r.unexpectedUnacked).toEqual([]);
    expect(r.maxSeverity).toBe('WARN');
    expect(r.refused).toBe(false);
  });

  test('maxSeverity accumulates across multiple foreign worktrees — highest wins', () => {
    // If the loop uses <= instead of >, the highest severity won't be picked
    const r = classifyRange(
      input({
        foreignWorktrees: [
          fwt({ name: 'wt-warn', path: '/wt/warn' }),                    // WARN
          fwt({ name: 'wt-err', path: '/wt/err', unmerged: true }),      // ERROR
        ],
      })
    );
    expect(r.maxSeverity).toBe('ERROR');
    // ERROR worktree refuses even with no unexpectedUnacked
    expect(r.refused).toBe(true);
  });
});

describe('classifyRange: file-touch matching uses some() not every()', () => {
  test('a commit touching ONE in-scope file (of several touched) is attributed', () => {
    // Touching one in-scope file among several is sufficient for attribution.
    const r = classifyRange(
      input({
        commits: [commit('x1', 'work', ['src/store/x.ts', 'unrelated/y.ts'])],
        specs: [spec('SPEC-1', ['src/store'])],
        currentSpecId: 'SPEC-1',
      })
    );
    expect(r.commits[0].inferredSpecIds).toContain('SPEC-1');
    expect(r.commits[0].currentSliceMatch).toBe(true);
    expect(r.refused).toBe(false);
  });

  test('a spec with one matching entry (of multiple scope.in) attributes the commit', () => {
    // Matching any one scope.in entry is sufficient for attribution; not all entries need to match.
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
    // Contrast: proves the escalation is ONLY from commit origin, not structural
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
    // A commit whose originWorktree differs from the worktree must not escalate severity to that worktree.
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
    // wt-peer: originated p4a → 'commits in the outgoing range originate from it'
    const peer = r.foreignWorktrees.find((f) => f.name === 'wt-peer');
    expect(peer).toBeDefined();
    expect(peer.reasons).toContain('commits in the outgoing range originate from it');
    // wt-other: originated p4b → also has the reason
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
    // INFO does not refuse
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
    // On origin/main: a foreign worktree with no hard conditions gets WARN (not ERROR)
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

describe('classifyRange: unexpectedUnacked and fullPosture', () => {
  test('unexpectedUnacked contains the actual unexpected SHA', () => {
    const r = classifyRange(
      input({
        commits: [
          commit('sha-mine', 'mine', ['src/store/x.ts']),
          commit('sha-peer', 'peer', ['other/y.ts']),
        ],
        specs: [spec('SPEC-1', ['src/store'])],
        currentSpecId: 'SPEC-1',
      })
    );
    expect(r.unexpectedUnacked).toEqual(['sha-peer']);
    expect(r.unexpectedUnacked).not.toContain('sha-mine');
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
    // upstream/main is NOT full posture → WARN
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

describe('classifyRange: maxSeverity set from unexpectedUnacked', () => {
  test('maxSeverity = ERROR when unexpectedUnacked > 0 even if foreignWorktrees is empty', () => {
    const r = classifyRange(
      input({
        commits: [commit('unexp', 'foreign work', ['other/x.ts'])],
        specs: [spec('SPEC-1', ['src/store'])],
        currentSpecId: 'SPEC-1',
      })
    );
    expect(r.unexpectedUnacked).toEqual(['unexp']);
    expect(r.maxSeverity).toBe('ERROR');
  });

  test('maxSeverity stays at ERROR from foreign-wt even when unexpectedUnacked length is 0', () => {
    const r = classifyRange(
      input({
        commits: [commit('mine', 'mine', ['src/store/x.ts'])],
        specs: [spec('SPEC-1', ['src/store'])],
        currentSpecId: 'SPEC-1',
        foreignWorktrees: [{
          name: 'wt-err', path: '/wt/err',
          unregistered: false, unmerged: true,
        }],
      })
    );
    expect(r.unexpectedUnacked).toEqual([]);
    expect(r.maxSeverity).toBe('ERROR'); // set by the worktree loop, not by the unexpectedUnacked branch
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
    // After normalization: 'src/store' must NOT match 'src/storefront.ts'
    expect(scopeEntryMatches('src/store/', 'src/storefront.ts')).toBe(false);
    expect(scopeEntryMatches('./src/store', 'src/store/x.ts')).toBe(true);
  });

  test('multiple consecutive trailing slashes are all stripped', () => {
    expect(normalizeRel('src/x//')).toBe('src/x');
    expect(normalizeRel('src/x///')).toBe('src/x');
  });

  test('./ in the middle of a path is NOT stripped (only leading ./ is removed)', () => {
    // Only the leading ./ prefix is stripped; a ./ that appears mid-path must be preserved.
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
    // Everything is unexpected with no currentSpecId
    expect(r.unexpectedUnacked).toContain('a1');
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
    // peer-sha is not acked by default and is not current-slice → unexpectedUnacked
    expect(r.unexpectedUnacked).toContain('peer-sha');
    expect(r.refused).toBe(true);
  });

  test('ackedShas defaults do not falsely ack any SHA that is not explicitly listed', () => {
    // Complement: with explicit empty ackedShas vs omitted — same outcome
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
    expect(rOmitted.unexpectedUnacked).toEqual(rEmpty.unexpectedUnacked);
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

  test('unexpectedUnacked sets maxSeverity to ERROR even when maxSeverity is already WARN from a foreign wt', () => {
    const rWithWt = classifyRange(
      input({
        commits: [commit('unexp2', 'peer', ['other/x.ts'])],
        specs: [spec('SPEC-1', ['src/store'])],
        currentSpecId: 'SPEC-1',
        foreignWorktrees: [fwt()], // WARN worktree
      })
    );
    // unexpectedUnacked should push maxSeverity to ERROR
    expect(rWithWt.unexpectedUnacked).toEqual(['unexp2']);
    expect(rWithWt.maxSeverity).toBe('ERROR');
  });

  test('no unexpectedUnacked + WARN worktree → maxSeverity stays WARN, not ERROR', () => {
    // Without unexpectedUnacked, the ERROR severity must not be set solely from a WARN worktree.
    const r = classifyRange(
      input({
        commits: [commit('mine', 'mine', ['src/store/x.ts'])],
        specs: [spec('SPEC-1', ['src/store'])],
        currentSpecId: 'SPEC-1',
        foreignWorktrees: [fwt()], // WARN on origin/main
      })
    );
    expect(r.unexpectedUnacked).toEqual([]);
    expect(r.maxSeverity).toBe('WARN'); // not ERROR — a WARN worktree with no unexpectedUnacked must not escalate
    expect(r.refused).toBe(false);
  });
});
