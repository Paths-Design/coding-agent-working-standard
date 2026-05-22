/**
 * WORKTREE-REGISTRY-LEGACY-ENVELOPE-MIGRATION-001 — store-level helper tests.
 *
 * Tests the pure-ish migration helper functions:
 *   - detectWorktreesRegistryShape(fileContents)
 *   - classifyRecordsForMigration(nestedRecords, specs, pathExistsCheck)
 *   - isSpecLoadVerifiable(specs, diagnostics)
 *   - planMigration(fileContents, specs, specLoadDiagnostics, pathExistsCheck)
 *
 * Test discipline:
 *   - All inputs are plain in-memory data. The pathExistsCheck callback
 *     is injected so the helper logic is filesystem-free.
 *   - Each test asserts exact bytes for the apply path's outputBytes —
 *     the migration's serialization contract is locked at
 *     JSON.stringify(flatMap, null, 2) + '\n'.
 *   - Fixture matrix F1-F7 from the plan + idempotency cross-check.
 */

'use strict';

const {
  MIGRATION_RULES,
  classifyRecordsForMigration,
  detectWorktreesRegistryShape,
  isSpecLoadVerifiable,
  planMigration,
} = require('../../dist/store/worktrees-migration');

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function envelope(records) {
  return JSON.stringify({ version: 1, worktrees: records }, null, 2) + '\n';
}

function flatMap(records) {
  return JSON.stringify(records, null, 2) + '\n';
}

const NEVER_EXISTS = () => false;
const ALWAYS_EXISTS = () => true;

// ---------------------------------------------------------------------------
// detectWorktreesRegistryShape
// ---------------------------------------------------------------------------

describe('detectWorktreesRegistryShape', () => {
  test('flat: top-level record keys, no version/worktrees envelope', () => {
    const r = detectWorktreesRegistryShape(
      JSON.stringify({ 'wt-a': { specId: 'X' } })
    );
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ kind: 'flat', recordCount: 1 });
  });

  test('flat: empty object → kind: empty', () => {
    const r = detectWorktreesRegistryShape('{}');
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ kind: 'empty', reason: 'empty_object' });
  });

  test('legacy_envelope: { version, worktrees: {...} } only', () => {
    const r = detectWorktreesRegistryShape(
      JSON.stringify({ version: 1, worktrees: { 'wt-a': { specId: 'X' } } })
    );
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({
      kind: 'legacy_envelope',
      version: 1,
      nestedRecordCount: 1,
    });
  });

  test('legacy_envelope: empty nested worktrees object', () => {
    const r = detectWorktreesRegistryShape(
      JSON.stringify({ version: 1, worktrees: {} })
    );
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({
      kind: 'legacy_envelope',
      version: 1,
      nestedRecordCount: 0,
    });
  });

  test('mixed: envelope keys plus extra top-level record keys', () => {
    const r = detectWorktreesRegistryShape(
      JSON.stringify({
        version: 1,
        worktrees: {},
        'wt-a': { specId: 'X' },
      })
    );
    expect(r.ok).toBe(true);
    expect(r.value.kind).toBe('mixed');
    expect(r.value.reason).toContain('wt-a');
  });

  test('mixed: version alone (no worktrees object)', () => {
    const r = detectWorktreesRegistryShape(
      JSON.stringify({ version: 1, 'wt-a': { specId: 'X' } })
    );
    expect(r.ok).toBe(true);
    expect(r.value.kind).toBe('mixed');
    expect(r.value.reason).toContain('version');
  });

  test('mixed: worktrees object alone (no version)', () => {
    const r = detectWorktreesRegistryShape(
      JSON.stringify({ worktrees: { 'wt-a': { specId: 'X' } } })
    );
    expect(r.ok).toBe(true);
    expect(r.value.kind).toBe('mixed');
    expect(r.value.reason).toContain('worktrees');
  });

  test('read_failed: invalid JSON', () => {
    const r = detectWorktreesRegistryShape('{not valid json');
    expect(r.ok).toBe(false);
    expect(r.errors[0].rule).toBe(MIGRATION_RULES.READ_FAILED);
  });

  test('read_failed: JSON array (not object)', () => {
    const r = detectWorktreesRegistryShape('[1, 2, 3]');
    expect(r.ok).toBe(false);
    expect(r.errors[0].rule).toBe(MIGRATION_RULES.READ_FAILED);
  });

  test('read_failed: JSON null', () => {
    const r = detectWorktreesRegistryShape('null');
    expect(r.ok).toBe(false);
    expect(r.errors[0].rule).toBe(MIGRATION_RULES.READ_FAILED);
  });
});

