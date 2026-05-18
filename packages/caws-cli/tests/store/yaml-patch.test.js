/**
 * Tests for yaml-patch.ts (LIFECYCLE-MUTATION-001 A4).
 *
 * The patcher operates on raw source bytes. Tests use byte-level
 * comparison (NOT parsed-object equality) to prove comments,
 * field order, and trailing whitespace survive a mutation. If we
 * tested only "the parsed YAML matches the expected object," tests
 * would pass against a parse-then-dump implementation that destroys
 * comments — which is exactly the failure-lineage Entry 14 hazard.
 */

'use strict';

const {
  setTopLevelScalar,
  insertTopLevelScalarAfter,
} = require('../../dist/store/yaml-patch');

function unwrap(result) {
  if (!result.ok) {
    throw new Error(
      `expected ok; got ${result.errors.map((e) => `${e.rule}: ${e.message}`).join('; ')}`
    );
  }
  return result.value;
}

describe('setTopLevelScalar — value replacement', () => {
  it('replaces a top-level scalar and preserves all other lines byte-for-byte', () => {
    const original = [
      'id: SPEC-001',
      'title: example',
      'lifecycle_state: active',
      'mode: feature',
      '',
    ].join('\n');
    const patched = unwrap(setTopLevelScalar(original, 'lifecycle_state', 'closed'));
    const expected = [
      'id: SPEC-001',
      'title: example',
      'lifecycle_state: closed',
      'mode: feature',
      '',
    ].join('\n');
    expect(patched).toBe(expected);
  });

  it('preserves comments above and below the changed line', () => {
    const original = [
      '# Top-of-file comment',
      'id: SPEC-002',
      '# inline comment before lifecycle',
      'lifecycle_state: active',
      'mode: feature  # value after comment',
      '',
    ].join('\n');
    const patched = unwrap(setTopLevelScalar(original, 'lifecycle_state', 'closed'));
    expect(patched).toBe(
      [
        '# Top-of-file comment',
        'id: SPEC-002',
        '# inline comment before lifecycle',
        'lifecycle_state: closed',
        'mode: feature  # value after comment',
        '',
      ].join('\n')
    );
  });

  it('preserves inline trailing comment on the same line as the key', () => {
    const original = 'lifecycle_state: active  # was draft yesterday\n';
    const patched = unwrap(setTopLevelScalar(original, 'lifecycle_state', 'closed'));
    expect(patched).toBe('lifecycle_state: closed  # was draft yesterday\n');
  });

  it('preserves trailing whitespace and newline exactly', () => {
    const original = 'id: SPEC-003\nlifecycle_state: active\n';
    const patched = unwrap(setTopLevelScalar(original, 'lifecycle_state', 'closed'));
    expect(patched).toBe('id: SPEC-003\nlifecycle_state: closed\n');
    // Trailing newline preserved.
    expect(patched.endsWith('\n')).toBe(true);
  });

  it('does not add a trailing newline when source did not have one', () => {
    const original = 'lifecycle_state: active';
    const patched = unwrap(setTopLevelScalar(original, 'lifecycle_state', 'closed'));
    expect(patched).toBe('lifecycle_state: closed');
    expect(patched.endsWith('\n')).toBe(false);
  });

  it('refuses when the key does not exist at top level (KEY_NOT_FOUND)', () => {
    const original = 'id: SPEC-004\nmode: feature\n';
    const result = setTopLevelScalar(original, 'lifecycle_state', 'closed');
    expect(result.ok).toBe(false);
    expect(result.errors[0].rule).toBe('store.yaml_patch.key_not_found');
  });

  it('refuses when the key only appears nested (KEY_NOT_FOUND at top level)', () => {
    const original = ['id: SPEC-005', 'scope:', '  lifecycle_state: active', ''].join('\n');
    const result = setTopLevelScalar(original, 'lifecycle_state', 'closed');
    expect(result.ok).toBe(false);
    expect(result.errors[0].rule).toBe('store.yaml_patch.key_not_found');
  });

  it('refuses when the same key appears multiple times at top level (AMBIGUOUS)', () => {
    const original = 'lifecycle_state: active\nmode: feature\nlifecycle_state: draft\n';
    const result = setTopLevelScalar(original, 'lifecycle_state', 'closed');
    expect(result.ok).toBe(false);
    expect(result.errors[0].rule).toBe('store.yaml_patch.ambiguous');
  });

  it('refuses when the value spans multiple lines via block scalar (AMBIGUOUS)', () => {
    const original = ['notes: |', '  multi-line', '  block scalar', ''].join('\n');
    const result = setTopLevelScalar(original, 'notes', 'replacement');
    expect(result.ok).toBe(false);
    expect(result.errors[0].rule).toBe('store.yaml_patch.ambiguous');
  });

  it('refuses when the value is a nested mapping (AMBIGUOUS)', () => {
    const original = ['scope:', '  in:', '    - src/', ''].join('\n');
    const result = setTopLevelScalar(original, 'scope', 'inline');
    expect(result.ok).toBe(false);
    expect(result.errors[0].rule).toBe('store.yaml_patch.ambiguous');
  });

  it('does not confuse a key prefix (e.g., scope vs scope_in)', () => {
    const original = 'scope_in: src/\nmode: feature\n';
    const result = setTopLevelScalar(original, 'scope', 'foo');
    expect(result.ok).toBe(false);
    expect(result.errors[0].rule).toBe('store.yaml_patch.key_not_found');
  });
});

