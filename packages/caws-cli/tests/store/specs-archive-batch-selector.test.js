'use strict';

const fs = require('fs');
const path = require('path');

const { initProject } = require('../../dist/store/init-store');
const {
  archiveClosedSpecs,
  selectClosedSpecsForArchive,
} = require('../../dist/store/specs-writer');
const { cleanupAll, git, makeTempRepo } = require('../helpers/git-repo-factory');

const ACTOR = { kind: 'agent', id: 'jest', platform: 'jest' };

afterAll(() => {
  cleanupAll();
});

function mkRepo() {
  const root = makeTempRepo();
  const initialized = initProject(root);
  if (!initialized.ok) {
    throw new Error('initProject failed: ' + JSON.stringify(initialized.errors));
  }
  return { root, caws: path.join(root, '.caws') };
}

function writeSpec(cawsDir, id, state, opts = {}) {
  const resolution = state === 'closed' || state === 'archived'
    ? 'resolution: completed\n'
    : '';
  const createdAt = opts.createdAt ?? '2026-07-04T00:00:00.000Z';
  const updatedAt = opts.updatedAt ?? '2026-07-04T00:00:00.000Z';
  const worktreeLine = opts.worktree !== undefined ? `worktree: ${opts.worktree}\n` : '';
  const body = `id: ${id}
title: '${id}'
risk_tier: 3
mode: chore
lifecycle_state: ${state}
${resolution}${worktreeLine}created_at: '${createdAt}'
updated_at: '${updatedAt}'
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
  - 'fixture'
acceptance:
  - id: A1
    given: 'fixture'
    when: 'fixture'
    then: 'fixture'
non_functional: {}
contracts: []
`;
  fs.writeFileSync(path.join(cawsDir, 'specs', `${id}.yaml`), body);
}

function commitAll(root, message) {
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', message]);
}

describe('selectClosedSpecsForArchive', () => {
  test('selects only closed specs and applies include/exclude by exact id', () => {
    const { caws } = mkRepo();
    writeSpec(caws, 'ARCHIVE-BATCH-A-001', 'closed');
    writeSpec(caws, 'ARCHIVE-BATCH-B-001', 'closed');
    writeSpec(caws, 'ARCHIVE-BATCH-C-001', 'active');

    const selected = selectClosedSpecsForArchive(caws, {
      include: ['ARCHIVE-BATCH-A-001', 'ARCHIVE-BATCH-B-001', 'ARCHIVE-BATCH-C-001', 'ARCHIVE-BATCH-MISSING-999'],
      exclude: ['ARCHIVE-BATCH-B-001'],
    });

    expect(selected.ok).toBe(true);
    expect(selected.value.candidates.map((entry) => entry.id)).toEqual([
      'ARCHIVE-BATCH-A-001',
    ]);
    expect(selected.value.skipped).toEqual([
      {
        id: 'ARCHIVE-BATCH-C-001',
        reason: 'not_closed',
        lifecycle_state: 'active',
      },
      {
        id: 'ARCHIVE-BATCH-MISSING-999',
        reason: 'missing',
        lifecycle_state: 'missing',
      },
    ]);
  });

  test('composes age, cutoff, and without-worktree selectors with include/exclude', () => {
    const { caws } = mkRepo();
    writeSpec(caws, 'ARCHIVE-BATCH-OLD-001', 'closed', {
      updatedAt: '2026-06-01T00:00:00.000Z',
    });
    writeSpec(caws, 'ARCHIVE-BATCH-FRESH-001', 'closed', {
      updatedAt: '2026-07-04T00:30:00.000Z',
    });
    writeSpec(caws, 'ARCHIVE-BATCH-BOUND-001', 'closed', {
      updatedAt: '2026-06-01T00:00:00.000Z',
      worktree: 'wt-bound',
    });
    writeSpec(caws, 'ARCHIVE-BATCH-ACTIVE-001', 'active', {
      updatedAt: '2026-06-01T00:00:00.000Z',
    });

    const selected = selectClosedSpecsForArchive(caws, {
      include: [
        'ARCHIVE-BATCH-OLD-001',
        'ARCHIVE-BATCH-FRESH-001',
        'ARCHIVE-BATCH-BOUND-001',
        'ARCHIVE-BATCH-ACTIVE-001',
      ],
      olderThanMs: 60 * 60 * 1000,
      updatedBefore: '2026-07-01T00:00:00.000Z',
      withoutWorktree: true,
      now: () => new Date('2026-07-04T01:02:03.000Z'),
    });

    expect(selected.ok).toBe(true);
    expect(selected.value.candidates.map((entry) => entry.id)).toEqual([
      'ARCHIVE-BATCH-OLD-001',
    ]);
    expect(selected.value.candidates[0].timestamp).toBe('2026-06-01T00:00:00.000Z');
    expect(selected.value.candidates[0].age_ms).toBeGreaterThan(0);
    expect(selected.value.skipped.map((entry) => [entry.id, entry.reason])).toEqual([
      ['ARCHIVE-BATCH-ACTIVE-001', 'not_closed'],
      ['ARCHIVE-BATCH-BOUND-001', 'has_worktree'],
      ['ARCHIVE-BATCH-FRESH-001', 'too_fresh'],
    ]);
    expect(selected.value.skipped.find((entry) => entry.id === 'ARCHIVE-BATCH-BOUND-001').worktree).toBe('wt-bound');
  });

  test('rejects invalid updated-before values', () => {
    const { caws } = mkRepo();
    writeSpec(caws, 'ARCHIVE-BATCH-A-001', 'closed');

    const selected = selectClosedSpecsForArchive(caws, {
      updatedBefore: 'not-a-date',
    });

    expect(selected.ok).toBe(false);
    expect(selected.errors[0].message).toContain('--updated-before');
  });
});

describe('archiveClosedSpecs', () => {
  test('archives selected closed specs in one aggregate audit commit', () => {
    const { root, caws } = mkRepo();
    writeSpec(caws, 'ARCHIVE-BATCH-A-001', 'closed');
    writeSpec(caws, 'ARCHIVE-BATCH-B-001', 'closed');
    commitAll(root, 'add archive batch fixtures');
    const beforeHead = git(root, ['rev-parse', 'HEAD']);

    const archived = archiveClosedSpecs(caws, {
      actor: ACTOR,
      now: () => new Date('2026-07-04T01:02:03.000Z'),
      include: ['ARCHIVE-BATCH-A-001', 'ARCHIVE-BATCH-B-001'],
    });

    expect(archived.ok).toBe(true);
    expect(archived.value.archived.map((entry) => entry.id)).toEqual([
      'ARCHIVE-BATCH-A-001',
      'ARCHIVE-BATCH-B-001',
    ]);
    expect(archived.value.skipped).toEqual([]);
    expect(archived.value.failed).toEqual([]);
    expect(archived.value.data.audit_commit.kind).toBe('committed');
    expect(git(root, ['rev-list', '--count', `${beforeHead}..HEAD`])).toBe('1');
    expect(git(root, ['log', '-1', '--pretty=%s'])).toBe(
      'chore(caws): archive 2 closed specs'
    );
    expect(fs.existsSync(path.join(caws, 'specs', 'ARCHIVE-BATCH-A-001.yaml'))).toBe(false);
    expect(fs.existsSync(path.join(caws, 'specs', 'ARCHIVE-BATCH-B-001.yaml'))).toBe(false);
    expect(fs.existsSync(path.join(caws, 'specs', '.archive', 'ARCHIVE-BATCH-A-001.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(caws, 'specs', '.archive', 'ARCHIVE-BATCH-B-001.yaml'))).toBe(true);
  });
});
