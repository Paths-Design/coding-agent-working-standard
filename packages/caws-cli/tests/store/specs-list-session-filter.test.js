'use strict';

// CAWS-SPECS-LIST-SESSION-ID-001 — store-layer session filter for listSpecs.
//
// Covers: relation attribution (created_by_session / bridge claim / worktree
// ownership), prefix-normalized session identity (bare uuid ↔ session-<uuid>),
// archived-spec attribution via the spec_created event actor, --status
// composition, bound_worktree reporting, backward compatibility of the
// unfiltered listing, and fail-closed behavior on a malformed bridge.json.

const fs = require('fs');
const path = require('path');

const { initProject } = require('../../dist/store/init-store');
const { listSpecs } = require('../../dist/store/specs-writer');
const { cleanupAll, makeTempRepo } = require('../helpers/git-repo-factory');

// 1111…/2222…/3333… are valid v4-shaped uuids for fixture purposes.
const S1 = '11111111-1111-4111-8111-111111111111'; // bare form of session one
const S1P = `session-${S1}`; // prefixed form of the SAME session lane
const S2 = '22222222-2222-4222-8222-222222222222';
const S3 = '33333333-3333-4333-8333-333333333333';

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
  const resolution = state === 'closed' ? 'resolution: completed\n' : '';
  const createdBy = opts.createdBy !== undefined ? `created_by_session: '${opts.createdBy}'\n` : '';
  const body = `id: ${id}
title: '${id}'
mode: chore
lifecycle_state: ${state}
${resolution}${createdBy}created_at: '2026-07-04T00:00:00.000Z'
updated_at: '2026-07-04T00:00:00.000Z'
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

function appendEvent(cawsDir, event) {
  fs.appendFileSync(path.join(cawsDir, 'events.jsonl'), JSON.stringify(event) + '\n');
}

function specById(result, id) {
  return result.value.active.find((e) => e.id === id) ?? null;
}

// ─── relation attribution ────────────────────────────────────────────────

describe('listSpecs session filter', () => {
  let caws;
  beforeEach(() => {
    const repo = mkRepo();
    caws = repo.caws;

    writeSpec(caws, 'SPEC-CREATED-1', 'active', { createdBy: S1P });
    writeSpec(caws, 'SPEC-BRIDGED-2', 'active', { createdBy: S2 });
    writeSpec(caws, 'SPEC-WT-3', 'active', { createdBy: S2 });
    writeSpec(caws, 'SPEC-DRAFT-4', 'draft', { createdBy: S1 });
    writeSpec(caws, 'SPEC-CLOSED-5', 'closed', { createdBy: S1 });
    writeSpec(caws, 'SPEC-UNRELATED-6', 'active', { createdBy: S2 });
    writeSpec(caws, 'SPEC-FOREIGN-BOUND-7', 'active', { createdBy: S1 });

    // Session one holds a bridge claim on SPEC-BRIDGED-2 (bare-id stamping).
    fs.mkdirSync(path.join(caws, 'claims'), { recursive: true });
    fs.writeFileSync(
      path.join(caws, 'claims', 'bridge.json'),
      JSON.stringify({
        'SPEC-BRIDGED-2': { session_id: S1, acquired_at: '2026-10-01T00:00:00.000Z' },
      })
    );

    // Session one (prefixed stamping) owns the worktree bound to SPEC-WT-3;
    // session two owns the worktree bound to SPEC-FOREIGN-BOUND-7.
    fs.writeFileSync(
      path.join(caws, 'worktrees.json'),
      JSON.stringify({
        'wt-owner': {
          specId: 'SPEC-WT-3',
          path: '.caws/worktrees/wt-owner',
          owner: { session_id: S1P, platform: 'dsh' },
        },
        'wt-foreign': {
          specId: 'SPEC-FOREIGN-BOUND-7',
          path: '.caws/worktrees/wt-foreign',
          owner: { session_id: S2, platform: 'dsh' },
        },
      })
    );

    // Archived: one created by session one, one by session two. Tombstoned
    // bodies are gone; the spec_created event actor is the attribution.
    appendEvent(caws, {
      seq: 1,
      event: 'spec_created',
      ts: '2026-10-01T00:00:00.000Z',
      actor: { kind: 'agent', id: S1, session_id: S1, platform: 'dsh' },
      spec_id: 'SPEC-ARCHIVED-MINE-8',
      data: { title: 'mine', mode: 'chore', lifecycle_state: 'draft' },
    });
    appendEvent(caws, {
      seq: 2,
      event: 'spec_created',
      ts: '2026-10-01T00:00:00.000Z',
      actor: { kind: 'agent', id: S2, session_id: S2, platform: 'dsh' },
      spec_id: 'SPEC-ARCHIVED-THEIRS-9',
      data: { title: 'theirs', mode: 'chore', lifecycle_state: 'draft' },
    });
    appendEvent(caws, {
      seq: 3,
      event: 'spec_archived',
      ts: '2026-10-05T00:00:00.000Z',
      actor: { kind: 'agent', id: S1, session_id: S1, platform: 'dsh' },
      spec_id: 'SPEC-ARCHIVED-MINE-8',
      data: {
        from_path: '.caws/specs/SPEC-ARCHIVED-MINE-8.yaml',
        to_path: '.caws/specs/.archive/SPEC-ARCHIVED-MINE-8.yaml',
        blob_sha: '0123456789abcdef0123456789abcdef01234567',
      },
    });
    appendEvent(caws, {
      seq: 4,
      event: 'spec_archived',
      ts: '2026-10-05T00:00:00.000Z',
      actor: { kind: 'agent', id: S2, session_id: S2, platform: 'dsh' },
      spec_id: 'SPEC-ARCHIVED-THEIRS-9',
      data: {
        from_path: '.caws/specs/SPEC-ARCHIVED-THEIRS-9.yaml',
        to_path: '.caws/specs/.archive/SPEC-ARCHIVED-THEIRS-9.yaml',
      },
    });
  });

  test('filters to related specs and labels every relation kind', () => {
    const result = listSpecs(caws, { sessionId: S1 });
    expect(result.ok).toBe(true);
    const ids = result.value.active.map((e) => e.id).sort();
    // SPEC-UNRELATED-6 (created by S2, no claims) and SPEC-ARCHIVED-THEIRS-9 are out.
    expect(ids).toEqual([
      'SPEC-BRIDGED-2',
      'SPEC-CLOSED-5',
      'SPEC-CREATED-1',
      'SPEC-DRAFT-4',
      'SPEC-FOREIGN-BOUND-7',
      'SPEC-WT-3',
    ]);

    const created = specById(result, 'SPEC-CREATED-1');
    expect(created.relations).toEqual([{ kind: 'created' }]);
    expect(created.bound_worktree).toBeNull();

    const bridged = specById(result, 'SPEC-BRIDGED-2');
    expect(bridged.relations).toEqual([{ kind: 'bridge' }]);

    const wt = specById(result, 'SPEC-WT-3');
    expect(wt.relations).toEqual([
      { kind: 'worktree', worktree: 'wt-owner', owner_session_id: S1P },
    ]);
    expect(wt.bound_worktree).toEqual({ name: 'wt-owner', owner_session_id: S1P });

    // Created by session one, but bound to a worktree owned by session two:
    // the relation is 'created' only, and the FOREIGN binding is still
    // reported so the view can render honest takeover guidance.
    const foreignBound = specById(result, 'SPEC-FOREIGN-BOUND-7');
    expect(foreignBound.relations).toEqual([{ kind: 'created' }]);
    expect(foreignBound.bound_worktree).toEqual({ name: 'wt-foreign', owner_session_id: S2 });
  });

  test('prefix normalization: bare and session-prefixed forms match the same lane', () => {
    const bare = listSpecs(caws, { sessionId: S1 });
    const prefixed = listSpecs(caws, { sessionId: S1P });
    expect(prefixed.ok).toBe(true);
    expect(prefixed.value.active.map((e) => e.id).sort()).toEqual(
      bare.value.active.map((e) => e.id).sort()
    );
    // And the reverse direction: a body stamped bare matches a prefixed filter.
    const createdBare = listSpecs(caws, { sessionId: S1 });
    expect(specById(createdBare, 'SPEC-DRAFT-4').relations).toEqual([{ kind: 'created' }]);
  });

  test('archived specs are attributed through the spec_created event actor', () => {
    const result = listSpecs(caws, { sessionId: S1 });
    expect(result.ok).toBe(true);
    const archivedIds = result.value.archived.map((e) => e.id);
    expect(archivedIds).toEqual(['SPEC-ARCHIVED-MINE-8']);
    expect(result.value.archived[0].relations).toEqual([{ kind: 'created' }]);
    expect(result.value.archived[0].blob_sha).toBe('0123456789abcdef0123456789abcdef01234567');
  });

  test('explicit --status narrows the session view (status wins over archived default)', () => {
    const drafts = listSpecs(caws, { sessionId: S1, status: 'draft' });
    expect(drafts.value.active.map((e) => e.id)).toEqual(['SPEC-DRAFT-4']);
    expect(drafts.value.archived).toEqual([]);

    const activeOnly = listSpecs(caws, { sessionId: S1, status: 'active' });
    expect(activeOnly.value.active.map((e) => e.id).sort()).toEqual([
      'SPEC-BRIDGED-2',
      'SPEC-CREATED-1',
      'SPEC-FOREIGN-BOUND-7',
      'SPEC-WT-3',
    ]);
    expect(activeOnly.value.archived).toEqual([]);
  });

  test('unknown session yields empty active and archived lists', () => {
    const result = listSpecs(caws, { sessionId: S3 });
    expect(result.ok).toBe(true);
    expect(result.value.active).toEqual([]);
    expect(result.value.archived).toEqual([]);
  });

  test('negative control: without sessionId the listing is unfiltered and unannotated', () => {
    const result = listSpecs(caws, {});
    expect(result.ok).toBe(true);
    // Every spec on disk is listed — the filter changed nothing.
    expect(result.value.active.length).toBe(7);
    for (const entry of result.value.active) {
      expect(entry.relations).toBeUndefined();
      expect(entry.bound_worktree).toBeUndefined();
    }
    expect(result.value.archived).toEqual([]);
  });

  test('fail-closed: malformed bridge.json refuses the session view but not the plain listing', () => {
    fs.writeFileSync(path.join(caws, 'claims', 'bridge.json'), '{not json');
    const filtered = listSpecs(caws, { sessionId: S1 });
    expect(filtered.ok).toBe(false);
    const plain = listSpecs(caws, {});
    expect(plain.ok).toBe(true);
  });
});
