// push-range classifier unit tests — MULTI-AGENT-PUSH-RANGE-GUARD-001
//
// The classifier is a PURE function. These tests exercise it with plain
// JS fixtures (no git, no temp repos, no live .caws/) — the command-level
// fixture-repo tests live in prepush-command.test.js (A9). Here we prove
// the classification + decision logic directly.

const { classifyRange } = require('../../dist/shell/push-range/classify-range');

const SPECS = [
  {
    specId: 'ACTIVE-FOO-001',
    scopeIn: ['packages/foo'],
    lifecycleState: 'active',
  },
  {
    specId: 'PARALLEL-BAR-001',
    scopeIn: ['packages/bar'],
    lifecycleState: 'active',
  },
];

const ORIGIN_MAIN = { remote: 'origin', branch: 'main' };

describe('classifyRange — A2: clean current-slice range proceeds', () => {
  it('attributes every commit to the current spec, does not refuse, exit-clean', () => {
    const report = classifyRange({
      baseRef: 'origin/main',
      target: ORIGIN_MAIN,
      currentSpecId: 'ACTIVE-FOO-001',
      specs: SPECS,
      commits: [
        {
          sha: 'aaa1111',
          subject: 'feat(foo): thing',
          touchedFiles: ['packages/foo/a.ts'],
        },
        {
          sha: 'aaa2222',
          subject: 'test(foo): cover thing',
          touchedFiles: ['packages/foo/a.test.js'],
        },
      ],
    });

    expect(report.refused).toBe(false);
    expect(report.unexpectedUnacked).toEqual([]);
    expect(report.commits).toHaveLength(2);
    for (const c of report.commits) {
      expect(c.currentSliceMatch).toBe(true);
      expect(c.inferredSpecIds).toEqual(['ACTIVE-FOO-001']);
      expect(c.provenanceSource).toBe('file_touch');
      expect(c.ambiguous).toBe(false);
    }
  });
});

describe('classifyRange — A1: mixed range with a foreign-spec commit refuses', () => {
  it('enumerates both commits; refuses on the unattributed one', () => {
    const report = classifyRange({
      baseRef: 'origin/main',
      target: ORIGIN_MAIN,
      currentSpecId: 'ACTIVE-FOO-001',
      specs: SPECS,
      commits: [
        {
          sha: 'fff1111',
          subject: 'feat(foo): mine',
          touchedFiles: ['packages/foo/a.ts'],
        },
        {
          sha: 'bbb2222',
          subject: 'chore(caws): draft PARALLEL-BAR-001',
          touchedFiles: ['packages/bar/b.ts'],
        },
      ],
    });

    expect(report.refused).toBe(true);
    expect(report.unexpectedUnacked).toEqual(['bbb2222']);

    const mine = report.commits.find((c) => c.sha === 'fff1111');
    expect(mine.currentSliceMatch).toBe(true);

    const foreign = report.commits.find((c) => c.sha === 'bbb2222');
    expect(foreign.currentSliceMatch).toBe(false);
    expect(foreign.inferredSpecIds).toEqual(['PARALLEL-BAR-001']);
    // file_touch (packages/bar) + commit_subject (names PARALLEL-BAR-001).
    expect(foreign.provenanceSource).toBe('file_touch+commit_subject');
    expect(foreign.ambiguous).toBe(false);
  });
});

describe('classifyRange — A4: per-SHA acknowledgement clears the refusal', () => {
  it('an acked unexpected commit no longer forces refusal; non-acked still does', () => {
    const base = {
      baseRef: 'origin/main',
      target: ORIGIN_MAIN,
      currentSpecId: 'ACTIVE-FOO-001',
      specs: SPECS,
      commits: [
        {
          sha: 'bbb2222',
          subject: 'chore(caws): draft PARALLEL-BAR-001',
          touchedFiles: ['packages/bar/b.ts'],
        },
      ],
    };

    const refused = classifyRange(base);
    expect(refused.refused).toBe(true);

    const acked = classifyRange({ ...base, ackedShas: ['bbb2222'] });
    expect(acked.refused).toBe(false);
    expect(acked.unexpectedUnacked).toEqual([]);
    expect(acked.commits[0].acknowledged).toBe(true);
    // Still NOT current-slice-match — ack does not relabel provenance.
    expect(acked.commits[0].currentSliceMatch).toBe(false);
  });
});