// ---------------------------------------------------------------------------
// classifyRecordsForMigration — destroyed-record policy
// ---------------------------------------------------------------------------

describe('classifyRecordsForMigration', () => {
  test('non-terminal record (no status field) → preserved verbatim', () => {
    const decisions = classifyRecordsForMigration(
      { 'wt-a': { specId: 'X' } },
      [],
      NEVER_EXISTS
    );
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      record: 'wt-a',
      omit: false,
      reason: 'non_terminal',
    });
  });

  test('non-terminal record (status: active) → preserved verbatim', () => {
    const decisions = classifyRecordsForMigration(
      { 'wt-a': { specId: 'X', status: 'active' } },
      [],
      NEVER_EXISTS
    );
    expect(decisions[0]).toMatchObject({
      record: 'wt-a',
      status: 'active',
      omit: false,
      reason: 'non_terminal',
    });
  });

  test('destroyed + no claim + path absent → omittable', () => {
    const decisions = classifyRecordsForMigration(
      {
        'wt-d': { specId: 'X', status: 'destroyed', path: '/tmp/d' },
      },
      [],
      NEVER_EXISTS
    );
    expect(decisions[0]).toMatchObject({
      record: 'wt-d',
      status: 'destroyed',
      omit: true,
      reason: 'destroyed_safe_to_omit',
    });
  });

  test('destroyed + spec claims name → BLOCKS (spec_claims)', () => {
    const decisions = classifyRecordsForMigration(
      {
        'wt-d': { specId: 'X', status: 'destroyed', path: '/tmp/d' },
      },
      [{ id: 'CLAIMER-1', worktree: 'wt-d' }],
      NEVER_EXISTS
    );
    expect(decisions[0]).toMatchObject({
      record: 'wt-d',
      status: 'destroyed',
      omit: false,
      reason: 'spec_claims',
      detail: { specId: 'CLAIMER-1' },
    });
  });

  test('destroyed + path exists → BLOCKS (path_present)', () => {
    const decisions = classifyRecordsForMigration(
      {
        'wt-d': { specId: 'X', status: 'destroyed', path: '/real/path' },
      },
      [],
      ALWAYS_EXISTS
    );
    expect(decisions[0]).toMatchObject({
      record: 'wt-d',
      status: 'destroyed',
      omit: false,
      reason: 'path_present',
      detail: { path: '/real/path' },
    });
  });

  test('destroyed + spec claims AND path exists → BLOCKS with spec_claims (first check wins)', () => {
    // Precedence: spec_claims is checked before path_present. The first
    // failing condition is named; the operator addresses one at a time.
    const decisions = classifyRecordsForMigration(
      {
        'wt-d': { specId: 'X', status: 'destroyed', path: '/real/path' },
      },
      [{ id: 'CLAIMER-1', worktree: 'wt-d' }],
      ALWAYS_EXISTS
    );
    expect(decisions[0]).toMatchObject({
      omit: false,
      reason: 'spec_claims',
    });
  });

  test('destroyed + path field undefined → treats as absent', () => {
    const decisions = classifyRecordsForMigration(
      { 'wt-d': { specId: 'X', status: 'destroyed' } },
      [],
      ALWAYS_EXISTS // pathExistsCheck irrelevant when path is undefined
    );
    expect(decisions[0]).toMatchObject({
      omit: true,
      reason: 'destroyed_safe_to_omit',
    });
  });

  test('multiple specs claiming same name → first match cited', () => {
    const decisions = classifyRecordsForMigration(
      { 'wt-d': { specId: 'X', status: 'destroyed' } },
      [
        { id: 'FIRST', worktree: 'wt-d' },
        { id: 'SECOND', worktree: 'wt-d' },
      ],
      NEVER_EXISTS
    );
    expect(decisions[0]).toMatchObject({
      omit: false,
      reason: 'spec_claims',
      detail: { specId: 'FIRST' },
    });
  });

  test('mixed: active + destroyed-omittable + destroyed-blocked', () => {
    const decisions = classifyRecordsForMigration(
      {
        'wt-active': { specId: 'A', status: 'active' },
        'wt-d-ok': { specId: 'B', status: 'destroyed' },
        'wt-d-blocked': {
          specId: 'C',
          status: 'destroyed',
          path: '/real/path',
        },
      },
      [],
      (p) => p === '/real/path'
    );
    expect(decisions).toHaveLength(3);
    expect(decisions[0]).toMatchObject({ record: 'wt-active', omit: false, reason: 'non_terminal' });
    expect(decisions[1]).toMatchObject({ record: 'wt-d-ok', omit: true });
    expect(decisions[2]).toMatchObject({ record: 'wt-d-blocked', omit: false, reason: 'path_present' });
  });

  test('non-object nested value → preserved (defensive non_terminal)', () => {
    // The classifier doesn't crash on a weird value; preserve and let
    // downstream registry validation surface it.
    const decisions = classifyRecordsForMigration(
      { broken: 'not-an-object' },
      [],
      NEVER_EXISTS
    );
    expect(decisions[0]).toMatchObject({ record: 'broken', omit: false, reason: 'non_terminal' });
  });
});