describe('insertTopLevelScalarAfter — line insertion', () => {
  it('inserts a new key:value line directly after a sibling top-level key', () => {
    const original = [
      'id: SPEC-006',
      'lifecycle_state: closed',
      'mode: feature',
      '',
    ].join('\n');
    const patched = unwrap(
      insertTopLevelScalarAfter(original, 'lifecycle_state', 'resolution', 'completed')
    );
    expect(patched).toBe(
      [
        'id: SPEC-006',
        'lifecycle_state: closed',
        'resolution: completed',
        'mode: feature',
        '',
      ].join('\n')
    );
  });

  it('inserts after the whole block when anchor key has a nested value', () => {
    const original = [
      'id: SPEC-007',
      'scope:',
      '  in:',
      '    - src/',
      '  out: []',
      'mode: feature',
      '',
    ].join('\n');
    const patched = unwrap(
      insertTopLevelScalarAfter(original, 'scope', 'lifecycle_state', 'active')
    );
    // Insertion lands AFTER the scope block, BEFORE mode.
    expect(patched).toBe(
      [
        'id: SPEC-007',
        'scope:',
        '  in:',
        '    - src/',
        '  out: []',
        'lifecycle_state: active',
        'mode: feature',
        '',
      ].join('\n')
    );
  });

  it('refuses when the anchor key is missing (KEY_NOT_FOUND)', () => {
    const original = 'id: SPEC-008\nmode: feature\n';
    const result = insertTopLevelScalarAfter(original, 'nonexistent', 'resolution', 'completed');
    expect(result.ok).toBe(false);
    expect(result.errors[0].rule).toBe('store.yaml_patch.key_not_found');
  });

  it('refuses when the key being inserted already exists at top level (AMBIGUOUS)', () => {
    const original = 'id: SPEC-009\nlifecycle_state: closed\nmode: feature\n';
    const result = insertTopLevelScalarAfter(original, 'mode', 'lifecycle_state', 'active');
    expect(result.ok).toBe(false);
    expect(result.errors[0].rule).toBe('store.yaml_patch.ambiguous');
  });
});

describe('A4: byte-level non-destructive close fixture', () => {
  // Golden-file regression: a realistic v11 spec is closed by
  // (1) setting lifecycle_state to closed, (2) inserting resolution
  // after it, (3) inserting closure_notes after resolution, (4)
  // updating updated_at. All comments, blank lines, and field order
  // must survive byte-for-byte.

  it('close sequence produces a minimal-semantic diff', () => {
    const original = [
      '# Authored: 2026-05-12',
      'id: SPEC-010',
      'title: example active spec',
      'risk_tier: 3',
      'mode: feature',
      'lifecycle_state: active',
      'created_at: \'2026-05-12T00:00:00.000Z\'',
      'updated_at: \'2026-05-12T00:00:00.000Z\'',
      '# scope below intentionally minimal',
      'scope:',
      '  in:',
      '    - src/',
      '  out: []',
      'invariants:',
      '  - System maintains data consistency',
      'acceptance:',
      '  - id: A1',
      '    given: x',
      '    when: y',
      '    then: z',
      'non_functional:',
      '  reliability:',
      '    - System is reliable',
      'contracts: []',
      '',
    ].join('\n');

    let bytes = original;
    bytes = unwrap(setTopLevelScalar(bytes, 'lifecycle_state', 'closed'));
    bytes = unwrap(
      insertTopLevelScalarAfter(bytes, 'lifecycle_state', 'resolution', 'completed')
    );
    bytes = unwrap(
      insertTopLevelScalarAfter(
        bytes,
        'resolution',
        'closure_notes',
        "'Closed manually during smoke test.'"
      )
    );
    bytes = unwrap(
      setTopLevelScalar(bytes, 'updated_at', "'2026-05-18T00:00:00.000Z'")
    );

    const expected = [
      '# Authored: 2026-05-12',
      'id: SPEC-010',
      'title: example active spec',
      'risk_tier: 3',
      'mode: feature',
      'lifecycle_state: closed',
      'resolution: completed',
      "closure_notes: 'Closed manually during smoke test.'",
      'created_at: \'2026-05-12T00:00:00.000Z\'',
      "updated_at: '2026-05-18T00:00:00.000Z'",
      '# scope below intentionally minimal',
      'scope:',
      '  in:',
      '    - src/',
      '  out: []',
      'invariants:',
      '  - System maintains data consistency',
      'acceptance:',
      '  - id: A1',
      '    given: x',
      '    when: y',
      '    then: z',
      'non_functional:',
      '  reliability:',
      '    - System is reliable',
      'contracts: []',
      '',
    ].join('\n');

    expect(bytes).toBe(expected);

    // Sanity: comments survived byte-for-byte.
    expect(bytes).toContain('# Authored: 2026-05-12');
    expect(bytes).toContain('# scope below intentionally minimal');
  });
});