describe('classifyRange — foreign worktree escalation (ADR Q4 OR)', () => {
  it('ERROR on origin main when a commit originates from a foreign worktree', () => {
    const report = classifyRange({
      baseRef: 'origin/main',
      target: ORIGIN_MAIN,
      currentSpecId: 'ACTIVE-FOO-001',
      specs: SPECS,
      commits: [
        {
          sha: 'ccc3333',
          subject: 'feat: from sibling',
          touchedFiles: ['packages/foo/a.ts'],
          originWorktree: 'sibling-wt',
        },
      ],
      foreignWorktrees: [
        {
          name: 'sibling-wt',
          path: '/tmp/sibling-wt',
          branch: 'sibling',
          unregistered: false,
          unmerged: false,
        },
      ],
    });

    const finding = report.foreignWorktrees.find((f) => f.name === 'sibling-wt');
    expect(finding.severity).toBe('ERROR');
    expect(finding.reasons).toContain(
      'commits in the outgoing range originate from it'
    );
    expect(report.refused).toBe(true);
    expect(report.maxSeverity).toBe('ERROR');
  });

  it('feature-branch target weakens ERROR to WARN (does not refuse on the wt alone)', () => {
    const report = classifyRange({
      baseRef: 'origin/feat-x',
      target: { remote: 'origin', branch: 'feat-x' },
      currentSpecId: 'ACTIVE-FOO-001',
      specs: SPECS,
      commits: [
        {
          sha: 'ddd4444',
          subject: 'feat(foo): mine',
          touchedFiles: ['packages/foo/a.ts'],
        },
      ],
      foreignWorktrees: [
        {
          name: 'sibling-wt',
          path: '/tmp/sibling-wt',
          branch: 'sibling',
          unregistered: true,
          unmerged: true,
        },
      ],
    });

    const finding = report.foreignWorktrees.find((f) => f.name === 'sibling-wt');
    expect(finding.severity).toBe('WARN'); // weakened, not ERROR
    // No unexpected commit + no ERROR wt → not refused on a feature branch.
    expect(report.refused).toBe(false);
  });
});

describe('classifyRange — A5: structured-output shape + provenance ambiguity', () => {
  it('produces the documented per-commit record schema; flags ambiguous', () => {
    const report = classifyRange({
      baseRef: 'origin/main',
      target: ORIGIN_MAIN,
      currentSpecId: 'ACTIVE-FOO-001',
      specs: SPECS,
      commits: [
        {
          sha: 'eee5555',
          subject: 'chore: touches nothing in any scope',
          touchedFiles: ['unrelated/readme.md'],
        },
      ],
    });

    const c = report.commits[0];
    // Documented record fields:
    expect(c).toHaveProperty('sha');
    expect(c).toHaveProperty('subject');
    expect(c).toHaveProperty('touchedFiles');
    expect(c).toHaveProperty('inferredSpecIds');
    expect(c).toHaveProperty('currentSliceMatch');
    expect(c).toHaveProperty('provenanceSource');
    expect(c).toHaveProperty('ambiguous');
    expect(c).toHaveProperty('acknowledged');
    // No spec matched by file-touch and no known spec in subject → ambiguous.
    expect(c.inferredSpecIds).toEqual([]);
    expect(c.provenanceSource).toBe('none');
    expect(c.ambiguous).toBe(true);
    expect(c.currentSliceMatch).toBe(false);
    // ambiguous commit is unexpected → refuses.
    expect(report.refused).toBe(true);
  });

  it('determinism: identical input yields identical report', () => {
    const input = {
      baseRef: 'origin/main',
      target: ORIGIN_MAIN,
      currentSpecId: 'ACTIVE-FOO-001',
      specs: SPECS,
      commits: [
        { sha: 'a', subject: 'feat(foo): x', touchedFiles: ['packages/foo/x.ts'] },
      ],
    };
    expect(classifyRange(input)).toEqual(classifyRange(input));
  });
});

describe('classifyRange — multi-match provenance is reported, not collapsed', () => {
  it('a commit touching two specs scope.in lists both inferred ids', () => {
    const report = classifyRange({
      baseRef: 'origin/main',
      target: ORIGIN_MAIN,
      currentSpecId: 'ACTIVE-FOO-001',
      specs: SPECS,
      commits: [
        {
          sha: 'multi1',
          subject: 'refactor: cross-cutting',
          touchedFiles: ['packages/foo/a.ts', 'packages/bar/b.ts'],
        },
      ],
    });
    const c = report.commits[0];
    expect(c.inferredSpecIds).toEqual(['ACTIVE-FOO-001', 'PARALLEL-BAR-001']);
    // current spec is in the match set → current-slice-match true, but the
    // multi-match is still fully reported for operator visibility.
    expect(c.currentSliceMatch).toBe(true);
  });
});