// ---------------------------------------------------------------------------
// isSpecLoadVerifiable (A12 gate)
// ---------------------------------------------------------------------------

describe('isSpecLoadVerifiable', () => {
  test('specs present → always verifiable regardless of diagnostics', () => {
    expect(isSpecLoadVerifiable([{ id: 'X' }], [])).toBe(true);
    expect(
      isSpecLoadVerifiable(
        [{ id: 'X' }],
        [{ rule: 'store.read.io_failed', authority: 'kernel/diagnostics', message: '...' }]
      )
    ).toBe(true);
  });

  test('zero specs + no diagnostics → verifiable (empty repo)', () => {
    expect(isSpecLoadVerifiable([], [])).toBe(true);
  });

  test('zero specs + benign diagnostics → verifiable', () => {
    expect(
      isSpecLoadVerifiable(
        [],
        [
          { rule: 'store.specs.non_yaml_skipped', authority: 'kernel/diagnostics', message: '...' },
          { rule: 'store.specs.duplicate_id', authority: 'kernel/diagnostics', message: '...' },
        ]
      )
    ).toBe(true);
  });

  test('zero specs + READ_IO_FAILED → NOT verifiable (A12)', () => {
    expect(
      isSpecLoadVerifiable(
        [],
        [{ rule: 'store.read.io_failed', authority: 'kernel/diagnostics', message: '...' }]
      )
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// planMigration — F1-F7 fixture matrix + idempotency + dry-run parity
// ---------------------------------------------------------------------------

describe('planMigration — F1: legacy envelope, all non-terminal records', () => {
  test('migrate: copy non-terminal records verbatim', () => {
    const input = envelope({
      'wt-a': { specId: 'A', status: 'active', custom: 'kept' },
      'wt-b': { specId: 'B' }, // no status field
    });
    const plan = planMigration(input, [], [], NEVER_EXISTS);

    expect(plan.kind).toBe('apply');
    expect(plan.inputRecordCount).toBe(2);
    expect(plan.outputRecordCount).toBe(2);

    // outputBytes locked at JSON.stringify(flatMap, null, 2) + '\n'.
    const expected = flatMap({
      'wt-a': { specId: 'A', status: 'active', custom: 'kept' },
      'wt-b': { specId: 'B' },
    });
    expect(plan.outputBytes).toBe(expected);

    // The "custom: 'kept'" field round-trips verbatim per invariant 2.
    const reparsed = JSON.parse(plan.outputBytes);
    expect(reparsed['wt-a'].custom).toBe('kept');
  });
});

describe('planMigration — F2: legacy envelope, all destroyed records omittable', () => {
  test('migrate to {} when no claims and no paths', () => {
    const input = envelope({
      'wt-d1': { specId: 'X', status: 'destroyed', path: '/tmp/d1' },
      'wt-d2': { specId: 'X', status: 'destroyed', path: '/tmp/d2' },
    });
    const plan = planMigration(input, [], [], NEVER_EXISTS);

    expect(plan.kind).toBe('apply');
    expect(plan.inputRecordCount).toBe(2);
    expect(plan.outputRecordCount).toBe(0);
    // Exact byte assertion: empty map serialized to {}\n.
    expect(plan.outputBytes).toBe('{}\n');
    expect(Buffer.byteLength(plan.outputBytes, 'utf8')).toBe(3);
  });
});

describe('planMigration — F3: legacy envelope, destroyed record claimed by spec', () => {
  test('refuse with destroyed_blocked + spec_claims detail', () => {
    const input = envelope({
      'wt-d': { specId: 'X', status: 'destroyed', path: '/tmp/d' },
    });
    const plan = planMigration(
      input,
      [{ id: 'CLAIMER-1', worktree: 'wt-d' }],
      [],
      NEVER_EXISTS
    );

    expect(plan.kind).toBe('refuse');
    expect(plan.reason).toBe('destroyed_blocked');
    expect(plan.diagnostic.rule).toBe(
      MIGRATION_RULES.DESTROYED_RECORD_BLOCKS_OMISSION
    );
    expect(plan.decisions).toHaveLength(1);
    expect(plan.decisions[0]).toMatchObject({
      omit: false,
      reason: 'spec_claims',
      detail: { specId: 'CLAIMER-1' },
    });
  });
});

describe('planMigration — F4: legacy envelope, destroyed record with path present', () => {
  test('refuse with destroyed_blocked + path_present detail', () => {
    const input = envelope({
      'wt-d': { specId: 'X', status: 'destroyed', path: '/real/path' },
    });
    const plan = planMigration(input, [], [], ALWAYS_EXISTS);

    expect(plan.kind).toBe('refuse');
    expect(plan.reason).toBe('destroyed_blocked');
    expect(plan.decisions[0]).toMatchObject({
      omit: false,
      reason: 'path_present',
      detail: { path: '/real/path' },
    });
  });
});

describe('planMigration — F5: mixed shape refusal', () => {
  test('refuse with mixed_shape (envelope keys adjacent to flat records)', () => {
    const input = JSON.stringify({
      version: 1,
      worktrees: { 'wt-nested': { specId: 'X' } },
      'wt-flat': { specId: 'Y' },
    });
    const plan = planMigration(input, [], [], NEVER_EXISTS);

    expect(plan.kind).toBe('refuse');
    expect(plan.reason).toBe('mixed_shape');
    expect(plan.diagnostic.rule).toBe(MIGRATION_RULES.MIXED_SHAPE_REFUSED);
    // No per-record decisions for shape-level refusal.
    expect(plan.decisions).toBeUndefined();
  });

  test('refuse with mixed_shape (version alone, no worktrees object)', () => {
    const input = JSON.stringify({
      version: 1,
      'wt-flat': { specId: 'Y' },
    });
    const plan = planMigration(input, [], [], NEVER_EXISTS);
    expect(plan.kind).toBe('refuse');
    expect(plan.reason).toBe('mixed_shape');
  });
});

describe('planMigration — F6: already-flat (no_op + idempotency)', () => {
  test('flat → no_op, no outputBytes', () => {
    const input = flatMap({ 'wt-a': { specId: 'A' } });
    const plan = planMigration(input, [], [], NEVER_EXISTS);
    expect(plan.kind).toBe('no_op');
    expect(plan.reason).toBe('already_flat');
    expect(plan.recordCount).toBe(1);
  });

  test('empty flat → no_op (empty_object)', () => {
    const plan = planMigration('{}', [], [], NEVER_EXISTS);
    expect(plan.kind).toBe('no_op');
    expect(plan.reason).toBe('empty_object');
  });

  test('idempotency: applying migration to its own output is a no-op', () => {
    // F1 fixture → apply produces flat-map output → re-plan that
    // output → must be no_op. Catches accidental shape regressions
    // in the serialization.
    const f1Input = envelope({
      'wt-a': { specId: 'A', status: 'active' },
    });
    const firstPlan = planMigration(f1Input, [], [], NEVER_EXISTS);
    expect(firstPlan.kind).toBe('apply');

    const secondPlan = planMigration(firstPlan.outputBytes, [], [], NEVER_EXISTS);
    expect(secondPlan.kind).toBe('no_op');
    expect(secondPlan.reason).toBe('already_flat');
    expect(secondPlan.recordCount).toBe(1);
  });

  test('idempotency: F2 → migration → re-plan must be no_op (empty_object)', () => {
    const f2Input = envelope({
      'wt-d': { specId: 'X', status: 'destroyed' },
    });
    const firstPlan = planMigration(f2Input, [], [], NEVER_EXISTS);
    expect(firstPlan.kind).toBe('apply');
    expect(firstPlan.outputBytes).toBe('{}\n');

    const secondPlan = planMigration(firstPlan.outputBytes, [], [], NEVER_EXISTS);
    expect(secondPlan.kind).toBe('no_op');
    expect(secondPlan.reason).toBe('empty_object');
  });
});

describe('planMigration — F7 / A12: spec-load failure refusal', () => {
  test('legacy envelope with destroyed records + zero specs + READ_IO_FAILED → refuse', () => {
    const input = envelope({
      'wt-d': { specId: 'X', status: 'destroyed' },
    });
    const plan = planMigration(
      input,
      [],
      [{ rule: 'store.read.io_failed', authority: 'kernel/diagnostics', message: 'permission denied' }],
      NEVER_EXISTS
    );
    expect(plan.kind).toBe('refuse');
    expect(plan.reason).toBe('spec_load_failed');
    expect(plan.diagnostic.rule).toBe(
      MIGRATION_RULES.SPEC_LOAD_FAILED_POLICY_UNVERIFIABLE
    );
    expect(plan.decisions).toBeDefined();
  });

  test('A12 narrowness: legacy envelope with ONLY non-terminal records + READ_IO_FAILED → apply (no claim check needed)', () => {
    // If there are no destroyed records, the claim check has no work,
    // so a spec-load failure does NOT block. This preserves the narrow
    // refusal posture.
    const input = envelope({
      'wt-a': { specId: 'A', status: 'active' },
    });
    const plan = planMigration(
      input,
      [],
      [{ rule: 'store.read.io_failed', authority: 'kernel/diagnostics', message: '...' }],
      NEVER_EXISTS
    );
    expect(plan.kind).toBe('apply');
  });

  test('A12 narrowness: legacy envelope with destroyed records + zero specs + ONLY benign diagnostics → apply', () => {
    // Benign diagnostics (non-yaml-skipped, duplicate-id) do NOT
    // make the spec universe unknowable. A repo can legitimately
    // have zero specs and SPECS_NON_YAML_SKIPPED diagnostics.
    const input = envelope({
      'wt-d': { specId: 'X', status: 'destroyed' },
    });
    const plan = planMigration(
      input,
      [],
      [
        { rule: 'store.specs.non_yaml_skipped', authority: 'kernel/diagnostics', message: '...' },
        { rule: 'store.specs.duplicate_id', authority: 'kernel/diagnostics', message: '...' },
      ],
      NEVER_EXISTS
    );
    expect(plan.kind).toBe('apply');
    expect(plan.outputRecordCount).toBe(0);
  });

  test('A12 narrowness: legacy envelope with destroyed records + specs present (any specs) → apply', () => {
    // Even with READ_IO_FAILED in diagnostics, if any specs loaded,
    // the claim check is verifiable for the records we observe.
    const input = envelope({
      'wt-d': { specId: 'X', status: 'destroyed' },
    });
    const plan = planMigration(
      input,
      [{ id: 'UNRELATED-1' }], // no worktree:, so no claim on wt-d
      [{ rule: 'store.read.io_failed', authority: 'kernel/diagnostics', message: '...' }],
      NEVER_EXISTS
    );
    expect(plan.kind).toBe('apply');
    expect(plan.outputRecordCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Refusal precedence (locked)
// ---------------------------------------------------------------------------

describe('planMigration — refusal precedence', () => {
  test('read_failed precedes everything (invalid JSON)', () => {
    const plan = planMigration('not json', [], [], NEVER_EXISTS);
    expect(plan.kind).toBe('refuse');
    expect(plan.reason).toBe('read_failed');
  });

  test('mixed_shape precedes destroyed_blocked and spec_load_failed', () => {
    const input = JSON.stringify({
      version: 1,
      worktrees: { 'wt-d': { status: 'destroyed' } },
      'wt-extra': { specId: 'X' },
    });
    const plan = planMigration(
      input,
      [],
      [{ rule: 'store.read.io_failed', authority: 'kernel/diagnostics', message: '...' }],
      NEVER_EXISTS
    );
    expect(plan.reason).toBe('mixed_shape');
  });

  test('spec_load_failed precedes destroyed_blocked', () => {
    // Both conditions are true: claiming spec would block AND
    // spec load failed. The A12 refusal fires first because the
    // operator cannot tell which records would actually be blocked
    // until specs load successfully.
    const input = envelope({
      'wt-d': { specId: 'X', status: 'destroyed', path: '/real/path' },
    });
    const plan = planMigration(
      input,
      [],
      [{ rule: 'store.read.io_failed', authority: 'kernel/diagnostics', message: '...' }],
      ALWAYS_EXISTS
    );
    expect(plan.reason).toBe('spec_load_failed');
  });
});

// ---------------------------------------------------------------------------
// Real-repo shape fidelity (this repo's actual .caws/worktrees.json bytes)
// ---------------------------------------------------------------------------

describe('planMigration — this repo\'s fixture shape', () => {
  test('two-destroyed-records envelope, both paths absent, no claiming spec → apply with {}\n', () => {
    // Reproduces the live-repo shape (paths replaced with /tmp/
    // placeholders that NEVER_EXISTS returns false for). Exercises
    // the same byte-output path commit 3 will run.
    const input = envelope({
      'ci-caws-gate-wt': {
        name: 'ci-caws-gate-wt',
        path: '/tmp/ci-caws-gate-wt',
        branch: 'caws/ci-caws-gate-wt',
        baseBranch: 'feat/ci-v11-workflow-repair',
        scope: null,
        specId: 'CI-CAWS-GATE-V11-SURFACE-001',
        owner: null,
        createdAt: '2026-05-20T19:08:58.140Z',
        status: 'destroyed',
        destroyedAt: '2026-05-20T19:11:11.284Z',
      },
      'ci-caws-gate-exec-wt': {
        name: 'ci-caws-gate-exec-wt',
        path: '/tmp/ci-caws-gate-exec-wt',
        branch: 'caws/ci-caws-gate-exec-wt',
        baseBranch: 'feat/ci-v11-workflow-repair',
        scope: null,
        specId: 'CI-CAWS-GATE-V11-SURFACE-001',
        owner: null,
        createdAt: '2026-05-20T22:07:05.130Z',
        status: 'destroyed',
        destroyedAt: '2026-05-20T22:08:02.009Z',
      },
    });
    const plan = planMigration(input, [], [], NEVER_EXISTS);
    expect(plan.kind).toBe('apply');
    expect(plan.inputRecordCount).toBe(2);
    expect(plan.outputRecordCount).toBe(0);
    expect(plan.outputBytes).toBe('{}\n');
  });
});
