'use strict';

/**
 * Store unit tests for the working-tree overlap predicate
 * (WORKING-TREE-PROVENANCE-GUARD-001, Commit 1).
 *
 * The predicate is pure: given a sessions snapshot (claimed_paths /
 * last_modified_paths) + a dirty-path list, classify overlap with OTHER
 * sessions. Self-overlap is excluded; a session with neither field is
 * "metadata unavailable" (no overlap possible); a claimed_paths glob/dir
 * entry matches on a path boundary like scope.in admission.
 *
 * Covers: glob+prefix claims (A1), no-overlap (A2), self-overlap exclusion
 * (Q4), both-source overlap, metadata-unavailable (A6), dedupe.
 */

const { classifyWorkingTreeOverlap } = require('../../dist/store/working-tree-overlap');

function overlap(sessions, dirtyPaths, selfSessionId) {
  return classifyWorkingTreeOverlap({ selfSessionId, sessions, dirtyPaths });
}

describe('classifyWorkingTreeOverlap', () => {
  test('flags a claimed_paths dir/glob overlap on another session (A1)', () => {
    const result = overlap(
      [{ session_id: 'caws-aaa', claimed_paths: ['packages/foo'] }],
      ['packages/foo/bar.ts', 'packages/zz/other.ts'],
      'caws-bbb'
    );
    expect(result.overlaps).toHaveLength(1);
    expect(result.overlaps[0].sessionId).toBe('caws-aaa');
    expect(result.overlaps[0].source).toBe('claimed_paths');
    expect(result.overlaps[0].overlappingPaths).toEqual(['packages/foo/bar.ts']);
    expect(result.noOverlapPaths).toEqual(['packages/zz/other.ts']);
  });

  test('permits a dirty tree with no overlap on any other session (A2)', () => {
    const result = overlap(
      [{ session_id: 'caws-aaa', claimed_paths: ['packages/foo'] }],
      ['packages/bar/baz.ts'],
      'caws-bbb'
    );
    expect(result.overlaps).toHaveLength(0);
    expect(result.noOverlapPaths).toEqual(['packages/bar/baz.ts']);
  });

  test('excludes self-overlap (Q4)', () => {
    const result = overlap(
      [{ session_id: 'caws-bbb', claimed_paths: ['packages/foo'] }],
      ['packages/foo/bar.ts'],
      'caws-bbb'
    );
    expect(result.overlaps).toHaveLength(0);
  });

  test('reports both-source overlap when claimed and modified both match', () => {
    const result = overlap(
      [
        {
          session_id: 'caws-aaa',
          claimed_paths: ['packages/foo'],
          last_modified_paths: ['packages/foo/bar.ts', 'packages/other.ts'],
        },
      ],
      ['packages/foo/bar.ts', 'packages/other.ts'],
      'caws-bbb'
    );
    expect(result.overlaps[0].source).toBe('both');
    expect(result.overlaps[0].overlappingPaths.sort()).toEqual([
      'packages/foo/bar.ts',
      'packages/other.ts',
    ]);
  });

  test('lists metadata-unavailable sessions (neither field) (A6)', () => {
    const result = overlap(
      [
        { session_id: 'caws-aaa', claimed_paths: ['packages/foo'] },
        { session_id: 'caws-ccc' }, // no ownership fields
      ],
      ['packages/foo/bar.ts'],
      'caws-bbb'
    );
    expect(result.overlaps).toHaveLength(1);
    expect(result.metadataUnavailable).toEqual(['caws-ccc']);
  });

  test('treats last_modified_paths as an overlap source', () => {
    const result = overlap(
      [{ session_id: 'caws-aaa', last_modified_paths: ['packages/foo/bar.ts'] }],
      ['packages/foo/bar.ts'],
      'caws-bbb'
    );
    expect(result.overlaps[0].source).toBe('last_modified_paths');
  });

  test('dedupes a path reported twice by git porcelain', () => {
    const result = overlap(
      [{ session_id: 'caws-aaa', claimed_paths: ['packages/foo'] }],
      ['packages/foo/bar.ts', 'packages/foo/bar.ts'],
      'caws-bbb'
    );
    expect(result.overlaps[0].overlappingPaths).toEqual(['packages/foo/bar.ts']);
  });
});
