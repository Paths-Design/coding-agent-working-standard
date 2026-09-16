'use strict';

/**
 * CAWS-DEFECT-DOCTOR-NO-DISCHARGE-WARNINGS-01 — store-side tombstone
 * observations (spec A8).
 *
 * Proves the snapshot composer produces the exact inputs the kernel's §2e
 * verifiable-tombstone downgrade consumes, over a REAL repo + REAL chained
 * events (appendEvent, not mocks):
 *   - localBranchRefs reflects the repo's actual refs (and omits a deleted
 *     lane branch),
 *   - createdWorktreePathExistsByName reports the recorded path's absence,
 *   - the composed DoctorInput, run through inspectProjectState, downgrades
 *     the verifiably-dead orphan to info while the branch-still-present
 *     orphan stays a warning.
 *
 * SUT loaded from dist/ (store tests build first). Fixture repo via the
 * isolated git-repo factory; cleaned up through its registry.
 */

const fs = require('fs');
const path = require('path');
const { makeTempRepo, cleanupAll, git } = require('../helpers/git-repo-factory');
const { appendEvent, composeStoreSnapshot, composeDoctorSnapshot } = require('../../dist/store');
const { inspectProjectState } = require('../../dist/kernel');
const { DOCTOR_RULES } = require('../../dist/kernel');

const actor = { kind: 'agent', id: 'a-1', session_id: 's-1', platform: 'test' };

function createdBody(name, repoRoot) {
  return {
    event: 'worktree_created',
    ts: '2026-09-12T00:00:00.000Z',
    actor,
    data: {
      name,
      branch: name,
      base_branch: 'main',
      path: path.join(repoRoot, '.caws', 'worktrees', name),
    },
  };
}

describe('doctor snapshot tombstone observations (CAWS-DEFECT-DOCTOR-NO-DISCHARGE-WARNINGS-01)', () => {
  afterAll(() => {
    cleanupAll();
  });

  test('A8: a real orphan composes into the exact inputs the §2e tombstone downgrade requires', () => {
    const repoRoot = makeTempRepo();
    const cawsDir = path.join(repoRoot, '.caws');
    fs.mkdirSync(cawsDir, { recursive: true });

    // wt-ghost: branch never created, directory never created — verifiably dead.
    // wt-alive: branch EXISTS (unmerged residue), directory absent — not dead.
    expect(appendEvent(cawsDir, createdBody('wt-ghost', repoRoot)).ok).toBe(true);
    expect(appendEvent(cawsDir, createdBody('wt-alive', repoRoot)).ok).toBe(true);
    git(repoRoot, ['branch', 'wt-alive']);

    const snapshot = composeStoreSnapshot({ repoRoot, cawsDir });

    // Branch observation: an array of full refs, containing the live lane
    // branch and the base branch, omitting the never-created one.
    expect(Array.isArray(snapshot.localBranchRefs)).toBe(true);
    expect(snapshot.localBranchRefs).toContain('refs/heads/main');
    expect(snapshot.localBranchRefs).toContain('refs/heads/wt-alive');
    expect(snapshot.localBranchRefs).not.toContain('refs/heads/wt-ghost');

    // Created-event path observation: keyed by event name, absent on disk.
    expect(snapshot.filesystem.createdWorktreePathExistsByName).toEqual({
      'wt-ghost': false,
      'wt-alive': false,
    });

    // The projected DoctorInput carries both observations, and the pure
    // kernel renders the dead orphan as info while the branch-bearing orphan
    // stays a warning — the full vertical on a real repo.
    const { doctorInput } = composeDoctorSnapshot({
      repoRoot,
      cawsDir,
      now: new Date('2026-09-12T12:00:00.000Z'),
    });
    expect(doctorInput.localBranchRefs).toEqual(snapshot.localBranchRefs);
    const report = inspectProjectState(doctorInput);
    const bySubject = new Map(
      report.findings
        .filter((f) => f.rule === DOCTOR_RULES.WORKTREE_EVENT_WITHOUT_CONTROL_PLANE_BINDING)
        .map((f) => [f.subject, f])
    );
    expect(bySubject.get('wt-ghost')?.severity).toBe('info');
    expect(bySubject.get('wt-ghost')?.data?.verified_dead).toBe(true);
    expect(bySubject.get('wt-alive')?.severity).toBe('warning');
  });

  test('an events log with no usable worktree_created events omits the path map entirely (unobserved, not empty)', () => {
    const repoRoot = makeTempRepo();
    const cawsDir = path.join(repoRoot, '.caws');
    fs.mkdirSync(cawsDir, { recursive: true });
    expect(
      appendEvent(cawsDir, {
        event: 'test_recorded',
        ts: '2026-09-12T00:00:00.000Z',
        actor,
        spec_id: 'S-1',
        data: { command: 'jest', exit_code: 0 },
      }).ok
    ).toBe(true);

    const snapshot = composeStoreSnapshot({ repoRoot, cawsDir });
    expect(snapshot.filesystem.createdWorktreePathExistsByName).toBeUndefined();
    // Branch observation is independent of the events log.
    expect(snapshot.localBranchRefs).toContain('refs/heads/main');
  });
});
